import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Challenge } from 'mppx';
import { Session as TempoProtocol } from 'mppx/tempo';
import { createPublicClient, createWalletClient, http, isAddressEqual } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { tempo as tempoChain } from 'viem/chains';
import { APP_NAME, CLI_NAME, OPENAI_MPP_CHAT_COMPLETIONS_PATH } from './config.js';
import {
  closeTempoChannelViaService,
  type TempoCloseContext,
  type TempoCloseChannelFallbackInput,
  type TempoSessionReceipt
} from './session/tempo.js';
import { resolveTempoPrivateKey } from './wallet.js';

const RECOVERY_FILE_VERSION = 1;
const RECOVERY_FILE_NAME = 'recovery.json';
const DEFAULT_CLOSE_REQUEST_GRACE_PERIOD_SECONDS = 900n;

type TempoRecoveryRequestKind = 'openai-chat-completions';

export interface TempoRecoveryEntry {
  channelId: `0x${string}`;
  cumulative: string;
  requestUrl: string;
  requestKind: TempoRecoveryRequestKind;
  payerAddress: `0x${string}`;
  chainId: number;
  escrowContract: `0x${string}`;
  feeToken?: `0x${string}` | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface TempoRecoveryStore {
  readonly filePath: string;
  list(): Promise<TempoRecoveryEntry[]>;
  upsert(entry: TempoRecoveryEntry): Promise<void>;
  remove(channelId: string): Promise<void>;
}

export interface TempoRecoveryProgressEvent {
  step: 'load' | 'close' | 'request-close' | 'withdraw';
  message: string;
  detail?: Record<string, unknown> | undefined;
}

type TempoRecoveryStatus =
  | 'closed'
  | 'close-requested'
  | 'awaiting-withdraw'
  | 'withdrawn'
  | 'already-finalized'
  | 'skipped-wallet-mismatch'
  | 'failed';

interface TempoRecoveryResult {
  channelId: string;
  cumulative: string;
  requestUrl: string;
  status: TempoRecoveryStatus;
  txHash?: string | undefined;
  unlockAt?: string | undefined;
  receipt?: TempoSessionReceipt | undefined;
  error?: string | undefined;
}

export interface TempoRecoveryReport {
  storePath: string;
  remainingChannels: number;
  results: TempoRecoveryResult[];
}

interface RecoveryFileShape {
  version: number;
  channels: TempoRecoveryEntry[];
}

interface TempoRecoveryChannelState {
  finalized: boolean;
  closeRequestedAt: bigint;
  deposit: bigint;
  settled: bigint;
}

interface TempoRecoveryRequestCloseResult {
  txHash: `0x${string}`;
  unlockAt: Date;
}

interface TempoRecoveryWithdrawResult {
  txHash: `0x${string}`;
}

export interface RecoverTempoSessionsOptions {
  store?: TempoRecoveryStore | undefined;
  privateKey?: string | undefined;
  signal?: AbortSignal | undefined;
  onProgress?: ((event: TempoRecoveryProgressEvent) => void) | undefined;
  closeViaService?: (input: TempoCloseChannelFallbackInput) => Promise<TempoSessionReceipt>;
  getChannelState?: (entry: TempoRecoveryEntry) => Promise<TempoRecoveryChannelState>;
  requestClose?: (
    entry: TempoRecoveryEntry,
    privateKey: `0x${string}`
  ) => Promise<TempoRecoveryRequestCloseResult>;
  withdraw?: (
    entry: TempoRecoveryEntry,
    privateKey: `0x${string}`
  ) => Promise<TempoRecoveryWithdrawResult>;
  now?: (() => Date) | undefined;
}

class FileTempoRecoveryStore implements TempoRecoveryStore {
  readonly filePath: string;

  constructor(filePath = getTempoRecoveryFilePath()) {
    this.filePath = filePath;
  }

  async list(): Promise<TempoRecoveryEntry[]> {
    let raw: string;

    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (isMissingFileError(error)) {
        return [];
      }
      throw error;
    }

