import axios from 'axios';
import { db } from '../db/knex';
import { logInfo, logError } from '../utils/logger';

// If you have a types file, import this. Otherwise use this interface.
export interface JobRow {
  id: number;
  type: string;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'RETRY' | 'DONE';
  payload: any;
  attempts: number;
  max_attempts: number;
  last_error?: string | null;
  next_run_at?: Date | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Determine if error is transient (worth retrying).
 */
export function isTransientError(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return false;

  const status = err.response?.status;
  const data: any = err.response?.data;
  
  // Extract message safely
  const messageFromData = (typeof data === 'object' && data?.message) ? String(data.message) : '';
  const message = (messageFromData || err.message || '').toLowerCase();

  // 1. Network / Unknown -> Transient
  if (!status) return true;

  // 2. Standard HTTP Transient Codes
  // 408: Timeout, 429: Rate Limit, 500+: Server Error, 503: Maintenance
  if (status === 408 || status === 429 || status >= 500) return true;

  // 3. Magento-Specific "Fake" 400 Errors (Deadlocks/Locking)
  if (status === 400) {
    const knownRetriables = [
      'deadlock found',
      'serialization failure',
      'lock wait timeout',
      'could not save source item', 
      "the shipment couldn't be saved"
    ];
    return knownRetriables.some(phrase => message.includes(phrase));
  }

  return false;
}

/**
 * Atomically claim jobs.
 * Uses FOR UPDATE SKIP LOCKED to allow multiple concurrent workers.
 */
export async function getDueJobs(limit: number = 20): Promise<JobRow[]> {
  return db.transaction(async (trx) => {
    const now = new Date();

    // 1. Find candidates
    let query = trx('jobs')
      .select('*')
      .whereIn('status', ['PENDING', 'RETRY'])
      .andWhere(qb => {
        qb.whereNull('next_run_at').orWhere('next_run_at', '<=', now);
      })
      .orderBy('id', 'asc') // FIFO
      .limit(limit)
      .forUpdate();

    // 2. Apply Skip Locked (Supported in MySQL 8+ and Postgres)
    // Checks if the knex driver supports it standardly
    if (query.skipLocked) {
      query = query.skipLocked();
    }

    const rows = await query;
    if (!rows.length) return [];

    // 3. Mark them RUNNING immediately so no one else grabs them
    const jobIds = rows.map((r) => r.id);
    await trx('jobs')
      .whereIn('id', jobIds)
      .update({
        status: 'RUNNING',
        attempts: trx.raw('attempts + 1'), // Atomic increment
        updated_at: now
      });

    // 4. Return parsed objects
    return rows.map((row) => ({
      ...row,
      status: 'RUNNING',
      attempts: (row.attempts || 0) + 1,
      payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload
    })) as JobRow[];
  });
}

/**
 * Helper: Run a job wrapper
 */
export async function runJobWithRetry(
  job: JobRow,
  handler: (job: JobRow) => Promise<void>
): Promise<void> {
  const ctx = `job:${job.id}`;
  const attempt = job.attempts;
  const maxAttempts = job.max_attempts || 5;

  // logInfo(ctx, 'Starting execution', { attempt, maxAttempts });

  try {
    await handler(job);
    
    // Success
    await db('jobs').where({ id: job.id }).update({
      status: 'DONE',
      last_error: null,
      updated_at: new Date()
    });
    // logInfo(ctx, 'Job DONE');

  } catch (err: any) {
    const message = err?.message || String(err);
    const transient = isTransientError(err);
    
    // PERMANENT FAILURE
    if (!transient || attempt >= maxAttempts) {
      const reason = !transient ? 'Non-transient error' : 'Max attempts reached';
      logError(ctx, `Job FAILED (${reason})`, { error: message });

      await db('jobs').where({ id: job.id }).update({
        status: 'FAILED',
        last_error: message,
        updated_at: new Date()
      });
      return;
    }

    // RETRY SCHEDULE
    // Exponential Backoff: 30s, 60s, 120s, 240s...
    const delaySeconds = 30 * Math.pow(2, attempt - 1); 
    
    logError(ctx, `Job RETRY in ${delaySeconds}s`, { error: message });

    await db('jobs').where({ id: job.id }).update({
      status: 'RETRY',
      last_error: message,
      next_run_at: db.raw(`DATE_ADD(NOW(), INTERVAL ? SECOND)`, [delaySeconds]),
      updated_at: new Date()
    });
  }
}

/**
 * GENERIC HELPER: Ensures a job exists for an order.
 * - If exists and FAILED/DONE -> Reset to PENDING.
 * - If doesn't exist -> Create PENDING.
 * - If exists and PENDING/RUNNING -> Do nothing.
 */
async function ensureJob(type: string, orderId: number) {
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
          updated_at: new Date()
        });
      logInfo('jobs', `Reset job ${existing.id} (${type})`, { orderId });
    }
    return;
  }

  // Create New
  const [id] = await db('jobs').insert({
    type,
    payload: JSON.stringify({ order_id: orderId }),
    status: 'PENDING',
    attempts: 0,
    max_attempts: 5, // Default max
    created_at: new Date(),
    updated_at: new Date()
  });

  logInfo('jobs', `Created job ${id} (${type})`, { orderId });
}

// ============================================================================
// PUBLIC FACADE
// ============================================================================

export async function createSyncJobIfNotExists(orderId: number) {
  return ensureJob('SYNC_ORDER_TO_MAGENTO', orderId);
}

export async function createInvoiceJobIfNotExists(orderId: number) {
  return ensureJob('INVOICE_MAGENTO_ORDER', orderId);
}

export async function createShipJobIfNotExists(orderId: number) {
  return ensureJob('SHIP_MAGENTO_ORDER', orderId);
}
