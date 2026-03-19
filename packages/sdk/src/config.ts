import type { DetailLevel } from './types.js';

export const APP_NAME = 'bookfold';
export const APP_DISPLAY_NAME = 'Bookfold';
export const CLI_NAME = 'bookfold';
export const OPENAI_MPP_BASE_URL = 'https://openai.mpp.tempo.xyz';
export const OPENAI_MPP_CHAT_COMPLETIONS_PATH = '/v1/chat/completions';
export const TEMPO_MAX_DEPOSIT = '1';
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_EPUB_DECOMPRESSED_BYTES = 500 * 1024 * 1024;
export const REQUEST_TIMEOUT_MS = 120_000;
export const MAP_CONCURRENCY = 3;
export const CHARS_PER_TOKEN_ESTIMATE = 4;
export const CHUNK_MAX_TOKENS = 1000;
export const CHUNK_OVERLAP_TOKENS = 100;
export const PROMPT_VERSION = 'bookfold-v1';

export interface DetailProfile {
  model: string;
  targetWords: {
    min: number;
    max: number;
  };
  strategy: 'single-pass' | 'light-map-reduce' | 'map-reduce' | 'section-aware-map-reduce';
  mapGroupSize: number;
}

export const DETAIL_PROFILES: Record<DetailLevel, DetailProfile> = {
  short: {
    model: 'gpt-4o-mini',
    targetWords: { min: 150, max: 300 },
    strategy: 'light-map-reduce',
    mapGroupSize: 3
  },
  medium: {
    model: 'gpt-4o',
    targetWords: { min: 500, max: 900 },
    strategy: 'map-reduce',
    mapGroupSize: 2
  },
  long: {
    model: 'gpt-4o',
    targetWords: { min: 1200, max: 1800 },
    strategy: 'section-aware-map-reduce',
    mapGroupSize: 1
  }
};
