import { MAX_FILE_BYTES, OPENAI_MPP_BASE_URL } from '@bookfold/sdk/config';

export const SERVER_NAME = 'bookfold-mpp-server';
export const DEFAULT_PORT = 8787;
export const DEFAULT_QUOTE_TTL_SECONDS = 15 * 60;
export const DEFAULT_PRICE_SHEET_VERSION = 'bookfold-price-v1';
export const DEFAULT_TEMPO_CHAIN_ID = 4217;
export const DEFAULT_TEMPO_DECIMALS = 6;
export const DEFAULT_TEMPO_CURRENCY = '0x20C000000000000000000000b9537d11c60E8b50' as const;
export const DEFAULT_UPLOADS_PER_MINUTE = 3;
export const DEFAULT_UPLOADS_PER_HOUR = 10;
export const DEFAULT_UPLOAD_BYTES_PER_HOUR = 250 * 1024 * 1024;
export const DEFAULT_UPLOAD_BYTES_PER_DAY = 1024 * 1024 * 1024;
export const DEFAULT_OPEN_UPLOADS_PER_CLIENT = 2;
export const DEFAULT_QUOTES_PER_MINUTE = 2;
export const DEFAULT_QUOTES_PER_HOUR = 6;
export const DEFAULT_QUOTES_PER_DAY = 10;
export const DEFAULT_JOB_CREATES_PER_MINUTE = 10;
export const DEFAULT_JOB_READS_PER_MINUTE = 30;
export const DEFAULT_RATE_LIMIT_BUCKET_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface ServerRateLimitConfig {
  uploadsPerMinute: number;
  uploadsPerHour: number;
  uploadBytesPerHour: number;
  uploadBytesPerDay: number;
  openUploadsPerClient: number;
  quotesPerMinute: number;
  quotesPerHour: number;
  quotesPerDay: number;
  jobCreatesPerMinute: number;
  jobReadsPerMinute: number;
  bucketTtlSeconds: number;
}

export interface ServerConfig {
  environment: string;
  port: number;
  baseUrl: string;
  quoteTtlSeconds: number;
  maxUploadBytes: number;
  priceSheetVersion: string;
  openAiMppBaseUrl: string;
  tempoChainId: number;
  tempoCurrency: `0x${string}`;
  tempoCurrencyDecimals: number;
  blobReadWriteToken?: string | undefined;
  tursoDatabaseUrl?: string | undefined;
  tursoAuthToken?: string | undefined;
  tempoPrivateKey?: `0x${string}` | undefined;
  mppSecretKey?: string | undefined;
  rateLimits: ServerRateLimitConfig;
}

interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  strict?: boolean | undefined;
}

