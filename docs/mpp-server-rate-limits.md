# BookFold MPP Server Rate Limits

Shape:

```text
client IP
  -> hash
  -> shared DB buckets
  -> allow or 429
```

## Why

This project is public.

There is no app auth.

So the server protects the free paths with rate limits:

- `POST /v1/uploads`
- `POST /v1/quotes`
- `POST /v1/jobs`
- `GET /v1/jobs/:id`

The paid job path still has a limit.

That keeps abuse bursts small.

## Client key

The server reads the client IP from:

1. `x-forwarded-for`
2. `cf-connecting-ip`
3. `x-real-ip`
4. `x-client-ip`

Then it stores a SHA-256 hash of that value.

It does not store the raw IP in the rate-limit buckets.

## Default limits

| Route | Limit |
|---|---|
| `POST /v1/uploads` | `3/min` per client |
| `POST /v1/uploads` | `10/hour` per client |
| `POST /v1/uploads` | `250 MiB/hour` per client |
| `POST /v1/uploads` | `1 GiB/day` per client |
| `POST /v1/uploads` | `2` open upload tokens per client |
| `POST /v1/quotes` | `2/min` per client |
| `POST /v1/quotes` | `6/hour` per client |
| `POST /v1/quotes` | `10/day` per client |
| `POST /v1/jobs` | `10/min` per client |
| `GET /v1/jobs/:id` | `30/min` per client |

## Window shape

The server uses fixed windows.

Example:

```text
00:00 -> 00:00:59  one minute bucket
01:00 -> 01:59:59  one hour bucket
00:00 UTC -> 23:59:59 UTC  one day bucket
```

This is simple.

It is easy to reason about.

It is easy to test.

## Upload rules

Uploads have two kinds of limits:

1. request count
2. total declared bytes

There is also an open-token cap.

That stops a client from minting many idle Blob upload tokens.

## Quote reuse

The server now reuses a stored quote template when all of these match:

- file digest
- detail level
- summary plan version
- parser version
- tokenizer version
- prompt version
- price sheet version
- payable token config

Flow:

```text
blob -> digest
     -> cached quote?
        yes -> new quote row from cached plan
        no  -> parse book -> build plan
```

This avoids repeat parse work for the same book.

## Headers

Rate-limited routes return these headers:

| Header | Use |
|---|---|
| `RateLimit-Limit` | current limit for the tightest bucket |
| `RateLimit-Remaining` | remaining space in that bucket |
| `RateLimit-Reset` | seconds until reset |
| `RateLimit-Policy` | applied windows |
| `Retry-After` | wait time on `429` |

## Errors

The server returns `429` with one of these codes:

- `too_many_open_uploads`
- `upload_rate_limited`
- `quote_rate_limited`
- `job_create_rate_limited`
- `job_read_rate_limited`

## Env

All values are integers.

Set a value to `0` to disable that limit.

| Env | Default |
|---|---|
| `BOOKFOLD_RATE_LIMIT_UPLOADS_PER_MINUTE` | `3` |
| `BOOKFOLD_RATE_LIMIT_UPLOADS_PER_HOUR` | `10` |
| `BOOKFOLD_RATE_LIMIT_UPLOAD_BYTES_PER_HOUR` | `262144000` |
| `BOOKFOLD_RATE_LIMIT_UPLOAD_BYTES_PER_DAY` | `1073741824` |
| `BOOKFOLD_RATE_LIMIT_OPEN_UPLOADS_PER_CLIENT` | `2` |
| `BOOKFOLD_RATE_LIMIT_QUOTES_PER_MINUTE` | `2` |
| `BOOKFOLD_RATE_LIMIT_QUOTES_PER_HOUR` | `6` |
| `BOOKFOLD_RATE_LIMIT_QUOTES_PER_DAY` | `10` |
| `BOOKFOLD_RATE_LIMIT_JOB_CREATES_PER_MINUTE` | `10` |
| `BOOKFOLD_RATE_LIMIT_JOB_READS_PER_MINUTE` | `30` |
| `BOOKFOLD_RATE_LIMIT_BUCKET_TTL_SECONDS` | `604800` |

## Storage

The server stores rate-limit counters in Turso.

That matters because Vercel can run more than one instance.

```text
request -> server instance A \
                         -> Turso bucket
request -> server instance B /
```

## Cleanup

Old buckets are pruned.

The server keeps about 7 days by default.

Prune runs at most once per hour per warm app instance.

## One more hardening change

Upload tokens now use the declared `sizeBytes` as their Blob max size.

Before this change, a client could declare a small size and still upload up to the global max.
