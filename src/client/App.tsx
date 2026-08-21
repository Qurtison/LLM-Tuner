// App shell (Phase 5 slice 1): navigation, engine status banner, error
// surface, and the single SSE owner. Panels come from features/index.ts;
// each tab renders its slice components (docs/p5-slices.md).
import { useCallback, useEffect, useRef, useState } from 'react';
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
} from './features';

const TABS = ['interactive', 'monitor', 'history', 'bench'] as const;
type Tab = (typeof TABS)[number];
const TAB_LABELS: Record<Tab, string> = { interactive: 'Interactive', monitor: 'Monitor', history: 'History', bench: 'Bench' };

function loadTab(): Tab {
    try {
        const saved = window.localStorage.getItem('active_tab');
        return TABS.includes(saved as Tab) ? (saved as Tab) : 'interactive';
    } catch {
        return 'interactive';
    }
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
    const [tab, setTab] = useState<Tab>(loadTab);
    const tabsRef = useRef<HTMLDivElement>(null);
    const { config } = useServer();
    const onMessage = useCallback((data: string) => { applySseFrame(data); }, []);
    const { connected } = useSse('/api/status', onMessage);
    useEffect(() => { setSseConnected(connected); }, [connected]);
    useEffect(() => {
        api<ConfigResponse>('/api/config').then(setServerConfig).catch(() => {});
    }, []);

    const selectTab = (next: Tab) => {
        setTab(next);
        try { window.localStorage.setItem('active_tab', next); } catch { /* storage unavailable */ }
    };

    const onKeyDown = (event: React.KeyboardEvent) => {
        const idx = TABS.indexOf(tab);
        let next: number | null = null;
        if (event.key === 'ArrowRight') next = (idx + 1) % TABS.length;
        else if (event.key === 'ArrowLeft') next = (idx - 1 + TABS.length) % TABS.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = TABS.length - 1;
        if (next === null) return;
        event.preventDefault();
        const target = TABS[next];
        selectTab(target);
        tabsRef.current?.querySelector<HTMLButtonElement>('button[data-tab="' + target + '"]')?.focus();
    };

    return (
        <div className="min-h-screen bg-neutral-950 text-slate-100">
            <header className="border-b border-neutral-800 bg-neutral-900/90">
                <nav className="mx-auto flex max-w-7xl flex-wrap items-center gap-2 px-4 py-3">
                    <span className="mr-2 text-sm font-semibold tracking-wide text-neutral-300">Mission Control</span>
                    <div ref={tabsRef} role="tablist" aria-label="Dashboard sections" onKeyDown={onKeyDown} className="flex gap-1">
                        {TABS.map(name => (
                            <button
                                key={name}
                                type="button"
                                role="tab"
                                data-tab={name}
                                id={'tab-' + name}
                                aria-selected={tab === name}
                                aria-controls={'panel-' + name}
                                tabIndex={tab === name ? 0 : -1}
                                onClick={() => selectTab(name)}
                                className={
                                    tab === name
                                        ? 'rounded bg-neutral-700 px-3 py-1.5 text-sm font-medium text-white'
                                        : 'rounded px-3 py-1.5 text-sm text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'
                                }
                            >
                                {TAB_LABELS[name]}
                            </button>
                        ))}
                    </div>
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
                <div className="mx-auto max-w-7xl"><EngineStatusBanner /></div>
            </section>
            <main className="mx-auto max-w-7xl px-4 py-4">
                {tab === 'interactive' && (
                    <div role="tabpanel" id="panel-interactive" aria-labelledby="tab-interactive" className="grid gap-4 lg:grid-cols-[2fr,1fr]">
                        <InteractivePanel />
                        <ChatPanel />
                    </div>
                )}
                {tab === 'monitor' && (
                    <div role="tabpanel" id="panel-monitor" aria-labelledby="tab-monitor" className="space-y-4">
                        <MonitorPanel />
                        <LiveRequestsPanel />
                    </div>
                )}
                {tab === 'history' && (
                    <div role="tabpanel" id="panel-history" aria-labelledby="tab-history"><HistoryPanel /></div>
                )}
                {tab === 'bench' && (
                    <div role="tabpanel" id="panel-bench" aria-labelledby="tab-bench"><BenchPanel /></div>
                )}
            </main>
        </div>
    );
}
