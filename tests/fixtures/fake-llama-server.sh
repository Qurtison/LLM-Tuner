#!/bin/bash
if [ -z "$FAKE_LLAMA_SETSID" ]; then
    export FAKE_LLAMA_SETSID=1
    exec setsid "$0" "$@"
fi
# Teardown for TERM/INT/HUP and normal exit.
#
# This script becomes its own process group leader (the setsid re-exec above),
# so the group is exactly "this script + its children". Signal the GROUP so the
# grandchildren (fake-llama-http.ts, the sleeps) die with us -- but never
# SIGKILL this process itself: it must survive to exit with the status its
# caller is waiting for.
#
# Exit status is part of this fixture's contract: devices.ts runs --help and
# --list-devices through execFile(), which rejects a signalled exit, and the
# early-exit branches below have to return 0. A bare `kill -KILL 0` (or a
# `kill 0` with the handler still armed) turns every exit into a signal
# death, which breaks flag/device listing and the bench "exited with code 0"
# assertion.
#
# Disarm FIRST, then signal: the group kill includes this script, and an
# armed handler re-entered by our own signal recurses
# (run_pending_traps -> parse_and_execute -> execute_command_internal -> ...)
# until bash overflows the stack and dies with SIGSEGV. Disarmed, the
# self-delivered TERM is a no-op.
teardown() {
    local status=$?
    trap '' TERM INT HUP EXIT
    trap - EXIT
    kill -TERM 0 2>/dev/null
    local n
    for n in $(seq 30); do [ -z "$(jobs -pr)" ] && break; sleep 0.1; done
    # Escalate on whoever is still up, re-reading the group at kill time.
    # pgrep never matches itself; $$ is skipped so the exit below still runs.
    local p
    for p in $(pgrep -g "$$" 2>/dev/null); do
        [ "$p" = "$$" ] && continue
        kill -KILL "$p" 2>/dev/null
    done
    exit "$status"
}
trap teardown TERM INT HUP EXIT
if [ "$1" = "--help" ]; then cat <<'HELP'
usage: llama-server [options]

-h,  --help                        Show this help text and exit.
-c,  --ctx-size N                  Context size (default 4096).
-ngl, --n-gpu-layers N             Number of layers to offload to GPU (default 99).
--port N                           Port to listen on (default 8080).
--rpc [TARGET]                     Use RPC target for offloading (default localhost:50052).
--split-mode [mode]                Device split mode: none, layer, row (default none).
--metrics                          Enable prometheus metrics (default disabled).
--temp f                           Temperature (default 0.800000).
--top-k N                          Top-k sampling (default 40).
--jinja                            Enable jinja chat template processing (default disabled).
HELP
    exit 0
fi
if [ "$1" = "--list-devices" ]; then
    echo "0: Fake GPU 0 (16384 MiB, 12000 MiB free)"
    echo "1: CPU (8192 MiB, 4000 MiB free)"
    exit 0
fi
echo "server version: 0.0.0-fake"
[ -n "$FAKE_LLM_PIDFILE" ] && echo $$ > "$FAKE_LLM_PIDFILE"
echo "load_model: loading model"
sleep 0.4 &
wait $!
echo "llama_server: model loaded"
# Serve /slots + /v1/chat/completions on the port we were launched with so the
# dashboard proxy is testable against real upstream HTTP (streaming included).
# FAKE_BUN + fake-llama-http.ts are provided by the test helper; the child is
# in our process group, so teardown's group kill takes it down with us.
LLAMA_PORT=""
prev=""
for arg in "$@"; do
    if [ "$prev" = "--port" ]; then LLAMA_PORT="$arg"; fi
    prev="$arg"
done
if [ -n "$LLAMA_PORT" ] && [ -n "$FAKE_BUN" ]; then
    FAKE_PORT="$LLAMA_PORT" "$FAKE_BUN" "$(dirname "$0")/fake-llama-http.ts" &
fi
sleep 30 &
wait $!
