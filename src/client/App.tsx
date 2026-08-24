// App shell: three-slot layout — left sidebar (model loading), center
// (bench + history), right sidebar (monitor). Each sidebar swaps into the
// center via its arrow button; the displaced view becomes the sidebar.
// App remains the single SSE owner. Panels come from features/index.ts.
import { useCallback, useEffect, useState } from 'react';
import { useSse } from './hooks/useSse';
import { useServer, applySseFrame, setSseConnected, setServerConfig } from './state/server';
import { api } from './api/client';
import type { ConfigResponse } from '../../shared/contracts';
import {
    InteractivePanel,
    ChatPanel,
    MonitorPanel,
    LiveRequestsPanel,
    HistoryPanel,
    BenchPanel,
    OverviewPanel,
    FileBrowserPanel,
    PresetsPanel,
    UpgradePanel,
} from './features';

type Side = 'left' | 'center' | 'right';
type View = 'model' | 'bench' | 'monitor';
type Slots = Record<Side, View>;

const SIDES: Side[] = ['left', 'center', 'right'];
const VIEWS: View[] = ['model', 'bench', 'monitor'];
const DEFAULT_SLOTS: Slots = { left: 'model', center: 'bench', right: 'monitor' };
const TITLES: Record<View, string> = { model: 'Model', bench: 'Bench + History', monitor: 'Monitor' };
// Where each view lives by default; used to point the collapse arrow home.
const HOME: Record<View, 'left' | 'center' | 'right'> = { model: 'left', bench: 'center', monitor: 'right' };

function loadSlots(): Slots {
    try {
        const raw: unknown = JSON.parse(window.localStorage.getItem('layout_slots') || 'null');
        if (raw && typeof raw === 'object'
            && SIDES.every(side => VIEWS.includes((raw as Slots)[side]))
            && new Set(SIDES.map(side => (raw as Slots)[side])).size === SIDES.length) {
            return raw as Slots;
        }
    } catch { /* storage unavailable or corrupt — use default */ }
    return DEFAULT_SLOTS;
}

function swapWithCenter(slots: Slots, side: 'left' | 'right'): Slots {
    return { ...slots, [side]: slots.center, center: slots[side] };
}

function ViewContent({ view }: { view: View }) {
    if (view === 'model') return <><InteractivePanel /><ChatPanel /></>;
    if (view === 'monitor') return <><OverviewPanel /><PresetsPanel /><UpgradePanel /><MonitorPanel /><LiveRequestsPanel /><FileBrowserPanel /></>;
    return <><BenchPanel /><HistoryPanel /></>;
}

function SlotHeader({ view, side, onMove }: { view: View; side: Side; onMove: () => void }) {
    const btn = 'rounded bg-neutral-800 px-2 py-1 text-sm leading-none text-neutral-300 hover:bg-neutral-700';
    let button: React.ReactNode = null;
    if (side === 'left') {
        button = <button type="button" onClick={onMove} title="Expand to main area" aria-label={'Expand ' + TITLES[view] + ' to the main area'} className={'ml-auto ' + btn}>→</button>;
    } else if (side === 'right') {
        button = <button type="button" onClick={onMove} title="Expand to main area" aria-label={'Expand ' + TITLES[view] + ' to the main area'} className={'ml-auto ' + btn}>←</button>;
    } else if (view !== 'bench') {
        // Center holds a displaced view: arrow points back toward its home side.
        const home = HOME[view];
        button = <button type="button" onClick={onMove} title="Return to sidebar" aria-label={'Return ' + TITLES[view] + ' to its sidebar'} className={'ml-auto ' + btn}>{home === 'left' ? '←' : '→'}</button>;
    }
    return (
        <div className="flex items-center gap-2 border-b border-neutral-800 pb-2">
            <h2 className="text-sm font-bold uppercase tracking-wider text-neutral-300">{TITLES[view]}</h2>
            <span className="text-[10px] uppercase tracking-wide text-neutral-600">{side === 'center' ? 'main' : 'sidebar'}</span>
            {button}
        </div>
    );
}

