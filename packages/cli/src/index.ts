#!/usr/bin/env node

import readline from 'node:readline';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  createTempoWallet,
  formatWalletFundingMessage,
  recoverTempoSessions,
  resolveTempoWallet,
  summarizeBook,
  type TempoRecoveryProgressEvent,
  type TempoRecoveryReport,
  type TempoWalletInfo,
  type ProgressEvent,
  type SummaryResult
} from '@bookfold/sdk';

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
  ${CLI_NAME} summarize <file> [--detail short|medium|long] [--json] [--output <path>] [--verbose]
  ${CLI_NAME} recover [--json] [--verbose]
  ${CLI_NAME} wallet init [--force]
  ${CLI_NAME} wallet address

Examples:
  ${CLI_NAME} summarize ./book.pdf
  ${CLI_NAME} summarize ./book.epub --detail long
  ${CLI_NAME} summarize ./book.pdf --json --output ./summary.json
  ${CLI_NAME} recover
  ${CLI_NAME} wallet init
  ${CLI_NAME} wallet address`;

export async function runCli(argv: string[]): Promise<number> {
  const stdout = process.stdout;
  const stderr = process.stderr;
  if (argv.includes('--help') || argv.includes('-h')) {
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
      const existing = resolveTempoWallet();
      if (existing && !parsed.force) {
        stdout.write(`${formatWalletInfo(existing)}\n`);
        return 0;
      }

      const created = createTempoWallet({ overwrite: parsed.force });
      stdout.write(`${formatWalletInfo(created)}\n`);
      stdout.write(`${formatWalletFundingMessage(created.address)}\n`);
      return 0;
    } catch (error) {
      stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }

  if (parsed.command === 'wallet-address') {
    const wallet = resolveTempoWallet();
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
      const report = await recoverTempoSessions({ onProgress: logProgress });
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

  if (!resolveTempoWallet()) {
    if (process.stdin.isTTY && process.stderr.isTTY) {
      stderr.write('No Tempo wallet found.\n');
      const shouldCreate = await confirmPrompt(
        'Create a local Tempo wallet and store it in your system keychain?',
        true
      );
      if (!shouldCreate) {
        stderr.write(`Canceled. Run \`${CLI_NAME} wallet init\` when you are ready.\n`);
        return 1;
      }

      try {
        const wallet = createTempoWallet();
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
    const result = await summarizeBook({
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
    let json = false;
    let verbose = false;

    for (let index = 1; index < argv.length; index += 1) {
      const argument = argv[index];

      if (argument === '--json') {
        json = true;
        continue;
      }

      if (argument === '--verbose') {
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

  if (argv[0] === 'wallet') {
    if (argv[1] === 'init') {
      return {
        command: 'wallet-init',
        force: argv.includes('--force')
      };
    }

    if (argv[1] === 'address') {
      return { command: 'wallet-address' };
    }

    throw new Error('Expected `wallet init` or `wallet address`.');
  }

  if (argv[0] !== 'summarize') {
    throw new Error('Expected `summarize`, `recover`, or `wallet`.');
  }

  const filePath = argv[1];
  if (!filePath || filePath.startsWith('-')) {
    throw new Error('Missing <file> argument.');
  }

  let detail: SummarizeArgs['detail'] = 'medium';
  let json = false;
  let verbose = false;
  let outputPath: string | undefined;

  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === '--detail') {
      const value = argv[index + 1];
      if (value !== 'short' && value !== 'medium' && value !== 'long') {
        throw new Error('`--detail` must be one of: short, medium, long.');
      }
      detail = value;
      index += 1;
      continue;
    }

    if (argument === '--json') {
      json = true;
      continue;
    }

    if (argument === '--verbose') {
      verbose = true;
      continue;
    }

    if (argument === '--output') {
      const value = argv[index + 1];
      if (!value || value.startsWith('-')) {
        throw new Error('`--output` requires a file path.');
      }
      outputPath = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
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
  const exitCode = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
