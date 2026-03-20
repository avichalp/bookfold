import assert from 'node:assert/strict';
import test from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { InvalidTempoWalletError } from '@bookfold/sdk';
import { runCli } from '../src/index.js';

class BufferWriter {
  isTTY = false;
  output = '';

  write(chunk: string): void {
    this.output += chunk;
  }
}

class TtyBufferWriter extends BufferWriter {
  override isTTY = true;
  columns = 72;
}

function stripAnsi(value: string): string {
  return stripVTControlCharacters(value);
}

function createSummaryResult() {
  return {
    summary: 'Fixture summary',
    detail: 'medium' as const,
    metadata: {
      fileType: 'pdf' as const
    },
    payment: {
      provider: 'openai-mpp' as const,
      spent: '22000',
      cumulative: '45000',
      channelId: '0x3333333333333333333333333333333333333333333333333333333333333333'
    },
    debug: {
      chunkCount: 7,
      modelCallCount: 5,
      modelNames: ['gpt-4o']
    }
  };
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

test('runCli wallet init recreates invalid Bookfold secure-store entries', async () => {
  const stdout = new BufferWriter();
  const stderr = new BufferWriter();

  const exitCode = await runCli(['wallet', 'init'], {
    stdout,
    stderr,
    resolveWallet: () => {
      throw new InvalidTempoWalletError('app');
    },
    createWallet: () => ({
      address: '0x1111111111111111111111111111111111111111',
      source: 'app',
      accountName: 'default',
      serviceName: 'bookfold'
    })
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.output, /Created wallet/);
  assert.match(stdout.output, /0x1111111111111111111111111111111111111111/);
  assert.equal(stderr.output, '');
});

test('runCli wallet init --force ignores invalid mppx fallback wallets', async () => {
  const stdout = new BufferWriter();
  const stderr = new BufferWriter();
  let receivedOptions: { overwrite?: boolean | undefined } | undefined;

  const exitCode = await runCli(['wallet', 'init', '--force'], {
    stdout,
    stderr,
    resolveWallet: () => {
      throw new InvalidTempoWalletError('mppx');
    },
    createWallet: (options) => {
      receivedOptions = options;
      return {
        address: '0x1111111111111111111111111111111111111111',
        source: 'app',
        accountName: 'default',
        serviceName: 'bookfold'
      };
    }
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(receivedOptions, { overwrite: true });
  assert.match(stdout.output, /Recreated wallet/);
  assert.match(stdout.output, /0x1111111111111111111111111111111111111111/);
  assert.equal(stderr.output, '');
});

test('runCli renders a live summarize progress bar on TTY stderr', async () => {
  const stdout = new BufferWriter();
  const stderr = new TtyBufferWriter();

  const exitCode = await runCli(['./book.pdf'], {
    stdout,
    stderr,
    resolveWallet: () => ({
      address: '0x1111111111111111111111111111111111111111',
      source: 'env',
      accountName: 'TEMPO_PRIVATE_KEY',
      serviceName: 'env'
    }),
    summarize: async (options) => {
      options.onProgress?.({
        step: 'load',
        message: 'Loading local book file.'
      });
      options.onProgress?.({
        step: 'parse',
        message: 'Parsed PDF into 7 chunks.'
      });
      options.onProgress?.({
        step: 'summarize',
        message: 'Running medium map-reduce summary across 4 chunk groups.',
        progress: {
          completed: 0,
          total: 5
        }
      });
      options.onProgress?.({
        step: 'summarize',
        message: 'Synthesizing final book summary.',
        progress: {
          completed: 5,
          total: 5
        }
      });
      options.onProgress?.({
        step: 'close-session',
        message: 'Closing Tempo session.'
      });

      return createSummaryResult();
    }
  });

  assert.equal(exitCode, 0);
  assert.equal(stdout.output, 'Fixture summary\n');
  const plainStderr = stripAnsi(stderr.output);
  assert.match(plainStderr, /\r\[[#-]{14}\]\s+0%\s+0\/5 Running medium map-reduce/);
  assert.match(plainStderr, /\r\[[#-]{14}\]\s+100%\s+5\/5 Synthesizing final/);
  assert.match(plainStderr, /\[Close Session\] Closing Tempo session\./);
});

test('runCli keeps live progress output within the resized TTY width', async () => {
  const stdout = new BufferWriter();
  const stderr = new TtyBufferWriter();
  stderr.columns = 96;

  const exitCode = await runCli(['./book.pdf'], {
    stdout,
    stderr,
    resolveWallet: () => ({
      address: '0x1111111111111111111111111111111111111111',
      source: 'env',
      accountName: 'TEMPO_PRIVATE_KEY',
      serviceName: 'env'
    }),
    summarize: async (options) => {
      options.onProgress?.({
        step: 'summarize',
        message: 'Running medium map-reduce summary across 4 chunk groups.',
        progress: {
          completed: 0,
          total: 5
        }
      });

      stderr.columns = 40;

      options.onProgress?.({
        step: 'summarize',
        message: 'Synthesizing final book summary.',
        progress: {
          completed: 5,
          total: 5
        }
      });

      return createSummaryResult();
    }
  });

  assert.equal(exitCode, 0);

  const plainStderr = stripAnsi(stderr.output);
  const progressLines = Array.from(plainStderr.matchAll(/\r([^\r\n]*)/g), (match) => match[1] ?? '');
  const resizedLine = progressLines.find((line) => line.includes('Synthesizing'));

  assert.ok(resizedLine);
  assert.ok(resizedLine.length <= 40);
  assert.match(resizedLine, /\.\.\.$/);
});
