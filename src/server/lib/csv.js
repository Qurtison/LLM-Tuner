/*
 * ponytail: verbatim extraction for Phase 1 tests; convert to TS in Phase 3.
 *
 * Extracted verbatim from server4.js CSV helpers (lines 903-980):
 *  - csvValue   (string sanitization, newlines stripped)
 *  - parseNumOrNull
 *  - csvQuote   (minimal CSV quoting)
 *  - splitCsvLine  (forward char-scan parser, double-quote aware)
 *
 * The schema auto-detection / column-indexing (cols.length >= 32 / 31 / 25)
 * lives in the /api/logs/recent and /api/logs/summary route handlers,
 * not here; this module only exposes the row-level parser.
 */
'use strict';

// Convert any CSV cell to a safe single-line string. Newlines inside a quoted
// field would break the line-based readers in /api/logs/recent and
// /api/logs/summary -- argString in particular comes from a UI textarea, so
// it can carry them. NaN/Infinity become '' (they can't be parsed back).
function csvValue(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number' && !Number.isFinite(v)) return '';
    return String(v).replace(/\r\n|\r|\n/g, ' ');
}

// Parse a CSV cell to a number or null -- unlike `parseFloat(x) || null`, a
// genuine 0 reading survives instead of collapsing to null.
function parseNumOrNull(s) {
    if (s === null || s === undefined) return null;
    const t = String(s).trim();
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
}

// Safely quote a CSV field -- wraps in double-quotes, escaping internal quotes
function csvQuote(val) {
    if (val === null || val === undefined) return '""';
    const s = String(val);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
}

// Minimal CSV parser that respects double-quoted fields with embedded commas
// -- shared by /api/logs/summary and /api/logs/recent.
// Single forward character scan -- the previous indexOf-based version could
// send its cursor BACKWARDS on a `""""` sequence (an escaped empty string
// inside a quoted field, e.g. configJson's `""argString""":""""`), re-parsing
// the same line in an infinite loop and OOMing the whole server on the first
// /api/logs/summary call after such a row existed in the CSV.
function splitCsvLine(line) {
    if (!line) return [];
    const cols = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (inQuotes) {
            if (c === '"') {
                if (line[i + 1] === '"') { field += '"'; i++; } // escaped quote
                else inQuotes = false; // closing quote
            } else field += c;
        } else if (c === '"' && field.length === 0) {
            inQuotes = true; // opening quote of a quoted field
        } else if (c === ',') {
            cols.push(field); field = '';
        } else field += c;
    }
    cols.push(field);
    return cols;
}

module.exports = {
    csvValue,
    parseNumOrNull,
    csvQuote,
    splitCsvLine,
};
