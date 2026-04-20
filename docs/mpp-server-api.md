# BookFold MPP Server API

Shape:

```text
client
  -> POST /v1/uploads
  -> Blob PUT
  -> POST /v1/quotes
  -> POST /v1/jobs
  <- 402 challenge
  -> POST /v1/jobs (paid retry)
  -> GET /v1/jobs/:id
```

## Routes

| Route | Use |
|---|---|
| `GET /healthz` | health |
| `GET /v1/openapi.json` | machine spec |
| `POST /v1/uploads` | mint direct upload token |
| `POST /v1/quotes` | freeze plan and quote |
| `POST /v1/jobs` | paid job create |
| `GET /v1/jobs/:id` | poll result |

## Flow

1. Ask for an upload target.
2. Upload the file to private Blob storage.
3. Ask for a quote with `detail`.
4. Call `POST /v1/jobs`.
5. If the request is unpaid, you get `402`.
6. Retry `POST /v1/jobs` with MPP payment.
7. Poll `GET /v1/jobs/:id` until `status` is `succeeded` or `failed`.

## Quote rules

- Quote uses a frozen plan.
- Quote pins parser, tokenizer, prompt, model ids, and price sheet.
- Same file + same detail + same versions => same plan hash.

## Job rules

- Job create is idempotent per `quoteId`.
- Repeated paid retries return the same `jobId`.
- Result polling returns warnings and payment info.

## Public limits

- Public routes are rate-limited by client IP hash.
- See [docs/mpp-server-rate-limits.md](./mpp-server-rate-limits.md).
- `429` responses include `RateLimit-*` headers and `Retry-After`.

## Examples

- Curl: [docs/examples/mpp-server.curl.sh](./examples/mpp-server.curl.sh)
- JS: [docs/examples/mpp-server.js](./examples/mpp-server.js)
- Python: [docs/examples/mpp-server.py](./examples/mpp-server.py)

## Deploy inputs

Needed for live deploy:

- Vercel project access
- `BLOB_READ_WRITE_TOKEN`
- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN`
- `TEMPO_PRIVATE_KEY`
- `MPP_SECRET_KEY`

Optional:

- custom domain
- final production price sheet version override
