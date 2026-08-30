// /api/* dispatcher. Each route group in this directory exports
// handle(ctx, req, url) returning null when the request is not its route.
// Dispatch order is frozen: it must match the legacy single-file ordering so
// first-match-wins stays byte-identical (e.g. /api/presets/<name> GET is
// checked before /api/presets/validate POST). The SSE /api/status endpoint
// lives in index.ts (the server entry) because it owns the client stream set.
import { InvalidJsonError, type RouteCtx } from './context';
// Re-exported so the server entry keeps importing { handleApiRoute, RouteCtx,
// BodyTooLargeError } from './routes' without knowing the directory layout.
export type { RouteCtx } from './context';
export { BodyTooLargeError } from './context';
import * as models from './models';
import * as presets from './presets';
import * as files from './files';
import * as unit from './unit';
import * as apply from './apply';
import * as upgrade from './upgrade';
import * as logs from './logs';
import * as bench from './bench';
import * as devices from './devices';
import * as launch from './launch';
import * as worker from './worker';
import * as master from './master';
import * as telemetry from './telemetry';
import * as hf from './hf';

const handlers = [
    models.handle,
    presets.handle,
    files.handle,
    unit.handle,
    apply.handle,
    upgrade.handle,
    logs.handle,
    bench.handle,
    devices.handle,
    launch.handle,
    worker.handle,
    master.handle,
    telemetry.handle,
    hf.handle,
];

export async function handleApiRoute(ctx: RouteCtx, req: Request, url: URL): Promise<Response> {
    try {
        for (const handle of handlers) {
            const response = await handle(ctx, req, url);
            if (response) return response;
        }
        // Fallback 404 (SSE /api/status is handled before this in the entry).
        return ctx.json({ error: 'Not found' }, 404);
    } catch (err) {
        if (err instanceof InvalidJsonError) return ctx.json({ error: 'Invalid JSON' }, 400);
        throw err;
    }
}