function EngineStatusBanner() {
    const { state, connected } = useServer();
    if (!state) {
        return (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                {connected
                    ? <span className="text-neutral-300">Connected — waiting for first status…</span>
                    : <span className="text-amber-400">Connecting to server…</span>}
            </div>
        );
    }
    const timing = state.finalLoadTime ? ' · loaded in ' + String(state.finalLoadTime) + 's' : '';
    const model = state.model ? ' · ' + state.model : '';
    const color = state.state === 'ready' ? 'text-emerald-400'
        : state.state === 'stopped' ? 'text-neutral-400'
            : 'text-amber-400';
    return (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <span className={color}>Engine: {state.state}{timing}{model}</span>
            {state.error && <span role="alert" className="text-red-400">{state.error}</span>}
        </div>
    );
}

export default function App() {
    const [slots, setSlots] = useState<Slots>(loadSlots);
    const { config } = useServer();
    const onMessage = useCallback((data: string) => { applySseFrame(data); }, []);
    const { connected } = useSse('/api/status', onMessage);
    useEffect(() => { setSseConnected(connected); }, [connected]);
    useEffect(() => {
        api<ConfigResponse>('/api/config').then(setServerConfig).catch(() => {});
    }, []);
    useEffect(() => {
        try { window.localStorage.setItem('layout_slots', JSON.stringify(slots)); } catch { /* storage unavailable */ }
    }, [slots]);

    const expandSide = (side: 'left' | 'right') => setSlots(old => swapWithCenter(old, side));
    const collapseCenter = () => setSlots(old => swapWithCenter(old, HOME[old.center] === 'right' ? 'right' : 'left'));

    return (
        <div className="min-h-screen bg-neutral-950 text-slate-100">
            <header className="border-b border-neutral-800 bg-neutral-900/90">
                <nav className="flex flex-wrap items-center gap-2 px-4 py-3">
                    <span className="mr-2 text-sm font-semibold tracking-wide text-neutral-300">Mission Control</span>
                    <div className="ml-auto flex items-center gap-3 text-xs text-neutral-500">
                        {config && (
                            <>
                                <span>worker {config.worker.enabled ? 'on' : 'off'}</span>
                                <span>telemetry {config.telemetry.enabled ? 'on' : 'off'}</span>
                                <span>{config.llama.builds.length} build{config.llama.builds.length === 1 ? '' : 's'}</span>
                            </>
                        )}
                        <span className={connected ? 'text-emerald-500' : 'text-amber-500'}>{connected ? 'connected' : 'connecting'}</span>
                    </div>
                </nav>
            </header>
            <section className="border-b border-neutral-800 bg-neutral-900 px-4 py-2" aria-live="polite">
                <EngineStatusBanner />
            </section>
            <main className="grid gap-4 px-4 py-4 lg:grid-cols-[26rem_minmax(0,1fr)_26rem] lg:items-start">
                {/* Keyed by view, not slot: React keeps each panel mounted (charts,
                    buffers, form state intact) and only its grid position changes. */}
                {VIEWS.map(view => {
                    const side = SIDES.find(s => slots[s] === view) as Side;
                    const onMove = side === 'center' ? collapseCenter : () => expandSide(side);
                    const sidebar = side !== 'center';
                    // Explicit row+column: DOM order differs from visual order after a
                    // swap, and grid auto-placement would push later DOM items to row 2.
                    const placement = side === 'left' ? 'lg:col-start-1 lg:row-start-1' : side === 'center' ? 'lg:col-start-2 lg:row-start-1' : 'lg:col-start-3 lg:row-start-1';
                    return (
                        <section
                            key={view}
                            aria-label={TITLES[view] + (sidebar ? ' sidebar' : ' main area')}
                            className={
                                'min-w-0 space-y-4 ' + placement
                                + (sidebar ? ' lg:sticky lg:top-4 lg:max-h-[calc(100dvh-2rem)] lg:overflow-y-auto lg:pr-1' : '')
                            }
                        >
                            <SlotHeader view={view} side={side} onMove={onMove} />
                            <ViewContent view={view} />
                        </section>
                    );
                })}
            </main>
        </div>
    );
}
