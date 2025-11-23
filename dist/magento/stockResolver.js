"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveStockId = resolveStockId;
// src/magento/stockResolver.ts
const node_fetch_1 = __importDefault(require("node-fetch"));
const RAW_MAGENTO_BASE_URL = process.env.MAGENTO_BASE_URL;
const MAGENTO_API_TOKEN = process.env.MAGENTO_API_TOKEN;
const MAGENTO_STORE_CODE = process.env.MAGENTO_STORE_CODE || 'default';
const MAGENTO_REST_BASE = RAW_MAGENTO_BASE_URL
    ? RAW_MAGENTO_BASE_URL.replace(/\/$/, '')
    : undefined;
const STOCK_RESOLVER_BASE = MAGENTO_REST_BASE && MAGENTO_STORE_CODE
    ? `${MAGENTO_REST_BASE}/${MAGENTO_STORE_CODE}/V1/inventory/stock-resolver`
    : undefined;
async function resolveStockId(type, code) {
    if (!STOCK_RESOLVER_BASE || !MAGENTO_API_TOKEN) {
        throw new Error('Cannot resolve stock id: config missing');
    }
    const url = `${STOCK_RESOLVER_BASE}/${encodeURIComponent(type)}/${encodeURIComponent(code)}`;
    const res = await (0, node_fetch_1.default)(url, {
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${MAGENTO_API_TOKEN}`,
        },
    });
    const text = await res.text();
    if (!res.ok) {
        console.error('Stock resolver failed', { url, status: res.status, body: text });
        throw new Error(`Stock resolver failed: ${res.status}`);
    }
    const json = JSON.parse(text);
    if (!json.stock_id) {
        throw new Error('Stock resolver did not return stock_id');
    }
    return json.stock_id;
}
