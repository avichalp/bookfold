import {
  DEFAULT_PRICE_SHEET_VERSION,
  DEFAULT_TEMPO_CURRENCY,
  DEFAULT_TEMPO_DECIMALS,
  SERVER_NAME,
  type ServerConfig
} from './config.js';

const PUBLIC_SERVICE_NAME = 'BookFold';
const PUBLIC_SERVICE_VERSION = '0.1.0';
const PUBLIC_SERVICE_DESCRIPTION =
  'Upload a PDF or EPUB, get a deterministic quote, pay over MPP, and poll for the finished summary.';
const OWNERSHIP_PROOF_PREFIX = 'mpp-verify=';

export function buildOwnershipProofToken(config: ServerConfig): string {
  return `${OWNERSHIP_PROOF_PREFIX}${new URL(config.baseUrl).host}`;
}

export function buildLlmsText(config: ServerConfig): string {
  const quoteMinutes = Math.max(1, Math.round(config.quoteTtlSeconds / 60));
  const maxUploadMegabytes = Math.floor(config.maxUploadBytes / (1024 * 1024));
  const docs = buildDocsLinks(config);

  return [
    `# ${PUBLIC_SERVICE_NAME}`,
    '',
    `${PUBLIC_SERVICE_NAME} is an MPP-paid API for summarizing PDF and EPUB books.`,
    '',
    `Base URL: ${config.baseUrl}`,
    `OpenAPI: ${docs.apiReference}`,
    '',
    '## Flow',
    '1. POST /v1/uploads with fileName, sizeBytes, and optional contentType.',
    '2. Use the returned upload.clientToken to upload the file with PUT.',
    '3. POST /v1/quotes with uploadId and detail.',
    '4. POST /v1/jobs with quoteId.',
    '5. If the server returns 402, pay the MPP challenge and retry the same POST /v1/jobs request.',
    '6. Poll GET /v1/jobs/{jobId} until the status is succeeded or failed.',
    '',
    '## Notes',
    `- Supported input: PDF and EPUB`,
    `- Max upload size: ${maxUploadMegabytes} MB`,
    `- Quote TTL: about ${quoteMinutes} minutes`,
    `- Scanned or image-only PDFs are not supported`,
    `- DRM-protected EPUBs are rejected`,
    `- The quote is the pricing source for POST /v1/jobs; the live 402 challenge is final`,
    '',
    '## Public docs',
    `- Homepage: ${docs.homepage}`,
    `- llms.txt: ${docs.llms}`
  ].join('\n');
}

