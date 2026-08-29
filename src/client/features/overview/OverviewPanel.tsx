// Overview panel (gaps G4/G6/G7): server paths, unit status. GPU cards now
// live in the always-visible GpuRow under the ActivityBar (App.tsx).
// Read-only here — preset settings live in the PresetDock and the ⌘K preset
// browser.
import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { ServerPathsResponse, UnitStatus } from '../../../../shared/contracts';

function Stat({ label, value }: { label: string; value: string }) {
    return <div className="flex items-baseline justify-between gap-2 text-xs"><span className="text-neutral-500">{label}</span><span className="truncate font-mono text-neutral-300">{value}</span></div>;
}

export default function OverviewPanel() {
    const [paths, setPaths] = useState<ServerPathsResponse | null>(null);
    const [unit, setUnit] = useState<UnitStatus | null>(null);
    const [error] = useState('');

    useEffect(() => {
        let alive = true;
        api<ServerPathsResponse>('/api/server-paths').then(result => { if (alive) setPaths(result); }).catch(() => {});
        api<UnitStatus>('/api/unit/status').then(result => { if (alive) setUnit(result); }).catch(() => {});
        return () => { alive = false; };
    }, []);

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
        </section>
    );
}
