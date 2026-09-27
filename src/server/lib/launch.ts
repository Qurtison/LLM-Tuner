/*
 * Launch-resolution helpers (extracted from the legacy server):
 *  - toFiniteNumber / toNonEmptyString (pure coercion helpers)
 *  - buildLlamaArgs
 *  - resolveLaunchCommand
 *  - getLlamaServerBinary / isValidBuild / hostFromRpcTarget
 *
 * tokenizeCommand comes from ./tokenize. getLlamaServerBinary takes the
 * filtered builds list as an arg; the server owns the config-backed build
 * list and passes it in. rpcPort/defaultPort opts flow in from server config.
 */
import { tokenizeCommand } from './tokenize';
import { PARAM_BY_ID, type ParamDef } from '../../../shared/llama-params';
import type { BuildEntry, LaunchConfig, RouterModelConfig } from '../../../shared/contracts';
import {
    appendLaunchArgs,
    LAUNCH_BAG_ALIASES,
    toFiniteNumber,
    toNonEmptyString,
} from '../../../shared/launch-params';
import { isExplicitOff, offSpelling } from '../../../shared/flag-polarity';
import * as path from 'node:path';
import {
    argsToIniEntries,
    buildRouterArgs,
    buildRouterIni,
    buildRouterSections,
    isRouterMode,
    resolveModelsDir,
} from './router';

// The router's per-model list, if the config carries one. Read through the
// untrusted-input type: a preset is user JSON, so `models` arrives as whatever
// was on disk. Anything that is not an object with a usable modelPath is
// dropped by buildRouterSections.
function routerModels(config: LaunchInput): RouterModelConfig[] {
    const router = config.router as { models?: unknown } | undefined;
    if (!router || !Array.isArray(router.models)) return [];
    return router.models.filter((m): m is RouterModelConfig =>
        !!m && typeof m === 'object' && typeof (m as RouterModelConfig).modelPath === 'string');
}

// A hand-written preset INI from the launch config, if the user supplied one.
function routerIniText(config: LaunchInput): string | undefined {
    const router = config.router as { iniText?: unknown } | undefined;
    const raw = router?.iniText;
    // Blank means "not supplied", but a supplied preset is passed through
    // UNTRIMMED: the editor promises the text is used as written, and silently
    // reflowing someone's file is not its job.
    if (typeof raw !== 'string' || raw.trim() === '') return undefined;
    return raw;
}

// The INI derived from the launch config: the per-model knobs rendered once as
// args, then rewritten as INI entries. One code path decides what a preset
// means, so the two launch modes cannot drift apart.
function buildGeneratedRouterIni(config: LaunchInput, modelsDir: string, opts: { mapModelPath: (p: string) => string; deviceArgs: string[]; defaultPort?: number }): string {
    const modelArgs = buildLlamaArgs(config, { ...opts, router: true });
    const globalEntries = argsToIniEntries(modelArgs);
    return buildRouterIni(globalEntries, buildRouterSections(routerModels(config), modelsDir, globalEntries));
}
// The resolver treats the launch config as untrusted input: every field is
// coerced (toFiniteNumber/toNonEmptyString) before use. Keys are typed
// `unknown` (not LaunchConfig's own types) because user JSON and tests feed
// numbers where the contract says string (e.g. tensorSplit).
// (The index signature covers config fields the resolver reads that are not
// in the contract, e.g. topK/topP/minP from raw launch bodies.)
export type LaunchInput = { [K in keyof LaunchConfig]?: unknown } & Record<string, unknown>;

