// A+D unit: pure logic of the systemd launch path — unit file content,
// launch.sh content, last-launch persistence, /health probe mapping.
// No real systemctl/journalctl involved (those are exercised by the
// poller/journal helpers, covered by the smoke run).
import { test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeUnitFile } from '../src/server/services/unit';
import { writeLaunchScriptFile, loadLastLaunch, persistLastLaunch, probeLlama } from '../src/server/services/llama';

let tmp;
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
    const root = path.join(tmp, 'app');
    fs.mkdirSync(root, { recursive: true });
    expect(await loadLastLaunch(root)).toBeNull();
    persistLastLaunch(root, { config: { model: 'x', port: 8080 }, command: '/opt/llama-server', args: ['-m', 'x'], at: 123 });
    const back = await loadLastLaunch(root);
    expect(back.config.model).toBe('x');
    expect(back.command).toBe('/opt/llama-server');
    expect(back.args).toEqual(['-m', 'x']);
    fs.writeFileSync(path.join(root, 'generated', 'last-launch.json'), '{not json');
    expect(await loadLastLaunch(root)).toBeNull();
});

test('probeLlama maps /health to ready/loading/down', async () => {
    const ok = Bun.serve({ port: 0, fetch: () => new Response(JSON.stringify({ status: 'ok' }), { headers: { 'Content-Type': 'application/json' } }) });
    const loading = Bun.serve({ port: 0, fetch: () => new Response(JSON.stringify({ status: 'loading' }), { headers: { 'Content-Type': 'application/json' } }) });
    const dead = Bun.serve({ port: 0, fetch: () => new Response('x') });
    const deadPort = dead.port;
    dead.stop(true);
    try {
        expect(await probeLlama('127.0.0.1', ok.port)).toBe('ready');
        expect(await probeLlama('127.0.0.1', loading.port)).toBe('loading');
        expect(await probeLlama('127.0.0.1', deadPort)).toBe('down');
    } finally {
        ok.stop(true);
        loading.stop(true);
    }
});
