// /api/* route handlers (Phase 3). Behavior-frozen from server4.js per
// docs/api-inventory.md; types from shared/contracts.ts. The SSE endpoint
// (/api/status) lives in index.ts because it owns the client stream set.
import path from 'node:path';
import fs from 'node:fs/promises';
import type { DashboardConfig } from './config';
import type { ServerState } from './services/types';
import type { LlamaService } from './services/llama';
import { formatCommand, LlamaSpawnError } from './services/llama';
import type { BenchService } from './services/bench';
import type { TelemetryService } from './services/telemetry';
import { appendBenchmarkRow, logCompletedRequest } from './services/csvlog';
import { scanModels } from './services/models';
import { flagReference, listDevices } from './services/devices';
import { runSSHCommand } from './services/ssh';
import { publicConfig } from './config';
import launch = require('./lib/launch');
import csv = require('./lib/csv');

// Thrown by the entry's size-guarded body reader; route catches must let it
// propagate (it maps to 413 in the entry, NOT 400 Invalid JSON).
export class BodyTooLargeError extends Error {
    constructor() { super('Payload too large'); }
}

export interface RouteCtx {
    config: DashboardConfig;
    state: ServerState;
    broadcast: (log?: string, error?: string) => void;
    llama: LlamaService;
    bench: BenchService;
    telemetry: TelemetryService;
    appRoot: string;
    // Body reader honoring config.server.maxBodyBytes; resolves null when the
    // body exceeded the cap (legacy behavior reset the socket; the Bun entry
    // answers 413 — same protection, documentable status).
    readBody: (req: Request) => Promise<string | null>;
    json: (body: unknown, status?: number, headers?: Record<string, string>) => Response;
}

// Frozen /api/stop + /api/start failure paths both reset launch state the
// same way; keep the strings identical.
const NO_WORKER_HOST = { error: 'Missing worker_ssh' };

function workerComposeCommand(ctx: RouteCtx, command: string): string {
    const dir = ctx.config.worker.workDirectory;
    return dir ? `cd ${dir} && ${command}` : command;
}

// Throws: JSON.parse error on invalid bodies (route maps to 400), or
// BodyTooLargeError from the entry's size-guarded reader (maps to 413).
async function parseJsonBody(ctx: RouteCtx, req: Request): Promise<Record<string, unknown>> {
    const raw = await ctx.readBody(req);
    return JSON.parse(raw) as Record<string, unknown>;
}

// Every POST route parses bodies through this so the frozen 400 shape stays
// uniform while oversized bodies keep their own (413) handling.
async function jsonBodyOr400(ctx: RouteCtx, req: Request): Promise<Record<string, unknown>> {
    try {
        return await parseJsonBody(ctx, req);
    } catch (err) {
        if (err instanceof BodyTooLargeError) throw err;
        return ctx.json({ error: 'Invalid JSON' }, 400) as never;
    }
}

