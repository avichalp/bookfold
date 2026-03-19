import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenAiMppProvider } from '../src/provider/openai-mpp.js';

const sampleRequest = {
  model: 'gpt-4o-mini',
  messages: [
    { role: 'system' as const, content: 'system' },
    { role: 'user' as const, content: 'user' }
  ],
  maxOutputTokens: 64
};

test('OpenAiMppProvider can run against an injected session client without wallet lookup', async () => {
  const provider = new OpenAiMppProvider({
    sessionClient: {
      async fetchJson() {
        return {
          data: {
            model: 'gpt-4o-mini',
            choices: [{ message: { content: 'hello' } }]
          },
          cumulative: '0'
        };
      },
      async close() {
        return undefined;
      },
      paymentState: {
        spent: '0',
        cumulative: '0',
        requestCount: 0
      },
      depositLimit: '1'
    }
  });

  const result = await provider.generateText(sampleRequest);
  assert.equal(result.text, 'hello');
});

test('OpenAiMppProvider surfaces insufficient-funds style payment failures', async () => {
  const provider = new OpenAiMppProvider({
    sessionClient: {
      async fetchJson() {
        throw new Error('Tempo session request failed: insufficient funds');
      },
      async close() {
        return undefined;
      },
      paymentState: {
        spent: '0',
        cumulative: '0',
        requestCount: 0
      },
      depositLimit: '1'
    }
  });

  await assert.rejects(
    () => provider.generateText(sampleRequest),
    /insufficient funds/
  );
});

test('OpenAiMppProvider surfaces upstream model failures', async () => {
  const provider = new OpenAiMppProvider({
    sessionClient: {
      async fetchJson() {
        throw new Error('OpenAI MPP request failed (500): model overloaded');
      },
      async close() {
        return undefined;
      },
      paymentState: {
        spent: '0',
        cumulative: '0',
        requestCount: 0
      },
      depositLimit: '1'
    }
  });

  await assert.rejects(
    () => provider.generateText(sampleRequest),
    /model overloaded/
  );
});
