import { XMLParser } from 'fast-xml-parser';
import JSZip from 'jszip';
import path from 'node:path';
import { MAX_EPUB_DECOMPRESSED_BYTES } from '../config.js';
import { chunkTextWithPages } from '../chunking.js';
import type { ParsedBook, TocEntry } from './types.js';

interface ManifestItem {
  id: string;
  href: string;
  mediaType: string;
  properties: string;
}

interface SpineItem {
  idref: string;
  href: string;
  linear: boolean;
}

interface EpubMetadata {
  title?: string | undefined;
  author?: string | undefined;
  language?: string | undefined;
  description?: string | undefined;
}

interface OpfResult {
  metadata: EpubMetadata;
  manifest: Map<string, ManifestItem>;
  spine: SpineItem[];
  ncxId: string | null;
}

type GuardedReader = (filePath: string) => Promise<string>;

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  isArray: (name) => ['item', 'itemref', 'navPoint', 'li', 'a', 'ol'].includes(name)
});

export async function parseEpub(filePath: string, fileBuffer: Buffer): Promise<ParsedBook> {
  const structure = await validateEpubStructure(fileBuffer);
  if (!structure.valid) {
    throw new Error(structure.error ?? 'Invalid EPUB.');
  }

  const zip = await JSZip.loadAsync(fileBuffer);
  let decompressedBytes = 0;

  const readZipTextGuarded: GuardedReader = async (archivePath: string) => {
    const content = await readZipText(zip, archivePath);
    decompressedBytes += Buffer.byteLength(content, 'utf-8');
    if (decompressedBytes > MAX_EPUB_DECOMPRESSED_BYTES) {
      throw new Error('EPUB exceeds maximum decompressed size limit.');
    }
    return content;
  };

  if (await hasDrmEncryption(zip, readZipTextGuarded)) {
    throw new Error('This EPUB appears to be DRM-protected and cannot be processed.');
  }

  const opfPath = await resolveOpfPath(zip);
  const opfDir = path.dirname(opfPath);
  const opfXml = await readZipTextGuarded(opfPath);
  const opf = parseOpf(opfXml, opfDir);

  if (opf.spine.length === 0) {
    throw new Error('EPUB has no content (empty spine).');
  }

  let tocEntries = await extractTocFromNavAsync(opf.manifest, opf.spine, zip, readZipTextGuarded);
  if (tocEntries.length === 0) {
    tocEntries = await extractTocFromNcx(
      opf.ncxId,
      opf.manifest,
      opf.spine,
      zip,
      opfDir,
      readZipTextGuarded
    );
  }
  if (tocEntries.length === 0) {
    tocEntries = await extractTocFromSpine(opf.spine, zip, readZipTextGuarded);
  }

  const pageTexts: Array<{ text: string; pageNumber: number }> = [];
  for (let index = 0; index < opf.spine.length; index += 1) {
    const item = opf.spine[index];
    if (!item || !item.linear) {
      continue;
    }

    let xhtml: string;
    try {
      xhtml = await readZipTextGuarded(item.href);
    } catch {
      continue;
    }

    const text = xhtmlToText(xhtml);
    if (!text.trim()) {
      continue;
    }

    pageTexts.push({ text, pageNumber: index + 1 });
  }

  if (pageTexts.length === 0) {
    throw new Error('Could not extract text from EPUB. The file may be empty or corrupted.');
  }

  const chunks = chunkTextWithPages(pageTexts);
  if (chunks.length === 0) {
    throw new Error('Could not create any text chunks from EPUB.');
  }

  return {
    filePath,
    fileType: 'epub',
    chunks: chunks.map((chunk) => ({
      content: chunk.content,
      metadata: { pageNumbers: chunk.pageNumbers }
    })),
    textLength: pageTexts.reduce((total, page) => total + page.text.length, 0),
    metadata: {
      chapterCount: opf.spine.filter((item) => item.linear).length,
      info: {
        title: opf.metadata.title,
        author: opf.metadata.author
      },
      tocEntries
    }
  };
}

async function resolveOpfPath(zip: JSZip): Promise<string> {
  const containerFile = zip.file('META-INF/container.xml');
  if (!containerFile) {
    throw new Error('Invalid EPUB: missing META-INF/container.xml');
  }

  const containerXml = await containerFile.async('string');
  const parsed = xmlParser.parse(containerXml);
  const rootfiles = parsed?.container?.rootfiles?.rootfile;

  if (!rootfiles) {
    throw new Error('Invalid EPUB: no rootfile in container.xml');
  }

  const rootfile = Array.isArray(rootfiles) ? rootfiles[0] : rootfiles;
  const fullPath = rootfile?.['@_full-path'];

  if (typeof fullPath !== 'string' || !fullPath) {
    throw new Error('Invalid EPUB: rootfile missing full-path attribute');
  }

  return fullPath;
}

