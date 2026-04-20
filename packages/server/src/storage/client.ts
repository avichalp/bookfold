import { createClient, type Client } from '@libsql/client/web';
import type { ServerConfig } from '../config.js';

export function createTursoClient(config: Pick<ServerConfig, 'tursoAuthToken' | 'tursoDatabaseUrl'>): Client {
  if (!config.tursoDatabaseUrl) {
    throw new Error('Missing TURSO_DATABASE_URL.');
  }

  return createClient({
    url: config.tursoDatabaseUrl,
    ...(config.tursoAuthToken ? { authToken: config.tursoAuthToken } : {}),
    intMode: 'number'
  });
}
