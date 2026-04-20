import { createHash } from 'node:crypto';
import type { ServerRateLimitConfig } from './config.js';
import type { BookFoldStorage } from './storage/index.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

type RateLimitMetric = 'requests' | 'bytes';

interface RateLimitCounterState {
  rule: RateLimitRule;
  used: number;
  remaining: number;
  resetAtMs: number;
}

interface RateLimitRule {
  id: string;
  metric: RateLimitMetric;
  limit: number;
  windowMs: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  headers: Headers;
  retryAfterSeconds?: number | undefined;
}

export function buildUploadRateLimitRules(config: ServerRateLimitConfig): RateLimitRule[] {
  return [
    {
      id: 'uploads.requests.1m',
      metric: 'requests',
      limit: config.uploadsPerMinute,
      windowMs: MINUTE_MS
    },
    {
      id: 'uploads.requests.1h',
      metric: 'requests',
      limit: config.uploadsPerHour,
      windowMs: HOUR_MS
    },
    {
      id: 'uploads.bytes.1h',
      metric: 'bytes',
      limit: config.uploadBytesPerHour,
      windowMs: HOUR_MS
    },
    {
      id: 'uploads.bytes.1d',
      metric: 'bytes',
      limit: config.uploadBytesPerDay,
      windowMs: DAY_MS
    }
  ];
}

export function buildQuoteRateLimitRules(config: ServerRateLimitConfig): RateLimitRule[] {
  return [
    {
      id: 'quotes.requests.1m',
      metric: 'requests',
      limit: config.quotesPerMinute,
      windowMs: MINUTE_MS
    },
    {
      id: 'quotes.requests.1h',
      metric: 'requests',
      limit: config.quotesPerHour,
      windowMs: HOUR_MS
    },
    {
      id: 'quotes.requests.1d',
      metric: 'requests',
      limit: config.quotesPerDay,
      windowMs: DAY_MS
    }
  ];
}

export function buildJobCreateRateLimitRules(config: ServerRateLimitConfig): RateLimitRule[] {
  return [
    {
      id: 'jobs.create.requests.1m',
      metric: 'requests',
      limit: config.jobCreatesPerMinute,
      windowMs: MINUTE_MS
    }
  ];
}

export function buildJobReadRateLimitRules(config: ServerRateLimitConfig): RateLimitRule[] {
  return [
    {
      id: 'jobs.read.requests.1m',
      metric: 'requests',
      limit: config.jobReadsPerMinute,
      windowMs: MINUTE_MS
    }
  ];
}

export async function enforceRateLimits(input: {
  storage: BookFoldStorage;
  request: Request;
  scope: string;
  rules: RateLimitRule[];
  clock: () => Date;
  requestCount?: number | undefined;
  byteCount?: number | undefined;
}): Promise<RateLimitDecision> {
  const nowMs = input.clock().getTime();
  const subjectKey = resolveClientSubjectKey(input.request);
  const requestCount = input.requestCount ?? 1;
  const byteCount = input.byteCount ?? 0;
  const states: RateLimitCounterState[] = [];

  for (const rule of input.rules) {
    if (rule.limit <= 0) {
      continue;
    }

    const bucketStartMs = Math.floor(nowMs / rule.windowMs) * rule.windowMs;
    const bucket = await input.storage.incrementRateLimitBucket({
      scope: input.scope,
      subjectKey,
      windowMs: rule.windowMs,
      windowStartMs: bucketStartMs,
      requestCount: rule.metric === 'requests' ? requestCount : 0,
      byteCount: rule.metric === 'bytes' ? byteCount : 0
    });
    const used = rule.metric === 'bytes' ? bucket.byteCount : bucket.requestCount;

    states.push({
      rule,
      used,
      remaining: Math.max(rule.limit - used, 0),
      resetAtMs: bucketStartMs + rule.windowMs
    });
  }

  const blocked = states.find((state) => state.used > state.rule.limit);
  const headers = buildHeaders(states, nowMs, blocked);

  return {
    allowed: !blocked,
    headers,
    retryAfterSeconds:
      blocked ? Math.max(1, Math.ceil((blocked.resetAtMs - nowMs) / 1000)) : undefined
  };
}

