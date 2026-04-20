import { createHash, randomUUID } from 'node:crypto';
import type { ParsedBook, PriceSheet } from '@bookfold/sdk';
import {
  PARSER_VERSION,
  PROMPT_VERSION,
  SUMMARY_PLAN_VERSION,
  TOKENIZER_VERSION
} from '@bookfold/sdk/config';
import type { SummaryPlan, SummaryPlanPrice } from '@bookfold/sdk/server';
import type { BlobStore } from './blob.js';
import {
  buildJobCreateRateLimitRules,
  buildJobReadRateLimitRules,
  buildQuoteRateLimitRules,
  buildUploadRateLimitRules,
  enforceOpenUploadLimit,
  enforceRateLimits,
  maybePruneRateLimitBuckets,
  resolveClientSubjectKey,
  type RateLimitDecision
} from './rate-limit.js';
import type { JobPaymentGateway, JobReader, JobStarter } from './runtime.js';
import {
  buildFaviconSvg,
  buildLandingPage,
  buildLlmsText,
  buildOpenApiDocument,
  buildOwnershipProofToken,
  buildWellKnownDiscovery
} from './openapi.js';
import { loadServerConfig, SERVER_NAME, type ServerConfig } from './config.js';
import type { BookFoldStorage } from './storage/index.js';
import type { QuoteRecord } from './storage/types.js';

const BOOK_CONTENT_TYPES = {
  pdf: 'application/pdf',
  epub: 'application/epub+zip'
} as const;

const DETAIL_LEVELS = new Set(['short', 'medium', 'long']);

interface RuntimeDependencies {
  paymentGateway: JobPaymentGateway;
  jobReader: JobReader;
  jobStarter: JobStarter;
}

interface SdkServerModule {
  readonly DEFAULT_PRICE_SHEET: PriceSheet;
  parseBookFromBuffer(input: {
    fileBuffer: Buffer | Uint8Array;
    filePath: string;
    fileType?: 'pdf' | 'epub' | undefined;
  }): Promise<ParsedBook>;
  buildSummaryPlan(book: ParsedBook, detail: 'short' | 'medium' | 'long'): SummaryPlan;
  priceSummaryPlan(plan: SummaryPlan, priceSheet?: PriceSheet): SummaryPlanPrice;
  hashSummaryPlan(plan: SummaryPlan): string;
}

interface ServerAppDependencies {
  config?: ServerConfig | undefined;
  storage?: BookFoldStorage | undefined;
  blobStore?: BlobStore | undefined;
  clock?: (() => Date) | undefined;
  sdkServer?: SdkServerModule | undefined;
  paymentGateway?: JobPaymentGateway | undefined;
  jobStarter?: JobStarter | undefined;
  jobReader?: JobReader | undefined;
}

export interface ServerApp {
  readonly config: ServerConfig;
  fetch(request: Request): Promise<Response>;
}

