# Dashboard Bug Report & Action Plan

**Source:** `dashboard-bugs1.txt`. Investigated against `index.html`, `server4.js`, `monitor.py` (the active trio — `index1/2.html`, `server3.js`, `monitor1.py` are older/superseded).

---

## How to Use This Document

- **Work items in order** — later items sometimes depend on earlier ones (dependencies are called out explicitly).
- Each item has a **Root Cause** (with file:line references) and an **Action Plan** (ordered steps) — read both before touching code.
- A **Confidence Note** is given where a finding wasn't verified against a live run (grep for "needs live confirmation").
- Items marked `COMPLETED` already have a fix applied — verify the fix still holds, don't redo the work.
- File:line references may drift by a few lines as fixes are applied; re-`grep` for the quoted code snippet if a line number looks off.
- **Update this document with completion summaries every time you finish a task.**
- Note: your commit message should have detailed (but brief) implementation notes after the short headline.

---

## Dependency Graph (Execution Order)

```
Item 13 (Backend Crash) → Item 8c (Crash Red Panel) → Item 8d (Stale State After Refresh)
Item 5 (Load Time)       → Item 15 (Historical CSV)
Item 5 (Load Time)       → Item 12 (Continuous Telemetry)
Item 7 (Progress Bar)    → Item 16 (Throttle Badges)
```

**Recommended execution order:** 13 → 8 → 14 → 5 → 7 → 9 → 16 → 15 → 12 → 17 → 18 → 6

---

## Status Legend

| Status | Meaning |
|--------|---------|
| 🔴 Open | Not started, needs work |
| 🟡 In Progress | Partially implemented, needs verification |
| 🟢 Completed | Fix applied, needs user verification |
| ⏸ Paused | Deferred, ignore for now |

---

# SECTION A: CRITICAL BUGS (Fix First)

These are stability-critical issues that block other work.

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
  - **Phase 1 (gold):** Loading Context
  - **Phase 2 (blue):** Thinking
  - **Phase 3 (green):** Answering
  - **Phase 4 (purple):** Processing Prompt (if different from loading)
  
  The bar should always be 100% width and show the dynamic ratio of time spent in each stage. First it's 100% gold, then a right edge turns blue as thinking starts, then green as answering expands, then freezes once complete.
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

- [ ] **Step 1:** Fix badge duplication — investigate why throttle reasons are being rendered twice (likely a duplicate render call or the badge container not being cleared before re-rendering).
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

### Action Plan

- [ ] **Step 1:** Clicking on the per-answer multi-graph should expand it to a larger view.
- [ ] **Step 2:** Add a close/collapse button to return to the compact view.
- [ ] **Step 3:** Ensure chart data remains visible and interactive in expanded view.

---

## 18. VRAM Utilization Bar Improvement

**Status:** 🔴 Open

### Current Behavior
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

# EXECUTION PLAN

## Phase 1: Stability (Critical — Fix First)

| Order | Item | Description | Estimated Effort |
|-------|------|-------------|-----------------|
| 1 | **#13** | Backend crash: null `llamaProcess` dereference | 1-2 hours |
| 2 | **#14** | Telemetry fetch cascade on network change | 30 min |
| 3 | **#8** | Master log panel (broken fetch, placement, crash indication, stale state) | 2-3 hours |

**Goal:** Eliminate crashes and silent failures. Everything else depends on a stable foundation.

## Phase 2: Data Integrity (Enables Future Features)

| Order | Item | Description | Estimated Effort |
|-------|------|-------------|-----------------|
| 4 | **#5** | Fix load time not being recorded in CSV | 30 min |
| 5 | **#7** | Fix prefill progress bar reliability + unified phase bar | 3-4 hours |

**Goal:** Ensure accurate telemetry data flows from server → client → UI.

## Phase 3: GPU/Throttle Accuracy

| Order | Item | Description | Estimated Effort |
|-------|------|-------------|-----------------|
| 6 | **#9** | GPU throttle badge: use granular fields instead of combined flags | 1-2 hours |
| 7 | **#16** | Throttle badge improvements (duplication, placement, tooltips, dynamic show/hide) | 2-3 hours |

**Goal:** Accurate, non-misleading throttle indication with proper visual feedback.

## Phase 4: Historical Analytics

| Order | Item | Description | Estimated Effort |
|-------|------|-------------|-----------------|
| 8 | **#15** | Historical CSV query for avg/median load time per config | 1-2 hours |

**Goal:** Provide baselines and expectations for model launch performance.

## Phase 5: Architecture & Feature Work

| Order | Item | Description | Estimated Effort |
|-------|------|-------------|-----------------|
| 9 | **#12** | Continuous telemetry + monitoring/chat toggle | 4-6 hours |
| 10 | **#6** | Free-text arg box + saved configs | 2-3 hours |
| 11 | **#17** | Expandable multi-graph | 1 hour |
| 12 | **#18** | VRAM utilization stacked bar | 1-2 hours |

**Goal:** Larger architectural improvements and quality-of-life features.

---

## Total Estimated Effort: ~20-30 hours

---

## Completion Log

| Date | Item | Notes |
|------|------|-------|
| — | — | (Update this table as items are completed) |