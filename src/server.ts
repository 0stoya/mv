// src/server.ts
import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import bodyParser from 'body-parser';
import cors from 'cors';
import multer from 'multer';

// Internal imports
import { db } from './db/knex';
import { verifyInternalSecret } from './middleware/internalSecret';
import { logInfo, logError } from './utils/logger';
import { startWorkerLoop, signalShutdown } from './workers/ordersWorker';

// Import Types & Services
import { OrderRow, JobRow } from './types/order';
import {
  getAllChannelRules,
  upsertChannelRule
} from './db/repositories/channelRulesRepository';
import {
  createSyncJobIfNotExists,
  createInvoiceJobIfNotExists,
  createShipJobIfNotExists
} from './services/jobsService';
import { importOrdersFromFiles } from './import/importOrders';
import { previewImportFromFiles } from './import/importPreview';
import { getImports } from './db/repositories/importsRepository';

// Constants
const PORT = process.env.PORT || 4000;
const upload = multer({ dest: 'uploads/' });

// App Setup
const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.json());

// ============================================================================
// 1. HEALTH & METRICS
// ============================================================================

app.get('/health', async (_req, res) => {
  try {
    await db.raw('SELECT 1'); // Check DB connectivity
    res.json({ status: 'ok', worker: 'running' });
  } catch (err) {
    res.status(503).json({ status: 'error', db: 'disconnected' });
  }
});

// ============================================================================
// 2. ORDER ENDPOINTS (Existing Logic)
// ============================================================================

app.get('/orders', async (req, res) => {
  try {
    const { status, channel, invoiced, shipped, hasMagentoOrder } = req.query;

    const parseBool = (val: unknown): boolean | undefined => {
      if (val === undefined) return undefined;
      const s = String(val).toLowerCase();
      return s === 'true' ? true : s === 'false' ? false : undefined;
    };

    const invoicedFilter = parseBool(invoiced);
    const shippedFilter = parseBool(shipped);
    const hasMagentoFilter = parseBool(hasMagentoOrder);

    let query = db<OrderRow>('orders')
      .select('*')
      .orderBy('id', 'desc')
      .limit(100);

    if (status) query = query.where('status', String(status));
    if (channel) query = query.where('order_channel', String(channel));

    if (hasMagentoFilter !== undefined) {
      hasMagentoFilter ? query.whereNotNull('magento_order_id') : query.whereNull('magento_order_id');
    }
    if (invoicedFilter !== undefined) {
      invoicedFilter ? query.whereNotNull('invoiced_at') : query.whereNull('invoiced_at');
    }
    if (shippedFilter !== undefined) {
      shippedFilter ? query.whereNotNull('shipped_at') : query.whereNull('shipped_at');
    }

    const rows = await query;
    const enhanced = rows.map((o) => ({
      ...o,
      hasMagentoOrder: !!o.magento_order_id,
      isInvoiced: !!o.invoiced_at,
      isShipped: !!o.shipped_at
    }));

    res.json(enhanced);
  } catch (e: any) {
    logError('api', 'GET /orders error', { error: e.message });
    res.status(500).json({ error: e.message || 'Internal Server Error' });
  }
});

