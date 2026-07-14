const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync, exec } = require('child_process');

const ROOT_DIR = path.join(__dirname, '..');
const PORT = 3000;
let llamaProcess = null;
let serverState = 'stopped';
let currentModel = '';
let isRpc = false;
let clients = [];

let loadStartTime = 0;
let finalLoadTime = 0;

try {
    const psOut = execSync('docker ps -q -f name=master-node').toString().trim();
    if (psOut) {
        serverState = 'ready';
        const inspectOut = JSON.parse(execSync(`docker inspect ${psOut}`).toString());
        const args = inspectOut[0].Args || [];
        const mIdx = args.indexOf('-m');
        if (mIdx !== -1 && args[mIdx + 1]) currentModel = args[mIdx + 1].split('/').pop();
        else currentModel = 'Unknown';
        isRpc = args.includes('--rpc');
    }
} catch (e) { }

// Recursive helper to find .gguf files safely
function scanDirForGgufs(dir) {
    let files = [];
    try {
        const items = fs.readdirSync(dir, { withFileTypes: true });
        for (const item of items) {
            const fullPath = path.join(dir, item.name);
            if (item.isDirectory()) {
                files = files.concat(scanDirForGgufs(fullPath));
            } else if (item.name.endsWith('.gguf')) {
                const stats = fs.statSync(fullPath);
                files.push({
                    name: item.name,
                    path: fullPath,
                    size: (stats.size / (1024 * 1024 * 1024)).toFixed(2),
                    source: 'huggingface'
                });
            }
        }
    } catch (err) {
        // Silently skip directories we can't read (permissions, broken symlinks, etc.)
    }
    return files;
}

function broadcastState(logLine = '', errorMessage = '') {
    const payload = JSON.stringify({ state: serverState, model: currentModel, isRpc, log: logLine, error: errorMessage, loadStartTime, finalLoadTime });
    clients.forEach(client => client.write(`data: ${payload}\n\n`));
}

try { execSync('fuser -k 8081/tcp', { stdio: 'ignore' }); } catch (e) { }
const pythonProcess = spawn('python3', ['monitor.py'], { cwd: __dirname });

process.on('exit', () => { if (pythonProcess) pythonProcess.kill(); });
process.on('SIGINT', () => { if (pythonProcess) pythonProcess.kill(); process.exit(); });
process.on('SIGTERM', () => { if (pythonProcess) pythonProcess.kill(); process.exit(); });

const LOCAL_MODELS_DIR = path.join(ROOT_DIR, 'models');
const HF_CACHE_DIR = process.env.HF_HOME || process.env.HUGGINGFACE_HUB_CACHE || path.join(os.homedir(), '.cache', 'huggingface', 'hub');

