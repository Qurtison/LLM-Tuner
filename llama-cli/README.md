# Llama CLI & TUI

Minimalist CLI and btop-style terminal UI for managing llama.cpp models, launch profiles, and real-time hardware telemetry.

## Prerequisites

- Node.js >= 18 (native `fetch`)
- Python 3 (for `monitor.py`)
- `llama-server` in `$PATH`

## Install

```bash
cd llama-cli
npm install
```

## Usage

### List Models

Recursively scans `~/.cache/huggingface/hub`, `./models`, and `~/llama.cpp/models` for `.gguf` files.

```bash
node cli.js models
```

### Manage Profiles

Profiles are stored in `~/.llama-cli/profiles.json`.

```bash
# Save a profile (model path is validated and resolved to absolute)
node cli.js profile save "Llama3-8B" -m ./models/llama-3-8b.gguf -a "--ctx 8192 --ngl 99"

# List all profiles
node cli.js profile list

# Delete a profile
node cli.js profile delete "Llama3-8B"
```

### Run & Monitor

Launches `llama-server` and enters a live TUI. Automatically starts `monitor.py` if port 8081 isn't already open.

```bash
# Run with a saved profile
node cli.js run "Llama3-8B"

# Run with inline flags
node cli.js run -m ./models/mistral-7b.gguf -a "--ctx 4096 --flash-attn"
```

#### TUI Controls

| Key | Action |
|-----|--------|
| `q` | Quit TUI and shutdown server |
| `k` | Kill server only (keep TUI running) |
| `r` | Force immediate refresh |
| `Ctrl+C` | Quit TUI and shutdown server |

## Architecture

| File | Purpose |
|------|---------|
| `cli.js` | Commander setup, model scanning, process lifecycle |
| `lib/profiles.js` | JSON profile CRUD with path validation |
| `lib/telemetry.js` | POST polling to `monitor.py:8081`, rolling metric buffers |
| `lib/tui.js` | Raw-mode input, ANSI rendering, sparkline/progress graphs |

## How It Works

- **Telemetry**: POSTs `{"worker_ssh": ""}` to `monitor.py` on port 8081 every 500ms. Response contains `master` (and optionally `worker`) GPU, CPU, RAM, and network stats.
- **Network throughput**: Calculated as a delta from cumulative `net_bytes` counters to avoid counting noise.
- **Graphs**: Auto-scaled ASCII sparklines over the last 40 data points (~20 seconds at 500ms polling).
- **Process management**: `llama-server` is spawned as a child process. `monitor.py` is spawned detached (daemon-style) if not already running.

## File Structure

```
llama-cli/
  cli.js              # Entry point
  lib/
    profiles.js       # Profile management
    telemetry.js      # HTTP polling + metric buffers
    tui.js            # Terminal UI rendering
  package.json
  README.md
```
