import { useEffect, useMemo, useRef, useState } from 'react';
import Chart from 'chart.js/auto';
import { api } from '../../api/client';
import { onSseLine, useServer } from '../../state/server';
import type { CompletionEvent, TelemetryLatestResponse, TelemetryRateResponse, TelemetrySample } from '../../../../shared/contracts';

type Stats = Record<string, unknown>;
type Point = { t: number; master: Stats | null; worker: Stats | null; net: number | null };
type MiniMetric = { title: string; key: string; unit: string };

const miniMetrics: MiniMetric[] = [
    { title: 'GPU util', key: 'gpu_util', unit: '%' },
    { title: 'Power', key: 'gpu_pwr', unit: ' W' },
    { title: 'GPU temp', key: 'gpu_temp', unit: ' °C' },
    { title: 'CPU', key: 'cpu_util', unit: '%' },
    { title: 'VRAM', key: 'vram_used', unit: ' MiB' },
];
const throttleLabels: Record<string, string> = { hw_thermal_slowdown: 'HW Thermal', sw_thermal_slowdown: 'SW Thermal', sw_power_cap: 'SW Power Cap', hw_power_brake_slowdown: 'HW Power Brake' };
const thermalReasons = new Set(['hw_thermal_slowdown', 'sw_thermal_slowdown']);

