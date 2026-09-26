/*
 * Router-mode launch helpers.
 *
 * llama-server has two modes. Given `-m <file>` it is a plain single-model
 * server. Given `--models-dir` (and no -m) it is a ROUTER: it discovers GGUF
 * files, keeps several models addressable at once, and loads/unloads them on
 * demand. Clients that manage models themselves (pi's `/llama`, `/model`) only
 * work against the router, so a dashboard that wants to serve those needs to
 * launch in this mode.
 *
 * Two things make router mode more than "drop -m":
 *
 *  1. The router owns a handful of arguments (host, port, alias, the model
 *     path itself) and overwrites them per child instance. Everything else a
 *     model needs moves into a preset INI via `--models-preset`, whose keys
 *     are argument names without dashes.
 *  2. The INI is unforgiving. One unrecognized key aborts the whole router
 *     with `option '<key>' not recognized in preset '*'` before it serves
 *     anything, so keys are derived from the param registry (which is
 *     generated from `llama-server --help`) instead of being spelled by hand.
 *
 * The INI is emitted as a shared `[*]` block plus one section per model that
 * needs to deviate from it -- the same shape llama.cpp itself materializes.
 */
import * as path from 'node:path';
import { PARAM_BY_ID, type ParamDef } from '../../../shared/llama-params';
import type { LaunchInput, } from './launch';
import { toFiniteNumber, toNonEmptyString } from './launch';
import type { RouterConfig, RouterModelConfig } from '../../../shared/contracts';

// --- flag <-> INI key -------------------------------------------------------

let FLAG_TO_PARAM: Map<string, ParamDef> | null = null;
function flagToParam(flag: string): ParamDef | undefined {
    if (FLAG_TO_PARAM === null) {
        FLAG_TO_PARAM = new Map();
        for (const def of Object.values(PARAM_BY_ID)) {
            for (const f of def.flags) FLAG_TO_PARAM.set(f, def);
        }
    }
    return FLAG_TO_PARAM.get(flag);
}

// The INI key for a param is that param's first long flag minus the dashes:
// `no_reasoning_preserve` -> `reasoning-preserve`, `ctx_size` -> `ctx-size`,
// `cache_type_k_draft` -> `spec-draft-type-k`. Deriving the key from a real
// flag (rather than reshaping the id) keeps it in the set the binary accepts;
// the registry is generated from `--help`, so it cannot drift.
function longFlagOf(def: ParamDef): string | undefined {
    return def.flags.find(f => f.startsWith('--'));
}

export function iniKeyForFlag(flag: string): string | undefined {
    const def = flagToParam(flag);
    if (!def) return undefined;
    const long = longFlagOf(def);
    return long ? long.slice(2) : undefined;
}

export function iniKeyForParamId(id: string): string | undefined {
    const def = PARAM_BY_ID[id];
    if (!def) return undefined;
    const long = longFlagOf(def);
    return long ? long.slice(2) : undefined;
}

// Arguments the router sets on every child instance itself, so writing them to
// the INI is either rejected or silently overwritten. `model`/`mmproj` are
// resolved per discovered model; the router passes its own host/port (the
// child binds an ephemeral port behind the router's proxy).
const ROUTER_CONTROLLED_PARAMS = new Set([
    'host', 'port', 'api_key', 'alias', 'model', 'mmproj',
    'models_dir', 'models_preset', 'models_max', 'no_models_autoload',
]);

export type IniEntry = { key: string; value: string };

function looksLikeFlag(token: unknown): boolean {
    if (typeof token !== 'string' || !token.startsWith('-') || token === '-') return false;
    return !/^-\d+(\.\d+)?$/.test(token); // negative numbers are values
}

// Format a paramOverrides value the way the CLI renderer does: toggles become
// the bare flag (so `true`), arrays join with commas, everything else stringifies.
function formatOverrideValue(def: ParamDef, value: unknown): string | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (def.control === 'toggle') return value === true || value === 'true' ? 'true' : 'false';
    const text = Array.isArray(value) ? value.map(String).join(',') : String(value);
    return text.trim() === '' ? undefined : text;
}

