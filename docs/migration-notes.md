# Migration working notes (branch bun-vite-react-migration)

Goal: 7-phase Bun+Vite+React migration per bun-vite-react-migration-plan.md.
Repo default branch is master (no main). Work branch: bun-vite-react-migration.

## Status
- P1: API inventory doc + lib extraction/fixture tests -> two subagents (track ids in session).
- P1 remaining: route smoke tests, API freeze.
- P2-P7: not started.

## Recon findings
- 4 UI tabs: interactive, monitor, history, bench (index.html:490-493). Worker controls + HF search inside interactive.
- SSE endpoint is /api/status (server4.js:1374-1375). Client: script.js:431.
- monitor.py: 690 lines, single POST /stats on 8081; accepts worker_ssh for remote telemetry (ssh BatchMode, ConnectTimeout=5, timeout 3s combined command). Probes: meminfo, netdev, cpu (proc stat), nvidia-smi, amdgpu hwmon.
- server4.js polls http://localhost:8081/stats (server4.js:1233).
- PM2: ecosystem.config.js runs server4.js, autorestart, max_restarts 20.
- dashboard.config.example.json: only llamaServerBuilds[] (P2 replaces with full contract).
- llama-cli/: separate TUI package (own package.json/lock; cli.js, lib/{menu,parser,profiles,telemetry,tui}).
- .gitignore: node_modules, dashboard.config.json, __pycache__.
- Vendored: vendor/chart.js, vendor/marked.min.js, vendor/tailwind.css (built from tailwind.src.css via tailwind.config.js).

## Machine-specific values (working tree; A's inventory has committed-file line numbers)
- server4.js:168 build fallback /home/kyle/AI/llama-official/llama.cpp/build/bin/llama-server
- server4.js:1983,1999,2015,2031 worker cmds: cd ~/AI/experiment-1 && docker compose -f docker-compose.worker.yml ...
- server4.js:305 cleanupPort uses fuser -k <port>/tcp
- server4.js:2073-2074 startup cleanupPort(8080) + cleanupPort(8081)
- server4.js:2093 spawn('python3', ['monitor.py'])
- server4.js:536 RPC port 50052 appended for --rpc
- script.js:238,240 sshInput defaults kyle4090@169.254.61.173 / kyle4090@192.168.1.125
- index.html:196 worker-ssh input value kyle4090@169.254.61.173
- README.md:192 /home/kyle/AI/experiment-1/dashboard
- old_docs/*: historical, leave as-is.

## localStorage keys (13; P5 slice 9 versioned-migration targets)
cluster_averages, cluster_chat_history, omni_smoothing, bench_auto_queue, bench_stars,
bench_custom_rows, bench_row_status, cluster_sidebar_width, launch_sidebar_width,
sidebar_collapsed_left, sidebar_collapsed_right, launch_ab, bench_subtab

## Decisions (post-migration behavior)
- same_host worker stats (2026-08-21): a GPU is a "worker" only when connected over RPC to another machine; otherwise it is a local GPU sharing master's machine-level cpu/ram/net pool. monitor.py marks the worker slot `same_host: true` for the local second-GPU mode and for RPC targets resolving to this machine (loopback / own hostname; collected locally, no SSH to self). MonitorPanel suppresses the worker cpu/ram line and value on same_host points; per-GPU stats (util/pwr/temp/VRAM) still show. Frozen API suite untouched: fake monitor already returns `worker: null`. Future: when monitor.py is folded into the Bun server (SSE stats), the TS side produces the same flag.

## Plan per phase (delta vs scroll)
- P1: A=inventory doc, B=extraction+fixtures. Then: route smoke tests (start server with fake monitor fixture? decide), freeze API in shared/contracts.ts.
- P2: config.ts TS module + config/dashboard.example.json + /api/config + .gitignore update.
- P3: server split into src/server, Bun.serve, spawn, process registry, proxy /api/llama/*.
- P4: vite+react shell, dev proxy, styles.css, fetch helper, SSE hook.
- P5: 9 slices in scroll order.
- P6: delete script.js/index.html markup/vendor.
- P7: scripts, bun.lock, systemd example, README rewrite.
