// src/import/importPreview.ts
import path from 'path';
import { parseCsvFile, detectDelimiter } from '../utils/csvUtils';
import { createContextId, logInfo, logError } from '../utils/logger';
import { RawOrderHeaderRow, RawOrderItemRow } from './types';
import { parseItemRow } from './importOrders';
import { ImportRow, validateImportRows, ImportValidationIssue } from './validation';

export interface ImportPreviewOptions {
  headerFilePath: string;
  itemsFilePath: string;
  separator?: string;
    importedBy?: string;
}

export interface ImportPreviewResult {
  headerFilename: string;
  itemsFilename: string;
  totalOrders: number;
  totalItemRows: number;
  validationOk: boolean;
  issues: ImportValidationIssue[];
}

/**
 * Reads the same CSVs as the real import, but:
 * - does NOT touch DB
 * - validates SKUs + stock in Magento
 * - returns summary + issues for UI
 */
export async function previewImportFromFiles(
  options: ImportPreviewOptions
): Promise<ImportPreviewResult> {
  const ctx = createContextId('importPreview');

  const headerFilePath = path.resolve(options.headerFilePath);
  const itemsFilePath = path.resolve(options.itemsFilePath);

  const headerFilename = path.basename(headerFilePath);
  const itemsFilename = path.basename(itemsFilePath);

  const delimiter =
    options.separator || detectDelimiter(headerFilePath) || ',';

  logInfo(ctx, 'Starting CSV preview read', {
    headerFilePath,
    itemsFilePath,
    delimiter,
    importedBy: options.importedBy ?? 'unknown'
  });



  const [rawHeaders, rawItems] = await Promise.all([
    parseCsvFile(headerFilePath, delimiter) as Promise<RawOrderHeaderRow[]>,
    parseCsvFile(itemsFilePath, delimiter) as Promise<RawOrderItemRow[]>
  ]);

  logInfo(ctx, 'CSV files loaded for preview', {
    headerRows: rawHeaders.length,
    itemRows: rawItems.length
  });

  const importRows: ImportRow[] = [];

  for (let index = 0; index < rawItems.length; index++) {
    const raw = rawItems[index];

    try {
      const item = parseItemRow(raw);

      if (!item.sku || !item.qty_ordered) {
        logInfo(ctx, 'Preview: skipping item with missing sku/qty', { raw });
        continue;
      }

      importRows.push({
        rowIndex: index + 2, // assuming header is line 1
        sku: item.sku,
        qty: item.qty_ordered,
        raw
      });
    } catch (err: any) {
      logInfo(ctx, 'Preview: failed to parse item row; skipping', {
        error: String(err),
        raw
      });
    }
  }

  let issues: ImportValidationIssue[] = [];
  let validationOk = true;

  if (importRows.length > 0) {
    try {
      const validation = await validateImportRows(importRows);
      validationOk = validation.ok;
      issues = validation.issues;
    } catch (err: any) {
      validationOk = false;
      logError(ctx, 'Preview validation error', { error: String(err) });
      issues = [
        {
          type: 'INVALID_QTY',
          sku: 'GLOBAL',
          rowIndex: null,
          message: `Preview validation error: ${String(err)}`
        }
      ];
    }
  }

  return {
    headerFilename,
    itemsFilename,
    totalOrders: rawHeaders.length,
    totalItemRows: rawItems.length,
    validationOk,
    issues
  };
}
