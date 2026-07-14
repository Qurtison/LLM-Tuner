const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { spawn, exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

const ROOT_DIR = path.join(__dirname, '..');
const PORT = 3000;
const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB payload limit to prevent OOM

// --- STATE ---
let llamaProcess = null;
let pythonProcess = null;
let serverState = 'stopped';
let currentModel = '';
let isRpc = false;
let clients = [];
let loadStartTime = 0;
let finalLoadTime = 0;

// --- PATH HELPERS ---
const LOCAL_MODELS_DIR = path.join(ROOT_DIR, 'models');
const HF_CACHE_DIR = process.env.HF_HOME || process.env.HUGGINGFACE_HUB_CACHE || path.join(os.homedir(), '.cache', 'huggingface', 'hub');

function toContainerPath(hostPath) {
    if (hostPath.startsWith(LOCAL_MODELS_DIR)) return hostPath.replace(LOCAL_MODELS_DIR, '/models');
    if (hostPath.startsWith(HF_CACHE_DIR)) return hostPath.replace(HF_CACHE_DIR, '/hf-cache');
    throw new Error(`Model path not under a mounted dir: ${hostPath}`);
}

// --- SAFE SSE BROADCAST ---
function broadcastState(logLine = '', errorMessage = '') {
    const payload = JSON.stringify({ state: serverState, model: currentModel, isRpc, log: logLine, error: errorMessage, loadStartTime, finalLoadTime });
    const deadClients = [];
    for (const client of clients) {
        try {
            client.write(`data: ${payload}\n\n`);
        } catch (err) {
            deadClients.push(client);
        }
    }
    clients = clients.filter(c => !deadClients.includes(c));
}

// --- SAFE REQUEST BODY PARSER ---
function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        let size = 0;
        req.on('data', chunk => {
            size += chunk.length;
            if (size > MAX_BODY_SIZE) {
                req.destroy();
                return reject(new Error('Payload too large'));
            }
            body += chunk;
        });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

// --- ASYNC GGUF SCANNER ---
async function scanDirForGgufs(dir) {
    let files = [];
    try {
        const items = await fs.readdir(dir, { withFileTypes: true });
        for (const item of items) {
            const fullPath = path.join(dir, item.name);
            if (item.isDirectory()) {
                files = files.concat(await scanDirForGgufs(fullPath));
            } else if (item.name.endsWith('.gguf')) {
                const stats = await fs.stat(fullPath);
                files.push({
                    name: item.name,
                    path: fullPath,
                    size: (stats.size / (1024 * 1024 * 1024)).toFixed(2),
                    source: 'huggingface'
                });
            }
        }
    } catch { /* skip inaccessible dirs */ }
    return files;
}

// --- SSH EXECUTION (SECURE & CORRECTED) ---
function isValidSSHHost(host) {
    return /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+$/.test(host);
}

async function runSSHCommand(host, command) {
    if (!isValidSSHHost(host)) throw new Error('Invalid SSH host format');
    return new Promise((resolve, reject) => {
        // Pass command as a single trailing argument so SSH sends it verbatim to the remote shell
        const ssh = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', host, command]);
        let stdout = '', stderr = '';
        ssh.stdout.on('data', d => stdout += d);
        ssh.stderr.on('data', d => stderr += d);
        ssh.on('close', code => {
            if (code === 0) resolve({ stdout, stderr });
            else reject(new Error(stderr || `SSH exited with code ${code}`));
        });
        ssh.on('error', reject);
    });
}

// --- DOCKER COMPOSE HELPER ---
async function runDockerCompose(command) {
    try {
        const { stdout, stderr } = await execAsync(`docker compose -f docker-compose.master.yml ${command}`, {
            cwd: ROOT_DIR,
            maxBuffer: 1024 * 1024
        });
        return { stdout, stderr };
    } catch (err) {
        return { stdout: err.stdout || '', stderr: err.stderr || err.message };
    }
}

// --- PORT CLEANUP (Restored safely) ---
async function cleanupPort(port) {
    try {
        await execAsync(`fuser -k ${port}/tcp`, { stdio: 'ignore' });
    } catch {
        // fuser unavailable or port already free - silently ignore
    }
}

// --- CSV LOG INIT ---
const CSV_HEADERS = "Timestamp,Category,Metric,Model,Quant,Ctx,NGL,RPC,Transport,Prompt Tok/s,Gen Tok/s,Prompt Latency (s),Master GPU Util (%),Master GPU Pwr (W),Master GPU Temp (C),Master CPU Util (%),Master CPU Temp (C),Master VRAM (MB),Master RAM (MB),Worker GPU Util (%),Worker GPU Pwr (W),Worker GPU Temp (C),Worker CPU Temp (C),Worker VRAM (MB),Worker RAM (MB),Net Throughput (MB/s),Gen Tokens,Reasoning Tokens,Wall Time (s),Load Time\n";
const LOGS_DIR = path.join(ROOT_DIR, 'logs');
const CSV_FILE = path.join(LOGS_DIR, 'benchmarks.csv');

async function initLogsDir() {
    try {
        await fs.mkdir(LOGS_DIR, { recursive: true });
        try { await fs.access(CSV_FILE); } catch {
            await fs.writeFile(CSV_FILE, CSV_HEADERS);
        }
    } catch (err) {
        console.warn('Failed to init logs directory:', err.message);
    }
}

// --- HTTP SERVER ---
const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(200); return res.end(); }

    try {
        // --- UI ---
        if (req.url === '/' || req.url === '/index.html') {
            const content = await fs.readFile(path.join(__dirname, 'index.html'), 'utf-8');
            res.writeHead(200, { 'Content-Type': 'text/html' });
            return res.end(content);
        }

        // --- SSE STATUS ---
        else if (req.url === '/api/status') {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
            clients.push(res);
            broadcastState();
            req.on('close', () => { clients = clients.filter(c => c !== res); });
            return;
        }

        // --- MODELS ---
        else if (req.url === '/api/models') {
            const allModels = [];
            const localDir = path.join(ROOT_DIR, 'models');

            if (await fs.access(localDir).then(() => true).catch(() => false)) {
                const items = await fs.readdir(localDir);
                for (const f of items) {
                    if (f.endsWith('.gguf')) {
                        const fullPath = path.join(localDir, f);
                        const stats = await fs.stat(fullPath);
                        allModels.push({
                            name: f, path: fullPath,
                            size: (stats.size / (1024 * 1024 * 1024)).toFixed(2),
                            source: 'local'
                        });
                    }
                }
            }

            try {
                if (await fs.access(HF_CACHE_DIR).then(() => true).catch(() => false)) {
                    allModels.push(...await scanDirForGgufs(HF_CACHE_DIR));
                }
            } catch (err) {
                console.warn('Failed to scan Hugging Face cache:', err.message);
            }

            const uniqueModels = [];
            const seenPaths = new Set();
            for (const m of allModels) {
                if (!seenPaths.has(m.path)) {
                    seenPaths.add(m.path);
                    uniqueModels.push(m);
                }
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(uniqueModels));
        }

        // --- BENCHMARK LOG ---
        else if (req.url === '/api/log' && req.method === 'POST') {
            let body;
            try { body = JSON.parse(await parseBody(req)); } catch (e) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid JSON' })); }

            // Self-healing: ensure dir exists even if lost mid-run
            await fs.mkdir(LOGS_DIR, { recursive: true });

            const timestamp = new Date().toISOString();
            const row = `${timestamp},${body.category || 'Bench'},${body.metric || 'N/A'},${body.model},${body.quant || 'N/A'},${body.ctx},${body.ngl},${body.rpc},${body.transport},${body.promptTps},${body.genTps},${body.promptLatency},${body.gpuUtil},${body.gpuPwr},${body.masterGpuTemp || 'N/A'},${body.cpuUtil},${body.masterCpuTemp || 'N/A'},${body.gpuMem},${body.ramUsage},${body.workerGpuUtil || 'N/A'},${body.workerGpuPwr || 'N/A'},${body.workerGpuTemp || 'N/A'},${body.workerCpuTemp || 'N/A'},${body.workerVram || 'N/A'},${body.workerRam || 'N/A'},${body.netThroughput},${body.genTokens},${body.reasonTokens || 0},${body.wallTime},${body.loadTime || 'N/A'}\n`;

            await fs.appendFile(CSV_FILE, row);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true }));
        }

        // --- CSV DOWNLOAD ---
        else if (req.url === '/api/logs/csv' && req.method === 'GET') {
            try {
                const csv = await fs.readFile(CSV_FILE, 'utf-8');
                res.writeHead(200, { 'Content-Type': 'text/csv' });
                return res.end(csv);
            } catch {
                res.writeHead(404);
                return res.end();
            }
        }

        // --- START SERVER ---
        else if (req.url === '/api/start' && req.method === 'POST') {
            let body;
            try { body = JSON.parse(await parseBody(req)); } catch (e) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid JSON' })); }

            if (llamaProcess) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Running' })); }

            const config = body;
            currentModel = config.model;
            isRpc = !!config.rpcTarget;
            serverState = 'starting';
            loadStartTime = Date.now();
            finalLoadTime = 0;
            broadcastState();

            await runDockerCompose('down --remove-orphans');

            let args = ['compose', '-f', 'docker-compose.master.yml', 'run', '--rm', '--service-ports', 'master-node',
                '/app/llama-server', '-m', toContainerPath(config.modelPath),
                '-c', config.ctx.toString(), '-ngl', config.ngl.toString(),
                '--host', '0.0.0.0', '--port', '8080', '--metrics'];

            if (config.fa) args.push('-fa', 'on');
            if (config.cacheK) args.push('--cache-type-k', config.cacheK);
            if (config.cacheV) args.push('--cache-type-v', config.cacheV);
            if (config.specType) {
                args.push('--spec-type', config.specType);
                args.push('--spec-draft-n-max', (config.specDraftNMax || 2).toString());
                args.push('-np', '1');
            }
            if (config.specDraftNgl) args.push('--spec-draft-ngl', config.specDraftNgl.toString());
            if (config.preserveThinking) {
                args.push('--chat-template-kwargs', JSON.stringify({ preserve_thinking: true }));
            }
            if (isRpc) {
                args.push('--rpc', `${config.rpcTarget.split('@').pop()}:50052`);
                args.push('--split-mode', 'layer');
                if (config.tensorSplit && config.tensorSplit < 100) {
                    args.push('-ts', `${config.tensorSplit},${100 - config.tensorSplit}`);
                }
            }

            llamaProcess = spawn('docker', args, { cwd: ROOT_DIR, stdio: ['ignore', 'pipe', 'pipe'] });

            const handleLogs = (d) => {
                const text = d.toString();
                process.stdout.write(text);
                if (text.includes('load_model: loading model')) {
                    serverState = 'loading';
                    broadcastState();
                }
                else if (text.includes('llama_server: listening on')) {
                    serverState = 'ready';
                    if (loadStartTime > 0) {
                        finalLoadTime = ((Date.now() - loadStartTime) / 1000).toFixed(1);
                        loadStartTime = 0;
                    }
                    broadcastState();
                }
                else if (text.includes('prompt processing, n_tokens =')) {
                    // Parse: prompt processing, n_tokens =  8192, progress = 0.66, t =  3.61 s / 2272.33 tokens per second
                    const nTokensMatch = text.match(/n_tokens =\s*(\d+)/);
                    const progressMatch = text.match(/progress = (0\.\d+|1\.00)/);
                    const tpsMatch = text.match(/(\d+\.?\d*)\s*tokens per second/);
                    if (progressMatch) {
                        const nTokens = nTokensMatch ? nTokensMatch[1] : '0';
                        const tps = tpsMatch ? tpsMatch[1] : '0';
                        broadcastState(`PREFILL_PROGRESS:${progressMatch[1]}:${tps}:${nTokens}`);
                    }
                }
                else if (text.includes('abort') || text.toLowerCase().includes('error:') || text.includes('failed to fit params to free device memory')) {
                    serverState = 'stopped';
                    if (llamaProcess) {
                        llamaProcess.kill();
                        llamaProcess = null;
                        runDockerCompose('down --remove-orphans').catch(() => { });
                    }
                    const errMsg = text.includes('failed to fit params')
                        ? 'Failed to allocate VRAM: Reduce n_gpu_layers or use a smaller model.'
                        : 'Process error: ' + text.trim().slice(-200);
                    broadcastState('', errMsg);
                }
            };

            llamaProcess.stdout.on('data', handleLogs);
            llamaProcess.stderr.on('data', handleLogs);

            llamaProcess.on('close', () => {
                if (llamaProcess.stdout) llamaProcess.stdout.removeAllListeners('data');
                if (llamaProcess.stderr) llamaProcess.stderr.removeAllListeners('data');
                llamaProcess = null;
                serverState = 'stopped';
                currentModel = '';
                isRpc = false;
                broadcastState();
            });

            llamaProcess.on('error', (err) => {
                console.error('Llama process error:', err);
                serverState = 'stopped';
                broadcastState('', 'Failed to start process: ' + err.message);
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ status: 'launching' }));
        }

        // --- STOP SERVER ---
        else if (req.url === '/api/stop' && req.method === 'POST') {
            serverState = 'stopping';
            broadcastState();
            await runDockerCompose('down --remove-orphans');
            if (llamaProcess) {
                llamaProcess.kill();
                llamaProcess = null;
            }
            serverState = 'stopped';
            currentModel = '';
            isRpc = false;
            broadcastState();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ status: 'stopped' }));
        }

        // --- WORKER START ---
        else if (req.url === '/api/worker/start' && req.method === 'POST') {
            let body;
            try { body = JSON.parse(await parseBody(req)); } catch (e) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid JSON' })); }
            const { worker_ssh } = body;
            if (!worker_ssh) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Missing worker_ssh' })); }
            try {
                const { stdout, stderr } = await runSSHCommand(worker_ssh, 'cd ~/AI/experiment-1 && docker compose -f docker-compose.worker.yml up -d');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ success: true, stdout, stderr }));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ success: false, error: err.message }));
            }
        }

        // --- WORKER STOP ---
        else if (req.url === '/api/worker/stop' && req.method === 'POST') {
            let body;
            try { body = JSON.parse(await parseBody(req)); } catch (e) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid JSON' })); }
            const { worker_ssh } = body;
            if (!worker_ssh) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Missing worker_ssh' })); }
            try {
                const { stdout, stderr } = await runSSHCommand(worker_ssh, 'cd ~/AI/experiment-1 && docker compose -f docker-compose.worker.yml down');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ success: true, stdout, stderr }));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ success: false, error: err.message }));
            }
        }

        // --- WORKER STATUS ---
        else if (req.url === '/api/worker/status' && req.method === 'POST') {
            let body;
            try { body = JSON.parse(await parseBody(req)); } catch (e) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid JSON' })); }
            const { worker_ssh } = body;
            if (!worker_ssh) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Missing worker_ssh' })); }
            try {
                const { stdout } = await runSSHCommand(worker_ssh, 'cd ~/AI/experiment-1 && docker compose -f docker-compose.worker.yml ps --filter status=running -q');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ status: stdout.trim().length > 0 ? 'running' : 'stopped' }));
            } catch (err) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ status: 'offline', error: err.message }));
            }
        }

        // --- WORKER LOGS ---
        else if (req.url === '/api/worker/logs' && req.method === 'POST') {
            let body;
            try { body = JSON.parse(await parseBody(req)); } catch (e) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid JSON' })); }
            const { worker_ssh } = body;
            if (!worker_ssh) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Missing worker_ssh' })); }
            try {
                const { stdout, stderr } = await runSSHCommand(worker_ssh, 'cd ~/AI/experiment-1 && docker compose -f docker-compose.worker.yml logs --tail=50');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ logs: stdout || stderr || 'No logs available.' }));
            } catch (err) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ logs: `Failed to fetch logs: ${err.message}` }));
            }
        }

        // --- MASTER LOGS ---
        else if (req.url === '/api/master/logs' && req.method === 'GET') {
            try {
                const { stdout, stderr } = await runDockerCompose('logs --tail=50 master-node 2>&1');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ logs: stdout || stderr || 'No logs available.' }));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ logs: `Failed to fetch logs: ${err.message}` }));
            }
        }

        // --- 404 ---
        else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Not found' }));
        }

    } catch (err) {
        console.error('Unhandled route error:', err);
        if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
        }
    }
});

