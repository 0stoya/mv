import axios, { AxiosError } from 'axios';
import { db } from '../db/knex';
import { logInfo, logError } from '../utils/logger';

/**
 * Determine if error is transient (worth retrying).
 */
export function isTransientError(err: unknown): boolean {
  if (!axios.isAxiosError(err)) {
    return false;
  }

  const status = err.response?.status;
  const data: unknown = err.response?.data;
  const messageFromData =
    typeof data === 'object' && data !== null && 'message' in data
      ? String((data as { message?: unknown }).message)
      : '';
  const message = (messageFromData || err.message || '').toLowerCase();

  // Network-level / unknown status → treat as transient
  if (!status) return true;

  // Classic transient HTTP statuses
  if (status === 408 || status === 429) return true;
  if (status >= 500) return true;

  // 🔁 Magento deadlock / source item issues come back as HTTP 400
  if (
    status === 400 &&
    (
      message.includes('deadlock found when trying to get lock') ||
      message.includes('serialization failure: 1213') ||
      message.includes('could not save source item') ||
      message.includes("the shipment couldn't be saved")
    )
  ) {
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
export async function getDueJobs(limit: number = 20): Promise<any[]> {
  return db.transaction(async trx => {
    const now = trx.fn.now();

    let query = trx('jobs')
      .select('*')
      .whereIn('status', ['PENDING', 'RETRY'])
      .andWhere(qb =>
        qb.whereNull('next_run_at').orWhere('next_run_at', '<=', now)
      )
      .orderBy('id', 'asc')
      .limit(limit)
      .forUpdate();

    // If your DB/Knex supports skipLocked, use it to avoid blocking
    if (typeof (query as any).skipLocked === 'function') {
      (query as any).skipLocked();
    }

    const rows = await query;

    if (!rows.length) {
      return [];
    }

    const jobIds = rows.map((r: any) => r.id);

    await trx('jobs')
      .whereIn('id', jobIds)
      .update({
        status: 'RUNNING',
        attempts: trx.raw('attempts + 1'),
        updated_at: now
      });

    // Return updated copies with parsed payload + incremented attempts
    return rows.map((row: any) => ({
      ...row,
      status: 'RUNNING',
      attempts: (row.attempts ?? 0) + 1,
      payload:
        typeof row.payload === 'string'
          ? JSON.parse(row.payload)
          : row.payload
    }));
  });
}

/**
 * Mark job DONE.
 */
export async function markJobDone(jobId: number, attempts: number): Promise<void> {
  await db('jobs')
    .where({ id: jobId })
    .update({
      status: 'DONE',
      attempts,
      last_error: null,
      updated_at: db.fn.now()
    });
}

/**
 * Mark job permanently FAILED.
 */
export async function markJobFailedPermanent(
  jobId: number,
  attempts: number,
  error: string
): Promise<void> {
  await db('jobs')
    .where({ id: jobId })
    .update({
      status: 'FAILED',
      attempts,
      last_error: error,
      updated_at: db.fn.now()
    });
}

/**
 * Schedule a retry with simple backoff using next_run_at.
 */
export async function scheduleJobRetry(
  jobId: number,
  attempts: number,
  error: string
): Promise<void> {
  // Simple backoff: 30s * attempts (tweak as you like)
  const delaySeconds = 30 * attempts;

  await db('jobs')
    .where({ id: jobId })
    .update({
      status: 'RETRY',
      attempts,
      last_error: error,
      next_run_at: db.raw(`DATE_ADD(NOW(), INTERVAL ? SECOND)`, [
        delaySeconds
      ]),
      updated_at: db.fn.now()
    });
}

/**
 * Run a job with auto-retry.
 * NOTE: jobs passed in from getDueJobs() are already RUNNING + attempts incremented.
 */
export async function runJobWithRetry(
  job: any,
  handler: (job: any) => Promise<void>
): Promise<void> {
  const ctx = `job:${job.id}`;
  const attempt = job.attempts ?? 1;
  const maxAttempts = job.max_attempts ?? 5;

  logInfo(ctx, 'Running job', { attempt, maxAttempts });

  try {
    await handler(job);
    await markJobDone(job.id, attempt);
    logInfo(ctx, 'Job completed');
  } catch (err: any) {
    const message = err?.message || String(err);
    const transient = isTransientError(err);

    if (!transient) {
      logError(ctx, 'Permanent error, not retrying', { error: message });
      await markJobFailedPermanent(job.id, attempt, message);
      return;
    }

    if (attempt >= maxAttempts) {
      logError(ctx, 'Max attempts reached, marking FAILED', {
        error: message,
        attempt,
        maxAttempts
      });
      await markJobFailedPermanent(job.id, attempt, message);
      return;
    }

    logError(ctx, 'Transient error, scheduling retry', {
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
export async function createSyncJobIfNotExists(orderId: number): Promise<void> {
  const type = 'SYNC_ORDER_TO_MAGENTO';

  const existing = await db('jobs')
    .where({ type })
    .andWhereRaw(`JSON_EXTRACT(payload, '$.order_id') = ?`, [orderId])
    .first();

  if (existing) {
    if (['FAILED', 'DONE'].includes(existing.status)) {
      await db('jobs')
        .where({ id: existing.id })
        .update({
          status: 'PENDING',
          attempts: 0,
          last_error: null,
          next_run_at: null,
          updated_at: db.fn.now()
        });
      logInfo('jobs', 'Re-enabled existing job', { orderId, jobId: existing.id });
    }
    return;
  }

  const [id] = await db('jobs').insert({
    type,
    payload: JSON.stringify({ order_id: orderId }),
    status: 'PENDING',
    attempts: 0,
    created_at: db.fn.now(),
    updated_at: db.fn.now()
  });

  logInfo('jobs', 'Created new sync job', { orderId, jobId: id });
}

export async function createInvoiceJobIfNotExists(
  orderId: number
): Promise<void> {
  const type = 'INVOICE_MAGENTO_ORDER';

  const existing = await db('jobs')
    .where({ type })
    .andWhereRaw(`JSON_EXTRACT(payload, '$.order_id') = ?`, [orderId])
    .first();

  if (existing) {
    if (['FAILED', 'DONE'].includes(existing.status)) {
      await db('jobs')
        .where({ id: existing.id })
        .update({
          status: 'PENDING',
          attempts: 0,
          last_error: null,
          next_run_at: null,
          updated_at: db.fn.now()
        });
      logInfo('jobs', 'Re-enabled existing invoice job', {
        orderId,
        jobId: existing.id
      });
    }
    return;
  }

  const [id] = await db('jobs').insert({
    type,
    payload: JSON.stringify({ order_id: orderId }),
    status: 'PENDING',
    attempts: 0,
    created_at: db.fn.now(),
    updated_at: db.fn.now()
  });

  logInfo('jobs', 'Created new invoice job', { orderId, jobId: id });
}

export async function createShipJobIfNotExists(
  orderId: number
): Promise<void> {
  const type = 'SHIP_MAGENTO_ORDER';

  const existing = await db('jobs')
    .where({ type })
    .andWhereRaw(`JSON_EXTRACT(payload, '$.order_id') = ?`, [orderId])
    .first();

  if (existing) {
    if (['FAILED', 'DONE'].includes(existing.status)) {
      await db('jobs')
        .where({ id: existing.id })
        .update({
          status: 'PENDING',
          attempts: 0,
          last_error: null,
          next_run_at: null,
          updated_at: db.fn.now()
        });
      logInfo('jobs', 'Re-enabled existing ship job', {
        orderId,
        jobId: existing.id
      });
    }
    return;
  }

  const [id] = await db('jobs').insert({
    type,
    payload: JSON.stringify({ order_id: orderId }),
    status: 'PENDING',
    attempts: 0,
    created_at: db.fn.now(),
    updated_at: db.fn.now()
  });

  logInfo('jobs', 'Created new ship job', { orderId, jobId: id });
}
