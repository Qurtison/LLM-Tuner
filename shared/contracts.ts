/*
 * API types captured at Phase 1 from docs/api-inventory.md.
 * Server (Phase 3) and client (Phase 4+) must match.
 */

export type ServerState = 'stopped' | 'loading' | 'ready' | 'starting' | 'stopping';

export type LaunchConfig = {
    modelPath?: string;
    model?: string;
    ctx?: number;
    ngl?: number;
    port?: number;
    build?: string;
    rawCommand?: string;
    rawArgs?: string;
    rpcTarget?: string;
    fa?: boolean;
    cacheK?: string;
    cacheV?: string;
    nPrompt?: number;
    nGen?: number;
    depths?: string;
    reps?: string;
    devices?: string;
    splitMode?: string;
    tensorSplit?: string;
    extraArgs?: string;
    specType?: string;
    specDraftNMax?: number;
    specDraftNMin?: number;
    specDraftModel?: string;
    specNgramSizeN?: number;
    specNgramSizeM?: number;
    specNgramMinHits?: number;
    specDraftNgl?: number;
    preserveThinking?: boolean;
    reasoningPreserve?: boolean;
    chatTemplateFile?: string;
    jinja?: boolean;
    loadMode?: string;
    verbosity?: number;
    argString?: string;
    temp?: number;
    deviceA?: string;
    deviceB?: string;
    transport?: string;
    label?: string;
    // Registry params with no dedicated LaunchConfig field, keyed by param
    // id (shared/llama-params.ts). Rendered to CLI flags by the launch
    // resolver; dedicated fields above always win for the same param.
    paramOverrides?: Record<string, unknown>;
    // Router mode: launch llama-server with --models-dir and no -m, so the
    // server discovers GGUF files and loads them on demand. Everything a
    // single model needs moves into a generated preset INI (--models-preset);
    // see src/server/lib/router.ts. Omitted or disabled = single-model mode.
    router?: RouterConfig;
};
// One model the router should know about beyond plain discovery. A section is
// only emitted when it carries something the shared `[*]` block cannot:
// `loadOnStartup` (no global equivalent) or a value that differs.
export interface RouterModelConfig {
    // A GGUF file, or a directory under modelsDir holding one (multi-shard
    // models and mmproj files live that way). The router matches the entry by
    // its id, so a file inside a model directory resolves to that directory.
    modelPath: string;
    // Load as soon as the router starts, so the dashboard comes up serving
    // this model with no client interaction.
    loadOnStartup?: boolean;
    // Per-model context size; overrides the shared block.
    ctx?: number;
    // Per-model param overrides, same bag and param ids as LaunchConfig.
    paramOverrides?: Record<string, unknown>;
}

export interface RouterConfig {
    enabled: boolean;
    // Defaults to paths.modelDirectories[0] from the server config.
    modelsDir?: string;
    // --models-max: how many models stay resident at once. 0 = unlimited.
    // Left unset, llama-server defaults to 4.
    maxModels?: number;
    // false adds --no-models-autoload, so a request naming an unloaded model
    // fails instead of loading it. Unset = autoload (the llama-server default).
    autoload?: boolean;
    models?: RouterModelConfig[];
}


export interface SseStatePayload {
    state: ServerState;
    model: string;
    isRpc: boolean;
    log: string;
    error: string;
    loadStartTime: number;
    finalLoadTime: number;
    launchCommand: string;
    launchConfig: LaunchConfig | null;
}

export const SseLogPrefixes = {
    PREFILL_PROGRESS: 'PREFILL_PROGRESS',
    GEN_PROGRESS: 'GEN_PROGRESS',
    CTX_LIVE: 'CTX_LIVE',
    COMPLETION: 'COMPLETION',
    BENCH: 'BENCH',
    BENCH_DONE: 'BENCH_DONE',
    LAUNCH_CMD: 'LAUNCH CMD: '
} as const;

export interface TelemetrySample {
    t: number;
    netMbps: number | null;
    masterPwr: number;
    masterTemp: number;
    masterGpuUtil: number;
    masterCpuUtil: number;
    workerPwr: number;
    workerTemp: number;
    workerGpuUtil: number;
    masterVram: number | null;
    workerVram: number | null;
    prefillTps: number | null;
    prefillProgress: number | null;
    prefillPos: number | null;
    genTps: number | null;
}

export interface CompletionEvent {
    runId: string;
    timestamp: number;
    model: string;
    promptTps: number | null;
    genTps: number | null;
    promptTokens: number | null;
    genTokens: number | null;
    wallTime: number | null;
    draftAcceptRate: number | null;
    draftAccepted: number | null;
    draftGenerated: number | null;
    draftMeanLen: number | null;
    aborted: boolean;
    metrics: TelemetrySample[];
}

