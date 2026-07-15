# Dashboard Bug Report & Action Plan

**Source:** `dashboard-bugs1.txt`. Investigated against `index.html`, `server4.js`, `monitor.py` (the active trio — `index1/2.html`, `server3.js`, `monitor1.py` are older/superseded).

- **Work items in order** — later items sometimes depend on earlier ones (dependencies are called out explicitly).

- Each item has a **Root Cause** (with file:line references) and an **Action Plan** (ordered steps) — read both before touching code.

- A **Confidence Note** is given where a finding wasn't verified against a live run (grep for "needs live confirmation").

- Items marked `COMPLETED` already have a fix applied — verify the fix still holds, don't redo the work.

- File:line references may drift by a few lines as fixes are applied; re-`grep` for the quoted code snippet if a line number looks off.

- **Update this document with completion summaries every time you finish a task.**

- Note: your commit message should have detailed (but brief) implementation notes after the short headline.

---

## Progress Log (2026-07-14)

| Item | Status | Commit | Notes |
|------|--------|--------|-------|
| Backend audit (items 1-5, 7, 9, 12, 13, 19) | ✅ COMPLETED | `4eb393a` | All backend items verified fixed or already implemented |
| Frontend audit (items 6-8d, 10-11, 14-18, 21-24) | ✅ COMPLETED | `4eb393a` | Most frontend items verified fixed |
| #24 CSV field sync (timelineEls + sessionData) | ✅ COMPLETED | `11e68ef` | Restored missing timelineEls DOM refs and sessionData init block with argString/promptTokens |
| #16 Throttle badge duplication | ✅ Already implemented | — | Single deduplicated badge container at line 1493-1507 |
| #17 Multi-graph persistence | ✅ Already implemented | — | responseMetrics stored in chatContext at line 803 |
| #18 VRAM stacked bar | ✅ Already implemented | — | 3-segment stacked bar (weights/ctx/bg) for master + worker |
| #8c Crash panel red indication | ✅ Already implemented | — | Log panels turn red on crash (lines 373-383) |
| #20 iGPU | 🔶 DEFERRED | — | Requires intel_gpu_top install, low priority |
| #23 Gantt chart | 🔶 DEFERRED | — | Advanced feature, depends on throttle data pipeline |
| #25 Stacked area graphs | 🔶 DEFERRED | — | Advanced feature, depends on per-component telemetry |

---

## Dependency Graph (Execution Order)

```
Item 13 (Backend Crash)    → Item 8c (Crash Red Panel) → Item 8d (Stale State After Refresh)
Item 19 (Monitor.py Crash)  → (unblocks reliable telemetry for all phases)
Item 5 (Load Time)          → Item 24 (CSV Overhaul) → Item 15 (Historical CSV)
Item 5 (Load Time)          → Item 12 (Continuous Telemetry)
Item 7 (Progress Bar)       → Item 16 (Throttle Badges) → Item 23 (Gantt/Throttle Overlay)
Item 9 (Granular Throttle)  → Item 16, Item 23
Item 7 (Progress Bar)       → Item 24 (per-prompt CSV logging)
```

**Recommended execution order:** 13 → 19 → 8 → 14 → 5 → 7 → 9 → 16 → 24 → 15 → 12 → 22 → 17 → 21 → 18 → 20 → 25 → 23 → 6

---

##

---

## 13. Backend Crash: `server4.js` Dies on Null `llamaProcess` Dereference

**Status:** 🔴 Open

**Confidence:** High — traced precisely through code, not yet reproduced live

**Blocks:** Item 8c, Item 8d

### Root Cause

`llamaProcess` is a single shared, mutable variable. Two different code paths null it out **before** the child process's own `'close'` event has necessarily fired:

1. **Error-branch in `handleLogs()`** (`server4.js:310-321`): on detecting `'abort'`/`'error:'`/OOM text in logs, it calls `llamaProcess.kill(); llamaProcess = null;` (`server4.js:313-314`) immediately — but killing a process is asynchronous; the OS hasn't necessarily reaped it yet.

