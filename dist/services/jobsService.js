"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isTransientError = isTransientError;
exports.getDueJobs = getDueJobs;
exports.markJobDone = markJobDone;
exports.markJobFailedPermanent = markJobFailedPermanent;
exports.scheduleJobRetry = scheduleJobRetry;
exports.runJobWithRetry = runJobWithRetry;
exports.createSyncJobIfNotExists = createSyncJobIfNotExists;
exports.createInvoiceJobIfNotExists = createInvoiceJobIfNotExists;
exports.createShipJobIfNotExists = createShipJobIfNotExists;
const axios_1 = __importDefault(require("axios"));
const knex_1 = require("../db/knex");
const logger_1 = require("../utils/logger");
/**
 * Determine if error is transient (worth retrying).
 */
function isTransientError(err) {
    if (!axios_1.default.isAxiosError(err)) {
        return false;
    }
    const status = err.response?.status;
    const data = err.response?.data;
    const messageFromData = typeof data === 'object' && data !== null && 'message' in data
        ? String(data.message)
        : '';
    const message = (messageFromData || err.message || '').toLowerCase();
    // Network-level / unknown status → treat as transient
    if (!status)
        return true;
    // Classic transient HTTP statuses
    if (status === 408 || status === 429)
        return true;
    if (status >= 500)
        return true;
    // 🔁 Magento deadlock / source item issues come back as HTTP 400
    if (status === 400 &&
        (message.includes('deadlock found when trying to get lock') ||
            message.includes('serialization failure: 1213') ||
            message.includes('could not save source item') ||
            message.includes("the shipment couldn't be saved"))) {
        return true;
    }
    return false;
}
/**
 * Atomically claim up to `limit` jobs that are due:
 *  - status in (PENDING, RETRY)
 *  - next_run_at is null or <= now()
 * Marks them RUNNING and bumps attempts in a single transaction.
 * Safe to call from multiple workers in parallel.
 */
async function getDueJobs(limit = 20) {
    return knex_1.db.transaction(async (trx) => {
        const now = trx.fn.now();
        let query = trx('jobs')
            .select('*')
            .whereIn('status', ['PENDING', 'RETRY'])
            .andWhere(qb => qb.whereNull('next_run_at').orWhere('next_run_at', '<=', now))
            .orderBy('id', 'asc')
            .limit(limit)
            .forUpdate();
        // If your DB/Knex supports skipLocked, use it to avoid blocking
        if (typeof query.skipLocked === 'function') {
            query.skipLocked();
        }
        const rows = await query;
        if (!rows.length) {
            return [];
        }
        const jobIds = rows.map((r) => r.id);
        await trx('jobs')
            .whereIn('id', jobIds)
            .update({
            status: 'RUNNING',
            attempts: trx.raw('attempts + 1'),
            updated_at: now
        });
        // Return updated copies with parsed payload + incremented attempts
        return rows.map((row) => ({
            ...row,
            status: 'RUNNING',
            attempts: (row.attempts ?? 0) + 1,
            payload: typeof row.payload === 'string'
                ? JSON.parse(row.payload)
                : row.payload
        }));
    });
}
/**
 * Mark job DONE.
 */
async function markJobDone(jobId, attempts) {
    await (0, knex_1.db)('jobs')
        .where({ id: jobId })
        .update({
        status: 'DONE',
        attempts,
        last_error: null,
        updated_at: knex_1.db.fn.now()
    });
}
/**
 * Mark job permanently FAILED.
 */
async function markJobFailedPermanent(jobId, attempts, error) {
    await (0, knex_1.db)('jobs')
        .where({ id: jobId })
        .update({
        status: 'FAILED',
        attempts,
        last_error: error,
        updated_at: knex_1.db.fn.now()
    });
}
/**
 * Schedule a retry with simple backoff using next_run_at.
 */
async function scheduleJobRetry(jobId, attempts, error) {
    // Simple backoff: 30s * attempts (tweak as you like)
    const delaySeconds = 30 * attempts;
    await (0, knex_1.db)('jobs')
        .where({ id: jobId })
        .update({
        status: 'RETRY',
        attempts,
        last_error: error,
        next_run_at: knex_1.db.raw(`DATE_ADD(NOW(), INTERVAL ? SECOND)`, [
            delaySeconds
        ]),
        updated_at: knex_1.db.fn.now()
    });
}
/**
 * Run a job with auto-retry.
 * NOTE: jobs passed in from getDueJobs() are already RUNNING + attempts incremented.
 */
