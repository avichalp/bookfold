import { PROMPT_VERSION } from '../config.js';
import type { DetailLevel, ProviderMessage } from '../types.js';

interface MetadataContext {
  title?: string | undefined;
  author?: string | undefined;
  fileType: 'pdf' | 'epub';
  pageCount?: number | undefined;
  chapterCount?: number | undefined;
}

function buildMetadataBlock(metadata: MetadataContext): string {
  return [
    `BOOK_TITLE: ${metadata.title ?? 'Unknown'}`,
    `BOOK_AUTHOR: ${metadata.author ?? 'Unknown'}`,
    `BOOK_FILE_TYPE: ${metadata.fileType}`,
    `BOOK_PAGE_COUNT: ${metadata.pageCount ?? 'unknown'}`,
    `BOOK_CHAPTER_COUNT: ${metadata.chapterCount ?? 'unknown'}`
  ].join('\n');
}

export function buildSystemPromptText(): string {
  return [
    'You are a careful book summarizer.',
    'Base every summary only on the provided source material.',
    'Do not fabricate claims, chapters, or conclusions that are not in the text.',
    'Prefer plain paragraphs over bullet lists unless the prompt explicitly asks for structure.',
    `PROMPT_VERSION: ${PROMPT_VERSION}`
  ].join('\n');
}

export function buildSinglePassPrompt(args: {
  detail: DetailLevel;
  metadata: MetadataContext;
  targetWords: { min: number; max: number };
  text: string;
}): ProviderMessage[] {
  return [
    { role: 'system', content: buildSystemPromptText() },
    {
      role: 'user',
      content: buildSinglePassUserPrompt(args)
    }
  ];
}

function buildSinglePassUserPrompt(args: {
  detail: DetailLevel;
  metadata: MetadataContext;
  targetWords: { min: number; max: number };
  text: string;
}): string {
  return [
    'TASK_KIND: SINGLE',
    `DETAIL_LEVEL: ${args.detail}`,
    `TARGET_WORDS: ${args.targetWords.min}-${args.targetWords.max}`,
    buildMetadataBlock(args.metadata),
    'INSTRUCTIONS:',
    'Write a coherent summary of the provided book content.',
    'Cover the main thesis, structure, major themes, and notable examples or arguments.',
    'Maintain the reading order when describing the book.',
    'Output plain text only.',
    'SOURCE_TEXT:',
    args.text
  ].join('\n\n');
}

export function buildChunkMapPrompt(args: {
  detail: DetailLevel;
  metadata: MetadataContext;
  targetWords: { min: number; max: number };
  chunkLabel: string;
  text: string;
}): ProviderMessage[] {
  return [
    { role: 'system', content: buildSystemPromptText() },
    {
      role: 'user',
      content: buildChunkMapUserPrompt(args)
    }
  ];
}

function buildChunkMapUserPrompt(args: {
  detail: DetailLevel;
  metadata: MetadataContext;
  targetWords: { min: number; max: number };
  chunkLabel: string;
  text: string;
}): string {
  return [
    'TASK_KIND: MAP',
    `DETAIL_LEVEL: ${args.detail}`,
    `TARGET_WORDS: ${args.targetWords.min}-${args.targetWords.max}`,
    `CHUNK_LABEL: ${args.chunkLabel}`,
    buildMetadataBlock(args.metadata),
    'INSTRUCTIONS:',
    'Summarize this chunk for later synthesis into a whole-book summary.',
    'Capture major topics, key arguments/events, and distinctive supporting details from this chunk only.',
    'Keep it dense and factual.',
    'Output plain text only.',
    'SOURCE_TEXT:',
    args.text
  ].join('\n\n');
}

export function buildSectionMapPrompt(args: {
  detail: DetailLevel;
  metadata: MetadataContext;
  targetWords: { min: number; max: number };
  sectionTitle: string;
  sectionLabel: string;
  text: string;
}): ProviderMessage[] {
  return [
    { role: 'system', content: buildSystemPromptText() },
    {
      role: 'user',
      content: buildSectionMapUserPrompt(args)
    }
  ];
}

function buildSectionMapUserPrompt(args: {
  detail: DetailLevel;
  metadata: MetadataContext;
  targetWords: { min: number; max: number };
  sectionTitle: string;
  sectionLabel: string;
  text: string;
}): string {
  return [
    'TASK_KIND: SECTION_MAP',
    `DETAIL_LEVEL: ${args.detail}`,
    `TARGET_WORDS: ${args.targetWords.min}-${args.targetWords.max}`,
    `SECTION_LABEL: ${args.sectionLabel}`,
    `SECTION_TITLE: ${args.sectionTitle}`,
    buildMetadataBlock(args.metadata),
    'INSTRUCTIONS:',
    'Summarize this section as part of a long-form whole-book summary.',
    'Preserve any local arc, chapter focus, important examples, and transition into later sections.',
    'Output plain text only.',
    'SOURCE_TEXT:',
    args.text
  ].join('\n\n');
}

export function buildReducePrompt(args: {
  detail: DetailLevel;
  metadata: MetadataContext;
  targetWords: { min: number; max: number };
  notesLabel: string;
  notes: string[];
}): ProviderMessage[] {
  return [
    { role: 'system', content: buildSystemPromptText() },
    {
      role: 'user',
      content: buildReduceUserPrompt(args)
    }
  ];
}

export function buildReduceUserPrompt(args: {
  detail: DetailLevel;
  metadata: MetadataContext;
  targetWords: { min: number; max: number };
  notesLabel: string;
  notes?: string[] | undefined;
}): string {
  return [
    'TASK_KIND: REDUCE',
    `DETAIL_LEVEL: ${args.detail}`,
    `TARGET_WORDS: ${args.targetWords.min}-${args.targetWords.max}`,
    `NOTES_LABEL: ${args.notesLabel}`,
    buildMetadataBlock(args.metadata),
    'INSTRUCTIONS:',
    'Synthesize the notes into a cohesive summary of the whole book.',
    'Explain the central thesis, the major sections or arguments in order, and the most important takeaways.',
    'If the source appears incomplete or partial, say so briefly rather than guessing.',
    'Output plain text only.',
    'MAP_NOTES:',
    (args.notes ?? []).map((note, index) => `NOTE ${index + 1}:\n${note}`).join('\n\n')
  ].join('\n\n');
}

export function buildCollapsePrompt(args: {
  detail: DetailLevel;
  metadata: MetadataContext;
  targetWords: { min: number; max: number };
  stageLabel: string;
  notes: string[];
}): ProviderMessage[] {
  return [
    { role: 'system', content: buildSystemPromptText() },
    {
      role: 'user',
      content: buildCollapseUserPrompt(args)
    }
  ];
}

export function buildCollapseUserPrompt(args: {
  detail: DetailLevel;
  metadata: MetadataContext;
  targetWords: { min: number; max: number };
  stageLabel: string;
  notes?: string[] | undefined;
}): string {
  return [
    'TASK_KIND: COLLAPSE',
    `DETAIL_LEVEL: ${args.detail}`,
    `TARGET_WORDS: ${args.targetWords.min}-${args.targetWords.max}`,
    `STAGE_LABEL: ${args.stageLabel}`,
    buildMetadataBlock(args.metadata),
    'INSTRUCTIONS:',
    'Compress these intermediate notes while preserving the main arguments, sequence, and distinctive details.',
    'This output will be reduced again later, so keep it compact but information-dense.',
    'Output plain text only.',
    'INTERMEDIATE_NOTES:',
    (args.notes ?? []).map((note, index) => `NOTE ${index + 1}:\n${note}`).join('\n\n')
  ].join('\n\n');
}
