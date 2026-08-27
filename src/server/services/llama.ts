import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type { LaunchConfig } from '../../../shared/contracts';
import type { ServerCtx } from './types';
import * as launch from '../lib/launch';
import * as tokenize from '../lib/tokenize';
import * as fatalLogs from '../lib/fatallogs';
import * as unitMod from './unit';
import type { UnitStatus } from './unit';

const MASTER_LOG_BUFFER_SIZE = 500;

// --- D: persisted last launch (generated/last-launch.json) ---
// Lets a dashboard restart adopt (systemd mode) or relaunch (native mode)
// the model without user action.
export interface LastLaunch {
    config: LaunchConfig;
    command: string;
    args: string[];
    at: number;
}

export async function loadLastLaunch(appRoot: string): Promise<LastLaunch | null> {
    try {
        const raw = await fs.readFile(path.join(appRoot, 'generated', 'last-launch.json'), 'utf8');
        const data = JSON.parse(raw) as Partial<LastLaunch> | null;
        if (!data || typeof data !== 'object' || !data.config || typeof data.command !== 'string' || !Array.isArray(data.args)) return null;
        return { config: data.config, command: data.command, args: data.args, at: typeof data.at === 'number' ? data.at : 0 };
    } catch { return null; }
}

export function persistLastLaunch(appRoot: string, record: LastLaunch): void {
    try {
        const p = path.join(appRoot, 'generated', 'last-launch.json');
        mkdirSync(path.dirname(p), { recursive: true });
        writeFileSync(p, JSON.stringify(record, null, 2));
    } catch (err) {
        console.error('[llama] failed to persist last launch:', err);
    }
}

// Exec-form launch script the systemd unit runs. formatCommand is the same
// shell quoting the UI displays/copies, so the unit and the UI agree.
export function writeLaunchScriptFile(scriptPath: string, command: string, args: string[]): void {
    mkdirSync(path.dirname(scriptPath), { recursive: true });
    writeFileSync(scriptPath, '#!/usr/bin/env bash\nset -euo pipefail\nexec ' + formatCommand(command, args) + '\n');
    chmodSync(scriptPath, 0o755);
}

export type LlamaProbe = 'ready' | 'loading' | 'down';

// llama-server /health: {"status":"ok"} once the model is loaded,
// {"status":"loading"} during load; fetch failure = no server on the port.
export async function probeLlama(host: string, port: number): Promise<LlamaProbe> {
    try {
        const res = await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(1500) });
        const body: unknown = await res.json().catch(() => null);
        if (body && typeof body === 'object' && 'status' in body) {
            const status = (body as { status: unknown }).status;
            if (status === 'ok') return 'ready';
            if (status === 'loading') return 'loading';
        }
        // Server up but no /health (older binary): treat as loading; the
        // journal follow flips state when "model loaded" lands.
        return res.status < 500 ? 'loading' : 'down';
    } catch { return 'down'; }
}

type Timing = Record<string, number | string | boolean | null | undefined>;
type Pending = {
    timing: Timing;
    samples: unknown[];
    completedAt: number;
    config: LaunchConfig | null;
    launchCommand: string;
    timer: ReturnType<typeof setTimeout>;
};

type LlamaOptions = {
    onActivity?: () => void;
    takeSamples?: () => unknown[];
    logCompletedRequest?: (timing: Timing, samples: unknown[], completedAt: number, opts: { config: LaunchConfig | null; launchCommand: string }) => Promise<void>;
};

type Launch = {
    command: string;
    args: string[];
    config: LaunchConfig;
};

export interface LiveProgress {
    prefillTps?: number;
    prefillProgress?: number;
    prefillTokens?: number;
    genTps?: number;
    genTokens?: number;
}

// Spawn failures (ENOENT, non-string command, ...) -- the /api/start route
// maps this to 500, while resolve/validation failures map to 400 (frozen
// status split).
export class LlamaSpawnError extends Error {}

