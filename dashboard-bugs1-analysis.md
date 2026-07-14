# Dashboard Bug Report & Action Plan

Source: `dashboard-bugs1.txt`. Investigated against `index.html`, `server4.js`, `monitor.py` (the active trio — `index1/2.html`, `server3.js`, `monitor1.py` are older/superseded).

**How to use this document:** Work items in order — later items sometimes depend on earlier ones (this is called out explicitly where it applies, e.g. item 8 depends on item 5 and item 13). Each item has a **Why it happens** (root cause, with file:line references) and an **Action plan** (ordered steps) — read both before touching code; don't skip to the action plan. A confidence note is given where a finding wasn't verified against a live run (grep for "Confidence" or "needs live confirmation") — reproduce those first rather than assuming the diagnosis is complete. Items marked `COMPLETED` already have a fix applied — verify the fix still holds, don't redo the work. File:line references may drift by a few lines as fixes are applied; re-`grep` for the quoted code snippet if a line number looks off.

---

## 1. Master RAM numbers are nonsensical ("7702 MB (Llama: 21759 MB, Sys: 0 MB)")

**Why it happens:** The UI computes `Sys = Total("used") - Llama(RSS)` and clamps at 0 (`index.html:1620`). The two inputs come from different, non-comparable sources in `monitor.py`:
- `ram_used` = column 3 of `free -m`'s `Mem:` line (`monitor.py:164-168`) — this is memory `free` classifies as "used," which **excludes** page cache/buffers.
- `process_ram` = sum of RSS (`ps ax -o rss,comm`) for processes named `llama-server` (`monitor.py:170-179`).

llama.cpp `mmap()`s the GGUF weight file by default. Resident, file-backed mmap pages **count toward the process's RSS** but are classified by the kernel as cache, not "used," in `free -m`'s accounting. So once part of a 35B model is paged into system RAM (as you suspected), the process's RSS can legitimately exceed `free -m`'s "used" figure — that's exactly the `21759 > 7702` inversion you're seeing. It isn't a display bug alone; the two numbers are apples-and-oranges and always will be while sourced this way.

**Action plan:**
1. In `monitor.py`, stop deriving "total used" from `free -m`'s used column. Use `MemTotal - MemAvailable` from `/proc/meminfo` instead — this is the standard "true used including reclaimable cache that's actually pinned by a process" figure and will always be ≥ any single process's RSS.
2. Keep `process_ram` as-is (RSS via `ps`), it's the right number for "Llama."
3. Recompute `Sys = max(total_used - process_ram, 0)` server-side (in `monitor.py`) or leave the client math as-is once the inputs are consistent — the UI logic in `index.html:1615-1628` is otherwise correct and doesn't need to change.
4. Apply the same fix to the worker RAM path (`monitor.py` remote branch uses the same `free -m` parsing; `index.html:1670-1679` mirrors the same subtraction).

**Cline has attempted fix. Completion notes:**
Fixed the master RAM display bug in ￼monitor.py. The root cause was that ram_used was sourced from free -m's "used" column, which excludes page cache/buffers, while process_ram (RSS via ps) includes file-backed mmap pages for llama.cpp's GGUF weights. This caused process_ram > ram_used when model weights are paged into system RAM, producing nonsensical output like "7702 MB (Llama: 21759 MB, Sys: 0 MB)".

Changes made to ￼monitor.py:

Added get_meminfo_usage() function — reads /proc/meminfo and computes used = MemTotal - MemAvailable. This is the standard Linux "true used" figure that always ≥ any single process's RSS.

Replaced free -m parsing with /proc/meminfo for local stats — the local path now calls get_meminfo_usage() instead of parsing free -m's used column.

Added /proc/meminfo collection for SSH remote (worker) stats — the SSH command now includes cat /proc/meminfo (as ===MEMINFO===), and the parser extracts it. A parse_meminfo() helper function is used for the remote data, while get_meminfo_usage() handles the local path.