function parseOpf(opfXml: string, opfDir: string): OpfResult {
  const parsed = xmlParser.parse(opfXml);
  const pkg = parsed?.package ?? parsed?.['opf:package'] ?? parsed?.['OPF:package'];

  if (!pkg) {
    throw new Error('Invalid EPUB: cannot parse OPF package document');
  }

  const metadataNode = pkg.metadata ?? pkg['opf:metadata'] ?? {};
  const metadata: EpubMetadata = {
    title: extractDcField(metadataNode, 'title'),
    author: extractDcField(metadataNode, 'creator'),
    language: extractDcField(metadataNode, 'language'),
    description: extractDcField(metadataNode, 'description')
  };

  const manifest = new Map<string, ManifestItem>();
  const items: any[] = pkg.manifest?.item ?? [];
  for (const item of items) {
    const id = item?.['@_id'];
    const href = item?.['@_href'];
    const mediaType = item?.['@_media-type'] ?? '';
    const properties = item?.['@_properties'] ?? '';

    if (typeof id === 'string' && typeof href === 'string') {
      manifest.set(id, {
        id,
        href: resolveHref(href, opfDir),
        mediaType,
        properties
      });
    }
  }

  const ncxId = typeof pkg.spine?.['@_toc'] === 'string' ? pkg.spine['@_toc'] : null;
  const itemrefs: any[] = pkg.spine?.itemref ?? [];
  const spine: SpineItem[] = [];

  for (const itemref of itemrefs) {
    const idref = itemref?.['@_idref'];
    if (typeof idref !== 'string') {
      continue;
    }

    const manifestItem = manifest.get(idref);
    if (!manifestItem) {
      continue;
    }

    spine.push({
      idref,
      href: manifestItem.href,
      linear: itemref?.['@_linear'] !== 'no'
    });
  }

  return { metadata, manifest, spine, ncxId };
}

function extractDcField(metadata: any, field: string): string | undefined {
  const keys = [`dc:${field}`, `DC:${field}`, field];

  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }

    if (typeof value === 'object' && value !== null) {
      const text = value['#text'];
      if (typeof text === 'string' && text.trim()) {
        return text.trim();
      }

      if (Array.isArray(value)) {
        const first = value[0];
        if (typeof first === 'string' && first.trim()) {
          return first.trim();
        }
        if (typeof first === 'object' && first !== null) {
          const nestedText = first['#text'];
          if (typeof nestedText === 'string' && nestedText.trim()) {
            return nestedText.trim();
          }
        }
      }
    }
  }

  return undefined;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function safeResolveHref(baseDir: string, raw: string): string {
  const decoded = safeDecodeURIComponent(raw);
  if (baseDir === '.' || baseDir === '') {
    return decoded;
  }

  const resolved = path.posix.normalize(path.posix.join(baseDir, decoded));
  if (resolved.startsWith('../') || resolved === '..') {
    throw new Error(`Invalid EPUB path: href escapes archive root: ${raw}`);
  }

  return resolved;
}

function resolveHref(href: string, opfDir: string): string {
  return safeResolveHref(opfDir, href);
}

async function extractTocFromNavAsync(
  manifest: Map<string, ManifestItem>,
  spine: SpineItem[],
  zip: JSZip,
  reader?: GuardedReader
): Promise<TocEntry[]> {
  let navItem: ManifestItem | null = null;
  for (const item of manifest.values()) {
    if (item.properties.split(/\s+/).includes('nav')) {
      navItem = item;
      break;
    }
  }

  if (!navItem) {
    return [];
  }

  let navXhtml: string;
  if (reader) {
    try {
      navXhtml = await reader(navItem.href);
    } catch {
      return [];
    }
  } else {
    const navFile = zip.file(navItem.href);
    if (!navFile) {
      return [];
    }
    navXhtml = await navFile.async('string');
  }

  return parseNavToc(navXhtml, spine, navItem.href);
}

export function parseNavToc(navXhtml: string, spine: SpineItem[], navHref: string): TocEntry[] {
  const navDir = path.dirname(navHref);
  let parsed: any;

  try {
    parsed = xmlParser.parse(navXhtml);
  } catch {
    return [];
  }

  const tocNav = findTocNavNode(parsed);
  if (!tocNav || typeof tocNav !== 'object') {
    return [];
  }

  const firstOl = firstByLocalName(tocNav, 'ol');
  if (!firstOl || typeof firstOl !== 'object') {
    return [];
  }

  return parseNavOl(firstOl, spine, navDir, 0);
}

