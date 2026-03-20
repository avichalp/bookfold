import { DETAIL_PROFILES, MAP_CONCURRENCY } from '../config.js';
import type { BookChunk, ParsedBook, TocEntry } from '../book/types.js';
import type {
  DetailLevel,
  ProgressEvent,
  SummaryDebugInfo,
  SummaryMetadata,
  SummaryResult,
  SummarizationProvider
} from '../types.js';
import {
  buildChunkMapPrompt,
  buildCollapsePrompt,
  buildReducePrompt,
  buildSectionMapPrompt,
  buildSinglePassPrompt
} from './prompts.js';

interface SectionGroup {
  title: string;
  label: string;
  chunks: BookChunk[];
}

type PreparedSummaryResult = Omit<SummaryResult, 'payment'>;
const COLLAPSE_GROUP_SIZE = 6;

export async function summarizeParsedBook(args: {
  book: ParsedBook;
  detail: DetailLevel;
  provider: SummarizationProvider;
  signal?: AbortSignal | undefined;
  onProgress?: ((event: ProgressEvent) => void) | undefined;
}): Promise<PreparedSummaryResult> {
  const { book, detail, provider, signal, onProgress } = args;
  const profile = DETAIL_PROFILES[detail];
  const metadata = toSummaryMetadata(book);
  const warnings: string[] = [];
  const modelNames = new Set<string>();
  let modelCallCount = 0;
  let strategy = profile.strategy;
  let sectionCount = 0;
  let summarizeMessage = 'Generating summary.';
  let summarizeProgressCompleted = 0;
  let summarizeProgressTotal = 0;

  const emitSummarizeProgress = (message = summarizeMessage, detail?: Record<string, unknown>) => {
    summarizeMessage = message;
    onProgress?.({
      step: 'summarize',
      message,
      detail,
      progress:
        summarizeProgressTotal > 0
          ? {
              completed: summarizeProgressCompleted,
              total: summarizeProgressTotal
            }
          : undefined
    });
  };

  const generate = async (parameters: {
    messages: Parameters<typeof buildSinglePassPrompt>[0] extends never ? never : ReturnType<typeof buildSinglePassPrompt>;
    maxWords: number;
    model?: string | undefined;
  }): Promise<string> => {
    signal?.throwIfAborted();

    const result = await provider.generateText({
      model: parameters.model ?? profile.model,
      messages: parameters.messages,
      maxOutputTokens: wordsToMaxOutputTokens(parameters.maxWords),
      temperature: 0.2,
      signal
    });

    modelCallCount += 1;
    modelNames.add(result.model);
    summarizeProgressCompleted += 1;
    emitSummarizeProgress();
    return result.text.trim();
  };

  let summary: string;

  if (detail === 'short' && canUseSinglePass(book)) {
    summarizeProgressTotal = 1;
    emitSummarizeProgress('Running short single-pass summary.', {
      chunkCount: book.chunks.length
    });

    summary = await generate({
      messages: buildSinglePassPrompt({
        detail,
        metadata,
        targetWords: profile.targetWords,
        text: joinChunkText(book.chunks)
      }),
      maxWords: profile.targetWords.max
    });
    strategy = 'single-pass';
  } else if (detail === 'long') {
    const sections = buildSectionGroups(book);
    sectionCount = sections.length;
    if (sections.length <= 1) {
      warnings.push('Long detail fell back to synthetic sections because no reliable TOC-based grouping was available.');
    }

    summarizeProgressTotal = sections.length + estimateCollapseCallCount(sections.length) + 1;
    emitSummarizeProgress(`Summarizing ${sections.length} long-form sections.`, {
      sectionCount: sections.length,
      chunkCount: book.chunks.length
    });

    const sectionNotes = await mapWithConcurrency(sections, MAP_CONCURRENCY, async (section) => {
      return generate({
        messages: buildSectionMapPrompt({
          detail,
          metadata,
          targetWords: { min: 180, max: 260 },
          sectionTitle: section.title,
          sectionLabel: section.label,
          text: joinChunkText(section.chunks)
        }),
        maxWords: 260
      });
    });

    const collapsedNotes = await collapseNotes({
      notes: sectionNotes,
      detail,
      metadata,
      signal,
      onStage: emitSummarizeProgress,
      generate
    });

    emitSummarizeProgress('Synthesizing final book summary.');
    summary = await generate({
      messages: buildReducePrompt({
        detail,
        metadata,
        targetWords: profile.targetWords,
        notesLabel: 'book-summary',
        notes: collapsedNotes
      }),
      maxWords: profile.targetWords.max
    });
  } else {
    const groups = chunkBySize(book.chunks, profile.mapGroupSize);

    summarizeProgressTotal = groups.length + estimateCollapseCallCount(groups.length) + 1;
    emitSummarizeProgress(`Running ${detail} map-reduce summary across ${groups.length} chunk groups.`, {
      groupCount: groups.length,
      chunkCount: book.chunks.length
    });

    const mapNotes = await mapWithConcurrency(groups, MAP_CONCURRENCY, async (group, index) => {
      return generate({
        messages: buildChunkMapPrompt({
          detail,
          metadata,
          targetWords: detail === 'short' ? { min: 80, max: 130 } : { min: 120, max: 180 },
          chunkLabel: `group ${index + 1} of ${groups.length}`,
          text: joinChunkText(group)
        }),
        maxWords: detail === 'short' ? 130 : 180
      });
    });

    const collapsedNotes = await collapseNotes({
      notes: mapNotes,
      detail,
      metadata,
      signal,
      onStage: emitSummarizeProgress,
      generate
    });

    emitSummarizeProgress('Synthesizing final book summary.');
    summary = await generate({
      messages: buildReducePrompt({
        detail,
        metadata,
        targetWords: profile.targetWords,
        notesLabel: 'book-summary',
        notes: collapsedNotes
      }),
      maxWords: profile.targetWords.max
    });
  }

  const debug: SummaryDebugInfo = {
    chunkCount: book.chunks.length,
    modelCallCount,
    modelNames: Array.from(modelNames),
    strategy,
    sectionCount: sectionCount || undefined
  };

  return {
    summary,
    detail,
    metadata,
    debug,
    warnings: warnings.length > 0 ? warnings : undefined
  };
}

