// TELEMETRY: one-shot latest sample, poll-rate control, and the SSE stream
// (server pushes every sample; clients no longer poll /api/telemetry/latest).
import { jsonBodyOr400, sseResponse, type RouteCtx } from './context';

export async function handle(ctx: RouteCtx, req: Request, url: URL): Promise<Response | null> {
    const route = url.pathname;
    const method = req.method;

    // TELEMETRY STREAM (SSE): current sample on connect, then one frame per
    // server-side sample at the configured poll rate (POST /api/telemetry/
    // rate controls it, same as before). Frame shape = /api/telemetry/latest
    // ({ t, stats }); stats may be null before the first sample lands.
    if (route === '/api/telemetry/stream' && method === 'GET') {
        let unsubscribe: (() => void) | null = null;
        const stream = new ReadableStream({
            start(controller) {
                const encoder = new TextEncoder();
                const emit = () => {
                    try {
                        const latest = ctx.telemetry.latest() || { t: 0, stats: null };
                        controller.enqueue(encoder.encode('data: ' + JSON.stringify(latest) + '\n\n'));
                    } catch { /* client gone; abort handler cleans up */ }
                };
                emit();
                unsubscribe = ctx.telemetry.onSample(emit);
                req.signal.addEventListener('abort', () => {
                    unsubscribe?.();
                    try { controller.close(); } catch { /* already closed */ }
                });
            },
            cancel() { unsubscribe?.(); },
        });
        return sseResponse(stream);
    }

    if (route === '/api/telemetry/latest' && method === 'GET') {
        return ctx.json(ctx.telemetry.latest() || { t: 0, stats: null });
    }
    if (route === '/api/telemetry/rate' && method === 'POST') {
        const rateBody = await jsonBodyOr400(ctx, req);
        const ms = ctx.telemetry.setPollMs(rateBody.ms as number);
        return ctx.json({ ok: true, ms });
    }

    return null;
}
