import type { Client } from '@libsql/client';
import { createTursoClient } from './client.js';
import { BookFoldStorage } from './index.js';
import type { ServerConfig } from '../config.js';

export function createBookFoldStorage(parameters: {
  client?: Client | undefined;
  config?: Pick<ServerConfig, 'tursoAuthToken' | 'tursoDatabaseUrl'> | undefined;
}): BookFoldStorage {
  if (parameters.client) {
    return new BookFoldStorage(parameters.client);
  }

  if (!parameters.config) {
    throw new Error('Storage creation needs a libsql client or Turso config.');
  }

  return new BookFoldStorage(createTursoClient(parameters.config));
}
