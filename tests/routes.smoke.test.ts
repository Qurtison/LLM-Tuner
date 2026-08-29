// Route smoke tests for the Bun server: root/config/models/builds, SSE
// status stream, CSV log rows + read models, bench lifecycle, launch
// lifecycle, live master-log SSE, flags/devices, worker/telemetry/errors.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { startTestServer, stopTestServer, type TestServer } from './helpers/test-server';

let server: TestServer;

function json(url: string, options?: RequestInit): Promise<{ response: Response; body: any }> {
    // ponytail: API bodies are asserted field-by-field; any keeps the helper
    // generic (matches the pre-TS require() version).
    return fetch(url, options).then(async response => ({ response, body: await response.json() }));
}

async function poll<T>(fn: () => Promise<T | null | undefined>, timeout = 10000): Promise<T> {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
        const value = await fn();
        if (value) return value;
        await Bun.sleep(100);
    }
    throw new Error('Timed out polling');
}

function sse(url: string, predicate: (payload: any) => boolean): Promise<{ response: http.IncomingMessage; payload: any }> {
    return new Promise((resolve, reject) => {
        const req = http.request(url, response => {
            let buffer = '';
            response.on('data', chunk => {
                buffer += chunk;
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';
                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const payload = JSON.parse(line.slice(6));
                    if (predicate(payload)) {
                        req.destroy();
                        resolve({ response, payload });
                    }
                }
            });
        });
        req.setTimeout(10000, () => { req.destroy(); reject(new Error('SSE timeout')); });
        req.on('error', error => { if ((error as { code?: string }).code !== 'ECONNRESET') reject(error); });
        req.end();
    });
}

