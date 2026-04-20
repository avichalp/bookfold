# BookFold MPP Server Deploy

Shape:

```text
Vercel
  -> /api
  -> .well-known/workflow/v1/*
  -> Blob
  -> Turso
```

## Files

- [vercel.json](../vercel.json)
- [api/index.ts](../api/index.ts)
- [workflows/bookfold-job.ts](../workflows/bookfold-job.ts)
- [docs/mpp-server-rate-limits.md](./mpp-server-rate-limits.md)

## Build

```bash
bun run build:vercel
```

This does:

1. `workflow build`
2. `tsc -b`
3. `workflow build --target vercel-build-output-api`

The third step writes the private Workflow handlers into:

- `.vercel/output/functions/.well-known/workflow/v1/flow.func`
- `.vercel/output/functions/.well-known/workflow/v1/step.func`
- `.vercel/output/functions/.well-known/workflow/v1/webhook/[token].func`

## Env

Required:

```text
BOOKFOLD_BASE_URL
BLOB_READ_WRITE_TOKEN
TURSO_DATABASE_URL
TURSO_AUTH_TOKEN
TEMPO_PRIVATE_KEY
MPP_SECRET_KEY
```

Optional:

```text
BOOKFOLD_PRICE_SHEET_VERSION
BOOKFOLD_QUOTE_TTL_SECONDS
BOOKFOLD_MAX_UPLOAD_BYTES
BOOKFOLD_TEMPO_CHAIN_ID
BOOKFOLD_TEMPO_CURRENCY
BOOKFOLD_TEMPO_CURRENCY_DECIMALS
OPENAI_MPP_BASE_URL
```

Rate-limit tuning:

```text
BOOKFOLD_RATE_LIMIT_UPLOADS_PER_MINUTE
BOOKFOLD_RATE_LIMIT_UPLOADS_PER_HOUR
BOOKFOLD_RATE_LIMIT_UPLOAD_BYTES_PER_HOUR
BOOKFOLD_RATE_LIMIT_UPLOAD_BYTES_PER_DAY
BOOKFOLD_RATE_LIMIT_OPEN_UPLOADS_PER_CLIENT
BOOKFOLD_RATE_LIMIT_QUOTES_PER_MINUTE
BOOKFOLD_RATE_LIMIT_QUOTES_PER_HOUR
BOOKFOLD_RATE_LIMIT_QUOTES_PER_DAY
BOOKFOLD_RATE_LIMIT_JOB_CREATES_PER_MINUTE
BOOKFOLD_RATE_LIMIT_JOB_READS_PER_MINUTE
BOOKFOLD_RATE_LIMIT_BUCKET_TTL_SECONDS
```

## Blob notes

- Uploads use private direct upload tokens.
- Upload token max size now matches declared `sizeBytes`.
- Source books stay in Blob.
- Summary artifacts stay in Blob.

## Turso notes

- Server uses Turso through `@libsql/client`.
- Schema boots on first request and in tests.
- Quotes, jobs, events, payments, and artifacts live there.

## Preview deploy

```bash
npx vercel build --yes --scope <team>
npx vercel deploy --prebuilt --yes --scope <team>
```

## Production deploy

```bash
npx vercel build --prod --yes --scope <team>
npx vercel deploy --prebuilt --prod --yes --scope <team>
```

## Smoke test

```bash
BOOKFOLD_BASE_URL=https://preview-or-prod.example \
TEMPO_PRIVATE_KEY=... \
bun run smoke:hosted
```

For production, add:

```bash
BOOKFOLD_ALLOW_PRODUCTION=true
```

This checks:

1. `GET /healthz`
2. `POST /v1/uploads`
3. Blob upload
4. `POST /v1/quotes`
5. `POST /v1/jobs` and confirm `402`
6. paid retry
7. `GET /v1/jobs/:id` until done

Wallet note:

- The Tempo wallet behind `TEMPO_PRIVATE_KEY` needs at least `1.0` USD of Tempo fee-token balance for the outbound OpenAI session open.
