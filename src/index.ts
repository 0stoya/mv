import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { db } from './db/knex';
import { createSyncJobIfNotExists } from './services/jobsService';
import { logInfo, logError } from './utils/logger';

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

// ─────────────────────────────────────────
// HEALTH
// ─────────────────────────────────────────
app.get('/health', async (_req, res) => {
  try {
    const [{ now }] = await db.raw('SELECT NOW() as now');
    res.json({
      status: 'ok',
      db_time: now
    });
  } catch (err: any) {
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

    let query = db('orders').select(
      'id',
      'external_order_id',
      'order_channel',
      'status',
      'created_date',
      'magento_order_id',
      'magento_increment_id',
      'last_error'
    );

    if (status) {
      query = query.where('status', status as string);
    }
    if (channel) {
      query = query.where('order_channel', channel as string);
    }

    const rows = await query.orderBy('id', 'desc').limit(Number(limit));
    res.json(rows);
  } catch (err: any) {
    logError('api:orders:list', 'Failed to list orders', {
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
    const order = await db('orders').where({ id }).first();
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const items = await db('order_items').where({ order_id: id });

    res.json({ order, items });
  } catch (err: any) {
    logError('api:orders:detail', 'Failed to fetch order', {
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
    let query = db('jobs').select('*');

    if (status) {
      query = query.where('status', status as string);
    }

    const rows = await query.orderBy('id', 'desc').limit(Number(limit));

    const mapped = rows.map((row: any) => ({
      ...row,
      payload:
        typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload
    }));

    res.json(mapped);
  } catch (err: any) {
    logError('api:jobs:list', 'Failed to list jobs', {
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
    const order = await db('orders').where({ id }).first();
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    await createSyncJobIfNotExists(id);

    logInfo('api:orders:retry', 'Scheduled sync job', { orderId: id });

    res.json({ ok: true });
  } catch (err: any) {
    logError('api:orders:retry', 'Failed to schedule retry', {
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
  logInfo('api', 'Server started', { port: PORT });
});