function toContainerPath(hostPath) {
    if (hostPath.startsWith(LOCAL_MODELS_DIR)) return hostPath.replace(LOCAL_MODELS_DIR, '/models');
    if (hostPath.startsWith(HF_CACHE_DIR)) return hostPath.replace(HF_CACHE_DIR, '/hf-cache');
    throw new Error(`Model path not under a mounted dir: ${hostPath}`);
}

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(200); return res.end(); }

    if (req.url === '/' || req.url === '/index.html') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, content) => {
            if (err) { res.writeHead(500); return res.end('Error loading UI.'); }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(content, 'utf-8');
        });
    }
    else if (req.url === '/api/status') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
        clients.push(res);
        broadcastState();
        req.on('close', () => { clients = clients.filter(c => c !== res); });
    }
    // --- UPDATED: Get Models WITH File Sizes ---
    else if (req.url === '/api/models') {
        try {
            const allModels = [];

            // 1. Local models directory
            const localDir = path.join(ROOT_DIR, 'models');
            if (fs.existsSync(localDir)) {
                const localFiles = fs.readdirSync(localDir).filter(f => f.endsWith('.gguf')).map(f => {
                    const stats = fs.statSync(path.join(localDir, f));
                    return {
                        name: f,
                        path: path.join(localDir, f),
                        size: (stats.size / (1024 * 1024 * 1024)).toFixed(2),
                        source: 'local'
                    };
                });
                allModels.push(...localFiles);
            }

            // 2. Hugging Face cache directory

            // const hfCacheDir = process.env.HF_HOME ||
            //     process.env.HUGGINGFACE_HUB_CACHE ||
            //     path.join(os.homedir(), '.cache', 'huggingface', 'hub');

            try {
                if (fs.existsSync(HF_CACHE_DIR)) {
                    const hfFiles = scanDirForGgufs(HF_CACHE_DIR);
                    allModels.push(...hfFiles);
                }
            } catch (hfErr) {
                console.warn('Failed to scan Hugging Face cache:', hfErr.message);
            }

            // Deduplicate by path (handles symlinks or copied files)
            const uniqueModels = [];
            const seenPaths = new Set();
            for (const m of allModels) {
                if (!seenPaths.has(m.path)) {
                    seenPaths.add(m.path);
                    uniqueModels.push(m);
                }
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(uniqueModels));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to read models', details: e.message }));
        }
    }
    // --- NEW: Write to CSV Benchmark Log ---
    else if (req.url === '/api/log' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const logsDir = path.join(ROOT_DIR, 'logs');
                const csvFile = path.join(logsDir, 'benchmarks.csv');

                if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir);

                // Add Headers if file doesn't exist
                if (!fs.existsSync(csvFile)) {
                    const headers = "Timestamp,Category,Metric,Model,Quant,Ctx,NGL,RPC,Transport,Prompt Tok/s,Gen Tok/s,Prompt Latency (s),Master GPU Util (%),Master GPU Pwr (W),Master GPU Temp (C),Master CPU Util (%),Master CPU Temp (C),Master VRAM (MB),Master RAM (MB),Worker GPU Util (%),Worker GPU Pwr (W),Worker GPU Temp (C),Worker CPU Temp (C),Worker VRAM (MB),Worker RAM (MB),Net Throughput (MB/s),Gen Tokens,Reasoning Tokens,Wall Time (s),Load Time\n";
                    fs.writeFileSync(csvFile, headers);
                }

                // Append Data
                const timestamp = new Date().toISOString();
                const row = `${timestamp},${data.category || 'Bench'},${data.metric || 'N/A'},${data.model},${data.quant || 'N/A'},${data.ctx},${data.ngl},${data.rpc},${data.transport},${data.promptTps},${data.genTps},${data.promptLatency},${data.gpuUtil},${data.gpuPwr},${data.masterGpuTemp || 'N/A'},${data.cpuUtil},${data.masterCpuTemp || 'N/A'},${data.gpuMem},${data.ramUsage},${data.workerGpuUtil || 'N/A'},${data.workerGpuPwr || 'N/A'},${data.workerGpuTemp || 'N/A'},${data.workerCpuTemp || 'N/A'},${data.workerVram || 'N/A'},${data.workerRam || 'N/A'},${data.netThroughput},${data.genTokens},${data.reasonTokens || 0},${data.wallTime},${data.loadTime || 'N/A'}\n`;
                fs.appendFileSync(csvFile, row);

                res.writeHead(200); res.end(JSON.stringify({ success: true }));
            } catch (e) { console.error("CSV Write Error:", e); res.writeHead(500); res.end(); }
        });
    }
    else if (req.url === '/api/logs/csv' && req.method === 'GET') {
        const csvFile = path.join(ROOT_DIR, 'logs', 'benchmarks.csv');
        if (fs.existsSync(csvFile)) {
            res.writeHead(200, { 'Content-Type': 'text/csv' });
            res.end(fs.readFileSync(csvFile));
        } else {
            res.writeHead(404); res.end();
        }
    }
    else if (req.url === '/api/start' && req.method === 'POST') {
        let body = ''; req.on('data', chunk => body += chunk);
        req.on('end', () => {
            if (llamaProcess) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Running' })); }
            const config = JSON.parse(body);
            currentModel = config.model; isRpc = !!config.rpcTarget; serverState = 'starting';

            loadStartTime = Date.now();
            finalLoadTime = 0;

            broadcastState();
            try { execSync('docker compose -f docker-compose.master.yml down --remove-orphans', { cwd: ROOT_DIR, stdio: 'ignore' }); } catch (e) { }

            // let args = ['compose', '-f', 'docker-compose.master.yml', 'run', '--rm', '--service-ports', 'master-node', '/app/llama-server', '-m', toContainerPath(config.modelPath), '-c', config.ctx.toString(), '-ngl', config.ngl.toString(), '--host', '0.0.0.0', '--port', '8080'];
            let args = ['compose', '-f', 'docker-compose.master.yml', 'run', '--rm', '--service-ports', 'master-node',
                '/app/llama-server', '-m', toContainerPath(config.modelPath),
                '-c', config.ctx.toString(), '-ngl', config.ngl.toString(),
                '--host', '0.0.0.0', '--port', '8080', '--metrics'];

            if (config.fa) args.push('-fa', 'on');
            if (config.cacheK) args.push('--cache-type-k', config.cacheK);
            if (config.cacheV) args.push('--cache-type-v', config.cacheV);
            if (config.specType) {
                args.push('--spec-type', config.specType);          // e.g. 'draft-mtp'
                args.push('--spec-draft-n-max', (config.specDraftNMax || 2).toString());
                args.push('-np', '1'); // MTP requires np=1
            }
            if (config.specDraftNgl) {
                args.push(
                    '--spec-draft-ngl',
                    config.specDraftNgl.toString()
                );
            }
            if (config.preserveThinking) {
                args.push(
                    '--chat-template-kwargs',
                    JSON.stringify({
                        preserve_thinking: true
                    })
                );
            }
            if (isRpc) {
                args.push('--rpc', `${config.rpcTarget.split('@').pop()}:50052`);
                args.push('--split-mode', 'layer');
                if (config.tensorSplit && config.tensorSplit < 100) {
                    args.push('-ts', `${config.tensorSplit},${100 - config.tensorSplit}`);
                }
            }

            llamaProcess = spawn('docker', args, { cwd: ROOT_DIR });

            const handleLogs = (d) => {
                const text = d.toString(); process.stdout.write(text);
                if (text.includes('load_model: loading model')) {
                    serverState = 'loading';
                    broadcastState();
                }
                else if (text.includes('llama_server: listening on')) {
                    serverState = 'ready';
                    // --- ADD THIS BLOCK ---
                    if (loadStartTime > 0) {
                        finalLoadTime = ((Date.now() - loadStartTime) / 1000).toFixed(1);
                        loadStartTime = 0;
                    }
                    // ----------------------
                    broadcastState();
                }
                else if (text.includes('prompt processing, n_tokens =')) {
                    const match = text.match(/progress = (0\.\d+|1\.00)/);
                    if (match) {
                        const progress = parseFloat(match[1]);
                        broadcastState(`PREFILL_PROGRESS:${progress}`);
                    }
                }
                else if (text.includes('abort') || text.toLowerCase().includes('error:') || text.includes('failed to fit params to free device memory')) {
                    serverState = 'stopped';
                    if (llamaProcess) {
                        llamaProcess.kill();
                        llamaProcess = null;
                        try { execSync('docker compose -f docker-compose.master.yml down --remove-orphans', { cwd: ROOT_DIR, stdio: 'ignore' }); } catch (e) { }
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
                llamaProcess = null; serverState = 'stopped'; currentModel = ''; isRpc = false; broadcastState();
            });
            res.writeHead(200); res.end(JSON.stringify({ status: 'launching' }));
        });
    }
    else if (req.url === '/api/stop' && req.method === 'POST') {
        serverState = 'stopping'; broadcastState();
        try { execSync('docker compose -f docker-compose.master.yml down --remove-orphans', { cwd: ROOT_DIR, stdio: 'ignore' }); } catch (e) { }
        if (llamaProcess) { llamaProcess.kill(); llamaProcess = null; }
        serverState = 'stopped'; currentModel = ''; isRpc = false; broadcastState();
        res.writeHead(200); res.end(JSON.stringify({ status: 'stopped' }));
    }
    else if (req.url === '/api/worker/start' && req.method === 'POST') {
        let body = ''; req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { worker_ssh } = JSON.parse(body);
                if (!worker_ssh) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Missing worker_ssh' })); }
                exec(`ssh -o BatchMode=yes -o ConnectTimeout=5 ${worker_ssh} "cd ~/AI/experiment-1 && docker compose -f docker-compose.worker.yml up -d"`, (err, stdout, stderr) => {
                    if (err) {
                        res.writeHead(500);
                        return res.end(JSON.stringify({ success: false, error: err.message, stderr }));
                    }
                    res.writeHead(200);
                    res.end(JSON.stringify({ success: true, stdout, stderr }));
                });
            } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' })); }
        });
    }
    else if (req.url === '/api/worker/stop' && req.method === 'POST') {
        let body = ''; req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { worker_ssh } = JSON.parse(body);
                if (!worker_ssh) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Missing worker_ssh' })); }
                exec(`ssh -o BatchMode=yes -o ConnectTimeout=5 ${worker_ssh} "cd ~/AI/experiment-1 && docker compose -f docker-compose.worker.yml down"`, (err, stdout, stderr) => {
                    if (err) {
                        res.writeHead(500);
                        return res.end(JSON.stringify({ success: false, error: err.message, stderr }));
                    }
                    res.writeHead(200);
                    res.end(JSON.stringify({ success: true, stdout, stderr }));
                });
            } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' })); }
        });
    }
    else if (req.url === '/api/worker/status' && req.method === 'POST') {
        let body = ''; req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { worker_ssh } = JSON.parse(body);
                if (!worker_ssh) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Missing worker_ssh' })); }
                exec(`ssh -o BatchMode=yes -o ConnectTimeout=5 ${worker_ssh} "cd ~/AI/experiment-1 && docker compose -f docker-compose.worker.yml ps --filter status=running -q"`, (err, stdout, stderr) => {
                    if (err) {
                        res.writeHead(200);
                        return res.end(JSON.stringify({ status: 'offline', error: err.message }));
                    }
                    const running = stdout.trim().length > 0;
                    res.writeHead(200);
                    res.end(JSON.stringify({ status: running ? 'running' : 'stopped' }));
                });
            } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' })); }
        });
    }
    else if (req.url === '/api/worker/logs' && req.method === 'POST') {
        let body = ''; req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { worker_ssh } = JSON.parse(body);
                if (!worker_ssh) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Missing worker_ssh' })); }
                exec(`ssh -o BatchMode=yes -o ConnectTimeout=5 ${worker_ssh} "cd ~/AI/experiment-1 && docker compose -f docker-compose.worker.yml logs --tail=50"`, (err, stdout, stderr) => {
                    if (err) {
                        res.writeHead(200);
                        return res.end(JSON.stringify({ logs: `Failed to fetch logs: ${err.message}\n${stderr}` }));
                    }
                    res.writeHead(200);
                    res.end(JSON.stringify({ logs: stdout || stderr || 'No logs available.' }));
                });
            } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' })); }
        });
    }
    else if (req.url === '/api/master/logs' && req.method === 'GET') {
        exec(`docker compose -f docker-compose.master.yml logs --tail=50 master-node 2>&1`, (err, stdout, stderr) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ logs: stdout || stderr || 'No logs available.' }));
        });
    } else { res.writeHead(404); res.end('Not found'); }
});

server.listen(PORT, () => console.log(`\n🚀 Mission Control running at: http://localhost:${PORT}`));
process.on('SIGINT', () => {
    if (llamaProcess) { try { execSync('docker compose -f docker-compose.master.yml down', { cwd: ROOT_DIR, stdio: 'ignore' }); } catch (e) { } }
    pythonProcess.kill(); process.exit();
});