export function createServerApp(input: ServerAppDependencies = {}): ServerApp {
  const config = input.config ?? loadServerConfig();
  const clock = input.clock ?? (() => new Date());
  let storage = input.storage;
  let blobStore = input.blobStore;

  let storagePromise: Promise<BookFoldStorage> | undefined;
  let blobStorePromise: Promise<BlobStore> | undefined;
  let bootstrapPromise: Promise<void> | undefined;
  let runtimeDependenciesPromise: Promise<RuntimeDependencies> | undefined;
  let sdkServerPromise: Promise<SdkServerModule> | undefined;
  let lastRateLimitPrunedAtMs: number | undefined;

  async function getStorage(): Promise<BookFoldStorage> {
    if (storage) {
      return storage;
    }

    storagePromise ??= import('./storage/create.js').then(({ createBookFoldStorage }) =>
      createBookFoldStorage({
        config
      })
    );

    storage = await storagePromise;
    return storage;
  }

  async function getBlobStore(): Promise<BlobStore> {
    if (blobStore) {
      return blobStore;
    }

    blobStorePromise ??= createRequiredBlobStore(config);
    blobStore = await blobStorePromise;
    return blobStore;
  }

  function ensureBootstrapped(): Promise<void> {
    bootstrapPromise ??= getStorage().then((resolvedStorage) => resolvedStorage.bootstrap());
    return bootstrapPromise;
  }

  async function getRuntimeDependencies(): Promise<RuntimeDependencies> {
    runtimeDependenciesPromise ??= import('./runtime.js').then(({ createServerDependencies }) =>
      createServerDependencies({ config })
    );
    return runtimeDependenciesPromise;
  }

  async function getSdkServer() {
    sdkServerPromise ??= input.sdkServer
      ? Promise.resolve(input.sdkServer)
      : import('@bookfold/sdk/server');
    return sdkServerPromise;
  }

  async function pruneRateLimitBucketsIfNeeded(resolvedStorage: BookFoldStorage): Promise<void> {
    lastRateLimitPrunedAtMs = await maybePruneRateLimitBuckets({
      storage: resolvedStorage,
      clock,
      bucketTtlSeconds: config.rateLimits.bucketTtlSeconds,
      lastPrunedAtMs: lastRateLimitPrunedAtMs
    });
  }

  return {
    config,
    async fetch(request: Request): Promise<Response> {
      try {
        const url = new URL(request.url);

        if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/') {
          return html(buildLandingPage(config));
        }

        if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/favicon.svg') {
          return assetText(buildFaviconSvg(), 'image/svg+xml; charset=utf-8');
        }

        if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/openapi.json') {
          return discoveryJson(buildOpenApiDocument(config));
        }

        if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/healthz') {
          return json(
            {
              ok: true,
              service: SERVER_NAME,
              environment: config.environment,
              priceSheetVersion: config.priceSheetVersion
            },
            200
          );
        }

        if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/v1/openapi.json') {
          return discoveryJson(buildOpenApiDocument(config));
        }

        if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/llms.txt') {
          return discoveryText(buildLlmsText(config));
        }

        if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/.well-known/x402') {
          return discoveryJson(buildWellKnownDiscovery(config));
        }

        if (
          (request.method === 'GET' || request.method === 'HEAD') &&
          url.pathname === '/.well-known/mpp-verify.txt'
        ) {
          return discoveryText(buildOwnershipProofToken(config));
        }

        if (request.method === 'POST' && url.pathname === '/v1/uploads') {
          await ensureBootstrapped();
          const storage = await getStorage();
          const blobStore = await getBlobStore();
          await pruneRateLimitBucketsIfNeeded(storage);

          const payload = await readJsonObject(request);
          const upload = validateUploadRequest(payload, config.maxUploadBytes);
          const openUploadDecision = await enforceOpenUploadLimit({
            storage,
            request,
            limit: config.rateLimits.openUploadsPerClient,
            clock
          });
          if (!openUploadDecision.allowed) {
            return rateLimitedJson(
              'too_many_open_uploads',
              'Too many upload tokens are still open. Use one or wait for one to expire.',
              openUploadDecision
            );
          }

          const uploadRateDecision = await enforceRateLimits({
            storage,
            request,
            scope: 'uploads',
            rules: buildUploadRateLimitRules(config.rateLimits),
            clock,
            byteCount: upload.sizeBytes
          });
          if (!uploadRateDecision.allowed) {
            return rateLimitedJson(
              'upload_rate_limited',
              'Upload rate limit exceeded. Wait and retry.',
              uploadRateDecision
            );
          }

          const uploadId = randomUUID();
          const blobPath = buildUploadBlobPath(uploadId, upload.fileName);
          const expiresAt = addMinutes(clock(), 15);
          const uploadToken = await blobStore.createUploadToken({
            pathname: blobPath,
            allowedContentTypes: upload.allowedContentTypes,
            maximumSizeInBytes: upload.sizeBytes,
            validUntil: expiresAt
          });

          await storage.createUpload({
            id: uploadId,
            blobPath,
            fileName: upload.fileName,
            contentType: upload.contentType,
            sizeBytes: upload.sizeBytes,
            status: 'pending',
            requestKey: resolveClientSubjectKey(request),
            uploadTokenExpiresAt: uploadToken.validUntil,
            metadata: {
              clientTokenValidUntil: uploadToken.validUntil,
              fileType: upload.fileType
            }
          });

          return withHeaders(
            json(
              {
                fileId: uploadId,
                blobPath,
                contentType: upload.contentType,
                sizeBytes: upload.sizeBytes,
                upload: {
                  method: 'PUT',
                  access: 'private',
                  clientToken: uploadToken.clientToken,
                  validUntil: uploadToken.validUntil
                }
              },
              200
            ),
            uploadRateDecision.headers
          );
        }

        if (request.method === 'POST' && url.pathname === '/v1/quotes') {
          await ensureBootstrapped();
          const storage = await getStorage();
          const blobStore = await getBlobStore();
          const sdk = await getSdkServer();
          await pruneRateLimitBucketsIfNeeded(storage);

          const payload = await readJsonObject(request);
          const quoteRequest = validateQuoteRequest(payload);
          const upload = await resolveUpload(storage, quoteRequest);
          if (!upload) {
            return errorJson(404, 'upload_not_found', 'Upload was not found.');
          }

          const quoteRateDecision = await enforceRateLimits({
            storage,
            request,
            scope: 'quotes',
            rules: buildQuoteRateLimitRules(config.rateLimits),
            clock
          });
          if (!quoteRateDecision.allowed) {
            return rateLimitedJson(
              'quote_rate_limited',
              'Quote rate limit exceeded. Wait and retry.',
              quoteRateDecision
            );
          }

          const blob = await blobStore.get(upload.blobPath);
          if (!blob) {
            return withHeaders(
              errorJson(409, 'upload_missing', 'Blob upload is not available yet.'),
              quoteRateDecision.headers
            );
          }

          const fileDigestSha256 = sha256Hex(blob.body);
          const priceSheet = await resolveConfiguredPriceSheet(storage, config, sdk);
          const cachedQuote = await createQuoteFromReusableTemplate({
            clock,
            config,
            detail: quoteRequest.detail,
            fileDigestSha256,
            priceSheetVersion: priceSheet.sheet.version,
            sdk,
            storage,
            upload
          });

          let plan: SummaryPlan;
          let price: SummaryPlanPrice;
          let quote: Awaited<ReturnType<BookFoldStorage['createQuote']>>;

          if (cachedQuote) {
            ({ plan, price, quote } = cachedQuote);
          } else {
            const fileType = detectServerBookFileType(upload.fileName);
            const book = await sdk.parseBookFromBuffer({
              fileBuffer: blob.body,
              filePath: upload.fileName,
              fileType
            });
            plan = sdk.buildSummaryPlan(book, quoteRequest.detail);
            price = sdk.priceSummaryPlan(plan, priceSheet.sheet);
            quote = await storage.createQuote({
              uploadId: upload.id,
              blobPath: upload.blobPath,
              detail: quoteRequest.detail,
              fileDigestSha256,
              planHash: sdk.hashSummaryPlan(plan),
              planJson: JSON.stringify(plan),
              priceJson: JSON.stringify(price),
              priceSheetVersion: priceSheet.sheet.version,
              amount: scaleMinorUnitAmount(
                price.amount,
                price.currencyDecimals,
                config.tempoCurrencyDecimals
              ),
              currency: config.tempoCurrency,
              expiresAt: addSeconds(clock(), config.quoteTtlSeconds).toISOString()
            });
          }

          await storage.updateUpload(upload.id, {
            status: 'uploaded',
            digestSha256: fileDigestSha256,
            metadata: {
              ...(upload.metadata ?? {}),
              blobContentType: blob.blob.contentType,
              blobSizeBytes: blob.blob.size
            }
          });

          await storage.upsertPriceSheet({
            version: priceSheet.sheet.version,
            payloadJson: priceSheet.payloadJson,
            createdAt: clock().toISOString()
          });

          return withHeaders(
            json(
              buildQuotePayload({
                config,
                quote,
                plan,
                price
              }),
              200
            ),
            quoteRateDecision.headers
          );
        }

        if (request.method === 'POST' && url.pathname === '/v1/jobs') {
          await ensureBootstrapped();
          const storage = await getStorage();
          const blobStore = await getBlobStore();
          await pruneRateLimitBucketsIfNeeded(storage);

          const jobCreateRateDecision = await enforceRateLimits({
            storage,
            request,
            scope: 'jobs.create',
            rules: buildJobCreateRateLimitRules(config.rateLimits),
            clock
          });
          if (!jobCreateRateDecision.allowed) {
            return rateLimitedJson(
              'job_create_rate_limited',
              'Job create rate limit exceeded. Wait and retry.',
              jobCreateRateDecision
            );
          }

          const runtimeDependencies =
            input.paymentGateway && input.jobStarter ? undefined : await getRuntimeDependencies();
          const paymentGateway = input.paymentGateway ?? runtimeDependencies!.paymentGateway;
          const jobStarter = input.jobStarter ?? runtimeDependencies!.jobStarter;

          return withHeaders(
            await paymentGateway.handleJobCreate({
              request,
              storage,
              blobStore,
              config,
              clock,
              jobStarter
            }),
            jobCreateRateDecision.headers
          );
        }

        if (request.method === 'GET' && url.pathname.startsWith('/v1/jobs/')) {
          await ensureBootstrapped();
          const storage = await getStorage();
          const blobStore = await getBlobStore();
          await pruneRateLimitBucketsIfNeeded(storage);

          const jobReadRateDecision = await enforceRateLimits({
            storage,
            request,
            scope: 'jobs.read',
            rules: buildJobReadRateLimitRules(config.rateLimits),
            clock
          });
          if (!jobReadRateDecision.allowed) {
            return rateLimitedJson(
              'job_read_rate_limited',
              'Job poll rate limit exceeded. Wait and retry.',
              jobReadRateDecision
            );
          }

          const jobReader = input.jobReader ?? (await getRuntimeDependencies()).jobReader;

          return withHeaders(
            await jobReader.read({
              request,
              storage,
              blobStore
            }),
            jobReadRateDecision.headers
          );
        }

        if (
          url.pathname === '/.well-known/workflow/v1/flow' ||
          url.pathname === '/.well-known/workflow/v1/step' ||
          url.pathname.startsWith('/.well-known/workflow/v1/webhook/')
        ) {
          return runWorkflowHandler(url.pathname, request);
        }

        return errorJson(404, 'not_found', `No route for ${request.method} ${url.pathname}.`);
      } catch (error) {
        if (error instanceof HttpError) {
          return errorJson(error.status, error.code, error.message);
        }

        return errorJson(
          500,
          'internal_error',
          'Internal server error.'
        );
      }
    }
  };
}

