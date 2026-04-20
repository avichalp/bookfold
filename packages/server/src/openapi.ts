import {
  DEFAULT_PRICE_SHEET_VERSION,
  DEFAULT_TEMPO_CURRENCY,
  DEFAULT_TEMPO_DECIMALS,
  SERVER_NAME,
  type ServerConfig
} from './config.js';

export function buildOpenApiDocument(config: ServerConfig): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: 'BookFold MPP Server',
      version: '0.1.0',
      description:
        'Upload a PDF or EPUB, get a deterministic quote, pay over MPP, and poll for the finished summary.'
    },
    servers: [{ url: config.baseUrl }],
    tags: [
      { name: 'Health' },
      { name: 'Uploads' },
      { name: 'Quotes' },
      { name: 'Jobs' }
    ],
    paths: {
      '/healthz': {
        get: {
          tags: ['Health'],
          summary: 'Health check',
          responses: {
            '200': jsonResponse('#/components/schemas/Health', 'Server is alive.')
          }
        }
      },
      '/v1/openapi.json': {
        get: {
          tags: ['Health'],
          summary: 'OpenAPI document',
          responses: {
            '200': {
              description: 'OpenAPI document.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object'
                  }
                }
              }
            }
          }
        }
      },
      '/v1/uploads': {
        post: {
          tags: ['Uploads'],
          summary: 'Create a private direct upload target',
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
          tags: ['Quotes'],
          summary: 'Create a deterministic quote from an uploaded book',
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
          tags: ['Jobs'],
          summary: 'Create or resume a paid summary job',
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
            '202': jsonResponse('#/components/schemas/JobCreateResponse', 'Payment succeeded but queue start should be retried.'),
            '402': {
              description: 'MPP payment challenge.',
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
          tags: ['Jobs'],
          summary: 'Read job status and result payload',
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