export function loadServerConfig(options: LoadConfigOptions = {}): ServerConfig {
  const env = options.env ?? process.env;
  const port = readInteger(env, 'PORT', DEFAULT_PORT);
  const baseUrl = readString(env, 'BOOKFOLD_BASE_URL');

  const config: ServerConfig = {
    environment: readString(env, 'NODE_ENV') ?? 'development',
    port,
    baseUrl: baseUrl ?? `http://localhost:${port}`,
    quoteTtlSeconds: readInteger(env, 'BOOKFOLD_QUOTE_TTL_SECONDS', DEFAULT_QUOTE_TTL_SECONDS),
    maxUploadBytes: readInteger(env, 'BOOKFOLD_MAX_UPLOAD_BYTES', MAX_FILE_BYTES),
    priceSheetVersion:
      readString(env, 'BOOKFOLD_PRICE_SHEET_VERSION') ?? DEFAULT_PRICE_SHEET_VERSION,
    openAiMppBaseUrl: readString(env, 'OPENAI_MPP_BASE_URL') ?? OPENAI_MPP_BASE_URL,
    tempoChainId: readInteger(env, 'BOOKFOLD_TEMPO_CHAIN_ID', DEFAULT_TEMPO_CHAIN_ID),
    tempoCurrency:
      (readString(env, 'BOOKFOLD_TEMPO_CURRENCY') ?? DEFAULT_TEMPO_CURRENCY) as `0x${string}`,
    tempoCurrencyDecimals: readInteger(
      env,
      'BOOKFOLD_TEMPO_CURRENCY_DECIMALS',
      DEFAULT_TEMPO_DECIMALS
    ),
    blobReadWriteToken: readString(env, 'BLOB_READ_WRITE_TOKEN'),
    tursoDatabaseUrl: readString(env, 'TURSO_DATABASE_URL'),
    tursoAuthToken: readString(env, 'TURSO_AUTH_TOKEN'),
    tempoPrivateKey: readString(env, 'TEMPO_PRIVATE_KEY') as `0x${string}` | undefined,
    mppSecretKey: readString(env, 'MPP_SECRET_KEY'),
    rateLimits: {
      uploadsPerMinute: readNonNegativeInteger(
        env,
        'BOOKFOLD_RATE_LIMIT_UPLOADS_PER_MINUTE',
        DEFAULT_UPLOADS_PER_MINUTE
      ),
      uploadsPerHour: readNonNegativeInteger(
        env,
        'BOOKFOLD_RATE_LIMIT_UPLOADS_PER_HOUR',
        DEFAULT_UPLOADS_PER_HOUR
      ),
      uploadBytesPerHour: readNonNegativeInteger(
        env,
        'BOOKFOLD_RATE_LIMIT_UPLOAD_BYTES_PER_HOUR',
        DEFAULT_UPLOAD_BYTES_PER_HOUR
      ),
      uploadBytesPerDay: readNonNegativeInteger(
        env,
        'BOOKFOLD_RATE_LIMIT_UPLOAD_BYTES_PER_DAY',
        DEFAULT_UPLOAD_BYTES_PER_DAY
      ),
      openUploadsPerClient: readNonNegativeInteger(
        env,
        'BOOKFOLD_RATE_LIMIT_OPEN_UPLOADS_PER_CLIENT',
        DEFAULT_OPEN_UPLOADS_PER_CLIENT
      ),
      quotesPerMinute: readNonNegativeInteger(
        env,
        'BOOKFOLD_RATE_LIMIT_QUOTES_PER_MINUTE',
        DEFAULT_QUOTES_PER_MINUTE
      ),
      quotesPerHour: readNonNegativeInteger(
        env,
        'BOOKFOLD_RATE_LIMIT_QUOTES_PER_HOUR',
        DEFAULT_QUOTES_PER_HOUR
      ),
      quotesPerDay: readNonNegativeInteger(
        env,
        'BOOKFOLD_RATE_LIMIT_QUOTES_PER_DAY',
        DEFAULT_QUOTES_PER_DAY
      ),
      jobCreatesPerMinute: readNonNegativeInteger(
        env,
        'BOOKFOLD_RATE_LIMIT_JOB_CREATES_PER_MINUTE',
        DEFAULT_JOB_CREATES_PER_MINUTE
      ),
      jobReadsPerMinute: readNonNegativeInteger(
        env,
        'BOOKFOLD_RATE_LIMIT_JOB_READS_PER_MINUTE',
        DEFAULT_JOB_READS_PER_MINUTE
      ),
      bucketTtlSeconds: readNonNegativeInteger(
        env,
        'BOOKFOLD_RATE_LIMIT_BUCKET_TTL_SECONDS',
        DEFAULT_RATE_LIMIT_BUCKET_TTL_SECONDS
      )
    }
  };

  if (options.strict) {
    const missing = [
      ['BOOKFOLD_BASE_URL', baseUrl],
      ['BLOB_READ_WRITE_TOKEN', config.blobReadWriteToken],
      ['TURSO_DATABASE_URL', config.tursoDatabaseUrl],
      ['TURSO_AUTH_TOKEN', config.tursoAuthToken],
      ['TEMPO_PRIVATE_KEY', config.tempoPrivateKey],
      ['MPP_SECRET_KEY', config.mppSecretKey]
    ]
      .filter(([, value]) => !value)
      .map(([key]) => key);

    if (missing.length > 0) {
      throw new Error(`Missing required server env vars: ${missing.join(', ')}`);
    }
  }

  return config;
}

function readString(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  key: string
): string | undefined {
  const value = env[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readInteger(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  key: string,
  fallback: number
): number {
  const raw = readString(env, key);
  if (!raw) {
    return fallback;
  }

  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) {
    throw new Error(`Expected ${key} to be an integer.`);
  }

  return value;
}

function readNonNegativeInteger(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  key: string,
  fallback: number
): number {
  const value = readInteger(env, key, fallback);
  if (value < 0) {
    throw new Error(`Expected ${key} to be a non-negative integer.`);
  }

  return value;
}
