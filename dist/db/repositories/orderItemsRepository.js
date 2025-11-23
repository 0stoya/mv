"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.replaceOrderItems = replaceOrderItems;
exports.getOrderItems = getOrderItems;
const knex_1 = require("../knex");
async function replaceOrderItems(orderId, items) {
    await (0, knex_1.db)('order_items').where({ order_id: orderId }).del();
    if (!items.length)
        return;
    await (0, knex_1.db)('order_items').insert(items.map((item) => ({
        order_id: orderId,
        sku: item.sku,
        name: item.name ?? null,
        qty_ordered: item.qty_ordered,
        price: item.price,
        original_price: item.original_price ?? null
    })));
}
async function getOrderItems(orderId) {
    return (0, knex_1.db)('order_items').where({ order_id: orderId });
}
