// UPGRADE (gap G3; git pull + build, streamed over SSE). One run at a time.
import { runUpgrade } from '../services/upgrade';
import { sseResponse, type RouteCtx } from './context';

let upgradeRunning = false;

export async function handle(ctx: RouteCtx, req: Request, url: URL): Promise<Response | null> {
    const route = url.pathname;
    const method = req.method;

    if (route === '/api/upgrade/status' && method === 'GET') {
        return ctx.json({ running: upgradeRunning });
    }
    if (route === '/api/upgrade/stream' && method === 'GET') {
        if (!ctx.config.upgrade.enabled || !ctx.config.upgrade.repoDir || !ctx.config.upgrade.buildDir) {
            return ctx.json({ error: 'upgrade not configured' }, 400);
        }
        if (upgradeRunning) return ctx.json({ error: 'upgrade already running' }, 409);
        upgradeRunning = true;
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
            async start(controller) {
                const emit = (line: string) => {
                    try {
                        for (const ln of line.split('\n')) {
                            controller.enqueue(encoder.encode('data: ' + ln + '\n\n'));
                        }
                    } catch { /* client gone */ }
                };
                try {
                    await runUpgrade(ctx.config.upgrade.repoDir, ctx.config.upgrade.buildDir, emit);
                    emit('UPGRADE_DONE ok');
                } catch (err) {
                    emit('UPGRADE_FAILED ' + (err instanceof Error ? err.message : String(err)));
                } finally {
                    upgradeRunning = false;
                    try { controller.close(); } catch { /* already closed */ }
                }
            },
            // Client gone != build gone: runUpgrade keeps building, so the
            // flag stays set until the run finishes or a second build would
            // race the same buildDir. Emissions into the closed controller
            // just no-op.
            cancel() { /* keep upgradeRunning; run continues */ },
        });
        return sseResponse(stream);
    }

    return null;
}
