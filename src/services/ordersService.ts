// src/services/ordersService.ts

import { logInfo, logError } from '../utils/logger';
import {
  importOrdersFromFiles as lowLevelImportOrdersFromFiles,
  ImportOrdersResult
} from '../import/importOrders';

export interface ImportOrdersOptions {
  headerPath: string;
  itemsPath: string;
  separator?: string;
  userName: string;
}

/**
 * High-level service wrapper around the CSV import.
 * Use this from HTTP/API if you ever expose an "import orders" endpoint.
 * The heavy lifting is done in src/import/importOrders.ts (same as CLI).
 */
export async function importOrdersFromFiles(
  options: ImportOrdersOptions
): Promise<ImportOrdersResult> {
  const ctx = 'service:orders:importFromFiles';

  try {
    logInfo(ctx, 'Starting import via ordersService', {
      headerPath: options.headerPath,
      itemsPath: options.itemsPath,
      separator: options.separator,
      userName: options.userName
    });

    const result = await lowLevelImportOrdersFromFiles({
      headerFilePath: options.headerPath,
      itemsFilePath: options.itemsPath,
      separator: options.separator,
      importedBy: options.userName
    });

    // 👇 Wrap summary in an object so it matches Record<string, unknown>
    logInfo(ctx, 'Import via ordersService completed', {
      summary: result.summary
    });

    return result;
  } catch (err: any) {
    logError(ctx, 'Import via ordersService failed', {
      error: err?.message || String(err)
    });
    throw err;
  }
}
