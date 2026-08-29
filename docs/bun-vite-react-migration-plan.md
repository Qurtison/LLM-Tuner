# Bun Server and Vite React Migration Plan

## Goal

Convert Mission Control into one Bun application with a Vite and React frontend. Keep current model control, telemetry, benchmark, history, and remote-worker behavior.

Remove machine-specific values from source files. Supply portable defaults through checked-in config examples, environment variables, or browser settings.

## Current state

- `server4.js` is a 2,154-line CommonJS server. It owns HTTP routes, server-sent events (SSE), child processes, benchmark queues, CSV history, and static files.
- `index.html` contains full interface and inline styles. `script.js` contains 5,346 lines of global DOM code.
- `monitor.py` runs a second HTTP server on port 8081. Backend polls it for Linux, NVIDIA, AMD, network, and remote SSH telemetry.
- Frontend contacts `llama-server` directly on `localhost:8080` for chat and slot data.
- `dashboard.config.json` supports llama.cpp build paths, but its fallback contains one user's absolute path.
- Remote-worker hosts and Docker directory commands contain one user's names, addresses, and paths.
- Ports, model directories, log directories, Python command, telemetry tools, and cleanup policy remain fixed in source.
- PM2 runs Node. Frontend uses vendored Chart.js, marked, and generated Tailwind CSS.
- No automated application tests exist.

## Target shape

Use one package and one lockfile at repository root.

```text
src/
  server/
    index.ts
    config.ts
    routes/
    services/
  client/
    main.tsx
    App.tsx
    api/
    components/
    features/
    hooks/
    styles.css
shared/
  contracts.ts
config/
  dashboard.example.json
public/
tests/
```

Use Bun APIs where they reduce code:

- `Bun.serve()` for HTTP, SSE, and production assets.
- `Bun.spawn()` for llama.cpp, benchmark, Python, SSH, and cleanup processes.
- `Bun.file()` for config, CSV, history, and built assets.
- `Bun.env` for deployment overrides.
- Vite for development, React builds, and production bundles.

Keep `monitor.py` during first migration. Rewriting hardware probes adds risk without helping requested runtime conversion. Run it as a managed Bun child and bind it only to loopback.

## Configuration contract

Add `config/dashboard.example.json`. Ignore `config/dashboard.json`. Load values in this order:

1. Safe built-in defaults.
2. Checked-in or user-selected config file.
3. Environment variables.
4. Request values only for fields users can change per launch.

Reject unknown or invalid values at startup. Print each source and resolved non-secret value. Never silently restore a machine path.

Suggested contract:

```json
{
  "server": { "host": "127.0.0.1", "port": 3000, "corsOrigins": [], "maxBodyBytes": 10485760 },
  "paths": { "modelDirectories": ["./models"], "huggingFaceCache": null, "logsDirectory": "./logs", "pythonCommand": "python3", "monitorScript": "./monitor.py" },
  "llama": { "builds": [], "defaultPort": 8080, "defaultHost": "127.0.0.1", "rpcPort": 50052 },
  "telemetry": { "enabled": true, "host": "127.0.0.1", "port": 8081, "pollMs": 1000, "providers": ["nvidia", "amd", "linux"] },
  "processes": { "cleanupManagedPortsOnStart": false, "stopGraceMs": 3000 },
  "worker": {
    "sshHost": "",
    "rpcTarget": "",
    "workDirectory": "",
    "startCommand": "docker compose -f docker-compose.worker.yml up -d",
    "stopCommand": "docker compose -f docker-compose.worker.yml down",
    "statusCommand": "docker compose -f docker-compose.worker.yml ps --filter status=running -q",
    "logsCommand": "docker compose -f docker-compose.worker.yml logs --tail=50",
    "transportPresets": []
  },
  "uiDefaults": { "contextSize": 4096, "gpuLayers": 0, "tensorSplit": 50, "temperature": 0.8 }
}
```

Support environment overrides for deployment fields, such as `DASHBOARD_CONFIG`, `DASHBOARD_HOST`, `DASHBOARD_PORT`, and `DASHBOARD_LOGS_DIR`. Keep list and command data in JSON to avoid brittle environment encoding.

Return public defaults from `GET /api/config`. Do not return filesystem paths or remote commands unless current screen needs them.

## Machine-specific cleanup

Remove these assumptions from active source and documentation:

- `/home/kyle/AI/llama-official/...`
- `/home/kyle/AI/experiment-1/dashboard`
- `kyle4090@169.254.61.173`
- `kyle4090@192.168.1.125`
- `~/AI/experiment-1`
- Fixed dashboard, llama.cpp, monitor, and RPC ports.
- Fixed `../models`, `../logs`, Hugging Face cache, and Python executable behavior.
- Automatic `fuser -k` against every process that owns ports 8080 or 8081.
- Browser calls to `http://localhost:8080`, which fail for remote dashboard users.
- Hardware labels and transport choices that assume one NVIDIA GPU, one AMD eGPU, and one Thunderbolt worker.

