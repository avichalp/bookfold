import { type PaymentSummary, type SummaryResult } from '@bookfold/sdk';
import type { BlobStore } from './blob.js';

export const BOOKFOLD_JOB_WORKFLOW_ID = 'workflow//./workflows/bookfold-job//runBookFoldJobWorkflow';

export interface SummaryArtifactPayload {
  jobId: string;
  quoteId: string;
  createdAt: string;
  result: {
    summary: SummaryResult['summary'];
    detail: SummaryResult['detail'];
    metadata: SummaryResult['metadata'];
    debug: SummaryResult['debug'];
    warnings?: SummaryResult['warnings'] | undefined;
    payment: PaymentSummary;
  };
}

export function buildSummaryArtifactPath(jobId: string): string {
  return `artifacts/${jobId}/summary.json`;
}

export function encodeWarnings(warnings: string[] | undefined): Record<string, unknown> | undefined {
  if (!warnings || warnings.length === 0) {
    return undefined;
  }

  return { messages: warnings };
}

export function decodeWarnings(input: Record<string, unknown> | undefined): string[] | undefined {
  const messages = input?.messages;
  if (!Array.isArray(messages)) {
    return undefined;
  }

  const clean = messages.filter(
    (value): value is string => typeof value === 'string' && value.trim().length > 0
  );
  return clean.length > 0 ? clean : undefined;
}

export async function readSummaryArtifact(
  blobStore: BlobStore,
  blobPath: string
): Promise<SummaryArtifactPayload | undefined> {
  const blob = await blobStore.get(blobPath);
  if (!blob) {
    return undefined;
  }

  return JSON.parse(blob.body.toString('utf8')) as SummaryArtifactPayload;
}
