"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getImports = getImports;
exports.getRecentImports = getRecentImports;
// src/db/repositories/importsRepository.ts
const knex_1 = require("../knex");
async function getImports(params) {
    const limit = Math.min(params.limit ?? 50, 200);
    const offset = params.offset ?? 0;
    const jobId = params.jobId;
    const base = (0, knex_1.db)('imports');
    let query = base.clone();
    if (jobId) {
        query = query.where('job_id', jobId);
    }
    const [rows, countRow] = await Promise.all([
        query.orderBy('id', 'desc').limit(limit).offset(offset),
        base
            .clone()
            .modify(qb => {
            if (jobId)
                qb.where('job_id', jobId);
        })
            .count({ count: '*' })
            .first()
    ]);
    const count = Number(countRow?.count ?? 0);
    // ────────────────────────────────────────────────
    // Attach progress per import via orders.import_job_id
    // ────────────────────────────────────────────────
    const jobIds = rows
        .map(r => r.job_id)
        .filter((id) => id != null);
    let progressByJob = {};
    if (jobIds.length > 0) {
        const progressRows = await (0, knex_1.db)('orders')
            .select('import_job_id', knex_1.db.raw('COUNT(*) as total'), knex_1.db.raw('SUM(CASE WHEN magento_order_id IS NOT NULL THEN 1 ELSE 0 END) as synced'), knex_1.db.raw('SUM(CASE WHEN invoiced_at IS NOT NULL THEN 1 ELSE 0 END) as invoiced'), knex_1.db.raw('SUM(CASE WHEN shipped_at IS NOT NULL THEN 1 ELSE 0 END) as shipped'), knex_1.db.raw("SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) as failed"))
            .whereIn('import_job_id', jobIds)
            .groupBy('import_job_id');
        progressByJob = progressRows.reduce((acc, row) => {
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
async function getRecentImports(limit = 50) {
    return (0, knex_1.db)('imports')
        .select('*')
        .orderBy('id', 'desc')
        .limit(limit);
}