export type BenchStartRequest =
    | (LaunchConfig & { queue?: never })
    | { queue: (LaunchConfig & { label?: string })[] };

export interface BenchmarkLogRequest {
    model?: string;
    ctx?: number;
    ngl?: number;
    rpc?: string;
    transport?: string;
    argString?: string;
    launchCommand?: string;
    promptTps?: number;
    genTps?: number;
    promptLatency?: number;
    promptTokens?: number;
    gpuUtil?: number;
    gpuPwr?: number;
    masterGpuTemp?: number;
    cpuUtil?: number;
    masterCpuTemp?: number;
    gpuMem?: number;
    ramUsage?: number;
    workerGpuUtil?: number;
    workerGpuPwr?: number;
    workerGpuTemp?: number;
    workerCpuTemp?: number;
    workerVram?: number;
    workerRam?: number;
    netThroughput?: number;
    genTokens?: number;
    reasonTokens?: number;
    wallTime?: number;
    loadTime?: number;
    configJson?: string;
    draftAcceptRate?: number;
    draftAccepted?: number;
    draftGenerated?: number;
    draftMeanLen?: number;
    aborted?: boolean;
}

export interface WorkerRequest {
    worker_ssh?: string;
}

export interface TelemetryRateRequest {
    ms: number;
}

export interface ModelEntry {
    name: string;
    path: string;
    size: string;
    source: 'local' | 'huggingface';
}

export type ModelsResponse = ModelEntry[];

export interface BuildEntry {
    id: string;
    label: string;
    path: string;
}

export interface BuildsResponse {
    builds: BuildEntry[];
}

export interface LogCreatedResponse {
    success: true;
    run_id: string;
}

export interface SamplesResponse {
    samples: TelemetrySample[];
}

export type ActiveSamplesResponse = SamplesResponse;

export interface RecentRequestRow {
    timestamp: string;
    runId: string;
    model: string;
    transport: string;
    promptTps: number | null;
    genTps: number | null;
    promptTokens: number | null;
    genTokens: number | null;
    wallTime: number | null;
    draftAcceptRate: number | null;
    draftAccepted: number | null;
    draftGenerated: number | null;
    draftMeanLen: number | null;
    aborted: boolean | null;
}

export interface RecentRequestsResponse {
    rows: RecentRequestRow[];
}

export interface LogsSummaryResponse {
    count: number;
    lastModel?: string;
    lastConfig?: unknown;
    lastTimestamp?: string;
    lastPromptTps?: number | null;
    lastGenTps?: number | null;
    lastLoadTime?: number | null;
    filtered?: boolean;
    avgPromptTps?: number | null;
    avgGenTps?: number | null;
    avgPromptLatency?: number | null;
    avgWallTime?: number | null;
    avgLoadTime?: number | null;
    bestPromptTps?: number | null;
    bestGenTps?: number | null;
    bestPromptLatency?: number | null;
    bestWallTime?: number | null;
    bestLoadTime?: number | null;
}

export interface BenchStatusResponse {
    running: boolean;
    command: string;
    output: string[];
    queueRemaining: number;
    queueTotal: number;
    currentLabel: string;
    samples: TelemetrySample[];
}

// /api/bench/stream SSE frame: current bench state without the output array
// (lines already flow per-line over the /api/status BENCH: broadcast).
export interface BenchStreamFrame {
    running: boolean;
    command: string;
    queueRemaining: number;
    queueTotal: number;
    currentLabel: string;
    samples: TelemetrySample[];
}

export interface BenchStartResponse {
    ok: true;
    command: string;
    queued?: number;
}

export interface BenchOpResponse {
    ok: true;
}

export interface BenchRestoreResponse extends BenchOpResponse {
    output: string[];
}

export interface BenchDequeueResponse extends BenchOpResponse {
    removed: number;
    queueRemaining: number;
}

export interface FlagsResponse {
    flags: FlagEntry[];
    error?: string;
}

export interface FlagEntry {
    flags: string;
    description: string;
    section: string;
    insertText: string;
    primaryFlag: string;
}

export interface Device {
    id: string;
    description: string;
    totalMib: number;
    freeMib: number;
}

export interface DevicesResponse {
    devices: Device[];
    error?: string;
}

export interface PreviewCommandResponse {
    command: string;
    // Router mode only: the generated model preset the command line points at
    // via --models-preset, holding every per-model knob. Absent in
    // single-model mode.
    ini?: string;
    error?: string;
}

export interface StartResponse {
    status: 'launching';
}

export interface StopResponse {
    status: 'stopped';
}

export type WorkerStartStopResponse =
    | { success: true; stdout: string; stderr: string }
    | { success: false; error: string };

export type WorkerStatusResponse =
    | { status: 'running' | 'stopped' }
    | { status: 'offline'; error: string };

