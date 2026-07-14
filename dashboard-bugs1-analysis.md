# Dashboard Bug Report & Action Plan

Source: `dashboard-bugs1.txt`. Investigated against `index.html`, `server4.js`, `monitor.py` (the active trio — `index1/2.html`, `server3.js`, `monitor1.py` are older/superseded).

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

**Action plan:** Add a small reset control (button near `metric-prefill-avg`/`metric-gen-avg`) wired to a new function that zeroes `runningAverages`, calls `updateAverageUI()`, and either clears or overwrites `localStorage['cluster_averages']`. Decide whether reset should be manual-only or also auto-reset on model switch/new chat session — worth a quick product decision before building.

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
