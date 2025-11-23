// src/workers/ordersWorker.ts
import 'dotenv/config';
import { randomUUID } from 'crypto';

import { getDueJobs, runJobWithRetry } from '../services/jobsService';
import {
  syncOrderById,
  invoiceOrderById,
  shipOrderById
} from '../services/orderSyncService';
import { logInfo, logError } from '../utils/logger';

const POLL_INTERVAL_MS = Number(process.env.JOBS_POLL_INTERVAL_MS || 2000);
const JOBS_BATCH_SIZE = Number(process.env.JOBS_BATCH_SIZE || 10);
// How many jobs we process IN PARALLEL in a batch
const JOBS_CONCURRENCY = Number(process.env.JOBS_CONCURRENCY || 1);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processBatch(runId: string): Promise<boolean> {
  const workerCtx = `worker:${runId}`;

  // Pull up to JOBS_BATCH_SIZE jobs that are due
  const jobs = await getDueJobs(JOBS_BATCH_SIZE);

  if (!jobs.length) {
    logInfo(workerCtx, 'No pending jobs, sleeping', {
      pollMs: POLL_INTERVAL_MS
    });
    return false;
  }

  const types = Array.from(new Set(jobs.map((j) => j.type)));

  logInfo(workerCtx, 'Found pending jobs', {
    count: jobs.length,
    types
  });

  // Simple concurrency pool
  const queue = [...jobs];

  const runNext = async (): Promise<void> => {
    // grab the next job from the queue
    const job = queue.shift();
    if (!job) return;

    const orderId = job.payload?.order_id;
    const jobCtx = `job:${job.id}-order:${orderId}-${runId}`;

    logInfo(jobCtx, 'Starting job', {
      jobId: job.id,
      type: job.type,
      attempts: job.attempts
    });

    try {
      await runJobWithRetry(job, async (lockedJob) => {
        const oid = lockedJob.payload?.order_id;
        if (!oid) {
          throw new Error('Job payload is missing order_id');
        }

        switch (lockedJob.type) {
          case 'SYNC_ORDER_TO_MAGENTO':
            await syncOrderById(oid, jobCtx);
            break;

          case 'INVOICE_MAGENTO_ORDER':
            await invoiceOrderById(oid, jobCtx);
            break;

          case 'SHIP_MAGENTO_ORDER':
            await shipOrderById(oid, jobCtx);
            break;

          default:
            throw new Error(`Unknown job type: ${lockedJob.type}`);
        }
      });
    } catch (err: any) {
      logError(jobCtx, 'Job execution failed', {
        error: err?.message || String(err)
      });
    }

    // After finishing this job, immediately try the next one in the queue
    await runNext();
  };

  // Start up to JOBS_CONCURRENCY parallel runners
  const runners: Promise<void>[] = [];
  const poolSize = Math.min(JOBS_CONCURRENCY, jobs.length);
  for (let i = 0; i < poolSize; i++) {
    runners.push(runNext());
  }

  await Promise.all(runners);

  logInfo(workerCtx, 'Processed batch of jobs', { batchSize: jobs.length });
  return true;
}

export async function startWorkerLoop(): Promise<void> {
  const runId = randomUUID();
  const workerCtx = `worker:${runId}`;

  logInfo(workerCtx, 'Starting worker loop', {
    pollMs: POLL_INTERVAL_MS,
    batchSize: JOBS_BATCH_SIZE,
    concurrency: JOBS_CONCURRENCY
  });

  // Continuous loop
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const hadJobs = await processBatch(runId);
      if (!hadJobs) {
        await sleep(POLL_INTERVAL_MS);
      }
    } catch (err: any) {
      logError(workerCtx, 'Worker loop iteration crashed', {
        error: err?.message || String(err)
      });
      await sleep(POLL_INTERVAL_MS);
    }
  }
}

// If run directly via `node dist/workers/ordersWorker.js`
if (require.main === module) {
  startWorkerLoop().catch((err) => {
    console.error('Fatal worker error', err);
    process.exit(1);
  });
}
