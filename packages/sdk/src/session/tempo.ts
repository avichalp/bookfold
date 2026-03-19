import { Credential } from 'mppx';
import { tempo as mppxTempo } from 'mppx/client';
import { Session as TempoProtocol } from 'mppx/tempo';
import { createWalletClient, http } from 'viem';
import { tempo as tempoChain } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { REQUEST_TIMEOUT_MS, TEMPO_MAX_DEPOSIT } from '../config.js';
import type { TempoRecoveryEntry, TempoRecoveryStore } from '../recovery.js';
import { resolveTempoPrivateKey } from '../wallet.js';

export interface TempoSessionReceipt {
  method: 'tempo';
  intent: 'session';
  status: 'success';
  timestamp: string;
  reference: string;
  challengeId: string;
  channelId: string;
  acceptedCumulative: string;
  spent: string;
  units?: number | undefined;
  txHash?: string | undefined;
}

export interface TempoSessionState {
  cumulative: string;
  spent: string;
  channelId?: string | undefined;
  lastReceipt?: TempoSessionReceipt | undefined;
  finalReceipt?: TempoSessionReceipt | undefined;
  closeError?: string | undefined;
  requestCount: number;
}

export interface TempoSessionClientOptions {
  privateKey?: string | undefined;
  maxDeposit?: string | undefined;
  sessionManager?: TempoSessionManager | undefined;
  closeChannelFallback?: TempoCloseChannelFallback | undefined;
  recoveryStore?: TempoRecoveryStore | undefined;
}

interface TempoSessionResponse extends Response {
  receipt?: unknown;
  channelId?: string | null;
  cumulative?: bigint;
  challenge?: unknown;
}

interface TempoSessionManager {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<TempoSessionResponse>;
  close(): Promise<unknown>;
  readonly channelId: string | null | undefined;
}

export interface TempoCloseContext {
  chainId: number;
  escrowContract: `0x${string}`;
  feeToken?: `0x${string}` | undefined;
}

export interface TempoCloseChannelFallbackInput {
  channelId: `0x${string}`;
  cumulative: string;
  privateKey: `0x${string}`;
  context: TempoCloseContext;
  challenge: unknown;
  requestUrl: string;
  requestInit?: RequestInit | undefined;
}

type TempoCloseChannelFallback = (
  input: TempoCloseChannelFallbackInput
) => Promise<TempoSessionReceipt>;

export class TempoSessionClient {
  private readonly manager: TempoSessionManager;

  private readonly maxDeposit: string;

  private readonly privateKey: `0x${string}`;

  private readonly payerAddress: `0x${string}`;

  private readonly closeChannelFallback: TempoCloseChannelFallback;

  private readonly recoveryStore?: TempoRecoveryStore | undefined;

  private firstRequestBarrier?: Promise<void> | undefined;

  private closeContext?: TempoCloseContext | undefined;

  private lastChallenge?: unknown;

  private lastRequestUrl?: string | undefined;

  private lastRequestInit?: RequestInit | undefined;

  private readonly state: TempoSessionState = {
    cumulative: '0',
    spent: '0',
    requestCount: 0
  };

  constructor(options: TempoSessionClientOptions = {}) {
    const privateKey = resolveTempoPrivateKey({ envPrivateKey: options.privateKey });

    if (!privateKey) {
      throw new Error(
        'No Tempo wallet found. Run `summ-tempo wallet init` or set TEMPO_PRIVATE_KEY.'
      );
    }

    const account = privateKeyToAccount(privateKey);
    this.privateKey = privateKey;
    this.payerAddress = account.address;
    this.maxDeposit = options.maxDeposit ?? TEMPO_MAX_DEPOSIT;
    this.closeChannelFallback = options.closeChannelFallback ?? closeTempoChannelViaService;
    this.recoveryStore = options.recoveryStore;
    this.manager =
      options.sessionManager ??
      mppxTempo.session({
        account,
        maxDeposit: this.maxDeposit
      });
  }

  get paymentState(): TempoSessionState {
    return {
      cumulative: this.state.cumulative,
      spent: this.state.spent,
      channelId: this.state.channelId,
      lastReceipt: this.state.lastReceipt,
      finalReceipt: this.state.finalReceipt,
      closeError: this.state.closeError,
      requestCount: this.state.requestCount
    };
  }

