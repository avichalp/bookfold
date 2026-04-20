import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatPaymentSummary,
  formatUsage,
  formatWalletBalance
} from '../src/output.js';

test('formatUsage documents the wallet balance command', () => {
  const output = formatUsage('bookfold', { color: false });

  assert.match(output, /wallet balance/);
  assert.match(output, /Bookfold CLI/);
});

test('formatWalletBalance renders balances and fee token details', () => {
  const output = formatWalletBalance(
    {
      wallet: {
        address: '0x1111111111111111111111111111111111111111',
        source: 'env',
        accountName: 'TEMPO_PRIVATE_KEY',
        serviceName: 'env'
      },
      chainId: 4217,
      chainName: 'Tempo Mainnet',
      explorerUrl: 'https://explore.tempo.xyz',
      effectiveFeeTokenBalance: {
        amount: '3500000',
        decimals: 6,
        name: 'USD Coin',
        symbol: 'USDC',
        tokenAddress: '0x2222222222222222222222222222222222222222',
        tokenId: '7'
      },
      effectiveFeeTokenSource: 'account-preference',
      pathUsdBalance: {
        amount: '12340000',
        decimals: 6,
        name: 'pathUSD',
        symbol: 'pathUSD',
        tokenAddress: '0x20c0000000000000000000000000000000000000',
        tokenId: '0'
      },
      usdcBalance: {
        amount: '3500000',
        decimals: 6,
        name: 'USD Coin',
        symbol: 'USDC',
        tokenAddress: '0x20C000000000000000000000b9537d11c60E8b50',
        tokenId: '123'
      },
      preferredFeeTokenBalance: {
        amount: '3500000',
        decimals: 6,
        name: 'USD Coin',
        symbol: 'USDC',
        tokenAddress: '0x2222222222222222222222222222222222222222',
        tokenId: '7'
      }
    },
    { color: false }
  );

  assert.match(output, /Wallet\n------/);
  assert.match(output, /Effective fee token\s+3\.5 USDC/);
  assert.match(output, /Fee token source\s+Account preference/);
  assert.match(output, /pathUSD fallback\s+12\.34 pathUSD/);
  assert.match(output, /USDC\s+3\.5 USDC/);
  assert.match(output, /Token ID\s+7/);
});

test('formatPaymentSummary renders human-readable Tempo amounts', () => {
  const output = formatPaymentSummary(
    {
      summary: 'Fixture summary',
      detail: 'medium',
      metadata: {
        fileType: 'pdf'
      },
      payment: {
        kind: 'session',
        provider: 'openai-mpp',
        spent: '22000',
        cumulative: '45000',
        channelId: '0x3333333333333333333333333333333333333333333333333333333333333333',
        finalReceipt: {
          reference: 'receipt-1',
          txHash: '0xabc',
          challengeId: 'challenge-1'
        }
      },
      debug: {
        chunkCount: 2,
        modelCallCount: 1,
        modelNames: ['gpt-4o-2024-11-20']
      }
    },
    { color: false }
  );

  assert.match(output, /Spent\s+0\.022 USD/);
  assert.match(output, /Cumulative\s+0\.045 USD/);
  assert.match(output, /Reference\s+receipt-1/);
  assert.match(output, /Tx hash\s+0xabc/);
});
