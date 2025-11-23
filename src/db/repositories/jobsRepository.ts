// src/db/repositories/jobsRepository.ts
import { db } from '../knex';
import { JobRow } from '../../types/order';

export async function createSyncJobIfNotExists(
  orderId: number
): Promise<void> {
  const type = 'SYNC_ORDER_TO_MAGENTO';
  const payload = { order_id: orderId };

  const existing = await db<JobRow>('jobs')
    .whereRaw(`JSON_EXTRACT(payload, '$.order_id') = ?`, [orderId])
    .andWhere({ type })
    .first();

  if (existing) {
    // If job is FAILED, requeue it
    if (existing.status === 'FAILED') {
      await db('jobs')
        .where({ id: existing.id })
        .update({
          status: 'PENDING',
          attempts: 0,
          last_error: null,
          next_run_at: null,
          updated_at: db.fn.now()
        });
    }
    // If PENDING/RUNNING/DONE, do nothing
    return;
  }

  await db('jobs').insert({
    type,
    payload: JSON.stringify(payload),
    status: 'PENDING',
    attempts: 0,
    max_attempts: 3, // or whatever default you want
    next_run_at: null
  });
}

/**
 * Simple "read-only" helper. Fine for diagnostics, but
 * NOT safe for multiple workers to use for execution.
 */
export async function getPendingJobs(
  type: string,
  limit = 10
): Promise<JobRow[]> {
  return db<JobRow>('jobs')
    .where({ type, status: 'PENDING' })
    .orderBy('id', 'asc')
    .limit(limit);
}

/**
 * Atomically claim up to `limit` jobs that are due:
 * - status = PENDING
 * - next_run_at is null or <= now()
 * Marks them RUNNING and bumps attempts inside a single transaction.
 * Safe to call from multiple worker processes in parallel.
 */
export async function claimDueJobs(
  limit = 20
): Promise<JobRow[]> {
  return db.transaction(async (trx) => {
    const now = trx.fn.now();

    // Select a batch of pending, due jobs and lock them
    let query = trx<JobRow>('jobs')
      .select('*')
      .where('status', 'PENDING')
      .andWhere((qb) =>
        qb.whereNull('next_run_at').orWhere('next_run_at', '<=', now)
      )
      .orderBy('id', 'asc')
      .limit(limit)
      .forUpdate();

    // If you're on MySQL 8 / MariaDB 10.6+, you can skip locked rows:
    // @ts-ignore - knex has skipLocked in recent versions
    if (typeof (query as any).skipLocked === 'function') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (query as any).skipLocked();
    }

    const jobs = await query;

    if (!jobs.length) {
      return [];
    }

    const jobIds = jobs.map((j) => j.id);

    await trx('jobs')
      .whereIn('id', jobIds)
      .update({
        status: 'RUNNING',
        attempts: trx.raw('attempts + 1'),
        updated_at: now
      });

    // Return updated copies to the caller
    return jobs.map((j) => ({
      ...j,
      status: 'RUNNING',
      attempts: (j.attempts ?? 0) + 1
    }) as JobRow);
  });
}

export async function markJobRunning(id: number): Promise<void> {
  await db('jobs')
    .where({ id })
    .update({
      status: 'RUNNING',
      attempts: db.raw('attempts + 1'),
      updated_at: db.fn.now()
    });
}

export async function markJobDone(id: number): Promise<void> {
  await db('jobs')
    .where({ id })
    .update({
      status: 'DONE',
      last_error: null,
      updated_at: db.fn.now()
    });
}

export async function markJobFailed(id: number, error: string): Promise<void> {
  await db('jobs')
    .where({ id })
    .update({
      status: 'FAILED',
      last_error: error,
      updated_at: db.fn.now()
    });
}