async function createRequiredBlobStore(config: ServerConfig): Promise<BlobStore> {
  if (!config.blobReadWriteToken) {
    throw new Error('Missing BLOB_READ_WRITE_TOKEN.');
  }

  const { VercelBlobStore } = await import('./blob.js');
  return new VercelBlobStore(config.blobReadWriteToken);
}

function buildUploadBlobPath(uploadId: string, fileName: string): string {
  return `uploads/${uploadId}/${sanitizeFileName(fileName)}`;
}

function sanitizeFileName(fileName: string): string {
  return fileName
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

function validateUploadRequest(payload: Record<string, unknown>, maxUploadBytes: number) {
  const fileName = asNonEmptyString(payload.fileName, 'fileName');
  let fileType: 'pdf' | 'epub';
  try {
    fileType = detectServerBookFileType(fileName);
  } catch (error) {
    throw new HttpError(
      400,
      'unsupported_file_type',
      error instanceof Error ? error.message : String(error)
    );
  }
  const declaredContentType = asOptionalString(payload.contentType);
  const contentType = normalizeContentType(fileType, declaredContentType);
  const sizeBytes = asPositiveInteger(payload.sizeBytes, 'sizeBytes');

  if (sizeBytes > maxUploadBytes) {
    throw new HttpError(
      400,
      'file_too_large',
      `Upload exceeds the current limit of ${maxUploadBytes} bytes.`
    );
  }

  return {
    fileName,
    fileType,
    contentType,
    sizeBytes,
    allowedContentTypes: Array.from(new Set([contentType, 'application/octet-stream']))
  };
}

function detectServerBookFileType(fileName: string): 'pdf' | 'epub' {
  const normalized = fileName.trim().toLowerCase();

  if (normalized.endsWith('.pdf')) {
    return 'pdf';
  }

  if (normalized.endsWith('.epub')) {
    return 'epub';
  }

  throw new Error('Unsupported file type: only .pdf and .epub are supported.');
}

function normalizeContentType(
  fileType: 'pdf' | 'epub',
  declaredContentType: string | undefined
): string {
  const canonical = BOOK_CONTENT_TYPES[fileType];

  if (!declaredContentType) {
    return canonical;
  }

  if (declaredContentType === canonical || declaredContentType === 'application/octet-stream') {
    return canonical;
  }

  throw new HttpError(
    400,
    'unsupported_content_type',
    `Expected ${canonical} for this file type.`
  );
}

function validateQuoteRequest(payload: Record<string, unknown>) {
  const detail = asNonEmptyString(payload.detail, 'detail');
  if (!DETAIL_LEVELS.has(detail)) {
    throw new HttpError(400, 'invalid_detail', 'Detail must be short, medium, or long.');
  }

  const uploadId = asOptionalString(payload.uploadId);
  const blobPath = asOptionalString(payload.blobPath);

  if (!uploadId && !blobPath) {
    throw new HttpError(400, 'missing_upload_locator', 'Provide uploadId or blobPath.');
  }

  return {
    detail: detail as 'short' | 'medium' | 'long',
    uploadId,
    blobPath
  };
}

async function resolveUpload(
  storage: BookFoldStorage,
  request: { uploadId?: string | undefined; blobPath?: string | undefined }
) {
  if (request.uploadId) {
    return storage.getUploadById(request.uploadId);
  }

  if (request.blobPath) {
    return storage.getUploadByBlobPath(request.blobPath);
  }

  return undefined;
}

async function createQuoteFromReusableTemplate(input: {
  clock: () => Date;
  config: ServerConfig;
  detail: 'short' | 'medium' | 'long';
  fileDigestSha256: string;
  priceSheetVersion: string;
  sdk: SdkServerModule;
  storage: BookFoldStorage;
  upload: NonNullable<Awaited<ReturnType<BookFoldStorage['getUploadById']>>>;
}): Promise<
  | {
      quote: Awaited<ReturnType<BookFoldStorage['createQuote']>>;
      plan: SummaryPlan;
      price: SummaryPlanPrice;
    }
  | undefined
> {
  const candidates = await input.storage.listRecentQuotesByDigest({
    fileDigestSha256: input.fileDigestSha256,
    detail: input.detail,
    priceSheetVersion: input.priceSheetVersion,
    currency: input.config.tempoCurrency
  });

  for (const candidate of candidates) {
    const template = parseReusableQuoteTemplate(candidate, input.config, input.sdk);
    if (!template) {
      continue;
    }

    const quote = await input.storage.createQuote({
      uploadId: input.upload.id,
      blobPath: input.upload.blobPath,
      detail: input.detail,
      fileDigestSha256: input.fileDigestSha256,
      planHash: candidate.planHash,
      planJson: candidate.planJson,
      priceJson: candidate.priceJson,
      priceSheetVersion: candidate.priceSheetVersion,
      amount: candidate.amount,
      currency: candidate.currency,
      expiresAt: addSeconds(input.clock(), input.config.quoteTtlSeconds).toISOString()
    });

    return {
      quote,
      plan: template.plan,
      price: template.price
    };
  }

  return undefined;
}

function parseReusableQuoteTemplate(
  quote: QuoteRecord,
  config: ServerConfig,
  sdk: SdkServerModule
): { plan: SummaryPlan; price: SummaryPlanPrice } | undefined {
  let plan: SummaryPlan;
  let price: SummaryPlanPrice;

  try {
    plan = JSON.parse(quote.planJson) as SummaryPlan;
    price = JSON.parse(quote.priceJson) as SummaryPlanPrice;
  } catch {
    return undefined;
  }

  if (plan.version !== SUMMARY_PLAN_VERSION) {
    return undefined;
  }

  if (plan.parserVersion !== PARSER_VERSION || plan.tokenizerVersion !== TOKENIZER_VERSION) {
    return undefined;
  }

  if (plan.promptVersion !== PROMPT_VERSION) {
    return undefined;
  }

  if (sdk.hashSummaryPlan(plan) !== quote.planHash) {
    return undefined;
  }

  if (price.priceSheetVersion !== quote.priceSheetVersion) {
    return undefined;
  }

  if (price.currencyDecimals !== config.tempoCurrencyDecimals) {
    return undefined;
  }

  if (
    quote.amount !==
    scaleMinorUnitAmount(price.amount, price.currencyDecimals, config.tempoCurrencyDecimals)
  ) {
    return undefined;
  }

  return { plan, price };
}

function buildQuotePayload(args: {
  config: ServerConfig;
  quote: Awaited<ReturnType<BookFoldStorage['createQuote']>>;
  plan: SummaryPlan;
  price: SummaryPlanPrice;
}) {
  const { config, quote, plan, price } = args;

  return {
    quoteId: quote.id,
    uploadId: quote.uploadId,
    blobPath: quote.blobPath,
    detail: quote.detail,
    amount: quote.amount,
    currency: quote.currency,
    currencyDecimals: config.tempoCurrencyDecimals,
    expiresAt: quote.expiresAt,
    fileDigestSha256: quote.fileDigestSha256,
    plan: {
      hash: quote.planHash,
      version: plan.version,
      strategy: plan.strategy,
      sectionCount: plan.sectionCount,
      totals: plan.totals,
      modelIds: Array.from(new Set(plan.calls.map((call) => call.model)))
    },
    versions: {
      parser: PARSER_VERSION,
      tokenizer: TOKENIZER_VERSION,
      prompt: PROMPT_VERSION,
      priceSheet: quote.priceSheetVersion
    },
    price
  };
}

async function resolveConfiguredPriceSheet(
  storage: BookFoldStorage,
  config: ServerConfig,
  sdk: SdkServerModule
): Promise<{ sheet: PriceSheet; payloadJson: string }> {
  const defaultPayloadJson = JSON.stringify(sdk.DEFAULT_PRICE_SHEET);
  if (config.priceSheetVersion === sdk.DEFAULT_PRICE_SHEET.version) {
    return {
      sheet: sdk.DEFAULT_PRICE_SHEET,
      payloadJson: defaultPayloadJson
    };
  }

  const stored = await storage.getPriceSheet(config.priceSheetVersion);
  if (!stored) {
    throw new HttpError(
      500,
      'price_sheet_not_found',
      `Configured price sheet ${config.priceSheetVersion} was not found.`
    );
  }

  let parsed: PriceSheet;
  try {
    parsed = JSON.parse(stored.payloadJson) as PriceSheet;
  } catch {
    throw new HttpError(
      500,
      'invalid_price_sheet',
      `Stored price sheet ${config.priceSheetVersion} is not valid JSON.`
    );
  }

  if (parsed.version !== config.priceSheetVersion) {
    throw new HttpError(
      500,
      'invalid_price_sheet',
      `Stored price sheet version ${parsed.version} does not match ${config.priceSheetVersion}.`
    );
  }

  return {
    sheet: parsed,
    payloadJson: stored.payloadJson
  };
}

async function runWorkflowHandler(pathname: string, request: Request): Promise<Response> {
  try {
    if (pathname === '/.well-known/workflow/v1/flow') {
      const module = await importWorkflowModule('flow');
      return module.POST(request);
    }

    if (pathname === '/.well-known/workflow/v1/step') {
      const module = await importWorkflowModule('step');
      return module.POST(request);
    }

    const module = await importWorkflowModule('webhook');
    const method = request.method.toUpperCase();
    const handler = module[method] as ((value: Request) => Promise<Response>) | undefined;

    if (!handler) {
      return errorJson(405, 'method_not_allowed', `Workflow webhook does not support ${method}.`);
    }

    return handler(request);
  } catch {
    return errorJson(
      503,
      'workflow_unavailable',
      'Workflow is temporarily unavailable.'
    );
  }
}

async function importWorkflowModule(name: 'flow' | 'step' | 'webhook') {
  const modulePath = new URL(`../../../.well-known/workflow/v1/${name}.js`, import.meta.url);
  return import(modulePath.href) as Promise<Record<string, any>>;
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let text: string;

  try {
    text = await request.text();
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body must be valid JSON.');
  }

  if (!text.trim()) {
    throw new HttpError(400, 'invalid_json', 'Request body must be valid JSON.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body must be valid JSON.');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'invalid_json', 'Request body must be a JSON object.');
  }

  return parsed as Record<string, unknown>;
}

