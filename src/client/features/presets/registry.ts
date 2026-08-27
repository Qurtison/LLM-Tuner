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
import { PARAM_BY_ID, type ParamDef } from '../../../../shared/llama-params';
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
};

export interface OverrideEntry {
    field: keyof LaunchConfig;
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

export function paramForField(field: keyof LaunchConfig): ParamDef | undefined {
    const id = LAUNCH_FIELD_TO_PARAM[field];
    return id ? PARAM_BY_ID[id] : undefined;
}

export function overridesFromConfig(config: LaunchConfig | null | undefined): OverrideEntry[] {
    if (!config) return [];
    const out: OverrideEntry[] = [];
    for (const field of Object.keys(LAUNCH_FIELD_TO_PARAM) as (keyof LaunchConfig)[]) {
        const value = config[field];
        if (isUnset(value)) continue;
        const def = paramForField(field);
        if (!def) continue;
        if (def.default !== undefined && deepEqual(value, def.default)) continue;
        out.push({ field, paramId: def.id, def, value });
    }
    return out;
}

export function configWithOverrides(overrides: Record<keyof LaunchConfig, unknown>): LaunchConfig {
    const out: LaunchConfig = {};
    for (const [field, value] of Object.entries(overrides)) {
        if (isUnset(value)) continue;
        const def = paramForField(field as keyof LaunchConfig);
        if (def && def.default !== undefined && deepEqual(value, def.default)) continue;
        (out as Record<string, unknown>)[field] = value;
    }
    return out;
}
