import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { summarizeBook } from '../src/index.js';

test('summarizeBook surfaces local file errors before requiring TEMPO_PRIVATE_KEY', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'bookfold-sdk-'));
  const filePath = path.join(tempDir, 'notes.txt');
  await writeFile(filePath, 'plain text');

  await assert.rejects(
    () => summarizeBook({ filePath, detail: 'short' }),
    /Unsupported file type/
  );
});
