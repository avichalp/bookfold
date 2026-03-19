#!/usr/bin/env node

import readline from 'node:readline';
import { realpathSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  createTempoWallet,
  formatWalletFundingMessage,
  recoverTempoSessions,
  resolveTempoWallet,
  summarizeBook,
  type RecoverTempoSessionsOptions,
  type TempoRecoveryProgressEvent,
  type TempoRecoveryReport,
  type TempoWalletInfo,
  type ProgressEvent,
  type SummarizeBookOptions,
  type SummaryResult
} from '@bookfold/sdk';

interface Writer {
  write(chunk: string): void;
}

interface CliDependencies {
  summarize?: (options: SummarizeBookOptions) => Promise<SummaryResult>;
  recover?: (options?: RecoverTempoSessionsOptions) => Promise<TempoRecoveryReport>;
  resolveWallet?: () => TempoWalletInfo | undefined;
  createWallet?: (options?: { overwrite?: boolean | undefined }) => TempoWalletInfo;
  confirm?: (message: string, defaultYes?: boolean) => Promise<boolean>;
  isInteractive?: () => boolean;
  stdout?: Writer;
  stderr?: Writer;
}

interface SummarizeArgs {
  command: 'summarize';
  filePath: string;
  detail: 'short' | 'medium' | 'long';
  json: boolean;
  outputPath?: string | undefined;
  verbose: boolean;
}

interface WalletInitArgs {
  command: 'wallet-init';
  force: boolean;
}

interface WalletAddressArgs {
  command: 'wallet-address';
}

interface RecoverArgs {
  command: 'recover';
  json: boolean;
  verbose: boolean;
}

type ParsedCliArgs = SummarizeArgs | WalletInitArgs | WalletAddressArgs | RecoverArgs;

const CLI_NAME = 'bookfold';
const USAGE = `Usage:
  ${CLI_NAME} <file> [-d short|medium|long] [-j] [-o <path>] [-v]
  ${CLI_NAME} summarize <file> [--detail short|medium|long] [--json] [--output <path>] [--verbose]
  ${CLI_NAME} recover [-j] [-v]
  ${CLI_NAME} wallet init [--force]
  ${CLI_NAME} wallet address

Examples:
  ${CLI_NAME} ./book.pdf
  ${CLI_NAME} ./book.epub -d long
  ${CLI_NAME} sum ./book.pdf -j -o ./summary.json
  ${CLI_NAME} recover
  ${CLI_NAME} wallet init
  ${CLI_NAME} wallet address`;

