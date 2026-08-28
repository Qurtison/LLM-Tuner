/*
 * Client-side preset store. Mirrors the server's /api/presets surface
 * and adds a `draft` layer so the docked panel can edit in place.
 *
 * `draft` is a full LaunchConfig (the server round-trips a full one
 * anyway), but `overridesFromConfig` collapses it to the diff against
 * the registry when the UI wants to render only changed flags. The
 * invariant: setting a field back to its registry default deletes the
 * key from draft.
 */
import { api } from '../api/client';
import { getErrorMessage } from '../api/errors';
import { loadJson, saveJson, removeJson } from '../lib/storage';
import type { LaunchConfig, Preset, PresetsResponse, PresetSaveRequest } from '../../../shared/contracts';
import { configWithOverrides, overridesFromConfig, paramForField, paramDefById } from '../features/presets/registry';

const ACTIVE_KEY = 'presets_active';
// ponytail: no localStorage draft persistence — the server-saved preset is
// the source of truth on load; unsaved edits live in memory for the session
// only. Re-add a draft key (tagged with the preset name) if cross-reload
// draft recovery is ever wanted.

export interface PresetsSnapshot {
    presets: Preset[];
    active: Preset | null;
    draft: LaunchConfig;
    isDirty: boolean;
    loading: boolean;
    error: string;
}

type Listener = () => void;

class Value<T> {
    private value: T;
    private listeners = new Set<Listener>();
    constructor(initial: T) { this.value = initial; }
    get(): T { return this.value; }
    set(next: T): void { if (next === this.value) return; this.value = next; this.listeners.forEach(l => l()); }
    subscribe = (l: Listener): (() => void) => { this.listeners.add(l); return () => this.listeners.delete(l); };
}

function defaultDraft(): LaunchConfig {
    return {};
}

function deepEqualLaunch(a: LaunchConfig, b: LaunchConfig): boolean {
    if (a === b) return true;
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
        const av = (a as Record<string, unknown>)[k];
        const bv = (b as Record<string, unknown>)[k];
        if (av === bv) continue;
        if (av == null || bv == null) return false;
        if (JSON.stringify(av) !== JSON.stringify(bv)) return false;
    }
    return true;
}

function activeFrom(presets: Preset[], name: string | null): Preset | null {
    if (!name) return null;
    return presets.find(p => p.name === name) ?? null;
}

class PresetsStore {
    private value = new Value<PresetsSnapshot>({
        presets: [],
        active: null,
        draft: defaultDraft(),
        isDirty: false,
        loading: false,
        error: '',
    });

    get = (): PresetsSnapshot => this.value.get();
    subscribe = this.value.subscribe;

    async refresh(): Promise<void> {
        const next: PresetsSnapshot = { ...this.value.get(), loading: true, error: '' };
        this.value.set(next);
        try {
            const data = await api<PresetsResponse>('/api/presets');
            const presets = data.presets || [];
            const activeName = data.active ?? loadJson<string | null>(ACTIVE_KEY, null);
            const active = activeFrom(presets, activeName);
            this.value.set({ ...this.value.get(), presets, active, loading: false, error: '' });
            // Sync the draft to the saved preset unless the user has unsaved
            // edits — a stale localStorage draft must not shadow the server.
            if (!this.value.get().isDirty) {
                this.value.set({ ...this.value.get(), draft: active ? { ...active.config } : defaultDraft(), isDirty: false });
            }
        } catch (err) {
            this.value.set({ ...this.value.get(), loading: false, error: getErrorMessage(err) });
        }
    }

    setActive(name: string | null): void {
        const next = activeFrom(this.value.get().presets, name);
        if (name) saveJson(ACTIVE_KEY, name); else removeJson(ACTIVE_KEY);
        this.value.set({ ...this.value.get(), active: next, draft: next ? { ...next.config } : defaultDraft(), isDirty: false });
        if (name) {
            // Keep the server's active.json in sync (drives /api/apply and
            // activeBuildDir); localStorage alone would drift from it.
            void api(`/api/presets/${encodeURIComponent(name)}/activate`, { method: 'POST', body: '{}' }).catch(() => {});
        }
    }

