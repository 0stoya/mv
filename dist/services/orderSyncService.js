"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncOrderById = syncOrderById;
exports.invoiceOrderById = invoiceOrderById;
exports.shipOrderById = shipOrderById;
const knex_1 = require("../db/knex");
const magentoClient_1 = __importDefault(require("../magento/magentoClient"));
const logger_1 = require("../utils/logger");
const channelRuleService_1 = require("./channelRuleService");
const ordersRepository_1 = require("../db/repositories/ordersRepository");
const jobsService_1 = require("./jobsService");
const dateUtils_1 = require("../utils/dateUtils");
/**
 * SYNC_ORDER_TO_MAGENTO
 *
 * - Creates Magento guest cart
 * - Adds items
 * - Sets addresses + payment
 * - Places order
 * - Backdates + attaches customer
 * - Adds "Bulk Import" comment
 * - Schedules INVOICE job (if channelRule.autoInvoice)
 *   (Shipping is now scheduled AFTER invoice succeeds)
 */
async function syncOrderById(orderId, parentCtx = 'worker') {
    const ctx = (0, logger_1.createChildContextId)(parentCtx, `order:${orderId}`);
    try {
        const order = await (0, knex_1.db)('orders').where({ id: orderId }).first();
        if (!order) {
            (0, logger_1.logError)(ctx, 'Order not found in DB', { orderId });
            throw new Error(`Order ${orderId} not found`);
        }
        const items = await (0, knex_1.db)('order_items').where({
            order_id: orderId
        });
        // If already synced (magento_order_id exists), don't try to create again.
        if (order.magento_order_id) {
            (0, logger_1.logInfo)(ctx, 'Order already has magento_order_id, skipping creation', {
                magento_order_id: order.magento_order_id
            });
            return;
        }
        const magento = magentoClient_1.default;
        // 1. Create guest cart
        (0, logger_1.logInfo)(ctx, 'Creating guest cart', {
            external_order_id: order.external_order_id,
            order_channel: order.order_channel
        });
        const cartId = await magento.createGuestCart();
        // 2. Add items (with limited concurrency)
        if (items.length) {
            const maxItemConcurrency = Number(process.env.ITEM_CONCURRENCY || '4');
            const queue = [...items];
            const workers = [];
            const workerCount = Math.min(maxItemConcurrency, queue.length);
            for (let i = 0; i < workerCount; i++) {
                workers.push((async () => {
                    while (true) {
                        const item = queue.shift();
                        if (!item)
                            return;
                        (0, logger_1.logInfo)(ctx, 'Adding item to cart', {
                            cartId,
                            sku: item.sku,
                            qty: item.qty_ordered
                        });
                        await magento.addItemToGuestCart(cartId, {
                            sku: item.sku,
                            qty: Number(item.qty_ordered)
                        });
                    }
                })());
            }
            await Promise.all(workers);
        }
        else {
            (0, logger_1.logInfo)(ctx, 'Order has no items, continuing anyway', { orderId });
        }
        // 3. Address + shipping
        (0, logger_1.logInfo)(ctx, 'Setting addresses and shipping', { cartId });
        await magento.setGuestCartAddresses(cartId, order);
        // 4. Payment method (COD)
        (0, logger_1.logInfo)(ctx, 'Setting payment method COD', { cartId });
        await magento.setPaymentMethodCOD(cartId);
        // 5. Place order
        const magentoOrderId = await magento.placeGuestOrder(cartId);
        (0, logger_1.logInfo)(ctx, 'Magento order placed', { magentoOrderId });
        // Fetch full order to get increment_id (non-fatal if it fails)
        let magentoIncrementId = null;
        try {
            const magentoOrder = await magento.getOrderById(magentoOrderId);
            magentoIncrementId = magentoOrder.increment_id?.toString() ?? null;
            (0, logger_1.logInfo)(ctx, 'Fetched Magento increment_id', {
                magentoOrderId,
                magentoIncrementId
            });
        }
        catch (err) {
            (0, logger_1.logError)(ctx, 'Failed to fetch Magento increment_id (non-fatal)', {
                magentoOrderId,
                error: err?.message || String(err)
            });
        }
        // 6. Save to DB (status SYNCED, magento_order_id set)
        await (0, knex_1.db)('orders')
            .where({ id: orderId })
            .update({
            status: 'SYNCED',
            magento_order_id: magentoOrderId,
            magento_increment_id: magentoIncrementId,
            updated_at: knex_1.db.fn.now()
        });
        // 7. Backdate + convert to customer (via Ostoya_OrderTools)
        try {
            const createdAt = (0, dateUtils_1.formatToMySqlDateTime)(order.created_date);
            if (order.email) {
                await magento.attachCustomerAndBackdate(magentoOrderId, order.email, order.firstname || 'Guest', order.lastname || 'Guest', createdAt);
                (0, logger_1.logInfo)(ctx, 'Attached customer and backdated order in Magento', {
                    magentoOrderId,
                    email: order.email,
                    createdAt
                });
            }
            else {
                await magento.backdateOrder(magentoOrderId, createdAt);
                (0, logger_1.logInfo)(ctx, 'Backdated guest order in Magento', {
                    magentoOrderId,
                    createdAt
                });
            }
        }
        catch (err) {
            // Non-fatal: order is already created and stored; this just affects metadata
            (0, logger_1.logError)(ctx, 'Failed to attach customer / backdate order (non-fatal)', {
                magentoOrderId,
                error: err?.message || String(err)
            });
        }
        // 8. Add Magento comment (non-fatal)
        const comment = [
            'Order Created via Bulk Import',
            `Import order id: ${order.file_order_id}`,
            `Imported by: ${order.imported_by || 'System'}`,
            `Original created date: ${order.created_date}`
        ].join('\n');
        try {
            await magento.addOrderComment(magentoOrderId, comment);
            (0, logger_1.logInfo)(ctx, 'Added Magento order comment', { magentoOrderId });
        }
        catch (err) {
            (0, logger_1.logError)(ctx, 'Failed to add Magento order comment (non-fatal)', {
                magentoOrderId,
                error: err?.message || String(err)
            });
        }
        // 9. Channel rules: schedule invoice (shipping is scheduled after invoice)
        const channelRule = await (0, channelRuleService_1.resolveChannelRule)(order.order_channel);
        if (channelRule.autoInvoice) {
            await (0, jobsService_1.createInvoiceJobIfNotExists)(order.id);
            (0, logger_1.logInfo)(ctx, 'Scheduled invoice job', {
                orderId,
                magentoOrderId,
                channel: order.order_channel
            });
        }
        // If someone misconfigures autoShip=true, autoInvoice=false, warn in logs
        if (channelRule.autoShip && !channelRule.autoInvoice) {
            (0, logger_1.logError)(ctx, 'Channel rule has autoShip=true but autoInvoice=false; shipping will never auto-run', {
                channel: order.order_channel
            });
        }
    }
    catch (err) {
        (0, logger_1.logError)(ctx, 'Failed to sync order', {
            error: err?.message || String(err)
        });
        throw err;
    }
}
/**
 * INVOICE_MAGENTO_ORDER
 *
 * - Creates invoice in Magento
 * - Backdates invoice
 * - Marks order.invoiced_at
 * - Then, if channelRule.autoShip === true, schedules SHIP_MAGENTO_ORDER
 */
