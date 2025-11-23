// src/import/importOrders.ts
import path from 'path';
import { parseCsvFile, detectDelimiter } from '../utils/csvUtils';
import { createContextId, logInfo, logError } from '../utils/logger';
import {
  RawOrderHeaderRow,
  RawOrderItemRow,
  ParsedOrderHeader,
  ParsedOrderItem,
  ImportSummary,
  FailedOrderInfo
} from './types';
import { upsertOrder } from '../db/repositories/ordersRepository';
import { replaceOrderItems } from '../db/repositories/orderItemsRepository';
import { createSyncJobIfNotExists } from '../services/jobsService';
import { db } from '../db/knex';
import { ImportRow, validateImportRows } from './validation';

export interface ImportOrdersFromFilesOptions {
  headerFilePath: string;
  itemsFilePath: string;
  separator?: string;
  importedBy: string;
}

export interface ImportOrdersResult {
  summary: ImportSummary;
  failures: FailedOrderInfo[];
  importId: number | null;
  jobId: number | null;
}

const IMPORT_JOB_TYPE = 'IMPORT_ORDERS';

function parseNumber(
  raw: string | undefined,
  fallback: number | null = null
): number | null {
  if (raw == null || raw === '') return fallback;
  const cleaned = raw.replace(',', '.');
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

function parseDate(raw: string | undefined): Date {
  if (!raw) return new Date();
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    return new Date();
  }
  return d;
}

function getVal(
  row: RawOrderHeaderRow,
  keys: string[],
  required = false
): string | undefined {
  for (const key of keys) {
    const v = row[key];
    if (v != null && v !== '') return v;
  }
  if (required) {
    throw new Error(`Missing required field: ${keys.join('|')}`);
  }
  return undefined;
}

function parseHeaderRow(row: RawOrderHeaderRow): ParsedOrderHeader {
  const fileOrderId =
    getVal(row, ['file_order_id', 'file_id', 'order_id'], true)!.toString();

  const channel =
    getVal(row, ['order_channel', 'channel', 'store_view']) ?? 'UNKNOWN';

  const storeCode =
    getVal(row, ['store_code', 'store', 'website_code'], true)!.toString();

  return {
    file_order_id: fileOrderId,
    external_order_id:
      getVal(row, ['external_order_id', 'increment_id']) ?? null,
    order_channel: channel,
    store_code: storeCode,
    seller_id: getVal(row, ['seller_id']) ?? null,
    created_date: parseDate(getVal(row, ['created_date', 'created_at'])),
    email: getVal(row, ['email', 'customer_email']) ?? null,
    firstname:
      getVal(row, ['firstname', 'first_name', 'customer_firstname']) ?? null,
    lastname:
      getVal(row, ['lastname', 'last_name', 'customer_lastname']) ?? null,
    country_id: getVal(row, ['country_id']) ?? null,
    region_id: getVal(row, ['region_id']) ?? null,
    region: getVal(row, ['region']) ?? null,
    postcode: getVal(row, ['postcode', 'zip']) ?? null,
    street: getVal(row, ['street', 'street1']) ?? null,
    city: getVal(row, ['city']) ?? null,
    telephone: getVal(row, ['telephone', 'phone']) ?? null,
    company: getVal(row, ['company']) ?? null,
    fax: getVal(row, ['fax']) ?? null,
    taxvat: getVal(row, ['taxvat', 'vat_id']) ?? null,
    cnpj: getVal(row, ['cnpj']) ?? null,
    shipping_method: getVal(row, ['shipping_method']) ?? null,
    delivery_instructions:
      getVal(row, ['delivery_instructions', 'shipping_instructions']) ?? null,
    coupon_code: getVal(row, ['coupon_code']) ?? null
  };
}

export function parseItemRow(row: RawOrderItemRow): ParsedOrderItem {

  const fileOrderId =
    (row['file_order_id'] ||
      row['order_id'] ||
      row['file_id'])?.toString() ?? '';

  if (!fileOrderId) {
    throw new Error('Item row missing file_order_id/order_id');
  }

  const qty = parseNumber(row['qty_ordered'], 0) ?? 0;
  const price = parseNumber(row['price'], 0) ?? 0;
  const originalPrice = parseNumber(row['original_price'], null);

  return {
    file_order_id: fileOrderId,
    sku: (row['sku'] ?? '').toString(),
    name: (row['name'] ?? null) as string | null,
    qty_ordered: qty,
    price,
    original_price: originalPrice
  };
}