  get depositLimit(): string {
    return this.maxDeposit;
  }

  async fetchJson<T>(input: RequestInfo | URL, init: RequestInit = {}): Promise<{
    data: T;
    receipt?: TempoSessionReceipt | undefined;
    cumulative: string;
    channelId?: string | undefined;
  }> {
    const signal = init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
      : AbortSignal.timeout(REQUEST_TIMEOUT_MS);

    if (!this.state.channelId && this.state.requestCount === 0) {
      return this.fetchJsonWithFirstRequestLock<T>(input, init, signal);
    }

    return this.performFetchJson<T>(input, init, signal);
  }

  async close(): Promise<TempoSessionReceipt | undefined> {
    try {
      const receipt = coerceReceipt(await this.manager.close());
      if (receipt) {
        this.applyReceipt(receipt);
        await this.clearRecoveryEntry();
        return receipt;
      }

      if (this.state.channelId) {
        const fallbackReceipt = await this.closeWithFallback();
        if (fallbackReceipt) {
          this.applyReceipt(fallbackReceipt);
          await this.clearRecoveryEntry();
          return fallbackReceipt;
        }
      }

      return undefined;
    } catch (error) {
      const message = normalizeSessionError(error, 'Failed to close Tempo session');
      this.state.closeError = message;
      throw new Error(message);
    }
  }

  private async fetchJsonWithFirstRequestLock<T>(
    input: RequestInfo | URL,
    init: RequestInit,
    signal: AbortSignal
  ): Promise<{
    data: T;
    receipt?: TempoSessionReceipt | undefined;
    cumulative: string;
    channelId?: string | undefined;
  }> {
    if (!this.firstRequestBarrier) {
      let resolveBarrier: (() => void) | undefined;
      let rejectBarrier: ((reason?: unknown) => void) | undefined;
      this.firstRequestBarrier = new Promise<void>((resolve, reject) => {
        resolveBarrier = resolve;
        rejectBarrier = reject;
      });

      try {
        const result = await this.performFetchJson<T>(input, init, signal);
        resolveBarrier?.();
        return result;
      } catch (error) {
        rejectBarrier?.(error);
        throw error;
      } finally {
        this.firstRequestBarrier = undefined;
      }
    }

    try {
      await this.firstRequestBarrier;
    } catch {
      // A failed leader request leaves the session unopened. Retry as the next leader.
    }

    if (!this.state.channelId && this.state.requestCount === 0) {
      return this.fetchJsonWithFirstRequestLock<T>(input, init, signal);
    }

    return this.performFetchJson<T>(input, init, signal);
  }

  private async performFetchJson<T>(
    input: RequestInfo | URL,
    init: RequestInit,
    signal: AbortSignal
  ): Promise<{
    data: T;
    receipt?: TempoSessionReceipt | undefined;
    cumulative: string;
    channelId?: string | undefined;
  }> {
    let response: TempoSessionResponse;

    try {
      response = await this.manager.fetch(input, { ...init, signal });
    } catch (error) {
      throw new Error(normalizeSessionError(error));
    }

    this.lastRequestUrl = resolveRequestUrl(input);
    this.lastRequestInit = cloneRequestInit(init);
    const receipt = coerceReceipt(response.receipt);
    const channelId = typeof response.channelId === 'string' ? response.channelId : this.manager.channelId;
    const cumulative = typeof response.cumulative === 'bigint'
      ? response.cumulative.toString()
      : this.state.cumulative;

    this.captureCloseContext(response.challenge);

    this.state.requestCount += 1;
    this.state.cumulative = cumulative;
    this.state.channelId = channelId ?? undefined;
    if (receipt) {
      this.state.lastReceipt = receipt;
      this.state.spent = receipt.spent;
    }

    await this.persistRecoveryEntry();

    if (!response.ok) {
      const details = await readErrorResponse(response);
      throw new Error(`OpenAI MPP request failed (${response.status}): ${details}`);
    }

    const data = await response.json() as T;
    return {
      data,
      receipt,
      cumulative: this.state.cumulative,
      channelId: this.state.channelId
    };
  }

  private applyReceipt(receipt: TempoSessionReceipt): void {
    this.state.finalReceipt = receipt;
    this.state.lastReceipt = receipt;
    this.state.channelId = receipt.channelId;
    this.state.cumulative = receipt.acceptedCumulative;
    this.state.spent = receipt.spent;
    this.state.closeError = undefined;
  }

