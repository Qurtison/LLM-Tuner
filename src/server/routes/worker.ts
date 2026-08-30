// WORKER (commands from server config; host per request or config).
// Deliberately request/response, not SSE: every update costs one SSH round
// trip and the server has no local event source, so a stream would only
// relocate the timer (see docs/api-inventory.md Phase 7).
import { runSSHCommand } from '../services/ssh';
import { jsonBodyOr400, type RouteCtx } from './context';

const NO_WORKER_HOST = { error: 'Missing worker_ssh' };

function workerComposeCommand(ctx: RouteCtx, command: string): string {
    const dir = ctx.config.worker.workDirectory;
    return dir ? `cd ${dir} && ${command}` : command;
}

export async function handle(ctx: RouteCtx, req: Request, url: URL): Promise<Response | null> {
    const route = url.pathname;
    const method = req.method;

    const workerRoutes: Record<string, { command: string; kind: 'op' | 'status' | 'logs' }> = {
        '/api/worker/start': { command: ctx.config.worker.startCommand, kind: 'op' },
        '/api/worker/stop': { command: ctx.config.worker.stopCommand, kind: 'op' },
        '/api/worker/status': { command: ctx.config.worker.statusCommand, kind: 'status' },
        '/api/worker/logs': { command: ctx.config.worker.logsCommand, kind: 'logs' },
    };
    const worker = workerRoutes[route];
    if (worker && method === 'POST') {
        const body = await jsonBodyOr400(ctx, req);
        const workerHost = (body.worker_ssh as string) || ctx.config.worker.sshHost;
        if (!workerHost) return ctx.json(NO_WORKER_HOST, 400);
        if (!worker.command) {
            if (worker.kind === 'op') return ctx.json({ success: false, error: 'Worker commands not configured' }, 500);
            if (worker.kind === 'status') return ctx.json({ status: 'offline', error: 'Worker commands not configured' });
            return ctx.json({ logs: 'Failed to fetch logs: Worker commands not configured' });
        }
        try {
            const { stdout, stderr } = await runSSHCommand(workerHost, workerComposeCommand(ctx, worker.command));
            if (worker.kind === 'op') return ctx.json({ success: true, stdout, stderr });
            if (worker.kind === 'status') return ctx.json({ status: stdout.trim().length > 0 ? 'running' : 'stopped' });
            return ctx.json({ logs: stdout || stderr || 'No logs available.' });
        } catch (err) {
            const message = (err as Error).message;
            if (worker.kind === 'op') return ctx.json({ success: false, error: message }, 500);
            if (worker.kind === 'status') return ctx.json({ status: 'offline', error: message });
            return ctx.json({ logs: `Failed to fetch logs: ${message}` });
        }
    }

    return null;
}
