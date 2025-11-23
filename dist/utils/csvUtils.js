"use strict";
// src/utils/csvUtils.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.normaliseHeaderName = normaliseHeaderName;
exports.detectDelimiter = detectDelimiter;
exports.parseCsvFile = parseCsvFile;
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
 * Very simple CSV reader:
 * - Uses provided separator or auto-detects with detectDelimiter()
 * - Normalises header names with normaliseHeaderName()
 * - Returns an array of { [normalisedHeader]: value }
 * NOTE: This is not a fully RFC-compliant CSV parser (no quoted commas handling),
 * but is fine for your current bulk-import files.
 */
async function parseCsvFile(path, separator) {
    const content = fs_1.default.readFileSync(path, 'utf8');
    const lines = content
        .split(/\r?\n/)
        // drop empty lines
        .filter((l) => l.trim() !== '');
    if (!lines.length) {
        return [];
    }
    const effectiveSeparator = separator || detectDelimiter(path);
    const rawHeaders = lines[0].split(effectiveSeparator);
    const headers = rawHeaders.map((h) => normaliseHeaderName(h));
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        const cells = line.split(effectiveSeparator);
        const row = {};
        for (let c = 0; c < headers.length; c++) {
            const key = headers[c] || `col_${c}`;
            row[key] = cells[c]?.trim() ?? '';
        }
        rows.push(row);
    }
    return rows;
}
