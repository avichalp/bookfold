import assert from 'node:assert/strict';
import test from 'node:test';
import { recoverJobs } from '../src/index.js';
import { FakeJobStarter } from './fakes.js';
import { createTestServer } from './helpers.js';

test('recoverJobs restarts paid jobs that never reached the workflow queue', async () => {
  const server = await createTestServer();
  const starter = new FakeJobStarter();

  try {
    const upload = await server.storage.createUpload({
      blobPath: 'uploads/recovery/paid.pdf',
      fileName: 'paid.pdf',
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
      status: 'paid'
    });

    const report = await recoverJobs({
      clock: () => new Date('2026-04-15T00:00:00.000Z'),
      jobStarter: starter,
      storage: server.storage
    });

    const storedJob = await server.storage.getJobById(job.id);
    assert.equal(storedJob?.status, 'queued');
    assert.equal(storedJob?.workflowRunId, `run-${job.id}`);
    assert.deepEqual(report.restartedJobIds, [job.id]);
    assert.equal(starter.calls.length, 1);

    const events = await server.storage.listJobEvents(job.id);
    assert.ok(events.some((event) => event.eventType === 'job.recovered'));
  } finally {
    await server.close();
  }
});

test('recoverJobs checks running jobs with workflow ids and flags payment issues', async () => {
  const server = await createTestServer();
  const starter = new FakeJobStarter();

  try {
    const upload = await server.storage.createUpload({
      blobPath: 'uploads/recovery/running.pdf',
      fileName: 'running.pdf',
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
      status: 'running',
      workflowRunId: 'run-existing'
    });
    await server.storage.createOutboundPayment({
      jobId: job.id,
      provider: 'openai-mpp',
      kind: 'session',
      status: 'paid',
      spent: '10',
      cumulative: '10',
      closeError: 'close failed'
    });

    const report = await recoverJobs({
      clock: () => new Date('2026-04-15T00:00:00.000Z'),
      jobStarter: starter,
      storage: server.storage
    });

    assert.deepEqual(report.restartedJobIds, []);
    assert.deepEqual(report.checkedJobIds, [job.id]);
    assert.deepEqual(report.flaggedJobIds, [job.id]);
    assert.equal(starter.calls.length, 0);

    const events = await server.storage.listJobEvents(job.id);
    assert.ok(events.some((event) => event.eventType === 'job.recovery.checked'));
    assert.ok(events.some((event) => event.eventType === 'payment.outbound_close_error'));
  } finally {
    await server.close();
  }
});
