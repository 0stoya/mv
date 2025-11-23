// src/server.ts
import express from 'express';
import { verifyInternalSecret } from './middleware/internalSecret';
import bodyParser from 'body-parser';
import { previewImportFromFiles } from './import/importPreview';
import cors from 'cors';
import { db } from './db/knex';
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
import multer from 'multer';
import { importOrdersFromFiles } from './import/importOrders';
import { getImports } from './db/repositories/importsRepository';

import { logInfo, logError } from './utils/logger';

const app = express();
app.use(bodyParser.json());
const PORT = process.env.PORT || 4000;
const upload = multer({ dest: 'uploads/' });

app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});


// List orders with optional filters: status, channel
// List orders with optional filters: status, channel, invoiced, shipped, hasMagentoOrder
app.get('/orders', async (req, res) => {
  try {
    const { status, channel, invoiced, shipped, hasMagentoOrder } = req.query;

    // Helper to interpret "true"/"false" query params
    const parseBool = (val: unknown): boolean | undefined => {
      if (val === undefined) return undefined;
      const s = String(val).toLowerCase();
      if (s === 'true') return true;
      if (s === 'false') return false;
      return undefined;
    };

    const invoicedFilter = parseBool(invoiced);
    const shippedFilter = parseBool(shipped);
    const hasMagentoFilter = parseBool(hasMagentoOrder);

    let query = db<OrderRow>('orders')
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
      } else {
        query = query.whereNull('magento_order_id');
      }
    }

    if (invoicedFilter !== undefined) {
      if (invoicedFilter) {
        query = query.whereNotNull('invoiced_at');
      } else {
        query = query.whereNull('invoiced_at');
      }
    }

    if (shippedFilter !== undefined) {
      if (shippedFilter) {
        query = query.whereNotNull('shipped_at');
      } else {
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
  } catch (e: any) {
    console.error('GET /orders error:', e);
    res.status(500).json({ error: e?.message || 'Internal Server Error' });
  }
});



// Get single order + items
app.get('/orders/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const order = await db<OrderRow>('orders').where({ id }).first();
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const items = await db('order_items').where({ order_id: id });

    const enhancedOrder = {
      ...order,
      hasMagentoOrder: !!order.magento_order_id,
      isInvoiced: !!order.invoiced_at,
      isShipped: !!order.shipped_at
    };

    res.json({ order: enhancedOrder, items });
  } catch (e: any) {
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

    let query = db<JobRow>('jobs').select('*');

    if (status) {
      query = query.where('status', String(status));
    }

    if (type) {
      query = query.where('type', String(type));
    }

    if (orderId) {
      // Filter by payload.order_id
      query = query.whereRaw(
        "JSON_EXTRACT(payload, '$.order_id') = ?",
        [Number(orderId)]
      );
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
  } catch (e: any) {
    console.error('GET /jobs error:', e);
    res.status(500).json({ error: e?.message || 'Internal Server Error' });
  }
});

app.get('/imports', async (req, res) => {
  try {
    const { jobId, limit, offset } = req.query;

    const jobIdNum =
      jobId !== undefined && jobId !== ''
        ? Number(jobId)
        : undefined;

    const limitNum = Math.min(Number(limit) || 50, 200);
    const offsetNum = Number(offset) || 0;

    const { data, pagination } = await getImports({
      jobId: jobIdNum && !Number.isNaN(jobIdNum) ? jobIdNum : undefined,
      limit: limitNum,
      offset: offsetNum
    });

    res.json({ data, pagination });
  } catch (e: any) {
    console.error('GET /imports error:', e);
    res.status(500).json({ error: e?.message || 'Internal Server Error' });
  }
});


// Upload and run import
// Upload and run import
app.post(
  '/imports',
  verifyInternalSecret,
  upload.fields([
    { name: 'header', maxCount: 1 },
    { name: 'items', maxCount: 1 }
  ]),
  async (req, res) => {
    const ctx = 'api:imports:upload';

    try {
      const files = req.files as {
        [field: string]: Express.Multer.File[];
      };

      const headerFile = files?.header?.[0];
      const itemsFile = files?.items?.[0];

      if (!headerFile || !itemsFile) {
        return res
          .status(400)
          .json({ error: 'Both header and items files are required' });
      }

      const importedBy =
        (req.body.importedBy as string) ||
        (req.body.userName as string) ||
        'Dashboard';

      logInfo(ctx, 'Starting import from API', {
        headerPath: headerFile.path,
        itemsPath: itemsFile.path,
        importedBy
      });

      const { summary, failures, importId, jobId } =
        await importOrdersFromFiles({
          headerFilePath: headerFile.path,
          itemsFilePath: itemsFile.path,
          importedBy
        });

      logInfo(ctx, 'Import finished via API', {
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
    } catch (e: any) {
      logError(ctx, 'Import via API failed', {
        error: e?.message || String(e)
      });
      res.status(500).json({ error: e?.message || 'Import failed' });
    }
  }
);


// Retry a failed job: set it back to PENDING
// Retry a job by re-queuing the appropriate job type for its order
app.post('/jobs/:id/retry', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) {
      return res.status(400).json({ error: 'Invalid job id' });
    }

    const job = await db<JobRow>('jobs').where({ id }).first();
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // Parse payload and extract order_id
    const payload =
      typeof job.payload === 'string'
        ? JSON.parse(job.payload as unknown as string)
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
        await createSyncJobIfNotExists(orderId);
        break;

      case 'INVOICE_MAGENTO_ORDER':
        await createInvoiceJobIfNotExists(orderId);
        break;

      case 'SHIP_MAGENTO_ORDER':
        await createShipJobIfNotExists(orderId);
        break;

      default:
        return res
          .status(400)
          .json({ error: `Unsupported job type for retry: ${job.type}` });
    }

    // Optional: clear error on the original row for UI cleanliness
    await db('jobs')
      .where({ id })
      .update({
        last_error: null,
        updated_at: db.fn.now()
      });

    return res.json({
      ok: true,
      jobId: job.id,
      type: job.type,
      orderId
    });
  } catch (e: any) {
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
    const rows = await getAllChannelRules();
    res.json(
      rows.map((r) => ({
        channel: r.channel,
        autoInvoice: !!r.auto_invoice,
        autoShip: !!r.auto_ship,
        isActive: !!r.is_active
      }))
    );
  } catch (e: any) {
    console.error('GET /channels error:', e);
    res.status(500).json({ error: e?.message || 'Internal Server Error' });
  }
});

