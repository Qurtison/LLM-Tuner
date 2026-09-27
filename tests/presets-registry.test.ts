import { test, expect } from 'bun:test';
import { displayValue, overridesFromConfig, configWithOverrides, paramForField } from '../src/client/features/presets/registry';
import { PARAM_BY_ID } from '../shared/llama-params';
import type { LaunchConfig } from '../shared/contracts';

test('paramForField: ngl maps to n_gpu_layers', () => {
    const def = paramForField('ngl');
    expect(def?.id).toBe('n_gpu_layers');
});

test('registry: no_reasoning_preserve is a toggle defaulting to false', () => {
    const def = PARAM_BY_ID['no_reasoning_preserve'];
    expect(def.control).toBe('toggle');
    expect(def.default).toBe(false);
    expect(def.flags[0]).toBe('--reasoning-preserve');
});

test('overridesFromConfig: empty config yields no overrides', () => {
    expect(overridesFromConfig({})).toEqual([]);
    expect(overridesFromConfig(null)).toEqual([]);
    expect(overridesFromConfig(undefined)).toEqual([]);
});

test('overridesFromConfig: value equal to default is dropped (invariant)', () => {
    const def = PARAM_BY_ID['ctx_size'];
    expect(def?.default).toBeDefined();
    // ponytail: registry defaults are runtime-typed unknown; ctx_size's is a number.
    const config: LaunchConfig = { ctx: def.default as number };
    expect(overridesFromConfig(config)).toEqual([]);
});

// The directive this guards: an option llama.cpp enables BY DEFAULT must not
// be recorded as a change unless the user actually changed it. It failed while
// a toggle's default was the WORD "enabled" -- a string can never equal the
// boolean a preset carries, so `jinja: true` (llama.cpp's own default) landed
// in every preset as a modification, and a default-ON flag could be switched
// off by a preset that never meant to touch it.
test('a default-ON toggle at its default is not a change', () => {
    const def = PARAM_BY_ID['no_jinja'];
    expect(def.control).toBe('toggle');
    expect(def.default).toBe(true);
    expect(overridesFromConfig({ jinja: true } as LaunchConfig)).toEqual([]);
});

test('a default-ON toggle switched off IS a change', () => {
    const overrides = overridesFromConfig({ jinja: false } as LaunchConfig);
    expect(overrides).toHaveLength(1);
    expect(overrides[0].field).toBe('jinja');
    expect(overrides[0].value).toBe(false);
});

test('every toggle default is a real boolean, not a word', () => {
    // llama.cpp writes "(default: enabled)" in --help; the generator normalises
    // it and keeps the word as defaultLabel for display.
    const wordy = Object.values(PARAM_BY_ID)
        .filter(def => def.control === 'toggle' && typeof def.default === 'string')
        .filter(def => /^(enabled|disabled|true|false|on|off|yes|no)$/i.test(def.default as string))
        .map(def => `${def.id}=${String(def.default)}`);
    expect(wordy).toEqual([]);
});

test('no canned-model loader is exposed as a preset knob', () => {
    // --fim-qwen-*-default, --gpt-oss-*-default, --vision-gemma-*-default and
    // friends download and load a canned model. The dashboard picks the model
    // itself, so these are filtered out of the registry entirely.
    const canned = Object.values(PARAM_BY_ID)
        .filter(def => /can download weights/i.test(def.help ?? ''))
        .map(def => def.id);
    expect(canned).toEqual([]);
});

test('displayValue: an unset toggle shows the state it will launch with', () => {
    // --jinja is ON unless disabled, so an untouched toggle must read ON.
    expect(displayValue(PARAM_BY_ID['no_jinja'], undefined)).toBe(true);
    // A default-OFF toggle still reads off.
    expect(displayValue(PARAM_BY_ID['metrics'], undefined)).toBe(false);
    // An explicit value always wins over the default.
    expect(displayValue(PARAM_BY_ID['no_jinja'], false)).toBe(false);
    expect(displayValue(PARAM_BY_ID['metrics'], true)).toBe(true);
});

test('displayValue: non-toggles keep showing an empty field', () => {
    // Their default is a value to type, not a state to display: prefilling the
    // field would make it look edited.
    expect(displayValue(PARAM_BY_ID['ctx_size'], undefined)).toBeUndefined();
    expect(displayValue(PARAM_BY_ID['ctx_size'], 8192)).toBe(8192);
});

test('overridesFromConfig: value differing from default is kept', () => {
    const config = { ctx: 8192 };
    const overrides = overridesFromConfig(config);
    expect(overrides).toHaveLength(1);
    expect(overrides[0].field).toBe('ctx');
    expect(overrides[0].paramId).toBe('ctx_size');
    expect(overrides[0].value).toBe(8192);
});

test('overridesFromConfig: empty string is treated as unset (not an override)', () => {
    const config = { model: '' };
    expect(overridesFromConfig(config)).toEqual([]);
});

test('overridesFromConfig: unmapped fields are skipped silently', () => {
    const config = { argString: '-ngl 99', deviceA: 'CUDA0', nPrompt: 512 };
    expect(overridesFromConfig(config)).toEqual([]);
});

test('overridesFromConfig: request-scope field (temp) is detected', () => {
    const config = { temp: 0.7 };
    const overrides = overridesFromConfig(config);
    expect(overrides).toHaveLength(1);
    expect(overrides[0].def.scope).toBe('request');
    expect(overrides[0].def.requiresRestart).toBeFalsy();
});

test('overridesFromConfig: server-scope field (ctx) marked requiresRestart', () => {
    const config = { ctx: 4096 };
    const overrides = overridesFromConfig(config);
    expect(overrides[0].def.scope).toBe('server');
    expect(overrides[0].def.requiresRestart).toBe(true);
});

test('configWithOverrides: round-trip drops default-equivalent values', () => {
    const def = PARAM_BY_ID['ctx_size'];
    const out = configWithOverrides({ ctx: def.default, ngl: 99 });
    expect(out.ctx).toBeUndefined();
    expect(out.ngl).toBe(99);
});

test('configWithOverrides: round-trip drops empty values', () => {
    const out = configWithOverrides({ ctx: 0, model: '' });
    expect(out.ctx).toBeUndefined();
    expect(out.model).toBeUndefined();
});

test('configWithOverrides: round-trip preserves non-default values', () => {
    const out = configWithOverrides({ ctx: 16384, fa: true, temp: 0.5 });
    expect(out.ctx).toBe(16384);
    expect(out.fa).toBe(true);
    expect(out.temp).toBe(0.5);
});
