// UPGRADE (gap G3; git pull + build, streamed over SSE). One run at a time.
// /api/upgrade/status also carries the cached behind-check the header chip
// polls, so the client never has to run git itself.
import { checkBehind, runUpgrade, type BehindInfo } from '../services/upgrade';
import { sseResponse, type RouteCtx } from './context';

let upgradeRunning = false;
let behind: BehindInfo | null = null;
let checking = false;
// The chip polls every 15 min; a full fetch+rev-list is far too slow to run
// per request, so the answer is cached and refreshed on a timer.
const CHECK_TTL_MS = 15 * 60_000;

function configured(ctx: RouteCtx): boolean {
    return ctx.config.upgrade.enabled === true && ctx.config.upgrade.repoDir !== '' && ctx.config.upgrade.buildDir !== '';
}

async function refreshBehind(ctx: RouteCtx): Promise<BehindInfo | null> {
    if (!configured(ctx) || checking) return behind;
    checking = true;
    try {
        behind = await checkBehind(ctx.config.upgrade.repoDir);
    } catch (err) {
        behind = { behind: 0, head: behind?.head ?? '', remote: 'origin/master', checkedAt: Date.now(), error: err instanceof Error ? err.message : String(err) };
    } finally {
        checking = false;
    }
    return behind;
}

export async function handle(ctx: RouteCtx, req: Request, url: URL): Promise<Response | null> {
    const route = url.pathname;
    const method = req.method;

    if (route === '/api/upgrade/status' && method === 'GET') {
        const force = url.searchParams.get('refresh') === '1';
        const stale = !behind || Date.now() - behind.checkedAt > CHECK_TTL_MS;
        if (force || !behind) await refreshBehind(ctx);
        else if (stale) void refreshBehind(ctx); // serve the cache, refresh behind it
        return ctx.json({
            configured: configured(ctx),
            running: upgradeRunning,
            behind: behind?.behind ?? 0,
            head: behind?.head ?? '',
            remote: behind?.remote ?? 'origin/master',
            checkedAt: behind?.checkedAt ?? 0,
            checkError: behind?.error ?? '',
            stale: stale || !behind,
        });
    }
    if (route === '/api/upgrade/stream' && method === 'GET') {
        if (!configured(ctx)) {
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
                            controller.enqueue(encoder.encode(`data: ${ln}\n\n`));
                        }
                    } catch { /* client gone */ }
                };
                try {
                    await runUpgrade(ctx.config.upgrade.repoDir, ctx.config.upgrade.buildDir, emit);
                    emit('UPGRADE_DONE ok');
                    // The tree just moved: the cached behind-count is stale.
                    behind = null;
                } catch (err) {
                    emit(`UPGRADE_FAILED ${err instanceof Error ? err.message : String(err)}`);
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
