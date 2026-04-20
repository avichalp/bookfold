import assert from 'node:assert/strict';
import { put } from '@vercel/blob/client';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { Mppx, tempo } from 'mppx/client';
import { privateKeyToAccount } from 'viem/accounts';

const DEFAULT_DETAIL = 'short';
const POLL_ATTEMPTS = 36;
const POLL_DELAY_MS = 5_000;

type JobResponse = {
  jobId: string;
  status: string;
  workflowRunId?: string | undefined;
  warnings?: string[] | undefined;
  error?: { message?: string | undefined } | undefined;
  result?: { summary?: string | undefined } | undefined;
  payment?: { outbound?: unknown[] | undefined } | undefined;
};

function log(step: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ step, ...extra }));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveBaseUrl(): string {
  const baseUrl = process.env.BOOKFOLD_BASE_URL;

  assert.ok(baseUrl, 'BOOKFOLD_BASE_URL is required.');

  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('BOOKFOLD_BASE_URL must be a valid URL.');
  }

  const isProductionHost = url.hostname === 'bookfold.vercel.app';
  if (isProductionHost) {
    assert.equal(
      process.env.BOOKFOLD_ALLOW_PRODUCTION,
      'true',
      'Set BOOKFOLD_ALLOW_PRODUCTION=true before targeting production.'
    );
  }

  return url.origin;
}

async function buildFixturePdf(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);

  page.drawText('BookFold smoke test', { x: 72, y: 720, size: 24, font });
  page.drawText('This book proves the full hosted flow works.', {
    x: 72,
    y: 680,
    size: 14,
    font
  });
  page.drawText('Chapters', { x: 72, y: 630, size: 18, font });
  page.drawText('1. Start with a small PDF.', { x: 96, y: 600, size: 13, font });
  page.drawText('2. Ask BookFold for a quote.', { x: 96, y: 580, size: 13, font });
  page.drawText('3. Pay over MPP and wait for the summary.', {
    x: 96,
    y: 560,
    size: 13,
    font
  });

  return Buffer.from(await pdf.save());
}

async function main() {
  const baseUrl = resolveBaseUrl();
  const detail = process.env.BOOKFOLD_SMOKE_DETAIL ?? DEFAULT_DETAIL;
  const privateKey = process.env.TEMPO_PRIVATE_KEY;

  assert.ok(privateKey, 'TEMPO_PRIVATE_KEY is required.');

  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const paymentClient = Mppx.create({
    methods: [tempo({ account })],
    polyfill: false
  });

  const fixture = await buildFixturePdf();
  log('fixture', { sizeBytes: fixture.length });

  const healthResponse = await fetch(`${baseUrl}/healthz`);
  const health = await healthResponse.json();
  assert.equal(healthResponse.status, 200, 'healthz should return 200.');
  assert.equal(health.ok, true, 'healthz should return ok=true.');
  log('health', { status: healthResponse.status });

  const uploadResponse = await fetch(`${baseUrl}/v1/uploads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fileName: 'smoke.pdf',
      contentType: 'application/pdf',
      sizeBytes: fixture.length
    })
  });
  const upload = (await uploadResponse.json()) as {
    fileId: string;
    blobPath: string;
    upload: { clientToken: string };
  };
  assert.equal(uploadResponse.status, 200, 'upload target should return 200.');
  log('upload-target', {
    status: uploadResponse.status,
    fileId: upload.fileId,
    blobPath: upload.blobPath
  });

  const uploadedBlob = await put(upload.blobPath, fixture, {
    access: 'private',
    contentType: 'application/pdf',
    token: upload.upload.clientToken
  });
  log('blob-uploaded', { pathname: uploadedBlob.pathname });

  const quoteResponse = await fetch(`${baseUrl}/v1/quotes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uploadId: upload.fileId, detail })
  });
  const quote = (await quoteResponse.json()) as {
    quoteId: string;
    price: { amount: string; currency: string };
    error?: unknown;
  };
  assert.equal(quoteResponse.status, 200, 'quote should return 200.');
  assert.equal(quote.error, undefined, 'quote should not include an error.');
  log('quote', {
    status: quoteResponse.status,
    quoteId: quote.quoteId,
    amount: quote.price.amount,
    currency: quote.price.currency,
    error: quote.error ?? null
  });

  const jobBody = JSON.stringify({ quoteId: quote.quoteId });

  const unpaidResponse = await fetch(`${baseUrl}/v1/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: jobBody
  });
  const unpaidText = await unpaidResponse.text();
  assert.equal(unpaidResponse.status, 402, 'unpaid job create should return 402.');
  log('job-unpaid', {
    status: unpaidResponse.status,
    authenticate: unpaidResponse.headers.get('www-authenticate'),
    body: unpaidText
  });

  const paidResponse = await paymentClient.fetch(`${baseUrl}/v1/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: jobBody
  });
  const paid = (await paidResponse.json()) as JobResponse;
  assert.equal(paidResponse.status, 200, 'paid job create should return 200.');
  assert.equal(typeof paid.jobId, 'string');
  assert.equal(typeof paid.workflowRunId, 'string');
  log('job-paid', {
    status: paidResponse.status,
    jobId: paid.jobId,
    workflowRunId: paid.workflowRunId
  });

  let finalJob: JobResponse | undefined;
  for (let attempt = 1; attempt <= POLL_ATTEMPTS; attempt += 1) {
    await sleep(POLL_DELAY_MS);

    const pollResponse = await fetch(`${baseUrl}/v1/jobs/${paid.jobId}`);
    const poll = (await pollResponse.json()) as JobResponse;
    log('poll', {
      attempt,
      statusCode: pollResponse.status,
      jobStatus: poll.status,
      warnings: poll.warnings ?? [],
      error: poll.error ?? null
    });

    if (poll.status === 'succeeded' || poll.status === 'failed') {
      finalJob = poll;
      break;
    }
  }

  assert.ok(finalJob, 'job did not finish in time.');
  assert.equal(finalJob.status, 'succeeded', `job ended in ${finalJob.status}`);
  assert.equal(typeof finalJob.result?.summary, 'string');
  assert.ok(finalJob.result!.summary!.length > 0, 'summary should not be empty.');
  assert.ok(Array.isArray(finalJob.payment?.outbound), 'outbound payment list should exist.');
  assert.ok(finalJob.payment!.outbound!.length > 0, 'outbound payment list should not be empty.');

  log('done', {
    jobId: finalJob.jobId,
    status: finalJob.status,
    summaryLength: finalJob.result!.summary!.length,
    outboundPayments: finalJob.payment!.outbound!.length
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
