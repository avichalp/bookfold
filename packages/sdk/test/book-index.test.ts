import assert from 'node:assert/strict';
import { mkdtemp, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseBookFromFile } from '../src/book/index.js';
import { MAX_FILE_BYTES } from '../src/config.js';
import { createMalformedEpubFixture } from './helpers.js';

test('parseBookFromFile rejects unsupported file types', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'summ-tempo-book-'));
  const filePath = path.join(tempDir, 'notes.txt');
  await writeFile(filePath, 'plain text');

  await assert.rejects(
    () => parseBookFromFile(filePath),
    /Unsupported file type/
  );
});

test('parseBookFromFile rejects oversized files before parsing', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'summ-tempo-book-'));
  const filePath = path.join(tempDir, 'large.pdf');
  await writeFile(filePath, '');
  await truncate(filePath, MAX_FILE_BYTES + 1);

  await assert.rejects(
    () => parseBookFromFile(filePath),
    /too large/
  );
});

test('parseBookFromFile surfaces malformed EPUB errors', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'summ-tempo-book-'));
  const filePath = path.join(tempDir, 'broken.epub');
  await writeFile(filePath, await createMalformedEpubFixture());

  await assert.rejects(
    () => parseBookFromFile(filePath),
    /META-INF\/container\.xml/
  );
});

test('parseBookFromFile surfaces broken PDF errors', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'summ-tempo-book-'));
  const filePath = path.join(tempDir, 'broken.pdf');
  await writeFile(filePath, 'not really a pdf');

  await assert.rejects(
    () => parseBookFromFile(filePath),
    /Failed to parse PDF/
  );
});
