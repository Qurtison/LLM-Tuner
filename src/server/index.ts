// Mission Control -- Bun server entry (Phase 3).
//
// Replaces server4.js: Bun.serve for HTTP + SSE + static assets, Bun.spawn
// children (llama-server, llama-bench, monitor) tracked in one shutdown path,
// /api/llama/* proxy so browsers never dial the model server directly, and
// config-driven everything (src/server/config.ts). Route behavior is frozen
// per docs/api-inventory.md; frozen types in shared/contracts.ts.
//
// ponytail: routes live in routes.ts alongside this entry rather than a
// routes/ directory per the plan's target layout -- one import boundary is
// cheaper to review; split when route count or import cycles demand it.
import path from 'node:path';
import fs from 'node:fs/promises';
import { loadConfig, ConfigError, type DashboardConfig } from './config';
import type { TelemetrySample } from '../../shared/contracts';
import { LlamaService } from './services/llama';
import { BenchService } from './services/bench';
import { TelemetryService } from './services/telemetry';
import { logCompletedRequest } from './services/csvlog';
import { CSV_HEADERS } from './services/csvlog';
import type { ServerState } from './services/types';
import { handleApiRoute, type RouteCtx, BodyTooLargeError } from './routes';
import { PresetStore } from './services/presets';

const APP_ROOT = path.join(import.meta.dir, '..', '..'); // src/server/<entry> -> repo root
const DIST_DIR = path.join(APP_ROOT, 'dist', 'client');

// --- CONFIG (gates startup; invalid -> field-specific fatal error) ---
let config: DashboardConfig;
try {
    config = await loadConfig({ appRoot: APP_ROOT });
} catch (err) {
    if (err instanceof ConfigError) for (const issue of err.issues) console.error('[config] ' + issue);
    else console.error('Failed to load config:', err);
    process.exit(1);
}

// --- SHARED STATE + SSE HUB ---
const state: ServerState = {
    serverState: 'stopped',
    currentModel: '',
    isRpc: false,
    loadStartTime: 0,
    finalLoadTime: 0,
    currentLaunchCommand: '',
    currentLaunchConfig: null,
};
const encoder = new TextEncoder();
let clients: ReadableStreamDefaultController[] = [];

function broadcast(log = '', error = '') {
    const payload = JSON.stringify({
        state: state.serverState,
        model: state.currentModel,
        isRpc: state.isRpc,
        log,
        error,
        loadStartTime: state.loadStartTime,
        finalLoadTime: state.finalLoadTime,
        launchCommand: state.currentLaunchCommand,
        launchConfig: state.currentLaunchConfig,
    });
    const dead: ReadableStreamDefaultController[] = [];
    for (const client of clients) {
        try {
            client.enqueue(encoder.encode(`data: ${payload}\n\n`));
        } catch {
            dead.push(client);
        }
    }
    if (dead.length) clients = clients.filter(c => !dead.includes(c));
}

// --- REQUEST BODY WITH FROZEN SIZE GUARD ---
async function readBody(req: Request): Promise<string> {
    if (!req.body) return '';
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = req.body.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > config.server.maxBodyBytes) throw new BodyTooLargeError();
        chunks.push(value);
    }
    const merged = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }
    return new TextDecoder().decode(merged);
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { 'Content-Type': typeof body === 'string' ? (headers['Content-Type'] || 'text/plain') : 'application/json', ...headers } });
}

// --- SERVICES (one process registry's worth of tracked children) ---
const telemetry = new TelemetryService(
    { config, state, broadcast },
    {
        benchRunning: () => benchStatusRunning(),
        fetchSlots: async (port: number) => {
            // Frozen 1.5s timeout; defaultHost comes from config.
            const res = await fetch(`http://${config.llama.defaultHost}:${port}/slots`, { signal: AbortSignal.timeout(1500) });
            return await res.json();
        },
        liveProgress: { get: () => llama.liveProgress, reset: () => llama.resetLiveProgress() },
    }
);

