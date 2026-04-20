import { createHash } from 'node:crypto';
import {
  DETAIL_PROFILES,
  PARSER_VERSION,
  PROMPT_VERSION,
  SUMMARY_PLAN_VERSION,
  TOKENIZER_VERSION
} from '../config.js';
import type { BookChunk, ParsedBook, TocEntry } from '../book/types.js';
import { countPromptTokenBudget, countPromptTokens, countTextTokens } from '../tokenize/index.js';
import type { DetailLevel, SummaryMetadata } from '../types.js';
import {
  buildChunkMapPrompt,
  buildCollapseUserPrompt,
  buildReduceUserPrompt,
  buildSectionMapPrompt,
  buildSinglePassPrompt,
  buildSystemPromptText
} from '../summarize/prompts.js';
import type {
  SummaryPlan,
  SummaryPlanCall,
  SummaryPlanChunk,
  SummaryPlanChunkCall,
  SummaryPlanNotesCall
} from './types.js';

interface SectionGroup {
  title: string;
  label: string;
  chunkIndexes: number[];
}

export function buildSummaryPlan(book: ParsedBook, detail: DetailLevel): SummaryPlan {
  const profile = DETAIL_PROFILES[detail];
  const metadata = toSummaryMetadata(book);
  const systemPrompt = buildSystemPromptText();
  const warnings: string[] = [];
  const calls: SummaryPlanCall[] = [];
  const chunks = buildPlanChunks(book, profile.model);
  let sectionCount = 0;
  let strategy = profile.strategy;

  if (detail === 'short' && canUseSinglePass(book)) {
    strategy = 'single-pass';
    const text = joinChunkText(book.chunks);
    const messages = buildSinglePassPrompt({
      detail,
      metadata,
      targetWords: profile.targetWords,
      text
    });

    calls.push(
      createChunkCall({
        id: 'single-1',
        stage: 'single',
        model: profile.model,
        targetWords: profile.targetWords,
        chunkIndexes: chunks.map((chunk) => chunk.index),
        promptTokens: countPromptTokens(messages, profile.model),
        promptDigestInput: messages,
        reservedOutputTokens: wordsToMaxOutputTokens(profile.targetWords.max)
      })
    );
  } else if (detail === 'long') {
    const sections = buildSectionGroups(book);
    sectionCount = sections.length;

    if (sections.length <= 1) {
      warnings.push(
        'Long detail fell back to synthetic sections because no reliable TOC-based grouping was available.'
      );
    }

    const mapIds: string[] = [];
    const mapBudgets: number[] = [];

    sections.forEach((section, index) => {
      const text = joinChunkText(section.chunkIndexes.map((chunkIndex) => book.chunks[chunkIndex]!).filter(Boolean));
      const targetWords = { min: 180, max: 260 };
      const messages = buildSectionMapPrompt({
        detail,
        metadata,
        targetWords,
        sectionTitle: section.title,
        sectionLabel: section.label,
        text
      });
      const id = `section-map-${index + 1}`;
      const reservedOutputTokens = wordsToMaxOutputTokens(targetWords.max);
      calls.push(
        createChunkCall({
          id,
          stage: 'section-map',
          model: profile.model,
          targetWords,
          chunkIndexes: section.chunkIndexes,
          promptTokens: countPromptTokens(messages, profile.model),
          promptDigestInput: messages,
          reservedOutputTokens,
          sectionTitle: section.title,
          sectionLabel: section.label
        })
      );
      mapIds.push(id);
      mapBudgets.push(reservedOutputTokens);
    });

    const reduceInputs = appendCollapseCalls({
      calls,
      detail,
      metadata,
      model: profile.model,
      systemPrompt,
      noteIds: mapIds,
      noteBudgets: mapBudgets
    });

    calls.push(
      createNotesCall({
        id: 'reduce-1',
        stage: 'reduce',
        model: profile.model,
        targetWords: profile.targetWords,
        noteRefs: reduceInputs.noteIds,
        noteTokenBudgets: reduceInputs.noteBudgets,
        notesLabel: 'book-summary',
        promptTokens: countPromptTokenBudget({
          systemPrompt,
          userPrefix: buildReduceUserPrompt({
            detail,
            metadata,
            targetWords: profile.targetWords,
            notesLabel: 'book-summary'
          }),
          noteBudgets: reduceInputs.noteBudgets,
          model: profile.model
        }),
        promptDigestInput: {
          kind: 'reduce',
          detail,
          metadata,
          targetWords: profile.targetWords,
          notesLabel: 'book-summary',
          noteRefs: reduceInputs.noteIds,
          noteTokenBudgets: reduceInputs.noteBudgets
        },
        reservedOutputTokens: wordsToMaxOutputTokens(profile.targetWords.max)
      })
    );
  } else {
    const groups = chunkBySize(chunks.map((chunk) => chunk.index), profile.mapGroupSize);
    const mapIds: string[] = [];
    const mapBudgets: number[] = [];

    groups.forEach((group, index) => {
      const targetWords = detail === 'short' ? { min: 80, max: 130 } : { min: 120, max: 180 };
      const messages = buildChunkMapPrompt({
        detail,
        metadata,
        targetWords,
        chunkLabel: `group ${index + 1} of ${groups.length}`,
        text: joinChunkText(group.map((chunkIndex) => book.chunks[chunkIndex]!).filter(Boolean))
      });
      const id = `map-${index + 1}`;
      const reservedOutputTokens = wordsToMaxOutputTokens(targetWords.max);
      calls.push(
        createChunkCall({
          id,
          stage: 'map',
          model: profile.model,
          targetWords,
          chunkIndexes: group,
          chunkLabel: `group ${index + 1} of ${groups.length}`,
          promptTokens: countPromptTokens(messages, profile.model),
          promptDigestInput: messages,
          reservedOutputTokens
        })
      );
      mapIds.push(id);
      mapBudgets.push(reservedOutputTokens);
    });

    const reduceInputs = appendCollapseCalls({
      calls,
      detail,
      metadata,
      model: profile.model,
      systemPrompt,
      noteIds: mapIds,
      noteBudgets: mapBudgets
    });

    calls.push(
      createNotesCall({
        id: 'reduce-1',
        stage: 'reduce',
        model: profile.model,
        targetWords: profile.targetWords,
        noteRefs: reduceInputs.noteIds,
        noteTokenBudgets: reduceInputs.noteBudgets,
        notesLabel: 'book-summary',
        promptTokens: countPromptTokenBudget({
          systemPrompt,
          userPrefix: buildReduceUserPrompt({
            detail,
            metadata,
            targetWords: profile.targetWords,
            notesLabel: 'book-summary'
          }),
          noteBudgets: reduceInputs.noteBudgets,
          model: profile.model
        }),
        promptDigestInput: {
          kind: 'reduce',
          detail,
          metadata,
          targetWords: profile.targetWords,
          notesLabel: 'book-summary',
          noteRefs: reduceInputs.noteIds,
          noteTokenBudgets: reduceInputs.noteBudgets
        },
        reservedOutputTokens: wordsToMaxOutputTokens(profile.targetWords.max)
      })
    );
  }

  const totals = calls.reduce(
    (result, call) => ({
      callCount: result.callCount + 1,
      promptTokens: result.promptTokens + call.promptTokens,
      reservedOutputTokens: result.reservedOutputTokens + call.reservedOutputTokens,
      totalReservedTokens: result.totalReservedTokens + call.totalReservedTokens
    }),
    {
      callCount: 0,
      promptTokens: 0,
      reservedOutputTokens: 0,
      totalReservedTokens: 0
    }
  );

  return {
    version: SUMMARY_PLAN_VERSION,
    detail,
    fileType: book.fileType,
    metadata,
    parserVersion: PARSER_VERSION,
    tokenizerVersion: TOKENIZER_VERSION,
    promptVersion: PROMPT_VERSION,
    strategy,
    chunks,
    calls,
    totals,
    sectionCount: sectionCount || undefined,
    warnings: warnings.length > 0 ? warnings : undefined
  };
}

