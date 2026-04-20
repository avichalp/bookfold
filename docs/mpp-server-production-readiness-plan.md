# BookFold MPP Server Production Readiness Plan

## Goal

Ship BookFold as a public MPP service that is:

- reliable
- safe to charge money for
- easy for agents to find
- easy for agents to use

## What "ready" means

```text
agent
  -> finds BookFold in a registry
  -> reads /openapi.json
  -> reads llms.txt
  -> uploads a book
  -> gets a quote
  -> pays
  -> polls job
  -> gets result
```

## Terms

- Discovery: how agents find and understand the API before they call it.
- Registry: a public list of MPP services.
- Runtime truth: the live `402` challenge. This is the final price signal.

## Current state

Checked on 2026-04-19.

| Item | State | Notes |
|---|---|---|
| `GET /healthz` | present | live |
| `GET /v1/openapi.json` | present | live |
| `GET /openapi.json` | missing | live `404` |
| `GET /llms.txt` | missing | live `404` |
| `x-service-info` in OpenAPI | missing | not in current doc |
| `x-payment-info` in OpenAPI | missing | not in current doc |
| MPP registry entry | missing | not listed yet |
| Tempo discovery via `tempo wallet services` | missing | depends on registry |

## Release rule

Do not call this production-ready until every phase below is done.

---

## Phase 1. Discovery contract

Goal:

- make BookFold look like a real MPP service before any registry submit

Checklist:

- [ ] Serve `GET /openapi.json`
- [ ] Keep `GET /v1/openapi.json` as an alias or redirect
- [ ] Add root-level `x-service-info`
- [ ] Add `x-payment-info` on every paid operation
- [ ] Mark free routes as free by omission, not by guesswork
- [ ] Add a clear `402` response on paid operations
- [ ] Add `summary` and short `description` text for each route
- [ ] Add service docs links:
  - [ ] homepage
  - [ ] API reference
  - [ ] `llms.txt`
- [ ] Decide how to represent quote-based pricing:
  - [ ] fixed estimate
  - [ ] dynamic price hint
  - [ ] exact price only in runtime `402`
- [ ] Validate the final doc with `mppx discover validate`

Exit check:

```bash
curl -fsSL https://bookfold.vercel.app/openapi.json
npx mppx discover validate https://bookfold.vercel.app/openapi.json
```

Notes:

- BookFold is quote-based.
- The paid route is not a simple fixed-price endpoint.
- The discovery doc should say enough for planning.
- The live `402` should still be the final truth.

---

## Phase 2. Agent docs

Goal:

- make the service easy for an agent to use without guesswork

Checklist:

- [ ] Add `GET /llms.txt`
- [ ] Add a short flow doc in plain words
- [ ] Show the real call order:
  - [ ] upload
  - [ ] quote
  - [ ] paid job create
  - [ ] poll
- [ ] Show one `curl` example
- [ ] Show one JS example
- [ ] Show one Python example
- [ ] Explain quote lifetime and retry rules
- [ ] Explain idempotency for repeated paid retries
- [ ] Explain result shape for `queued`, `running`, `succeeded`, `failed`
- [ ] Explain limits:
  - [ ] file types
  - [ ] file size
  - [ ] detail modes
  - [ ] quote expiry

Exit check:

```bash
curl -fsSL https://bookfold.vercel.app/llms.txt
```

---

## Phase 3. Money safety

Goal:

- avoid wrong charges
- avoid double charges
- avoid silent margin loss

Checklist:

- [ ] Recheck quote math against live price sheet
- [ ] Recheck margin math
- [ ] Recheck currency, decimals, and rounding rules
- [ ] Prove `POST /v1/jobs` is idempotent for repeated paid retries
- [ ] Prove one quote cannot create two billable jobs
- [ ] Prove inbound payment records match job records
- [ ] Prove outbound OpenAI spend is recorded
- [ ] Decide refund policy for:
  - [ ] quote paid but workflow never starts
  - [ ] job fails before model call
  - [ ] job fails after partial spend
- [ ] Add operator runbook for payment disputes
- [ ] Add alerts for margin below threshold

Exit check:

- [ ] One test for repeated paid retry
- [ ] One test for failed workflow after payment
- [ ] One test for outbound spend record

---

## Phase 4. Job reliability

Goal:

- jobs finish or fail cleanly
- restarts do not lose state

Checklist:

- [ ] Recheck recovery sweep rules
- [ ] Recheck workflow restart behavior
- [ ] Recheck blob read and write failure handling
- [ ] Recheck Turso retry behavior
- [ ] Recheck timeout behavior for long books
- [ ] Recheck quote expiry race cases
- [ ] Recheck duplicate upload and duplicate quote cases
- [ ] Add a hard cap for stuck polls
- [ ] Add clear terminal errors for clients
- [ ] Add replay-safe job event logging

Exit check:

- [ ] End-to-end success test passes
- [ ] Restart recovery test passes
- [ ] Blob missing test passes
- [ ] Quote expired test passes

---

## Phase 5. Security and abuse control

