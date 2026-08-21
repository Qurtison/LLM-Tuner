import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import { onSseLine, useServer } from '../../state/server';
import type { WorkerLogsResponse, WorkerStartStopResponse, WorkerStatusResponse } from '../../../../shared/contracts';

type WorkerState = 'disabled' | 'checking' | 'running' | 'stopped' | 'offline' | 'error' | 'starting' | 'stopping' | 'start failed' | 'stop failed';

const badgeClasses: Record<WorkerState, string> = {
    disabled: 'bg-neutral-800 text-neutral-500',
    checking: 'animate-pulse border border-amber-800 bg-amber-900/20 text-amber-400',
    running: 'border border-emerald-800 bg-emerald-900/20 text-emerald-400',
    stopped: 'border border-amber-800 bg-amber-900/20 text-amber-400',
    offline: 'border border-red-800 bg-red-900/20 text-red-400',
    error: 'border border-red-800 bg-red-900/20 text-red-400',
    starting: 'animate-pulse border border-amber-800 bg-amber-900/20 text-amber-400',
    stopping: 'animate-pulse border border-amber-800 bg-amber-900/20 text-amber-400',
    'start failed': 'border border-red-800 bg-red-900/20 text-red-400',
    'stop failed': 'border border-red-800 bg-red-900/20 text-red-400',
};

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export default function WorkerPanel() {
    const { config, state } = useServer();
    const enabled = config?.worker.enabled ?? false;
    const [sshHost, setSshHost] = useState('');
    const [status, setStatus] = useState<WorkerState>('disabled');
    const [statusError, setStatusError] = useState('');
    const [operationError, setOperationError] = useState('');
    const [logsOpen, setLogsOpen] = useState(false);
    const [logs, setLogs] = useState('No logs fetched yet.');
    const pollActive = useRef(false);

    useEffect(() => {
        if (config?.worker.sshHost) setSshHost(current => current || config.worker.sshHost);
    }, [config]);

    useEffect(() => onSseLine(line => {
        if (line.startsWith('WORKER:')) setOperationError(line.slice('WORKER:'.length).trim());
    }), []);

    useEffect(() => {
        if (!enabled) {
            setStatus('disabled');
            setStatusError('Worker support disabled by server configuration.');
            return;
        }
        if (!sshHost.trim()) {
            setStatus('disabled');
            setStatusError('Enter worker SSH host.');
            return;
        }
        let live = true;
        const check = async () => {
            if (pollActive.current) return;
            pollActive.current = true;
            try {
                const result = await api<WorkerStatusResponse>('/api/worker/status', {
                    method: 'POST', body: JSON.stringify({ worker_ssh: sshHost.trim() }),
                });
                if (!live) return;
                setStatus(result.status);
                setStatusError(result.status === 'offline' ? result.error : '');
            } catch (error) {
                if (!live) return;
                setStatus('error');
                setStatusError(message(error));
            } finally {
                pollActive.current = false;
            }
        };
        void check();
        const interval = window.setInterval(() => { void check(); }, 5_000);
        return () => { live = false; window.clearInterval(interval); };
    }, [enabled, sshHost]);

    useEffect(() => {
        if (!logsOpen || !enabled || !sshHost.trim()) return;
        let live = true;
        const fetchLogs = async () => {
            try {
                const result = await api<WorkerLogsResponse>('/api/worker/logs', {
                    method: 'POST', body: JSON.stringify({ worker_ssh: sshHost.trim() }),
                });
                if (live) setLogs(result.logs || 'No logs returned.');
            } catch (error) {
                if (live) setLogs('Failed to fetch logs: ' + message(error));
            }
        };
        void fetchLogs();
        const interval = window.setInterval(() => { void fetchLogs(); }, 3_000);
        return () => { live = false; window.clearInterval(interval); };
    }, [enabled, logsOpen, sshHost]);

    const run = async (action: 'start' | 'stop') => {
        const worker_ssh = sshHost.trim();
        if (!worker_ssh) {
            setOperationError('Enter worker SSH host.');
            return;
        }
        setOperationError('');
        setStatus(action === 'start' ? 'starting' : 'stopping');
        try {
            const result = await api<WorkerStartStopResponse>('/api/worker/' + action, {
                method: 'POST', body: JSON.stringify({ worker_ssh }),
            });
            if (!result.success) {
                setStatus(action + ' failed' as WorkerState);
                setOperationError(result.error);
                if (action === 'start') setLogs('Start failed:\n' + result.error);
                return;
            }
            setStatus(action === 'start' ? 'running' : 'stopped');
            if (logsOpen && action === 'start') setLogs('Loading worker logs…');
        } catch (error) {
            setStatus(action + ' failed' as WorkerState);
            setOperationError(message(error));
            if (action === 'start') setLogs('Start failed: ' + message(error));
        }
    };

    const label = status === 'start failed' ? 'START FAILED' : status === 'stop failed' ? 'STOP FAILED' : status.toUpperCase() + (status === 'starting' || status === 'stopping' ? '…' : '');
    const busy = status === 'starting' || status === 'stopping';
    const unavailable = !enabled || !sshHost.trim() || busy;

    return (
        <section className="space-y-3 rounded-lg border border-neutral-700/50 bg-neutral-900/50 p-3" aria-label="Worker controls">
            <div className="flex items-center justify-between gap-3">
                <h2 className="text-xs font-bold uppercase tracking-wider text-neutral-500">RPC Worker</h2>
                <span className={'rounded px-1.5 py-0.5 text-[10px] font-semibold ' + badgeClasses[status]}>{label}</span>
            </div>
            <label className="block text-xs text-neutral-400">Worker SSH host
                <input value={sshHost} onChange={event => setSshHost(event.target.value)} disabled={!enabled} placeholder="user@host" className="mt-1 w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 font-mono text-xs text-neutral-200 disabled:cursor-not-allowed disabled:opacity-50" />
            </label>
            <div className={!enabled ? 'space-y-2 opacity-50' : 'space-y-2'}>
                <p className="text-[11px] text-neutral-400">Transport presets: {config?.worker.transportPresets.map(preset => preset.label).join(', ') || 'Loading…'}</p>
                <div className="flex gap-2">
                    <button type="button" onClick={() => { void run('start'); }} disabled={unavailable || status === 'running'} className="flex-1 rounded bg-indigo-600 px-2 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50">Start Worker</button>
                    <button type="button" onClick={() => { void run('stop'); }} disabled={unavailable || status === 'stopped'} className="flex-1 rounded bg-red-900/30 px-2 py-1.5 text-xs font-medium text-red-400 hover:bg-red-900/50 disabled:cursor-not-allowed disabled:opacity-50">Stop</button>
                </div>
            </div>
            {(!enabled || statusError || operationError || state?.error) && <p role="alert" className="text-xs text-red-400">{!enabled ? 'Worker support disabled by server configuration.' : operationError || statusError || state?.error}</p>}
            <div className="overflow-hidden rounded border border-neutral-700/50 bg-neutral-800/50">
                <button type="button" onClick={() => setLogsOpen(open => !open)} aria-expanded={logsOpen} aria-controls="worker-logs" className="flex w-full items-center justify-between px-3 py-2 text-xs font-semibold text-neutral-300 hover:bg-neutral-800">
                    <span><span className="mr-2 text-red-400">●</span>Worker Logs</span><span>{logsOpen ? '▼' : '▶'}</span>
                </button>
                {logsOpen && <pre id="worker-logs" className="max-h-80 overflow-auto whitespace-pre-wrap select-text bg-neutral-950/50 px-3 py-2 font-mono text-[10px] text-neutral-400">{enabled ? logs : 'Worker support disabled by server configuration.'}</pre>}
            </div>
        </section>
    );
}
