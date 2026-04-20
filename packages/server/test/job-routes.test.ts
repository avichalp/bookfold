import assert from 'node:assert/strict';
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
  createJobPaymentGateway,
  createJobReader,
  type JobPaymentAuthorizer
} from '../src/index.js';
import { FakeJobPaymentAuthorizer, FakeJobStarter } from './fakes.js';
import { createTestServer } from './helpers.js';

async function createQuoteFixture(server: Awaited<ReturnType<typeof createTestServer>>) {
  const uploadResponse = await server.app.fetch(
    new Request('https://bookfold.test/v1/uploads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        fileName: 'fixture.pdf',
        contentType: 'application/pdf',
        sizeBytes: 4096
      })
    })
  );
  const upload = await uploadResponse.json();

  await server.blobStore.put(upload.blobPath, await createPdfFixture(), {
    contentType: 'application/pdf'
  });

  const quoteResponse = await server.app.fetch(
    new Request('https://bookfold.test/v1/quotes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        uploadId: upload.fileId,
        detail: 'short'
      })
    })
  );

  return {
    quote: await quoteResponse.json(),
    upload
  };
}

async function createStaleQuoteFixture(
  server: Awaited<ReturnType<typeof createTestServer>>,
  options: {
    mutatePlan?: ((plan: SummaryPlan) => SummaryPlan) | undefined;
  } = {}
) {
  const pdf = await createPdfFixture();
  const upload = await server.storage.createUpload({
    blobPath: 'uploads/stale/fixture.pdf',
    fileName: 'fixture.pdf',
    contentType: 'application/pdf',
    sizeBytes: pdf.byteLength,
    status: 'uploaded'
  });

  await server.blobStore.put(upload.blobPath, pdf, {
    contentType: 'application/pdf'
  });

  const book = await parseBookFromBuffer({
    fileBuffer: pdf,
    filePath: upload.fileName,
    fileType: 'pdf'
  });
  const basePlan = buildSummaryPlan(book, 'short');
  const plan =
    options.mutatePlan?.(basePlan) ??
    ({
      ...basePlan,
      promptVersion: 'bookfold-prompt-v0'
    } satisfies SummaryPlan);
  const price = priceSummaryPlan(plan, DEFAULT_PRICE_SHEET);
  const quote = await server.storage.createQuote({
    uploadId: upload.id,
    blobPath: upload.blobPath,
    detail: 'short',
    fileDigestSha256: 'stale-digest',
    planHash: hashSummaryPlan(plan),
    planJson: JSON.stringify(plan),
    priceJson: JSON.stringify(price),
    priceSheetVersion: DEFAULT_PRICE_SHEET.version,
    amount: price.amount,
    currency: server.config.tempoCurrency,
    expiresAt: '2026-05-15T01:00:00.000Z'
  });

  return { quote, upload };
}

test('POST /v1/jobs returns a 402 challenge when unpaid', async () => {
  const authorizer = new FakeJobPaymentAuthorizer();
  const starter = new FakeJobStarter();
  const server = await createTestServer({
    jobReader: createJobReader(),
    jobStarter: starter,
    paymentGateway: createJobPaymentGateway({ authorizer })
  });

  try {
    const { quote } = await createQuoteFixture(server);

    const response = await server.app.fetch(
      new Request('https://bookfold.test/v1/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          quoteId: quote.quoteId
        })
      })
    );
    const payload = await response.json();

    assert.equal(response.status, 402);
    assert.equal(payload.error.code, 'payment_required');
    assert.match(response.headers.get('www-authenticate') ?? '', /^Payment /);
    assert.equal(starter.calls.length, 0);
  } finally {
    await server.close();
  }
});

test('POST /v1/jobs accepts a paid retry, stores inbound payment, and queues one job', async () => {
  const authorizer = new FakeJobPaymentAuthorizer();
  const starter = new FakeJobStarter();
  const server = await createTestServer({
    jobReader: createJobReader(),
    jobStarter: starter,
    paymentGateway: createJobPaymentGateway({ authorizer })
  });

  try {
    const { quote } = await createQuoteFixture(server);

    await server.app.fetch(
      new Request('https://bookfold.test/v1/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          quoteId: quote.quoteId
        })
      })
    );

    const paidResponse = await server.app.fetch(
      new Request('https://bookfold.test/v1/jobs', {
        method: 'POST',
        headers: {
          authorization: 'Payment inbound-receipt-1',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          quoteId: quote.quoteId
        })
      })
    );
    const payload = await paidResponse.json();

    assert.equal(paidResponse.status, 200);
    assert.equal(payload.status, 'queued');
    assert.equal(typeof payload.workflowRunId, 'string');
    assert.equal(starter.calls.length, 1);

    const job = await server.storage.getJobById(payload.jobId);
    assert.equal(job?.status, 'queued');
    assert.equal(job?.quoteId, quote.quoteId);
    assert.equal(job?.workflowRunId, payload.workflowRunId);

    const inboundPayment = job?.inboundPaymentId
      ? await server.storage.getInboundPaymentById(job.inboundPaymentId)
      : undefined;
    assert.equal(inboundPayment?.receiptReference, 'inbound-receipt-1');
    assert.equal(inboundPayment?.amount, quote.amount);
    assert.equal(inboundPayment?.currency, quote.currency);

    const events = await server.storage.listJobEvents(payload.jobId);
    assert.ok(events.some((event) => event.eventType === 'job.paid'));
    assert.ok(events.some((event) => event.eventType === 'job.queued'));
  } finally {
    await server.close();
  }
});

