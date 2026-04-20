import { MAP_CONCURRENCY } from '../config.js';
import type { ParsedBook } from '../book/types.js';
import type {
  DetailLevel,
  ProgressEvent,
  SummaryDebugInfo,
  SummaryResult,
  SummarizationProvider
} from '../types.js';
import {
  buildChunkMapPrompt,
  buildCollapsePrompt,
  buildReducePrompt,
  buildSectionMapPrompt,
  buildSinglePassPrompt
} from '../summarize/prompts.js';
import type { SummaryPlan, SummaryPlanCall } from './types.js';

type PreparedSummaryResult = Omit<SummaryResult, 'payment'>;

export async function executeSummaryPlan(args: {
  book: ParsedBook;
  detail: DetailLevel;
  plan: SummaryPlan;
  provider: SummarizationProvider;
  signal?: AbortSignal | undefined;
  onProgress?: ((event: ProgressEvent) => void) | undefined;
}): Promise<PreparedSummaryResult> {
  const { book, detail, plan, provider, signal, onProgress } = args;
  const modelNames = new Set<string>();
  const outputs = new Map<string, string>();

  const chunkCalls = plan.calls.filter((call) => call.sourceKind === 'chunks');

  if (chunkCalls.length > 0) {
    onProgress?.({
      step: 'summarize',
      message: `Running ${plan.strategy} summary across ${chunkCalls.length} source calls.`,
      detail: {
        strategy: plan.strategy,
        chunkCount: book.chunks.length,
        callCount: plan.calls.length
      }
    });
  }

  const pending = [...plan.calls];

  while (pending.length > 0) {
    signal?.throwIfAborted();

    const ready = pending.filter((call) =>
      call.sourceKind === 'chunks' || call.noteRefs.every((ref) => outputs.has(ref))
    );

    if (ready.length === 0) {
      throw new Error('Summary plan execution is blocked by unresolved note dependencies.');
    }

    const readyIds = new Set(ready.map((call) => call.id));
    const results = await mapWithConcurrency(ready, MAP_CONCURRENCY, async (call) => {
      const messages = buildMessagesForCall({ book, call, detail, metadata: plan.metadata, outputs });
      const result = await provider.generateText({
        model: call.model,
        messages,
        maxOutputTokens: call.reservedOutputTokens,
        temperature: 0.2,
        signal
      });

      return {
        id: call.id,
        model: result.model,
        text: result.text.trim()
      };
    });

    results.forEach((result) => {
      modelNames.add(result.model);
      outputs.set(result.id, result.text);
    });

    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const call = pending[index];
      if (call && readyIds.has(call.id)) {
        pending.splice(index, 1);
      }
    }
  }

  const lastCall = plan.calls[plan.calls.length - 1];
  const summary = lastCall ? outputs.get(lastCall.id) : undefined;
  if (!summary) {
    throw new Error('Summary plan execution did not produce a final summary.');
  }

  const debug: SummaryDebugInfo = {
    chunkCount: book.chunks.length,
    modelCallCount: plan.calls.length,
    modelNames: Array.from(modelNames),
    strategy: plan.strategy,
    sectionCount: plan.sectionCount
  };

  return {
    summary,
    detail,
    metadata: plan.metadata,
    debug,
    warnings: plan.warnings
  };
}

function buildMessagesForCall(args: {
  book: ParsedBook;
  call: SummaryPlanCall;
  detail: DetailLevel;
  metadata: SummaryResult['metadata'];
  outputs: Map<string, string>;
}) {
  const { book, call, detail, metadata, outputs } = args;

  if (call.sourceKind === 'chunks') {
    const chunks = call.chunkIndexes.map((index) => book.chunks[index]!).filter(Boolean);
    const text = joinChunkText(chunks);

    switch (call.stage) {
      case 'single':
        return buildSinglePassPrompt({
          detail,
          metadata,
          targetWords: call.targetWords,
          text
        });
      case 'map':
        return buildChunkMapPrompt({
          detail,
          metadata,
          targetWords: call.targetWords,
          chunkLabel: call.chunkLabel ?? call.id,
          text
        });
      case 'section-map':
        return buildSectionMapPrompt({
          detail,
          metadata,
          targetWords: call.targetWords,
          sectionTitle: call.sectionTitle ?? call.id,
          sectionLabel: call.sectionLabel ?? call.id,
          text
        });
      default:
        throw new Error(`Unsupported chunk call stage "${call.stage}".`);
    }
  }

  const notes = call.noteRefs.map((ref) => {
    const note = outputs.get(ref);
    if (!note) {
      throw new Error(`Missing note output for ${ref}.`);
    }
    return note;
  });

  switch (call.stage) {
    case 'collapse':
      return buildCollapsePrompt({
        detail,
        metadata,
        targetWords: call.targetWords,
        stageLabel: call.stageLabel ?? call.id,
        notes
      });
    case 'reduce':
      return buildReducePrompt({
        detail,
        metadata,
        targetWords: call.targetWords,
        notesLabel: call.notesLabel,
        notes
      });
    default:
      throw new Error(`Unsupported notes call stage "${call.stage}".`);
  }
}

function joinChunkText(chunks: ParsedBook['chunks']): string {
  return chunks
    .map((chunk, index) => {
      const pages = chunk.metadata.pageNumbers;
      const pageLabel = pages && pages.length > 0 ? `Pages ${pages.join(', ')}` : `Chunk ${index + 1}`;
      return `[${pageLabel}]\n${chunk.content}`;
    })
    .join('\n\n');
}

async function mapWithConcurrency<TInput, TOutput>(
  items: TInput[],
  concurrency: number,
  worker: (item: TInput) => Promise<TOutput>
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
      results[currentIndex] = await worker(item);
    }
  };

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}