// Render param-id overrides (LaunchConfig.paramOverrides) into CLI flags.
// Toggle params emit just the flag; everything else emits 'flag value'
// (arrays join to comma lists). Unknown ids and empty values are skipped.
function appendParamOverrideArgs(args: string[], overrides: unknown): void {
    if (!overrides || typeof overrides !== 'object') return;
    const bag = overrides as Record<string, unknown>;
    for (const id of Object.keys(bag)) {
        const def: ParamDef | undefined = PARAM_BY_ID[id];
        const value = bag[id];
        if (!def || !Array.isArray(def.flags) || def.flags.length === 0) continue;
        if (value === undefined || value === null || value === '') continue;
        if (def.control === 'toggle') {
            if (value === true || value === 'true') { args.push(def.flags[0]); continue; }
            // An explicit false emits the disabling spelling, so an option that
            // defaults to enabled can actually be turned off. Unset/absent
            // still emits nothing and leaves llama-server's default alone.
            if (isExplicitOff(value)) {
                const off = offSpelling(def.flags);
                if (off) args.push(off);
            }
            continue;
        }
        const text = Array.isArray(value) ? value.map(String).join(',') : String(value);
        if (text.trim() === '') continue;
        args.push(def.flags[0], text);
    }
}

// The coercers moved to shared/launch-params.ts so the shared emission table
// and the server agree on what "set" means. Re-exported because callers
// (router.ts, index.ts, services/llama.ts) reach them through this module.
export { toFiniteNumber, toNonEmptyString };

// Legacy/mismatched presets may hold KNOWN params in the overrides bag
// (e.g. ctx_size instead of ctx). Promote them to real fields before the
// required-knob validation so `-c`/`-ngl` etc. render once, from fields.
// The alias table is the input contract and lives in shared/launch-params.ts,
// next to the field -> registry id map it has to agree with.
function promoteBagToFields(config: LaunchInput): LaunchInput {
    const bag = config.paramOverrides;
    if (!bag || typeof bag !== 'object') return config;
    const overrides = bag as Record<string, unknown>;
    const promoted: string[] = [];
    for (const [id, field] of Object.entries(LAUNCH_BAG_ALIASES)) {
        if (overrides[id] === undefined || config[field] !== undefined) continue;
        config[field] = overrides[id];
        promoted.push(id);
    }
    if (promoted.length > 0) {
        const next = { ...overrides };
        for (const id of promoted) delete next[id];
        if (Object.keys(next).length > 0) config.paramOverrides = next;
        else delete config.paramOverrides;
    }
    return config;
}

// Flags that llama.cpp accepts multiple times on purpose.
const REPEATABLE_FLAGS = new Set<string>(['-lora', '--lora', '--lora-scaled', '--header', '-H',
    // -m never dedupes: raw argString remap depends on the base -m surviving.
    '-m', '--model']);

// Alias map: every known flag -> its registry param id, so `-sm` and
// `--split-mode` dedupe to the same slot. Unknown flags dedupe literally.
let FLAG_TO_PARAM_ID: Map<string, string> | null = null;
function flagToParamId(flag: string): string | undefined {
    if (FLAG_TO_PARAM_ID === null) {
        FLAG_TO_PARAM_ID = new Map();
        for (const def of Object.values(PARAM_BY_ID)) {
            if (!Array.isArray(def.flags)) continue;
            for (const f of def.flags) FLAG_TO_PARAM_ID.set(f, def.id);
        }
    }
    return FLAG_TO_PARAM_ID.get(flag);
}

function looksLikeFlag(token: unknown): boolean {
    if (typeof token !== 'string' || !token.startsWith('-') || token === '-') return false;
    return !/^-\d+(\.\d+)?$/.test(token); // negative numbers are values
}

