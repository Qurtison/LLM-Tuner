/*
 * Bridge between the frozen `LaunchConfig` (shared/contracts.ts) and the
 * llama.cpp parameter registry (shared/llama-params.ts). Drives the
 * "preset is a diff" invariant: a Preset only stores LaunchConfig keys
 * that differ from the registry default. Setting a value back to its
 * default deletes the key, so an empty preset means "running defaults".
 *
 * ponytail: only fields we can confidently map to a ParamDef are wired
 * here. Bench-only fields (nPrompt, nGen, depths, reps), passthrough
 * strings (argString, extraArgs, rawCommand, rawArgs, rpcTarget,
 * deviceA, deviceB, transport, label) and the spec draft NGL are
 * intentionally skipped from the diff — they stay in LaunchConfig but
 * don't get a "changed from default" badge. Add to LAUNCH_FIELD_TO_PARAM
 * when the registry grows a matching id.
 */
import { PARAM_BY_ID, type ParamDef, type ParamGroup } from '../../../../shared/llama-params';
import type { LaunchConfig } from '../../../../shared/contracts';

export type ParamId = string;

const LAUNCH_FIELD_TO_PARAM: Record<keyof LaunchConfig, ParamId | undefined> = {
    modelPath: 'model',
    model: 'model',
    ctx: 'ctx_size',
    ngl: 'n_gpu_layers',
    port: 'port',
    build: undefined,
    rawCommand: undefined,
    rawArgs: undefined,
    rpcTarget: undefined,
    fa: 'flash_attn',
    cacheK: 'cache_type_k',
    cacheV: 'cache_type_v',
    nPrompt: undefined,
    nGen: undefined,
    depths: undefined,
    reps: undefined,
    devices: 'device',
    splitMode: 'split_mode',
    tensorSplit: 'tensor_split',
    extraArgs: undefined,
    specType: 'spec_type',
    specDraftNMax: 'spec_n_max',
    specDraftNMin: 'spec_n_min',
    specDraftModel: 'model',
    specNgramSizeN: 'spec_ngram_size_n',
    specNgramSizeM: 'spec_ngram_size_m',
    specNgramMinHits: 'spec_ngram_min_hits',
    specDraftNgl: undefined,
    preserveThinking: 'reasoning_preserve',
    reasoningPreserve: 'reasoning_preserve',
    chatTemplateFile: 'chat_template',
    jinja: 'jinja',
    loadMode: 'load_mode',
    verbosity: 'verbosity',
    argString: undefined,
    temp: 'temperature',
    deviceA: undefined,
    deviceB: undefined,
    transport: undefined,
    label: undefined,
    paramOverrides: undefined,
};

export interface OverrideEntry {
    field: keyof LaunchConfig | null;
    paramId: ParamId;
    def: ParamDef;
    value: unknown;
}

function isUnset(v: unknown): boolean {
    return v === undefined || v === null || v === '';
}

function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a == null || b == null) return false;
    if (typeof a !== typeof b) return false;
    if (typeof a !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
        return true;
    }
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao);
    const bk = Object.keys(bo);
    if (ak.length !== bk.length) return false;
    for (const k of ak) if (!deepEqual(ao[k], bo[k])) return false;
    return true;
}

// Reverse lookup: which LaunchConfig field backs a param id. Fixed
// precedence (modelPath before model before specDraftModel, etc.).
const PARAM_TO_FIELD = new Map<ParamId, keyof LaunchConfig>();
for (const field of Object.keys(LAUNCH_FIELD_TO_PARAM) as (keyof LaunchConfig)[]) {
    const id = LAUNCH_FIELD_TO_PARAM[field];
    if (id !== undefined && !PARAM_TO_FIELD.has(id)) PARAM_TO_FIELD.set(id, field);
}

export function fieldForParamId(id: ParamId): keyof LaunchConfig | null {
    return PARAM_TO_FIELD.get(id) ?? null;
}

