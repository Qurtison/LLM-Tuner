const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { spawn, exec, execFile } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

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
let currentLaunchCommand = '';
// Full structured config passed to the most recent /api/start (Item 22: lets a
// freshly-connected/refreshed client repopulate the launch-config UI from the
// server's authoritative state instead of staying blank). Cleared once the
// server actually stops so a dead run's config isn't offered as "current".
let currentLaunchConfig = null;

// --- LOCAL (NON-DOCKER) LAUNCH CONFIG ---
// dashboard.config.json is user-editable and gitignored (see dashboard.config.example.json);
// missing/invalid file silently falls back to this default.
const DEFAULT_LLAMA_SERVER_BINARY = '/home/kyle/AI/llama-official/llama.cpp/build/bin/llama-server';
const DASHBOARD_CONFIG_FILE = path.join(__dirname, 'dashboard.config.json');
let dashboardConfig = { llamaServerBinary: DEFAULT_LLAMA_SERVER_BINARY };

async function loadDashboardConfig() {
    try {
        const parsed = JSON.parse(await fs.readFile(DASHBOARD_CONFIG_FILE, 'utf-8'));
        if (parsed.llamaServerBinary) dashboardConfig.llamaServerBinary = parsed.llamaServerBinary;
    } catch {
        // missing/invalid config file -- keep the default
    }
}

function getLlamaServerBinary() {
    return dashboardConfig.llamaServerBinary;
}

function isLocalMode() {
    return !!(currentLaunchConfig && currentLaunchConfig.launchMode === 'local-multi-gpu');
}
// In-memory ring buffer for master logs (last 500 lines) — sidesteps the
// docker compose run --rm one-off container issue (see dashboard-bugs1-analysis.md item 5)
let masterLogBuffer = [];
const MASTER_LOG_BUFFER_SIZE = 500;

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
    const payload = JSON.stringify({ state: serverState, model: currentModel, isRpc, log: logLine, error: errorMessage, loadStartTime, finalLoadTime, launchCommand: currentLaunchCommand, launchConfig: currentLaunchConfig });
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

// --- SHARED ARG BUILDER ---
// Flags common to both launch modes (Docker+RPC and local-multi-gpu). `mapModelPath`
// remaps host paths to container paths in Docker mode, or is the identity function
// for a directly-spawned local process. `deviceArgs` is the mode-specific device/split
// selection (--rpc+--split-mode for Docker RPC, or -dev+--split-mode for local Vulkan),
// injected at the same position the old RPC-only block used to occupy.
function buildLlamaArgs(config, { mapModelPath, deviceArgs }) {
    const args = ['-m', mapModelPath(config.modelPath),
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
        args.push('--reasoning-preserve');
    }
    args.push(...deviceArgs);
    if (config.reasoningPreserve) {
        args.push('--reasoning-preserve');
    }
    // Item 6: pass-through raw arg string (takes priority when provided)
    if (config.argString && config.argString.trim().length > 0) {
        const rawTokens = config.argString.trim().split(/\s+/);
        for (let i = 0; i < rawTokens.length; i++) {
            const t = rawTokens[i];
            if (t === '-m' && i + 1 < rawTokens.length) {
                args.push('-m', mapModelPath(rawTokens[++i]));
            } else {
                args.push(t);
            }
        }
    }
    return args;
}

