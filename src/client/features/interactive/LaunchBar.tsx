/*
 * LaunchBar: preset picker, build selector, Preview/Start/Stop. Rendered as
 * a fixed card in the top status strip (next to the two GPU cards), not as a
 * canvas panel — the engine is unreachable without it, so it never hides and
 * never moves.
 *
 * The selected preset owns the model and per-model settings (ctx, ngl,
 * sampling, cacheK/V, spec, reasoning, jinja, ...); launch requests compose
 * the preset config over the form fields. Models are chosen inside the
 * preset (PresetDock modelPath dropdown).
 */
import { fieldClass, useLaunchForm } from '../../components/launchForm';
import { usePresets } from '../../hooks/usePresets';
import { useServer } from '../../state/server';

export default function LaunchBar() {
    const { state } = useServer();
    const { presets, active, setActive } = usePresets();
    const { form, set, models, builds, actionError, preview, ini, previewBusy, previewCommand, start, stop } = useLaunchForm();
    const locked = state?.state !== undefined && state.state !== 'stopped';
    const stopDisabled = state?.state === 'stopped';
    const routerOn = form.routerEnabled;
    const btn = 'rounded px-3 py-1.5 text-xs disabled:opacity-50';
    return (
        <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
                <h3 className="truncate text-xs font-semibold text-neutral-200">Launch</h3>
                {locked && <span className="shrink-0 rounded bg-neutral-800 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-neutral-500">locked</span>}
            </div>
            {actionError && <p role="alert" className="mb-2 text-xs text-red-400">{actionError}</p>}
            <fieldset disabled={locked} className="space-y-2 disabled:opacity-50">
                <label className="block text-xs text-neutral-400">Preset
                    <select value={active?.name ?? ''} onChange={e => setActive(e.target.value || null)} className={fieldClass}>
                        {presets.length === 0 && <option value="">No presets — create one in the dock</option>}
                        {presets.length > 0 && !active && <option value="">Select preset…</option>}
                        {presets.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
                    </select>
                </label>
                <label className="block text-xs text-neutral-400">Build
                    <select value={form.build} onChange={e => set('build', e.target.value)} className={fieldClass}>
                        <option value="">No build</option>
                        {builds.map(b => <option key={b.id} value={b.id}>{b.label || b.id}</option>)}
                    </select>
                </label>
                {/* Router mode: llama-server discovers the models dir instead of
                    serving one -m model. Clients that manage models themselves
                    (pi's /llama and /model) need this; the per-model knobs still
                    come from the preset and are written to a generated INI. */}
                <label className="flex items-center gap-2 text-xs text-neutral-400">
                    <input type="checkbox" checked={routerOn} onChange={e => set('routerEnabled', e.target.checked)} />
                    Router mode (multi-model)
                </label>
                {routerOn && (
                    <>
                        <label className="block text-xs text-neutral-400">Max models resident (default 1; 0 = unlimited)
                            <input
                                type="number"
                                min={0}
                                value={form.routerMax}
                                placeholder="1"
                                onChange={e => set('routerMax', e.target.value)}
                                className={fieldClass}
                            />
                        </label>
                        <label className="flex items-center gap-2 text-xs text-neutral-400">
                            <input type="checkbox" checked={form.routerAutoload} onChange={e => set('routerAutoload', e.target.checked)} />
                            Load a model on first request when it is not resident
                        </label>
                        {models.length > 0 && (
                            <fieldset className="text-xs text-neutral-400">
                                <legend className="mb-1">Load at startup</legend>
                                <div className="max-h-32 space-y-1 overflow-y-auto rounded border border-neutral-800 p-1.5">
                                    {models.map(m => (
                                        <label key={m.path} className="flex items-center gap-2 truncate" title={m.path}>
                                            <input
                                                type="checkbox"
                                                checked={!!form.routerStartup[m.path]}
                                                onChange={e => set('routerStartup', { ...form.routerStartup, [m.path]: e.target.checked })}
                                            />
                                            <span className="truncate">{m.name}</span>
                                        </label>
                                    ))}
                                </div>
                            </fieldset>
                        )}
                        <p className="text-[10px] leading-snug text-neutral-500">
                            Every model in the models directory is served either way. Ticked ones are
                            already resident when the router starts. The preset&apos;s ctx, GPU layers,
                            cache and sampling settings apply to all of them.
                        </p>
                    </>
                )}
            </fieldset>
            <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" disabled={previewBusy || locked} onClick={previewCommand} className={btn + ' bg-neutral-700'}>{previewBusy ? 'Previewing…' : 'Preview'}</button>
                <button type="button" disabled={locked || state?.state !== 'stopped'} onClick={start} className={btn + ' bg-emerald-700'}>Start</button>
                <button type="button" disabled={stopDisabled} onClick={stop} className={btn + ' bg-red-900'}>Stop</button>
            </div>
            {preview && <textarea readOnly aria-label="Launch command preview" value={preview} className={fieldClass + ' mt-2 font-mono text-[11px]'} rows={3} />}
            {ini && (
                <>
                    <p className="mt-2 text-[10px] text-neutral-500">
                        Model preset written next to launch.sh (generated/router.ini) and passed via
                        --models-preset. In router mode this is where the preset&apos;s per-model settings
                        go, so the command line above looks deceptively empty.
                    </p>
                    <textarea readOnly aria-label="Generated router model preset" value={ini} className={fieldClass + ' mt-1 font-mono text-[11px]'} rows={12} />
                </>
            )}
        </div>
    );
}
