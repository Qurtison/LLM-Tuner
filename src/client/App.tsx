// App shell: a stack of registered panels. Layout (order, collapsed,
// hidden) is per-user, persisted in localStorage. Users open the
// "Panels" menu in the header to add/remove panels and drag the
// "⋮⋮" handle to reorder. ⌘K opens the preset browser overlay.
import { useCallback, useEffect, useState } from 'react';
import { useSse } from './hooks/useSse';
import { useServer, applySseFrame, setSseConnected, setServerConfig, onSseLine } from './state/server';
import { presetBrowser } from './state/presetBrowser';
import { api } from './api/client';
import type { ConfigResponse } from '../../shared/contracts';
import { ChatPanel } from './features';
import { MonitorPanel, LiveRequestsPanel, HistoryPanel, BenchPanel, OverviewPanel, FileBrowserPanel, UpgradePanel, LogsPanel, PresetDock, PresetBrowserDialog } from './features';
import LaunchBar from './features/interactive/LaunchBar';
import RpcWorkerPanel from './features/interactive/RpcWorkerPanel';
import { PanelCanvas, PanelVisibilityMenu, registerPanel } from './components/panels';

registerPanel('chat', 'Chat', () => <ChatPanel />);
registerPanel('preset-dock', 'Preset Inspector', () => <PresetDock />);
registerPanel('launch-bar', 'Launch Bar', () => <LaunchBar />);
registerPanel('rpc-worker', 'RPC Worker', () => <RpcWorkerPanel />);
registerPanel('overview', 'Overview', () => <OverviewPanel />);
registerPanel('monitor', 'Monitor', () => <MonitorPanel />);
registerPanel('logs', 'Logs', () => <LogsPanel />);
registerPanel('live-requests', 'Live Requests', () => <LiveRequestsPanel />);
registerPanel('history', 'History', () => <HistoryPanel />);
registerPanel('bench', 'Bench', () => <BenchPanel />);
registerPanel('upgrade', 'Upgrade', () => <UpgradePanel />);
registerPanel('files', 'File Browser', () => <FileBrowserPanel />);

// Compact engine state pill for the header. Hover/focus shows the detail
// that used to sit inline (model, load time, start time, last error).
function EngineStatusChip() {
    const { state, connected } = useServer();
    const label = !state
        ? (connected ? 'Waiting' : 'Connecting')
        : state.state === 'ready' ? 'Running'
            : state.state === 'stopped' ? 'Stopped'
                : state.state === 'stopping' ? 'Stopping'
                    : 'Starting';
    const dot = !state ? 'bg-neutral-600'
        : state.state === 'ready' ? 'bg-emerald-400'
            : state.state === 'stopped' ? 'bg-neutral-500'
                : 'animate-pulse bg-amber-400';
    const detail = state ? [
        state.model ? 'Model ' + state.model : null,
        state.finalLoadTime > 0 ? 'Loaded in ' + state.finalLoadTime + 's' : null,
        state.loadStartTime > 0 ? 'Started ' + new Date(state.loadStartTime).toLocaleTimeString() : null,
        state.error ? 'Error ' + state.error : null,
    ].filter((line): line is string => line !== null) : [];
    return (
        <span className="group relative mr-3">
            <button type="button" aria-label={'Engine ' + label + (detail.length ? ' — ' + detail.join(', ') : '')}
                className="flex items-center gap-1.5 rounded-full border border-neutral-800 bg-neutral-950 px-2.5 py-1 text-xs text-neutral-300 hover:border-neutral-600">
                <span className={'h-1.5 w-1.5 rounded-full ' + dot} />
                {label}
            </button>
            {detail.length > 0 && (
                <span role="tooltip" className="pointer-events-none absolute left-0 top-full z-20 mt-1 hidden w-max max-w-96 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs text-neutral-300 shadow-lg group-hover:block group-focus-within:block">
                    {detail.map(line => <span key={line} className="block whitespace-pre-wrap break-words">{line}</span>)}
                </span>
            )}
        </span>
    );
}

