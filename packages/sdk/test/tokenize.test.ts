import assert from 'node:assert/strict';
import test from 'node:test';
import {
  countPromptTokenBudget,
  countPromptTokens,
  countTextTokens
} from '../src/index.js';

test('countTextTokens uses pinned GPT-4o tokenizer mapping', () => {
  assert.equal(countTextTokens('hello world', 'gpt-4o-2024-11-20'), 2);
  assert.equal(countTextTokens('hello world', 'gpt-4o-mini-2024-07-18'), 2);
});

test('countPromptTokens serializes message frames deterministically', () => {
  assert.equal(
    countPromptTokens(
      [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hello' }
      ],
      'gpt-4o-2024-11-20'
    ),
    33
  );
});

test('countPromptTokenBudget adds reserved note budgets', () => {
  assert.equal(
    countPromptTokenBudget({
      systemPrompt: 'sys',
      userPrefix: 'prefix',
      noteBudgets: [10, 20],
      model: 'gpt-4o-2024-11-20'
    }),
    73
  );
});
