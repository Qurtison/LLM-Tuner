/*
 * LaunchBar: preset picker, build selector, GPU A/B + RPC, Preview/Start/Stop.
 * The selected preset owns the model and per-model settings (ctx, ngl,
 * sampling, cacheK/V, spec, reasoning, jinja, ...); launch requests compose
 * the preset config over the form fields. Models are chosen inside the
 * preset (PresetDock modelPath dropdown).
 */
import HfSearchPanel from './HfSearchPanel';
import { fieldClass, useLaunchForm } from '../../components/launchForm';
import { usePresets } from '../../hooks/usePresets';
import { useServer } from '../../state/server';

export default function LaunchBar() {
    const { state } = useServer();
    const { presets, active, setActive } = usePresets();
    const { form, set, builds, actionError, preview, previewBusy, previewCommand, start, stop } = useLaunchForm();
    const locked = state?.state !== undefined && state.state !== 'stopped';
    const stopDisabled = state?.state === 'stopped';
    return (
        <div className="space-y-3">
            <div className="flex items-center justify-end">
                <HfSearchPanel />
            </div>
            {actionError && <p role="alert" className="text-xs text-red-400">{actionError}</p>}
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
            <div className="flex flex-wrap gap-2">
                <button type="button" disabled={previewBusy || locked} onClick={previewCommand} className="rounded bg-neutral-700 px-3 py-1.5 text-xs disabled:opacity-50">{previewBusy ? 'Previewing…' : 'Preview'}</button>
                <button type="button" disabled={locked || state?.state !== 'stopped'} onClick={start} className="rounded bg-emerald-700 px-3 py-1.5 text-xs disabled:opacity-50">Start</button>
                <button type="button" disabled={stopDisabled} onClick={stop} className="rounded bg-red-900 px-3 py-1.5 text-xs disabled:opacity-50">Stop</button>
            </div>
            {preview && <textarea readOnly aria-label="Launch command preview" value={preview} className={fieldClass + ' font-mono text-[11px]'} rows={3} />}
        </div>
    );
}