    private recomputeDirty(): void {
        const { active, draft } = this.value.get();
        const base = active?.config ?? {};
        this.value.set({ ...this.value.get(), isDirty: !deepEqualLaunch(draft, base) });
    }

    setValue<K extends keyof LaunchConfig>(field: K, value: LaunchConfig[K]): void {
        const draft = { ...this.value.get().draft };
        if (value === undefined || value === null || value === '') {
            delete (draft as Record<string, unknown>)[field as string];
        } else {
            const def = paramForField(field);
            if (def && def.default !== undefined && JSON.stringify(value) === JSON.stringify(def.default)) {
                delete (draft as Record<string, unknown>)[field as string];
            } else {
                (draft as Record<string, unknown>)[field as string] = value;
            }
        }
        // The field write wins over any bag entry for the same param.
        const pid = paramForField(field)?.id;
        if (pid && draft.paramOverrides && pid in draft.paramOverrides) {
            const bag = { ...draft.paramOverrides };
            delete bag[pid];
            this.applyBag(draft, bag);
        }
        this.value.set({ ...this.value.get(), draft });
        this.recomputeDirty();
    }

    // Set a registry param that has no dedicated LaunchConfig field.
    setParam(id: string, value: unknown): void {
        const draft = { ...this.value.get().draft };
        const bag = { ...(draft.paramOverrides ?? {}) };
        const def = paramDefById(id);
        if (value === undefined || value === null || value === '') {
            delete bag[id];
        } else if (def && def.default !== undefined && JSON.stringify(value) === JSON.stringify(def.default)) {
            delete bag[id];
        } else {
            bag[id] = value;
        }
        this.applyBag(draft, bag);
        this.value.set({ ...this.value.get(), draft });
        this.recomputeDirty();
    }

    private applyBag(draft: LaunchConfig, bag: Record<string, unknown>): void {
        if (Object.keys(bag).length > 0) draft.paramOverrides = bag;
        else delete draft.paramOverrides;
    }

    revert(): void {
        const { active } = this.value.get();
        this.value.set({ ...this.value.get(), draft: active ? { ...active.config } : defaultDraft(), isDirty: false });
    }

    overrides() {
        return overridesFromConfig(this.value.get().draft);
    }

    async save(): Promise<{ ok: boolean; warnings: string[] }> {
        const { active, draft } = this.value.get();
        if (!active) return { ok: false, warnings: ['No active preset to save to.'] };
        try {
            const body: PresetSaveRequest = { name: active.name, config: configWithOverrides(draft as Record<keyof LaunchConfig, unknown>) };
            const result = await api<{ ok: boolean; warnings: string[] }>('/api/presets', {
                method: 'POST',
                body: JSON.stringify(body),
            });
            await this.refresh();
            this.value.set({ ...this.value.get(), isDirty: false });
            return { ok: result.ok, warnings: result.warnings || [] };
        } catch (err) {
            this.value.set({ ...this.value.get(), error: getErrorMessage(err) });
            return { ok: false, warnings: [getErrorMessage(err)] };
        }
    }

    async saveAsNew(name: string): Promise<{ ok: boolean; warnings: string[]; error?: string }> {
        const trimmed = name.trim();
        if (!trimmed) return { ok: false, warnings: [], error: 'Name required.' };
        try {
            const result = await api<{ ok: boolean; warnings: string[] }>(`/api/presets`, {
                method: 'POST',
                body: JSON.stringify({ name: trimmed, config: configWithOverrides(this.value.get().draft as Record<keyof LaunchConfig, unknown>) }),
            });
            await this.refresh();
            this.setActive(trimmed);
            return { ok: result.ok, warnings: result.warnings || [] };
        } catch (err) {
            return { ok: false, warnings: [], error: getErrorMessage(err) };
        }
    }

    async remove(name: string): Promise<boolean> {
        try {
            await api(`/api/presets/${encodeURIComponent(name)}`, { method: 'DELETE' });
            const { active } = this.value.get();
            if (active?.name === name) this.setActive(null);
            else await this.refresh();
            return true;
        } catch (err) {
            this.value.set({ ...this.value.get(), error: getErrorMessage(err) });
            return false;
        }
    }
}

export const presetsStore = new PresetsStore();