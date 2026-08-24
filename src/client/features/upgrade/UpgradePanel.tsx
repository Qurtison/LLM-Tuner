// llama.cpp build/upgrade panel (gap G3, docs/gap-analysis.md). Streams the
// git-pull + build run from /api/upgrade/stream over EventSource; disabled
// until the server config enables upgrade (repoDir/buildDir set).
import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import type { UpgradeStatusResponse } from '../../../../shared/contracts';

export default function UpgradePanel() {
    const [running, setRunning] = useState(false);
    const [logs, setLogs] = useState<string[]>([]);
    const [enabled, setEnabled] = useState(true);
    const [error, setError] = useState('');
    const boxRef = useRef<HTMLPreElement>(null);

    const checkStatus = async () => {
        try {
            const result = await api<UpgradeStatusResponse>('/api/upgrade/status');
            setRunning(result.running);
        } catch { /* server absent -> panel stays inert */ }
    };

    useEffect(() => { void checkStatus(); }, []);

    useEffect(() => {
        const el = boxRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [logs]);

    const start = () => {
        setError('');
        setLogs([]);
        setRunning(true);
        const es = new EventSource('/api/upgrade/stream');
        es.onmessage = (event) => {
            const line = event.data;
            if (line.startsWith('UPGRADE_DONE')) {
                setRunning(false);
                es.close();
                return;
            }
            if (line.startsWith('UPGRADE_FAILED')) {
                setRunning(false);
                setError(line.slice('UPGRADE_FAILED '.length));
                es.close();
                return;
            }
            setLogs(prev => [...prev, line].slice(-3000));
        };
        es.onerror = () => {
            // EventSource auto-reconnects; only surface a real failure when
            // the stream never opened (server refused the upgrade).
            setRunning(false);
            setError('Upgrade stream failed (is upgrade enabled in server config?)');
            es.close();
            setEnabled(false);
        };
    };

    return (
        <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-4" aria-label="Upgrade llama.cpp">
            <div className="mb-2 flex items-center justify-between gap-2">
                <div>
                    <h2 className="text-sm font-semibold text-neutral-200">Upgrade llama.cpp</h2>
                    <p className="text-xs text-neutral-500">git fetch → fast-forward → cmake build (configured build dir). Configure upgrade.repoDir/buildDir in server config to enable.</p>
                </div>
                <button type="button" onClick={start} disabled={running || !enabled}
                    className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50">
                    {running ? 'Upgrading…' : 'Pull + Build'}
                </button>
            </div>
            {error && <p role="alert" className="mb-2 text-xs text-red-400">{error}</p>}
            <pre ref={boxRef} className="max-h-64 overflow-auto whitespace-pre-wrap rounded border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-[11px] text-neutral-300">
                {logs.length ? logs.join('\n') : 'No upgrade run yet.'}
            </pre>
        </section>
    );
}
