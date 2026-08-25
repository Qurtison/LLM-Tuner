import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { getErrorMessage } from '../../api/errors';
import { fieldClass } from '../../components/Field';
import type {
    ApplyResult,
    BuildEntry,
    BuildsResponse,
    Preset,
    PresetsResponse,
    PresetSaveRequest,
    UnitOpResponse,
    UnitStatus,
} from '../../../../shared/contracts';

const btn = 'rounded bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-50';
const btnPrimary = 'rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50';
const btnDanger = 'rounded bg-red-900/40 px-3 py-1.5 text-sm text-red-300 hover:bg-red-900/60 disabled:cursor-not-allowed disabled:opacity-50';

type Draft = { name: string; build: string; label: string; modelPath: string; ctx: string; ngl: string; port: string; fa: boolean; temp: string };
const emptyDraft: Draft = { name: '', build: '', label: '', modelPath: '', ctx: '', ngl: '', port: '', fa: false, temp: '' };

function n(value: string): number | undefined { const parsed = Number(value); return value === '' || Number.isNaN(parsed) ? undefined : parsed; }
function basename(path: string): string { return path.split('/').pop() || path; }
function modelLabel(preset: Preset): string {
    return basename(preset.config.modelPath || preset.config.model || '');
}
function draftFrom(preset: Preset): Draft {
    return {
        name: preset.name,
        build: preset.build,
        label: preset.label || '',
        modelPath: preset.config.modelPath || preset.config.model || '',
        ctx: preset.config.ctx === undefined ? '' : String(preset.config.ctx),
        ngl: preset.config.ngl === undefined ? '' : String(preset.config.ngl),
        port: preset.config.port === undefined ? '' : String(preset.config.port),
        fa: Boolean(preset.config.fa),
        temp: preset.config.temp === undefined ? '' : String(preset.config.temp),
    };
}
function draftToRequest(draft: Draft): PresetSaveRequest {
    return {
        name: draft.name.trim(),
        build: draft.build,
        label: draft.label.trim() || undefined,
        config: {
            modelPath: draft.modelPath.trim() || undefined,
            ctx: n(draft.ctx),
            ngl: n(draft.ngl),
            port: n(draft.port),
            fa: draft.fa,
            temp: n(draft.temp),
        },
    };
}

