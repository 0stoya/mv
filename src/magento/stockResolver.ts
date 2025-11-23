// src/magento/stockResolver.ts
import fetch from 'node-fetch';

const RAW_MAGENTO_BASE_URL = process.env.MAGENTO_BASE_URL;
const MAGENTO_API_TOKEN = process.env.MAGENTO_API_TOKEN;
const MAGENTO_STORE_CODE = process.env.MAGENTO_STORE_CODE || 'default';

const MAGENTO_REST_BASE = RAW_MAGENTO_BASE_URL
  ? RAW_MAGENTO_BASE_URL.replace(/\/$/, '')
  : undefined;

const STOCK_RESOLVER_BASE =
  MAGENTO_REST_BASE && MAGENTO_STORE_CODE
    ? `${MAGENTO_REST_BASE}/${MAGENTO_STORE_CODE}/V1/inventory/stock-resolver`
    : undefined;

export async function resolveStockId(
  type: 'website' | 'sales-channel',
  code: string
): Promise<number> {
  if (!STOCK_RESOLVER_BASE || !MAGENTO_API_TOKEN) {
    throw new Error('Cannot resolve stock id: config missing');
  }

  const url = `${STOCK_RESOLVER_BASE}/${encodeURIComponent(
    type
  )}/${encodeURIComponent(code)}`;

  const res = await fetch(url, {
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

  const json = JSON.parse(text) as { stock_id?: number };
  if (!json.stock_id) {
    throw new Error('Stock resolver did not return stock_id');
  }

  return json.stock_id;
}
