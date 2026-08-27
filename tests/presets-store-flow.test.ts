// Repro attempt: dialog edit → store → survives refresh, survives reopen.
import { describe, it, expect, beforeAll } from 'bun:test';

const canned = {
    presets: [{ name: 'smoke', build: '', config: { ctx: 4096 } }],
    active: 'smoke',
};

beforeAll(() => {
    (globalThis as Record<string, unknown>).fetch = (async (input: string | URL) => {
        const url = String(input);
        const body = url.includes('/api/presets')
            ? canned
            : {};
        return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    // localStorage absent in bun — storage lib must tolerate that.
});

describe('presetsStore dialog-edit flow', () => {
    it('edit lands in draft, survives refresh, dirty flags correct', async () => {
        const { presetsStore } = await import('../src/client/state/presets');
        const { overridesFromConfig } = await import('../src/client/features/presets/registry');

        await presetsStore.refresh();
        let snap = presetsStore.get();
        expect(snap.active?.name).toBe('smoke');
        expect(snap.draft.ctx).toBe(4096);
        expect(snap.isDirty).toBe(false);

        // user edits ctx via dialog row
        presetsStore.setValue('ctx', 4097);
        snap = presetsStore.get();
        expect(snap.draft.ctx).toBe(4097);
        expect(snap.isDirty).toBe(true);
        expect(overridesFromConfig(snap.draft).some(o => o.field === 'ctx')).toBe(true);

        // dialog closed; any refresh (mount of another panel) must NOT wipe
        await presetsStore.refresh();
        snap = presetsStore.get();
        expect(snap.draft.ctx).toBe(4097);
        expect(snap.isDirty).toBe(true);

        // set ctx back to the registry default (0 = "from model") → key deleted
        presetsStore.setValue('ctx', 0);
        snap = presetsStore.get();
        expect(snap.draft.ctx).toBeUndefined();
    });

    it('unmapped param cannot persist (field null)', async () => {
        const { paramForField } = await import('../src/client/features/presets/registry');
        // params with no LaunchConfig mapping are silently dropped by the dialog
        expect(paramForField('nPrompt')).toBeUndefined();
    });
});
