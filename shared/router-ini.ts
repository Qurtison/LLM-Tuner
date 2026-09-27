/*
 * Validation for a router model preset INI (`--models-preset`).
 *
 * Lives in shared/ because both sides need it: the server checks a preset
 * before writing it to disk, and the client checks it as the user types so a
 * typo is visible before a launch rather than after one.
 *
 * This is not ordinary config validation. llama-server reads the preset while
 * starting the router, and ONE unrecognized key aborts the whole thing before
 * it serves anything:
 *
 *   E llama_server: failed to initialize router models:
 *     option 'this-is-not-a-real-key' not recognized in preset '*'
 *
 * So a typo is not a degraded launch, it is a dead server. Keys are therefore
 * checked against the param registry (generated from `llama-server --help`)
 * rather than a hand-kept list, and the rule for what a key may be is the same
 * one the generator writes by: a param's first long flag without its dashes.
 */
import { PARAM_BY_ID, type ParamDef } from './llama-params';
import type { IniWarning } from './contracts';

// Preset-file keys that are not command-line arguments.
const PRESET_ONLY_KEYS = new Set([
    'version', 'load-on-startup', 'stop-timeout', 'dedup-cache-models',
]);

// Arguments the router sets on every child instance itself. Accepted as keys
// (the router does not reject them) and then silently overwritten, which is its
// own trap: the value reads as applied and is not. Worth saying out loud.
const ROUTER_CONTROLLED_KEYS = new Set([
    'host', 'port', 'api-key', 'alias', 'model', 'mmproj',
    'models-dir', 'models-preset', 'models-max', 'models-autoload',
]);

function firstLongFlag(def: ParamDef): string | undefined {
    return def.flags.find(f => f.startsWith('--'));
}

let KNOWN: Set<string> | null = null;
function knownIniKeys(): Set<string> {
    if (KNOWN) return KNOWN;
    const keys = new Set<string>(PRESET_ONLY_KEYS);
    for (const def of Object.values(PARAM_BY_ID)) {
        const long = firstLongFlag(def);
        if (long) keys.add(long.slice(2));
        // A negative form is accepted as a key too and normalizes to the
        // positive one (the router rewrites `no-x = true` into `x = false`).
        for (const f of def.flags) {
            if (f.startsWith('--no-')) keys.add(f.slice(5));
        }
    }
    KNOWN = keys;
    return keys;
}

export function isKnownIniKey(key: string): boolean {
    return knownIniKeys().has(key);
}

// Report every problem in a preset, each with the line it sits on so the
// editor can point at it. Unparseable lines are reported too: a stray word
// where a key belongs is a hard failure at startup, not something to ignore.
export function validateRouterIni(text: string): IniWarning[] {
    const known = knownIniKeys();
    const warnings: IniWarning[] = [];
    const lines = String(text ?? '').split('\n');
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i].trim();
        if (raw === '' || raw.startsWith(';') || raw.startsWith('#') || raw.startsWith('[')) continue;
        const eq = raw.indexOf('=');
        if (eq < 0) {
            warnings.push({ line: i + 1, key: raw, message: 'is not a `key = value` line' });
            continue;
        }
        // Tolerate the shapes people actually type: `ctx_size`, `CTX-SIZE`.
        const key = raw.slice(0, eq).trim().replace(/_/g, '-').toLowerCase();
        if (key === '') continue;
        // Checked BEFORE the known-key test: host, port, alias and the models-*
        // keys are real llama flags, so they are also in the registry and would
        // otherwise pass as fine. The router accepts and then overwrites them.
        if (ROUTER_CONTROLLED_KEYS.has(key)) {
            warnings.push({ line: i + 1, key, message: 'is set by the router and will be overwritten — change it on the command line instead' });
            continue;
        }
        if (known.has(key)) continue;
        warnings.push({ line: i + 1, key, message: 'is not a llama-server option; the router will refuse to start' });
    }
    return warnings;
}
