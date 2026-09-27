#!/bin/bash
if [ -z "$FAKE_BENCH_SETSID" ]; then
    export FAKE_BENCH_SETSID=1
    exec setsid "$0" "$@"
fi
# Same teardown as fake-llama-server.sh, for the same reasons: this script is
# its own process group leader (setsid above), the group kill reaps the sleep,
# and we never SIGKILL ourselves because the exit status is read by the caller
# (bench.ts prints "exited with code 0" from it, and a signal death becomes
# "exited with signal SIGKILL").
#
# Disarm FIRST, then signal: our own group kill would otherwise re-enter the
# handler and recurse until bash dies with SIGSEGV (see the global rules).
teardown() {
    local status=$?
    trap '' TERM INT HUP EXIT
    trap - EXIT
    kill -TERM 0 2>/dev/null
    local n
    for n in $(seq 30); do [ -z "$(jobs -pr)" ] && break; sleep 0.1; done
    local p
    for p in $(pgrep -g "$$" 2>/dev/null); do
        [ "$p" = "$$" ] && continue
        kill -KILL "$p" 2>/dev/null
    done
    exit "$status"
}
trap teardown TERM INT HUP EXIT
[ -n "$FAKE_BENCH_PIDFILE" ] && echo $$ > "$FAKE_BENCH_PIDFILE"
echo "build: 0.0.0-fake (fake)"
echo "| model | t/s |"
echo "| fake  | 10.0 |"
sleep 1.5 &
wait $!
echo "bench done"
