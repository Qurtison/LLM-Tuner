// Shared route context, body parsing, and SSE helpers for the /api/* route
// groups in this directory. index.ts dispatches the groups in frozen order
// (earlier match wins -- including the /api/presets/<name> GET vs
// /api/presets/validate POST precedence). Behavior captured from server4.js
// per docs/api-inventory.md; types from shared/contracts.ts.
import type { DashboardConfig } from '../config';
import type { ServerState } from '../services/types';
import type { LlamaService } from '../services/llama';
import type { BenchService } from '../services/bench';
import type { TelemetryService } from '../services/telemetry';
import type { PresetStore } from '../services/presets';

// Thrown by the entry's size-guarded body reader; route catches must let it
// propagate (it maps to 413 in the entry, NOT 400 Invalid JSON).
export class BodyTooLargeError extends Error {
    constructor() { super('Payload too large'); }
}

// Thrown by jsonBodyOr400 on malformed bodies; handleApiRoute maps it to the
// 400 shape ({ error: 'Invalid JSON' }) in one central place.
export class InvalidJsonError extends Error {
    constructor() { super('Invalid JSON'); }
}

export interface RouteCtx {
    config: DashboardConfig;
    state: ServerState;
    broadcast: (log?: string, error?: string) => void;
    llama: LlamaService;
    bench: BenchService;
    telemetry: TelemetryService;
    presets: PresetStore;
    appRoot: string;
    // Body reader honoring config.server.maxBodyBytes; throws
    // BodyTooLargeError when the cap is exceeded (the entry maps it to 413).
    readBody: (req: Request) => Promise<string>;
    json: (body: unknown, status?: number, headers?: Record<string, string>) => Response;
}

// Every POST route parses bodies through this so the 400 shape stays uniform
// while oversized bodies keep their own (413) handling. Invalid JSON throws
// InvalidJsonError (mapped centrally); it must not be swallowed by any route's
// own try/catch.
// Tolerant variant: /api/apply swallows parse errors (missing/invalid body
// behaves as no body). All other routes use jsonBodyOr400.
export async function parseJsonBody(ctx: RouteCtx, req: Request): Promise<Record<string, unknown>> {
    const raw = await ctx.readBody(req);
    return JSON.parse(raw) as Record<string, unknown>;
}

export async function jsonBodyOr400(ctx: RouteCtx, req: Request): Promise<Record<string, unknown>> {
    try {
        return await parseJsonBody(ctx, req);
    } catch (err) {
        if (err instanceof BodyTooLargeError) throw err;
        throw new InvalidJsonError();
    }
}

// Standard response for every SSE push endpoint (telemetry, bench, master
// logs, upgrade streams share these headers).
export function sseResponse(stream: ReadableStream<Uint8Array>): Response {
    return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
    });
}
