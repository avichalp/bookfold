import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_PRICE_SHEET,
  buildSummaryPlan,
  parseBookFromBuffer,
  priceSummaryPlan,
  type PriceSheet
} from '@bookfold/sdk';
import { loadServerConfig } from '../src/index.js';
import { createPdfFixture } from '../../sdk/test/helpers.js';
import { createTestServer } from './helpers.js';

test('POST /v1/uploads returns a direct upload token and stores pending upload metadata', async () => {
  const server = await createTestServer();

  try {
    const response = await server.app.fetch(
      new Request('https://bookfold.test/v1/uploads', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          fileName: 'fixture.pdf',
          contentType: 'application/pdf',
          sizeBytes: 2048
        })
      })
    );
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.contentType, 'application/pdf');
    assert.equal(payload.sizeBytes, 2048);
    assert.equal(payload.upload.method, 'PUT');
    assert.equal(payload.upload.access, 'private');
    assert.equal(typeof payload.upload.clientToken, 'string');
    assert.match(payload.blobPath, /^uploads\/.+\/fixture\.pdf$/);

    const upload = await server.storage.getUploadById(payload.fileId);
    assert.equal(upload?.status, 'pending');
    assert.equal(upload?.blobPath, payload.blobPath);
    assert.equal(upload?.metadata?.fileType, 'pdf');
  } finally {
    await server.close();
  }
});

test('POST /v1/uploads rejects unsupported file types', async () => {
  const server = await createTestServer();

  try {
    const response = await server.app.fetch(
      new Request('https://bookfold.test/v1/uploads', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          fileName: 'notes.txt',
          contentType: 'text/plain',
          sizeBytes: 128
        })
      })
    );
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.equal(payload.error.code, 'unsupported_file_type');
  } finally {
    await server.close();
  }
});

test('POST /v1/quotes creates deterministic quotes from an uploaded blob', async () => {
  const server = await createTestServer();

  try {
    const uploadResponse = await server.app.fetch(
      new Request('https://bookfold.test/v1/uploads', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          fileName: 'fixture.pdf',
          contentType: 'application/pdf',
          sizeBytes: 4096
        })
      })
    );
    const upload = await uploadResponse.json();

    await server.blobStore.put(upload.blobPath, await createPdfFixture(), {
      contentType: 'application/pdf'
    });

    const quoteRequest = new Request('https://bookfold.test/v1/quotes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        uploadId: upload.fileId,
        detail: 'medium'
      })
    });

    const firstResponse = await server.app.fetch(quoteRequest.clone());
    const firstPayload = await firstResponse.json();
    const secondResponse = await server.app.fetch(quoteRequest.clone());
    const secondPayload = await secondResponse.json();

    assert.equal(firstResponse.status, 200);
    assert.equal(secondResponse.status, 200);
    assert.notEqual(firstPayload.quoteId, secondPayload.quoteId);
    assert.equal(firstPayload.plan.hash, secondPayload.plan.hash);
    assert.equal(firstPayload.amount, secondPayload.amount);
    assert.equal(firstPayload.currency, server.config.tempoCurrency);
    assert.equal(firstPayload.currencyDecimals, server.config.tempoCurrencyDecimals);
    assert.equal(firstPayload.fileDigestSha256, secondPayload.fileDigestSha256);
    assert.equal(firstPayload.plan.strategy, 'map-reduce');
    assert.ok(firstPayload.price.lines.length >= 1);

    const storedUpload = await server.storage.getUploadById(upload.fileId);
    assert.equal(storedUpload?.status, 'uploaded');
    assert.equal(storedUpload?.digestSha256, firstPayload.fileDigestSha256);

    const storedQuote = await server.storage.getQuoteById(firstPayload.quoteId);
    assert.equal(storedQuote?.planHash, firstPayload.plan.hash);
    assert.equal(storedQuote?.amount, firstPayload.amount);
    assert.equal(storedQuote?.currency, server.config.tempoCurrency);

    const priceSheet = await server.storage.getPriceSheet('bookfold-price-v1');
    assert.equal(priceSheet?.version, 'bookfold-price-v1');
  } finally {
    await server.close();
  }
});

