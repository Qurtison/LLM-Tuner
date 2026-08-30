// FLAG REFERENCE + DEVICES (both resolve the llama-server binary per build).
import { flagReference, listDevices } from '../services/devices';
import * as launch from '../lib/launch';
import type { RouteCtx } from './context';

export async function handle(ctx: RouteCtx, req: Request, url: URL): Promise<Response | null> {
    const route = url.pathname;
    const method = req.method;

    if (route.startsWith('/api/flags') && method === 'GET') {
        const buildId = url.searchParams.get('build') || '';
        let binary: string;
        try {
            binary = launch.getLlamaServerBinary(ctx.config.llama.builds, buildId || undefined);
        } catch (err) {
            return ctx.json({ error: (err as Error).message }, 500);
        }
        const result = await flagReference(binary);
        return ctx.json(result.error ? { flags: [], error: result.error } : { flags: result.flags });
    }

    // LIST DEVICES (binary resolution error -> 200 with error field)
    if (route.startsWith('/api/devices') && method === 'GET') {
        const buildId = url.searchParams.get('build') || '';
        let binary: string;
        try {
            binary = launch.getLlamaServerBinary(ctx.config.llama.builds, buildId || undefined);
        } catch (err) {
            return ctx.json({ devices: [], error: (err as Error).message });
        }
        const result = await listDevices(binary);
        return ctx.json(result);
    }

    return null;
}
