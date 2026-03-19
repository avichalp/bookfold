import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { summarizeBook } from '../src/index.js';
import type {
  GenerateTextRequest,
  GenerateTextResult,
  SummaryPaymentResult,
  SummarizationProvider
} from '../src/types.js';
import { createPdfFixture } from './helpers.js';

class ClosingFailureProvider implements SummarizationProvider {
  async generateText(_request: GenerateTextRequest): Promise<GenerateTextResult> {
    return {
      text: Array.from({ length: 180 }, (_value, index) => `summary-${index + 1}`).join(' '),
      model: 'mock-model'
    };
  }

  getPaymentSummary(): SummaryPaymentResult {
    return {
      provider: 'mock',
      spent: '0',
      cumulative: '0',
      requestCount: 1
    };
  }

  async close(): Promise<Record<string, unknown> | undefined> {
    throw new Error('Failed to close Tempo session: close failed');
  }
}

test('summarizeBook keeps the summary result and reports session close failure', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'bookfold-sdk-'));
  const filePath = path.join(tempDir, 'fixture.pdf');
  await writeFile(filePath, await createPdfFixture());

  const result = await summarizeBook({
    filePath,
    detail: 'short',
    provider: new ClosingFailureProvider()
  });

  assert.match(result.summary, /^summary-1 summary-2/);
  assert.match(result.payment.closeError ?? '', /close failed/);
  assert.ok(result.warnings?.some((warning) => /close failed/.test(warning)));
});

test('summarizeBook surfaces local file errors before requiring TEMPO_PRIVATE_KEY', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'bookfold-sdk-'));
  const filePath = path.join(tempDir, 'notes.txt');
  await writeFile(filePath, 'plain text');

  await assert.rejects(
    () => summarizeBook({ filePath, detail: 'short' }),
    /Unsupported file type/
  );
});
