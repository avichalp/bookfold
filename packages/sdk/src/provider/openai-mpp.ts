import {
  OPENAI_MPP_BASE_URL,
  OPENAI_MPP_CHAT_COMPLETIONS_PATH
} from '../config.js';
import { createTempoRecoveryStore, type TempoRecoveryStore } from '../recovery.js';
import { TempoSessionClient } from '../session/tempo.js';
import type {
  GenerateTextRequest,
  GenerateTextResult,
  SummaryPaymentResult,
  SummarizationProvider
} from '../types.js';

interface OpenAiMppProviderOptions {
  baseUrl?: string | undefined;
  endpointPath?: string | undefined;
  privateKey?: `0x${string}` | undefined;
  recoveryStore?: TempoRecoveryStore | undefined;
}

interface OpenAiChatCompletionResponse {
  id?: string;
  model?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
}

export class OpenAiMppProvider implements SummarizationProvider {
  private readonly baseUrl: string;

  private readonly endpointPath: string;

  private readonly session: TempoSessionClient;

  constructor(options: OpenAiMppProviderOptions = {}) {
    this.baseUrl = options.baseUrl ?? OPENAI_MPP_BASE_URL;
    this.endpointPath = options.endpointPath ?? OPENAI_MPP_CHAT_COMPLETIONS_PATH;
    this.session = new TempoSessionClient({
      ...(options.privateKey ? { privateKey: options.privateKey } : {}),
      recoveryStore: options.recoveryStore ?? createTempoRecoveryStore()
    });
  }

  async generateText(request: GenerateTextRequest): Promise<GenerateTextResult> {
    const { data } = await this.session.fetchJson<OpenAiChatCompletionResponse>(
      new URL(this.endpointPath, this.baseUrl),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json'
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          max_tokens: request.maxOutputTokens,
          temperature: request.temperature ?? 0.2,
          stream: false
        }),
        ...(request.signal ? { signal: request.signal } : {})
      }
    );

    const text = extractText(data);
    if (!text) {
      throw new Error('OpenAI MPP response did not include assistant text.');
    }

    return {
      text,
      model: typeof data.model === 'string' && data.model ? data.model : request.model,
      usage: data.usage
        ? {
            inputTokens: data.usage.prompt_tokens,
            outputTokens: data.usage.completion_tokens,
            totalTokens: data.usage.total_tokens
          }
        : undefined
    };
  }

  getPaymentSummary(): SummaryPaymentResult {
    const state = this.session.paymentState;
    return {
      kind: 'session',
      provider: 'openai-mpp',
      baseUrl: this.baseUrl,
      endpointPath: this.endpointPath,
      maxDeposit: this.session.depositLimit,
      spent: state.spent,
      cumulative: state.cumulative,
      channelId: state.channelId,
      finalReceipt: state.finalReceipt ? { ...state.finalReceipt } : undefined,
      lastReceipt: state.lastReceipt ? { ...state.lastReceipt } : undefined,
      closeError: state.closeError,
      requestCount: state.requestCount
    };
  }

  async close(): Promise<Record<string, unknown> | undefined> {
    const receipt = await this.session.close();
    return receipt ? { ...receipt } : undefined;
  }
}

function extractText(response: OpenAiChatCompletionResponse): string {
  const content = response.choices?.[0]?.message?.content;
  if (typeof content === 'string') {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => (part?.type === 'text' && typeof part.text === 'string' ? part.text : ''))
      .join('')
      .trim();
  }

  return '';
}
