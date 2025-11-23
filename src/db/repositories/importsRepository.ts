// src/db/repositories/importsRepository.ts
import { db } from '../knex';
import type { OrderRow } from '../../types/order';

export interface GetImportsParams {
  jobId?: number;
  limit?: number;
  offset?: number;
}

export interface ImportRowDb {
  id: number;
  header_filename: string;
  items_filename: string;
  imported_by: string;
  total_orders: number;
  processed_orders: number;
  failed_orders: number;
  skipped_orders: number;
  status: string;
  error: string | null;
  job_id: number | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface ImportProgress {
  total: number;
  synced: number;
  invoiced: number;
  shipped: number;
  failed: number;
}

export interface ImportsResult {
  data: (ImportRowDb & { progress?: ImportProgress })[];
  pagination: {
    limit: number;
    offset: number;
    count: number;
  };
}

export async function getImports(params: GetImportsParams): Promise<ImportsResult> {
  const limit = Math.min(params.limit ?? 50, 200);
  const offset = params.offset ?? 0;
  const jobId = params.jobId;

  const base = db<ImportRowDb>('imports');
  let query = base.clone();

  if (jobId) {
    query = query.where('job_id', jobId);
  }

  const [rows, countRow] = await Promise.all([
    query.orderBy('id', 'desc').limit(limit).offset(offset),
    base
      .clone()
      .modify(qb => {
        if (jobId) qb.where('job_id', jobId);
      })
      .count<{ count: string | number }>({ count: '*' })
      .first()
  ]);

  const count = Number(countRow?.count ?? 0);

  // ────────────────────────────────────────────────
  // Attach progress per import via orders.import_job_id
  // ────────────────────────────────────────────────
  const jobIds = rows
    .map(r => r.job_id)
    .filter((id): id is number => id != null);

  let progressByJob: Record<number, ImportProgress> = {};

  if (jobIds.length > 0) {
    const progressRows = await db<OrderRow>('orders')
      .select(
        'import_job_id',
        db.raw('COUNT(*) as total'),
        db.raw('SUM(CASE WHEN magento_order_id IS NOT NULL THEN 1 ELSE 0 END) as synced'),
        db.raw('SUM(CASE WHEN invoiced_at IS NOT NULL THEN 1 ELSE 0 END) as invoiced'),
        db.raw('SUM(CASE WHEN shipped_at IS NOT NULL THEN 1 ELSE 0 END) as shipped'),
        db.raw("SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) as failed")
      )
      .whereIn('import_job_id', jobIds)
      .groupBy('import_job_id');

    progressByJob = progressRows.reduce<Record<number, ImportProgress>>((acc, row: any) => {
      const jobId = Number(row.import_job_id);
      acc[jobId] = {
        total: Number(row.total ?? 0),
        synced: Number(row.synced ?? 0),
        invoiced: Number(row.invoiced ?? 0),
        shipped: Number(row.shipped ?? 0),
        failed: Number(row.failed ?? 0)
      };
      return acc;
    }, {});
  }

  const data = rows.map(row => {
    if (row.job_id && progressByJob[row.job_id]) {
      return {
        ...row,
        progress: progressByJob[row.job_id]
      };
    }

    // Fallback: use imports.total_orders if we have no progress rows yet
    if (row.total_orders && row.total_orders > 0) {
      return {
        ...row,
        progress: {
          total: row.total_orders,
          synced: 0,
          invoiced: 0,
          shipped: 0,
          failed: row.failed_orders ?? 0
        }
      };
    }

    return row;
  });

  return {
    data,
    pagination: {
      limit,
      offset,
      count
    }
  };
}

// Simple recent imports helper if you still need it somewhere else
export async function getRecentImports(limit = 50): Promise<ImportRowDb[]> {
  return db<ImportRowDb>('imports')
    .select('*')
    .orderBy('id', 'desc')
    .limit(limit);
}