async function collapseNotes(args: {
  notes: string[];
  detail: DetailLevel;
  metadata: SummaryMetadata;
  signal?: AbortSignal | undefined;
  onStage?: ((message: string, detail?: Record<string, unknown>) => void) | undefined;
  generate: (parameters: {
    messages: ReturnType<typeof buildSinglePassPrompt>;
    maxWords: number;
    model?: string | undefined;
  }) => Promise<string>;
}): Promise<string[]> {
  let notes = args.notes;
  let round = 1;

  while (notes.length > 6) {
    const groups = chunkBySize(notes, COLLAPSE_GROUP_SIZE);
    args.onStage?.(`Collapsing ${notes.length} intermediate notes (round ${round}).`, {
      round,
      groups: groups.length
    });

    notes = await mapWithConcurrency(groups, MAP_CONCURRENCY, async (group, index) => {
      return args.generate({
        messages: buildCollapsePrompt({
          detail: args.detail,
          metadata: args.metadata,
          targetWords: args.detail === 'short' ? { min: 120, max: 180 } : { min: 180, max: 260 },
          stageLabel: `round ${round} group ${index + 1} of ${groups.length}`,
          notes: group
        }),
        maxWords: args.detail === 'short' ? 180 : 260
      });
    });

    round += 1;
    args.signal?.throwIfAborted();
  }

  return notes;
}

function toSummaryMetadata(book: ParsedBook): SummaryMetadata {
  return {
    title: book.metadata.info.title,
    author: book.metadata.info.author,
    fileType: book.fileType,
    pageCount: book.metadata.pageCount,
    chapterCount: book.metadata.chapterCount
  };
}