test('POST /v1/jobs rejects an incompatible quote before payment', async () => {
  const authorizer: JobPaymentAuthorizer = {
    async authorize() {
      assert.fail('authorize should not run for an incompatible quote');
    }
  };
  const starter = new FakeJobStarter();
  const server = await createTestServer({
    jobReader: createJobReader(),
    jobStarter: starter,
    paymentGateway: createJobPaymentGateway({ authorizer })
  });

  try {
    const { quote } = await createStaleQuoteFixture(server);

    const response = await server.app.fetch(
      new Request('https://bookfold.test/v1/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          quoteId: quote.id
        })
      })
    );
    const payload = await response.json();

    assert.equal(response.status, 409);
    assert.equal(payload.error.code, 'quote_incompatible');
    assert.equal(starter.calls.length, 0);

    const job = await server.storage.getJobByQuoteId(quote.id);
    assert.equal(job, undefined);
  } finally {
    await server.close();
  }
});

test('POST /v1/jobs rejects a stale plan version before payment', async () => {
  const authorizer: JobPaymentAuthorizer = {
    async authorize() {
      assert.fail('authorize should not run for an incompatible quote');
    }
  };
  const starter = new FakeJobStarter();
  const server = await createTestServer({
    jobReader: createJobReader(),
    jobStarter: starter,
    paymentGateway: createJobPaymentGateway({ authorizer })
  });

  try {
    const { quote } = await createStaleQuoteFixture(server, {
      mutatePlan: (plan) => ({
        ...plan,
        version: 'bookfold-plan-v0'
      })
    });

    const response = await server.app.fetch(
      new Request('https://bookfold.test/v1/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          quoteId: quote.id
        })
      })
    );
    const payload = await response.json();

    assert.equal(response.status, 409);
    assert.equal(payload.error.code, 'quote_incompatible');
    assert.match(payload.error.message, /plan bookfold-plan-v0 != bookfold-plan-v1/);
    assert.equal(starter.calls.length, 0);
  } finally {
    await server.close();
  }
});

test('POST /v1/jobs is idempotent for repeated paid retries', async () => {
  const authorizer = new FakeJobPaymentAuthorizer();
  const starter = new FakeJobStarter();
  const server = await createTestServer({
    jobReader: createJobReader(),
    jobStarter: starter,
    paymentGateway: createJobPaymentGateway({ authorizer })
  });

  try {
    const { quote } = await createQuoteFixture(server);

    const firstResponse = await server.app.fetch(
      new Request('https://bookfold.test/v1/jobs', {
        method: 'POST',
        headers: {
          authorization: 'Payment inbound-receipt-2',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          quoteId: quote.quoteId
        })
      })
    );
    const firstPayload = await firstResponse.json();

    const secondResponse = await server.app.fetch(
      new Request('https://bookfold.test/v1/jobs', {
        method: 'POST',
        headers: {
          authorization: 'Payment inbound-receipt-2',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          quoteId: quote.quoteId
        })
      })
    );
    const secondPayload = await secondResponse.json();

    assert.equal(firstResponse.status, 200);
    assert.equal(secondResponse.status, 200);
    assert.equal(firstPayload.jobId, secondPayload.jobId);
    assert.equal(starter.calls.length, 1);

    const payments = await server.storage.getInboundPaymentByReceiptReference('inbound-receipt-2');
    assert.equal(payments?.receiptReference, 'inbound-receipt-2');
  } finally {
    await server.close();
  }
});

