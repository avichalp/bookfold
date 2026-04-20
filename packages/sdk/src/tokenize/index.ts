import { encodingForModel, type TiktokenModel } from 'js-tiktoken';
import type { ProviderMessage } from '../types.js';

const MODEL_ALIASES: Record<string, TiktokenModel> = {
  'gpt-4o': 'gpt-4o',
  'gpt-4o-mini': 'gpt-4o-mini',
  'gpt-4o-2024-11-20': 'gpt-4o',
  'gpt-4o-2024-08-06': 'gpt-4o',
  'gpt-4o-2024-05-13': 'gpt-4o',
  'gpt-4o-mini-2024-07-18': 'gpt-4o-mini'
};

const encoderCache = new Map<TiktokenModel, ReturnType<typeof encodingForModel>>();

export function countTextTokens(text: string, model: string): number {
  return getEncoder(model).encode(text).length;
}

export function countPromptTokens(messages: ProviderMessage[], model: string): number {
  const serialized = messages
    .map(
      (message) =>
        `<|start|>${message.role}\n${message.content}\n<|end|>`
    )
    .join('\n');

  return countTextTokens(`${serialized}\n<|assistant|>`, model);
}

export function countPromptTokenBudget(parameters: {
  systemPrompt: string;
  userPrefix: string;
  noteBudgets: number[];
  noteLabelPrefix?: string | undefined;
  model: string;
}): number {
  const { systemPrompt, userPrefix, noteBudgets, noteLabelPrefix = 'NOTE', model } = parameters;
  let total = countPromptTokens(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrefix }
    ],
    model
  );

  total += countTextTokens('\n\n', model);

  for (let index = 0; index < noteBudgets.length; index += 1) {
    if (index > 0) {
      total += countTextTokens('\n\n', model);
    }

    total += countTextTokens(`${noteLabelPrefix} ${index + 1}:\n`, model);
    total += noteBudgets[index] ?? 0;
  }

  return total;
}

function getEncoder(model: string) {
  const resolved = resolveTokenizerModel(model);
  const cached = encoderCache.get(resolved);
  if (cached) {
    return cached;
  }

  const encoder = encodingForModel(resolved);
  encoderCache.set(resolved, encoder);
  return encoder;
}

function resolveTokenizerModel(model: string): TiktokenModel {
  const resolved = MODEL_ALIASES[model];
  if (!resolved) {
    throw new Error(`No tokenizer mapping exists for model "${model}".`);
  }

  return resolved;
}
