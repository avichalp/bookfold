import { createHash } from 'node:crypto';
import { Receipt, Credential } from 'mppx';
import { Mppx, tempo } from 'mppx/server';
import { start } from 'workflow/api';
import {
  hashSummaryPlan,
  resolveTempoWallet,
  type SummaryPlan
} from '@bookfold/sdk';
import {
  PARSER_VERSION,
  PROMPT_VERSION,
  SUMMARY_PLAN_VERSION,
  TOKENIZER_VERSION
} from '@bookfold/sdk/config';
import { privateKeyToAccount } from 'viem/accounts';
import type { BlobStore } from './blob.js';
import type { ServerConfig } from './config.js';
import {
  BOOKFOLD_JOB_WORKFLOW_ID,
  decodeWarnings,
  readSummaryArtifact
} from './job-service.js';
import type { BookFoldStorage } from './storage/index.js';
import type { InboundPaymentRecord, JobRecord, QuoteRecord } from './storage/types.js';

const STARTABLE_JOB_STATUSES = new Set(['paid', 'queued', 'running']);

export interface JobStarter {
  start(jobId: string): Promise<{ runId: string }>;
}

export interface JobPaymentGateway {
  handleJobCreate(input: {
    request: Request;
    storage: BookFoldStorage;
    blobStore: BlobStore;
    config: ServerConfig;
    clock: () => Date;
    jobStarter: JobStarter;
  }): Promise<Response>;
}

export interface JobReader {
  read(input: {
    request: Request;
    storage: BookFoldStorage;
    blobStore: BlobStore;
  }): Promise<Response>;
}

export interface JobPaymentAuthorizer {
  authorize(input: {
    request: Request;
    quote: QuoteRecord;
    requestDigest: string;
  }): Promise<
    | {
        kind: 'challenge';
        response: Response;
        challengeId?: string | undefined;
      }
    | {
        kind: 'paid';
        challengeId?: string | undefined;
        receipt: Receipt.Receipt;
      }
  >;
}

export function createServerDependencies(input: { config: ServerConfig }): {
  paymentGateway: JobPaymentGateway;
  jobStarter: JobStarter;
  jobReader: JobReader;
} {
  const jobStarter = createWorkflowJobStarter();
  const authorizer = createMppJobPaymentAuthorizer(input.config);

  return {
    paymentGateway: createJobPaymentGateway({ authorizer }),
    jobStarter,
    jobReader: createJobReader()
  };
}

export function createWorkflowJobStarter(): JobStarter {
  return {
    async start(jobId: string) {
      const run = await start({ workflowId: BOOKFOLD_JOB_WORKFLOW_ID }, [jobId]);
      return { runId: run.runId };
    }
  };
}

export function createMppJobPaymentAuthorizer(config: ServerConfig): JobPaymentAuthorizer {
  if (!config.mppSecretKey) {
    throw new Error('Missing MPP_SECRET_KEY.');
  }

  const recipient = resolveInboundRecipient(config);
  if (!recipient) {
    throw new Error('Missing Tempo wallet for inbound MPP charges.');
  }

  const realm = new URL(config.baseUrl).host;
  const payment = Mppx.create({
    methods: [
      tempo.charge({
        chainId: config.tempoChainId,
        currency: config.tempoCurrency,
        decimals: config.tempoCurrencyDecimals,
        recipient
      })
    ],
    realm,
    secretKey: config.mppSecretKey
  });

  return {
    async authorize(input) {
      const challengeId = readChallengeId(input.request);
      const result = await payment.charge({
        amount: formatChargeAmount(input.quote.amount, config.tempoCurrencyDecimals),
        description: `BookFold ${input.quote.detail} summary`,
        externalId: input.quote.id
      })(input.request);

      if (result.status === 402) {
        return {
          kind: 'challenge',
          challengeId,
          response: result.challenge
        };
      }

      const receiptResponse = result.withReceipt(new Response(null, { status: 204 }));

      return {
        kind: 'paid',
        challengeId,
        receipt: Receipt.fromResponse(receiptResponse)
      };
    }
  };
}

function resolveInboundRecipient(config: Pick<ServerConfig, 'tempoPrivateKey'>): `0x${string}` | undefined {
  if (config.tempoPrivateKey) {
    return privateKeyToAccount(config.tempoPrivateKey).address;
  }

  return resolveTempoWallet()?.address;
}

