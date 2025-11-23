"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/server.ts
const express_1 = __importDefault(require("express"));
const internalSecret_1 = require("./middleware/internalSecret");
const body_parser_1 = __importDefault(require("body-parser"));
const importPreview_1 = require("./import/importPreview");
const cors_1 = __importDefault(require("cors"));
const knex_1 = require("./db/knex");
const channelRulesRepository_1 = require("./db/repositories/channelRulesRepository");
const jobsService_1 = require("./services/jobsService");
const multer_1 = __importDefault(require("multer"));
const importOrders_1 = require("./import/importOrders");
const importsRepository_1 = require("./db/repositories/importsRepository");
const logger_1 = require("./utils/logger");
const app = (0, express_1.default)();
app.use(body_parser_1.default.json());
const PORT = process.env.PORT || 4000;
const upload = (0, multer_1.default)({ dest: 'uploads/' });
app.use((0, cors_1.default)());
app.use(express_1.default.json());
app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
});
// List orders with optional filters: status, channel
// List orders with optional filters: status, channel, invoiced, shipped, hasMagentoOrder
app.get('/orders', async (req, res) => {
    try {
        const { status, channel, invoiced, shipped, hasMagentoOrder } = req.query;
        // Helper to interpret "true"/"false" query params
        const parseBool = (val) => {
            if (val === undefined)
                return undefined;
            const s = String(val).toLowerCase();
            if (s === 'true')
                return true;
            if (s === 'false')
                return false;
            return undefined;
        };
        const invoicedFilter = parseBool(invoiced);
        const shippedFilter = parseBool(shipped);
        const hasMagentoFilter = parseBool(hasMagentoOrder);
        let query = (0, knex_1.db)('orders')
            .select('*')
            .orderBy('id', 'desc')
            .limit(100);
        if (status) {
            query = query.where('status', String(status));
        }
        if (channel) {
            query = query.where('order_channel', String(channel));
        }
        if (hasMagentoFilter !== undefined) {
            if (hasMagentoFilter) {
                query = query.whereNotNull('magento_order_id');
            }
            else {
                query = query.whereNull('magento_order_id');
            }
        }
        if (invoicedFilter !== undefined) {
            if (invoicedFilter) {
                query = query.whereNotNull('invoiced_at');
            }
            else {
                query = query.whereNull('invoiced_at');
            }
        }
        if (shippedFilter !== undefined) {
            if (shippedFilter) {
                query = query.whereNotNull('shipped_at');
            }
            else {
                query = query.whereNull('shipped_at');
            }
        }
        const rows = await query;
        const enhanced = rows.map((o) => ({
            ...o,
            hasMagentoOrder: !!o.magento_order_id,
            isInvoiced: !!o.invoiced_at,
            isShipped: !!o.shipped_at
        }));
        res.json(enhanced);
    }
    catch (e) {
        console.error('GET /orders error:', e);
        res.status(500).json({ error: e?.message || 'Internal Server Error' });
    }
});
// Get single order + items
app.get('/orders/:id', async (req, res) => {
    try {
        const id = Number(req.params.id);
        const order = await (0, knex_1.db)('orders').where({ id }).first();
        if (!order) {
            return res.status(404).json({ error: 'Order not found' });
        }
        const items = await (0, knex_1.db)('order_items').where({ order_id: id });
        const enhancedOrder = {
            ...order,
            hasMagentoOrder: !!order.magento_order_id,
            isInvoiced: !!order.invoiced_at,
            isShipped: !!order.shipped_at
        };
        res.json({ order: enhancedOrder, items });
    }
    catch (e) {
        console.error('GET /orders/:id error:', e);
        res.status(500).json({ error: e?.message || 'Internal Server Error' });
    }
});
// List jobs (with filters + pagination)
app.get('/jobs', async (req, res) => {
    try {
        const { status, type, orderId, limit, offset } = req.query;
        const limitNum = Math.min(Number(limit) || 50, 200); // cap to 200
        const offsetNum = Number(offset) || 0;
        let query = (0, knex_1.db)('jobs').select('*');
        if (status) {
            query = query.where('status', String(status));
        }
        if (type) {
            query = query.where('type', String(type));
        }
        if (orderId) {
            // Filter by payload.order_id
            query = query.whereRaw("JSON_EXTRACT(payload, '$.order_id') = ?", [Number(orderId)]);
        }
        query = query.orderBy('id', 'desc').limit(limitNum).offset(offsetNum);
        const rows = await query;
        res.json({
            data: rows,
            pagination: {
                limit: limitNum,
                offset: offsetNum,
                count: rows.length
            }
        });
    }
    catch (e) {
        console.error('GET /jobs error:', e);
        res.status(500).json({ error: e?.message || 'Internal Server Error' });
    }
});
app.get('/imports', async (req, res) => {
    try {
        const { jobId, limit, offset } = req.query;
        const jobIdNum = jobId !== undefined && jobId !== ''
            ? Number(jobId)
            : undefined;
        const limitNum = Math.min(Number(limit) || 50, 200);
        const offsetNum = Number(offset) || 0;
        const { data, pagination } = await (0, importsRepository_1.getImports)({
            jobId: jobIdNum && !Number.isNaN(jobIdNum) ? jobIdNum : undefined,
            limit: limitNum,
            offset: offsetNum
        });
        res.json({ data, pagination });
    }
    catch (e) {
        console.error('GET /imports error:', e);
        res.status(500).json({ error: e?.message || 'Internal Server Error' });
    }
});
// Upload and run import
// Upload and run import
app.post('/imports', internalSecret_1.verifyInternalSecret, upload.fields([
    { name: 'header', maxCount: 1 },
    { name: 'items', maxCount: 1 }
]), async (req, res) => {
    const ctx = 'api:imports:upload';
    try {
        const files = req.files;
        const headerFile = files?.header?.[0];
        const itemsFile = files?.items?.[0];
        if (!headerFile || !itemsFile) {
            return res
                .status(400)
                .json({ error: 'Both header and items files are required' });
        }
        const importedBy = req.body.importedBy ||
            req.body.userName ||
            'Dashboard';
        (0, logger_1.logInfo)(ctx, 'Starting import from API', {
            headerPath: headerFile.path,
            itemsPath: itemsFile.path,
            importedBy
        });
        const { summary, failures, importId, jobId } = await (0, importOrders_1.importOrdersFromFiles)({
            headerFilePath: headerFile.path,
            itemsFilePath: itemsFile.path,
            importedBy
        });
        (0, logger_1.logInfo)(ctx, 'Import finished via API', {
            importId,
            jobId,
            summary
        });
        res.json({
            importId,
            jobId,
            summary,
            failures
        });
    }
    catch (e) {
        (0, logger_1.logError)(ctx, 'Import via API failed', {
            error: e?.message || String(e)
        });
        res.status(500).json({ error: e?.message || 'Import failed' });
    }
});
// Retry a failed job: set it back to PENDING
// Retry a job by re-queuing the appropriate job type for its order
app.post('/jobs/:id/retry', async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (Number.isNaN(id)) {
            return res.status(400).json({ error: 'Invalid job id' });
        }
        const job = await (0, knex_1.db)('jobs').where({ id }).first();
        if (!job) {
            return res.status(404).json({ error: 'Job not found' });
        }
        // Parse payload and extract order_id
        const payload = typeof job.payload === 'string'
            ? JSON.parse(job.payload)
            : job.payload;
        const orderId = payload?.order_id;
        if (!orderId || typeof orderId !== 'number') {
            return res
                .status(400)
                .json({ error: 'Job payload is missing a valid order_id' });
        }
        // Use existing helpers – they will re-enable FAILED/DONE jobs
        // or create a new one if needed.
        switch (job.type) {
            case 'SYNC_ORDER_TO_MAGENTO':
                await (0, jobsService_1.createSyncJobIfNotExists)(orderId);
                break;
            case 'INVOICE_MAGENTO_ORDER':
                await (0, jobsService_1.createInvoiceJobIfNotExists)(orderId);
                break;
            case 'SHIP_MAGENTO_ORDER':
                await (0, jobsService_1.createShipJobIfNotExists)(orderId);
                break;
            default:
                return res
                    .status(400)
                    .json({ error: `Unsupported job type for retry: ${job.type}` });
        }
        // Optional: clear error on the original row for UI cleanliness
        await (0, knex_1.db)('jobs')
            .where({ id })
            .update({
            last_error: null,
            updated_at: knex_1.db.fn.now()
        });
        return res.json({
            ok: true,
            jobId: job.id,
            type: job.type,
            orderId
        });
    }
    catch (e) {
        console.error('POST /jobs/:id/retry error:', e);
        return res.status(500).json({ error: e?.message || 'Internal Server Error' });
    }
});
app.listen(PORT, () => {
    console.log(`Middleware API listening on port ${PORT}`);
});
// List channel rules (DB-backed)
app.get('/channels', async (_req, res) => {
    try {
        const rows = await (0, channelRulesRepository_1.getAllChannelRules)();
        res.json(rows.map((r) => ({
            channel: r.channel,
            autoInvoice: !!r.auto_invoice,
            autoShip: !!r.auto_ship,
            isActive: !!r.is_active
        })));
    }
    catch (e) {
        console.error('GET /channels error:', e);
        res.status(500).json({ error: e?.message || 'Internal Server Error' });
    }
});
// Upsert channel rule
app.put('/channels/:channel', async (req, res) => {
    try {
        const channel = String(req.params.channel);
        const { autoInvoice, autoShip, isActive } = req.body;
        await (0, channelRulesRepository_1.upsertChannelRule)({
            channel,
            autoInvoice: !!autoInvoice,
            autoShip: !!autoShip,
            isActive: isActive === undefined ? true : !!isActive
        });
        res.json({ ok: true });
    }
    catch (e) {
        console.error('PUT /channels/:channel error:', e);
        res.status(500).json({ error: e?.message || 'Internal Server Error' });
    }
});
// Requeue invoice job for an order
app.post('/orders/:id/requeue-invoice', async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (Number.isNaN(id)) {
            return res.status(400).json({ error: 'Invalid order id' });
        }
        const order = await (0, knex_1.db)('orders').where({ id }).first();
        if (!order) {
            return res.status(404).json({ error: 'Order not found' });
        }
        if (!order.magento_order_id) {
            return res.status(400).json({
                error: 'Order has no magento_order_id; cannot invoice'
            });
        }
        await (0, jobsService_1.createInvoiceJobIfNotExists)(order.id);
        return res.json({
            ok: true,
            orderId: order.id,
            magento_order_id: order.magento_order_id
        });
    }
    catch (e) {
        console.error('POST /orders/:id/requeue-invoice error:', e);
        res.status(500).json({ error: e?.message || 'Internal Server Error' });
    }
});
// Requeue ship job for an order
app.post('/orders/:id/requeue-ship', async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (Number.isNaN(id)) {
            return res.status(400).json({ error: 'Invalid order id' });
        }
        const order = await (0, knex_1.db)('orders').where({ id }).first();
        if (!order) {
            return res.status(404).json({ error: 'Order not found' });
        }
        if (!order.magento_order_id) {
            return res.status(400).json({
                error: 'Order has no magento_order_id; cannot ship'
            });
        }
        await (0, jobsService_1.createShipJobIfNotExists)(order.id);
        return res.json({
            ok: true,
            orderId: order.id,
            magento_order_id: order.magento_order_id
        });
    }
    catch (e) {
        console.error('POST /orders/:id/requeue-ship error:', e);
        res.status(500).json({ error: e?.message || 'Internal Server Error' });
    }
});
app.get('/imports/:id', async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (Number.isNaN(id)) {
            return res.status(400).json({ error: 'Invalid import id' });
        }
        // First try: treat :id as import.id
        let imp = await (0, knex_1.db)('imports').where({ id }).first();
        // Fallback: treat :id as job_id (so /imports/<jobId> also works)
        if (!imp) {
            imp = await (0, knex_1.db)('imports').where({ job_id: id }).first();
        }
        if (!imp) {
            return res.status(404).json({ error: 'Import not found' });
        }
        // Assuming orders.import_job_id = imp.job_id
        let orders = [];
        if (imp.job_id) {
            orders = await (0, knex_1.db)('orders')
                .select('*')
                .where('import_job_id', imp.job_id)
                .orderBy('id', 'desc');
        }
        res.json({
            import: imp,
            orders
        });
    }
    catch (e) {
        console.error('GET /imports/:id error:', e);
        res.status(500).json({ error: e?.message || 'Internal Server Error' });
    }
});
app.get('/imports/:id/export', async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (Number.isNaN(id)) {
            return res.status(400).json({ error: 'Invalid import id' });
        }
        // Try as import.id
        let imp = await (0, knex_1.db)('imports').where({ id }).first();
        // Fallback: treat :id as job_id (so /imports/<jobId>/export also works)
        if (!imp) {
            imp = await (0, knex_1.db)('imports').where({ job_id: id }).first();
        }
        if (!imp) {
            return res.status(404).json({ error: 'Import not found' });
        }
        let orders = [];
        if (imp.job_id) {
            orders = await (0, knex_1.db)('orders')
                .select('*')
                .where('import_job_id', imp.job_id)
                .orderBy('id', 'desc');
        }
        const escapeCsv = (val) => {
            if (val == null)
                return '';
            const s = String(val);
            if (s.includes('"') || s.includes(',') || s.includes('\n')) {
                return `"${s.replace(/"/g, '""')}"`;
            }
            return s;
        };
        const header = [
            'original_order_id',
            'magento_order_id',
            'status',
            'order_status'
        ];
        const rows = orders.map((o) => {
            const anyOrder = o;
            const originalOrderId = anyOrder.file_order_id ??
                anyOrder.order_number ??
                '';
            const magentoOrderId = anyOrder.magento_increment_id ??
                (anyOrder.magento_order_id != null
                    ? String(anyOrder.magento_order_id)
                    : '');
            const status = anyOrder.status ?? '';
            const orderStatus = anyOrder.magento_status ??
                anyOrder.order_status ??
                '';
            return [
                escapeCsv(originalOrderId),
                escapeCsv(magentoOrderId),
                escapeCsv(status),
                escapeCsv(orderStatus)
            ].join(',');
        });
        const csv = [header.join(','), ...rows].join('\n');
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="import-${imp.id}-orders.csv"`);
        res.send(csv);
    }
    catch (e) {
        console.error('GET /imports/:id/export error:', e);
        res.status(500).json({ error: e?.message || 'Internal Server Error' });
    }
});
// Preview an import (no DB writes, just validation)
// Preview an import (no DB writes, just validation)
app.post('/imports/preview', internalSecret_1.verifyInternalSecret, upload.fields([
    { name: 'header', maxCount: 1 },
    { name: 'items', maxCount: 1 }
]), async (req, res) => {
    try {
        const files = req.files;
        const headerFile = files?.header?.[0];
        const itemsFile = files?.items?.[0];
        if (!headerFile || !itemsFile) {
            return res
                .status(400)
                .json({ error: 'Both header and items files are required' });
        }
        const importedBy = req.body.importedBy ||
            req.body.userName ||
            'Dashboard';
        const result = await (0, importPreview_1.previewImportFromFiles)({
            headerFilePath: headerFile.path,
            itemsFilePath: itemsFile.path,
            separator: undefined,
            importedBy
        });
        return res.json(result);
    }
    catch (err) {
        console.error('Error in /imports/preview', err);
        return res.status(500).json({
            error: err?.message || 'Failed to generate import preview'
        });
    }
});
