import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { chunkTextWithPages } from '../chunking.js';
import type { ParsedBook, TocEntry } from './types.js';

const require = createRequire(import.meta.url);

const STANDARD_FONT_DATA_URL: string | undefined = (() => {
  try {
    const pkgPath = require.resolve('pdfjs-dist/package.json');
    const pdfjsDistDir = path.dirname(pkgPath);
    return path.join(pdfjsDistDir, 'standard_fonts').replace(/\\/g, '/') + '/';
  } catch {
    return undefined;
  }
})();

interface PdfOutlineNode {
  title?: string;
  dest?: unknown;
  items?: PdfOutlineNode[];
}

export async function parsePdf(filePath: string, fileBuffer: Buffer): Promise<ParsedBook> {
  let pdf: pdfjs.PDFDocumentProxy | undefined;

  try {
    const uint8Array = new Uint8Array(fileBuffer);
    const loadingTask = pdfjs.getDocument({
      data: uint8Array,
      ...(STANDARD_FONT_DATA_URL ? { standardFontDataUrl: STANDARD_FONT_DATA_URL } : {})
    });

    pdf = await loadingTask.promise;
    const numPages = pdf.numPages;
    if (numPages === 0) {
      throw new Error('PDF has no pages.');
    }

    const pageTexts: Array<{ text: string; pageNumber: number }> = [];

    for (let pageNumber = 1; pageNumber <= numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const parts: string[] = [];

      for (const item of textContent.items as Array<{ str?: string; hasEOL?: boolean }>) {
        const text = typeof item?.str === 'string' ? item.str : '';
        parts.push(text);
        if (item?.hasEOL) {
          parts.push('\n');
        }
      }

      const pageText = parts
        .join(' ')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      if (pageText) {
        pageTexts.push({ text: pageText, pageNumber });
      }
    }

    if (pageTexts.length === 0) {
      throw new Error(
        'Could not extract text from PDF. The file may be scanned or corrupted.'
      );
    }

    const chunks = chunkTextWithPages(pageTexts);
    if (chunks.length === 0) {
      throw new Error('Could not create any text chunks from PDF.');
    }

    const metadata = await pdf.getMetadata();
    const info = metadata.info as Record<string, unknown> | undefined;
    const outlineEntries = await extractOutlineEntries(pdf);

    return {
      filePath,
      fileType: 'pdf',
      chunks: chunks.map((chunk) => ({
        content: chunk.content,
        metadata: { pageNumbers: chunk.pageNumbers }
      })),
      textLength: pageTexts.reduce((total, page) => total + page.text.length, 0),
      metadata: {
        pageCount: numPages,
        info: {
          title: typeof info?.Title === 'string' ? info.Title.trim() || undefined : undefined,
          author: typeof info?.Author === 'string' ? info.Author.trim() || undefined : undefined
        },
        outlineEntries
      }
    };
  } catch (error) {
    if (
      error instanceof Error &&
      (
        error.message === 'PDF has no pages.' ||
        error.message === 'Could not extract text from PDF. The file may be scanned or corrupted.' ||
        error.message === 'Could not create any text chunks from PDF.'
      )
    ) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse PDF: ${message}`);
  } finally {
    if (pdf) {
      await pdf.destroy();
    }
  }
}

async function extractOutlineEntries(pdf: pdfjs.PDFDocumentProxy): Promise<TocEntry[]> {
  let outline: PdfOutlineNode[] | null;

  try {
    outline = await pdf.getOutline();
  } catch {
    return [];
  }

  if (!Array.isArray(outline) || outline.length === 0) {
    return [];
  }

  const entries: TocEntry[] = [];

  const resolvePageNumber = async (dest: unknown): Promise<number | null> => {
    if (dest == null) {
      return null;
    }

    let resolved: unknown = dest;
    if (typeof dest === 'string') {
      try {
        resolved = await pdf.getDestination(dest);
      } catch {
        return null;
      }
    }

    if (!Array.isArray(resolved) || resolved.length === 0) {
      return null;
    }

    const [ref] = resolved;
    try {
      const pageIndex = await pdf.getPageIndex(ref as any);
      return typeof pageIndex === 'number' ? pageIndex + 1 : null;
    } catch {
      return null;
    }
  };

  const walk = async (items: PdfOutlineNode[], level: number) => {
    for (const item of items) {
      const rawTitle = typeof item.title === 'string' ? item.title.trim() : '';
      const pageNumber = await resolvePageNumber(item.dest);
      const childItems = Array.isArray(item.items) ? item.items : [];

      entries.push({
        title: rawTitle || '(untitled)',
        pageNumber,
        level,
        children: []
      });

      if (childItems.length > 0) {
        await walk(childItems, level + 1);
      }
    }
  };

  await walk(outline, 0);
  return entries;
}
