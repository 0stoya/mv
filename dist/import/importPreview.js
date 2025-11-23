"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.previewImportFromFiles = previewImportFromFiles;
// src/import/importPreview.ts
const path_1 = __importDefault(require("path"));
const csvUtils_1 = require("../utils/csvUtils");
const logger_1 = require("../utils/logger");
const importOrders_1 = require("./importOrders");
const validation_1 = require("./validation");
/**
 * Reads the same CSVs as the real import, but:
 * - does NOT touch DB
 * - validates SKUs + stock in Magento
 * - returns summary + issues for UI
 */
async function previewImportFromFiles(options) {
    const ctx = (0, logger_1.createContextId)('importPreview');
    const headerFilePath = path_1.default.resolve(options.headerFilePath);
    const itemsFilePath = path_1.default.resolve(options.itemsFilePath);
    const headerFilename = path_1.default.basename(headerFilePath);
    const itemsFilename = path_1.default.basename(itemsFilePath);
    const delimiter = options.separator || (0, csvUtils_1.detectDelimiter)(headerFilePath) || ',';
    (0, logger_1.logInfo)(ctx, 'Starting CSV preview read', {
        headerFilePath,
        itemsFilePath,
        delimiter,
        importedBy: options.importedBy ?? 'unknown'
    });
    const [rawHeaders, rawItems] = await Promise.all([
        (0, csvUtils_1.parseCsvFile)(headerFilePath, delimiter),
        (0, csvUtils_1.parseCsvFile)(itemsFilePath, delimiter)
    ]);
    (0, logger_1.logInfo)(ctx, 'CSV files loaded for preview', {
        headerRows: rawHeaders.length,
        itemRows: rawItems.length
    });
    const importRows = [];
    for (let index = 0; index < rawItems.length; index++) {
        const raw = rawItems[index];
        try {
            const item = (0, importOrders_1.parseItemRow)(raw);
            if (!item.sku || !item.qty_ordered) {
                (0, logger_1.logInfo)(ctx, 'Preview: skipping item with missing sku/qty', { raw });
                continue;
            }
            importRows.push({
                rowIndex: index + 2, // assuming header is line 1
                sku: item.sku,
                qty: item.qty_ordered,
                raw
            });
        }
        catch (err) {
            (0, logger_1.logInfo)(ctx, 'Preview: failed to parse item row; skipping', {
                error: String(err),
                raw
            });
        }
    }
    let issues = [];
    let validationOk = true;
    if (importRows.length > 0) {
        try {
            const validation = await (0, validation_1.validateImportRows)(importRows);
            validationOk = validation.ok;
            issues = validation.issues;
        }
        catch (err) {
            validationOk = false;
            (0, logger_1.logError)(ctx, 'Preview validation error', { error: String(err) });
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