    const parsed = JSON.parse(raw) as Partial<RecoveryFileShape>;
    if (parsed.version !== RECOVERY_FILE_VERSION || !Array.isArray(parsed.channels)) {
      throw new Error(
        `Invalid Tempo recovery state in ${this.filePath}. Remove or fix the file, then retry.`
      );
    }

    return parsed.channels.map(assertRecoveryEntry);
  }

  async upsert(entry: TempoRecoveryEntry): Promise<void> {
    const entries = await this.list();
    const index = entries.findIndex((candidate) => candidate.channelId === entry.channelId);
    if (index === -1) {
      entries.push(entry);
    } else {
      const existing = entries[index];
      entries[index] = {
        ...entry,
        createdAt: existing ? existing.createdAt : entry.createdAt
      };
    }

    await this.write(entries);
  }

  async remove(channelId: string): Promise<void> {
    const entries = await this.list();
    const nextEntries = entries.filter((entry) => entry.channelId !== channelId);
    if (nextEntries.length === entries.length) {
      return;
    }

    await this.write(nextEntries);
  }

  private async write(entries: TempoRecoveryEntry[]): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const payload = JSON.stringify(
      {
        version: RECOVERY_FILE_VERSION,
        channels: entries
      },
      null,
      2
    );
    await writeFile(tempPath, `${payload}\n`, 'utf8');
    await rename(tempPath, this.filePath);
  }
}

export function createTempoRecoveryStore(filePath?: string): TempoRecoveryStore {
  return new FileTempoRecoveryStore(filePath);
}

function getTempoRecoveryFilePath(): string {
  return path.join(os.homedir(), `.${APP_NAME}`, RECOVERY_FILE_NAME);
}

export async function recoverTempoSessions(
  options: RecoverTempoSessionsOptions = {}
): Promise<TempoRecoveryReport> {
  const store = options.store ?? createTempoRecoveryStore();
  const entries = await store.list();

  if (entries.length === 0) {
    return {
      storePath: store.filePath,
      remainingChannels: 0,
      results: []
    };
  }

  const privateKey = resolveTempoPrivateKey({ envPrivateKey: options.privateKey });
  if (!privateKey) {
    throw new Error(
      `No Tempo wallet found. Run \`${CLI_NAME} wallet init\` or set TEMPO_PRIVATE_KEY before recovery.`
    );
  }

  const closeViaService = options.closeViaService ?? recoverViaServiceClose;
  const getChannelState = options.getChannelState ?? readRecoveryChannelState;
  const requestClose = options.requestClose ?? requestCloseForRecovery;
  const withdraw = options.withdraw ?? withdrawRecoveryChannel;
  const now = options.now ?? (() => new Date());
  const account = privateKeyToAccount(privateKey);
  const results: TempoRecoveryResult[] = [];

  options.onProgress?.({
    step: 'load',
    message: `Loaded ${entries.length} recoverable Tempo session${entries.length === 1 ? '' : 's'}.`,
    detail: { count: entries.length, storePath: store.filePath }
  });

  for (const entry of entries) {
    options.signal?.throwIfAborted();

    if (!isAddressEqual(account.address, entry.payerAddress)) {
      results.push({
        channelId: entry.channelId,
        cumulative: entry.cumulative,
        requestUrl: entry.requestUrl,
        status: 'skipped-wallet-mismatch',
        error: `Recovery entry belongs to ${entry.payerAddress}, but the active wallet is ${account.address}.`
      });
      continue;
    }

    const result = await recoverEntry(entry, {
      store,
      privateKey,
      closeViaService,
      getChannelState,
      requestClose,
      withdraw,
      now,
      onProgress: options.onProgress
    });
    results.push(result);
  }

  return {
    storePath: store.filePath,
    remainingChannels: (await store.list()).length,
    results
  };
}