// --- SHARED PROCESS SPAWN + LIFECYCLE ---
// Generic over "a spawned child process that speaks llama-server's stdout log format" --
// used for both the `docker` invocation (Docker+RPC mode) and a directly-spawned
// llama-server binary (local-multi-gpu mode). `onErrorCleanup`, if given, is called
// (in addition to `proc.kill()`) when handleLogs detects an abort/OOM/error line --
// Docker mode uses it to tear down the compose container; local mode has nothing
// extra to clean up, so it's omitted there.
function spawnLlamaProcess(command, args, { cwd, onErrorCleanup } = {}) {
    const proc = spawn(command, args, { cwd: cwd || ROOT_DIR, stdio: ['ignore', 'pipe', 'pipe'] });

    // Line-buffering to prevent regex misses when stdout chunks split a single
    // log line across multiple 'data' events (item 7)
    let logLineBuffer = '';

    const handleLogs = (d) => {
        const text = d.toString();
        process.stdout.write(text);

        // Append to in-memory ring buffer for /api/master/logs (item 5)
        const rawLines = text.split('\n');
        for (const l of rawLines) {
            if (l.length > 0) {
                masterLogBuffer.push(l);
                if (masterLogBuffer.length > MASTER_LOG_BUFFER_SIZE) {
                    masterLogBuffer.shift();
                }
            }
        }

        // Buffer partial lines to handle chunk boundaries (item 7)
        logLineBuffer += text;
        const bufferedLines = logLineBuffer.split('\n');
        logLineBuffer = bufferedLines.pop() || '';

        for (const line of bufferedLines) {
            if (line.includes('load_model: loading model')) {
                serverState = 'loading';
                broadcastState();
            }
            else if (line.includes('llama_server: model loaded')) {
                console.log("MODEL LOADED! READY!");
                serverState = 'ready';
                if (loadStartTime > 0) {
                    finalLoadTime = ((Date.now() - loadStartTime) / 1000).toFixed(1);
                    loadStartTime = 0;
                }
                broadcastState();
            }
            else if (line.includes('prompt processing, n_tokens =')) {
                const nTokensMatch = line.match(/n_tokens =\s*(\d+)/);
                const progressMatch = line.match(/progress = (0\.\d+|1\.00)/);
                const tpsMatch = line.match(/(\d+\.?\d*)\s*tokens per second/);
                if (progressMatch) {
                    const nTokens = nTokensMatch ? nTokensMatch[1] : '0';
                    const tps = tpsMatch ? tpsMatch[1] : '0';
                    broadcastState(`PREFILL_PROGRESS:${progressMatch[1]}:${tps}:${nTokens}`);
                }
            }
            else if (line.includes('print_timing:')) {
                const nDecodedMatch = line.match(/n_decoded\s*=\s*(\d+)/);
                const tpsMatch = line.match(/tg\s*=\s*(\d+\.?\d*)\s*t\/s/);
                if (nDecodedMatch && tpsMatch) {
                    broadcastState(`GEN_PROGRESS:${tpsMatch[1]}:${nDecodedMatch[1]}:${nDecodedMatch[1]}`);
                }
            }
            else if (line.includes('abort') || line.toLowerCase().includes('error:') || line.includes('failed to fit params to free device memory')) {
                serverState = 'stopped';
                proc.kill();
                if (onErrorCleanup) onErrorCleanup().catch(() => { });
                const errMsg = line.includes('failed to fit params')
                    ? 'Failed to allocate VRAM: Reduce n_gpu_layers or use a smaller model.'
                    : 'Process error: ' + line.trim().slice(-200);
                broadcastState('', errMsg);
            }
        }
    };

    proc.stdout.on('data', handleLogs);
    proc.stderr.on('data', handleLogs);

    // Single source of truth for tearing down shared state: fires exactly once
    // per spawned process, after it has actually closed.
    proc.on('close', (code, signal) => {
        proc.stdout.removeAllListeners('data');
        proc.stderr.removeAllListeners('data');
        if (llamaProcess === proc) {
            llamaProcess = null;
            serverState = 'stopped';
            currentModel = '';
            isRpc = false;
            currentLaunchConfig = null;
            broadcastState();
        }
    });

    proc.on('error', (err) => {
        console.error('Llama process error:', err);
        if (llamaProcess === proc) {
            llamaProcess = null;
            serverState = 'stopped';
            currentLaunchConfig = null;
            broadcastState('', 'Failed to start process: ' + err.message);
        }
    });

    return proc;
}

