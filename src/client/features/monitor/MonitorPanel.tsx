import { useEffect, useMemo, useRef, useState } from 'react';
import Chart from 'chart.js/auto';
import { api } from '../../api/client';
import { onSseLine, useServer } from '../../state/server';
import type { CompletionEvent, TelemetryLatestResponse, TelemetryRateResponse, TelemetrySample } from '../../../../shared/contracts';

type Stats = Record<string, unknown>;
type Point = { t: number; master: Stats | null; worker: Stats | null; net: number | null };
type MiniMetric = { title: string; key: string; unit: string };

const POINTS_KEY = 'monitor_points';
// Stats compared when deciding whether the worker section has any data at all.
const WORKER_KEYS = ['gpu_util', 'gpu_pwr', 'gpu_temp', 'cpu_util', 'vram_used', 'ram_used'];
// One row per graph, in this order: TEMP, UTIL, POWER, VRAM, CPU, RAM, NET,
// GEN t/s, PREFILL t/s. This array is the default order and the source of row
// identity; the user can drag rows to reorder (persisted, see
// METRIC_ORDER_KEY) and lock the order (METRIC_LOCK_KEY).
const miniMetrics: MiniMetric[] = [
    { title: 'GPU temp', key: 'gpu_temp', unit: ' °C' },
    { title: 'GPU util', key: 'gpu_util', unit: '%' },
    { title: 'Power', key: 'gpu_pwr', unit: ' W' },
    { title: 'VRAM', key: 'vram_used', unit: ' MiB' },
    { title: 'CPU', key: 'cpu_util', unit: '%' },
    { title: 'RAM', key: 'ram_used', unit: ' MiB' },
    { title: 'Net', key: 'net', unit: ' MB/s' },
    { title: 'Gen t/s', key: 'gen_tps', unit: ' t/s' },
    { title: 'Prefill t/s', key: 'prefill_tps', unit: ' t/s' },
];
const metricByKey = new Map(miniMetrics.map(metric => [metric.key, metric]));
const TPS_KEYS = new Set(['gen_tps', 'prefill_tps']);
interface TpsPoint { t: number; genTps: number | null; prefillTps: number | null }
const METRIC_ORDER_KEY = 'monitor_metric_order'; // legacy: metric-only order, migrated into METRIC_BLOCK_ORDER_KEY
const METRIC_LOCK_KEY = 'monitor_metric_lock';
const METRIC_BLOCK_ORDER_KEY = 'monitor_block_order';
// Every monitor block is a draggable row: the section header, stat blocks,
// metric rows, charts. Titles are the drag handles.
const DEFAULT_BLOCK_ORDER = ['header', 'context', 'thermal', 'power', 'vram', ...miniMetrics.map(metric => metric.key), 'omni', 'requests'];
const throttleLabels: Record<string, string> = { hw_thermal_slowdown: 'HW Thermal', sw_thermal_slowdown: 'SW Thermal', sw_power_cap: 'SW Power Cap', hw_power_brake_slowdown: 'HW Power Brake' };
const thermalReasons = new Set(['hw_thermal_slowdown', 'sw_thermal_slowdown']);

