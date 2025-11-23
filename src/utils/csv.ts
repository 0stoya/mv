// /var/www/middleware/src/utils/csv.ts
import fs from 'fs';

const CANDIDATES = [',', ';', '\t', '|'];

export function normaliseHeaderName(header: string | null | undefined): string {
  if (!header) return '';

  return header
    .replace(/^\uFEFF/, '') // strip BOM
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_'); // "File Order ID" -> "file_order_id"
}

export function detectDelimiter(path: string): string {
  const content = fs.readFileSync(path, 'utf8');
  const lines = content.split(/\r?\n/).filter(Boolean).slice(0, 5);

  if (!lines.length) return ','; // default

  let best = ',';
  let bestScore = -Infinity;

  for (const delim of CANDIDATES) {
    const counts = lines.map((l) => l.split(delim).length);
    const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
    const varSum = counts.reduce((a, c) => a + Math.pow(c - avg, 2), 0);
    const variance = varSum / counts.length;

    // Good delimiter: many columns, low variance
    const score = avg - variance;
    if (score > bestScore) {
      bestScore = score;
      best = delim;
    }
  }

  return best;
}

/**
 * Very simple CSV parser.
 * - Auto-splits by given delimiter
 * - Normalises header names
 * - Filters empty lines
 */
export function parseDelimitedFile(path: string, delimiter?: string): {
  headers: string[];
  rows: Record<string, string>[];
} {
  const content = fs.readFileSync(path, 'utf8');
  const lines = content.split(/\r?\n/).filter((l) => l.trim() !== '');

  if (!lines.length) {
    return { headers: [], rows: [] };
  }

  const delim = delimiter || detectDelimiter(path);

  const rawHeaderCols = lines[0].split(delim);
  const headers = rawHeaderCols.map((h) => normaliseHeaderName(h));

  const rows: Record<string, string>[] = [];

  for (const line of lines.slice(1)) {
    const cols = line.split(delim);
    if (!cols.some((c) => c.trim() !== '')) continue;

    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = cols[idx] ?? '';
    });
    rows.push(row);
  }

  return { headers, rows };
}