const llama = new LlamaService(
    { config, state, broadcast },
    {
        onActivity: () => telemetry.markActivity(),
        takeSamples: () => telemetry.takeSamples(),
        logCompletedRequest: (timing, samples, completedAt, opts) =>
            logCompletedRequest({ config, state, broadcast }, {
                fetchStats: () => telemetry.fetchStats(),
                finalLoadTime: () => state.finalLoadTime as number,
                rememberSamples: (runId, s) => telemetry.rememberSamples(runId, s as TelemetrySample[]),
            }, timing, samples, completedAt, opts),
    }
);

function benchStatusRunning(): boolean {
    return bench.status().running;
}

import * as launchLib from './lib/launch';
const bench = new BenchService(
    { config, state, broadcast },
    {
        benchBinFor: (build) => launchLib.getLlamaServerBinary(config.llama.builds, build as string | undefined).replace(/llama-server$/, 'llama-bench'),
        takeSamples: () => telemetry.takeSamples(),
        liveSamples: () => telemetry.liveSamples(),
        onBenchLine: (line) => broadcast('BENCH:' + line),
        onBenchDone: (tag) => broadcast(tag),
        llamaRunning: () => llama.running,
    }
);

const presets = new PresetStore(path.join(APP_ROOT, 'presets'));

const routeCtx: RouteCtx = {
    config,
    state,
    broadcast,
    llama,
    bench,
    telemetry,
    presets,
    appRoot: APP_ROOT,
    readBody,
    json,
};

// --- MONITOR (managed child; telemetry is best-effort, never fatal) ---
let monitor: Bun.Subprocess | null = null;

// Drain a child stream line-by-line into the server log. Piping without
// draining would re-create the original 'ignore' problem (an unread 64KB+
// pipe blocks the child and stalls its /stats endpoint); draining keeps the
// child unblocked AND makes its output visible -- before this, monitor.py
// startup failures (missing module, EADDRINUSE on the telemetry port from an
// orphaned copy) vanished completely and telemetry died silently.
async function drainChildStream(stream: ReadableStream<Uint8Array> | number | undefined | null, log: (line: string) => void): Promise<void> {
    // Spawned with stdout/stderr 'pipe'; the wider parameter type only
    // reflects Bun's other stdio options ('ignore'/'inherit').
    if (!(stream instanceof ReadableStream)) return;
    const decoder = new TextDecoder();
    let buffer = '';
    try {
        for await (const chunk of stream) {
            buffer += decoder.decode(chunk, { stream: true });
            const lines = buffer.split(/\r\n|\r|\n/);
            buffer = lines.pop() || '';
            for (const line of lines) log(line);
        }
        if (buffer.trim()) log(buffer);
    } catch { /* stream torn down with the child */ }
}

