import { fetchStockForSkus } from '../magento/stockValidation';
import { RawOrderItemRow } from './types';

export interface ImportRow {
  rowIndex: number;
  sku: string;
  qty: number;
  raw: RawOrderItemRow;
}

export type ImportValidationIssueType = 'SKU_NOT_FOUND' | 'NOT_ENOUGH_STOCK' | 'INVALID_QTY';

export interface ImportValidationIssue {
  type: ImportValidationIssueType;
  sku: string;
  rowIndex: number | null;
  message: string;
}

export interface ImportValidationResult {
  ok: boolean;
  issues: ImportValidationIssue[];
}

export async function validateImportRows(rows: ImportRow[]): Promise<ImportValidationResult> {
  const issues: ImportValidationIssue[] = [];
  const validRows: ImportRow[] = [];

  // 1. Basic sanity check (No API call needed)
  for (const row of rows) {
    if (!Number.isFinite(row.qty) || row.qty <= 0) {
      issues.push({
        type: 'INVALID_QTY',
        sku: row.sku,
        rowIndex: row.rowIndex,
        message: `Row ${row.rowIndex}: invalid qty "${row.qty}"`
      });
      continue;
    }
    validRows.push(row);
  }

  if (!validRows.length) {
    return { ok: issues.length === 0, issues };
  }

  // 2. Aggregate Totals
  const totalsBySku = new Map<string, number>();
  for (const row of validRows) {
    const current = totalsBySku.get(row.sku) ?? 0;
    totalsBySku.set(row.sku, current + row.qty);
  }

  const skus = Array.from(totalsBySku.keys());

  // 3. Batch API Call
  // Assuming fetchStockForSkus returns Record<string, { exists: boolean, salableQty: number, inStock: boolean }>
  let stockMap: Record<string, any> = {};
  
  try {
    stockMap = await fetchStockForSkus(skus);
  } catch (err: any) {
    // If validation API fails completely, we should probably fail safe or warn
    // For now, let's assume if we can't validate, we return a fatal issue
    return {
      ok: false,
      issues: [{
        type: 'SKU_NOT_FOUND',
        sku: 'GLOBAL',
        rowIndex: null,
        message: `Validation API failed: ${err.message}`
      }]
    };
  }

  // 4. Check logic
  for (const sku of skus) {
    const totalRequested = totalsBySku.get(sku)!;
    const stock = stockMap[sku];

    if (!stock || !stock.exists) {
      issues.push({
        type: 'SKU_NOT_FOUND',
        sku,
        rowIndex: null,
        message: `SKU "${sku}" does not exist in Magento.`
      });
      continue;
    }

    // Optional: Only check stock if you want to enforce strict inventory
    if (totalRequested > stock.salableQty || !stock.inStock) {
      issues.push({
        type: 'NOT_ENOUGH_STOCK',
        sku,
        rowIndex: null,
        message: `SKU "${sku}" has ${stock.salableQty} available, requested ${totalRequested}.`
      });
    }
  }

  return { ok: issues.length === 0, issues };
}
