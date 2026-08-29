/*
 * Panel system. Panels live on a free-form canvas: each has an x/y/w/h
 * rect, dragged by the "⋮⋮" header handle and resized by the corner
 * handle (pointer events, no library). Layout state (position, size,
 * collapsed, hidden) is persisted in localStorage so a refresh keeps
 * the user's workspace.
 *
 * Each panel registers an id + a render function. PanelCanvas consumes
 * a persisted rect map and renders absolutely positioned panels.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { loadJson, saveJson } from '../lib/storage';
import { Value } from '../state/value';

const STORAGE_KEY = 'panel_layout_v2';

export type PanelId = string;

export interface PanelRect {
    x: number;
    y: number;
    w: number;
    h: number;
}

const MIN_W = 260;
const MIN_H = 140;

export interface PanelState {
    order: PanelId[];
    geometry: Record<PanelId, PanelRect>;
    collapsed: Record<PanelId, boolean>;
    hidden: Record<PanelId, boolean>;
}

type Listener = () => void;

const registry = new Map<PanelId, { render: () => ReactNode; label: string }>();

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

interface PanelShellProps {
    id: PanelId;
    title: string;
    children: ReactNode;
    onDragStart: (e: React.PointerEvent) => void;
    onResizeStart: (e: React.PointerEvent) => void;
}

export function PanelShell({ id, title, children, onDragStart, onResizeStart }: PanelShellProps) {
    const state = usePanelState();
    const collapsed = !!state.collapsed[id];
    const onToggle = useCallback(() => panelStore.toggleCollapsed(id), [id]);
    return (
        <section aria-label={title} className="relative flex h-full flex-col rounded border border-neutral-800 bg-neutral-900/60 shadow-lg">
            <header className="flex items-center gap-2 border-b border-neutral-800 px-3 py-2">
                <span onPointerDown={onDragStart} className="cursor-grab touch-none select-none text-neutral-600 hover:text-neutral-300" aria-label={'Drag ' + title} title="Drag to move">⋮⋮</span>
                <h2 className="text-xs font-bold uppercase tracking-wider text-neutral-300">{title}</h2>
                <button type="button" onClick={onToggle} aria-expanded={!collapsed} aria-label={collapsed ? 'Expand ' + title : 'Minimize ' + title} className="ml-auto rounded px-2 py-0.5 text-[11px] text-neutral-500 hover:text-neutral-200">{collapsed ? '▴' : '▾'}</button>
            </header>
            {collapsed
                ? <div className="flex-1" onPointerDown={onDragStart} />
                : <div className="min-h-0 flex-1 overflow-auto p-3">{children}</div>}
            <span
                onPointerDown={onResizeStart}
                aria-label={'Resize ' + title}
                title="Drag to resize"
                className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize touch-none rounded-br text-neutral-600 hover:text-neutral-300"
            >◢</span>
        </section>
    );
}

interface DragState {
    id: PanelId;
    mode: 'move' | 'resize';
    startX: number;
    startY: number;
    orig: PanelRect;
}

export function PanelCanvas() {
    const state = usePanelState();
    const [drag, setDrag] = useState<DragState | null>(null);

    useEffect(() => { panelStore.init(); }, []);

    const visible = useMemo(() => state.order.filter(id => !state.hidden[id]), [state]);

    const { contentW, contentH } = useMemo(() => {
        let w = 0, h = 0;
        for (const id of visible) {
            const g = state.geometry[id];
            if (!g) continue;
            w = Math.max(w, g.x + g.w);
            h = Math.max(h, g.y + g.h);
        }
        return { contentW: w + 16, contentH: h + 16 };
    }, [state, visible]);

    const startDrag = useCallback((id: PanelId, mode: 'move' | 'resize') => (e: React.PointerEvent) => {
        e.preventDefault();
        const orig = panelStore.get().geometry[id];
        if (!orig) return;
        setDrag({ id, mode, startX: e.clientX, startY: e.clientY, orig });
    }, []);

    useEffect(() => {
        if (!drag) return;
        const onMove = (e: PointerEvent) => {
            const dx = e.clientX - drag.startX;
            const dy = e.clientY - drag.startY;
            if (drag.mode === 'move') {
                panelStore.setRect(drag.id, {
                    ...drag.orig,
                    x: Math.max(0, drag.orig.x + dx),
                    y: Math.max(0, drag.orig.y + dy),
                });
            } else {
                panelStore.setRect(drag.id, {
                    ...drag.orig,
                    w: Math.max(MIN_W, drag.orig.w + dx),
                    h: Math.max(MIN_H, drag.orig.h + dy),
                });
            }
        };
        const onUp = () => setDrag(null);
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        return () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
        };
    }, [drag]);

    return (
        <div className="overflow-auto">
            <div
                className="relative rounded"
                style={{
                    minWidth: '100%',
                    width: contentW,
                    height: contentH,
                    backgroundImage: 'radial-gradient(circle, rgb(64 64 64 / 0.5) 1px, transparent 1px)',
                    backgroundSize: '24px 24px',
                }}
            >
                {visible.map(id => {
                    const entry = registry.get(id);
                    if (!entry) return null;
                    const g = state.geometry[id];
                    if (!g) return null;
                    return (
                        <div
                            key={id}
                            className="absolute"
                            style={{ left: g.x, top: g.y, width: g.w, height: state.collapsed[id] ? 'auto' : g.h, zIndex: drag?.id === id ? 30 : undefined }}
                        >
                            <PanelShell
                                id={id}
                                title={entry.label}
                                onDragStart={startDrag(id, 'move')}
                                onResizeStart={startDrag(id, 'resize')}
                            >
                                <entry.render />
                            </PanelShell>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

export function PanelVisibilityMenu() {
    const state = usePanelState();
    const [open, setOpen] = useState(false);
    return (
        <div className="relative">
            <button type="button" onClick={() => setOpen(o => !o)} className="rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-700">Panels ▾</button>
            {open && (
                <>
                    <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
                    <div className="absolute right-0 z-40 mt-1 max-h-96 w-64 overflow-auto rounded border border-neutral-700 bg-neutral-900 p-2 text-xs shadow-2xl">
                        {[...registry.keys()].map(id => {
                            const hidden = !!state.hidden[id];
                            return (
                                <label key={id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-neutral-800">
                                    <input type="checkbox" checked={!hidden} onChange={() => panelStore.toggleHidden(id)} className="h-3.5 w-3.5 accent-amber-500" />
                                    <span className="text-neutral-200">{registry.get(id)?.label ?? id}</span>
                                </label>
                            );
                        })}
                        <button type="button" onClick={() => panelStore.reset()} className="mt-2 w-full rounded bg-neutral-800 px-2 py-1 text-neutral-400 hover:text-neutral-200">Reset to default</button>
                    </div>
                </>
            )}
        </div>
    );
}
