// /api/* route handlers (Phase 3). Behavior captured from server4.js per
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
import { appendBenchmarkRow, logCompletedRequest, CSV_COL } from './services/csvlog';
import { scanModels } from './services/models';
import { PresetStore, validatePreset } from './services/presets';
import * as unitMod from './services/unit';
import { listFiles, deleteFile } from './services/files';
import { runUpgrade, UpgradeError } from './services/upgrade';
import { flagReference, listDevices } from './services/devices';
import { runSSHCommand } from './services/ssh';
import { publicConfig } from './config';
import * as launch from './lib/launch';
import * as csv from './lib/csv';

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

// Every POST route parses bodies through this so the 400 shape stays
// uniform while oversized bodies keep their own (413) handling. Invalid JSON
// throws InvalidJsonError (mapped centrally); it must not be swallowed by any
// route's own try/catch.
async function jsonBodyOr400(ctx: RouteCtx, req: Request): Promise<Record<string, unknown>> {
    try {
        return await parseJsonBody(ctx, req);
    } catch (err) {
        if (err instanceof BodyTooLargeError) throw err;
        throw new InvalidJsonError();
    }
}

let upgradeRunning = false;

// SSE stream of a build/upgrade run; one run at a time.
function upgradeStream(ctx: RouteCtx, req: Request): Response {
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
        // Client gone != build gone: runUpgrade keeps building, so the flag
        // stays set until the run finishes or a second build would race the
        // same buildDir. Emissions into the closed controller just no-op.
        cancel() { /* keep upgradeRunning; run continues */ },
    });
    return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
    });
}

export async function handleApiRoute(ctx: RouteCtx, req: Request, url: URL): Promise<Response> {
    try {
        return await dispatchApiRoute(ctx, req, url);
    } catch (err) {
        if (err instanceof InvalidJsonError) return ctx.json({ error: 'Invalid JSON' }, 400);
        throw err;
    }
}