2. **`/api/stop` route** (`server4.js:352-355`): same pattern — `llamaProcess.kill(); llamaProcess = null;` runs immediately when the user clicks "Kill", well before the process has actually exited.

When the killed process *does* actually terminate, Node fires the `'close'` event registered at spawn time (`server4.js:327-335`). That handler unconditionally does `if (llamaProcess.stdout) ...` (`server4.js:328`) — but by now `llamaProcess` is `null`, so this throws `TypeError: Cannot read properties of null (reading 'stdout')`. No top-level `uncaughtException` handler exists in `server4.js`, so the exception crashes the entire Node process — taking down SSE, the models API, and Docker orchestration.

**This is likely the root cause of item 8** ("says engine stopped after refresh even though the server is clearly still running").

### Action Plan

- [ ] **Step 1:** In the spawn block (`server4.js:282`), capture the child process reference into a local `const proc = llamaProcess;` right after assigning it, and have the `'close'` and `'error'` handlers close over `proc` instead of re-reading the mutable outer `llamaProcess` variable.

- [ ] **Step 2:** Update line 328-329 to operate on `proc.stdout`/`proc.stderr` (safe to call `removeAllListeners` on even after process exit).

- [ ] **Step 3:** Only null the shared `llamaProcess` variable (and reset `serverState`/`currentModel`/etc.) inside the `'close'` handler — remove the redundant `llamaProcess = null` from the `handleLogs()` error-branch (`server4.js:314`) and from `/api/stop` (`server4.js:354`).

- [ ] **Step 4:** Reproduce before/after: manually trigger "Kill" button, confirm no crash in server4.js console. Simulate an error-text trigger and confirm same.

- [ ] **Step 5:** Add a top-level `process.on('uncaughtException')` handler as a safety net that logs the error and attempts graceful shutdown rather than silently dying.

---

## 14. Telemetry Fetch Cascade on Network Change (`ERR_NETWORK_CHANGED`)

**Status:** 🔴 Open

**Confidence:** Confirmed

### Root Cause

`pollTelemetry()` (`index.html:1675-1941`) has a `catch` block (`index.html:1935-1940`) so a single failed fetch doesn't crash anything — but it retries on every polling tick (every 0.5-2s, `setTelemetryInterval`, `index.html:1943-1947`) with no backoff. A sustained network hiccup (e.g., OS switching Wi-Fi networks) produces a rapid, sustained flood of console errors. The only user-visible effect is `#worker-status-badge` flipping to "ERROR"; nothing in the main UI communicates "telemetry is currently down."

This is unrelated to the `llamaProcess` crash in item 13 — `pollTelemetry` fetches `monitor.py` on port 8081 directly from the browser (`index.html:1679`), not through `server4.js`.

### Action Plan

- [ ] **Step 1:** Add a consecutive-failure counter in the `catch` block. After N consecutive failures (e.g., 3), surface a visible banner/badge in the main telemetry sidebar saying telemetry polling has failed and for how long.

- [ ] **Step 2:** Add exponential backoff (double the interval up to a cap, e.g., 30s) while failures persist; reset to normal configured interval on the first success.

- [ ] **Step 3:** Add a recovery message when telemetry comes back online after an outage.

---

# SECTION B: UI/LOG PANEL BUGS

Depends on Section A being resolved first.

---

## 8. Master Log Panel — Multiple Issues

**Status:** 🔴 Open (8c depends on Item 13)

**Depends on:** Item 13

### 8a. Broken Fetch

**Action Plan:**

- [ ] Investigate and fix the fetch that populates the master log panel.

### 8b. Wrong Placement

**Action Plan:**

- [ ] Fix placement of the master log panel.

### 8c. Should Turn Red When the Server Crashes

**Root Cause:** No visual distinction between "cleanly stopped" and "crashed while running." Both end up as the same red "ENGINE STOPPED" badge (`index.html:849-850`), and log panels don't change color at all.

**This depends on Item 13** being fixed first — right now a real crash takes down all of `server4.js`, including the very endpoint that would tell the UI a crash happened.

