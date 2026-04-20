import assert from 'node:assert/strict';
import test from 'node:test';
import { createPdfFixture } from '../../sdk/test/helpers.js';
import {
  createJobPaymentGateway,
  createJobReader,
  loadServerConfig
} from '../src/index.js';
import { FakeJobPaymentAuthorizer, FakeJobStarter } from './fakes.js';
import { createTestServer } from './helpers.js';

function buildConfig(overrides: Record<string, string>): ReturnType<typeof loadServerConfig> {
  return loadServerConfig({
    env: {
      NODE_ENV: 'test',
      BOOKFOLD_BASE_URL: 'https://bookfold.test',
      ...overrides
    }
  });
}

function buildUploadRequest(ip: string, sizeBytes = 1024): Request {
  return new Request('https://bookfold.test/v1/uploads', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': ip
    },
    body: JSON.stringify({
      fileName: 'fixture.pdf',
      contentType: 'application/pdf',
      sizeBytes
    })
  });
}

async function createUpload(
  server: Awaited<ReturnType<typeof createTestServer>>,
  ip: string,
  fileBuffer?: Buffer
) {
  const response = await server.app.fetch(buildUploadRequest(ip, fileBuffer?.byteLength ?? 4096));
  const payload = await response.json();

  if (response.status === 200 && fileBuffer) {
    await server.blobStore.put(payload.blobPath, fileBuffer, {
      contentType: 'application/pdf'
    });
  }

  return { response, payload };
}

async function createQuote(
  server: Awaited<ReturnType<typeof createTestServer>>,
  ip: string,
  uploadId: string
) {
  const response = await server.app.fetch(
    new Request('https://bookfold.test/v1/quotes', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': ip
      },
      body: JSON.stringify({
        uploadId,
        detail: 'short'
      })
    })
  );

  return {
    response,
    payload: await response.json()
  };
}

test('POST /v1/uploads limits request count per client', async () => {
  let now = new Date('2026-04-15T00:00:00.000Z');
  const server = await createTestServer({
    clock: () => now,
    config: buildConfig({
      BOOKFOLD_RATE_LIMIT_OPEN_UPLOADS_PER_CLIENT: '10',
      BOOKFOLD_RATE_LIMIT_UPLOADS_PER_MINUTE: '2',
      BOOKFOLD_RATE_LIMIT_UPLOADS_PER_HOUR: '10',
      BOOKFOLD_RATE_LIMIT_UPLOAD_BYTES_PER_HOUR: '104857600',
      BOOKFOLD_RATE_LIMIT_UPLOAD_BYTES_PER_DAY: '104857600'
    })
  });

  try {
    const first = await server.app.fetch(buildUploadRequest('203.0.113.10'));
    const second = await server.app.fetch(buildUploadRequest('203.0.113.10'));
    const third = await server.app.fetch(buildUploadRequest('203.0.113.10'));
    const payload = await third.json();

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(third.status, 429);
    assert.equal(payload.error.code, 'upload_rate_limited');
    assert.equal(third.headers.get('ratelimit-limit'), '2');
    assert.equal(third.headers.get('retry-after'), '60');

    now = new Date('2026-04-15T00:01:00.000Z');
    const fourth = await server.app.fetch(buildUploadRequest('203.0.113.10'));
    assert.equal(fourth.status, 200);
  } finally {
    await server.close();
  }
});

test('POST /v1/uploads limits open upload tokens per client', async () => {
  const server = await createTestServer({
    config: buildConfig({
      BOOKFOLD_RATE_LIMIT_OPEN_UPLOADS_PER_CLIENT: '2',
      BOOKFOLD_RATE_LIMIT_UPLOADS_PER_MINUTE: '10',
      BOOKFOLD_RATE_LIMIT_UPLOADS_PER_HOUR: '10',
      BOOKFOLD_RATE_LIMIT_UPLOAD_BYTES_PER_HOUR: '104857600',
      BOOKFOLD_RATE_LIMIT_UPLOAD_BYTES_PER_DAY: '104857600'
    })
  });

  try {
    const first = await server.app.fetch(buildUploadRequest('203.0.113.11'));
    const second = await server.app.fetch(buildUploadRequest('203.0.113.11'));
    const third = await server.app.fetch(buildUploadRequest('203.0.113.11'));
    const payload = await third.json();

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(third.status, 429);
    assert.equal(payload.error.code, 'too_many_open_uploads');
    assert.equal(third.headers.get('ratelimit-limit'), '2');
    assert.match(third.headers.get('retry-after') ?? '', /^\d+$/);
  } finally {
    await server.close();
  }
});

test('POST /v1/uploads limits total upload bytes per client', async () => {
  const server = await createTestServer({
    config: buildConfig({
      BOOKFOLD_RATE_LIMIT_OPEN_UPLOADS_PER_CLIENT: '10',
      BOOKFOLD_RATE_LIMIT_UPLOADS_PER_MINUTE: '10',
      BOOKFOLD_RATE_LIMIT_UPLOADS_PER_HOUR: '10',
      BOOKFOLD_RATE_LIMIT_UPLOAD_BYTES_PER_HOUR: '3000',
      BOOKFOLD_RATE_LIMIT_UPLOAD_BYTES_PER_DAY: '10000'
    })
  });

  try {
    const first = await server.app.fetch(buildUploadRequest('203.0.113.12', 2000));
    const second = await server.app.fetch(buildUploadRequest('203.0.113.12', 1500));
    const payload = await second.json();

    assert.equal(first.status, 200);
    assert.equal(second.status, 429);
    assert.equal(payload.error.code, 'upload_rate_limited');
    assert.equal(second.headers.get('ratelimit-limit'), '3000');
  } finally {
    await server.close();
  }
});

