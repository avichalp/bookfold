export type UploadStatus = 'pending' | 'uploaded' | 'failed';
export type JobStatus =
  | 'quoted'
  | 'paid'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'refund_review';
export type PaymentStatus = 'pending' | 'paid' | 'failed';

export interface UploadRecord {
  id: string;
  blobPath: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  status: UploadStatus;
  digestSha256?: string | undefined;
  requestKey?: string | undefined;
  uploadTokenExpiresAt?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface QuoteRecord {
  id: string;
  uploadId: string;
  blobPath: string;
  detail: 'short' | 'medium' | 'long';
  fileDigestSha256: string;
  planHash: string;
  planJson: string;
  priceJson: string;
  priceSheetVersion: string;
  amount: string;
  currency: string;
  expiresAt: string;
  createdAt: string;
}

export interface JobRecord {
  id: string;
  quoteId: string;
  uploadId: string;
  inboundPaymentId?: string | undefined;
  status: JobStatus;
  workflowRunId?: string | undefined;
  resultArtifactId?: string | undefined;
  resultBlobPath?: string | undefined;
  warnings?: Record<string, unknown> | undefined;
  errorMessage?: string | undefined;
  createdAt: string;
  updatedAt: string;
  startedAt?: string | undefined;
  completedAt?: string | undefined;
}

export interface JobEventRecord {
  id: string;
  jobId: string;
  eventType: string;
  payload?: Record<string, unknown> | undefined;
  createdAt: string;
}

export interface InboundPaymentRecord {
  id: string;
  receiptReference: string;
  paymentMethod: string;
  amount: string;
  currency: string;
  status: PaymentStatus;
  challengeId?: string | undefined;
  requestBodyDigest?: string | undefined;
  receipt?: Record<string, unknown> | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface OutboundPaymentRecord {
  id: string;
  jobId: string;
  provider: string;
  kind: string;
  status: PaymentStatus;
  spent: string;
  cumulative: string;
  channelId?: string | undefined;
  requestCount?: number | undefined;
  receipt?: Record<string, unknown> | undefined;
  closeError?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactRecord {
  id: string;
  jobId: string;
  kind: string;
  blobPath: string;
  metadata?: Record<string, unknown> | undefined;
  createdAt: string;
}

export interface PriceSheetRecord {
  version: string;
  payloadJson: string;
  createdAt: string;
}
