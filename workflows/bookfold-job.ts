import {
  executeSummaryPlan,
  hashSummaryPlan,
  parseBookFromBuffer,
  type PaymentSummary,
  type SummaryPlan,
  type SummaryResult
} from '@bookfold/sdk';
import {
  PARSER_VERSION,
  PROMPT_VERSION,
  SUMMARY_PLAN_VERSION,
  TOKENIZER_VERSION
} from '@bookfold/sdk/config';
import { buildSummaryArtifactPath, encodeWarnings } from '../packages/server/src/job-service.js';
import { getBookFoldRuntime } from '../packages/server/src/runtime-context.js';

interface WorkflowContext {
  jobId: string;
  quoteId: string;
  uploadId: string;
  uploadFileName: string;
  blobPath: string;
  detail: SummaryResult['detail'];
  plan: SummaryPlan;
  planHash: string;
}

interface WorkflowResult {
  jobId: string;
  artifactBlobPath: string;
}

function hasPaidPayment(payment: PaymentSummary | undefined): boolean {
  if (!payment) {
    return false;
  }

  if (payment.kind === 'charge') {
    return payment.status === 'paid';
  }

  return payment.spent !== '0' || !!payment.finalReceipt || !!payment.lastReceipt;
}

export async function runBookFoldJobWorkflow(jobId: string): Promise<WorkflowResult> {
  'use workflow';

  const context = await loadWorkflowContext(jobId);

  try {
    await assertFrozenPlanVersionCompatibilityStep(context);
    await markJobRunning(context.jobId);
    const book = await fetchAndParseBook(context.blobPath, context.uploadFileName);
    const result = await executeFrozenPlanStep(context, book);
    return await finalizeSuccessfulJob(context, result);
  } catch (error) {
    await markJobFailed(jobId, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

async function loadWorkflowContext(jobId: string): Promise<WorkflowContext> {
  'use step';

  const runtime = getBookFoldRuntime();
  await runtime.storage.bootstrap();

  const job = await runtime.storage.getJobById(jobId);
  if (!job) {
    throw new Error(`Job ${jobId} was not found.`);
  }

  const quote = await runtime.storage.getQuoteById(job.quoteId);
  if (!quote) {
    throw new Error(`Quote ${job.quoteId} was not found for job ${jobId}.`);
  }

  const upload = await runtime.storage.getUploadById(job.uploadId);
  if (!upload) {
    throw new Error(`Upload ${job.uploadId} was not found for job ${jobId}.`);
  }

  const plan = JSON.parse(quote.planJson) as SummaryPlan;
  const actualHash = hashSummaryPlan(plan);
  if (actualHash !== quote.planHash) {
    throw new Error(`Stored plan hash mismatch for quote ${quote.id}.`);
  }

  await runtime.storage.appendJobEvent({
    jobId,
    eventType: 'job.workflow.loaded',
    payload: {
      quoteId: quote.id,
      blobPath: quote.blobPath,
      planHash: quote.planHash
    }
  });

  return {
    jobId,
    quoteId: quote.id,
    uploadId: upload.id,
    uploadFileName: upload.fileName,
    blobPath: quote.blobPath,
    detail: quote.detail,
    plan,
    planHash: quote.planHash
  };
}

async function assertFrozenPlanVersionCompatibilityStep(
  context: Pick<WorkflowContext, 'plan' | 'quoteId'>
): Promise<void> {
  'use step';

  const mismatches = [
    ['plan', context.plan.version, SUMMARY_PLAN_VERSION],
    ['parser', context.plan.parserVersion, PARSER_VERSION],
    ['tokenizer', context.plan.tokenizerVersion, TOKENIZER_VERSION],
    ['prompt', context.plan.promptVersion, PROMPT_VERSION]
  ].filter(([, stored, current]) => stored !== current);

  if (mismatches.length === 0) {
    return;
  }

  const detail = mismatches
    .map(([label, stored, current]) => `${label} ${stored} != ${current}`)
    .join(', ');

  throw new Error(
    `Stored plan versions are incompatible for quote ${context.quoteId}: ${detail}. Create a new quote.`
  );
}

async function markJobRunning(jobId: string): Promise<void> {
  'use step';

  const runtime = getBookFoldRuntime();
  const now = runtime.clock().toISOString();

  await runtime.storage.updateJob(jobId, {
    status: 'running',
    startedAt: now,
    errorMessage: undefined
  });
  await runtime.storage.appendJobEvent({
    jobId,
    eventType: 'job.running',
    payload: { startedAt: now }
  });
}

async function fetchAndParseBook(blobPath: string, fileName: string) {
  'use step';

  const runtime = getBookFoldRuntime();
  const blob = await runtime.blobStore.get(blobPath);
  if (!blob) {
    throw new Error(`Source blob ${blobPath} was not found.`);
  }

  const book = await parseBookFromBuffer({
    fileBuffer: blob.body,
    filePath: fileName
  });

  return book;
}

async function executeFrozenPlanStep(
  context: WorkflowContext,
  book: Awaited<ReturnType<typeof fetchAndParseBook>>
): Promise<{
  summary: SummaryResult['summary'];
  detail: SummaryResult['detail'];
  metadata: SummaryResult['metadata'];
  debug: SummaryResult['debug'];
  warnings?: SummaryResult['warnings'] | undefined;
  payment: PaymentSummary;
}> {
  'use step';

  const runtime = getBookFoldRuntime();
  const provider = runtime.createProvider();
  let prepared: Omit<SummaryResult, 'payment'> | undefined;
  let failure: unknown;
  let closeError: string | undefined;

  try {
    prepared = await executeSummaryPlan({
      book,
      detail: context.detail,
      plan: context.plan,
      provider
    });
  } catch (error) {
    failure = error;
  } finally {
    try {
      await provider.close();
    } catch (error) {
      closeError = error instanceof Error ? error.message : String(error);
    }
  }

  const payment = provider.getPaymentSummary();
  if (closeError && !payment.closeError) {
    payment.closeError = closeError;
  }

  if (failure) {
    await persistOutboundPayment(context.jobId, payment, 'failed');

    const baseMessage = failure instanceof Error ? failure.message : String(failure);
    throw new Error(closeError ? `${baseMessage} Also failed to close session: ${closeError}` : baseMessage);
  }

  if (!prepared) {
    throw new Error('Workflow did not produce a summary.');
  }

  const warnings = [
    ...(prepared.warnings ?? []),
    ...(payment.closeError ? [payment.closeError] : [])
  ];

  await runtime.storage.appendJobEvent({
    jobId: context.jobId,
    eventType: 'job.summary.completed',
    payload: {
      callCount: prepared.debug.modelCallCount,
      spent: payment.spent
    }
  });

  return {
    summary: prepared.summary,
    detail: prepared.detail,
    metadata: prepared.metadata,
    debug: prepared.debug,
    warnings: warnings.length > 0 ? warnings : undefined,
    payment
  };
}

async function finalizeSuccessfulJob(
  context: WorkflowContext,
  result: Awaited<ReturnType<typeof executeFrozenPlanStep>>
): Promise<WorkflowResult> {
  'use step';

  const runtime = getBookFoldRuntime();
  const artifactBlobPath = buildSummaryArtifactPath(context.jobId);
  const currentJob = await runtime.storage.getJobById(context.jobId);
  if (currentJob?.status === 'succeeded' && currentJob.resultBlobPath) {
    return {
      jobId: context.jobId,
      artifactBlobPath: currentJob.resultBlobPath
    };
  }

  const artifactPayload = {
    jobId: context.jobId,
    quoteId: context.quoteId,
    createdAt: runtime.clock().toISOString(),
    result
  };

  await persistOutboundPayment(
    context.jobId,
    result.payment,
    hasPaidPayment(result.payment) ? 'paid' : 'failed'
  );

  await runtime.blobStore.put(artifactBlobPath, JSON.stringify(artifactPayload, null, 2), {
    contentType: 'application/json'
  });

  const existingArtifact = await runtime.storage.getArtifactByBlobPath(artifactBlobPath);
  const artifact =
    existingArtifact ??
    (await runtime.storage.createArtifact({
      jobId: context.jobId,
      kind: 'summary',
      blobPath: artifactBlobPath,
      metadata: {
        contentType: 'application/json'
      }
    }));

  await runtime.storage.updateJob(context.jobId, {
    status: 'succeeded',
    resultArtifactId: artifact.id,
    resultBlobPath: artifactBlobPath,
    warnings: encodeWarnings(result.warnings),
    completedAt: runtime.clock().toISOString()
  });
  await runtime.storage.appendJobEvent({
    jobId: context.jobId,
    eventType: 'job.succeeded',
    payload: {
      artifactId: artifact.id,
      artifactBlobPath
    }
  });

  return {
    jobId: context.jobId,
    artifactBlobPath
  };
}

async function markJobFailed(jobId: string, message: string): Promise<void> {
  'use step';

  const runtime = getBookFoldRuntime();
  await runtime.storage.updateJob(jobId, {
    status: 'failed',
    errorMessage: message,
    completedAt: runtime.clock().toISOString()
  });
  await runtime.storage.appendJobEvent({
    jobId,
    eventType: 'job.failed',
    payload: { message }
  });
}

async function persistOutboundPayment(
  jobId: string,
  payment: Awaited<ReturnType<typeof executeFrozenPlanStep>>['payment'],
  status: 'paid' | 'failed'
): Promise<void> {
  const runtime = getBookFoldRuntime();

  if (payment.kind !== 'session') {
    return;
  }

  const existing = await runtime.storage.listOutboundPayments(jobId);
  if (
    existing.some((record) =>
      isSameOutboundPaymentRecord(record, payment, status)
    )
  ) {
    return;
  }

  await runtime.storage.createOutboundPayment({
    jobId,
    provider: payment.provider,
    kind: payment.kind,
    status,
    spent: payment.spent,
    cumulative: payment.cumulative,
    channelId: payment.channelId,
    requestCount: payment.requestCount,
    receipt: payment.finalReceipt ?? payment.lastReceipt,
    closeError: payment.closeError
  });
}

function isSameOutboundPaymentRecord(
  record: Awaited<ReturnType<ReturnType<typeof getBookFoldRuntime>['storage']['listOutboundPayments']>>[number],
  payment: Awaited<ReturnType<typeof executeFrozenPlanStep>>['payment'],
  status: 'paid' | 'failed'
): boolean {
  if (payment.kind !== 'session') {
    return false;
  }

  return (
    record.provider === payment.provider &&
    record.kind === payment.kind &&
    record.status === status &&
    record.spent === payment.spent &&
    record.cumulative === payment.cumulative &&
    record.channelId === payment.channelId &&
    record.requestCount === payment.requestCount &&
    record.closeError === payment.closeError &&
    getReceiptReference(record.receipt) ===
      getReceiptReference(payment.finalReceipt ?? payment.lastReceipt)
  );
}

function getReceiptReference(
  receipt: Record<string, unknown> | undefined
): string | undefined {
  const reference = receipt?.reference;
  return typeof reference === 'string' ? reference : undefined;
}
