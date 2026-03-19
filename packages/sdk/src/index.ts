import { parseBookFromFile } from './book/index.js';
import { OpenAiMppProvider } from './provider/openai-mpp.js';
import { summarizeParsedBook } from './summarize/index.js';
import type { SummarizeBookOptions, SummaryResult, SummarizationProvider } from './types.js';

export {
  createTempoWallet,
  formatWalletFundingMessage,
  resolveTempoWallet
} from './wallet.js';
export { recoverTempoSessions } from './recovery.js';
export type {
  RecoverTempoSessionsOptions,
  TempoRecoveryProgressEvent,
  TempoRecoveryReport
} from './recovery.js';
export type {
  ProgressEvent,
  SummarizeBookOptions,
  SummaryResult
} from './types.js';
export type { TempoWalletInfo } from './wallet.js';

export async function summarizeBook(options: SummarizeBookOptions): Promise<SummaryResult> {
  let provider: SummarizationProvider | undefined;
  let prepared: Omit<SummaryResult, 'payment'> | undefined;
  let failure: unknown;
  let closeError: string | undefined;

  try {
    options.onProgress?.({
      step: 'load',
      message: 'Loading local book file.',
      detail: { filePath: options.filePath }
    });

    const book = await parseBookFromFile(options.filePath);

    options.onProgress?.({
      step: 'parse',
      message: `Parsed ${book.fileType.toUpperCase()} into ${book.chunks.length} chunks.`,
      detail: {
        fileType: book.fileType,
        chunkCount: book.chunks.length,
        pageCount: book.metadata.pageCount,
        chapterCount: book.metadata.chapterCount
      }
    });

    provider = new OpenAiMppProvider();

    prepared = await summarizeParsedBook({
      book,
      detail: options.detail,
      provider,
      signal: options.signal,
      onProgress: options.onProgress
    });
  } catch (error) {
    failure = error;
  } finally {
    options.onProgress?.({
      step: 'close-session',
      message: 'Closing Tempo session.',
      detail: undefined
    });

    try {
      if (provider) {
        await provider.close();
      }
    } catch (error) {
      closeError = error instanceof Error ? error.message : String(error);
    }
  }

  if (!provider) {
    const baseMessage = failure instanceof Error ? failure.message : String(failure);
    throw new Error(closeError ? `${baseMessage} Also failed to close session: ${closeError}` : baseMessage);
  }

  const payment = provider.getPaymentSummary();
  if (closeError && !payment.closeError) {
    payment.closeError = closeError;
  }

  if (failure) {
    const baseMessage = failure instanceof Error ? failure.message : String(failure);
    throw new Error(closeError ? `${baseMessage} Also failed to close session: ${closeError}` : baseMessage);
  }

  if (!prepared) {
    throw new Error('Summarization failed before producing a result.');
  }

  const warnings = [
    ...(prepared.warnings ?? []),
    ...(payment.closeError ? [payment.closeError] : [])
  ];

  return {
    ...prepared,
    payment,
    warnings: warnings.length > 0 ? warnings : undefined
  };
}
