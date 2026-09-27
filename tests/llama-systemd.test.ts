// A+D unit: pure logic of the systemd launch path — unit file content,
// launch.sh content, last-launch persistence, /health probe mapping.
// No real systemctl/journalctl involved (those are exercised by the
// poller/journal helpers, covered by the smoke run).
import { test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeUnitFile } from '../src/server/services/unit';
import { writeLaunchScriptFile, loadLastLaunch, persistLastLaunch, probeLlama, journalSinceFor, attachJournalStreams } from '../src/server/services/llama';

let tmp: string;
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-tuner-')); });
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

test('writeUnitFile writes a stable unit that ExecStarts the launch script', () => {
    const unitPath = path.join(tmp, 'units', 'llm-llama-server.service');
    const script = '/home/james/projects/LLM-Tuner/generated/launch.sh';
    writeUnitFile(unitPath, script);
    const text = fs.readFileSync(unitPath, 'utf8');
    expect(text).toContain('ExecStart=' + script);
    expect(text).toContain('Restart=always');
    expect(text).toContain('RestartSec=10');
    expect(text).toContain('KillSignal=SIGINT');
    expect(text).toContain('WantedBy=default.target');
});

test('launch script is an exec of the shell-quoted command and is executable', () => {
    const scriptPath = path.join(tmp, 'gen', 'launch.sh');
    writeLaunchScriptFile(scriptPath, '/opt/llama-server', ['-m', '/models/weird name.gguf', '--port', '8080']);
    const text = fs.readFileSync(scriptPath, 'utf8');
    expect(text.startsWith('#!/usr/bin/env bash\n')).toBe(true);
    expect(text).toContain("exec /opt/llama-server -m '/models/weird name.gguf' --port 8080");
    expect(fs.statSync(scriptPath).mode & 0o111).not.toBe(0);
});

test('last-launch persists, round-trips, and rejects missing/corrupt files', async () => {
    const dir = path.join(tmp, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    expect(await loadLastLaunch(dir)).toBeNull();
    persistLastLaunch(dir, { config: { model: 'x', port: 8080 }, command: '/opt/llama-server', args: ['-m', 'x'], at: 123 });
    const back = await loadLastLaunch(dir);
    if (!back) throw new Error('last launch did not persist');
    expect(back.config.model).toBe('x');
    expect(back.command).toBe('/opt/llama-server');
    expect(back.args).toEqual(['-m', 'x']);
    fs.writeFileSync(path.join(dir, 'last-launch.json'), '{not json');
    expect(await loadLastLaunch(dir)).toBeNull();
});

test('probeLlama maps /health to ready/loading/down', async () => {
    const ok = Bun.serve({ port: 0, fetch: () => new Response(JSON.stringify({ status: 'ok' }), { headers: { 'Content-Type': 'application/json' } }) });
    const loading = Bun.serve({ port: 0, fetch: () => new Response(JSON.stringify({ status: 'loading' }), { headers: { 'Content-Type': 'application/json' } }) });
    const dead = Bun.serve({ port: 0, fetch: () => new Response('x') });
    const deadPort = dead.port!;
    dead.stop(true);
    try {
        expect(await probeLlama('127.0.0.1', ok.port!)).toBe('ready');
        expect(await probeLlama('127.0.0.1', loading.port!)).toBe('loading');
        expect(await probeLlama('127.0.0.1', deadPort)).toBe('down');
    } finally {
        ok.stop(true);
        loading.stop(true);
    }
});

// A dashboard restart adopts the running unit and follows its journal. The
// follow MUST start at that unit's own process start: history catch-up replays
// fatal lines from earlier runs (a 27B prints `failed to fit params` while
// fitting layers), and the fatal-log detector SIGINTs the model when it sees
// one -- which killed a healthy server a second after every start.
test('journalSinceFor pins the replay window to the unit process start', () => {
    const started = 'Sat 2026-09-26 18:10:57 CDT';
    const since = journalSinceFor({ activeState: 'active', subState: 'running', since: started, pid: 1, restarts: 0, result: '' });
    if (!since) throw new Error('expected a replay window');
    // The window is the process start, NOT now: anything earlier (a previous
    // run's fatal lines) stays out of the replay.
    expect(new Date(since).getTime()).toBe(new Date(started).getTime());
    expect(since).not.toBe(new Date().toISOString());
});

test('journalSinceFor falls back to catch-up rather than losing the logs', () => {
    const base = { activeState: 'active', subState: 'running', pid: 1, restarts: 0, result: '' };
    expect(journalSinceFor({ ...base, since: null })).toBeNull();
    expect(journalSinceFor({ ...base, since: 'not a timestamp' })).toBeNull();
});

// A stand-in for `journalctl -f`: two independently-fed pipes and a close
// event, which is all attachJournalStreams touches.
function fakeJournal() {
    type Cb = (arg?: Buffer) => void;
    const pipe = () => {
        const subs = new Map<string, Cb[]>();
        return {
            on(ev: string, cb: Cb) {
                const list = subs.get(ev) || [];
                list.push(cb);
                subs.set(ev, list);
            },
            write(text: string) {
                for (const cb of subs.get('data') || []) cb(Buffer.from(text));
            },
        };
    };
    const stdout = pipe();
    const stderr = pipe();
    const closeSubs: Cb[] = [];
    return {
        stdout,
        stderr,
        on(ev: string, cb: Cb) { if (ev === 'close') closeSubs.push(cb); },
        write(which: 'stdout' | 'stderr', text: string) {
            (which === 'stdout' ? stdout : stderr).write(text);
        },
        close() { for (const cb of closeSubs) cb(); },
    };
}

// The actual fix, tested at the wiring level: journalctl writes the unit's
// stdout and stderr to two pipes and chunk boundaries land anywhere inside a
// line. Wiring both pipes to one feeder would splice a partial line onto the
// other stream's bytes, so this drives the real attachment with a fake proc.
test('journal pipes get one buffer each: interleaved chunks do not merge', () => {
    const lines: string[] = [];
    const proc = fakeJournal();
    attachJournalStreams(proc as never, l => lines.push(l));

    proc.write('stdout', 'llama: loading model ');   // no newline yet
    proc.write('stderr', 'CUDA out of memory\n');     // complete line, other pipe
    proc.write('stdout', 'shard 1/3\nload_tensors: ');// completes line 1, starts line 2
    proc.write('stderr', 'ggml_backend_');            // partial stderr line
    proc.write('stdout', 'done\n');
    proc.write('stderr', 'buffer flushed\n');         // completes the stderr line

    expect(lines).toEqual([
        'CUDA out of memory',
        'llama: loading model shard 1/3',
        'load_tensors: done',
        'ggml_backend_buffer flushed',
    ]);
});

test('a final fragment with no newline is logged as a tail on close', () => {
    const lines: string[] = [];
    const tails: string[] = [];
    const proc = fakeJournal();
    attachJournalStreams(proc as never, l => lines.push(l), t => tails.push(t));

    proc.write('stdout', 'complete\ntruncated frag');
    proc.write('stderr', 'also truncated');
    expect(lines).toEqual(['complete']);
    expect(tails).toEqual([]);

    proc.close();
    // Truncated fragments, per stream, as tails — not parsed as events.
    expect(tails).toEqual(['truncated frag', 'also truncated']);
    expect(lines).toEqual(['complete']);
});