  private captureCloseContext(challenge: unknown): void {
    if (!challenge || typeof challenge !== 'object') {
      return;
    }

    this.lastChallenge = challenge;

    const request = (challenge as { request?: unknown }).request;
    if (!request || typeof request !== 'object') {
      return;
    }

    const methodDetails = (request as { methodDetails?: unknown }).methodDetails;
    if (!methodDetails || typeof methodDetails !== 'object') {
      return;
    }

    const chainId = (methodDetails as { chainId?: unknown }).chainId;
    const escrowContract = (methodDetails as { escrowContract?: unknown }).escrowContract;
    const feeToken = (request as { currency?: unknown }).currency;

    if (typeof chainId !== 'number' || typeof escrowContract !== 'string') {
      return;
    }

    this.closeContext = {
      chainId,
      escrowContract: escrowContract as `0x${string}`,
      feeToken: typeof feeToken === 'string' ? feeToken as `0x${string}` : undefined
    };
  }

  private async closeWithFallback(): Promise<TempoSessionReceipt | undefined> {
    if (!this.state.channelId) {
      return undefined;
    }

    if (!this.closeContext || !this.lastChallenge || !this.lastRequestUrl) {
      this.state.closeError =
        `Tempo session close returned no final receipt for channel ${this.state.channelId}. ` +
        'Funds may remain locked until you run `summ-tempo recover`.';
      return undefined;
    }

    try {
      return await this.closeChannelFallback({
        channelId: this.state.channelId as `0x${string}`,
        cumulative: resolveCloseCumulative(this.state),
        privateKey: this.privateKey,
        context: this.closeContext,
        challenge: this.lastChallenge,
        requestUrl: this.lastRequestUrl,
        requestInit: this.lastRequestInit
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.state.closeError =
        `Tempo session close returned no final receipt for channel ${this.state.channelId}. ` +
        `Manual close fallback failed: ${message}`;
      return undefined;
    }
  }

  private async persistRecoveryEntry(): Promise<void> {
    const entry = this.buildRecoveryEntry();
    if (!entry || !this.recoveryStore) {
      return;
    }

    try {
      await this.recoveryStore.upsert(entry);
    } catch {
      // Recovery metadata is best-effort. Failed writes should not break the paid request itself.
    }
  }

  private async clearRecoveryEntry(): Promise<void> {
    if (!this.recoveryStore || !this.state.channelId) {
      return;
    }

    try {
      await this.recoveryStore.remove(this.state.channelId);
    } catch {
      // Best-effort cleanup only.
    }
  }

  private buildRecoveryEntry(): TempoRecoveryEntry | undefined {
    if (
      !this.recoveryStore ||
      !this.state.channelId ||
      !this.closeContext ||
      !this.lastRequestUrl
    ) {
      return undefined;
    }

    const requestKind = resolveRecoveryRequestKind(this.lastRequestUrl);
    if (!requestKind) {
      return undefined;
    }

    const timestamp = new Date().toISOString();
    return {
      channelId: this.state.channelId as `0x${string}`,
      cumulative: resolveCloseCumulative(this.state),
      requestUrl: this.lastRequestUrl,
      requestKind,
      payerAddress: this.payerAddress,
      chainId: this.closeContext.chainId,
      escrowContract: this.closeContext.escrowContract,
      feeToken: this.closeContext.feeToken,
      createdAt: timestamp,
      updatedAt: timestamp
    };
  }
}

function coerceReceipt(receipt: unknown): TempoSessionReceipt | undefined {
  if (!receipt || typeof receipt !== 'object') {
    return undefined;
  }

  const record = receipt as Record<string, unknown>;
  if (
    record.method === 'tempo' &&
    record.intent === 'session' &&
    typeof record.channelId === 'string' &&
    typeof record.acceptedCumulative === 'string' &&
    typeof record.spent === 'string'
  ) {
    return {
      method: 'tempo',
      intent: 'session',
      status: record.status === 'success' ? 'success' : 'success',
      timestamp: typeof record.timestamp === 'string' ? record.timestamp : new Date().toISOString(),
      reference: typeof record.reference === 'string' ? record.reference : record.channelId,
      challengeId: typeof record.challengeId === 'string' ? record.challengeId : '',
      channelId: record.channelId,
      acceptedCumulative: record.acceptedCumulative,
      spent: record.spent,
      units: typeof record.units === 'number' ? record.units : undefined,
      txHash: typeof record.txHash === 'string' ? record.txHash : undefined
    };
  }

  return undefined;
}

function resolveCloseCumulative(state: TempoSessionState): string {
  const acceptedCumulative = state.lastReceipt?.acceptedCumulative;
  if (acceptedCumulative && BigInt(acceptedCumulative) > 0n) {
    return acceptedCumulative;
  }

  return state.cumulative;
}

function resolveRecoveryRequestKind(requestUrl: string): 'openai-chat-completions' | undefined {
  const url = new URL(requestUrl);
  return url.pathname === '/v1/chat/completions' ? 'openai-chat-completions' : undefined;
}

function resolveRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }

