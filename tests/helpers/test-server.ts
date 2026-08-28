import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

export interface TestServer {
    baseUrl: string;
    url: (p: string) => string;
    port: number;
    tempDir: string;
    readonly output: string;
    child: ChildProcess;
    stop: () => Promise<void>;
}

export interface TestServerOptions {
    models?: string[];
    config?: Record<string, unknown>;
    entry?: string;
}

const repoRoot = path.resolve(import.meta.dir, '..', '..');
const fixturesRoot = path.join(repoRoot, 'tests', 'fixtures');

function randomPort(): number {
    return 20000 + Math.floor(Math.random() * 20001);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

function merge(base: Record<string, unknown>, extra: Record<string, unknown> | undefined): Record<string, unknown> {
    const result: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(extra || {})) {
        const prev = result[key];
        result[key] = isPlainObject(value) && isPlainObject(prev) ? merge(prev, value) : value;
    }
    return result;
}

function request(url: string): Promise<number> {
    return new Promise((resolve, reject) => {
        const req = http.get(url, res => {
            res.resume();
            resolve(res.statusCode ?? 0);
        });
        req.on('error', reject);
    });
}

export async function startTestServer(opts: TestServerOptions = {}): Promise<TestServer> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-'));
    const modelsDir = path.join(tempDir, 'models');
    const logsDir = path.join(tempDir, 'logs');
    const fixturesDir = path.join(tempDir, 'fixtures');
    const hfCache = fs.mkdtempSync(path.join(tempDir, 'hf-'));
    fs.mkdirSync(modelsDir);
    fs.mkdirSync(logsDir);
    fs.mkdirSync(fixturesDir);
    for (const name of opts.models || ['fake.gguf']) fs.writeFileSync(path.join(modelsDir, name), 'x');
    for (const name of ['fake-llama-server.sh', 'fake-llama-bench.sh', 'fake-monitor.ts', 'fake-llama-http.ts']) {
        const destination = path.join(fixturesDir, name.replace('.sh', ''));
        fs.copyFileSync(path.join(fixturesRoot, name), destination);
        if (name.endsWith('.sh')) fs.chmodSync(destination, 0o755);
    }
    const port = randomPort();
    const telemetryPort = randomPort();
    const config = merge({
        server: { host: '127.0.0.1', port, maxBodyBytes: 10485760, corsOrigins: [] },
        paths: { modelDirectories: [modelsDir], logsDirectory: logsDir, monitorScript: path.join(fixturesDir, 'fake-monitor.ts'), pythonCommand: process.execPath, huggingFaceCache: hfCache },
        llama: { builds: [{ id: 'fake', label: 'Fake', path: path.join(fixturesDir, 'fake-llama-server') }], defaultPort: randomPort(), defaultHost: '127.0.0.1', rpcPort: 50052 },
        telemetry: { enabled: false, host: '127.0.0.1', port: telemetryPort, pollMs: 250, providers: ['linux'] },
        processes: { cleanupManagedPortsOnStart: false, stopGraceMs: 1500 },
        worker: { sshHost: '', rpcTarget: '', workDirectory: '', startCommand: 'echo up', stopCommand: 'echo down', statusCommand: 'echo', logsCommand: 'echo no logs', transportPresets: [] }
    }, opts.config || {});
    // ponytail: merge() is untyped; the defaults above pin the shape the
    // test server actually reads.
    const cfg = config as { server: { port: number }; telemetry: { port: number } };
    fs.writeFileSync(path.join(tempDir, 'config.json'), JSON.stringify(config));
    let output = '';
    // Entry under test: the Bun server. (The legacy server4.js entry and its
    // DASH_TEST_ENTRY override were removed in Phase 6.) opts.entry remains
    // for tests that need to boot a different entry file.
    const entry = opts.entry || path.join(repoRoot, 'src', 'server', 'index.ts');
    const child = spawn(process.execPath, [entry], {
        cwd: repoRoot,
        env: { ...process.env, DASHBOARD_CONFIG: path.join(tempDir, 'config.json'), HF_HOME: '', HUGGINGFACE_HUB_CACHE: '', FAKE_MONITOR_PORT: String(cfg.telemetry.port), FAKE_LLM_PIDFILE: path.join(tempDir, 'llm.pid'), FAKE_BENCH_PIDFILE: path.join(tempDir, 'bench.pid'), FAKE_BUN: process.execPath },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    const append = (chunk: Buffer | string): void => { output = (output + chunk).slice(-1024 * 1024); };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const baseUrl = 'http://127.0.0.1:' + cfg.server.port;
    const handle: TestServer = {
        baseUrl,
        url: p => baseUrl + p,
        port: cfg.server.port,
        tempDir,
        get output() { return output; },
        child,
        stop: () => stopTestServer(handle),
    };
    const until = Date.now() + 15000;
    while (Date.now() < until) {
        try { if (await request(handle.url('/api/config')) === 200) return handle; } catch { /* not ready yet */ }
        await Bun.sleep(100);
    }
    await handle.stop();
    throw new Error('Dashboard readiness timed out:\n' + output.slice(-4096));
}

export function stopTestServer(handle: TestServer): Promise<void> {
    return new Promise(resolve => {
        if (handle.child.exitCode !== null || handle.child.signalCode) return resolve();
        const timer = setTimeout(() => {
            if (handle.child.exitCode === null) handle.child.kill('SIGKILL');
        }, 5000);
        handle.child.once('exit', () => { clearTimeout(timer); resolve(); });
        handle.child.kill('SIGTERM');
    });
}