// Upsert channel rule
app.put('/channels/:channel', async (req, res) => {
  try {
    const channel = String(req.params.channel);
    const { autoInvoice, autoShip, isActive } = req.body;

    await upsertChannelRule({
      channel,
      autoInvoice: !!autoInvoice,
      autoShip: !!autoShip,
      isActive: isActive === undefined ? true : !!isActive
    });

    res.json({ ok: true });
  } catch (e: any) {
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

    const order = await db<OrderRow>('orders').where({ id }).first();
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (!order.magento_order_id) {
      return res.status(400).json({
        error: 'Order has no magento_order_id; cannot invoice'
      });
    }

    await createInvoiceJobIfNotExists(order.id);

    return res.json({
      ok: true,
      orderId: order.id,
      magento_order_id: order.magento_order_id
    });
  } catch (e: any) {
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

    const order = await db<OrderRow>('orders').where({ id }).first();
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (!order.magento_order_id) {
      return res.status(400).json({
        error: 'Order has no magento_order_id; cannot ship'
      });
    }

    await createShipJobIfNotExists(order.id);

    return res.json({
      ok: true,
      orderId: order.id,
      magento_order_id: order.magento_order_id
    });
  } catch (e: any) {
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
    let imp = await db('imports').where({ id }).first();

    // Fallback: treat :id as job_id (so /imports/<jobId> also works)
    if (!imp) {
      imp = await db('imports').where({ job_id: id }).first();
    }

    if (!imp) {
      return res.status(404).json({ error: 'Import not found' });
    }

    // Assuming orders.import_job_id = imp.job_id
    let orders: OrderRow[] = [];

    if (imp.job_id) {
      orders = await db<OrderRow>('orders')
        .select('*')
        .where('import_job_id', imp.job_id)
        .orderBy('id', 'desc');
    }

    res.json({
      import: imp,
      orders
    });
  } catch (e: any) {
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
    let imp = await db('imports').where({ id }).first();

    // Fallback: treat :id as job_id (so /imports/<jobId>/export also works)
    if (!imp) {
      imp = await db('imports').where({ job_id: id }).first();
    }

    if (!imp) {
      return res.status(404).json({ error: 'Import not found' });
    }

    let orders: OrderRow[] = [];

    if (imp.job_id) {
      orders = await db<OrderRow>('orders')
        .select('*')
        .where('import_job_id', imp.job_id)
        .orderBy('id', 'desc');
    }

    const escapeCsv = (val: unknown): string => {
      if (val == null) return '';
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
      const anyOrder = o as any;
      const originalOrderId =
        (anyOrder.file_order_id as string) ??
        (anyOrder.order_number as string) ??
        '';
      const magentoOrderId =
        (anyOrder.magento_increment_id as string) ??
        (anyOrder.magento_order_id != null
          ? String(anyOrder.magento_order_id)
          : '');
      const status = (anyOrder.status as string) ?? '';
      const orderStatus =
        (anyOrder.magento_status as string) ??
        (anyOrder.order_status as string) ??
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
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="import-${imp.id}-orders.csv"`
    );
    res.send(csv);
  } catch (e: any) {
    console.error('GET /imports/:id/export error:', e);
    res.status(500).json({ error: e?.message || 'Internal Server Error' });
  }
});
// Preview an import (no DB writes, just validation)
// Preview an import (no DB writes, just validation)
app.post(
  '/imports/preview',
  verifyInternalSecret,
  upload.fields([
    { name: 'header', maxCount: 1 },
    { name: 'items', maxCount: 1 }
  ]),
  async (req, res) => {
    try {
      const files = req.files as {
        [field: string]: Express.Multer.File[];
      };

      const headerFile = files?.header?.[0];
      const itemsFile = files?.items?.[0];

      if (!headerFile || !itemsFile) {
        return res
          .status(400)
          .json({ error: 'Both header and items files are required' });
      }

      const importedBy =
        (req.body.importedBy as string) ||
        (req.body.userName as string) ||
        'Dashboard';

      const result = await previewImportFromFiles({
        headerFilePath: headerFile.path,
        itemsFilePath: itemsFile.path,
        separator: undefined,
        importedBy
      });

      return res.json(result);
    } catch (err: any) {
      console.error('Error in /imports/preview', err);
      return res.status(500).json({
        error: err?.message || 'Failed to generate import preview'
      });
    }
  }
);


