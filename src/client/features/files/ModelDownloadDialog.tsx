// Model download modal (opened from the file browser's "Download new").
//
// Flow: paste a repo URL or owner/name -> the server lists the repo's GGUF
// quants and marks the ones already on disk -> tick the ones you want ->
// download, with per-file and overall progress pushed over SSE.
//
// This is a dedicated per-resource stream: the modal owns
// /api/hf/download/stream itself rather than riding the shared /api/status
// feed, because the bytes are large and the frames are only interesting here.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api/client';
import { getErrorMessage } from '../../api/errors';
import { useEventSource } from '../../hooks/useEventSource';
import type { HfDownloadTask, HfRepoFile, HfRepoListing } from '../../../../shared/contracts';

type Props = { onClose: () => void; onDownloaded: () => void };

const GB = 1024 ** 3;

function formatBytes(value: number): string {
    if (!Number.isFinite(value) || value <= 0) return '0 B';
    if (value >= GB) return (value / GB).toFixed(value / GB >= 100 ? 0 : 1) + ' GB';
    if (value >= 1024 ** 2) return (value / 1024 ** 2).toFixed(0) + ' MB';
    if (value >= 1024) return (value / 1024).toFixed(0) + ' KB';
    return value + ' B';
}

function formatRate(bytesPerSecond: number): string {
    return bytesPerSecond > 0 ? formatBytes(bytesPerSecond) + '/s' : '—';
}

function formatEta(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds <= 0) return '—';
    if (seconds < 60) return Math.ceil(seconds) + 's';
    if (seconds < 3600) return Math.floor(seconds / 60) + 'm ' + Math.round(seconds % 60) + 's';
    return Math.floor(seconds / 3600) + 'h ' + Math.round((seconds % 3600) / 60) + 'm';
}

