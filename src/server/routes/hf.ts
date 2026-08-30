// HUGGING FACE PROXIES (browser stays same-origin).
import type { RouteCtx } from './context';

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

    return null;
}