async function runJobWithRetry(job, handler) {
    const ctx = `job:${job.id}`;
    const attempt = job.attempts ?? 1;
    const maxAttempts = job.max_attempts ?? 5;
    (0, logger_1.logInfo)(ctx, 'Running job', { attempt, maxAttempts });
    try {
        await handler(job);
        await markJobDone(job.id, attempt);
        (0, logger_1.logInfo)(ctx, 'Job completed');
    }
    catch (err) {
        const message = err?.message || String(err);
        const transient = isTransientError(err);
        if (!transient) {
            (0, logger_1.logError)(ctx, 'Permanent error, not retrying', { error: message });
            await markJobFailedPermanent(job.id, attempt, message);
            return;
        }
        if (attempt >= maxAttempts) {
            (0, logger_1.logError)(ctx, 'Max attempts reached, marking FAILED', {
                error: message,
                attempt,
                maxAttempts
            });
            await markJobFailedPermanent(job.id, attempt, message);
            return;
        }
        (0, logger_1.logError)(ctx, 'Transient error, scheduling retry', {
            error: message,
            attempt,
            maxAttempts
        });
        await scheduleJobRetry(job.id, attempt, message);
    }
}
/**
 * Create (or re-enable) a SYNC_ORDER job for a given order.
 */
async function createSyncJobIfNotExists(orderId) {
    const type = 'SYNC_ORDER_TO_MAGENTO';
    const existing = await (0, knex_1.db)('jobs')
        .where({ type })
        .andWhereRaw(`JSON_EXTRACT(payload, '$.order_id') = ?`, [orderId])
        .first();
    if (existing) {
        if (['FAILED', 'DONE'].includes(existing.status)) {
            await (0, knex_1.db)('jobs')
                .where({ id: existing.id })
                .update({
                status: 'PENDING',
                attempts: 0,
                last_error: null,
                next_run_at: null,
                updated_at: knex_1.db.fn.now()
            });
            (0, logger_1.logInfo)('jobs', 'Re-enabled existing job', { orderId, jobId: existing.id });
        }
        return;
    }
    const [id] = await (0, knex_1.db)('jobs').insert({
        type,
        payload: JSON.stringify({ order_id: orderId }),
        status: 'PENDING',
        attempts: 0,
        created_at: knex_1.db.fn.now(),
        updated_at: knex_1.db.fn.now()
    });
    (0, logger_1.logInfo)('jobs', 'Created new sync job', { orderId, jobId: id });
}
async function createInvoiceJobIfNotExists(orderId) {
    const type = 'INVOICE_MAGENTO_ORDER';
    const existing = await (0, knex_1.db)('jobs')
        .where({ type })
        .andWhereRaw(`JSON_EXTRACT(payload, '$.order_id') = ?`, [orderId])
        .first();
    if (existing) {
        if (['FAILED', 'DONE'].includes(existing.status)) {
            await (0, knex_1.db)('jobs')
                .where({ id: existing.id })
                .update({
                status: 'PENDING',
                attempts: 0,
                last_error: null,
                next_run_at: null,
                updated_at: knex_1.db.fn.now()
            });
            (0, logger_1.logInfo)('jobs', 'Re-enabled existing invoice job', {
                orderId,
                jobId: existing.id
            });
        }
        return;
    }
    const [id] = await (0, knex_1.db)('jobs').insert({
        type,
        payload: JSON.stringify({ order_id: orderId }),
        status: 'PENDING',
        attempts: 0,
        created_at: knex_1.db.fn.now(),
        updated_at: knex_1.db.fn.now()
    });
    (0, logger_1.logInfo)('jobs', 'Created new invoice job', { orderId, jobId: id });
}
async function createShipJobIfNotExists(orderId) {
    const type = 'SHIP_MAGENTO_ORDER';
    const existing = await (0, knex_1.db)('jobs')
        .where({ type })
        .andWhereRaw(`JSON_EXTRACT(payload, '$.order_id') = ?`, [orderId])
        .first();
    if (existing) {
        if (['FAILED', 'DONE'].includes(existing.status)) {
            await (0, knex_1.db)('jobs')
                .where({ id: existing.id })
                .update({
                status: 'PENDING',
                attempts: 0,
                last_error: null,
                next_run_at: null,
                updated_at: knex_1.db.fn.now()
            });
            (0, logger_1.logInfo)('jobs', 'Re-enabled existing ship job', {
                orderId,
                jobId: existing.id
            });
        }
        return;
    }
    const [id] = await (0, knex_1.db)('jobs').insert({
        type,
        payload: JSON.stringify({ order_id: orderId }),
        status: 'PENDING',
        attempts: 0,
        created_at: knex_1.db.fn.now(),
        updated_at: knex_1.db.fn.now()
    });
    (0, logger_1.logInfo)('jobs', 'Created new ship job', { orderId, jobId: id });
}
