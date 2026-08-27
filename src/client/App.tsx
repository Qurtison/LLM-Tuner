// App shell: a stack of registered panels. Layout (order, collapsed,
// hidden) is per-user, persisted in localStorage. Users open the
// "Panels" menu in the header to add/remove panels and drag the
// "⋮⋮" handle to reorder. ⌘K opens the preset browser overlay.
import { useCallback, useEffect } from 'react';
import { useSse } from './hooks/useSse';
import { useServer, applySseFrame, setSseConnected, setServerConfig } from './state/server';
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
            <section className="border-b border-neutral-800 bg-neutral-900 px-4 py-2" aria-live="polite">
                <EngineStatusBanner />
            </section>
            <main className="px-2 py-4">
                <PanelCanvas />
            </main>
            <PresetBrowserMount />
        </div>
    );
}
