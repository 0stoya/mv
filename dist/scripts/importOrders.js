"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/scripts/importOrders.ts
require("dotenv/config");
const path_1 = __importDefault(require("path"));
const csvUtils_1 = require("../utils/csvUtils");
const logger_1 = require("../utils/logger");
const importOrders_1 = require("../import/importOrders");
const knex_1 = require("../db/knex"); // 👈 add this
function parseCliArgs(argv) {
    const args = [...argv];
    if (args.length < 3) {
        console.error([
            'Usage:',
            '  npm run import:orders -- <headers.csv> <items.csv> --user-name "<name>" [--separator ","]',
            '',
            'Examples:',
            '  npm run import:orders -- header.csv items.csv --user-name "Alice"',
            '  npm run import:orders -- header.csv items.csv --user-name "Bob" --separator ";"'
        ].join('\n'));
        process.exit(1);
    }
    const headerPath = path_1.default.resolve(args[0]);
    const itemsPath = path_1.default.resolve(args[1]);
    let userName;
    let separator;
    for (let i = 2; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--user-name') {
            userName = args[i + 1];
            i++;
        }
        else if (arg === '--separator') {
            separator = args[i + 1];
            i++;
        }
    }
    if (!userName) {
        console.error('--user-name is required');
        process.exit(1);
    }
    return { headerPath, itemsPath, userName, separator };
}
async function main() {
    const ctx = (0, logger_1.createContextId)('importOrdersCLI');
    try {
        const [, , ...argv] = process.argv;
        const options = parseCliArgs(argv);
        const separator = options.separator || (0, csvUtils_1.detectDelimiter)(options.headerPath) || ',';
        (0, logger_1.logInfo)(ctx, 'Starting order import CLI', {
            headerPath: options.headerPath,
            itemsPath: options.itemsPath,
            separator,
            importedBy: options.userName
        });
        const result = await (0, importOrders_1.importOrdersFromFiles)({
            headerFilePath: options.headerPath,
            itemsFilePath: options.itemsPath,
            separator,
            importedBy: options.userName
        });
        (0, logger_1.logInfo)(ctx, 'Order import completed', { summary: result.summary });
        if (result.failures.length) {
            (0, logger_1.logError)(ctx, 'Some orders failed to import', {
                failedCount: result.failures.length
            });
            // non-zero exit to signal partial failure to CI/shell
            process.exitCode = 2;
        }
    }
    catch (err) {
        (0, logger_1.logError)(ctx, 'Fatal error during order import', { error: String(err) });
        process.exitCode = 1;
    }
}
// 👇 Ensure we always close the Knex pool so Node can exit
main()
    .finally(async () => {
    try {
        await knex_1.db.destroy();
    }
    catch {
        // ignore errors while closing pool
    }
});