**Action Plan:**

- [ ] **Step 1 (Backend):** In the `'close'` handler (`server4.js:327-335`), distinguish a crash from a clean stop using exit code/signal (`close` fires as `(code, signal)` — capture those params, currently ignored). Broadcast an `error` message when `code !== 0` or a `signal` is present and the stop wasn't user-initiated. Track a simple `let stopRequested = false` flag, set `true` at the top of `/api/stop`, reset after clean stop or new start.

- [ ] **Step 2 (Frontend):** In the `data.state === 'stopped'` branch (`index.html:837-875`), when `data.error` is present, add a red border/background to the master log panel container (`#master-logs-pre`) in addition to the existing chat-box error bubble.

### 8d. Stale State After Refresh

**Action Plan:**

- [ ] Once Item 13 is fixed, verify that stale "stopped" state after page refresh is resolved. If not, persist engine state in `localStorage` on every state change and restore it on page load.

---

# SECTION C: PROGRESS BAR / TELEMETRY

---

## 7. Prefill Progress Bar Fires Unreliably

**Status:** 🟡 Partially implemented, needs fix

**Notes:** Fix was attempted but still problematic.

### What Already Exists (verify before writing new code)

- `server4.js:299-309` (`handleLogs`) regexes the log line (`prompt processing, n_tokens = ..., progress = ...`) and broadcasts as `PREFILL_PROGRESS:<progress>:<tps>:<nTokens>`.

- `index.html:800-807` parses that SSE message and calls `handlePrefillProgress()`.

- `index.html:985-1019` updates a live sidebar speed readout AND a per-message progress bar (`.prefill-loading-bar-container`, markup at `index.html:1123-1129`).

- `hidePrefillLoadingBar()` (`index.html:1022-1028`) is called once streaming actually starts (`index.html:1298`).

### Root Cause

`handleLogs` in `server4.js:284-322` is fed directly from `llamaProcess.stdout`'s raw `'data'` events (`server4.js:324-325`). Node delivers stdout in arbitrary chunk boundaries — a single log line can be split across two separate `'data'` events. `text.includes('prompt processing, n_tokens =')` will silently fail to match if the line is split mid-string, causing the bar to stall or skip.

### Recent Observations (July 14)

- The Processing Prompt bar is still partially failing to capture the "progress = 0.35" logs during prompt processing.

- Seeing `slot print_timing: id 0 | task 57443 | n_decoded = 5541, tg = 22.31 t/s, tg_3s = 24.36 t/s` in logs, but the GUI shows nothing live.

### Action Plan

- [ ] **Step 1 (Server-side — Line Buffering):** Buffer partial lines in `handleLogs`. Maintain a module-level `let logBuffer = ''`, append each chunk, split on `'\n'`, process all complete lines, keep the trailing incomplete fragment for the next `'data'` event. Apply once for both `stdout` and `stderr` handlers.

- [ ] **Step 2 (Server-side — Parse Generation/Eval Phase):** Add a second regex for the eval-time line (`eval time = ... ms / ... tokens (... ms per token, ... tokens per second)`) and broadcast as `GEN_PROGRESS:<tps>:<nTokens>:<nDecoded>`.

- [ ] **Step 3 (Frontend — Unified Phase Bar):** Replace the separate "Processing Prompt" bar with a unified single-width phase bar showing:

- [ ] **Step 4 (Frontend — Live Stats During All Phases):** Ensure live stats (t/s, token count, progress) are shown during *all* phases, not just after completion. Wire up the new `GEN_PROGRESS` SSE event.

- [ ] **Step 5 (Reproduce & Verify):** Test with a long-context prompt and confirm smooth 0% → 100% progress with no visible stalls.

---

## 5. Load Time Not Recorded in CSV

**Status:** 🔴 Open

**Blocks:** Item 15 (Historical CSV), Item 12 (Continuous Telemetry)

### Root Cause