export async function runCli(argv: string[], dependencies: CliDependencies = {}): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const summarize = dependencies.summarize ?? summarizeBook;
  const recover = dependencies.recover ?? recoverTempoSessions;
  const resolveWallet = dependencies.resolveWallet ?? (() => resolveTempoWallet());
  const createWallet = dependencies.createWallet ?? ((options) => createTempoWallet(options));
  const confirm = dependencies.confirm ?? ((message, defaultYes) => confirmPrompt(message, defaultYes));
  const isInteractive = dependencies.isInteractive ?? (() => Boolean(process.stdin.isTTY && process.stderr.isTTY));

  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') {
    stdout.write(`${USAGE}\n`);
    return 0;
  }

  let parsed: ParsedCliArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}\n`);
    return 1;
  }

  if (parsed.command === 'wallet-init') {
    try {
      const existing = resolveWallet();
      if (existing && !parsed.force) {
        stdout.write(`${formatWalletInfo(existing)}\n`);
        return 0;
      }

      const created = createWallet({ overwrite: parsed.force });
      stdout.write(`${formatWalletInfo(created)}\n`);
      stdout.write(`${formatWalletFundingMessage(created.address)}\n`);
      return 0;
    } catch (error) {
      stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }

  if (parsed.command === 'wallet-address') {
    const wallet = resolveWallet();
    if (!wallet) {
      stderr.write(`No Tempo wallet found. Run \`${CLI_NAME} wallet init\` or set TEMPO_PRIVATE_KEY.\n`);
      return 1;
    }
    stdout.write(`${formatWalletInfo(wallet)}\n`);
    return 0;
  }

  if (parsed.command === 'recover') {
    const logProgress = (event: TempoRecoveryProgressEvent) => {
      stderr.write(`[${event.step}] ${event.message}\n`);
      if (parsed.verbose && event.detail) {
        stderr.write(`${JSON.stringify(event.detail)}\n`);
      }
    };

    try {
      const report = await recover({ onProgress: logProgress });
      stdout.write(parsed.json ? `${JSON.stringify(report, null, 2)}\n` : formatRecoveryReport(report));
      return report.results.some(
        (result) => result.status === 'failed' || result.status === 'skipped-wallet-mismatch'
      )
        ? 1
        : 0;
    } catch (error) {
      stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }

  const summarizeArgs = parsed;

  if (!resolveWallet()) {
    if (isInteractive()) {
      stderr.write('No Tempo wallet found.\n');
      const shouldCreate = await confirm('Create a local Tempo wallet and store it in your system keychain?', true);
      if (!shouldCreate) {
        stderr.write(`Canceled. Run \`${CLI_NAME} wallet init\` when you are ready.\n`);
        return 1;
      }

      try {
        const wallet = createWallet();
        stderr.write(`[wallet] Created ${wallet.address} (${wallet.source})\n`);
        stderr.write(`${formatWalletFundingMessage(wallet.address)}\n`);
      } catch (error) {
        stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
      }
    } else {
      stderr.write(`No Tempo wallet found. Run \`${CLI_NAME} wallet init\` or set TEMPO_PRIVATE_KEY.\n`);
      return 1;
    }
  }

  const logProgress = (event: ProgressEvent) => {
    stderr.write(`[${event.step}] ${event.message}\n`);
    if (summarizeArgs.verbose && event.detail) {
      stderr.write(`${JSON.stringify(event.detail)}\n`);
    }
  };

  try {
    const result = await summarize({
      filePath: summarizeArgs.filePath,
      detail: summarizeArgs.detail,
      onProgress: logProgress
    });

    const payload = summarizeArgs.json ? `${JSON.stringify(result, null, 2)}\n` : `${result.summary}\n`;

    if (summarizeArgs.outputPath) {
      await writeFile(summarizeArgs.outputPath, payload, 'utf8');
      stderr.write(`[write] Wrote output to ${summarizeArgs.outputPath}\n`);
    } else {
      stdout.write(payload);
    }

    stderr.write(formatPaymentSummary(result));

    if (summarizeArgs.verbose) {
      stderr.write(
        `[done] detail=${result.detail} chunks=${result.debug.chunkCount} calls=${result.debug.modelCallCount} spent=${result.payment.spent}\n`
      );
    }

    if (result.payment.closeError) {
      stderr.write(`[warning] ${result.payment.closeError}\n`);
      return 1;
    }

    return 0;
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function parseArgs(argv: string[]): ParsedCliArgs {
  if (argv[0] === 'recover') {
    return parseRecoverArgs(argv.slice(1));
  }

  if (argv[0] === 'wallet') {
    return parseWalletArgs(argv.slice(1));
  }

  if (argv[0] === 'summarize' || argv[0] === 'sum') {
    return parseSummarizeArgs(argv.slice(1));
  }

  if (findImplicitSummarizePath(argv)) {
    return parseSummarizeArgs(argv);
  }

  throw new Error('Expected <file>, `summarize`, `sum`, `recover`, or `wallet`.');
}

function findImplicitSummarizePath(argv: string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) {
      continue;
    }

    const detailOption = readOptionValue(argv, index, argument, '--detail', '-d', '--detail');
    if (detailOption) {
      index = detailOption.nextIndex;
      continue;
    }

    const outputOption = readOptionValue(argv, index, argument, '--output', '-o', '--output');
    if (outputOption) {
      index = outputOption.nextIndex;
      continue;
    }

    if (argument === '--json' || argument === '-j' || argument === '--verbose' || argument === '-v') {
      continue;
    }

    if (argument.startsWith('-')) {
      return undefined;
    }

    return looksLikeBookPath(argument) ? argument : undefined;
  }

  return undefined;
}

function looksLikeBookPath(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized.endsWith('.pdf') || normalized.endsWith('.epub');
}

function parseRecoverArgs(argv: string[]): RecoverArgs {
  let json = false;
  let verbose = false;

  for (const argument of argv) {
    if (argument === '--json' || argument === '-j') {
      json = true;
      continue;
    }

    if (argument === '--verbose' || argument === '-v') {
      verbose = true;
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  return {
    command: 'recover',
    json,
    verbose
  };
}

function parseWalletArgs(argv: string[]): WalletInitArgs | WalletAddressArgs {
  if (argv[0] === 'init' || argv[0] === 'create') {
    for (const argument of argv.slice(1)) {
      if (argument === '--force' || argument === '-f') {
        continue;
      }

      throw new Error(`Unknown argument: ${argument}`);
    }

    return {
      command: 'wallet-init',
      force: argv.includes('--force') || argv.includes('-f')
    };
  }

  if (argv[0] === 'address' || argv[0] === 'addr') {
    if (argv.length > 1) {
      throw new Error(`Unknown argument: ${argv[1]}`);
    }

    return { command: 'wallet-address' };
  }

  throw new Error('Expected `wallet init`, `wallet create`, `wallet address`, or `wallet addr`.');
}

function parseSummarizeArgs(argv: string[]): SummarizeArgs {
  let filePath: string | undefined;
  let detail: SummarizeArgs['detail'] = 'medium';
  let json = false;
  let verbose = false;
  let outputPath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) {
      continue;
    }

    const detailOption = readOptionValue(argv, index, argument, '--detail', '-d', '--detail');
    if (detailOption) {
      detail = parseDetail(detailOption.value);
      index = detailOption.nextIndex;
      continue;
    }

    const outputOption = readOptionValue(argv, index, argument, '--output', '-o', '--output');
    if (outputOption) {
      outputPath = outputOption.value;
      index = outputOption.nextIndex;
      continue;
    }

    if (argument === '--json' || argument === '-j') {
      json = true;
      continue;
    }

    if (argument === '--verbose' || argument === '-v') {
      verbose = true;
      continue;
    }

    if (argument.startsWith('-')) {
      throw new Error(`Unknown argument: ${argument}`);
    }

    if (filePath) {
      throw new Error(`Unexpected argument: ${argument}`);
    }

    filePath = argument;
  }

  if (!filePath) {
    throw new Error('Missing <file> argument.');
  }

  return {
    command: 'summarize',
    filePath,
    detail,
    json,
    outputPath,
    verbose
  };
}

