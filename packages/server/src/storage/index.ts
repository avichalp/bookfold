import { randomUUID } from 'node:crypto';
import type { Client } from '@libsql/client';
import { STORAGE_SCHEMA_SQL } from './schema.js';
import type {
  ArtifactRecord,
  InboundPaymentRecord,
  JobEventRecord,
  JobRecord,
  OutboundPaymentRecord,
  PriceSheetRecord,
  QuoteRecord,
  UploadRecord
} from './types.js';

export class BookFoldStorage {
  constructor(private readonly client: Client) {}

  async bootstrap(): Promise<void> {
    await this.client.executeMultiple(STORAGE_SCHEMA_SQL);
    await this.ensureUploadColumn('request_key', 'TEXT');
    await this.ensureUploadColumn('upload_token_expires_at', 'TEXT');
    await this.client.execute(
      `CREATE INDEX IF NOT EXISTS uploads_request_key_status_idx
        ON uploads(request_key, status, upload_token_expires_at)`
    );
  }

  async close(): Promise<void> {
    this.client.close();
  }

  async createUpload(input: Omit<UploadRecord, 'createdAt' | 'id' | 'updatedAt'> & { id?: string | undefined }): Promise<UploadRecord> {
    const record: UploadRecord = {
      id: input.id ?? randomUUID(),
      blobPath: input.blobPath,
      fileName: input.fileName,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      status: input.status,
      digestSha256: input.digestSha256,
      requestKey: input.requestKey,
      uploadTokenExpiresAt: input.uploadTokenExpiresAt,
      metadata: input.metadata,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };

    await this.client.execute({
      sql: `INSERT INTO uploads
        (id, blob_path, file_name, content_type, size_bytes, status, digest_sha256, request_key, upload_token_expires_at, metadata_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        record.id,
        record.blobPath,
        record.fileName,
        record.contentType,
        record.sizeBytes,
        record.status,
        record.digestSha256 ?? null,
        record.requestKey ?? null,
        record.uploadTokenExpiresAt ?? null,
        stringifyJson(record.metadata),
        record.createdAt,
        record.updatedAt
      ]
    });

    return record;
  }

  async updateUpload(id: string, input: Partial<Pick<UploadRecord, 'digestSha256' | 'metadata' | 'status'>>): Promise<UploadRecord> {
    const current = await this.getUploadById(id);
    if (!current) {
      throw new Error(`Upload ${id} not found.`);
    }

    const updated: UploadRecord = {
      ...current,
      digestSha256: input.digestSha256 ?? current.digestSha256,
      metadata: input.metadata ?? current.metadata,
      status: input.status ?? current.status,
      updatedAt: nowIso()
    };

    await this.client.execute({
      sql: `UPDATE uploads
        SET status = ?, digest_sha256 = ?, metadata_json = ?, updated_at = ?
        WHERE id = ?`,
      args: [
        updated.status,
        updated.digestSha256 ?? null,
        stringifyJson(updated.metadata),
        updated.updatedAt,
        id
      ]
    });

    return updated;
  }

  async getUploadById(id: string): Promise<UploadRecord | undefined> {
    const result = await this.client.execute({
      sql: `SELECT * FROM uploads WHERE id = ?`,
      args: [id]
    });
    return result.rows[0] ? mapUpload(result.rows[0]) : undefined;
  }

  async getUploadByBlobPath(blobPath: string): Promise<UploadRecord | undefined> {
    const result = await this.client.execute({
      sql: `SELECT * FROM uploads WHERE blob_path = ?`,
      args: [blobPath]
    });
    return result.rows[0] ? mapUpload(result.rows[0]) : undefined;
  }

  async getPendingUploadSummary(
    requestKey: string,
    nowIsoValue: string
  ): Promise<{ count: number; earliestExpiresAt?: string | undefined }> {
    const result = await this.client.execute({
      sql: `SELECT COUNT(*) AS count, MIN(upload_token_expires_at) AS earliest_expires_at
        FROM uploads
        WHERE request_key = ?
          AND status = 'pending'
          AND upload_token_expires_at IS NOT NULL
          AND upload_token_expires_at > ?`,
      args: [requestKey, nowIsoValue]
    });
    const row = (result.rows[0] ?? {}) as Record<string, unknown>;

    return {
      count: asNumber(row.count ?? 0),
      earliestExpiresAt: asOptionalString(row.earliest_expires_at)
    };
  }

  async createQuote(input: Omit<QuoteRecord, 'createdAt' | 'id'> & { id?: string | undefined }): Promise<QuoteRecord> {
    const record: QuoteRecord = {
      id: input.id ?? randomUUID(),
      uploadId: input.uploadId,
      blobPath: input.blobPath,
      detail: input.detail,
      fileDigestSha256: input.fileDigestSha256,
      planHash: input.planHash,
      planJson: input.planJson,
      priceJson: input.priceJson,
      priceSheetVersion: input.priceSheetVersion,
      amount: input.amount,
      currency: input.currency,
      expiresAt: input.expiresAt,
      createdAt: nowIso()
    };

    await this.client.execute({
      sql: `INSERT INTO quotes
        (id, upload_id, blob_path, detail, file_digest_sha256, plan_hash, plan_json, price_json, price_sheet_version, amount, currency, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        record.id,
        record.uploadId,
        record.blobPath,
        record.detail,
        record.fileDigestSha256,
        record.planHash,
        record.planJson,
        record.priceJson,
        record.priceSheetVersion,
        record.amount,
        record.currency,
        record.expiresAt,
        record.createdAt
      ]
    });

    return record;
  }

