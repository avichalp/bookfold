import assert from 'node:assert/strict';
import test from 'node:test';
import { TempoSessionClient } from '../src/session/tempo.js';

class FakeSessionManager {
  channelId: string | null = null;

  fetchCount = 0;

  openAttempts = 0;

  inFlightOpenRequests = 0;

  includeChallenge = false;

  async fetch(): Promise<Response & {
    receipt?: unknown;
    channelId?: string | null;
    cumulative?: bigint;
    challenge?: unknown;
  }> {
    if (!this.channelId) {
      this.openAttempts += 1;
      this.inFlightOpenRequests += 1;

      if (this.inFlightOpenRequests > 1) {
        throw new Error('concurrent session open detected');
      }

      await new Promise((resolve) => setTimeout(resolve, 20));
      this.channelId = '0xsession';
      this.inFlightOpenRequests -= 1;
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    this.fetchCount += 1;

    const response = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }) as Response & {
      receipt?: unknown;
      channelId?: string | null;
      cumulative?: bigint;
      challenge?: unknown;
    };

    response.channelId = this.channelId;
    response.cumulative = 1000n;
    if (this.includeChallenge) {
      response.challenge = {
        request: {
          currency: '0x20c000000000000000000000b9537d11c60e8b50',
          methodDetails: {
            chainId: 4217,
            escrowContract: '0x33b901018174DDabE4841042ab76ba85D4e24f25'
          }
        }
      };
    }
    response.receipt = {
      method: 'tempo',
      intent: 'session',
      status: 'success',
      timestamp: new Date().toISOString(),
      reference: this.channelId,
      challengeId: 'challenge',
      channelId: this.channelId,
      acceptedCumulative: '1000',
      spent: '0'
    };

    return response;
  }

  async close(): Promise<undefined> {
    return undefined;
  }
}

class OutOfOrderSessionManager extends FakeSessionManager {
  override includeChallenge = true;

  private responseSequence = 0;

  override async fetch(): Promise<Response & {
    receipt?: unknown;
    channelId?: string | null;
    cumulative?: bigint;
    challenge?: unknown;
  }> {
    if (!this.channelId) {
      this.openAttempts += 1;
      this.inFlightOpenRequests += 1;

      if (this.inFlightOpenRequests > 1) {
        throw new Error('concurrent session open detected');
      }

      await new Promise((resolve) => setTimeout(resolve, 20));
      this.channelId = '0xsession';
      this.inFlightOpenRequests -= 1;
    }

    const responseIndex = this.responseSequence;
    this.responseSequence += 1;
    const plan = [
      { delayMs: 0, cumulative: 1000n },
      { delayMs: 25, cumulative: 2000n },
      { delayMs: 5, cumulative: 3000n }
    ][responseIndex] ?? { delayMs: 0, cumulative: 3000n };

    await new Promise((resolve) => setTimeout(resolve, plan.delayMs));
    this.fetchCount += 1;

    const response = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }) as Response & {
      receipt?: unknown;
      channelId?: string | null;
      cumulative?: bigint;
      challenge?: unknown;
    };

    response.channelId = this.channelId;
    response.cumulative = plan.cumulative;
    response.challenge = {
      request: {
        currency: '0x20c000000000000000000000b9537d11c60e8b50',
        methodDetails: {
          chainId: 4217,
          escrowContract: '0x33b901018174DDabE4841042ab76ba85D4e24f25'
        }
      }
    };
    response.receipt = {
      method: 'tempo',
      intent: 'session',
      status: 'success',
      timestamp: new Date().toISOString(),
      reference: this.channelId,
      challengeId: `challenge-${responseIndex + 1}`,
      channelId: this.channelId,
      acceptedCumulative: plan.cumulative.toString(),
      spent: plan.cumulative.toString()
    };

    return response;
  }
}

test('serializes the first fetch until the session channel exists', async () => {
  const manager = new FakeSessionManager();
  const client = new TempoSessionClient({
    privateKey: `0x${'11'.repeat(32)}`,
    sessionManager: manager
  });

  const results = await Promise.all([
    client.fetchJson<{ ok: boolean }>('https://example.com/1'),
    client.fetchJson<{ ok: boolean }>('https://example.com/2'),
    client.fetchJson<{ ok: boolean }>('https://example.com/3')
  ]);

  assert.equal(manager.openAttempts, 1);
  assert.equal(manager.fetchCount, 3);
  assert.equal(client.paymentState.channelId, '0xsession');
  assert.deepEqual(
    results.map((result) => result.data.ok),
    [true, true, true]
  );
});

test('marks close without a final receipt as a recovery warning', async () => {
  const manager = new FakeSessionManager();
  const client = new TempoSessionClient({
    privateKey: `0x${'22'.repeat(32)}`,
    sessionManager: manager
  });

  await client.fetchJson<{ ok: boolean }>('https://example.com/summary');
  const receipt = await client.close();

  assert.equal(receipt, undefined);
  assert.match(
    client.paymentState.closeError ?? '',
    /close returned no final receipt.*run `summ-tempo recover`/i
  );
});

test('falls back to direct channel close when the provider returns no final receipt', async () => {
  const manager = new FakeSessionManager();
  manager.includeChallenge = true;
  const client = new TempoSessionClient({
    privateKey: `0x${'33'.repeat(32)}`,
    sessionManager: manager,
    closeChannelFallback: async ({ channelId, cumulative }) => ({
      method: 'tempo',
      intent: 'session',
      status: 'success',
      timestamp: new Date().toISOString(),
      reference: channelId,
      challengeId: '',
      channelId,
      acceptedCumulative: cumulative,
      spent: cumulative,
      txHash: '0xfallback'
    })
  });

  await client.fetchJson<{ ok: boolean }>('https://example.com/summary');
  const receipt = await client.close();

  assert.equal(receipt?.txHash, '0xfallback');
  assert.equal(client.paymentState.finalReceipt?.txHash, '0xfallback');
  assert.equal(client.paymentState.closeError, undefined);
});

test('keeps the highest cumulative receipt when concurrent requests finish out of order', async () => {
  const manager = new OutOfOrderSessionManager();
  let fallbackCumulative = '0';
  const client = new TempoSessionClient({
    privateKey: `0x${'44'.repeat(32)}`,
    sessionManager: manager,
    closeChannelFallback: async ({ channelId, cumulative }) => {
      fallbackCumulative = cumulative;
      return {
        method: 'tempo',
        intent: 'session',
        status: 'success',
        timestamp: new Date().toISOString(),
        reference: channelId,
        challengeId: '',
        channelId,
        acceptedCumulative: cumulative,
        spent: cumulative,
        txHash: '0xfallback'
      };
    }
  });

  await Promise.all([
    client.fetchJson<{ ok: boolean }>('https://example.com/1'),
    client.fetchJson<{ ok: boolean }>('https://example.com/2'),
    client.fetchJson<{ ok: boolean }>('https://example.com/3')
  ]);

  assert.equal(client.paymentState.cumulative, '3000');
  assert.equal(client.paymentState.spent, '3000');
  assert.equal(client.paymentState.lastReceipt?.acceptedCumulative, '3000');

  const receipt = await client.close();
  assert.equal(fallbackCumulative, '3000');
  assert.equal(receipt?.acceptedCumulative, '3000');
});