export class LlamaService {
    private ctx: ServerCtx;
    private onActivity?: () => void;
    // 'native' = Bun.spawn child (dies with the dashboard); 'systemd' =
    // separate user unit in its own cgroup (survives dashboard restarts).
    private mode: 'native' | 'systemd';
    private proc: Bun.Subprocess | null = null;
    private journal: ChildProcess | null = null;
    private pollTimer: ReturnType<typeof setInterval> | null = null;
    private systemdRunning = false;
    private logBuffer: string[] = [];
    private lineListeners = new Set<(line: string) => void>();
    private progress: LiveProgress = {};
    private takeSamples?: () => unknown[];
    private logCompletedRequest?: LlamaOptions['logCompletedRequest'];
    private taskTimings = new Map<string, Timing>();
    private pendingCompletions = new Map<string, Pending>();
    private recentlyCompleted = new Set<string>();
    onExit?: (code: number) => void;

    constructor(ctx: ServerCtx, opts: LlamaOptions = {}) {
        this.ctx = ctx;
        this.mode = ctx.config.service.manageViaSystemd && !!ctx.config.service.unitName ? 'systemd' : 'native';
        this.onActivity = opts.onActivity;
        this.takeSamples = opts.takeSamples;
        this.logCompletedRequest = opts.logCompletedRequest;
        if (this.mode === 'systemd') this.startPoll();
    }

    // A+D boot path, called from init(): adopt a llama unit that survived
    // the dashboard restart (deploy), or relaunch the persisted last launch
    // (fresh boot / was stopped) so a restart self-heals without action.
    async restoreOnBoot(): Promise<void> {
        const last = await loadLastLaunch(this.appRoot());
        if (this.mode === 'systemd') {
            let st: UnitStatus;
            try { st = await unitMod.status(this.unitName()); } catch { return; }
            const up = st.activeState === 'active' || st.activeState === 'activating';
            if (up) {
                this.systemdRunning = true;
                this.startJournalFollow();
                await this.applyIdentityFromLast(last, true);
                this.ctx.broadcast();
                console.log('[llama] adopted running systemd unit ' + this.unitName());
                return;
            }
            if (!last) return;
            // D: relaunch from the persisted launch; launch.sh + unit file
            // are (re)written so a unit stop/start cycle always has both.
            writeLaunchScriptFile(this.scriptPath(), last.command, last.args);
            this.ensureUnitFile();
            this.systemdRunning = true;
            this.startJournalFollow();
            await this.applyIdentityFromLast(last, false);
            void unitMod.start(this.unitName()).then(r => {
                if (!r.ok) this.ctx.broadcast('', 'Launch failed: ' + r.output.slice(-300));
            });
            this.ctx.broadcast();
            console.log('[llama] relaunching systemd unit from last launch');
            return;
        }
        // native: a live model port means an orphaned server from a crashed
        // (not restarted) dashboard -- leave it alone; otherwise relaunch.
        if (!last) return;
        const port = launch.toFiniteNumber(last.config.port) ?? this.ctx.config.llama.defaultPort;
        const probe = await probeLlama(this.ctx.config.llama.defaultHost, port);
        if (probe !== 'down') {
            console.log('[llama] model port ' + port + ' already up (orphaned server) -- not touching it');
            return;
        }
        this.launch(last.config);
    }

    private async applyIdentityFromLast(last: LastLaunch | null, unitUp: boolean): Promise<void> {
        if (!last) {
            if (unitUp) this.ctx.state.serverState = 'starting';
            return;
        }
        this.ctx.state.currentModel = last.config.model || last.config.modelPath || '';
        this.ctx.state.isRpc = !!last.config.rpcTarget;
        this.ctx.state.currentLaunchConfig = last.config;
        this.ctx.state.currentLaunchCommand = formatCommand(last.command, last.args);
        this.ctx.state.loadStartTime = Date.now();
        this.ctx.state.serverState = 'starting';
        if (unitUp) {
            const port = launch.toFiniteNumber(last.config.port) ?? this.ctx.config.llama.defaultPort;
            if (await probeLlama(this.ctx.config.llama.defaultHost, port) === 'ready') {
                this.ctx.state.serverState = 'ready';
            }
        }
    }

