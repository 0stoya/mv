"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchStockForSkus = fetchStockForSkus;
// src/magento/stockValidation.ts
const node_fetch_1 = __importDefault(require("node-fetch"));
const RAW_MAGENTO_BASE_URL = process.env.MAGENTO_BASE_URL; // e.g. https://mos.osycom.co.uk/rest
const MAGENTO_API_TOKEN = process.env.MAGENTO_API_TOKEN;
const MAGENTO_STORE_CODE = process.env.MAGENTO_STORE_CODE || 'default';
const MAGENTO_STOCK_ID = Number(process.env.MAGENTO_STOCK_ID || '1');
// Normalise: ensure no trailing slash
const MAGENTO_REST_BASE = RAW_MAGENTO_BASE_URL
    ? RAW_MAGENTO_BASE_URL.replace(/\/$/, '')
    : undefined;
// /rest/<storeCode>/V1/products
const PRODUCTS_URL = MAGENTO_REST_BASE && MAGENTO_STORE_CODE
    ? `${MAGENTO_REST_BASE}/${MAGENTO_STORE_CODE}/V1/products`
    : undefined;
// /rest/<storeCode>/V1/inventory/get-salable-quantity/{sku}/{stockId}
const SALABLE_QTY_URL_BASE = MAGENTO_REST_BASE && MAGENTO_STORE_CODE
    ? `${MAGENTO_REST_BASE}/${MAGENTO_STORE_CODE}/V1/inventory/get-product-salable-quantity`
    : undefined;
/**
 * Fetch stock info for a list of SKUs via Magento REST MSI salable quantity.
 * - Uses /rest/<store>/V1/products?searchCriteria[...] to detect which SKUs exist
 * - For each existing SKU, calls /rest/<store>/V1/inventory/get-salable-quantity/{sku}/{stockId}
 */
async function fetchStockForSkus(skus) {
    if (!skus.length)
        return {};
    if (!PRODUCTS_URL || !SALABLE_QTY_URL_BASE || !MAGENTO_API_TOKEN) {
        throw new Error('PRODUCTS_URL, SALABLE_QTY_URL_BASE or MAGENTO_API_TOKEN is not set; cannot validate stock.');
    }
    const uniqueSkus = Array.from(new Set(skus));
    // 1) Check which SKUs exist via /V1/products (sku IN (...))
    const searchParams = new URLSearchParams();
    searchParams.set('searchCriteria[filter_groups][0][filters][0][field]', 'sku');
    searchParams.set('searchCriteria[filter_groups][0][filters][0][value]', uniqueSkus.join(','));
    searchParams.set('searchCriteria[filter_groups][0][filters][0][condition_type]', 'in');
    searchParams.set('searchCriteria[pageSize]', '200'); // adjust if you ever expect >200 SKUs per import
    const productsUrl = `${PRODUCTS_URL}?${searchParams.toString()}`;
    const prodRes = await (0, node_fetch_1.default)(productsUrl, {
        method: 'GET',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${MAGENTO_API_TOKEN}`,
        },
    });
    const prodText = await prodRes.text();
    if (!prodRes.ok) {
        console.error('Magento REST products query failed', {
            url: productsUrl,
            status: prodRes.status,
            statusText: prodRes.statusText,
            body: prodText,
        });
        throw new Error(`Magento REST products query failed: ${prodRes.status} ${prodRes.statusText}`);
    }
    let prodJson;
    try {
        prodJson = JSON.parse(prodText);
    }
    catch (e) {
        console.error('Failed to parse Magento REST products response as JSON', {
            url: productsUrl,
            body: prodText,
            error: String(e),
        });
        throw new Error('Invalid JSON from Magento REST products query');
    }
    const existingItems = prodJson.items ?? [];
    const existingSkuSet = new Set(existingItems.map((i) => i.sku));
    const result = {};
    // Initialise all requested SKUs as "not found"
    uniqueSkus.forEach((sku) => {
        result[sku] = {
            sku,
            exists: false,
            salableQty: 0,
            inStock: false,
        };
    });
    // 2) For each existing SKU, fetch salable quantity from MSI
    for (const sku of uniqueSkus) {
        if (!existingSkuSet.has(sku)) {
            // leave as exists: false
            continue;
        }
        const salableUrl = `${SALABLE_QTY_URL_BASE}/${encodeURIComponent(sku)}/${MAGENTO_STOCK_ID}`;
        try {
            const salableRes = await (0, node_fetch_1.default)(salableUrl, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${MAGENTO_API_TOKEN}`,
                },
            });
            const salableText = await salableRes.text();
            if (!salableRes.ok) {
                console.error('Magento REST salable quantity query failed', {
                    url: salableUrl,
                    status: salableRes.status,
                    statusText: salableRes.statusText,
                    body: salableText,
                });
                // If MSI call fails for some SKU, treat as exists but 0 salableQty
                result[sku] = {
                    sku,
                    exists: true,
                    salableQty: 0,
                    inStock: false,
                };
                continue;
            }
            // Endpoint returns a plain number (JSON encoded)
            let salableQtyRaw;
            try {
                salableQtyRaw = JSON.parse(salableText);
            }
            catch {
                // Sometimes it might just be a bare number without quotes
                salableQtyRaw = Number(salableText);
            }
            const salableQtyNumber = Number(salableQtyRaw);
            const salableQty = Number.isFinite(salableQtyNumber) && salableQtyNumber > 0
                ? salableQtyNumber
                : 0;
            result[sku] = {
                sku,
                exists: true,
                salableQty,
                inStock: salableQty > 0,
            };
        }
        catch (e) {
            console.error('Error calling salable quantity endpoint', {
                url: salableUrl,
                error: String(e),
            });
            result[sku] = {
                sku,
                exists: true,
                salableQty: 0,
                inStock: false,
            };
        }
    }
    return result;
}
