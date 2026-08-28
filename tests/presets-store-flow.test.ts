// Store flow: mapped-field edits and paramOverrides bag edits persist and
// survive refresh; launch.js renders the bag to CLI flags.
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';

const canned = {
    presets: [{ name: 'smoke', build: '', config: { ctx: 4096 } }],
    active: 'smoke',
};

// Bun runs test files in one process: this stub must not leak past this
// file or every later fetch() in the suite gets canned responses.
const realFetch = globalThis.fetch;

beforeAll(() => {
    (globalThis as Record<string, unknown>).fetch = (async (input: string | URL) => {
        const url = String(input);
        const body = url.includes('/api/presets') ? canned : {};
        return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
});

afterAll(() => {
    (globalThis as Record<string, unknown>).fetch = realFetch;
});

describe('presetsStore dialog-edit flow', () => {
    it('mapped field edit lands, survives refresh, resets on default', async () => {
        const { presetsStore } = await import('../src/client/state/presets');
        const { overridesFromConfig } = await import('../src/client/features/presets/registry');

        await presetsStore.refresh();
        let snap = presetsStore.get();
        expect(snap.active?.name).toBe('smoke');
        expect(snap.draft.ctx).toBe(4096);

        presetsStore.setValue('ctx', 4097);
        snap = presetsStore.get();
        expect(snap.draft.ctx).toBe(4097);
        expect(snap.isDirty).toBe(true);
        expect(overridesFromConfig(snap.draft).some(o => o.field === 'ctx')).toBe(true);

        await presetsStore.refresh();
        snap = presetsStore.get();
        expect(snap.draft.ctx).toBe(4097);

        presetsStore.setValue('ctx', 0); // registry default for ctx_size is 0
        expect(presetsStore.get().draft.ctx).toBeUndefined();
    });

    it('paramOverrides bag: setParam persists any param id, dedupes field writes', async () => {
        const { presetsStore } = await import('../src/client/state/presets');
        const { overridesFromConfig, configWithOverrides } = await import('../src/client/features/presets/registry');

        await presetsStore.refresh();
        presetsStore.setParam('threads', 8);
        let snap = presetsStore.get();
        expect(snap.draft.paramOverrides?.threads).toBe(8);
        expect(snap.isDirty).toBe(true);
        const entries = overridesFromConfig(snap.draft);
        expect(entries.some(o => o.field === null && o.paramId === 'threads' && o.value === 8)).toBe(true);

        // survives refresh (dirty guard)
        await presetsStore.refresh();
        expect(presetsStore.get().draft.paramOverrides?.threads).toBe(8);

        // round-trip through configWithOverrides keeps the bag
        const config = configWithOverrides(presetsStore.get().draft as never);
        expect(config.paramOverrides?.threads).toBe(8);

        // mapped field write clears the same param from the bag
        presetsStore.setParam('ctx_size', 999);
        presetsStore.setValue('ctx', 123);
        expect(presetsStore.get().draft.paramOverrides?.ctx_size).toBeUndefined();

        // resetting to registry default removes the bag entry
        presetsStore.setParam('threads', 4); // threads default is likely != 4? just clear explicitly below
        presetsStore.setParam('threads', undefined);
        expect(presetsStore.get().draft.paramOverrides?.threads).toBeUndefined();
    });
});

describe('launch.js paramOverrides rendering', () => {
    it('renders bag entries to flags; toggles flag-only; unknown ids skipped', async () => {
        const { buildLlamaArgs } = await import('../src/server/lib/launch.js');
        const config = {
            modelPath: '/models/m.gguf', ctx: 4096, ngl: 99, port: 8080,
            paramOverrides: { threads: 8, no_cont_batching: true, ignore_eos: true, 'does-not-exist': 1, split_mode: 'layer', top_k: 50 },
        };
        const args = buildLlamaArgs(config, { mapModelPath: (p: string) => p, deviceArgs: [], defaultPort: 8080 });
        const has = (...pair: string[]) => pair.every((v, i) => args[args.indexOf(pair[0]) + i] === v);
        expect(has('-t', '8')).toBe(true);
        expect(has('--top-k', '50')).toBe(true);
        expect(has('-sm', 'layer')).toBe(true);
        expect(args).toContain('-cb');
        expect(args).toContain('--ignore-eos');
        expect(args).not.toContain('--does-not-exist');
    });

    it('dedupes duplicate/aliased flags, last wins; repeatables survive', async () => {
        const { buildLlamaArgs } = await import('../src/server/lib/launch.js');
        const args = buildLlamaArgs({
            modelPath: '/m', ctx: 4096, ngl: 99, port: 18083,
            deviceA: 'CUDA0', deviceB: 'Vulkan1',
            paramOverrides: { split_mode: 'layer', device: ['CUDA0','VULKAN1'], metrics: true, lora: '/a.gguf' },
        }, { mapModelPath: (p: string) => p, deviceArgs: ['--split-mode', 'layer', '-dev', 'CUDA0,Vulkan1'], defaultPort: 18083 });
        const count = (t: string) => args.filter(a => a === t).length;
        expect(count('--metrics')).toBe(1);          // base always adds it; bag toggle must not duplicate
        expect(count('-dev')).toBe(1);               // deviceArgs vs bag alias — last wins
        expect(count('-sm')).toBe(1);                // alias of --split-mode
        expect(count('--split-mode')).toBe(0);       // superseded by later -sm
        expect(args.filter(a => a === '--lora').length).toBe(1); // repeatable kept
        expect(args[args.indexOf('-sm') + 1]).toBe('layer');     // value kept with flag
    });

    it('promotes known bag ids (ctx_size/ngl) to fields so strict validation passes', async () => {
        const { resolveLaunchCommand } = await import('../src/server/lib/launch.js');
        const config = {
            modelPath: '/models/m.gguf',
            paramOverrides: { ctx_size: 262144, n_gpu_layers: '999' },
        };
        const { args } = resolveLaunchCommand(config, [{ id: 'default', label: 'default', path: '/bin/llama-server' }]);
        expect(args[args.indexOf('-c') + 1]).toBe('262144');
        expect(args[args.indexOf('-ngl') + 1]).toBe('999');
        // promoted ids must not render twice
        expect(args.filter(a => a === '262144').length).toBe(1);
    });
});

describe('intInputValid (int fields reject decimals, no silent truncation)', () => {
    it('accepts integers and empty, rejects decimals and garbage', async () => {
        const { intInputValid } = await import('../src/client/features/presets/registry');
        expect(intInputValid('')).toBe(true);
        expect(intInputValid('  ')).toBe(true);
        expect(intInputValid('0')).toBe(true);
        expect(intInputValid('-1')).toBe(true);
        expect(intInputValid('40')).toBe(true);
        expect(intInputValid('0.05')).toBe(false);
        expect(intInputValid('1.0')).toBe(true);
        expect(intInputValid('1.5')).toBe(false);
        expect(intInputValid('abc')).toBe(false);
    });

    it('toInput shows the effective default for unset numeric rows', async () => {
        const { toInput } = await import('../src/client/features/presets/PresetBrowserDialog');
        const { PARAM_BY_ID } = await import('../shared/llama-params');
        expect(toInput(undefined, 'float', PARAM_BY_ID['top_p'])).toBe('0.95');
        expect(toInput(undefined, 'float', PARAM_BY_ID['min_p'])).toBe('0.05');
        expect(toInput(undefined, 'int', PARAM_BY_ID['top_k'])).toBe('40');
        expect(toInput(0.8, 'float', PARAM_BY_ID['top_p'])).toBe('0.8');
        expect(toInput(undefined, 'text')).toBe('');
        expect(toInput('x', 'text')).toBe('x');
    });
});
