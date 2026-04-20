import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryBlobStore } from '../src/blob.js';
import { createServerApp, loadServerConfig } from '../src/index.js';
import { createBookFoldStorage } from '../src/storage/create.js';
import { createClient } from '@libsql/client';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('loadServerConfig applies defaults', () => {
  const config = loadServerConfig({
    env: {
      NODE_ENV: 'test'
    }
  });

  assert.equal(config.environment, 'test');
  assert.equal(config.priceSheetVersion, 'bookfold-price-v1');
  assert.equal(config.openAiMppBaseUrl, 'https://openai.mpp.tempo.xyz');
  assert.equal(config.rateLimits.uploadsPerMinute, 3);
  assert.equal(config.rateLimits.quotesPerDay, 10);
  assert.equal(config.rateLimits.jobReadsPerMinute, 30);
});

test('loadServerConfig strict mode rejects missing deploy env', () => {
  assert.throws(
    () =>
      loadServerConfig({
        env: {
          NODE_ENV: 'production'
        },
        strict: true
      }),
    /Missing required server env vars/
  );
});

test('loadServerConfig strict mode requires BOOKFOLD_BASE_URL', () => {
  assert.throws(
    () =>
      loadServerConfig({
        env: {
          NODE_ENV: 'production',
          BLOB_READ_WRITE_TOKEN: 'blob-token',
          TURSO_DATABASE_URL: 'libsql://bookfold.example',
          TURSO_AUTH_TOKEN: 'turso-token',
          TEMPO_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
          MPP_SECRET_KEY: 'mpp-secret'
        },
        strict: true
      }),
    /BOOKFOLD_BASE_URL/
  );
});

test('loadServerConfig fallback baseUrl uses PORT', () => {
  const config = loadServerConfig({
    env: {
      NODE_ENV: 'test',
      PORT: '9999'
    }
  });

  assert.equal(config.port, 9999);
  assert.equal(config.baseUrl, 'http://localhost:9999');
});

test('health route returns service info', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'bookfold-app-'));
  const client = createClient({ url: `file:${path.join(tempDir, 'bookfold.db')}`, intMode: 'number' });
  const storage = createBookFoldStorage({ client });
  try {
    const app = createServerApp({
      config: loadServerConfig({
        env: {
          NODE_ENV: 'test',
          BOOKFOLD_PRICE_SHEET_VERSION: 'sheet-v1'
        }
      }),
      storage,
      blobStore: new MemoryBlobStore()
    });

    const response = await app.fetch(new Request('http://localhost/healthz'));
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
      ok: true,
      service: 'bookfold-mpp-server',
      environment: 'test',
      priceSheetVersion: 'sheet-v1'
    });
  } finally {
    await storage.close();
  }
});

test('openapi shell lists public discovery metadata', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'bookfold-app-'));
  const client = createClient({ url: `file:${path.join(tempDir, 'bookfold.db')}`, intMode: 'number' });
  const storage = createBookFoldStorage({ client });
  try {
    const app = createServerApp({
      config: loadServerConfig({
        env: {
          NODE_ENV: 'test',
          BOOKFOLD_BASE_URL: 'https://bookfold.test'
        }
      }),
      storage,
      blobStore: new MemoryBlobStore()
    });

    const response = await app.fetch(new Request('https://bookfold.test/openapi.json'));
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.openapi, '3.1.0');
    assert.equal(payload.info['x-guidance'].includes('POST /v1/uploads'), true);
    assert.deepEqual(payload['x-service-info'].docs, {
      homepage: 'https://bookfold.test/',
      apiReference: 'https://bookfold.test/openapi.json',
      llms: 'https://bookfold.test/llms.txt'
    });
    assert.deepEqual(payload['x-discovery'].ownershipProofs, ['mpp-verify=bookfold.test']);
    assert.ok(payload.paths['/v1/uploads']);
    assert.ok(payload.paths['/v1/quotes']);
    assert.ok(payload.paths['/v1/jobs']);
    assert.equal(payload.paths['/v1/jobs'].post['x-payment-info'].protocols[0].mpp.method, 'tempo');
  } finally {
    await storage.close();
  }
});

test('runtime failures return a generic internal error payload', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'bookfold-app-'));
  const client = createClient({ url: `file:${path.join(tempDir, 'bookfold.db')}`, intMode: 'number' });
  const storage = createBookFoldStorage({ client });
  try {
    const app = createServerApp({
      config: loadServerConfig({
        env: {
          NODE_ENV: 'test',
          BOOKFOLD_BASE_URL: 'https://bookfold.test'
        }
      }),
      storage
    });

    const response = await app.fetch(
      new Request('https://bookfold.test/v1/uploads', {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          fileName: 'book.pdf',
          sizeBytes: 123,
          contentType: 'application/pdf'
        })
      })
    );
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(payload, {
      error: {
        code: 'internal_error',
        message: 'Internal server error.'
      }
    });
  } finally {
    await storage.close();
  }
});
