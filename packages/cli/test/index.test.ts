import assert from 'node:assert/strict';
import test from 'node:test';
import { runCli } from '../src/index.js';

class BufferWriter {
  isTTY = false;
  output = '';

  write(chunk: string): void {
    this.output += chunk;
  }
}

test('runCli renders wallet balance output', async () => {
  const stdout = new BufferWriter();
  const stderr = new BufferWriter();

  const exitCode = await runCli(['wallet', 'balance'], {
    stdout,
    stderr,
    walletBalance: async () => ({
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
        amount: '2750000',
        decimals: 6,
        name: 'USD Coin',
        symbol: 'USDC',
        tokenAddress: '0x2222222222222222222222222222222222222222',
        tokenId: '7'
      },
      effectiveFeeTokenSource: 'account-preference',
      pathUsdBalance: {
        amount: '1500000',
        decimals: 6,
        name: 'pathUSD',
        symbol: 'pathUSD',
        tokenAddress: '0x20c0000000000000000000000000000000000000',
        tokenId: '0'
      },
      usdcBalance: {
        amount: '2750000',
        decimals: 6,
        name: 'USD Coin',
        symbol: 'USDC',
        tokenAddress: '0x20C000000000000000000000b9537d11c60E8b50',
        tokenId: '123'
      },
      preferredFeeTokenBalance: {
        amount: '2750000',
        decimals: 6,
        name: 'USD Coin',
        symbol: 'USDC',
        tokenAddress: '0x2222222222222222222222222222222222222222',
        tokenId: '7'
      }
    })
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.output, /Balance/);
  assert.match(stdout.output, /2\.75 USDC/);
  assert.match(stdout.output, /1\.5 pathUSD/);
  assert.equal(stderr.output, '');
});
