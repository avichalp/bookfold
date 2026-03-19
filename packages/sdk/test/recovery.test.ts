import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { privateKeyToAccount } from 'viem/accounts';
import {
  FileTempoRecoveryStore,
  recoverTempoSessions,
  type TempoRecoveryEntry,
  type TempoRecoveryStore
} from '../src/recovery.js';

class MemoryRecoveryStore implements TempoRecoveryStore {
  readonly filePath = '/tmp/summ-tempo-recovery.json';

  private entries: TempoRecoveryEntry[];

  constructor(entries: TempoRecoveryEntry[] = []) {
    this.entries = [...entries];
  }

  async list(): Promise<TempoRecoveryEntry[]> {
    return [...this.entries];
  }

  async upsert(entry: TempoRecoveryEntry): Promise<void> {
    const index = this.entries.findIndex((candidate) => candidate.channelId === entry.channelId);
    if (index === -1) {
      this.entries.push(entry);
    } else {
      this.entries[index] = {
        ...entry,
        createdAt: this.entries[index].createdAt
      };
    }
  }

  async remove(channelId: string): Promise<void> {
    this.entries = this.entries.filter((entry) => entry.channelId !== channelId);
  }
}

const privateKey = `0x${'11'.repeat(32)}` as const;
const payerAddress = privateKeyToAccount(privateKey).address;

function createEntry(overrides: Partial<TempoRecoveryEntry> = {}): TempoRecoveryEntry {
  return {
    channelId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    cumulative: '22000',
    requestUrl: 'https://openai.mpp.tempo.xyz/v1/chat/completions',
    requestKind: 'openai-chat-completions',
    payerAddress,
    chainId: 4217,
    escrowContract: '0x33b901018174DDabE4841042ab76ba85D4e24f25',
    feeToken: '0x20c000000000000000000000b9537d11c60e8b50',
    createdAt: '2026-03-19T00:00:00.000Z',
    updatedAt: '2026-03-19T00:00:00.000Z',
    ...overrides
  };
}

test('FileTempoRecoveryStore upserts and removes entries on disk', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'summ-tempo-recovery-'));
  const filePath = path.join(tempDir, 'recovery.json');
  const store = new FileTempoRecoveryStore(filePath);
  const first = createEntry();
  const second = createEntry({
    channelId: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    cumulative: '82000'
  });

  await store.upsert(first);
  await store.upsert(second);
  await store.upsert({ ...first, cumulative: '33000', updatedAt: '2026-03-19T01:00:00.000Z' });

  const parsed = JSON.parse(await readFile(filePath, 'utf8')) as { version: number; channels: Array<{ channelId: string; cumulative: string; createdAt: string }> };
  assert.equal(parsed.version, 1);
  assert.equal(parsed.channels.length, 2);
  assert.equal(parsed.channels[0].cumulative, '33000');
  assert.equal(parsed.channels[0].createdAt, first.createdAt);

  await store.remove(first.channelId);
  const remaining = await store.list();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].channelId, second.channelId);
});

test('recoverTempoSessions closes a stored channel cooperatively and removes it from the store', async () => {
  const entry = createEntry();
  const store = new MemoryRecoveryStore([entry]);

  const report = await recoverTempoSessions({
    store,
    privateKey,
    closeViaService: async () => ({
      method: 'tempo',
      intent: 'session',
      status: 'success',
      timestamp: '2026-03-19T00:00:00.000Z',
      reference: entry.channelId,
      challengeId: 'challenge',
      channelId: entry.channelId,
      acceptedCumulative: entry.cumulative,
      spent: entry.cumulative,
      txHash: '0xclose'
    }),
    getChannelState: async () => ({
      finalized: false,
      closeRequestedAt: 0n,
      deposit: 1_000_000n,
      settled: 0n
    }),
    requestClose: async () => {
      throw new Error('should not request close');
    },
    withdraw: async () => {
      throw new Error('should not withdraw');
    }
  });

  assert.equal(report.remainingChannels, 0);
  assert.equal(report.results[0].status, 'closed');
  assert.equal(report.results[0].txHash, '0xclose');
  assert.equal((await store.list()).length, 0);
});

test('recoverTempoSessions requests forced close when cooperative close fails', async () => {
  const entry = createEntry();
  const store = new MemoryRecoveryStore([entry]);

  const report = await recoverTempoSessions({
    store,
    privateKey,
    closeViaService: async () => {
      throw new Error('service close failed');
    },
    getChannelState: async () => ({
      finalized: false,
      closeRequestedAt: 0n,
      deposit: 1_000_000n,
      settled: 0n
    }),
    requestClose: async () => ({
      txHash: '0xrequestclose',
      unlockAt: new Date('2026-03-19T12:44:50.000Z')
    }),
    withdraw: async () => {
      throw new Error('should not withdraw');
    }
  });

  assert.equal(report.remainingChannels, 1);
  assert.equal(report.results[0].status, 'close-requested');
  assert.equal(report.results[0].txHash, '0xrequestclose');
  assert.match(report.results[0].error ?? '', /service close failed/);
});

test('recoverTempoSessions withdraws a matured forced-close channel and removes it', async () => {
  const entry = createEntry();
  const store = new MemoryRecoveryStore([entry]);

  const report = await recoverTempoSessions({
    store,
    privateKey,
    getChannelState: async () => ({
      finalized: false,
      closeRequestedAt: 1n,
      deposit: 1_000_000n,
      settled: 0n
    }),
    withdraw: async () => ({
      txHash: '0xwithdraw'
    }),
    now: () => new Date('2026-03-19T12:45:10.000Z')
  });

  assert.equal(report.remainingChannels, 0);
  assert.equal(report.results[0].status, 'withdrawn');
  assert.equal(report.results[0].txHash, '0xwithdraw');
  assert.equal((await store.list()).length, 0);
});

test('recoverTempoSessions returns an empty report when nothing is stored', async () => {
  const report = await recoverTempoSessions({
    store: new MemoryRecoveryStore()
  });

  assert.equal(report.remainingChannels, 0);
  assert.deepEqual(report.results, []);
});