// paramOverrides bag -> INI entries, skipping unknown ids (an unknown key
// would take the router down) and router-controlled params.
export function overridesToIniEntries(overrides: unknown): IniEntry[] {
    if (!overrides || typeof overrides !== 'object') return [];
    const bag = overrides as Record<string, unknown>;
    const out: IniEntry[] = [];
    for (const id of Object.keys(bag).sort()) {
        if (id.startsWith('no_') === false && ROUTER_CONTROLLED_PARAMS.has(id)) continue;
        const def = PARAM_BY_ID[id];
        if (!def) continue;
        if (ROUTER_CONTROLLED_PARAMS.has(id)) continue;
        const key = iniKeyForParamId(id);
        if (!key) continue;
        const value = formatOverrideValue(def, bag[id]);
        if (value === undefined) continue;
        out.push({ key, value });
    }
    return out;
}

// Render already-resolved CLI args into INI entries. Reusing the arg list the
// single-model path produced is what keeps the two modes from drifting: the
// same preset yields the same knobs either way, just spelled as an INI.
//
// A flag with no value token is a boolean toggle -> `true`; `--no-x` becomes
// `x = false` so the positive key is always what lands in the file. Unknown
// flags are dropped (they cannot be validated against the router) and
// duplicates collapse to the last occurrence, matching llama.cpp's own
// last-wins arg parsing -- two aliases for one param in a single section
// silently keep the later one.
export function argsToIniEntries(args: string[]): IniEntry[] {
    const byKey = new Map<string, string>();
    const order: string[] = [];
    for (let i = 0; i < args.length; i++) {
        const token = args[i];
        if (!looksLikeFlag(token)) continue;
        const def = flagToParam(token);
        if (!def) continue;
        if (ROUTER_CONTROLLED_PARAMS.has(def.id)) continue;
        const resolved = iniKeyForFlag(token);
        if (!resolved) continue;
        let key = resolved;
        let value: string;
        const next = args[i + 1];
        if (def.control === 'toggle' && (next === undefined || looksLikeFlag(next))) {
            value = 'true';
        } else if (next !== undefined && !looksLikeFlag(next)) {
            value = next;
            i += 1;
        } else {
            value = 'true';
        }
        if (key.startsWith('no-')) { key = key.slice(3); value = 'false'; }
        if (!byKey.has(key)) order.push(key);
        byKey.set(key, value);
    }
    return order.map(key => ({ key, value: byKey.get(key) as string }));
}

// --- model ids --------------------------------------------------------------

// The id the router reports for a discovered model, which is also the key a
// preset section must be named to match it. Verified against a live router:
//   models/llama-3.2-1b-Q4_K_M.gguf          -> llama-3.2-1b-Q4_K_M
//   models/qwen-3-8b-Q4_K_M.gguf             -> qwen-3-8b-Q4_K_M
//   models/gemma-3-4b-it-Q8_0/gemma-3-4b...   -> gemma-3-4b-it-Q8_0
// i.e. the path relative to models-dir, without the .gguf suffix, collapsed to
// its first segment.
//
// Collapsing matters: naming a section after the .gguf INSIDE a model
// directory makes the router list that file as a second, separate model, so
// the same weights appear twice in /models and in pi's model picker.
export function routerModelId(modelPath: string, modelsDir: string): string {
    const abs = path.resolve(modelPath);
    const root = path.resolve(modelsDir);
    const rel = path.relative(root, abs);
    const outsideRoot = rel === '' || rel.startsWith('..') || path.isAbsolute(rel);
    const cleaned = (outsideRoot ? path.basename(abs) : rel).replace(/\.gguf$/i, '');
    return cleaned.split('/')[0];
}

function isGruf(modelPath: string): boolean {
    return /\.gguf$/i.test(modelPath);
}

// --- INI rendering ----------------------------------------------------------

export type RouterSection = { id: string; lines: IniEntry[] };

// `version = 1`, the shared `[*]` block, then only the sections that differ
// from it. A model configured with nothing but `load-on-startup` still needs
// its own section; the flag is not a command-line argument and has no `[*]`
// equivalent.
export function buildRouterIni(globalEntries: IniEntry[], sections: RouterSection[]): string {
    const lines: string[] = ['version = 1'];
    if (globalEntries.length > 0) {
        lines.push('', '[*]');
        for (const e of globalEntries) lines.push(`${e.key} = ${e.value}`);
    }
    for (const section of sections) {
        lines.push('', `[${section.id}]`);
        for (const e of section.lines) lines.push(`${e.key} = ${e.value}`);
    }
    return `${lines.join('\n')}\n`;
}