  async getQuoteById(id: string): Promise<QuoteRecord | undefined> {
    const result = await this.client.execute({
      sql: `SELECT * FROM quotes WHERE id = ?`,
      args: [id]
    });
    return result.rows[0] ? mapQuote(result.rows[0]) : undefined;
  }

  async listRecentQuotesByDigest(input: {
    fileDigestSha256: string;
    detail: QuoteRecord['detail'];
    priceSheetVersion: string;
    currency: string;
    limit?: number | undefined;
  }): Promise<QuoteRecord[]> {
    const result = await this.client.execute({
      sql: `SELECT * FROM quotes
        WHERE file_digest_sha256 = ?
          AND detail = ?
          AND price_sheet_version = ?
          AND currency = ?
        ORDER BY created_at DESC
        LIMIT ?`,
      args: [
        input.fileDigestSha256,
        input.detail,
        input.priceSheetVersion,
        input.currency,
        input.limit ?? 10
      ]
    });

    return result.rows.map((row) => mapQuote(row));
  }

  async createInboundPayment(
    input: Omit<InboundPaymentRecord, 'createdAt' | 'id' | 'updatedAt'> & { id?: string | undefined }
  ): Promise<InboundPaymentRecord> {
    const record: InboundPaymentRecord = {
      id: input.id ?? randomUUID(),
      receiptReference: input.receiptReference,
      paymentMethod: input.paymentMethod,
      amount: input.amount,
      currency: input.currency,
      status: input.status,
      challengeId: input.challengeId,
      requestBodyDigest: input.requestBodyDigest,
      receipt: input.receipt,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };

    await this.client.execute({
      sql: `INSERT INTO inbound_payments
        (id, receipt_reference, payment_method, amount, currency, status, challenge_id, request_body_digest, receipt_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        record.id,
        record.receiptReference,
        record.paymentMethod,
        record.amount,
        record.currency,
        record.status,
        record.challengeId ?? null,
        record.requestBodyDigest ?? null,
        stringifyJson(record.receipt),
        record.createdAt,
        record.updatedAt
      ]
    });

    return record;
  }

  async getInboundPaymentByReceiptReference(receiptReference: string): Promise<InboundPaymentRecord | undefined> {
    const result = await this.client.execute({
      sql: `SELECT * FROM inbound_payments WHERE receipt_reference = ?`,
      args: [receiptReference]
    });
    return result.rows[0] ? mapInboundPayment(result.rows[0]) : undefined;
  }

  async getInboundPaymentById(id: string): Promise<InboundPaymentRecord | undefined> {
    const result = await this.client.execute({
      sql: `SELECT * FROM inbound_payments WHERE id = ?`,
      args: [id]
    });
    return result.rows[0] ? mapInboundPayment(result.rows[0]) : undefined;
  }

  async createJob(input: Omit<JobRecord, 'createdAt' | 'id' | 'updatedAt'> & { id?: string | undefined }): Promise<JobRecord> {
    const record: JobRecord = {
      id: input.id ?? randomUUID(),
      quoteId: input.quoteId,
      uploadId: input.uploadId,
      inboundPaymentId: input.inboundPaymentId,
      status: input.status,
      workflowRunId: input.workflowRunId,
      resultArtifactId: input.resultArtifactId,
      resultBlobPath: input.resultBlobPath,
      warnings: input.warnings,
      errorMessage: input.errorMessage,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      startedAt: input.startedAt,
      completedAt: input.completedAt
    };

    await this.client.execute({
      sql: `INSERT INTO jobs
        (id, quote_id, upload_id, inbound_payment_id, status, workflow_run_id, result_artifact_id, result_blob_path, warnings_json, error_message, created_at, updated_at, started_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        record.id,
        record.quoteId,
        record.uploadId,
        record.inboundPaymentId ?? null,
        record.status,
        record.workflowRunId ?? null,
        record.resultArtifactId ?? null,
        record.resultBlobPath ?? null,
        stringifyJson(record.warnings),
        record.errorMessage ?? null,
        record.createdAt,
        record.updatedAt,
        record.startedAt ?? null,
        record.completedAt ?? null
      ]
    });

    return record;
  }