function readOptionValue(
  argv: string[],
  index: number,
  argument: string,
  longFlag: string,
  shortFlag: string,
  label: string
): { value: string; nextIndex: number } | undefined {
  if (argument === longFlag || argument === shortFlag) {
    const value = argv[index + 1];
    if (!value || value.startsWith('-')) {
      throw new Error(`\`${label}\` requires a value.`);
    }

    return {
      value,
      nextIndex: index + 1
    };
  }

  if (argument.startsWith(`${longFlag}=`)) {
    return {
      value: argument.slice(longFlag.length + 1),
      nextIndex: index
    };
  }

  if (argument.startsWith(`${shortFlag}=`)) {
    return {
      value: argument.slice(shortFlag.length + 1),
      nextIndex: index
    };
  }

  return undefined;
}

function parseDetail(value: string): SummarizeArgs['detail'] {
  if (value !== 'short' && value !== 'medium' && value !== 'long') {
    throw new Error('`--detail` must be one of: short, medium, long.');
  }

  return value;
}

function formatWalletInfo(wallet: TempoWalletInfo): string {
  return `Wallet ${wallet.address} (source=${wallet.source})`;
}

function formatRecoveryReport(report: TempoRecoveryReport): string {
  const lines = [`Recovery store: ${report.storePath}`];

  if (report.results.length === 0) {
    lines.push('No recoverable Tempo sessions found.');
    return `${lines.join('\n')}\n`;
  }

  for (const result of report.results) {
    const parts = [`${result.status} ${result.channelId}`];
    if (result.txHash) {
      parts.push(`tx=${result.txHash}`);
    }
    if (result.unlockAt) {
      parts.push(`unlockAt=${result.unlockAt}`);
    }
    lines.push(parts.join(' '));
    if (result.error) {
      lines.push(`error: ${result.error}`);
    }
  }

  lines.push(`Remaining recoverable channels: ${report.remainingChannels}`);
  return `${lines.join('\n')}\n`;
}

function formatPaymentSummary(result: SummaryResult): string {
  const parts = [`spent=${result.payment.spent}`, `cumulative=${result.payment.cumulative}`];
  if (result.payment.channelId) {
    parts.push(`channel=${result.payment.channelId}`);
  }

  let output = `[payment] ${parts.join(' ')}\n`;

  const receipt = result.payment.finalReceipt ?? result.payment.lastReceipt;
  if (receipt) {
    const receiptParts: string[] = [];
    if (typeof receipt.reference === 'string') {
      receiptParts.push(`reference=${receipt.reference}`);
    }
    if (typeof receipt.txHash === 'string') {
      receiptParts.push(`txHash=${receipt.txHash}`);
    }
    if (typeof receipt.challengeId === 'string') {
      receiptParts.push(`challengeId=${receipt.challengeId}`);
    }

    if (receiptParts.length > 0) {
      output += `[receipt] ${receiptParts.join(' ')}\n`;
    }
  }

  return output;
}

async function confirmPrompt(message: string, defaultYes = false): Promise<boolean> {
  const reader = readline.createInterface({
    input: process.stdin,
    output: process.stderr
  });

  const hint = defaultYes ? '[Y/n]' : '[y/N]';

  return new Promise((resolve) => {
    reader.question(`${message} ${hint} `, (answer) => {
      reader.close();
      const normalized = answer.trim().toLowerCase();
      if (!normalized) {
        resolve(defaultYes);
        return;
      }
      resolve(normalized === 'y' || normalized === 'yes');
    });
  });
}

async function main(): Promise<void> {
  try {
    const exitCode = await runCli(process.argv.slice(2));
    process.exitCode = exitCode;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1]) {
  const entryPoint = process.argv[1];
  let entryUrl = pathToFileURL(entryPoint).href;

  try {
    entryUrl = pathToFileURL(realpathSync(entryPoint)).href;
  } catch {
    // Fall back to the argv path when the real path cannot be resolved.
  }

  if (import.meta.url === entryUrl) {
    void main();
  }
}
