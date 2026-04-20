import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_PRICE_SHEET,
  buildSummaryPlan,
  priceSummaryPlan
} from '../src/index.js';
import type { ParsedBook } from '../src/book/types.js';

function createBook(chunkCount: number, withSections = false): ParsedBook {
  const chunks = Array.from({ length: chunkCount }, (_value, index) => ({
    content: `Chunk ${index + 1}. ${'content '.repeat(220)}`,
    metadata: { pageNumbers: [index + 1] }
  }));

  return {
    filePath: '/tmp/fake.pdf',
    fileType: 'pdf',
    chunks,
    textLength: chunks.reduce((total, chunk) => total + chunk.content.length, 0),
    metadata: {
      info: {
        title: 'Fake Book',
        author: 'Bookfold'
      },
      pageCount: chunkCount,
      outlineEntries: withSections
        ? [
            { title: 'Part One', pageNumber: 1, level: 0, children: [] },
            { title: 'Part Two', pageNumber: 3, level: 0, children: [] },
            { title: 'Part Three', pageNumber: 5, level: 0, children: [] },
            { title: 'Part Four', pageNumber: 7, level: 0, children: [] }
          ]
        : []
    }
  };
}

test('default price sheet uses the frozen version', () => {
  assert.equal(DEFAULT_PRICE_SHEET.version, 'bookfold-price-v1');
  assert.equal(DEFAULT_PRICE_SHEET.models['gpt-4o-2024-11-20']?.inputMicrosUsdPerMillionTokens, '2500000');
});

test('priceSummaryPlan prices the short plan deterministically', () => {
  const plan = buildSummaryPlan(createBook(2), 'short');
  const price = priceSummaryPlan(plan);

  assert.equal(price.amount, '56472');
  assert.equal(price.subtotalMicrosUsd, '421');
  assert.equal(price.bookfoldFeeMicrosUsd, '50000');
  assert.equal(price.safetyBufferMicrosUsd, '6051');
});

test('priceSummaryPlan prices the medium plan deterministically', () => {
  const plan = buildSummaryPlan(createBook(7), 'medium');
  const price = priceSummaryPlan(plan);

  assert.equal(price.amount, '211650');
  assert.equal(price.lines.length, 5);
  assert.equal(price.bookfoldFeeMicrosUsd, '150000');
});

test('priceSummaryPlan prices the long plan deterministically', () => {
  const plan = buildSummaryPlan(createBook(8, true), 'long');
  const price = priceSummaryPlan(plan);

  assert.equal(price.amount, '462530');
  assert.equal(price.lines.length, 5);
  assert.equal(price.bookfoldFeeMicrosUsd, '350000');
});