async function invoiceOrderById(orderId, parentCtx = 'worker') {
    const ctx = (0, logger_1.createChildContextId)(parentCtx, `invoice:${orderId}`);
    const order = await (0, knex_1.db)('orders').where({ id: orderId }).first();
    if (!order) {
        (0, logger_1.logError)(ctx, 'Order not found in DB for invoice', { orderId });
        throw new Error(`Order ${orderId} not found`);
    }
    if (!order.magento_order_id) {
        (0, logger_1.logError)(ctx, 'Cannot invoice order without magento_order_id', {
            orderId
        });
        throw new Error('Order has no magento_order_id');
    }
    if (order.invoiced_at) {
        (0, logger_1.logInfo)(ctx, 'Order already invoiced, skipping', {
            orderId,
            magento_order_id: order.magento_order_id,
            invoiced_at: order.invoiced_at
        });
        return;
    }
    const magento = magentoClient_1.default;
    // 1) Create invoice in Magento
    const invoiceId = await magento.createInvoice(order.magento_order_id);
    // 2) Compute backdated invoice time: 10 minutes after order.created_date
    const invoiceDate = (0, dateUtils_1.addMinutes)(order.created_date, 10);
    const invoiceCreatedAt = (0, dateUtils_1.formatToMySqlDateTime)(invoiceDate);
    // 3) Backdate invoice in Magento (non-fatal if it fails)
    try {
        await magento.backdateInvoice(invoiceId, invoiceCreatedAt);
        (0, logger_1.logInfo)(ctx, 'Backdated invoice in Magento', {
            orderId,
            invoiceId,
            invoiceCreatedAt
        });
    }
    catch (err) {
        (0, logger_1.logError)(ctx, 'Failed to backdate invoice (non-fatal)', {
            orderId,
            invoiceId,
            error: err?.message || String(err)
        });
    }
    // 4) Persist invoiced_at
    await (0, ordersRepository_1.markOrderInvoiced)(orderId, invoiceId);
    (0, logger_1.logInfo)(ctx, 'Invoice created and recorded', {
        orderId,
        invoiceId
    });
    // 5) After successful invoice, decide whether to auto-schedule shipping
    try {
        const refreshedOrder = await (0, knex_1.db)('orders')
            .where({ id: orderId })
            .first();
        if (!refreshedOrder) {
            (0, logger_1.logError)(ctx, 'Order disappeared after invoicing (unexpected)', {
                orderId
            });
            return;
        }
        const channelRule = await (0, channelRuleService_1.resolveChannelRule)(refreshedOrder.order_channel);
        if (channelRule.autoShip) {
            await (0, jobsService_1.createShipJobIfNotExists)(orderId);
            (0, logger_1.logInfo)(ctx, 'Scheduled ship job after invoice', {
                orderId,
                magento_order_id: refreshedOrder.magento_order_id,
                channel: refreshedOrder.order_channel
            });
        }
    }
    catch (err) {
        // Non-fatal: invoice is still created; just no auto-shipping
        (0, logger_1.logError)(ctx, 'Failed to schedule ship job after invoice (non-fatal)', {
            orderId,
            error: err?.message || String(err)
        });
    }
}
/**
 * SHIP_MAGENTO_ORDER
 *
 * - Creates shipment in Magento
 * - Backdates shipment
 * - Marks order.shipped_at
 */