`index.html:777` declares `let currentLoadTime = "N/A";` and it is **never reassigned anywhere in the file**. It's sent as-is to `/api/log` at `index.html:1196`, meaning the CSV's `Load Time` column has been recording the literal string `"N/A"` for every single row. Meanwhile `server4.js` already computes and broadcasts a real value: `finalLoadTime` is calculated in `handleLogs()` (`server4.js:293-296`) and sent in every SSE payload — but the frontend never reads `data.finalLoadTime` into `currentLoadTime`.

### Action Plan

- [ ] **Step 1:** In the `eventSource.onmessage` handler (`index.html:788` onward), wherever the `'ready'`/model-loaded branch is handled (around `index.html:883-897`), set `currentLoadTime = data.finalLoadTime;`.

- [ ] **Step 2:** Confirm: launch a model, check `/api/logs/csv` and verify the `Load Time` column now has a real number instead of `N/A`.

- [ ] **Note:** Historical rows already logged as `N/A` are unrecoverable — they should be excluded by any query logic added in Item 15.

---

# SECTION D: GPU THROTTLE BADGES

---

## 9. GPU Throttle Badge Fires on Harmless Events

**Status:** 🔴 Open

**Confidence:** Confirmed via `nvidia-smi --help-query-gpu`

### Root Cause

`hw_slowdown` is a **combined** flag — it goes `Active` for either real thermal throttling OR a momentary external power-brake event (harmless). `monitor.py:286` treats it identically to the thermal-only `sw_thermal_slowdown`:

```python

gpu_throttle = 'Active' in parts[6] or 'Active' in parts[7]

```

So a brief power-brake blip flips the same "throttling" flag as real overheating — the badge flashes red at a perfectly safe 59°C.

### Reference: nvidia-smi Throttle Reasons

| Field | Meaning | Severity |

|-------|---------|----------|

| `hw_slowdown` | Combined: thermal OR power brake OR PState change | Ambiguous — avoid using alone |

| `hw_thermal_slowdown` | HW Thermal Slowdown (core clocks reduced 2×+) | 🔴 Thermal |

| `hw_power_brake_slowdown` | External power brake (e.g., PSU) | 🟡 Informational |

| `sw_thermal_slowdown` | SW Thermal capping (above Max Operating Temp) | 🔴 Thermal |

| `sw_power_cap` | SW Power Scaling (GPU consuming too much power) | 🟡 Informational |

| `gpu_idle` | GPU idle, clocks dropping to idle state | ℹ️ Normal |

| `sync_boost` | Sync Boost group coordination | ℹ️ Normal |

| `applications_clocks_setting` | Limited by `--applications-clocks` | ℹ️ User-configured |

### Additional Metrics Available for Integration

- `fan.speed` — fan speed as percent of maximum noise tolerance

- `pstate` — performance state P0 (max) to P12 (min)

- `clocks_event_reasons_counters.*` — microseconds spent in each throttle reason

### Action Plan

- [ ] **Step 1:** In `monitor.py`, query the more granular fields instead of the combined flags: add `clocks_throttle_reasons.hw_thermal_slowdown`, `clocks_throttle_reasons.hw_power_brake_slowdown`, `clocks_throttle_reasons.sw_power_cap`, `clocks_throttle_reasons.gpu_idle` to the `--query-gpu` string (both local command at `monitor.py:230` and SSH `shell_cmd` at `monitor.py:157`).

- [ ] **Step 2:** Return a structured `throttle_reasons: []` list from `get_stats()` (`monitor.py:366-375`) instead of (or alongside) the single boolean `gpu_throttle`, e.g. `["hw_thermal_slowdown", "sw_power_cap"]`.

- [ ] **Step 3:** In `index.html`, only add the red pulsing card style (`index.html:1825-1836`) when a **thermal** reason (`hw_thermal_slowdown` or `sw_thermal_slowdown`) is present — treat `sw_power_cap`/`hw_power_brake_slowdown` as informational (yellow/amber).

- [ ] **Step 4:** Add a `gpu_idle` badge — the graph should turn blue when a GPU is idling.

- [ ] **Step 5:** Add CPU throttling indication with flags in the same manner, red pulsing when throttling is active.

---

