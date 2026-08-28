/*
 * Minimal shell-lite tokenizer for the raw-command box: splits on whitespace,
 * respecting single/double-quoted spans (no escape-sequence support -- good
 * enough for llama-server flags and JSON args like --chat-template-kwargs
 * `{"preserve_thinking": true}`, which is the actual case this needs to handle).
 */

export function tokenizeCommand(str: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let quoteChar: string | null = null;
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
export function extractLastFlagValue(tokens: string[], flag: string): string | undefined {
    for (let i = tokens.length - 1; i >= 0; i--) {
        if (tokens[i] === flag && i + 1 < tokens.length) return tokens[i + 1];
    }
    return undefined;
}
