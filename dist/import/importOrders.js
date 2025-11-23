"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseItemRow = parseItemRow;
exports.importOrdersFromFiles = importOrdersFromFiles;
// src/import/importOrders.ts
const path_1 = __importDefault(require("path"));
const csvUtils_1 = require("../utils/csvUtils");
const logger_1 = require("../utils/logger");
const ordersRepository_1 = require("../db/repositories/ordersRepository");
const orderItemsRepository_1 = require("../db/repositories/orderItemsRepository");
const jobsService_1 = require("../services/jobsService");
const knex_1 = require("../db/knex");
const validation_1 = require("./validation");
const IMPORT_JOB_TYPE = 'IMPORT_ORDERS';
function parseNumber(raw, fallback = null) {
    if (raw == null || raw === '')
        return fallback;
    const cleaned = raw.replace(',', '.');
    const n = Number(cleaned);
    if (!Number.isFinite(n))
        return fallback;
    return n;
}
function parseDate(raw) {
    if (!raw)
        return new Date();
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) {
        return new Date();
    }
    return d;
}
function getVal(row, keys, required = false) {
    for (const key of keys) {
        const v = row[key];
        if (v != null && v !== '')
            return v;
    }
    if (required) {
        throw new Error(`Missing required field: ${keys.join('|')}`);
    }
    return undefined;
}
function parseHeaderRow(row) {
    const fileOrderId = getVal(row, ['file_order_id', 'file_id', 'order_id'], true).toString();
    const channel = getVal(row, ['order_channel', 'channel', 'store_view']) ?? 'UNKNOWN';
    const storeCode = getVal(row, ['store_code', 'store', 'website_code'], true).toString();
    return {
        file_order_id: fileOrderId,
        external_order_id: getVal(row, ['external_order_id', 'increment_id']) ?? null,
        order_channel: channel,
        store_code: storeCode,
        seller_id: getVal(row, ['seller_id']) ?? null,
        created_date: parseDate(getVal(row, ['created_date', 'created_at'])),
        email: getVal(row, ['email', 'customer_email']) ?? null,
        firstname: getVal(row, ['firstname', 'first_name', 'customer_firstname']) ?? null,
        lastname: getVal(row, ['lastname', 'last_name', 'customer_lastname']) ?? null,
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
        delivery_instructions: getVal(row, ['delivery_instructions', 'shipping_instructions']) ?? null,
        coupon_code: getVal(row, ['coupon_code']) ?? null
    };
}
function parseItemRow(row) {
    const fileOrderId = (row['file_order_id'] ||
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
        name: (row['name'] ?? null),
        qty_ordered: qty,
        price,
        original_price: originalPrice
    };
}
async function importOrdersFromFiles(options) {
    const ctx = (0, logger_1.createContextId)('importOrders');
    const headerFilePath = path_1.default.resolve(options.headerFilePath);
    const itemsFilePath = path_1.default.resolve(options.itemsFilePath);
    const headerFilename = path_1.default.basename(headerFilePath);
    const itemsFilename = path_1.default.basename(itemsFilePath);
    const delimiter = options.separator || (0, csvUtils_1.detectDelimiter)(headerFilePath) || ',';
    (0, logger_1.logInfo)(ctx, 'Starting CSV read', {
        headerFilePath,
        itemsFilePath,
        delimiter
    });
    const [rawHeaders, rawItems] = await Promise.all([
        (0, csvUtils_1.parseCsvFile)(headerFilePath, delimiter),
        (0, csvUtils_1.parseCsvFile)(itemsFilePath, delimiter)
    ]);
    (0, logger_1.logInfo)(ctx, 'CSV files loaded', {
        headerRows: rawHeaders.length,
        itemRows: rawItems.length
    });
    const failures = [];
    const summary = {
        totalOrders: rawHeaders.length,
        processedOrders: 0,
        skippedOrders: 0,
        failedOrders: 0
    };
    // ─────────────────────────────────────────────────────────────
    // Create job + imports record so UI can show grouped imports
    // ─────────────────────────────────────────────────────────────
    let jobId = null;
    let importId = null;
    try {
        const jobInsert = await (0, knex_1.db)('jobs').insert({
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
        const importInsert = await (0, knex_1.db)('imports').insert({
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
        (0, logger_1.logInfo)(ctx, 'Created import record and job', {
            jobId,
            importId,
            headerFilename,
            itemsFilename
        });
    }
    catch (err) {
        (0, logger_1.logError)(ctx, 'Failed to create import/job records', {
            error: String(err)
        });
    }
    // ─────────────────────────────────────────────────────────────
    // Parse items and group by file_order_id
    // + collect rows for SKU/qty validation
    // ─────────────────────────────────────────────────────────────
    const itemsByFileId = new Map();
    const importRows = [];
    for (let index = 0; index < rawItems.length; index++) {
        const raw = rawItems[index];
        try {
            const item = parseItemRow(raw);
            if (!item.sku || !item.qty_ordered) {
                (0, logger_1.logInfo)(ctx, 'Skipping item with missing sku/qty', { raw });
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
        }
        catch (err) {
            (0, logger_1.logInfo)(ctx, 'Failed to parse item row; skipping', {
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
            const validation = await (0, validation_1.validateImportRows)(importRows);
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
                (0, logger_1.logError)(ctx, 'Import validation failed', {
                    issues: validation.issues
                });
            }
        }
        catch (err) {
            // If validation itself blows up, treat as fatal
            summary.failedOrders = summary.totalOrders;
            summary.processedOrders = 0;
            summary.skippedOrders = 0;
            failures.push({
                file_order_id: 'GLOBAL',
                order_channel: 'GLOBAL',
                error: `Validation error: ${String(err)}`
            });
            (0, logger_1.logError)(ctx, 'Error while validating import against Magento', {
                error: String(err)
            });
        }
    }
    const seenFileChannel = new Set();
    if (summary.failedOrders === 0) {
        try {
            // ───────────────────────────────────────────────────────────
            // Main per-order processing loop
            // ───────────────────────────────────────────────────────────
            for (const raw of rawHeaders) {
                let parsed = null;
                try {
                    parsed = parseHeaderRow(raw);
                }
                catch (err) {
                    summary.failedOrders++;
                    failures.push({
                        file_order_id: raw['file_order_id'] ||
                            raw['order_id'] ||
                            'UNKNOWN',
                        order_channel: raw['order_channel'] || 'UNKNOWN',
                        error: `Header parse error: ${String(err)}`
                    });
                    (0, logger_1.logError)(ctx, 'Header parse error', {
                        raw,
                        error: String(err)
                    });
                    continue;
                }
                const key = `${parsed.file_order_id}::${parsed.order_channel}`;
                if (seenFileChannel.has(key)) {
                    summary.skippedOrders++;
                    (0, logger_1.logInfo)(ctx, 'Duplicate (file_order_id, order_channel) in CSV; skipping', {
                        file_order_id: parsed.file_order_id,
                        order_channel: parsed.order_channel
                    });
                    continue;
                }
                seenFileChannel.add(key);
                const items = itemsByFileId.get(parsed.file_order_id) ?? [];
                if (!items.length) {
                    (0, logger_1.logInfo)(ctx, 'Order has no items in items.csv', {
                        file_order_id: parsed.file_order_id,
                        order_channel: parsed.order_channel
                    });
                }
                try {
                    const orderId = await (0, ordersRepository_1.upsertOrder)({
                        ...parsed,
                        imported_by: options.importedBy,
                        import_job_id: jobId ?? null
                    });
                    await (0, orderItemsRepository_1.replaceOrderItems)(orderId, items.map((i) => ({
                        sku: i.sku,
                        name: i.name,
                        qty_ordered: i.qty_ordered,
                        price: i.price,
                        original_price: i.original_price
                    })));
                    await (0, jobsService_1.createSyncJobIfNotExists)(orderId);
                    summary.processedOrders++;
                    (0, logger_1.logInfo)(ctx, 'Imported order successfully', {
                        orderId,
                        file_order_id: parsed.file_order_id,
                        order_channel: parsed.order_channel
                    });
                }
                catch (err) {
                    summary.failedOrders++;
                    failures.push({
                        file_order_id: parsed.file_order_id,
                        order_channel: parsed.order_channel,
                        error: String(err)
                    });
                    (0, logger_1.logError)(ctx, 'Failed to import order', {
                        file_order_id: parsed.file_order_id,
                        order_channel: parsed.order_channel,
                        error: String(err)
                    });
                }
            }
        }
        catch (fatalErr) {
            summary.failedOrders = summary.totalOrders;
            summary.processedOrders = 0;
            summary.skippedOrders = 0;
            failures.push({
                file_order_id: 'GLOBAL',
                order_channel: 'GLOBAL',
                error: `Fatal import error: ${String(fatalErr)}`
            });
            (0, logger_1.logError)(ctx, 'Fatal error in import loop', {
                error: String(fatalErr)
            });
        }
    }
    summary.skippedOrders =
        summary.totalOrders - summary.processedOrders - summary.failedOrders;
    const finalStatus = summary.failedOrders > 0 ? 'FAILED' : 'DONE';
    (0, logger_1.logInfo)(ctx, 'Order import finished', { summary });
    // ─────────────────────────────────────────────────────────────
    // Update imports + job records with final status
    // ─────────────────────────────────────────────────────────────
    try {
        if (importId != null) {
            await (0, knex_1.db)('imports')
                .where({ id: importId })
                .update({
                total_orders: summary.totalOrders,
                processed_orders: summary.processedOrders,
                failed_orders: summary.failedOrders,
                skipped_orders: summary.skippedOrders,
                status: finalStatus,
                error: summary.failedOrders > 0
                    ? JSON.stringify(failures.slice(0, 50))
                    : null,
                updated_at: knex_1.db.fn.now()
            });
        }
        if (jobId != null) {
            await (0, knex_1.db)('jobs')
                .where({ id: jobId })
                .update({
                status: finalStatus,
                last_error: finalStatus === 'FAILED'
                    ? `Failed orders: ${summary.failedOrders}`
                    : null,
                updated_at: knex_1.db.fn.now()
            });
        }
    }
    catch (err) {
        (0, logger_1.logError)(ctx, 'Failed to update import/job status', {
            error: String(err),
            jobId,
            importId
        });
    }
    return { summary, failures, importId, jobId };
}
