import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { MAX_FILE_BYTES } from '../config.js';
import type { BookFileType } from '../types.js';
import { parseEpub } from './epub.js';
import { parsePdf } from './pdf.js';
import type { ParsedBook } from './types.js';

export async function parseBookFromFile(filePath: string): Promise<ParsedBook> {
  const fileStats = await stat(filePath);
  if (!fileStats.isFile()) {
    throw new Error(`Input path is not a file: ${filePath}`);
  }

  if (fileStats.size > MAX_FILE_BYTES) {
    throw new Error(
      `Input file is too large (${formatBytes(fileStats.size)}). The current limit is ${formatBytes(MAX_FILE_BYTES)}.`
    );
  }

  const fileType = detectBookFileType(filePath);
  const fileBuffer = await readFile(filePath);

  switch (fileType) {
    case 'pdf':
      return parsePdf(filePath, fileBuffer);
    case 'epub':
      return parseEpub(filePath, fileBuffer);
  }
}

export function detectBookFileType(filePath: string): BookFileType {
  const extension = path.extname(filePath).toLowerCase();

  if (extension === '.pdf') {
    return 'pdf';
  }

  if (extension === '.epub') {
    return 'epub';
  }

  throw new Error(`Unsupported file type: ${extension || '(none)'}. Only .pdf and .epub are supported.`);
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}
