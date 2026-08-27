import { test, expect } from 'bun:test';
import { overridesFromConfig, configWithOverrides, paramForField } from '../src/client/features/presets/registry';
import { PARAM_BY_ID } from '../shared/llama-params.ts';

test('paramForField: ngl maps to n_gpu_layers', () => {
    const def = paramForField('ngl');
    expect(def?.id).toBe('n_gpu_layers');
});

test('overridesFromConfig: empty config yields no overrides', () => {
    expect(overridesFromConfig({})).toEqual([]);
    expect(overridesFromConfig(null)).toEqual([]);
    expect(overridesFromConfig(undefined)).toEqual([]);
});

test('overridesFromConfig: value equal to default is dropped (invariant)', () => {
    const def = PARAM_BY_ID['ctx_size'];
    expect(def?.default).toBeDefined();
    const config = { ctx: def.default };
    expect(overridesFromConfig(config)).toEqual([]);
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
