/*
 * Splits `llama-server --help` output into {flags, description, section,
 * insertText, primaryFlag} entries.
 */

// Flag-reference parsing: description column is column-aligned at a fixed
// indent (verified against real output: 40 chars) rather than "first
// big gap after the flag names", which breaks on short/long alias pairs like
// "-c,    --ctx-size N".
export const HELP_DESC_COLUMN = 40;

export interface HelpFlagEntry {
    flags: string;
    description: string;
    section: string;
    insertText: string;
    primaryFlag: string;
}

export function parseHelpFlags(helpText: string): HelpFlagEntry[] {
    const lines = helpText.split('\n');
    const entries: HelpFlagEntry[] = [];
    let currentSection = 'general';
    for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, '');
        if (/^-{3,}.*-{3,}$/.test(line.trim())) {
            currentSection = line.trim().replace(/^-+\s*/, '').replace(/\s*-+$/, '');
            continue;
        }
        if (!line.trim()) continue;
        if (!/^\s/.test(line)) {
            const candidateFlagPart = line.slice(0, HELP_DESC_COLUMN);
            let flagPart: string;
            let descPart: string;
            if (candidateFlagPart.trimEnd().length < HELP_DESC_COLUMN) {
                flagPart = candidateFlagPart.trim();
                descPart = line.slice(HELP_DESC_COLUMN).trim();
            } else {
                flagPart = line.trim();
                descPart = '';
            }
            entries.push({ flags: flagPart, description: descPart, section: currentSection, insertText: '', primaryFlag: '' });
        } else if (entries.length > 0) {
            const last = entries[entries.length - 1];
            last.description = (last.description ? last.description + ' ' : '') + line.trim();
        }
    }
    for (const e of entries) {
        const flagTokens = e.flags.match(/--?[\w-]+/g) || [];
        const longForm = [...flagTokens].reverse().find(t => t.startsWith('--')) || flagTokens[flagTokens.length - 1] || '';
        const withoutFlags = e.flags.replace(/^(-{1,2}[\w-]+,?\s*)+/, '').trim();
        e.insertText = withoutFlags ? longForm + ' ' : longForm;
        e.primaryFlag = longForm;
    }
    return entries;
}
