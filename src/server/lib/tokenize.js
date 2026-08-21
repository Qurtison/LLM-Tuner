/*
 * ponytail: verbatim extraction for Phase 1 tests; convert to TS in Phase 3.
 *
 * Extracted verbatim from server4.js `tokenizeCommand` (lines 589-608).
 * Behavior: minimal shell-lite tokenizer. Splits on whitespace, respecting
 * single/double-quoted spans. NO escape-sequence support (so backslashes
 * are passed through literally and `a"b c"d` collapses to `ab cd`).
 */
'use strict';

// --- TOKENIZATION ---
// Minimal shell-lite tokenizer for the raw-command box: splits on whitespace,
// respecting single/double-quoted spans (no escape-sequence support -- good
// enough for llama-server flags and JSON args like --chat-template-kwargs
// `{"preserve_thinking": true}`, which is the actual case this needs to handle).
function tokenizeCommand(str) {
    const tokens = [];
    let current = '';
    let quoteChar = null;
    for (let i = 0; i < str.length; i++) {
        const c = str[i];
        if (quoteChar) {
            if (c === quoteChar) quoteChar = null;
            else current += c;
        } else if (c === '"' || c === "'") {
            quoteChar = c;
        } else if (/\s/.test(c)) {
            if (current.length > 0) { tokens.push(current); current = ''; }
        } else {
            current += c;
        }
    }
    if (current.length > 0) tokens.push(current);
    return tokens;
}

// Last occurrence of `flag`'s value (the FOLLOWING token) in a token array --
// later flags override earlier ones, same as the shell / llama-server do.
function extractLastFlagValue(tokens, flag) {
    for (let i = tokens.length - 1; i >= 0; i--) {
        if (tokens[i] === flag && i + 1 < tokens.length) return tokens[i + 1];
    }
    return undefined;
}

module.exports = { tokenizeCommand, extractLastFlagValue };
