import type { TelemetrySample } from '../../../shared/contracts';
import type { ServerCtx, TelemetryStats } from './types';

export interface LiveProgress {
    prefillTps?: number;
    prefillProgress?: number;
    prefillTokens?: number;
    genTps?: number;
}

export interface TelemetryDeps {
    benchRunning: () => boolean;
    fetchSlots: (port: number) => Promise<unknown>;
    liveProgress: {
        get: () => LiveProgress;
        reset: () => void;
    };
}

const ACTIVITY_TIMEOUT_MS = 3000;
const MAX_SAMPLES_PER_REQUEST = 300;
const MAX_RECENT_REQUEST_SAMPLES = 30;

function toFiniteNumber(value: unknown): number | undefined {
    if (value === null || value === undefined || typeof value === 'boolean') return undefined;
    if (typeof value === 'string' && value.trim() === '') return undefined;
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
}

export class TelemetryService {
    private readonly ctx: ServerCtx;
    private readonly deps: TelemetryDeps;
    private activeRequestSamples: TelemetrySample[] = [];
    private lastActivityTimestamp = 0;
    private telemetrySampleInFlight = false;
    private telemetryPollMs: number;
    private telemetryLoopTimer: ReturnType<typeof setInterval> | null = null;
    private lastServerTelemetry: { t: number; stats: TelemetryStats } | null = null;
    private lastSampleNetBytes: number | null = null;
    private lastSampleNetTime = 0;
    private readonly recentRequestSamples = new Map<string, TelemetrySample[]>();

    constructor(ctx: ServerCtx, deps: TelemetryDeps) {
        this.ctx = ctx;
        this.deps = deps;
        this.telemetryPollMs = ctx.config.telemetry.pollMs;
    }

    start(): void {
        if (this.telemetryLoopTimer) clearInterval(this.telemetryLoopTimer);
        this.telemetryLoopTimer = setInterval(() => void this.poll(), this.telemetryPollMs);
    }

    setPollMs(milliseconds: number): number {
        this.telemetryPollMs = Math.max(250, Math.min(5000, parseInt(String(milliseconds), 10) || 1000));
        this.start();
        return this.telemetryPollMs;
    }

    latest(): { t: number; stats: TelemetryStats } | null {
        return this.lastServerTelemetry;
    }

    async fetchStats(): Promise<TelemetryStats | null> {
        try {
            const body: { local_second_gpu?: string; worker_ssh?: unknown } = {};
            if (this.ctx.state.currentLaunchConfig?.deviceB) body.local_second_gpu = 'amd';
            else if (this.ctx.state.currentLaunchConfig?.rpcTarget) body.worker_ssh = this.ctx.state.currentLaunchConfig.rpcTarget;
            else if (!this.ctx.state.currentLaunchConfig) body.local_second_gpu = 'amd';
            const response = await fetch(`http://${this.ctx.config.telemetry.host}:${this.ctx.config.telemetry.port}/stats`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(10000)
            });
            return await response.json() as TelemetryStats;
        } catch {
            return null;
        }
    }

    markActivity(): void {
        this.lastActivityTimestamp = Date.now();
        if (this.activeRequestSamples.length === 0) void this.takeOneSample();
    }

    takeSamples(): TelemetrySample[] {
        const samples = this.activeRequestSamples;
        this.activeRequestSamples = [];
        this.deps.liveProgress.reset();
        return samples;
    }

    // Read-only peek (original /api/bench/status + /api/logs/active-samples
    // behavior) — does NOT drain the buffer the completion path still needs.
    liveSamples(): TelemetrySample[] {
        return this.activeRequestSamples;
    }

    recentSamples(runId: string): TelemetrySample[] {
        return this.recentRequestSamples.get(runId) || [];
    }

    rememberSamples(runId: string, samples: TelemetrySample[]): void {
        if (!samples || samples.length === 0) return;
        this.recentRequestSamples.set(runId, samples);
        if (this.recentRequestSamples.size > MAX_RECENT_REQUEST_SAMPLES) {
            const oldestKey = this.recentRequestSamples.keys().next().value;
            if (oldestKey !== undefined) this.recentRequestSamples.delete(oldestKey);
        }
    }

    stop(): void {
        if (this.telemetryLoopTimer) clearInterval(this.telemetryLoopTimer);
        this.telemetryLoopTimer = null;
    }

    private async takeOneSample(statsArg?: TelemetryStats | null): Promise<void> {
        if (this.telemetrySampleInFlight) return;
        this.telemetrySampleInFlight = true;
        try {
            const stats = statsArg || await this.fetchStats();
            if (!stats) return;
            try {
                const port = toFiniteNumber(this.ctx.state.currentLaunchConfig?.port) ?? this.ctx.config.llama.defaultPort;
                const slots = await this.deps.fetchSlots(port);
                const slot = Array.isArray(slots) ? slots[0] as Record<string, unknown> | undefined : undefined;
                if (slot && slot.n_ctx) this.ctx.broadcast(`CTX_LIVE:${slot.n_prompt_tokens ?? 0}:${slot.n_ctx}:${slot.is_processing ? 1 : 0}`);
            } catch { /* endpoint disabled/unreachable -- context card stays client-driven */ }
            let netMbps: number | null = null;
            const netBytes = stats.master?.net_bytes;
            if (typeof netBytes === 'number' && this.lastSampleNetBytes !== null && netBytes >= this.lastSampleNetBytes && this.lastSampleNetTime) {
                const deltaSeconds = (Date.now() - this.lastSampleNetTime) / 1000;
                if (deltaSeconds > 0.05) netMbps = +(((netBytes - this.lastSampleNetBytes) / 1048576) / deltaSeconds).toFixed(2);
            }
            if (typeof netBytes === 'number') {
                this.lastSampleNetBytes = netBytes;
                this.lastSampleNetTime = Date.now();
            }
            const progress = this.deps.liveProgress.get();
            this.activeRequestSamples.push({
                t: Date.now(),
                netMbps,
                masterPwr: stats.master?.gpu_pwr ?? 0,
                masterTemp: stats.master?.gpu_temp ?? 0,
                masterGpuUtil: stats.master?.gpu_util ?? 0,
                masterCpuUtil: stats.master?.cpu_util ?? 0,
                workerPwr: stats.worker?.gpu_pwr ?? 0,
                workerTemp: stats.worker?.gpu_temp ?? 0,
                workerGpuUtil: stats.worker?.gpu_util ?? 0,
                masterVram: stats.master?.vram_used != null ? +(stats.master.vram_used / 1024).toFixed(2) : null,
                workerVram: stats.worker?.vram_used != null ? +(stats.worker.vram_used / 1024).toFixed(2) : null,
                prefillTps: progress.prefillTps ?? null,
                prefillProgress: progress.prefillProgress ?? null,
                prefillPos: progress.prefillTokens ?? null,
                genTps: progress.genTps ?? null
            });
            if (this.activeRequestSamples.length > MAX_SAMPLES_PER_REQUEST) this.activeRequestSamples.shift();
        } finally {
            this.telemetrySampleInFlight = false;
        }
    }

    private async poll(): Promise<void> {
        if (this.telemetrySampleInFlight) return;
        const stats = await this.fetchStats();
        if (!stats) return;
        this.lastServerTelemetry = { t: Date.now(), stats };
        const recording = this.deps.benchRunning() || Date.now() - this.lastActivityTimestamp < ACTIVITY_TIMEOUT_MS;
        if (recording) await this.takeOneSample(stats);
    }
}
