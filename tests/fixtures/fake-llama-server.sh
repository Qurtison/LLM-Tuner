#!/bin/bash
if [ -z "$FAKE_LLAMA_SETSID" ]; then
    export FAKE_LLAMA_SETSID=1
    exec setsid "$0" "$@"
fi
trap 'kill 0' TERM
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
sleep 30 &
wait $!