function modelSection(model: RouterModelConfig, modelsDir: string, globalEntries: IniEntry[]): RouterSection | null {
    const modelPath = toNonEmptyString(model.modelPath);
    if (!modelPath) return null;
    const id = routerModelId(modelPath, modelsDir);
    const lines: IniEntry[] = [];

    // Only needed when the path is outside models-dir: then no discovered
    // model matches the section name, and the README requires the preset to
    // name the model itself. Inside the dir the router already knows it, and
    // a redundant `model =` line would pin a directory entry to one shard.
    const abs = path.resolve(modelPath);
    const rel = path.relative(path.resolve(modelsDir), abs);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
        if (isGruf(abs)) lines.push({ key: 'model', value: abs });
    }

    const loadOnStartup = model.loadOnStartup;
    if (loadOnStartup !== undefined) {
        lines.push({ key: 'load-on-startup', value: loadOnStartup ? 'true' : 'false' });
    }

    const ctx = toFiniteNumber(model.ctx);
    if (ctx !== undefined) lines.push({ key: iniKeyForParamId('ctx_size') as string, value: String(ctx) });

    for (const entry of overridesToIniEntries(model.paramOverrides)) {
        lines.push(entry);
    }

    // Nothing that differs from the shared block? Then the section only earns
    // its place when it carries load-on-startup, which has no global form.
    const globalKeys = new Set(globalEntries.map(e => e.key));
    const effective = lines.filter(e => e.key === 'load-on-startup' || !globalKeys.has(e.key) || globalEntries.find(g => g.key === e.key)?.value !== e.value);
    if (effective.length === 0) return null;
    return { id, lines: effective };
}

export function buildRouterSections(models: RouterModelConfig[] | undefined, modelsDir: string, globalEntries: IniEntry[]): RouterSection[] {
    if (!models) return [];
    const out: RouterSection[] = [];
    for (const model of models) {
        const section = modelSection(model, modelsDir, globalEntries);
        if (section) out.push(section);
    }
    return out;
}

// --- launch args ------------------------------------------------------------

export function isRouterMode(config: LaunchInput): boolean {
    const router = config.router as RouterConfig | undefined;
    return !!router && router.enabled === true;
}

export function resolveModelsDir(config: LaunchInput, defaultModelsDir: string): string {
    const router = (config.router || {}) as RouterConfig;
    return toNonEmptyString(router.modelsDir) || defaultModelsDir;
}

// The router's own command line. Only what the router itself must be told:
// where to look, which INI to read, how many models may be resident, and how
// to reach the outside world. Per-model tuning belongs in the INI.
export function buildRouterArgs(config: LaunchInput, opts: {
    modelsDir: string;
    presetPath: string;
    defaultPort?: number;
    host?: string;
}): string[] {
    const router = (config.router || {}) as RouterConfig;
    const port = toFiniteNumber(toNonEmptyString(config.port) || String(opts.defaultPort ?? 8080));
    if (port === undefined || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('port must be an integer between 1 and 65535');
    }
    const args: string[] = [
        '--models-dir', opts.modelsDir,
        '--models-preset', opts.presetPath,
        '--host', opts.host || '0.0.0.0',
        '--port', String(port),
        '--metrics',
    ];
    // --models-max caps how many models stay resident at once. llama-server
    // defaults to 4, which is a bad default here: a models directory holds a
    // whole library (often several 27Bs), and the router keeps loaded models
    // warm. Four resident models is an OOM that takes down a server that was
    // working, so the dashboard caps at 1 unless the launch says otherwise.
    // 0 (unlimited) is still honoured when explicitly requested.
    const maxModels = toFiniteNumber(router.maxModels);
    args.push('--models-max', String(maxModels !== undefined && maxModels >= 0 ? maxModels : 1));
    // Router autoload on (the default) means a request naming a model loads it;
    // off means a model must be loaded explicitly first.
    if (router.autoload === false) args.push('--no-models-autoload');
    return args;
}
