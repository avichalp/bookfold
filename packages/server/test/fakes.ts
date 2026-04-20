import type {
  GenerateTextRequest,
  GenerateTextResult,
  SummarizationProvider,
  SummaryPaymentResult
} from '@bookfold/sdk';
import type { JobPaymentAuthorizer, JobStarter } from '../src/runtime.js';
import { runBookFoldJobWorkflow } from '../../../workflows/bookfold-job.js';

export class FakeJobPaymentAuthorizer implements JobPaymentAuthorizer {
  constructor(
    private readonly options: {
      nowIso?: string | undefined;
    } = {}
  ) {}

  async authorize(input: Parameters<JobPaymentAuthorizer['authorize']>[0]) {
    const authorization = input.request.headers.get('authorization');
    if (!authorization) {
      return {
        kind: 'challenge' as const,
        response: new Response(
          JSON.stringify({
            error: {
              code: 'payment_required',
              message: 'Payment is required.'
            }
          }),
          {
            status: 402,
            headers: {
              'content-type': 'application/json; charset=utf-8',
              'www-authenticate': 'Payment realm="bookfold.test", token="fake"'
            }
          }
        )
      };
    }

    const reference = authorization.replace(/^Payment\s+/i, '').trim() || 'paid-receipt';

    return {
      kind: 'paid' as const,
      challengeId: 'challenge-fake',
      receipt: {
        method: 'tempo',
        reference,
        externalId: input.quote.id,
        status: 'success',
        timestamp: this.options.nowIso ?? '2026-04-15T00:00:00.000Z'
      }
    };
  }
}

export class FakeJobStarter implements JobStarter {
  readonly calls: string[] = [];

  async start(jobId: string): Promise<{ runId: string }> {
    this.calls.push(jobId);
    return { runId: `run-${jobId}` };
  }
}

export class InlineWorkflowJobStarter implements JobStarter {
  readonly calls: string[] = [];

  private readonly runs: Promise<unknown>[] = [];

  async start(jobId: string): Promise<{ runId: string }> {
    this.calls.push(jobId);
    this.runs.push(
      Promise.resolve().then(async () => {
        await runBookFoldJobWorkflow(jobId);
      })
    );

    return { runId: `run-${jobId}` };
  }

  async waitForAll(): Promise<void> {
    await Promise.allSettled(this.runs);
  }
}

export class FakeSummarizationProvider implements SummarizationProvider {
  readonly requests: GenerateTextRequest[] = [];

  constructor(
    private readonly options: {
      closeError?: string | undefined;
      failMessage?: string | undefined;
      text?: string | undefined;
    } = {}
  ) {}

  async generateText(request: GenerateTextRequest): Promise<GenerateTextResult> {
    this.requests.push(request);

    if (this.options.failMessage) {
      throw new Error(this.options.failMessage);
    }

    return {
      text: this.options.text ?? `Summary for ${request.model}`,
      model: request.model,
      usage: {
        inputTokens: 128,
        outputTokens: 48,
        totalTokens: 176
      }
    };
  }

  getPaymentSummary(): SummaryPaymentResult {
    return {
      kind: 'session',
      provider: 'openai-mpp',
      spent: '123',
      cumulative: '123',
      channelId: 'channel-test',
      requestCount: this.requests.length,
      finalReceipt: {
        method: 'tempo',
        reference: 'outbound-receipt',
        status: 'success',
        timestamp: '2026-04-15T00:00:00.000Z'
      },
      closeError: this.options.closeError
    };
  }

  async close(): Promise<Record<string, unknown> | undefined> {
    if (this.options.closeError) {
      throw new Error(this.options.closeError);
    }

    return {
      method: 'tempo',
      reference: 'outbound-receipt',
      status: 'success',
      timestamp: '2026-04-15T00:00:00.000Z'
    };
  }
}
