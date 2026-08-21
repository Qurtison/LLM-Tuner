#!/bin/bash
if [ -z "$FAKE_BENCH_SETSID" ]; then
    export FAKE_BENCH_SETSID=1
    exec setsid "$0" "$@"
fi
trap 'kill 0' TERM
[ -n "$FAKE_BENCH_PIDFILE" ] && echo $$ > "$FAKE_BENCH_PIDFILE"
echo "build: 0.0.0-fake (fake)"
echo "| model | t/s |"
echo "| fake  | 10.0 |"
sleep 1.5 &
wait $!
echo "bench done"