function canUseSinglePass(book: ParsedBook): boolean {
  return book.chunks.length <= 3 && book.textLength <= 12_000;
}

function buildSectionGroups(book: ParsedBook): SectionGroup[] {
  const tocEntries = normalizeTocEntries(book.metadata.tocEntries ?? book.metadata.outlineEntries ?? []);
  const topLevelEntries = tocEntries.filter((entry) => entry.level === 0 && entry.pageNumber !== null);
  const sourceEntries = topLevelEntries.length >= 2
    ? topLevelEntries
    : tocEntries.filter((entry) => entry.pageNumber !== null);

  if (sourceEntries.length >= 2) {
    const sections: SectionGroup[] = [];

    for (let index = 0; index < sourceEntries.length; index += 1) {
      const entry = sourceEntries[index];
      if (!entry) {
        continue;
      }
      const nextEntry = sourceEntries[index + 1];
      const startPage = entry.pageNumber ?? 1;
      const endPage = nextEntry?.pageNumber ?? Number.POSITIVE_INFINITY;
      const chunks = book.chunks.filter((chunk) => {
        const pages = chunk.metadata.pageNumbers ?? [];
        if (pages.length === 0) {
          return false;
        }
        const firstPage = Math.min(...pages);
        const lastPage = Math.max(...pages);
        return lastPage >= startPage && firstPage < endPage;
      });

      if (chunks.length > 0) {
        sections.push({
          title: entry.title,
          label: `section ${index + 1} of ${sourceEntries.length}`,
          chunks
        });
      }
    }

    if (sections.length >= 2) {
      return sections;
    }
  }

  return chunkBySize(book.chunks, 4).map((chunks, index, all) => ({
    title: `Section ${index + 1}`,
    label: `section ${index + 1} of ${all.length}`,
    chunks
  }));
}

function normalizeTocEntries(entries: TocEntry[]): TocEntry[] {
  return entries
    .filter((entry) => entry.pageNumber !== null)
    .sort((left, right) => {
      const leftPage = left.pageNumber ?? Number.POSITIVE_INFINITY;
      const rightPage = right.pageNumber ?? Number.POSITIVE_INFINITY;
      if (leftPage !== rightPage) {
        return leftPage - rightPage;
      }
      return left.level - right.level;
    });
}

function joinChunkText(chunks: BookChunk[]): string {
  return chunks
    .map((chunk, index) => {
      const pages = chunk.metadata.pageNumbers;
      const pageLabel = pages && pages.length > 0 ? `Pages ${pages.join(', ')}` : `Chunk ${index + 1}`;
      return `[${pageLabel}]\n${chunk.content}`;
    })
    .join('\n\n');
}

function wordsToMaxOutputTokens(maxWords: number): number {
  return Math.max(256, Math.ceil(maxWords * 1.8));
}

function chunkBySize<T>(items: T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    groups.push(items.slice(index, index + size));
  }
  return groups;
}

function estimateCollapseCallCount(noteCount: number): number {
  let currentCount = noteCount;
  let totalCalls = 0;

  while (currentCount > COLLAPSE_GROUP_SIZE) {
    currentCount = Math.ceil(currentCount / COLLAPSE_GROUP_SIZE);
    totalCalls += currentCount;
  }

  return totalCalls;
}

async function mapWithConcurrency<TInput, TOutput>(
  items: TInput[],
  concurrency: number,
  worker: (item: TInput, index: number) => Promise<TOutput>
): Promise<TOutput[]> {
  if (items.length === 0) {
    return [];
  }

  const results = new Array<TOutput>(items.length);
  let nextIndex = 0;

  const runWorker = async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      const item = items[currentIndex];
      if (item === undefined) {
        continue;
      }
      results[currentIndex] = await worker(item, currentIndex);
    }
  };

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}