// --- CSV LOG INIT ---
// Schema v2 (Item #24): Removed Category, Metric, Quant (never populated by client).
// Added run_id (auto-generated), model_name (short), prompt_tokens, arg_string.
// All string fields are quoted in output to handle commas in paths/args.
const CSV_HEADERS = "Timestamp,run_id,model_name,Model_Path,Ctx,NGL,RPC,Transport,arg_string,launch_command,Prompt Tok/s,Gen Tok/s,Prompt Latency (s),prompt_tokens,Master GPU Util (%),Master GPU Pwr (W),Master GPU Temp (C),Master CPU Util (%),Master CPU Temp (C),Master VRAM (MB),Master RAM (MB),Worker GPU Util (%),Worker GPU Pwr (W),Worker GPU Temp (C),Worker CPU Temp (C),Worker VRAM (MB),Worker RAM (MB),Net Throughput (MB/s),Gen Tokens,Reasoning Tokens,Wall Time (s),Load Time\n";
const LOGS_DIR = path.join(ROOT_DIR, 'logs');
const CSV_FILE = path.join(LOGS_DIR, 'benchmarks.csv');

// Generate a short run_id: timestamp + 4 random hex chars
function generateRunId() {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(16).slice(2, 6);
    return `${ts}_${rand}`;
}

