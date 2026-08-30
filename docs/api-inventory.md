# Dashboard Server API Inventory (Phase 1 Behavior Capture)

Source: committed `HEAD:server4.js` (2,154 lines, CommonJS) and committed `HEAD:script.js` (5,346 lines).
All line numbers refer to `server4.js` unless a `script.js` line is cited explicitly.

This document is a verbatim behavior capture. Every claim is traceable to a source line.
Conditional behavior is stated with its condition.

> Superseded (2026-08): the Python `monitor.py` child and its `127.0.0.1:8081/stats`
> endpoint are gone. Telemetry is collected in-process by `src/server/services/hwmon.ts`
> (same subprocess + /proc sources, identical response shapes). Client-facing
> contracts (`/api/telemetry/*`, SSE frames) are unchanged.

---

## 1. Route Inventory

### Static file routes

#### `GET /` and `GET /index.html`
- **Method:** GET (any method reaches the handler; the only method gate above it is the OPTIONS check at line 1360)
- **Query params:** none parsed
- **Request body:** none read
- **Response shape:** `text/html` — raw contents of `path.join(__dirname, 'index.html')` read as UTF-8 text (lines 1364–1370)
- **Status codes:** 200 on success
- **Side effects:** none
- **Notes:** Serves `Cache-Control: no-store` to prevent stale index.html/script.js mismatch (line 1369)

#### `GET /static-asset` (regex: `/^\\/(?:vendor\\/)?[\\w.-]+\\.(js|css|map|ico|png|svg)$/`)
- **Method:** matches any method (no method gate)
- **Query params:** none parsed
- **Request body:** none read
- **Response shape:** file bytes with `Content-Type` from the types map (lines 1430–1437):
  - `.js` → `application/javascript`
  - `.css` → `text/css`
  - `.map` → `application/json`
  - `.ico` → `image/x-icon`
  - `.png` → `image/png`
  - `.svg` → `image/svg+xml`
  - fallback → `application/octet-stream`
- **Status codes:** 200 on success, 403 on traversal attempt, 404 on file-not-found
- **Side effects:** none
- **Path traversal guard:** `path.join(__dirname, req.url)` result checked with `filePath.startsWith(__dirname)`; if false, returns 403 (lines 1424–1429).
- **Cache:** `Cache-Control: no-store` for all assets EXCEPT those under `/vendor/` (line 1443)

---

### API routes

#### `GET /api/status` (SSE stream — `text/event-stream`)
- **Method:** GET (any method)
- **Query params:** none
- **Request body:** none
- **Response:** SSE stream. Headers set at lines 1374–1375:
  - `Content-Type: text/event-stream`
  - `Cache-Control: no-cache`
  - `Connection: keep-alive`
- **Status codes:** 200 (always, on connect)
- **Side effects on connect:** response `res` object pushed to `clients[]` array (line 1376); immediate `broadcastState()` call fires the initial payload as the first SSE `data:` line (line 1377)
- **Disconnect handling:** `req.on('close', ...)` removes `res` from `clients[]` via filter (line 1378)
- **Initial payload:** the full `broadcastState` JSON object (see SSE section below), emitted once on connect
- **No per-client state:** all clients receive the same broadcast payload

#### `GET /api/models`
- **Method:** GET (any method)
- **Query params:** none
- **Request body:** none
- **Response shape:** `application/json` — array of model objects: `[{ name: string, path: string, size: string, source: "local"|"huggingface" }]`
- **Status codes:** 200 always
- **Side effects:** none (read-only filesystem scan)
- **Sources:** scans `path.join(ROOT_DIR, 'models')` for `.gguf` files (source `local`, line 1385/1396); scans `HF_CACHE_DIR` via `scanDirForGgufs()` (source `huggingface`, line 1404). `scanDirForGgufs` recursively walks directories, returns `{ name, path, size, source: 'huggingface' }` (lines 259–278). HF cache access failure logged but does not fail request (lines 1402–1408)
- **Dedup:** models with duplicate paths removed via `seenPaths` Set (lines 1410–1417)

#### `POST /api/log`
- **Method:** POST
- **Query params:** none
- **Request body JSON shape:** arbitrary object passed to `appendBenchmarkRow(data)` — expects fields: `{ model, ctx, ngl, rpc, transport, argString, launchCommand, promptTps, genTps, promptLatency, promptTokens, gpuUtil, gpuPwr, masterGpuTemp, cpuUtil, masterCpuTemp, gpuMem, ramUsage, workerGpuUtil, workerGpuPwr, workerGpuTemp, workerCpuTemp, workerVram, workerRam, netThroughput, genTokens, reasonTokens, wallTime, loadTime, configJson, draftAcceptRate, draftAccepted, draftGenerated, draftMeanLen, aborted }`. All fields optional; missing fields become empty strings in CSV
- **Validation applied:** JSON parse error → 400 `{ error: "Invalid JSON" }` (line 1457). Body size limited by `parseBody` 10 MB cap (see Validation section)
- **Response shape:** `application/json` — `{ success: true, run_id: string }`
- **Status codes:** 200 on success, 400 on JSON parse error
- **Side effects:** appends a row to `logs/benchmarks.csv` via `appendBenchmarkRow` (call at line 1458, function defined at line 1039); calls `fs.mkdir(LOGS_DIR, { recursive: true })` first as self-healing (line 987)

#### `GET /api/logs/csv`
- **Method:** GET
- **Query params:** none
- **Request body:** none
- **Response shape:** `text/csv` — raw file contents of `logs/benchmarks.csv`
- **Status codes:** 200 on success, 404 if file does not exist
- **Side effects:** none
- **Notes:** Returns the full CSV including header row (line 911 headers written on init at line 1348)

