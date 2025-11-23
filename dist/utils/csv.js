"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.normaliseHeaderName = normaliseHeaderName;
exports.detectDelimiter = detectDelimiter;
exports.parseDelimitedFile = parseDelimitedFile;
// /var/www/middleware/src/utils/csv.ts
const fs_1 = __importDefault(require("fs"));
const CANDIDATES = [',', ';', '\t', '|'];
function normaliseHeaderName(header) {
    if (!header)
        return '';
    return header
        .replace(/^\uFEFF/, '') // strip BOM
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '_'); // "File Order ID" -> "file_order_id"
}
function detectDelimiter(path) {
    const content = fs_1.default.readFileSync(path, 'utf8');
    const lines = content.split(/\r?\n/).filter(Boolean).slice(0, 5);
    if (!lines.length)
        return ','; // default
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
function parseDelimitedFile(path, delimiter) {
    const content = fs_1.default.readFileSync(path, 'utf8');
    const lines = content.split(/\r?\n/).filter((l) => l.trim() !== '');
    if (!lines.length) {
        return { headers: [], rows: [] };
    }
    const delim = delimiter || detectDelimiter(path);
    const rawHeaderCols = lines[0].split(delim);
    const headers = rawHeaderCols.map((h) => normaliseHeaderName(h));
    const rows = [];
    for (const line of lines.slice(1)) {
        const cols = line.split(delim);
        if (!cols.some((c) => c.trim() !== ''))
            continue;
        const row = {};
        headers.forEach((h, idx) => {
            row[h] = cols[idx] ?? '';
        });
        rows.push(row);
    }
    return { headers, rows };
}