async function shipOrderById(orderId, parentCtx = 'worker') {
    const ctx = (0, logger_1.createChildContextId)(parentCtx, `ship:${orderId}`);
    const order = await (0, knex_1.db)('orders').where({ id: orderId }).first();
    if (!order) {
        (0, logger_1.logError)(ctx, 'Order not found in DB for shipment', { orderId });
        throw new Error(`Order ${orderId} not found`);
    }
    if (!order.magento_order_id) {
        (0, logger_1.logError)(ctx, 'Cannot ship order without magento_order_id', {
            orderId
        });
        throw new Error('Order has no magento_order_id');
    }
    if (order.shipped_at) {
        (0, logger_1.logInfo)(ctx, 'Order already shipped, skipping', {
            orderId,
            magento_order_id: order.magento_order_id,
            shipped_at: order.shipped_at
        });
        return;
    }
    const magento = magentoClient_1.default;
    // 1) Create shipment in Magento
    const shipmentId = await magento.createShipment(order.magento_order_id);
    // 2) Compute backdated shipment time: order.created_date + 20 minutes
    const shipmentDate = (0, dateUtils_1.addMinutes)(order.created_date, 20);
    const shipmentCreatedAt = (0, dateUtils_1.formatToMySqlDateTime)(shipmentDate);
    // 3) Backdate shipment in Magento (non-fatal if it fails)
    try {
        await magento.backdateShipment(shipmentId, shipmentCreatedAt);
        (0, logger_1.logInfo)(ctx, 'Backdated shipment in Magento', {
            orderId,
            shipmentId,
            shipmentCreatedAt
        });
    }
    catch (err) {
        (0, logger_1.logError)(ctx, 'Failed to backdate shipment (non-fatal)', {
            orderId,
            shipmentId,
            error: err?.message || String(err)
        });
    }
    // 4) Persist shipped_at
    await (0, ordersRepository_1.markOrderShipped)(orderId, shipmentId);
    (0, logger_1.logInfo)(ctx, 'Shipment created and recorded', {
        orderId,
        shipmentId
    });
}