RAM values converted from kB→MB server-side (mem_total_kb // 1024) for consistency with the existing UI expectations.

The UI in ￼index.html requires no changes — its logic (bgRam = Math.max(totalRamUsed - processRam, 0)) is correct; it was just operating on incompatible inputs that are now consistent.

After restart, you should see RAM values like "20849 MB (Llama: 21759 MB, Sys: -910 MB)" replaced with consistent numbers where Sys = TotalUsed - Llama ≥ 0. The "Llama" RSS may still exceed the displayed "Total Used" only if MemAvailable is very low, which would indicate the system is under memory pressure — a legitimate condition to surface rather than masking it with mismatched numbers.

To apply: restart the monitor server: pkill -f monitor.py && python3 monitor.py &

---

## 2. GPU telemetry shows nothing

**Root cause confirmed (not a guess — I ran it):** `monitor.py`'s combined GPU query (`monitor.py:112`, and the identical string in the SSH `shell_cmd` block) requests the field `clocks_throttle_reasons.sw_thermal`. That field name is wrong. Running the exact query on this machine:

```
$ nvidia-smi --query-gpu=name,memory.used,memory.total,power.draw,temperature.gpu,utilization.gpu,clocks_throttle_reasons.hw_slowdown,clocks_throttle_reasons.sw_thermal --format=csv,noheader,nounits
Field "clocks_throttle_reasons.sw_thermal" is not a valid field to query.
```

`nvidia-smi --help-query-gpu` confirms the real field name is `clocks_throttle_reasons.sw_thermal_slowdown` (a `_slowdown` suffix is missing):

```
"clocks_throttle_reasons.hw_slowdown"
"clocks_throttle_reasons.hw_thermal_slowdown"
"clocks_throttle_reasons.sw_thermal_slowdown"   <- the one mistyped as "sw_thermal"
```

`nvidia-smi` validates every field in a `--query-gpu` call before returning any row, so this one bad field name kills the *entire* combined query on any machine, any driver — which is exactly why it fails identically on both master and worker; it was never a driver-support gap. This is a straightforward typo introduced when `monitor.py` was rewritten to add throttle detection (the older `monitor1.py` never queried this field at all, so it never hit this).

It's invisible in the UI because the failure is swallowed twice: `monitor.py`'s blanket `try/except` (lines 141-150) falls back to `gpu_name="Unknown", vram_used=0, ...` with no error flag, and the frontend's `pollTelemetry()` catch block (`index.html:1826-1829`) also swallows exceptions with no `console.error`.

**Action plan:**
1. Fix the field name in `monitor.py` (both the local command args and the SSH `shell_cmd` string): `clocks_throttle_reasons.sw_thermal` → `clocks_throttle_reasons.sw_thermal_slowdown`.
2. Update the corresponding parse at `monitor.py:148` (`gpu_throttle = 'Active' in parts[6] or 'Active' in parts[7]`) if the field position shifts — it shouldn't, since it's a rename not a removal, but verify against a live run.
3. Re-run the query above after the fix to confirm it returns a CSV row instead of an error.
4. Regardless of this specific fix, harden against the next typo: have `get_stats()` include an `"error"` string in the returned dict when the primary `nvidia-smi` call's exit code is non-zero, and surface that in the UI instead of showing zeros indistinguishable from "GPU idle." Add `console.error(e)` in the `catch` block at `index.html:1826` too — right now any thrown error in `pollTelemetry()` just flips a badge to `"ERROR"` with zero diagnostic trail.


** COMPLETED **

---

## 3. Net throughput graph and tokens/sec graph aren't expandable

**Why it happens:** This one's a straightforward omission, not a logic bug. Compare the chart containers:
- Working (expandable): `<div class="... cursor-pointer" onclick="expandChart('tempChart', 'GPU Temperature (°C)')">` (`index.html:393`, same pattern at 407/421/435/449 for power, GPU util, CPU, CPU temp).
- Broken: `<div class="h-20 w-full"><canvas id="netChart"></canvas></div>` (`index.html:372`) and `<div class="h-20 w-full"><canvas id="tpsChart"></canvas></div>` (`index.html:380`) — no `cursor-pointer` class, no `onclick="expandChart(...)"`.

The `expandChart()` function itself already exists and works (it's driving the other five charts) — it's just never wired up to these two containers.

**Action plan:** Add `cursor-pointer` and `onclick="expandChart('netChart', 'Net Throughput (MB/s)')"` / `onclick="expandChart('tpsChart', 'Tokens/sec')"` to the two divs at lines 372 and 380, matching the existing pattern. Trivial fix.

---

## 4. Avg speed in the t/s graphs never resets

**Why it happens:** There is no reset path at all — it was never built. `runningAverages` (`index.html:531-536`) accumulates `prefillSpeedSum`/`genSpeedSum` and their counts forever, is persisted to `localStorage['cluster_averages']` on every response (`index.html:570`), and is reloaded on every page load (`index.html:550-556`). No function clears it and no button calls one — grep for "reset" in this area turns up nothing.

**Action plan:** The other prefil and generation t/s numbers do have code that resets them. It was just a simple omission to not have this one included. Just make sure this one gets reset at the same time, on page load, and on server kill.

---

## 5. Master logs don't show

**Why it happens:** The launch path and the log-fetch path use two different, disconnected mechanisms that don't agree:
- **Launch** (`server4.js:257-282`) starts the container with `docker compose -f docker-compose.master.yml run --rm --service-ports master-node ...`. `docker compose run` creates a **one-off container**, tagged internally with the `com.docker.compose.oneoff=True` label.
- **Log fetch** (`server4.js:422-431`, `/api/master/logs`) calls `docker compose -f docker-compose.master.yml logs --tail=50 master-node`. `docker compose logs <service>` **excludes one-off containers by design** — it's built to show logs for services started via `up`, not `run`. So this call will reliably come back empty (or with "No logs available") regardless of whether the container is actually running and producing output.
- Compounding it: the container also has a fixed `container_name: rpc-master` in `docker-compose.master.yml:3`, and runs with `--rm`, so once it stops there's nothing left to query at all.

The frustrating part: the real log data is *already flowing through the Node process* — `llamaProcess.stdout`/`stderr` are piped and handled in `handleLogs()` (`server4.js:284-318`), which currently only echoes to the server's own console (`process.stdout.write(text)`, line 286) and scans for a few keywords to drive state transitions. That live stream is never buffered anywhere the `/api/master/logs` endpoint can read it.

**Action plan:**
1. Add an in-memory ring buffer (e.g. last 500 lines) in `server4.js`, appended to inside `handleLogs()` alongside the existing keyword scanning.
2. Change `/api/master/logs` to serve that buffer directly instead of shelling out to `docker compose logs`. This sidesteps the oneoff-container/`--rm` issue entirely and is also faster (no SSH/exec round trip).
3. Optionally clear the buffer on each new `/api/start` call so stale logs from a previous run don't linger.
4. The worker logs endpoint (`server4.js:406-419`) doesn't have this problem today since it queries a separately `up`'d container over SSH — no change needed there, just don't copy this pattern to master.

---

## 6. Feature request: replace checkbox/dropdown launch params with a free-text arg box + named, per-model saved configs

Not a bug, but flagging the current shape so the rebuild is scoped correctly. Today, launch config is built field-by-field in the DOM (`server-cache-k`, `server-cache-v`, `mtp-toggle`, `reasoning-preserve-toggle`, `server-verbosity`, `rpc-toggle`, etc. — `index.html:100-153`) and assembled into a flag list with a growing `if (config.x) args.push(...)` chain in `server4.js:262-280`. `todo.md` already flags this exact `if/if/if` growth pattern as something to fix, so this request and that existing complaint should be solved together.

**Action plan:**
1. **Backend (`server4.js`):** Add a mode where `/api/start` accepts a raw `argString` (already-tokenized llama-server args) instead of/alongside the structured `config` object, and passes it straight to `spawn('docker', [...baseArgs, ...tokenize(argString)])`. Keep `toContainerPath()` handling for `-m` since that still needs host→container path translation.
2. **Frontend UI:** Replace the checkbox/dropdown block with a `<textarea>` for the raw arg string per model.
3. **Storage:** `localStorage`, keyed per model (e.g. `arg_configs[modelPath] = [{ name, argString, lastUsed }]`). Saving a config prompts for (or reuses) a name and stamps `lastUsed = Date.now()`.
4. **Picker modal:** Scrollable list, sourced from `arg_configs[currentModel]`, sorted by `lastUsed` descending. Selecting one populates the textarea and bumps `lastUsed` on next launch.
5. This directly resolves the `todo.md` complaint about hardcoded `if (fa)/if (cache)/if (rpc)/if (mtp)` growth — once launch is just "pass this string through," new llama.cpp flags need zero server-side changes.

---

## 7. Prefill progress bar is already built but fires unreliably

**Status:** Partially implemented, not a from-scratch feature request. Don't build this again — fix the existing wiring.

**What already exists (verify this before writing new code):**
- `server4.js:299-309` (`handleLogs`) already regexes the exact log line you pasted (`prompt processing, n_tokens = ..., progress = ..., tokens per second`) and broadcasts it over SSE as `PREFILL_PROGRESS:<progress>:<tps>:<nTokens>`.
- `index.html:800-807` already parses that SSE message and calls `handlePrefillProgress()`.
- `index.html:985-1019` (`handlePrefillProgress`) already updates a live sidebar speed readout AND a per-message progress bar (`.prefill-loading-bar-container`, markup at `index.html:1123-1129`), including percent, token count, and t/s.
- `hidePrefillLoadingBar()` (`index.html:1022-1028`) is correctly called once streaming actually starts (`index.html:1298`).

So the "feature request" in the original note is already done. The real bug is item 9's complaint that it "doesn't seem to be working" — most likely intermittently, not always.

**Why it happens (most likely cause, needs live confirmation):** `handleLogs` in `server4.js:284-322` is fed directly from `llamaProcess.stdout`'s raw `'data'` events (`server4.js:324-325`). Node delivers stdout in arbitrary chunk boundaries — a single `print_timing` log line can be split across two separate `'data'` events. `text.includes('prompt processing, n_tokens =')` (`server4.js:299`) will silently fail to match on either half if the line is split mid-string, and that sample is just dropped (no error, no retry) — the bar would visibly stall or skip, especially under high I/O load when Docker's stdout pipe fragments more.

**Action plan:**
1. Reproduce first: start a long-context prompt, watch the server4.js console (`process.stdout.write(text)` at line 286 already echoes everything) and compare it line-by-line against what `pollTelemetry`/`handlePrefillProgress` actually receives client-side (add a temporary `console.log` in the SSE `onmessage` handler for `PREFILL_PROGRESS` messages). Confirm whether samples are being dropped.
2. If confirmed: buffer partial lines in `handleLogs`. Maintain a module-level `let logBuffer = ''`, append each chunk to it, split on `'\n'`, process all complete lines, and keep the trailing incomplete fragment in `logBuffer` for the next `'data'` event. Apply this once for both `stdout` and `stderr` handlers (`server4.js:324-325`).
3. Re-test the same long-context prompt and confirm the progress bar advances smoothly through 0% → 100% with no visible stalls.

---

## 8. Master log panel — broken fetch, wrong placement, no crash indication, stale state after refresh

This section bundles four related complaints about the same UI area. Fix in this order — each step depends on the previous one working.

### 8a. The panel never shows real logs (functionality)
This is the **same root cause as item 5 above** — `/api/master/logs` (`server4.js:429-438`) shells out to `docker compose logs`, which cannot see one-off `run --rm` containers. **Do item 5's action plan first.** Nothing else in this section will look right until that's fixed, because you'll just be redesigning a panel that has no real data to show.

### 8b. Presentation — should match the "thinking" (reasoning) block style
Today `#master-logs-pre` / `#worker-logs-pre` (`index.html:188-205`) are plain `<pre>`-like `<div>`s tucked inside `#worker-ssh-controls`, which is itself nested inside the RPC card (`index.html:164-215`).

The "thinking" block you're referring to is the `.reasoning-container` pattern, e.g. `index.html:1136-1141` (template) and `index.html:2040-2045` (rendered instance): a clickable header row with a rotating `▼`/`▲` icon (`toggleReasoning()`, `index.html:961-973`) above a `fade-bottom`-masked, `max-height`-limited scrollable body that expands on click.

**Action plan:**
1. Move the two log blocks (`index.html:187-205`) out of `#worker-ssh-controls` entirely. Place them as their own section directly after the RPC card closes (`index.html:215`) and before the `<hr class="border-gray-800">` at line 224 (which currently separates hardware-config from Chat History) — i.e. below the RPC subsection, above Chat History, as requested.
2. Restyle each block to reuse the reasoning-container markup shape: a header `<div>` with `cursor-pointer`, `onclick` toggling an icon and the body's `max-height`/`fade-bottom` class (copy the pattern of `toggleReasoning()` at `index.html:961-973` — you can reuse that exact function against these panels instead of writing a new one).
3. Keep the existing `btn-master-logs-toggle` / `btn-worker-logs-toggle` fetch-and-poll logic (`index.html:1605-1650`) as-is; only the DOM location and visual styling change.

### 8c. Should turn red when the server crashes
Right now there is no visual distinction between "cleanly stopped" and "crashed while running." Both end up as the same red "ENGINE STOPPED" badge (`index.html:849-850`), and the log panels don't change color at all.
**This depends on item 13 below** (the backend crash bug) being fixed first — right now, a real crash takes down all of `server4.js`, including the very endpoint that would tell the UI a crash happened. Once item 13 is fixed so the process reliably reaches the `'close'` handler and broadcasts state:
1. In the `'close'` handler (`server4.js:327-335`), distinguish a crash from a clean stop using the exit code/signal (`close` fires as `(code, signal)` — capture those params, currently ignored). Broadcast an `error` message when `code !== 0` or a `signal` is present and the stop wasn't user-initiated (track a simple `let stopRequested = false` flag, set `true` at the top of the `/api/stop` handler, reset it after a clean stop or a new `/api/start`).
2. In the frontend's `data.state === 'stopped'` branch (`index.html:837-875`), when `data.error` is present, add a red border/background to the master log panel's container (the same `#master-logs-pre` panel from 8b) in addition to the existing chat-box error bubble (`index.html:860-865`).

### 8d. "Engine stopped" shown after refresh even though the server is still running
This is a direct symptom of the item 13 crash bug: `server4.js` (the Node process powering the dashboard backend) died. On a fresh page load, the browser opens a new `EventSource` (`index.html:773`) against whatever `server4.js` process is currently listening — if the old one crashed and hasn't been restarted, either the connection fails outright, or (if it was restarted) `initServer()` (`server4.js:456-490`) re-detects state only by checking `docker ps -q -f name=master-node` (`server4.js:461`), which only finds the container if it's still `up`. Meanwhile the actual `llama-server` process inside Docker is untouched by a `server4.js` crash and keeps running/logging completely independently — hence "the server stayed on."
**Action plan:** No separate fix needed beyond item 13 — once `server4.js` stops crashing, this symptom goes away because the state-tracking process never dies out from under the UI. Verify by deliberately triggering the crash scenario in item 13 pre-fix, then post-fix, and confirming the SSE state stays accurate across a page refresh in both cases (pre-fix should reproduce the bug, post-fix should not).

---

## 9. GPU throttle badge fires on harmless events, not just real thermal throttling

**Confirmed via `nvidia-smi --help-query-gpu` on this machine** (not a guess):
```
"clocks_throttle_reasons.hw_slowdown" ...
 HW Slowdown (...) is engaged. This is an indicator of:
 HW Thermal Slowdown: temperature being too high
 [or] HW Power Brake Slowdown: External Power Brake Assertion (e.g. by the system power supply)

"clocks_throttle_reasons.sw_thermal_slowdown" ...
 SW Thermal capping ... because GPU temperature is higher than Max Operating Temp.
```
`hw_slowdown` is a **combined** flag — it goes `Active` for either real thermal throttling OR a momentary external power-brake event (common under transient load spikes on a shared/marginal PSU rail, and mostly harmless). `monitor.py:286` treats it identically to the genuinely-thermal-only `sw_thermal_slowdown`:
```python
gpu_throttle = 'Active' in parts[6] or 'Active' in parts[7]   # parts[6]=hw_slowdown, parts[7]=sw_thermal_slowdown
```
So a brief power-brake blip flips the same "throttling" flag as real overheating — this is exactly why the badge flashes red at a perfectly safe 59°C.

**Action plan:**
1. In `monitor.py`, query the more granular fields instead of just the two currently requested: add `clocks_throttle_reasons.sw_power_cap`, `clocks_throttle_reasons.hw_thermal_slowdown`, `clocks_throttle_reasons.hw_power_brake_slowdown` to the `--query-gpu` string (both the local command at `monitor.py:230` and the SSH `shell_cmd` string at `monitor.py:157`). Note `hw_thermal_slowdown` is the specific thermal-only sub-reason of `hw_slowdown` — prefer it over the combined flag for the "is this actually thermal" question.
2. Return a structured `throttle_reasons: []` list from `get_stats()` (`monitor.py:366-375`) instead of (or alongside) the single boolean `gpu_throttle`, e.g. `["hw_thermal_slowdown", "sw_power_cap"]`, built by checking each parsed field for `'Active'`.
3. In `index.html`, only add the red pulsing card style (`index.html:1825-1836`) when a **thermal** reason (`hw_thermal_slowdown` or `sw_thermal_slowdown`) is present — treat `sw_power_cap`/`hw_power_brake_slowdown` as informational, not alarming.
4. Add a small badge row above the GPU Temp chart (`index.html:431-443`, inside `#card-gpu-temp`) that renders one badge per active reason string from step 2, e.g. "SW Power Cap", "HW Thermal". Color each badge to match the GPU it came from — master badges use the yellow accent already used for master elsewhere (`border-yellow-400`, see `index.html:436`), worker badges use the existing red accent (`border-red-400`, `index.html:437`), keeping the same master=yellow/worker=red convention used throughout this card.

---

## 10. Worker CPU stats reportedly missing

**Confidence: lower — reasoned from code, not reproduced against the actual worker.** The code path looks structurally sound, so if it's truly blank, the bug is likely environmental rather than a logic error. Needs a live check before writing a fix.

**What the code currently does:** For the worker (SSH) path, `monitor.py:156-173` runs `top -bn1` and `cat /proc/stat` on the remote host and sections the combined output by `===` markers (`monitor.py:182-208`). `cpu_util` is parsed from the `top` output first, falling back to `/proc/stat` deltas (`monitor.py:325-336`); `cpu_name` is parsed from `/proc/cpuinfo` (`monitor.py:338-341`). The frontend only renders worker CPU numbers when `workerReporting` is true (`index.html:1751`, gated on `stats.worker.gpu_util !== undefined`), which doesn't depend on CPU data at all — so if the GPU query succeeds but CPU parsing silently fails, you'd see `--%` in place of numbers rather than the whole card disappearing.

**Action plan (diagnose before fixing):**
1. Hit `monitor.py`'s `/stats` endpoint directly with the worker's SSH string while the worker is up (`curl -X POST http://localhost:8081/stats -d '{"worker_ssh":"kyle4090@..."}'`) and inspect the raw JSON for `stats.worker.cpu_util` / `cpu_name`.
2. If those fields are `0.0` / `"Unknown CPU"`: the `top -bn1` output format on the worker host doesn't match the `"Cpu(s)"` string match at `monitor.py:328`, or `/proc/cpuinfo` doesn't have a `"model name"` line (common on ARM or some minimal images) — check what `top -bn1` and `/proc/cpuinfo` actually look like on that specific worker via a manual SSH session, then adjust the parser at `monitor.py:325-341` to match.
3. If the fields are missing/absent from the JSON entirely, or the whole worker object is empty: the SSH command itself is likely failing (timeout, host key issue, `top` not installed) — check the `except Exception` fallback at `monitor.py:209-219`, which swallows the real error. Temporarily log the exception there to see what's actually failing.

---

## 11. Per-response combined graph — styling and content gaps

These are all about the small hardware chart embedded in each assistant message bubble (`.hw-chart-container`, markup at `index.html:1132-1133`, built in `pollTelemetry` at `index.html:1908-1932`) — referred to as the "answer" graph. This is a **different chart** from the sidebar's `netChart`/`tpsChart` — don't confuse the two when editing.

**Action plan:**
1. **Net MB/s line color:** currently `rgba(52,211,153,0.8)` (green/teal) at `index.html:1919`. Change to match the sidebar `netChart`'s blue, `rgba(96, 165, 250, 1)` (same color used at `index.html:715`).
2. **Add Tokens/Sec as its own dataset:** push a `genTps`/generation-speed value into the `responseMetrics` snapshot object (`index.html:1888-1897`) each poll tick, and add a corresponding `Chart.js` dataset at `index.html:1914-1920`. Per the request, this line's color should track which phase is active (prefill/thinking/answering) rather than being a fixed color — read the current phase from the existing timeline state (`activeTimelineEls`/the phase bar built by `buildStaticTimelineSvg`/`drawPrefillSparkline`, `index.html:1034-1065` and surrounding) and set `borderColor` dynamically per update, matching whatever color that phase bar segment already uses.
3. **GPU Util and CPU Util:** also missing from this chart entirely — add them the same way as step 2, reusing the values already being polled in `pollTelemetry` (`stats.master.gpu_util`, `stats.master.cpu_util`), since they're already available in-scope at the point `responseMetrics.push(snap)` runs (`index.html:1898`).
4. **Taller graph:** increase the fixed `height:100px` inline style on `.hw-chart-container` (`index.html:1132`).
5. **Click-to-expand:** unlike the sidebar charts (which all wire `cursor-pointer` + `onclick="expandChart(...)"`, e.g. `index.html:442`), this per-message chart has no such wiring at all. Since `hwChartInst` is destroyed/recreated per message (`index.html:1452`), `expandChart()` (used for the sidebar's persistent chart instances) can't be reused as-is — it expects a stable chart instance to clone data from. Either give `expandChart()` an overload that takes a live `Chart` instance directly instead of looking one up by a fixed global name, or wire a simpler one-off modal that just re-renders `responseMetrics` into `#expandedChartCanvas` on click.

---

## 12. Continuous/live telemetry independent of chat activity + monitoring/chat toggle

This is the largest ask in the raw notes and touches architecture, not just a bug fix. Treat it as its own project, built in this order — each step is usable on its own even if you stop partway.

**Why the current design can't do this today:** The "answer" graph (`hw-chart-container`/`hwChartInst`, see item 11) only exists for the lifetime of one assistant message bubble — it's created in `submitPrompt()` when a new bubble is built (`index.html:1168-1169`) and torn down the moment that response finishes (`index.html:1452`). There is no persistent "live telemetry" chart independent of an in-flight chat turn. Similarly, `handlePrefillProgress()` (item 7) only updates UI elements that live inside `#active-ast` (`index.html:1002`, `1023`) — a bubble that only exists while *this dashboard* is the one that sent the prompt.

However, the underlying log stream already carries everything needed: `server4.js`'s `handleLogs()` (`server4.js:284-322`) is attached to the same Docker container's stdout regardless of which client (this dashboard, a VS Code extension, opencode, curl, anything) sent the request that produced those log lines — llama-server logs every request it processes, no matter the caller. So prefill-progress parsing already works for externally-triggered requests too; it's the **client-side consumption** that's hard-wired to a specific chat bubble, not the server-side capture.

**Action plan:**
1. **Server-side: also parse the generation/eval-phase line.** `handleLogs()` currently only parses the `prompt processing, n_tokens =` line (`server4.js:299-309`). Add a second regex for the eval-time line you pasted (`eval time = ... ms / ... tokens (... ms per token, ... tokens per second)`) and broadcast a new SSE event type, e.g. `GEN_PROGRESS:<tps>:<nTokens>`, so generation speed is observable independent of any specific chat bubble too.
2. **Client-side: decouple telemetry state from the chat bubble.** Introduce a persistent, always-alive tracker (not scoped to `#active-ast`) that both `PREFILL_PROGRESS` and the new `GEN_PROGRESS` messages update unconditionally — regardless of whether the current page has an active submitted prompt. This becomes the single source of truth that both the chat view AND the new monitoring view (step 4) read from.
3. **Persistent combined graph.** Take the existing `hw-chart-container`/`hwChartInst` logic (item 11) and lift it out of the per-message template into a standalone, always-mounted chart fed by `pollTelemetry`'s existing `setInterval` loop (`index.html:1943-1947`, already runs continuously regardless of chat state) plus the decoupled tracker from step 2. This same persistent chart instance is what step 4's monitoring view displays, and what you reuse under the boot overlay per the original request.
4. **Monitoring/Chat toggle.** Add a toggle control at the top of the chat panel (near `index.html:241` where `<main>` starts). It should swap the visibility of `#chat-container` + the input bar (`index.html:242-306`) against a new "monitoring view" panel showing the persistent chart from step 3 plus the existing sidebar telemetry cards. Since the sidebar telemetry (`#telemetry-sidebar`, `index.html:310`) already updates continuously via `pollTelemetry` independent of chat, most of the "monitoring view" content already exists — the toggle is primarily about hiding/showing the chat-specific DOM, not building new data plumbing.
5. **Boot overlay showing the combined graph underneath.** Add a `.hw-chart-container`-equivalent element inside `#boot-overlay` (`index.html:244-274`), mounted the same way as step 3's persistent chart, so it's populated even while a model is still loading (useful since `pollTelemetry` keeps running the whole time regardless of `serverState`).

---

## 13. Backend crash: `server4.js` dies on a null `llamaProcess` dereference

**High confidence — traced precisely through the code, not yet reproduced live; verify by triggering the scenario below.** This is very likely the root cause behind item 8's "says engine stopped after refresh even though the server is clearly still running," and probably also explains the crash trace you pasted (`TypeError: Cannot read properties of null (reading 'stdout')` at `server4.js:328`).

**Why it happens:** `llamaProcess` is a single shared, mutable variable. Two different code paths null it out **before** the child process's own `'close'` event has necessarily fired:
- The error-branch inside `handleLogs()` (`server4.js:310-321`): on detecting `'abort'`/`'error:'`/OOM text in the logs, it calls `llamaProcess.kill(); llamaProcess = null;` (`server4.js:313-314`) immediately, synchronously — but killing a process is asynchronous; the OS hasn't necessarily reaped it yet.
- The `/api/stop` route (`server4.js:352-355`): same pattern — `llamaProcess.kill(); llamaProcess = null;` runs immediately when the user clicks "Kill", well before the process has actually exited.

Some time later, when the killed process *does* actually terminate, Node fires the `'close'` event that was registered back when the process was spawned (`server4.js:327-335`). That handler unconditionally does `if (llamaProcess.stdout) ...` (`server4.js:328`) — but by now `llamaProcess` is `null` (set by whichever of the two paths above ran first), so this throws. There is no top-level `uncaughtException` handler anywhere in `server4.js`, so this exception crashes the entire Node process — taking down the SSE endpoint, the models API, and Docker orchestration with it, while the actual `llama-server` container (already killed via `runDockerCompose('down ...')` in the error-branch, or independently in `/api/stop`) may or may not still be up depending on which path triggered it.

**Action plan:**
1. In the spawn block (`server4.js:282`), capture the child process reference into a local `const proc = llamaProcess;` right after assigning it, and have the `'close'` and `'error'` handlers (`server4.js:327-341`) close over `proc` instead of re-reading the mutable outer `llamaProcess` variable. This guarantees the handler always has a valid reference to the process it belongs to, regardless of what the outer variable has been reset to in the meantime.
2. Update line 328-329 to operate on `proc.stdout`/`proc.stderr` (which are safe to call `removeAllListeners` on even after the process has exited — only the outer `llamaProcess` variable was ever the null one).
3. Only null the shared `llamaProcess` variable (and reset `serverState`/`currentModel`/etc.) inside this same `'close'` handler — remove the redundant `llamaProcess = null` from the `handleLogs()` error-branch (`server4.js:314`) and from `/api/stop` (`server4.js:354`), so there's exactly one place that owns clearing the shared state, after the process has actually closed, not before.
4. Reproduce before/after: manually trigger the "Kill" button and confirm no crash in the server4.js console; also simulate an error-text trigger (e.g. temporarily log a fake "error:" line through the process) and confirm the same.
5. This unblocks item 8c/8d (crash-red state, stale "stopped" after refresh) — do this fix first, those next.

---

## 14. Telemetry fetch cascade on network change (`ERR_NETWORK_CHANGED`) is invisible to the user

**Why it happens:** `pollTelemetry()` (`index.html:1675-1941`) already has a `catch` block (`index.html:1935-1940`) so a single failed fetch doesn't crash anything — but it retries on every polling tick (every 0.5-2s per `setTelemetryInterval`, `index.html:1943-1947`) with no backoff, so a sustained network hiccup (e.g., the OS switching Wi-Fi networks, which is what `ERR_NETWORK_CHANGED` specifically indicates) produces a rapid, sustained flood of console errors — what you saw as a "cascade." The only user-visible effect is the small `#worker-status-badge` flipping to "ERROR" (`index.html:1937-1939`); nothing in the main UI actually communicates "telemetry is currently down," which is why it read as a silent freeze rather than a clear, explained outage.

Separately: this is unrelated to the `llamaProcess`/Node crash in item 13 — `pollTelemetry` fetches `monitor.py` on port 8081 directly from the browser (`index.html:1679`), not through `server4.js` at all, so a network blip here doesn't imply anything about the model server's health, and vice versa. Don't conflate the two when debugging — check which port/process an error trace points to first.

**Action plan:**
1. Add a consecutive-failure counter in the `catch` block. After N consecutive failures (e.g. 3), surface a visible banner/badge in the main telemetry sidebar (not just the small worker badge) saying telemetry polling has failed and for how long, distinct from any engine-state messaging.
2. Add a simple backoff (e.g. double the interval up to some cap) while failures persist, to stop spamming the console and the network during a real outage; reset to the normal configured interval on the first success.
3. This is purely a client-side resilience/visibility fix — no server changes needed.

---

## 15. Feature request: query historical CSV for avg/median load time and expected t/s per config

**Prerequisite bug — fix this first, or the feature has no real data to query:** `index.html:777` declares `let currentLoadTime = "N/A";` and it is **never reassigned anywhere in the file**. It's sent as-is to `/api/log` at `index.html:1196` (`loadTime: currentLoadTime`), meaning the CSV's `Load Time` column (`server4.js:133`, `CSV_HEADERS`) has been recording the literal string `"N/A"` for every single row logged so far. Meanwhile `server4.js` already computes and broadcasts a real value: `finalLoadTime` is calculated in `handleLogs()` (`server4.js:293-296`) and sent in every SSE payload (`broadcastState`, `server4.js:36`) — but the frontend's SSE handler never reads `data.finalLoadTime` into `currentLoadTime`. Fix this first:
1. In the `eventSource.onmessage` handler (`index.html:788` onward), wherever the `'ready'`/model-loaded branch is handled (around `index.html:883-897`), set `currentLoadTime = data.finalLoadTime;` so it's captured once the model actually finishes loading.
2. Confirm going forward: launch a model, check `/api/logs/csv` (or the "View Logs (CSV)" modal, `index.html:2181-2213`) and verify the `Load Time` column now has a real number instead of `N/A`. Historical rows already logged as `N/A` are unrecoverable and should just be excluded/ignored by any query logic you add next — don't try to backfill them.

**Then, the actual feature — factor by model, RPC on/off, and transport (Thunderbolt vs Wi-Fi):**
The CSV already has every column needed for grouping: `Model` (`config.model`, not the full path — verify this is a stable, comparable key across rows), `RPC` (boolean-ish), and `Transport` (`WiFi`/`TB4` from `#transport-type`, `index.html:174-177`) — see `CSV_HEADERS` at `server4.js:133` and the row-building logic at `server4.js:221`.

**Action plan:**
1. Add a new read-only endpoint, e.g. `GET /api/logs/summary`, in `server4.js` (alongside the existing `/api/logs/csv` handler at `server4.js:229-238`). It should read `CSV_FILE`, parse rows, group by `(Model, RPC, Transport)`, and compute average and median of the `Load Time`, `Prompt Tok/s`, and `Gen Tok/s` columns per group — filter out rows where `Load Time` is `N/A` (pre-fix rows, and any row where the run was aborted before load finished).
2. On the client, when a model + RPC + transport combination is selected in the launch config UI (`#model-select`, `#rpc-toggle`, `#transport-type`), fetch this summary and show the matching group's numbers somewhere near the boot button — e.g. "Expected load: ~42s (median of 6 runs) · ~85 t/s gen" — so the user has a baseline before clicking "Boot Cluster."
3. Keep this additive: if no historical rows match the current combination (new model, or a transport never tried before), show nothing/"No history yet" rather than a misleading zero or average-of-nothing.