Keep examples generic. Move old machine notes under clearly marked historical documents or remove them when they no longer help current setup.

## Phase 1: Capture behavior and contracts

1. Inventory every `/api/*` route, request body, response, status code, and SSE event.
2. Add fixture tests for command tokenization, launch resolution, help parsing, CSV parsing, and fatal-log detection.
3. Add route smoke tests for status, models, builds, logs, benchmark control, worker control, and telemetry.
4. Record shutdown behavior for llama.cpp, benchmark, and monitor children.
5. Freeze current API during runtime migration.

Acceptance criteria:

- Tests describe each route used by browser.
- Parser tests cover quoted arguments, malformed numbers, stale build IDs, and old CSV schemas.
- A test confirms cleanup never kills an unrelated process by default.

## Phase 2: Add typed config

1. Create `src/server/config.ts` with schema validation and path resolution from config file directory.
2. Replace hardcoded build fallback with an empty build list and a clear startup warning.
3. Move model roots, cache location, logs, ports, monitor command, process timeouts, and worker commands into config.
4. Add `GET /api/config` for safe UI defaults and feature flags.
5. Update config example and `.gitignore`.
6. Add startup checks for writable logs, executable builds, port ranges, worker command completeness, and missing telemetry tools.

Acceptance criteria:

- A fresh clone starts without a user path.
- A missing llama.cpp build disables launch actions but leaves setup and history screens available.
- Relative paths resolve consistently.
- Invalid config stops startup with a field-specific error.

## Phase 3: Move server runtime to Bun

1. Split `server4.js` by responsibility without changing behavior first.
2. Replace `http.createServer()` with `Bun.serve()`.
3. Replace Node child-process calls with argument-array `Bun.spawn()` calls.
4. Keep shell execution only for explicit configured remote commands. Pass remote command as one SSH argument.
5. Add one process registry for llama.cpp, benchmarks, and monitor.py.
6. Make shutdown idempotent. Send `SIGTERM`, wait for configured grace period, then send `SIGKILL`.
7. Replace broad port cleanup with tracked-process cleanup. Offer legacy cleanup only through an explicit config flag.
8. Serve Vite output from `dist/client` in production. Keep `/api/*` and asset routes separate.
9. Proxy chat and slot requests through Bun under `/api/llama/*`.
10. Restrict CORS to configured origins. Default to same-origin only.

Acceptance criteria:

- `bun run start` serves all existing APIs and SSE events.
- Browser code contains no fixed localhost service URL.
- Restart and stop leave no tracked child process.
- Startup does not kill unrelated listeners.
- Request size, timeout, validation, and path-traversal protections remain active.

## Phase 4: Add Vite and React shell

1. Add Vite, React, TypeScript, Chart.js, marked, Tailwind, and required type packages to root package.
2. Replace vendored scripts with package imports. Remove vendor copies after offline production builds pass.
3. Create a Vite development proxy for `/api` and SSE. Read target from `VITE_API_PROXY_TARGET` for development only.
4. Move global styles into `src/client/styles.css`. Let Tailwind scan TypeScript and TSX sources.
5. Build shared API types in `shared/contracts.ts`.
6. Add one fetch helper with JSON errors, abort handling, and typed responses.
7. Add one SSE hook with reconnect state and cleanup.

Acceptance criteria:

- `bun run dev` starts Vite and Bun together.
- Vite hot module replacement updates React code.
- `bun run build` creates a self-contained production bundle.
- `bun run start` serves that bundle without Vite.

## Phase 5: Convert interface by feature

Convert vertical slices, not individual HTML tags. Keep old and React screens behind a temporary route or feature flag until each slice passes.

1. App shell, navigation, status banner, and error display.
2. Build, model, device, launch, command preview, start, and stop controls.
3. Chat streaming and slot polling through Bun proxy.
4. Telemetry cards, live charts, chart expansion, and sampling controls.
5. Monitor and history tables, filters, summaries, sample detail, and CSV download.
6. Benchmark runner, matrix queue, notes, restore, stop, and telemetry graph.
7. Worker setup, lifecycle controls, status, and logs.
8. Hugging Face search and Markdown rendering.
9. Browser persistence for profiles, chat sessions, chart settings, and benchmark drafts.

Use React state for current screen state. Keep browser persistence in small hooks with versioned keys and migration functions. Do not add a global state library unless prop flow becomes a measured problem.

