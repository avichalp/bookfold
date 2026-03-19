import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatWalletFundingMessage,
  resolveTempoPrivateKey,
  resolveTempoWallet
} from '../src/wallet.js';

async function withTempoPrivateKey<T>(
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

test('resolveTempoWallet uses TEMPO_PRIVATE_KEY when set', async () => {
  await withTempoPrivateKey(
    '0x1111111111111111111111111111111111111111111111111111111111111111',
    () => {
      const resolved = resolveTempoWallet();

      assert.equal(resolved?.source, 'env');
      assert.equal(resolved?.accountName, 'TEMPO_PRIVATE_KEY');
      assert.equal(resolved?.serviceName, 'env');
    }
  );
});

test('resolveTempoPrivateKey rejects malformed values', async () => {
  await withTempoPrivateKey('bad-key', () => {
    assert.throws(
      () => resolveTempoPrivateKey(),
      /32-byte hex/
    );
  });
});

test('formatWalletFundingMessage includes the wallet address', () => {
  assert.match(
    formatWalletFundingMessage('0x5555555555555555555555555555555555555555'),
    /0x5555555555555555555555555555555555555555/
  );
});
