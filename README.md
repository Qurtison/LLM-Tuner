# Mission Control

Self-hosted dashboard for launching, chatting with, monitoring, and
benchmarking local LLM servers (llama.cpp builds). One repo, one runtime:
Bun serves the API, the SSE stream, and the built React frontend from a
single process.

## Quick start (fresh clone)

~~~sh
bun install        # one lockfile: bun.lock
bun run build      # builds the Vite/React client into dist/client
bun run start      # serves everything at http://127.0.0.1:3000
~~~

Development (hot-reload server + Vite dev server with /api proxied):

~~~sh
bun run dev        # server on 3000, client on 5173
~~~

If your server port is not 3000, point the dev proxy at it:

~~~sh
VITE_API_PROXY_TARGET=http://127.0.0.1:<port> bun run dev
~~~

## Configuration

No machine-specific values live in code. Precedence (low to high):

1. Built-in defaults
2. Config file (path from DASHBOARD_CONFIG, else config/dashboard.json,
   else legacy dashboard.config.json) — see config/dashboard.example.json
3. Environment: DASHBOARD_HOST, DASHBOARD_PORT, DASHBOARD_LOGS_DIR

At startup every resolved value prints with its source. An invalid config
file fails startup with the list of issues instead of a stack trace.

The monitor child (monitor.py) needs Python at paths.pythonCommand
(default python3). Telemetry stays disabled with a warning if the script
or the monitor port is unreachable.

## Tests and typecheck

~~~sh
bun test           # API behavior suite (boots the real server with fake children)
bun run typecheck
~~~

The test suite records the legacy API's exact responses, SSE frames,
latency budgets, and quirks in docs/api-inventory.md. New behavior goes
behind explicit, documented decisions, with the suite updated alongside.

## Upgrading from the old dashboard

- dashboard.config.json still loads (legacy path support): copy it to
  config/dashboard.json and the loader maps the old keys automatically.
- The old static UI was served under /legacy/ during migration.
- PM2 is gone; use a plain process manager. Example unit:
  docs/systemd/mission-control.service.example.

## Layout

- src/server/ — Bun runtime: config, routes, SSE hub, services
  (llama spawn/log state machine, bench runner, telemetry poll, CSV log),
  static serving, /api/llama/* proxy to the launched model server.
- src/client/ — Vite + React 19 app (one SSE owner, per-feature panels).
- shared/contracts.ts — the API/SSE types both sides compile against.
- tests/ — API behavior suite + fake children (llama-server, bench,
  monitor, model HTTP sidecar).
- monitor.py — telemetry collector, managed as a child process.
