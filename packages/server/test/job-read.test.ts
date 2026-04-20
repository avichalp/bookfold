import assert from 'node:assert/strict';
import test from 'node:test';
import { createJobReader, encodeWarnings } from '../src/index.js';
import type { SummaryArtifactPayload } from '../src/index.js';
import { createTestServer } from './helpers.js';

test('GET /v1/jobs/:id returns a pending payload', async () => {
  const server = await createTestServer({
    jobReader: createJobReader()
  });

  try {
    const upload = await server.storage.createUpload({
      blobPath: 'uploads/pending/fixture.pdf',
      fileName: 'fixture.pdf',
      contentType: 'application/pdf',
      sizeBytes: 100,
      status: 'uploaded'
    });
    const quote = await server.storage.createQuote({
      uploadId: upload.id,
      blobPath: upload.blobPath,
      detail: 'short',
      fileDigestSha256: 'digest',
      planHash: 'plan-hash',
      planJson: '{}',
      priceJson: '{}',
      priceSheetVersion: 'bookfold-price-v1',
      amount: '1000',
      currency: '0x20C000000000000000000000b9537d11c60E8b50',
      expiresAt: '2026-04-15T01:00:00.000Z'
    });
    const job = await server.storage.createJob({
      quoteId: quote.id,
      uploadId: upload.id,
      status: 'queued'
    });

    const response = await server.app.fetch(
      new Request(`https://bookfold.test/v1/jobs/${job.id}`)
    );
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.jobId, job.id);
    assert.equal(payload.status, 'queued');
    assert.equal(payload.result, undefined);
    assert.deepEqual(payload.payment.outbound, []);
  } finally {
    await server.close();
  }
});

test('GET /v1/jobs/:id returns result, warnings, and payment fields for a finished job', async () => {
  const server = await createTestServer({
    jobReader: createJobReader()
  });

  try {
    const upload = await server.storage.createUpload({
      blobPath: 'uploads/succeeded/fixture.pdf',
      fileName: 'fixture.pdf',
      contentType: 'application/pdf',
      sizeBytes: 100,
      status: 'uploaded'
    });
    const quote = await server.storage.createQuote({
      uploadId: upload.id,
      blobPath: upload.blobPath,
      detail: 'short',
      fileDigestSha256: 'digest',
      planHash: 'plan-hash',
      planJson: '{}',
      priceJson: '{}',
      priceSheetVersion: 'bookfold-price-v1',
      amount: '1000',
      currency: '0x20C000000000000000000000b9537d11c60E8b50',
      expiresAt: '2026-04-15T01:00:00.000Z'
    });
    const inboundPayment = await server.storage.createInboundPayment({
      receiptReference: 'inbound-1',
      paymentMethod: 'tempo',
      amount: quote.amount,
      currency: quote.currency,
      status: 'paid',
      requestBodyDigest: 'body-digest'
    });
    const job = await server.storage.createJob({
      quoteId: quote.id,
      uploadId: upload.id,
      inboundPaymentId: inboundPayment.id,
      status: 'succeeded',
      resultBlobPath: 'artifacts/job-1/summary.json',
      warnings: encodeWarnings(['stored warning'])
    });
    await server.storage.createOutboundPayment({
      jobId: job.id,
      provider: 'openai-mpp',
      kind: 'session',
      status: 'paid',
      spent: '33',
      cumulative: '33',
      channelId: 'channel-1',
      requestCount: 1,
      closeError: 'close failed'
    });

    const artifact: SummaryArtifactPayload = {
      jobId: job.id,
      quoteId: quote.id,
      createdAt: '2026-04-15T00:00:00.000Z',
      result: {
        summary: 'Short summary',
        detail: 'short',
        metadata: {
          fileType: 'pdf',
          title: 'Fixture'
        },
        debug: {
          chunkCount: 1,
          modelCallCount: 1,
          modelNames: ['gpt-4o-mini-2024-07-18']
        },
        warnings: ['artifact warning'],
        payment: {
          kind: 'session',
          provider: 'openai-mpp',
          spent: '33',
          cumulative: '33'
        }
      }
    };
    await server.blobStore.put(job.resultBlobPath!, JSON.stringify(artifact), {
      contentType: 'application/json'
    });

    const response = await server.app.fetch(
      new Request(`https://bookfold.test/v1/jobs/${job.id}`)
    );
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.status, 'succeeded');
    assert.equal(payload.result.summary, 'Short summary');
    assert.equal(payload.payment.inbound.receiptReference, 'inbound-1');
    assert.equal(payload.payment.outbound.length, 1);
    assert.deepEqual(payload.warnings, ['stored warning', 'artifact warning', 'close failed']);
  } finally {
    await server.close();
  }
});
