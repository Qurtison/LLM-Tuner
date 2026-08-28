// Systemd --user control of a managed llama-server inference unit (gap G2,
// docs/gap-analysis.md). Mirrors the old dashboard app/service.py: install a
// unit file that runs a launch script, then start/stop/restart/status via
// systemctl --user, and follow logs via journalctl --user.
//
// The unit is only installed/restarted when presets are applied; llama-server
// itself keeps running under systemd even if this dashboard process restarts.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

export interface UnitStatus {
    activeState: string;
    subState: string;
    since: string | null;
    pid: number | null;
    restarts: number;
    result: string;
}

export interface UnitCommandResult {
    ok: boolean;
    output: string;
}

function run(args: string[], timeoutMs = 30_000): Promise<UnitCommandResult> {
    return new Promise(resolve => {
        const proc = spawn('systemctl', ['--user', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        proc.stdout?.on('data', (b: Buffer) => { out += b.toString(); });
        proc.stderr?.on('data', (b: Buffer) => { err += b.toString(); });
        const timer = setTimeout(() => { proc.kill('SIGKILL'); }, timeoutMs);
        proc.on('error', e => { clearTimeout(timer); resolve({ ok: false, output: String(e.message) }); });
        proc.on('close', code => {
            clearTimeout(timer);
            resolve({ ok: code === 0, output: (err + out).trim() });
        });
    });
}

function shQuote(s: string): string {
    if (!s) return "''";
    if (/^[A-Za-z0-9._\/:-]+$/.test(s)) return s;
    return "'" + s.replace(/'/g, "'\\''") + "'";
}

// Write the unit file synchronously (no systemctl involved): callers that
// need the file present before a same-tick `systemctl start` (LlamaService
// boot/launch path) can't wait on daemon-reload. The unit ExecStarts the
// given launch script; the script is regenerated on every launch, the unit
// file itself is stable.
export function writeUnitFile(unitPath: string, launchScript: string): void {
    const unit = [
        '[Unit]',
        'Description=llama-server (managed by Mission Control)',
        'After=network-online.target',
        'Wants=network-online.target',
        '',
        '[Service]',
        'Type=simple',
        'ExecStart=' + shQuote(launchScript),
        'Restart=always',
        'RestartSec=10',
        'TimeoutStopSec=60',
        'KillSignal=SIGINT',
        'SuccessExitStatus=0 130 143',
        'StandardOutput=journal',
        'StandardError=journal',
        '',
        '[Install]',
        'WantedBy=default.target',
        '',
    ].join('\n');
    mkdirSync(path.dirname(unitPath), { recursive: true });
    writeFileSync(unitPath, unit);
}

export function daemonReload(): Promise<UnitCommandResult> {
    return run(['daemon-reload']);
}

export function enable(unitName: string): Promise<UnitCommandResult> {
    return run(['enable', unitName]);
}

export async function installUnit(unitPath: string, launchScript: string, unitName: string, enableOnApply: boolean): Promise<UnitCommandResult> {
    writeUnitFile(unitPath, launchScript);
    const reload = await daemonReload();
    if (!reload.ok) return reload;
    if (enableOnApply) {
        const enable = await run(['enable', '--now', unitName]);
        if (!enable.ok) return enable;
    }
    return { ok: true, output: 'unit installed: ' + unitPath };
}

export async function start(unitName: string): Promise<UnitCommandResult> {
    return run(['start', unitName]);
}

export async function stop(unitName: string): Promise<UnitCommandResult> {
    return run(['stop', unitName]);
}

export async function restart(unitName: string): Promise<UnitCommandResult> {
    return run(['restart', unitName]);
}

export async function status(unitName: string): Promise<UnitStatus> {
    const props = await run(['show', unitName, '--property=ActiveState,SubState,ExecMainStartTimestamp,ExecMainPID,NRestarts,Result'], 10_000);
    const data: Record<string, string> = {};
    for (const line of props.output.split('\n')) {
        const eq = line.indexOf('=');
        if (eq > 0) data[line.slice(0, eq)] = line.slice(eq + 1);
    }
    const pid = parseInt(data['ExecMainPID'] || '0', 10);
    return {
        activeState: data['ActiveState'] || 'unknown',
        subState: data['SubState'] || 'unknown',
        since: data['ExecMainStartTimestamp'] || null,
        pid: pid > 0 ? pid : null,
        restarts: parseInt(data['NRestarts'] || '0', 10) || 0,
        result: data['Result'] || '',
    };
}

export async function logs(unitName: string, lines = 200): Promise<string> {
    return new Promise(resolve => {
        const proc = spawn('journalctl', ['--user', '-u', unitName, '-n', String(lines), '--no-pager', '-o', 'cat'], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        proc.stdout?.on('data', (b: Buffer) => { out += b.toString(); });
        proc.on('close', () => resolve(out.trim()));
        proc.on('error', () => resolve(''));
    });
}

// Spawn a long-lived journalctl -f follower; caller owns the process and
// must terminate it when the stream ends.
//
// `since` is an ISO-8601 timestamp; when set, the follow starts at that
// moment and the historical `-n` replay is skipped. This is the fresh-launch
// path: replaying the previous run's log lines on a new follow triggers the
// fatal-log detector (`out of memory` etc.) and kills the unit within a few
// ms of start. The boot/adopt paths pass `since = null` to keep their
// history catch-up.
export function logFollowProcess(unitName: string, lines = 200, since: string | null = null) {
    const args: string[] = ['--user', '-u', unitName, '-o', 'cat', '--no-pager', '-q'];
    if (since) args.push('--since=' + since);
    else args.push('-n', String(lines));
    args.push('-f');
    return spawn('journalctl', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}