    // Dashboard shutdown: in systemd mode the llama unit deliberately
    // outlives the dashboard (that is the point) -- detach tracking only,
    // never stop the unit. native mode keeps the frozen kill path.
    dispose(): void {
        if (this.mode === 'systemd') {
            this.systemdRunning = false;
            this.stopJournalFollow();
            this.stopPoll();
            return;
        }
        this.stop();
    }

    private complete(timing: Timing, samples: unknown[], completedAt: number, opts: { config: LaunchConfig | null; launchCommand: string }): void {
        this.logCompletedRequest?.(timing, samples, completedAt, opts).catch(() => {});
    }

    get running(): boolean {
        return this.mode === 'systemd' ? this.systemdRunning : this.proc !== null;
    }

    get logs(): readonly string[] {
        return this.logBuffer;
    }

    // Subscribe to every raw llama-server line (same strings that land in
    // logs()). Powers the SSE log-follow stream (/api/master/logs/stream);
    // returns an unsubscribe function.
    onLine(listener: (line: string) => void): () => void {
        this.lineListeners.add(listener);
        return () => { this.lineListeners.delete(listener); };
    }

    get liveProgress(): Readonly<LiveProgress> {
        return this.progress;
    }

    resetLiveProgress(): void {
        this.progress = {};
    }

    // Two-phase start so the /api/start route can preserve the frozen
    // status split: validation/resolve failure -> 400, spawn failure -> 500.
    // resolveLaunch throws on an invalid config without touching state.
    resolveLaunch(config: LaunchConfig): { command: string; args: string[]; config: LaunchConfig } {
        if (this.proc) throw new Error('Running');
        return this.resolve(config);
    }

    // Sets launch state, broadcasts, spawns. Throws on synchronous spawn
    // failure AFTER resetting state and broadcasting 'Failed to start
    // process:' (frozen /api/start failure path).
    launch(config: LaunchConfig): void {
        const launchConfig = this.resolveLaunch(config);
        const { command, args } = launchConfig;
        this.setLaunchState(launchConfig.config, command, args);
        this.ctx.broadcast();
        console.log('LAUNCHING:', this.ctx.state.currentLaunchCommand);
        this.ctx.broadcast('', 'LAUNCH CMD: ' + this.ctx.state.currentLaunchCommand);
        try {
            if (this.mode === 'systemd') this.systemdLaunch(command, args, launchConfig.config);
            else this.spawn(command, args);
        } catch (error) {
            this.reset();
            const message = error instanceof Error ? error.message : String(error);
            this.ctx.broadcast('', 'Failed to start process: ' + message);
            throw new LlamaSpawnError(message);
        }
    }

    // SIGTERM now, SIGKILL after the configured grace period if it ignores
    // the first one. Deliberately does NOT await exit and does NOT touch
    // shared state: the /api/stop route transitions stopping -> stopped
    // immediately (frozen behavior) and the close handler (reset) is the
    // single place that clears launch state once the process is actually
    // gone. Escalation timer is unref'd so a stop never holds the event
    // loop (parity with server4.js:1963-1965).
    // Shared launch-state setup for launch() (fresh) and the adopt paths.
    private setLaunchState(config: LaunchConfig, command: string, args: string[]): void {
        this.ctx.state.currentModel = config.model || config.modelPath || '';
        this.ctx.state.isRpc = !!config.rpcTarget;
        this.ctx.state.currentLaunchConfig = config;
        this.ctx.state.serverState = 'starting';
        this.ctx.state.loadStartTime = Date.now();
        this.ctx.state.finalLoadTime = 0;
        this.logBuffer = [];
        this.ctx.state.currentLaunchCommand = formatCommand(command, args);
    }

    stop(): void {
        if (this.mode === 'systemd') {
            if (!this.systemdRunning) return;
            // The poller (kept running) is the single place that clears
            // launch state once the unit is actually inactive (parity with
            // the native close handler); the route has already transitioned
            // stopping -> stopped (frozen).
            this.systemdRunning = false;
            void unitMod.stop(this.unitName());
            return;
        }
        const proc = this.proc;
        if (!proc) return;
        try {
            proc.kill('SIGTERM');
        } catch { /* process may already be gone */ }
        setTimeout(() => {
            try {
                proc.kill('SIGKILL');
            } catch { /* already gone */ }
        }, this.ctx.config.processes.stopGraceMs).unref();
    }

