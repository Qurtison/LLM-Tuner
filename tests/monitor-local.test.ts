import { test, expect } from 'bun:test';
import { join } from 'node:path';

// monitor.py's _is_same_host decides whether the worker slot shares master's
// machine-level stats (cpu/ram/net): local second GPU and loopback/own-hostname
// RPC targets are same-host, remote SSH targets are not. The serve loop sits
// under a __main__ guard, so importing the module is side-effect free.
const hasPython = process.platform !== 'win32' && Boolean(Bun.which('python3'));
const run = hasPython ? test : test.skip;

run('monitor._is_same_host marks shared-host worker targets', async () => {
    const cases: [string, boolean][] = [
        ['localhost', true],
        ['127.0.0.1', true],
        ['::1', true],
        ['0.0.0.0', true],
        ['user@localhost', true],
        ['[::1]', true],
        ['kyle4090@169.254.61.173', false],
        ['192.168.1.50', false],
        ['', false],
    ];
    const code = [
        'import sys, json',
        'sys.path.insert(0, sys.argv[1])',
        'import monitor',
        'print(json.dumps([monitor._is_same_host(t) for t in json.loads(sys.stdin.read())]))',
    ].join('\n');
    const proc = Bun.spawn(['python3', '-c', code, join(import.meta.dir, '..')], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    proc.stdin.write(JSON.stringify(cases.map(pair => pair[0])));
    proc.stdin.end();
    const [out, err, exit] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    expect(err).toBe('');
    expect(exit).toBe(0);
    expect(JSON.parse(out)).toEqual(cases.map(pair => pair[1]));
});
