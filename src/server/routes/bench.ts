// BENCH routes: single config or { queue } (server-side matrix queue),
// plus /api/bench/stream (SSE state push; output lines stay on the
// /api/status BENCH: broadcast so frames carry no output array).
import type { BenchStreamFrame } from '../../../shared/contracts';
import { jsonBodyOr400, sseResponse, type RouteCtx } from './context';

export async function handle(ctx: RouteCtx, req: Request, url: URL): Promise<Response | null> {
    const route = url.pathname;
    const method = req.method;

    if (route === '/api/bench/start' && method === 'POST') {
        const cfg = await jsonBodyOr400(ctx, req);
        const result = ctx.bench.start(cfg);
        if (result.error) return ctx.json({ error: result.error }, result.code || 500);
        // Frozen shapes: queue mode carries queued, single mode does not.
        return ctx.json(result.queued !== undefined ? { ok: true, queued: result.queued, command: result.command } : { ok: true, command: result.command });
    }
    if (route === '/api/bench/status' && method === 'GET') {
        return ctx.json(ctx.bench.status());
    }
    if (route === '/api/bench/stop' && method === 'POST') {
        ctx.bench.stop();
        return ctx.json({ ok: true });
    }
    if (route === '/api/bench/clear' && method === 'POST') {
        ctx.bench.clear();
        return ctx.json({ ok: true });
    }
    if (route === '/api/bench/restore' && method === 'POST') {
        const output = await ctx.bench.restore();
        return ctx.json({ ok: true, output });
    }
    if (route === '/api/bench/dequeue' && method === 'POST') {
        const dq = await jsonBodyOr400(ctx, req);
        const res = ctx.bench.dequeue(dq.label);
        return ctx.json({ ok: true, removed: res.removed, queueRemaining: res.queueRemaining });
    }
    if (route === '/api/bench/note' && method === 'POST') {
        const noteBody = await jsonBodyOr400(ctx, req);
        ctx.bench.note(noteBody.lines);
        return ctx.json({ ok: true });
    }

    // BENCH STATE STREAM (SSE): current state on connect, then one
    // BenchStreamFrame per state transition (start, next matrix run,
    // finish, stop, queue drain/abort). Stays open until the client
    // disconnects; the abort handler unsubscribes so a gone client never
    // accumulates listeners.
    if (route === '/api/bench/stream' && method === 'GET') {
        let unsubscribe: (() => void) | null = null;
        const stream = new ReadableStream({
            start(controller) {
                const encoder = new TextEncoder();
                const emit = () => {
                    try {
                        const status = ctx.bench.status();
                        const frame: BenchStreamFrame = {
                            running: status.running,
                            command: status.command,
                            queueRemaining: status.queueRemaining,
                            queueTotal: status.queueTotal,
                            currentLabel: status.currentLabel,
                            samples: status.samples,
                        };
                        controller.enqueue(encoder.encode('data: ' + JSON.stringify(frame) + '\n\n'));
                    } catch { /* client gone; abort handler cleans up */ }
                };
                emit();
                unsubscribe = ctx.bench.subscribe(emit);
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