// --- SERVER INITIALIZATION ---
async function initServer() {
    await initLogsDir();
    await cleanupPort(8081); // Restored safe orphan-process protection

    try {
        const { stdout: psOut } = await execAsync('docker ps -q -f name=master-node');
        const containerId = psOut.trim();
        if (containerId) {
            serverState = 'ready';
            const { stdout: inspectOut } = await execAsync(`docker inspect ${containerId}`);
            const inspectData = JSON.parse(inspectOut);
            const args = inspectData[0]?.Args || [];
            const mIdx = args.indexOf('-m');
            if (mIdx !== -1 && args[mIdx + 1]) currentModel = args[mIdx + 1].split('/').pop();
            else currentModel = 'Unknown';
            isRpc = args.includes('--rpc');
        }
    } catch { /* Docker not available or container not running */ }

    pythonProcess = spawn('python3', ['monitor.py'], { cwd: __dirname });

    const shutdownHandler = async () => {
        if (llamaProcess) {
            try { await execAsync('docker compose -f docker-compose.master.yml down', { cwd: ROOT_DIR }); } catch { }
        }
        if (pythonProcess) pythonProcess.kill();
        process.exit(0);
    };

    process.on('exit', () => { if (pythonProcess) pythonProcess.kill(); });
    process.on('SIGINT', shutdownHandler);
    process.on('SIGTERM', shutdownHandler);

    server.listen(PORT, () => console.log(`\n🚀 Mission Control running at: http://localhost:${PORT}`));
}

initServer().catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
});