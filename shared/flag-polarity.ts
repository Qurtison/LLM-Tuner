/*
 * Which spelling of a registry param is the DISABLING one.
 *
 * A ParamDef lists every spelling of one option in the order llama-server's
 * help line gives them:
 *
 *   --jinja, --no-jinja            whether to use jinja (default: enabled)
 *   -kvo, --kv-offload, -nkvo, --no-kv-offload
 *
 * So `flags` mixes positive aliases with disabling spellings, and position
 * cannot tell them apart: index 1 is `--kv-offload`, a positive alias. Picking
 * `flags[0]` for "on" is safe; picking a disabling spelling needs the pattern,
 * which is why this lives in one place.
 *
 * The two callers are the opposite ends of the same contract:
 *   -- shared/launch-params.ts  emits the disabling spelling for an explicit
 *                               `false` (an absent key still emits nothing, so
 *                               llama-server's own default stands);
 *   -- scripts/gen-params.ts    labels a `no_`-prefixed param after its
 *                               positive spelling, because the `no_` id is an
 *                               artifact of the alias, not the option's meaning.
 */

// Long form, e.g. "--no-jinja".
const LONG_NEGATIVE = /^--no-/;
// The short aliases llama.cpp pairs with them: "-nkvo" (from "-kvo") and
// "-no-ag" (from "-ag").
const SHORT_NEGATIVE = /^-no-|^-n[a-z]/;

/**
 * True when `flags` describes a param that has a disabling spelling at all.
 *
 * Only a `--no-<x>` spelling is treated as proof, so standalone options that
 * merely start with `-n` (`-ngl`, `-no-kv-offload` without a pair, ...) are
 * never mistaken for one.
 */
export function hasNegativeSpelling(flags: readonly string[]): boolean {
    return flags.some(flag => LONG_NEGATIVE.test(flag));
}

/**
 * The disabling spellings of a param, or `[]` when it has none. Only call this
 * for a param where `hasNegativeSpelling()` is true.
 */
export function negativeSpellings(flags: readonly string[]): string[] {
    if (!hasNegativeSpelling(flags)) return [];
    return flags.filter(flag => LONG_NEGATIVE.test(flag) || SHORT_NEGATIVE.test(flag));
}

/**
 * The spelling to emit when a param is EXPLICITLY turned off, or undefined
 * when there is none.
 *
 * Requires a positive spelling to exist. A negative-only option (llama.cpp
 * has `--no-host`, which is its own switch, not the negation of `--host`) has
 * no "off" state -- ON already emits that spelling, so emitting it again for
 * `false` would make true and false identical.
 *
 * Prefers the longest long form: upstream often lists a terse alias next to
 * the option's own name (`--mmproj-auto, --no-mmproj, --no-mmproj-auto`), and
 * the longest one is the specific spelling that matches the param.
 */
export function offSpelling(flags: readonly string[]): string | undefined {
    const negatives = negativeSpellings(flags);
    if (negatives.length === 0 || positiveSpellings(flags).length === 0) return undefined;
    const longs = negatives.filter(flag => LONG_NEGATIVE.test(flag));
    return longs.sort((a, b) => b.length - a.length)[0] ?? negatives[0];
}

/**
 * The positive spellings, i.e. everything that is not a disabling one. Empty
 * for a param that only has disabling spellings.
 */
export function positiveSpellings(flags: readonly string[]): string[] {
    const negatives = new Set(negativeSpellings(flags));
    return flags.filter(flag => !negatives.has(flag));
}

/**
 * True for an explicit "off" value.
 *
 * Deliberately narrow: only `false`/`"false"`/`0` count, and the caller must
 * restrict this to toggle controls. A numeric param set to 0 is a real value
 * (`--min-p 0`), not an "off".
 */
export function isExplicitOff(value: unknown): boolean {
    return value === false || value === 'false' || value === 0;
}
