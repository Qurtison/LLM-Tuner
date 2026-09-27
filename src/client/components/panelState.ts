// Panel registration and persisted layout state live outside the component module
// so Vite can refresh panel components without resetting this singleton store.
import { useSyncExternalStore, type ReactNode } from 'react';
import { loadJson, saveJson } from '../lib/storage';
import { Value } from '../state/value';

const STORAGE_KEY = 'panel_layout_v2';
const MIN_W = 260;
const MIN_H = 140;

export type PanelId = string;

export interface PanelRect {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface PanelState {
    order: PanelId[];
    geometry: Record<PanelId, PanelRect>;
    collapsed: Record<PanelId, boolean>;
    hidden: Record<PanelId, boolean>;
}

export const registry = new Map<PanelId, { render: () => ReactNode; label: string }>();

export function registerPanel(id: PanelId, label: string, render: () => ReactNode): void {
    registry.set(id, { render, label });
}

function defaultState(): PanelState {
    const geometry: Record<PanelId, PanelRect> = {};
    let i = 0;
    for (const id of registry.keys()) {
        geometry[id] = { x: 16 + (i % 5) * 48, y: 16 + i * 44, w: 560, h: 360 };
        i++;
    }
    return { order: [...registry.keys()], geometry, collapsed: {}, hidden: {} };
}

function loadState(): PanelState {
    const fallback = defaultState();
    const raw = loadJson<PanelState | null>(STORAGE_KEY, null);
    if (!raw || typeof raw !== 'object') return fallback;
    const known = new Set(registry.keys());
    const order = Array.isArray(raw.order) ? raw.order.filter((id): id is PanelId => typeof id === 'string' && known.has(id)) : [];
    for (const id of registry.keys()) if (!order.includes(id)) order.push(id);
    const geometry = fallback.geometry;
    const rawGeo = raw.geometry as Record<string, PanelRect> | undefined;
    if (rawGeo && typeof rawGeo === 'object') {
        for (const id of registry.keys()) {
            const g = rawGeo[id];
            if (g && [g.x, g.y, g.w, g.h].every(n => typeof n === 'number' && isFinite(n))) {
                geometry[id] = { x: g.x, y: g.y, w: Math.max(MIN_W, g.w), h: Math.max(MIN_H, g.h) };
            }
        }
    }
    const collapsed = raw.collapsed && typeof raw.collapsed === 'object' ? raw.collapsed : {};
    const hidden = raw.hidden && typeof raw.hidden === 'object' ? raw.hidden : {};
    return { order, geometry, collapsed, hidden };
}

class PanelStore {
    private value = new Value<PanelState>({ order: [], geometry: {}, collapsed: {}, hidden: {} });
    init(): void { this.value.set(loadState()); }
    get = (): PanelState => this.value.get();
    subscribe = this.value.subscribe;
    private save(next: PanelState): void { this.value.set(next); saveJson(STORAGE_KEY, next); }
    setRect(id: PanelId, rect: PanelRect): void {
        const cur = this.value.get();
        this.save({ ...cur, geometry: { ...cur.geometry, [id]: rect } });
    }
    toggleCollapsed(id: PanelId): void {
        const cur = this.value.get();
        this.save({ ...cur, collapsed: { ...cur.collapsed, [id]: !cur.collapsed[id] } });
    }
    toggleHidden(id: PanelId): void {
        const cur = this.value.get();
        this.save({ ...cur, hidden: { ...cur.hidden, [id]: !cur.hidden[id] } });
    }
    reset(): void { this.save(defaultState()); }
}

export const panelStore = new PanelStore();
export function usePanelState(): PanelState {
    return useSyncExternalStore(panelStore.subscribe, panelStore.get, panelStore.get);
}

export { MIN_W, MIN_H };