async function recoverEntry(
  entry: TempoRecoveryEntry,
  options: {
    store: TempoRecoveryStore;
    privateKey: `0x${string}`;
    closeViaService: (input: TempoCloseChannelFallbackInput) => Promise<TempoSessionReceipt>;
    getChannelState: (entry: TempoRecoveryEntry) => Promise<TempoRecoveryChannelState>;
    requestClose: (
      entry: TempoRecoveryEntry,
      privateKey: `0x${string}`
    ) => Promise<TempoRecoveryRequestCloseResult>;
    withdraw: (
      entry: TempoRecoveryEntry,
      privateKey: `0x${string}`
    ) => Promise<TempoRecoveryWithdrawResult>;
    now: () => Date;
    onProgress?: ((event: TempoRecoveryProgressEvent) => void) | undefined;
  }
): Promise<TempoRecoveryResult> {
  let channel = await options.getChannelState(entry);
  if (channel.finalized || channel.deposit === 0n) {
    await options.store.remove(entry.channelId);
    return {
      channelId: entry.channelId,
      cumulative: entry.cumulative,
      requestUrl: entry.requestUrl,
      status: 'already-finalized'
    };
  }

  if (channel.closeRequestedAt === 0n) {
    options.onProgress?.({
      step: 'close',
      message: `Attempting cooperative close for ${entry.channelId}.`,
      detail: { channelId: entry.channelId, cumulative: entry.cumulative }
    });

    try {
      const receipt = await options.closeViaService({
        ...(await buildRecoveryCloseInput(entry)),
        privateKey: options.privateKey
      });
      await options.store.remove(entry.channelId);
      return {
        channelId: entry.channelId,
        cumulative: entry.cumulative,
        requestUrl: entry.requestUrl,
        status: 'closed',
        txHash: receipt.txHash,
        receipt
      };
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);

      channel = await options.getChannelState(entry);
      if (channel.finalized || channel.deposit === 0n) {
        await options.store.remove(entry.channelId);
        return {
          channelId: entry.channelId,
          cumulative: entry.cumulative,
          requestUrl: entry.requestUrl,
          status: 'already-finalized'
        };
      }

      if (channel.closeRequestedAt === 0n) {
        options.onProgress?.({
          step: 'request-close',
          message: `Requesting forced close for ${entry.channelId}.`,
          detail: { channelId: entry.channelId }
        });

        try {
          const requested = await options.requestClose(entry, options.privateKey);
          return {
            channelId: entry.channelId,
            cumulative: entry.cumulative,
            requestUrl: entry.requestUrl,
            status: 'close-requested',
            txHash: requested.txHash,
            unlockAt: requested.unlockAt.toISOString(),
            error: `Cooperative close failed: ${details}`
          };
        } catch (requestCloseError) {
          return {
            channelId: entry.channelId,
            cumulative: entry.cumulative,
            requestUrl: entry.requestUrl,
            status: 'failed',
            error:
              `Cooperative close failed: ${details}. ` +
              `Forced close also failed: ${requestCloseError instanceof Error ? requestCloseError.message : String(requestCloseError)}`
          };
        }
      }
    }
  }

  const unlockAt = await getUnlockAt(entry, channel.closeRequestedAt, options.now);
  if (unlockAt.getTime() > options.now().getTime()) {
    return {
      channelId: entry.channelId,
      cumulative: entry.cumulative,
      requestUrl: entry.requestUrl,
      status: 'awaiting-withdraw',
      unlockAt: unlockAt.toISOString()
    };
  }

  options.onProgress?.({
    step: 'withdraw',
    message: `Withdrawing forced-close refund for ${entry.channelId}.`,
    detail: { channelId: entry.channelId }
  });

  try {
    const withdrawn = await options.withdraw(entry, options.privateKey);
    await options.store.remove(entry.channelId);
    return {
      channelId: entry.channelId,
      cumulative: entry.cumulative,
      requestUrl: entry.requestUrl,
      status: 'withdrawn',
      txHash: withdrawn.txHash
    };
  } catch (error) {
    return {
      channelId: entry.channelId,
      cumulative: entry.cumulative,
      requestUrl: entry.requestUrl,
      status: 'failed',
      unlockAt: unlockAt.toISOString(),
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function buildRecoveryCloseInput(
  entry: TempoRecoveryEntry
): Promise<Omit<TempoCloseChannelFallbackInput, 'privateKey'>> {
  const probe = buildRecoveryProbeRequest(entry);
  const challengeResponse = await fetch(entry.requestUrl, probe);
  const header = challengeResponse.headers.get('www-authenticate');

  if (challengeResponse.status !== 402 || !header) {
    const text = await challengeResponse.text().catch(() => '');
    throw new Error(
      `Expected a 402 challenge from ${entry.requestUrl}, got ${challengeResponse.status}${text ? `: ${text}` : ''}`
    );
  }

  const challenge = Challenge.deserialize(header);
  const context: TempoCloseContext = {
    chainId: entry.chainId,
    escrowContract: entry.escrowContract,
    feeToken: entry.feeToken
  };

  return {
    channelId: entry.channelId,
    cumulative: entry.cumulative,
    context,
    challenge,
    requestUrl: entry.requestUrl,
    requestInit: probe
  };
}

function buildRecoveryProbeRequest(entry: TempoRecoveryEntry): RequestInit {
  if (entry.requestKind !== 'openai-chat-completions') {
    throw new Error(`Unsupported recovery request kind: ${entry.requestKind}`);
  }

  const requestUrl = new URL(entry.requestUrl);
  if (requestUrl.pathname !== OPENAI_MPP_CHAT_COMPLETIONS_PATH) {
    throw new Error(`Unsupported recovery endpoint: ${entry.requestUrl}`);
  }

  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'close session' }],
      max_tokens: 1,
      temperature: 0,
      stream: false
    })
  };
}

