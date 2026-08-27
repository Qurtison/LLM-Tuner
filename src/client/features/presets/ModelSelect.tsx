/*
 * Model picker used by both the PresetDock and the ⌘K preset browser.
 * Lists scanned models from /api/models; a stored path that no longer
 * resolves still shows so nothing silently disappears.
 */
import type { ModelEntry } from '../../../../shared/contracts';

export function ModelSelect({ value, models, onChange, className }: { value: string; models: ModelEntry[]; onChange: (path: string) => void; className?: string }) {
    const cls = className ?? 'w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-100 focus:border-amber-500 focus:outline-none';
    const known = models.some(m => m.path === value);
    return (
        <select value={value} onChange={e => onChange(e.target.value)} className={cls}>
            {!value && <option value="">Pick model…</option>}
            {!known && value && <option value={value}>{value}</option>}
            {models.map(m => <option key={m.path} value={m.path}>{m.name} ({m.size} GB){m.source === 'huggingface' ? ' [HF cache]' : ''}</option>)}
        </select>
    );
}
