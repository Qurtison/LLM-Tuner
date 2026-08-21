const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const { spawn, exec, execFile } = require('child_process');
const { promisify } = require('util');
const { loadConfig, ConfigError, publicConfig } = require('./src/server/config.ts');

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const APP_ROOT = __dirname; // repo root (P3 moves the entry to src/server)
// Phase 2: every machine-specific value now comes from src/server/config.ts
// (defaults < config file < env). CFG is set in initServer() before anything
// reads it; the lets below are assigned there as well.
let CFG = null;
let LOGS_DIR = '';
let CSV_FILE = '';
let HF_CACHE_DIR = '';

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

// Live phase state of the in-flight request, parsed from llama-server's
// progress lines -- stamped onto each telemetry sample as it's taken so the
// per-request/monitor charts get REAL per-tick rates and prefill progress,
// not just a flat completion-time average painted across the whole phase.
let liveProgress = {};
// net-throughput delta state for server-recorded samples
let lastSampleNetBytes = null;
let lastSampleNetTime = null;

// --- BENCH STATE (llama-bench runner, Bench tab) ---
let benchQueue = [];        // server-side matrix queue (survives page closes)
let benchQueueTotal = 0;
let benchCurrentLabel = ''; // label of the run in flight (for reconnecting clients)
function launchBenchProcess(cfg) {
    const benchBin = getLlamaServerBinary(cfg.build).replace(/llama-server$/, 'llama-bench');
    const args = ['-m', cfg.modelPath];
    if (cfg.rawArgs) {
        // manual run line: everything after the resolved -m, verbatim
        // (tokenizeCommand so quoted spans stay single arguments)
        args.push(...tokenizeCommand(String(cfg.rawArgs).trim()));
        return spawnBench(benchBin, args);
    }
    if (cfg.fa != null) args.push('-fa', cfg.fa ? '1' : '0');
    if (cfg.cacheK) args.push('-ctk', cfg.cacheK);
    if (cfg.cacheV) args.push('-ctv', cfg.cacheV);
    if (cfg.nPrompt != null && cfg.nPrompt !== '') args.push('-p', String(cfg.nPrompt));
    if (cfg.nGen != null && cfg.nGen !== '') args.push('-n', String(cfg.nGen));
    if (cfg.depths) args.push('-d', String(cfg.depths));
    if (cfg.reps != null && cfg.reps !== '') args.push('-r', String(cfg.reps));
    if (cfg.devices) args.push('-dev', String(cfg.devices));
    if (cfg.splitMode) args.push('-sm', String(cfg.splitMode));
    if (cfg.tensorSplit) args.push('-ts', String(cfg.tensorSplit));
    if (cfg.extraArgs) args.push(...tokenizeCommand(String(cfg.extraArgs).trim()));
    return spawnBench(benchBin, args);
}
function spawnBench(benchBin, args) {
    benchRunning = true;
    benchLastCommand = `${benchBin} ${args.join(' ')}`;
    benchLog(`--- ${new Date().toLocaleString()} ---`);
    benchLog(`$ ${benchLastCommand}`);
    try {
        benchProcess = spawn(benchBin, args);
    } catch (err) {
        benchRunning = false;
        benchLog(`[bench] failed to spawn: ${err.message}`);
        return err.message;
    }
    let benchLineBuf = '';
    const onBenchData = (d) => {
        benchLineBuf += d.toString();
        const lines = benchLineBuf.split(/\r\n|\r|\n/);
        benchLineBuf = lines.pop();
        for (const line of lines) benchLog(line);
    };
    benchProcess.stdout.on('data', onBenchData);
    benchProcess.stderr.on('data', onBenchData);
    // One-shot: on a failed spawn BOTH 'error' and 'exit' fire, and running
    // this twice would overwrite benchLastSamples with an empty buffer and
    // advance the matrix queue by TWO runs.
    let runFinished = false;
    const finishRun = (logLine, doneTag) => {
        if (runFinished) return;
        runFinished = true;
        benchRunning = false;
        benchProcess = null;
        benchLastSamples = takeRequestSamples();
        benchLog(logLine);
        broadcastState(doneTag);
        maybeStartNextQueued();
    };
    benchProcess.on('error', (err) => finishRun(`[bench] error: ${err.message}`, 'BENCH_DONE:error'));
    benchProcess.on('exit', (code, signal) => {
        if (benchLineBuf) benchLog(benchLineBuf);
        finishRun(`[bench] exited with ${signal ? `signal ${signal}` : `code ${code}`}`, `BENCH_DONE:${code ?? 'signal'}`);
    });
    return null;
}
function maybeStartNextQueued() {
    try {
        if (benchQueue.length === 0) { benchQueueTotal = 0; return; }
        if (llamaProcess) {
            benchLog('[matrix] a model was launched mid-matrix -- aborting remaining runs');
            benchQueue = []; benchQueueTotal = 0;
            return;
        }
        const next = benchQueue.shift();
        const k = benchQueueTotal - benchQueue.length;
        benchCurrentLabel = next.label || next.devices || 'run';
        benchLog(`===== llama-bench ${k}/${benchQueueTotal}: ${benchCurrentLabel} =====`);
        const err = launchBenchProcess(next);
        if (err) maybeStartNextQueued();
    } catch (err) {
        // A malformed queued config (e.g. a build id that no longer exists in
        // dashboard.config.json) throws inside launchBenchProcess -- and this
        // fires from a process 'exit' handler, so an uncaught throw would take
        // the whole dashboard down mid-matrix.
        benchQueue = []; benchQueueTotal = 0;
        benchLog(`[matrix] aborted: ${err.message}`);
    }
}

let benchProcess = null;
// Cumulative across runs (capped) -- the client renders this verbatim, so
// switching tabs / refreshing restores the WHOLE session's results, not just
// the current run. Every line is also appended to logs/bench-history.log,
// which survives dashboard restarts (the last chunk is reloaded on boot).
let benchOutput = [];
const BENCH_OUTPUT_MAX_LINES = 4000;
let benchRunning = false;
let benchLastCommand = '';
// Telemetry during bench runs: same 1s sampler the request path uses, driven
// by an explicit timer (bench output goes quiet for minutes during deep
// prefills, so the activity-timeout sampler would stop mid-test). Snapshot on
// exit so the buffer can't bleed into the next real request's series.
let benchSampleTimer = null;
let benchLastSamples = [];
let benchLogWriteChain = Promise.resolve();
function benchLog(line) {
    benchOutput.push(line);
    if (benchOutput.length > BENCH_OUTPUT_MAX_LINES) benchOutput = benchOutput.slice(-3000);
    broadcastState(`BENCH:${line}`);
    // Serialized: parallel un-awaited appendFile calls can land OUT OF ORDER
    // in the file, which corrupted block parsing after a restart reload.
    benchLogWriteChain = benchLogWriteChain
        .then(() => fs.appendFile(path.join(LOGS_DIR, 'bench-history.log'), line + '\n'))
        .catch(() => {});
}

// --- LAUNCH BUILDS (Phase 2: from config) ---
// Builds used to fall back to one user's hardcoded absolute path. Now the
// config's llama.builds is the single source (defaults < config file < env,
// strict validation in src/server/config.ts; the legacy dashboard.config.json
// format is still mapped). An empty list disables launch/bench actions at the
// routes (resolveLaunchCommand throws) while models/history/telemetry keep
// working -- the GUI's Build selector stays usable for setup.
function getLlamaServerBuilds() {
    return CFG.llama.builds;
}

// getLlamaServerBinary moved verbatim to src/server/lib/launch.js (Phase 1 extraction).
// Unknown/stale build id falls back to builds[0]; empty builds list throws.
function getLlamaServerBinary(buildId) { return _ln.getLlamaServerBinary(getLlamaServerBuilds(), buildId); }

// In-memory ring buffer for master logs (last 500 lines) — sidesteps the
// docker compose run --rm one-off container issue (see dashboard-bugs1-analysis.md item 5)
let masterLogBuffer = [];
const MASTER_LOG_BUFFER_SIZE = 500;

