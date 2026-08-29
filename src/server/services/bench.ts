import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tokenizeCommand } from '../lib/tokenize';
import { SseLogPrefixes, type BenchStatusResponse, type LaunchConfig, type TelemetrySample } from '../../../shared/contracts';
import type { ServerCtx } from './types';

type BenchConfig = LaunchConfig & { label?: string };

type BenchDeps = {
    benchBinFor: (build: unknown) => string;
    takeSamples: () => TelemetrySample[];
    // Read-only peek at the live request samples while a bench run is in
    // flight (original /api/bench/status behavior: live while running, last
    // run's snapshot when stopped).
    liveSamples: () => TelemetrySample[];
    onBenchLine: (line: string) => void;
    onBenchDone: (tag: string) => void;
    llamaRunning: () => boolean;
};

type StartResult = {
    error?: string;
    code?: 400 | 409;
    ok?: true;
    queued?: number;
    command?: string;
};

const BENCH_OUTPUT_MAX_LINES = 4000;

export class BenchService {
    private process: ReturnType<typeof Bun.spawn> | null = null;
    private output: string[] = [];
    private running = false;
    private command = '';
    private queue: BenchConfig[] = [];
    private queueTotal = 0;
    private currentLabel = '';
    private lastSamples: TelemetrySample[] = [];
    private logWriteChain: Promise<void> = Promise.resolve();

    private ctx: ServerCtx;
    private deps: BenchDeps;

    constructor(ctx: ServerCtx, deps: BenchDeps) {
        this.ctx = ctx;
        this.deps = deps;
    }

    status(): BenchStatusResponse {
        return {
            running: this.running,
            command: this.command,
            output: this.output,
            queueRemaining: this.queue.length,
            queueTotal: this.queueTotal,
            currentLabel: this.running ? this.currentLabel : '',
            samples: this.running ? this.deps.liveSamples() : this.lastSamples
        };
    }

    async restore(): Promise<string[]> {
        try {
            const history = await fs.readFile(path.join(this.ctx.config.paths.logsDirectory, 'bench-history.log'), 'utf8');
            this.output = history.split('\n').filter(line => line !== '').slice(-1500);
        } catch {
            this.output = [];
        }
        return this.output;
    }

    note(lines: unknown): void {
        const noteLines = Array.isArray(lines) ? lines.slice(0, 200) : [];
        for (const line of noteLines) this.log(String(line).slice(0, 2000));
    }

    clear(): void {
        this.output = [];
    }

    dequeue(label: unknown): { removed: number; queueRemaining: number } {
        const before = this.queue.length;
        this.queue = this.queue.filter(run => run.label !== label);
        if (this.queue.length !== before) this.log('[matrix] dequeued: ' + String(label));
        return { removed: before - this.queue.length, queueRemaining: this.queue.length };
    }

    stop(): void {
        this.queue = [];
        this.queueTotal = 0;
        this.process?.kill('SIGTERM');
    }

    // Shutdown escalation after the grace period (called by the entry).
    killForce(): void {
        try { this.process?.kill('SIGKILL'); } catch { /* already gone */ }
    }

    start(cfg: Record<string, unknown>): StartResult {
        if (this.running) return { error: 'A bench run is already in progress', code: 409 };
        if (this.deps.llamaRunning()) return { error: 'Stop the running model first -- llama-bench needs its VRAM for clean numbers', code: 409 };
        if (Array.isArray(cfg.queue)) {
            const queue = cfg.queue as BenchConfig[];
            if (queue.length === 0 || queue.some(run => !run || !run.modelPath)) return { error: 'queue must be non-empty configs with modelPath', code: 400 };
            this.queue = queue.slice(1);
            this.queueTotal = queue.length;
            const first = queue[0];
            this.currentLabel = first.label || first.devices || 'run';
            this.log('===== llama-bench 1/' + this.queueTotal + ': ' + this.currentLabel + ' =====');
            const error = this.launch(first);
            if (error) return { error, code: 400 };
            return { ok: true, queued: this.queue.length, command: this.command };
        }
        const run = cfg as BenchConfig;
        if (!run.modelPath) return { error: 'modelPath is required', code: 400 };
        this.queue = [];
        this.queueTotal = 0;
        const error = this.launch(run);
        if (error) return { error, code: 400 };
        return { ok: true, command: this.command };
    }

