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
    const { form, set, builds, actionError, preview, previewBusy, previewCommand, start, stop } = useLaunchForm();
    const locked = state?.state !== undefined && state.state !== 'stopped';
    const stopDisabled = state?.state === 'stopped';
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
            </fieldset>
            <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" disabled={previewBusy || locked} onClick={previewCommand} className={btn + ' bg-neutral-700'}>{previewBusy ? 'Previewing…' : 'Preview'}</button>
                <button type="button" disabled={locked || state?.state !== 'stopped'} onClick={start} className={btn + ' bg-emerald-700'}>Start</button>
                <button type="button" disabled={stopDisabled} onClick={stop} className={btn + ' bg-red-900'}>Stop</button>
            </div>
            {preview && <textarea readOnly aria-label="Launch command preview" value={preview} className={fieldClass + ' mt-2 font-mono text-[11px]'} rows={3} />}
        </div>
    );
}
