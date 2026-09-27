/*
 * The one place that knows how a LaunchConfig field becomes a llama-server
 * flag. Both sides import it: the client to label/preset a field, the server
 * to render it. Nothing else may hand-write a flag spelling.
 *
 * Three lookups live here, and they are not the same lookup:
 *
 *   LAUNCH_FIELD_TO_PARAM  field -> registry id. For reading a ParamDef
 *                          (label, control, group, default) off a field, so
 *                          every id MUST exist in PARAM_BY_ID. The check below
 *                          enforces that, and tests/launch-params.test.ts holds it
 *                          in place: that guard is what catches a renamed upstream
 *                          param instead of letting a field silently lose its
 *                          metadata in the preset editor.
 *
 *   LAUNCH_BAG_ALIASES     paramOverrides key -> field. This is the *input*
 *                          contract: which bag keys get promoted onto a
 *                          dedicated field before rendering. Frozen as-is,
 *                          because callers already send these keys -- a bag
 *                          key is not required to be a registry id.
 *
 *   LAUNCH_ARGS            ordered emission table. The flag comes from the
 *                          registry, so a llama.cpp rename is picked up by
 *                          `bun scripts/gen-params.ts` instead of by hand.
 *
 * Irregular shapes stay out of the table and are rendered by the caller: the
 * speculative-decoding block (one flag per --spec-type token) and the raw
 * argString passthrough. A table row is a flat field -> flag -> value.
 */
import { PARAM_BY_ID } from './llama-params';
import type { ParamControl } from './llama-params';
import type { LaunchConfig } from './contracts';
import { isExplicitOff, offSpelling } from './flag-polarity';

export type ParamId = string;

// --- coercion (pure) -------------------------------------------------------