function appendCollapseCalls(parameters: {
  calls: SummaryPlanCall[];
  detail: DetailLevel;
  metadata: SummaryMetadata;
  model: string;
  systemPrompt: string;
  noteIds: string[];
  noteBudgets: number[];
}): { noteIds: string[]; noteBudgets: number[] } {
  const { calls, detail, metadata, model, systemPrompt } = parameters;
  let noteIds = parameters.noteIds;
  let noteBudgets = parameters.noteBudgets;
  let round = 1;

  while (noteIds.length > 6) {
    const groupedIds = chunkBySize(noteIds, 6);
    const groupedBudgets = chunkBySize(noteBudgets, 6);
    const nextIds: string[] = [];
    const nextBudgets: number[] = [];

    groupedIds.forEach((group, index) => {
      const targetWords = detail === 'short' ? { min: 120, max: 180 } : { min: 180, max: 260 };
      const stageLabel = `round ${round} group ${index + 1} of ${groupedIds.length}`;
      const noteTokenBudgets = groupedBudgets[index] ?? [];
      const id = `collapse-${round}-${index + 1}`;
      const reservedOutputTokens = wordsToMaxOutputTokens(targetWords.max);

      calls.push(
        createNotesCall({
          id,
          stage: 'collapse',
          model,
          targetWords,
          noteRefs: group,
          noteTokenBudgets,
          notesLabel: 'intermediate-notes',
          stageLabel,
          promptTokens: countPromptTokenBudget({
            systemPrompt,
            userPrefix: buildCollapseUserPrompt({
              detail,
              metadata,
              targetWords,
              stageLabel
            }),
            noteBudgets: noteTokenBudgets,
            model
          }),
          promptDigestInput: {
            kind: 'collapse',
            detail,
            metadata,
            targetWords,
            stageLabel,
            noteRefs: group,
            noteTokenBudgets
          },
          reservedOutputTokens
        })
      );

      nextIds.push(id);
      nextBudgets.push(reservedOutputTokens);
    });

    noteIds = nextIds;
    noteBudgets = nextBudgets;
    round += 1;
  }

  return { noteIds, noteBudgets };
}

