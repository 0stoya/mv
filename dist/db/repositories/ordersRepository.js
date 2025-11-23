"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.upsertOrder = upsertOrder;
exports.getOrderById = getOrderById;
exports.setMagentoIds = setMagentoIds;
exports.updateOrderStatus = updateOrderStatus;
exports.markOrderInvoiced = markOrderInvoiced;
exports.markOrderShipped = markOrderShipped;
const knex_1 = require("../knex");
async function upsertOrder(header) {
    // Always fall back to file_order_id
    const externalOrderId = header.external_order_id === undefined || header.external_order_id === null
        ? header.file_order_id
        : header.external_order_id;
    // Ensure channel is never undefined
    const channel = (header.order_channel || 'UNKNOWN').toString();
    console.log('UPSERT ORDER DEBUG:', 'file_order_id=', header.file_order_id, 'external_order_id=', externalOrderId, 'order_channel=', channel);
    // 1) Check if it already exists
    const existing = await (0, knex_1.db)('orders')
        .where({
        external_order_id: externalOrderId,
        order_channel: channel
    })
        .first();
    const baseUpdate = {
        ...header,
        external_order_id: externalOrderId,
        order_channel: channel,
        imported_by: header.imported_by ?? null
    };
    if (existing) {
        await (0, knex_1.db)('orders')
            .where({ id: existing.id })
            .update({
            ...baseUpdate,
            updated_at: knex_1.db.fn.now()
        });
        return existing.id;
    }
    // 2) Insert new
    const insertResult = await (0, knex_1.db)('orders').insert(baseUpdate);
    // MariaDB returns [insertId]
    const insertId = Array.isArray(insertResult)
        ? insertResult[0]
        : insertResult;
    return insertId;
}
async function getOrderById(id) {
    return (0, knex_1.db)('orders').where({ id }).first();
}
async function setMagentoIds(orderId, magentoOrderId, magentoIncrementId) {
    await (0, knex_1.db)('orders')
        .where({ id: orderId })
        .update({
        magento_order_id: magentoOrderId,
        magento_increment_id: magentoIncrementId ?? null,
        updated_at: knex_1.db.fn.now()
    });
}
async function updateOrderStatus(orderId, status, lastError) {
    await (0, knex_1.db)('orders')
        .where({ id: orderId })
        .update({
        status,
        last_error: lastError ?? null,
        updated_at: knex_1.db.fn.now()
    });
}
async function markOrderInvoiced(orderId, magentoInvoiceId) {
    await (0, knex_1.db)('orders')
        .where({ id: orderId })
        .update({
        magento_invoice_id: magentoInvoiceId,
        invoiced_at: knex_1.db.fn.now(),
        updated_at: knex_1.db.fn.now()
    });
}
async function markOrderShipped(orderId, magentoShipmentId) {
    await (0, knex_1.db)('orders')
        .where({ id: orderId })
        .update({
        magento_shipment_id: magentoShipmentId,
        shipped_at: knex_1.db.fn.now(),
        updated_at: knex_1.db.fn.now()
    });
}
