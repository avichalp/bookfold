# summ-tempo

`summ-tempo` is a local CLI-first book summarizer. It reads a local PDF or EPUB, parses it on-device, orchestrates summarization locally, pays OpenAI's MPP endpoint directly through a Tempo session, prints the summary locally, and closes the session at the end of the run.

This repo intentionally has no server, no web app, and no product persistence. The only local state outside the system keychain is minimal manual-recovery metadata in `~/.summ-tempo/recovery.json`.

## Architecture

The repo is split into exactly two packages:

- `packages/sdk`
  - all real logic
  - local PDF parsing
  - local EPUB parsing
  - deterministic chunking
  - summarization orchestration
  - Tempo session management
  - OpenAI MPP provider
- `packages/cli`
  - thin wrapper around the SDK
  - argument parsing
  - stdout/stderr formatting
  - optional output file writing

## Hardcoded Configuration

These defaults live in source code in [`packages/sdk/src/config.ts`](/Users/avichalpandey/work/summ-tempo/packages/sdk/src/config.ts):

- OpenAI MPP base URL: `https://openai.mpp.tempo.xyz`
- OpenAI endpoint path: `POST /v1/chat/completions`
- Tempo max deposit: `"1"`
- File size limit: `50 MB`
- EPUB decompressed size limit: `500 MB`
- Request timeout: `120000 ms`
- Map concurrency: `3`
- Prompt version: `summ-tempo-v1`

Detail profiles:

- `short`
  - model: `gpt-4o-mini`
  - target: `150-300` words
  - strategy: single-pass when the book is small enough, otherwise light map-reduce
- `medium`
  - model: `gpt-4o`
  - target: `500-900` words
  - strategy: map-reduce
- `long`
  - model: `gpt-4o`
  - target: `1200-1800` words
  - strategy: section-aware map-reduce

## Environment Variables

Normal CLI usage does not require any env var. On first run, `summ-tempo` can create a Tempo wallet locally and store it in the system keychain, then reuse it automatically on later runs.

Optional override:

- `TEMPO_PRIVATE_KEY`

`TEMPO_RPC_URL` is not required by the current implementation and is not used.

## Install

```bash
npm install
```

## Build

```bash
npm run build
```

## Test

```bash
npm test
npm run typecheck
```

## Run

Build first, then run the CLI from the repo root:

```bash
node packages/cli/dist/index.js summarize ./path/to/book.pdf
```

Examples:

```bash
node packages/cli/dist/index.js wallet init
node packages/cli/dist/index.js wallet address
node packages/cli/dist/index.js recover
node packages/cli/dist/index.js summarize ./book.pdf
node packages/cli/dist/index.js summarize ./book.epub --detail long
node packages/cli/dist/index.js summarize ./book.pdf --json
node packages/cli/dist/index.js summarize ./book.pdf --json --output ./summary.json
node packages/cli/dist/index.js summarize ./book.epub --detail short --output ./summary.txt
```

Development-time invocation without building:

```bash
npx tsx packages/cli/src/index.ts summarize ./book.pdf
```

## CLI Behavior

- summary output goes to `stdout`
- progress and logs go to `stderr`
- `--json` writes structured JSON to `stdout`
- `--output` writes the summary or JSON payload to a file and keeps logs on `stderr`

Supported flags:

- `--detail <short|medium|long>`
- `--json`
- `--output <path>`
- `--verbose`

Wallet commands:

- `wallet init`
- `wallet init --force`
- `wallet address`

Recovery command:

- `recover`
- `recover --json`
- `recover --verbose`

## SDK API

Public SDK entrypoints live in [`packages/sdk/src/index.ts`](/Users/avichalpandey/work/summ-tempo/packages/sdk/src/index.ts).

Primary API:

```ts
import { summarizeBook } from '@summ-tempo/sdk'

const result = await summarizeBook({
  filePath: './book.pdf',
  detail: 'medium',
})
```

Returned shape:

