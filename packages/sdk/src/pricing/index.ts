import defaultPriceSheetJson from './default-price-sheet.json' with { type: 'json' };
import type { SummaryPlan } from '../plan/types.js';
import type { PriceSheet, SummaryPlanPrice } from './types.js';

const ONE_MILLION = 1_000_000n;

export const DEFAULT_PRICE_SHEET = defaultPriceSheetJson as PriceSheet;

export function priceSummaryPlan(
  plan: SummaryPlan,
  priceSheet: PriceSheet = DEFAULT_PRICE_SHEET
): SummaryPlanPrice {
  const lines = plan.calls.map((call) => {
    const modelPrice = priceSheet.models[call.model];
    if (!modelPrice) {
      throw new Error(`No price exists for model "${call.model}" in price sheet ${priceSheet.version}.`);
    }

    const inputCost = priceTokens(call.promptTokens, modelPrice.inputMicrosUsdPerMillionTokens);
    const outputCost = priceTokens(
      call.reservedOutputTokens,
      modelPrice.outputMicrosUsdPerMillionTokens
    );
    const total = inputCost + outputCost;

    return {
      callId: call.id,
      model: call.model,
      promptTokens: call.promptTokens,
      reservedOutputTokens: call.reservedOutputTokens,
      inputCostMicrosUsd: inputCost.toString(),
      outputCostMicrosUsd: outputCost.toString(),
      totalMicrosUsd: total.toString()
    };
  });

  const subtotal = lines.reduce((sum, line) => sum + BigInt(line.totalMicrosUsd), 0n);
  const fee = BigInt(priceSheet.bookfoldFeeMicrosUsd[plan.detail]);
  const safetyBuffer = ceilDiv(
    (subtotal + fee) * BigInt(priceSheet.safetyBufferBps),
    10_000n
  );
  const amount = subtotal + fee + safetyBuffer;

  return {
    priceSheetVersion: priceSheet.version,
    currency: priceSheet.currency,
    currencyDecimals: priceSheet.currencyDecimals,
    amount: amount.toString(),
    subtotalMicrosUsd: subtotal.toString(),
    bookfoldFeeMicrosUsd: fee.toString(),
    safetyBufferMicrosUsd: safetyBuffer.toString(),
    lines
  };
}

function priceTokens(tokenCount: number, rateMicrosUsdPerMillion: string): bigint {
  return ceilDiv(BigInt(tokenCount) * BigInt(rateMicrosUsdPerMillion), ONE_MILLION);
}

function ceilDiv(left: bigint, right: bigint): bigint {
  return (left + right - 1n) / right;
}