// Collapse duplicate flags (incl. short/long aliases of one param): the
// LAST occurrence wins, matching llama-server arg parsing. Value flags
// keep their value token; repeatable flags (-lora, --header, ...) keep
// every occurrence.
function dedupeFlags(args: string[]): string[] {
    const lastIndexOf = new Map<string, number>();
    for (let i = 0; i < args.length; i++) {
        if (!looksLikeFlag(args[i])) continue;
        if (REPEATABLE_FLAGS.has(args[i])) continue;
        const key = flagToParamId(args[i]) ?? args[i];
        lastIndexOf.set(key, i);
    }
    const out: string[] = [];
    let skipValue = false;
    for (let i = 0; i < args.length; i++) {
        const token = args[i];
        if (skipValue) { skipValue = false; continue; } // value of a dropped flag
        if (!looksLikeFlag(token)) { out.push(token); continue; }
        if (REPEATABLE_FLAGS.has(token)) {
            out.push(token);
            if (i + 1 < args.length && !looksLikeFlag(args[i + 1])) { out.push(args[i + 1]); i += 1; }
            continue;
        }
        const key = flagToParamId(token) ?? token;
        if (lastIndexOf.get(key) !== i) {
            // superseded by a later occurrence — swallow its value too
            if (i + 1 < args.length && !looksLikeFlag(args[i + 1])) skipValue = true;
            continue;
        }
        out.push(token);
        if (i + 1 < args.length && !looksLikeFlag(args[i + 1])) { out.push(args[i + 1]); i += 1; }
    }
    return out;
}

export function buildLlamaArgs(config: LaunchInput, { mapModelPath, deviceArgs, defaultPort = 8080, router = false }: { mapModelPath: (p: string) => string; deviceArgs: string[]; defaultPort?: number; router?: boolean }): string[] {
    config = promoteBagToFields(config);
    // Validate the required knobs up front so a malformed config fails with a
    // clear message instead of spawning `llama-server -m undefined -c NaN`
    // (a blank ctx/ngl field reaches us as NaN -> JSON null).
    //
    // Router mode is exempt: there is no single model to point -m at, and ctx/
    // ngl may legitimately live in the preset INI instead of the command line.
    // The knob values themselves are still coerced, so a blank field cannot
    // become a `-c NaN` further down.
    const modelPath = toNonEmptyString(config.modelPath);
    if (!modelPath && !router) throw new Error('modelPath is required');

    const ctx = toFiniteNumber(config.ctx);
    const ngl = toFiniteNumber(config.ngl);
    if (!router && (ctx === undefined || ngl === undefined)) {
        throw new Error('ctx and ngl must be numbers');
    }

    // Port: the UI has no port field today, but a raw command (or a future UI)
    // may set one -- and the /slots poll + CSV rows depend on this being real.
    // Default port comes from server config (llama.defaultPort); a per-launch
    // config.port or --port in a raw command still wins. In router mode the
    // port belongs to the router's own command line (buildRouterArgs), which
    // validates it.
    const port = toFiniteNumber(toNonEmptyString(config.port) || String(defaultPort));
    if (!router && (port === undefined || !Number.isInteger(port) || port < 1 || port > 65535)) {
        throw new Error('port must be an integer between 1 and 65535');
    }

    // Router mode: the same per-model knobs as a single-model launch, minus the
    // three arguments the router owns (-m, --host, --port). They become INI
    // entries via argsToIniEntries, so a preset means the same thing in both
    // modes.
    const args: string[] = [];
    if (!router) {
        args.push('-m', mapModelPath(modelPath as string));
    }
    if (ctx !== undefined) args.push('-c', String(ctx));
    if (ngl !== undefined) args.push('-ngl', String(ngl));
    if (!router) args.push('--host', '0.0.0.0', '--port', String(port));
    args.push('--metrics');

    // Every remaining knob is a row in shared/launch-params.ts, rendered in
    // table order. The two blocks the table deliberately does not cover are
    // written out here: the speculative-decoding expansion (one flag per
    // --spec-type token) and the device args injected by the caller.
    appendLaunchArgs(args, 'pre-spec', config);

    const specType = toNonEmptyString(config.specType);
    if (specType) {
        args.push('--spec-type', specType);
        const specDraftNMax = toFiniteNumber(config.specDraftNMax);
        args.push('--spec-draft-n-max', String(specDraftNMax !== undefined ? specDraftNMax : 2));
        const specDraftNMin = toFiniteNumber(config.specDraftNMin);
        if (specDraftNMin !== undefined) {
            args.push('--spec-draft-n-min', String(specDraftNMin));
        }
        const specDraftModel = toNonEmptyString(config.specDraftModel);
        if (specDraftModel) args.push('--spec-draft-model', specDraftModel);
        const ngramFlagStems: Record<string, string> = { 'ngram-simple': 'ngram-simple', 'ngram-map-k': 'ngram-map-k', 'ngram-map-k4v': 'ngram-map-k4v' };
        for (const type of specType.split(',').map(s => s.trim())) {
            const stem = ngramFlagStems[type];
            if (!stem) continue;
            const sizeN = toFiniteNumber(config.specNgramSizeN);
            if (sizeN !== undefined) args.push('--spec-' + stem + '-size-n', String(sizeN));
            const sizeM = toFiniteNumber(config.specNgramSizeM);
            if (sizeM !== undefined) args.push('--spec-' + stem + '-size-m', String(sizeM));
            const minHits = toFiniteNumber(config.specNgramMinHits);
            if (minHits !== undefined) args.push('--spec-' + stem + '-min-hits', String(minHits));
        }
        args.push('-np', '1');
    }

    appendLaunchArgs(args, 'post-spec', config);
    args.push(...deviceArgs);
    appendLaunchArgs(args, 'post-device', config);
    appendParamOverrideArgs(args, config.paramOverrides);
    const argString = toNonEmptyString(config.argString);
    if (argString) {
        const rawTokens = tokenizeCommand(argString.trim());
        for (let i = 0; i < rawTokens.length; i++) {
            const t = rawTokens[i];
            // Router mode never passes -m: that flag is exactly what selects
            // single-model mode. A leftover -m in a raw command is dropped
            // rather than silently downgrading the launch back to one model.
            if (router && (t === '-m' || t === '--model')) {
                if (i + 1 < rawTokens.length && !looksLikeFlag(rawTokens[i + 1])) i += 1;
                continue;
            }
            if (t === '-m' && i + 1 < rawTokens.length) {
                args.push('-m', mapModelPath(rawTokens[++i]));
            } else {
                args.push(t);
            }
        }
    }
    return dedupeFlags(args);
}