// Safely quote a CSV field — wraps in double-quotes, escaping internal quotes
function csvQuote(val) {
    if (val === null || val === undefined) return '""';
    const s = String(val);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
}

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

        else if (req.url.match(/^\/(?:vendor\/)?[\w.-]+\.(js|css|map|ico|png|svg)$/)) {
            const filePath = path.join(__dirname, req.url);
            // Prevent path traversal — ensure resolved path stays in __dirname
            if (!filePath.startsWith(__dirname)) {
                res.writeHead(403);
                return res.end('Forbidden');
            }
            const types = {
                '.js': 'application/javascript',
                '.css': 'text/css',
                '.map': 'application/json',
                '.ico': 'image/x-icon',
                '.png': 'image/png',
                '.svg': 'image/svg+xml'
            };
            try {
                const content = await fs.readFile(filePath);
                res.writeHead(200, { 'Content-Type': types[path.extname(filePath)] || 'application/octet-stream' });
                return res.end(content);
            } catch (err) {
                res.writeHead(404);
                return res.end('Not found');
            }
        }

        // --- BENCHMARK LOG (Schema v2, Item #24) ---
        else if (req.url === '/api/log' && req.method === 'POST') {
            let body;
            try { body = JSON.parse(await parseBody(req)); } catch (e) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid JSON' })); }

            // Self-healing: ensure dir exists even if lost mid-run
            await fs.mkdir(LOGS_DIR, { recursive: true });

            const timestamp = new Date().toISOString();
            const runId = generateRunId();
            // Extract short model name from path
            const modelPath = body.model || '';
            const modelName = modelPath.split('/').pop();
            // Build the row using csvQuote to safely handle commas in paths/args
            const fields = [
                timestamp,
                runId,
                csvQuote(modelName),
                csvQuote(modelPath),
                body.ctx || '',
                body.ngl || '',
                body.rpc || '',
                csvQuote(body.transport || ''),
                csvQuote(body.argString || ''),
                csvQuote(body.launchCommand || ''),
                body.promptTps || '',
                body.genTps || '',
                body.promptLatency || '',
                body.promptTokens || '',
                body.gpuUtil || '',
                body.gpuPwr || '',
                body.masterGpuTemp || '',
                body.cpuUtil || '',
                body.masterCpuTemp || '',
                body.gpuMem || '',
                body.ramUsage || '',
                body.workerGpuUtil || '',
                body.workerGpuPwr || '',
                body.workerGpuTemp || '',
                body.workerCpuTemp || '',
                body.workerVram || '',
                body.workerRam || '',
                body.netThroughput || '',
                body.genTokens || '',
                body.reasonTokens || '',
                body.wallTime || '',
                body.loadTime || ''
            ];
            const row = fields.join(',') + '\n';

            await fs.appendFile(CSV_FILE, row);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true, run_id: runId }));
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

        // --- LOGS SUMMARY (Item 15b + Item #24 Schema v2) ---
        // Returns aggregate stats from the benchmarks CSV so the UI can
        // display "Best Gen Speed", "Avg Prefill", etc. without parsing
        // CSV on the client side.
        else if (req.url === '/api/logs/summary' && req.method === 'GET') {
            try {
                const csv = await fs.readFile(CSV_FILE, 'utf-8');
                const lines = csv.trim().split('\n').slice(1); // skip header
                if (lines.length <= 1) {
                    // empty or header-only
                    return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ count: 0 }));
                }
                // Minimal CSV parser that respects double-quoted fields with embedded commas
                function splitCsvLine(line) {
                    const cols = [];
                    let i = 0;
                    while (i < line.length) {
                        if (line[i] === '"') {
                            // Quoted field: find closing quote (escaped quotes are "")
                            let end = line.indexOf('"', i + 1);
                            let field = '';
                            while (end < line.length && line[end + 1] === '"') {
                                field += line.slice(i + 1, end).replace(/""/g, '"');
                                i = end + 2;
                                end = line.indexOf('"', i + 1);
                            }
                            field += line.slice(i + 1, end);
                            cols.push(field);
                            i = end + 2; // skip closing quote
                            if (line[i] === ',') i++; // skip comma
                        } else {
                            // Unquoted field
                            const comma = line.indexOf(',', i);
                            if (comma === -1) { cols.push(line.slice(i)); break; }
                            else { cols.push(line.slice(i, comma)); i = comma + 1; }
                        }
                    }
                    return cols;
                }
                // Schema v3 columns (0-indexed, 32 cols with launch_command):
                //  10=promptTps, 11=genTps, 12=promptLatency, 13=promptTokens,
                //  30=wallTime, 31=loadTime
                // Schema v2 (31 cols, no launch_command): 9=promptTps, 10=genTps, 11=promptLatency, 29=wallTime, 30=loadTime
                // Old schema (30 cols): 8=promptTps, 9=genTps, 10=promptLatency, 28=wallTime, 29=loadTime
                let n = 0, sumPromptTps = 0, sumGenTps = 0, sumPromptLat = 0, sumWallTime = 0, sumLoadTime = 0;
                let bestPromptTps = 0, bestGenTps = 0, bestPromptLat = Infinity, bestWallTime = Infinity, bestLoadTime = Infinity;
                for (const line of lines) {
                    if (!line.trim()) continue;
                    const cols = splitCsvLine(line);
                    // Need at least 25 cols to have the core metrics; auto-detect schema
                    if (cols.length < 25) continue;
                    let pTps, gTps, pLat, wTime, lTime;
                    if (cols.length >= 32) {
                        // v3: 32 cols with launch_command
                        pTps = parseFloat(cols[10]);
                        gTps = parseFloat(cols[11]);
                        pLat = parseFloat(cols[12]);
                        wTime = parseFloat(cols[30]);
                        lTime = parseFloat(cols[31]);
                    } else if (cols.length >= 31) {
                        // v2: 31 cols without launch_command
                        pTps = parseFloat(cols[9]);
                        gTps = parseFloat(cols[10]);
                        pLat = parseFloat(cols[11]);
                        wTime = parseFloat(cols[29]);
                        lTime = parseFloat(cols[30]);
                    } else {
                        // old: 30 cols
                        pTps = parseFloat(cols[8]);
                        gTps = parseFloat(cols[9]);
                        pLat = parseFloat(cols[10]);
                        wTime = parseFloat(cols[28]);
                        lTime = parseFloat(cols[29]);
                    }
                    if (Number.isFinite(pTps))  { sumPromptTps += pTps;  if (pTps > bestPromptTps)  bestPromptTps = pTps; }
                    if (Number.isFinite(gTps))  { sumGenTps += gTps;   if (gTps > bestGenTps)     bestGenTps = gTps; }
                    if (Number.isFinite(pLat))  { sumPromptLat += pLat; if (pLat < bestPromptLat)   bestPromptLat = pLat; }
                    if (Number.isFinite(wTime)) { sumWallTime += wTime; if (wTime < bestWallTime)   bestWallTime = wTime; }
                    if (Number.isFinite(lTime)) { sumLoadTime += lTime; if (lTime < bestLoadTime)   bestLoadTime = lTime; }
                    n++;
                }
                const avg = (v, c) => c > 0 ? (v / c) : 0;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({
                    count: n,
                    avgPromptTps: avg(sumPromptTps, n),
                    avgGenTps: avg(sumGenTps, n),
                    avgPromptLatency: avg(sumPromptLat, n),
                    avgWallTime: avg(sumWallTime, n),
                    avgLoadTime: avg(sumLoadTime, n),
                    bestPromptTps: bestPromptTps || 0,
                    bestGenTps: bestGenTps || 0,
                    bestPromptLatency: isFinite(bestPromptLat) ? bestPromptLat : 0,
                    bestWallTime: isFinite(bestWallTime) ? bestWallTime : 0,
                    bestLoadTime: isFinite(bestLoadTime) ? bestLoadTime : 0,
                }));
            } catch {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ count: 0 }));
            }
        }

        // --- LIST VULKAN/CUDA DEVICES (local-multi-gpu mode) ---
        else if (req.url === '/api/devices' && req.method === 'GET') {
            const binary = getLlamaServerBinary();
            try {
                // Hard timeout: device enumeration talks to the Vulkan/CUDA loader, which
                // can hang (e.g. a TB4 eGPU in a bad power/link state) -- never let this
                // block the HTTP response. Caller (script.js) falls back to manual entry.
                const { stdout } = await execFileAsync(binary, ['--list-devices'], { timeout: 8000, maxBuffer: 1024 * 1024 });
                const devices = [];
                const lineRe = /^(\S+):\s*(.+?)\s*\((\d+) MiB, (\d+) MiB free\)$/;
                for (const rawLine of stdout.split('\n')) {
                    const m = rawLine.trim().match(lineRe);
                    if (m) devices.push({ id: m[1], description: m[2], totalMib: parseInt(m[3], 10), freeMib: parseInt(m[4], 10) });
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ devices }));
            } catch (err) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                const reason = (err.killed || err.signal) ? 'timed out' : (err.message || 'failed');
                return res.end(JSON.stringify({ devices: [], error: reason }));
            }
        }

        // --- START SERVER ---
        else if (req.url === '/api/start' && req.method === 'POST') {
            let body;
            try { body = JSON.parse(await parseBody(req)); } catch (e) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid JSON' })); }

            if (llamaProcess) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Running' })); }

            const config = body;
            const launchMode = config.launchMode === 'local-multi-gpu' ? 'local-multi-gpu' : 'docker-rpc';
            currentModel = config.model;
            isRpc = launchMode === 'docker-rpc' && !!config.rpcTarget;
            currentLaunchConfig = config;
            serverState = 'starting';
            loadStartTime = Date.now();
            finalLoadTime = 0;
            // Clear log buffer for fresh run (see dashboard-bugs1-analysis.md item 5)
            masterLogBuffer = [];
            broadcastState();

            let command, baseArgs, mapModelPath, deviceArgs, onErrorCleanup;

            if (launchMode === 'local-multi-gpu') {
                // No Docker involved -- spawn the Vulkan-enabled llama-server binary
                // directly, matching the raw command this mode is built to replace.
                command = getLlamaServerBinary();
                baseArgs = [];
                mapModelPath = (p) => p; // raw host path, no container mount to remap into
                deviceArgs = [];
                if (config.deviceA && config.deviceB) {
                    deviceArgs.push('--split-mode', 'layer', '-dev', `${config.deviceA},${config.deviceB}`);
                    if (config.tensorSplit && config.tensorSplit < 100) {
                        deviceArgs.push('-ts', `${config.tensorSplit},${100 - config.tensorSplit}`);
                    }
                }
                onErrorCleanup = null; // proc.kill() is sufficient -- no container to tear down
            } else {
                await runDockerCompose('down --remove-orphans');
                command = 'docker';
                baseArgs = ['compose', '-f', 'docker-compose.master.yml', 'run', '--rm', '--service-ports', 'master-node', '/app/llama-server'];
                mapModelPath = toContainerPath;
                deviceArgs = [];
                if (isRpc) {
                    deviceArgs.push('--rpc', `${config.rpcTarget.split('@').pop()}:50052`, '--split-mode', 'layer');
                    if (config.tensorSplit && config.tensorSplit < 100) {
                        deviceArgs.push('-ts', `${config.tensorSplit},${100 - config.tensorSplit}`);
                    }
                }
                onErrorCleanup = () => runDockerCompose('down --remove-orphans');
            }

            const args = [...baseArgs, ...buildLlamaArgs(config, { mapModelPath, deviceArgs })];

            currentLaunchCommand = command + ' ' + args.map(a =>
                /\s/.test(a) ? JSON.stringify(a) : a
            ).join(' ');
            console.log('LAUNCHING:', currentLaunchCommand);
            broadcastState('', 'LAUNCH CMD: ' + currentLaunchCommand);   // shows in chat as an "error"-style banner

            llamaProcess = spawnLlamaProcess(command, args, { cwd: ROOT_DIR, onErrorCleanup });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ status: 'launching' }));
        }

        // --- STOP SERVER ---
        else if (req.url === '/api/stop' && req.method === 'POST') {
            serverState = 'stopping';
            broadcastState();
            // Docker teardown only applies to the Docker+RPC launch path -- a
            // local-multi-gpu run has no compose container to bring down.
            if (!isLocalMode()) {
                await runDockerCompose('down --remove-orphans');
            }
            // Request the kill but don't null `llamaProcess` here -- the process's own
            // 'close' handler (registered at spawn time) is now the single place that
            // clears shared state, once the process has actually exited. Nulling it here
            // first was the other half of the race that used to crash the whole process
            // (see dashboard-bugs1-analysis.md item 13).
            if (llamaProcess) {
                llamaProcess.kill();
            }
            serverState = 'stopped';
            currentModel = '';
            isRpc = false;
            currentLaunchConfig = null;
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
            // Serve from in-memory ring buffer instead of shelling out to docker compose logs,
            // which cannot see one-off run --rm containers (see dashboard-bugs1-analysis.md item 5)
            res.writeHead(200, { 'Content-Type': 'application/json' });
            const logs = masterLogBuffer.length > 0
                ? masterLogBuffer.join('\n')
                : 'No logs available. Start the server first.';
            return res.end(JSON.stringify({ logs }));
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
    await loadDashboardConfig();
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
            if (isLocalMode()) {
                // Directly-spawned process -- Docker teardown wouldn't touch it,
                // so it must be killed explicitly or it's orphaned on shutdown.
                try { llamaProcess.kill(); } catch { }
            } else {
                try { await execAsync('docker compose -f docker-compose.master.yml down', { cwd: ROOT_DIR }); } catch { }
            }
        }
        if (pythonProcess) pythonProcess.kill();
        process.exit(0);
    };

process.on('exit', () => { if (pythonProcess) pythonProcess.kill(); });
process.on('SIGINT', shutdownHandler);
process.on('SIGTERM', shutdownHandler);

// Safety net for uncaught exceptions (Item 13, Step 5) — prevents silent
// crashes from taking down SSE, the models API, and Docker orchestration.
process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err?.stack || err);
    // Broadcast error state to connected SSE clients before shutting down
    try {
        serverState = 'stopped';
        broadcastState('', 'Server crash: ' + (err?.message || String(err)));
    } catch { /* broadcast may fail if clients array is corrupted */ }
    // Attempt graceful shutdown
    shutdownHandler();
});

// Catch rejected promises that bubble up (async handlers without try/catch)
process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
});

    server.listen(PORT, () => console.log(`\n🚀 Mission Control running at: http://localhost:${PORT}`));
}

initServer().catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
});