  async updateJob(id: string, input: Partial<Omit<JobRecord, 'createdAt' | 'id' | 'quoteId' | 'uploadId'>>): Promise<JobRecord> {
    const current = await this.getJobById(id);
    if (!current) {
      throw new Error(`Job ${id} not found.`);
    }

    const has = <TKey extends keyof typeof input>(key: TKey) =>
      Object.prototype.hasOwnProperty.call(input, key);

    const updated: JobRecord = {
      ...current,
      inboundPaymentId: has('inboundPaymentId') ? input.inboundPaymentId : current.inboundPaymentId,
      status: input.status ?? current.status,
      workflowRunId: has('workflowRunId') ? input.workflowRunId : current.workflowRunId,
      resultArtifactId: has('resultArtifactId') ? input.resultArtifactId : current.resultArtifactId,
      resultBlobPath: has('resultBlobPath') ? input.resultBlobPath : current.resultBlobPath,
      warnings: has('warnings') ? input.warnings : current.warnings,
      errorMessage: has('errorMessage') ? input.errorMessage : current.errorMessage,
      updatedAt: nowIso(),
      startedAt: has('startedAt') ? input.startedAt : current.startedAt,
      completedAt: has('completedAt') ? input.completedAt : current.completedAt
    };

    await this.client.execute({
      sql: `UPDATE jobs
        SET inbound_payment_id = ?, status = ?, workflow_run_id = ?, result_artifact_id = ?, result_blob_path = ?, warnings_json = ?, error_message = ?, updated_at = ?, started_at = ?, completed_at = ?
        WHERE id = ?`,
      args: [
        updated.inboundPaymentId ?? null,
        updated.status,
        updated.workflowRunId ?? null,
        updated.resultArtifactId ?? null,
        updated.resultBlobPath ?? null,
        stringifyJson(updated.warnings),
        updated.errorMessage ?? null,
        updated.updatedAt,
        updated.startedAt ?? null,
        updated.completedAt ?? null,
        id
      ]
    });

    return updated;
  }