// Structural view of a build entry: only the path matters for validity
// (dashboard.config.json is user-editable, and a half-deleted entry must not
// corrupt the build list).
export type BuildLike = { id?: unknown; path?: unknown };

export function isValidBuild(b: BuildLike | null | undefined): boolean {
    return !!b && typeof b.path === 'string' && b.path.trim().length > 0;
}

// Resolves a build id to its binary path, falling back to the first
// configured build if the id is missing/unknown -- e.g. a saved profile or
// restored launch config from before builds existed (no `build` field at
// all), or a stale id left over after dashboard.config.json was edited to
// remove a build. `builds` is the filtered list to resolve against.
export function getLlamaServerBinary(builds: BuildEntry[], buildId?: string): string {
    if (!builds || builds.length === 0) {
        throw new Error('No valid llama-server builds configured');
    }
    const found = buildId ? builds.find(b => b.id === buildId) : null;
    return (found || builds[0]).path;
}

// Extract the bare hostname from an RPC/SSH target like "user@host:22" --
// the RPC port (50052) is appended separately, so a user-supplied :port must
// not survive ("host:22:50052" is not a valid RPC endpoint).
export function hostFromRpcTarget(target: string): string {
    const s = String(target || '').trim();
    const withoutUser = s.split('@').pop() || s;
    return withoutUser.split(':')[0];
}

