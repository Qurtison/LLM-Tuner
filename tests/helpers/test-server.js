const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const repoRoot = path.resolve(__dirname, '../..');
const fixturesRoot = path.join(repoRoot, 'tests', 'fixtures');

function randomPort() {
    return 20000 + Math.floor(Math.random() * 20001);
}

function merge(base, extra) {
    const result = { ...base };
    for (const [key, value] of Object.entries(extra || {})) {
        result[key] = value && typeof value === 'object' && !Array.isArray(value) && result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])
            ? merge(result[key], value)
            : value;
    }
    return result;
}

function request(url) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, res => {
            res.resume();
            resolve(res.statusCode);
        });
        req.on('error', reject);
    });
}

async function startTestServer(opts = {}) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-'));
    const modelsDir = path.join(tempDir, 'models');
    const logsDir = path.join(tempDir, 'logs');
    const fixturesDir = path.join(tempDir, 'fixtures');
    const hfCache = fs.mkdtempSync(path.join(tempDir, 'hf-'));
    fs.mkdirSync(modelsDir);
    fs.mkdirSync(logsDir);
    fs.mkdirSync(fixturesDir);
    for (const name of opts.models || ['fake.gguf']) fs.writeFileSync(path.join(modelsDir, name), 'x');
    for (const name of ['fake-llama-server.sh', 'fake-llama-bench.sh', 'fake-monitor.ts']) {
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
    fs.writeFileSync(path.join(tempDir, 'config.json'), JSON.stringify(config));
    let output = '';
    const child = spawn(process.execPath, [opts.entry || path.join(repoRoot, 'server4.js')], {
        cwd: repoRoot,
        env: { ...process.env, DASHBOARD_CONFIG: path.join(tempDir, 'config.json'), HF_HOME: '', HUGGINGFACE_HUB_CACHE: '', FAKE_MONITOR_PORT: String(config.telemetry.port), FAKE_LLM_PIDFILE: path.join(tempDir, 'llm.pid'), FAKE_BENCH_PIDFILE: path.join(tempDir, 'bench.pid') },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    const append = chunk => { output = (output + chunk).slice(-1024 * 1024); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const baseUrl = 'http://127.0.0.1:' + config.server.port;
    const handle = { baseUrl, url: p => baseUrl + p, port: config.server.port, tempDir, get output() { return output; }, child, stop: null };
    handle.stop = () => stopTestServer(handle);
    const until = Date.now() + 15000;
    while (Date.now() < until) {
        try { if (await request(handle.url('/api/config')) === 200) return handle; } catch {}
        await Bun.sleep(100);
    }
    await handle.stop();
    throw new Error('Dashboard readiness timed out:\n' + output.slice(-4096));
}

function stopTestServer(handle) {
    return new Promise(resolve => {
        if (handle.child.exitCode !== null || handle.child.signalCode) return resolve();
        const timer = setTimeout(() => {
            if (handle.child.exitCode === null) handle.child.kill('SIGKILL');
        }, 5000);
        handle.child.once('exit', () => { clearTimeout(timer); resolve(); });
        handle.child.kill('SIGTERM');
    });
}

module.exports = { startTestServer, stopTestServer };