export function buildLandingPage(config: ServerConfig): string {
  const docs = buildDocsLinks(config);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${PUBLIC_SERVICE_NAME}</title>
    <meta name="description" content="${PUBLIC_SERVICE_DESCRIPTION}" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <style>
      :root {
        color-scheme: light dark;
        --bg: #f7f7f2;
        --fg: #161614;
        --muted: #5d5b57;
        --line: #d7d3ca;
        --accent: #0b6bcb;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #11110f;
          --fg: #f3f1ec;
          --muted: #b7b1a8;
          --line: #2b2a26;
          --accent: #6fb1ff;
        }
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: var(--bg);
        color: var(--fg);
        font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      main {
        width: min(760px, calc(100vw - 32px));
        margin: 0 auto;
        padding: 48px 0 64px;
      }
      h1, h2, p, pre, ul { margin: 0; }
      h1 { font-size: 2.25rem; line-height: 1.1; }
      h2 { margin-top: 32px; font-size: 1rem; }
      p, li { color: var(--muted); }
      .lede { margin-top: 12px; max-width: 54ch; }
      .links, .flow, .notes { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--line); }
      ul { padding-left: 18px; }
      li + li { margin-top: 8px; }
      a { color: var(--accent); }
      pre {
        margin-top: 12px;
        padding: 12px;
        border: 1px solid var(--line);
        border-radius: 6px;
        overflow-x: auto;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${PUBLIC_SERVICE_NAME}</h1>
      <p class="lede">${PUBLIC_SERVICE_DESCRIPTION}</p>
      <section class="links">
        <h2>Docs</h2>
        <ul>
          <li><a href="${docs.apiReference}">OpenAPI</a></li>
          <li><a href="${docs.llms}">llms.txt</a></li>
        </ul>
      </section>
      <section class="flow">
        <h2>Flow</h2>
        <pre>client -> /v1/uploads
      -> Blob PUT
      -> /v1/quotes
      -> /v1/jobs
      <- 402
      -> /v1/jobs (paid retry)
      -> /v1/jobs/{jobId}</pre>
      </section>
      <section class="notes">
        <h2>Limits</h2>
        <ul>
          <li>PDF and EPUB only</li>
          <li>50 MB upload cap</li>
          <li>Scanned PDFs are not supported</li>
          <li>DRM EPUBs are rejected</li>
        </ul>
      </section>
    </main>
  </body>
</html>`;
}

export function buildFaviconSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="10" fill="#11110f" />
  <path
    d="M18 16h18c8.837 0 16 7.163 16 16v16H34c-8.837 0-16-7.163-16-16V16Z"
    fill="#f6f3ea"
  />
  <path
    d="M18 16h18c8.837 0 16 7.163 16 16v3H34c-8.837 0-16-7.163-16-16v-3Z"
    fill="#5aa9ff"
  />
</svg>`;
}

export function buildWellKnownDiscovery(config: ServerConfig): Record<string, unknown> {
  return {
    version: 1,
    description: PUBLIC_SERVICE_DESCRIPTION,
    resources: ['/openapi.json', '/llms.txt', '/v1/uploads', '/v1/quotes', '/v1/jobs', '/v1/jobs/{jobId}'],
    ownershipProofs: [buildOwnershipProofToken(config)],
    instructions: buildGuidance(config)
  };
}