    private resolve(config: LaunchConfig): Launch {
        if (config.rawCommand && config.rawCommand.trim().length > 0) {
            const tokens = tokenize.tokenizeCommand(config.rawCommand.trim());
            const command = tokens[0];
            const args = tokens.slice(1);
            if (!command) throw new Error('Invalid raw command');
            const modelPath = tokenize.extractLastFlagValue(args, '-m') ?? tokenize.extractLastFlagValue(args, '--model');
            let synced = config;
            if (modelPath) synced = { ...synced, model: String(modelPath).split('/').pop(), modelPath };
            const port = launch.toFiniteNumber(tokenize.extractLastFlagValue(args, '--port'));
            if (port !== undefined) synced = { ...synced, port };
            const rpcTarget = tokenize.extractLastFlagValue(args, '--rpc');
            if (rpcTarget && !synced.rpcTarget) synced = { ...synced, rpcTarget };
            return { command, args, config: synced };
        }
        const resolved = launch.resolveLaunchCommand(config, this.ctx.config.llama.builds, {
            rpcPort: this.ctx.config.llama.rpcPort,
            defaultPort: this.ctx.config.llama.defaultPort,
        });
        return { ...resolved, config };
    }

    // --- SYSTEMD MODE (A) ---
    // llama-server runs in its own user unit/cgroup, so dashboard restarts
    // never touch the model process. Journal follow + state polling feed the
    // same handleLine pipeline the native stdout pipe used.

    private unitName(): string {
        return this.ctx.config.service.unitName;
    }

    private appRoot(): string {
        return this.ctx.appRoot ?? process.cwd();
    }

    // Same convention as /api/apply (routes.ts): service.unitPath doubles as
    // the launch-script location; defaults under <appRoot>/generated and
    // the user's systemd dir.
    private scriptPath(): string {
        return path.resolve(this.ctx.config.service.unitPath || path.join(this.appRoot(), 'generated', 'launch.sh'));
    }

    private unitFilePath(): string {
        return path.resolve(this.ctx.config.service.unitPath || path.join(process.env.HOME || '/home/james', '.config', 'systemd', 'user', this.unitName()));
    }

    private ensureUnitFile(): void {
        if (!existsSync(this.unitFilePath())) {
            unitMod.writeUnitFile(this.unitFilePath(), this.scriptPath());
            void unitMod.daemonReload();
            // A+D: the unit must start on boot, not just when the dashboard
            // happens to call start first.
            void unitMod.enable(this.unitName());
        }
    }

    // Synchronous on purpose: launch() keeps its frozen two-phase contract
    // (validation -> 400, spawn -> 500). Async unit failures surface via the
    // poller / start-promise as a 'Launch failed' broadcast.
    private systemdLaunch(command: string, args: string[], config: LaunchConfig): void {
        writeLaunchScriptFile(this.scriptPath(), command, args);
        persistLastLaunch(this.appRoot(), { config, command, args, at: Date.now() });
        this.ensureUnitFile();
        this.systemdRunning = true;
        this.startJournalFollow();
        void unitMod.start(this.unitName()).then(r => {
            if (!r.ok) this.ctx.broadcast('', 'Launch failed: ' + r.output.slice(-300));
        });
    }

    // journalctl -f on the unit: history catch-up (-n 200) + live lines,
    // fed straight into handleLine so loading/ready/progress/timing
    // behavior is identical to the native pipe.
    private startJournalFollow(): void {
        if (this.journal) return;
        const proc = unitMod.logFollowProcess(this.unitName(), 200);
        this.journal = proc;
        let buffer = '';
        const feed = (chunk: Buffer): void => {
            buffer += chunk.toString();
            const lines = buffer.split(/\r\n|\r|\n/);
            buffer = lines.pop() || '';
            if (buffer.length > 1_000_000) buffer = buffer.slice(-4096);
            for (const line of lines) {
                process.stdout.write(line + '\n');
                this.handleLine(line);
            }
        };
        proc.stdout?.on('data', feed);
        proc.stderr?.on('data', feed);
        proc.on('error', () => { this.journal = null; });
        proc.on('close', () => { this.journal = null; });
    }

