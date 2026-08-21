import { useCallback, useEffect, useState } from 'react';
import { api } from './api/client';
import { useSse } from './hooks/useSse';
import type { ConfigResponse, SseStatePayload } from '../../shared/contracts';

const tabs = ['Interactive', 'Monitor', 'History', 'Bench'];
export default function App() {
  const [config, setConfig] = useState<ConfigResponse>();
  const [configError, setConfigError] = useState('');
  const [status, setStatus] = useState<SseStatePayload>();
  const onMessage = useCallback((data: string) => { try { setStatus(JSON.parse(data) as SseStatePayload); } catch { /* Ignore malformed SSE payload. */ } }, []);
  const { connected } = useSse('/api/status', onMessage);
  useEffect(() => { api<ConfigResponse>('/api/config').then(setConfig).catch((error: unknown) => setConfigError(error instanceof Error ? error.message : 'Config request failed')); }, []);
  return <div className="min-h-screen text-slate-100">
    <header className="border-b border-slate-700 bg-slate-900/90"><nav className="mx-auto flex max-w-6xl gap-2 px-4 py-3" aria-label="Dashboard sections">{tabs.map((tab) => <button key={tab} type="button" disabled className="rounded px-3 py-2 text-sm font-medium text-slate-500 disabled:cursor-not-allowed">{tab}</button>)}</nav></header>
    <section className="border-b border-slate-800 bg-slate-900 px-4 py-3 text-sm" aria-live="polite"><div className="mx-auto flex max-w-6xl flex-wrap gap-x-5 gap-y-1">
      {config ? <><span>Worker: {config.worker.enabled ? 'enabled' : 'disabled'}</span><span>Telemetry: {config.telemetry.enabled ? 'enabled' : 'disabled'}</span><span>Builds: {config.llama.builds.length}</span></> : <span>{configError ? 'Config error: ' + configError : 'Loading config…'}</span>}
      <span>SSE: {connected ? 'connected' : 'connecting'}{status ? ' · ' + status.state + ' · ' + (status.model || 'no model') + (status.error ? ' · ' + status.error : '') : ''}</span>
    </div></section>
    <main className="mx-auto max-w-6xl px-4 py-10">{tabs.map((tab) => <section key={tab} className="hidden first:block" aria-label={tab}><h1 className="text-2xl font-semibold">{tab}</h1><p className="mt-3 text-slate-400">Coming in Phase 5.</p></section>)}</main>
  </div>;
}