export async function importOrdersFromFiles(
  options: ImportOrdersFromFilesOptions
): Promise<ImportOrdersResult> {
  const ctx = createContextId('importOrders');

  const headerFilePath = path.resolve(options.headerFilePath);
  const itemsFilePath = path.resolve(options.itemsFilePath);

  const headerFilename = path.basename(headerFilePath);
  const itemsFilename = path.basename(itemsFilePath);

  const delimiter =
    options.separator || detectDelimiter(headerFilePath) || ',';

  logInfo(ctx, 'Starting CSV read', {
    headerFilePath,
    itemsFilePath,
    delimiter
  });

  const [rawHeaders, rawItems] = await Promise.all([
    parseCsvFile(headerFilePath, delimiter) as Promise<RawOrderHeaderRow[]>,
    parseCsvFile(itemsFilePath, delimiter) as Promise<RawOrderItemRow[]>
  ]);

  logInfo(ctx, 'CSV files loaded', {
    headerRows: rawHeaders.length,
    itemRows: rawItems.length
  });

  const failures: FailedOrderInfo[] = [];
  const summary: ImportSummary = {
    totalOrders: rawHeaders.length,
    processedOrders: 0,
    skippedOrders: 0,
    failedOrders: 0
  };

  // ─────────────────────────────────────────────────────────────
  // Create job + imports record so UI can show grouped imports
  // ─────────────────────────────────────────────────────────────
  let jobId: number | null = null;
  let importId: number | null = null;

  try {
    const jobInsert = await db('jobs').insert({
      type: IMPORT_JOB_TYPE,
      status: 'PENDING',
      attempts: 0,
      max_attempts: 1,
      next_run_at: null,
      last_error: null,
      payload: JSON.stringify({
        header_filename: headerFilename,
        items_filename: itemsFilename,
        imported_by: options.importedBy,
        header_rows: rawHeaders.length,
        item_rows: rawItems.length
      })
    });

    jobId = Array.isArray(jobInsert) ? Number(jobInsert[0]) : Number(jobInsert);

    const importInsert = await db('imports').insert({
      header_filename: headerFilename,
      items_filename: itemsFilename,
      imported_by: options.importedBy,
      total_orders: summary.totalOrders,
      processed_orders: 0,
      failed_orders: 0,
      skipped_orders: 0,
      status: 'RUNNING',
      error: null,
      job_id: jobId
    });

    importId = Array.isArray(importInsert)
      ? Number(importInsert[0])
      : Number(importInsert);

    logInfo(ctx, 'Created import record and job', {
      jobId,
      importId,
      headerFilename,
      itemsFilename
    });
  } catch (err: any) {
    logError(ctx, 'Failed to create import/job records', {
      error: String(err)
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Parse items and group by file_order_id
  // + collect rows for SKU/qty validation
  // ─────────────────────────────────────────────────────────────
  const itemsByFileId = new Map<string, ParsedOrderItem[]>();
  const importRows: ImportRow[] = [];

  for (let index = 0; index < rawItems.length; index++) {
    const raw = rawItems[index];

    try {
      const item = parseItemRow(raw);

      if (!item.sku || !item.qty_ordered) {
        logInfo(ctx, 'Skipping item with missing sku/qty', { raw });
        continue;
      }

      // Group by order
      const existing = itemsByFileId.get(item.file_order_id) ?? [];
      existing.push(item);
      itemsByFileId.set(item.file_order_id, existing);

      // Collect for validation – CSV row index is approximate (header is line 1)
      importRows.push({
        rowIndex: index + 2, // header row + 1
        sku: item.sku,
        qty: item.qty_ordered,
        raw
      });
    } catch (err: any) {
      logInfo(ctx, 'Failed to parse item row; skipping', {
        error: String(err),
        raw
      });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Validate SKUs & available stock with Magento
  // ─────────────────────────────────────────────────────────────
  if (importRows.length > 0) {
    try {
      const validation = await validateImportRows(importRows);

      if (!validation.ok) {
        const message = validation.issues.map((i) => i.message).join(' | ');

        summary.failedOrders = summary.totalOrders;
        summary.processedOrders = 0;
        summary.skippedOrders = 0;

        failures.push({
          file_order_id: 'GLOBAL',
          order_channel: 'GLOBAL',
          error: `Validation failed: ${message}`
        });

        logError(ctx, 'Import validation failed', {
          issues: validation.issues
        });
      }
    } catch (err: any) {
      // If validation itself blows up, treat as fatal
      summary.failedOrders = summary.totalOrders;
      summary.processedOrders = 0;
      summary.skippedOrders = 0;

      failures.push({
        file_order_id: 'GLOBAL',
        order_channel: 'GLOBAL',
        error: `Validation error: ${String(err)}`
      });

      logError(ctx, 'Error while validating import against Magento', {
        error: String(err)
      });
    }
  }


  const seenFileChannel = new Set<string>();

  if (summary.failedOrders === 0) {
    try {
      // ───────────────────────────────────────────────────────────
      // Main per-order processing loop
      // ───────────────────────────────────────────────────────────
      for (const raw of rawHeaders) {
        let parsed: ParsedOrderHeader | null = null;

        try {
          parsed = parseHeaderRow(raw);
        } catch (err: any) {
          summary.failedOrders++;
          failures.push({
            file_order_id:
              raw['file_order_id'] ||
              raw['order_id'] ||
              'UNKNOWN',
            order_channel: raw['order_channel'] || 'UNKNOWN',
            error: `Header parse error: ${String(err)}`
          });
          logError(ctx, 'Header parse error', {
            raw,
            error: String(err)
          });
          continue;
        }

        const key = `${parsed.file_order_id}::${parsed.order_channel}`;

        if (seenFileChannel.has(key)) {
          summary.skippedOrders++;
          logInfo(
            ctx,
            'Duplicate (file_order_id, order_channel) in CSV; skipping',
            {
              file_order_id: parsed.file_order_id,
              order_channel: parsed.order_channel
            }
          );
          continue;
        }
        seenFileChannel.add(key);

        const items = itemsByFileId.get(parsed.file_order_id) ?? [];

        if (!items.length) {
          logInfo(ctx, 'Order has no items in items.csv', {
            file_order_id: parsed.file_order_id,
            order_channel: parsed.order_channel
          });
        }

        try {
          const orderId = await upsertOrder({
            ...parsed,
            imported_by: options.importedBy,
            import_job_id: jobId ?? null
          });

          await replaceOrderItems(
            orderId,
            items.map((i) => ({
              sku: i.sku,
              name: i.name,
              qty_ordered: i.qty_ordered,
              price: i.price,
              original_price: i.original_price
            }))
          );

          await createSyncJobIfNotExists(orderId);

          summary.processedOrders++;
          logInfo(ctx, 'Imported order successfully', {
            orderId,
            file_order_id: parsed.file_order_id,
            order_channel: parsed.order_channel
          });
        } catch (err: any) {
          summary.failedOrders++;
          failures.push({
            file_order_id: parsed.file_order_id,
            order_channel: parsed.order_channel,
            error: String(err)
          });
          logError(ctx, 'Failed to import order', {
            file_order_id: parsed.file_order_id,
            order_channel: parsed.order_channel,
            error: String(err)
          });
        }
      }
    } catch (fatalErr: any) {
      summary.failedOrders = summary.totalOrders;
      summary.processedOrders = 0;
      summary.skippedOrders = 0;
      failures.push({
        file_order_id: 'GLOBAL',
        order_channel: 'GLOBAL',
        error: `Fatal import error: ${String(fatalErr)}`
      });
      logError(ctx, 'Fatal error in import loop', {
        error: String(fatalErr)
      });
    }
  }


  summary.skippedOrders =
    summary.totalOrders - summary.processedOrders - summary.failedOrders;

  const finalStatus = summary.failedOrders > 0 ? 'FAILED' : 'DONE';

  logInfo(ctx, 'Order import finished', { summary });

  // ─────────────────────────────────────────────────────────────
  // Update imports + job records with final status
  // ─────────────────────────────────────────────────────────────
  try {
    if (importId != null) {
      await db('imports')
        .where({ id: importId })
        .update({
          total_orders: summary.totalOrders,
          processed_orders: summary.processedOrders,
          failed_orders: summary.failedOrders,
          skipped_orders: summary.skippedOrders,
          status: finalStatus,
          error:
            summary.failedOrders > 0
              ? JSON.stringify(failures.slice(0, 50))
              : null,
          updated_at: db.fn.now()
        });
    }

    if (jobId != null) {
      await db('jobs')
        .where({ id: jobId })
        .update({
          status: finalStatus,
          last_error:
            finalStatus === 'FAILED'
              ? `Failed orders: ${summary.failedOrders}`
              : null,
          updated_at: db.fn.now()
        });
    }
  } catch (err: any) {
    logError(ctx, 'Failed to update import/job status', {
      error: String(err),
      jobId,
      importId
    });
  }

  return { summary, failures, importId, jobId };
}
