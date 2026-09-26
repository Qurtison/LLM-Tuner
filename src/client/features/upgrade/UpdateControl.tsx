/*
 * Update control: a header chip next to the build count that says "update"
 * when the local llama.cpp checkout is behind origin/master, plus the modal
 * that runs git pull + cmake build.
 *
 * The modal owns the run: it holds the overlay open until the build finishes
 * (Escape/backdrop/X are inert while building, because a build that loses
 * its reader still runs server-side and nobody would see the result). After a
 * successful build, closing asks whether to relaunch llama-server so the new
 * binary is the one serving requests.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import { useServer } from '../../state/server';
import type { UpgradeStatusResponse } from '../../../../shared/contracts';

const POLL_MS = 15 * 60_000;

type Phase = 'idle' | 'running' | 'done' | 'failed';

function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function phaseLabel(phase: Phase, action: string): string {
    if (phase === 'running') return 'Building…';
    if (phase === 'done') return 'Build again';
    return action;
}

function logPlaceholder(phase: Phase, hasLogs: boolean): string {
    if (hasLogs) return '';
    if (phase === 'running') return 'Starting…';
    return 'No upgrade run yet.';
}

function chipLabel(running: boolean, behind: number): string {
    if (running) return 'Building…';
    return behind > 0 ? 'update' : 'up to date';
}

function summaryLine(configured: boolean, behind: number, remote: string, head: string): string {
    if (!configured) return 'Upgrade is not configured. Set upgrade.repoDir and upgrade.buildDir in the server config.';
    if (behind <= 0) return head ? `Already at ${remote} (${head})` : `Already at ${remote}`;
    const commits = `${behind} commit${behind === 1 ? '' : 's'} behind ${remote}`;
    return head ? `${commits} (at ${head})` : commits;
}

export default function UpdateControl() {
    const { state } = useServer();
    const [open, setOpen] = useState(false);
    const [status, setStatus] = useState<UpgradeStatusResponse | null>(null);
    const [phase, setPhase] = useState<Phase>('idle');
    const [logs, setLogs] = useState<string[]>([]);
    const [error, setError] = useState('');
    const [confirm, setConfirm] = useState(false);
    const [restarting, setRestarting] = useState(false);
    const boxRef = useRef<HTMLPreElement>(null);
    const esRef = useRef<EventSource | null>(null);
    // True while /api/upgrade/stream is ours, so the status poll does not treat
    // our own run as someone else's finished one.
    const ownRunRef = useRef(false);
    // The stop->start wait below is a poll over server state, which arrives
    // through the shared SSE store: read it through a ref so the poller sees
    // fresh broadcasts instead of the render that started the restart.
    const stateRef = useRef(state);
    stateRef.current = state;

    const refresh = useCallback(async (force: boolean) => {
        try {
            const suffix = force ? '?refresh=1' : '';
            setStatus(await api<UpgradeStatusResponse>(`/api/upgrade/status${suffix}`));
        } catch { /* server absent -> no chip */ }
    }, []);

    useEffect(() => {
        void refresh(false);
        const timer = setInterval(() => void refresh(false), POLL_MS);
        return () => clearInterval(timer);
    }, [refresh]);

    useEffect(() => {
        const el = boxRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [logs]);

    useEffect(() => () => esRef.current?.close(), []);

    // Close only when a build is not in flight; a finished build asks first.
    function requestClose() {
        if (phase === 'running') return;
        if (phase === 'done') { setConfirm(true); return; }
        setOpen(false);
    }

    useEffect(() => {
        if (!open) return;
        const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && phase !== 'running') requestClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    });

    function start() {
        setError('');
        setLogs([]);
        setConfirm(false);
        setPhase('running');
        ownRunRef.current = true;
        const es = new EventSource('/api/upgrade/stream');
        esRef.current = es;
        es.onmessage = (event) => {
            const line = event.data;
            if (line.startsWith('UPGRADE_DONE')) {
                setPhase('done');
                es.close();
                esRef.current = null;
                void refresh(true);
                return;
            }
            if (line.startsWith('UPGRADE_FAILED')) {
                setPhase('failed');
                setError(line.slice('UPGRADE_FAILED '.length));
                es.close();
                esRef.current = null;
                return;
            }
            setLogs(prev => [...prev, line].slice(-3000));
        };
        es.onerror = () => {
            // A transient drop auto-reconnects; only a closed socket is fatal
            // (the server refused the run, e.g. upgrade not configured).
            if (es.readyState === EventSource.CLOSED) {
                setPhase('failed');
                setError('Upgrade stream failed (is upgrade enabled in server config?)');
                esRef.current = null;
            }
        };
    }

    // A run already in flight (another tab, or before this one mounted) is
    // adopted: 409 means the server has it, so show its log rather than
    // pretending there is nothing to wait for.
    useEffect(() => {
        if (!open || !status?.running || phase !== 'idle' || esRef.current) return;
        setPhase('running');
        setError('An upgrade is already running on the server.');
        const timer = setInterval(() => void refresh(false), 5000);
        return () => clearInterval(timer);
    }, [open, status?.running, phase, refresh]);

    // An adopted run (started elsewhere) has no stream of ours to announce its
    // end, so the status poll closes it out. Our own run is left to its stream.
    useEffect(() => {
        if (phase !== 'running' || !status || status.running || esRef.current || ownRunRef.current) return;
        setPhase('done');
        void refresh(true);
    }, [phase, status, refresh]);

    async function relaunch() {
        const config = stateRef.current?.launchConfig;
        if (!config) { setConfirm(false); setOpen(false); return; }
        setRestarting(true);
        setError('');
        try {
            await api('/api/stop', { method: 'POST', body: '{}' });
            // /api/start is rejected while the child is still up, so wait for
            // the state broadcast to say stopped.
            await new Promise<void>((resolve, reject) => {
                const deadline = Date.now() + 20_000;
                const poll = () => {
                    if (stateRef.current?.state === 'stopped') resolve();
                    else if (Date.now() > deadline) reject(new Error('llama-server did not stop in time'));
                    else setTimeout(poll, 400);
                };
                poll();
            });
            await api('/api/start', { method: 'POST', body: JSON.stringify(config) });
            setConfirm(false);
            setOpen(false);
            setPhase('idle');
            ownRunRef.current = false;
        } catch (err) {
            setError(`Restart failed: ${errorText(err)}`);
        } finally {
            setRestarting(false);
        }
    }

    const configured = status?.configured === true;
    const behind = status?.behind ?? 0;
    const running = phase === 'running';
    const label = chipLabel(running, behind);
    const chip = behind > 0 && !running
        ? 'border-amber-600/70 bg-amber-950/60 text-amber-300 hover:bg-amber-900/60'
        : 'border-neutral-800 bg-neutral-900 text-neutral-500 hover:text-neutral-300';
    const summary = summaryLine(configured, behind, status?.remote ?? 'origin/master', status?.head ?? '');

    return (
        <>
            <button type="button" onClick={() => setOpen(true)} disabled={!configured}
                title={configured ? 'llama.cpp checkout' : 'upgrade not configured in server config'}
                className={`rounded-full border px-2.5 py-1 text-xs ${chip} disabled:opacity-40`}>
                {label}
            </button>
            {open && (
                <div className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-black/70 p-6" role="presentation">
                    <div role="dialog" aria-modal="true" aria-label="Update llama.cpp"
                        className="w-full max-w-2xl rounded-xl border border-neutral-800 bg-neutral-900 p-4 shadow-xl">
                        <div className="mb-2 flex items-start justify-between gap-3">
                            <div>
                                <h2 className="text-sm font-semibold text-neutral-200">Update llama.cpp</h2>
                                <p className="text-xs text-neutral-500">{summary}</p>
                            </div>
                            <button type="button" onClick={requestClose} disabled={running}
                                aria-label="Close update dialog"
                                className="rounded px-2 py-1 text-xs text-neutral-500 hover:text-neutral-200 disabled:opacity-30">✕</button>
                        </div>
                        {error && <p role="alert" className="mb-2 text-xs text-red-400">{error}</p>}
                        <pre ref={boxRef} className="max-h-72 overflow-auto whitespace-pre-wrap rounded border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-[11px] text-neutral-300">
                            {logs.length ? logs.join('\n') : logPlaceholder(phase, logs.length > 0)}
                        </pre>
                        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                            {running && <span className="mr-auto text-xs text-amber-400">Build in progress — this window stays open until it finishes.</span>}
                            {confirm && <span className="mr-auto text-xs text-neutral-300">Restart llama-server with the new build?</span>}
                            {confirm && (
                                <>
                                    <button type="button" onClick={() => { setConfirm(false); setOpen(false); }} className="rounded bg-neutral-800 px-3 py-1.5 text-xs text-neutral-300">Later</button>
                                    <button type="button" onClick={() => void relaunch()} disabled={restarting} className="rounded bg-indigo-600 px-3 py-1.5 text-xs text-white disabled:opacity-50">{restarting ? 'Restarting…' : 'Restart now'}</button>
                                </>
                            )}
                            {!confirm && (
                                <>
                                    <button type="button" onClick={requestClose} disabled={running} className="rounded bg-neutral-800 px-3 py-1.5 text-xs text-neutral-300 disabled:opacity-40">{phase === 'done' ? 'Close' : 'Cancel'}</button>
                                    <button type="button" onClick={start} disabled={!configured || running} className="rounded bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
                                        {phaseLabel(phase, 'Pull + Build')}
                                    </button>
                                </>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
