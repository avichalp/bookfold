import assert from 'node:assert/strict';
import test from 'node:test';
import { privateKeyToAccount } from 'viem/accounts';
import { TempoSessionClient } from '../src/session/tempo.js';

const PRIVATE_KEY = '0x1111111111111111111111111111111111111111111111111111111111111111';
const PAYER_ADDRESS = privateKeyToAccount(PRIVATE_KEY).address;

function createClient(options: {
  fetchError?: Error | undefined;
  closeError?: Error | undefined;
} = {}): TempoSessionClient {
  return new TempoSessionClient({
    privateKey: PRIVATE_KEY,
    manager: {
      channelId: null,
      async fetch() {
        if (options.fetchError) {
          throw options.fetchError;
        }

        throw new Error('fetch() should not be called without an injected error in this test.');
      },
      async close() {
        if (options.closeError) {
          throw options.closeError;
        }

        return undefined;
      }
    }
  });
}

test('TempoSessionClient adds wallet funding guidance for insufficient balance errors', async () => {
  const client = createClient({
    fetchError: new Error(
      [
        'Execution reverted with reason: TIP20 token error: InsufficientBalance(InsufficientBalance { available: 0, required: 1000000, token: 0x20c000000000000000000000b9537d11c60e8b50 }).',
        '',
        'Estimate Gas Arguments:',
        `  from: ${PAYER_ADDRESS}`
      ].join('\n')
    )
  });

  await assert.rejects(
    () => client.fetchJson('https://example.com/v1/chat/completions', { method: 'POST' }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /does not have enough fee-token balance/);
      assert.match(message, new RegExp(`Wallet address: ${PAYER_ADDRESS}`));
      assert.match(message, /Fund this address on Tempo Mainnet \(chain id 4217\)/);
      assert.match(message, /Upstream reason: Execution reverted with reason: TIP20 token error: InsufficientBalance/);
      assert.doesNotMatch(message, /Estimate Gas Arguments/);
      return true;
    }
  );
});

test('TempoSessionClient preserves non-funding close errors', async () => {
  const client = createClient({
    closeError: new Error('request timed out')
  });

  await assert.rejects(
    () => client.close(),
    /Failed to close Tempo session: request timed out/
  );
});