#### `GET /api/logs/samples` (Monitor Mode omni-graph samples for a completed request)
- **Method:** GET
- **Query params:**
  - `runId` (string, required for meaningful data; defaults to `''` when absent)
- **Request body:** none
- **Response shape:** `application/json` — `{ samples: array<{ t, netMbps, masterPwr, masterTemp, masterGpuUtil, masterCpuUtil, workerPwr, workerTemp, workerGpuUtil, masterVram, workerVram, prefillTps, prefillProgress, prefillPos, genTps }> }`
- **Status codes:** 200 always
- **Side effects:** none (read-only lookup into in-memory `recentRequestSamples` Map)
- **Notes:** Returns `[]` if runId not found or ring buffer evicted (capped at `MAX_RECENT_REQUEST_SAMPLES = 30`, line 1208). Samples are not persisted to disk; lost on dashboard restart

#### `GET /api/logs/active-samples` (Monitor Mode live rolling graph)
- **Method:** GET
- **Query params:** none
- **Request body:** none
- **Response shape:** `application/json` — `{ samples: array<same sample shape> }`
- **Status codes:** 200 always
- **Side effects:** none (read-only peek at `activeRequestSamples` array)
- **Notes:** Does NOT drain the buffer — returns the live array reference (line 1497 comment)

#### `GET /api/logs/recent`
- **Method:** GET
- **Query params:**
  - `limit` (integer, optional; default `50`; clamped to range `[1, 500]` via `Math.max(1, Math.min(parseInt(...), 10) || 50, 500)` at line 1511)
- **Request body:** none
- **Response shape:** `application/json` — `{ rows: array<{ timestamp, runId, model, transport, promptTps, genTps, promptTokens, genTokens, wallTime, draftAcceptRate, draftAccepted, draftGenerated, draftMeanLen, aborted }> }`
- **Status codes:** 200 always (even on CSV read failure → returns `{ rows: [] }`)
- **Side effects:** none (read-only)
- **Notes:** Parses CSV with `splitCsvLine` (line 1519); skips rows with fewer than 32 columns (line 1520). Draft stats only parsed when `cols.length` exceeds the column index (lines 1535–1538)

#### `GET /api/logs/summary`
- **Method:** GET
- **Query params:**
  - `model` (string, optional; defaults to empty — no filter when absent)
  - `transport` (string, optional; defaults to empty — no filter when absent)
- **Request body:** none
- **Response shape:** `application/json`:
  - On empty CSV / no rows: `{ count: 0 }` (line 1571) or `{ count: 0, filtered: true }` (line 1659 when filters set but no match)
  - On success: `{ count, lastModel, lastConfig, lastTimestamp, lastPromptTps, lastGenTps, lastLoadTime, filtered, avgPromptTps, avgGenTps, avgPromptLatency, avgWallTime, avgLoadTime, bestPromptTps, bestGenTps, bestPromptLatency, bestWallTime, bestLoadTime }`
- **Status codes:** 200 always
- **Side effects:** none (read-only)
- **Validation/notes:** Parses CSV supporting three schema versions (v2=31 cols, v3=32 cols, old=30 cols) based on column count (lines 1573–1636). Rows with fewer than 25 columns skipped (line 1590). Schema v3+ required for model/transport filtering. Numeric values rounded to 1 decimal. `lastConfig` from col 32 JSON parse on schema v4+ (33+ cols) (lines 1606–1609)

#### `GET /api/builds`
- **Method:** GET
- **Query params:** none
- **Request body:** none
- **Response shape:** `application/json` — `{ builds: array<{ id: string, label: string, path: string }> }`
- **Status codes:** 200 always
- **Side effects:** none (read-only)
- **Notes:** Returns `dashboardConfig.llamaServerBuilds` (line 1690), loaded from `dashboard.config.json` or `DEFAULT_LLAMA_SERVER_BUILDS` (line 167)

#### `POST /api/bench/start`
- **Method:** POST
- **Query params:** none
- **Request body JSON shape:**
  - Single config mode: `{ modelPath (required), build, ctx, ngl, rawArgs, fa, cacheK, cacheV, nPrompt, nGen, depths, reps, devices, splitMode, tensorSplit, extraArgs, ... }`
  - Queue/matrix mode: `{ queue: array<same config shape> }`
  - `cfg.rawCommand` (different from `cfg.rawArgs`) also accepted, takes priority (lines 1887–1889)
- **Validation applied:**
  - JSON parse error → 400 `{ error: "Invalid JSON" }` (line 1699)
  - If `benchRunning` is already true → 409 `{ error: "A bench run is already in progress" }` (line 1702)
  - If `llamaProcess` is already running → 409 `{ error: "Stop the running model first..." }` (line 1708)
  - Queue mode: empty queue or item missing `modelPath` → 400 (lines 1711–1713)
  - Single mode: missing `modelPath` → 400 (lines 1725–1727)
- **Response shape (single):** `{ ok: true, command: string }` (line 1733)
- **Response shape (queue):** `{ ok: true, queued: number, command: string }` (line 1723)
- **Response shape (spawn error):** `{ error: string }` status 500 (lines 1721, 1731)
- **Status codes:** 200, 400, 409, 500
- **Side effects:** Spawns `llama-bench` via `launchBenchProcess` (lines 1720/1730); mutates `benchQueue`, `benchQueueTotal`, `benchCurrentLabel`; calls `benchLog` which appends to `benchOutput` and writes `logs/bench-history.log` via serialized `benchLogWriteChain` (line 154)

