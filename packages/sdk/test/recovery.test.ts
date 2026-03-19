import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createTempoRecoveryStore,
  recoverTempoSessions,
  type TempoRecoveryEntry
} from '../src/recovery.js';

async function withHomeDirectory<T>(
  homeDirectory: string,
  callback: () => Promise<T> | T
): Promise<T> {
  const previousHome = process.env.HOME;
  process.env.HOME = homeDirectory;

  try {
    return await callback();
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
}

function createEntry(overrides: Partial<TempoRecoveryEntry> = {}): TempoRecoveryEntry {
  return {
    channelId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    cumulative: '22000',
    requestUrl: 'https://openai.mpp.tempo.xyz/v1/chat/completions',
    requestKind: 'openai-chat-completions',
    payerAddress: '0x19E7E376E7C213B7E7e7e46cc70A5Dd086DAff2A',
    chainId: 4217,
    escrowContract: '0x33b901018174DDabE4841042ab76ba85D4e24f25',
    feeToken: '0x20c000000000000000000000b9537d11c60e8b50',
    createdAt: '2026-03-19T00:00:00.000Z',
    updatedAt: '2026-03-19T00:00:00.000Z',
    ...overrides
  };
}

test('FileTempoRecoveryStore upserts and removes entries on disk', async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), 'bookfold-recovery-'));

  await withHomeDirectory(tempHome, async () => {
    const filePath = path.join(tempHome, '.bookfold', 'recovery.json');
    const store = createTempoRecoveryStore();
    const first = createEntry();
    const second = createEntry({
      channelId: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      cumulative: '82000'
    });

    await store.upsert(first);
    await store.upsert(second);
    await store.upsert({ ...first, cumulative: '33000', updatedAt: '2026-03-19T01:00:00.000Z' });

    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as {
      version: number;
      channels: Array<{ channelId: string; cumulative: string; createdAt: string }>;
    };
    assert.equal(parsed.version, 1);
    assert.equal(parsed.channels.length, 2);
    assert.equal(parsed.channels[0].cumulative, '33000');
    assert.equal(parsed.channels[0].createdAt, first.createdAt);

    await store.remove(first.channelId);
    const remaining = await store.list();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].channelId, second.channelId);
  });
});

test('recoverTempoSessions returns an empty report when nothing is stored', async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), 'bookfold-recovery-'));

  await withHomeDirectory(tempHome, async () => {
    const report = await recoverTempoSessions();

    assert.equal(report.remainingChannels, 0);
    assert.deepEqual(report.results, []);
    assert.equal(report.storePath, path.join(tempHome, '.bookfold', 'recovery.json'));
  });
});
