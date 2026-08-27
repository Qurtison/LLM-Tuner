/*
 * LaunchBar: model picker, build selector, GPU A/B + RPC, Preview/Start/Stop.
 * Per-model settings (ctx, ngl, sampling, cacheK/V, spec, reasoning, jinja,
 * ...) are edited only in the PresetDock or the ⌘K preset browser; launch
 * requests compose those over the form fields.
 */
import HfSearchPanel from './HfSearchPanel';
import { fieldClass, useLaunchForm } from '../../components/launchForm';
import { useServer } from '../../state/server';

export default function LaunchBar() {
    const { state } = useServer();
    const { form, set, models, builds, devices, actionError, preview, previewBusy, previewCommand, start, stop } = useLaunchForm();
    const locked = state?.state !== undefined && state.state !== 'stopped';
    const stopDisabled = state?.state === 'stopped';
    return (
        <div className="space-y-3">
            <div className="flex items-center justify-end">
                <HfSearchPanel />
            </div>
            {actionError && <p role="alert" className="text-xs text-red-400">{actionError}</p>}
            <fieldset disabled={locked} className="space-y-2 disabled:opacity-50">
                <label className="block text-xs text-neutral-400">Model
                    <select value={form.modelPath} onChange={e => set('modelPath', e.target.value)} className={fieldClass}>
                        <option value="">{models.length ? 'Choose model' : 'Loading models…'}</option>
                        {models.map(m => <option key={m.path} value={m.path}>{m.name} ({m.size} GB){m.source === 'huggingface' ? ' [HF cache]' : ''}</option>)}
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