function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(400, 'invalid_request', `${field} must be a non-empty string.`);
  }

  return value.trim();
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new HttpError(400, 'invalid_request', `${field} must be a positive integer.`);
  }

  return value;
}

function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function addMinutes(value: Date, minutes: number): Date {
  return new Date(value.getTime() + minutes * 60_000);
}

function addSeconds(value: Date, seconds: number): Date {
  return new Date(value.getTime() + seconds * 1_000);
}

function rateLimitedJson(code: string, message: string, decision: RateLimitDecision): Response {
  return withHeaders(errorJson(429, code, message), decision.headers);
}

function withHeaders(response: Response, headers: HeadersInit): Response {
  const merged = new Headers(response.headers);
  const incoming = new Headers(headers);
  incoming.forEach((value, key) => {
    merged.set(key, value);
  });

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged
  });
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

function discoveryJson(payload: unknown): Response {
  return withHeaders(json(payload, 200), {
    'cache-control': 'public, max-age=300'
  });
}

function text(payload: string, status = 200, contentType = 'text/plain; charset=utf-8'): Response {
  return new Response(payload, {
    status,
    headers: {
      'content-type': contentType,
      'cache-control': 'no-store'
    }
  });
}

function html(payload: string): Response {
  return withHeaders(text(payload, 200, 'text/html; charset=utf-8'), {
    'cache-control': 'public, max-age=300'
  });
}

function assetText(payload: string, contentType: string): Response {
  return withHeaders(text(payload, 200, contentType), {
    'cache-control': 'public, max-age=300'
  });
}

function discoveryText(payload: string): Response {
  return withHeaders(text(payload, 200), {
    'cache-control': 'public, max-age=300'
  });
}

function errorJson(status: number, code: string, message: string): Response {
  return json(
    {
      error: {
        code,
        message
      }
    },
    status
  );
}

function scaleMinorUnitAmount(amount: string, fromDecimals: number, toDecimals: number): string {
  if (!/^\d+$/.test(amount)) {
    throw new Error(`Expected amount to be a non-negative integer string, got "${amount}".`);
  }

  if (fromDecimals === toDecimals) {
    return amount;
  }

  const shift = Math.abs(toDecimals - fromDecimals);
  const factor = 10n ** BigInt(shift);

  if (toDecimals > fromDecimals) {
    return (BigInt(amount) * factor).toString();
  }

  const value = BigInt(amount);
  return ((value + factor - 1n) / factor).toString();
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