function number(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function stat(stats: Stats | null, key: string): number | null { return stats ? number(stats[key]) : null; }
function text(value: number | null, unit: string): string { return value === null ? '--' + unit : value.toFixed(unit === '%' ? 0 : 1) + unit; }
function labels(points: { t: number }[]): string[] { return points.map(point => new Date(point.t).toLocaleTimeString()); }
function series(points: Point[], from: 'master' | 'worker', key: string): (number | null)[] { return points.map(point => stat(point[from], key)); }
// Machine-level stats a worker shares with main when it runs on the same host
// (local second GPU or loopback RPC target). monitor.py marks those points
// same_host; showing the worker value there would just repeat main's.
const SHARED_KEYS = new Set(['cpu_util', 'ram_used']);
function workerSeries(points: Point[], key: string): (number | null)[] { return points.map(point => SHARED_KEYS.has(key) && point.worker && point.worker.same_host === true ? null : stat(point.worker, key)); }
// GPUs are labeled by their real names (nvidia-smi / amdgpu_top) instead of
// Main/Worker: "Main"/"Worker" describe the RPC role, not the card. Fallback
// is positional (GPU 1 / GPU 2) when the name is missing or an error marker.
const BAD_GPU_NAMES = new Set(['', 'Unknown', 'Offline', 'Unknown AMD GPU']);
function gpuLabel(stats: Stats | null, fallback: string): string { const name = stats && typeof stats.gpu_name === 'string' ? stats.gpu_name.trim() : ''; return BAD_GPU_NAMES.has(name) ? fallback : name; }
// The block title itself is the drag handle: plain-looking text, but grabbable
// when unlocked -- dropping it on another block reorders the two (persisted).
function DragTitle({ text, locked, onDragStart, onDragEnd }: { text: string; locked: boolean; onDragStart: () => void; onDragEnd: () => void }) {
    if (locked) return <>{text}</>;
    return <span draggable title="Drag to reorder" onDragStart={event => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', text); onDragStart(); }} onDragEnd={onDragEnd} className="cursor-grab select-none hover:text-neutral-200 active:cursor-grabbing">{text}</span>;
}
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
function netSeries(points: Point[]): (number | null)[] { return points.map((point, index) => { const previous = index > 0 ? points[index - 1] : null; if (point.net == null || !previous || previous.net == null) return null; return Math.max(0, (point.net - previous.net) / 1_048_576); }); }
function MiniChart({ metric, points, smooth, master, worker, net, masterLabel, workerLabel, tpsPoints, drag }: { metric: MiniMetric; points: Point[]; smooth: boolean; master: Stats | null; worker: Stats | null; net: number | null; masterLabel: string; workerLabel: string; tpsPoints: TpsPoint[]; drag?: { locked: boolean; onDragStart: () => void; onDragEnd: () => void } }) {
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
        const isTps = TPS_KEYS.has(metric.key);
        chart.data.labels = labels(isTps ? tpsPoints : points);
        const data = isTps
            ? tpsPoints.map(point => (metric.key === 'gen_tps' ? point.genTps : point.prefillTps))
            : metric.key === 'net' ? netSeries(points) : series(points, 'master', metric.key);
        chart.data.datasets = isTps
            ? [{ label: metric.title, data, borderColor: metric.key === 'gen_tps' ? '#22c55e' : '#60a5fa', pointRadius: 0, borderWidth: 1.5, tension: smooth ? 0.35 : 0 }]
            : [
                { label: masterLabel, data, borderColor: '#eab308', pointRadius: 0, borderWidth: 1.5, tension: smooth ? 0.35 : 0 },
                ...(metric.key === 'net' ? [] : [{ label: workerLabel, data: workerSeries(points, metric.key), borderColor: '#ef4444', pointRadius: 0, borderWidth: 1.5, tension: smooth ? 0.35 : 0 }]),
            ];
        chart.update('none');
    }, [metric.key, points, smooth, tpsPoints, masterLabel, workerLabel]);
    const isTps = TPS_KEYS.has(metric.key);
    const lastTps = tpsPoints.length > 0 ? tpsPoints[tpsPoints.length - 1] : null;
    const value = isTps ? (lastTps ? (metric.key === 'gen_tps' ? lastTps.genTps : lastTps.prefillTps) : null) : metric.key === 'net' ? net : stat(master, metric.key);
    const workerValue = metric.key === 'net' || isTps || (SHARED_KEYS.has(metric.key) && worker?.same_host === true) ? null : stat(worker, metric.key);
    return <div className="rounded border border-neutral-800 bg-neutral-900 p-2"><div className="mb-1 flex items-baseline justify-between"><p className="text-xs text-neutral-400">{drag ? <DragTitle text={metric.title} {...drag} /> : metric.title}</p><p className="font-mono text-sm text-yellow-300" title={isTps ? undefined : `${masterLabel}${workerValue !== null ? ' / ' + workerLabel : ''}`}>{text(value, metric.unit)}{workerValue !== null && <span className="text-red-300"> / {text(workerValue, metric.unit)}</span>}</p></div><div className="h-24"><canvas ref={canvas} /></div></div>;
}