test('POST /v1/jobs requeues a previously failed paid job', async () => {
  const authorizer = new FakeJobPaymentAuthorizer();
  let runCount = 0;
  const starter = {
    calls: [] as string[],
    async start(jobId: string) {
      this.calls.push(jobId);
      runCount += 1;
      return { runId: `run-${runCount}` };
    }
  };
  const server = await createTestServer({
    jobReader: createJobReader(),
    jobStarter: starter,
    paymentGateway: createJobPaymentGateway({ authorizer })
  });

  try {
    const { quote } = await createQuoteFixture(server);

    const firstResponse = await server.app.fetch(
      new Request('https://bookfold.test/v1/jobs', {
        method: 'POST',
        headers: {
          authorization: 'Payment inbound-receipt-3',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          quoteId: quote.quoteId
        })
      })
    );
    const firstPayload = await firstResponse.json();

    await server.storage.updateJob(firstPayload.jobId, {
      status: 'failed',
      workflowRunId: 'run-old',
      errorMessage: 'temporary upstream failure',
      completedAt: '2026-04-15T00:00:00.000Z'
    });

    const retryResponse = await server.app.fetch(
      new Request('https://bookfold.test/v1/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          quoteId: quote.quoteId
        })
      })
    );
    const retryPayload = await retryResponse.json();

    assert.equal(retryResponse.status, 200);
    assert.equal(retryPayload.jobId, firstPayload.jobId);
    assert.equal(retryPayload.status, 'queued');
    assert.equal(retryPayload.workflowRunId, 'run-2');
    assert.equal(starter.calls.length, 2);

    const job = await server.storage.getJobById(firstPayload.jobId);
    assert.equal(job?.status, 'queued');
    assert.equal(job?.workflowRunId, 'run-2');
    assert.equal(job?.errorMessage, undefined);
    assert.equal(job?.completedAt, undefined);

    const events = await server.storage.listJobEvents(firstPayload.jobId);
    assert.ok(events.some((event) => event.eventType === 'job.retry_requested'));
    assert.ok(events.filter((event) => event.eventType === 'job.queued').length >= 2);
  } finally {
    await server.close();
  }
});

test('POST /v1/jobs requeues an existing paid job after the quote expires', async () => {
  const authorizer = new FakeJobPaymentAuthorizer();
  let now = new Date('2026-04-15T00:00:00.000Z');
  let runCount = 0;
  const starter = {
    calls: [] as string[],
    async start(jobId: string) {
      this.calls.push(jobId);
      runCount += 1;
      return { runId: `run-${runCount}` };
    }
  };
  const server = await createTestServer({
    clock: () => now,
    jobReader: createJobReader(),
    jobStarter: starter,
    paymentGateway: createJobPaymentGateway({ authorizer })
  });

  try {
    const { quote } = await createQuoteFixture(server);

    const firstResponse = await server.app.fetch(
      new Request('https://bookfold.test/v1/jobs', {
        method: 'POST',
        headers: {
          authorization: 'Payment inbound-receipt-4',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          quoteId: quote.quoteId
        })
      })
    );
    const firstPayload = await firstResponse.json();

    await server.storage.updateJob(firstPayload.jobId, {
      status: 'failed',
      workflowRunId: 'run-old',
      errorMessage: 'temporary upstream failure',
      completedAt: '2026-04-15T00:00:00.000Z'
    });
    now = new Date('2026-04-16T00:00:00.000Z');

    const retryResponse = await server.app.fetch(
      new Request('https://bookfold.test/v1/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          quoteId: quote.quoteId
        })
      })
    );
    const retryPayload = await retryResponse.json();

    assert.equal(retryResponse.status, 200);
    assert.equal(retryPayload.jobId, firstPayload.jobId);
    assert.equal(retryPayload.status, 'queued');
    assert.equal(retryPayload.workflowRunId, 'run-2');
    assert.equal(starter.calls.length, 2);
  } finally {
    await server.close();
  }
});

test('POST /v1/jobs does not requeue a failed job for an incompatible quote', async () => {
  const authorizer: JobPaymentAuthorizer = {
    async authorize() {
      assert.fail('authorize should not run for an incompatible quote');
    }
  };
  const starter = new FakeJobStarter();
  const server = await createTestServer({
    jobReader: createJobReader(),
    jobStarter: starter,
    paymentGateway: createJobPaymentGateway({ authorizer })
  });

  try {
    const { quote, upload } = await createStaleQuoteFixture(server);
    const job = await server.storage.createJob({
      quoteId: quote.id,
      uploadId: upload.id,
      status: 'failed',
      workflowRunId: 'run-old',
      errorMessage: 'Stored plan versions are incompatible.',
      completedAt: '2026-04-15T00:00:00.000Z'
    });

    const response = await server.app.fetch(
      new Request('https://bookfold.test/v1/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          quoteId: quote.id
        })
      })
    );
    const payload = await response.json();

    assert.equal(response.status, 409);
    assert.equal(payload.error.code, 'quote_incompatible');
    assert.equal(starter.calls.length, 0);

    const storedJob = await server.storage.getJobById(job.id);
    assert.equal(storedJob?.status, 'failed');
    assert.equal(storedJob?.workflowRunId, 'run-old');

    const events = await server.storage.listJobEvents(job.id);
    assert.ok(events.every((event) => event.eventType !== 'job.retry_requested'));
  } finally {
    await server.close();
  }
});
