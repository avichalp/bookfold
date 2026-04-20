import assert from 'node:assert/strict';
import test from 'node:test';
import { createPdfFixture } from '../../sdk/test/helpers.js';
import {
  createJobPaymentGateway,
  createJobReader,
  setBookFoldRuntimeForTests,
  type BookFoldRuntime
} from '../src/index.js';
import {
  FakeJobPaymentAuthorizer,
  FakeSummarizationProvider,
  InlineWorkflowJobStarter
} from './fakes.js';
import { createTestServer } from './helpers.js';

function buildRuntime(
  server: Awaited<ReturnType<typeof createTestServer>>,
  provider: FakeSummarizationProvider
): BookFoldRuntime {
  return {
    config: server.config,
    storage: server.storage,
    blobStore: server.blobStore,
    clock: () => new Date('2026-04-15T00:00:00.000Z'),
    createProvider: () => provider,
    resolveInboundRecipient: () => '0x1234567890123456789012345678901234567890'
  };
}

test('full server happy path runs from upload to completed job polling', async () => {
  const authorizer = new FakeJobPaymentAuthorizer();
  const starter = new InlineWorkflowJobStarter();
  const provider = new FakeSummarizationProvider({ text: 'End to end summary' });
  const server = await createTestServer({
    jobReader: createJobReader(),
    jobStarter: starter,
    paymentGateway: createJobPaymentGateway({ authorizer })
  });

  try {
    setBookFoldRuntimeForTests(buildRuntime(server, provider));

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
    const quote = await quoteResponse.json();

    const unpaidResponse = await server.app.fetch(
      new Request('https://bookfold.test/v1/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          quoteId: quote.quoteId
        })
      })
    );

    assert.equal(unpaidResponse.status, 402);

    const paidResponse = await server.app.fetch(
      new Request('https://bookfold.test/v1/jobs', {
        method: 'POST',
        headers: {
          authorization: 'Payment e2e-receipt',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          quoteId: quote.quoteId
        })
      })
    );
    const paidPayload = await paidResponse.json();

    assert.equal(paidResponse.status, 200);
    assert.equal(paidPayload.status, 'queued');

    await starter.waitForAll();

    const jobResponse = await server.app.fetch(
      new Request(`https://bookfold.test/v1/jobs/${paidPayload.jobId}`)
    );
    const jobPayload = await jobResponse.json();

    assert.equal(jobResponse.status, 200);
    assert.equal(jobPayload.status, 'succeeded');
    assert.equal(jobPayload.result.summary, 'End to end summary');
    assert.equal(jobPayload.payment.inbound.receiptReference, 'e2e-receipt');
    assert.equal(jobPayload.payment.outbound.length, 1);
  } finally {
    setBookFoldRuntimeForTests(undefined);
    await server.close();
  }
});
