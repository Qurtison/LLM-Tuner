import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as csv from '../lib/csv';
import type { ServerCtx, TelemetryStats } from './types';

export const CSV_HEADERS = 'Timestamp,run_id,model_name,Model_Path,Ctx,NGL,RPC,Transport,arg_string,launch_command,Prompt Tok/s,Gen Tok/s,Prompt Latency (s),prompt_tokens,Master GPU Util (%),Master GPU Pwr (W),Master GPU Temp (C),Master CPU Util (%),Master CPU Temp (C),Master VRAM (MB),Master RAM (MB),Worker GPU Util (%),Worker GPU Pwr (W),Worker GPU Temp (C),Worker CPU Temp (C),Worker VRAM (MB),Worker RAM (MB),Net Throughput (MB/s),Gen Tokens,Reasoning Tokens,Wall Time (s),Load Time,config_json,Draft Accept Rate,Draft Accepted,Draft Generated,Draft Mean Len,Aborted\n';

// Structural superset of shared/contracts LaunchConfig: keeps the fields the
// CSV row reads, with loose value types, and (unlike the contracts interface)
// carries no index signature so either type is assignable here.
type LaunchConfig = {
    modelPath?: string;
    ctx?: unknown;
    ngl?: unknown;
    rpcTarget?: unknown;
    transport?: unknown;
    argString?: unknown;
};
type Sample = Record<string, unknown>;
type Telemetry = TelemetryStats;

export type CsvLogDeps = {
    fetchStats: () => Promise<unknown | null>;
    finalLoadTime: () => number;
    rememberSamples: (id: string, s: unknown[]) => void;
};

export function generateRunId(): string {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(16).slice(2, 6);
    return `${ts}_${rand}`;
}

export async function appendBenchmarkRow(logsDir: string, data: Record<string, unknown>): Promise<string> {
    await fs.mkdir(logsDir, { recursive: true });
    const timestamp = new Date().toISOString();
    const runId = generateRunId();
    const modelPath = data.model || '';
    const modelName = String(modelPath).split('/').pop();
    const fields = [
        timestamp, runId, csv.csvQuote(csv.csvValue(modelName)), csv.csvQuote(csv.csvValue(modelPath)),
        csv.csvValue(data.ctx), csv.csvValue(data.ngl), csv.csvValue(data.rpc),
        csv.csvQuote(csv.csvValue(data.transport)), csv.csvQuote(csv.csvValue(data.argString)), csv.csvQuote(csv.csvValue(data.launchCommand)),
        csv.csvValue(data.promptTps), csv.csvValue(data.genTps), csv.csvValue(data.promptLatency), csv.csvValue(data.promptTokens),
        csv.csvValue(data.gpuUtil), csv.csvValue(data.gpuPwr), csv.csvValue(data.masterGpuTemp), csv.csvValue(data.cpuUtil), csv.csvValue(data.masterCpuTemp), csv.csvValue(data.gpuMem), csv.csvValue(data.ramUsage),
        csv.csvValue(data.workerGpuUtil), csv.csvValue(data.workerGpuPwr), csv.csvValue(data.workerGpuTemp), csv.csvValue(data.workerCpuTemp), csv.csvValue(data.workerVram), csv.csvValue(data.workerRam),
        csv.csvValue(data.netThroughput), csv.csvValue(data.genTokens), csv.csvValue(data.reasonTokens), csv.csvValue(data.wallTime), csv.csvValue(data.loadTime), csv.csvQuote(csv.csvValue(data.configJson)),
        csv.csvValue(data.draftAcceptRate), csv.csvValue(data.draftAccepted), csv.csvValue(data.draftGenerated), csv.csvValue(data.draftMeanLen), data.aborted ? '1' : ''
    ];
    await fs.appendFile(path.join(logsDir, 'benchmarks.csv'), fields.join(',') + '\n');
    return runId;
}

export async function logCompletedRequest(ctx: ServerCtx, deps: CsvLogDeps, timing: Record<string, unknown>, samples: unknown[], completedAt: number, { config: cfgParam, launchCommand: launchCmdParam }: { config?: LaunchConfig | null; launchCommand?: string } = {}): Promise<void> {
    try {
        const requestSamples = samples || [];
        const doneAt = completedAt || Date.now();
        const cfgSource = cfgParam || ctx.state.currentLaunchConfig;
        const cfg = (cfgSource || {}) as LaunchConfig;
        const launchCmd = launchCmdParam !== undefined ? launchCmdParam : ctx.state.currentLaunchCommand;
        const genMs = timing.genMs as number | null | undefined;
        if (requestSamples.length > 0 && genMs != null) {
            const prefillEndTime = doneAt - genMs;
            for (const unknownSample of requestSamples) {
                const sample = unknownSample as Sample;
                if ((sample.t as number) < prefillEndTime) {
                    sample.prefillTps = sample.prefillTps ?? timing.promptTps ?? null;
                    sample.genTps = null;
                } else {
                    sample.prefillTps = null;
                    sample.genTps = sample.genTps ?? timing.genTps ?? null;
                }
            }
        }
        const stats = await deps.fetchStats() as Telemetry | null;
        const master = stats?.master || {};
        const worker = stats?.worker || {};
        const runId = await appendBenchmarkRow(ctx.config.paths.logsDirectory, {
            model: cfg.modelPath || '', ctx: cfg.ctx || '', ngl: cfg.ngl || '', rpc: cfg.rpcTarget ? 'yes' : 'no', transport: cfg.rpcTarget ? (cfg.transport || '') : 'Local', argString: cfg.argString || '', launchCommand: launchCmd,
            promptTps: timing.promptTps ?? '', genTps: timing.genTps ?? '', promptLatency: timing.promptMs != null ? ((timing.promptMs as number) / 1000).toFixed(2) : '', promptTokens: timing.promptTokens ?? '',
            gpuUtil: master.gpu_util, gpuPwr: master.gpu_pwr, masterGpuTemp: master.gpu_temp, cpuUtil: master.cpu_util, masterCpuTemp: master.cpu_temp, gpuMem: master.vram_used, ramUsage: master.process_ram ?? master.ram_used,
            workerGpuUtil: worker.gpu_util, workerGpuPwr: worker.gpu_pwr, workerGpuTemp: worker.gpu_temp, workerCpuTemp: worker.cpu_temp, workerVram: worker.vram_used, workerRam: worker.process_ram ?? worker.ram_used,
            genTokens: timing.genTokens ?? '', wallTime: timing.wallTimeS ?? '', loadTime: deps.finalLoadTime() || '', configJson: cfgSource ? JSON.stringify(cfgSource) : '',
            draftAcceptRate: timing.draftAcceptRate, draftAccepted: timing.draftAccepted, draftGenerated: timing.draftGenerated, draftMeanLen: timing.draftMeanLen, aborted: !!timing.aborted
        });
        deps.rememberSamples(runId, requestSamples);
        ctx.broadcast('COMPLETION:' + JSON.stringify({
            runId, timestamp: Date.now(), model: (cfg.modelPath || '').split('/').pop(), promptTps: timing.promptTps, genTps: timing.genTps, promptTokens: timing.promptTokens, genTokens: timing.genTokens, wallTime: timing.wallTimeS,
            draftAcceptRate: timing.draftAcceptRate ?? null, draftAccepted: timing.draftAccepted ?? null, draftGenerated: timing.draftGenerated ?? null, draftMeanLen: timing.draftMeanLen ?? null, aborted: !!timing.aborted, metrics: requestSamples
        }));
    } catch (err) {
        console.error('Failed to log completed request:', err);
    }
}