Goal:

- reduce easy abuse
- protect secrets and storage

Checklist:

- [ ] Review `MPP_SECRET_KEY` handling
- [ ] Review `TEMPO_PRIVATE_KEY` handling
- [ ] Confirm secrets are only server-side
- [ ] Confirm private Blob uploads stay private
- [ ] Add upload size guardrails
- [ ] Add MIME and extension checks
- [ ] Add rate limits for:
  - [ ] uploads
  - [ ] quotes
  - [ ] jobs
  - [ ] polling
- [ ] Add basic abuse logging
- [ ] Add request body size caps
- [ ] Add safe error messages with no secret leak
- [ ] Review retention policy for uploaded books and artifacts
- [ ] Add delete policy for old uploads, quotes, and artifacts

Exit check:

- [ ] Secret scan clean
- [ ] Oversized upload rejected
- [ ] Bad file type rejected
- [ ] Poll spam path rate-limited

---

## Phase 6. Ops and observability

Goal:

- let us see problems fast
- let us fix them fast

Checklist:

- [ ] Add structured logs for each request
- [ ] Add request id and job id to logs
- [ ] Add payment id or receipt ref to logs
- [ ] Add workflow run id to logs
- [ ] Add metrics for:
  - [ ] quote count
  - [ ] paid job count
  - [ ] job success rate
  - [ ] job failure rate
  - [ ] median job time
  - [ ] inbound money
  - [ ] outbound money
  - [ ] margin
- [ ] Add alerts for:
  - [ ] health failure
  - [ ] job failure spike
  - [ ] workflow backlog
  - [ ] storage failure
  - [ ] low margin
- [ ] Add an operator smoke script for production
- [ ] Write a rollback plan

Exit check:

- [ ] Can trace one job from upload to result
- [ ] Can trace one payment from quote to settle
- [ ] Smoke script passes on production

---

## Phase 7. Service polish

Goal:

- make the public service clear and stable

Checklist:

- [ ] Pick the final public service name
- [ ] Pick the final one-line description
- [ ] Pick final categories
- [ ] Pick final tags for registry search
- [ ] Add icon
- [ ] Add homepage copy for humans
- [ ] Add API reference page for agents
- [ ] Add status page or status section
- [ ] Add support contact
- [ ] Add terms and pricing notes if needed

Exit check:

- [ ] Service metadata is stable
- [ ] No placeholder names remain
- [ ] No MVP wording remains in public docs

---

## Phase 8. Registry listing

Goal:

- make the service discoverable in real tools

Checklist:

- [ ] Register on MPPScan
- [ ] Submit PR to `tempoxyz/mpp` for `mpp.dev/services`
- [ ] Add BookFold service metadata to the registry entry
- [ ] Add endpoint list and payment intent data
- [ ] Add docs links
- [ ] Add icon assets if needed
- [ ] Watch the PR until merged
- [ ] Confirm BookFold appears on `mpp.dev/services`
- [ ] Confirm BookFold appears on MPPScan
- [ ] Confirm `tempo wallet services --search bookfold` finds it
- [ ] Confirm `tempo wallet services <SERVICE_ID>` shows the right route info

Exit check:

```bash
tempo wallet -t services --search bookfold
tempo wallet -t services <SERVICE_ID>
```

Notes:

- This is the step that makes Tempo CLI discovery real.
- Based on current docs, this is a registry submit flow, not an onchain register call.

---

## Phase 9. Production launch gate

Goal:

- do one final go/no-go check

Checklist:

- [ ] All earlier phases done
- [ ] All required env vars set in production
- [ ] Production deploy is healthy
- [ ] Production smoke test passes
- [ ] Registry listing is live
- [ ] Billing path is verified with real funds
- [ ] Failure path is verified
- [ ] On-call owner is named
- [ ] Rollback plan is written
- [ ] Launch note is ready

Go/no-go rule:

- Go only if every box above is checked.

---

## Suggested work order

```text
1. discovery
2. llms/docs
3. money safety
4. reliability
5. security
6. observability
7. registry
8. launch gate
```

## Fastest path to first discoverability

If the goal is "show up in Tempo search" as fast as possible:

- [ ] add `/openapi.json`
- [ ] add `x-service-info`
- [ ] add `x-payment-info`
- [ ] add `/llms.txt`
- [ ] register on MPPScan
- [ ] submit PR to `tempoxyz/mpp`

This is not enough for full production readiness.
It is only enough for first discovery.

## Commands to keep handy

```bash
# local verify
bun run verify

# live checks
curl -fsSL https://bookfold.vercel.app/healthz
curl -fsSL https://bookfold.vercel.app/openapi.json
curl -fsSL https://bookfold.vercel.app/llms.txt

# discovery validation
npx mppx discover validate https://bookfold.vercel.app/openapi.json

# registry / cli checks
tempo wallet -t services --search bookfold
tempo wallet -t services <SERVICE_ID>
```

## Owner note

This doc is a release plan.

It is not the task tracker.

When work starts, move active items into the tracker and mark proof there.