function number(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function stat(stats: Stats | null, key: string): number | null { return stats ? number(stats[key]) : null; }
function text(value: number | null, unit: string): string { return value === null ? '--' + unit : value.toFixed(unit === '%' ? 0 : 1) + unit; }
function labels(points: Point[]): string[] { return points.map(point => new Date(point.t).toLocaleTimeString()); }
function series(points: Point[], from: 'master' | 'worker', key: string): (number | null)[] { return points.map(point => stat(point[from], key)); }
function metricSeries(samples: TelemetrySample[], key: keyof TelemetrySample): (number | null)[] { return samples.map(sample => { const value = sample[key]; return typeof value === 'number' ? value : null; }); }
function chartOptions(compact = false): object {
    return { responsive: true, maintainAspectRatio: false, animation: false, spanGaps: false, plugins: { legend: { display: !compact, labels: { color: '#a3a3a3' } } }, scales: { x: { display: !compact, ticks: { color: '#737373', maxTicksLimit: 6 } }, y: { ticks: { color: '#737373', font: { size: compact ? 8 : 12 } } } } };
}
function vramParts(stats: Stats | null): { used: number | null; free: number | null; total: number | null } {
    const used = stat(stats, 'vram_used');
    const free = stat(stats, 'vram_free');
    const total = stat(stats, 'vram_total') ?? (used !== null && free !== null ? used + free : null);
    return { used, free, total };
}
function MiniChart({ metric, points, smooth }: { metric: MiniMetric; points: Point[]; smooth: boolean }) {
    const canvas = useRef<HTMLCanvasElement>(null);
    const instance = useRef<Chart | null>(null);
    useEffect(() => {
        if (!canvas.current) return;
        const chart = new Chart(canvas.current, { type: 'line', data: { labels: [], datasets: [] }, options: chartOptions(true) });
        instance.current = chart;
        return () => { chart.destroy(); if (instance.current === chart) instance.current = null; };
    }, []);
    useEffect(() => {
        const chart = instance.current;
        if (!chart) return;
        chart.data.labels = labels(points);
        chart.data.datasets = [
            { label: 'Master', data: series(points, 'master', metric.key), borderColor: '#eab308', pointRadius: 0, borderWidth: 1.5, tension: smooth ? 0.35 : 0 },
            { label: 'Worker', data: series(points, 'worker', metric.key), borderColor: '#ef4444', pointRadius: 0, borderWidth: 1.5, tension: smooth ? 0.35 : 0 },
        ];
        chart.update('none');
    }, [metric.key, points, smooth]);
    return <div className="rounded border border-neutral-800 bg-neutral-900 p-2"><p className="mb-1 text-xs text-neutral-400">{metric.title}</p><div className="h-24"><canvas ref={canvas} /></div></div>;
}

export default function MonitorPanel() {
    const { config, completions, progress } = useServer();
    const [points, setPoints] = useState<Point[]>([]);
    const [rate, setRate] = useState(1000);
    const [error, setError] = useState('');
    const [failures, setFailures] = useState(0);
    const [expanded, setExpanded] = useState(false);
    const [smooth, setSmooth] = useState(() => { try { return window.localStorage.getItem('omni_smoothing') === '1'; } catch { return false; } });
    const [context, setContext] = useState<{ used: number; limit: number } | null>(null);
    const [selectedRunId, setSelectedRunId] = useState('');
    const omniCanvas = useRef<HTMLCanvasElement>(null);
    const requestCanvas = useRef<HTMLCanvasElement>(null);
    const expandedCanvas = useRef<HTMLCanvasElement>(null);
    const omniChart = useRef<Chart | null>(null);
    const requestChart = useRef<Chart | null>(null);
    const expandedChart = useRef<Chart | null>(null);
    const inFlight = useRef(false);
    const restoreFocus = useRef<HTMLButtonElement>(null);

    useEffect(() => { if (config?.telemetry.pollMs) setRate(config.telemetry.pollMs); }, [config]);
    useEffect(() => onSseLine(line => {
        if (line.startsWith('PREFILL_PROGRESS:') || line.startsWith('GEN_PROGRESS:')) setError('');
        if (!line.startsWith('CTX_LIVE:')) return;
        const [, rawUsed, rawLimit] = line.split(':');
        const used = Number.parseInt(rawUsed, 10); const limit = Number.parseInt(rawLimit, 10);
        if (Number.isFinite(used) && Number.isFinite(limit) && limit > 0) setContext({ used, limit });
    }), []);
    useEffect(() => { if (!selectedRunId && completions[0]) setSelectedRunId(completions[0].runId); }, [completions, selectedRunId]);
    useEffect(() => {
        if (!omniCanvas.current) return;
        const chart = new Chart(omniCanvas.current, { type: 'line', data: { labels: [], datasets: [] }, options: chartOptions() });
        omniChart.current = chart;
        return () => { chart.destroy(); if (omniChart.current === chart) omniChart.current = null; };
    }, []);
    useEffect(() => {
        if (!requestCanvas.current) return;
        const chart = new Chart(requestCanvas.current, { type: 'line', data: { labels: [], datasets: [] }, options: chartOptions() });
        requestChart.current = chart;
        return () => { chart.destroy(); if (requestChart.current === chart) requestChart.current = null; };
    }, []);
    useEffect(() => {
        if (!expanded || !expandedCanvas.current) return;
        const chart = new Chart(expandedCanvas.current, { type: 'line', data: { labels: [], datasets: [] }, options: chartOptions() });
        expandedChart.current = chart;
        return () => { chart.destroy(); if (expandedChart.current === chart) expandedChart.current = null; };
    }, [expanded]);

    const updateOmni = (chart: Chart | null) => {
        if (!chart) return;
        chart.data.labels = labels(points);
        chart.data.datasets = [
            { label: 'GPU A %', data: series(points, 'master', 'gpu_util'), borderColor: '#eab308', pointRadius: 0 },
            { label: 'GPU B %', data: series(points, 'worker', 'gpu_util'), borderColor: '#ef4444', pointRadius: 0 },
            { label: 'CPU %', data: series(points, 'master', 'cpu_util'), borderColor: '#60a5fa', pointRadius: 0 },
            { label: 'Power W', data: series(points, 'master', 'gpu_pwr'), borderColor: '#f97316', pointRadius: 0 },
            { label: 'Temp °C', data: series(points, 'master', 'gpu_temp'), borderColor: '#facc15', pointRadius: 0 },
            { label: 'VRAM MiB', data: series(points, 'master', 'vram_used'), borderColor: '#a78bfa', pointRadius: 0 },
        ].map(dataset => ({ ...dataset, tension: smooth ? 0.35 : 0 }));
        chart.update('none');
    };
    useEffect(() => { updateOmni(omniChart.current); updateOmni(expandedChart.current); }, [points, smooth, expanded]);
    const selectedCompletion = completions.find(completion => completion.runId === selectedRunId) ?? completions[0] ?? null;
    useEffect(() => {
        const samples = selectedCompletion?.metrics ?? [];
        const chart = requestChart.current;
        if (!chart) return;
        chart.data.labels = samples.map(sample => new Date(sample.t).toLocaleTimeString());
        chart.data.datasets = [
            { label: 'Prefill t/s', data: metricSeries(samples, 'prefillTps'), borderColor: '#eab308', pointRadius: 0 },
            { label: 'Prefill %', data: metricSeries(samples, 'prefillProgress'), borderColor: '#60a5fa', pointRadius: 0 },
            { label: 'Gen t/s', data: metricSeries(samples, 'genTps'), borderColor: '#22c55e', pointRadius: 0 },
        ].map(dataset => ({ ...dataset, tension: smooth ? 0.35 : 0 }));
        chart.update('none');
    }, [selectedCompletion, smooth]);

    useEffect(() => {
        let alive = true;
        const poll = async () => {
            if (inFlight.current) return;
            inFlight.current = true;
            try {
                const result = await api<TelemetryLatestResponse>('/api/telemetry/latest');
                if (!alive) return;
                const stats = result.stats;
                if (!stats || !stats.master || typeof stats.master !== 'object') { setError('No telemetry data.'); return; }
                const master = stats.master as Stats;
                const worker = stats.worker && typeof stats.worker === 'object' && !(stats.worker as Stats).nvidia_smi_error && !(stats.worker as Stats).amdgpu_top_error ? stats.worker as Stats : null;
                setPoints(old => [...old, { t: result.t || Date.now(), master, worker, net: stat(master, 'net_bytes') }].slice(-240));
                setFailures(0); setError('');
            } catch (cause) {
                if (!alive) return;
                setFailures(old => old + 1); setError(cause instanceof Error ? cause.message : 'Telemetry request failed.');
            } finally { inFlight.current = false; }
        };
        void poll();
        const timer = window.setInterval(() => { void poll(); }, Math.min(rate * Math.max(1, 2 ** Math.min(failures, 4)), 16_000));
        return () => { alive = false; window.clearInterval(timer); };
    }, [rate, failures]);

    const current = points.at(-1);
    const master = current?.master ?? null;
    const worker = current?.worker ?? null;
    const net = useMemo(() => { if (points.length < 2) return null; const previous = points.at(-2); const a = current?.net; const b = previous?.net; return a == null || b == null ? null : Math.max(0, (a - b) / 1_048_576); }, [points, current]);
    const reasons = [
        ...((Array.isArray(master?.throttle_reasons) ? master.throttle_reasons : []).filter((reason): reason is string => typeof reason === 'string').map(reason => ({ reason, source: 'Master' }))),
        ...((Array.isArray(worker?.throttle_reasons) ? worker.throttle_reasons : []).filter((reason): reason is string => typeof reason === 'string').map(reason => ({ reason, source: 'Worker' }))),
    ];
    const activeReasons = new Map<string, string[]>();
    reasons.forEach(({ reason, source }) => activeReasons.set(reason, [...(activeReasons.get(reason) ?? []), source]));
    const thermalActive = [...activeReasons.keys()].some(reason => thermalReasons.has(reason));
    const powerActive = [...activeReasons.keys()].some(reason => !thermalReasons.has(reason) && reason in throttleLabels);
    const setPollingRate = async (next: number) => {
        setRate(next); setError('');
        try { const result = await api<TelemetryRateResponse>('/api/telemetry/rate', { method: 'POST', body: JSON.stringify({ ms: next }) }); setRate(result.ms); }
        catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not set telemetry rate.'); }
    };
    const toggleSmooth = (on: boolean) => { setSmooth(on); try { window.localStorage.setItem('omni_smoothing', on ? '1' : ''); } catch { setError('Could not save smoothing preference.'); } };
    const cards = [
        ['GPU util', text(stat(master, 'gpu_util'), '%'), text(stat(worker, 'gpu_util'), '%')], ['Power', text(stat(master, 'gpu_pwr'), ' W'), text(stat(worker, 'gpu_pwr'), ' W')],
        ['GPU temp', text(stat(master, 'gpu_temp'), ' °C'), text(stat(worker, 'gpu_temp'), ' °C')], ['CPU util', text(stat(master, 'cpu_util'), '%'), text(stat(worker, 'cpu_util'), '%')],
        ['VRAM', text(stat(master, 'vram_used'), ' MiB'), text(stat(worker, 'vram_used'), ' MiB')], ['RAM', text(stat(master, 'ram_used'), ' MiB'), text(stat(worker, 'ram_used'), ' MiB')], ['Net', text(net, ' MB/s'), '--'],
    ];
    const vram = [{ label: 'Master', parts: vramParts(master), color: 'bg-yellow-400' }, { label: 'Worker', parts: vramParts(worker), color: 'bg-red-400' }];

    return <section className="space-y-4" aria-label="Telemetry monitor">
        <div className="flex flex-wrap items-center gap-3"><h2 className="text-sm font-bold uppercase tracking-wider text-neutral-300">Telemetry</h2><label className="ml-auto text-xs text-neutral-400">Rate <select value={rate} onChange={event => { void setPollingRate(Number(event.target.value)); }} className="ml-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-1"><option value={500}>Fast (0.5s)</option><option value={1000}>Normal (1s)</option><option value={2000}>Slow (2s)</option></select></label><label className="text-xs text-neutral-400"><input checked={smooth} onChange={event => toggleSmooth(event.target.checked)} type="checkbox" className="mr-1 accent-indigo-500" />smooth</label></div>
        {failures >= 3 && <p role="alert" className="rounded border border-orange-700/50 bg-orange-900/20 px-3 py-2 text-xs text-orange-300">Telemetry polling failed ({failures} consecutive errors). Backing off.</p>}
        {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">{cards.map(([name, a, b]) => <div key={name} className="rounded border border-neutral-800 bg-neutral-900 p-3"><p className="text-xs text-neutral-400">{name}</p><p className="font-mono text-sm text-yellow-300">Master {a}</p><p className="font-mono text-sm text-red-300">Worker {b}</p></div>)}
            <div className="rounded border border-neutral-800 bg-neutral-900 p-3"><p className="text-xs text-neutral-400">Context usage</p>{context ? <><p className="font-mono text-sm text-indigo-300">{context.used.toLocaleString()} / {context.limit.toLocaleString()}</p><div className="mt-2 h-1.5 overflow-hidden rounded bg-neutral-800"><div className="h-full bg-indigo-500" style={{ width: Math.min(context.used / context.limit * 100, 100) + '%' }} /></div><p className="mt-1 text-xs text-neutral-500">{(context.used / context.limit * 100).toFixed(1)}% used</p></> : <p className="font-mono text-sm text-neutral-500">unknown</p>}</div>
        </div>
        <div className="grid gap-2 sm:grid-cols-2"><div className={'rounded border p-3 ' + (thermalActive ? 'animate-pulse border-red-500/50 bg-red-900/30' : 'border-neutral-800 bg-neutral-900')}><p className="text-xs text-neutral-400">Thermal throttle</p><div className="mt-2 flex flex-wrap gap-1">{Object.entries(throttleLabels).filter(([reason]) => thermalReasons.has(reason)).map(([reason, label]) => <span key={reason} title={activeReasons.has(reason) ? activeReasons.get(reason)?.join(' + ') + ': ' + label : label + ' (not currently active)'} className={'rounded border px-1.5 py-0.5 text-[9px] font-semibold ' + (activeReasons.has(reason) ? 'border-red-500/50 bg-red-900/40 text-red-300' : 'border-neutral-700/50 bg-neutral-800/40 text-neutral-600')}>{label}</span>)}</div></div><div className={'rounded border p-3 ' + (powerActive ? 'animate-pulse border-yellow-500/50 bg-yellow-900/20' : 'border-neutral-800 bg-neutral-900')}><p className="text-xs text-neutral-400">Power throttle</p><div className="mt-2 flex flex-wrap gap-1">{Object.entries(throttleLabels).filter(([reason]) => !thermalReasons.has(reason)).map(([reason, label]) => <span key={reason} title={activeReasons.has(reason) ? activeReasons.get(reason)?.join(' + ') + ': ' + label : label + ' (not currently active)'} className={'rounded border px-1.5 py-0.5 text-[9px] font-semibold ' + (activeReasons.has(reason) ? 'border-yellow-600/50 bg-yellow-900/30 text-yellow-300' : 'border-neutral-700/50 bg-neutral-800/40 text-neutral-600')}>{label}</span>)}</div></div></div>
        <div className="rounded border border-neutral-800 bg-neutral-900 p-3"><h3 className="mb-2 text-sm text-neutral-200">VRAM breakdown</h3><div className="space-y-3">{vram.map(({ label, parts, color }) => <div key={label}><div className="mb-1 flex justify-between text-xs"><span className="text-neutral-400">{label}</span><span className="font-mono text-neutral-300">{parts.used === null ? 'unknown' : text(parts.used, ' MiB')} used{parts.free === null ? '' : ' · ' + text(parts.free, ' MiB') + ' free'}</span></div><div className="flex h-3 overflow-hidden rounded bg-neutral-800">{parts.total !== null && parts.used !== null && <div className={color} style={{ width: Math.min(parts.used / parts.total * 100, 100) + '%' }} />}{parts.total !== null && parts.free !== null && <div className="bg-neutral-600" style={{ width: Math.min(parts.free / parts.total * 100, 100) + '%' }} />}</div></div>)}</div></div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">{miniMetrics.map(metric => <MiniChart key={metric.key} metric={metric} points={points} smooth={smooth} />)}</div>
        <div className="rounded border border-neutral-800 bg-neutral-900 p-3"><div className="mb-2 flex items-center"><div><h3 className="text-sm text-neutral-200">Live hardware</h3><p className="text-xs text-neutral-500">Missing values remain gaps.</p></div><button ref={restoreFocus} type="button" onClick={() => setExpanded(true)} className="ml-auto rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-700" aria-label="Expand live hardware chart">Expand</button></div><div className="h-64"><canvas ref={omniCanvas} /></div></div>
        <div className="rounded border border-neutral-800 bg-neutral-900 p-3"><div className="mb-2 flex flex-wrap items-center gap-2"><div><h3 className="text-sm text-neutral-200">Completed request samples</h3><p className="text-xs text-neutral-500">{progress?.prefill ? 'PREFILL ' + progress.prefill.progress.toFixed(1) + '%' : progress?.gen ? 'GEN ' + progress.gen.tokens + ' tokens' : 'Idle'}</p></div><label className="ml-auto text-xs text-neutral-400">Request <select value={selectedCompletion?.runId ?? ''} onChange={event => setSelectedRunId(event.target.value)} className="ml-1 max-w-48 rounded border border-neutral-700 bg-neutral-950 px-2 py-1">{completions.length === 0 && <option value="">No completed requests</option>}{completions.map((completion: CompletionEvent) => <option key={completion.runId} value={completion.runId}>{new Date(completion.timestamp).toLocaleTimeString()} · {completion.model || completion.runId}</option>)}</select></label></div><div className="h-56"><canvas ref={requestCanvas} /></div></div>
        {expanded && <div role="dialog" aria-modal="true" aria-label="Expanded live hardware chart" className="fixed inset-0 z-50 flex flex-col bg-black/95 p-6"><div className="mb-3 flex items-center gap-3"><h2 className="text-lg font-bold">Live hardware</h2><label className="text-xs text-neutral-400"><input checked={smooth} onChange={event => toggleSmooth(event.target.checked)} type="checkbox" className="mr-1 accent-indigo-500" />smooth</label><button type="button" onClick={() => { setExpanded(false); window.setTimeout(() => restoreFocus.current?.focus(), 0); }} className="ml-auto rounded bg-neutral-800 px-3 py-1 text-sm">Close</button></div><div className="min-h-0 flex-1"><canvas ref={expandedCanvas} /></div></div>}
    </section>;
}
