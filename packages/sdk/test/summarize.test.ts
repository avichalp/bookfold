import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeParsedBook } from '../src/summarize/index.js';
import type {
  GenerateTextRequest,
  GenerateTextResult,
  SummaryPaymentResult,
  SummarizationProvider
} from '../src/types.js';
import type { ParsedBook } from '../src/book/types.js';

class MockProvider implements SummarizationProvider {
  readonly calls: GenerateTextRequest[] = [];

  closeCalls = 0;

  async generateText(request: GenerateTextRequest): Promise<GenerateTextResult> {
    this.calls.push(request);

    const prompt = request.messages.find((message) => message.role === 'user')?.content ?? '';
    const taskKind = /TASK_KIND:\s*([A-Z-]+)/.exec(prompt)?.[1] ?? 'UNKNOWN';
    const targetMatch = /TARGET_WORDS:\s*(\d+)-(\d+)/.exec(prompt);
    const minWords = targetMatch ? Number.parseInt(targetMatch[1], 10) : 100;
    const maxWords = targetMatch ? Number.parseInt(targetMatch[2], 10) : minWords;
    const targetWords = Math.round((minWords + maxWords) / 2);

    return {
      text: Array.from({ length: targetWords }, (_value, index) => `${taskKind.toLowerCase()}-${index + 1}`).join(' '),
      model: request.model
    };
  }

  getPaymentSummary(): SummaryPaymentResult {
    return {
      provider: 'mock',
      spent: '0',
      cumulative: '0',
      requestCount: this.calls.length
    };
  }

  async close(): Promise<Record<string, unknown> | undefined> {
    this.closeCalls += 1;
    return undefined;
  }
}

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
        author: 'Summ Tempo'
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

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

test('short detail uses single-pass for small books', async () => {
  const provider = new MockProvider();
  const result = await summarizeParsedBook({
    book: createBook(2),
    detail: 'short',
    provider
  });

  assert.equal(result.debug.strategy, 'single-pass');
  assert.equal(result.debug.modelCallCount, 1);
  assert.equal(provider.calls.length, 1);
  assert.ok(countWords(result.summary) >= 150);
  assert.ok(countWords(result.summary) <= 300);
});

test('medium detail uses map-reduce for larger books', async () => {
  const provider = new MockProvider();
  const result = await summarizeParsedBook({
    book: createBook(7),
    detail: 'medium',
    provider
  });

  assert.equal(result.debug.strategy, 'map-reduce');
  assert.equal(provider.calls.length, 5);
  assert.ok(countWords(result.summary) >= 500);
  assert.ok(countWords(result.summary) <= 900);
});

test('long detail uses section-aware map-reduce when TOC data exists', async () => {
  const provider = new MockProvider();
  const result = await summarizeParsedBook({
    book: createBook(8, true),
    detail: 'long',
    provider
  });

  assert.equal(result.debug.strategy, 'section-aware-map-reduce');
  assert.equal(result.debug.sectionCount, 4);
  assert.equal(provider.calls.length, 5);
  assert.ok(countWords(result.summary) >= 1200);
  assert.ok(countWords(result.summary) <= 1800);
});
