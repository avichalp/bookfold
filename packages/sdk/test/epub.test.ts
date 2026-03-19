import assert from 'node:assert/strict';
import test from 'node:test';
import { parseEpub, validateEpubStructure } from '../src/book/epub.js';
import {
  createEpubFixture,
  createEpubFixtureWithMalformedNcx,
  createMalformedEpubFixture
} from './helpers.js';

test('parseEpub extracts chapters, metadata, and TOC from a small fixture EPUB', async () => {
  const book = await parseEpub('/tmp/fixture.epub', await createEpubFixture());

  assert.equal(book.fileType, 'epub');
  assert.equal(book.metadata.info.title, 'Fixture EPUB');
  assert.equal(book.metadata.info.author, 'Bookfold');
  assert.equal(book.metadata.chapterCount, 2);
  assert.equal(book.metadata.tocEntries?.length, 2);
  assert.ok(book.chunks.length >= 1);
  assert.match(book.chunks[0].content, /first chapter of the fixture EPUB/i);
});

test('validateEpubStructure reports malformed EPUBs clearly', async () => {
  const result = await validateEpubStructure(await createMalformedEpubFixture());
  assert.equal(result.valid, false);
  assert.match(result.error ?? '', /META-INF\/container\.xml/);
});

test('parseEpub falls back to spine headings when the NCX is malformed', async () => {
  const book = await parseEpub('/tmp/fixture-bad-ncx.epub', await createEpubFixtureWithMalformedNcx());

  assert.equal(book.fileType, 'epub');
  assert.equal(book.metadata.info.title, 'Fixture EPUB With Broken NCX');
  assert.equal(book.metadata.chapterCount, 2);
  assert.deepEqual(
    book.metadata.tocEntries?.map((entry) => entry.title),
    ['Chapter One', 'Chapter Two']
  );
  assert.match(book.chunks[0]?.content ?? '', /readable even if the NCX is malformed/i);
});