test('POST /v1/quotes returns 409 when the blob is missing', async () => {
  const server = await createTestServer();

  try {
    const uploadResponse = await server.app.fetch(
      new Request('https://bookfold.test/v1/uploads', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          fileName: 'fixture.pdf',
          contentType: 'application/pdf',
          sizeBytes: 1024
        })
      })
    );
    const upload = await uploadResponse.json();

    const response = await server.app.fetch(
      new Request('https://bookfold.test/v1/quotes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          uploadId: upload.fileId,
          detail: 'short'
        })
      })
    );
    const payload = await response.json();

    assert.equal(response.status, 409);
    assert.equal(payload.error.code, 'upload_missing');
  } finally {
    await server.close();
  }
});

test('POST /v1/quotes uses the configured stored price sheet', async () => {
  const customPriceSheet: PriceSheet = {
    ...DEFAULT_PRICE_SHEET,
    version: 'bookfold-price-v2',
    bookfoldFeeMicrosUsd: {
      ...DEFAULT_PRICE_SHEET.bookfoldFeeMicrosUsd,
      short: '1'
    }
  };
  const server = await createTestServer({
    config: loadServerConfig({
      env: {
        NODE_ENV: 'test',
        BOOKFOLD_BASE_URL: 'https://bookfold.test',
        BOOKFOLD_PRICE_SHEET_VERSION: customPriceSheet.version
      }
    })
  });

  try {
    await server.storage.upsertPriceSheet({
      version: customPriceSheet.version,
      payloadJson: JSON.stringify(customPriceSheet),
      createdAt: '2026-04-15T00:00:00.000Z'
    });

    const pdf = await createPdfFixture();
    const uploadResponse = await server.app.fetch(
      new Request('https://bookfold.test/v1/uploads', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          fileName: 'fixture.pdf',
          contentType: 'application/pdf',
          sizeBytes: pdf.byteLength
        })
      })
    );
    const upload = await uploadResponse.json();

    await server.blobStore.put(upload.blobPath, pdf, {
      contentType: 'application/pdf'
    });

    const parsed = await parseBookFromBuffer({
      fileBuffer: pdf,
      filePath: 'fixture.pdf',
      fileType: 'pdf'
    });
    const expectedPrice = priceSummaryPlan(buildSummaryPlan(parsed, 'short'), customPriceSheet);

    const quoteResponse = await server.app.fetch(
      new Request('https://bookfold.test/v1/quotes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          uploadId: upload.fileId,
          detail: 'short'
        })
      })
    );
    const payload = await quoteResponse.json();

    assert.equal(quoteResponse.status, 200);
    assert.equal(payload.price.priceSheetVersion, customPriceSheet.version);
    assert.equal(payload.price.bookfoldFeeMicrosUsd, expectedPrice.bookfoldFeeMicrosUsd);
    assert.equal(payload.amount, expectedPrice.amount);

    const storedQuote = await server.storage.getQuoteById(payload.quoteId);
    assert.equal(storedQuote?.priceSheetVersion, customPriceSheet.version);
  } finally {
    await server.close();
  }
});

test('POST /v1/quotes returns the configured payable token metadata', async () => {
  const server = await createTestServer({
    config: loadServerConfig({
      env: {
        NODE_ENV: 'test',
        BOOKFOLD_BASE_URL: 'https://bookfold.test',
        BOOKFOLD_TEMPO_CURRENCY: '0x1111111111111111111111111111111111111111',
        BOOKFOLD_TEMPO_CURRENCY_DECIMALS: '8'
      }
    })
  });

  try {
    const pdf = await createPdfFixture();
    const uploadResponse = await server.app.fetch(
      new Request('https://bookfold.test/v1/uploads', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          fileName: 'fixture.pdf',
          contentType: 'application/pdf',
          sizeBytes: pdf.byteLength
        })
      })
    );
    const upload = await uploadResponse.json();

    await server.blobStore.put(upload.blobPath, pdf, {
      contentType: 'application/pdf'
    });

    const quoteResponse = await server.app.fetch(
      new Request('https://bookfold.test/v1/quotes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          uploadId: upload.fileId,
          detail: 'short'
        })
      })
    );
    const payload = await quoteResponse.json();
    const expectedAmount = (BigInt(payload.price.amount) * 100n).toString();

    assert.equal(quoteResponse.status, 200);
    assert.equal(payload.amount, expectedAmount);
    assert.equal(payload.currency, server.config.tempoCurrency);
    assert.equal(payload.currencyDecimals, 8);
    assert.equal(payload.price.currency, 'USD');
    assert.equal(payload.price.currencyDecimals, 6);

    const storedQuote = await server.storage.getQuoteById(payload.quoteId);
    assert.equal(storedQuote?.amount, expectedAmount);
  } finally {
    await server.close();
  }
});