  async getJobById(id: string): Promise<JobRecord | undefined> {
    const result = await this.client.execute({
      sql: `SELECT * FROM jobs WHERE id = ?`,
      args: [id]
    });
    return result.rows[0] ? mapJob(result.rows[0]) : undefined;
  }

  async getJobByQuoteId(quoteId: string): Promise<JobRecord | undefined> {
    const result = await this.client.execute({
      sql: `SELECT * FROM jobs WHERE quote_id = ?`,
      args: [quoteId]
    });
    return result.rows[0] ? mapJob(result.rows[0]) : undefined;
  }

  async getJobByInboundPaymentId(inboundPaymentId: string): Promise<JobRecord | undefined> {
    const result = await this.client.execute({
      sql: `SELECT * FROM jobs WHERE inbound_payment_id = ?`,
      args: [inboundPaymentId]
    });
    return result.rows[0] ? mapJob(result.rows[0]) : undefined;
  }

  async listJobsByStatus(status: string): Promise<JobRecord[]> {
    const result = await this.client.execute({
      sql: `SELECT * FROM jobs WHERE status = ? ORDER BY created_at ASC`,
      args: [status]
    });
    return result.rows.map((row) => mapJob(row));
  }

  async appendJobEvent(input: Omit<JobEventRecord, 'createdAt' | 'id'> & { id?: string | undefined }): Promise<JobEventRecord> {
    const record: JobEventRecord = {
      id: input.id ?? randomUUID(),
      jobId: input.jobId,
      eventType: input.eventType,
      payload: input.payload,
      createdAt: nowIso()
    };

    await this.client.execute({
      sql: `INSERT INTO job_events (id, job_id, event_type, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?)`,
      args: [record.id, record.jobId, record.eventType, stringifyJson(record.payload), record.createdAt]
    });

    return record;
  }

  async listJobEvents(jobId: string): Promise<JobEventRecord[]> {
    const result = await this.client.execute({
      sql: `SELECT * FROM job_events WHERE job_id = ? ORDER BY created_at ASC`,
      args: [jobId]
    });
    return result.rows.map((row) => mapJobEvent(row));
  }