function parseNavOl(olNode: any, spine: SpineItem[], baseDir: string, level: number): TocEntry[] {
  const entries: TocEntry[] = [];

  for (const li of valuesByLocalName(olNode, 'li')) {
    if (!li || typeof li !== 'object') {
      continue;
    }

    const linkNode = firstByLocalName(li, 'a');
    const href = readAttribute(linkNode, 'href');
    const title = (extractNodeText(linkNode) || extractNodeText(firstByLocalName(li, 'span')) || '').trim();

    if (!title) {
      continue;
    }

    let pageNumber: number | null = null;
    if (typeof href === 'string' && href.trim()) {
      const resolvedHref = safeResolveHref(baseDir, href);
      const spineIndex = mapHrefToSpineIndex(resolvedHref, spine);
      pageNumber = spineIndex !== null ? spineIndex + 1 : null;
    }

    const nestedOl = firstByLocalName(li, 'ol');
    entries.push({
      title,
      pageNumber,
      level,
      children: nestedOl ? parseNavOl(nestedOl, spine, baseDir, level + 1) : []
    });
  }

  return entries;
}

function findTocNavNode(node: unknown): Record<string, unknown> | null {
  if (!node || typeof node !== 'object') {
    return null;
  }

  const record = node as Record<string, unknown>;
  if (isTocNav(record)) {
    return record;
  }

  for (const value of Object.values(record)) {
    if (Array.isArray(value)) {
      for (const child of value) {
        const found = findTocNavNode(child);
        if (found) {
          return found;
        }
      }
      continue;
    }

    const found = findTocNavNode(value);
    if (found) {
      return found;
    }
  }

  return null;
}

function isTocNav(node: Record<string, unknown>): boolean {
  const tocType = readAttribute(node, 'epub:type') ?? readAttribute(node, 'type') ?? readAttribute(node, 'role');
  return typeof tocType === 'string' && /\btoc\b/i.test(tocType);
}

function firstByLocalName(node: unknown, localName: string): unknown {
  if (!node || typeof node !== 'object') {
    return undefined;
  }

  const record = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (key.startsWith('@_')) {
      continue;
    }

    const keyLocal = key.includes(':') ? key.split(':').pop() : key;
    if (keyLocal === localName) {
      return Array.isArray(value) ? value[0] : value;
    }
  }

  return undefined;
}

function valuesByLocalName(node: unknown, localName: string): unknown[] {
  if (!node || typeof node !== 'object') {
    return [];
  }

  const record = node as Record<string, unknown>;
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (key.startsWith('@_')) {
      continue;
    }

    const keyLocal = key.includes(':') ? key.split(':').pop() : key;
    if (keyLocal !== localName) {
      continue;
    }

    if (Array.isArray(value)) {
      values.push(...value);
    } else {
      values.push(value);
    }
  }

  return values;
}

function readAttribute(node: unknown, attributeName: string): string | undefined {
  if (!node || typeof node !== 'object') {
    return undefined;
  }

  const record = node as Record<string, unknown>;
  const direct = record[`@_${attributeName}`];
  if (typeof direct === 'string') {
    return direct;
  }

  const localAttributeName = attributeName.includes(':') ? attributeName.split(':').pop() : attributeName;
  for (const [key, value] of Object.entries(record)) {
    if (!key.startsWith('@_')) {
      continue;
    }

    const rawAttribute = key.slice(2);
    const rawLocal = rawAttribute.includes(':') ? rawAttribute.split(':').pop() : rawAttribute;
    if ((rawAttribute === attributeName || rawLocal === localAttributeName) && typeof value === 'string') {
      return value;
    }
  }

  return undefined;
}