    private stopJournalFollow(): void {
        if (!this.journal) return;
        try { this.journal.kill(); } catch { /* already gone */ }
        this.journal = null;
    }

    private startPoll(): void {
        if (this.pollTimer) return;
        this.pollTimer = setInterval(() => { void this.pollUnit(); }, 2000);
        this.pollTimer.unref?.();
    }

    private stopPoll(): void {
        if (!this.pollTimer) return;
        clearInterval(this.pollTimer);
        this.pollTimer = null;
    }

    // proc.exited replaced by state polling: non-active = process gone
    // (reset + onExit, the native close-handler equivalent); active again
    // after a crash = systemd Restart=always brought it back (re-adopt).
    private async pollUnit(): Promise<void> {
        const st = await unitMod.status(this.unitName());
        const up = st.activeState === 'active' || st.activeState === 'activating';
        if (!this.systemdRunning) {
            if (up) await this.readoptAfterSystemdRestart();
            return;
        }
        if (up) return;
        this.systemdExited(st.result === 'success' ? 0 : 1);
    }

    // Crash -> systemd restarted the unit: reset() cleared the launch
    // identity, restore it from the persisted last launch and go starting;
    // the journal follow catches loading/ready transitions.
    private async readoptAfterSystemdRestart(): Promise<void> {
        const last = await loadLastLaunch(this.appRoot());
        if (last) {
            this.ctx.state.currentModel = last.config.model || last.config.modelPath || '';
            this.ctx.state.isRpc = !!last.config.rpcTarget;
            this.ctx.state.currentLaunchConfig = last.config;
            this.ctx.state.currentLaunchCommand = formatCommand(last.command, last.args);
        }
        this.systemdRunning = true;
        this.startJournalFollow();
        this.ctx.state.serverState = 'starting';
        this.ctx.state.loadStartTime = Date.now();
        this.ctx.broadcast('', 'llama-server restarted by systemd');
    }

    private systemdExited(code: number): void {
        this.systemdRunning = false;
        this.stopJournalFollow();
        if (this.ctx.state.serverState !== 'ready' && this.ctx.state.serverState !== 'stopped') {
            const errors = this.logBuffer.filter(line => /\sE\s|error|failed/i.test(line)).slice(-2);
            if (errors.length) this.ctx.broadcast('', 'Launch failed: ' + errors.join(' | ').slice(0, 300));
        }
        this.reset();
        this.onExit?.(code);
        this.ctx.broadcast();
    }

    // Fatal-log kill, mode-aware: native kills the child, systemd stops the
    // unit (a plain kill would let Restart=always loop on a bad launch).
    private killProcess(): void {
        if (this.mode === 'systemd') void unitMod.stop(this.unitName());
        else this.proc?.kill();
    }

