import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runCli } from '../src/index.js';
import type {
  RecoverTempoSessionsOptions,
  SummarizeBookOptions,
  SummaryResult,
  TempoRecoveryReport,
  TempoWalletInfo
} from '@bookfold/sdk';

class MemoryWriter {
  content = '';

  write(chunk: string): void {
    this.content += chunk;
  }
}

function createWallet(address = '0x1111111111111111111111111111111111111111'): TempoWalletInfo {
  return {
    address,
    source: 'app',
    accountName: 'default',
    serviceName: 'bookfold'
  };
}

function createSummaryResult(): SummaryResult {
  return {
    summary: 'Fixture summary output.',
    detail: 'medium',
    metadata: {
      fileType: 'pdf',
      title: 'Fixture Book',
      author: 'Bookfold',
      pageCount: 2
    },
    payment: {
      provider: 'openai-mpp',
      spent: '0',
      cumulative: '0',
      requestCount: 1
    },
    debug: {
      chunkCount: 2,
      modelCallCount: 1,
      modelNames: ['mock-model']
    }
  };
}

test('CLI defaults to summarize when passed a file path', async () => {
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();
  let received: SummarizeBookOptions | undefined;

  const exitCode = await runCli(['/tmp/book.pdf'], {
    stdout,
    stderr,
    resolveWallet: () => createWallet(),
    summarize: async (options: SummarizeBookOptions) => {
      received = options;
      return createSummaryResult();
    }
  });

  assert.equal(exitCode, 0);
  assert.equal(received?.filePath, '/tmp/book.pdf');
  assert.equal(received?.detail, 'medium');
  assert.equal(stdout.content, 'Fixture summary output.\n');
  assert.match(stderr.content, /\[payment\] spent=0 cumulative=0/);
});

test('CLI supports short flags before the file path', async () => {
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();
  let received: SummarizeBookOptions | undefined;

  const exitCode = await runCli(['-j', '-d', 'long', '/tmp/book.epub'], {
    stdout,
    stderr,
    resolveWallet: () => createWallet(),
    summarize: async (options: SummarizeBookOptions) => {
      received = options;
      return {
        ...createSummaryResult(),
        detail: 'long',
        metadata: {
          fileType: 'epub',
          title: 'Fixture EPUB'
        }
      };
    }
  });

  assert.equal(exitCode, 0);
  assert.equal(received?.filePath, '/tmp/book.epub');
  assert.equal(received?.detail, 'long');
  const parsed = JSON.parse(stdout.content);
  assert.equal(parsed.detail, 'long');
  assert.equal(parsed.metadata.fileType, 'epub');
});

test('CLI writes output to a file when -o is provided', async () => {
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'bookfold-cli-'));
  const outputPath = path.join(tempDir, 'summary.txt');

  const exitCode = await runCli(['sum', '/tmp/book.pdf', '-o', outputPath], {
    stdout,
    stderr,
    resolveWallet: () => createWallet(),
    summarize: async () => createSummaryResult()
  });

  assert.equal(exitCode, 0);
  assert.equal(stdout.content, '');
  assert.match(stderr.content, /\[write\] Wrote output to /);
  assert.equal(await readFile(outputPath, 'utf8'), 'Fixture summary output.\n');
});

test('CLI can initialize a wallet on first summarize run', async () => {
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();

  const exitCode = await runCli(['/tmp/book.pdf'], {
    stdout,
    stderr,
    resolveWallet: () => undefined,
    createWallet: () => createWallet('0x2222222222222222222222222222222222222222'),
    isInteractive: () => true,
    confirm: async () => true,
    summarize: async () => createSummaryResult()
  });

  assert.equal(exitCode, 0);
  assert.match(stderr.content, /No Tempo wallet found/);
  assert.match(stderr.content, /\[wallet\] Created 0x2222/);
});

test('CLI recover prints a recovery report', async () => {
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();
  let optionsSeen: RecoverTempoSessionsOptions | undefined;

  const exitCode = await runCli(['recover'], {
    stdout,
    stderr,
    recover: async (options?: RecoverTempoSessionsOptions): Promise<TempoRecoveryReport> => {
      optionsSeen = options;
      return {
        storePath: '/tmp/recovery.json',
        remainingChannels: 1,
        results: [
          {
            channelId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            cumulative: '22000',
            requestUrl: 'https://openai.mpp.tempo.xyz/v1/chat/completions',
            status: 'close-requested',
            txHash: '0xrequestclose',
            unlockAt: '2026-03-19T12:44:50.000Z'
          }
        ]
      };
    }
  });

  assert.equal(exitCode, 0);
  assert.equal(typeof optionsSeen?.onProgress, 'function');
  assert.match(stdout.content, /Recovery store: \/tmp\/recovery\.json/);
  assert.match(stdout.content, /close-requested 0xaaaaaaaa/);
  assert.equal(stderr.content, '');
});

test('CLI rejects unknown top-level commands before wallet checks', async () => {
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();

  const exitCode = await runCli(['foo'], {
    stdout,
    stderr,
    resolveWallet: () => undefined,
    isInteractive: () => false
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout.content, '');
  assert.match(stderr.content, /Expected <file>, `summarize`, `sum`, `recover`, or `wallet`\./);
  assert.doesNotMatch(stderr.content, /No Tempo wallet found/);
});

test('CLI rejects mistyped summarize commands before parsing file args', async () => {
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();

  const exitCode = await runCli(['summarise', '/tmp/book.pdf'], {
    stdout,
    stderr,
    resolveWallet: () => createWallet()
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout.content, '');
  assert.match(stderr.content, /Expected <file>, `summarize`, `sum`, `recover`, or `wallet`\./);
  assert.doesNotMatch(stderr.content, /Unexpected argument: \/tmp\/book\.pdf/);
});
