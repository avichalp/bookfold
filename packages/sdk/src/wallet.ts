import * as childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { APP_NAME } from './config.js';

const APP_SERVICE_NAME = APP_NAME;
const APP_ACCOUNT_NAME = 'default';
const MPPX_SERVICE_NAME = 'mppx';

export type TempoWalletSource = 'env' | 'app' | 'mppx';

export interface TempoWalletInfo {
  address: `0x${string}`;
  source: TempoWalletSource;
  accountName: string;
  serviceName: string;
}

export class InvalidTempoWalletError extends Error {
  readonly source: Exclude<TempoWalletSource, 'env'>;

  constructor(source: Exclude<TempoWalletSource, 'env'>) {
    super(
      source === 'app'
        ? 'Stored Bookfold wallet is invalid. Run `bookfold wallet init --force` to replace it.'
        : 'Stored mppx default account wallet is invalid. Update the mppx default account or set TEMPO_PRIVATE_KEY.'
    );
    this.name = 'InvalidTempoWalletError';
    this.source = source;
  }
}

interface SecretStore {
  get(serviceName: string, accountName: string): string | undefined;
  set(serviceName: string, accountName: string, secret: string): void;
  delete(serviceName: string, accountName: string): void;
}

interface WalletRuntime {
  execFileSync: typeof childProcess.execFileSync;
  homedir: typeof os.homedir;
  platform: typeof os.platform;
  readFileSync: typeof fs.readFileSync;
}

declare global {
  var __BOOKFOLD_WALLET_RUNTIME_FOR_TESTS__: Partial<WalletRuntime> | undefined;
}

const defaultWalletRuntime: WalletRuntime = {
  execFileSync: childProcess.execFileSync,
  homedir: os.homedir,
  platform: os.platform,
  readFileSync: fs.readFileSync
};

function getWalletRuntime(): WalletRuntime {
  return {
    ...defaultWalletRuntime,
    ...(globalThis.__BOOKFOLD_WALLET_RUNTIME_FOR_TESTS__ ?? {})
  };
}

export function resolveTempoWallet(): TempoWalletInfo | undefined {
  const store = createSystemSecretStore();
  const envPrivateKey = normalizePrivateKey(process.env.TEMPO_PRIVATE_KEY, {
    allowEmpty: true
  });

  if (envPrivateKey) {
    return {
      address: privateKeyToAccount(envPrivateKey).address,
      source: 'env',
      accountName: 'TEMPO_PRIVATE_KEY',
      serviceName: 'env'
    };
  }

  const appKey = store.get(APP_SERVICE_NAME, APP_ACCOUNT_NAME);
  if (appKey) {
    const privateKey = normalizeStoredPrivateKey(appKey, 'app');
    if (!privateKey) {
      return undefined;
    }
    return {
      address: privateKeyToAccount(privateKey).address,
      source: 'app',
      accountName: APP_ACCOUNT_NAME,
      serviceName: APP_SERVICE_NAME
    };
  }

  const mppxAccountName = resolveMppxDefaultAccountName();
  const mppxKey = store.get(MPPX_SERVICE_NAME, mppxAccountName);
  if (mppxKey) {
    const privateKey = normalizeStoredPrivateKey(mppxKey, 'mppx');
    if (!privateKey) {
      return undefined;
    }
    return {
      address: privateKeyToAccount(privateKey).address,
      source: 'mppx',
      accountName: mppxAccountName,
      serviceName: MPPX_SERVICE_NAME
    };
  }

  return undefined;
}

export function resolveTempoPrivateKey(): `0x${string}` | undefined {
  const store = createSystemSecretStore();
  const envPrivateKey = normalizePrivateKey(process.env.TEMPO_PRIVATE_KEY, {
    allowEmpty: true
  });

  if (envPrivateKey) {
    return envPrivateKey;
  }

  const appKey = store.get(APP_SERVICE_NAME, APP_ACCOUNT_NAME);
  if (appKey) {
    const privateKey = normalizeStoredPrivateKey(appKey, 'app');
    if (privateKey) {
      return privateKey;
    }
  }

  const mppxAccountName = resolveMppxDefaultAccountName();
  const mppxKey = store.get(MPPX_SERVICE_NAME, mppxAccountName);
  if (mppxKey) {
    const privateKey = normalizeStoredPrivateKey(mppxKey, 'mppx');
    if (privateKey) {
      return privateKey;
    }
  }

  return undefined;
}

