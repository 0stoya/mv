"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const morgan_1 = __importDefault(require("morgan"));
const knex_1 = require("./db/knex");
const jobsService_1 = require("./services/jobsService");
const logger_1 = require("./utils/logger");
const app = (0, express_1.default)();
const PORT = Number(process.env.PORT || 3000);
app.use((0, cors_1.default)());
app.use(express_1.default.json());
app.use((0, morgan_1.default)('dev'));
// ─────────────────────────────────────────
// HEALTH
// ─────────────────────────────────────────
app.get('/health', async (_req, res) => {
    try {
        const [{ now }] = await knex_1.db.raw('SELECT NOW() as now');
        res.json({
            status: 'ok',
            db_time: now
        });
    }
    catch (err) {
        res.status(500).json({
            status: 'error',
            error: err?.message || String(err)
        });
    }
});
// ─────────────────────────────────────────
// ORDERS LIST
// ─────────────────────────────────────────
app.get('/orders', async (req, res) => {
    try {
        const { status, channel, limit = '50' } = req.query;
        let query = (0, knex_1.db)('orders').select('id', 'external_order_id', 'order_channel', 'status', 'created_date', 'magento_order_id', 'magento_increment_id', 'last_error');
        if (status) {
            query = query.where('status', status);
        }
        if (channel) {
            query = query.where('order_channel', channel);
        }
        const rows = await query.orderBy('id', 'desc').limit(Number(limit));
        res.json(rows);
    }
    catch (err) {
        (0, logger_1.logError)('api:orders:list', 'Failed to list orders', {
            error: err?.message || String(err)
        });
        res.status(500).json({ error: err?.message || String(err) });
    }
});
// ─────────────────────────────────────────
// ORDER DETAIL
// ─────────────────────────────────────────
app.get('/orders/:id', async (req, res) => {
    const id = Number(req.params.id);
    try {
        const order = await (0, knex_1.db)('orders').where({ id }).first();
        if (!order) {
            return res.status(404).json({ error: 'Order not found' });
        }
        const items = await (0, knex_1.db)('order_items').where({ order_id: id });
        res.json({ order, items });
    }
    catch (err) {
        (0, logger_1.logError)('api:orders:detail', 'Failed to fetch order', {
            id,
            error: err?.message || String(err)
        });
        res.status(500).json({ error: err?.message || String(err) });
    }
});
// ─────────────────────────────────────────
// JOBS LIST
// ─────────────────────────────────────────
app.get('/jobs', async (req, res) => {
    const { status, limit = '50' } = req.query;
    try {
        let query = (0, knex_1.db)('jobs').select('*');
        if (status) {
            query = query.where('status', status);
        }
        const rows = await query.orderBy('id', 'desc').limit(Number(limit));
        const mapped = rows.map((row) => ({
            ...row,
            payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload
        }));
        res.json(mapped);
    }
    catch (err) {
        (0, logger_1.logError)('api:jobs:list', 'Failed to list jobs', {
            error: err?.message || String(err)
        });
        res.status(500).json({ error: err?.message || String(err) });
    }
});
// ─────────────────────────────────────────
// RETRY ORDER SYNC
// ─────────────────────────────────────────
app.post('/orders/:id/retry', async (req, res) => {
    const id = Number(req.params.id);
    try {
        const order = await (0, knex_1.db)('orders').where({ id }).first();
        if (!order) {
            return res.status(404).json({ error: 'Order not found' });
        }
        await (0, jobsService_1.createSyncJobIfNotExists)(id);
        (0, logger_1.logInfo)('api:orders:retry', 'Scheduled sync job', { orderId: id });
        res.json({ ok: true });
    }
    catch (err) {
        (0, logger_1.logError)('api:orders:retry', 'Failed to schedule retry', {
            id,
            error: err?.message || String(err)
        });
        res.status(500).json({ error: err?.message || String(err) });
    }
});
// ─────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────
app.listen(PORT, () => {
    (0, logger_1.logInfo)('api', 'Server started', { port: PORT });
});
