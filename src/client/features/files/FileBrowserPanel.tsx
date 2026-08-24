// Model file manager (gap G5, docs/gap-analysis.md): browse the models
// directory tree, delete files. Path-guarded server side; this panel only
// navigates + confirms deletions.
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { FilesResponse } from '../../../../shared/contracts';

function formatSize(size: number | null): string {
    if (size === null) return '—';
    if (size < 1024) return size + ' B';
    const units = ['KiB', 'MiB', 'GiB'];
    let value = size;
    let unit = 'B';
    for (const u of units) {
        if (value < 1024) { unit = u; break; }
        value /= 1024;
    }
    return value.toFixed(value >= 100 ? 0 : 1) + ' ' + unit;
}

function parentPath(path: string): string {
    const parts = path.split('/').filter(Boolean);
    parts.pop();
    return parts.join('/');
}

export default function FileBrowserPanel() {
    const [path, setPath] = useState('');
    const [data, setData] = useState<FilesResponse | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    const load = useCallback(async (requested: string) => {
        setLoading(true); setError('');
        try {
            const result = await api<FilesResponse>('/api/files?path=' + encodeURIComponent(requested));
            setData(result); setPath(result.path);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not load files.');
        } finally { setLoading(false); }
    }, []);
    useEffect(() => { void load(''); }, [load]);

    const remove = async (entry: { name: string; path: string }) => {
        if (!window.confirm('Delete ' + entry.name + '? This cannot be undone.')) return;
        setError('');
        try {
            await api<{ ok: boolean }>('/api/files/delete', { method: 'POST', body: JSON.stringify({ path: entry.path }) });
            await load(path);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Delete failed.');
        }
    };

    const crumbs = data ? data.path.split('/').filter(Boolean) : [];

    return (
        <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-3" aria-label="Model files">
            <h2 className="text-sm font-bold uppercase tracking-wider text-neutral-300">Models</h2>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                {path !== '' && (
                    <button type="button" onClick={() => void load(parentPath(path))} className="rounded border border-neutral-700 bg-neutral-800 px-2 py-1 text-neutral-300 hover:bg-neutral-700" title="Up one folder">↑ Up</button>
                )}
                <nav aria-label="Breadcrumb" className="flex min-w-0 flex-wrap items-center gap-1 font-mono text-neutral-400">
                    <button type="button" onClick={() => void load('')} className={path === '' ? 'text-indigo-300' : 'hover:text-neutral-200'}>{data?.root ?? '…'}</button>
                    {crumbs.map((part, index) => (
                        <span key={index} className="flex items-center gap-1">
                            <span className="text-neutral-600">/</span>
                            <button type="button" onClick={() => void load(crumbs.slice(0, index + 1).join('/'))} className={index === crumbs.length - 1 ? 'text-indigo-300' : 'hover:text-neutral-200'}>{part}</button>
                        </span>
                    ))}
                </nav>
            </div>
            {error && <p role="alert" className="mt-2 text-xs text-red-400">{error}</p>}
            {loading && <p className="mt-2 text-xs text-neutral-500">Loading…</p>}
            {!loading && data && (
                <ul className="mt-2 max-h-72 space-y-0.5 overflow-y-auto text-xs">
                    {data.entries.length === 0 && <li className="text-neutral-600">Empty directory</li>}
                    {data.entries.map(entry => entry.isDir ? (
                        <li key={entry.path}>
                            <button type="button" onClick={() => void load(entry.path)} className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-neutral-300 hover:bg-neutral-800">▸ <span className="truncate">{entry.name}</span></button>
                        </li>
                    ) : (
                        <li key={entry.path} className="flex items-center gap-2 rounded px-2 py-1 hover:bg-neutral-800">
                            <span className="truncate text-neutral-300">{entry.name}</span>
                            <span className="ml-auto shrink-0 font-mono text-neutral-500">{formatSize(entry.size)}</span>
                            <button type="button" onClick={() => void remove(entry)} className="shrink-0 rounded border border-red-900/60 bg-red-950/40 px-1.5 py-0.5 text-[10px] text-red-300 hover:bg-red-900/50" aria-label={'Delete ' + entry.name}>Delete</button>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}
