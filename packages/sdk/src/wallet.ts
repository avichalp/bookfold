import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const APP_SERVICE_NAME = 'summ-tempo';
const APP_ACCOUNT_NAME = 'default';
const MPPX_SERVICE_NAME = 'mppx';

export type TempoWalletSource = 'env' | 'summ-tempo' | 'mppx';

export interface TempoWalletInfo {
  address: `0x${string}`;
  source: TempoWalletSource;
  accountName: string;
  serviceName: string;
}

export interface SecretStore {
  get(serviceName: string, accountName: string): string | undefined;
  set(serviceName: string, accountName: string, secret: string): void;
  delete(serviceName: string, accountName: string): void;
}

export function resolveTempoWallet(options: {
  envPrivateKey?: string | undefined;
  store?: SecretStore | undefined;
} = {}): TempoWalletInfo | undefined {
  const store = options.store ?? createSystemSecretStore();
  const envPrivateKey = normalizePrivateKey(options.envPrivateKey ?? process.env.TEMPO_PRIVATE_KEY, {
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
    const privateKey = normalizePrivateKey(appKey);
    if (!privateKey) {
      return undefined;
    }
    return {
      address: privateKeyToAccount(privateKey).address,
      source: 'summ-tempo',
      accountName: APP_ACCOUNT_NAME,
      serviceName: APP_SERVICE_NAME
    };
  }

  const mppxAccountName = resolveMppxDefaultAccountName();
  const mppxKey = store.get(MPPX_SERVICE_NAME, mppxAccountName);
  if (mppxKey) {
    const privateKey = normalizePrivateKey(mppxKey);
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

export function resolveTempoPrivateKey(options: {
  envPrivateKey?: string | undefined;
  store?: SecretStore | undefined;
} = {}): `0x${string}` | undefined {
  const store = options.store ?? createSystemSecretStore();
  const envPrivateKey = normalizePrivateKey(options.envPrivateKey ?? process.env.TEMPO_PRIVATE_KEY, {
    allowEmpty: true
  });

  if (envPrivateKey) {
    return envPrivateKey;
  }

  const appKey = store.get(APP_SERVICE_NAME, APP_ACCOUNT_NAME);
  if (appKey) {
    const privateKey = normalizePrivateKey(appKey);
    if (privateKey) {
      return privateKey;
    }
  }

  const mppxAccountName = resolveMppxDefaultAccountName();
  const mppxKey = store.get(MPPX_SERVICE_NAME, mppxAccountName);
  if (mppxKey) {
    const privateKey = normalizePrivateKey(mppxKey);
    if (privateKey) {
      return privateKey;
    }
  }

  return undefined;
}

export function createTempoWallet(options: {
  store?: SecretStore | undefined;
  overwrite?: boolean | undefined;
  privateKey?: string | undefined;
} = {}): TempoWalletInfo {
  const store = options.store ?? createSystemSecretStore();
  const existing = store.get(APP_SERVICE_NAME, APP_ACCOUNT_NAME);
  if (existing && !options.overwrite) {
    const privateKey = normalizePrivateKey(existing);
    if (!privateKey) {
      throw new Error('Stored wallet is invalid.');
    }
    return {
      address: privateKeyToAccount(privateKey).address,
      source: 'summ-tempo',
      accountName: APP_ACCOUNT_NAME,
      serviceName: APP_SERVICE_NAME
    };
  }

  const privateKey = options.privateKey
    ? normalizePrivateKey(options.privateKey)
    : generatePrivateKey();

  if (!privateKey) {
    throw new Error('Missing Tempo private key.');
  }

  store.set(APP_SERVICE_NAME, APP_ACCOUNT_NAME, privateKey);

  return {
    address: privateKeyToAccount(privateKey).address,
    source: 'summ-tempo',
    accountName: APP_ACCOUNT_NAME,
    serviceName: APP_SERVICE_NAME
  };
}

export function deleteTempoWallet(store: SecretStore = createSystemSecretStore()): void {
  store.delete(APP_SERVICE_NAME, APP_ACCOUNT_NAME);
}

export function hasTempoWallet(options: {
  envPrivateKey?: string | undefined;
  store?: SecretStore | undefined;
} = {}): boolean {
  return resolveTempoWallet(options) !== undefined;
}

export function createSystemSecretStore(): SecretStore {
  const platform = os.platform();

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
        try {
          execFileSync(
            'security',
            ['delete-generic-password', '-s', serviceName, '-a', accountName],
            { stdio: 'ignore' }
          );
        } catch {}

        execFileSync(
          'security',
          ['add-generic-password', '-s', serviceName, '-a', accountName, '-w', secret],
          { stdio: 'ignore' }
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

export function normalizePrivateKey(
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

export function formatWalletFundingMessage(address: string): string {
  return [
    `Wallet address: ${address}`,
    'Fund this address on Tempo Mainnet (chain id 4217) with a USD-denominated Tempo fee token before summarizing paid requests.'
  ].join('\n');
}

function resolveMppxDefaultAccountName(): string {
  try {
    const configPath = path.join(
      process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
      'mppx',
      'default'
    );
    return fs.readFileSync(configPath, 'utf8').trim() || 'main';
  } catch {
    return 'main';
  }
}