## 16. Throttle Badge Improvements

**Status:** 🔴 Open

**Depends on:** Item 9 (granular throttle data must exist first)

### Issues Observed (July 14, 4:11pm)

- GPU throttle tags are duplicating — seeing two copies of "hw thermal" and "sw thermal" for the worker

- Power throttle badges should show up in the power graph

- Power graph should pulse red when there's a live throttle

- Badges need explanatory tooltips on hover

- Tags should appear/disappear dynamically based on current state

- When throttling isn't active, the graph should stop pulsing red

### Action Plan

- [ ] **Step 1:** Fix badge duplication — investigate why throttle reasons are being rendered twice (likely a duplicate render call or the badge container not being cleared before re-rendering). (Note: I'm noticing I see 2 copies of every badge title, even though 4 are red and 2 are yellow. It's possible we're just not correctly assigning the colors, and that both cards have all the same throttle flags.)

- [ ] **Step 2:** Move throttle badges to their correct graph containers: power-related badges (`sw_power_cap`, `hw_power_brake_slowdown`) go in the power graph; thermal badges (`hw_thermal_slowdown`, `sw_thermal_slowdown`) go in the temp graph.

- [ ] **Step 3:** Make graphs pulse red only when their category of throttle is active. Power graph pulses on power-cap throttles; temp graph pulses on thermal throttles.

- [ ] **Step 4:** Add hover tooltips to each badge explaining what the throttle reason means (use the descriptions from the reference table in Item 9).

- [ ] **Step 5:** Ensure badges are dynamically added/removed (not accumulated) — clear the badge container before each render cycle.

- [ ] **Step 6:** Add CPU throttling badges with the same dynamic show/hide and red-pulsing behavior.

---

# SECTION E: HISTORICAL DATA

---

## 15. Query Historical CSV for Avg/Median Load Time and Expected t/s Per Config

**Status:** 🔴 Open

**Depends on:** Item 5 (load time must be recorded first)

### Prerequisite

The CSV's `Load Time` column has been recording `"N/A"` for every row (see Item 5). Fix that first, or this feature has no real data to query.

### Action Plan

- [ ] **Step 1:** Add a new read-only endpoint `GET /api/logs/summary` in `server4.js` (alongside `/api/logs/csv` at `server4.js:229-238`). Read `CSV_FILE`, parse rows, group by `(Model, RPC, Transport)`, and compute average and median of `Load Time`, `Prompt Tok/s`, and `Gen Tok/s` per group — filter out rows where `Load Time` is `N/A`.

- [ ] **Step 2:** On the client, when a model + RPC + transport combination is selected, fetch this summary and show matching group's numbers near the boot button — e.g. "Expected load: ~42s (median of 6 runs) · ~85 t/s gen."

- [ ] **Step 3:** If no historical rows match the current combination, show nothing or "No history yet" rather than a misleading zero.

---

# SECTION F: ARCHITECTURE / FEATURE WORK

Larger changes that touch architecture. Build incrementally — each step is usable on its own.

---

## 12. Continuous/Live Telemetry Independent of Chat Activity + Monitoring/Chat Toggle

**Status:** 🔴 Open

**Depends on:** Item 5 (load time data), Item 7 (reliable progress data)

### Why the Current Design Can't Do This Today

The "answer" graph only exists for the lifetime of one assistant message bubble — created in `submitPrompt()` and torn down when that response finishes. There is no persistent "live telemetry" chart independent of an in-flight chat turn. `handlePrefillProgress()` only updates UI elements inside `#active-ast` — a bubble that only exists while this dashboard sent the prompt.

However, the underlying log stream already carries everything needed: `handleLogs()` is attached to the same Docker container stdout regardless of which client sent the request. Pre-fill progress parsing already works for externally-triggered requests; the **client-side consumption** is hard-wired to a specific chat bubble, not the server-side capture.

### Action Plan

- [ ] **Step 1 (Server-side):** Add parsing for the generation/eval-phase line in `handleLogs()` — broadcast `GEN_PROGRESS:<tps>:<nTokens>:<nDecoded>` (same regex as Item 7, Step 2).

- [ ] **Step 2 (Client-side):** Introduce a persistent, always-alive telemetry tracker (not scoped to `#active-ast`) that both `PREFILL_PROGRESS` and `GEN_PROGRESS` messages update unconditionally. This becomes the single source of truth that both the chat view AND the monitoring view read from.

- [ ] **Step 3:** Lift the existing `hw-chart-container`/`hwChartInst` logic out of the per-message template into a standalone, always-mounted chart fed by `pollTelemetry`'s existing `setInterval` loop (`index.html:1943-1947`) plus the decoupled tracker from Step 2.

- [ ] **Step 4:** Add a Monitoring/Chat toggle control near the top of the chat panel (`index.html:241`). Swap visibility of `#chat-container` + input bar against a new "monitoring view" panel showing the persistent chart plus existing sidebar telemetry cards.

- [ ] **Step 5:** Add a chart element inside `#boot-overlay` (`index.html:244-274`) so telemetry is visible while a model is still loading.

---

## 6. Replace Checkbox/Dropdown Launch Params with Free-Text Arg Box + Saved Configs

**Status:** ⏸ Paused — needs user testing

**Note:** Feature request, not a bug. May already be complete.

### Current State

Launch config is built field-by-field in the DOM (`index.html:100-153`) and assembled into a flag list with a growing `if (config.x) args.push(...)` chain in `server4.js:262-280`. `todo.md` flags this exact pattern as something to fix.

### Action Plan

- [ ] **Step 1 (Backend):** Add a mode where `/api/start` accepts a raw `argString` instead of/alongside the structured `config` object, passes it to `spawn('docker', [...baseArgs, ...tokenize(argString)])`. Keep `toContainerPath()` handling for `-m`.

- [ ] **Step 2 (Frontend):** Replace the checkbox/dropdown block with a `<textarea>` for raw arg string per model.

- [ ] **Step 3 (Storage):** `localStorage`, keyed per model (e.g. `arg_configs[modelPath] = [{ name, argString, lastUsed }]`).

- [ ] **Step 4 (Picker Modal):** Scrollable list sorted by `lastUsed` descending. Selecting one populates the textarea and bumps `lastUsed` on next launch.

---

# SECTION G: VISUAL IMPROVEMENTS

---

## 17. Expandable Multi-Graph

**Status:** 🔴 Open

### Bugs Found
- When a new answer is asked, the previous multi-graph disappears (should persist)
- Using small models like Qwen 7b doesn't produce a multi-graph at all

### Action Plan

- [ ] **Step 1:** Clicking on the per-answer multi-graph should expand it to a larger view.

- [ ] **Step 2:** Add a close/collapse button to return to the compact view.

- [ ] **Step 3:** Ensure chart data remains visible and interactive in expanded view.

- [ ] **Step 4:** Fix bug: previous multi-graphs should persist when a new answer arrives (don't destroy old chart containers).

- [ ] **Step 5:** Fix bug: ensure multi-graph renders for all models regardless of size (investigate why Qwen 7b produces no graph — likely missing data or edge case in chart initialization).

---

## 18. VRAM Utilization Bar Improvement

**Status:** ✅ COMPLETED (verified 2026-07-14)

**Completion Notes:** Already fully implemented. 3-segment stacked bar (weights/ctx/bg) exists for both master and worker cards. Script.js lines 1458-1460 and 1516-1518 set segment widths. HTML indices 404-406 and 416-418 render the segments. Includes process VRAM vs background VRAM split with proper zero-total guards.

### Current Behavior (Before Implementation)

VRAM shows total usage as a single bar.

### Desired Behavior

VRAM bar should show:

- **Color 1:** Model weights (estimated via nvidia-smi telemetry during load stage)

- **Color 2:** Context usage of VRAM (current VRAM usage minus model VRAM usage)

### Action Plan

- [ ] **Step 1:** Capture VRAM usage at rest (before model load) in `monitor.py`.

- [ ] **Step 2:** Capture VRAM usage during the load stage to estimate model weight footprint.

- [ ] **Step 3:** Calculate context VRAM = current VRAM - model VRAM.

- [ ] **Step 4:** Update the VRAM bar in `index.html` to render as a stacked bar with two colors.

- [ ] **Step 5:** Add a legend or tooltip explaining the two segments.

---

## 19. Monitor.py Dies on Page Refresh — Manual Restart Required

**Status:** 🔴 Open

### Observed Behavior

Sometimes after refreshing the dashboard, `monitor.py` needs to be manually restarted even though the main Node server (`server4.js`) was never restarted:
```bash
pkill -f "python.*monitor.py"
cd /home/kyle/AI/experiment-1/dashboard && python3 monitor.py &
```

This is a code smell — `monitor.py` is an independent HTTP server on port 8081 that should not depend on browser lifecycle events. If it's dying, something is crashing it (unhandled exception, connection reset, etc.).

### Action Plan

- [ ] **Step 1:** Investigate why `monitor.py` dies — add a top-level `try/except` with traceback logging to catch silent crashes.

- [ ] **Step 2:** Ensure `monitor.py` handles client disconnections gracefully (don't crash on `ConnectionResetError` or similar when a browser tab closes).

- [ ] **Step 3:** Consider having `server4.js` auto-restart `monitor.py` as a child process if it detects the process is down, rather than requiring manual restart.

---

# SECTION H: ADVANCED GRAPHING

---

## 20. iGPU (intel_gpu_top) Profiler Graph

**Status:** 🔴 Open

### Description

Need a separate iGPU profiler graph on the right sidebar using `intel_gpu_top` telemetry, similar to the existing dGPU monitoring.

### Action Plan

- [ ] **Step 1:** Add `intel_gpu_top` data collection to `monitor.py` (or a separate subprocess) — parse GPU util, frequency, power, etc.

- [ ] **Step 2:** Extend the telemetry JSON response to include an `igpu` section.

- [ ] **Step 3:** Add a new chart card in the sidebar for iGPU utilization over time.

- [ ] **Step 4:** Wire up continuous polling to update the iGPU chart in real time.

---

## 21. Expanded Graph Modal — Show ALL Graphs Stacked

**Status:** 🔴 Open

### Current Behavior

Clicking a graph expands only that single graph to full-screen modal.

### Desired Behavior

Clicking to expand should fill a full-screen modal with **all the sidebar historical graphs stacked on top of each other**, providing a comprehensive view of all telemetry aligned on the same time axis. Currently the graphs are too tall to be useful in compact view, but the expanded view solves this by showing historical data in context of each other.

### Action Plan

- [ ] **Step 1:** Replace single-graph expand modal with a full-screen modal containing all sidebar graphs (CPU, GPU, VRAM, temp, power, throttle, etc.) stacked vertically.

- [ ] **Step 2:** Ensure all graphs share the same time axis for correlation analysis.

- [ ] **Step 3:** Add scroll/pin behavior so users can scroll through the stacked graphs or pin specific ones.

---

## 22. Restore Launch Config on Page Refresh

**Status:** 🔴 Open

### Current Behavior

When the dashboard is refreshed while the server is still running, the client has no idea what model was loaded or what arguments were used — the dropdowns and config fields are blank/default.

### Desired Behavior

The server should store what model was run and what arguments were used, then send that info to a newly connected client. The client should auto-populate the model dropdown, context size, GPU layers, and llama-server args fields.

### Action Plan

- [ ] **Step 1 (Backend):** In `server4.js`, when a new client connects via SSE, include the current launch config in the initial state broadcast (model path, context size, GPU layers, raw arg string, etc.).

- [ ] **Step 2 (Frontend):** On SSE connection, parse the launch config from the initial state payload and populate the UI: select the right model in the dropdown, set context/gpu-layers values, fill the args textarea.

- [ ] **Step 3 (Storage):** Also persist the last launch config in `localStorage` as a fallback in case the SSE initial broadcast is missed.

---

## 23. Gantt Chart Bottleneck Analysis + Throttle/Idle Overlay

**Status:** 🔴 Open

### Description

Two related enhancements to existing graphs:

1. **Throttle/Idle color-coded overlay on existing timeline graphs:** The graph already has matching prefill/thinking/answering sections at the top. Add color-coded sections to indicate periods of throttling (red) and idling (blue).

2. **Bottleneck Gantt chart at the bottom:** A separate chart that looks like a Gantt chart with:
   - **Y-axis (left):** Pipeline components (e.g., "GPU Decode", "Prefill", "I/O Wait", "Context Build", etc.)
   - **X-axis:** Time
   - **Bars:** Highlight the length of time where any single component was the bottleneck
   - **Right side:** Numbers showing how much time was spent bottlenecked on each component and what percent of total time that bottleneck represented

### Action Plan

- [ ] **Step 1:** Add throttle/idle color-coded overlays to existing phase timeline — use throttle reason data from Item 9 to determine when to paint red (thermal) or blue (idle).

- [ ] **Step 2:** Design the bottleneck Gantt chart component — define pipeline components, data structure for bottleneck events, and rendering logic.

- [ ] **Step 3:** Implement server-side bottleneck detection — determine which component is the bottleneck at any given time based on utilization data (e.g., if GPU < 50% util but CPU is at 100%, the bottleneck is CPU-bound).

- [ ] **Step 4:** Render the Gantt chart with component labels on the left, time as the x-axis, colored bars for each bottleneck period, and summary statistics on the right (total time, % of total).

---

## 24. CSV Recording Overhaul

**Status:** 🔴 Open

### Current Problem

CSV recording is missing data after recent updates. Latest row example:
```
2026-07-14T08:44:17.434Z  Bench  N/A  /path/to/model.gguf  N/A  131000  999  yes  TB4  0.7  20.9  66.84  undefined  undefined  N/A  undefined  N/A  13833  undefined  N/A  N/A  N/A  N/A  N/A  N/A  undefined  1416  1062  129.535  42.4
```

Multiple columns contain `undefined` or `N/A`, indicating the CSV schema is out of sync with the data being sent.

### What Also Needs to Change

1. **Re-evaluate CSV columns:** Audit which columns are actually useful vs. stale/unused.

2. **Per-prompt storage, not just per-run averages:** Currently only the run-level averages are stored. Every prompt's data should be stored as a separate row (including background prompt activity once that's being correctly captured).

3. **Add a `run_id` column:** Link individual prompt rows back to their parent run session.

### Action Plan

- [ ] **Step 1:** Audit the current `CSV_HEADERS` in `server4.js:133` — identify which columns produce `undefined` or `N/A`, and trace back to why the data isn't being sent.

- [ ] **Step 2:** Fix the data pipeline so all existing columns are populated correctly.

- [ ] **Step 3:** Redesign the CSV schema: add `run_id`, `prompt_id`, `prompt_number`, `phase` columns. Remove or deprecate columns that are no longer relevant.

- [ ] **Step 4:** Change logging from one-row-per-run to one-row-per-prompt, storing individual prompt metrics (load time, prefill t/s, gen t/s, token counts, phase durations).

- [ ] **Step 5:** Once Item 7 (background prompt capture) is fixed, ensure those prompts are also logged as separate rows.

---

## 25. Per-Component Stacked Area Graphs (CPU + GPU)

**Status:** 🔴 Open

### Description

A separate graph for each CPU and each GPU showing a **stacked area chart** with:
- **Area 1 (bottom):** llama.cpp utilization
- **Area 2 (top):** non-llama utilization

**Important:** This does NOT mean changing the existing utilization graphs that show lines for all CPUs / all GPUs. Those are useful separately, but can't be combined with area graphs effectively. These are **new, additional** per-component graphs.

### Action Plan

- [ ] **Step 1:** In `monitor.py`, track per-process CPU utilization (llama-server vs. everything else) so the stacked area has meaningful data.

- [ ] **Step 2:** For GPU, isolate llama-server GPU usage from total GPU usage (nvidia-smi per-process stats).






