import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSummaryPlan, hashSummaryPlan } from '../src/index.js';
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

test('buildSummaryPlan creates a stable short single-pass plan', () => {
  const plan = buildSummaryPlan(createBook(2), 'short');

  assert.equal(plan.calls.length, 1);
  assert.equal(plan.calls[0]?.stage, 'single');
  assert.deepEqual(plan.totals, {
    callCount: 1,
    promptTokens: 645,
    reservedOutputTokens: 540,
    totalReservedTokens: 1185
  });
  assert.equal(
    hashSummaryPlan(plan),
    '596e4a9a489b63ae0640d8076556884a7a2f7f96d42b92d1f57c1c7b2afe97f1'
  );
});

test('buildSummaryPlan creates a stable medium map-reduce plan', () => {
  const plan = buildSummaryPlan(createBook(7), 'medium');

  assert.equal(plan.calls.length, 5);
  assert.equal(plan.calls[0]?.stage, 'map');
  assert.equal(plan.calls.at(-1)?.stage, 'reduce');
  assert.deepEqual(plan.totals, {
    callCount: 5,
    promptTokens: 3925,
    reservedOutputTokens: 2916,
    totalReservedTokens: 6841
  });
  assert.equal(
    hashSummaryPlan(plan),
    '2b39346635b714bb58b09e8598182957d44f413e087916a9a691c134c8bf3683'
  );
});

test('buildSummaryPlan creates a stable long section plan', () => {
  const plan = buildSummaryPlan(createBook(8, true), 'long');

  assert.equal(plan.calls.length, 5);
  assert.equal(plan.sectionCount, 4);
  assert.equal(plan.calls[0]?.stage, 'section-map');
  assert.deepEqual(plan.totals, {
    callCount: 5,
    promptTokens: 4741,
    reservedOutputTokens: 5112,
    totalReservedTokens: 9853
  });
  assert.equal(
    hashSummaryPlan(plan),
    '13199cdc6db62243541bf3b07b2864667bafb5aa019ea8225e1012ab0a203f18'
  );
});
