import { randomUUID } from 'node:crypto';
import {
  get as getBlob,
  head as headBlob,
  put as putBlob
} from '@vercel/blob';
import { generateClientTokenFromReadWriteToken } from '@vercel/blob/client';

type BlobPutBody =
  | string
  | Buffer
  | Blob
  | ArrayBuffer
  | ReadableStream
  | Uint8Array
  | DataView;

export interface BlobRecord {
  pathname: string;
  contentType: string;
  size: number;
  url?: string | undefined;
  downloadUrl?: string | undefined;
  uploadedAt?: string | undefined;
  etag?: string | undefined;
}

export interface BlobBodyResult {
  blob: BlobRecord;
  body: Buffer;
}

export interface CreateBlobUploadTokenInput {
  pathname: string;
  allowedContentTypes: string[];
  maximumSizeInBytes: number;
  validUntil: Date;
}

export interface CreateBlobUploadTokenResult {
  clientToken: string;
  pathname: string;
  validUntil: string;
}

export interface BlobStore {
  createUploadToken(input: CreateBlobUploadTokenInput): Promise<CreateBlobUploadTokenResult>;
  get(pathname: string): Promise<BlobBodyResult | null>;
  head(pathname: string): Promise<BlobRecord | null>;
  put(pathname: string, body: BlobPutBody, options: { contentType: string }): Promise<BlobRecord>;
}

export class VercelBlobStore implements BlobStore {
  constructor(private readonly token: string) {}

  async createUploadToken(input: CreateBlobUploadTokenInput): Promise<CreateBlobUploadTokenResult> {
    const clientToken = await generateClientTokenFromReadWriteToken({
      token: this.token,
      pathname: input.pathname,
      allowedContentTypes: input.allowedContentTypes,
      maximumSizeInBytes: input.maximumSizeInBytes,
      validUntil: input.validUntil.getTime(),
      addRandomSuffix: false,
      allowOverwrite: false
    });

    return {
      clientToken,
      pathname: input.pathname,
      validUntil: input.validUntil.toISOString()
    };
  }

  async get(pathname: string): Promise<BlobBodyResult | null> {
    const result = await getBlob(pathname, {
      access: 'private',
      token: this.token,
      useCache: false
    });

    if (!result || result.statusCode !== 200) {
      return null;
    }

    const body = Buffer.from(await new Response(result.stream).arrayBuffer());

    return {
      blob: {
        pathname: result.blob.pathname,
        contentType: result.blob.contentType,
        size: result.blob.size,
        url: result.blob.url,
        downloadUrl: result.blob.downloadUrl,
        uploadedAt: result.blob.uploadedAt.toISOString(),
        etag: result.blob.etag
      },
      body
    };
  }

  async head(pathname: string): Promise<BlobRecord | null> {
    try {
      const blob = await headBlob(pathname, { token: this.token });
      return {
        pathname: blob.pathname,
        contentType: blob.contentType,
        size: blob.size,
        url: blob.url,
        downloadUrl: blob.downloadUrl,
        uploadedAt: blob.uploadedAt.toISOString(),
        etag: blob.etag
      };
    } catch {
      return null;
    }
  }

  async put(pathname: string, body: BlobPutBody, options: { contentType: string }): Promise<BlobRecord> {
    await putBlob(pathname, body as any, {
      access: 'private',
      token: this.token,
      contentType: options.contentType,
      addRandomSuffix: false,
      allowOverwrite: true
    });

    const stored = await this.head(pathname);
    if (!stored) {
      throw new Error(`Blob write succeeded but ${pathname} could not be read back.`);
    }

    return stored;
  }
}

interface MemoryBlobEntry {
  body: Buffer;
  contentType: string;
  etag: string;
  uploadedAt: string;
}

export class MemoryBlobStore implements BlobStore {
  readonly records = new Map<string, MemoryBlobEntry>();

  async createUploadToken(input: CreateBlobUploadTokenInput): Promise<CreateBlobUploadTokenResult> {
    return {
      clientToken: `memory-${randomUUID()}`,
      pathname: input.pathname,
      validUntil: input.validUntil.toISOString()
    };
  }

  async get(pathname: string): Promise<BlobBodyResult | null> {
    const record = this.records.get(pathname);
    if (!record) {
      return null;
    }

    return {
      blob: {
        pathname,
        contentType: record.contentType,
        size: record.body.byteLength,
        url: `memory://${pathname}`,
        downloadUrl: `memory://${pathname}`,
        uploadedAt: record.uploadedAt,
        etag: record.etag
      },
      body: Buffer.from(record.body)
    };
  }

  async head(pathname: string): Promise<BlobRecord | null> {
    const record = this.records.get(pathname);
    if (!record) {
      return null;
    }

    return {
      pathname,
      contentType: record.contentType,
      size: record.body.byteLength,
      url: `memory://${pathname}`,
      downloadUrl: `memory://${pathname}`,
      uploadedAt: record.uploadedAt,
      etag: record.etag
    };
  }

  async put(pathname: string, body: BlobPutBody, options: { contentType: string }): Promise<BlobRecord> {
    const buffer = await putBodyToBuffer(body);
    const uploadedAt = new Date().toISOString();
    const etag = randomUUID();

    this.records.set(pathname, {
      body: buffer,
      contentType: options.contentType,
      etag,
      uploadedAt
    });

    return {
      pathname,
      contentType: options.contentType,
      size: buffer.byteLength,
      url: `memory://${pathname}`,
      downloadUrl: `memory://${pathname}`,
      uploadedAt,
      etag
    };
  }
}

async function putBodyToBuffer(body: BlobPutBody): Promise<Buffer> {
  if (typeof body === 'string') {
    return Buffer.from(body);
  }

  if (Buffer.isBuffer(body)) {
    return body;
  }

  if (body instanceof ArrayBuffer) {
    return Buffer.from(body);
  }

  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }

  if (body instanceof Blob) {
    return Buffer.from(await body.arrayBuffer());
  }

  return Buffer.from(await new Response(body as ReadableStream).arrayBuffer());
}
