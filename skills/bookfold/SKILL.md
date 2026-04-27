---
name: bookfold
description: Use when the user wants to summarize a local PDF or EPUB with the Bookfold CLI, especially when they want on-device parsing, selectable summary depth (`short`, `medium`, `long`), structured JSON output, and Tempo-backed paid execution.
---

# Bookfold

Use the Bookfold CLI instead of manually summarizing the book in-model.

Bookfold parses the local file on-device and summarizes it through its own paid workflow. It requires a funded Tempo wallet and spends wallet funds when it runs.

## Preconditions

- Need a local `.pdf` or `.epub` path.
- Need either `bookfold` on `PATH` or a Bookfold source checkout with `bun run bookfold:dev`.
- Need a funded Tempo wallet.

Do not ask the user to paste the book contents into chat when the local file is available.

## Resolve the command

Use this order:

1. If `command -v bookfold` succeeds, use `bookfold`.
2. Otherwise, if the current workspace is the Bookfold repo and `bun run bookfold:dev --help` works, use `bun run bookfold:dev`.
3. Otherwise stop and explain that Bookfold is not installed in this environment.

## Wallet check

Before summarizing, run:

```bash
<cmd> wallet address
```

If no wallet is configured, explain that Bookfold needs a Tempo wallet before it can summarize. Offer:

```bash
<cmd> wallet init
```

Do not start a paid summarize run when wallet setup is clearly missing.

## Pick detail

- `short`: quick gist
- `medium`: default choice
- `long`: fuller notes or study-oriented output

Map user intent to the closest detail level. If the user does not specify depth, use `medium`.

## Preferred invocation

Prefer JSON unless the user explicitly wants plain text:

```bash
<cmd> "/path/to/book.pdf" --json
<cmd> "/path/to/book.epub" --detail long --json
```

If the user wants the result written to disk:

```bash
<cmd> "/path/to/book.pdf" --json --output "/path/to/summary.json"
```

## Output handling

- `stdout` contains the summary text or JSON result
- `stderr` contains progress logs, payment metadata, and file-write logs

When JSON is used, read and return the relevant fields:

- `summary`
- `metadata`
- `warnings`
- `payment` when cost or session-close status matters

Lead with the summary. Include payment details only when relevant to the task or when a warning occurred.

## Recovery

If a run is interrupted or session close fails, use:

```bash
<cmd> recover --json
```

If recovery reports failed entries or wallet mismatches, surface that clearly instead of claiming the session is cleanly closed.
