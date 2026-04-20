# BookFold MPP Server MVP Plan

## Goal

Ship BookFold as a public MPP-backed API.

Any agent should be able to:

1. upload a book
2. get a deterministic quote
3. pay over MPP
4. wait for the job
5. fetch the summary

BookFold should:

- collect payment from the client over MPP
- pay OpenAI over MPP
- keep a margin
- survive restarts
- keep the CLI working

## Chosen stack

Use Vercel for hosting.

Use:

- Vercel Functions
- Vercel Blob
- Vercel Workflow
- Turso

Do not use local SQLite files on Vercel.

Use Turso if we want SQLite semantics.

## Product shape

Keep two products:

- local CLI
- hosted MPP server

Do not remove the CLI.

## Core rule

Quote on a frozen plan.

Do not quote on final model usage.

Use:

```text
price =
  input tokens * input rate
+ reserved output tokens * output rate
+ BookFold fee
+ safety buffer
```

Why:

- input tokens can be counted before the run
- output budget can be fixed before the run
- actual output used is only known after the run

## Main architecture

```text
Agent
  -> Blob upload
  -> POST /v1/quotes
  -> POST /v1/jobs
  -> GET /v1/jobs/:id

BookFold API
  -> Turso
  -> Vercel Workflow
  -> Vercel Blob
  -> OpenAI MPP
```

## Vercel fit

Use each Vercel product for one clear job.

### Vercel Functions

Use for:

- upload token route
- quote route
- paid job route
- job read route
- health route
- OpenAPI route

### Vercel Blob

Use for:

- uploaded books
- summary artifacts
- debug artifacts if needed

Do not send large book files through normal request bodies if we can avoid it.

Prefer direct upload to Blob.

### Vercel Workflow

Use for:

- async job execution
- retries
- restart-safe progress
- long-running summarize work

### Turso

Use for:

- quotes
- jobs
- job events
- inbound receipts
- outbound receipts
- price sheets

## API shape

Free routes:

- `GET /healthz`
- `GET /v1/openapi.json`
- `POST /v1/uploads`
- `POST /v1/quotes`
- `GET /v1/jobs/:id`

Paid route:

- `POST /v1/jobs`

## Flow

```text
1. client asks for upload target
2. client uploads book to Blob
3. client asks for quote with blob key + detail
4. server parses book and freezes plan
5. server returns quote
6. client creates job
7. unpaid request gets 402
8. paid retry creates workflow job
9. workflow runs summary
10. client polls for result
```

## Upload flow

### `POST /v1/uploads`

Goal:

- mint a safe Blob upload target

Input:

- file name
- content type
- file size

Output:

- upload token or signed upload details
- target path
- file id

Rules:

- reject unsupported file types
- reject files above current BookFold size limit
- store books in private Blob storage

## Quote flow

### `POST /v1/quotes`

Input:

- uploaded blob path
- `detail`

Work:

1. fetch the uploaded book from Blob
2. parse the file
3. build a deterministic summary plan
4. count tokens
5. compute the quote
6. save the quote in Turso

Output:

- `quoteId`
- `planHash`
- `amount`
- `currency`
- `expiresAt`
- `detail`
- file digest
- price version
- model version

Rules:

- same file + same detail + same versions => same plan hash
- same plan hash + same price sheet => same price
- quote expires fast

## Job flow

### `POST /v1/jobs`

Input:

- `quoteId`

Behavior:

- unpaid request returns `402`
- paid retry creates one job
- job starts a workflow run

Output:

- `jobId`
- `status`
- `quoteId`

Rules:

- job creation must be idempotent
- do not create two jobs for the same paid attempt

## Result flow

### `GET /v1/jobs/:id`

Output:

- job status
- summary when ready
- warnings
- debug info
- payment info

## Job state

```text
uploaded
  -> quoted
  -> paid
  -> queued
  -> running
  -> succeeded
  -> failed
  -> refund_review
```

## Payment state

Track both sides.

Inbound:

- challenge id
- receipt
- amount charged
- status

Outbound:

- OpenAI channel id
- receipts
- spent
- close status

## Deterministic quote rules

Pin all of these:

