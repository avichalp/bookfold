# Bookfold

BookFold has two modes:

- local CLI
- hosted MPP server

It summarizes PDF and EPUB books.

The CLI parses on-device.
The hosted server accepts uploads, returns quotes, runs jobs, and serves results.

## features

CLI:

- local PDF and EPUB parsing
- deterministic `short`, `medium`, and `long` summary modes
- direct paid requests to `https://openai.mpp.tempo.xyz/v1/chat/completions`
- one Tempo session per summarize run
- manual recovery for interrupted runs with `recover`

Hosted server:

- direct upload to private Blob storage
- deterministic quote from a frozen summary plan
- paid job create over MPP
- async job execution with Vercel Workflow
- job state and payment records in Turso

## architecture

```text
CLI
  book file
    -> local parse
    -> local plan
    -> OpenAI MPP
    -> summary

Hosted API
  client
    -> POST /v1/uploads
    -> Blob PUT
    -> POST /v1/quotes
    -> POST /v1/jobs
    <- 402 challenge
    -> POST /v1/jobs (paid retry)
    -> GET /v1/jobs/:id

  server
    -> Blob
    -> Turso
    -> Vercel Workflow
    -> OpenAI MPP
```

## docs

- API: [docs/mpp-server-api.md](./docs/mpp-server-api.md)
- Deploy: [docs/mpp-server-deploy.md](./docs/mpp-server-deploy.md)
- Readiness: [docs/mpp-server-production-readiness-plan.md](./docs/mpp-server-production-readiness-plan.md)

## requirements

CLI:

- Node `22.x`
- a funded Tempo wallet
- `.pdf` or `.epub` input

Hosted server:

- Vercel
- Blob
- Turso
- a server Tempo wallet
- `MPP_SECRET_KEY`

limits and caveats:

- input file size limit: `50 MB`
- EPUB decompressed size limit: `500 MB`
- scanned or image-only PDFs are not supported
- DRM-protected EPUBs are rejected

wallet storage:

- macOS: `security`
- Linux: `secret-tool`
- other platforms: set `TEMPO_PRIVATE_KEY`

## install

CLI package:

```bash
npm install -g bookfold
bookfold --help
```

one-off runs without a global install:

```bash
bunx bookfold ./book.pdf
npx bookfold ./book.pdf
```

local development from a source checkout:

```bash
bun install
bun run link:bookfold
bookfold --help
```

local development without touching your global PATH:

```bash
bun install
bun run bookfold:dev --help
bun run bookfold:dev ./book.pdf
```

verification:

```bash
bun run verify
bun run build:vercel
```

## agent skill

- canonical skill file: `skills/bookfold/SKILL.md`
- install target for Codex-style agents: `~/.codex/skills/bookfold/SKILL.md`
- published GitHub path: `https://github.com/avichalp/bookfold/tree/main/skills/bookfold`

manual install:

```bash
mkdir -p ~/.codex/skills/bookfold
curl -L https://raw.githubusercontent.com/avichalp/bookfold/main/skills/bookfold/SKILL.md \
  -o ~/.codex/skills/bookfold/SKILL.md
```

restart Codex after installing the skill so the agent reloads it.

## setup

CLI wallet setup:

```bash
bookfold wallet init
bookfold wallet address
bookfold wallet balance
```

fund the printed address on Tempo Mainnet (chain id `4217`) with a USD-denominated Tempo fee token.

wallet lookup order:

1. `TEMPO_PRIVATE_KEY`
2. the app-owned secure-store entry `bookfold/default`
3. the current `mppx` default account

if no wallet exists and the CLI is interactive, `bookfold` will offer to create one during `summarize`.

Hosted server setup lives here:

- [docs/mpp-server-deploy.md](./docs/mpp-server-deploy.md)

## usage

CLI:

```bash
bookfold ./book.pdf
bookfold ./book.epub -d long
bookfold ./book.pdf --json
bookfold ./book.pdf --json --output ./summary.json
bookfold recover
bookfold wallet balance
```

from a source checkout, you can also use the packaged scripts:

```bash
bun run bookfold ./book.pdf
bun run bookfold:dev ./book.pdf
```

Hosted API flow:

```text
1. POST /v1/uploads
2. upload file to Blob
3. POST /v1/quotes
4. POST /v1/jobs
5. handle 402
6. retry POST /v1/jobs with payment
7. GET /v1/jobs/:id until done
```

## cli behavior

- passing a file path defaults to `summarize`
- `summarize` also has a short alias: `sum`
- short flags are available: `-d`, `-j`, `-o`, `-v`
- `summarize` defaults to `--detail medium`
- summary text or JSON goes to `stdout`
- progress, payment metadata, and file-write logs go to `stderr`
- `recover` exits non-zero for failed entries and wallet mismatches
- `wallet balance` shows the active Tempo wallet, the effective fee token balance, the `pathUSD` fallback balance, and `USDC`

## detail modes

- `short`: `gpt-4o-mini-2024-07-18`, target `150-300` words, single-pass for very small books, otherwise light map-reduce
- `medium`: `gpt-4o-2024-11-20`, target `500-900` words, map-reduce
- `long`: `gpt-4o-2024-11-20`, target `1200-1800` words, section-aware map-reduce

## sdk

```ts
import { summarizeBook } from '@bookfold/sdk';

const result = await summarizeBook({
  filePath: './book.pdf',
  detail: 'medium',
});
```

the SDK requires `detail`. the result includes:

- `summary`
- `metadata`
- `payment`
- `debug`
- `warnings`

other exported helpers:

- wallet: `createTempoWallet`, `resolveTempoWallet`, `formatWalletFundingMessage`, `getTempoWalletBalance`
- recovery: `recoverTempoSessions`
- planning: `buildSummaryPlan`, `hashSummaryPlan`, `serializeSummaryPlan`
- pricing: `DEFAULT_PRICE_SHEET`, `priceSummaryPlan`
- token counting: `countTextTokens`, `countPromptTokens`, `countPromptTokenBudget`
- parsing: `detectBookFileType`, `parseBookFromBuffer`, `parseBookFromFile`

`summarizeBook` always attempts to close the provider in a `finally` block. if summarization succeeds but session close fails, the result is still returned and the close failure is attached to `payment.closeError` and `warnings`.

server-facing SDK exports:

- `@bookfold/sdk/server`
- `DEFAULT_PRICE_SHEET`
- `priceSummaryPlan`
- `buildSummaryPlan`
- `hashSummaryPlan`
- `detectBookFileType`
- `parseBookFromBuffer`

## recovery

if a run dies after opening a channel, Bookfold stores minimal recovery metadata at:

```text
~/.bookfold/recovery.json
```

`recover` will:

1. try a cooperative close through the MPP service
2. request a forced close if needed
3. withdraw if the forced close is mature

## limits

CLI:

- one in-memory Tempo session per summarize run
- no OCR for scanned PDFs
- no DRM bypass for EPUBs

Hosted server:

- upload, quote, job-create, and job-read routes are rate-limited
- source books and summary artifacts are stored remotely
- async jobs run through Vercel Workflow