```ts
type SummaryResult = {
  summary: string
  detail: 'short' | 'medium' | 'long'
  metadata: {
    title?: string
    author?: string
    fileType: 'pdf' | 'epub'
    pageCount?: number
    chapterCount?: number
  }
  payment: {
    provider: 'openai-mpp' | 'mock'
    baseUrl?: string
    endpointPath?: string
    maxDeposit?: string
    spent: string
    cumulative: string
    channelId?: string
    finalReceipt?: Record<string, unknown>
    lastReceipt?: Record<string, unknown>
    closeError?: string
    requestCount?: number
  }
  debug: {
    chunkCount: number
    modelCallCount: number
    modelNames: string[]
    strategy?: string
    sectionCount?: number
  }
  warnings?: string[]
}
```

## Payment Flow

Each `summarize` run creates one in-memory Tempo session and reuses it across all OpenAI calls for that run.

High level flow:

1. CLI starts a summarize run.
2. If no wallet exists, the CLI offers to create one and stores it in the OS keychain.
3. SDK parses the local PDF or EPUB.
4. SDK orchestrates summarization locally.
5. `OpenAiMppProvider` sends requests directly to `https://openai.mpp.tempo.xyz/v1/chat/completions`.
6. `mppx` handles the Tempo session challenge and voucher flow.
7. The SDK closes the Tempo session in a `finally` block.
8. The CLI prints the summary plus payment metadata.

## Manual Recovery

If the process terminates abnormally after opening a Tempo channel, `summ-tempo` keeps minimal recovery metadata in:

```text
~/.summ-tempo/recovery.json
```

Stored fields are limited to the channel id, last accepted cumulative amount, request URL/kind, payer address, chain id, escrow contract, fee token, and timestamps. The CLI does not try to recover automatically during `summarize`; recovery is manual so summary runs are not delayed.

Use:

```bash
node packages/cli/dist/index.js recover
node packages/cli/dist/index.js recover --json
```

Recovery behavior:

1. Try a cooperative close through the OpenAI MPP service using the stored channel metadata.
2. If cooperative close fails and the channel is still open, request a forced close on-chain.
3. If a forced close is already mature, withdraw the refund and remove the recovery entry.

## Sample JSON Output

```json
{
  "summary": "…",
  "detail": "medium",
  "metadata": {
    "title": "Example Book",
    "author": "Author Name",
    "fileType": "pdf",
    "pageCount": 212
  },
  "payment": {
    "provider": "openai-mpp",
    "baseUrl": "https://openai.mpp.tempo.xyz",
    "endpointPath": "/v1/chat/completions",
    "maxDeposit": "1",
    "spent": "0.00",
    "cumulative": "0.00",
    "channelId": "0x...",
    "finalReceipt": {
      "method": "tempo",
      "intent": "session",
      "status": "success"
    },
    "requestCount": 5
  },
  "debug": {
    "chunkCount": 42,
    "modelCallCount": 5,
    "modelNames": ["gpt-4o"]
  }
}
```

## Live Verification

Live payment verification is possible once the keychain wallet or `TEMPO_PRIVATE_KEY` is funded. The exact commands to run are:

```bash
node packages/cli/dist/index.js wallet init
node packages/cli/dist/index.js recover
node packages/cli/dist/index.js summarize ./path/to/small.pdf --detail short
node packages/cli/dist/index.js summarize ./path/to/small.epub --detail short --json
```

For a minimal one-call provider check before a full summarize run:

```bash
npx tsx -e "import { OpenAiMppProvider } from './packages/sdk/src/provider/openai-mpp.ts'; void (async () => { const provider = new OpenAiMppProvider(); const result = await provider.generateText({ model: 'gpt-4o-mini', messages: [{ role: 'system', content: 'You are concise.' }, { role: 'user', content: 'Reply with the word ok.' }], maxOutputTokens: 16 }); console.log(result); await provider.close(); })();"
```

## Known Limitations

- local CLI only
- one in-memory Tempo session per run
- abnormal termination may leave a session/channel needing manual recovery with `summ-tempo recover`
- no saved summaries or session persistence; only minimal recovery metadata is written to `~/.summ-tempo/recovery.json`
- no chat
- no embeddings or vector search