async function dispatchApiRoute(ctx: RouteCtx, req: Request, url: URL): Promise<Response> {
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

    // --- LIST CONFIGURED BUILDS (shape includes paths) ---
    if (route === '/api/builds') {
        return ctx.json({ builds: ctx.config.llama.builds });
    }


    // --- PRESETS (gap G1) ---
    if (route === '/api/presets' && method === 'GET') {
        const presets = await ctx.presets.list();
        const active = await ctx.presets.getActiveName();
        return ctx.json({ presets, active });
    }
    if (route === '/api/presets' && method === 'POST') {
        const body = await jsonBodyOr400(ctx, req);
        const name = typeof body.name === 'string' ? body.name : '';
        if (!name) return ctx.json({ error: 'preset needs a name' }, 400);
        const existing = await ctx.presets.get(name);
        const preset = {
            name,
            build: typeof body.build === 'string' && body.build ? body.build : (existing?.build || ctx.config.launch.build || ''),
            label: typeof body.label === 'string' ? body.label : undefined,
            config: (body.config && typeof body.config === 'object' ? body.config : existing?.config || {}),
        } as import('./services/presets').Preset;
        try {
            await ctx.presets.save(preset);
        } catch (err) {
            return ctx.json({ error: err instanceof Error ? err.message : String(err) }, 400);
        }
        const warnings = await validatePreset(preset, ctx.config.paths.modelDirectories);
        return ctx.json({ ok: true, warnings });
    }
    const presetMatch = route.match(/^\/api\/presets\/([^/]+)$/);
    if (presetMatch && method === 'DELETE') {
        const name = decodeURIComponent(presetMatch[1]);
        const ok = await ctx.presets.delete(name);
        return ctx.json({ ok });
    }
    if (presetMatch && method === 'GET') {
        const name = decodeURIComponent(presetMatch[1]);
        const preset = await ctx.presets.get(name);
        if (!preset) return ctx.json({ error: 'not found' }, 404);
        return ctx.json(preset);
    }
    const activateMatch = route.match(/^\/api\/presets\/([^/]+)\/activate$/);
    if (activateMatch && method === 'POST') {
        const name = decodeURIComponent(activateMatch[1]);
        const preset = await ctx.presets.get(name);
        if (!preset) return ctx.json({ error: 'not found' }, 404);
        await ctx.presets.setActiveName(name);
        return ctx.json({ ok: true, active: name });
    }
    if (route === '/api/presets/validate' && method === 'POST') {
        const body = await jsonBodyOr400(ctx, req);
        const warnings = await validatePreset({ name: String(body.name || 'x'), build: String(body.build || ''), config: (body.config as never) || {} } as import('./services/presets').Preset, ctx.config.paths.modelDirectories);
        return ctx.json({ warnings });
    }

    // --- FILES (gap G5) ---
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

    // --- UNIT (gap G2; systemd-managed inference server) ---
    if (route === '/api/unit/status' && method === 'GET') {
        const viaSystemd = ctx.config.service.manageViaSystemd && !!ctx.config.service.unitName;
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
        if (!ctx.config.service.manageViaSystemd || !ctx.config.service.unitName) return ctx.json({ error: 'unit management disabled' }, 400);
        return ctx.json(await unitMod.start(ctx.config.service.unitName));
    }
    if (route === '/api/unit/stop' && method === 'POST') {
        if (!ctx.config.service.manageViaSystemd || !ctx.config.service.unitName) return ctx.json({ error: 'unit management disabled' }, 400);
        return ctx.json(await unitMod.stop(ctx.config.service.unitName));
    }
    if (route === '/api/unit/restart' && method === 'POST') {
        if (!ctx.config.service.manageViaSystemd || !ctx.config.service.unitName) return ctx.json({ error: 'unit management disabled' }, 400);
        return ctx.json(await unitMod.restart(ctx.config.service.unitName));
    }
    if (route === '/api/unit/logs' && method === 'GET') {
        const lines = Math.max(1, Math.min(parseInt(url.searchParams.get('lines') || '200', 10) || 200, 2000));
        if (!ctx.config.service.manageViaSystemd || !ctx.config.service.unitName) return ctx.json({ logs: '' });
        return ctx.json({ logs: await unitMod.logs(ctx.config.service.unitName, lines) });
    }

    // --- APPLY (regenerate launch script from active preset, install unit, optionally restart) ---
    if (route === '/api/apply' && method === 'POST') {
        const active = await ctx.presets.getActive();
        if (!active) return ctx.json({ ok: false, error: 'no active preset', warnings: [] });
        const body = await parseJsonBody(ctx, req).catch(() => ({} as Record<string, unknown>));
        const restart = (body as Record<string, unknown>)?.restart === true;
        try {
            const resolved = launch.resolveLaunchCommand(active.config, ctx.config.llama.builds, {
                rpcPort: ctx.config.llama.rpcPort,
                defaultPort: ctx.config.llama.defaultPort,
            });
            const command = formatCommand(resolved.command, resolved.args);
            const warnings = await validatePreset(active, ctx.config.paths.modelDirectories);
            let restartOk: boolean | undefined;
            let restartOutput: string | undefined;
            if (ctx.config.service.manageViaSystemd && ctx.config.service.unitName) {
                // Shared helper keeps script + unit paths distinct (the old
                // unitPath fallback made both the same and installUnit
                // overwrote the freshly written script with the unit file).
                const scriptPath = unitMod.scriptPathFor(ctx.config.service, ctx.appRoot);
                await fs.mkdir(path.dirname(scriptPath), { recursive: true });
                const script = '#!/usr/bin/env bash\nset -euo pipefail\nexec ' + command + '\n';
                await fs.writeFile(scriptPath, script);
                await fs.chmod(scriptPath, 0o755);
                const unitPath = unitMod.unitFilePathFor(ctx.config.service);
                // In systemd mode the unit must be enabled so the model
                // survives reboots (A+D); enableOnApply is ignored there.
                const installed = await unitMod.installUnit(unitPath, scriptPath, ctx.config.service.unitName, true);
                if (!installed.ok) return ctx.json({ ok: false, error: installed.output, command, warnings });
                if (restart) {
                    const r = await unitMod.restart(ctx.config.service.unitName);
                    restartOk = r.ok; restartOutput = r.output;
                }
            } else {
                // Native mode: apply launches the active preset through the
                // dashboard-managed child (same path as /api/start).
                if (ctx.llama.running) {
                    return ctx.json({ ok: false, error: 'a model server is already running (stop it first)', command, warnings });
                }
                try {
                    ctx.llama.launch(active.config);
                } catch (err) {
                    return ctx.json({ ok: false, error: err instanceof Error ? err.message : String(err), command, warnings });
                }
            }
            return ctx.json({ ok: true, command, warnings, restartOk, restartOutput });
        } catch (err) {
            return ctx.json({ ok: false, error: err instanceof Error ? err.message : String(err), warnings: [] });
        }
    }

    // --- UPGRADE (gap G3; git pull + build, streamed) ---
    if (route === '/api/upgrade/status' && method === 'GET') {
        return ctx.json({ running: upgradeRunning });
    }
    if (route === '/api/upgrade/stream' && method === 'GET') {
        if (!ctx.config.upgrade.enabled || !ctx.config.upgrade.repoDir || !ctx.config.upgrade.buildDir) {
            return ctx.json({ error: 'upgrade not configured' }, 400);
        }
        return upgradeStream(ctx, req);
    }

    // --- SERVER PATHS (gap G7; read-only, path info the UI needs) ---
    if (route === '/api/server-paths' && method === 'GET') {
        const builds = ctx.config.llama.builds;
        return ctx.json({
            modelsDir: ctx.config.paths.modelDirectories[0] || '',
            logsDir: ctx.config.paths.logsDirectory,
            repoDir: ctx.config.upgrade.repoDir || null,
            buildDirs: builds.map(b => b.path),
            activeBuildDir: (await ctx.presets.getActive())?.build || builds[0]?.id || null,
        });
    }

    // --- BENCHMARK LOG (manual/external logging) ---
    if (route === '/api/log' && method === 'POST') {
        const body = await jsonBodyOr400(ctx, req);
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
                    timestamp: cols[CSV_COL.timestamp],
                    runId: cols[CSV_COL.runId],
                    model: cols[CSV_COL.model],
                    transport: cols[CSV_COL.transport],
                    promptTps: csv.parseNumOrNull(cols[CSV_COL.promptTps]),
                    genTps: csv.parseNumOrNull(cols[CSV_COL.genTps]),
                    promptTokens: csv.parseNumOrNull(cols[CSV_COL.promptTokens]),
                    genTokens: csv.parseNumOrNull(cols[CSV_COL.genTokens]),
                    wallTime: csv.parseNumOrNull(cols[CSV_COL.wallTime]),
                    draftAcceptRate: cols.length > CSV_COL.draftAcceptRate ? csv.parseNumOrNull(cols[CSV_COL.draftAcceptRate]) : null,
                    draftAccepted: cols.length > CSV_COL.draftAccepted ? csv.parseNumOrNull(cols[CSV_COL.draftAccepted]) : null,
                    draftGenerated: cols.length > CSV_COL.draftGenerated ? csv.parseNumOrNull(cols[CSV_COL.draftGenerated]) : null,
                    draftMeanLen: cols.length > CSV_COL.draftMeanLen ? csv.parseNumOrNull(cols[CSV_COL.draftMeanLen]) : null,
                    aborted: cols.length > CSV_COL.aborted ? cols[CSV_COL.aborted] === '1' : false,
                });
            }
            return ctx.json({ rows });
        } catch {
            return ctx.json({ rows: [] });
        }
    }

    // --- LOGS SUMMARY (schema v2/v3/old auto-detection) ---
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
                    const rowModel = cols[CSV_COL.model];
                    const rowTransport = cols[CSV_COL.transport];
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
                // Older schemas shift everything after arg_string: v2 (no
                // launch_command) by 1, old (no launch_command/config_json) by 2.
                const shift = cols.length >= 32 ? 0 : cols.length >= 31 ? 1 : 2;
                pTps = parseFloat(cols[CSV_COL.promptTps - shift]); gTps = parseFloat(cols[CSV_COL.genTps - shift]); pLat = parseFloat(cols[CSV_COL.promptLatency - shift]); wTime = parseFloat(cols[CSV_COL.wallTime - shift]); lTime = parseFloat(cols[CSV_COL.loadTime - shift]);
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
        const cfg = await jsonBodyOr400(ctx, req);
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
        const dq = await jsonBodyOr400(ctx, req);
        const res = ctx.bench.dequeue(dq.label);
        return ctx.json({ ok: true, removed: res.removed, queueRemaining: res.queueRemaining });
    }
    if (route === '/api/bench/note' && method === 'POST') {
        const noteBody = await jsonBodyOr400(ctx, req);
        ctx.bench.note(noteBody.lines);
        return ctx.json({ ok: true });
    }

    // --- FLAG REFERENCE (no build -> 500; exec failure -> error in body) ---
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

    // --- LIST DEVICES (binary resolution error -> 200 with error field) ---
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
        const body = await jsonBodyOr400(ctx, req);
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

    // --- START SERVER (status split: validation 400, spawn 500) ---
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

    // --- STOP SERVER (state transitions here, close handler clears) ---
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

    // --- MASTER LOGS (in-memory ring) ---
    if (route === '/api/master/logs' && method === 'GET') {
        const logs = ctx.llama.logs.length > 0
            ? ctx.llama.logs.join('\n')
            : 'No logs available. Start the server first.';
        return ctx.json({ logs });
    }

    // --- MASTER LOG STREAM (SSE tail + live follow) ---
    // One EventSource gets the ring's last ?lines= lines backfilled, then
    // every new llama-server line as it lands (LlamaService.onLine). Stays
    // open until the client disconnects; the abort handler unsubscribes and
    // closes so a gone client never accumulates listeners.
    if (route === '/api/master/logs/stream' && method === 'GET') {
        const requested = parseInt(url.searchParams.get('lines') || '200', 10);
        const tailCount = Number.isFinite(requested) ? Math.max(0, Math.min(requested, 500)) : 200;
        let unsubscribe: (() => void) | null = null;
        const stream = new ReadableStream({
            start(controller) {
                const encoder = new TextEncoder();
                const emit = (line: string) => {
                    try { controller.enqueue(encoder.encode('data: ' + line + '\n\n')); }
                    catch { /* client gone; abort handler cleans up */ }
                };
                for (const line of (tailCount > 0 ? ctx.llama.logs.slice(-tailCount) : [])) emit(line);
                unsubscribe = ctx.llama.onLine(emit);
                req.signal.addEventListener('abort', () => {
                    unsubscribe?.();
                    try { controller.close(); } catch { /* already closed */ }
                });
            },
            cancel() { unsubscribe?.(); },
        });
        return new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
        });
    }

    // --- TELEMETRY ---
    if (route === '/api/telemetry/latest' && method === 'GET') {
        return ctx.json(ctx.telemetry.latest() || { t: 0, stats: null });
    }
    if (route === '/api/telemetry/rate' && method === 'POST') {
        const rateBody = await jsonBodyOr400(ctx, req);
        const ms = ctx.telemetry.setPollMs(rateBody.ms as number);
        return ctx.json({ ok: true, ms });
    }

    // --- HUGGING FACE PROXIES (browser stays same-origin) ---
    if (route === '/api/hf/search' && method === 'GET') {
        const q = url.searchParams.get('q')?.trim() || '';
        const requested = Number.parseInt(url.searchParams.get('limit') || '10', 10);
        const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 100) : 10;
        try {
            const upstream = await fetch('https://huggingface.co/api/models?search=' + encodeURIComponent(q) + '&limit=' + limit, { signal: AbortSignal.timeout(10_000) });
            if (!upstream.ok) throw new Error('Hugging Face returned ' + upstream.status);
            const data: unknown = await upstream.json();
            if (!Array.isArray(data)) throw new Error('Invalid Hugging Face response');
            return ctx.json(data);
        } catch (err) {
            return ctx.json({ error: err instanceof Error ? err.message : 'Hugging Face search failed' }, 502);
        }
    }
    if (route === '/api/hf/readme' && method === 'GET') {
        const repo = url.searchParams.get('repo') || '';
        if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return ctx.json({ error: 'Invalid repository' }, 502);
        try {
            const upstream = await fetch('https://huggingface.co/' + repo + '/raw/main/README.md', { signal: AbortSignal.timeout(10_000) });
            if (!upstream.ok) throw new Error('Hugging Face returned ' + upstream.status);
            return new Response(await upstream.text(), { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
        } catch (err) {
            return ctx.json({ error: err instanceof Error ? err.message : 'Hugging Face README fetch failed' }, 502);
        }
    }

    // Fallback 404 (SSE /api/status is handled before this in index.ts)
    return ctx.json({ error: 'Not found' }, 404);
}
