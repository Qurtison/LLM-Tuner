// Overview panel (gaps G4/G6/G7): server paths, unit status, GPU summary
// (progress-derived prefill/gen + live telemetry cards). Read-only here —
// presets/unit actions live in their own panels.
import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useTelemetryLatest } from '../../hooks/useTelemetry';
import { fmtWithUnit } from '../../lib/format';
import { gpuTitle, stat as gpuStat } from '../../lib/gpu';
import { useServer } from '../../state/server';
import type { ServerPathsResponse, UnitStatus } from '../../../../shared/contracts';

type GpuStats = Record<string, unknown>;

function Stat({ label, value }: { label: string; value: string }) {
    return <div className="flex items-baseline justify-between gap-2 text-xs"><span className="text-neutral-500">{label}</span><span className="truncate font-mono text-neutral-300">{value}</span></div>;
}

function Bar({ pct }: { pct: number }) {
    return <div className="h-1.5 overflow-hidden rounded bg-neutral-800"><div className="h-full bg-indigo-500" style={{ width: Math.min(Math.max(pct, 0), 100) + '%' }} /></div>;
}

function GpuCard({ title, stats, isWorker }: { title: string; stats: GpuStats | null; isWorker: boolean }) {
    const util = gpuStat(stats, 'gpu_util');
    const temp = gpuStat(stats, 'gpu_temp');
    const pwr = gpuStat(stats, 'gpu_pwr');
    const used = gpuStat(stats, 'vram_used');
    const total = gpuStat(stats, 'vram_total');
    const reasons = Array.isArray(stats?.throttle_reasons) ? (stats.throttle_reasons as unknown[]).filter((reason): reason is string => typeof reason === 'string') : [];
    const vramPct = used !== null && total !== null && total > 0 ? used / total * 100 : null;
    return (
        <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
                <h3 className="truncate text-xs font-semibold text-neutral-200">{title}</h3>
                {isWorker && <span className="shrink-0 rounded bg-neutral-800 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-neutral-500">worker</span>}
            </div>
            {!stats ? <p className="text-xs text-neutral-600">No data</p> : (
                <div className="space-y-2">
                    <Stat label="Temp" value={fmtWithUnit(temp, '°C')} />
                    <div>
                        <div className="mb-1 flex justify-between text-xs"><span className="text-neutral-500">Util</span><span className="font-mono text-neutral-300">{fmtWithUnit(util, '%')}</span></div>
                        <Bar pct={util ?? 0} />
                    </div>
                    <Stat label="Power" value={fmtWithUnit(pwr, 'W')} />
                    <div>
                        <div className="mb-1 flex justify-between text-xs"><span className="text-neutral-500">VRAM</span><span className="font-mono text-neutral-300">{fmtWithUnit(used, 'MiB', 0)} / {fmtWithUnit(total, 'MiB', 0)}</span></div>
                        {vramPct !== null && <Bar pct={vramPct} />}
                    </div>
                    {reasons.length > 0 && <p className="text-[10px] text-amber-400">Throttling: {reasons.join(', ')}</p>}
                </div>
            )}
        </div>
    );
}