async function post(route: string, body: unknown) {
    return json(server.url(route), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

describe('server4 route smoke', () => {
    beforeAll(async () => { server = await startTestServer({ models: ['fake.gguf'] }); });
    afterAll(async () => { if (server) await stopTestServer(server); });

    it('serves root, safe config, models, and builds', async () => {
        const root = await fetch(server.url('/'));
        expect(root.status).toBe(200);
        expect(root.headers.get('content-type')).toContain('text/html');
        expect(await root.text()).toContain('<html');
        const config = await json(server.url('/api/config'));
        expect(config.response.status).toBe(200);
        expect(config.body.uiDefaults).toBeObject();
        expect(config.body.llama.builds[0]).not.toHaveProperty('path');
        expect(typeof config.body.worker.enabled).toBe('boolean');
        expect(typeof config.body.telemetry.enabled).toBe('boolean');
        expect(JSON.stringify(config.body)).not.toContain('startCommand');
        expect(JSON.stringify(config.body)).not.toContain('logsDirectory');
        const models = await json(server.url('/api/models'));
        expect(models.response.status).toBe(200);
        expect(models.body).toEqual(expect.any(Array));
        expect(models.body).toContainEqual(expect.objectContaining({ name: 'fake.gguf', source: 'local', path: path.join(server.tempDir, 'models', 'fake.gguf') }));
        expect(models.body.filter((model: { source: string }) => model.source === 'huggingface')).toHaveLength(0);
        const builds = await json(server.url('/api/builds'));
        expect(builds.response.status).toBe(200);
        expect(builds.body).toEqual({ builds: [{ id: 'fake', label: 'Fake', path: expect.any(String) }] });
    });

    it('streams stopped SSE state', async () => {
        const event = await sse(server.url('/api/status'), payload => payload.state === 'stopped');
        expect(event.response.statusCode).toBe(200);
        expect(event.response.headers['content-type']).toContain('text/event-stream');
        expect(event.payload).toEqual(expect.objectContaining({ state: 'stopped', model: expect.any(String), log: expect.any(String), error: expect.any(String), launchCommand: expect.any(String), launchConfig: null }));
    });

    it('logs CSV rows and exposes log read models', async () => {
        const model = path.join(server.tempDir, 'models', 'fake.gguf');
        const logged = await post('/api/log', { model, ctx: 4096, ngl: 1, promptTps: 12.5, genTps: 30.25, promptTokens: 100, genTokens: 200, wallTime: 5.5, loadTime: 2.2, transport: 'Local', argString: 'a,b "q"' });
        expect(logged.response.status).toBe(200);
        expect(logged.body).toEqual({ success: true, run_id: expect.any(String) });
        const csv = await fetch(server.url('/api/logs/csv'));
        expect(csv.status).toBe(200);
        expect(csv.headers.get('content-type')).toContain('text/csv');
        const text = await csv.text();
        expect(text).toContain('fake.gguf');
        expect(text).toContain('"a,b ""q"""');
        const recent = await json(server.url('/api/logs/recent'));
        const row = recent.body.rows.find((item: { model: string }) => item.model === 'fake.gguf');
        expect(row).toEqual(expect.objectContaining({ promptTps: 12.5, genTokens: 200, aborted: false }));
        const summary = await json(server.url('/api/logs/summary'));
        expect(summary.body.count).toBeGreaterThanOrEqual(1);
        expect(Number.isFinite(summary.body.avgGenTps)).toBe(true);
        expect(summary.body.bestGenTps).toBeGreaterThanOrEqual(summary.body.avgGenTps);
        expect(summary.body.lastModel).toEqual(expect.any(String));
        expect((await json(server.url('/api/logs/samples?runId=' + logged.body.run_id))).body).toEqual({ samples: [] });
        expect((await json(server.url('/api/logs/active-samples'))).body).toEqual({ samples: [] });
    });

    it('runs bench note, clear, start, restore, and stop paths', async () => {
        expect((await json(server.url('/api/bench/status'))).body).toEqual({ running: false, command: '', output: [], queueRemaining: 0, queueTotal: 0, currentLabel: '', samples: [] });
        expect((await post('/api/bench/note', { lines: ['hello note'] })).body).toEqual({ ok: true });
        expect((await json(server.url('/api/bench/status'))).body.output).toContain('hello note');
        expect((await post('/api/bench/clear', {})).body).toEqual({ ok: true });
        expect((await json(server.url('/api/bench/status'))).body.output).toEqual([]);
        const modelPath = path.join(server.tempDir, 'models', 'fake.gguf');
        const start = await post('/api/bench/start', { modelPath, build: 'fake', reps: 1 });
        expect(start.response.status).toBe(200);
        expect(start.body).toEqual({ ok: true, command: expect.stringContaining('fake-llama-bench') });
        const finished = await poll(async () => { const status = await json(server.url('/api/bench/status')); return status.body.running ? null : status.body; });
        expect(finished.output.some((line: string) => /exited with code 0/.test(line))).toBe(true);
        const restored = await post('/api/bench/restore', {});
        expect(restored.body.ok).toBe(true);
        expect(restored.body.output.length).toBeGreaterThan(0);
        const again = await post('/api/bench/start', { modelPath, build: 'fake', reps: 1 });
        expect(again.response.status).toBe(200);
        const conflict = await post('/api/bench/start', { modelPath, build: 'fake', reps: 1 });
        expect(conflict.response.status).toBe(409);
        expect(conflict.body).toEqual({ error: 'A bench run is already in progress' });
        expect((await post('/api/bench/stop', {})).body).toEqual({ ok: true });
        await poll(async () => (await json(server.url('/api/bench/status'))).body.running ? null : true);
    });

    it('previews command, starts model, rejects duplicate start, then stops it', async () => {
        const body = { modelPath: path.join(server.tempDir, 'models', 'fake.gguf'), build: 'fake', ctx: 4096, ngl: 1 };
        const preview = await post('/api/preview-command', body);
        expect(preview.response.status).toBe(200);
        expect(preview.body.command).toContain('fake-llama-server');
        expect(preview.body.command).toContain('--port');
        expect((await post('/api/start', body)).body).toEqual({ status: 'launching' });
        const duplicate = await post('/api/start', body);
        expect(duplicate.response.status).toBe(400);
        expect(duplicate.body).toEqual({ error: 'Running' });
        await sse(server.url('/api/status'), payload => payload.state === 'ready');
        const logs = await json(server.url('/api/master/logs'));
        expect(logs.body.logs).toContain('model loaded');
        expect((await post('/api/stop', {})).body).toEqual({ status: 'stopped' });
        const pid = Number(fs.readFileSync(path.join(server.tempDir, 'llm.pid'), 'utf8'));
        await poll(async () => { try { process.kill(pid, 0); return null; } catch { return true; } }, 5000);
    });

    it('streams master logs live over SSE and backfills the tail', async () => {
        const body = { modelPath: path.join(server.tempDir, 'models', 'fake.gguf'), build: 'fake', ctx: 4096, ngl: 1 };
        let contentType = '';
        // lines=0 disables the backfill entirely, so every line received here
        // is provably LIVE -- no dependence on what the ring held before this
        // test ran (a launch clears the ring, so transcript counting flakes).
        let receivedCount = 0;
        const liveDone = new Promise<void>((resolve, reject) => {
            const req = http.request(server.url('/api/master/logs/stream?lines=0'), response => {
                contentType = response.headers['content-type'] as string;
                let buffer = '';
                response.on('data', chunk => {
                    buffer += chunk;
                    const lines = buffer.split('\n');
                    buffer = lines.pop() ?? '';
                    for (const line of lines) {
                        if (!line.startsWith('data: ')) continue;
                        const text = line.slice(6);
                        receivedCount += 1;
                        if (text.includes('llama_server: model loaded')) {
                            req.destroy();
                            resolve();
                        }
                    }
                });
            });
            req.setTimeout(14000, () => { req.destroy(); reject(new Error('live log stream timeout')); });
            req.on('error', error => { if ((error as { code?: string }).code !== 'ECONNRESET') reject(error); });
            req.end();
        });
        expect((await post('/api/start', body)).body).toEqual({ status: 'launching' });
        await liveDone;
        expect(contentType).toContain('text/event-stream');

        // A fresh connection replays the ring tail without needing a launch.
        const tail = await new Promise((resolve, reject) => {
            const req = http.request(server.url('/api/master/logs/stream?lines=1'), response => {
                let buffer = '';
                response.on('data', chunk => {
                    buffer += chunk;
                    if (buffer.includes('data: ')) { req.destroy(); resolve(buffer); }
                });
            });
            req.setTimeout(5000, () => { req.destroy(); reject(new Error('log tail timeout')); });
            req.on('error', error => { if ((error as { code?: string }).code !== 'ECONNRESET') reject(error); });
            req.end();
        });
        expect(tail).toContain('llama_server: model loaded');
        expect((await post('/api/stop', {})).body).toEqual({ status: 'stopped' });
        const pid = Number(fs.readFileSync(path.join(server.tempDir, 'llm.pid'), 'utf8'));
        await poll(async () => { try { process.kill(pid, 0); return null; } catch { return true; } }, 5000);
    });

    it('parses flags and GPUs only', async () => {
        const flags = await json(server.url('/api/flags'));
        expect(flags.response.status).toBe(200);
        expect(flags.body.flags.length).toBeGreaterThan(0);
        expect(flags.body.flags.some((item: { flags: string }) => item.flags.includes('--ctx-size'))).toBe(true);
        const devices = await json(server.url('/api/devices'));
        expect(devices.body).toEqual({ devices: [{ id: '0', description: 'Fake GPU 0', totalMib: 16384, freeMib: 12000 }, { id: '1', description: 'CPU', totalMib: 8192, freeMib: 4000 }] });
    });

    it('handles worker, telemetry-rate, and errors', async () => {
        const worker = await post('/api/worker/status', { worker_ssh: 'user@127.0.0.1' });
        expect(worker.response.status).toBe(200);
        expect(worker.body).toEqual({ status: 'offline', error: expect.any(String) });
        const missing = await post('/api/worker/start', {});
        expect(missing.response.status).toBe(400);
        expect(missing.body).toEqual({ error: 'Missing worker_ssh' });
        expect((await post('/api/telemetry/rate', { ms: 100 })).body).toEqual({ ok: true, ms: 250 });
        expect((await post('/api/telemetry/rate', { ms: 99999 })).body).toEqual({ ok: true, ms: 5000 });
        const invalid = await fetch(server.url('/api/log'), { method: 'POST', body: 'not json{' });
        expect(invalid.status).toBe(400);
        expect(await invalid.json()).toEqual({ error: 'Invalid JSON' });
        const missingRoute = await json(server.url('/api/definitely-not'));
        expect(missingRoute.response.status).toBe(404);
        expect(missingRoute.body).toEqual({ error: 'Not found' });
        // Frozen: oversized body is refused and the server stays alive.
        // Legacy entry resets the socket (no status); the Bun entry answers
        // 413 -- same protection, documentable deviation (see migration notes).
        let oversized: Response | null;
        try {
            oversized = await fetch(server.url('/api/log'), { method: 'POST', body: 'x'.repeat(11 * 1024 * 1024) });
        } catch {
            oversized = null; // legacy socket reset
        }
        if (oversized) expect(oversized.status).toBe(413);
        expect((await json(server.url('/api/config'))).response.status).toBe(200);
    });

    it('reads enabled telemetry from fake monitor', async () => {
        const telemetry = await startTestServer({ config: { telemetry: { enabled: true } } });
        try {
            const latest = await poll(async () => { const result = await json(telemetry.url('/api/telemetry/latest')); return result.body.stats ? result.body : null; });
            expect(latest.stats.master.gpu_util).toBe(42);
        } finally {
            await stopTestServer(telemetry);
        }
    });
});