export function buildOpenApiDocument(config: ServerConfig): Record<string, unknown> {
  const guidance = buildGuidance(config);
  const docs = buildDocsLinks(config);

  return {
    openapi: '3.1.0',
    info: {
      title: PUBLIC_SERVICE_NAME,
      version: PUBLIC_SERVICE_VERSION,
      description: PUBLIC_SERVICE_DESCRIPTION,
      guidance,
      'x-guidance': guidance
    },
    'x-service-info': {
      categories: ['ai', 'media'],
      docs
    },
    'x-discovery': {
      ownershipProofs: [buildOwnershipProofToken(config)]
    },
    servers: [{ url: config.baseUrl }],
    tags: [
      { name: 'Uploads' },
      { name: 'Quotes' },
      { name: 'Jobs' }
    ],
    paths: {
      '/v1/uploads': {
        post: {
          operationId: 'createUpload',
          tags: ['Uploads'],
          summary: 'Create a private direct upload target',
          description:
            'Creates a short-lived private upload target for one PDF or EPUB before quote creation.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/UploadRequest'
                }
              }
            }
          },
          responses: {
            '200': jsonResponse('#/components/schemas/UploadResponse', 'Upload target created.'),
            '400': jsonResponse('#/components/schemas/ErrorResponse', 'Invalid upload request.'),
            '429': tooManyRequestsResponse('Upload rate limit exceeded.')
          }
        }
      },
      '/v1/quotes': {
        post: {
          operationId: 'createQuote',
          tags: ['Quotes'],
          summary: 'Create a deterministic quote from an uploaded book',
          description:
            'Parses the uploaded book, freezes the summary plan, and returns the exact quote used by the paid job request.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/QuoteRequest'
                }
              }
            }
          },
          responses: {
            '200': jsonResponse('#/components/schemas/QuoteResponse', 'Quote created.'),
            '400': jsonResponse('#/components/schemas/ErrorResponse', 'Invalid quote request.'),
            '404': jsonResponse('#/components/schemas/ErrorResponse', 'Upload not found.'),
            '409': jsonResponse('#/components/schemas/ErrorResponse', 'Blob not uploaded yet.'),
            '429': tooManyRequestsResponse('Quote rate limit exceeded.')
          }
        }
      },
      '/v1/jobs': {
        post: {
          operationId: 'createJob',
          tags: ['Jobs'],
          summary: 'Create or resume a paid summary job',
          description:
            'Creates the paid summary job from a quote. Call once to receive the 402 challenge, then retry the same request after paying.',
          'x-payment-info': {
            price: {
              mode: 'dynamic',
              min: '0.05',
              max: '5.00',
              currency: 'USD'
            },
            protocols: [
              {
                mpp: {
                  method: 'tempo',
                  intent: 'charge',
                  currency: config.tempoCurrency
                }
              }
            ]
          },
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/JobCreateRequest'
                }
              }
            }
          },
          responses: {
            '200': jsonResponse('#/components/schemas/JobCreateResponse', 'Job created or reused.'),
            '202': jsonResponse(
              '#/components/schemas/JobCreateResponse',
              'Payment succeeded but queue start should be retried.'
            ),
            '402': {
              description: 'Payment Required',
              headers: {
                'WWW-Authenticate': {
                  schema: { type: 'string' },
                  description: 'MPP challenge for the paid retry.'
                }
              },
              content: {
                'application/json': {
                  schema: {
                    $ref: '#/components/schemas/ErrorResponse'
                  }
                }
              }
            },
            '404': jsonResponse('#/components/schemas/ErrorResponse', 'Quote not found.'),
            '410': jsonResponse('#/components/schemas/ErrorResponse', 'Quote expired.'),
            '429': tooManyRequestsResponse('Job create rate limit exceeded.')
          }
        }
      },
      '/v1/jobs/{jobId}': {
        get: {
          operationId: 'getJob',
          tags: ['Jobs'],
          summary: 'Read job status and result payload',
          description:
            'Reads the async job state. Keep polling until the status is succeeded or failed.',
          parameters: [
            {
              in: 'path',
              name: 'jobId',
              required: true,
              schema: {
                type: 'string'
              }
            }
          ],
          responses: {
            '200': jsonResponse('#/components/schemas/JobStatusResponse', 'Job payload.'),
            '404': jsonResponse('#/components/schemas/ErrorResponse', 'Job not found.'),
            '429': tooManyRequestsResponse('Job poll rate limit exceeded.')
          }
        }
      }
    },
    components: {
      schemas: {
        ErrorResponse: {
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message'],
              properties: {
                code: { type: 'string' },
                message: { type: 'string' }
              }
            }
          }
        },
        Health: {
          type: 'object',
          required: ['ok', 'service', 'priceSheetVersion'],
          properties: {
            ok: { type: 'boolean' },
            service: { type: 'string', example: SERVER_NAME },
            environment: { type: 'string' },
            priceSheetVersion: { type: 'string', example: DEFAULT_PRICE_SHEET_VERSION }
          }
        },
        UploadRequest: {
          type: 'object',
          required: ['fileName', 'sizeBytes'],
          properties: {
            fileName: {
              type: 'string',
              example: 'book.pdf'
            },
            contentType: {
              type: 'string',
              example: 'application/pdf'
            },
            sizeBytes: {
              type: 'integer',
              minimum: 1,
              example: 524288
            }
          }
        },
        UploadResponse: {
          type: 'object',
          required: ['fileId', 'blobPath', 'contentType', 'sizeBytes', 'upload'],
          properties: {
            fileId: { type: 'string' },
            blobPath: { type: 'string' },
            contentType: { type: 'string' },
            sizeBytes: { type: 'integer' },
            upload: {
              type: 'object',
              required: ['method', 'access', 'clientToken', 'validUntil'],
              properties: {
                method: { type: 'string', example: 'PUT' },
                access: { type: 'string', example: 'private' },
                clientToken: { type: 'string' },
                validUntil: { type: 'string', format: 'date-time' }
              }
            }
          }
        },
        QuoteRequest: {
          type: 'object',
          required: ['detail'],
          properties: {
            uploadId: { type: 'string' },
            blobPath: { type: 'string' },
            detail: {
              type: 'string',
              enum: ['short', 'medium', 'long']
            }
          }
        },
        QuoteResponse: {
          type: 'object',
          required: [
            'quoteId',
            'uploadId',
            'blobPath',
            'detail',
            'amount',
            'currency',
            'currencyDecimals',
            'expiresAt',
            'fileDigestSha256',
            'plan',
            'versions',
            'price'
          ],
          properties: {
            quoteId: { type: 'string' },
            uploadId: { type: 'string' },
            blobPath: { type: 'string' },
            detail: { type: 'string', enum: ['short', 'medium', 'long'] },
            amount: { type: 'string', example: '250000' },
            currency: {
              type: 'string',
              example: config.tempoCurrency ?? DEFAULT_TEMPO_CURRENCY
            },
            currencyDecimals: {
              type: 'integer',
              example: config.tempoCurrencyDecimals ?? DEFAULT_TEMPO_DECIMALS
            },
            expiresAt: { type: 'string', format: 'date-time' },
            fileDigestSha256: { type: 'string' },
            plan: {
              type: 'object',
              required: ['hash', 'version', 'strategy', 'sectionCount', 'totals', 'modelIds'],
              properties: {
                hash: { type: 'string' },
                version: { type: 'string' },
                strategy: { type: 'string' },
                sectionCount: { type: 'integer' },
                totals: {
                  type: 'object'
                },
                modelIds: {
                  type: 'array',
                  items: { type: 'string' }
                }
              }
            },
            versions: {
              type: 'object',
              required: ['parser', 'tokenizer', 'prompt', 'priceSheet'],
              properties: {
                parser: { type: 'string' },
                tokenizer: { type: 'string' },
                prompt: { type: 'string' },
                priceSheet: { type: 'string' }
              }
            },
            price: {
              type: 'object'
            }
          }
        },
        JobCreateRequest: {
          type: 'object',
          required: ['quoteId'],
          properties: {
            quoteId: {
              type: 'string'
            }
          }
        },
        JobCreateResponse: {
          type: 'object',
          required: ['jobId', 'quoteId', 'uploadId', 'status', 'createdAt', 'updatedAt'],
          properties: {
            jobId: { type: 'string' },
            quoteId: { type: 'string' },
            uploadId: { type: 'string' },
            status: {
              type: 'string',
              enum: ['paid', 'queued', 'running', 'succeeded', 'failed', 'refund_review']
            },
            workflowRunId: { type: 'string' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' }
          }
        },
        InboundPayment: {
          type: 'object',
          required: ['id', 'method', 'amount', 'currency', 'status', 'receiptReference', 'createdAt', 'updatedAt'],
          properties: {
            id: { type: 'string' },
            method: { type: 'string', example: 'tempo' },
            amount: { type: 'string' },
            currency: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'paid', 'failed'] },
            challengeId: { type: 'string' },
            receiptReference: { type: 'string' },
            receipt: { type: 'object' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' }
          }
        },
        OutboundPayment: {
          type: 'object',
          required: ['id', 'provider', 'kind', 'status', 'spent', 'cumulative', 'createdAt', 'updatedAt'],
          properties: {
            id: { type: 'string' },
            provider: { type: 'string' },
            kind: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'paid', 'failed'] },
            spent: { type: 'string' },
            cumulative: { type: 'string' },
            channelId: { type: 'string' },
            requestCount: { type: 'integer' },
            receipt: { type: 'object' },
            closeError: { type: 'string' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' }
          }
        },
        JobResult: {
          type: 'object',
          required: ['summary', 'detail', 'metadata', 'debug'],
          properties: {
            summary: { type: 'string' },
            detail: { type: 'string', enum: ['short', 'medium', 'long'] },
            metadata: { type: 'object' },
            debug: { type: 'object' }
          }
        },
        JobStatusResponse: {
          type: 'object',
          required: ['jobId', 'quoteId', 'uploadId', 'status', 'createdAt', 'updatedAt', 'payment'],
          properties: {
            jobId: { type: 'string' },
            quoteId: { type: 'string' },
            uploadId: { type: 'string' },
            status: {
              type: 'string',
              enum: ['paid', 'queued', 'running', 'succeeded', 'failed', 'refund_review']
            },
            workflowRunId: { type: 'string' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
            startedAt: { type: 'string', format: 'date-time' },
            completedAt: { type: 'string', format: 'date-time' },
            warnings: {
              type: 'array',
              items: { type: 'string' }
            },
            error: {
              type: 'object',
              properties: {
                message: { type: 'string' }
              }
            },
            payment: {
              type: 'object',
              required: ['outbound'],
              properties: {
                inbound: {
                  $ref: '#/components/schemas/InboundPayment'
                },
                outbound: {
                  type: 'array',
                  items: {
                    $ref: '#/components/schemas/OutboundPayment'
                  }
                }
              }
            },
            result: {
              $ref: '#/components/schemas/JobResult'
            }
          }
        }
      }
    }
  };
}

