## Launching: local GPU(s) + optional RPC worker

The master (`llama-server`) always launches natively now -- there's no more
Docker-vs-local mode choice. `dashboard.config.json`'s `llamaServerBuilds`
picks which compiled binary to run (e.g. Vulkan-only vs. a combined
CUDA+Vulkan build), and up to two local devices (GPU A / GPU B) can be
selected for a split, both detected automatically on page load.

RPC Worker is a separate, optional toggle (off by default) that adds a remote
`llama.cpp` RPC worker as a second compute target alongside your local GPU(s).
Enabling it forces GPU B back to "None" -- the split is always exactly 2-way
(this machine vs. the worker), not a 3-way local+local+remote split.

**RPC needs a local build compiled with `-DGGML_RPC=ON`.** The
`build-cuda-vulkan` build in `../llama-official/llama.cpp/build-cuda-vulkan`
was compiled without it (`GGML_RPC:BOOL=OFF` in its `CMakeCache.txt`), so
using RPC with that build will fail until it's rebuilt with RPC enabled, e.g.:

```bash
cmake -B build-cuda-vulkan -DGGML_CUDA=ON -DGGML_VULKAN=ON -DGGML_RPC=ON -DCMAKE_BUILD_TYPE=Release
cmake --build build-cuda-vulkan --config Release -j$(nproc)
```

The worker side is still assumed to run via Docker (`docker-compose.worker.yml`,
started/stopped over SSH by the RPC Worker box's Start/Stop buttons) --
unchanged by this. Whether the worker actually needs Docker either is an open
question, just not one this covers.

**Known gap: RPC doesn't currently pin the local device list.** When RPC is
on, `resolveLaunchCommand` (server4.js) passes `--rpc host:port --split-mode
layer -ts N,M` but no `-dev` flag, relying on llama-server's own device
auto-detection to land on exactly 2 devices (the one local GPU + the RPC
worker). That's only actually 2 devices when there's just one local GPU
available. With the eGPU reconnected, auto-detection would see both local
GPUs *and* the RPC device -- 3 devices against a 2-value `-ts` -- so RPC +
local dual-GPU is untested and likely broken until this is fixed. The GUI
forces GPU B to "None" whenever RPC is on specifically to dodge this in the
common case; it doesn't fix the underlying command. Verify `--list-devices`
output on the rebuilt binary and figure out the right explicit `-dev` list
(does it need the RPC device named in it too, and if so what's its id?)
before trusting RPC together with a second local GPU.

## Offline / no external dependencies

The frontend used to load Tailwind, Chart.js, and marked from public CDNs, so
the dashboard wouldn't render without internet access. Those are now vendored
locally under `vendor/` (`vendor/chart.js`, `vendor/marked.min.js`,
`vendor/tailwind.css`) and referenced from `index.html` via relative paths, so
the site works fully offline once served by `server4.js`.

`vendor/tailwind.css` is a pre-built, purged stylesheet (via the Tailwind CLI,
config in `tailwind.config.js`) rather than the Tailwind CDN's in-browser JIT
compiler. If you add new Tailwind classes to `index.html` or `script.js`,
rebuild it:

```bash
npm install        # one-time, pulls in the tailwindcss dev dependency
npm run build:css  # regenerates vendor/tailwind.css
```

This build step needs internet/npm; the resulting `vendor/tailwind.css` is
committed so end users never need to run it themselves.

# Running the dashboard under pm2

`server4.js` is the dashboard backend. It's the process that spawns `monitor.py`
as a child, drives the Docker Compose lifecycle for the master/worker
llama-server containers, and serves the SSE state stream + telemetry the UI
depends on. Because a crash in this process used to take the whole dashboard
down until someone manually restarted it (see `dashboard-bugs1-analysis.md`
item 13), it now runs under [pm2](https://pm2.keymetrics.io/), a Node process
manager that auto-restarts it if it ever dies.

`monitor.py` is not managed separately — `server4.js` spawns it on startup and
kills it on shutdown, so a single pm2 entry for `server4.js` covers both.

## Config

Process settings live in `ecosystem.config.js`:

```js
module.exports = {
  apps: [{
    name: 'dashboard',
    script: 'server4.js',
    cwd: __dirname,
    restart_delay: 2000,   // wait 2s between restart attempts
    max_restarts: 20,      // give up after 20 restarts within min_uptime windows (crash-loop guard)
    min_uptime: 5000,      // must stay up 5s to count as a stable start
    autorestart: true
  }]
};
```

`max_restarts`/`min_uptime` together are a crash-loop guard: if something is
broken badly enough that the process dies within 5s of every restart, pm2 gives
up after 20 attempts instead of restart-looping forever (which would otherwise
hammer the GPUs with repeated container boot/teardown all night for no
benefit).

## Common commands

Run these from this directory (`/home/kyle/AI/experiment-1/dashboard`).

| Command | What it does |
|---|---|
| `pm2 start ecosystem.config.js` | Start the dashboard (first time, or after a full stop) |
| `pm2 status` | Show whether it's online, its PID, uptime, and restart count (`↺`) |
| `pm2 logs dashboard` | Tail stdout/stderr live (this is where `handleLogs()`'s echoed llama-server output shows up) |
| `pm2 restart dashboard` | Manually restart it (e.g. after editing `server4.js`) |
| `pm2 stop dashboard` | Stop it — pm2 will **not** auto-restart after an explicit stop |
| `pm2 delete dashboard` | Remove it from pm2's process list entirely |
| `pm2 save` | Snapshot the current process list to `~/.pm2/dump.pm2`, so `pm2 resurrect` (or `pm2 startup` + a reboot) can bring it back |

A restart via pm2 (or a crash it recovers from) does **not** preserve
in-flight model state — if a model was loaded, you'll need to hit "Boot
Cluster" again in the UI afterward. pm2 only guarantees the dashboard
backend itself comes back up; it doesn't remember or reissue your last
`/api/start` config.

## Checking restart history

The `↺` column in `pm2 status` is a cumulative restart counter for the
process's whole lifetime (not just since the last boot) — a non-zero count
after leaving it running unattended (e.g. overnight) tells you it crashed and
recovered at least that many times, worth cross-referencing against
`pm2 logs dashboard --lines 500` (or the raw log files under `~/.pm2/logs/`)
to see what actually happened.

## Removing pm2 management

If you want to go back to running it directly:

```bash
pm2 stop dashboard
pm2 delete dashboard
node server4.js   # now runs in the foreground, no auto-restart
```