test('POST /v1/quotes limits request count per client', async () => {
  const pdf = await createPdfFixture();
  const server = await createTestServer({
    config: buildConfig({
      BOOKFOLD_RATE_LIMIT_QUOTES_PER_MINUTE: '1',
      BOOKFOLD_RATE_LIMIT_QUOTES_PER_HOUR: '10',
      BOOKFOLD_RATE_LIMIT_QUOTES_PER_DAY: '10'
    })
  });

  try {
    const upload = await createUpload(server, '203.0.113.13', pdf);
    assert.equal(upload.response.status, 200);

    const first = await createQuote(server, '203.0.113.13', upload.payload.fileId);
    const second = await createQuote(server, '203.0.113.13', upload.payload.fileId);

    assert.equal(first.response.status, 200);
    assert.equal(second.response.status, 429);
    assert.equal(second.payload.error.code, 'quote_rate_limited');
    assert.equal(second.response.headers.get('ratelimit-limit'), '1');
  } finally {
    await server.close();
  }
});

test('POST /v1/quotes reuses a cached quote plan for the same file digest', async () => {
  const pdf = await createPdfFixture();
  const sdk = await import('@bookfold/sdk/server');
  let parseCalls = 0;
  const server = await createTestServer({
    sdkServer: {
      ...sdk,
      async parseBookFromBuffer(input) {
        parseCalls += 1;
        return sdk.parseBookFromBuffer(input);
      }
    },
    config: buildConfig({
      BOOKFOLD_RATE_LIMIT_QUOTES_PER_MINUTE: '10',
      BOOKFOLD_RATE_LIMIT_QUOTES_PER_HOUR: '10',
      BOOKFOLD_RATE_LIMIT_QUOTES_PER_DAY: '10'
    })
  });

  try {
    const firstUpload = await createUpload(server, '203.0.113.14', pdf);
    const firstQuote = await createQuote(server, '203.0.113.14', firstUpload.payload.fileId);
    const secondUpload = await createUpload(server, '203.0.113.14', pdf);
    const secondQuote = await createQuote(server, '203.0.113.14', secondUpload.payload.fileId);

    assert.equal(firstQuote.response.status, 200);
    assert.equal(secondQuote.response.status, 200);
    assert.equal(parseCalls, 1);
    assert.notEqual(firstQuote.payload.quoteId, secondQuote.payload.quoteId);
    assert.equal(firstQuote.payload.plan.hash, secondQuote.payload.plan.hash);
  } finally {
    await server.close();
  }
});

test('POST /v1/jobs limits create attempts per client', async () => {
  const pdf = await createPdfFixture();
  const server = await createTestServer({
    config: buildConfig({
      BOOKFOLD_RATE_LIMIT_JOB_CREATES_PER_MINUTE: '1'
    }),
    jobReader: createJobReader(),
    jobStarter: new FakeJobStarter(),
    paymentGateway: createJobPaymentGateway({
      authorizer: new FakeJobPaymentAuthorizer()
    })
  });

  try {
    const upload = await createUpload(server, '203.0.113.15', pdf);
    const quote = await createQuote(server, '203.0.113.15', upload.payload.fileId);

    const first = await server.app.fetch(
      new Request('https://bookfold.test/v1/jobs', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': '203.0.113.15'
        },
        body: JSON.stringify({
          quoteId: quote.payload.quoteId
        })
      })
    );
    const second = await server.app.fetch(
      new Request('https://bookfold.test/v1/jobs', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': '203.0.113.15'
        },
        body: JSON.stringify({
          quoteId: quote.payload.quoteId
        })
      })
    );
    const payload = await second.json();

    assert.equal(first.status, 402);
    assert.equal(second.status, 429);
    assert.equal(payload.error.code, 'job_create_rate_limited');
  } finally {
    await server.close();
  }
});

test('GET /v1/jobs/:id limits poll attempts per client', async () => {
  const server = await createTestServer({
    config: buildConfig({
      BOOKFOLD_RATE_LIMIT_JOB_READS_PER_MINUTE: '1'
    }),
    jobReader: createJobReader()
  });

  try {
    const upload = await server.storage.createUpload({
      id: 'upl_1',
      blobPath: 'uploads/upl_1/book.pdf',
      fileName: 'book.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1024,
      status: 'uploaded'
    });
    const quote = await server.storage.createQuote({
      id: 'quo_1',
      uploadId: upload.id,
      blobPath: upload.blobPath,
      detail: 'short',
      fileDigestSha256: 'digest-1',
      planHash: 'plan-hash-1',
      planJson: '{"version":"bookfold-plan-v1","parserVersion":"bookfold-parser-v1","tokenizerVersion":"bookfold-tokenizer-v1","promptVersion":"bookfold-prompt-v1"}',
      priceJson: '{"currencyDecimals":6,"priceSheetVersion":"bookfold-price-v1"}',
      priceSheetVersion: 'bookfold-price-v1',
      amount: '1000',
      currency: server.config.tempoCurrency,
      expiresAt: '2026-04-15T00:15:00.000Z'
    });
    const job = await server.storage.createJob({
      id: 'job_1',
      quoteId: quote.id,
      uploadId: upload.id,
      status: 'queued'
    });

    const first = await server.app.fetch(
      new Request(`https://bookfold.test/v1/jobs/${job.id}`, {
        headers: {
          'x-forwarded-for': '203.0.113.16'
        }
      })
    );
    const second = await server.app.fetch(
      new Request(`https://bookfold.test/v1/jobs/${job.id}`, {
        headers: {
          'x-forwarded-for': '203.0.113.16'
        }
      })
    );
    const payload = await second.json();

    assert.equal(first.status, 200);
    assert.equal(second.status, 429);
    assert.equal(payload.error.code, 'job_read_rate_limited');
  } finally {
    await server.close();
  }
});