async function spawnMonitor(): Promise<void> {
    if (!config.telemetry.enabled) return;
    const monitorExists = await fs.access(config.paths.monitorScript).then(() => true).catch(() => false);
    if (!monitorExists) {
        console.warn(`[config] telemetry enabled but monitor script missing: ${config.paths.monitorScript} -- telemetry disabled`);
        return;
    }
    try {
        monitor = Bun.spawn([config.paths.pythonCommand, config.paths.monitorScript], { cwd: APP_ROOT, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
        void drainChildStream(monitor.stdout, line => console.log('[monitor]', line));
        void drainChildStream(monitor.stderr, line => console.error('[monitor]', line));
        monitor.exited.then(code => {
            if (code !== 0 && code !== null) {
                // Non-zero exit = telemetry is down until we restart; say so
                // loudly instead of leaving /api/telemetry/* quietly empty.
                console.error(`[monitor] exited with code ${code} -- telemetry unavailable until this server restarts`);
            }
        }).catch(() => { /* best-effort */ });
    } catch (err) {
        console.error('monitor spawn error:', (err as Error).message);
        monitor = null;
    }
}

// --- LEGACY PORT CLEANUP (opt-in only; default never kills strangers) ---
async function cleanupPort(port: number): Promise<void> {
    try {
        const proc = Bun.spawn(['fuser', '-k', `${port}/tcp`], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
        await proc.exited;
    } catch { /* fuser unavailable or port already free -- ignore */ }
}

// --- STATIC FILES (Vite client build) ---
const MIME: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.map': 'application/json',
    '.ico': 'image/x-icon',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.json': 'application/json',
};

async function serveFile(resolved: string, cacheControl: string): Promise<Response | null> {
    try {
        const buf = await fs.readFile(resolved);
        return new Response(buf, { headers: { 'Content-Type': MIME[path.extname(resolved)] || 'application/octet-stream', 'Cache-Control': cacheControl } });
    } catch {
        return null;
    }
}

// Resolves a relative path against root and guarantees the result stays
// inside it (frozen traversal guard: 403-style refusal via 404 here).
function safeJoin(root: string, rel: string): string | null {
    const resolved = path.normalize(path.join(root, rel));
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
    return resolved;
}

// --- Llama-server PROXY (browsers never dial the model host directly) ---
async function proxyLlama(req: Request, targetPath: string): Promise<Response> {
    const cfgPort = launchLib.toFiniteNumber((state.currentLaunchConfig as { port?: unknown } | null)?.port) ?? config.llama.defaultPort;
    const upstream = `http://${config.llama.defaultHost}:${cfgPort}${targetPath}`;
    let upstreamRes: Response;
    try {
        upstreamRes = await fetch(upstream, {
            method: req.method,
            headers: { 'Content-Type': req.headers.get('content-type') || 'application/json' },
            body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.from(await readBody(req)),
            // Chat streams can run for minutes; no short timeout here.
            signal: AbortSignal.timeout(600000),
        });
    } catch {
        return json({ error: 'Model server not reachable (is it launched?)' }, 502);
    }
    return new Response(upstreamRes.body, {
        status: upstreamRes.status,
        headers: { 'Content-Type': upstreamRes.headers.get('content-type') || 'application/octet-stream', 'Cache-Control': 'no-cache' },
    });
}

// --- REQUEST HANDLER ---
async function handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // CORS: configured origins only; empty (default) = same-origin, no header.
    const origin = req.headers.get('origin');
    const allowOrigin = config.server.corsOrigins.length > 0
        ? (origin && config.server.corsOrigins.includes(origin) ? origin : (config.server.corsOrigins.includes('*') ? '*' : null))
        : null;
    const baseHeaders: Record<string, string> = {};
    if (allowOrigin) {
        baseHeaders['Access-Control-Allow-Origin'] = allowOrigin;
        baseHeaders['Vary'] = 'Origin';
    }
    baseHeaders['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: baseHeaders });

    try {
        // SSE status stream (frozen shape; initial broadcast on connect).
        if (url.pathname === '/api/status') {
            const stream = new ReadableStream({
                start(controller) {
                    clients.push(controller);
                    broadcast();
                    req.signal.addEventListener('abort', () => {
                        clients = clients.filter(c => c !== controller);
                    });
                },
            });
            return new Response(stream, { status: 200, headers: { ...baseHeaders, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' } });
        }

        // New: /api/llama/* proxies chat + slots + any llama-server endpoint.
        if (url.pathname.startsWith('/api/llama/')) {
            return await proxyLlama(req, url.pathname.slice('/api/llama'.length) || '/');
        }

        // Frozen /api/* routes.
        if (url.pathname.startsWith('/api/')) {
            return await handleApiRoute(routeCtx, req, url);
        }

        // Vite client build (production bundle).
        if (url.pathname === '/' || url.pathname === '/index.html') {
            const distIndex = await serveFile(path.join(DIST_DIR, 'index.html'), 'no-store');
            if (distIndex) return distIndex;
            // Fresh clone without a build: an honest build-required page.
            return new Response(
                '<html><head><title>Mission Control</title></head><body style="font-family:monospace"><h1>Client not built</h1><p>Run <code>bun run build</code>, then reload.</p></body></html>',
                { status: 200, headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' } },
            );
        }
        if (url.pathname.startsWith('/assets/')) {
            const file = await serveFile(safeJoin(DIST_DIR, url.pathname.slice(1))!, 'max-age=31536000, immutable');
            if (file) return file;
            return json({ error: 'Not found' }, 404);
        }

        return json({ error: 'Not found' }, 404);
    } catch (err) {
        if (err instanceof BodyTooLargeError) {
            // Legacy behavior reset the socket with no status; 413 is the
            // same protection with a documentable answer (documented
            // deviation in docs/migration-notes.md).
            return json({ error: 'Payload too large' }, 413);
        }
        console.error('Unhandled route error:', err);
        return json({ error: 'Internal server error' }, 500);
    }
}

// --- INIT ---
async function init(): Promise<void> {
    const LOGS_DIR = config.paths.logsDirectory;
    try {
        await fs.mkdir(LOGS_DIR, { recursive: true });
        const csvFile = path.join(LOGS_DIR, 'benchmarks.csv');
        try { await fs.access(csvFile); } catch { await fs.writeFile(csvFile, CSV_HEADERS); }
    } catch (err) {
        console.error(`Failed to init logs directory ${LOGS_DIR}: ${(err as Error).message}`);
        process.exit(1);
    }

    // Legacy fuser port cleanup: opt-in only (default never kills strangers).
    if (config.processes.cleanupManagedPortsOnStart) {
        await cleanupPort(config.llama.defaultPort);
        if (config.telemetry.enabled) await cleanupPort(config.telemetry.port);
    }

    // Startup checks (soft): surface a broken setup without crashing.
    if (config.llama.builds.length === 0) {
        console.warn('[config] no llama.cpp builds configured -- launch and bench actions are disabled (add llama.builds to config/dashboard.json)');
    }
    for (const b of config.llama.builds) {
        if (!await fs.access(b.path).then(() => true).catch(() => false)) {
            console.warn(`[config] build "${b.id}" binary missing or unreadable: ${b.path}`);
        }
    }
    if (!config.worker.sshHost) {
        console.warn('[config] worker.sshHost empty -- worker controls stay disabled in the UI');
    }

    await spawnMonitor();
    // Reload the bench transcript tail (frozen restart behavior).
    void bench.restore();
    telemetry.start();
}

// --- SHUTDOWN (idempotent: SIGTERM -> grace -> SIGKILL -> exit) ---
let shuttingDown = false;
async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    telemetry.stop();
    try { llama.stop(); } catch { /* already gone */ }
    try { bench.stop(); } catch { /* already gone */ }
    if (monitor) { try { monitor.kill('SIGTERM'); } catch { /* already gone */ } }
    // Give children the configured grace period, then SIGKILL stragglers.
    await new Promise(resolve => setTimeout(resolve, config.processes.stopGraceMs).unref());
    try { bench.killForce(); } catch { /* already gone */ }
    if (monitor) { try { monitor.kill('SIGKILL'); } catch { /* already gone */ } }
    process.exit(0);
}

process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
// Frozen safety net: log, broadcast the crash, shut down.
process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', (err as Error)?.stack || err);
    try {
        state.serverState = 'stopped';
        broadcast('', 'Server crash: ' + ((err as Error)?.message || String(err)));
    } catch { /* broadcast may fail if clients array is corrupted */ }
    void shutdown();
});
// Frozen: log only.
process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
});

await init();
Bun.serve({
    hostname: config.server.host,
    port: config.server.port,
    fetch: handleRequest,
    error: (err) => {
        console.error('Bun.serve error:', err);
        return json({ error: 'Internal server error' }, 500);
    },
});
console.log(`\n\u{1F680} Mission Control running at: http://${config.server.host}:${config.server.port}`);
