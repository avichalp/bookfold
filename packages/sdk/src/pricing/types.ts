import type { DetailLevel } from '../types.js';

export interface ModelPrice {
  inputMicrosUsdPerMillionTokens: string;
  outputMicrosUsdPerMillionTokens: string;
}

export interface PriceSheet {
  version: string;
  currency: 'USD';
  currencyDecimals: number;
  safetyBufferBps: number;
  bookfoldFeeMicrosUsd: Record<DetailLevel, string>;
  models: Record<string, ModelPrice>;
}

export interface PlanPriceLine {
  callId: string;
  model: string;
  promptTokens: number;
  reservedOutputTokens: number;
  inputCostMicrosUsd: string;
  outputCostMicrosUsd: string;
  totalMicrosUsd: string;
}

export interface SummaryPlanPrice {
  priceSheetVersion: string;
  currency: 'USD';
  currencyDecimals: number;
  amount: string;
  subtotalMicrosUsd: string;
  bookfoldFeeMicrosUsd: string;
  safetyBufferMicrosUsd: string;
  lines: PlanPriceLine[];
}