export interface WorkerLogsResponse {
    logs: string;
}

export interface MasterLogsResponse {
    logs: string;
}

export interface TelemetryLatestResponse {
    t: number;
    stats: Record<string, unknown> | null;
}

export interface TelemetryRateResponse extends BenchOpResponse {
    ms: number;
}

export interface ErrorResponse {
    error: string;
}

export interface NotFoundResponse {
    error: 'Not found';
}

export interface ConfigResponse {
    uiDefaults: {
        contextSize: number;
        gpuLayers: number;
        tensorSplit: number;
        temperature: number;
    };
    launch: {
        modelName: string;
        build: string;
        deviceA: string;
        deviceB: string;
        splitMode: string;
        ctx: number;
        ngl: number;
        port: number;
        fa: boolean;
        cacheK: string;
        cacheV: string;
        specType: string;
        specDraftNMax: number;
        reasoningPreserve: boolean;
        jinja: boolean;
        temp: number;
        tensorSplit: number;
        extraArgs: string;
        chatTemplateFile?: string;
        chatTemplateKwargs: string;
    };
    llama: {
        defaultPort: number;
        defaultHost: string;
        rpcPort: number;
        builds: { id: string; label: string }[];
    };
    worker: {
        enabled: boolean;
        sshHost: string;
        rpcTarget: string;
        transportPresets: { id: string; label: string }[];
    };
    telemetry: {
        enabled: boolean;
        pollMs: number;
        providers: string[];
    };
}

// --- Gap-closing additions (docs/gap-analysis.md) ---

export interface Preset {
    name: string;
    build: string;
    label?: string;
    config: LaunchConfig;
}

export interface PresetsResponse {
    presets: Preset[];
    active: string | null;
}

export interface PresetSaveRequest {
    name: string;
    build?: string;
    label?: string;
    config?: LaunchConfig;
}

export interface PresetValidateResponse {
    warnings: string[];
}

export interface ApplyResult {
    ok: boolean;
    command?: string;
    warnings: string[];
    error?: string;
    restartOk?: boolean;
    restartOutput?: string;
}

export interface UnitStatus {
    activeState: string;
    subState: string;
    since: string | null;
    pid: number | null;
    restarts: number;
    result: string;
}

export interface UnitOpResponse {
    ok: boolean;
    output: string;
}

export interface UpgradeStatusResponse {
    configured: boolean;
    running: boolean;
    /** Commits on HEAD..origin/master the local checkout is behind. */
    behind: number;
    head: string;
    remote: string;
    checkedAt: number;
    checkError: string;
    /** true when the served numbers are older than the server's check TTL. */
    stale: boolean;
}

export interface FilesEntry {
    name: string;
    path: string;
    isDir: boolean;
    size: number | null;
}

export interface FilesResponse {
    root: string;
    path: string;
    entries: FilesEntry[];
}

export interface FilesDeleteResponse {
    ok: boolean;
}

export interface ServerPathsResponse {
    modelsDir: string;
    logsDir: string;
    repoDir: string | null;
    buildDirs: string[];
    activeBuildDir: string | null;
}

// --- HUGGING FACE DOWNLOADS ---
// One row per .gguf in a repo, as returned by the HF tree API. `quant` is the
// human-facing label the modal sorts and groups by (e.g. "Q4_K_M"); `group`
// is the stem shared by split shards so a 2-part quant stays together.
export interface HfRepoFile {
    path: string;
    name: string;
    size: number;
    quant: string;
    group: string;
    shard: number;
    shards: number;
    /** Already present on disk at full size -- the UI checks it and skips it. */
    present: boolean;
    /** Bytes of a previous, resumable partial (.part sibling). */
    partial: number;
}

export interface HfRepoListing {
    repo: string;
    /** models-dir-relative subfolder the files land in. */
    folder: string;
    files: HfRepoFile[];
    totalSize: number;
    presentSize: number;
}

export type HfDownloadStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface HfDownloadTask {
    id: string;
    repo: string;
    folder: string;
    status: HfDownloadStatus;
    /** Files in transfer order; the one at fileIndex is the active one. */
    files: HfRepoFile[];
    fileIndex: number;
    received: number;
    /** 0 until the first byte of a file lands and the real total is known. */
    total: number;
    /** Bytes for the files already finished in this task. */
    completedBytes: number;
    /** received + completedBytes: the task-wide progress bar. */
    taskTotal: number;
    bytesPerSecond: number;
    error: string;
    startedAt: number;
}

export interface HfDownloadsSnapshot {
    tasks: HfDownloadTask[];
}

/** /api/hf/download/stream frame: the full task list on every change. */
export interface HfDownloadStreamFrame {
    tasks: HfDownloadTask[];
}