export function paramForField(field: keyof LaunchConfig): ParamDef | undefined {
    const id = LAUNCH_FIELD_TO_PARAM[field];
    return id ? PARAM_BY_ID[id] : undefined;
}

export function overridesFromConfig(config: LaunchConfig | null | undefined): OverrideEntry[] {
    if (!config) return [];
    const out: OverrideEntry[] = [];
    const emitted = new Set<ParamId>();
    for (const field of Object.keys(LAUNCH_FIELD_TO_PARAM) as (keyof LaunchConfig)[]) {
        const value = config[field];
        if (isUnset(value)) continue;
        const def = paramForField(field);
        if (!def) continue;
        if (def.default !== undefined && deepEqual(value, def.default)) continue;
        // Two fields can map to one param id (preserveThinking and
        // reasoningPreserve both -> reasoning_preserve); emit one row for the
        // first mapped field, same precedence PARAM_TO_FIELD uses.
        if (emitted.has(def.id)) continue;
        emitted.add(def.id);
        out.push({ field, paramId: def.id, def, value });
    }
    // Registry params with no dedicated field — the paramOverrides bag.
    const bag = config.paramOverrides;
    if (bag) {
        for (const id of Object.keys(bag)) {
            if (emitted.has(id)) continue;
            const value = bag[id];
            if (isUnset(value)) continue;
            const def = PARAM_BY_ID[id];
            if (!def) continue;
            if (def.default !== undefined && deepEqual(value, def.default)) continue;
            out.push({ field: null, paramId: id, def, value });
        }
    }
    return out;
}

export function configWithOverrides(overrides: Partial<Record<keyof LaunchConfig, unknown>>): LaunchConfig {
    const out: LaunchConfig = {};
    const bag = overrides.paramOverrides;
    for (const [field, value] of Object.entries(overrides)) {
        if (field === 'paramOverrides') continue;
        if (isUnset(value)) continue;
        const def = paramForField(field as keyof LaunchConfig);
        if (def && def.default !== undefined && deepEqual(value, def.default)) continue;
        (out as Record<string, unknown>)[field] = value;
    }
    if (bag && typeof bag === 'object') {
        const clean: Record<string, unknown> = {};
        for (const [id, value] of Object.entries(bag)) {
            if (isUnset(value)) continue;
            const def: ParamDef | undefined = PARAM_BY_ID[id];
            if (def && def.default !== undefined && deepEqual(value, def.default)) continue;
            clean[id] = value;
        }
        if (Object.keys(clean).length > 0) out.paramOverrides = clean;
    }
    return out;
}

export function paramDefById(id: ParamId): ParamDef | undefined {
    return PARAM_BY_ID[id];
}

// Int fields must receive integers: reject (never truncate) decimals and
// non-numeric text, so a typo can't silently save 0 or a string flag value.
// '' is valid here — empty input means "reset", handled by the caller.
export function intInputValid(raw: string): boolean {
    if (raw.trim() === '') return true;
    return Number.isInteger(Number(raw));
}

// Same gate for float commits: '1.2.3' would otherwise persist a raw string
// into the preset config (the poison class 31588f2 fixed for ints).
export function numericInputValid(control: string, raw: string): boolean {
    if (control === 'int') return intInputValid(raw);
    if (control === 'float') return raw.trim() === '' || Number.isFinite(Number(raw));
    return true;
}

// Shared group labels for PresetDock + PresetBrowserDialog (was copy-pasted).
export const GROUP_LABELS: Record<ParamGroup, string> = {
    speed: 'Speed & threads',
    memory: 'Memory & VRAM',
    context: 'Context & caching',
    sampling: 'Output & sampling',
    model: 'Model & source',
    devices: 'Devices & GPUs',
    speculative: 'Speculative decoding',
    server: 'Server & network',
    agents: 'Agents & tools',
    multimodal: 'Multimodal & embeddings',
    chat: 'Chat & reasoning',
    logging: 'Logging & debug',
    archive: 'Archive',
};