export default function MonitorPanel() {
    const { config, completions, progress } = useServer();
    // ponytail: points restored from localStorage so a refresh keeps the
    // telemetry history; full backfill would need a server-side ring buffer.
    const [points, setPoints] = useState<Point[]>(() => {
        try {
            const value: unknown = JSON.parse(window.localStorage.getItem(POINTS_KEY) || '[]');
            return Array.isArray(value) ? value as Point[] : [];
        } catch { return []; }
    });
    const [rate, setRate] = useState(1000);
    const [error, setError] = useState('');
    const [failures, setFailures] = useState(0);
    const [expanded, setExpanded] = useState(false);
    const [smooth, setSmooth] = useState(() => { try { return window.localStorage.getItem('omni_smoothing') === '1'; } catch { return false; } });
    // Live token-rate ring: one sample per SSE progress frame (PREFILL/GEN),
    // so the t/s rows track the in-flight request without the machine-stats poll.
    const [tpsPoints, setTpsPoints] = useState<TpsPoint[]>([]);
    useEffect(() => {
        const genTps = progress?.gen ? Number.parseFloat(progress.gen.tps) : NaN;
        const prefillTps = progress?.prefill ? Number.parseFloat(progress.prefill.tps) : NaN;
        if (!Number.isFinite(genTps) && !Number.isFinite(prefillTps)) return;
        setTpsPoints(prev => [...prev, { t: Date.now(), genTps: Number.isFinite(genTps) ? genTps : null, prefillTps: Number.isFinite(prefillTps) ? prefillTps : null }].slice(-240));
    }, [progress]);
    // User-reorderable block order (drag a block's title), persisted; the
    // lock freezes it. First run migrates the legacy metric-only order into
    // the metric slots of the full block order.
    const [blockOrder, setBlockOrder] = useState<string[]>(() => {
        const defaults = DEFAULT_BLOCK_ORDER;
        const sanitize = (raw: unknown): string[] | null => {
            if (!Array.isArray(raw)) return null;
            const seen: string[] = [];
            for (const key of raw) if (typeof key === 'string' && defaults.includes(key) && !seen.includes(key)) seen.push(key);
            if (seen.length === 0) return null;
            return [...seen, ...defaults.filter(key => !seen.includes(key))];
        };
        try {
            const stored: unknown = JSON.parse(window.localStorage.getItem(METRIC_BLOCK_ORDER_KEY) || 'null');
            const fromBlocks = sanitize(stored);
            if (fromBlocks) return fromBlocks;
            const legacy: unknown = JSON.parse(window.localStorage.getItem(METRIC_ORDER_KEY) || '[]');
            const savedMetrics = Array.isArray(legacy) ? legacy.filter((key): key is string => typeof key === 'string' && miniMetrics.some(metric => metric.key === key)) : [];
            if (savedMetrics.length === 0) return defaults;
            const metricKeys = new Set(miniMetrics.map(metric => metric.key));
            let savedIndex = 0;
            return defaults.map(key => (metricKeys.has(key) ? savedMetrics[savedIndex++] ?? key : key));
        } catch { return defaults; }
    });
    const [metricLocked, setMetricLocked] = useState<boolean>(() => { try { return window.localStorage.getItem(METRIC_LOCK_KEY) === '1'; } catch { return false; } });
    const dragKey = useRef<string | null>(null);
    useEffect(() => { try { window.localStorage.setItem(METRIC_BLOCK_ORDER_KEY, JSON.stringify(blockOrder)); } catch { /* full or unavailable */ } }, [blockOrder]);
    useEffect(() => { try { window.localStorage.setItem(METRIC_LOCK_KEY, metricLocked ? '1' : ''); } catch { /* full or unavailable */ } }, [metricLocked]);
    const moveBlock = (from: string | null, to: string) => {
        dragKey.current = null;
        if (!from || from === to) return;
        setBlockOrder(prev => {
            const fromIndex = prev.indexOf(from);
            const toIndex = prev.indexOf(to);
            if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return prev;
            const next = prev.filter(key => key !== from);
            next.splice(toIndex, 0, from);
            return next;
        });
    };
    const [context, setContext] = useState<{ used: number; limit: number } | null>(null);
    const [selectedRunId, setSelectedRunId] = useState('');
    const omniCanvas = useRef<HTMLCanvasElement>(null);
    const requestCanvas = useRef<HTMLCanvasElement>(null);
    const omniChart = useRef<Chart | null>(null);
    const requestChart = useRef<Chart | null>(null);
    const inFlight = useRef(false);
    // Poll effect only re-runs on [rate, failures]; ref keeps latest ring buffer.
    const pointsRef = useRef<Point[]>(points);
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

    const updateOmni = (chart: Chart | null) => {
        if (!chart) return;
        chart.data.labels = labels(points);
        chart.data.datasets = [
            { label: masterLabel + ' %', data: series(points, 'master', 'gpu_util'), borderColor: '#eab308', pointRadius: 0 },
            { label: workerLabel + ' %', data: series(points, 'worker', 'gpu_util'), borderColor: '#ef4444', pointRadius: 0 },
            { label: 'CPU %', data: series(points, 'master', 'cpu_util'), borderColor: '#60a5fa', pointRadius: 0 },
            { label: 'Power W', data: series(points, 'master', 'gpu_pwr'), borderColor: '#f97316', pointRadius: 0 },
            { label: 'Temp °C', data: series(points, 'master', 'gpu_temp'), borderColor: '#facc15', pointRadius: 0 },
            { label: 'VRAM MiB', data: series(points, 'master', 'vram_used'), borderColor: '#a78bfa', pointRadius: 0 },
        ].map(dataset => ({ ...dataset, tension: smooth ? 0.35 : 0 }));
        chart.update('none');
    };
    useEffect(() => { updateOmni(omniChart.current); }, [points, smooth]);
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
                const next = [...pointsRef.current, { t: result.t || Date.now(), master, worker, net: stat(master, 'net_bytes') }].slice(-240);
                pointsRef.current = next;
                try { window.localStorage.setItem(POINTS_KEY, JSON.stringify(next)); } catch { /* full or unavailable */ }
                setPoints(next);
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
    const masterLabel = gpuLabel(master, 'GPU 1');
    const workerLabel = gpuLabel(worker, 'GPU 2');
    const net = useMemo(() => { if (points.length < 2) return null; const previous = points.at(-2); const a = current?.net; const b = previous?.net; return a == null || b == null ? null : Math.max(0, (a - b) / 1_048_576); }, [points, current]);
    const reasons = [
        ...((Array.isArray(master?.throttle_reasons) ? master.throttle_reasons : []).filter((reason): reason is string => typeof reason === 'string').map(reason => ({ reason, source: masterLabel }))),
        ...((Array.isArray(worker?.throttle_reasons) ? worker.throttle_reasons : []).filter((reason): reason is string => typeof reason === 'string').map(reason => ({ reason, source: workerLabel }))),
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
    const workerHasData = points.some(point => point.worker !== null && WORKER_KEYS.some(key => stat(point.worker, key) !== null));
    const vram = [{ label: masterLabel, parts: vramParts(master), color: 'bg-yellow-400' }, ...(workerHasData ? [{ label: workerLabel, parts: vramParts(worker), color: 'bg-red-400' }] : [])];

    // Every monitor block is one draggable row; the block title is the handle.
    const renderBlock = (key: string) => {
        const handle = () => ({ locked: metricLocked, onDragStart: () => { dragKey.current = key; }, onDragEnd: () => { dragKey.current = null; } });
        switch (key) {
            case 'header':
                return <div className="flex flex-wrap items-center gap-3"><h2 className="text-sm font-bold uppercase tracking-wider text-neutral-300"><DragTitle text="Telemetry" {...handle()} /></h2><label className="ml-auto text-xs text-neutral-400">Rate <select value={rate} onChange={event => { void setPollingRate(Number(event.target.value)); }} className="ml-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-1"><option value={500}>Fast (0.5s)</option><option value={1000}>Normal (1s)</option><option value={2000}>Slow (2s)</option></select></label><label className="text-xs text-neutral-400"><input checked={smooth} onChange={event => toggleSmooth(event.target.checked)} type="checkbox" className="mr-1 accent-indigo-500" />smooth</label><button type="button" onClick={() => setMetricLocked(value => !value)} aria-pressed={metricLocked} title={metricLocked ? 'Block order locked -- unlock to drag titles' : 'Lock the current block order'} className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-300 hover:bg-neutral-800">{metricLocked ? 'Unlock order' : 'Lock order'}</button></div>;
            case 'context':
                return <div className="max-w-sm rounded border border-neutral-800 bg-neutral-900 p-3"><p className="text-xs text-neutral-400"><DragTitle text="Context usage" {...handle()} /></p>{context ? <><p className="font-mono text-sm text-indigo-300">{context.used.toLocaleString()} / {context.limit.toLocaleString()}</p><div className="mt-2 h-1.5 overflow-hidden rounded bg-neutral-800"><div className="h-full bg-indigo-500" style={{ width: Math.min(context.used / context.limit * 100, 100) + '%' }} /></div><p className="mt-1 text-xs text-neutral-500">{(context.used / context.limit * 100).toFixed(1)}% used</p></> : <p className="font-mono text-sm text-neutral-500">unknown</p>}</div>;
            case 'thermal':
                return <div className={'rounded border p-3 ' + (thermalActive ? 'animate-pulse border-red-500/50 bg-red-900/30' : 'border-neutral-800 bg-neutral-900')}><p className="text-xs text-neutral-400"><DragTitle text="Thermal throttle" {...handle()} /></p><div className="mt-2 flex flex-wrap gap-1">{Object.entries(throttleLabels).filter(([reason]) => thermalReasons.has(reason)).map(([reason, label]) => <span key={reason} title={activeReasons.has(reason) ? activeReasons.get(reason)?.join(' + ') + ': ' + label : label + ' (not currently active)'} className={'rounded border px-1.5 py-0.5 text-[9px] font-semibold ' + (activeReasons.has(reason) ? 'border-red-500/50 bg-red-900/40 text-red-300' : 'border-neutral-700/50 bg-neutral-800/40 text-neutral-600')}>{label}</span>)}</div></div>;
            case 'power':
                return <div className={'rounded border p-3 ' + (powerActive ? 'animate-pulse border-yellow-500/50 bg-yellow-900/20' : 'border-neutral-800 bg-neutral-900')}><p className="text-xs text-neutral-400"><DragTitle text="Power throttle" {...handle()} /></p><div className="mt-2 flex flex-wrap gap-1">{Object.entries(throttleLabels).filter(([reason]) => !thermalReasons.has(reason)).map(([reason, label]) => <span key={reason} title={activeReasons.has(reason) ? activeReasons.get(reason)?.join(' + ') + ': ' + label : label + ' (not currently active)'} className={'rounded border px-1.5 py-0.5 text-[9px] font-semibold ' + (activeReasons.has(reason) ? 'border-yellow-600/50 bg-yellow-900/30 text-yellow-300' : 'border-neutral-700/50 bg-neutral-800/40 text-neutral-600')}>{label}</span>)}</div></div>;
            case 'vram':
                return <div className="rounded border border-neutral-800 bg-neutral-900 p-3"><h3 className="mb-2 text-sm text-neutral-200"><DragTitle text="VRAM breakdown" {...handle()} /></h3><div className="space-y-3">{vram.map(({ label, parts, color }) => <div key={label}><div className="mb-1 flex justify-between text-xs"><span className="text-neutral-400">{label}</span><span className="font-mono text-neutral-300">{parts.used === null ? 'unknown' : text(parts.used, ' MiB')} used{parts.free === null ? '' : ' · ' + text(parts.free, ' MiB') + ' free'}</span></div><div className="flex h-3 overflow-hidden rounded bg-neutral-800">{parts.total !== null && parts.used !== null && <div className={color} style={{ width: Math.min(parts.used / parts.total * 100, 100) + '%' }} />}{parts.total !== null && parts.free !== null && <div className="bg-neutral-600" style={{ width: Math.min(parts.free / parts.total * 100, 100) + '%' }} />}</div></div>)}</div></div>;
            case 'omni':
                return <div className="rounded border border-neutral-800 bg-neutral-900 p-3"><div className="mb-2 flex items-center"><div><h3 className="text-sm text-neutral-200"><DragTitle text="Live hardware" {...handle()} /></h3><p className="text-xs text-neutral-500">Missing values remain gaps.</p></div><button ref={restoreFocus} type="button" onClick={() => setExpanded(true)} className="ml-auto rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-700" aria-label="Expand live hardware chart">Expand</button></div><div className="h-64"><canvas ref={omniCanvas} /></div></div>;
            case 'requests':
                return <div className="rounded border border-neutral-800 bg-neutral-900 p-3"><div className="mb-2 flex flex-wrap items-center gap-2"><div><h3 className="text-sm text-neutral-200"><DragTitle text="Completed request samples" {...handle()} /></h3><p className="text-xs text-neutral-500">{progress?.prefill ? 'PREFILL ' + progress.prefill.progress.toFixed(1) + '%' : progress?.gen ? 'GEN ' + progress.gen.tokens + ' tokens' : 'Idle'}</p></div><label className="ml-auto text-xs text-neutral-400">Request <select value={selectedCompletion?.runId ?? ''} onChange={event => setSelectedRunId(event.target.value)} className="ml-1 max-w-48 rounded border border-neutral-700 bg-neutral-950 px-2 py-1">{completions.length === 0 && <option value="">No completed requests</option>}{completions.map((completion: CompletionEvent) => <option key={completion.runId} value={completion.runId}>{new Date(completion.timestamp).toLocaleTimeString()} · {completion.model || completion.runId}</option>)}</select></label></div><div className="h-56"><canvas ref={requestCanvas} /></div></div>;
            default: {
                const metric = metricByKey.get(key);
                if (!metric) return null;
                return <MiniChart metric={metric} points={points} smooth={smooth} master={master} worker={worker} net={net} masterLabel={masterLabel} workerLabel={workerLabel} tpsPoints={tpsPoints} drag={handle()} />;
            }
        }
    };

    return <section className="@container space-y-4" aria-label="Telemetry monitor">
        {failures >= 3 && <p role="alert" className="rounded border border-orange-700/50 bg-orange-900/20 px-3 py-2 text-xs text-orange-300">Telemetry polling failed ({failures} consecutive errors). Backing off.</p>}
        {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
        {blockOrder.map(key => <div key={key} onDragOver={event => { if (!metricLocked) event.preventDefault(); }} onDrop={event => { event.preventDefault(); moveBlock(dragKey.current, key); }}>{renderBlock(key)}</div>)}
        {expanded && <div role="dialog" aria-modal="true" aria-label="Expanded live hardware chart" className="fixed inset-0 z-50 flex flex-col bg-black/95 p-6"><div className="mb-3 flex items-center gap-3"><h2 className="text-lg font-bold">Live hardware</h2><label className="text-xs text-neutral-400"><input checked={smooth} onChange={event => toggleSmooth(event.target.checked)} type="checkbox" className="mr-1 accent-indigo-500" />smooth</label><button type="button" onClick={() => { setExpanded(false); window.setTimeout(() => restoreFocus.current?.focus(), 0); }} className="ml-auto rounded bg-neutral-800 px-3 py-1 text-sm">Close</button></div><div className="min-h-0 flex-1 overflow-y-auto"><div className="grid gap-3 grid-cols-1 @lg:grid-cols-2 2xl:grid-cols-3">{blockOrder.map(key => { const metric = metricByKey.get(key); if (!metric) return null; return <MiniChart key={metric.key} metric={metric} points={points} smooth={smooth} master={master} worker={worker} net={net} masterLabel={masterLabel} workerLabel={workerLabel} tpsPoints={tpsPoints} />; })}</div></div></div>}
    </section>;
}