export async function enforceOpenUploadLimit(input: {
  storage: BookFoldStorage;
  request: Request;
  limit: number;
  clock: () => Date;
}): Promise<RateLimitDecision> {
  if (input.limit <= 0) {
    return {
      allowed: true,
      headers: new Headers()
    };
  }

  const now = input.clock();
  const summary = await input.storage.getPendingUploadSummary(
    resolveClientSubjectKey(input.request),
    now.toISOString()
  );
  const remaining = Math.max(input.limit - summary.count, 0);
  const headers = new Headers({
    'RateLimit-Limit': String(input.limit),
    'RateLimit-Remaining': String(remaining),
    'RateLimit-Policy': `open-uploads;limit=${input.limit}`
  });

  let retryAfterSeconds: number | undefined;
  if (summary.earliestExpiresAt) {
    const retryAtMs = new Date(summary.earliestExpiresAt).getTime();
    const seconds = Math.max(1, Math.ceil((retryAtMs - now.getTime()) / 1000));
    headers.set('RateLimit-Reset', String(seconds));
    retryAfterSeconds = seconds;
  } else {
    headers.set('RateLimit-Reset', '0');
  }

  if (summary.count >= input.limit && retryAfterSeconds) {
    headers.set('Retry-After', String(retryAfterSeconds));
  }

  return {
    allowed: summary.count < input.limit,
    headers,
    retryAfterSeconds
  };
}

export async function maybePruneRateLimitBuckets(input: {
  storage: BookFoldStorage;
  clock: () => Date;
  bucketTtlSeconds: number;
  lastPrunedAtMs?: number | undefined;
}): Promise<number> {
  if (input.bucketTtlSeconds <= 0) {
    return input.lastPrunedAtMs ?? 0;
  }

  const nowMs = input.clock().getTime();
  if (input.lastPrunedAtMs && nowMs - input.lastPrunedAtMs < HOUR_MS) {
    return input.lastPrunedAtMs;
  }

  const cutoffMs = nowMs - input.bucketTtlSeconds * 1000;
  await input.storage.pruneRateLimitBuckets(cutoffMs);
  return nowMs;
}

export function resolveClientSubjectKey(request: Request): string {
  const source = extractClientAddress(request);
  return createHash('sha256').update(source).digest('hex');
}

function extractClientAddress(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded
      .split(',')
      .map((part) => part.trim())
      .find(Boolean);
    if (first) {
      return `ip:${first}`;
    }
  }

  const direct =
    request.headers.get('cf-connecting-ip') ??
    request.headers.get('x-real-ip') ??
    request.headers.get('x-client-ip');
  if (direct && direct.trim()) {
    return `ip:${direct.trim()}`;
  }

  return 'ip:unknown';
}

function buildHeaders(
  states: RateLimitCounterState[],
  nowMs: number,
  blocked: RateLimitCounterState | undefined
): Headers {
  if (states.length === 0) {
    return new Headers();
  }

  const primary = blocked ?? pickPrimaryState(states);
  const resetSeconds = Math.max(0, Math.ceil((primary.resetAtMs - nowMs) / 1000));
  const headers = new Headers({
    'RateLimit-Limit': String(primary.rule.limit),
    'RateLimit-Remaining': String(primary.remaining),
    'RateLimit-Reset': String(resetSeconds),
    'RateLimit-Policy': states
      .map(
        (state) =>
          `${state.rule.metric};limit=${state.rule.limit};w=${Math.round(state.rule.windowMs / 1000)}`
      )
      .join(', ')
  });

  if (blocked) {
    headers.set('Retry-After', String(Math.max(1, resetSeconds)));
  }

  return headers;
}

function pickPrimaryState(states: RateLimitCounterState[]): RateLimitCounterState {
  return states.reduce((best, current) => {
    const bestRatio = best.rule.limit > 0 ? best.remaining / best.rule.limit : 0;
    const currentRatio = current.rule.limit > 0 ? current.remaining / current.rule.limit : 0;

    if (currentRatio !== bestRatio) {
      return currentRatio < bestRatio ? current : best;
    }

    return current.resetAtMs < best.resetAtMs ? current : best;
  });
}
