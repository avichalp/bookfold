import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  DEFAULT_PRICE_SHEET,
  buildSummaryPlan,
  hashSummaryPlan,
  parseBookFromBuffer,
  priceSummaryPlan,
  type SummaryPlan
} from '@bookfold/sdk';
import { createPdfFixture } from '../../sdk/test/helpers.js';
import {
  buildSummaryArtifactPath,
  setBookFoldRuntimeForTests,
  type BookFoldRuntime
} from '../src/index.js';
import { FakeSummarizationProvider } from './fakes.js';
import { createTestServer } from './helpers.js';
import { runBookFoldJobWorkflow } from '../../../workflows/bookfold-job.js';

async function createWorkflowFixture(
  server: Awaited<ReturnType<typeof createTestServer>>,
  options: {
    mutatePlan?: ((plan: SummaryPlan) => SummaryPlan) | undefined;
  } = {}
) {
  const pdf = await createPdfFixture();
  const blobPath = 'uploads/workflow/fixture.pdf';
  await server.blobStore.put(blobPath, pdf, {
    contentType: 'application/pdf'
  });

  const upload = await server.storage.createUpload({
    blobPath,
    fileName: 'fixture.pdf',
    contentType: 'application/pdf',
    sizeBytes: pdf.byteLength,
    status: 'uploaded',
    digestSha256: createHash('sha256').update(pdf).digest('hex')
  });

  const book = await parseBookFromBuffer({
    fileBuffer: pdf,
    filePath: 'fixture.pdf'
  });
  const plan = options.mutatePlan?.(buildSummaryPlan(book, 'short')) ?? buildSummaryPlan(book, 'short');
  const price = priceSummaryPlan(plan, DEFAULT_PRICE_SHEET);

  const quote = await server.storage.createQuote({
    uploadId: upload.id,
    blobPath,
    detail: 'short',
    fileDigestSha256: upload.digestSha256!,
    planHash: hashSummaryPlan(plan),
    planJson: JSON.stringify(plan),
    priceJson: JSON.stringify(price),
    priceSheetVersion: 'bookfold-price-v1',
    amount: price.amount,
    currency: price.currency,
    expiresAt: '2026-04-15T01:00:00.000Z'
  });

  const job = await server.storage.createJob({
    quoteId: quote.id,
    uploadId: upload.id,
    status: 'paid'
  });

  return { job, quote, upload };
}

function buildRuntime(
  server: Awaited<ReturnType<typeof createTestServer>>,
  providerFactory: () => FakeSummarizationProvider
): BookFoldRuntime {
  return {
    config: server.config,
    storage: server.storage,
    blobStore: server.blobStore,
    clock: () => new Date('2026-04-15T00:00:00.000Z'),
    createProvider: providerFactory,
    resolveInboundRecipient: () => '0x1234567890123456789012345678901234567890'
  };
}

test('runBookFoldJobWorkflow stores artifact, outbound payment, and success state', async () => {
  const server = await createTestServer();

  try {
    const { job } = await createWorkflowFixture(server);
    const provider = new FakeSummarizationProvider({ text: 'Workflow summary' });
    setBookFoldRuntimeForTests(buildRuntime(server, () => provider));

    const result = await runBookFoldJobWorkflow(job.id);

    assert.equal(result.jobId, job.id);
    assert.equal(result.artifactBlobPath, buildSummaryArtifactPath(job.id));

    const storedJob = await server.storage.getJobById(job.id);
    assert.equal(storedJob?.status, 'succeeded');
    assert.equal(storedJob?.resultBlobPath, buildSummaryArtifactPath(job.id));

    const outboundPayments = await server.storage.listOutboundPayments(job.id);
    assert.equal(outboundPayments.length, 1);
    assert.equal(outboundPayments[0]?.status, 'paid');
    assert.equal(outboundPayments[0]?.requestCount, 1);

    const artifact = await server.blobStore.get(buildSummaryArtifactPath(job.id));
    assert.ok(artifact);
    assert.match(artifact.body.toString('utf8'), /Workflow summary/);

    const events = await server.storage.listJobEvents(job.id);
    assert.ok(events.some((event) => event.eventType === 'job.running'));
    assert.ok(events.some((event) => event.eventType === 'job.succeeded'));
  } finally {
    setBookFoldRuntimeForTests(undefined);
    await server.close();
  }
});

test('runBookFoldJobWorkflow rejects quotes from an incompatible frozen plan version', async () => {
  const server = await createTestServer();

  try {
    const { job } = await createWorkflowFixture(server, {
      mutatePlan: (plan) => ({
        ...plan,
        promptVersion: 'bookfold-prompt-v0'
      })
    });
    const provider = new FakeSummarizationProvider({ text: 'should not run' });
    setBookFoldRuntimeForTests(buildRuntime(server, () => provider));

    await assert.rejects(
      () => runBookFoldJobWorkflow(job.id),
      /Create a new quote/
    );

    assert.equal(provider.requests.length, 0);

    const storedJob = await server.storage.getJobById(job.id);
    assert.equal(storedJob?.status, 'failed');
    assert.match(storedJob?.errorMessage ?? '', /Create a new quote/);

    const outboundPayments = await server.storage.listOutboundPayments(job.id);
    assert.equal(outboundPayments.length, 0);
  } finally {
    setBookFoldRuntimeForTests(undefined);
    await server.close();
  }
});