export function formatChargeAmount(amount: string, decimals: number): string {
  if (!/^-?\d+$/.test(amount)) {
    throw new Error(`Expected an integer minor-unit amount, got "${amount}".`);
  }

  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error(`Expected decimals to be a non-negative integer, got "${decimals}".`);
  }

  const negative = amount.startsWith('-');
  const digits = negative ? amount.slice(1) : amount;
  if (decimals === 0) {
    return `${negative ? '-' : ''}${digits}`;
  }

  const padded = digits.padStart(decimals + 1, '0');
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, '');

  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

function assertQuoteCanBeExecuted(quote: QuoteRecord): void {
  const plan = parseStoredQuotePlan(quote);

  if (hashSummaryPlan(plan) !== quote.planHash) {
    throw new HttpError(500, 'invalid_quote_plan', `Stored plan hash mismatch for quote ${quote.id}.`);
  }

  const mismatches = [
    ['plan', plan.version, SUMMARY_PLAN_VERSION],
    ['parser', plan.parserVersion, PARSER_VERSION],
    ['tokenizer', plan.tokenizerVersion, TOKENIZER_VERSION],
    ['prompt', plan.promptVersion, PROMPT_VERSION]
  ].filter(([, stored, current]) => stored !== current);

  if (mismatches.length === 0) {
    return;
  }

  const detail = mismatches
    .map(([label, stored, current]) => `${label} ${stored} != ${current}`)
    .join(', ');

  throw new HttpError(
    409,
    'quote_incompatible',
    `Quote ${quote.id} is incompatible with the current plan versions: ${detail}. Create a new quote.`
  );
}

function parseStoredQuotePlan(quote: QuoteRecord): SummaryPlan {
  try {
    return JSON.parse(quote.planJson) as SummaryPlan;
  } catch {
    throw new HttpError(500, 'invalid_quote_plan', `Stored plan JSON is invalid for quote ${quote.id}.`);
  }
}

export function createJobPaymentGateway(input: {
  authorizer: JobPaymentAuthorizer;
}): JobPaymentGateway {
  return {
    async handleJobCreate({ request, storage, blobStore: _blobStore, config: _config, clock, jobStarter }) {
      try {
        const rawBody = await readBodyText(request);
        const payload = parseJsonObject(rawBody);
        const requestDigest = sha256Hex(rawBody);
        const quoteId = asNonEmptyString(payload.quoteId, 'quoteId');
        const quote = await storage.getQuoteById(quoteId);
        if (!quote) {
          return errorJson(404, 'quote_not_found', 'Quote was not found.');
        }

        const upload = await storage.getUploadById(quote.uploadId);
        if (!upload) {
          return errorJson(404, 'upload_not_found', 'Upload was not found for this quote.');
        }

        const existingJob = await storage.getJobByQuoteId(quote.id);
        if (existingJob) {
          if (existingJob.status === 'failed') {
            assertQuoteCanBeExecuted(quote);
          }

          const resumableJob = existingJob.status === 'failed'
            ? await storage.updateJob(existingJob.id, {
                status: 'paid',
                workflowRunId: undefined,
                resultArtifactId: undefined,
                resultBlobPath: undefined,
                warnings: undefined,
                errorMessage: undefined,
                completedAt: undefined
              })
            : existingJob;

          if (existingJob.status === 'failed') {
            await storage.appendJobEvent({
              jobId: existingJob.id,
              eventType: 'job.retry_requested',
              payload: {
                source: 'job.create.retry'
              }
            });
          }

          const ensured = await ensureJobWorkflowStarted({
            clock,
            job: resumableJob,
            jobStarter,
            source: 'job.create.retry',
            storage
          });
          return json(buildJobCreatePayload(ensured), 200);
        }

        if (new Date(quote.expiresAt).getTime() <= clock().getTime()) {
          return errorJson(410, 'quote_expired', 'Quote has expired.');
        }

        assertQuoteCanBeExecuted(quote);

        const authorization = await input.authorizer.authorize({
          request,
          quote,
          requestDigest
        });

        if (authorization.kind === 'challenge') {
          return authorization.response;
        }

        const inboundPayment = await getOrCreateInboundPayment({
          amount: quote.amount,
          challengeId: authorization.challengeId,
          clock,
          currency: quote.currency,
          receipt: authorization.receipt,
          requestBodyDigest: requestDigest,
          storage
        });

        const duplicateJob = await storage.getJobByQuoteId(quote.id);
        if (duplicateJob) {
          const reconciled = await reconcileJobInboundPayment({
            inboundPayment,
            job: duplicateJob,
            storage
          });
          const ensured = await ensureJobWorkflowStarted({
            clock,
            job: reconciled,
            jobStarter,
            source: 'job.create.retry',
            storage
          });
          return json(buildJobCreatePayload(ensured), 200);
        }

        let job: JobRecord;
        try {
          job = await storage.createJob({
            quoteId: quote.id,
            uploadId: upload.id,
            inboundPaymentId: inboundPayment.id,
            status: 'paid'
          });
        } catch (error) {
          if (!isUniqueConstraintError(error)) {
            throw error;
          }

          const conflictJob = await storage.getJobByQuoteId(quote.id);
          if (!conflictJob) {
            throw error;
          }

          const reconciled = await reconcileJobInboundPayment({
            inboundPayment,
            job: conflictJob,
            storage
          });
          const ensured = await ensureJobWorkflowStarted({
            clock,
            job: reconciled,
            jobStarter,
            source: 'job.create.retry',
            storage
          });
          return json(buildJobCreatePayload(ensured), 200);
        }

        await storage.appendJobEvent({
          jobId: job.id,
          eventType: 'job.paid',
          payload: {
            amount: inboundPayment.amount,
            currency: inboundPayment.currency,
            inboundPaymentId: inboundPayment.id,
            receiptReference: inboundPayment.receiptReference
          }
        });

        job = await ensureJobWorkflowStarted({
          clock,
          job,
          jobStarter,
          source: 'job.create',
          storage
        });

        return json(
          buildJobCreatePayload(job),
          job.workflowRunId ? 200 : 202
        );
      } catch (error) {
        if (error instanceof HttpError) {
          return errorJson(error.status, error.code, error.message);
        }

        throw error;
      }
    }
  };
}