function extractNodeText(node: unknown): string {
  if (typeof node === 'string') {
    return node;
  }

  if (Array.isArray(node)) {
    return node.map((item) => extractNodeText(item)).join(' ').trim();
  }

  if (!node || typeof node !== 'object') {
    return '';
  }

  const record = node as Record<string, unknown>;
  const parts: string[] = [];
  const directText = record['#text'];
  if (typeof directText === 'string' && directText.trim()) {
    parts.push(directText.trim());
  }

  for (const [key, value] of Object.entries(record)) {
    if (key === '#text' || key.startsWith('@_')) {
      continue;
    }
    const text = extractNodeText(value);
    if (text) {
      parts.push(text);
    }
  }

  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

async function extractTocFromNcx(
  ncxId: string | null,
  manifest: Map<string, ManifestItem>,
  spine: SpineItem[],
  zip: JSZip,
  _opfDir: string,
  reader?: GuardedReader
): Promise<TocEntry[]> {
  let ncxItem: ManifestItem | null = null;
  if (ncxId) {
    ncxItem = manifest.get(ncxId) ?? null;
  }

  if (!ncxItem) {
    for (const item of manifest.values()) {
      if (item.mediaType === 'application/x-dtbncx+xml') {
        ncxItem = item;
        break;
      }
    }
  }

  if (!ncxItem) {
    return [];
  }

  let ncxXml: string;
  if (reader) {
    try {
      ncxXml = await reader(ncxItem.href);
    } catch {
      return [];
    }
  } else {
    const ncxFile = zip.file(ncxItem.href);
    if (!ncxFile) {
      return [];
    }
    ncxXml = await ncxFile.async('string');
  }

  return parseNcxToc(ncxXml, spine, ncxItem.href);
}

export function parseNcxToc(ncxXml: string, spine: SpineItem[], ncxHref: string): TocEntry[] {
  const ncxDir = path.dirname(ncxHref);
  let parsed: any;

  try {
    parsed = xmlParser.parse(ncxXml);
  } catch {
    return [];
  }

  const navPoints: any[] = parsed?.ncx?.navMap?.navPoint ?? [];

  return parseNavPoints(navPoints, spine, ncxDir, 0);
}

function parseNavPoints(navPoints: any[], spine: SpineItem[], baseDir: string, level: number): TocEntry[] {
  const entries: TocEntry[] = [];

  for (const navPoint of navPoints) {
    const labelNode = navPoint?.navLabel;
    const textNode = labelNode?.text ?? labelNode?.['#text'];
    const title =
      typeof textNode === 'string'
        ? textNode.trim()
        : typeof textNode === 'object' && textNode !== null
          ? String(textNode['#text'] ?? '').trim()
          : '';

    if (!title) {
      continue;
    }

    let pageNumber: number | null = null;
    const src = navPoint?.content?.['@_src'];
    if (typeof src === 'string') {
      const resolvedSrc = safeResolveHref(baseDir, src);
      const spineIndex = mapHrefToSpineIndex(resolvedSrc, spine);
      pageNumber = spineIndex !== null ? spineIndex + 1 : null;
    }

    const children = Array.isArray(navPoint?.navPoint)
      ? parseNavPoints(navPoint.navPoint, spine, baseDir, level + 1)
      : [];

    entries.push({
      title,
      pageNumber,
      level,
      children
    });
  }

  return entries;
}

async function extractTocFromSpine(spine: SpineItem[], zip: JSZip, reader?: GuardedReader): Promise<TocEntry[]> {
  const entries: TocEntry[] = [];

  for (let index = 0; index < spine.length; index += 1) {
    const item = spine[index];
    if (!item || !item.linear) {
      continue;
    }

    let title: string | null = null;
    if (reader) {
      try {
        title = extractFirstHeading(await reader(item.href));
      } catch {
        title = null;
      }
    } else {
      const file = zip.file(item.href);
      if (file) {
        title = extractFirstHeading(await file.async('string'));
      }
    }

    entries.push({
      title: title ?? filenameFallbackTitle(item.href),
      pageNumber: index + 1,
      level: 0,
      children: []
    });
  }

  return entries;
}

function extractFirstHeading(xhtml: string): string | null {
  for (const tag of ['h1', 'h2', 'h3']) {
    const match = xhtml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
    const body = match?.[1];
    if (body) {
      const text = stripTags(body).trim();
      if (text) {
        return text;
      }
    }
  }
  return null;
}

function filenameFallbackTitle(href: string): string {
  const basename = path.basename(href, path.extname(href));
  return basename.replace(/[-_]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase()).trim() || 'Untitled';
}

export function xhtmlToText(xhtml: string): string {
  let text = xhtml;
  text = text.replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '');
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(
    /<\/(p|div|h[1-6]|li|blockquote|tr|section|article|aside|header|footer|figcaption)>/gi,
    '\n\n'
  );
  text = text.replace(/<(h[1-6]|p|div|blockquote|section|article)[^>]*>/gi, '\n\n');
  text = text.replace(/<[^>]+>/g, '');
  text = decodeHtmlEntities(text);
  text = text.replace(/[ \t]{2,}/g, ' ');
  text = text.replace(/[ \t]+\n/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#160;/g, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number.parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

export function mapHrefToSpineIndex(href: string, spine: SpineItem[]): number | null {
  const [withoutFragment = ''] = href.split('#');
  const normalized = normalizePath(withoutFragment);

  for (let index = 0; index < spine.length; index += 1) {
    const item = spine[index];
    if (item && normalizePath(item.href) === normalized) {
      return index;
    }
  }

  return null;
}

function normalizePath(value: string): string {
  return value.replace(/^\.\//, '').replace(/\\/g, '/');
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

async function readZipText(zip: JSZip, archivePath: string): Promise<string> {
  const file = zip.file(archivePath);
  if (!file) {
    throw new Error(`Missing file in EPUB archive: ${archivePath}`);
  }
  return file.async('string');
}

const FONT_OBFUSCATION_ALGORITHMS = new Set([
  'http://www.idpf.org/2008/embedding',
  'http://ns.adobe.com/pdf/enc#RC'
]);

export async function hasDrmEncryption(zip: JSZip, reader?: GuardedReader): Promise<boolean> {
  const encryptionFile = zip.file('META-INF/encryption.xml');
  if (!encryptionFile) {
    return false;
  }

  let encryptionXml: string;
  try {
    encryptionXml = reader
      ? await reader('META-INF/encryption.xml')
      : await encryptionFile.async('string');
  } catch {
    return false;
  }

  let parsed: any;
  try {
    parsed = xmlParser.parse(encryptionXml);
  } catch {
    return false;
  }

  const encryptedDataEntries = findAllEncryptedData(parsed);
  if (encryptedDataEntries.length === 0) {
    return false;
  }

  for (const entry of encryptedDataEntries) {
    const algorithm = extractEncryptionAlgorithm(entry);
    if (!algorithm || !FONT_OBFUSCATION_ALGORITHMS.has(algorithm)) {
      return true;
    }
  }

  return false;
}

function findAllEncryptedData(node: unknown): unknown[] {
  if (!node || typeof node !== 'object') {
    return [];
  }

  const results: unknown[] = [];
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key.startsWith('@_')) {
      continue;
    }

    const localName = key.includes(':') ? key.split(':').pop() : key;
    if (localName === 'EncryptedData') {
      if (Array.isArray(value)) {
        results.push(...value);
      } else {
        results.push(value);
      }
      continue;
    }

    if (Array.isArray(value)) {
      for (const child of value) {
        results.push(...findAllEncryptedData(child));
      }
      continue;
    }

    results.push(...findAllEncryptedData(value));
  }

  return results;
}

function extractEncryptionAlgorithm(encryptedData: unknown): string | null {
  if (!encryptedData || typeof encryptedData !== 'object') {
    return null;
  }

  for (const [key, value] of Object.entries(encryptedData as Record<string, unknown>)) {
    if (key.startsWith('@_')) {
      continue;
    }

    const localName = key.includes(':') ? key.split(':').pop() : key;
    if (localName !== 'EncryptionMethod') {
      continue;
    }

    const node = Array.isArray(value) ? value[0] : value;
    if (node && typeof node === 'object') {
      const algorithm = (node as Record<string, unknown>)['@_Algorithm'] ?? (node as Record<string, unknown>)['@_algorithm'];
      return typeof algorithm === 'string' ? algorithm : null;
    }
  }

  return null;
}

export function looksLikeEpub(buffer: Buffer): boolean {
  return (
    buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    buffer[2] === 0x03 &&
    buffer[3] === 0x04
  );
}

export async function validateEpubStructure(buffer: Buffer): Promise<{ valid: boolean; error?: string }> {
  if (!looksLikeEpub(buffer)) {
    return { valid: false, error: 'File is not a ZIP archive.' };
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    return { valid: false, error: 'File could not be parsed as a ZIP archive.' };
  }

  const mimetypeFile = zip.file('mimetype');
  if (!mimetypeFile) {
    return { valid: false, error: 'Missing required EPUB mimetype file.' };
  }

  const mimetype = (await mimetypeFile.async('string')).trim();
  if (mimetype !== 'application/epub+zip') {
    return { valid: false, error: 'Invalid EPUB mimetype.' };
  }

  const containerFile = zip.file('META-INF/container.xml');
  if (!containerFile) {
    return { valid: false, error: 'Missing META-INF/container.xml.' };
  }

  let opfPath: string;
  try {
    opfPath = await resolveOpfPath(zip);
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Invalid EPUB container metadata.'
    };
  }

  if (!zip.file(opfPath)) {
    return { valid: false, error: `Missing OPF package document: ${opfPath}` };
  }

  return { valid: true };
}
