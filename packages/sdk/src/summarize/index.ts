import type { ParsedBook } from '../book/types.js';
import { buildSummaryPlan, executeSummaryPlan } from '../plan/index.js';
import type {
  DetailLevel,
  ProgressEvent,
  SummaryResult,
  SummarizationProvider
} from '../types.js';

type PreparedSummaryResult = Omit<SummaryResult, 'payment'>;

export async function summarizeParsedBook(args: {
  book: ParsedBook;
  detail: DetailLevel;
  provider: SummarizationProvider;
  signal?: AbortSignal | undefined;
  onProgress?: ((event: ProgressEvent) => void) | undefined;
}): Promise<PreparedSummaryResult> {
  const { book, detail, provider, signal, onProgress } = args;

  return executeSummaryPlan({
    book,
    detail,
    plan: buildSummaryPlan(book, detail),
    provider,
    signal,
    onProgress
  });
}
