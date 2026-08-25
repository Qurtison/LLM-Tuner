import { useEffect, useRef, useState } from 'react';
import { Chart, LineController, LineElement, PointElement, LinearScale, CategoryScale, Legend, Tooltip } from 'chart.js';
import { api } from '../../api/client';
import { getErrorMessage } from '../../api/errors';
import { chartOptions } from '../../lib/charts';
import type { SamplesResponse, TelemetrySample } from '../../../../shared/contracts';

Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale, Legend, Tooltip);

export default function SampleDialog({ runId, onClose }: { runId: string; onClose: () => void }) {
    const canvas = useRef<HTMLCanvasElement>(null);
    const chart = useRef<Chart | null>(null);
    const [samples, setSamples] = useState<TelemetrySample[] | null>(null);
    const [error, setError] = useState('');
    useEffect(() => {
        let alive = true;
        api<SamplesResponse>('/api/logs/samples?runId=' + encodeURIComponent(runId))
            .then(data => { if (alive) setSamples(data.samples); })
            .catch(e => { if (alive) setError(getErrorMessage(e, 'Failed to load samples')); });
        return () => { alive = false; };
    }, [runId]);
    useEffect(() => {
        if (!canvas.current || !samples || samples.length < 2) return;
        chart.current?.destroy();
        chart.current = new Chart(canvas.current, {
            type: 'line',
            data: {
                labels: samples.map(s => new Date(s.t).toLocaleTimeString()),
                datasets: [
                    { label: 'Prefill t/s', data: samples.map(s => s.prefillTps), borderColor: '#60a5fa' },
                    { label: 'Gen t/s', data: samples.map(s => s.genTps), borderColor: '#4ade80' },
                ],
            },
            options: chartOptions() as object,
        });
        return () => { chart.current?.destroy(); chart.current = null; };
    }, [samples]);
    useEffect(() => {
        const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', key);
        return () => document.removeEventListener('keydown', key);
    }, [onClose]);
    return (
        <div
            role="dialog"
            aria-modal="true"
            aria-label="Request telemetry"
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
            onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
        >
            <div className="w-full max-w-3xl rounded border border-neutral-700 bg-neutral-900 p-4">
                <div className="mb-3 flex justify-between">
                    <h2 className="font-semibold">Request telemetry</h2>
                    <button type="button" onClick={onClose} className="rounded px-2 text-neutral-300 hover:bg-neutral-800">Close</button>
                </div>
                {error ? <p role="alert" className="text-red-400">Failed to load samples: {error}</p>
                    : samples === null ? <p className="text-neutral-400">Loading…</p>
                    : samples.length < 2 ? <p className="text-neutral-400">No telemetry samples for this request.</p>
                    : <div className="h-80"><canvas ref={canvas} /></div>}
            </div>
        </div>
    );
}
