import type { BookFileType } from '../types.js';

export interface BookChunk {
  content: string;
  metadata: {
    pageNumbers?: number[];
  };
}

interface BookMetadataInfo {
  title?: string | undefined;
  author?: string | undefined;
}

export interface TocEntry {
  title: string;
  pageNumber: number | null;
  level: number;
  children?: TocEntry[];
}

export interface ParsedBook {
  filePath: string;
  fileType: BookFileType;
  chunks: BookChunk[];
  textLength: number;
  metadata: {
    info: BookMetadataInfo;
    pageCount?: number;
    chapterCount?: number;
    tocEntries?: TocEntry[];
    outlineEntries?: TocEntry[];
  };
}
