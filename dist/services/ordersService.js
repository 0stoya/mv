"use strict";
// src/services/ordersService.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.importOrdersFromFiles = importOrdersFromFiles;
const logger_1 = require("../utils/logger");
const importOrders_1 = require("../import/importOrders");
/**
 * High-level service wrapper around the CSV import.
 * Use this from HTTP/API if you ever expose an "import orders" endpoint.
 * The heavy lifting is done in src/import/importOrders.ts (same as CLI).
 */
async function importOrdersFromFiles(options) {
    const ctx = 'service:orders:importFromFiles';
    try {
        (0, logger_1.logInfo)(ctx, 'Starting import via ordersService', {
            headerPath: options.headerPath,
            itemsPath: options.itemsPath,
            separator: options.separator,
            userName: options.userName
        });
        const result = await (0, importOrders_1.importOrdersFromFiles)({
            headerFilePath: options.headerPath,
            itemsFilePath: options.itemsPath,
            separator: options.separator,
            importedBy: options.userName
        });
        // 👇 Wrap summary in an object so it matches Record<string, unknown>
        (0, logger_1.logInfo)(ctx, 'Import via ordersService completed', {
            summary: result.summary
        });
        return result;
    }
    catch (err) {
        (0, logger_1.logError)(ctx, 'Import via ordersService failed', {
            error: err?.message || String(err)
        });
        throw err;
    }
}
