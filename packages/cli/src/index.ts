#!/usr/bin/env node

import readline from 'node:readline';
import { realpathSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  createTempoWallet,
  getTempoWalletBalance,
  InvalidTempoWalletError,
  recoverTempoSessions,
  resolveTempoWallet,
  summarizeBook,
  type ProgressEvent,
  type RecoverTempoSessionsOptions,
  type SummarizeBookOptions,
  type SummaryResult,
  type TempoRecoveryProgressEvent,
  type TempoRecoveryReport,
  type TempoWalletBalanceReport,
  type TempoWalletInfo
} from '@bookfold/sdk';
import {
  formatFundingInstructions,
  formatLogLine,
  formatPaymentSummary,
  formatProgressDetail,
  formatRecoveryReport,
  formatUsage,
  formatWalletBalance,
  formatWalletInfo
} from './output.js';

interface Writer {
  isTTY?: boolean | undefined;
  write(chunk: string): void;
}

interface CliDependencies {
  summarize?: (options: SummarizeBookOptions) => Promise<SummaryResult>;
  recover?: (options?: RecoverTempoSessionsOptions) => Promise<TempoRecoveryReport>;
  resolveWallet?: () => TempoWalletInfo | undefined;
  createWallet?: (options?: { overwrite?: boolean | undefined }) => TempoWalletInfo;
  walletBalance?: () => Promise<TempoWalletBalanceReport>;
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

interface WalletBalanceArgs {
  command: 'wallet-balance';
}

interface RecoverArgs {
  command: 'recover';
  json: boolean;
  verbose: boolean;
}

type ParsedCliArgs =
  | SummarizeArgs
  | WalletInitArgs
  | WalletAddressArgs
  | WalletBalanceArgs
  | RecoverArgs;

const CLI_NAME = 'bookfold';
const TEMPO_NETWORK = 'Tempo Mainnet (4217)';
const TEMPO_EXPLORER = 'https://explore.tempo.xyz';

export async function runCli(argv: string[], dependencies: CliDependencies = {}): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const summarize = dependencies.summarize ?? summarizeBook;
  const recover = dependencies.recover ?? recoverTempoSessions;
  const resolveWallet = dependencies.resolveWallet ?? (() => resolveTempoWallet());
  const createWallet = dependencies.createWallet ?? ((options) => createTempoWallet(options));
  const walletBalance = dependencies.walletBalance ?? getTempoWalletBalance;
  const confirm = dependencies.confirm ?? ((message, defaultYes) => confirmPrompt(message, defaultYes));
  const isInteractive = dependencies.isInteractive ?? (() => Boolean(process.stdin.isTTY && process.stderr.isTTY));
  const stdoutOptions = { color: Boolean(stdout.isTTY) };
  const stderrOptions = { color: Boolean(stderr.isTTY) };
  const stdoutUsage = formatUsage(CLI_NAME, stdoutOptions);
  const stderrUsage = formatUsage(CLI_NAME, stderrOptions);

  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') {
    stdout.write(`${stdoutUsage}\n`);
    return 0;
  }

  let parsed: ParsedCliArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    stderr.write(
      `${formatLogLine('error', error instanceof Error ? error.message : String(error), stderrOptions)}\n\n${stderrUsage}\n`
    );
    return 1;
  }

  if (parsed.command === 'wallet-init') {
    try {
      let existing: TempoWalletInfo | undefined;
      try {
        existing = resolveWallet();
      } catch (error) {
        if (!(error instanceof InvalidTempoWalletError)) {
          throw error;
        }
      }
      if (existing && !parsed.force) {
        stdout.write(
          formatWalletInfo(existing, stdoutOptions, [
            ['Status', 'Existing wallet'],
            ['Network', TEMPO_NETWORK],
            ['Explorer', `${TEMPO_EXPLORER}/address/${existing.address}`]
          ])
        );
        stdout.write('\n');
        stdout.write(formatFundingInstructions(existing.address, stdoutOptions));
        return 0;
      }

      const created = createWallet({ overwrite: parsed.force });
      stdout.write(
        formatWalletInfo(created, stdoutOptions, [
          ['Status', parsed.force ? 'Recreated wallet' : 'Created wallet'],
          ['Network', TEMPO_NETWORK],
          ['Explorer', `${TEMPO_EXPLORER}/address/${created.address}`]
        ])
      );
      stdout.write('\n');
      stdout.write(formatFundingInstructions(created.address, stdoutOptions));
      return 0;
    } catch (error) {
      stderr.write(
        `${formatLogLine('error', error instanceof Error ? error.message : String(error), stderrOptions)}\n`
      );
      return 1;
    }
  }

  if (parsed.command === 'wallet-address') {
    const wallet = resolveWallet();
    if (!wallet) {
      stderr.write(
        `${formatLogLine(
          'error',
          `No Tempo wallet found. Run \`${CLI_NAME} wallet init\` or set TEMPO_PRIVATE_KEY.`,
          stderrOptions
        )}\n`
      );
      return 1;
    }

    stdout.write(
      formatWalletInfo(wallet, stdoutOptions, [
        ['Network', TEMPO_NETWORK],
        ['Explorer', `${TEMPO_EXPLORER}/address/${wallet.address}`]
      ])
    );
    return 0;
  }

  if (parsed.command === 'wallet-balance') {
    try {
      const report = await walletBalance();
      stdout.write(formatWalletBalance(report, stdoutOptions));
      return 0;
    } catch (error) {
      stderr.write(
        `${formatLogLine('error', error instanceof Error ? error.message : String(error), stderrOptions)}\n`
      );
      return 1;
    }
  }

  if (parsed.command === 'recover') {
    const logProgress = (event: TempoRecoveryProgressEvent) => {
      stderr.write(`${formatLogLine(event.step, event.message, stderrOptions)}\n`);
      if (parsed.verbose && event.detail) {
        stderr.write(`${formatProgressDetail(event.detail, stderrOptions)}\n`);
      }
    };

    try {
      const report = await recover({ onProgress: logProgress });
      stdout.write(
        parsed.json ? `${JSON.stringify(report, null, 2)}\n` : formatRecoveryReport(report, stdoutOptions)
      );
      return report.results.some(
        (result) => result.status === 'failed' || result.status === 'skipped-wallet-mismatch'
      )
        ? 1
        : 0;
    } catch (error) {
      stderr.write(
        `${formatLogLine('error', error instanceof Error ? error.message : String(error), stderrOptions)}\n`
      );
      return 1;
    }
  }

  const summarizeArgs = parsed;

  if (!resolveWallet()) {
    if (isInteractive()) {
      stderr.write(`${formatLogLine('wallet', 'No Tempo wallet found.', stderrOptions)}\n`);
      const shouldCreate = await confirm('Create a local Tempo wallet and store it in your system keychain?', true);
      if (!shouldCreate) {
        stderr.write(
          `${formatLogLine('error', `Canceled. Run \`${CLI_NAME} wallet init\` when you are ready.`, stderrOptions)}\n`
        );
        return 1;
      }

      try {
        const wallet = createWallet();
        stderr.write(
          formatWalletInfo(wallet, stderrOptions, [
            ['Status', 'Created wallet'],
            ['Network', TEMPO_NETWORK],
            ['Explorer', `${TEMPO_EXPLORER}/address/${wallet.address}`]
          ])
        );
        stderr.write('\n');
        stderr.write(formatFundingInstructions(wallet.address, stderrOptions));
      } catch (error) {
        stderr.write(
          `${formatLogLine('error', error instanceof Error ? error.message : String(error), stderrOptions)}\n`
        );
        return 1;
      }
    } else {
      stderr.write(
        `${formatLogLine(
          'error',
          `No Tempo wallet found. Run \`${CLI_NAME} wallet init\` or set TEMPO_PRIVATE_KEY.`,
          stderrOptions
        )}\n`
      );
      return 1;
    }
  }

  const logProgress = (event: ProgressEvent) => {
    stderr.write(`${formatLogLine(event.step, event.message, stderrOptions)}\n`);
    if (summarizeArgs.verbose && event.detail) {
      stderr.write(`${formatProgressDetail(event.detail, stderrOptions)}\n`);
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
      stderr.write(
        `${formatLogLine('write', `Wrote output to ${summarizeArgs.outputPath}`, stderrOptions)}\n`
      );
    } else {
      stdout.write(payload);
    }

    stderr.write(formatPaymentSummary(result, stderrOptions));

    if (summarizeArgs.verbose) {
      stderr.write(
        `${formatLogLine(
          'done',
          `detail=${result.detail} chunks=${result.debug.chunkCount} calls=${result.debug.modelCallCount} spent=${result.payment.spent}`,
          stderrOptions
        )}\n`
      );
    }

    if (result.payment.closeError) {
      stderr.write(`${formatLogLine('warning', result.payment.closeError, stderrOptions)}\n`);
      return 1;
    }

    return 0;
  } catch (error) {
    stderr.write(
      `${formatLogLine('error', error instanceof Error ? error.message : String(error), stderrOptions)}\n`
    );
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

function parseWalletArgs(argv: string[]): WalletInitArgs | WalletAddressArgs | WalletBalanceArgs {
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

  if (argv[0] === 'balance' || argv[0] === 'bal') {
    if (argv.length > 1) {
      throw new Error(`Unknown argument: ${argv[1]}`);
    }

    return { command: 'wallet-balance' };
  }

  throw new Error(
    'Expected `wallet init`, `wallet create`, `wallet address`, `wallet addr`, `wallet balance`, or `wallet bal`.'
  );
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

export async function main(): Promise<void> {
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
