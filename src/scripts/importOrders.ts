// src/scripts/importOrders.ts
import 'dotenv/config';
import path from 'path';
import { detectDelimiter } from '../utils/csvUtils';
import { createContextId, logInfo, logError } from '../utils/logger';
import { importOrdersFromFiles } from '../import/importOrders';
import { db } from '../db/knex'; // 👈 add this

interface CliOptions {
  headerPath: string;
  itemsPath: string;
  userName: string;
  separator?: string;
}

function parseCliArgs(argv: string[]): CliOptions {
  const args = [...argv];

  if (args.length < 3) {
    console.error(
      [
        'Usage:',
        '  npm run import:orders -- <headers.csv> <items.csv> --user-name "<name>" [--separator ","]',
        '',
        'Examples:',
        '  npm run import:orders -- header.csv items.csv --user-name "Alice"',
        '  npm run import:orders -- header.csv items.csv --user-name "Bob" --separator ";"'
      ].join('\n')
    );
    process.exit(1);
  }

  const headerPath = path.resolve(args[0]);
  const itemsPath = path.resolve(args[1]);

  let userName: string | undefined;
  let separator: string | undefined;

  for (let i = 2; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--user-name') {
      userName = args[i + 1];
      i++;
    } else if (arg === '--separator') {
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
  const ctx = createContextId('importOrdersCLI');

  try {
    const [, , ...argv] = process.argv;
    const options = parseCliArgs(argv);

    const separator =
      options.separator || detectDelimiter(options.headerPath) || ',';

    logInfo(ctx, 'Starting order import CLI', {
      headerPath: options.headerPath,
      itemsPath: options.itemsPath,
      separator,
      importedBy: options.userName
    });

    const result = await importOrdersFromFiles({
      headerFilePath: options.headerPath,
      itemsFilePath: options.itemsPath,
      separator,
      importedBy: options.userName
    });

    logInfo(ctx, 'Order import completed', { summary: result.summary });

    if (result.failures.length) {
      logError(ctx, 'Some orders failed to import', {
        failedCount: result.failures.length
      });
      // non-zero exit to signal partial failure to CI/shell
      process.exitCode = 2;
    }
  } catch (err: any) {
    logError(ctx, 'Fatal error during order import', { error: String(err) });
    process.exitCode = 1;
  }
}

// 👇 Ensure we always close the Knex pool so Node can exit
main()
  .finally(async () => {
    try {
      await db.destroy();
    } catch {
      // ignore errors while closing pool
    }
  });