// Always-visible activity strip (where the old engine banner lived): live
// prefill progress + generation tokens, plus the context usage moved out of
// the Monitor panel. Hides when no prefill is active — prefill parked at
// 100% counts as settled after 3s.
function ActivityBar() {
    const { progress } = useServer();
    const [context, setContext] = useState<{ used: number; limit: number } | null>(null);
    useEffect(() => onSseLine(line => {
        if (!line.startsWith('CTX_LIVE:')) return;
        const [, rawUsed, rawLimit] = line.split(':');
        const used = Number.parseInt(rawUsed, 10); const limit = Number.parseInt(rawLimit, 10);
        if (Number.isFinite(used) && Number.isFinite(limit) && limit > 0) setContext({ used, limit });
    }), []);
    const prefill = progress?.prefill ?? null;
    const gen = progress?.gen ?? null;
    const at100 = prefill !== null && prefill.progress >= 0.999;
    const [settled, setSettled] = useState(false);
    useEffect(() => {
        if (!at100) { setSettled(false); return; }
        const timer = window.setTimeout(() => setSettled(true), 3000);
        return () => window.clearTimeout(timer);
    }, [at100]);
    if (prefill === null || settled) return null;
    const pct = Math.min(Math.max(prefill.progress * 100, 0), 100);
    const ctxPct = context ? Math.min(context.used / context.limit * 100, 100) : null;
    return (
        <section className="border-b border-neutral-800 bg-neutral-900 px-4 py-2" aria-live="polite">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs">
                <span className="flex items-center gap-2">
                    <span className="text-neutral-500">Prefill</span>
                    <span className="h-1.5 w-40 overflow-hidden rounded bg-neutral-800"><span className="block h-full bg-indigo-500" style={{ width: pct + '%' }} /></span>
                    <span className="font-mono text-neutral-300">{pct.toFixed(0)}% · {prefill.tokens.toLocaleString()} tok · {prefill.tps} t/s</span>
                </span>
                {gen && (
                    <span className="flex items-center gap-2">
                        <span className="text-neutral-500">Gen</span>
                        <span className="font-mono text-neutral-300">{gen.tokens.toLocaleString()} tok · {gen.tps} t/s</span>
                    </span>
                )}
                {context && (
                    <span className="flex items-center gap-2">
                        <span className="text-neutral-500">Context</span>
                        <span className="h-1.5 w-24 overflow-hidden rounded bg-neutral-800"><span className="block h-full bg-indigo-400" style={{ width: (ctxPct ?? 0) + '%' }} /></span>
                        <span className="font-mono text-neutral-300">{context.used.toLocaleString()} / {context.limit.toLocaleString()} · {(ctxPct ?? 0).toFixed(0)}%</span>
                    </span>
                )}
            </div>
        </section>
    );
}

function PresetBrowserMount() {
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            const isK = event.key === 'k' || event.key === 'K';
            const cmd = event.metaKey || event.ctrlKey;
            if (cmd && isK) { event.preventDefault(); presetBrowser.setOpen(true); }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);
    return <PresetBrowserDialog onClose={() => presetBrowser.setOpen(false)} />;
}

export default function App() {
    const { config } = useServer();
    const onMessage = useCallback((data: string) => { applySseFrame(data); }, []);
    const { connected } = useSse('/api/status', onMessage);
    useEffect(() => { setSseConnected(connected); }, [connected]);
    useEffect(() => { api<ConfigResponse>('/api/config').then(setServerConfig).catch(() => {}); }, []);

    return (
        <div className="min-h-screen bg-neutral-950 text-slate-100">
            <header className="border-b border-neutral-800 bg-neutral-900/90">
                <nav className="flex flex-wrap items-center gap-2 px-4 py-3">
                    <span className="mr-2 text-sm font-semibold tracking-wide text-neutral-300">Mission Control</span>
                    <EngineStatusChip />
                    <div className="ml-auto flex items-center gap-3 text-xs text-neutral-500">
                        {config && (
                            <>
                                <span>worker {config.worker.enabled ? 'on' : 'off'}</span>
                                <span>telemetry {config.telemetry.enabled ? 'on' : 'off'}</span>
                                <span>{config.llama.builds.length} build{config.llama.builds.length === 1 ? '' : 's'}</span>
                            </>
                        )}
                        <span className={connected ? 'text-emerald-500' : 'text-amber-500'}>{connected ? 'connected' : 'connecting'}</span>
                        <PanelVisibilityMenu />
                    </div>
                </nav>
            </header>
            <ActivityBar />
            <main className="px-2 py-4">
                <PanelCanvas />
            </main>
            <PresetBrowserMount />
        </div>
    );
}