export async function handleApiRoute(ctx: RouteCtx, req: Request, url: URL): Promise<Response> {
    const route = url.pathname;
    const method = req.method;

    // --- MODELS ---
    if (route === '/api/models') {
        const models = await scanModels(ctx.config.paths.modelDirectories, ctx.config.paths.huggingFaceCache);
        return ctx.json(models);
    }

    // --- PUBLIC CONFIG (safe UI defaults + feature flags; no paths, no
    // commands -- see publicConfig) ---
    if (route === '/api/config') {
        return ctx.json(publicConfig(ctx.config));
    }

    // --- LIST CONFIGURED BUILDS (frozen shape includes paths) ---
    if (route === '/api/builds') {
        return ctx.json({ builds: ctx.config.llama.builds });
    }

    // --- BENCHMARK LOG (manual/external logging) ---
    if (route === '/api/log' && method === 'POST') {
        let body: Record<string, unknown>;
        try { body = await parseJsonBody(ctx, req); } catch (e) { if (e instanceof BodyTooLargeError) throw e; return ctx.json({ error: 'Invalid JSON' }, 400); }
        const runId = await appendBenchmarkRow(ctx.config.paths.logsDirectory, body);
        return ctx.json({ success: true, run_id: runId });
    }

    // --- CSV DOWNLOAD ---
    if (route === '/api/logs/csv' && method === 'GET') {
        try {
            const csvText = await fs.readFile(path.join(ctx.config.paths.logsDirectory, 'benchmarks.csv'), 'utf-8');
            return ctx.json(csvText, 200, { 'Content-Type': 'text/csv' });
        } catch {
            return new Response(null, { status: 404 });
        }
    }

    // --- PER-REQUEST OMNI GRAPH SAMPLES (in-memory ring, capped at 30) ---
    if (route.startsWith('/api/logs/samples') && method === 'GET') {
        const runId = url.searchParams.get('runId') || '';
        return ctx.json({ samples: ctx.telemetry.recentSamples(runId) });
    }

    // --- IN-PROGRESS REQUEST SAMPLES (read-only peek, NOT a drain) ---
    if (route === '/api/logs/active-samples' && method === 'GET') {
        return ctx.json({ samples: ctx.telemetry.liveSamples() });
    }

    // --- RECENT COMPLETED REQUESTS (structured CSV backfill) ---
    if (route.startsWith('/api/logs/recent') && method === 'GET') {
        try {
            const limit = Math.max(1, Math.min(parseInt(url.searchParams.get('limit') || '', 10) || 50, 500));
            const csvText = await fs.readFile(path.join(ctx.config.paths.logsDirectory, 'benchmarks.csv'), 'utf-8');
            const lines = csvText.trim().split('\n').slice(1).filter(l => l.trim());
            const recentLines = lines.slice(-limit);
            const rows: unknown[] = [];
            for (const line of recentLines) {
                const cols = csv.splitCsvLine(line);
                if (cols.length < 32) continue; // only schema v3+ rows have model_name/transport at known offsets
                rows.push({
                    timestamp: cols[0],
                    runId: cols[1],
                    model: cols[2],
                    transport: cols[7],
                    promptTps: csv.parseNumOrNull(cols[10]),
                    genTps: csv.parseNumOrNull(cols[11]),
                    promptTokens: csv.parseNumOrNull(cols[13]),
                    genTokens: csv.parseNumOrNull(cols[28]),
                    wallTime: csv.parseNumOrNull(cols[30]),
                    draftAcceptRate: cols.length > 33 ? csv.parseNumOrNull(cols[33]) : null,
                    draftAccepted: cols.length > 34 ? csv.parseNumOrNull(cols[34]) : null,
                    draftGenerated: cols.length > 35 ? csv.parseNumOrNull(cols[35]) : null,
                    draftMeanLen: cols.length > 36 ? csv.parseNumOrNull(cols[36]) : null,
                    aborted: cols.length > 37 ? cols[37] === '1' : false,
                });
            }
            return ctx.json({ rows });
        } catch {
            return ctx.json({ rows: [] });
        }
    }

    // --- LOGS SUMMARY (schema v2/v3/old auto-detection — frozen logic) ---
    if (route.startsWith('/api/logs/summary') && method === 'GET') {
        try {
            const filterModel = url.searchParams.get('model') || '';
            const filterTransport = url.searchParams.get('transport') || '';
            const csvText = await fs.readFile(path.join(ctx.config.paths.logsDirectory, 'benchmarks.csv'), 'utf-8');
            const lines = csvText.trim().split('\n').slice(1);
            if (lines.length === 0) return ctx.json({ count: 0 });
            // Column maps (0-indexed) by schema: v3+ = 32 cols with
            // launch_command; v2 = 31 cols without; old = 30 cols.
            let n = 0, sumPromptTps = 0, sumGenTps = 0, sumPromptLat = 0, sumWallTime = 0, sumLoadTime = 0;
            let bestPromptTps = 0, bestGenTps = 0, bestPromptLat = Infinity, bestWallTime = Infinity, bestLoadTime = Infinity;
            let lastModel: string | null = null, lastTimestamp: string | null = null, lastPromptTps: number | null = null, lastGenTps: number | null = null, lastLoadTime: number | null = null, lastConfig: unknown = null;
            for (const line of lines) {
                if (!line.trim()) continue;
                const cols = csv.splitCsvLine(line);
                if (cols.length < 25) continue;
                if (cols.length >= 32) {
                    const rowModel = cols[2];
                    const rowTransport = cols[7];
                    if (filterModel && rowModel !== filterModel) continue;
                    if (filterTransport && rowTransport !== filterTransport) continue;
                    lastModel = rowModel;
                    lastTimestamp = cols[0];
                    lastConfig = null;
                    if (cols.length >= 33 && cols[32]) {
                        try { lastConfig = JSON.parse(cols[32]); } catch { /* older/malformed row -- skip */ }
                    }
                } else if (filterModel || filterTransport) {
                    continue;
                }
                let pTps: number, gTps: number, pLat: number, wTime: number, lTime: number;
                if (cols.length >= 32) {
                    pTps = parseFloat(cols[10]); gTps = parseFloat(cols[11]); pLat = parseFloat(cols[12]); wTime = parseFloat(cols[30]); lTime = parseFloat(cols[31]);
                } else if (cols.length >= 31) {
                    pTps = parseFloat(cols[9]); gTps = parseFloat(cols[10]); pLat = parseFloat(cols[11]); wTime = parseFloat(cols[29]); lTime = parseFloat(cols[30]);
                } else {
                    pTps = parseFloat(cols[8]); gTps = parseFloat(cols[9]); pLat = parseFloat(cols[10]); wTime = parseFloat(cols[28]); lTime = parseFloat(cols[29]);
                }
                lastPromptTps = Number.isFinite(pTps) ? pTps : null;
                lastGenTps = Number.isFinite(gTps) ? gTps : null;
                lastLoadTime = Number.isFinite(lTime) ? lTime : null;
                if (Number.isFinite(pTps)) { sumPromptTps += pTps; if (pTps > bestPromptTps) bestPromptTps = pTps; }
                if (Number.isFinite(gTps)) { sumGenTps += gTps; if (gTps > bestGenTps) bestGenTps = gTps; }
                if (Number.isFinite(pLat)) { sumPromptLat += pLat; if (pLat < bestPromptLat) bestPromptLat = pLat; }
                if (Number.isFinite(wTime)) { sumWallTime += wTime; if (wTime < bestWallTime) bestWallTime = wTime; }
                if (Number.isFinite(lTime)) { sumLoadTime += lTime; if (lTime < bestLoadTime) bestLoadTime = lTime; }
                n++;
            }
            const avg = (v: number, c: number) => c > 0 ? Math.round((v / c) * 10) / 10 : 0;
            const round1 = (v: number | null) => Number.isFinite(v as number) ? Math.round((v as number) * 10) / 10 : 0;
            if (n === 0) return ctx.json({ count: 0, filtered: !!(filterModel || filterTransport) });
            return ctx.json({
                count: n,
                lastModel,
                lastConfig,
                lastTimestamp,
                lastPromptTps: round1(lastPromptTps),
                lastGenTps: round1(lastGenTps),
                lastLoadTime: round1(lastLoadTime),
                filtered: !!(filterModel || filterTransport),
                avgPromptTps: avg(sumPromptTps, n),
                avgGenTps: avg(sumGenTps, n),
                avgPromptLatency: avg(sumPromptLat, n),
                avgWallTime: avg(sumWallTime, n),
                avgLoadTime: avg(sumLoadTime, n),
                bestPromptTps: round1(bestPromptTps),
                bestGenTps: round1(bestGenTps),
                bestPromptLatency: isFinite(bestPromptLat) ? round1(bestPromptLat) : 0,
                bestWallTime: isFinite(bestWallTime) ? round1(bestWallTime) : 0,
                bestLoadTime: isFinite(bestLoadTime) ? round1(bestLoadTime) : 0,
            });
        } catch {
            return ctx.json({ count: 0 });
        }
    }

    // --- BENCH: single config or { queue } (server-side matrix queue) ---
    if (route === '/api/bench/start' && method === 'POST') {
        let cfg: Record<string, unknown>;
        try { cfg = await parseJsonBody(ctx, req); } catch (e) { if (e instanceof BodyTooLargeError) throw e; return ctx.json({ error: 'Invalid JSON' }, 400); }
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
        let dq: Record<string, unknown>;
        try { dq = await parseJsonBody(ctx, req); } catch (e) { if (e instanceof BodyTooLargeError) throw e; return ctx.json({ error: 'Invalid JSON' }, 400); }
        const res = ctx.bench.dequeue(dq.label);
        return ctx.json({ ok: true, removed: res.removed, queueRemaining: res.queueRemaining });
    }
    if (route === '/api/bench/note' && method === 'POST') {
        let noteBody: Record<string, unknown>;
        try { noteBody = await parseJsonBody(ctx, req); } catch (e) { if (e instanceof BodyTooLargeError) throw e; return ctx.json({ error: 'Invalid JSON' }, 400); }
        ctx.bench.note(noteBody.lines);
        return ctx.json({ ok: true });
    }

    // --- FLAG REFERENCE (frozen: no build -> 500; exec failure -> error in body) ---
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

    // --- LIST DEVICES (frozen: binary resolution error -> 200 with error field) ---
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

    // --- PREVIEW LAUNCH COMMAND (no spawn) ---
    if (route === '/api/preview-command' && method === 'POST') {
        let body: Record<string, unknown>;
        try { body = await parseJsonBody(ctx, req); } catch (e) { if (e instanceof BodyTooLargeError) throw e; return ctx.json({ error: 'Invalid JSON' }, 400); }
        try {
            const { command, args } = launch.resolveLaunchCommand(body, ctx.config.llama.builds, {
                rpcPort: ctx.config.llama.rpcPort,
                defaultPort: ctx.config.llama.defaultPort,
            });
            return ctx.json({ command: formatCommand(command, args) });
        } catch (err) {
            return ctx.json({ command: '', error: (err as Error).message });
        }
    }

    // --- START SERVER (frozen status split: validation 400, spawn 500) ---
    if (route === '/api/start' && method === 'POST') {
        let body: Record<string, unknown>;
        try { body = await parseJsonBody(ctx, req); } catch (e) { if (e instanceof BodyTooLargeError) throw e; return ctx.json({ error: 'Invalid JSON' }, 400); }
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

    // --- STOP SERVER (frozen: state transitions here, close handler clears) ---
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

    // --- WORKER (commands from server config; host per request or config) ---
    const workerRoutes: Record<string, { command: string; kind: 'op' | 'status' | 'logs' }> = {
        '/api/worker/start': { command: ctx.config.worker.startCommand, kind: 'op' },
        '/api/worker/stop': { command: ctx.config.worker.stopCommand, kind: 'op' },
        '/api/worker/status': { command: ctx.config.worker.statusCommand, kind: 'status' },
        '/api/worker/logs': { command: ctx.config.worker.logsCommand, kind: 'logs' },
    };
    const worker = workerRoutes[route];
    if (worker && method === 'POST') {
        let body: Record<string, unknown>;
        try { body = await parseJsonBody(ctx, req); } catch (e) { if (e instanceof BodyTooLargeError) throw e; return ctx.json({ error: 'Invalid JSON' }, 400); }
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

    // --- MASTER LOGS (in-memory ring) ---
    if (route === '/api/master/logs' && method === 'GET') {
        const logs = ctx.llama.logs.length > 0
            ? ctx.llama.logs.join('\n')
            : 'No logs available. Start the server first.';
        return ctx.json({ logs });
    }

    // --- TELEMETRY ---
    if (route === '/api/telemetry/latest' && method === 'GET') {
        return ctx.json(ctx.telemetry.latest() || { t: 0, stats: null });
    }
    if (route === '/api/telemetry/rate' && method === 'POST') {
        let rateBody: Record<string, unknown>;
        try { rateBody = await parseJsonBody(ctx, req); } catch (e) { if (e instanceof BodyTooLargeError) throw e; return ctx.json({ error: 'Invalid JSON' }, 400); }
        const ms = ctx.telemetry.setPollMs(rateBody.ms as number);
        return ctx.json({ ok: true, ms });
    }

    // Fallback 404 (SSE /api/status is handled before this in index.ts)
    return ctx.json({ error: 'Not found' }, 404);
}
