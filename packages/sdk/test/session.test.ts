import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSessionError } from '../src/session/tempo.js';

test('normalizeSessionError adds wallet funding guidance for insufficient balance errors', () => {
  const message = normalizeSessionError(
    new Error(
      [
        'Execution reverted with reason: TIP20 token error: InsufficientBalance(InsufficientBalance { available: 0, required: 1000000, token: 0x20c000000000000000000000b9537d11c60e8b50 }).',
        '',
        'Estimate Gas Arguments:',
        '  from: 0x7325f54391d00C7B8414C22e3397c77c58C08f59'
      ].join('\n')
    ),
    'Tempo session request failed',
    '0x7325f54391d00C7B8414C22e3397c77c58C08f59'
  );

  assert.match(message, /does not have enough fee-token balance/);
  assert.match(message, /Wallet address: 0x7325f54391d00C7B8414C22e3397c77c58C08f59/);
  assert.match(message, /Fund this address on Tempo Mainnet \(chain id 4217\)/);
  assert.match(message, /Upstream reason: Execution reverted with reason: TIP20 token error: InsufficientBalance/);
  assert.doesNotMatch(message, /Estimate Gas Arguments/);
});

test('normalizeSessionError preserves non-funding errors', () => {
  const message = normalizeSessionError(new Error('request timed out'));
  assert.equal(message, 'Tempo session request failed: request timed out');
});
