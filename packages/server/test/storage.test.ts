import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { createBookFoldStorage } from '../src/index.js';

test('BookFoldStorage bootstraps schema and reads all MVP tables', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'bookfold-storage-'));
  const dbPath = path.join(tempDir, 'bookfold.db');
  const client = createClient({ url: `file:${dbPath}`, intMode: 'number' });
  const storage = createBookFoldStorage({ client });

  try {
    await storage.bootstrap();

    const upload = await storage.createUpload({
      id: 'upl_1',
      blobPath: 'uploads/upl_1/book.pdf',
      fileName: 'book.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1024,
      status: 'uploaded',
      digestSha256: 'digest-1',
      requestKey: 'client-1',
      uploadTokenExpiresAt: '2026-04-15T00:15:00.000Z',
      metadata: { fileType: 'pdf' }
    });

    assert.equal((await storage.getUploadById(upload.id))?.blobPath, upload.blobPath);
    assert.equal((await storage.getUploadByBlobPath(upload.blobPath))?.id, upload.id);

    const quote = await storage.createQuote({
      id: 'quo_1',
      uploadId: upload.id,
      blobPath: upload.blobPath,
      detail: 'medium',
      fileDigestSha256: 'digest-1',
      planHash: 'plan-hash-1',
      planJson: '{"plan":1}',
      priceJson: '{"amount":"1000"}',
      priceSheetVersion: 'bookfold-price-v1',
      amount: '1000',
      currency: 'USD',
      expiresAt: '2026-04-15T00:15:00.000Z'
    });

    assert.equal((await storage.getQuoteById(quote.id))?.planHash, 'plan-hash-1');
    assert.equal(
      (
        await storage.listRecentQuotesByDigest({
          fileDigestSha256: 'digest-1',
          detail: 'medium',
          priceSheetVersion: 'bookfold-price-v1',
          currency: 'USD'
        })
      )[0]?.id,
      quote.id
    );

    const pendingUpload = await storage.createUpload({
      id: 'upl_2',
      blobPath: 'uploads/upl_2/book.pdf',
      fileName: 'book.pdf',
      contentType: 'application/pdf',
      sizeBytes: 512,
      status: 'pending',
      requestKey: 'client-1',
      uploadTokenExpiresAt: '2026-04-15T00:30:00.000Z'
    });

    assert.equal(pendingUpload.requestKey, 'client-1');
    assert.deepEqual(await storage.getPendingUploadSummary('client-1', '2026-04-15T00:00:00.000Z'), {
      count: 1,
      earliestExpiresAt: '2026-04-15T00:30:00.000Z'
    });

    const inboundPayment = await storage.createInboundPayment({
      id: 'pay_in_1',
      receiptReference: 'receipt-1',
      paymentMethod: 'tempo',
      amount: '1000',
      currency: 'USD',
      status: 'paid',
      challengeId: 'challenge-1',
      requestBodyDigest: 'body-digest-1',
      receipt: { reference: 'receipt-1' }
    });

    assert.equal(
      (await storage.getInboundPaymentByReceiptReference('receipt-1'))?.id,
      inboundPayment.id
    );

    const job = await storage.createJob({
      id: 'job_1',
      quoteId: quote.id,
      uploadId: upload.id,
      inboundPaymentId: inboundPayment.id,
      status: 'queued',
      workflowRunId: 'run_1'
    });

    assert.equal((await storage.getJobById(job.id))?.status, 'queued');

    const updatedJob = await storage.updateJob(job.id, {
      status: 'running',
      startedAt: '2026-04-15T00:01:00.000Z'
    });

    assert.equal(updatedJob.status, 'running');
    assert.equal((await storage.listJobsByStatus('running')).length, 1);

    const event = await storage.appendJobEvent({
      id: 'evt_1',
      jobId: job.id,
      eventType: 'job.started',
      payload: { status: 'running' }
    });

    assert.equal((await storage.listJobEvents(job.id))[0]?.id, event.id);

    const outbound = await storage.createOutboundPayment({
      id: 'pay_out_1',
      jobId: job.id,
      provider: 'openai-mpp',
      kind: 'session',
      status: 'paid',
      spent: '421',
      cumulative: '421',
      channelId: 'channel-1',
      requestCount: 1,
      receipt: { reference: 'outbound-1' }
    });

    assert.equal((await storage.listOutboundPayments(job.id))[0]?.id, outbound.id);

    const artifact = await storage.createArtifact({
      id: 'art_1',
      jobId: job.id,
      kind: 'summary',
      blobPath: 'artifacts/job_1/summary.txt',
      metadata: { format: 'text/plain' }
    });

    assert.equal((await storage.getArtifactById(artifact.id))?.blobPath, artifact.blobPath);

    const priceSheet = await storage.upsertPriceSheet({
      version: 'bookfold-price-v1',
      payloadJson: '{"version":"bookfold-price-v1"}',
      createdAt: '2026-04-15T00:00:00.000Z'
    });

    assert.equal((await storage.getPriceSheet(priceSheet.version))?.version, priceSheet.version);

    assert.deepEqual(
      await storage.incrementRateLimitBucket({
        scope: 'quotes',
        subjectKey: 'client-1',
        windowMs: 60_000,
        windowStartMs: Date.parse('2026-04-15T00:00:00.000Z'),
        requestCount: 1,
        byteCount: 0
      }),
      {
        requestCount: 1,
        byteCount: 0
      }
    );
  } finally {
    await storage.close();
  }
});
