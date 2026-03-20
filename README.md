# Bookfold

local book summaries for PDF and EPUB. parse on-device, summarize through OpenAI's MPP endpoint, pay through Tempo, print locally, and close the session when the run ends.

## features

- local PDF and EPUB parsing
- deterministic chunking with `short`, `medium`, and `long` summary modes
- direct paid requests to `https://openai.mpp.tempo.xyz/v1/chat/completions`
- one Tempo session per summarize run
- manual recovery for interrupted runs with `recover`

## requirements

- Node `>=22.6.0`
- a funded Tempo wallet
- `.pdf` or `.epub` input

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

published package:

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
```

## agent skill

- canonical skill file: `skills/bookfold/SKILL.md`
- install target for Codex-style agents: `~/.codex/skills/bookfold/SKILL.md`
- published GitHub path: `https://github.com/avichalp/bookfold/tree/main/skills/bookfold`

install with Skills CLI:

```bash
npx skills add https://github.com/avichalp/bookfold --skill bookfold -g -y
```

manual install:

```bash
mkdir -p ~/.codex/skills/bookfold
curl -L https://raw.githubusercontent.com/avichalp/bookfold/main/skills/bookfold/SKILL.md \
  -o ~/.codex/skills/bookfold/SKILL.md
```

restart Codex after installing the skill so the agent reloads it.

## setup

initialize a wallet:

```bash
bookfold wallet init
bookfold wallet address
```

fund the printed address on Tempo Mainnet (chain id `4217`) with a USD-denominated Tempo fee token.

wallet lookup order:

1. `TEMPO_PRIVATE_KEY`
2. the app-owned secure-store entry `bookfold/default`
3. the current `mppx` default account

if no wallet exists and the CLI is interactive, `bookfold` will offer to create one during `summarize`.

## usage

once `bookfold` is installed globally or linked from this repo:

```bash
bookfold ./book.pdf
bookfold ./book.epub -d long
bookfold ./book.pdf --json
bookfold ./book.pdf --json --output ./summary.json
bookfold recover
```

from a source checkout, you can also use the packaged scripts:

```bash
bun run bookfold ./book.pdf
bun run bookfold:dev ./book.pdf
```

## CLI behavior

- passing a file path defaults to `summarize`
- `summarize` also has a short alias: `sum`
- short flags are available: `-d`, `-j`, `-o`, `-v`
- `summarize` defaults to `--detail medium`
- summary text or JSON goes to `stdout`
- progress, payment metadata, and file-write logs go to `stderr`
- `recover` exits non-zero for failed entries and wallet mismatches

## detail modes

- `short`: `gpt-4o-mini`, target `150-300` words, single-pass for very small books, otherwise light map-reduce
- `medium`: `gpt-4o`, target `500-900` words, map-reduce
- `long`: `gpt-4o`, target `1200-1800` words, section-aware map-reduce

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

- wallet: `createTempoWallet`, `resolveTempoWallet`, `formatWalletFundingMessage`
- recovery: `recoverTempoSessions`

`summarizeBook` always attempts to close the provider in a `finally` block. if summarization succeeds but session close fails, the result is still returned and the close failure is attached to `payment.closeError` and `warnings`.

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

- local CLI only
- one in-memory Tempo session per summarize run
- no OCR for scanned PDFs
- no DRM bypass for EPUBs