async function recoverViaServiceClose(
  input: TempoCloseChannelFallbackInput
): Promise<TempoSessionReceipt> {
  return closeTempoChannelViaService(input);
}

async function readRecoveryChannelState(
  entry: TempoRecoveryEntry
): Promise<TempoRecoveryChannelState> {
  const client = createPublicClient({
    chain: createTempoChain(entry.feeToken),
    transport: http(tempoChain.rpcUrls.default.http[0])
  });
  const channel = await readEscrowChannel(client, entry);

  return {
    finalized: channel.finalized,
    closeRequestedAt: channel.closeRequestedAt,
    deposit: channel.deposit,
    settled: channel.settled
  };
}

async function requestCloseForRecovery(
  entry: TempoRecoveryEntry,
  privateKey: `0x${string}`
): Promise<TempoRecoveryRequestCloseResult> {
  const { walletClient, publicClient } = createTempoClients(privateKey, entry.feeToken);
  const txHash = await walletClient.writeContract({
    account: walletClient.account!,
    chain: walletClient.chain,
    address: entry.escrowContract,
    abi: TempoProtocol.Chain.escrowAbi,
    functionName: 'requestClose',
    args: [entry.channelId]
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });
  const channel = await readEscrowChannel(publicClient, entry);
  const gracePeriodSeconds = await readCloseRequestGracePeriod(publicClient, entry.escrowContract);
  const unlockAt = new Date(Number((channel.closeRequestedAt + gracePeriodSeconds) * 1000n));

  return { txHash, unlockAt };
}

async function withdrawRecoveryChannel(
  entry: TempoRecoveryEntry,
  privateKey: `0x${string}`
): Promise<TempoRecoveryWithdrawResult> {
  const { walletClient, publicClient } = createTempoClients(privateKey, entry.feeToken);
  const txHash = await walletClient.writeContract({
    account: walletClient.account!,
    chain: walletClient.chain,
    address: entry.escrowContract,
    abi: TempoProtocol.Chain.escrowAbi,
    functionName: 'withdraw',
    args: [entry.channelId]
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });
  return { txHash };
}

