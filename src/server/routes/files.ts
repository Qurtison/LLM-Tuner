// FILES (gap G5): model-directory listing + delete.
import { listFiles, deleteFile } from '../services/files';
import { jsonBodyOr400, type RouteCtx } from './context';

export async function handle(ctx: RouteCtx, req: Request, url: URL): Promise<Response | null> {
    const route = url.pathname;
    const method = req.method;

    if (route === '/api/files' && method === 'GET') {
        const requested = url.searchParams.get('path') || '';
        try {
            return ctx.json(await listFiles(ctx.config.paths.modelDirectories[0], requested));
        } catch (err) {
            return ctx.json({ error: err instanceof Error ? err.message : String(err) }, 400);
        }
    }
    if (route === '/api/files/delete' && method === 'POST') {
        const body = await jsonBodyOr400(ctx, req);
        try {
            await deleteFile(ctx.config.paths.modelDirectories[0], String(body.path || ''));
            return ctx.json({ ok: true });
        } catch (err) {
            return ctx.json({ error: err instanceof Error ? err.message : String(err) }, 400);
        }
    }

    return null;
}
