import {
  formatWalletFundingMessage,
  type SummaryResult,
  type TempoRecoveryReport,
  type TempoWalletBalanceReport,
  type TempoWalletInfo
} from '@bookfold/sdk';

interface OutputOptions {
  color?: boolean | undefined;
}

type OutputField = readonly [label: string, value: string | undefined];

const ANSI = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  cyan: '\u001b[36m',
  dim: '\u001b[2m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  red: '\u001b[31m'
} as const;

function paint(text: string, open: string, options: OutputOptions): string {
  if (!options.color) {
    return text;
  }

  return `${open}${text}${ANSI.reset}`;
}

function renderHeading(title: string, options: OutputOptions): string {
  return [
    paint(title, `${ANSI.bold}${ANSI.cyan}`, options),
    paint('-'.repeat(title.length), ANSI.dim, options)
  ].join('\n');
}

function renderFields(fields: ReadonlyArray<OutputField>, options: OutputOptions): string {
  const visibleFields = fields.filter(([, value]) => value !== undefined);
  const width = visibleFields.reduce((max, [label]) => Math.max(max, label.length), 0);

  return visibleFields
    .map(([label, value]) => `${paint(label.padEnd(width), ANSI.dim, options)}  ${value}`)
    .join('\n');
}

function renderSection(
  title: string,
  fields: ReadonlyArray<OutputField>,
  options: OutputOptions
): string {
  return `${renderHeading(title, options)}\n${renderFields(fields, options)}`;
}

function renderParagraphSection(
  title: string,
  lines: ReadonlyArray<string>,
  options: OutputOptions
): string {
  return `${renderHeading(title, options)}\n${lines.join('\n')}`;
}

function trimDecimal(value: string): string {
  if (!value.includes('.')) {
    return value;
  }

  return value.replace(/\.0+$|(\.\d*?)0+$/, '$1');
}

function formatDecimalUnits(value: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals <= 0) {
    return value.toString();
  }

  const sign = value < 0n ? '-' : '';
  const absoluteValue = value < 0n ? -value : value;
  const divisor = 10n ** BigInt(decimals);
  const whole = absoluteValue / divisor;
  const fraction = absoluteValue % divisor;

  if (fraction === 0n) {
    return `${sign}${whole.toString()}`;
  }

  const fractionText = fraction.toString().padStart(decimals, '0');
  return `${sign}${whole.toString()}.${fractionText}`;
}

function formatAtomicAmount(value: string, decimals: number, symbol: string): string {
  try {
    return `${trimDecimal(formatDecimalUnits(BigInt(value), decimals))} ${symbol}`.trim();
  } catch {
    return `${value} ${symbol}`.trim();
  }
}

function formatWalletSource(source: TempoWalletInfo['source']): string {
  switch (source) {
    case 'env':
      return 'TEMPO_PRIVATE_KEY';
    case 'app':
      return 'Bookfold secure store';
    case 'mppx':
      return 'mppx default account';
    default:
      return source;
  }
}

