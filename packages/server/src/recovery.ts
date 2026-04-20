import type { BookFoldStorage } from './storage/index.js';
import type { JobEventRecord, JobRecord, JobStatus } from './storage/types.js';
import { ensureJobWorkflowStarted, type JobStarter } from './runtime.js';

const RECOVERY_SCAN_STATUSES: JobStatus[] = ['paid', 'queued', 'running', 'succeeded', 'failed'];

export interface RecoveryReport {
  scannedJobs: number;
  restartedJobIds: string[];
  checkedJobIds: string[];
  flaggedJobIds: string[];
}

export async function recoverJobs(input: {
  clock: () => Date;
  jobStarter: JobStarter;
  storage: BookFoldStorage;
}): Promise<RecoveryReport> {
  await input.storage.bootstrap();

  const report: RecoveryReport = {
    scannedJobs: 0,
    restartedJobIds: [],
    checkedJobIds: [],
    flaggedJobIds: []
  };

  for (const status of RECOVERY_SCAN_STATUSES) {
    const jobs = await input.storage.listJobsByStatus(status);

    for (const job of jobs) {
      report.scannedJobs += 1;

      const events = await input.storage.listJobEvents(job.id);
      const beforeRunId = job.workflowRunId;
      const started = await ensureJobWorkflowStarted({
        clock: input.clock,
        job,
        jobStarter: input.jobStarter,
        source: 'recovery',
        storage: input.storage
      });

      if (!beforeRunId && started.workflowRunId) {
        report.restartedJobIds.push(job.id);
      } else if (job.status === 'running' && job.workflowRunId) {
        await appendEventOnce({
          eventType: 'job.recovery.checked',
          events,
          jobId: job.id,
          payload: {
            checkedAt: input.clock().toISOString(),
            workflowRunId: job.workflowRunId
          },
          storage: input.storage
        });
        report.checkedJobIds.push(job.id);
      }

      const inboundMissing = await flagInboundPaymentIssue({
        events,
        job: started,
        storage: input.storage
      });
      const outboundFlagged = await flagOutboundCloseErrors({
        events,
        job: started,
        storage: input.storage
      });

      if (inboundMissing || outboundFlagged) {
        report.flaggedJobIds.push(job.id);
      }
    }
  }

  report.restartedJobIds = dedupe(report.restartedJobIds);
  report.checkedJobIds = dedupe(report.checkedJobIds);
  report.flaggedJobIds = dedupe(report.flaggedJobIds);

  return report;
}

async function flagInboundPaymentIssue(input: {
  events: JobEventRecord[];
  job: JobRecord;
  storage: BookFoldStorage;
}): Promise<boolean> {
  if (!input.job.inboundPaymentId) {
    return false;
  }

  const payment = await input.storage.getInboundPaymentById(input.job.inboundPaymentId);
  if (payment) {
    return false;
  }

  await appendEventOnce({
    eventType: 'payment.inbound_missing',
    events: input.events,
    jobId: input.job.id,
    payload: {
      inboundPaymentId: input.job.inboundPaymentId
    },
    storage: input.storage
  });

  return true;
}

async function flagOutboundCloseErrors(input: {
  events: JobEventRecord[];
  job: JobRecord;
  storage: BookFoldStorage;
}): Promise<boolean> {
  const payments = await input.storage.listOutboundPayments(input.job.id);
  let flagged = false;

  for (const payment of payments) {
    if (!payment.closeError) {
      continue;
    }

    flagged = true;
    await appendEventOnce({
      eventType: 'payment.outbound_close_error',
      events: input.events,
      jobId: input.job.id,
      payload: {
        outboundPaymentId: payment.id,
        provider: payment.provider
      },
      storage: input.storage
    });
  }

  return flagged;
}

async function appendEventOnce(input: {
  eventType: string;
  events: JobEventRecord[];
  jobId: string;
  payload: Record<string, unknown>;
  storage: BookFoldStorage;
}): Promise<void> {
  const encoded = JSON.stringify(input.payload);
  const exists = input.events.some(
    (event) =>
      event.eventType === input.eventType &&
      JSON.stringify(event.payload ?? {}) === encoded
  );

  if (exists) {
    return;
  }

  await input.storage.appendJobEvent({
    jobId: input.jobId,
    eventType: input.eventType,
    payload: input.payload
  });
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}