Acceptance criteria for each slice:

- Feature matches current behavior and error states.
- Keyboard controls, labels, focus order, and dialog focus work.
- Timers, event streams, charts, and requests stop on unmount.
- Empty, loading, offline, invalid-config, and process-failure states render clearly.

## Phase 6: Remove legacy frontend

1. Make React only production entry after all slices pass.
2. Delete DOM-global handlers from `script.js`.
3. Delete old interface markup and inline CSS from `index.html`.
4. Delete vendored Chart.js, marked, and generated Tailwind files.
5. Remove old static-file branches from server.
6. Remove temporary legacy route and feature flag.

Acceptance criteria:

- No active source references `script.js` or `vendor/`.
- No inline `onclick` handlers or required globals remain.
- Production deep links return Vite entry without swallowing `/api/*` 404 responses.

## Phase 7: Tooling, deployment, and docs

Add root scripts:

```json
{
  "scripts": {
    "dev": "bun --hot src/server/index.ts & vite",
    "dev:server": "bun --hot src/server/index.ts",
    "dev:client": "vite",
    "build": "vite build",
    "start": "bun src/server/index.ts",
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  }
}
```

Replace background shell in `dev` with a small Bun runner if signal forwarding proves unreliable. Do not add a process dependency for that job.

1. Replace `package-lock.json` with `bun.lock` after dependency review.
2. Decide whether `llama-cli/` stays a separate package. If it stays, give it Bun scripts and a configurable monitor URL.
3. Replace PM2 instructions with a Bun command and one systemd example. Keep PM2 as an optional recipe if users need it.
4. Document Bun version, Python telemetry requirements, Linux tool requirements, and optional NVIDIA or AMD tools.
5. Add setup steps that copy `config/dashboard.example.json` to `config/dashboard.json`.
6. Update all port, path, worker, and model-directory documentation.

Acceptance criteria:

- Fresh-clone setup uses no absolute user path.
- Production starts with one documented Bun command.
- README separates required dependencies from optional telemetry and worker tools.
- Repository search finds no active user names, private addresses, or personal directories.

## Test matrix

### Server

- Config precedence, defaults, invalid fields, relative paths, and redacted output.
- Every route method, success response, invalid JSON, oversized body, and missing resource.
- SSE connect, initial state, event delivery, disconnect cleanup, and reconnect.
- Process spawn failure, normal exit, fatal log, stop timeout, and server shutdown.
- Benchmark queue order, cancellation, malformed entries, history restore, and model conflict.
- CSV old-schema reads, quoted fields, malformed rows, filters, and download.
- SSH host validation and configured command execution.
- Llama proxy streaming, upstream timeout, connection failure, and non-JSON errors.

### Client

- Config and build loading.
- Launch validation and command-preview errors.
- SSE reconnect and stale-state replacement.
- Streaming chat cancellation and partial output.
- Chart creation, update, and destruction.
- Profile and history persistence migrations.
- Worker controls when config is absent or disabled.
- Keyboard and dialog accessibility.

### End to end

- Start Bun and Vite with fake llama.cpp and monitor fixtures.
- Launch, stream status, chat, log a request, inspect history, run a benchmark, and stop.
- Build production assets and repeat smoke path through `bun run start`.
- Open dashboard from another machine and confirm all model traffic uses Bun origin.

## Failure controls

- Keep API compatibility until React conversion finishes.
- Use fake child executables in tests. Never require GPUs, SSH, or llama.cpp in continuous integration.
- Preserve existing CSV files. Read old schemas and write one documented current schema.
- Back up no files automatically. Migration code must not rewrite user config or history without an explicit command.
- Treat telemetry as optional. A missing Python process or hardware tool must not stop dashboard.
- Bind Bun and monitor.py to loopback by default. Require explicit config for network exposure.
- Do not accept arbitrary worker shell text from browser requests. Load commands from server config.

## Completion criteria

Migration finishes when all conditions pass:

- Bun owns production HTTP, SSE, process control, proxying, and static assets.
- Vite builds a React and TypeScript frontend.
- Frontend behavior covers all current tabs and controls.
- Active code contains no personal path, username, private address, or fixed remote directory.
- Deployments can configure hosts, ports, paths, builds, telemetry, worker commands, and UI defaults.
- Browser code uses same-origin APIs only.
- Tests run with `bun test`. Type checks run with `bun run typecheck`.
- Production builds and starts with documented Bun commands.
- README describes fresh-clone setup and upgrades from `dashboard.config.json`.

## Deliberate scope limit

Keep `monitor.py` as a managed child during this migration. Replace it with native Bun probes only after parity tests cover NVIDIA, AMD, Linux, and remote SSH telemetry.