#### `GET /api/bench/status`
- **Method:** GET
- **Query params:** none
- **Request body:** none
- **Response shape:** `application/json` — `{ running, command, output, queueRemaining, queueTotal, currentLabel, samples }`
- **Status codes:** 200 always
- **Side effects:** none
- **Notes:** `samples` returns `activeRequestSamples` (live) when running, or `benchLastSamples` when stopped (line 1792). `currentLabel` is `''` when not running (line 1791)

#### `POST /api/bench/stop`
- **Method:** POST
- **Query params:** none
- **Request body:** none (no body parsed)
- **Response shape:** `application/json` — `{ ok: true }`
- **Status codes:** 200 always
- **Side effects:** Clears `benchQueue = []` and `benchQueueTotal = 0` (line 1782); sends `SIGTERM` to `benchProcess` if alive (line 1783)

#### `POST /api/bench/clear`
- **Method:** POST
- **Query params:** none
- **Request body:** none (no body parsed)
- **Response shape:** `application/json` — `{ ok: true }`
- **Status codes:** 200 always
- **Side effects:** Clears in-memory `benchOutput = []` (line 1758). Does NOT delete `logs/bench-history.log` from disk

#### `POST /api/bench/restore`
- **Method:** POST
- **Query params:** none
- **Request body:** none (no body parsed)
- **Response shape:** `application/json` — `{ ok: true, output: array<string> }`
- **Status codes:** 200 always
- **Side effects:** Reads `logs/bench-history.log`, splits on newline, filters empties, takes last 1500 lines into `benchOutput` (lines 1764–1767). On read failure, sets `benchOutput = []` (line 1767)

#### `POST /api/bench/dequeue`
- **Method:** POST
- **Query params:** none
- **Request body JSON shape:** `{ label: string }`
- **Validation applied:** JSON parse error → 400 `{ error: "Invalid JSON" }` (line 1774). `label` not explicitly checked; `benchQueue.filter` handles missing gracefully
- **Response shape:** `application/json` — `{ ok: true, removed: number, queueRemaining: number }`
- **Status codes:** 200 on success, 400 on JSON parse error
- **Side effects:** Filters `benchQueue` removing entries where `q.label === dq.label` (line 1776); calls `benchLog` if any removed (line 1777)

#### `POST /api/bench/note`
- **Method:** POST
- **Query params:** none
- **Request body JSON shape:** `{ lines: array<string> }`
- **Validation applied:** JSON parse error → 400 `{ error: "Invalid JSON" }` (line 1751). `lines` validated with `Array.isArray`; non-array → empty list (line 1752). Each line sliced to max 2000 chars (line 1753). Up to 200 lines (line 1752: `.slice(0, 200)`)
- **Response shape:** `application/json` — `{ ok: true }`
- **Status codes:** 200 on success, 400 on JSON parse error
- **Side effects:** Each line passed to `benchLog()`, which pushes to `benchOutput`, broadcasts `BENCH:` SSE event, and appends to `logs/bench-history.log`

#### `GET /api/flags` (flag reference popover)
- **Method:** GET
- **Query params:**
  - `build` (string, optional; defaults to empty — empty string used as cache key)
- **Request body:** none
- **Response shape:** `application/json` — `{ flags: array<{ flags, description, section, insertText, primaryFlag }> }`; on error: `{ flags: [], error: string }`
- **Status codes:** 200 always (even on exec failure; error in body)
- **Side effects:** Calls `execFileAsync(getLlamaServerBinary(buildId), ['--help'], { timeout: 8000, maxBuffer: 1024 * 1024 })` (line 1804); caches result in `cachedFlagReferenceByBuild` Map (line 1806)
- **Validation:** `getLlamaServerBinary(buildId)` throws if no valid builds — NOT caught (falls to outer try/catch → 500). The `execFileAsync` call IS within its own try/catch (lines 1803–1812)

#### `GET /api/devices` (local-multi-gpu device enumeration)
- **Method:** GET
- **Query params:**
  - `build` (string, optional; defaults to empty — passed to `getLlamaServerBinary`)
- **Request body:** none
- **Response shape:** `application/json` — `{ devices: array<{ id, description, totalMib, freeMib }> }`; on build error: `{ devices: [], error }`; on exec failure: `{ devices: [], error: "timed out"|"failed" }`
- **Status codes:** 200 always
- **Side effects:** Calls `execFileAsync(binary, ['--list-devices'], { timeout: 8000, maxBuffer: 1024 * 1024 })` (line 1829)
- **Validation:** `getLlamaServerBinary` failure caught (lines 1819–1823); exec failure caught (lines 1838–1842)

