import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { MAX_FILE_BYTES } from '../config.js';
import type { BookFileType } from '../types.js';
import { parseEpub } from './epub.js';
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

  return parseBookFromBuffer({
    fileBuffer,
    filePath,
    fileType
  });
}

export async function parseBookFromBuffer(input: {
  fileBuffer: Buffer | Uint8Array;
  filePath: string;
  fileType?: BookFileType | undefined;
}): Promise<ParsedBook> {
  const fileBuffer = Buffer.isBuffer(input.fileBuffer)
    ? input.fileBuffer
    : Buffer.from(input.fileBuffer);

  if (fileBuffer.byteLength > MAX_FILE_BYTES) {
    throw new Error(
      `Input file is too large (${formatBytes(fileBuffer.byteLength)}). The current limit is ${formatBytes(MAX_FILE_BYTES)}.`
    );
  }

  const fileType = input.fileType ?? detectBookFileType(input.filePath);

  switch (fileType) {
    case 'pdf': {
      const { parsePdf } = await import('./pdf.js');
      return parsePdf(input.filePath, fileBuffer);
    }
    case 'epub':
      return parseEpub(input.filePath, fileBuffer);
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