app.get('/orders/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const order = await db<OrderRow>('orders').where({ id }).first();
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const items = await db('order_items').where({ order_id: id });
    res.json({
      order: {
        ...order,
        hasMagentoOrder: !!order.magento_order_id,
        isInvoiced: !!order.invoiced_at,
        isShipped: !!order.shipped_at
      },
      items
    });
  } catch (e: any) {
    logError('api', 'GET /orders/:id error', { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// Requeue Actions
app.post('/orders/:id/requeue-invoice', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const order = await db<OrderRow>('orders').where({ id }).first();
    if (!order || !order.magento_order_id) return res.status(400).json({ error: 'Order not valid for invoice' });

    await createInvoiceJobIfNotExists(order.id);
    res.json({ ok: true, orderId: order.id });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/orders/:id/requeue-ship', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const order = await db<OrderRow>('orders').where({ id }).first();
    if (!order || !order.magento_order_id) return res.status(400).json({ error: 'Order not valid for shipping' });

    await createShipJobIfNotExists(order.id);
    res.json({ ok: true, orderId: order.id });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================================
// 3. JOB ENDPOINTS
// ============================================================================

app.get('/jobs', async (req, res) => {
  try {
    const { status, type, orderId, limit, offset } = req.query;
    const limitNum = Math.min(Number(limit) || 50, 200);
    const offsetNum = Number(offset) || 0;

    let query = db<JobRow>('jobs').select('*');
    if (status) query = query.where('status', String(status));
    if (type) query = query.where('type', String(type));
    if (orderId) query = query.whereRaw("JSON_EXTRACT(payload, '$.order_id') = ?", [Number(orderId)]);

    const rows = await query.orderBy('id', 'desc').limit(limitNum).offset(offsetNum);
    
    // Get count for pagination
    const countRes = await db('jobs').count('id as total').first();
    const total = countRes ? Number(countRes.total) : 0;

    res.json({ data: rows, pagination: { limit: limitNum, offset: offsetNum, count: total } });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/jobs/:id/retry', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const job = await db<JobRow>('jobs').where({ id }).first();
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const payload = typeof job.payload === 'string' ? JSON.parse(job.payload as any) : job.payload;
    const orderId = payload?.order_id;

    if (!orderId) return res.status(400).json({ error: 'Invalid payload' });

    switch (job.type) {
      case 'SYNC_ORDER_TO_MAGENTO': await createSyncJobIfNotExists(orderId); break;
      case 'INVOICE_MAGENTO_ORDER': await createInvoiceJobIfNotExists(orderId); break;
      case 'SHIP_MAGENTO_ORDER': await createShipJobIfNotExists(orderId); break;
      default: return res.status(400).json({ error: 'Unsupported job type' });
    }

    // Clean up error message on old job
    await db('jobs').where({ id }).update({ last_error: null, updated_at: db.fn.now() });
    
    res.json({ ok: true, jobId: job.id });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================================
// 4. IMPORT ENDPOINTS
// ============================================================================

app.get('/imports', async (req, res) => {
  try {
    const { jobId, limit, offset } = req.query;
    const result = await getImports({
      jobId: jobId ? Number(jobId) : undefined,
      limit: Number(limit) || 50,
      offset: Number(offset) || 0
    });
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/imports/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    let imp = await db('imports').where({ id }).first();
    if (!imp) imp = await db('imports').where({ job_id: id }).first();
    if (!imp) return res.status(404).json({ error: 'Import not found' });

    const orders = imp.job_id ? await db<OrderRow>('orders').where('import_job_id', imp.job_id).orderBy('id', 'desc') : [];
    res.json({ import: imp, orders });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// CSV Export Logic
app.get('/imports/:id/export', async (req, res) => {
  try {
    const id = Number(req.params.id);
    let imp = await db('imports').where({ id }).first();
    if (!imp) imp = await db('imports').where({ job_id: id }).first();
    if (!imp) return res.status(404).json({ error: 'Import not found' });

    const orders = imp.job_id ? await db<OrderRow>('orders').where('import_job_id', imp.job_id) : [];

    const escapeCsv = (val: any) => {
      if (val == null) return '';
      const s = String(val);
      return (s.includes('"') || s.includes(',')) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const header = ['original_order_id', 'magento_order_id', 'status', 'order_status'];
    const rows = orders.map((o: any) => [
      escapeCsv(o.file_order_id || o.order_number),
      escapeCsv(o.magento_increment_id || o.magento_order_id),
      escapeCsv(o.status),
      escapeCsv(o.magento_status || o.order_status)
    ].join(','));

    const csv = [header.join(','), ...rows].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="import-${imp.id}.csv"`);
    res.send(csv);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Upload Handlers
app.post('/imports', verifyInternalSecret, upload.fields([{ name: 'header' }, { name: 'items' }]), async (req, res) => {
  try {
    const files = req.files as { [field: string]: Express.Multer.File[] };
    if (!files?.header?.[0] || !files?.items?.[0]) return res.status(400).json({ error: 'Missing files' });

    const result = await importOrdersFromFiles({
      headerFilePath: files.header[0].path,
      itemsFilePath: files.items[0].path,
      importedBy: req.body.importedBy || 'Dashboard'
    });
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/imports/preview', verifyInternalSecret, upload.fields([{ name: 'header' }, { name: 'items' }]), async (req, res) => {
  try {
    const files = req.files as { [field: string]: Express.Multer.File[] };
    if (!files?.header?.[0] || !files?.items?.[0]) return res.status(400).json({ error: 'Missing files' });

    const result = await previewImportFromFiles({
      headerFilePath: files.header[0].path,
      itemsFilePath: files.items[0].path,
      importedBy: req.body.importedBy
    });
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================================
// 5. SERVER STARTUP & GRACEFUL SHUTDOWN
// ============================================================================

const httpServer = createServer(app);

// Start Server
httpServer.listen(PORT, () => {
  logInfo('server', `Middleware API listening on port ${PORT}`);

  // Start Worker Loop
  startWorkerLoop().catch((err) => {
    logError('worker', 'Fatal startup error', { error: err.message });
  });
});

// Graceful Shutdown
async function shutdown(signal: string) {
  console.log(`\n${signal} received. Shutting down...`);
  
  // 1. Stop HTTP
  httpServer.close(() => console.log('HTTP server closed.'));

  // 2. Stop Worker
  await signalShutdown();

  // 3. Close DB
  try {
    await db.destroy();
    console.log('Database connection closed.');
    process.exit(0);
  } catch (e) {
    console.error('Error during shutdown:', e);
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