// Accepts a bare "owner/name" or any huggingface.co URL form, so a link can be
// pasted straight out of the browser address bar.
function parseRepo(input: string): string {
    const trimmed = input.trim();
    if (!trimmed) return '';
    const withoutOrigin = trimmed.replace(/^https?:\/\/(www\.)?huggingface\.co\//i, '');
    const head = withoutOrigin.split(/[?#]/)[0];
    const cleaned = head.replace(/^\/+|\/+$/g, '');
    const owner = cleaned.split('/')[0] || '';
    const name = cleaned.split('/')[1] || '';
    if (!owner || !name) return '';
    return owner + '/' + name;
}

/** Rows grouped by quant family, splits collapsed into one row per quant. */
type Group = {
    key: string;
    label: string;
    files: HfRepoFile[];
    size: number;
    present: boolean;
    partial: number;
};

function groupFiles(files: HfRepoFile[]): Group[] {
    const byGroup = new Map<string, HfRepoFile[]>();
    for (const file of files) {
        const bucket = byGroup.get(file.group);
        if (bucket) bucket.push(file); else byGroup.set(file.group, [file]);
    }
    const groups: Group[] = [...byGroup.entries()].map(([key, bucket]) => ({
        key,
        label: bucket[0].quant,
        files: bucket,
        size: bucket.reduce((sum, file) => sum + file.size, 0),
        present: bucket.every(file => file.present),
        partial: bucket.reduce((sum, file) => sum + file.partial, 0),
    }));
    // Smallest first: the cheap quants are what most people want to see at
    // the top, and the sizes double as a rough quality ranking.
    return groups.sort((a, b) => a.size - b.size);
}

export default function ModelDownloadDialog({ onClose, onDownloaded }: Props) {
    const [term, setTerm] = useState('');
    const [listing, setListing] = useState<HfRepoListing | null>(null);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [looking, setLooking] = useState(false);
    const [error, setError] = useState('');
    const [tasks, setTasks] = useState<HfDownloadTask[]>([]);

    const inputRef = useRef<HTMLInputElement>(null);
    const dialogRef = useRef<HTMLDivElement>(null);
    // Pushed by the stream, read by an effect that reloads the browser.
    const doneRef = useRef(onDownloaded);

    useEffect(() => { doneRef.current = onDownloaded; }, [onDownloaded]);

    useEffect(() => {
        inputRef.current?.focus();
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') { onClose(); return; }
            if (event.key !== 'Tab') return;
            const focusable = dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])');
            if (!focusable?.length) return;
            const items = [...focusable];
            const first = items[0];
            const last = items[items.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        };
        window.addEventListener('keydown', onKeyDown);
        // No focus restore here: the opener button belongs to the file browser
        // that owns this dialog, so it restores focus itself on unmount.
        return () => { window.removeEventListener('keydown', onKeyDown); };
    }, [onClose]);

    useEventSource('/api/hf/download/stream', data => {
        try {
            const frame = JSON.parse(data) as { tasks?: HfDownloadTask[] };
            setTasks(frame.tasks ?? []);
        } catch { /* a truncated frame is not worth tearing the stream down for */ }
    });

    // The models dir just changed: refresh the listing behind the modal.
    const settled = tasks.filter(task => task.status === 'done').map(task => task.id).join(',');
    useEffect(() => {
        if (!settled) return;
        doneRef.current();
    }, [settled]);

    const groups = useMemo(() => (listing ? groupFiles(listing.files) : []), [listing]);
    const active = tasks.find(task => task.status === 'running' || task.status === 'queued') || null;
    const history = tasks.filter(task => task.status === 'done' || task.status === 'failed' || task.status === 'cancelled').slice(-4).reverse();

    const repo = parseRepo(term);
    const chosen = useMemo(
        () => groups.filter(group => [...group.files].every(file => selected.has(file.name))),
        [groups, selected],
    );
    const chosenSize = chosen.reduce((sum, group) => sum + group.size, 0);

    const look = useCallback(async () => {
        if (!repo) { setError('Enter a repository as owner/name or paste its Hugging Face URL.'); return; }
        setLooking(true); setError(''); setListing(null); setSelected(new Set());
        try {
            const data = await api<HfRepoListing>('/api/hf/repo?repo=' + encodeURIComponent(repo));
            setListing(data);
            // Pre-tick the cheapest quant as a sane default; the user is
            // looking for one model to run, not the whole table.
            setSelected(new Set(groupsFirstKey(data) ? [groupsFirstKey(data) as string] : []));
        } catch (cause) {
            setError(getErrorMessage(cause, 'Could not read that repository.'));
        } finally {
            setLooking(false);
        }
    }, [repo]);

    const toggle = (group: Group) => {
        setSelected(prev => {
            const next = new Set(prev);
            const allOn = group.files.every(file => next.has(file.name));
            for (const file of group.files) {
                if (allOn) next.delete(file.name); else next.add(file.name);
            }
            return next;
        });
    };

    const setAll = (on: boolean) => {
        setSelected(on ? new Set(groups.flatMap(group => group.files.map(file => file.name))) : new Set());
    };

    const start = async () => {
        if (!listing || chosen.length === 0) return;
        setError('');
        try {
            await api('/api/hf/download', {
                method: 'POST',
                body: JSON.stringify({ repo: listing.repo, files: [...selected] }),
            });
        } catch (cause) {
            setError(getErrorMessage(cause, 'Could not start the download.'));
        }
    };

    const cancel = async (id: string) => {
        setError('');
        try {
            await api('/api/hf/download/cancel', { method: 'POST', body: JSON.stringify({ id }) });
        } catch (cause) {
            setError(getErrorMessage(cause, 'Could not cancel the download.'));
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="presentation">
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-label="Download a model from Hugging Face"
                className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-neutral-700 bg-neutral-900 shadow-2xl"
            >
                <header className="flex items-center gap-3 border-b border-neutral-800 p-4">
                    <h2 className="text-sm font-bold uppercase tracking-wider text-neutral-200">Download new model</h2>
                    <button type="button" onClick={onClose} className="ml-auto rounded px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-800">Close</button>
                </header>

                <div className="min-h-0 flex-1 overflow-y-auto p-4">
                    <form
                        className="flex flex-wrap gap-2"
                        onSubmit={event => { event.preventDefault(); void look(); }}
                    >
                        <input
                            ref={inputRef}
                            value={term}
                            onChange={event => setTerm(event.target.value)}
                            placeholder="owner/name or paste a huggingface.co link"
                            aria-label="Hugging Face repository"
                            className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm outline-none focus:border-indigo-400"
                        />
                        <button type="submit" disabled={looking} className="rounded bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
                            {looking ? 'Loading…' : 'List versions'}
                        </button>
                    </form>

                    {error && <p role="alert" className="mt-2 text-sm text-red-400">{error}</p>}

                    {listing && (
                        <div className="mt-3">
                            <p className="text-xs text-neutral-400">
                                <span className="font-mono text-indigo-300">{listing.repo}</span>
                                {' · '}{listing.files.length} file{listing.files.length === 1 ? '' : 's'} · {formatBytes(listing.totalSize)}
                                {listing.presentSize > 0 && ' · ' + formatBytes(listing.presentSize) + ' already on disk'}
                            </p>
                            <p className="mt-1 font-mono text-[11px] text-neutral-500">→ {listing.folder}/</p>

                            <div className="mt-2 flex items-center gap-2 text-xs">
                                <button type="button" onClick={() => setAll(true)} className="rounded border border-neutral-700 px-2 py-1 text-neutral-300 hover:bg-neutral-700">Select all</button>
                                <button type="button" onClick={() => setAll(false)} className="rounded border border-neutral-700 px-2 py-1 text-neutral-300 hover:bg-neutral-700">Clear</button>
                            </div>

                            <ul className="mt-2 max-h-64 space-y-0.5 overflow-y-auto text-xs">
                                {groups.map(group => {
                                    const on = group.files.every(file => selected.has(file.name));
                                    return (
                                        <li key={group.key} className="flex items-center gap-2 rounded px-2 py-1 hover:bg-neutral-800">
                                            <input
                                                id={'hf-q-' + group.key}
                                                type="checkbox"
                                                checked={on}
                                                disabled={group.present}
                                                onChange={() => toggle(group)}
                                                className="accent-indigo-500"
                                            />
                                            <label htmlFor={'hf-q-' + group.key} className="min-w-0 flex-1 cursor-pointer truncate text-neutral-200">
                                                {group.label}
                                                {group.files.length > 1 && <span className="text-neutral-500"> ({group.files.length} shards)</span>}
                                            </label>
                                            {group.present && <span className="shrink-0 text-[10px] text-emerald-400">downloaded</span>}
                                            {!group.present && group.partial > 0 && (
                                                <span className="shrink-0 text-[10px] text-amber-400">resumable {formatBytes(group.partial)}</span>
                                            )}
                                            <span className="ml-auto shrink-0 font-mono text-neutral-500">{formatBytes(group.size)}</span>
                                        </li>
                                    );
                                })}
                            </ul>

                            <div className="mt-3 flex flex-wrap items-center gap-3">
                                <button
                                    type="button"
                                    onClick={() => void start()}
                                    disabled={chosen.length === 0 || Boolean(active)}
                                    className="rounded bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                                >
                                    {active
                                        ? 'Download in progress…'
                                        : 'Download ' + (chosen.length ? chosen.length + ' selected' : '') + (chosenSize ? ' · ' + formatBytes(chosenSize) : '')}
                                </button>
                                {active && (
                                    <button type="button" onClick={() => void cancel(active.id)} className="rounded border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-300 hover:bg-red-900/50">
                                        Cancel
                                    </button>
                                )}
                            </div>
                        </div>
                    )}

                    {active && <Progress task={active} />}

                    {history.length > 0 && (
                        <ul className="mt-4 space-y-1 border-t border-neutral-800 pt-3 text-xs">
                            {history.map(task => (
                                <li key={task.id} className="flex items-center gap-2 text-neutral-400">
                                    <span className="truncate font-mono">{task.repo}</span>
                                    <span className="ml-auto shrink-0">
                                        {task.status === 'done' && <span className="text-emerald-400">done</span>}
                                        {task.status === 'failed' && <span className="text-red-400" title={task.error}>failed: {task.error}</span>}
                                        {task.status === 'cancelled' && <span className="text-neutral-500">cancelled</span>}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </div>
        </div>
    );
}

/** The cheapest quant's files, as the default selection. */
function groupsFirstKey(listing: HfRepoListing): string | null {
    const groups = groupFiles(listing.files);
    return groups.length ? groups[0].key : null;
}

function Progress({ task }: { task: HfDownloadTask }) {
    const file = task.files[task.fileIndex];
    const done = task.completedBytes + task.received;
    const total = task.taskTotal;
    const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;
    const eta = task.bytesPerSecond > 0 ? (total - done) / task.bytesPerSecond : 0;
    return (
        <div className="mt-4 rounded-lg border border-neutral-700 bg-neutral-950 p-3 text-xs">
            <div className="flex items-center gap-2">
                <span className="truncate font-mono text-indigo-300">{file ? file.name : ''}</span>
                <span className="ml-auto shrink-0 text-neutral-400">{formatRate(task.bytesPerSecond)}</span>
            </div>
            <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(pct)}
                className="mt-2 h-2 overflow-hidden rounded bg-neutral-800"
            >
                <div className="h-full rounded bg-indigo-500 transition-[width] duration-200" style={{ width: pct.toFixed(1) + '%' }} />
            </div>
            <div className="mt-1 flex items-center gap-2 text-neutral-400">
                <span>{formatBytes(done)} / {formatBytes(total)}</span>
                <span>({pct.toFixed(1)}%)</span>
                {task.files.length > 1 && <span>· file {task.fileIndex + 1} of {task.files.length}</span>}
                <span className="ml-auto">ETA {formatEta(eta)}</span>
            </div>
        </div>
    );
}
