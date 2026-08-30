# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Mission Control: a self-hosted dashboard for launching, chatting with, monitoring, and benchmarking local LLM servers (llama.cpp builds). One Bun process serves the API, the SSE stream, and the built React client. Bun is the only runtime and package manager — no npm/pnpm, one lockfile (`bun.lock`).

The `llama.cpp/` directory is a gitignored local checkout/build of upstream llama.cpp, not project source. `logs/`, `dist/`, `__pycache__/` are also gitignored artifacts.

## Commands

```sh
bun install
bun run dev          # hot-reload server on 3000 + Vite client on 5173 (/api proxied)
bun run build        # Vite client -> dist/client
bun run start        # production: single process at http://127.0.0.1:3000
bun run typecheck    # tsc --noEmit
bun run lint         # eslint (config + deps live in tools/lint/, not root node_modules)
bun run test         # full suite
bun test --timeout 15000 tests/launch.test.ts   # single test file
```

If the dev server runs on a nonstandard port: `VITE_API_PROXY_TARGET=http://127.0.0.1:<port> bun run dev`.

Tests boot the **real server** as a child process on a random port with a temp dir, wired to fake children in `tests/fixtures/` (fake-llama-server.sh, fake-llama-bench.sh, fake-llama-http.ts) via `tests/helpers/test-server.ts`. The 15s timeout matters: internal helpers wait up to 10s, so bun's 5s default kills them (set in `bunfig.toml` for `bun run test`; pass `--timeout 15000` when invoking `bun test` directly).

## The API contract

The API's behavior was captured verbatim from the legacy `server4.js` in `docs/api-inventory.md` — every response shape, status code, SSE frame, and quirk.

- `shared/contracts.ts` — request/SSE types both server and client compile against.
- The test suite records that inventory as behavior tests; new behavior goes behind explicit, documented decisions, with the suite updated alongside the change.
- `docs/api-inventory.md` is the source of truth when a response shape is in question.

## Architecture

**Server** (`src/server/`):
- `index.ts` — Bun.serve entry: owns the SSE client set (`/api/status`), static serving from `dist/client`, the `/api/llama/*` proxy (browsers never dial the model server directly), the size-guarded body reader (413 via `BodyTooLargeError`), and one shutdown path for all spawned children.
- `routes.ts` — every `/api/*` handler in one file (deliberate: one import boundary; split only when forced).
- `config.ts` — precedence: built-in defaults < config file (`DASHBOARD_CONFIG` env, else `config/dashboard.json`, else legacy `dashboard.config.json`) < env (`DASHBOARD_HOST`, `DASHBOARD_PORT`, `DASHBOARD_LOGS_DIR`). Startup prints every resolved value with its source; invalid config fails startup with field-specific errors. No machine-specific values in code.
- `services/` — stateful, own child processes: `llama.ts` (spawn/log state machine; persists `last-launch.json` under the configured logs dir so a restart can adopt/relaunch the model), `bench.ts`, `telemetry.ts` (sampling/recording around the in-process hardware collector `hwmon.ts`; degrades to offline placeholders), `presets.ts`, `csvlog.ts`, `unit.ts` (systemd mode), `upgrade.ts`, `devices.ts`, `models.ts`, `files.ts`, `ssh.ts`.
- `lib/` — pure helpers (`launch.ts`, `csv.ts`, `tokenize.ts`, `helpparse.ts`, `fatallogs.ts`).

**Client** (`src/client/`, Vite + React 19):
- One SSE owner: the app shell (via `state/server.ts`) opens the single `/api/status` EventSource, parses every frame, and fans out to typed stores. Feature panels read via `useServer()` and **never open their own EventSource**. Panels that consume raw log lines (`BENCH:`, `BENCH_DONE:`, …) subscribe through `onSseLine`.
- `state/value.ts` — the minimal external-store cell (`Value<T>`) behind every module-level store, read with `useSyncExternalStore`. Its `get` is an arrow field on purpose: it gets detached when passed to `useSyncExternalStore`.
- `features/` — per-panel directories (overview, interactive, bench, monitor, presets, logs, files, history, upgrade).

**Shared** (`shared/`):
- `contracts.ts` — the API/SSE types (see above).
- `llama-params.ts` — auto-generated from `llama-server --help` by `bun scripts/gen-params.ts`. Do not hand-edit defaults/flags/env/help — regenerate; only labels/groups/options/scope are hand-corrected.