    private launch(config: BenchConfig): string | null {
        const args = ['-m', config.modelPath!];
        if (config.rawArgs) {
            args.push(...tokenizeCommand(String(config.rawArgs).trim()));
        } else {
            if (config.fa != null) args.push('-fa', config.fa ? '1' : '0');
            if (config.cacheK) args.push('-ctk', config.cacheK);
            if (config.cacheV) args.push('-ctv', config.cacheV);
            // '' guards: a blanked-out UI field arrives as '' and must not
            // emit a flag with an empty value (parity with server4.js).
            if (config.nPrompt != null && String(config.nPrompt) !== '') args.push('-p', String(config.nPrompt));
            if (config.nGen != null && String(config.nGen) !== '') args.push('-n', String(config.nGen));
            if (config.depths) args.push('-d', String(config.depths));
            if (config.reps != null && config.reps !== '') args.push('-r', String(config.reps));
            if (config.devices) args.push('-dev', String(config.devices));
            if (config.splitMode) args.push('-sm', String(config.splitMode));
            if (config.tensorSplit) args.push('-ts', String(config.tensorSplit));
            if (config.extraArgs) args.push(...tokenizeCommand(String(config.extraArgs).trim()));
        }
        let benchBin: string;
        try {
            benchBin = this.deps.benchBinFor(config.build);
        } catch (error) {
            return (error as Error).message;
        }
        return this.spawn(benchBin, args);
    }

    private spawn(command: string, args: string[]): string | null {
        this.running = true;
        this.command = [command, ...args].join(' ');
        this.log('--- ' + new Date().toLocaleString() + ' ---');
        this.log('$ ' + this.command);
        let process: ReturnType<typeof Bun.spawn>;
        try {
            process = Bun.spawn([command, ...args], { stdout: 'pipe', stderr: 'pipe' });
        } catch (error) {
            this.running = false;
            const message = (error as Error).message;
            this.log('[bench] failed to spawn: ' + message);
            return message;
        }
        this.process = process;
        let finished = false;
        const finish = (line: string, tag: string): void => {
            if (finished) return;
            finished = true;
            this.running = false;
            this.process = null;
            this.lastSamples = this.deps.takeSamples();
            this.log(line);
            this.deps.onBenchDone(tag);
            this.startNext();
        };
        const streams = Promise.all([this.readOutput(process.stdout), this.readOutput(process.stderr)]);
        void process.exited.then(
            code => streams.then(() => {
                const signal = process.signalCode;
                finish('[bench] exited with ' + (signal ? 'signal ' + signal : 'code ' + code), SseLogPrefixes.BENCH_DONE + ':' + (signal ? 'signal' : code));
            }),
            error => streams.then(() => finish('[bench] error: ' + (error as Error).message, SseLogPrefixes.BENCH_DONE + ':error'))
        ).catch(error => finish('[bench] error: ' + (error as Error).message, SseLogPrefixes.BENCH_DONE + ':error'));
        return null;
    }

    private async readOutput(stream: ReadableStream<Uint8Array> | number | null | undefined): Promise<void> {
        if (!stream || typeof stream === 'number') return;
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += value ? decoder.decode(value, { stream: true }) : '';
                const lines = buffer.split(/\r\n|\r|\n/);
                buffer = lines.pop()!;
                for (const line of lines) this.log(line);
            }
            if (buffer) this.log(buffer);
        } finally {
            reader.releaseLock();
        }
    }

    private startNext(): void {
        try {
            if (this.queue.length === 0) {
                this.queueTotal = 0;
                return;
            }
            if (this.deps.llamaRunning()) {
                this.log('[matrix] a model was launched mid-matrix -- aborting remaining runs');
                this.queue = [];
                this.queueTotal = 0;
                return;
            }
            const next = this.queue.shift()!;
            const index = this.queueTotal - this.queue.length;
            this.currentLabel = next.label || next.devices || 'run';
            this.log('===== llama-bench ' + index + '/' + this.queueTotal + ': ' + this.currentLabel + ' =====');
            if (this.launch(next)) this.startNext();
        } catch (error) {
            this.queue = [];
            this.queueTotal = 0;
            this.log('[matrix] aborted: ' + (error as Error).message);
        }
    }

    private log(line: string): void {
        this.output.push(line);
        if (this.output.length > BENCH_OUTPUT_MAX_LINES) this.output = this.output.slice(-3000);
        this.deps.onBenchLine(line);
        this.logWriteChain = this.logWriteChain
            .then(() => fs.appendFile(path.join(this.ctx.config.paths.logsDirectory, 'bench-history.log'), line + '\n'))
            .catch(() => {});
    }
}