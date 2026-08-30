// LAUNCH: preview-command, start, stop (the dashboard-managed model server).
import { formatCommand, LlamaSpawnError } from '../services/llama';
import * as launchLib from '../lib/launch';
import { jsonBodyOr400, type RouteCtx } from './context';

export async function handle(ctx: RouteCtx, req: Request, url: URL): Promise<Response | null> {
    const route = url.pathname;
    const method = req.method;

    // PREVIEW LAUNCH COMMAND (no spawn)
    if (route === '/api/preview-command' && method === 'POST') {
        const body = await jsonBodyOr400(ctx, req);
        try {
            const { command, args } = launchLib.resolveLaunchCommand(body, ctx.config.llama.builds, {
                rpcPort: ctx.config.llama.rpcPort,
                defaultPort: ctx.config.llama.defaultPort,
            });
            return ctx.json({ command: formatCommand(command, args) });
        } catch (err) {
            return ctx.json({ command: '', error: (err as Error).message });
        }
    }

    // START SERVER (status split: validation 400, spawn 500)
    if (route === '/api/start' && method === 'POST') {
        const body = await jsonBodyOr400(ctx, req);
        if (ctx.llama.running) return ctx.json({ error: 'Running' }, 400);
        try {
            ctx.llama.launch(body);
        } catch (err) {
            // Frozen status split: resolve/validation failures -> 400, spawn
            // failures (LlamaSpawnError; state already reset + broadcast by
            // the service) -> 500.
            const message = err instanceof Error ? err.message : String(err);
            return ctx.json({ error: message }, err instanceof LlamaSpawnError ? 500 : 400);
        }
        return ctx.json({ status: 'launching' });
    }

    // STOP SERVER (state transitions here, close handler clears)
    if (route === '/api/stop' && method === 'POST') {
        ctx.state.serverState = 'stopping';
        ctx.broadcast();
        ctx.llama.stop();
        ctx.state.serverState = 'stopped';
        ctx.state.currentModel = '';
        ctx.state.isRpc = false;
        ctx.state.currentLaunchConfig = null;
        ctx.broadcast();
        return ctx.json({ status: 'stopped' });
    }

    return null;
}