function titleCase(value: string): string {
  return value
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatStatus(status: string, options: OutputOptions): string {
  const label = titleCase(status);

  if (status === 'recovered') {
    return paint(label, ANSI.green, options);
  }

  if (status === 'failed') {
    return paint(label, ANSI.red, options);
  }

  if (status.startsWith('skipped') || status.startsWith('pending')) {
    return paint(label, ANSI.yellow, options);
  }

  return label;
}

function formatEffectiveFeeTokenSource(
  source: TempoWalletBalanceReport['effectiveFeeTokenSource']
): string {
  return source === 'account-preference' ? 'Account preference' : 'pathUSD fallback';
}

function truncateText(value: string, maxLength: number): string {
  if (maxLength <= 0) {
    return '';
  }

  if (value.length <= maxLength) {
    return value;
  }

  if (maxLength <= 3) {
    return '.'.repeat(maxLength);
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

export function formatUsage(cliName: string, options: OutputOptions = {}): string {
  return [
    renderHeading('Bookfold CLI', options),
    '',
    'Usage:',
    `  ${cliName} <file> [-d short|medium|long] [-j] [-o <path>] [-v]`,
    `  ${cliName} summarize <file> [--detail short|medium|long] [--json] [--output <path>] [--verbose]`,
    `  ${cliName} recover [-j] [-v]`,
    `  ${cliName} wallet init [--force]`,
    `  ${cliName} wallet address`,
    `  ${cliName} wallet balance`,
    '',
    'Examples:',
    `  ${cliName} ./book.pdf`,
    `  ${cliName} ./book.epub -d long`,
    `  ${cliName} sum ./book.pdf -j -o ./summary.json`,
    `  ${cliName} recover`,
    `  ${cliName} wallet init`,
    `  ${cliName} wallet address`,
    `  ${cliName} wallet balance`
  ].join('\n');
}

export function formatWalletInfo(
  wallet: TempoWalletInfo,
  options: OutputOptions = {},
  extraFields: ReadonlyArray<OutputField> = []
): string {
  return `${renderSection(
    'Wallet',
    [
      ['Address', wallet.address],
      ['Source', formatWalletSource(wallet.source)],
      ...extraFields
    ],
    options
  )}\n`;
}

export function formatWalletBalance(
  report: TempoWalletBalanceReport,
  options: OutputOptions = {}
): string {
  const sections = [
    renderSection(
      'Wallet',
      [
        ['Address', report.wallet.address],
        ['Source', formatWalletSource(report.wallet.source)],
        ['Network', `${report.chainName} (${report.chainId})`],
        [
          'Explorer',
          report.explorerUrl ? `${report.explorerUrl}/address/${report.wallet.address}` : undefined
        ]
      ],
      options
    ),
    renderSection(
      'Balance',
      [
        [
          'Effective fee token',
          formatAtomicAmount(
            report.effectiveFeeTokenBalance.amount,
            report.effectiveFeeTokenBalance.decimals,
            report.effectiveFeeTokenBalance.symbol
          )
        ],
        ['Fee token source', formatEffectiveFeeTokenSource(report.effectiveFeeTokenSource)],
        [
          'Account preference',
          report.preferredFeeTokenBalance
            ? formatAtomicAmount(
                report.preferredFeeTokenBalance.amount,
                report.preferredFeeTokenBalance.decimals,
                report.preferredFeeTokenBalance.symbol
              )
            : 'Not configured'
        ],
        [
          'pathUSD fallback',
          formatAtomicAmount(
            report.pathUsdBalance.amount,
            report.pathUsdBalance.decimals,
            report.pathUsdBalance.symbol
          )
        ],
        ['USDC', report.usdcBalance ? formatAtomicAmount(report.usdcBalance.amount, report.usdcBalance.decimals, report.usdcBalance.symbol) : 'Unavailable']
      ],
      options
    )
  ];

  if (report.preferredFeeTokenBalance) {
    sections.push(
      renderSection(
        'Fee Token',
        [
          ['Name', report.preferredFeeTokenBalance.name],
          ['Address', report.preferredFeeTokenBalance.tokenAddress],
          ['Token ID', report.preferredFeeTokenBalance.tokenId]
        ],
        options
      )
    );
  }

  return `${sections.join('\n\n')}\n`;
}

export function formatFundingInstructions(address: string, options: OutputOptions = {}): string {
  const lines = formatWalletFundingMessage(address).split('\n');
  const guidance = lines.slice(1).join(' ').trim() || lines[0] || 'Fund this wallet on Tempo Mainnet.';

  return `${renderParagraphSection('Funding', [guidance], options)}\n`;
}

export function formatRecoveryReport(
  report: TempoRecoveryReport,
  options: OutputOptions = {}
): string {
  const sections = [
    renderSection(
      'Recovery',
      [
        ['Store', report.storePath],
        ['Remaining channels', String(report.remainingChannels)]
      ],
      options
    )
  ];

  if (report.results.length === 0) {
    sections.push(renderParagraphSection('Results', ['No recoverable Tempo sessions found.'], options));
    return `${sections.join('\n\n')}\n`;
  }

  const resultLines = report.results.flatMap((result) => {
    const details = [result.channelId];
    if (result.txHash) {
      details.push(`tx=${result.txHash}`);
    }
    if (result.unlockAt) {
      details.push(`unlockAt=${result.unlockAt}`);
    }

    const lines = [`${formatStatus(result.status, options)}  ${details.join(' ')}`];
    if (result.error) {
      lines.push(`${paint('error', ANSI.dim, options)}  ${result.error}`);
    }
    return lines;
  });

  sections.push(renderParagraphSection('Results', resultLines, options));
  return `${sections.join('\n\n')}\n`;
}

export function formatPaymentSummary(
  result: SummaryResult,
  options: OutputOptions = {}
): string {
  const receipt = result.payment.finalReceipt ?? result.payment.lastReceipt;
  const fields: OutputField[] = [
    ['Spent', formatAtomicAmount(result.payment.spent, 6, 'USD')],
    ['Cumulative', formatAtomicAmount(result.payment.cumulative, 6, 'USD')],
    ['Channel', result.payment.channelId]
  ];

  if (receipt && typeof receipt.reference === 'string') {
    fields.push(['Reference', receipt.reference]);
  }

  if (receipt && typeof receipt.txHash === 'string') {
    fields.push(['Tx hash', receipt.txHash]);
  }

  if (receipt && typeof receipt.challengeId === 'string') {
    fields.push(['Challenge', receipt.challengeId]);
  }

  return `${renderSection('Payment', fields, options)}\n`;
}

export function formatLogLine(
  tag: string,
  message: string,
  options: OutputOptions = {}
): string {
  const label = `[${titleCase(tag)}]`;
  const tone =
    tag === 'warning' ? ANSI.yellow : tag === 'error' ? ANSI.red : tag === 'done' ? ANSI.green : ANSI.cyan;

  return `${paint(label, tone, options)} ${message}`;
}

export function formatProgressBar(args: {
  completed: number;
  total: number;
  message: string;
  width?: number | undefined;
  maxWidth?: number | undefined;
}): string {
  const total = Math.max(1, args.total);
  const completed = Math.min(Math.max(0, args.completed), total);
  const ratio = completed / total;
  const percent = `${String(Math.round(ratio * 100)).padStart(3, ' ')}%`;
  const count = `${completed}/${total}`;
  const buildPrefix = (barWidth: number): string => {
    if (barWidth <= 0) {
      return `${percent} ${count}`;
    }

    const filled = Math.min(barWidth, Math.round(ratio * barWidth));
    const bar = `${'#'.repeat(filled)}${'-'.repeat(barWidth - filled)}`;
    return `[${bar}] ${percent} ${count}`;
  };

  const requestedWidth =
    args.maxWidth === undefined ? Math.max(10, args.width ?? 20) : Math.max(1, args.width ?? 20);
  let prefix = buildPrefix(requestedWidth);

  if (args.maxWidth !== undefined && prefix.length > args.maxWidth) {
    const compactPrefix = buildPrefix(0);
    if (compactPrefix.length > args.maxWidth) {
      prefix = truncateText(percent.trimStart(), args.maxWidth);
    } else {
      const prefixOverhead = buildPrefix(1).length - 1;
      const clampedBarWidth = Math.max(1, Math.min(requestedWidth, args.maxWidth - prefixOverhead));
      prefix = buildPrefix(clampedBarWidth);
    }
  }

  if (!args.message) {
    return prefix;
  }

  if (args.maxWidth === undefined) {
    return `${prefix} ${args.message}`;
  }

  const availableMessageWidth = args.maxWidth - prefix.length - 1;
  if (availableMessageWidth <= 0) {
    return prefix;
  }

  const message = truncateText(args.message, availableMessageWidth);
  return message ? `${prefix} ${message}` : prefix;
}

export function formatProgressDetail(
  detail: Record<string, unknown>,
  options: OutputOptions = {}
): string {
  return JSON.stringify(detail, null, 2)
    .split('\n')
    .map((line) => `${paint('  ', ANSI.dim, options)}${line}`)
    .join('\n');
}