export function createTempoWallet(options: {
  overwrite?: boolean | undefined;
} = {}): TempoWalletInfo {
  const store = createSystemSecretStore();
  const existing = store.get(APP_SERVICE_NAME, APP_ACCOUNT_NAME);
  if (existing && !options.overwrite) {
    try {
      const privateKey = normalizeStoredPrivateKey(existing, 'app');
      if (!privateKey) {
        throw new Error('Stored wallet is invalid.');
      }
      return {
        address: privateKeyToAccount(privateKey).address,
        source: 'app',
        accountName: APP_ACCOUNT_NAME,
        serviceName: APP_SERVICE_NAME
      };
    } catch (error) {
      if (!(error instanceof InvalidTempoWalletError)) {
        throw error;
      }
    }
  }

  const privateKey = generatePrivateKey();

  if (!privateKey) {
    throw new Error('Missing Tempo private key.');
  }

  store.set(APP_SERVICE_NAME, APP_ACCOUNT_NAME, privateKey);

  return {
    address: privateKeyToAccount(privateKey).address,
    source: 'app',
    accountName: APP_ACCOUNT_NAME,
    serviceName: APP_SERVICE_NAME
  };
}

function createSystemSecretStore(): SecretStore {
  const walletRuntime = getWalletRuntime();
  const platform = walletRuntime.platform();
  const execFileSync = walletRuntime.execFileSync;

  if (platform === 'darwin') {
    return {
      get(serviceName, accountName) {
        try {
          return execFileSync(
            'security',
            ['find-generic-password', '-s', serviceName, '-a', accountName, '-w'],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
          ).trim() || undefined;
        } catch {
          return undefined;
        }
      },
      set(serviceName, accountName, secret) {
        // `security add-generic-password ... -w` prompts on the TTY when the
        // password is omitted, so feed the command through interactive mode
        // instead of relying on stdin for prompt responses.
        execFileSync(
          'security',
          ['-i', '-q'],
          {
            input: buildMacosAddPasswordCommand(serviceName, accountName, secret),
            stdio: ['pipe', 'ignore', 'ignore'],
            encoding: 'utf8'
          }
        );
      },
      delete(serviceName, accountName) {
        try {
          execFileSync(
            'security',
            ['delete-generic-password', '-s', serviceName, '-a', accountName],
            { stdio: 'ignore' }
          );
        } catch {}
      }
    };
  }

  if (platform === 'linux') {
    return {
      get(serviceName, accountName) {
        try {
          return execFileSync(
            'secret-tool',
            ['lookup', 'service', serviceName, 'account', accountName],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
          ).trim() || undefined;
        } catch {
          return undefined;
        }
      },
      set(serviceName, accountName, secret) {
        execFileSync(
          'secret-tool',
          ['store', '--label', `${serviceName} ${accountName}`, 'service', serviceName, 'account', accountName],
          { input: secret, stdio: ['pipe', 'ignore', 'ignore'], encoding: 'utf8' }
        );
      },
      delete(serviceName, accountName) {
        try {
          execFileSync(
            'secret-tool',
            ['clear', 'service', serviceName, 'account', accountName],
            { stdio: 'ignore' }
          );
        } catch {}
      }
    };
  }

  throw new Error(
    `Unsupported platform "${platform}" for secure wallet storage. Use TEMPO_PRIVATE_KEY instead.`
  );
}

function buildMacosAddPasswordCommand(
  serviceName: string,
  accountName: string,
  secret: string
): string {
  return `add-generic-password -a ${quoteMacosSecurityArgument(accountName)} -s ${quoteMacosSecurityArgument(serviceName)} -U -w ${quoteMacosSecurityArgument(secret)}\n`;
}

function quoteMacosSecurityArgument(value: string): string {
  if (value.length === 0) {
    return "''";
  }

  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function normalizePrivateKey(
  value: string | undefined,
  options: { allowEmpty?: boolean | undefined } = {}
): `0x${string}` | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    if (options.allowEmpty) {
      return undefined;
    }
    throw new Error('Missing Tempo private key.');
  }

  const normalized = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error('Tempo private key must be a 32-byte hex private key.');
  }

  return normalized as `0x${string}`;
}

function normalizeStoredPrivateKey(
  value: string | undefined,
  source: Exclude<TempoWalletSource, 'env'>
): `0x${string}` | undefined {
  try {
    return normalizePrivateKey(value, { allowEmpty: true });
  } catch (error) {
    if (error instanceof Error && error.message === 'Tempo private key must be a 32-byte hex private key.') {
      throw new InvalidTempoWalletError(source);
    }

    throw error;
  }
}

export function formatWalletFundingMessage(address: string): string {
  return [
    `Wallet address: ${address}`,
    'Fund this address on Tempo Mainnet (chain id 4217) with a USD-denominated Tempo fee token before summarizing paid requests.'
  ].join('\n');
}

function resolveMppxDefaultAccountName(): string {
  try {
    const walletRuntime = getWalletRuntime();
    const configPath = path.join(
      process.env.XDG_CONFIG_HOME || path.join(walletRuntime.homedir(), '.config'),
      'mppx',
      'default'
    );
    return walletRuntime.readFileSync(configPath, 'utf8').trim() || 'main';
  } catch {
    return 'main';
  }
}
