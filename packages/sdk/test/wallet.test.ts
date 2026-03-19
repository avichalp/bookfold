import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import test from 'node:test';
import {
  createTempoWallet,
  createSystemSecretStore,
  formatWalletFundingMessage,
  normalizePrivateKey,
  resolveTempoPrivateKey,
  resolveTempoWallet,
  type SecretStore
} from '../src/wallet.js';

function createMemoryStore(): SecretStore & { values: Map<string, string> } {
  const values = new Map<string, string>();

  return {
    values,
    get(serviceName, accountName) {
      return values.get(`${serviceName}:${accountName}`);
    },
    set(serviceName, accountName, secret) {
      values.set(`${serviceName}:${accountName}`, secret);
    },
    delete(serviceName, accountName) {
      values.delete(`${serviceName}:${accountName}`);
    }
  };
}

test('createTempoWallet stores a reusable wallet in the app keychain namespace', () => {
  const store = createMemoryStore();
  const created = createTempoWallet({ store });
  const resolved = resolveTempoWallet({ store });

  assert.equal(created.source, 'app');
  assert.equal(resolved?.source, 'app');
  assert.equal(resolved?.address, created.address);
  assert.equal(created.serviceName, 'bookfold');
});

test('resolveTempoPrivateKey prefers env over stored keys', () => {
  const store = createMemoryStore();
  store.set('bookfold', 'default', '0x1111111111111111111111111111111111111111111111111111111111111111');

  const resolved = resolveTempoPrivateKey({
    envPrivateKey: '0x2222222222222222222222222222222222222222222222222222222222222222',
    store
  });

  assert.equal(
    resolved,
    '0x2222222222222222222222222222222222222222222222222222222222222222'
  );
});

test('resolveTempoWallet can reuse an existing mppx account entry', () => {
  const store = createMemoryStore();
  store.set('mppx', 'main', '0x3333333333333333333333333333333333333333333333333333333333333333');

  const resolved = resolveTempoWallet({ store });

  assert.equal(resolved?.source, 'mppx');
});

test('normalizePrivateKey accepts bare hex and rejects malformed values', () => {
  assert.equal(
    normalizePrivateKey('4444444444444444444444444444444444444444444444444444444444444444'),
    '0x4444444444444444444444444444444444444444444444444444444444444444'
  );
  assert.throws(() => normalizePrivateKey('bad-key'), /32-byte hex/);
});

test('formatWalletFundingMessage includes the wallet address', () => {
  assert.match(
    formatWalletFundingMessage('0x5555555555555555555555555555555555555555'),
    /0x5555555555555555555555555555555555555555/
  );
});

test('createSystemSecretStore uses prompt mode on macOS so the secret is not passed via argv', () => {
  const calls: Array<{
    file: string;
    args?: readonly string[] | undefined;
    options?: unknown;
  }> = [];
  const store = createSystemSecretStore({
    platform: () => 'darwin',
    execFileSync: ((file, args, options) => {
      calls.push({ file, args, options });
      return Buffer.alloc(0);
    }) as typeof childProcess.execFileSync
  });

  store.set('bookfold', 'default', 'super-secret');

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.file, 'security');
  assert.deepEqual(
    calls[0]?.args,
    ['add-generic-password', '-s', 'bookfold', '-a', 'default', '-U', '-w']
  );
  assert.equal(
    (calls[0]?.options as { input?: string } | undefined)?.input,
    'super-secret\nsuper-secret\n'
  );
  assert.equal(calls[0]?.args?.includes('super-secret'), false);
});
