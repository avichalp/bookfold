import {
  CHARS_PER_TOKEN_ESTIMATE,
  CHUNK_MAX_TOKENS,
  CHUNK_OVERLAP_TOKENS
} from './config.js';

const MAX_CHUNK_CHARS = CHUNK_MAX_TOKENS * CHARS_PER_TOKEN_ESTIMATE;
const OVERLAP_CHARS = CHUNK_OVERLAP_TOKENS * CHARS_PER_TOKEN_ESTIMATE;

export interface TextWithPage {
  text: string;
  pageNumber: number;
}

export interface ChunkResult {
  content: string;
  pageNumbers: number[];
  tokenCount: number;
}

interface PageSpan {
  pageNumber: number;
  start: number;
}

function slicePageSpans(
  spans: PageSpan[],
  overlapStart: number,
  chunkLength: number
): PageSpan[] {
  const overlapSpans: PageSpan[] = [];

  for (let index = 0; index < spans.length; index += 1) {
    const span = spans[index];
    if (!span) {
      continue;
    }

    const spanStart = span.start;
    const nextSpan = index + 1 < spans.length ? spans[index + 1] : undefined;
    const spanEnd = nextSpan ? nextSpan.start : chunkLength;

    if (spanEnd <= overlapStart) {
      continue;
    }

    overlapSpans.push({
      pageNumber: span.pageNumber,
      start: Math.max(spanStart, overlapStart) - overlapStart
    });
  }

  return overlapSpans;
}

export function chunkTextWithPages(pages: TextWithPage[]): ChunkResult[] {
  const chunks: ChunkResult[] = [];
  let currentChunk = '';
  let currentPages = new Set<number>();
  let pageSpans: PageSpan[] = [];
  let chunkIsOverlapOnly = false;

  const addPageSpan = (pageNumber: number, start: number) => {
    const lastSpan = pageSpans[pageSpans.length - 1];
    if (!lastSpan || lastSpan.pageNumber !== pageNumber) {
      pageSpans.push({ pageNumber, start });
    }
  };

  const pushChunkWithOverlap = () => {
    if (!currentChunk.trim()) {
      return;
    }

    chunks.push({
      content: currentChunk.trim(),
      pageNumbers: Array.from(currentPages).sort((left, right) => left - right),
      tokenCount: Math.ceil(currentChunk.length / CHARS_PER_TOKEN_ESTIMATE)
    });

    const overlapStart = Math.max(0, currentChunk.length - OVERLAP_CHARS);
    const overlapText = currentChunk.slice(overlapStart);
    pageSpans = slicePageSpans(pageSpans, overlapStart, currentChunk.length);

    currentChunk = overlapText;
    currentPages = new Set(pageSpans.map((span) => span.pageNumber));
    chunkIsOverlapOnly = currentChunk.length > 0;
  };

  const appendParagraph = (paragraph: string, pageNumber: number) => {
    let remaining = paragraph;
    let isFirstPiece = true;

    while (remaining.length > 0) {
      const separator =
        isFirstPiece && currentChunk
          ? chunkIsOverlapOnly
            ? ' '
            : '\n\n'
          : '';

      const available = MAX_CHUNK_CHARS - currentChunk.length - separator.length;

      if (
        isFirstPiece &&
        currentChunk.length > 0 &&
        !chunkIsOverlapOnly &&
        remaining.length <= MAX_CHUNK_CHARS &&
        remaining.length > available
      ) {
        pushChunkWithOverlap();
        continue;
      }

      if (available <= 0 && currentChunk.length > 0) {
        pushChunkWithOverlap();
        continue;
      }

      const takeLength = Math.min(available, remaining.length);
      const paragraphStart = currentChunk.length + separator.length;

      if (separator) {
        currentChunk += separator;
      }

      currentChunk += remaining.slice(0, takeLength);
      currentPages.add(pageNumber);
      addPageSpan(pageNumber, paragraphStart);
      chunkIsOverlapOnly = false;

      remaining = remaining.slice(takeLength);
      isFirstPiece = false;

      if (remaining.length > 0 && currentChunk.length >= MAX_CHUNK_CHARS) {
        pushChunkWithOverlap();
      }
    }
  };

  for (const page of pages) {
    const paragraphs = page.text.split(/\n\n+/);

    for (const paragraph of paragraphs) {
      if (!paragraph.trim()) {
        continue;
      }

      appendParagraph(paragraph, page.pageNumber);
    }
  }

  if (currentChunk.trim()) {
    chunks.push({
      content: currentChunk.trim(),
      pageNumbers: Array.from(currentPages).sort((left, right) => left - right),
      tokenCount: Math.ceil(currentChunk.length / CHARS_PER_TOKEN_ESTIMATE)
    });
  }

  return chunks;
}