// HF_CACHE_DIR (resolved in initServer from config; env HF_HOME /
// HUGGINGFACE_HUB_CACHE take precedence over the file value there).

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
            if (size > CFG.server.maxBodyBytes) {
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

function workerComposeCommand(command) {
    const dir = CFG.worker.workDirectory;
    return dir ? `cd ${dir} && ${command}` : command;
}

// --- PORT CLEANUP (legacy; opt-in via processes.cleanupManagedPortsOnStart) ---
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
// --- FLAG REFERENCE (searchable popover in the UI) ---
// Parses `llama-server --help`'s output into {flags, description, section,
// insertText, primaryFlag} entries. Description text is column-aligned at a
// fixed indent (verified against real output: 40 chars) rather than "first
// big gap after the flag names", which breaks on short/long alias pairs like
// "-c,    --ctx-size N" (the gap between "-c," and "--ctx-size" would
// otherwise look like the flags/description boundary). A flag-name group that
// overflows past that column with no room for a trailing padding gap (e.g.
// "--prefill-assistant, --no-prefill-assistant") has no description on its
// own line -- the actual description is the following indented line(s),
// handled by the continuation-line branch below.
// parseHelpFlags / HELP_DESC_COLUMN moved verbatim to src/server/lib/helpparse.js (Phase 1 extraction).
const cachedFlagReferenceByBuild = new Map();
var _hp = require('./src/server/lib/helpparse');
var parseHelpFlags = _hp.parseHelpFlags;

// toFiniteNumber / toNonEmptyString / buildLlamaArgs moved verbatim to src/server/lib/launch.js (Phase 1 extraction).
var _ln = require('./src/server/lib/launch');
var toFiniteNumber = _ln.toFiniteNumber;
var toNonEmptyString = _ln.toNonEmptyString;
var buildLlamaArgs = _ln.buildLlamaArgs;
var isValidBuild = _ln.isValidBuild;

// --- LAUNCH COMMAND RESOLUTION (structured config -> command + args) ---
// Shared by /api/preview-command (which only needs the resolved command/args
// to show the user, never spawns anything) and /api/start's fallback path
// (used when the raw-command box is empty). This is the "convenience
// generator" for the box's starting content -- once a user has edited the
// box, THIS function is no longer consulted for that launch; see the
// rawCommand branch in /api/start.
//
// The master always launches natively (no Docker) -- a local device split
// (GPU A + GPU B) and an RPC worker are both optional add-ons on top of that,
// not separate launch mechanisms. They're mutually exclusive in practice:
// enabling RPC in the GUI forces GPU B back to "None" (script.js
// applyRpcToggleUI), so at most one of localSplit/config.rpcTarget is ever
// true below -- this only supports a 2-way split (this machine vs. one other
// target), not a 3-way local-A + local-B + worker split.
// resolveLaunchCommand moved verbatim to src/server/lib/launch.js (Phase 1 extraction).
function resolveLaunchCommand(config) { return _ln.resolveLaunchCommand(config, getLlamaServerBuilds(), { rpcPort: CFG.llama.rpcPort, defaultPort: CFG.llama.defaultPort }); }

// hostFromRpcTarget moved to src/server/lib/launch.js (Phase 1 extraction).

// Shell-safe quoting for the displayed/copied launch command. JSON.stringify
// is not shell-safe: inside its double quotes, $, backtick, and ! can still
// expand in an interactive shell. Single quotes are inert (except for the
// '\'' escape), so anything not plain-safe gets wrapped in those.
function shellQuoteArg(arg) {
    const s = String(arg);
    if (s.length === 0) return "''";
    // No quoting needed for simple values -- keeps the command readable.
    if (/^[A-Za-z0-9._\/:-]+$/.test(s)) return s;
    return "'" + s.replace(/'/g, "'\\''") + "'";
}

// The displayed/broadcast command stays copy-pasteable and unambiguous about
// argument boundaries (see shellQuoteArg).
function formatCommand(command, args) {
    return [shellQuoteArg(command), ...args.map(shellQuoteArg)].join(' ');
}

// tokenizeCommand / extractLastFlagValue moved verbatim to src/server/lib/tokenize.js (Phase 1 extraction). (extractLastFlagValue original inlined below deleted after move.)
var _tk = require('./src/server/lib/tokenize');
var tokenizeCommand = _tk.tokenizeCommand;
var extractLastFlagValue = _tk.extractLastFlagValue;

// FATAL_LINE_RE / isFatalLogLine moved to src/server/lib/fatallogs.js (Phase 1 extraction).
var _fl = require('./src/server/lib/fatallogs');
var FATAL_LINE_RE = _fl.FATAL_LINE_RE;
var isFatalLogLine = _fl.isFatalLogLine;
// The master is always a directly-spawned llama-server binary now (no Docker
// invocation). `onErrorCleanup`, if given, is called (in addition to
// `proc.kill()`) when handleLogs detects an abort/OOM/error line -- currently
// always omitted, since a direct spawn has nothing extra to tear down; kept
// as a hook for whatever future launch path might need one.
function spawnLlamaProcess(command, args, { cwd, onErrorCleanup } = {}) {
    const proc = spawn(command, args, { cwd: cwd || APP_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });

    // Line-buffering to prevent regex misses when stdout chunks split a single
    // log line across multiple 'data' events (item 7)
    let logLineBuffer = '';

    const handleLogs = (d) => {
        const text = d.toString();
        process.stdout.write(text);

        // Buffer partial lines to handle chunk boundaries (item 7). \r counts
        // as a line terminator -- otherwise a \r-only output phase grows this
        // buffer (and re-splits all of it per chunk) for as long as the phase
        // lasts. The cap is a last-resort bound for a process that emits
        // unbounded output with no line breaks at all.
        logLineBuffer += text;
        const bufferedLines = logLineBuffer.split(/\r\n|\r|\n/);
        logLineBuffer = bufferedLines.pop() || '';
        if (logLineBuffer.length > 1_000_000) logLineBuffer = logLineBuffer.slice(-4096);

        for (const line of bufferedLines) {
            // Ring buffer for /api/master/logs (item 5) gets the SAME
            // reconstructed whole lines as the parser below -- pushing raw
            // chunk fragments used to split one physical line across two
            // entries whenever a chunk boundary landed mid-line.
            if (line.length > 0) {
                masterLogBuffer.push(line);
                if (masterLogBuffer.length > MASTER_LOG_BUFFER_SIZE) {
                    masterLogBuffer.shift();
                }
            }
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
            else if (line.includes('launch_slot_:') && line.includes('processing task')) {
                // Unconditional per-request start signal -- unlike the progress
                // lines below (llama.cpp only prints those once n_decoded >= 100
                // or t_prompt_processing >= 3000ms internally), this always fires,
                // so it's the only reliable way to start Monitor Mode's telemetry
                // sampling for short/fast requests that never cross those thresholds.
                liveProgress = {}; // new request -- drop the previous one's phase state
                markRequestActivity();
            }
            else if (line.includes('prompt processing, n_tokens =')) {
                const nTokensMatch = line.match(/n_tokens =\s*(\d+)/);
                const progressMatch = line.match(/progress = (0\.\d+|1\.00)/);
                const tpsMatch = line.match(/(\d+\.?\d*)\s*tokens per second/);
                if (progressMatch) {
                    const nTokens = nTokensMatch ? nTokensMatch[1] : '0';
                    const tps = tpsMatch ? tpsMatch[1] : '0';
                    liveProgress = {
                        prefillTps: parseFloat(tps) || null,
                        prefillProgress: parseFloat(progressMatch[1]),
                        prefillTokens: parseInt(nTokens, 10) || null,
                    };
                    broadcastState(`PREFILL_PROGRESS:${progressMatch[1]}:${tps}:${nTokens}`);
                    markRequestActivity();
                }
            }
            else if (line.includes('print_timing:')) {
                // Live per-slot gen progress (print_timings_tg() in
                // tools/server/server-context.cpp -- at most one line per 3s,
                // and only once n_gen >= 100). The SLT_INF macro truncates
                // __func__ to 12 chars, so this line, the prefill-progress
                // line, and the final summary ALL share the "slot print_timing:
                // id N | task N | " prefix. The live line's actual format:
                //   n_gen =  100, tg = 27.00 t/s, tg_3s = 26.50 t/s
                //
                // It used to match "n_decoded =" -- a field that only exists in
                // the /slots HTTP JSON, never in stdout -- so this half of the
                // branch never fired. Consequences: no GEN_PROGRESS broadcasts
                // (sidebar's Gen card pegged on the last request's final value
                // for as long as no NEW dashboard request reset it), no genTps
                // in recorded samples (no gen line in the Monitor/History omni
                // graphs), and -- most damaging -- no markRequestActivity()
                // during generation, so the 3s activity-timeout sampler stopped
                // recording ~3s after prefill ended. That's why omni graphs
                // spanned only the prefill plus a tail (25s) while the CSV row
                // honestly said the request took 100+s.
                const nGenMatch = line.match(/n_gen\s*=\s*(\d+)/) || line.match(/n_decoded\s*=\s*(\d+)/);
                const tg3sMatch = line.match(/tg_3s\s*=\s*(\d+\.?\d*)\s*t\/s/);
                const tgMatch = line.match(/tg\s*=\s*(\d+\.?\d*)\s*t\/s/);
                if (nGenMatch && (tg3sMatch || tgMatch)) {
                    // tg_3s is the last-3-second window -- the actual current
                    // speed. tg is the average since generation started, which
                    // barely moves and reads as "pegged" on a live graph.
                    const liveTpsMatch = tg3sMatch || tgMatch;
                    // Generation phase -- clear any prefill-phase state so
                    // telemetry samples taken from here on carry the gen rate,
                    // not a stale prefill stamp.
                    liveProgress = { genTps: parseFloat(liveTpsMatch[1]) || null, genTokens: parseInt(nGenMatch[1], 10) || null };
                    broadcastState(`GEN_PROGRESS:${liveTpsMatch[1]}:${nGenMatch[1]}:${nGenMatch[1]}`);
                    markRequestActivity();
                }

                // Per-request completion summary (Monitor Mode / Item 12): three
                // lines per request, tagged by task id, arriving in this order --
                // "prompt eval time", "eval time", "total time" (the last of which
                // triggers the actual log+broadcast). The segment after the LAST
                // '|' distinguishes them; "prompt eval time" would otherwise also
                // match a plain /eval time/ substring check.
                const idTaskMatch = line.match(/id\s+(\d+)\s*\|\s*task\s+(\d+)/);
                if (idTaskMatch) {
                    const taskId = idTaskMatch[2];
                    const segments = line.split('|');
                    const lastSegment = segments[segments.length - 1].trim();
                    if (lastSegment.startsWith('prompt eval time')) {
                        const m = lastSegment.match(/=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s*tokens[^)]*?([\d.]+)\s*tokens per second/);
                        if (m) {
                            const existing = taskTimingsByTaskId.get(taskId) || {};
                            taskTimingsByTaskId.set(taskId, { ...existing, promptMs: parseFloat(m[1]), promptTokens: parseInt(m[2], 10), promptTps: parseFloat(m[3]) });
                        }
                    } else if (lastSegment.startsWith('eval time')) {
                        const m = lastSegment.match(/=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s*tokens[^)]*?([\d.]+)\s*tokens per second/);
                        if (m) {
                            const existing = taskTimingsByTaskId.get(taskId) || {};
                            taskTimingsByTaskId.set(taskId, { ...existing, genMs: parseFloat(m[1]), genTokens: parseInt(m[2], 10), genTps: parseFloat(m[3]) });
                        }
                    } else if (lastSegment.startsWith('total time')) {
                        const m = lastSegment.match(/=\s*([\d.]+)\s*ms/);
                        const timing = taskTimingsByTaskId.get(taskId) || {};
                        taskTimingsByTaskId.delete(taskId);
                        if (m) {
                            // Capture samples, the completion timestamp, AND
                            // the launch config/command NOW -- the sample
                            // buffer is shared, so waiting out the flush delay
                            // would let the next request's samples bleed into
                            // this one's series, and the prefill/gen split in
                            // logCompletedRequest counts genMs back from this
                            // moment, not from whenever we flush. The config is
                            // captured here too because a server stop within
                            // the flush window nulls currentLaunchConfig, which
                            // would leave the CSV row without a model/config.
                            const pending = {
                                timing: { ...timing, wallTimeS: (parseFloat(m[1]) / 1000).toFixed(2) },
                                samples: takeRequestSamples(),
                                completedAt: Date.now(),
                                config: currentLaunchConfig,
                                launchCommand: currentLaunchCommand,
                                timer: null,
                            };
                            pending.timer = setTimeout(() => {
                                pendingCompletionsByTaskId.delete(taskId);
                                logCompletedRequest(pending.timing, pending.samples, pending.completedAt, {
                                    config: pending.config,
                                    launchCommand: pending.launchCommand,
                                }).catch(() => { });
                            }, COMPLETION_FLUSH_DELAY_MS);
                            pendingCompletionsByTaskId.set(taskId, pending);
                            rememberCompletedTaskId(taskId);
                        }
                    } else if (lastSegment.startsWith('draft acceptance')) {
                        // `draft acceptance = 0.76471 (   13 accepted /    17 generated), mean len =  1.76`
                        // -- only printed when the request actually drafted tokens.
                        const dm = lastSegment.match(/=\s*([\d.]+)\s*\(\s*(\d+)\s*accepted\s*\/\s*(\d+)\s*generated\s*\)(?:\s*,\s*mean len\s*=\s*([\d.]+))?/);
                        const pending = pendingCompletionsByTaskId.get(taskId);
                        if (dm && pending) {
                            clearTimeout(pending.timer);
                            pendingCompletionsByTaskId.delete(taskId);
                            Object.assign(pending.timing, {
                                draftAcceptRate: parseFloat(dm[1]),
                                draftAccepted: parseInt(dm[2], 10),
                                draftGenerated: parseInt(dm[3], 10),
                                draftMeanLen: dm[4] != null ? parseFloat(dm[4]) : null,
                            });
                            logCompletedRequest(pending.timing, pending.samples, pending.completedAt, {
                                config: pending.config,
                                launchCommand: pending.launchCommand,
                            }).catch(() => { });
                        }
                    }
                }
            }
            else if (line.includes('stop processing: n_tokens =')) {
                // Slot release line -- fires on BOTH natural completion and
                // client-side cancel (opencode/agents abort streams constantly;
                // llama.cpp prints NO timing lines for those, so canceled
                // requests -- often the longest thinking runs -- silently
                // produced no row at all). After a grace delay, if no natural
                // completion was seen for this task, synthesize a row from the
                // live progress state.
                const relTaskMatch = line.match(/task\s+(\d+)/);
                if (relTaskMatch) {
                    const taskId = relTaskMatch[1];
                    const live = { ...liveProgress };
                    // Same config-capture rationale as the "total time" branch:
                    // the 400ms delay below can outlive a server stop.
                    const launchConfig = currentLaunchConfig;
                    const launchCommand = currentLaunchCommand;
                    setTimeout(() => {
                        if (pendingCompletionsByTaskId.has(taskId) || recentlyCompletedTaskIds.has(taskId)) return;
                        if (!live.genTokens && !live.prefillTokens) return; // nothing observed -- not worth a row
                        rememberCompletedTaskId(taskId); // guard against double-fire
                        const timing = {
                            promptTokens: live.prefillTokens ?? null,
                            promptTps: live.prefillTps ?? null,
                            genTokens: live.genTokens ?? null,
                            genTps: live.genTps ?? null,
                            aborted: true,
                        };
                        logCompletedRequest(timing, takeRequestSamples(), Date.now(), {
                            config: launchConfig,
                            launchCommand,
                        }).catch(() => { });
                    }, 400);
                }
            }
            else if (FATAL_LINE_RE.test(line)) {
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
        // Flush any final partial line (output without a trailing newline)
        // into the ring buffer before tearing down the listeners.
        if (logLineBuffer.length > 0) {
            masterLogBuffer.push(logLineBuffer);
            if (masterLogBuffer.length > MASTER_LOG_BUFFER_SIZE) {
                masterLogBuffer.shift();
            }
            logLineBuffer = '';
        }
        // FATAL_LINE_RE (correctly) no longer matches every 'error:' line, so
        // failures where llama-server exits ON ITS OWN before becoming ready
        // (failed to load model/draft, context creation, Vulkan OOM) would
        // otherwise die silently -- surface their last error lines.
        if (llamaProcess === proc && serverState !== 'ready' && serverState !== 'stopped') {
            const errLines = masterLogBuffer.filter(l => /\sE\s|error|failed/i.test(l)).slice(-2);
            if (errLines.length > 0) {
                broadcastState('', 'Launch failed: ' + errLines.join(' | ').slice(0, 300));
            }
        }
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
// Schema v4: added config_json (col 32) -- the full structured launch config
// (buildConfigFromUI() shape + rawCommand) that actually booted the server for
// this row, as JSON. Lets a later model-select/launch-mode change look up
// "what did I run last time for this exact combo" and restore it exactly,
// rather than reconstructing a guess from the scattered individual columns.
const CSV_HEADERS = "Timestamp,run_id,model_name,Model_Path,Ctx,NGL,RPC,Transport,arg_string,launch_command,Prompt Tok/s,Gen Tok/s,Prompt Latency (s),prompt_tokens,Master GPU Util (%),Master GPU Pwr (W),Master GPU Temp (C),Master CPU Util (%),Master CPU Temp (C),Master VRAM (MB),Master RAM (MB),Worker GPU Util (%),Worker GPU Pwr (W),Worker GPU Temp (C),Worker CPU Temp (C),Worker VRAM (MB),Worker RAM (MB),Net Throughput (MB/s),Gen Tokens,Reasoning Tokens,Wall Time (s),Load Time,config_json,Draft Accept Rate,Draft Accepted,Draft Generated,Draft Mean Len,Aborted\n";
// LOGS_DIR / CSV_FILE / HF_CACHE_DIR are assigned in initServer() from config.

// Generate a short run_id: timestamp + 4 random hex chars
function generateRunId() {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(16).slice(2, 6);
    return `${ts}_${rand}`;
}

// csvValue / parseNumOrNull / csvQuote / splitCsvLine moved verbatim to src/server/lib/csv.js (Phase 1 extraction).
var _cv = require('./src/server/lib/csv');
var csvValue = _cv.csvValue;
var parseNumOrNull = _cv.parseNumOrNull;
var csvQuote = _cv.csvQuote;
var splitCsvLine = _cv.splitCsvLine;

// Shared by the /api/log HTTP route and logCompletedRequest() (server-side,
// client-agnostic completion capture -- see that function). `data` uses the
// same key names the old frontend-only /api/log payload used, so both
// callers can share this without a translation layer.
async function appendBenchmarkRow(data) {
    await fs.mkdir(LOGS_DIR, { recursive: true }); // self-healing: ensure dir exists even if lost mid-run
    const timestamp = new Date().toISOString();
    const runId = generateRunId();
    const modelPath = data.model || '';
    const modelName = modelPath.split('/').pop();
    // csvValue (not `x || ''`) for every field -- `||` treats a genuine 0
    // (idle GPU util, 0% CPU, a card with no throttle, etc.) as falsy and
    // silently substitutes '', making a real "zero" reading indistinguishable
    // from "field never populated" in the CSV. It also strips newlines so a
    // row always occupies exactly one physical line (see csvValue's comment).
    const fields = [
        timestamp,
        runId,
        csvQuote(csvValue(modelName)),
        csvQuote(csvValue(modelPath)),
        csvValue(data.ctx),
        csvValue(data.ngl),
        csvValue(data.rpc),
        csvQuote(csvValue(data.transport)),
        csvQuote(csvValue(data.argString)),
        csvQuote(csvValue(data.launchCommand)),
        csvValue(data.promptTps),
        csvValue(data.genTps),
        csvValue(data.promptLatency),
        csvValue(data.promptTokens),
        csvValue(data.gpuUtil),
        csvValue(data.gpuPwr),
        csvValue(data.masterGpuTemp),
        csvValue(data.cpuUtil),
        csvValue(data.masterCpuTemp),
        csvValue(data.gpuMem),
        csvValue(data.ramUsage),
        csvValue(data.workerGpuUtil),
        csvValue(data.workerGpuPwr),
        csvValue(data.workerGpuTemp),
        csvValue(data.workerCpuTemp),
        csvValue(data.workerVram),
        csvValue(data.workerRam),
        csvValue(data.netThroughput),
        csvValue(data.genTokens),
        csvValue(data.reasonTokens),
        csvValue(data.wallTime),
        csvValue(data.loadTime),
        csvQuote(csvValue(data.configJson)),
        // Speculative-decoding stats (blank when the run had no draft line).
        // Strictly appended after config_json -- consumers index it as col 32.
        csvValue(data.draftAcceptRate),
        csvValue(data.draftAccepted),
        csvValue(data.draftGenerated),
        csvValue(data.draftMeanLen),
        data.aborted ? '1' : ''
    ];
    await fs.appendFile(CSV_FILE, fields.join(',') + '\n');
    return runId;
}

// --- CLIENT-AGNOSTIC REQUEST COMPLETION CAPTURE (Monitor Mode) ---
// llama-server logs a `slot print_timing:` block for EVERY completed request
// regardless of which client sent it (this dashboard's chat, opencode, Cline,
// curl, anything hitting the OpenAI-compatible endpoint directly) -- three
// lines per request: "prompt eval time", "eval time", "total time", each
// tagged with `id <slot> | task <id>`. Since the server runs multiple slots
// concurrently (n_slots = 4 by default), several requests' lines can
// interleave in the stdout stream, so *timing* accumulation is keyed by task
// id, not a single shared buffer.
const taskTimingsByTaskId = new Map();

// Completions whose "total time" line has arrived but whose CSV write /
// COMPLETION broadcast is briefly deferred: llama-server prints the
// per-request `draft acceptance = ...` summary a few lines AFTER "total time"
// (see print_timings() in tools/server/server-context.cpp -- prompt eval /
// eval / total time / graphs reused, THEN the draft stats, and only when
// speculative decoding actually drafted something). Holding the completion
// for a beat lets that line join the same record; non-speculative runs (no
// acceptance line ever) flush on the timer with the draft fields absent.
const pendingCompletionsByTaskId = new Map(); // taskId -> { timing, samples, completedAt, timer }
const COMPLETION_FLUSH_DELAY_MS = 500;
// Task ids that reached a natural "total time" completion recently -- used by
// the abort detector (the "stop processing" release line fires for BOTH
// natural and canceled ends, and by the time its grace delay runs, a natural
// completion's pending entry may already have flushed and been deleted).
const recentlyCompletedTaskIds = new Set();
function rememberCompletedTaskId(taskId) {
    recentlyCompletedTaskIds.add(taskId);
    setTimeout(() => recentlyCompletedTaskIds.delete(taskId), 30000);
}

// Per-request telemetry sampling for Monitor Mode's "omni graph" (GPU
// power/temp/util over the course of a request, not just the final tps
// summary). Deliberately a SINGLE shared sample buffer, not per-task like the
// timing map above -- properly isolating samples per concurrent task would
// mean tagging each monitor.py poll to whichever task(s) were active at that
// instant, which is real complexity for a case (multiple truly-simultaneous
// requests from different clients) that's rare in this dashboard's actual
// usage (one interactive user, occasional external tool calls). Overlapping
// requests share the same sample series rather than each getting a perfectly
// isolated one -- an acceptable simplification, not a correctness issue for
// the timing/CSV data itself (only for how the graph looks under overlap).
// Activity-timeout heuristic rather than precise increment/decrement pairing:
// the prefill progress log line doesn't reliably carry a task id the way the
// print_timing lines do, so there's no clean per-task "this request just
// started" signal to count against later. Instead, any progress line (prefill
// or gen) just bumps lastActivityTimestamp; the sampling loop keeps running
// as long as something was seen recently, and stops itself after a quiet
// period. Simpler and self-healing (never gets stuck "active" forever from a
// missed decrement) at the cost of the same overlapping-requests imprecision
// already noted above.
let activeRequestSamples = [];
let lastActivityTimestamp = 0;
let telemetrySamplingTimer = null;
const SAMPLE_INTERVAL_MS = 1000;
const ACTIVITY_TIMEOUT_MS = 3000;
const MAX_SAMPLES_PER_REQUEST = 300; // ~5 min at 1s/sample; caps memory for a pathologically long request

// Guards against overlapping calls piling up -- fetchCurrentTelemetry can now
// take up to 10s (see its own comment), but the sampling interval below still
// ticks every 1s regardless of whether the previous call finished. Without
// this, a slow monitor.py would accumulate multiple concurrent in-flight
// requests to it, adding more load to the exact thing that's already slow.
let telemetrySampleInFlight = false;
async function takeOneTelemetrySample(statsArg) {
    if (telemetrySampleInFlight) return;
    telemetrySampleInFlight = true;
    try {
        const stats = statsArg || await fetchCurrentTelemetry();
        if (!stats) return;
        // Live context position from llama-server's /slots endpoint -- the only
        // client-agnostic source of real context usage (n_prompt_tokens tracks
        // the slot's absolute context position, growing during generation).
        try {
            // Validated: config.port only ever comes from the launch config or
            // a raw command's --port (see /api/start's sync) -- anything else
            // falls back to the default 8080.
            const port = toFiniteNumber(currentLaunchConfig?.port) ?? 8080;
            const slotsRes = await fetch(`http://${CFG.llama.defaultHost}:${port}/slots`, { signal: AbortSignal.timeout(1500) });
            const slots = await slotsRes.json();
            const slot = Array.isArray(slots) ? slots[0] : null;
            if (slot && slot.n_ctx) {
                broadcastState(`CTX_LIVE:${slot.n_prompt_tokens ?? 0}:${slot.n_ctx}:${slot.is_processing ? 1 : 0}`);
            }
        } catch { /* endpoint disabled/unreachable -- context card just stays client-driven */ }
        // Net MB/s from the byte-counter delta -- used to be a client-only
        // computation, leaving the omni Net line permanently empty for
        // server-recorded samples.
        let netMbps = null;
        const nb = stats.master?.net_bytes;
        if (typeof nb === 'number' && lastSampleNetBytes != null && nb >= lastSampleNetBytes && lastSampleNetTime) {
            const dt = (Date.now() - lastSampleNetTime) / 1000;
            if (dt > 0.05) netMbps = +(((nb - lastSampleNetBytes) / 1048576) / dt).toFixed(2);
        }
        if (typeof nb === 'number') { lastSampleNetBytes = nb; lastSampleNetTime = Date.now(); }
        activeRequestSamples.push({
            t: Date.now(),
            netMbps,
            masterPwr: stats.master?.gpu_pwr ?? 0, masterTemp: stats.master?.gpu_temp ?? 0,
            masterGpuUtil: stats.master?.gpu_util ?? 0, masterCpuUtil: stats.master?.cpu_util ?? 0,
            workerPwr: stats.worker?.gpu_pwr ?? 0, workerTemp: stats.worker?.gpu_temp ?? 0,
            workerGpuUtil: stats.worker?.gpu_util ?? 0,
            // VRAM in GB (monitor.py reports MiB) -- lets the charts show KV
            // cache growth during long prefills.
            masterVram: stats.master?.vram_used != null ? +(stats.master.vram_used / 1024).toFixed(2) : null,
            workerVram: stats.worker?.vram_used != null ? +(stats.worker.vram_used / 1024).toFixed(2) : null,
            // Real per-tick phase data from llama-server's own progress lines
            // (see liveProgress). Null in whichever phase doesn't apply.
            prefillTps: liveProgress.prefillTps ?? null,
            prefillProgress: liveProgress.prefillProgress ?? null,
            prefillPos: liveProgress.prefillTokens ?? null,
            genTps: liveProgress.genTps ?? null,
        });
        if (activeRequestSamples.length > MAX_SAMPLES_PER_REQUEST) activeRequestSamples.shift();
    } finally {
        telemetrySampleInFlight = false;
    }
}

function markRequestActivity() {
    lastActivityTimestamp = Date.now();
    // Immediate first sample -- short requests can finish before the shared
    // 1s loop ever ticks. Cadence afterwards comes from the single unified
    // telemetry loop below (no per-request interval anymore).
    if (activeRequestSamples.length === 0) takeOneTelemetrySample();
}

// --- UNIFIED TELEMETRY LOOP ---
// One poller for everything: polls monitor.py at the user-selected rate
// (POST /api/telemetry/rate), caches the latest reading for the sidebar
// (GET /api/telemetry/latest -- no nvidia-smi shellout per sidebar tick
// anymore), and, while a request or bench run is active, records samples
// into activeRequestSamples for the omni charts. Replaces three separate
// pollers that all shelled out to nvidia-smi/amdgpu_top independently.
let telemetryPollMs = 1000;
let telemetryLoopTimer = null;
let lastServerTelemetry = null;
function startTelemetryLoop() {
    if (telemetryLoopTimer) clearInterval(telemetryLoopTimer);
    telemetryLoopTimer = setInterval(async () => {
        if (telemetrySampleInFlight) return;
        const stats = await fetchCurrentTelemetry();
        if (!stats) return;
        lastServerTelemetry = { t: Date.now(), stats };
        const recording = benchRunning || (Date.now() - lastActivityTimestamp < ACTIVITY_TIMEOUT_MS);
        if (recording) await takeOneTelemetrySample(stats);
    }, telemetryPollMs);
}

// Called on a request's "total time" line -- hands back whatever samples have
// accumulated since the last call and resets for whatever comes next.
function takeRequestSamples() {
    const samples = activeRequestSamples;
    activeRequestSamples = [];
    liveProgress = {}; // request over -- don't let its last rates bleed into trailing samples
    return samples;
}

// Bounded ring buffer of the last N requests' full sample series, keyed by
// run_id -- lets Monitor Mode's request table show the omni graph for a
// recently-completed request even if that specific client wasn't connected
// (missed the COMPLETION broadcast) when it finished. Not persisted to disk;
// a dashboard restart loses these (the CSV row / summary stats survive fine,
// just not the per-request sample series).
const recentRequestSamples = new Map(); // run_id -> samples[]
const MAX_RECENT_REQUEST_SAMPLES = 30;
function rememberRequestSamples(runId, samples) {
    if (!samples || samples.length === 0) return;
    recentRequestSamples.set(runId, samples);
    if (recentRequestSamples.size > MAX_RECENT_REQUEST_SAMPLES) {
        const oldestKey = recentRequestSamples.keys().next().value;
        recentRequestSamples.delete(oldestKey);
    }
}

async function fetchCurrentTelemetry() {
    try {
        const body = {};
        // Mutually exclusive by construction -- see resolveLaunchCommand's comment.
        if (currentLaunchConfig?.deviceB) {
            body.local_second_gpu = 'amd';
        } else if (currentLaunchConfig?.rpcTarget) {
            body.worker_ssh = currentLaunchConfig.rpcTarget;
        } else if (!currentLaunchConfig) {
            // No model launched (bench runs, sweeps between launches): there's
            // no config to consult, but the second GPU still exists and its
            // telemetry is exactly what bench charts are for. Without this,
            // GPU B graphed as all-zeros during every bench run.
            body.local_second_gpu = 'amd';
        }
        const res = await fetch(`http://${CFG.telemetry.host}:${CFG.telemetry.port}/stats`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            // monitor.py shells out to nvidia-smi/amdgpu_top per call, which
            // can genuinely take several seconds under heavy GPU/CPU load --
            // confirmed live at 5.5s+ while a model was actively generating.
            // This used to time out at 3s, meaning every sample attempt
            // during a real generation silently failed and Monitor's
            // per-request telemetry graphs were empty for every single
            // request. 3s was tuned for an idle system, not a busy one.
            signal: AbortSignal.timeout(10000)
        });
        return await res.json();
    } catch {
        return null; // best-effort -- a slow/unreachable monitor.py shouldn't block logging
    }
}

// Fires once per completed request (on that task's "total time" line). Logs a
// CSV row and broadcasts a COMPLETION SSE event so any connected client
// (Monitor Mode) can update live -- independent of whether this dashboard's
// own chat UI happened to be the one that sent the request.
async function logCompletedRequest(timing, samples, completedAt, { config: cfgParam, launchCommand: launchCmdParam } = {}) {
    try {
        // `samples`, `completedAt`, and (when provided) the launch
        // config/command were all captured on the completion log line (see the
        // pendingCompletionsByTaskId machinery in handleLogs) -- the actual
        // write/broadcast may run up to COMPLETION_FLUSH_DELAY_MS later,
        // waiting for a possible draft-acceptance line, and a server stop in
        // that window would null the globals out from under us.
        samples = samples || [];
        completedAt = completedAt || Date.now();
        const cfgSource = cfgParam || currentLaunchConfig;
        const cfg = cfgSource || {};
        const launchCmd = launchCmdParam !== undefined ? launchCmdParam : currentLaunchCommand;
        // Split the sample series into a prefill-phase line and a gen-phase
        // line using the real, completion-time-computed durations (not a live
        // per-sample estimate, which we have no way to get server-side --
        // llama.cpp's own progress lines are rate-limited, see markRequestActivity's
        // comment). genMs is the actual generation-phase duration, so counting
        // back from the total-time log line's timestamp gives a real
        // prefill/gen boundary timestamp to split the samples on.
        // Samples already carry real per-tick rates when llama printed progress
        // lines while they were taken (see liveProgress stamping) -- the flat
        // completion-time average is only a FALLBACK for samples that have
        // nothing (short requests below llama's progress-print thresholds).
        if (samples.length > 0 && timing.genMs != null) {
            const prefillEndTime = completedAt - timing.genMs;
            for (const s of samples) {
                if (s.t < prefillEndTime) {
                    s.prefillTps = s.prefillTps ?? timing.promptTps ?? null;
                    s.genTps = null;
                } else {
                    s.prefillTps = null;
                    s.genTps = s.genTps ?? timing.genTps ?? null;
                }
            }
        }
        const stats = await fetchCurrentTelemetry();
        const master = stats?.master || {};
        const worker = stats?.worker || {};
        const runId = await appendBenchmarkRow({
            model: cfg.modelPath || '',
            ctx: cfg.ctx || '',
            ngl: cfg.ngl || '',
            rpc: cfg.rpcTarget ? 'yes' : 'no',
            transport: cfg.rpcTarget ? (cfg.transport || '') : 'Local',
            argString: cfg.argString || '',
            launchCommand: launchCmd,
            promptTps: timing.promptTps ?? '',
            genTps: timing.genTps ?? '',
            promptLatency: timing.promptMs != null ? (timing.promptMs / 1000).toFixed(2) : '',
            promptTokens: timing.promptTokens ?? '',
            gpuUtil: master.gpu_util, gpuPwr: master.gpu_pwr, masterGpuTemp: master.gpu_temp,
            cpuUtil: master.cpu_util, masterCpuTemp: master.cpu_temp,
            gpuMem: master.vram_used, ramUsage: master.process_ram ?? master.ram_used,
            workerGpuUtil: worker.gpu_util, workerGpuPwr: worker.gpu_pwr, workerGpuTemp: worker.gpu_temp,
            workerCpuTemp: worker.cpu_temp, workerVram: worker.vram_used, workerRam: worker.process_ram ?? worker.ram_used,
            genTokens: timing.genTokens ?? '',
            wallTime: timing.wallTimeS ?? '',
            loadTime: finalLoadTime || '',
            configJson: cfgSource ? JSON.stringify(cfgSource) : '',
            // netThroughput/reasonTokens are frontend-only concepts (a client-side
            // delta calc, and reasoning-token counting from rendered content) --
            // left blank here, same as any other row missing optional fields.
            draftAcceptRate: timing.draftAcceptRate,
            draftAccepted: timing.draftAccepted,
            draftGenerated: timing.draftGenerated,
            draftMeanLen: timing.draftMeanLen,
            aborted: !!timing.aborted,
        });
        rememberRequestSamples(runId, samples);
        broadcastState(`COMPLETION:${JSON.stringify({
            runId,
            timestamp: Date.now(),
            model: (cfg.modelPath || '').split('/').pop(),
            promptTps: timing.promptTps, genTps: timing.genTps,
            promptTokens: timing.promptTokens, genTokens: timing.genTokens,
            wallTime: timing.wallTimeS,
            draftAcceptRate: timing.draftAcceptRate ?? null,
            draftAccepted: timing.draftAccepted ?? null,
            draftGenerated: timing.draftGenerated ?? null,
            draftMeanLen: timing.draftMeanLen ?? null,
            aborted: !!timing.aborted,
            metrics: samples
        })}`);
    } catch (err) {
        console.error('Failed to log completed request:', err);
    }
}

async function initLogsDir() {
    try {
        await fs.mkdir(LOGS_DIR, { recursive: true });
        try { await fs.access(CSV_FILE); } catch {
            await fs.writeFile(CSV_FILE, CSV_HEADERS);
        }
    } catch (err) {
        // Phase 2 startup check: a logs dir we cannot create/write is fatal --
        // every benchmark row and the bench transcript depend on it.
        console.error(`Failed to init logs directory ${LOGS_DIR}: ${err.message}`);
        process.exit(1);
    }
}

// --- HTTP SERVER ---
const server = http.createServer(async (req, res) => {
    // Phase 2: CORS is config-driven. Empty corsOrigins (default) means
    // same-origin only -- the UI is served from this origin, so no header at
    // all; remote origins get nothing.
    const origin = req.headers.origin;
    if (CFG.server.corsOrigins.length > 0) {
        if (origin && CFG.server.corsOrigins.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
        else if (CFG.server.corsOrigins.includes('*')) res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(200); return res.end(); }

    try {
        // --- UI ---
        if (req.url === '/' || req.url === '/index.html') {
            const content = await fs.readFile(path.join(__dirname, 'index.html'), 'utf-8');
            // no-store: index.html and script.js evolve together; a cached copy
            // of one against a fresh copy of the other produces bizarre
            // rendering bugs (e.g. new renderer writing into an old <pre>).
            res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
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

        // --- PUBLIC CONFIG (Phase 2: safe UI defaults + feature flags; never
        // filesystem paths or remote commands -- see publicConfig) ---
        else if (req.url === '/api/config' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(publicConfig(CFG)));
        }

        // --- MODELS ---
        else if (req.url === '/api/models') {
            const allModels = [];
            // Phase 2: scan every configured model directory (default
            // ./models relative to the repo root). Missing dirs are skipped.
            for (const localDir of CFG.paths.modelDirectories) {
                if (!await fs.access(localDir).then(() => true).catch(() => false)) continue;
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
                const headers = { 'Content-Type': types[path.extname(filePath)] || 'application/octet-stream' };
                // vendor/ assets are stable; the app's own js/css must never be
                // cached against a mismatched index.html (see the html handler).
                if (!req.url.startsWith('/vendor/')) headers['Cache-Control'] = 'no-store';
                res.writeHead(200, headers);
                return res.end(content);
            } catch (err) {
                res.writeHead(404);
                return res.end('Not found');
            }
        }

        // --- BENCHMARK LOG (manual/external logging; the dashboard's own chat no
        // longer calls this automatically -- see logCompletedRequest() for the
        // client-agnostic capture that replaced it, Item 12/Monitor Mode) ---
        else if (req.url === '/api/log' && req.method === 'POST') {
            let body;
            try { body = JSON.parse(await parseBody(req)); } catch (e) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid JSON' })); }
            const runId = await appendBenchmarkRow(body);
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

        // --- PER-REQUEST OMNI GRAPH SAMPLES (Monitor Mode) ---
        // Backs the "expand" view on a Monitor Mode table row -- returns the
        // GPU power/temp/util sample series collected while that specific
        // request was in flight (see markRequestActivity/takeRequestSamples).
        // Only available for requests still in the in-memory ring buffer
        // (recentRequestSamples, capped at MAX_RECENT_REQUEST_SAMPLES) -- older
        // ones simply have no sample data to show, same as CSV rows from
        // before this feature existed.
        else if (req.url.startsWith('/api/logs/samples') && req.method === 'GET') {
            const queryParams = new URLSearchParams(req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '');
            const runId = queryParams.get('runId') || '';
            const samples = recentRequestSamples.get(runId) || [];
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ samples }));
        }

        // --- IN-PROGRESS REQUEST SAMPLES (Monitor's live rolling graph) ---
        // A read-only peek at activeRequestSamples -- NOT takeRequestSamples(),
        // which would drain the buffer that logCompletedRequest still needs at
        // completion time. Lets Monitor's "last 2 minutes" graph show something
        // while a request is still streaming, rather than only ever updating
        // once a request finishes (which could be minutes away for a long
        // generation, making the graph look dead despite real activity).
        else if (req.url === '/api/logs/active-samples' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ samples: activeRequestSamples }));
        }

        // --- RECENT COMPLETED REQUESTS (Monitor Mode backfill) ---
        // Structured (not raw CSV text) so the frontend doesn't need its own
        // CSV parser just to backfill the Monitor Mode chart/table on load --
        // the live stream after that comes from COMPLETION SSE events (see
        // logCompletedRequest's broadcastState call).
        else if (req.url.startsWith('/api/logs/recent') && req.method === 'GET') {
            try {
                const queryParams = new URLSearchParams(req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '');
                const limit = Math.max(1, Math.min(parseInt(queryParams.get('limit'), 10) || 50, 500));

                const csv = await fs.readFile(CSV_FILE, 'utf-8');
                const lines = csv.trim().split('\n').slice(1).filter(l => l.trim());
                const recentLines = lines.slice(-limit);

                const rows = [];
                for (const line of recentLines) {
                    const cols = splitCsvLine(line);
                    if (cols.length < 32) continue; // only schema v3+ rows have model_name/transport at known offsets
                    rows.push({
                        timestamp: cols[0],
                        runId: cols[1],
                        model: cols[2],
                        transport: cols[7],
                        // parseNumOrNull (not `parseFloat() || null`) so a
                        // genuine 0 reading is reported as 0, not null.
                        promptTps: parseNumOrNull(cols[10]),
                        genTps: parseNumOrNull(cols[11]),
                        promptTokens: parseNumOrNull(cols[13]),
                        genTokens: parseNumOrNull(cols[28]),
                        wallTime: parseNumOrNull(cols[30]),
                        // Draft stats (cols 33+) only exist on rows logged since
                        // speculative-decoding capture was added; null elsewhere.
                        draftAcceptRate: cols.length > 33 ? parseNumOrNull(cols[33]) : null,
                        draftAccepted: cols.length > 34 ? parseNumOrNull(cols[34]) : null,
                        draftGenerated: cols.length > 35 ? parseNumOrNull(cols[35]) : null,
                        draftMeanLen: cols.length > 36 ? parseNumOrNull(cols[36]) : null,
                        aborted: cols.length > 37 ? cols[37] === '1' : false,
                    });
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ rows }));
            } catch {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ rows: [] }));
            }
        }

        // --- LOGS SUMMARY (Item 15b + Item #24 Schema v2) ---
        // Returns aggregate stats from the benchmarks CSV so the UI can
        // display "Best Gen Speed", "Avg Prefill", etc. without parsing
        // CSV on the client side.
        else if (req.url.startsWith('/api/logs/summary') && req.method === 'GET') {
            try {
                // Optional ?model=<basename>&transport=<Local|WiFi|TB4> filters --
                // "historical performance of THIS model + card(s) + connection
                // mode", not one global blended average across every run ever
                // logged (which is nearly meaningless once you've tried more than
                // one model/config).
                const queryString = req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '';
                const queryParams = new URLSearchParams(queryString);
                const filterModel = queryParams.get('model') || '';
                const filterTransport = queryParams.get('transport') || '';

                const csv = await fs.readFile(CSV_FILE, 'utf-8');
                const lines = csv.trim().split('\n').slice(1); // skip header
                if (lines.length === 0) {
                    // header-only (or empty) -- a CSV with exactly ONE data row
                    // is valid and must be aggregated, not discarded.
                    return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ count: 0 }));
                }
                // Schema v3 columns (0-indexed, 32 cols with launch_command):
                //  10=promptTps, 11=genTps, 12=promptLatency, 13=promptTokens,
                //  30=wallTime, 31=loadTime
                // Schema v2 (31 cols, no launch_command): 9=promptTps, 10=genTps, 11=promptLatency, 29=wallTime, 30=loadTime
                // Old schema (30 cols): 8=promptTps, 9=genTps, 10=promptLatency, 28=wallTime, 29=loadTime
                let n = 0, sumPromptTps = 0, sumGenTps = 0, sumPromptLat = 0, sumWallTime = 0, sumLoadTime = 0;
                let bestPromptTps = 0, bestGenTps = 0, bestPromptLat = Infinity, bestWallTime = Infinity, bestLoadTime = Infinity;
                // Rows are chronological (append-only CSV), so the last matching row
                // processed is the most recent run -- track its own actual values
                // (timestamp + its own prompt/gen tps + load time), not an average.
                // "Runs: N" still reports how many historical rows matched, but the
                // headline numbers are "what happened last time", not a blend.
                let lastModel = null, lastTimestamp = null, lastPromptTps = null, lastGenTps = null, lastLoadTime = null, lastConfig = null;
                for (const line of lines) {
                    if (!line.trim()) continue;
                    const cols = splitCsvLine(line);
                    // Need at least 25 cols to have the core metrics; auto-detect schema
                    if (cols.length < 25) continue;

                    // model_name (col 2) / Transport (col 7) only exist from schema v3
                    // onward (32+ cols) -- older rows have neither, so filters simply
                    // never match them (correctly excluded: we can't know what config
                    // produced them).
                    if (cols.length >= 32) {
                        const rowModel = cols[2];
                        const rowTransport = cols[7];
                        if (filterModel && rowModel !== filterModel) continue;
                        if (filterTransport && rowTransport !== filterTransport) continue;
                        lastModel = rowModel;
                        lastTimestamp = cols[0];
                        // config_json (col 32) only exists from schema v4 onward
                        // (33 cols). Reset per row: a newer row without
                        // config_json must not inherit the previous row's config.
                        lastConfig = null;
                        if (cols.length >= 33 && cols[32]) {
                            try { lastConfig = JSON.parse(cols[32]); } catch { /* older/malformed row -- skip */ }
                        }
                    } else if (filterModel || filterTransport) {
                        continue; // can't match a filter against a schema that has no model/transport columns
                    }

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
                    // "last*" tracks the most recent row's OWN values -- set
                    // unconditionally so a row missing a field reports null
                    // instead of silently falling back to an older row's number.
                    lastPromptTps = Number.isFinite(pTps) ? pTps : null;
                    lastGenTps = Number.isFinite(gTps) ? gTps : null;
                    lastLoadTime = Number.isFinite(lTime) ? lTime : null;
                    if (Number.isFinite(pTps))  { sumPromptTps += pTps;  if (pTps > bestPromptTps)  bestPromptTps = pTps; }
                    if (Number.isFinite(gTps))  { sumGenTps += gTps;   if (gTps > bestGenTps)     bestGenTps = gTps; }
                    if (Number.isFinite(pLat))  { sumPromptLat += pLat; if (pLat < bestPromptLat)   bestPromptLat = pLat; }
                    if (Number.isFinite(wTime)) { sumWallTime += wTime; if (wTime < bestWallTime)   bestWallTime = wTime; }
                    if (Number.isFinite(lTime)) { sumLoadTime += lTime; if (lTime < bestLoadTime)   bestLoadTime = lTime; }
                    n++;
                }
                // Round to 1 decimal -- raw division produces long floats like
                // 22.101066666666674 which is noise, not information, at this precision.
                const avg = (v, c) => c > 0 ? Math.round((v / c) * 10) / 10 : 0;
                const round1 = (v) => Number.isFinite(v) ? Math.round(v * 10) / 10 : 0;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                if (n === 0) {
                    // Item 15 Step 3: no matching history for this exact
                    // model/transport combo -- say so rather than showing a
                    // misleading zero.
                    return res.end(JSON.stringify({ count: 0, filtered: !!(filterModel || filterTransport) }));
                }
                return res.end(JSON.stringify({
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
                }));
            } catch {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ count: 0 }));
            }
        }

        // --- LIST CONFIGURED BUILDS (local-multi-gpu mode's "Build" selector) ---
        else if (req.url === '/api/builds' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ builds: getLlamaServerBuilds() }));
        }

        // --- BENCH: run llama-bench from a configured build (Bench tab) ---
        // Accepts a single config, or { queue: [cfg, ...] } -- the queue lives
        // SERVER-side and chains run-to-run on process exit, so closing the
        // browser tab no longer kills a matrix mid-flight.
        else if (req.url === '/api/bench/start' && req.method === 'POST') {
            let cfg;
            try { cfg = JSON.parse(await parseBody(req)); } catch (e) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid JSON' })); }
            if (benchRunning) {
                res.writeHead(409, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'A bench run is already in progress' }));
            }
            // llama-bench needs the VRAM the model server is holding; refuse
            // rather than letting both fight over it and produce garbage numbers.
            if (llamaProcess) {
                res.writeHead(409, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Stop the running model first -- llama-bench needs its VRAM for clean numbers' }));
            }
            if (Array.isArray(cfg.queue)) {
                if (cfg.queue.length === 0 || cfg.queue.some(c => !c.modelPath)) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'queue must be non-empty configs with modelPath' }));
                }
                benchQueue = cfg.queue.slice(1);
                benchQueueTotal = cfg.queue.length;
                const first = cfg.queue[0];
                benchCurrentLabel = first.label || first.devices || 'run';
                benchLog(`===== llama-bench 1/${benchQueueTotal}: ${benchCurrentLabel} =====`);
                const err = launchBenchProcess(first);
                if (err) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: err })); }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ ok: true, queued: benchQueue.length, command: benchLastCommand }));
            }
            if (!cfg.modelPath) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'modelPath is required' }));
            }
            benchQueue = []; benchQueueTotal = 0;
            const err = launchBenchProcess(cfg);
            if (err) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: err })); }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: true, command: benchLastCommand }));
        }
        else if (req.url === '/api/telemetry/latest' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(lastServerTelemetry || { t: 0, stats: null }));
        }
        else if (req.url === '/api/telemetry/rate' && req.method === 'POST') {
            let rateBody;
            try { rateBody = JSON.parse(await parseBody(req)); } catch (e) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid JSON' })); }
            telemetryPollMs = Math.max(250, Math.min(5000, parseInt(rateBody.ms) || 1000));
            startTelemetryLoop();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: true, ms: telemetryPollMs }));
        }
        else if (req.url === '/api/bench/note' && req.method === 'POST') {
            // Client-composed result blocks (e.g. Launch Sweep tables) appended
            // into the same transcript/accordion/history file as bench runs.
            let noteBody;
            try { noteBody = JSON.parse(await parseBody(req)); } catch (e) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid JSON' })); }
            const noteLines = Array.isArray(noteBody.lines) ? noteBody.lines.slice(0, 200) : [];
            for (const l of noteLines) benchLog(String(l).slice(0, 2000));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: true }));
        }
        else if (req.url === '/api/bench/clear' && req.method === 'POST') {
            benchOutput = [];
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: true }));
        }
        else if (req.url === '/api/bench/restore' && req.method === 'POST') {
            // Undo for clear: reload the transcript tail from the disk log.
            try {
                const hist = await fs.readFile(path.join(LOGS_DIR, 'bench-history.log'), 'utf-8');
                benchOutput = hist.split('\n').filter(l => l !== '').slice(-1500);
            } catch { benchOutput = []; }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: true, output: benchOutput }));
        }
        else if (req.url === '/api/bench/dequeue' && req.method === 'POST') {
            // Remove a not-yet-started run from the server-side matrix queue.
            let dq;
            try { dq = JSON.parse(await parseBody(req)); } catch (e) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid JSON' })); }
            const before = benchQueue.length;
            benchQueue = benchQueue.filter(q => q.label !== dq.label);
            if (benchQueue.length !== before) benchLog(`[matrix] dequeued: ${dq.label}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: true, removed: before - benchQueue.length, queueRemaining: benchQueue.length }));
        }
        else if (req.url === '/api/bench/stop' && req.method === 'POST') {
            benchQueue = []; benchQueueTotal = 0; // stop also cancels queued matrix runs
            if (benchProcess) benchProcess.kill('SIGTERM');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: true }));
        }
        else if (req.url === '/api/bench/status' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ running: benchRunning, command: benchLastCommand, output: benchOutput,
                queueRemaining: benchQueue.length, queueTotal: benchQueueTotal,
                currentLabel: benchRunning ? benchCurrentLabel : '',
                samples: benchRunning ? activeRequestSamples : benchLastSamples }));
        }

        // --- FLAG REFERENCE (searchable popover) ---
        else if (req.url.startsWith('/api/flags') && req.method === 'GET') {
            const queryParams = new URLSearchParams(req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '');
            const buildId = queryParams.get('build') || '';
            if (cachedFlagReferenceByBuild.has(buildId)) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ flags: cachedFlagReferenceByBuild.get(buildId) }));
            }
            try {
                const { stdout } = await execFileAsync(getLlamaServerBinary(buildId), ['--help'], { timeout: 8000, maxBuffer: 1024 * 1024 });
                const flags = parseHelpFlags(stdout);
                cachedFlagReferenceByBuild.set(buildId, flags);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ flags }));
            } catch (err) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ flags: [], error: err.message }));
            }
        }

        // --- LIST VULKAN/CUDA DEVICES (local-multi-gpu mode) ---
        else if (req.url.startsWith('/api/devices') && req.method === 'GET') {
            const queryParams = new URLSearchParams(req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '');
            let binary;
            try {
                binary = getLlamaServerBinary(queryParams.get('build') || '');
            } catch (err) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ devices: [], error: err.message }));
            }
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

        // --- PREVIEW LAUNCH COMMAND (raw-command-as-source-of-truth UI) ---
        // Same structured-config -> command resolution /api/start uses, minus
        // actually spawning anything. The frontend calls this on every GUI field
        // change to keep the editable raw-command textarea in sync; whatever text
        // sits in that box at Boot time is what actually gets tokenized and run
        // (see the rawCommand branch in /api/start below) -- this endpoint only
        // generates the *starting point* for editing, it is not itself the source
        // of truth once the user starts typing in the box.
        else if (req.url === '/api/preview-command' && req.method === 'POST') {
            let body;
            try { body = JSON.parse(await parseBody(req)); } catch (e) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid JSON' })); }
            try {
                const { command, args } = resolveLaunchCommand(body);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ command: formatCommand(command, args) }));
            } catch (err) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ command: '', error: err.message }));
            }
        }

        // --- START SERVER ---
        else if (req.url === '/api/start' && req.method === 'POST') {
            let body;
            try { body = JSON.parse(await parseBody(req)); } catch (e) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid JSON' })); }

            if (llamaProcess) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Running' })); }

            let config = body;
            let command, args;

            // The raw command box is the actual source of truth for what runs --
            // structured `config` fields are used for display/CSV/Item-22-restore
            // purposes and to seed the box's initial content (via /api/preview-command
            // above), but everything actually executed comes from tokenizing
            // whatever text the user left in that box. Only fall back to
            // reconstructing from structured fields if it's empty (e.g. a client
            // that hasn't loaded the new UI, or the box genuinely wasn't touched).
            // A failure here (bad build config, missing model/ctx/ngl, empty
            // box) must return a clean 400 -- NOT an unhandled rejection that
            // leaves the dashboard stuck in 'starting' with stale launch state.
            try {
                if (config.rawCommand && config.rawCommand.trim().length > 0) {
                    const tokens = tokenizeCommand(config.rawCommand.trim());
                    command = tokens[0];
                    args = tokens.slice(1);
                    if (!command) throw new Error('Invalid raw command');

                    // The raw command is what actually runs, so sync the
                    // structured config from it -- otherwise the CSV row, the
                    // /slots poll, and worker telemetry would all use stale UI
                    // values for model/port/rpc.
                    const modelVal = extractLastFlagValue(args, '-m') ?? extractLastFlagValue(args, '--model');
                    // model = display name (basename), modelPath = the real path
                    if (modelVal) config = { ...config, model: String(modelVal).split('/').pop(), modelPath: modelVal };
                    const portVal = toFiniteNumber(extractLastFlagValue(args, '--port'));
                    if (portVal !== undefined) config = { ...config, port: portVal };
                    const rpcVal = extractLastFlagValue(args, '--rpc');
                    if (rpcVal && !config.rpcTarget) config = { ...config, rpcTarget: rpcVal };
                } else {
                    ({ command, args } = resolveLaunchCommand(config));
                }
            } catch (err) {
                return res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: err.message }));
            }

            currentModel = config.model || config.modelPath || '';
            isRpc = !!config.rpcTarget;
            currentLaunchConfig = config;
            serverState = 'starting';
            loadStartTime = Date.now();
            finalLoadTime = 0;
            // Clear log buffer for fresh run (see dashboard-bugs1-analysis.md item 5)
            masterLogBuffer = [];
            broadcastState();

            currentLaunchCommand = formatCommand(command, args);
            console.log('LAUNCHING:', currentLaunchCommand);
            broadcastState('', 'LAUNCH CMD: ' + currentLaunchCommand);   // shows in chat as an "error"-style banner

            try {
                llamaProcess = spawnLlamaProcess(command, args, { cwd: APP_ROOT });
            } catch (err) {
                // Synchronous spawn failure (e.g. non-string command) -- reset
                // the state just set above so the dashboard doesn't sit in
                // 'starting' forever with a dead launch config.
                llamaProcess = null;
                serverState = 'stopped';
                currentModel = '';
                isRpc = false;
                currentLaunchConfig = null;
                broadcastState('', 'Failed to start process: ' + err.message);
                return res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: err.message }));
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ status: 'launching' }));
        }

        // --- STOP SERVER ---
        else if (req.url === '/api/stop' && req.method === 'POST') {
            serverState = 'stopping';
            broadcastState();
            // The master always runs as a directly-spawned process now -- no
            // compose container to bring down.
            // Request the kill but don't null `llamaProcess` here -- the process's own
            // 'close' handler (registered at spawn time) is now the single place that
            // clears shared state, once the process has actually exited. Nulling it here
            // first was the other half of the race that used to crash the whole process
            // (see dashboard-bugs1-analysis.md item 13).
            if (llamaProcess) {
                const proc = llamaProcess;
                try {
                    proc.kill('SIGTERM');
                } catch { /* process may already be gone */ }
                // Escalate to SIGKILL if it ignores SIGTERM (e.g. stuck in a
                // long syscall) -- the 'close' handler is the only place that
                // clears state, so a kill that lands after close is a no-op.
                setTimeout(() => {
                    try { proc.kill('SIGKILL'); } catch { /* already gone */ }
                }, CFG.processes.stopGraceMs).unref();
            }
            serverState = 'stopped';
            currentModel = '';
            isRpc = false;
            currentLaunchConfig = null;
            broadcastState();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ status: 'stopped' }));
        }

        // --- WORKER (Phase 2: commands come from server config, never from
        // the browser; the host may come from the request or config default) ---
        // Optional workDirectory is prepended as a cd so relative compose
        // file paths resolve where the worker's files actually live.
        // (helper defined at module scope below -- see workerComposeCommand)
        else if (req.url === '/api/worker/start' && req.method === 'POST') {
            let body;
            try { body = JSON.parse(await parseBody(req)); } catch (e) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid JSON' })); }
            const workerHost = body.worker_ssh || CFG.worker.sshHost;
            if (!workerHost) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Missing worker_ssh' })); }
            if (!CFG.worker.startCommand) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ success: false, error: 'Worker commands not configured' })); }
            try {
                const { stdout, stderr } = await runSSHCommand(workerHost, workerComposeCommand(CFG.worker.startCommand));
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
            const workerHost = body.worker_ssh || CFG.worker.sshHost;
            if (!workerHost) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Missing worker_ssh' })); }
            if (!CFG.worker.stopCommand) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ success: false, error: 'Worker commands not configured' })); }
            try {
                const { stdout, stderr } = await runSSHCommand(workerHost, workerComposeCommand(CFG.worker.stopCommand));
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
            const workerHost = body.worker_ssh || CFG.worker.sshHost;
            if (!workerHost) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Missing worker_ssh' })); }
            if (!CFG.worker.statusCommand) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ status: 'offline', error: 'Worker commands not configured' })); }
            try {
                const { stdout } = await runSSHCommand(workerHost, workerComposeCommand(CFG.worker.statusCommand));
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
            const workerHost = body.worker_ssh || CFG.worker.sshHost;
            if (!workerHost) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Missing worker_ssh' })); }
            if (!CFG.worker.logsCommand) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ logs: 'Failed to fetch logs: Worker commands not configured' })); }
            try {
                const { stdout, stderr } = await runSSHCommand(workerHost, workerComposeCommand(CFG.worker.logsCommand));
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
    // Phase 2: typed config loads first and gates startup -- an invalid
    // config is a field-specific fatal error (ConfigError.issues), never a
    // silent fallback to machine values.
    try {
        CFG = await loadConfig({ appRoot: APP_ROOT });
    } catch (err) {
        if (err instanceof ConfigError) for (const issue of err.issues) console.error('[config] ' + issue);
        else console.error('Failed to load config:', err);
        process.exit(1);
    }
    LOGS_DIR = CFG.paths.logsDirectory;
    CSV_FILE = path.join(LOGS_DIR, 'benchmarks.csv');
    HF_CACHE_DIR = CFG.paths.huggingFaceCache;

    await initLogsDir();

    // Legacy fuser-based port cleanup is OFF by default: it killed whatever
    // PID happened to own the ports, including unrelated processes. Opt in
    // explicitly via processes.cleanupManagedPortsOnStart.
    if (CFG.processes.cleanupManagedPortsOnStart) {
        await cleanupPort(CFG.llama.defaultPort);
        if (CFG.telemetry.enabled) await cleanupPort(CFG.telemetry.port);
    }

    // Startup checks (soft): surface a broken setup without crashing the
    // dashboard -- a missing build disables launch/bench at the routes.
    if (CFG.llama.builds.length === 0) {
        console.warn('[config] no llama.cpp builds configured -- launch and bench actions are disabled (add llama.builds to config/dashboard.json)');
    }
    for (const b of CFG.llama.builds) {
        if (!await fs.access(b.path).then(() => true).catch(() => false)) {
            console.warn(`[config] build "${b.id}" binary missing or unreadable: ${b.path}`);
        }
    }
    if (!CFG.worker.sshHost) {
        console.warn('[config] worker.sshHost empty -- worker controls stay disabled in the UI');
    }

    // Reload the tail of the bench transcript so a dashboard restart doesn't
    // present an empty Bench tab (the full history lives in the file).
    try {
        const benchHist = await fs.readFile(path.join(LOGS_DIR, 'bench-history.log'), 'utf-8');
        benchOutput = benchHist.split('\n').filter(l => l !== '').slice(-1500);
    } catch { /* no history yet */ }

    // No more startup recovery scan for a leftover `master-node` Docker
    // container here -- the master never launches in Docker anymore, so the
    // only thing that scan could ever find post-refactor is a stale container
    // from before this change. If you have one of those hanging around after
    // updating, tear it down manually: `docker compose -f
    // docker-compose.master.yml down`.

    // stdio must be 'ignore': the default pipes are never read here, so once
    // monitor.py printed 64KB (e.g. a stream of warnings) it would block on
    // write and its /stats endpoint would silently stall.
    // Phase 2: monitor command/script come from config; a missing python or
    // script must never stop the dashboard (telemetry is best-effort).
    if (CFG.telemetry.enabled) {
        const monitorExists = await fs.access(CFG.paths.monitorScript).then(() => true).catch(() => false);
        if (!monitorExists) {
            console.warn(`[config] telemetry enabled but monitor script missing: ${CFG.paths.monitorScript} -- telemetry disabled`);
        } else {
            pythonProcess = spawn(CFG.paths.pythonCommand, [CFG.paths.monitorScript], { cwd: APP_ROOT, stdio: 'ignore' });
            // An unhandled 'error' event (python missing, spawn failure, ...)
            // would become an uncaughtException and take the whole dashboard
            // down over a missing monitor -- telemetry is best-effort.
            pythonProcess.on('error', (err) => {
                console.error('monitor spawn error:', err.message);
                pythonProcess = null;
            });
            pythonProcess.on('exit', () => {
                pythonProcess = null;
            });
        }
    }
    startTelemetryLoop();

    const shutdownHandler = async () => {
        // Directly-spawned processes -- must be killed explicitly or they're
        // orphaned on shutdown (no compose container to bring down instead).
        // Timers first, so nothing fires while the processes die.
        try { if (telemetryLoopTimer) clearInterval(telemetryLoopTimer); } catch { }
        if (benchProcess) {
            try { benchProcess.kill(); } catch { }
        }
        if (llamaProcess) {
            try { llamaProcess.kill(); } catch { }
        }
        if (pythonProcess) {
            try { pythonProcess.kill(); } catch { }
        }
        process.exit(0);
    };

process.on('exit', () => {
    if (benchProcess) { try { benchProcess.kill(); } catch { } }
    if (pythonProcess) { try { pythonProcess.kill(); } catch { } }
});
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

    server.listen(CFG.server.port, CFG.server.host, () => console.log(`\n🚀 Mission Control running at: http://${CFG.server.host}:${CFG.server.port}`));
}

initServer().catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
});
