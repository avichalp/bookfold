import { createPublicClient, http } from 'viem';
import { tempo as tempoChain } from 'viem/chains';
import {
  Actions as TempoActions,
  Addresses as TempoAddresses,
  TokenId,
  TokenIds
} from 'viem/tempo';
import { CLI_NAME } from './config.js';
import { resolveTempoWallet, type TempoWalletInfo } from './wallet.js';

const TEMPO_USDC_ADDRESS = '0x20C000000000000000000000b9537d11c60E8b50' as const;

export interface TempoWalletAssetBalance {
  amount: string;
  decimals: number;
  name: string;
  symbol: string;
}

export interface TempoWalletTokenBalance extends TempoWalletAssetBalance {
  tokenAddress: `0x${string}`;
  tokenId: string;
}

export interface TempoWalletBalanceReport {
  wallet: TempoWalletInfo;
  chainId: number;
  chainName: string;
  explorerUrl?: string | undefined;
  effectiveFeeTokenBalance: TempoWalletTokenBalance;
  effectiveFeeTokenSource: 'account-preference' | 'pathusd-fallback';
  pathUsdBalance: TempoWalletTokenBalance;
  usdcBalance?: TempoWalletTokenBalance | undefined;
  preferredFeeTokenBalance?: TempoWalletTokenBalance | undefined;
}

export async function getTempoWalletBalance(): Promise<TempoWalletBalanceReport> {
  const wallet = resolveTempoWallet();

  if (!wallet) {
    throw new Error(
      `No Tempo wallet found. Run \`${CLI_NAME} wallet init\` or set TEMPO_PRIVATE_KEY.`
    );
  }

  const rpcUrl = tempoChain.rpcUrls.default.http[0];
  if (!rpcUrl) {
    throw new Error('Tempo RPC URL is not configured.');
  }

  const client = createPublicClient({
    chain: tempoChain,
    transport: http(rpcUrl)
  });

  const [pathUsdBalance, preferredFeeToken, usdcBalance] = await Promise.all([
    fetchTokenBalance(client, wallet.address, TempoAddresses.pathUsd, TokenIds.pathUsd),
    TempoActions.fee.getUserToken(client, { account: wallet.address }),
    fetchTokenBalance(client, wallet.address, TEMPO_USDC_ADDRESS, TokenId.fromAddress(TEMPO_USDC_ADDRESS), {
      optional: true
    })
  ]);

  if (!pathUsdBalance) {
    throw new Error('Failed to load pathUSD balance.');
  }

  let preferredFeeTokenBalance: TempoWalletTokenBalance | undefined;

  if (preferredFeeToken) {
    preferredFeeTokenBalance = await fetchTokenBalance(
      client,
      wallet.address,
      preferredFeeToken.address,
      preferredFeeToken.id
    );
  }

  const effectiveFeeTokenBalance = preferredFeeTokenBalance ?? pathUsdBalance;
  const effectiveFeeTokenSource = preferredFeeTokenBalance ? 'account-preference' : 'pathusd-fallback';

  return {
    wallet,
    chainId: tempoChain.id,
    chainName: tempoChain.name,
    explorerUrl: tempoChain.blockExplorers?.default.url,
    effectiveFeeTokenBalance,
    effectiveFeeTokenSource,
    pathUsdBalance,
    usdcBalance,
    preferredFeeTokenBalance
  };
}

async function fetchTokenBalance(
  client: unknown,
  account: `0x${string}`,
  tokenAddress: `0x${string}`,
  tokenId: bigint,
  options: { optional?: boolean | undefined } = {}
): Promise<TempoWalletTokenBalance | undefined> {
  try {
    const tempoClient = client as never;
    const [balance, metadata] = await Promise.all([
      TempoActions.token.getBalance(tempoClient, {
        account,
        token: tokenId
      }),
      TempoActions.token.getMetadata(tempoClient, {
        token: tokenId
      })
    ]);

    return {
      amount: balance.toString(),
      decimals: metadata.decimals,
      name: metadata.name,
      symbol: metadata.symbol,
      tokenAddress,
      tokenId: tokenId.toString()
    };
  } catch (error) {
    if (options.optional) {
      return undefined;
    }

    throw error;
  }
}