// Coerce a UI/API value to a finite number, or undefined when it's missing,
// empty, or not numeric. Number.isNaN() alone is NOT sufficient: it doesn't
// coerce, so '' and 'abc' sail through it, and an empty string would emit a
// flag with no value (e.g. `--top-k` "").
export function toFiniteNumber(v: unknown): number | undefined {
    if (v === null || v === undefined) return undefined;
    if (typeof v === 'boolean') return undefined;
    if (typeof v === 'string' && v.trim() === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
}

// Coerce to a non-empty trimmed string, or undefined. Preserves "0" (unlike
// `v || undefined`, which would drop a legitimate zero).
export function toNonEmptyString(v: unknown): string | undefined {
    if (v === null || v === undefined) return undefined;
    const s = String(v).trim();
    return s.length > 0 ? s : undefined;
}

// --- field -> registry id --------------------------------------------------

// Only fields we can confidently map to a ParamDef are wired here. Bench-only
// fields (nPrompt, nGen, depths, reps), passthrough strings (argString,
// extraArgs, rawCommand, rawArgs, rpcTarget, deviceA, deviceB, transport,
// label) and the spec draft NGL are intentionally skipped from the preset
// diff -- they stay in LaunchConfig but get no "changed from default" badge.
// Add an entry when the registry grows a matching id.
export const LAUNCH_FIELD_TO_PARAM: Record<keyof LaunchConfig, ParamId | undefined> = {
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
    specDraftNMax: 'spec_draft_n_max',
    specDraftNMin: 'spec_draft_n_min',
    specDraftModel: 'model',
    specNgramSizeN: 'spec_ngram_size_n',
    specNgramSizeM: 'spec_ngram_size_m',
    specNgramMinHits: 'spec_ngram_min_hits',
    specDraftNgl: undefined,
    preserveThinking: 'no_reasoning_preserve',
    reasoningPreserve: 'no_reasoning_preserve',
    chatTemplateFile: 'chat_template_file',
    jinja: 'no_jinja',
    loadMode: 'load_mode',
    verbosity: 'log_verbosity',
    argString: undefined,
    temp: 'temperature',
    deviceA: undefined,
    deviceB: undefined,
    transport: undefined,
    label: undefined,
    paramOverrides: undefined,
    // Structured, not a flat knob: the router block is edited as a unit (see
    // RouterFields) and has no single registry param behind it.
    router: undefined,
};

// Every id above must resolve, or the field loses its label, control, group
// and default-diff in the preset editor -- a silent failure, because the map
// is typed `| undefined` precisely so a miss compiles. Keep this honest: a
// param renamed upstream shows up here instead of in a bug report.
const MISSING_PARAM_IDS = Object.entries(LAUNCH_FIELD_TO_PARAM)
    .filter(([, id]) => id !== undefined && !PARAM_BY_ID[id])
    .map(([field, id]) => `${field} -> ${id}`);

if (MISSING_PARAM_IDS.length > 0) {
    throw new Error(
        'LAUNCH_FIELD_TO_PARAM references ids missing from shared/llama-params.ts ' +
        `(re-run: bun scripts/gen-params.ts): ${MISSING_PARAM_IDS.join(', ')}`,
    );
}

// --- bag alias -> field ----------------------------------------------------

// Legacy/mismatched presets may hold KNOWN params in the overrides bag (e.g.
// ctx_size instead of ctx). Promote them to real fields before rendering, so
// `-c`/`-ngl` and friends render once, from the field. Explicit, not derived
// from LAUNCH_FIELD_TO_PARAM: these are input keys callers already send, and a
// bag key need not be a registry id.
export const LAUNCH_BAG_ALIASES: Readonly<Record<ParamId, keyof LaunchConfig>> = {
    ctx_size: 'ctx',
    n_gpu_layers: 'ngl',
    flash_attn: 'fa',
    cache_type_k: 'cacheK',
    cache_type_v: 'cacheV',
    temperature: 'temp',
    port: 'port',
    jinja: 'jinja',
    load_mode: 'loadMode',
    verbosity: 'verbosity',
    // `chat_template`, not the registry's `chat_template_file`: the registry id
    // and the spelling callers send have never agreed here, and the bag key is
    // the frozen input side. Renaming it would reject presets that work today.
    chat_template: 'chatTemplateFile',
    spec_type: 'specType',
    reasoning_preserve: 'reasoningPreserve',
};

// --- emission table --------------------------------------------------------

/**
 * Which slot of the command line a binding renders in. The resolver injects
 * two blocks between them: the speculative-decoding expansion right after
 * `pre-spec`, and the --split-mode/-dev/--rpc/-ts device block after
 * `post-spec`. Both are launch-shape concerns, not registry ones.
 */
export type LaunchArgGroup = 'pre-spec' | 'post-spec' | 'post-device';
export interface LaunchArgBinding {
    /** LaunchConfig field to read. Not a contract field for `legacy` rows. */
    readonly field: string;
    /** Registry id the flag spelling comes from. Must exist in PARAM_BY_ID. */
    readonly paramId: ParamId;
    readonly group: LaunchArgGroup;
    /** Emit this flag instead of the registry's flags[0]. */
    readonly flag?: string;
    /**
     * Replace the default "is this set?" gate. Receives the raw field value and
     * the whole config, for the flags whose trigger spans fields (`--jinja`
     * also fires when a chat template is set).
     */
    readonly when?: (raw: unknown, config: Record<string, unknown>) => boolean;
    /**
     * Replace the default value text, by control type. Returning undefined
     * skips the flag entirely -- that is how a boolean that means "off" stays
     * off instead of rendering the string "false".
     */
    readonly text?: (raw: unknown) => string | undefined;
    /**
     * A camelCase key that is not in LaunchConfig. Nothing in the repo sets
     * these; they are read only from hand-written raw launch bodies and are
     * reachable in the supported way through paramOverrides. Marked so they
     * can be found and dropped in one place.
     */
    readonly legacy?: true;
}

// Table order IS command-line order. `pre-device` rows render before the
// --split-mode/-dev/--rpc/-ts block that resolveLaunchCommand injects.
export const LAUNCH_ARGS: readonly LaunchArgBinding[] = [
    { field: 'fa', paramId: 'flash_attn', group: 'pre-spec', text: raw => (raw ? 'on' : undefined) },
    { field: 'cacheK', paramId: 'cache_type_k', group: 'pre-spec', flag: '--cache-type-k' },
    { field: 'cacheV', paramId: 'cache_type_v', group: 'pre-spec', flag: '--cache-type-v' },
    { field: 'specDraftNgl', paramId: 'n_gpu_layers_draft', group: 'post-spec' },
    {
        field: 'preserveThinking',
        paramId: 'chat_template_kwargs',
        group: 'post-spec',
        text: () => JSON.stringify({ preserve_thinking: true }),
    },
    {
        field: 'reasoningPreserve',
        paramId: 'no_reasoning_preserve',
        group: 'post-spec',
        // preserveThinking implies it: leaving it off reformats the output.
        when: (raw, config) => !!raw || !!config.preserveThinking,
    },
    { field: 'temp', paramId: 'temperature', group: 'post-device' },
    { field: 'topK', paramId: 'top_k', group: 'post-device', legacy: true },
    { field: 'topP', paramId: 'top_p', group: 'post-device', legacy: true },
    { field: 'minP', paramId: 'min_p', group: 'post-device', legacy: true },
    { field: 'presencePenalty', paramId: 'presence_penalty', group: 'post-device', legacy: true },
    { field: 'repeatPenalty', paramId: 'repeat_penalty', group: 'post-device', legacy: true },
    { field: 'nCpuMoe', paramId: 'n_cpu_moe', group: 'post-device', flag: '--n-cpu-moe', legacy: true },
    {
        field: 'jinja',
        paramId: 'no_jinja',
        group: 'post-device',
        // A chat template is a jinja template, so setting one implies --jinja.
        when: (raw, config) => !!raw || !!toNonEmptyString(config.chatTemplateFile),
    },
    { field: 'chatTemplateFile', paramId: 'chat_template_file', group: 'post-device' },
    { field: 'loadMode', paramId: 'load_mode', group: 'post-device' },
    { field: 'verbosity', paramId: 'log_verbosity', group: 'post-device' },
];

const NUMERIC_CONTROLS: ReadonlySet<ParamControl> = new Set<ParamControl>(['int', 'float']);

function defaultText(control: ParamControl, raw: unknown): string | undefined {
    if (NUMERIC_CONTROLS.has(control)) {
        const n = toFiniteNumber(raw);
        return n === undefined ? undefined : String(n);
    }
    return toNonEmptyString(raw);
}

function defaultWhen(control: ParamControl, raw: unknown): boolean {
    // A toggle is a bare flag: emit it when on, and emit nothing when off
    // (llama-server's own default stands). We never render the negative
    // spelling here, so a false toggle leaves the default alone.
    if (control === 'toggle') return raw === true || raw === 'true' || raw === 1;
    return defaultText(control, raw) !== undefined;
}

/** Append one binding's flag (and value) to `args`, if it is set. */
export function appendLaunchArg(args: string[], binding: LaunchArgBinding, config: Record<string, unknown>): void {
    const def = PARAM_BY_ID[binding.paramId];
    if (!def || def.flags.length === 0) return;
    const raw = config[binding.field];
    // An explicit "off" on a toggle emits the param's DISABLING spelling, so
    // an option that defaults to enabled (--jinja, --slots, ...) can actually
    // be turned off. Absent/undefined is different: it emits nothing and lets
    // llama-server's own default stand.
    //
    // Skipped when the row's gate is satisfied by ANOTHER field: `jinja: false`
    // with a chat template set (or `reasoningPreserve: false` alongside
    // preserveThinking) keeps the existing behaviour instead of emitting a
    // flag pair that contradicts itself.
    if (def.control === 'toggle' && isExplicitOff(raw) && binding.when?.(false, config) !== true) {
        const off = offSpelling(def.flags);
        if (off) { args.push(off); return; }
    }
    // An explicit gate is authoritative. A bare toggle has no value text, so
    // the default "is it set?" question cannot be answered from the value --
    // `when` is how such a row says yes.
    if (binding.when ? !binding.when(raw, config) : !defaultWhen(def.control, raw)) return;
    const text = binding.text ? binding.text(raw) : defaultText(def.control, raw);
    // Undefined text means "not set" and skips the flag -- unless a gate has
    // already claimed the row, or the row is a toggle, which takes no value.
    if (text === undefined && (binding.text || !binding.when)) return;
    args.push(binding.flag ?? def.flags[0]);
    // A toggle carries no value unless its row spells one out.
    if (text !== undefined && (def.control !== 'toggle' || binding.text)) args.push(text);
}

/** Append every binding in `group`, in table order. */
export function appendLaunchArgs(args: string[], group: LaunchArgGroup, config: Record<string, unknown>): void {
    for (const binding of LAUNCH_ARGS) {
        if (binding.group === group) appendLaunchArg(args, binding, config);
    }
}