export default function OverviewPanel() {
    const { progress } = useServer();
    const [paths, setPaths] = useState<ServerPathsResponse | null>(null);
    const [unit, setUnit] = useState<UnitStatus | null>(null);
    const { latest } = useTelemetryLatest(5000);
    const [error] = useState('');

    useEffect(() => {
        let alive = true;
        api<ServerPathsResponse>('/api/server-paths').then(result => { if (alive) setPaths(result); }).catch(() => {});
        api<UnitStatus>('/api/unit/status').then(result => { if (alive) setUnit(result); }).catch(() => {});
        return () => { alive = false; };
    }, []);

    const master = latest?.stats && typeof latest.stats.master === 'object' && latest.stats.master !== null ? latest.stats.master as GpuStats : null;
    const worker = latest?.stats && typeof latest.stats.worker === 'object' && latest.stats.worker !== null && !(latest.stats.worker as GpuStats).nvidia_smi_error && !(latest.stats.worker as GpuStats).amdgpu_top_error ? latest.stats.worker as GpuStats : null;
    const prefill = progress?.prefill ?? null;
    const gen = progress?.gen ?? null;
    const prefillPct = prefill ? Math.min(Math.max(prefill.progress * 100, 0), 100) : null;

    const pathRows = paths ? [
        { label: 'Models', value: paths.modelsDir },
        { label: 'Logs', value: paths.logsDir },
        { label: 'Repo', value: paths.repoDir ?? '—' },
        { label: 'Active build', value: paths.activeBuildDir ?? '—' },
    ] : [];

    return (
        <section className="space-y-4" aria-label="Overview">
            {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
            <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-3">
                <h2 className="text-sm font-bold uppercase tracking-wider text-neutral-300">Server paths</h2>
                <div className="mt-2 space-y-1.5">
                    {paths ? pathRows.map(row => <Stat key={row.label} label={row.label} value={row.value} />)
                        : <p className="text-xs text-neutral-500">Loading…</p>}
                </div>
            </div>
            <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-3">
                <h2 className="text-sm font-bold uppercase tracking-wider text-neutral-300">Unit status</h2>
                <div className="mt-2 space-y-1.5">
                    {unit ? <>
                        <Stat label="State" value={unit.activeState + (unit.subState ? ' (' + unit.subState + ')' : '')} />
                        <Stat label="PID" value={unit.pid !== null ? String(unit.pid) : '—'} />
                        <Stat label="Since" value={unit.since ?? '—'} />
                        <Stat label="Restarts" value={String(unit.restarts)} />
                    </> : <p className="text-xs text-neutral-500">Loading…</p>}
                </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-3">
                    <h2 className="text-sm font-bold uppercase tracking-wider text-neutral-300">Prefill</h2>
                    {prefill ? <div className="mt-2 space-y-1.5">
                        <div className="flex justify-between text-xs"><span className="text-neutral-500">Progress</span><span className="font-mono text-neutral-300">{prefillPct !== null ? prefillPct.toFixed(0) + '%' : '—'}</span></div>
                        <Bar pct={prefillPct ?? 0} />
                        <div className="flex justify-between text-xs"><span className="text-neutral-500">Tokens</span><span className="font-mono text-neutral-300">{prefill.tokens.toLocaleString()}</span></div>
                        <div className="flex justify-between text-xs"><span className="text-neutral-500">Speed</span><span className="font-mono text-neutral-300">{prefill.tps} t/s</span></div>
                    </div> : <p className="mt-2 text-xs text-neutral-600">Idle</p>}
                </div>
                <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-3">
                    <h2 className="text-sm font-bold uppercase tracking-wider text-neutral-300">Generation</h2>
                    {gen ? <div className="mt-2 space-y-1.5">
                        <div className="flex justify-between text-xs"><span className="text-neutral-500">Tokens</span><span className="font-mono text-neutral-300">{gen.tokens.toLocaleString()}</span></div>
                        <div className="flex justify-between text-xs"><span className="text-neutral-500">Speed</span><span className="font-mono text-neutral-300">{gen.tps} t/s</span></div>
                    </div> : <p className="mt-2 text-xs text-neutral-600">Idle</p>}
                </div>
            </div>
            <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-3">
                <h2 className="mb-2 text-sm font-bold uppercase tracking-wider text-neutral-300">GPUs</h2>
                {!master && !worker ? <p className="text-xs text-neutral-600">No GPU telemetry yet</p> : (
                    <div className="grid gap-3 sm:grid-cols-2">
                        {master && <GpuCard title={gpuTitle(master, 'GPU 1')} stats={master} isWorker={false} />}
                        {worker && <GpuCard title={gpuTitle(worker, 'GPU 2')} stats={worker} isWorker={true} />}
                    </div>
                )}
            </div>
        </section>
    );
}