- parser version
- prompt version
- tokenizer version
- chunking rules
- model ids
- price sheet version

The quote must be based on:

- exact parsed content
- exact chunk list
- exact prompt text
- exact number of model calls
- exact reserved output cap per call

## Repo shape

Use the current monorepo.

### `packages/sdk`

Keep:

- parsing
- summarization logic
- outbound OpenAI MPP logic

Add:

- `src/plan/`
- `src/pricing/`
- `src/tokenize/`

New core functions:

- `buildSummaryPlan(book, detail)`
- `priceSummaryPlan(plan, priceSheet)`
- `hashSummaryPlan(plan)`

### `packages/server`

Add a new package for:

- Vercel API handlers
- upload helpers
- Turso access
- Vercel Workflow jobs
- recovery
- OpenAPI spec

## Data model

Use Turso tables for:

- `uploads`
- `quotes`
- `jobs`
- `job_events`
- `inbound_payments`
- `outbound_payments`
- `artifacts`
- `price_sheets`

Keep:

- file digest
- blob path
- quote payload
- plan hash
- job status
- workflow run id
- receipts
- summary artifact path

## Build phases

## Phase 1. Core deterministic engine

Add:

- tokenizer helper
- planner
- pricer
- stable hashing
- price sheet loading

Done when:

- a parsed book can be turned into a frozen priced plan

## Phase 2. Server package

Create `packages/server`.

Add:

- config
- route handlers
- Turso client
- Blob helpers
- OpenAPI route

Done when:

- server boots
- health check works

## Phase 3. Upload and quote

Add:

- upload token route
- quote route
- file digest checks
- quote persistence

Done when:

- an uploaded book gets a deterministic quote

## Phase 4. Paid job create

Add:

- inbound MPP challenge flow
- `402` response
- paid retry handling
- idempotent job creation

Done when:

- a paid request creates one job

## Phase 5. Workflow runner

Add:

- workflow entrypoint
- step logging
- frozen plan execution
- outbound OpenAI MPP
- summary artifact save

Done when:

- one job runs end to end

## Phase 6. Recovery

Recover:

- paid but not queued
- queued but not started
- running but process stopped
- OpenAI charged but result not saved
- close failed on either side

Rules:

- do not double-charge the client
- retry cost is BookFold cost

## Phase 7. Public docs

Publish:

- OpenAPI spec
- curl example
- JS example
- Python example
- pricing rules
- result polling example

Done when:

- a new agent can use the service cold

## Default MVP choices

Unless changed later, use these defaults:

- direct upload to Vercel Blob
- async jobs only
- quote expiry: 15 minutes
- retries are not rebilled to the client
- one price sheet
- one outbound provider: OpenAI MPP
- short artifact retention

## Deploy inputs

Production deploy needs:

- Vercel project
- Blob store
- Workflow enabled
- Turso database
- Turso auth token
- funded Tempo wallet
- domain
- price sheet

## Environment variables

Expect at least:

- `BLOB_READ_WRITE_TOKEN`
- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN`
- `TEMPO_PRIVATE_KEY`
- `BOOKFOLD_BASE_URL`
- `BOOKFOLD_PRICE_SHEET_VERSION`

Optional:

- `OPENAI_MPP_BASE_URL`

## Main risks

- parser libraries may need adaptation for Vercel runtime limits
- upload flow is more complex because Blob upload is separate
- retries can eat margin
- moving model aliases break quote stability
- raw book uploads raise privacy and abuse risk

## MVP done

The MVP is done when:

- deterministic quotes work
- direct upload works
- unpaid job create returns `402`
- paid jobs run
- result fetch works
- restart recovery works
- public docs exist
- a new agent can use the live service

## References

- Vercel Blob: <https://vercel.com/docs/vercel-blob>
- Vercel Blob server upload note: <https://vercel.com/docs/vercel-blob/server-upload>
- Vercel Workflow: <https://vercel.com/docs/workflow>
- SQLite on Vercel: <https://vercel.com/guides/is-sqlite-supported-in-vercel>
- Stripe MPP docs: <https://docs.stripe.com/payments/machine/mpp>