#### `POST /api/preview-command`
- **Method:** POST
- **Query params:** none
- **Request body JSON shape:** launch config object (same shape as `/api/start`'s config body — see `buildLlamaArgs` for full field list at lines 390–504)
- **Validation applied:** JSON parse error → 400 `{ error: "Invalid JSON" }` (line 1855)
- **Response shape:** `application/json`: On success: `{ command: string }` (line 1859). On error: `{ command: '', error: string }` (line 1862)
- **Status codes:** 200 always
- **Side effects:** Calls `resolveLaunchCommand(body)` (lines 522–546); does NOT spawn anything

#### `POST /api/start`
- **Method:** POST
- **Query params:** none
- **Request body JSON shape:** launch config object with validated fields:
  - `modelPath` (string, required, non-empty after trim — line 394/395)
  - `ctx` (finite number, required — lines 397/399)
  - `ngl` (finite number, required — lines 398/399)
  - `port` (integer 1–65535, optional; defaults to `8080` — lines 405–408)
  - `build` (string, optional)
  - `rawCommand` (string, optional; if non-empty, takes priority — lines 1887–1903)
  - `rpcTarget` (string, optional; forces `isRpc = true`)
  - `model` (string, optional display name)
  - Plus: `fa, cacheK, cacheV, specType, specDraftNMax, specDraftNMin, specDraftModel, specNgramSizeN, specNgramSizeM, specNgramMinHits, specDraftNgl, preserveThinking, reasoningPreserve, chatTemplateFile, jinja, loadMode, verbosity, argString, deviceA, deviceB, tensorSplit, transport`
- **Validation applied:** JSON parse error → 400 (line 1869). `llamaProcess` already running → 400 `{ error: "Running" }` (line 1871). Invalid config fields → 400 (lines 1910–1936 try/catch). Spawn failure → 500 (line 1937)
- **Response shape:** `application/json` — `{ status: "launching" }` (line 1941)
- **Status codes:** 200, 400, 500
- **Side effects:** Sets `currentModel`, `isRpc`, `currentLaunchConfig`, `serverState = 'starting'`, `loadStartTime`, `masterLogBuffer = []` (lines 1911–1918); broadcasts; spawns `llama-server` via `spawnLlamaProcess(command, args, { cwd: ROOT_DIR })` (line 1926). On spawn failure: resets state to stopped, broadcasts error, returns 500 (lines 1927–1937)

#### `POST /api/stop`
- **Method:** POST
- **Query params:** none
- **Request body:** none (no body parsed)
- **Response shape:** `application/json` — `{ status: "stopped" }` (line 1973)
- **Status codes:** 200 always
- **Side effects:** Sets `serverState = 'stopping'`, broadcasts (lines 1946–1947). Sends `SIGTERM` to `llamaProcess` (line 1958); schedules `SIGKILL` after 3s via `setTimeout(..., 3000).unref()` (lines 1963–1965). Sets `serverState = 'stopped'`, clears model/config, broadcasts (lines 1967–1971). Does NOT null `llamaProcess` — relies on close handler (line 1950 comment)

#### `POST /api/worker/start`
- **Method:** POST
- **Query params:** none
- **Request body JSON shape:** `{ worker_ssh: string }`
- **Validation applied:** JSON parse error → 400 (line 1979). Missing `worker_ssh` → 400 (line 1981). Invalid SSH host regex → 500 (line 1987)
- **Response shape (success):** `{ success: true, stdout, stderr }` (line 1985)
- **Response shape (error):** `{ success: false, error: string }` (line 1988)
- **Status codes:** 200, 400, 500
- **Side effects:** Runs SSH command `cd ~/AI/experiment-1 && docker compose -f docker-compose.worker.yml up -d` via `runSSHCommand` (line 1983)

#### `POST /api/worker/stop`
- **Method:** POST
- **Query params:** none
- **Request body JSON shape:** `{ worker_ssh: string }`
- **Validation applied:** JSON parse error → 400 (line 1995). Missing `worker_ssh` → 400 (line 1997)
- **Response shape (success):** `{ success: true, stdout, stderr }` (line 2002)
- **Response shape (error):** `{ success: false, error: string }` (line 2004)
- **Status codes:** 200, 400, 500
- **Side effects:** Runs SSH command `cd ~/AI/experiment-1 && docker compose -f docker-compose.worker.yml down` (line 1999)

#### `POST /api/worker/status`
- **Method:** POST
- **Query params:** none
- **Request body JSON shape:** `{ worker_ssh: string }`
- **Validation applied:** JSON parse error → 400 (line 2011). Missing `worker_ssh` → 400 (line 2013)
- **Response shape (SSH success):** `{ status: "running" | "stopped" }` (line 2017)
- **Response shape (SSH failure):** `{ status: "offline", error: string }` (line 2020)
- **Status codes:** 200 always
- **Side effects:** Runs SSH command `cd ~/AI/experiment-1 && docker compose -f docker-compose.worker.yml ps --filter status=running -q` (line 2015)

#### `POST /api/worker/logs`
- **Method:** POST
- **Query params:** none
- **Request body JSON shape:** `{ worker_ssh: string }`
- **Validation applied:** JSON parse error → 400 (line 2027). Missing `worker_ssh` → 400 (line 2029)
- **Response shape (SSH success):** `{ logs: string }` (line 2033 — `stdout || stderr || 'No logs available.'`)
- **Response shape (SSH failure):** `{ logs: "Failed to fetch logs: <error>" }` (line 2036)
- **Status codes:** 200 always
- **Side effects:** Runs SSH command `cd ~/AI/experiment-1 && docker compose -f docker-compose.worker.yml logs --tail=50` (line 2031)

#### `GET /api/master/logs`
- **Method:** GET
- **Query params:** none
- **Request body:** none
- **Response shape:** `application/json` — `{ logs: string }` (line 2048 — joined by `\n`, or `No logs available. Start the server first.` if buffer empty)
- **Status codes:** 200 always
- **Side effects:** none (read-only access to `masterLogBuffer` ring buffer)

#### `POST /api/telemetry/rate`
- **Method:** POST
- **Query params:** none
- **Request body JSON shape:** `{ ms: number }` — `ms` parsed via `parseInt(rateBody.ms)` (line 1742)
- **Validation applied:** JSON parse error → 400 (line 1741). `ms` clamped to `[250, 5000]` with default 1000 (line 1742)
- **Response shape:** `application/json` — `{ ok: true, ms: number }` (line 1745)
- **Status codes:** 200 always
- **Side effects:** Sets `telemetryPollMs` global; calls `startTelemetryLoop()` which clears and recreates `telemetryLoopTimer` (lines 1180–1182)

#### `GET /api/telemetry/latest`
- **Method:** GET
- **Query params:** none
- **Request body:** none
- **Response shape:** `application/json`: `{ t: number, stats: object }` if telemetry available, or `{ t: 0, stats: null }` if not (lines 1986–1987)
- **Status codes:** 200 always
- **Side effects:** none (read-only)

#### Fallback 404
- **Else branch (lines 2052–2054):** Any URL not matching above routes returns `404 { error: "Not found" }`

---

## 2. `/api/status` SSE Event Reference

### Transport
- **Protocol:** `text/event-stream` over HTTP/1.1 keep-alive. Each broadcast is a single SSE `data:` field containing a JSON string, terminated by `\n\n` (line 232: `client.write("data: " + payload + "\n\n")`)
- **Connect behavior:** On GET `/api/status`, response registered as 200 with SSE headers, pushed to `clients[]` array, and `broadcastState()` called immediately — connecting client receives current server state as first message (lines 1374–1379)
- **Client-side:** `script.js` line 431 creates `new EventSource('/api/status')`; line 432 sets `onmessage = handleSseMessage`; line 443 calls `eventSource.close()` on `beforeunload`
- **Watchdog:** `script.js` lines 438–442 — every 15s, if tab visible and no message in 45s, reconnects via `connectSSE()`

### Initial payload (every SSE message uses this shape)
Every SSE `data:` line is a JSON object with this shape (line 228):
```json
{
  "state": "stopped" | "loading" | "ready" | "starting" | "stopping",
  "model": string,
  "isRpc": boolean,
  "log": string,
  "error": string,
  "loadStartTime": number,
  "finalLoadTime": number,
  "launchCommand": string,
  "launchConfig": object | null
}
```
The `log` and `error` fields are the channels through which event-type information is carried (SSE stream does not use SSE event names — single `onmessage` handler inspects `data.log` prefixes, `script.js` line 465).

### SSE event names and trigger conditions

All events use the `log` field of the standard payload. Client (`script.js` line 465) dispatches on `data.log` prefix:

| Event name (log prefix) | Payload format | Trigger condition | Source |
|||-|||
| *(state-only)* | `log: ""` | Any `broadcastState()` call with default args — state sync only | Any handler calling `broadcastState()` with no log arg |
| `PREFILL_PROGRESS:<progress>:<tps>:<nTokens>` | `PREFILL_PROGRESS:0.00-1.00:float:int` | llama-server stdout line containing `prompt processing, n_tokens =` AND matching progress regex AND `tokens per second` regex (line 676–690) | `handleLogs` on llama-server stdout/stderr (line 688) |
| `GEN_PROGRESS:<tps>:<nGen>:<nGen>` | `GEN_PROGRESS:float:int:int` | llama-server stdout line containing `print_timing:` AND matching `n_gen` and (`tg_3s` or `tg` t/s regex) (line 692–726) | `handleLogs` on llama-server stdout/stderr (line 724) |
| `CTX_LIVE:<n_prompt_tokens>:<n_ctx>:<is_processing>` | `CTX_LIVE:int:int:0|1` | During telemetry sampling (every 1000ms while recording active), llama-server `/slots` endpoint returns a slot with `n_ctx` truthy (lines 1116–1126) | `takeOneTelemetrySample` → `broadcastState` (line 1125) |
| `COMPLETION:<json>` | `COMPLETION:{"runId,"timestamp,"model,"promptTps,"genTps,"promptTokens,"genTokens,"wallTime,"draftAcceptRate,"draftAccepted,"draftGenerated,"draftMeanLen,"aborted,"metrics":[...]}` | A completed request's "total time" print_timing line (line 751), after a `COMPLETION_FLUSH_DELAY_MS` = 500ms deferral (line 774–780) OR immediately if a "draft acceptance" line arrives first (lines 784–802) | `logCompletedRequest` → `broadcastState` (line 1326) |
| `BENCH:<line>` | `BENCH:<arbitrary bench log line text>` | Every line written by `benchLog()` during a bench run (line 151) | `benchLog` function (line 151) |
| `BENCH_DONE:<code>` | `BENCH_DONE:0` (success) or `BENCH_DONE:signal` (killed) or `BENCH_DONE:N` (exit code N) | `llama-bench` process exits — `finishRun` callback emits this as `doneTag` (line 104: `"BENCH_DONE:" + (code ?? "signal")`), becomes the `log` arg of `broadcastState` (line 98) | `finishRun` inside `spawnBench` (line 98/104) |
| `LAUNCH CMD: <command>` | `LAUNCH CMD: <shell-quoted command string>` | On `/api/start` (line 1923), via `broadcastState('', 'LAUNCH CMD: ' + currentLaunchCommand)` — rides the `error` channel, not `log` channel | `/api/start` handler (line 1923) |

### Error-channel SSE events (via `error` field, not `log` prefix)

| Trigger | Error string | Source line |
|||-||
| Launch banner | `"LAUNCH CMD: " + currentLaunchCommand` | Line 1923 |
| Fatal llama-server log line | `"Failed to allocate VRAM: Reduce n_gpu_layers or use a smaller model."` (if `failed to fit params` in line) or `"Process error: " + line.trim().slice(-200)` | Lines 844–846 |
| Process exited prematurely | `"Launch failed: " + errLines.join(" | ").slice(0, 300)` | Line 874 |
| Spawn error event | `"Failed to start process: " + err.message` | Line 895 |
| Sync spawn failure in `/api/start` | `"Failed to start process: " + err.message` | Line 1936 |
| Uncaught exception | `"Server crash: " + (err?.message || String(err))` | Line 2137 |

### Heartbeat / keepalive
- **No heartbeat.** No ping/heartbeat mechanism on the server side. Messages pushed only in response to state changes, log lines, or telemetry ticks
- **Telemetry tick interval:** `SAMPLE_INTERVAL_MS = 1000` (line 1097). `CTX_LIVE` fires from the sampling loop only while `recording` is true (`benchRunning` true OR `Date.now() - lastActivityTimestamp < ACTIVITY_TIMEOUT_MS` = 3000ms, line 1187)

### Disconnect handling
- On `req.on('close')` for the SSE request, the response object is filtered out of `clients[]` (line 1378)
- `broadcastState` wraps each `client.write()` in try/catch and moves dead (broken-pipe) clients to a `deadClients` array for removal (lines 229–237)
- No explicit SSE ping/pong or `req.socket` monitoring

### Who writes what
`broadcastState()` (line 227) is the single writer to all SSE clients. Called from:
- `spawnLlamaProcess` handleLogs: load/start states, prefill/gen progress, fatal lines, premature close, process error, normal close (lines 656, 660/665, 688, 724, 847, 874, 895, 885)
- `spawnBench`/`finishRun`: on bench completion via `doneTag` (line 98)
- `benchLog()`: on every bench log line (line 151)
- `takeOneTelemetrySample`: on CTX_LIVE (line 1125)
- `logCompletedRequest`: on request completion (line 1326)
- `/api/start` handler: state→starting, launch command banner, spawn failure (lines 1919, 1923, 1936)
- `/api/stop` handler: state→stopping then stopped (lines 1947, 1971)
- `/api/status` SSE connect handler: initial broadcast (line 1377)
- `uncaughtException` handler: crash broadcast (line 2137)

---

## 3. Shutdown & Cleanup

### Signal handlers
| Handler | Line | Behavior |
|||-||
| `process.on('SIGINT')` | 2127 | Calls `shutdownHandler` |
| `process.on('SIGTERM')` | 2128 | Calls `shutdownHandler` |
| `process.on('exit')` | 2123 | Kills `benchProcess` and `pythonProcess` (NOT `llamaProcess`) with bare `.kill()` |
| `process.on('uncaughtException')` | 2132 | Logs stack, sets state stopped, broadcasts crash error, calls `shutdownHandler` (line 2140) |
| `process.on('unhandledRejection')` | 2144 | Logs only; does NOT shut down |

### `shutdownHandler` (lines 2106–2121)
1. Clears `telemetryLoopTimer` via `clearInterval` (line 2110, try/catch)
2. Kills `benchProcess` if alive: `benchProcess.kill()` (line 2112, bare kill = SIGTERM)
3. Kills `llamaProcess` if alive: `llamaProcess.kill()` (line 2115, bare kill = SIGTERM)
4. Kills `pythonProcess` if alive: `pythonProcess.kill()` (line 2118, bare kill = SIGTERM)
5. Calls `process.exit(0)` (line 2120)

### Process kill order
**SIGINT/SIGTERM / `shutdownHandler` order** (lines 2110–2119):
1. `telemetryLoopTimer` (clearInterval)
2. `benchProcess.kill()` (SIGTERM)
3. `llamaProcess.kill()` (SIGTERM)
4. `pythonProcess.kill()` (SIGTERM)
5. `process.exit(0)`

Note: unlike `/api/stop` (which escalates SIGTERM→SIGKILL after 3s), shutdown handler uses bare `.kill()` (SIGTERM only) with no SIGKILL escalation. `process.exit(0)` called immediately after kill signals. No grace period wait.

**`exit` handler order** (lines 2123–2126): only kills `benchProcess` and `pythonProcess` (no `llamaProcess`, no timer cleanup).

### `fuser -k` port cleanup logic
- **Function:** `cleanupPort(port)` (line 303) — runs `execAsync("fuser -k " + port + "/tcp", { stdio: "ignore" })` (line 305)
- **Called at startup only** during `initServer()` (lines 2073–2074):
  - `await cleanupPort(8080)` — kills whatever PID owns port 8080 (llama-server)
  - `await cleanupPort(8081)` — kills whatever PID owns port 8081 (monitor.py)
- **Silently ignores failures** — fuser unavailable or port free produces no error (lines 306–308 catch block)
- **Not called during shutdown** — only `.kill()` calls in `shutdownHandler`
- **No tracking** — `fuser` kills whatever PID owns the port regardless of whether this dashboard spawned it

### Process registry structures
No unified process registry. Processes tracked as module-level variables:
- `llamaProcess` (line 16) — spawned `llama-server` child process (or null)
- `pythonProcess` (line 17) — spawned `monitor.py` child process (or null)
- `benchProcess` (line 132) — spawned `llama-bench` child process (or null)

Each nulled independently:
- `llamaProcess`: nulled in `spawnLlamaProcess` close handler (line 880) and error handler (line 892); null on spawn failure in `/api/start` (line 1927)
- `pythonProcess`: nulled in 'error' handler (line 2099) and 'exit' handler (line 2101)
- `benchProcess`: nulled in `spawnBench` `finishRun` callback (line 95)

### Shutdown idempotency
- **Partially idempotent.** `shutdownHandler` wraps each `.kill()` in try/catch (lines 2112, 2115, 2118). `clearInterval` wrapped in try/catch (line 2110). `process.exit(0)` at line 2120 ensures effective single-run.
- **`uncaughtException` calls `shutdownHandler`** (line 2140) — if already invoked by SIGINT/SIGTERM, this is a second call but try/catch guards handle dead processes gracefully.
- **Not idempotent for `fuser`** — port cleanup only runs once at `initServer` startup; no shutdown-time port cleanup.
- **`exit` handler** is idempotent in practice — by the time `exit` fires, `shutdownHandler` has already killed `benchProcess` and `pythonProcess`.

---

## 4. Validation & Error Behavior

### Body size limits
- **10 MB hard cap** enforced in `parseBody` (line 13: `const MAX_BODY_SIZE = 10 * 1024 * 1024`). When accumulated `size` exceeds `MAX_BODY_SIZE`, the request is destroyed and a "Payload too large" error is rejected (lines 247–251).
- **No route catches "Payload too large"** — all route-level try/catch blocks catch `parseBody` rejection but only handle it as `{ error: "Invalid JSON" }`. An oversized body on any POST route falls through to the outer try/catch at line 2057 → 500 `{ error: "Internal server error" }`

### JSON parse error handling
Every POST route that reads a body uses the same pattern (lines 1741, 1751, 1774, 1855, 1869, 1979, 1995, 2011, 2027):
```js
try { body = JSON.parse(await parseBody(req)); } catch (e) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid JSON' })); }
```
Returns `400 { error: "Invalid JSON" }` with `Content-Type: application/json`.

### HTTP error patterns
| Status code | Pattern | Lines |
|||-||
| **200** | All successful responses; `/api/flags` and `/api/devices` on exec failure (error in body) | Throughout |
| **400** | Invalid JSON body, missing required fields (`worker_ssh`, `modelPath`), already running, invalid build config, empty queue, invalid raw command | 1871, 1855, 1869, 1751, 1774, 1979, 1995, 2011, 2027, 1981, 1997, 2013, 2029 |
| **403** | Path traversal attempt on static file serving | 1427 |
| **404** | File not found on static serving; CSV file not found on `/api/logs/csv`; unmatched route | 1447, 2053 |
| **409** | Bench already running; llama.server already running when bench start requested | 1701, 1707 |
| **500** | Synchronous spawn failure; bench spawn failure; SSH failure; unhandled route error; uncaughtException | 1937, 1721, 1731, 1987, 2003, 2060 |

### Outer error handler
Line 2057–2063: any uncaught error in the request handler (without `res.headersSent` already set) returns `500 { error: "Internal server error" }` with `Content-Type: application/json`.

### Path traversal guards
- **Static files:** `path.join(__dirname, req.url)` checked against `filePath.startsWith(__dirname)`; 403 if outside (lines 1424–1429)
- **Caveat:** `req.url` used directly without URL-decoding. URL-encoded traversal like `%2e%2e` is NOT decoded by `path.join`, so it would fail at `fs.readFile` with 404 (not caught as traversal). Literal `../..` IS caught.
- **No traversal guard on `/api/models`** — scans server-defined `ROOT_DIR/models` and `HF_CACHE_DIR`
- **No traversal guard on `/api/logs/*` routes** — all read from server-defined `CSV_FILE` path

### CORS handling
- `Access-Control-Allow-Origin: *` (line 1358) — accepts all origins
- `Access-Control-Allow-Methods: GET, POST, OPTIONS` (line 1359)
- **No `Access-Control-Allow-Headers`** — server does not declare allowed headers
- **No `Access-Control-Allow-Credentials`** — credentials not supported
- OPTIONS preflight: returns 200 with empty body (line 1360)

---

## 5. Machine-Specific Values

Every hardcoded absolute path, hostname, IP, username, port, and executable reference in the committed `server4.js`:

| Line | Type | Value | Context |
|||-|||
| 11 | Path | `path.join(__dirname, '..')` → `ROOT_DIR` | Parent of server4.js; cwd for spawned processes (623, 1926), models dir (1385) |
| 12 | Port | `3000` → `PORT` | HTTP server listen port (2148) |
| 13 | Limit | `10 * 1024 * 1024` (10 MB) → `MAX_BODY_SIZE` | Request body size cap (13) |
| 168 | Path | `/home/kyle/AI/llama-official/llama.cpp/build/bin/llama-server` | Default build path in `DEFAULT_LLAMA_SERVER_BUILDS` (168) |
| 170 | Path | `path.join(__dirname, 'dashboard.config.json')` | Config file path (170) |
| 224 | Path/env | `process.env.HF_HOME || process.env.HUGGINGFACE_HUB_CACHE || path.join(os.homedir(), '.cache', 'huggingface', 'hub')` → `HF_CACHE_DIR` | HuggingFace cache directory (224) |
| 283 | Regex | `^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+$` | SSH host validation pattern |
| 290 | Executable | `ssh` | SSH command executable (290) |
| 290 | Flags | `-o BatchMode=yes -o ConnectTimeout=5` | SSH options (290) |
| 290 | Number | `5` | SSH connect timeout seconds (290) |
| 305 | Command | `fuser -k ${port}/tcp` | Port cleanup (305) |
| 405 | Number | `8080` | Default llama.server port (405 fallback) |
| 406 | Number | `65535` / `1` | Port validation range (406) |
| 536 | Number | `50052` | RPC port in `--rpc` flag (536) |
| 1120 | Number | `8080` | Fallback for `/slots` poll port (1120) |
| 1121 | String | `http://localhost:${port}/slots` | llama-server /slots URL (1121) |
| 1233 | String | `http://localhost:8081/stats` | monitor.py /stats URL (1233) |
| 1244 | Number | `10000` | monitor.py fetch timeout ms (1244) |
| 2093 | Executable | `python3` | Python executable for monitor.py (2093) |
| 2093 | String | `monitor.py` | Monitor script filename (2093) |
| 2093 | Path | `__dirname` | CWD for python3 spawn (2093) |
| 2148 | String | `http://localhost:${PORT}` | Startup log message (2148) |
| 1983 | String | `cd ~/AI/experiment-1 && docker compose -f docker-compose.worker.yml up -d` | Worker start SSH cmd (1983) |
| 1999 | String | `cd ~/AI/experiment-1 && docker compose -f docker-compose.worker.yml down` | Worker stop SSH cmd (1999) |
| 2015 | String | `cd ~/AI/experiment-1 && docker compose -f docker-compose.worker.yml ps --filter status=running -q` | Worker status SSH cmd (2015) |
| 2031 | String | `cd ~/AI/experiment-1 && docker compose -f docker-compose.worker.yml logs --tail=50` | Worker logs SSH cmd (2031) |
| 2073 | Number | `8080` | Port cleaned at startup via fuser (2073) |
| 2074 | Number | `8081` | Port cleaned at startup via fuser (2074) |
| 912 | Path | `path.join(ROOT_DIR, 'logs')` → `LOGS_DIR` | Logs directory (912) |
| 913 | Path | `path.join(LOGS_DIR, 'benchmarks.csv')` → `CSV_FILE` | Benchmarks CSV path (913) |
| 155 | Path | `path.join(LOGS_DIR, 'bench-history.log')` | Bench history log (155, in `benchLog`) |
| 1764-1765 | Path | `path.join(LOGS_DIR, 'bench-history.log')` | Bench history log (1765, in `bench/restore`) |

### Additional machine-coupled constants (not paths/strings)

| Line | Constant | Value | Context |
|||-|||
| 109 | `ACTIVITY_TIMEOUT_MS` | `3000` | Inactivity threshold for telemetry recording (109) |
| 1177 | `telemetryPollMs` | `1000` | Default telemetry poll interval ms (1177) |
| 1208 | `MAX_RECENT_REQUEST_SAMPLES` | `30` | In-memory sample retention cap (1208) |
| 138 | `BENCH_OUTPUT_MAX_LINES` | `4000` | benchOutput ring buffer cap, trims to 3000 (138, 150) |
| 221 | `MASTER_LOG_BUFFER_SIZE` | `500` | masterLogBuffer ring buffer cap (221) |
| 1063 | `COMPLETION_FLUSH_DELAY_MS` | `500` | Deferral window for COMPLETION SSE (1063) |
| 1071 | — | `30000` | Recent task ID retention ms (1071) |
| 1097 | `SAMPLE_INTERVAL_MS` | `1000` | Telemetry sample interval (1097) |
| 1965 | — | `3000` | SIGTERM→SIGKILL escalation in `/api/stop` (1965) |
| 1804, 1829 | — | `8000` | `execFileAsync` timeout for `--help` and `--list-devices` (1804, 1829) |
| 1804, 1829 | — | `1024 * 1024` | `maxBuffer` for execFileAsync calls (1804, 1829) |

---

## Route & SSE Summary

- **API route count (excluding static + 404):** 28 routes
  - `/api/status`, `/api/models`, `/api/log`, `/api/builds`, `/api/flags`, `/api/devices`, `/api/preview-command`, `/api/start`, `/api/stop`, `/api/bench/start`, `/api/bench/status`, `/api/bench/stop`, `/api/bench/clear`, `/api/bench/restore`, `/api/bench/dequeue`, `/api/bench/note`, `/api/logs/csv`, `/api/logs/samples`, `/api/logs/active-samples`, `/api/logs/recent`, `/api/logs/summary`, `/api/master/logs`, `/api/telemetry/rate`, `/api/telemetry/latest`, `/api/worker/start`, `/api/worker/stop`, `/api/worker/status`, `/api/worker/logs`
  - Plus: `/` and `/index.html`, static file serving regex, `OPTIONS` preflight, 404 fallback
  - **Total dispatch branches: 32** (including `else if` chains for static files and 404)

- **SSE event count (distinct `log:` prefixed event types):** 7
  - `PREFILL_PROGRESS`, `GEN_PROGRESS`, `CTX_LIVE`, `COMPLETION`, `BENCH`, `BENCH_DONE`, `LAUNCH CMD`
  - Plus state-only broadcasts (no prefix) and 6 error-channel messages via the `error` field

### Top 5 most machine-coupled values found
1. **`/home/kyle/AI/llama-official/llama.cpp/build/bin/llama-server`** (line 168) — default build binary path in `DEFAULT_LLAMA_SERVER_BUILDS`
2. **`~/AI/experiment-1`** (lines 1983, 1999, 2015, 2031) — hardcoded remote worker working directory in all four SSH commands
3. **`fuser -k 8080/tcp` and `fuser -k 8081/tcp`** (lines 2073–2074) — startup port cleanup killing arbitrary processes on llama-server and monitor ports
4. **`python3`** (line 2093) — hardcoded Python executable name for spawning `monitor.py`
5. **`50052`** (line 536) — hardcoded RPC port appended to the `--rpc` flag in the llama-server launch command
