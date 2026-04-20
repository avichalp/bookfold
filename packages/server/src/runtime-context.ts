import type {
  SummarizationProvider
} from '@bookfold/sdk';
import { OpenAiMppProvider, resolveTempoWallet } from '@bookfold/sdk';
import { VercelBlobStore, type BlobStore } from './blob.js';
import { loadServerConfig, type ServerConfig } from './config.js';
import { createBookFoldStorage } from './storage/create.js';
import type { BookFoldStorage } from './storage/index.js';

export interface BookFoldRuntime {
  config: ServerConfig;
  storage: BookFoldStorage;
  blobStore: BlobStore;
  clock: () => Date;
  createProvider: () => SummarizationProvider;
  resolveInboundRecipient: () => `0x${string}`;
}

declare global {
  var __BOOKFOLD_SERVER_RUNTIME_FOR_TESTS__: BookFoldRuntime | undefined;
}

let cachedRuntime: BookFoldRuntime | undefined;

export function setBookFoldRuntimeForTests(runtime: BookFoldRuntime | undefined): void {
  globalThis.__BOOKFOLD_SERVER_RUNTIME_FOR_TESTS__ = runtime;
}

export function getBookFoldRuntime(): BookFoldRuntime {
  if (globalThis.__BOOKFOLD_SERVER_RUNTIME_FOR_TESTS__) {
    return globalThis.__BOOKFOLD_SERVER_RUNTIME_FOR_TESTS__;
  }

  cachedRuntime ??= createDefaultRuntime();
  return cachedRuntime;
}

export function createBookFoldRuntime(config: ServerConfig = loadServerConfig()): BookFoldRuntime {
  const storage = createBookFoldStorage({ config });
  const blobStore = new VercelBlobStore(requireConfig(config.blobReadWriteToken, 'BLOB_READ_WRITE_TOKEN'));

  return {
    config,
    storage,
    blobStore,
    clock: () => new Date(),
    createProvider: () =>
      new OpenAiMppProvider({
        baseUrl: config.openAiMppBaseUrl,
        ...(config.tempoPrivateKey ? { privateKey: config.tempoPrivateKey } : {})
      }),
    resolveInboundRecipient: () => {
      const wallet = resolveTempoWallet();
      if (!wallet) {
        throw new Error('Missing Tempo wallet for inbound MPP charges.');
      }

      return wallet.address;
    }
  };
}

function createDefaultRuntime(): BookFoldRuntime {
  return createBookFoldRuntime(loadServerConfig());
}

function requireConfig<T>(value: T | undefined, name: string): T {
  if (!value) {
    throw new Error(`Missing ${name}.`);
  }

  return value;
}
