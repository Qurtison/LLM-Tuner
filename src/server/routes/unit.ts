// UNIT (gap G2; systemd-managed inference server).
import * as unitMod from '../services/unit';
import type { RouteCtx } from './context';

export async function handle(ctx: RouteCtx, req: Request, url: URL): Promise<Response | null> {
    const route = url.pathname;
    const method = req.method;
    const viaSystemd = ctx.config.service.manageViaSystemd && !!ctx.config.service.unitName;

    if (route === '/api/unit/status' && method === 'GET') {
        if (!viaSystemd) {
            return ctx.json({ activeState: 'disabled', subState: 'managed by dashboard process', since: null, pid: null, restarts: 0, result: '' });
        }
        try {
            return ctx.json(await unitMod.status(ctx.config.service.unitName));
        } catch (err) {
            return ctx.json({ activeState: 'error', subState: String(err instanceof Error ? err.message : err), since: null, pid: null, restarts: 0, result: '' });
        }
    }
    if (route === '/api/unit/start' && method === 'POST') {
        if (!viaSystemd) return ctx.json({ error: 'unit management disabled' }, 400);
        return ctx.json(await unitMod.start(ctx.config.service.unitName));
    }
    if (route === '/api/unit/stop' && method === 'POST') {
        if (!viaSystemd) return ctx.json({ error: 'unit management disabled' }, 400);
        return ctx.json(await unitMod.stop(ctx.config.service.unitName));
    }
    if (route === '/api/unit/restart' && method === 'POST') {
        if (!viaSystemd) return ctx.json({ error: 'unit management disabled' }, 400);
        return ctx.json(await unitMod.restart(ctx.config.service.unitName));
    }
    if (route === '/api/unit/logs' && method === 'GET') {
        if (!viaSystemd) return ctx.json({ logs: '' });
        const lines = Math.max(1, Math.min(parseInt(url.searchParams.get('lines') || '200', 10) || 200, 2000));
        return ctx.json({ logs: await unitMod.logs(ctx.config.service.unitName, lines) });
    }

    return null;
}
