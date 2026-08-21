import type { LaunchConfig } from '../../../shared/contracts';
import type { ServerCtx } from './types';
import launch = require('../lib/launch');
import tokenize = require('../lib/tokenize');
import fatalLogs = require('../lib/fatallogs');

const MASTER_LOG_BUFFER_SIZE = 500;

type Timing = Record<string, number | string | boolean | null | undefined>;
type Pending = {
    timing: Timing;
    samples: unknown[];
    completedAt: number;
    config: Record<string, unknown> | null;
    launchCommand: string;
    timer: ReturnType<typeof setTimeout>;
};

type LlamaOptions = {
    onActivity?: () => void;
    takeSamples?: () => unknown[];
    logCompletedRequest?: (timing: Timing, samples: unknown[], completedAt: number, opts: { config: Record<string, unknown> | null; launchCommand: string }) => Promise<void>;
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
    private proc: Bun.Subprocess | null = null;
    private logBuffer: string[] = [];
    private progress: LiveProgress = {};
    private takeSamples?: () => unknown[];
    private logCompletedRequest?: LlamaOptions['logCompletedRequest'];
    private taskTimings = new Map<string, Timing>();
    private pendingCompletions = new Map<string, Pending>();
    private recentlyCompleted = new Set<string>();
    onExit?: (code: number) => void;

    constructor(ctx: ServerCtx, opts: LlamaOptions = {}) {
        this.ctx = ctx;
        this.onActivity = opts.onActivity;
        this.takeSamples = opts.takeSamples;
        this.logCompletedRequest = opts.logCompletedRequest;
    }

    private complete(timing: Timing, samples: unknown[], completedAt: number, opts: { config: Record<string, unknown> | null; launchCommand: string }): void {
        this.logCompletedRequest?.(timing, samples, completedAt, opts).catch(() => {});
    }

    get running(): boolean {
        return this.proc !== null;
    }

    get logs(): readonly string[] {
        return this.logBuffer;
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
        this.ctx.state.currentModel = launchConfig.config.model || launchConfig.config.modelPath || '';
        this.ctx.state.isRpc = !!launchConfig.config.rpcTarget;
        this.ctx.state.currentLaunchConfig = launchConfig.config;
        this.ctx.state.serverState = 'starting';
        this.ctx.state.loadStartTime = Date.now();
        this.ctx.state.finalLoadTime = 0;
        this.logBuffer = [];
        this.ctx.broadcast();
        this.ctx.state.currentLaunchCommand = formatCommand(command, args);
        console.log('LAUNCHING:', this.ctx.state.currentLaunchCommand);
        this.ctx.broadcast('', 'LAUNCH CMD: ' + this.ctx.state.currentLaunchCommand);
        try {
            this.spawn(command, args);
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
    stop(): void {
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
                for (const line of lines) this.handleLine(line, proc);
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

    private handleLine(line: string, proc: Bun.Subprocess): void {
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
            proc.kill();
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
