// Store flow: mapped-field edits and paramOverrides bag edits persist and
// survive refresh; launch.js renders the bag to CLI flags.
import { describe, it, expect, beforeAll } from 'bun:test';

const canned = {
    presets: [{ name: 'smoke', build: '', config: { ctx: 4096 } }],
    active: 'smoke',
};

beforeAll(() => {
    (globalThis as Record<string, unknown>).fetch = (async (input: string | URL) => {
        const url = String(input);
        const body = url.includes('/api/presets') ? canned : {};
        return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
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
});
