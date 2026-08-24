# Gap analysis: old dashboard -> LLM-Tuner (Mission Control)

Date: 2026-08-24. Source: /home/james/projects/dashboard (Python stdlib
dashboard for llama.cpp) vs /home/james/projects/LLM-Tuner (Bun + React
Mission Control). Goal: LLM-Tuner becomes the single stop for local models,
monitoring, and RPC workers.

## Already covered (no transfer needed)

- GPU/telemetry monitoring: old gpu.py (nvidia-smi + amd-smi, 1s SSE) is
  matched by monitor.py (richer: throttle reasons, VRAM per card, net,
  per-interface, amd hwmon) + MonitorPanel.
- Throughput metrics: old llm_metrics.py scrapes /metrics counters; LLM-Tuner
  parses print_timing lines + /slots + telemetry samples.
- Model discovery: old HF list + download; LLM-Tuner has HF search + README +
  pick + /api/models recursive scan.
- Build flags reference: old params.py parses --help; LLM-Tuner
  devices.ts/helpparse.ts parse --help and --list-devices.
- Chat: LLM-Tuner ChatPanel via /api/llama/* proxy (old had none).
- Bench + history + CSV: BenchPanel, HistoryPanel, benchmarks.csv.
- RPC workers: WorkerPanel + /api/worker/* + SSH + monitor.py worker stats
  (incl. same_host). Old never had workers. Only needs worker.* config filled.

## Gaps to close (priority order)

### G1. Presets (biggest)
Old: named presets {name, build_dir, args} JSON, active preset, apply/restart,
launch command render, file-path validation, dirty diff, export/import.
LLM-Tuner: single free-form launch form + localStorage profiles only.
Missing: named persistent launch configs, apply/restart, validation.

### G2. Persisted server + live logs
Old: llama-dashboard-server.service (systemd --user), Restart=always,
StartLimit, journald logs streamed live. LLM-Tuner spawns llama-server as a
child of its own process: dies with the server, logs only in-memory ring.
Missing: systemd-managed inference unit, start/stop/restart/status, log follow.

### G3. llama.cpp build/upgrade
Old upgrade.py: git fetch -> dirty/diverged guard -> --ff-only merge ->
cmake --build in existing configured build dir -> restart, streamed.
LLM-Tuner: nothing.

### G4. GPU summary cards + prefill/gen progress bars on a live view
Old renderGpu: per-card temp/util/VRAM/power bars + sparklines; per-slot
prefill bars parsed from logs; live gen t/s with /metrics fallback.
LLM-Tuner MonitorPanel lacks the card summary and per-slot prefill bars.

### G5. Manual model file management
Old: /api/files tree browser + /api/files/delete (path-guarded), sizes.
LLM-Tuner: /api/models lists GGUF only, no tree, no delete.

### G6. Overview tab
Old: single Overview with service state, GPU, throughput, logs.
LLM-Tuner: 3-column workbench, engine banner only; no overview.

### G7. Active build dir exposure
Old /api/config exposes repo_dir, build_dirs, active_build_dir, models_dir.
LLM-Tuner /api/config keeps paths out (safe); UI lacks build-dir awareness.
Decide: expose read-only paths behind a separate authenticated endpoint, or
leave safe config and let presets carry build_dir.

## Host notes (this machine)

- RTX 5080, nvidia-smi present, no amd-smi. monitor.py nvidia path covers.
- No /home/james/projects/LLM-Tuner/models dir, no config/dashboard.json yet.
- No local llama.cpp checkout or llama-server binary found under ~/ (only
  ~/llm/dashboard, which is the old dashboard). Build/upgrade (G3) needs a
  llama.cpp repo to point at; until one exists, the feature is inert-but-wired.
- dist/client stale (Aug 20), branch bun-vite-react-migration.

## Transfer order

G1 -> G2 -> G3 -> G4 -> G5 -> G6 -> G7. G1+G2 together (apply/restart owns
the unit). Tests: extend routes.smoke.test.js pattern with fake children.