// --- LAUNCH COMMAND RESOLUTION (structured config -> command + args) ---
// Shared by /api/preview-command (which only needs the resolved command/args
// to show the user, never spawns anything) and /api/start's fallback path
// (used when the raw-command box is empty).
//
// The master always launches natively (no Docker) -- a local device split
// (GPU A + GPU B) and an RPC worker are both optional add-ons on top of that,
// not separate launch mechanisms. They're mutually exclusive in practice:
// enabling RPC in the GUI forces GPU B back to "None", so at most one of
// localSplit/config.rpcTarget is ever true below -- this only supports a
// 2-way split (this machine vs. one other target), not a 3-way local-A +
// local-B + worker split.
// `-ts` takes a comma-separated list of proportions, one per device:
// '0.75,1.25', '3,1', ... The preset dock's `list` control stores that as
// an array, a legacy preset as a joined string, and the old dashboard slider
// as a single percentage (30 -> 30,70). All three reach us as `unknown`.
// A plain toFiniteNumber() only understood the last form: Number('0.75,1.25')
// is NaN, so the flag was silently dropped and the whole model landed on
// one device (OOM) with no hint in the preview string.
// Returns undefined for anything unusable, so the caller can skip `-ts`.
function parseTensorSplit(v: unknown): string | undefined {
    const parts = (Array.isArray(v) ? v.map(x => String(x)) : typeof v === 'string' ? v.split(',') : [v])
        .map(s => String(s).trim())
        .filter(s => s.length > 0);
    if (parts.length === 0) return undefined;
    const nums = parts.map(Number);
    if (nums.some(n => !Number.isFinite(n) || n < 0)) return undefined;
    // Legacy single value: GPU A's share in percent, the rest to GPU B.
    if (parts.length === 1) return nums[0] < 100 ? nums[0] + ',' + (100 - nums[0]) : undefined;
    return parts.join(',');
}

// Where the generated router INI lands. It sits beside launch.sh (the unit
// runs that script, and the preset path is absolute, so the two can't drift
// apart and a stale path in the command line can't outlive a moved file).
export const ROUTER_INI_FILENAME = 'router.ini';

export function routerIniPathFor(appRoot: string): string {
    return path.join(appRoot, 'generated', ROUTER_INI_FILENAME);
}

export function resolveLaunchCommand(config: LaunchInput, builds: BuildEntry[], { rpcPort = 50052, defaultPort = 8080, modelsDir = '', appRoot = process.cwd() }: { rpcPort?: number; defaultPort?: number; modelsDir?: string; appRoot?: string } = {}): { command: string; args: string[]; ini?: string } {
    const command = getLlamaServerBinary(builds, config.build as string | undefined);
    const mapModelPath = (p: string): string => p; // raw host path, no container mount to remap into
    const deviceArgs: string[] = [];
    const localSplit = !!(config.deviceA && config.deviceB && config.deviceA !== config.deviceB);
    const rpcTarget = toNonEmptyString(config.rpcTarget);
    if (localSplit || rpcTarget) {
        deviceArgs.push('--split-mode', 'layer');
        if (localSplit) deviceArgs.push('-dev', String(config.deviceA) + ',' + String(config.deviceB));
        if (rpcTarget) deviceArgs.push('--rpc', hostFromRpcTarget(rpcTarget) + ':' + rpcPort);
        const tensorSplit = parseTensorSplit(config.tensorSplit);
        if (tensorSplit !== undefined) deviceArgs.push('-ts', tensorSplit);
    }

    if (isRouterMode(config)) {
        const dir = resolveModelsDir(config, modelsDir);
        if (!dir) throw new Error('router mode needs a models directory (set paths.modelDirectories or router.modelsDir)');
        const presetPath = routerIniPathFor(appRoot);
        // A hand-written preset wins outright: it is the source of truth for
        // per-model settings, and merging generated entries back into it would
        // quietly reinstate the very values the user just deleted.
        const ini = routerIniText(config) ?? buildGeneratedRouterIni(config, dir, { mapModelPath, deviceArgs, defaultPort });
        return {
            command,
            args: buildRouterArgs(config, { modelsDir: dir, presetPath, defaultPort }),
            ini,
        };
    }

    const args = buildLlamaArgs(config, { mapModelPath, deviceArgs, defaultPort });
    return { command, args };
}