export default function PresetsPanel() {
    const [presets, setPresets] = useState<Preset[]>([]);
    const [active, setActive] = useState<string | null>(null);
    const [builds, setBuilds] = useState<BuildEntry[]>([]);
    const [loadError, setLoadError] = useState('');
    const [actionError, setActionError] = useState('');
    const [saving, setSaving] = useState(false);

    const [modalOpen, setModalOpen] = useState(false);
    const [draft, setDraft] = useState<Draft>(emptyDraft);
    const [warnings, setWarnings] = useState<string[]>([]);
    const [formError, setFormError] = useState('');

    const [applying, setApplying] = useState(false);
    const [applyResult, setApplyResult] = useState<ApplyResult | null>(null);

    const [status, setStatus] = useState<UnitStatus | null>(null);
    const [unitBusy, setUnitBusy] = useState(false);
    const [unitError, setUnitError] = useState('');

    const [logsOpen, setLogsOpen] = useState(false);
    const [logs, setLogs] = useState('No logs fetched yet.');
    const [logsBusy, setLogsBusy] = useState(false);

    const refresh = async () => {
        try {
            const data = await api<PresetsResponse>('/api/presets');
            setPresets(data.presets || []);
            setActive(data.active ?? null);
            setLoadError('');
        } catch (error) {
            setLoadError(getErrorMessage(error));
        }
    };

    useEffect(() => {
        let dead = false;
        void (async () => {
            try {
                const [presetData, buildData] = await Promise.all([
                    api<PresetsResponse>('/api/presets'),
                    api<BuildsResponse>('/api/builds'),
                ]);
                if (dead) return;
                setPresets(presetData.presets || []);
                setActive(presetData.active ?? null);
                setBuilds(buildData.builds || []);
            } catch (error) {
                if (!dead) setLoadError(getErrorMessage(error));
            }
        })();
        return () => { dead = true; };
    }, []);

    const refreshStatus = async () => {
        try {
            setStatus(await api<UnitStatus>('/api/unit/status'));
            setUnitError('');
        } catch (error) {
            setUnitError(getErrorMessage(error));
        }
    };

    useEffect(() => { void refreshStatus(); }, []);

    const openNew = () => {
        setDraft({ ...emptyDraft, build: builds[0]?.id || '' });
        setWarnings([]); setFormError('');
        setModalOpen(true);
    };

    const openEdit = (preset: Preset) => {
        setDraft(draftFrom(preset));
        setWarnings([]); setFormError('');
        setModalOpen(true);
    };

    const save = async () => {
        const request = draftToRequest(draft);
        if (!request.name) { setFormError('Preset needs a name.'); return; }
        setSaving(true); setFormError('');
        try {
            const result = await api<{ ok: boolean; warnings: string[] }>('/api/presets', {
                method: 'POST',
                body: JSON.stringify(request),
            });
            setWarnings(result.warnings || []);
            await refresh();
        } catch (error) {
            setFormError(getErrorMessage(error));
        } finally {
            setSaving(false);
        }
    };

    const activate = async (name: string) => {
        setActionError('');
        try {
            await api<{ ok: boolean; active: string }>('/api/presets/' + encodeURIComponent(name) + '/activate', { method: 'POST', body: '{}' });
            await refresh();
        } catch (error) {
            setActionError(getErrorMessage(error));
        }
    };

    const remove = async (name: string) => {
        if (!window.confirm('Delete preset "' + name + '"?')) return;
        setActionError('');
        try {
            await api<{ ok: boolean }>('/api/presets/' + encodeURIComponent(name), { method: 'DELETE' });
            await refresh();
        } catch (error) {
            setActionError(getErrorMessage(error));
        }
    };

    const apply = async () => {
        setApplying(true); setActionError(''); setApplyResult(null);
        try {
            const result = await api<ApplyResult>('/api/apply', { method: 'POST', body: JSON.stringify({ restart: true }) });
            setApplyResult(result);
            if (result.error) setActionError(result.error);
            await refreshStatus();
        } catch (error) {
            setApplyResult({ ok: false, warnings: [], error: getErrorMessage(error) });
        } finally {
            setApplying(false);
        }
    };

    const unitOp = async (op: 'start' | 'stop' | 'restart') => {
        setUnitBusy(true); setUnitError('');
        try {
            const result = await api<UnitOpResponse>('/api/unit/' + op, { method: 'POST', body: '{}' });
            if (!result.ok) setUnitError(result.output);
        } catch (error) {
            setUnitError(getErrorMessage(error));
        } finally {
            setUnitBusy(false);
            await refreshStatus();
        }
    };

    const fetchLogs = async () => {
        setLogsBusy(true);
        try {
            const result = await api<{ logs: string }>('/api/unit/logs?lines=200');
            setLogs(result.logs || 'No logs returned.');
        } catch (error) {
            setLogs('Failed to fetch logs: ' + getErrorMessage(error));
        } finally {
            setLogsBusy(false);
        }
    };

    const unitDisabled = status?.activeState === 'disabled';
    const unitStateColor = status?.activeState === 'active' ? 'text-emerald-400'
        : status?.activeState === 'inactive' ? 'text-neutral-400'
            : status?.activeState === 'error' ? 'text-red-400'
                : 'text-amber-400';

    const field = (label: string, key: keyof Draft, type = 'text') => (
        <label className="block text-xs text-neutral-400">{label}
            <input type={type} value={String(draft[key] ?? '')} onChange={event => setDraft(old => ({ ...old, [key]: type === 'checkbox' ? event.target.checked : event.target.value }))} className={fieldClass} />
        </label>
    );

    return (
        <section className="space-y-4" aria-label="Presets and systemd unit">
            {/* Header */}
            <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-bold uppercase tracking-wider text-neutral-300">Presets</h2>
                <span className={'rounded px-2 py-0.5 text-xs ' + (active ? 'bg-indigo-600/20 text-indigo-300' : 'bg-neutral-800 text-neutral-500')}>Active: {active || 'none'}</span>
                <button type="button" onClick={openNew} className={'ml-auto ' + btnPrimary}>New</button>
            </div>

            {loadError && <p role="alert" className="text-xs text-red-400">{loadError}</p>}
            {actionError && <p role="alert" className="text-xs text-red-400">{actionError}</p>}

            {/* Preset list */}
            <div className="space-y-2">
                {presets.length === 0 && <p className="text-xs text-neutral-500">No presets yet — create one with New.</p>}
                {presets.map(preset => (
                    <div key={preset.name} className="flex flex-wrap items-center gap-2 rounded border border-neutral-800 bg-neutral-900/60 px-3 py-2">
                        <div className="min-w-0 flex-1">
                            <p className="truncate text-sm text-neutral-200">
                                {preset.name}
                                {preset.label && <span className="ml-2 text-xs text-neutral-500">{preset.label}</span>}
                            </p>
                            <p className="truncate text-[11px] text-neutral-500">{preset.build || 'no build'} · {modelLabel(preset) || 'no model'}</p>
                        </div>
                        <div className="flex gap-1.5">
                            <button type="button" onClick={() => openEdit(preset)} className={btn}>Edit</button>
                            {active !== preset.name && (
                                <button type="button" onClick={() => void activate(preset.name)} className={btn}>Activate</button>
                            )}
                            <button type="button" onClick={() => void remove(preset.name)} className={btnDanger}>Delete</button>
                        </div>
                    </div>
                ))}
            </div>

            {/* Apply & Restart */}
            <div className="rounded border border-neutral-800 bg-neutral-900/60 p-3">
                <div className="flex items-center justify-between gap-3">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-neutral-500">Apply</h3>
                    <button type="button" onClick={() => void apply()} disabled={!active || applying} className={btnPrimary}>Apply &amp; Restart</button>
                </div>
                {!active && <p className="mt-2 text-[11px] text-neutral-500">Activate a preset first.</p>}
                {applyResult && (
                    <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded border border-neutral-800 bg-neutral-950/60 px-3 py-2 font-mono text-[10px] text-neutral-300">
                        {applyResult.error ? 'error: ' + applyResult.error
                            : 'ok: ' + applyResult.ok + '\ncommand:\n' + (applyResult.command || '')}
                        {applyResult.warnings?.length ? '\nwarnings:\n' + applyResult.warnings.join('\n') : ''}
                        {applyResult.restartOutput ? '\nrestart:\n' + applyResult.restartOutput : ''}
                    </pre>
                )}
            </div>

            {/* Unit status */}
            <div className="rounded border border-neutral-800 bg-neutral-900/60 p-3">
                <div className="flex flex-wrap items-center gap-3">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-neutral-500">Systemd Unit</h3>
                    {status && <span className={'text-xs font-semibold ' + unitStateColor}>{status.activeState}</span>}
                    {status && status.activeState !== 'disabled' && status.subState && <span className="text-[11px] text-neutral-500">{status.subState}</span>}
                    <div className="ml-auto flex gap-1.5">
                        <button type="button" onClick={() => void unitOp('start')} disabled={unitDisabled || unitBusy} className={btn}>Start</button>
                        <button type="button" onClick={() => void unitOp('stop')} disabled={unitDisabled || unitBusy} className={btn}>Stop</button>
                        <button type="button" onClick={() => void unitOp('restart')} disabled={unitDisabled || unitBusy} className={btn}>Restart</button>
                    </div>
                </div>
                {unitDisabled && <p className="mt-2 text-[11px] text-amber-400">Unit management disabled by server configuration.</p>}
                {unitError && <p role="alert" className="mt-2 text-xs text-red-400">{unitError}</p>}
                {status && !unitDisabled && (
                    <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] sm:grid-cols-4">
                        <div><dt className="text-neutral-600">PID</dt><dd className="text-neutral-300">{status.pid ?? '—'}</dd></div>
                        <div><dt className="text-neutral-600">Since</dt><dd className="text-neutral-300">{status.since || '—'}</dd></div>
                        <div><dt className="text-neutral-600">Restarts</dt><dd className="text-neutral-300">{status.restarts}</dd></div>
                        <div><dt className="text-neutral-600">Result</dt><dd className="text-neutral-300">{status.result || '—'}</dd></div>
                    </dl>
                )}
            </div>

            {/* Unit logs */}
            <div className="overflow-hidden rounded border border-neutral-800 bg-neutral-900/60">
                <div className="flex items-center">
                    <button type="button" onClick={() => setLogsOpen(open => !open)} aria-expanded={logsOpen} aria-controls="unit-logs" className="flex w-full items-center justify-between px-3 py-2 text-xs font-semibold text-neutral-300 hover:bg-neutral-800">
                        <span><span className="mr-2 text-emerald-400">●</span>Unit Logs</span><span>{logsOpen ? '▼' : '▶'}</span>
                    </button>
                    {logsOpen && <button type="button" onClick={() => void fetchLogs()} disabled={logsBusy} className={'mr-2 shrink-0 ' + btn}>{logsBusy ? 'Loading…' : 'Refresh'}</button>}
                </div>
                {logsOpen && <pre id="unit-logs" className="max-h-80 overflow-auto whitespace-pre-wrap select-text bg-neutral-950/50 px-3 py-2 font-mono text-[10px] text-neutral-400">{logs}</pre>}
            </div>

            {/* New / Edit modal */}
            {modalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="presentation">
                    <div role="dialog" aria-modal="true" aria-label="Preset editor" className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border border-neutral-700 bg-neutral-900 p-5 shadow-2xl">
                        <div className="mb-4 flex items-center justify-between">
                            <h2 className="text-sm font-bold text-neutral-200">{draft.name === emptyDraft.name ? 'New preset' : 'Edit preset'}</h2>
                            <button type="button" onClick={() => setModalOpen(false)} className="rounded px-3 py-2 text-sm text-neutral-300 hover:bg-neutral-800">Close</button>
                        </div>
                        {formError && <p role="alert" className="mb-3 text-xs text-red-400">{formError}</p>}
                        <div className="space-y-3">
                            {field('Name', 'name')}
                            <label className="block text-xs text-neutral-400">Build
                                <select value={draft.build} onChange={event => setDraft(old => ({ ...old, build: event.target.value }))} className={fieldClass}>
                                    <option value="">No build</option>
                                    {builds.map(build => <option key={build.id} value={build.id}>{build.label || build.id}</option>)}
                                </select>
                            </label>
                            {field('Label (optional)', 'label')}
                            <label className="block text-xs text-neutral-400">Model path
                                <input value={draft.modelPath} onChange={event => setDraft(old => ({ ...old, modelPath: event.target.value }))} placeholder="models/foo.gguf" className={fieldClass} />
                                <span className="mt-1 block text-[10px] text-neutral-500">May be relative to the models directory.</span>
                            </label>
                            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                                {field('Context', 'ctx', 'number')}
                                {field('GPU layers', 'ngl', 'number')}
                                {field('Port', 'port', 'number')}
                                {field('Temp', 'temp', 'number')}
                            </div>
                            <label className="flex items-center gap-2 text-xs text-neutral-300">
                                <input type="checkbox" checked={draft.fa} onChange={event => setDraft(old => ({ ...old, fa: event.target.checked }))} className="h-4 w-4 accent-indigo-500" />
                                Flash attention
                            </label>
                        </div>
                        {warnings.length > 0 && (
                            <div className="mt-3 space-y-1 rounded border border-amber-800/50 bg-amber-900/10 p-2">
                                {warnings.map((warning, index) => <p key={index} className="text-[11px] text-amber-400">{warning}</p>)}
                            </div>
                        )}
                        <div className="mt-4 flex justify-end gap-2">
                            <button type="button" onClick={() => void save()} disabled={saving} className={btnPrimary}>{saving ? 'Saving…' : 'Save'}</button>
                        </div>
                    </div>
                </div>
            )}
        </section>
    );
}