function buildGuidance(config: ServerConfig): string {
  const quoteMinutes = Math.max(1, Math.round(config.quoteTtlSeconds / 60));
  const maxUploadMegabytes = Math.floor(config.maxUploadBytes / (1024 * 1024));

  return [
    'Use POST /v1/uploads to create a private upload target for one PDF or EPUB.',
    'Upload the file with the returned client token.',
    'Use POST /v1/quotes to get the exact quote for the uploaded book.',
    'Use POST /v1/jobs with the quoteId to start the paid job.',
    'If POST /v1/jobs returns 402, pay the MPP challenge and retry the same request body.',
    'Poll GET /v1/jobs/{jobId} until the status is succeeded or failed.',
    `Books must be PDF or EPUB, uploads are capped at ${maxUploadMegabytes} MB, and quotes last about ${quoteMinutes} minutes.`,
    'Scanned PDFs are not supported and DRM-protected EPUBs are rejected.',
    'The live 402 challenge is the final payment source of truth.'
  ].join(' ');
}

function buildDocsLinks(config: ServerConfig) {
  return {
    homepage: `${config.baseUrl}/`,
    apiReference: `${config.baseUrl}/openapi.json`,
    llms: `${config.baseUrl}/llms.txt`
  };
}

function jsonResponse(schemaRef: string, description: string) {
  return {
    description,
    content: {
      'application/json': {
        schema: {
          $ref: schemaRef
        }
      }
    }
  };
}

function tooManyRequestsResponse(description: string) {
  return {
    description,
    headers: {
      'RateLimit-Limit': {
        schema: { type: 'string' },
        description: 'Current limit for the tightest active bucket.'
      },
      'RateLimit-Remaining': {
        schema: { type: 'string' },
        description: 'Remaining allowance for the tightest active bucket.'
      },
      'RateLimit-Reset': {
        schema: { type: 'string' },
        description: 'Seconds until the tightest active bucket resets.'
      },
      'RateLimit-Policy': {
        schema: { type: 'string' },
        description: 'Applied rate-limit windows for this route.'
      },
      'Retry-After': {
        schema: { type: 'string' },
        description: 'Seconds to wait before retrying.'
      }
    },
    content: {
      'application/json': {
        schema: {
          $ref: '#/components/schemas/ErrorResponse'
        }
      }
    }
  };
}
