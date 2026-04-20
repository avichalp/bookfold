import assert from 'node:assert/strict';
import type { execFileSync } from 'node:child_process';
import type { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { createBookFoldRuntime, loadServerConfig } from '../src/index.js';
import { fileURLToPath } from 'node:url';
import { BOOKFOLD_JOB_WORKFLOW_ID } from '../src/job-service.js';
import { createMppJobPaymentAuthorizer, formatChargeAmount } from '../src/runtime.js';
import type { homedir, platform } from 'node:os';

const manifestPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../.well-known/workflow/v1/manifest.json'
);

function setWalletRuntimeForTests(runtime: {
  execFileSync?: typeof execFileSync;
  homedir?: typeof homedir;
  platform?: typeof platform;
  readFileSync?: typeof readFileSync;
}): void {
  globalThis.__BOOKFOLD_WALLET_RUNTIME_FOR_TESTS__ = runtime;
}

function resetWalletRuntimeForTests(): void {
  globalThis.__BOOKFOLD_WALLET_RUNTIME_FOR_TESTS__ = undefined;
}

async function withTempoPrivateKeyEnv<T>(
  value: string | undefined,
  callback: () => Promise<T> | T
): Promise<T> {
  const previous = process.env.TEMPO_PRIVATE_KEY;
  if (value === undefined) {
    delete process.env.TEMPO_PRIVATE_KEY;
  } else {
    process.env.TEMPO_PRIVATE_KEY = value;
  }

  try {
    return await callback();
  } finally {
    if (previous === undefined) {
      delete process.env.TEMPO_PRIVATE_KEY;
    } else {
      process.env.TEMPO_PRIVATE_KEY = previous;
    }
  }
}

test('formatChargeAmount converts minor units to a decimal amount string', () => {
  assert.equal(formatChargeAmount('56403', 6), '0.056403');
  assert.equal(formatChargeAmount('1000000', 6), '1');
  assert.equal(formatChargeAmount('0', 6), '0');
  assert.equal(formatChargeAmount('123', 0), '123');
});

test('BOOKFOLD_JOB_WORKFLOW_ID matches the generated workflow manifest', async () => {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    workflows?: Record<string, Record<string, { workflowId?: string | undefined }>>;
  };
  const workflowIds = Object.values(manifest.workflows ?? {}).flatMap((fileEntry) =>
    Object.values(fileEntry).flatMap((workflowEntry) =>
      typeof workflowEntry.workflowId === 'string' ? [workflowEntry.workflowId] : []
    )
  );

  assert.ok(workflowIds.includes(BOOKFOLD_JOB_WORKFLOW_ID));
});

test('createBookFoldRuntime wires OPENAI_MPP_BASE_URL into the provider', () => {
  const runtime = createBookFoldRuntime(
    loadServerConfig({
      env: {
        NODE_ENV: 'test',
        BOOKFOLD_BASE_URL: 'https://bookfold.test',
        BLOB_READ_WRITE_TOKEN: 'blob-token',
        TURSO_DATABASE_URL: 'libsql://bookfold.test',
        TEMPO_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
        OPENAI_MPP_BASE_URL: 'https://mpp-alt.example'
      }
    })
  );

  const provider = runtime.createProvider();
  assert.equal(provider.getPaymentSummary().baseUrl, 'https://mpp-alt.example');
});

test('createMppJobPaymentAuthorizer uses config.tempoPrivateKey for inbound recipient', async (t) => {
  await withTempoPrivateKeyEnv(undefined, () => {
    t.after(() => resetWalletRuntimeForTests());
    setWalletRuntimeForTests({
      platform: () => 'darwin',
      execFileSync: () => {
        throw new Error('secure store should not be read');
      },
      readFileSync: () => {
        throw new Error('mppx config should not be read');
      }
    });

    assert.doesNotThrow(() =>
      createMppJobPaymentAuthorizer(
        loadServerConfig({
          env: {
            NODE_ENV: 'test',
            BOOKFOLD_BASE_URL: 'https://bookfold.test',
            MPP_SECRET_KEY: 'mpp-secret',
            TEMPO_PRIVATE_KEY: `0x${'22'.repeat(32)}`
          }
        })
      )
    );
  });
});
