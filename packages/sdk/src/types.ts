export type DetailLevel = 'short' | 'medium' | 'long';

export type OutputFormat = 'text' | 'json';

export type BookFileType = 'pdf' | 'epub';

export interface ProviderMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GenerateTextRequest {
  model: string;
  messages: ProviderMessage[];
  maxOutputTokens: number;
  temperature?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface GenerateTextResult {
  text: string;
  model: string;
  usage?: {
    inputTokens?: number | undefined;
    outputTokens?: number | undefined;
    totalTokens?: number | undefined;
  } | undefined;
}

export interface SummaryMetadata {
  title?: string | undefined;
  author?: string | undefined;
  fileType: BookFileType;
  pageCount?: number | undefined;
  chapterCount?: number | undefined;
}

export interface SummaryPaymentResult {
  provider: 'openai-mpp' | 'mock';
  baseUrl?: string | undefined;
  endpointPath?: string | undefined;
  maxDeposit?: string | undefined;
  spent: string;
  cumulative: string;
  channelId?: string | undefined;
  finalReceipt?: Record<string, unknown> | undefined;
  lastReceipt?: Record<string, unknown> | undefined;
  closeError?: string | undefined;
  requestCount?: number | undefined;
}

export interface SummaryDebugInfo {
  chunkCount: number;
  modelCallCount: number;
  modelNames: string[];
  strategy?: string | undefined;
  sectionCount?: number | undefined;
}

export interface SummaryResult {
  summary: string;
  detail: DetailLevel;
  metadata: SummaryMetadata;
  payment: SummaryPaymentResult;
  debug: SummaryDebugInfo;
  warnings?: string[] | undefined;
}

export interface ProgressEvent {
  step: 'load' | 'parse' | 'summarize' | 'close-session';
  message: string;
  detail?: Record<string, unknown> | undefined;
}

export interface SummarizationProvider {
  generateText(request: GenerateTextRequest): Promise<GenerateTextResult>;
  getPaymentSummary(): SummaryPaymentResult;
  close(): Promise<Record<string, unknown> | undefined>;
}

export interface SummarizeBookOptions {
  filePath: string;
  detail: DetailLevel;
  outputFormat?: OutputFormat;
  signal?: AbortSignal;
  provider?: SummarizationProvider | undefined;
  onProgress?: ((event: ProgressEvent) => void) | undefined;
}
