"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startWorkerLoop = startWorkerLoop;
// src/workers/ordersWorker.ts
require("dotenv/config");
const crypto_1 = require("crypto");
const jobsService_1 = require("../services/jobsService");
const orderSyncService_1 = require("../services/orderSyncService");
const logger_1 = require("../utils/logger");
const POLL_INTERVAL_MS = Number(process.env.JOBS_POLL_INTERVAL_MS || 2000);
const JOBS_BATCH_SIZE = Number(process.env.JOBS_BATCH_SIZE || 10);
// How many jobs we process IN PARALLEL in a batch
const JOBS_CONCURRENCY = Number(process.env.JOBS_CONCURRENCY || 10);
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
async function processBatch(runId) {
    const workerCtx = `worker:${runId}`;
    // Pull up to JOBS_BATCH_SIZE jobs that are due
    const jobs = await (0, jobsService_1.getDueJobs)(JOBS_BATCH_SIZE);
    if (!jobs.length) {
        (0, logger_1.logInfo)(workerCtx, 'No pending jobs, sleeping', {
            pollMs: POLL_INTERVAL_MS
        });
        return false;
    }
    const types = Array.from(new Set(jobs.map((j) => j.type)));
    (0, logger_1.logInfo)(workerCtx, 'Found pending jobs', {
        count: jobs.length,
        types
    });
    // Simple concurrency pool
    const queue = [...jobs];
    const runNext = async () => {
        // grab the next job from the queue
        const job = queue.shift();
        if (!job)
            return;
        const orderId = job.payload?.order_id;
        const jobCtx = `job:${job.id}-order:${orderId}-${runId}`;
        (0, logger_1.logInfo)(jobCtx, 'Starting job', {
            jobId: job.id,
            type: job.type,
            attempts: job.attempts
        });
        try {
            await (0, jobsService_1.runJobWithRetry)(job, async (lockedJob) => {
                const oid = lockedJob.payload?.order_id;
                if (!oid) {
                    throw new Error('Job payload is missing order_id');
                }
                switch (lockedJob.type) {
                    case 'SYNC_ORDER_TO_MAGENTO':
                        await (0, orderSyncService_1.syncOrderById)(oid, jobCtx);
                        break;
                    case 'INVOICE_MAGENTO_ORDER':
                        await (0, orderSyncService_1.invoiceOrderById)(oid, jobCtx);
                        break;
                    case 'SHIP_MAGENTO_ORDER':
                        await (0, orderSyncService_1.shipOrderById)(oid, jobCtx);
                        break;
                    default:
                        throw new Error(`Unknown job type: ${lockedJob.type}`);
                }
            });
        }
        catch (err) {
            (0, logger_1.logError)(jobCtx, 'Job execution failed', {
                error: err?.message || String(err)
            });
        }
        // After finishing this job, immediately try the next one in the queue
        await runNext();
    };
    // Start up to JOBS_CONCURRENCY parallel runners
    const runners = [];
    const poolSize = Math.min(JOBS_CONCURRENCY, jobs.length);
    for (let i = 0; i < poolSize; i++) {
        runners.push(runNext());
    }
    await Promise.all(runners);
    (0, logger_1.logInfo)(workerCtx, 'Processed batch of jobs', { batchSize: jobs.length });
    return true;
}
async function startWorkerLoop() {
    const runId = (0, crypto_1.randomUUID)();
    const workerCtx = `worker:${runId}`;
    (0, logger_1.logInfo)(workerCtx, 'Starting worker loop', {
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
        }
        catch (err) {
            (0, logger_1.logError)(workerCtx, 'Worker loop iteration crashed', {
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
