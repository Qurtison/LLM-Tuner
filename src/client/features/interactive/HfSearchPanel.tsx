import { marked } from 'marked';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import { useServer } from '../../state/server';
import { pickHfModel } from './HfModelPick';

type HfModel = { id: string; downloads?: number; likes?: number; lastModified?: string };
type HfError = { error: string };

// Removes executable elements, event handlers, unsafe URLs, and srcdoc. Marked output
// remains structural HTML only; extend allowlist if richer README HTML becomes required.
export function sanitizeMarkdownHtml(html: string): string {
    if (typeof DOMParser === 'undefined') return '';
    const document = new DOMParser().parseFromString(html, 'text/html');
    for (const element of document.querySelectorAll('script, style, iframe, object, embed, link, meta, base, form')) element.remove();
    for (const element of document.querySelectorAll('*')) {
        for (const attribute of [...element.attributes]) {
            const name = attribute.name.toLowerCase();
            const value = attribute.value.trim().toLowerCase();
            if (name.startsWith('on') || name === 'srcdoc' || ((name === 'href' || name === 'src' || name === 'xlink:href') && /^(javascript|data:text\/html|vbscript):/.test(value))) element.removeAttribute(attribute.name);
        }
    }
    return document.body.innerHTML;
}

export function MarkdownMessage({ markdown }: { markdown: string }) {
    const html = sanitizeMarkdownHtml(marked.parse(markdown) as string);
    return <div className="markdown-body prose prose-invert max-w-none break-words text-sm" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function ReasoningDisclosure({ children }: { children: React.ReactNode }) {
    const [open, setOpen] = useState(false);
    return <div className="rounded border border-neutral-700 bg-neutral-900"><button type="button" className="w-full px-3 py-2 text-left text-xs text-neutral-300" aria-expanded={open} onClick={() => setOpen(!open)}>Reasoning {open ? '▲' : '▼'}</button>{open && <div className="p-3 text-sm text-neutral-300">{children}</div>}</div>;
}

function number(value: number | undefined): string { return typeof value === 'number' ? value.toLocaleString() : '—'; }
function modified(value: string | undefined): string { return value ? new Date(value).toLocaleDateString() : '—'; }

export default function HfSearchPanel() {
    const { state } = useServer();
    const [open, setOpen] = useState(false);
    const [term, setTerm] = useState('');
    const [results, setResults] = useState<HfModel[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [selected, setSelected] = useState<HfModel | null>(null);
    const [readme, setReadme] = useState('');
    const [readmeLoading, setReadmeLoading] = useState(false);
    const [readmeError, setReadmeError] = useState('');
    const openerRef = useRef<HTMLButtonElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const dialogRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        inputRef.current?.focus();
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') { setOpen(false); return; }
            if (event.key !== 'Tab') return;
            const focusable = dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])');
            if (!focusable?.length) return;
            const items = [...focusable];
            const first = items[0]; const last = items[items.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => { window.removeEventListener('keydown', onKeyDown); openerRef.current?.focus(); };
    }, [open]);

    useEffect(() => {
        const query = term.trim();
        if (!open || !query) { setResults([]); setError(''); setLoading(false); return; }
        const controller = new AbortController();
        const timer = window.setTimeout(() => {
            setLoading(true); setError('');
            api<HfModel[] | HfError>('/api/hf/search?q=' + encodeURIComponent(query) + '&limit=10', { signal: controller.signal })
                .then(data => { if ('error' in data) throw new Error(data.error); setResults(data.filter(model => model.id.toLowerCase().includes('gguf'))); })
                .catch(err => { if (err.name !== 'AbortError') { setResults([]); setError(err instanceof Error ? err.message : 'Search failed.'); } })
                .finally(() => { if (!controller.signal.aborted) setLoading(false); });
        }, 300);
        return () => { controller.abort(); window.clearTimeout(timer); };
    }, [open, term]);

    const select = async (model: HfModel) => {
        setSelected(model); setReadme(''); setReadmeError(''); setReadmeLoading(true);
        try {
            const response = await fetch('/api/hf/readme?repo=' + encodeURIComponent(model.id), { headers: { Accept: 'text/markdown' } });
            const text = await response.text();
            if (!response.ok) { let message = text; try { message = (JSON.parse(text) as HfError).error; } catch {} throw new Error(message || 'README fetch failed.'); }
            setReadme(text);
        } catch (err) { setReadmeError(err instanceof Error ? err.message : 'README fetch failed.'); }
        finally { setReadmeLoading(false); }
    };

    return <>
        <button ref={openerRef} type="button" onClick={() => setOpen(true)} className="rounded bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500">Search Hugging Face</button>
        {open && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="presentation">
            <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Search Hugging Face models" className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-xl border border-neutral-700 bg-neutral-900 p-5 shadow-2xl">
                <div className="mb-4 flex items-center gap-3"><input ref={inputRef} value={term} onChange={event => setTerm(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') setTerm(term.trim()); }} placeholder="Search GGUF models" aria-label="Search Hugging Face models" className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm outline-none focus:border-indigo-400" /><button type="button" onClick={() => setOpen(false)} className="rounded px-3 py-2 text-sm text-neutral-300 hover:bg-neutral-800">Close</button></div>
                {state?.state === 'loading' && <p className="mb-3 text-xs text-amber-400">Engine loading. Model selection stays available.</p>}
                {loading && <p className="text-sm text-neutral-400">Searching…</p>}
                {error && <p role="alert" className="text-sm text-red-400">Search failed: {error}</p>}
                {!loading && !error && term.trim() && results.length === 0 && <p className="text-sm text-neutral-500">No GGUF models found.</p>}
                {!term.trim() && <p className="text-sm text-neutral-500">Enter model name to search.</p>}
                <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"><div className="space-y-2">{results.map(model => <button type="button" key={model.id} onClick={() => void select(model)} className="block w-full rounded-lg border border-neutral-700 bg-neutral-800 p-3 text-left hover:border-indigo-500"><span className="block break-all text-sm font-semibold text-indigo-300">{model.id}</span><span className="mt-1 block text-xs text-neutral-400">Downloads: {number(model.downloads)} · Likes: {number(model.likes)} · Modified: {modified(model.lastModified)}</span></button>)}</div>{selected && <section className="min-w-0 rounded-lg border border-neutral-700 bg-neutral-950 p-4"><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h2 className="break-all text-sm font-semibold text-indigo-300">{selected.id}</h2><button type="button" onClick={() => { pickHfModel(selected.id); setOpen(false); }} className="rounded bg-indigo-600 px-3 py-2 text-xs font-medium text-white hover:bg-indigo-500">Use this model</button></div>{readmeLoading && <p className="text-sm text-neutral-400">Loading README…</p>}{readmeError && <p role="alert" className="text-sm text-red-400">README failed: {readmeError}</p>}{readme && <MarkdownMessage markdown={readme} />}</section>}</div>
            </div>
        </div>}
    </>;
}