    private spawn(command: string, args: string[]): void {
        const proc = Bun.spawn([command, ...args], {
            cwd: process.cwd(),
            stdin: 'ignore',
            stdout: 'pipe',
            stderr: 'pipe',
        });
        this.proc = proc;
        let logLineBuffer = '';
        const consume = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
            const reader = stream.getReader();
            const decoder = new TextDecoder();
            while (true) {
                const result = await reader.read();
                if (result.done) break;
                const text = decoder.decode(result.value, { stream: true });
                process.stdout.write(text);
                logLineBuffer += text;
                const lines = logLineBuffer.split(/\r\n|\r|\n/);
                logLineBuffer = lines.pop() || '';
                if (logLineBuffer.length > 1_000_000) logLineBuffer = logLineBuffer.slice(-4096);
                for (const line of lines) this.handleLine(line);
            }
        };
        consume(proc.stdout).catch(error => console.error('Llama process log error:', error));
        consume(proc.stderr).catch(error => console.error('Llama process log error:', error));
        proc.exited.then(code => {
            if (logLineBuffer.length) this.pushLog(logLineBuffer);
            if (this.proc !== proc) return;
            if (this.ctx.state.serverState !== 'ready' && this.ctx.state.serverState !== 'stopped') {
                const errors = this.logBuffer.filter(line => /\sE\s|error|failed/i.test(line)).slice(-2);
                if (errors.length) this.ctx.broadcast('', 'Launch failed: ' + errors.join(' | ').slice(0, 300));
            }
            this.reset();
            this.onExit?.(code);
            this.ctx.broadcast();
        }).catch(error => {
            console.error('Llama process error:', error);
            if (this.proc !== proc) return;
            this.reset();
            this.ctx.broadcast('', 'Failed to start process: ' + (error instanceof Error ? error.message : String(error)));
        });
    }

    private handleLine(line: string): void {
        this.pushLog(line);
        if (line.includes('load_model: loading model')) {
            this.ctx.state.serverState = 'loading';
            this.ctx.broadcast();
        } else if (line.includes('llama_server: model loaded')) {
            console.log('MODEL LOADED! READY!');
            this.ctx.state.serverState = 'ready';
            if (this.ctx.state.loadStartTime > 0) {
                this.ctx.state.finalLoadTime = ((Date.now() - this.ctx.state.loadStartTime) / 1000).toFixed(1);
                this.ctx.state.loadStartTime = 0;
            }
            this.ctx.broadcast();
        } else if (line.includes('launch_slot_:') && line.includes('processing task')) {
            this.progress = {};
            this.onActivity?.();
        } else if (line.includes('prompt processing, n_tokens =')) {
            const tokens = line.match(/n_tokens =\s*(\d+)/);
            const progress = line.match(/progress = (0\.\d+|1\.00)/);
            const tps = line.match(/(\d+\.?\d*)\s*tokens per second/);
            if (progress) {
                const tokenCount = tokens ? tokens[1] : '0';
                const rate = tps ? tps[1] : '0';
                this.progress = {
                    prefillTps: parseFloat(rate) || undefined,
                    prefillProgress: parseFloat(progress[1]),
                    prefillTokens: parseInt(tokenCount, 10) || undefined,
                };
                this.ctx.broadcast('PREFILL_PROGRESS:' + progress[1] + ':' + rate + ':' + tokenCount);
                this.onActivity?.();
            }
        } else if (line.includes('print_timing:')) {
            const generated = line.match(/n_gen\s*=\s*(\d+)/) || line.match(/n_decoded\s*=\s*(\d+)/);
            const rollingRate = line.match(/tg_3s\s*=\s*(\d+\.?\d*)\s*t\/s/) || line.match(/tg\s*=\s*(\d+\.?\d*)\s*t\/s/);
            if (generated && rollingRate) {
                this.progress = { genTps: parseFloat(rollingRate[1]) || undefined, genTokens: parseInt(generated[1], 10) || undefined };
                this.ctx.broadcast('GEN_PROGRESS:' + rollingRate[1] + ':' + generated[1] + ':' + generated[1]);
                this.onActivity?.();
            }
            const idTask = line.match(/id\s+(\d+)\s*\|\s*task\s+(\d+)/);
            if (idTask) {
                const taskId = idTask[2];
                const segment = line.split('|').pop()!.trim();
                if (segment.startsWith('prompt eval time') || segment.startsWith('eval time')) {
                    const m = segment.match(/=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s*tokens[^)]*?([\d.]+)\s*tokens per second/);
                    if (m) {
                        const old = this.taskTimings.get(taskId) || {};
                        this.taskTimings.set(taskId, segment.startsWith('prompt') ? { ...old, promptMs: parseFloat(m[1]), promptTokens: parseInt(m[2], 10), promptTps: parseFloat(m[3]) } : { ...old, genMs: parseFloat(m[1]), genTokens: parseInt(m[2], 10), genTps: parseFloat(m[3]) });
                    }
                } else if (segment.startsWith('total time')) {
                    const m = segment.match(/=\s*([\d.]+)\s*ms/);
                    const timing = this.taskTimings.get(taskId) || {};
                    this.taskTimings.delete(taskId);
                    if (m) {
                        const samples = this.takeSamples?.() || [];
                        const completedAt = Date.now();
                        const pending: Pending = { timing: { ...timing, wallTimeS: (parseFloat(m[1]) / 1000).toFixed(2) }, samples, completedAt, config: this.ctx.state.currentLaunchConfig, launchCommand: this.ctx.state.currentLaunchCommand, timer: undefined as never };
                        pending.timer = setTimeout(() => { this.pendingCompletions.delete(taskId); this.complete(pending.timing, pending.samples, pending.completedAt, { config: pending.config, launchCommand: pending.launchCommand }); }, 500);
                        pending.timer.unref();
                        this.pendingCompletions.set(taskId, pending);
                        this.rememberCompleted(taskId);
                    }
                } else if (segment.startsWith('draft acceptance')) {
                    const m = segment.match(/=\s*([\d.]+)\s*\(\s*(\d+)\s*accepted\s*\/\s*(\d+)\s*generated\s*\)(?:\s*,\s*mean len\s*=\s*([\d.]+))?/);
                    const pending = this.pendingCompletions.get(taskId);
                    if (m && pending) {
                        clearTimeout(pending.timer); this.pendingCompletions.delete(taskId);
                        Object.assign(pending.timing, { draftAcceptRate: parseFloat(m[1]), draftAccepted: parseInt(m[2], 10), draftGenerated: parseInt(m[3], 10), draftMeanLen: m[4] != null ? parseFloat(m[4]) : null });
                        this.complete(pending.timing, pending.samples, pending.completedAt, { config: pending.config, launchCommand: pending.launchCommand });
                    }
                }
            }
        } else if (line.includes('stop processing: n_tokens =')) {
            const m = line.match(/task\s+(\d+)/);
            if (m) { const taskId = m[1]; const live = { ...this.progress }; const config = this.ctx.state.currentLaunchConfig; const command = this.ctx.state.currentLaunchCommand; setTimeout(() => { if (this.pendingCompletions.has(taskId) || this.recentlyCompleted.has(taskId) || (!live.genTokens && !live.prefillTokens)) return; this.rememberCompleted(taskId); this.complete({ promptTokens: live.prefillTokens ?? null, promptTps: live.prefillTps ?? null, genTokens: live.genTokens ?? null, genTps: live.genTps ?? null, aborted: true }, this.takeSamples?.() || [], Date.now(), { config, launchCommand: command }); }, 400).unref(); }
        } else if (fatalLogs.isFatalLogLine(line)) {
            this.ctx.state.serverState = 'stopped';
            this.killProcess();
            const message = line.includes('failed to fit params')
                ? 'Failed to allocate VRAM: Reduce n_gpu_layers or use a smaller model.'
                : 'Process error: ' + line.trim().slice(-200);
            this.ctx.broadcast('', message);
        }
    }

    private rememberCompleted(taskId: string): void {
        this.recentlyCompleted.add(taskId);
        const timer = setTimeout(() => this.recentlyCompleted.delete(taskId), 30000);
        timer.unref?.();
    }

    private pushLog(line: string): void {
        if (!line.length) return;
        this.logBuffer.push(line);
        if (this.logBuffer.length > MASTER_LOG_BUFFER_SIZE) this.logBuffer.shift();
        // Fan out to live subscribers after the ring is updated so a
        // subscriber reading logs() never sees a line before pushLog saw it.
        for (const listener of this.lineListeners) {
            try { listener(line); } catch { /* one broken subscriber must not kill log capture */ }
        }
    }

    private reset(): void {
        this.proc = null;
        this.ctx.state.serverState = 'stopped';
        this.ctx.state.currentModel = '';
        this.ctx.state.isRpc = false;
        this.ctx.state.currentLaunchConfig = null;
    }
}

// Shell-safe quoting for the displayed/copied launch command. JSON.stringify
// is NOT shell-safe ($, backtick, ! still expand inside its double quotes);
// single quotes are inert except for the '\'' escape. Verbatim port of the
// server4.js shellQuoteArg -- the broadcast/displayed command is frozen.
function shellQuoteArg(arg: string): string {
    const s = String(arg);
    if (s.length === 0) return "''";
    if (/^[A-Za-z0-9._\/:-]+$/.test(s)) return s;
    return "'" + s.replace(/'/g, "'\\''") + "'";
}

export function formatCommand(command: string, args: string[]): string {
    return [shellQuoteArg(command), ...args.map(shellQuoteArg)].join(' ');
}