  if (input instanceof URL) {
    return input.toString();
  }

  return input.url;
}

function cloneRequestInit(init: RequestInit): RequestInit {
  const cloned: RequestInit = { ...init };
  if (init.headers) {
    cloned.headers = new Headers(init.headers);
  }
  if ('signal' in cloned) {
    delete (cloned as { signal?: AbortSignal | undefined }).signal;
  }
  return cloned;
}

export async function closeTempoChannelViaService(
  input: TempoCloseChannelFallbackInput
): Promise<TempoSessionReceipt> {
  if (input.context.chainId !== tempoChain.id) {
    throw new Error(`Unsupported Tempo chain ${input.context.chainId}. Expected ${tempoChain.id}.`);
  }

  const account = privateKeyToAccount(input.privateKey);
  const chain = {
    ...tempoChain,
    ...(input.context.feeToken ? { feeToken: input.context.feeToken } : {})
  };
  const rpcUrl = chain.rpcUrls.default.http[0];
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(rpcUrl)
  });
  const cumulativeAmount = BigInt(input.cumulative);
  const signature = await TempoProtocol.Voucher.signVoucher(
    walletClient as never,
    account,
    {
      channelId: input.channelId,
      cumulativeAmount
    },
    input.context.escrowContract,
    input.context.chainId
  );
  const authorization = Credential.serialize({
    challenge: input.challenge as never,
    payload: {
      action: 'close',
      channelId: input.channelId,
      cumulativeAmount: input.cumulative,
      signature
    },
    source: `did:pkh:eip155:${input.context.chainId}:${account.address}`
  });
  const headers = new Headers(input.requestInit?.headers);
  headers.set('Authorization', authorization);
  const closeInit: RequestInit = {
    ...input.requestInit,
    method: input.requestInit?.method ?? 'POST',
    headers
  };
  if ('signal' in closeInit) {
    delete (closeInit as { signal?: AbortSignal | undefined }).signal;
  }
  const response = await fetch(input.requestUrl, closeInit);
  if (!response.ok) {
    const details = await readErrorResponse(response);
    throw new Error(`Service close request failed (${response.status}): ${details}`);
  }

  const receiptHeader = response.headers.get('Payment-Receipt');
  if (!receiptHeader) {
    throw new Error('Service close request succeeded without a Payment-Receipt header.');
  }

  const receipt = TempoProtocol.Receipt.deserializeSessionReceipt(receiptHeader);
  const coerced = coerceReceipt(receipt);
  if (!coerced) {
    throw new Error('Service close request returned an invalid Payment-Receipt header.');
  }

  if (coerced.txHash && coerced.spent === '0' && BigInt(coerced.acceptedCumulative) > 0n) {
    return {
      ...coerced,
      spent: coerced.acceptedCumulative
    };
  }

  return coerced;
}

async function readErrorResponse(response: Response): Promise<string> {
  const contentType = response.headers.get('content-type') ?? '';

  try {
    if (contentType.includes('application/json')) {
      const payload = await response.json() as Record<string, unknown>;
      const message =
        typeof payload.detail === 'string'
          ? payload.detail
          : typeof payload.error === 'string'
            ? payload.error
            : typeof payload.message === 'string'
              ? payload.message
              : JSON.stringify(payload);
      return message;
    }

    const text = (await response.text()).trim();
    return text || response.statusText || 'Unknown upstream error';
  } catch {
    return response.statusText || 'Unknown upstream error';
  }
}

function normalizeSessionError(error: unknown, prefix = 'Tempo session request failed'): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${prefix}: ${message}`;
}