function buildPlanChunks(book: ParsedBook, model: string): SummaryPlanChunk[] {
  return book.chunks.map((chunk, index) => ({
    index,
    pageNumbers: chunk.metadata.pageNumbers,
    tokenCount: countTextTokens(chunk.content, model),
    charCount: chunk.content.length,
    digest: sha256(
      JSON.stringify({
        content: chunk.content,
        pageNumbers: chunk.metadata.pageNumbers ?? []
      })
    )
  }));
}

function createChunkCall(parameters: {
  id: string;
  stage: SummaryPlanChunkCall['stage'];
  model: string;
  targetWords: { min: number; max: number };
  chunkIndexes: number[];
  promptTokens: number;
  promptDigestInput: unknown;
  reservedOutputTokens: number;
  chunkLabel?: string | undefined;
  sectionTitle?: string | undefined;
  sectionLabel?: string | undefined;
}): SummaryPlanChunkCall {
  return {
    id: parameters.id,
    stage: parameters.stage,
    sourceKind: 'chunks',
    model: parameters.model,
    targetWords: parameters.targetWords,
    chunkIndexes: parameters.chunkIndexes,
    chunkLabel: parameters.chunkLabel,
    sectionTitle: parameters.sectionTitle,
    sectionLabel: parameters.sectionLabel,
    promptTokens: parameters.promptTokens,
    reservedOutputTokens: parameters.reservedOutputTokens,
    totalReservedTokens: parameters.promptTokens + parameters.reservedOutputTokens,
    promptDigest: sha256(JSON.stringify(parameters.promptDigestInput))
  };
}

function createNotesCall(parameters: {
  id: string;
  stage: SummaryPlanNotesCall['stage'];
  model: string;
  targetWords: { min: number; max: number };
  noteRefs: string[];
  noteTokenBudgets: number[];
  notesLabel: string;
  promptTokens: number;
  promptDigestInput: unknown;
  reservedOutputTokens: number;
  stageLabel?: string | undefined;
}): SummaryPlanNotesCall {
  return {
    id: parameters.id,
    stage: parameters.stage,
    sourceKind: 'notes',
    model: parameters.model,
    targetWords: parameters.targetWords,
    noteRefs: parameters.noteRefs,
    noteTokenBudgets: parameters.noteTokenBudgets,
    notesLabel: parameters.notesLabel,
    stageLabel: parameters.stageLabel,
    promptTokens: parameters.promptTokens,
    reservedOutputTokens: parameters.reservedOutputTokens,
    totalReservedTokens: parameters.promptTokens + parameters.reservedOutputTokens,
    promptDigest: sha256(JSON.stringify(parameters.promptDigestInput))
  };
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
  const sourceEntries =
    topLevelEntries.length >= 2
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
      const chunkIndexes = book.chunks.flatMap((chunk, chunkIndex) => {
        const pages = chunk.metadata.pageNumbers ?? [];
        if (pages.length === 0) {
          return [];
        }
        const firstPage = Math.min(...pages);
        const lastPage = Math.max(...pages);
        return lastPage >= startPage && firstPage < endPage ? [chunkIndex] : [];
      });

      if (chunkIndexes.length > 0) {
        sections.push({
          title: entry.title,
          label: `section ${index + 1} of ${sourceEntries.length}`,
          chunkIndexes
        });
      }
    }

    if (sections.length >= 2) {
      return sections;
    }
  }

  return chunkBySize(book.chunks.map((_, index) => index), 4).map((chunkIndexes, index, all) => ({
    title: `Section ${index + 1}`,
    label: `section ${index + 1} of ${all.length}`,
    chunkIndexes
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

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