  async createOutboundPayment(
    input: Omit<OutboundPaymentRecord, 'createdAt' | 'id' | 'updatedAt'> & { id?: string | undefined }
  ): Promise<OutboundPaymentRecord> {
    const record: OutboundPaymentRecord = {
      id: input.id ?? randomUUID(),
      jobId: input.jobId,
      provider: input.provider,
      kind: input.kind,
      status: input.status,
      spent: input.spent,
      cumulative: input.cumulative,
      channelId: input.channelId,
      requestCount: input.requestCount,
      receipt: input.receipt,
      closeError: input.closeError,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };

    await this.client.execute({
      sql: `INSERT INTO outbound_payments
        (id, job_id, provider, kind, status, spent, cumulative, channel_id, request_count, receipt_json, close_error, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        record.id,
        record.jobId,
        record.provider,
        record.kind,
        record.status,
        record.spent,
        record.cumulative,
        record.channelId ?? null,
        record.requestCount ?? null,
        stringifyJson(record.receipt),
        record.closeError ?? null,
        record.createdAt,
        record.updatedAt
      ]
    });

    return record;
  }

  async listOutboundPayments(jobId: string): Promise<OutboundPaymentRecord[]> {
    const result = await this.client.execute({
      sql: `SELECT * FROM outbound_payments WHERE job_id = ? ORDER BY created_at ASC`,
      args: [jobId]
    });
    return result.rows.map((row) => mapOutboundPayment(row));
  }

  async createArtifact(input: Omit<ArtifactRecord, 'createdAt' | 'id'> & { id?: string | undefined }): Promise<ArtifactRecord> {
    const record: ArtifactRecord = {
      id: input.id ?? randomUUID(),
      jobId: input.jobId,
      kind: input.kind,
      blobPath: input.blobPath,
      metadata: input.metadata,
      createdAt: nowIso()
    };

    await this.client.execute({
      sql: `INSERT INTO artifacts (id, job_id, kind, blob_path, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`,
      args: [record.id, record.jobId, record.kind, record.blobPath, stringifyJson(record.metadata), record.createdAt]
    });

    return record;
  }

  async getArtifactById(id: string): Promise<ArtifactRecord | undefined> {
    const result = await this.client.execute({
      sql: `SELECT * FROM artifacts WHERE id = ?`,
      args: [id]
    });
    return result.rows[0] ? mapArtifact(result.rows[0]) : undefined;
  }

  async getArtifactByBlobPath(blobPath: string): Promise<ArtifactRecord | undefined> {
    const result = await this.client.execute({
      sql: `SELECT * FROM artifacts WHERE blob_path = ?`,
      args: [blobPath]
    });
    return result.rows[0] ? mapArtifact(result.rows[0]) : undefined;
  }

  async upsertPriceSheet(record: PriceSheetRecord): Promise<PriceSheetRecord> {
    await this.client.execute({
      sql: `INSERT INTO price_sheets (version, payload_json, created_at)
        VALUES (?, ?, ?)
        ON CONFLICT(version) DO UPDATE SET payload_json = excluded.payload_json`,
      args: [record.version, record.payloadJson, record.createdAt]
    });

    return record;
  }

  async getPriceSheet(version: string): Promise<PriceSheetRecord | undefined> {
    const result = await this.client.execute({
      sql: `SELECT * FROM price_sheets WHERE version = ?`,
      args: [version]
    });
    return result.rows[0] ? mapPriceSheet(result.rows[0]) : undefined;
  }

  async incrementRateLimitBucket(input: {
    scope: string;
    subjectKey: string;
    windowMs: number;
    windowStartMs: number;
    requestCount: number;
    byteCount: number;
  }): Promise<{ requestCount: number; byteCount: number }> {
    const now = nowIso();
    const result = await this.client.execute({
      sql: `INSERT INTO rate_limit_buckets
        (scope, subject_key, window_ms, window_start_ms, request_count, byte_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope, subject_key, window_ms, window_start_ms)
        DO UPDATE SET
          request_count = rate_limit_buckets.request_count + excluded.request_count,
          byte_count = rate_limit_buckets.byte_count + excluded.byte_count,
          updated_at = excluded.updated_at
        RETURNING request_count, byte_count`,
      args: [
        input.scope,
        input.subjectKey,
        input.windowMs,
        input.windowStartMs,
        input.requestCount,
        input.byteCount,
        now,
        now
      ]
    });
    const row = result.rows[0];
    if (!row) {
      throw new Error('Rate limit bucket increment did not return a row.');
    }

    return {
      requestCount: asNumber(row.request_count),
      byteCount: asNumber(row.byte_count)
    };
  }

  async pruneRateLimitBuckets(beforeWindowStartMs: number): Promise<void> {
    await this.client.execute({
      sql: `DELETE FROM rate_limit_buckets WHERE window_start_ms < ?`,
      args: [beforeWindowStartMs]
    });
  }

  private async ensureUploadColumn(name: string, definition: string): Promise<void> {
    const result = await this.client.execute({
      sql: 'PRAGMA table_info(uploads)'
    });
    if (result.rows.some((row) => row.name === name)) {
      return;
    }

    await this.client.execute({
      sql: `ALTER TABLE uploads ADD COLUMN ${name} ${definition}`
    });
  }
}

function mapUpload(row: Record<string, unknown>): UploadRecord {
  return {
    id: asString(row.id),
    blobPath: asString(row.blob_path),
    fileName: asString(row.file_name),
    contentType: asString(row.content_type),
    sizeBytes: asNumber(row.size_bytes),
    status: asString(row.status) as UploadRecord['status'],
    digestSha256: asOptionalString(row.digest_sha256),
    requestKey: asOptionalString(row.request_key),
    uploadTokenExpiresAt: asOptionalString(row.upload_token_expires_at),
    metadata: parseJson(row.metadata_json),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at)
  };
}

function mapQuote(row: Record<string, unknown>): QuoteRecord {
  return {
    id: asString(row.id),
    uploadId: asString(row.upload_id),
    blobPath: asString(row.blob_path),
    detail: asString(row.detail) as QuoteRecord['detail'],
    fileDigestSha256: asString(row.file_digest_sha256),
    planHash: asString(row.plan_hash),
    planJson: asString(row.plan_json),
    priceJson: asString(row.price_json),
    priceSheetVersion: asString(row.price_sheet_version),
    amount: asString(row.amount),
    currency: asString(row.currency),
    expiresAt: asString(row.expires_at),
    createdAt: asString(row.created_at)
  };
}

function mapInboundPayment(row: Record<string, unknown>): InboundPaymentRecord {
  return {
    id: asString(row.id),
    receiptReference: asString(row.receipt_reference),
    paymentMethod: asString(row.payment_method),
    amount: asString(row.amount),
    currency: asString(row.currency),
    status: asString(row.status) as InboundPaymentRecord['status'],
    challengeId: asOptionalString(row.challenge_id),
    requestBodyDigest: asOptionalString(row.request_body_digest),
    receipt: parseJson(row.receipt_json),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at)
  };
}

function mapJob(row: Record<string, unknown>): JobRecord {
  return {
    id: asString(row.id),
    quoteId: asString(row.quote_id),
    uploadId: asString(row.upload_id),
    inboundPaymentId: asOptionalString(row.inbound_payment_id),
    status: asString(row.status) as JobRecord['status'],
    workflowRunId: asOptionalString(row.workflow_run_id),
    resultArtifactId: asOptionalString(row.result_artifact_id),
    resultBlobPath: asOptionalString(row.result_blob_path),
    warnings: parseJson(row.warnings_json),
    errorMessage: asOptionalString(row.error_message),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
    startedAt: asOptionalString(row.started_at),
    completedAt: asOptionalString(row.completed_at)
  };
}

function mapJobEvent(row: Record<string, unknown>): JobEventRecord {
  return {
    id: asString(row.id),
    jobId: asString(row.job_id),
    eventType: asString(row.event_type),
    payload: parseJson(row.payload_json),
    createdAt: asString(row.created_at)
  };
}

function mapOutboundPayment(row: Record<string, unknown>): OutboundPaymentRecord {
  return {
    id: asString(row.id),
    jobId: asString(row.job_id),
    provider: asString(row.provider),
    kind: asString(row.kind),
    status: asString(row.status) as OutboundPaymentRecord['status'],
    spent: asString(row.spent),
    cumulative: asString(row.cumulative),
    channelId: asOptionalString(row.channel_id),
    requestCount: asOptionalNumber(row.request_count),
    receipt: parseJson(row.receipt_json),
    closeError: asOptionalString(row.close_error),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at)
  };
}

function mapArtifact(row: Record<string, unknown>): ArtifactRecord {
  return {
    id: asString(row.id),
    jobId: asString(row.job_id),
    kind: asString(row.kind),
    blobPath: asString(row.blob_path),
    metadata: parseJson(row.metadata_json),
    createdAt: asString(row.created_at)
  };
}

function mapPriceSheet(row: Record<string, unknown>): PriceSheetRecord {
  return {
    version: asString(row.version),
    payloadJson: asString(row.payload_json),
    createdAt: asString(row.created_at)
  };
}

function asString(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Expected database value to be a string.');
  }
  return value;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number {
  if (typeof value !== 'number') {
    throw new Error('Expected database value to be a number.');
  }
  return value;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function parseJson(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string' || !value) {
    return undefined;
  }

  return JSON.parse(value) as Record<string, unknown>;
}

function stringifyJson(value: Record<string, unknown> | undefined): string | null {
  return value ? JSON.stringify(value) : null;
}

function nowIso(): string {
  return new Date().toISOString();
}