export function createJobReader(): JobReader {
  return {
    async read({ request, storage, blobStore }) {
      try {
        const url = new URL(request.url);
        const parts = url.pathname.split('/').filter(Boolean);
        const jobId = parts.at(-1);

        if (!jobId) {
          return errorJson(400, 'invalid_job_id', 'Job id is required.');
        }

        const job = await storage.getJobById(jobId);
        if (!job) {
          return errorJson(404, 'job_not_found', 'Job was not found.');
        }

        const inboundPayment = job.inboundPaymentId
          ? await storage.getInboundPaymentById(job.inboundPaymentId)
          : undefined;
        const outboundPayments = await storage.listOutboundPayments(job.id);
        const artifact =
          job.resultBlobPath ? await readSummaryArtifact(blobStore, job.resultBlobPath) : undefined;

        const warnings = dedupeStrings([
          ...(decodeWarnings(job.warnings) ?? []),
          ...(artifact?.result.warnings ?? []),
          ...outboundPayments
            .map((payment) => payment.closeError)
            .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        ]);

        if (job.status === 'succeeded' && job.resultBlobPath && !artifact) {
          warnings.push('Summary artifact is missing from Blob storage.');
        }

        return json(
          {
            jobId: job.id,
            quoteId: job.quoteId,
            uploadId: job.uploadId,
            status: job.status,
            workflowRunId: job.workflowRunId,
            createdAt: job.createdAt,
            updatedAt: job.updatedAt,
            startedAt: job.startedAt,
            completedAt: job.completedAt,
            warnings: warnings.length > 0 ? warnings : undefined,
            error: job.errorMessage ? { message: job.errorMessage } : undefined,
            payment: {
              inbound: inboundPayment ? mapInboundPayment(inboundPayment) : undefined,
              outbound: outboundPayments.map((payment) => ({
                id: payment.id,
                provider: payment.provider,
                kind: payment.kind,
                status: payment.status,
                spent: payment.spent,
                cumulative: payment.cumulative,
                channelId: payment.channelId,
                requestCount: payment.requestCount,
                receipt: payment.receipt,
                closeError: payment.closeError,
                createdAt: payment.createdAt,
                updatedAt: payment.updatedAt
              }))
            },
            result: artifact
              ? {
                  summary: artifact.result.summary,
                  detail: artifact.result.detail,
                  metadata: artifact.result.metadata,
                  debug: artifact.result.debug
                }
              : undefined
          },
          200
        );
      } catch (error) {
        if (error instanceof HttpError) {
          return errorJson(error.status, error.code, error.message);
        }

        throw error;
      }
    }
  };
}

