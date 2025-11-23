// src/workers/ordersWorker.ts
import { randomUUID } from 'crypto';
import { getDueJobs, runJobWithRetry } from '../services/jobsService';
import {
  syncOrderById,
  invoiceOrderById,
  shipOrderById
} from '../services/orderSyncService';
import { logInfo, logError } from '../utils/logger';

// Configuration
const POLL_INTERVAL_MS = Number(process.env.JOBS_POLL_INTERVAL_MS || 2000);
const JOBS_BATCH_SIZE = Number(process.env.JOBS_BATCH_SIZE || 20); 
const JOBS_CONCURRENCY = Number(process.env.JOBS_CONCURRENCY || 5);

let isShuttingDown = false;
let activeJobsCount = 0;

/**
 * Called by server.ts to tell the worker to stop picking up new work
 */
export async function signalShutdown() {
  isShuttingDown = true;
  logInfo('worker', 'Shutdown signal received. Waiting for active jobs to finish...');
  
  // Wait loop (optional: add a timeout)
  while (activeJobsCount > 0) {
    await new Promise(r => setTimeout(r, 500));
  }
  logInfo('worker', 'All jobs finished. Worker stopped.');
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Main Worker Loop
 */
export async function startWorkerLoop(): Promise<void> {
  const runId = randomUUID();
  const workerCtx = `worker:${runId}`;

  logInfo(workerCtx, 'Starting worker loop', {
    concurrency: JOBS_CONCURRENCY,
    pollMs: POLL_INTERVAL_MS
  });

  while (!isShuttingDown) {
    try {
      // 1. Check if we have free slots
      const freeSlots = JOBS_CONCURRENCY - activeJobsCount;
      
      if (freeSlots <= 0) {
        // Pool is full, wait a bit
        await sleep(200);
        continue;
      }

      // 2. Fetch only enough jobs to fill the slots
      // Note: getDueJobs MUST use 'FOR UPDATE SKIP LOCKED'
      const jobs = await getDueJobs(freeSlots);

      if (jobs.length === 0) {
        // No work, sleep standard interval
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      // 3. Process jobs in parallel (fire and forget the promise, track via counter)
      jobs.forEach(job => {
        activeJobsCount++; // Increment
        
        // Run async without awaiting here (the loop continues immediately)
        processJob(job, runId).finally(() => {
          activeJobsCount--; // Decrement when done
        });
      });

    } catch (err: any) {
      logError(workerCtx, 'Worker loop error', { error: err.message });
      await sleep(POLL_INTERVAL_MS);
    }
  }
}

/**
 * Individual Job Processor
 */
async function processJob(job: any, runId: string) {
  const orderId = job.payload?.order_id;
  const jobCtx = `job:${job.id}-order:${orderId}`;

  try {
    await runJobWithRetry(job, async (lockedJob) => {
      if (isShuttingDown) throw new Error('Worker shutting down');

      const oid = lockedJob.payload?.order_id;
      if (!oid) throw new Error('Payload missing order_id');

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
    // Errors are already logged inside runJobWithRetry usually, 
    // but we ensure context is preserved here.
    logError(jobCtx, 'Job processing failed', { error: err.message });
  }
}
