import { fetchStockForSkus } from '../magento/stockValidation';
import { RawOrderItemRow } from './types';

export interface ImportRow {
  rowIndex: number;
  sku: string;
  qty: number;
  raw: RawOrderItemRow;
}

export type ImportValidationIssueType =
  | 'SKU_NOT_FOUND'
  | 'NOT_ENOUGH_STOCK'
  | 'INVALID_QTY';

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

export async function validateImportRows(
  rows: ImportRow[]
): Promise<ImportValidationResult> {
  const issues: ImportValidationIssue[] = [];

  const validRows: ImportRow[] = [];
  for (const row of rows) {
    if (!Number.isFinite(row.qty) || row.qty <= 0) {
      issues.push({
        type: 'INVALID_QTY',
        sku: row.sku,
        rowIndex: row.rowIndex,
        message: `Row ${row.rowIndex}: invalid qty "${row.qty}" for SKU "${row.sku}".`,
      });
      continue;
    }
    validRows.push(row);
  }

  if (!validRows.length) {
    return { ok: false, issues };
  }

  const totalsBySku = new Map<string, number>();
  for (const row of validRows) {
    const current = totalsBySku.get(row.sku) ?? 0;
    totalsBySku.set(row.sku, current + row.qty);
  }

  const skus = Array.from(totalsBySku.keys());
  const stockMap = await fetchStockForSkus(skus);

  for (const sku of skus) {
    const totalRequested = totalsBySku.get(sku)!;
    const stock = stockMap[sku];

    if (!stock || !stock.exists) {
      issues.push({
        type: 'SKU_NOT_FOUND',
        sku,
        rowIndex: null,
        message: `SKU "${sku}" does not exist in Magento.`,
      });
      continue;
    }

    if (totalRequested > stock.salableQty || !stock.inStock) {
      issues.push({
        type: 'NOT_ENOUGH_STOCK',
        sku,
        rowIndex: null,
        message: `SKU "${sku}" has only ${stock.salableQty} available, but CSV requests ${totalRequested}.`,
      });
    }
  }

  return {
    ok: issues.length === 0,
    issues,
  };
}