test('runBookFoldJobWorkflow rejects quotes from a stale plan version', async () => {
  const server = await createTestServer();

  try {
    const { job } = await createWorkflowFixture(server, {
      mutatePlan: (plan) => ({
        ...plan,
        version: 'bookfold-plan-v0'
      })
    });
    const provider = new FakeSummarizationProvider({ text: 'should not run' });
    setBookFoldRuntimeForTests(buildRuntime(server, () => provider));

    await assert.rejects(
      () => runBookFoldJobWorkflow(job.id),
      /plan bookfold-plan-v0 != bookfold-plan-v1/
    );

    assert.equal(provider.requests.length, 0);

    const storedJob = await server.storage.getJobById(job.id);
    assert.equal(storedJob?.status, 'failed');
    assert.match(storedJob?.errorMessage ?? '', /Create a new quote/);

    const outboundPayments = await server.storage.listOutboundPayments(job.id);
    assert.equal(outboundPayments.length, 0);
  } finally {
    setBookFoldRuntimeForTests(undefined);
    await server.close();
  }
});

test('runBookFoldJobWorkflow marks the job failed when the provider throws', async () => {
  const server = await createTestServer();

  try {
    const { job } = await createWorkflowFixture(server);
    const provider = new FakeSummarizationProvider({ failMessage: 'provider boom' });
    setBookFoldRuntimeForTests(buildRuntime(server, () => provider));

    await assert.rejects(() => runBookFoldJobWorkflow(job.id), /provider boom/);

    const storedJob = await server.storage.getJobById(job.id);
    assert.equal(storedJob?.status, 'failed');
    assert.equal(storedJob?.errorMessage, 'provider boom');

    const outboundPayments = await server.storage.listOutboundPayments(job.id);
    assert.equal(outboundPayments.length, 1);
    assert.equal(outboundPayments[0]?.status, 'failed');

    const events = await server.storage.listJobEvents(job.id);
    assert.ok(events.some((event) => event.eventType === 'job.failed'));
  } finally {
    setBookFoldRuntimeForTests(undefined);
    await server.close();
  }
});

test('runBookFoldJobWorkflow overwrites stale artifacts and appends retry payment records', async () => {
  const server = await createTestServer();

  try {
    const { job } = await createWorkflowFixture(server);
    const artifactBlobPath = buildSummaryArtifactPath(job.id);

    await server.blobStore.put(
      artifactBlobPath,
      JSON.stringify({
        jobId: job.id,
        quoteId: 'quote-old',
        createdAt: '2026-04-14T00:00:00.000Z',
        result: {
          summary: 'Old summary',
          detail: 'short'
        }
      }),
      {
        contentType: 'application/json'
      }
    );
    const artifact = await server.storage.createArtifact({
      jobId: job.id,
      kind: 'summary',
      blobPath: artifactBlobPath,
      metadata: {
        contentType: 'application/json'
      }
    });
    await server.storage.createOutboundPayment({
      jobId: job.id,
      provider: 'openai-mpp',
      kind: 'session',
      status: 'failed',
      spent: '12',
      cumulative: '12',
      channelId: 'channel-old',
      requestCount: 1,
      receipt: {
        reference: 'outbound-old'
      },
      closeError: 'close failed'
    });
    await server.storage.updateJob(job.id, {
      status: 'failed',
      resultArtifactId: artifact.id,
      resultBlobPath: artifactBlobPath,
      errorMessage: 'temporary upstream failure',
      completedAt: '2026-04-14T00:00:00.000Z'
    });

    const provider = new FakeSummarizationProvider({ text: 'Retry summary' });
    setBookFoldRuntimeForTests(buildRuntime(server, () => provider));

    const result = await runBookFoldJobWorkflow(job.id);

    assert.equal(result.artifactBlobPath, artifactBlobPath);

    const storedJob = await server.storage.getJobById(job.id);
    assert.equal(storedJob?.status, 'succeeded');

    const artifactBody = await server.blobStore.get(artifactBlobPath);
    assert.ok(artifactBody);
    assert.match(artifactBody.body.toString('utf8'), /Retry summary/);
    assert.doesNotMatch(artifactBody.body.toString('utf8'), /Old summary/);

    const outboundPayments = await server.storage.listOutboundPayments(job.id);
    assert.equal(outboundPayments.length, 2);
    assert.equal(outboundPayments[0]?.status, 'failed');
    assert.equal(outboundPayments[1]?.status, 'paid');
    assert.equal(
      (outboundPayments[1]?.receipt as { reference?: string } | undefined)?.reference,
      'outbound-receipt'
    );
  } finally {
    setBookFoldRuntimeForTests(undefined);
    await server.close();
  }
});
