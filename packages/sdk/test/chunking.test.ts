import assert from 'node:assert/strict';
import test from 'node:test';
import { chunkTextWithPages } from '../src/chunking.js';

test('chunkTextWithPages creates deterministic overlapping chunks', () => {
  const paragraph = 'A'.repeat(2_600);
  const chunks = chunkTextWithPages([
    { pageNumber: 1, text: `${paragraph}\n\n${paragraph}` },
    { pageNumber: 2, text: `${paragraph}\n\n${paragraph}` }
  ]);

  assert.ok(chunks.length >= 3);
  assert.equal(chunks[0].pageNumbers[0], 1);
  assert.ok(chunks.some((chunk) => chunk.pageNumbers.includes(2)));
  assert.ok(chunks[1].content.startsWith(chunks[0].content.slice(-200).trim().slice(0, 50)));
  assert.deepEqual(
    chunkTextWithPages([
      { pageNumber: 1, text: `${paragraph}\n\n${paragraph}` },
      { pageNumber: 2, text: `${paragraph}\n\n${paragraph}` }
    ]),
    chunks
  );
});
