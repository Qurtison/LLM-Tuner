// HUGGING FACE PROXIES (browser stays same-origin) + model downloads.
import type { HfDownloadStreamFrame } from '../../../shared/contracts';
import { REPO_PATTERN } from '../services/hf';
import { jsonBodyOr400, sseResponse, type RouteCtx } from './context';

export async function handle(ctx: RouteCtx, req: Request, url: URL): Promise<Response | null> {
    const route = url.pathname;
    const method = req.method;

    if (route === '/api/hf/search' && method === 'GET') {
        const q = url.searchParams.get('q')?.trim() || '';
        const requested = Number.parseInt(url.searchParams.get('limit') || '10', 10);
        const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 100) : 10;
        try {
            const upstream = await fetch('https://huggingface.co/api/models?search=' + encodeURIComponent(q) + '&limit=' + limit, { signal: AbortSignal.timeout(10_000) });
            if (!upstream.ok) throw new Error('Hugging Face returned ' + upstream.status);
            const data: unknown = await upstream.json();
            if (!Array.isArray(data)) throw new Error('Invalid Hugging Face response');
            return ctx.json(data);
        } catch (err) {
            return ctx.json({ error: err instanceof Error ? err.message : 'Hugging Face search failed' }, 502);
        }
    }
    if (route === '/api/hf/readme' && method === 'GET') {
        const repo = url.searchParams.get('repo') || '';
        if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return ctx.json({ error: 'Invalid repository' }, 502);
        try {
            const upstream = await fetch('https://huggingface.co/' + repo + '/raw/main/README.md', { signal: AbortSignal.timeout(10_000) });
            if (!upstream.ok) throw new Error('Hugging Face returned ' + upstream.status);
            return new Response(await upstream.text(), { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
        } catch (err) {
            return ctx.json({ error: err instanceof Error ? err.message : 'Hugging Face README fetch failed' }, 502);
        }
    }

    // --- MODEL DOWNLOADS ---
    // GET /api/hf/repo?repo=owner/name -> the repo's GGUF quants plus which of
    // them are already on disk. The listing is remembered server side so the
    // matching POST does not have to hit the network again.
    if (route === '/api/hf/repo' && method === 'GET') {
        const repo = (url.searchParams.get('repo') || '').trim();
        if (!REPO_PATTERN.test(repo)) return ctx.json({ error: 'Invalid repository (expected owner/name)' }, 400);
        try {
            const listing = await ctx.hf.listRepo(repo);
            ctx.hf.rememberListing(listing);
            return ctx.json(listing);
        } catch (err) {
            return ctx.json({ error: err instanceof Error ? err.message : 'Hugging Face lookup failed' }, 502);
        }
    }
    // POST /api/hf/download { repo, files: [name] } -> starts one task.
    if (route === '/api/hf/download' && method === 'POST') {
        const body = await jsonBodyOr400(ctx, req);
        const repo = String(body.repo || '');
        const files = Array.isArray(body.files) ? body.files.map(String) : [];
        try {
            return ctx.json({ ok: true, task: ctx.hf.start(repo, files) });
        } catch (err) {
            // 400 for anything the caller can fix (bad repo, nothing selected,
            // a second concurrent task), matching the rest of the API's shapes.
            return ctx.json({ error: err instanceof Error ? err.message : 'Could not start the download' }, 400);
        }
    }
    // POST /api/hf/download/cancel { id } -> aborts the in-flight request and
    // keeps the .part file for a later resume.
    if (route === '/api/hf/download/cancel' && method === 'POST') {
        const body = await jsonBodyOr400(ctx, req);
        return ctx.json({ ok: ctx.hf.cancel(String(body.id || '')) });
    }
    // POST /api/hf/download/resume { id } -> picks a paused or failed task up
    // again from its .part. The file list comes from the task itself, so this
    // works without a fresh repo lookup (and after a listing cache miss).
    if (route === '/api/hf/download/resume' && method === 'POST') {
        const body = await jsonBodyOr400(ctx, req);
        try {
            return ctx.json({ ok: true, task: await ctx.hf.resume(String(body.id || '')) });
        } catch (err) {
            return ctx.json({ error: err instanceof Error ? err.message : 'Could not resume the download' }, 400);
        }
    }
    // GET /api/hf/download/stream -> SSE task snapshots. Every frame carries
    // the whole task list; the modal renders from it and never polls.
    if (route === '/api/hf/download/stream' && method === 'GET') {
        let unsubscribe: (() => void) | null = null;
        const stream = new ReadableStream({
            start(controller) {
                const encoder = new TextEncoder();
                const emit = () => {
                    try {
                        const frame: HfDownloadStreamFrame = { tasks: ctx.hf.snapshot() };
                        controller.enqueue(encoder.encode('data: ' + JSON.stringify(frame) + '\n\n'));
                    } catch { /* client gone; the abort handler cleans up */ }
                };
                emit();
                unsubscribe = ctx.hf.subscribe(emit);
                req.signal.addEventListener('abort', () => {
                    unsubscribe?.();
                    try { controller.close(); } catch { /* already closed */ }
                });
            },
            cancel() { unsubscribe?.(); },
        });
        return sseResponse(stream);
    }

    return null;
}
