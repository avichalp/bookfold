import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { MemoryBlobStore } from '../src/blob.js';
import { createBookFoldStorage, createServerApp, loadServerConfig } from '../src/index.js';

type TestServerOverrides = Partial<Parameters<typeof createServerApp>[0]>;

export async function createTestServer(overrides: TestServerOverrides = {}) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'bookfold-server-'));
  const dbPath = path.join(tempDir, 'bookfold.db');
  const client = createClient({ url: `file:${dbPath}`, intMode: 'number' });
  const storage = createBookFoldStorage({ client });
  const blobStore = new MemoryBlobStore();
  const config = loadServerConfig({
    env: {
      NODE_ENV: 'test',
      BOOKFOLD_BASE_URL: 'https://bookfold.test',
      BOOKFOLD_PRICE_SHEET_VERSION: 'bookfold-price-v1'
    }
  });
  const app = createServerApp({
    config,
    storage,
    blobStore,
    ...overrides
  });
  await storage.bootstrap();

  return {
    app,
    blobStore,
    config: app.config,
    storage,
    async close() {
      await storage.close();
    }
  };
}
