// MASTER LOGS: one-shot snapshot of the in-memory ring + the SSE tail/live
// follow stream.
import { sseResponse, type RouteCtx } from './context';

export async function handle(ctx: RouteCtx, req: Request, url: URL): Promise<Response | null> {
    const route = url.pathname;
    const method = req.method;

    if (route === '/api/master/logs' && method === 'GET') {
        const logs = ctx.llama.logs.length > 0
            ? ctx.llama.logs.join('\n')
            : 'No logs available. Start the server first.';
        return ctx.json({ logs });
    }

    // MASTER LOG STREAM (SSE tail + live follow).
    // One EventSource gets the ring's last ?lines= lines backfilled, then
    // every new llama-server line as it lands (LlamaService.onLine). Stays
    // open until the client disconnects; the abort handler unsubscribes and
    // closes so a gone client never accumulates listeners.
    if (route === '/api/master/logs/stream' && method === 'GET') {
        const requested = parseInt(url.searchParams.get('lines') || '200', 10);
        const tailCount = Number.isFinite(requested) ? Math.max(0, Math.min(requested, 500)) : 200;
        let unsubscribe: (() => void) | null = null;
        const stream = new ReadableStream({
            start(controller) {
                const encoder = new TextEncoder();
                const emit = (line: string) => {
                    try { controller.enqueue(encoder.encode('data: ' + line + '\n\n')); }
                    catch { /* client gone; abort handler cleans up */ }
                };
                for (const line of (tailCount > 0 ? ctx.llama.logs.slice(-tailCount) : [])) emit(line);
                unsubscribe = ctx.llama.onLine(emit);
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
