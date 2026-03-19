import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePdf } from '../src/book/pdf.js';
import { createBlankPdfFixture, createPdfFixture } from './helpers.js';

test('parsePdf extracts text and metadata from a small fixture PDF', async () => {
  const book = await parsePdf('/tmp/fixture.pdf', await createPdfFixture());

  assert.equal(book.fileType, 'pdf');
  assert.equal(book.metadata.info.title, 'Fixture Book');
  assert.equal(book.metadata.info.author, 'Bookfold');
  assert.equal(book.metadata.pageCount, 2);
  assert.ok(book.chunks.length >= 1);
  assert.match(book.chunks[0].content, /first page of the fixture book/i);
});

test('parsePdf rejects PDFs with no extractable text', async () => {
  await assert.rejects(
    async () => parsePdf('/tmp/blank.pdf', await createBlankPdfFixture()),
    /Could not extract text from PDF/
  );
});