export async function ensureJobWorkflowStarted(input: {
  clock: () => Date;
  job: JobRecord;
  jobStarter: JobStarter;
  source: string;
  storage: BookFoldStorage;
}): Promise<JobRecord> {
  if (input.job.workflowRunId || !STARTABLE_JOB_STATUSES.has(input.job.status)) {
    return input.job;
  }

  try {
    const run = await input.jobStarter.start(input.job.id);
    const updated = await input.storage.updateJob(input.job.id, {
      status: 'queued',
      workflowRunId: run.runId
    });

    await input.storage.appendJobEvent({
      jobId: input.job.id,
      eventType: 'job.queued',
      payload: {
        runId: run.runId,
        source: input.source
      }
    });

    if (input.source === 'recovery') {
      await input.storage.appendJobEvent({
        jobId: input.job.id,
        eventType: 'job.recovered',
        payload: {
          runId: run.runId,
          recoveredAt: input.clock().toISOString()
        }
      });
    }

    return updated;
  } catch (error) {
    await input.storage.appendJobEvent({
      jobId: input.job.id,
      eventType: 'job.workflow_start_failed',
      payload: {
        message: error instanceof Error ? error.message : String(error),
        source: input.source
      }
    });

    return input.job;
  }
}

async function reconcileJobInboundPayment(input: {
  inboundPayment: InboundPaymentRecord;
  job: JobRecord;
  storage: BookFoldStorage;
}): Promise<JobRecord> {
  if (!input.job.inboundPaymentId) {
    return input.storage.updateJob(input.job.id, {
      inboundPaymentId: input.inboundPayment.id
    });
  }

  if (input.job.inboundPaymentId !== input.inboundPayment.id) {
    await input.storage.appendJobEvent({
      jobId: input.job.id,
      eventType: 'payment.duplicate_inbound_detected',
      payload: {
        existingInboundPaymentId: input.job.inboundPaymentId,
        inboundPaymentId: input.inboundPayment.id,
        receiptReference: input.inboundPayment.receiptReference
      }
    });
  }

  return input.job;
}

async function getOrCreateInboundPayment(input: {
  amount: string;
  challengeId?: string | undefined;
  clock: () => Date;
  currency: string;
  receipt: Receipt.Receipt;
  requestBodyDigest: string;
  storage: BookFoldStorage;
}): Promise<InboundPaymentRecord> {
  const existing = await input.storage.getInboundPaymentByReceiptReference(input.receipt.reference);
  if (existing) {
    return existing;
  }

  try {
    return await input.storage.createInboundPayment({
      receiptReference: input.receipt.reference,
      paymentMethod: input.receipt.method,
      amount: input.amount,
      currency: input.currency,
      status: 'paid',
      challengeId: input.challengeId,
      requestBodyDigest: input.requestBodyDigest,
      receipt: {
        ...input.receipt,
        recordedAt: input.clock().toISOString()
      }
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error;
    }

    const current = await input.storage.getInboundPaymentByReceiptReference(input.receipt.reference);
    if (!current) {
      throw error;
    }

    return current;
  }
}

function buildJobCreatePayload(job: JobRecord) {
  return {
    jobId: job.id,
    quoteId: job.quoteId,
    uploadId: job.uploadId,
    status: job.status,
    workflowRunId: job.workflowRunId,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };
}

function mapInboundPayment(payment: InboundPaymentRecord) {
  return {
    id: payment.id,
    method: payment.paymentMethod,
    amount: payment.amount,
    currency: payment.currency,
    status: payment.status,
    challengeId: payment.challengeId,
    receiptReference: payment.receiptReference,
    receipt: payment.receipt,
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt
  };
}

function readChallengeId(request: Request): string | undefined {
  try {
    return Credential.fromRequest(request).challenge.id;
  } catch {
    return undefined;
  }
}

function parseJsonObject(text: string): Record<string, unknown> {
  if (!text.trim()) {
    throw new HttpError(400, 'invalid_json', 'Request body must be valid JSON.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body must be valid JSON.');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'invalid_json', 'Request body must be a JSON object.');
  }

  return parsed as Record<string, unknown>;
}

async function readBodyText(request: Request): Promise<string> {
  try {
    return await request.clone().text();
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body must be valid JSON.');
  }
}

function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(400, 'invalid_request', `${field} must be a non-empty string.`);
  }

  return value.trim();
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const clean = value.trim();
    if (!clean || seen.has(clean)) {
      continue;
    }

    seen.add(clean);
    result.push(clean);
  }

  return result;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isUniqueConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return /UNIQUE constraint failed/i.test(error.message);
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8'
    }
  });
}

function errorJson(status: number, code: string, message: string): Response {
  return json(
    {
      error: {
        code,
        message
      }
    },
    status
  );
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
