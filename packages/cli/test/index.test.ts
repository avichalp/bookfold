import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runCli } from '../src/index.js';
import type { SummarizeBookOptions, SummaryResult } from '../../sdk/src/types.js';

class MemoryWriter {
  content = '';

  write(chunk: string): void {
    this.content += chunk;
  }
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
      provider: 'mock',
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

test('CLI writes summary to stdout and progress to stderr', async () => {
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();

  const exitCode = await runCli(['summarize', '/tmp/book.pdf'], {
    stdout,
    stderr,
    resolveWallet: () => ({
      address: '0x1111111111111111111111111111111111111111',
      source: 'app',
      accountName: 'default',
      serviceName: 'bookfold'
    }),
    summarize: async (options: SummarizeBookOptions) => {
      options.onProgress?.({ step: 'parse', message: 'parsed fixture', detail: { chunkCount: 2 } });
      return createSummaryResult();
    }
  });

  assert.equal(exitCode, 0);
  assert.equal(stdout.content, 'Fixture summary output.\n');
  assert.match(stderr.content, /\[parse\] parsed fixture/);
  assert.match(stderr.content, /\[payment\] spent=0 cumulative=0/);
});

test('CLI emits structured JSON on stdout with --json', async () => {
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();

  const exitCode = await runCli(['summarize', '/tmp/book.pdf', '--json'], {
    stdout,
    stderr,
    resolveWallet: () => ({
      address: '0x1111111111111111111111111111111111111111',
      source: 'app',
      accountName: 'default',
      serviceName: 'bookfold'
    }),
    summarize: async () => createSummaryResult()
  });

  assert.equal(exitCode, 0);
  const parsed = JSON.parse(stdout.content);
  assert.equal(parsed.summary, 'Fixture summary output.');
  assert.equal(parsed.metadata.title, 'Fixture Book');
  assert.match(stderr.content, /\[payment\] spent=0 cumulative=0/);
});

test('CLI writes output to a file when --output is provided', async () => {
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'bookfold-cli-'));
  const outputPath = path.join(tempDir, 'summary.txt');

  const exitCode = await runCli(['summarize', '/tmp/book.pdf', '--output', outputPath], {
    stdout,
    stderr,
    resolveWallet: () => ({
      address: '0x1111111111111111111111111111111111111111',
      source: 'app',
      accountName: 'default',
      serviceName: 'bookfold'
    }),
    summarize: async () => createSummaryResult()
  });

  assert.equal(exitCode, 0);
  assert.equal(stdout.content, '');
  assert.match(stderr.content, /\[write\] Wrote output/);
  assert.match(stderr.content, /\[payment\] spent=0 cumulative=0/);
  assert.equal(await readFile(outputPath, 'utf8'), 'Fixture summary output.\n');
});

test('CLI can initialize a wallet on first summarize run', async () => {
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();

  const exitCode = await runCli(['summarize', '/tmp/book.pdf'], {
    stdout,
    stderr,
    resolveWallet: () => undefined,
    createWallet: () => ({
      address: '0x2222222222222222222222222222222222222222',
      source: 'app',
      accountName: 'default',
      serviceName: 'bookfold'
    }),
    isInteractive: () => true,
    confirm: async () => true,
    summarize: async () => createSummaryResult()
  });

  assert.equal(exitCode, 0);
  assert.match(stderr.content, /No Tempo wallet found/);
  assert.match(stderr.content, /\[wallet\] Created 0x2222/);
});

test('CLI wallet init prints wallet details', async () => {
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();

  const exitCode = await runCli(['wallet', 'init'], {
    stdout,
    stderr,
    resolveWallet: () => undefined,
    createWallet: () => ({
      address: '0x3333333333333333333333333333333333333333',
      source: 'app',
      accountName: 'default',
      serviceName: 'bookfold'
    })
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.content, /Wallet 0x3333/);
  assert.match(stdout.content, /Fund this address/);
  assert.equal(stderr.content, '');
});

test('CLI recover prints a recovery report', async () => {
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();

  const exitCode = await runCli(['recover'], {
    stdout,
    stderr,
    recover: async () => ({
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
    })
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.content, /Recovery store: \/tmp\/recovery\.json/);
  assert.match(stdout.content, /close-requested 0xaaaaaaaa/);
  assert.match(stdout.content, /Remaining recoverable channels: 1/);
  assert.equal(stderr.content, '');
});

test('CLI recover returns a non-zero exit code for failed recovery entries', async () => {
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();

  const exitCode = await runCli(['recover', '--json'], {
    stdout,
    stderr,
    recover: async () => ({
      storePath: '/tmp/recovery.json',
      remainingChannels: 1,
      results: [
        {
          channelId: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          cumulative: '82000',
          requestUrl: 'https://openai.mpp.tempo.xyz/v1/chat/completions',
          status: 'failed',
          error: 'forced close failed'
        }
      ]
    })
  });

  assert.equal(exitCode, 1);
  const parsed = JSON.parse(stdout.content);
  assert.equal(parsed.results[0].status, 'failed');
  assert.equal(stderr.content, '');
});