async function getUnlockAt(
  entry: TempoRecoveryEntry,
  closeRequestedAt: bigint,
  now: () => Date
): Promise<Date> {
  if (closeRequestedAt === 0n) {
    return now();
  }

  const client = createPublicClient({
    chain: createTempoChain(entry.feeToken),
    transport: http(tempoChain.rpcUrls.default.http[0])
  });
  const gracePeriodSeconds = await readCloseRequestGracePeriod(client, entry.escrowContract);
  return new Date(Number((closeRequestedAt + gracePeriodSeconds) * 1000n));
}

async function readCloseRequestGracePeriod(
  publicClient: unknown,
  escrowContract: `0x${string}`
): Promise<bigint> {
  const client = publicClient as {
    readContract(parameters: {
      address: `0x${string}`;
      abi: readonly unknown[];
      functionName: string;
      args?: readonly unknown[] | undefined;
    }): Promise<unknown>;
  };

  try {
    return (await client.readContract({
      address: escrowContract,
      abi: [
        {
          type: 'function',
          name: 'closeRequestGracePeriod',
          stateMutability: 'view',
          inputs: [],
          outputs: [{ type: 'uint256' }]
        }
      ],
      functionName: 'closeRequestGracePeriod'
    })) as bigint;
  } catch {
    return DEFAULT_CLOSE_REQUEST_GRACE_PERIOD_SECONDS;
  }
}

async function readEscrowChannel(
  publicClient: unknown,
  entry: TempoRecoveryEntry
): Promise<TempoRecoveryChannelState> {
  const client = publicClient as {
    readContract(parameters: {
      address: `0x${string}`;
      abi: typeof TempoProtocol.Chain.escrowAbi;
      functionName: 'getChannel';
      args: readonly [`0x${string}`];
    }): Promise<unknown>;
  };

  const channel = (await client.readContract({
    address: entry.escrowContract,
    abi: TempoProtocol.Chain.escrowAbi,
    functionName: 'getChannel',
    args: [entry.channelId]
  })) as {
    finalized: boolean;
    closeRequestedAt: bigint;
    deposit: bigint;
    settled: bigint;
  };

  return {
    finalized: channel.finalized,
    closeRequestedAt: channel.closeRequestedAt,
    deposit: channel.deposit,
    settled: channel.settled
  };
}

function createTempoChain(feeToken?: `0x${string}` | undefined) {
  return {
    ...tempoChain,
    ...(feeToken ? { feeToken } : {})
  };
}

function createTempoClients(privateKey: `0x${string}`, feeToken?: `0x${string}` | undefined) {
  const account = privateKeyToAccount(privateKey);
  const chain = createTempoChain(feeToken);
  const transport = http(tempoChain.rpcUrls.default.http[0]);

  return {
    walletClient: createWalletClient({
      account,
      chain,
      transport
    }),
    publicClient: createPublicClient({
      chain,
      transport
    })
  };
}

function assertRecoveryEntry(entry: unknown): TempoRecoveryEntry {
  if (!entry || typeof entry !== 'object') {
    throw new Error('Invalid Tempo recovery entry.');
  }

  const record = entry as Record<string, unknown>;
  if (
    typeof record.channelId !== 'string' ||
    typeof record.cumulative !== 'string' ||
    typeof record.requestUrl !== 'string' ||
    record.requestKind !== 'openai-chat-completions' ||
    typeof record.payerAddress !== 'string' ||
    typeof record.chainId !== 'number' ||
    typeof record.escrowContract !== 'string' ||
    typeof record.createdAt !== 'string' ||
    typeof record.updatedAt !== 'string'
  ) {
    throw new Error('Invalid Tempo recovery entry.');
  }

  return {
    channelId: record.channelId as `0x${string}`,
    cumulative: record.cumulative,
    requestUrl: record.requestUrl,
    requestKind: 'openai-chat-completions',
    payerAddress: record.payerAddress as `0x${string}`,
    chainId: record.chainId,
    escrowContract: record.escrowContract as `0x${string}`,
    feeToken: typeof record.feeToken === 'string' ? record.feeToken as `0x${string}` : undefined,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'ENOENT';
}
