import type { BookFileType, DetailLevel, SummaryMetadata } from '../types.js';

export type SummaryPlanStrategy =
  | 'single-pass'
  | 'light-map-reduce'
  | 'map-reduce'
  | 'section-aware-map-reduce';

type SummaryPlanCallStage =
  | 'single'
  | 'map'
  | 'section-map'
  | 'collapse'
  | 'reduce';

export interface SummaryPlanChunk {
  index: number;
  pageNumbers?: number[] | undefined;
  tokenCount: number;
  charCount: number;
  digest: string;
}

interface SummaryPlanCallBase {
  id: string;
  stage: SummaryPlanCallStage;
  model: string;
  targetWords: {
    min: number;
    max: number;
  };
  reservedOutputTokens: number;
  promptTokens: number;
  totalReservedTokens: number;
  promptDigest: string;
}

export interface SummaryPlanChunkCall extends SummaryPlanCallBase {
  sourceKind: 'chunks';
  chunkIndexes: number[];
  chunkLabel?: string | undefined;
  sectionTitle?: string | undefined;
  sectionLabel?: string | undefined;
}

export interface SummaryPlanNotesCall extends SummaryPlanCallBase {
  sourceKind: 'notes';
  noteRefs: string[];
  noteTokenBudgets: number[];
  notesLabel: string;
  stageLabel?: string | undefined;
}

export type SummaryPlanCall = SummaryPlanChunkCall | SummaryPlanNotesCall;

export interface SummaryPlanTotals {
  callCount: number;
  promptTokens: number;
  reservedOutputTokens: number;
  totalReservedTokens: number;
}

export interface SummaryPlan {
  version: string;
  detail: DetailLevel;
  fileType: BookFileType;
  metadata: SummaryMetadata;
  parserVersion: string;
  tokenizerVersion: string;
  promptVersion: string;
  strategy: SummaryPlanStrategy;
  chunks: SummaryPlanChunk[];
  calls: SummaryPlanCall[];
  totals: SummaryPlanTotals;
  sectionCount?: number | undefined;
  warnings?: string[] | undefined;
}
