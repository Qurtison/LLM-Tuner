import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface Build { id: string; label: string; path: string }
export interface TransportPreset { id: string; label: string }
export interface DashboardConfig {
    server: { host: string; port: number; corsOrigins: string[]; maxBodyBytes: number };
    paths: { modelDirectories: string[]; huggingFaceCache: string; logsDirectory: string; pythonCommand: string; monitorScript: string };
    llama: { builds: Build[]; defaultPort: number; defaultHost: string; rpcPort: number };
    telemetry: { enabled: boolean; host: string; port: number; pollMs: number; providers: string[]; source: 'monitor' | 'builtin' };
    processes: { cleanupManagedPortsOnStart: boolean; stopGraceMs: number };
    service: { unitName: string; unitPath: string; enableOnApply: boolean; manageViaSystemd: boolean };
    upgrade: { repoDir: string; buildDir: string; enabled: boolean };
    worker: { sshHost: string; rpcTarget: string; workDirectory: string; startCommand: string; stopCommand: string; statusCommand: string; logsCommand: string; transportPresets: TransportPreset[] };
    uiDefaults: { contextSize: number; gpuLayers: number; tensorSplit: number; temperature: number };
    launch: { modelPath: string; modelName: string; build: string; deviceA: string; deviceB: string; splitMode: string; ctx: number; ngl: number; port: number; fa: boolean; cacheK: string; cacheV: string; specType: string; specDraftNMax: number; reasoningPreserve: boolean; jinja: boolean; temp: number; tensorSplit: number; extraArgs: string; chatTemplateFile: string; chatTemplateKwargs: string };
}

export class ConfigError extends Error {
    issues: string[];

    constructor(issues: string[]) {
        super(issues.join('; '));
        this.name = 'ConfigError';
        this.issues = issues;
    }
}

type Source = 'default' | 'file' | 'env';
type Raw = Record<string, unknown>;

const defaults = {
    server: { host: '127.0.0.1', port: 3000, corsOrigins: [], maxBodyBytes: 10 * 1024 * 1024 },
    paths: { modelDirectories: ['./models'], huggingFaceCache: null as string | null, logsDirectory: './logs', pythonCommand: 'python3', monitorScript: './monitor.py' },
    llama: { builds: [], defaultPort: 8080, defaultHost: '127.0.0.1', rpcPort: 50052 },
    telemetry: { enabled: true, host: '127.0.0.1', port: 8081, pollMs: 1000, providers: ['nvidia', 'amd', 'linux'], source: 'monitor' },
    processes: { cleanupManagedPortsOnStart: false, stopGraceMs: 3000 },
    service: { unitName: 'llama-dashboard-server.service', unitPath: '', enableOnApply: false, manageViaSystemd: false },
    upgrade: { repoDir: '', buildDir: '', enabled: false },
    worker: { sshHost: '', rpcTarget: '', workDirectory: '', startCommand: 'docker compose -f docker-compose.worker.yml up -d', stopCommand: 'docker compose -f docker-compose.worker.yml down', statusCommand: 'docker compose -f docker-compose.worker.yml ps --filter status=running -q', logsCommand: 'docker compose -f docker-compose.worker.yml logs --tail=50', transportPresets: [] },
    uiDefaults: { contextSize: 4096, gpuLayers: 0, tensorSplit: 50, temperature: 0.8 },
    launch: { modelPath: '', modelName: '', build: '', deviceA: '', deviceB: '', splitMode: 'none', ctx: 110000, ngl: 999, port: 8080, fa: true, cacheK: 'q8_0', cacheV: 'q8_0', specType: '', specDraftNMax: 2, reasoningPreserve: false, jinja: false, temp: 0.8, tensorSplit: 50, extraArgs: '', chatTemplateFile: '', chatTemplateKwargs: '' }
};

const shape: Record<string, unknown> = {
    server: { host: 0, port: 0, corsOrigins: 0, maxBodyBytes: 0 },
    paths: { modelDirectories: 0, huggingFaceCache: 0, logsDirectory: 0, pythonCommand: 0, monitorScript: 0 },
    llama: { builds: 0, defaultPort: 0, defaultHost: 0, rpcPort: 0 },
    telemetry: { enabled: 0, host: 0, port: 0, pollMs: 0, providers: 0, source: 0 },
    processes: { cleanupManagedPortsOnStart: 0, stopGraceMs: 0 },
    service: { unitName: 0, unitPath: 0, enableOnApply: 0, manageViaSystemd: 0 },
    upgrade: { repoDir: 0, buildDir: 0, enabled: 0 },
    worker: { sshHost: 0, rpcTarget: 0, workDirectory: 0, startCommand: 0, stopCommand: 0, statusCommand: 0, logsCommand: 0, transportPresets: 0 },
    uiDefaults: { contextSize: 0, gpuLayers: 0, tensorSplit: 0, temperature: 0 },
    launch: { modelPath: 0, modelName: 0, build: 0, deviceA: 0, deviceB: 0, splitMode: 0, ctx: 0, ngl: 0, port: 0, fa: 0, cacheK: 0, cacheV: 0, specType: 0, specDraftNMax: 0, reasoningPreserve: 0, jinja: 0, temp: 0, tensorSplit: 0, extraArgs: 0, chatTemplateFile: 0, chatTemplateKwargs: 0 }
};

function isObject(value: unknown): value is Raw {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value));
}

function checkUnknown(value: unknown, allowed: Record<string, unknown>, prefix: string, issues: string[]): void {
    if (!isObject(value)) return;
    for (const key of Object.keys(value)) {
        const name = prefix ? prefix + '.' + key : key;
        if (!(key in allowed)) {
            issues.push('unknown key: ' + name);
        } else if (isObject(allowed[key])) {
            checkUnknown(value[key], allowed[key] as Raw, name, issues);
        }
    }
}

function merge(target: Raw, source: Raw): void {
    for (const [key, value] of Object.entries(source)) {
        if (isObject(value) && isObject(target[key])) merge(target[key] as Raw, value);
        else target[key] = value;
    }
}

function nonEmpty(value: unknown, field: string, issues: string[]): value is string {
    if (typeof value !== 'string' || value.trim() === '') {
        issues.push(field + ' must be a non-empty string');
        return false;
    }
    return true;
}

function integer(value: unknown, field: string, min: number, max: number, issues: string[]): void {
    if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) issues.push(field + ' must be an integer between ' + min + ' and ' + max);
}

function validate(raw: Raw, issues: string[]): void {
    const s = raw.server as Raw; const p = raw.paths as Raw; const l = raw.llama as Raw;
    const t = raw.telemetry as Raw; const pr = raw.processes as Raw; const svc = raw.service as Raw; const upg = raw.upgrade as Raw; const w = raw.worker as Raw; const u = raw.uiDefaults as Raw; const launch = raw.launch as Raw;
    const hostChecks: [string, unknown][] = [['server.host', s.host], ['paths.logsDirectory', p.logsDirectory], ['paths.pythonCommand', p.pythonCommand], ['paths.monitorScript', p.monitorScript], ['llama.defaultHost', l.defaultHost], ['telemetry.host', t.host]];
    for (const [field, value] of hostChecks) nonEmpty(value, field, issues);
    if (p.huggingFaceCache !== null) nonEmpty(p.huggingFaceCache, 'paths.huggingFaceCache', issues);
    for (const [field, value] of [['worker.sshHost', w.sshHost], ['worker.rpcTarget', w.rpcTarget], ['worker.workDirectory', w.workDirectory], ['worker.startCommand', w.startCommand], ['worker.stopCommand', w.stopCommand], ['worker.statusCommand', w.statusCommand], ['worker.logsCommand', w.logsCommand]]) if (typeof value !== 'string') issues.push(field + ' must be a string');
    for (const [field, value] of [['server.corsOrigins', s.corsOrigins], ['paths.modelDirectories', p.modelDirectories]]) {
        if (!Array.isArray(value) || !value.every(item => typeof item === 'string' && item.trim())) issues.push(field + ' must be an array of non-empty strings');
    }
    for (const [field, value] of [['telemetry.enabled', t.enabled], ['processes.cleanupManagedPortsOnStart', pr.cleanupManagedPortsOnStart]]) if (typeof value !== 'boolean') issues.push(field + ' must be a boolean');
    integer(s.port, 'server.port', 1, 65535, issues); integer(l.defaultPort, 'llama.defaultPort', 1, 65535, issues); integer(l.rpcPort, 'llama.rpcPort', 1, 65535, issues); integer(t.port, 'telemetry.port', 1, 65535, issues);
    integer(s.maxBodyBytes, 'server.maxBodyBytes', 1, Number.MAX_SAFE_INTEGER, issues); integer(t.pollMs, 'telemetry.pollMs', 50, 60000, issues); integer(pr.stopGraceMs, 'processes.stopGraceMs', 1, Number.MAX_SAFE_INTEGER, issues);
    for (const [field, value] of [['service.unitName', svc.unitName], ['service.unitPath', svc.unitPath], ['upgrade.repoDir', upg.repoDir], ['upgrade.buildDir', upg.buildDir]]) if (typeof value !== 'string') issues.push(field + ' must be a string');
    if (typeof svc.enableOnApply !== 'boolean') issues.push('service.enableOnApply must be a boolean');
    if (typeof svc.manageViaSystemd !== 'boolean') issues.push('service.manageViaSystemd must be a boolean');
    if (typeof upg.enabled !== 'boolean') issues.push('upgrade.enabled must be a boolean'); integer(u.contextSize, 'uiDefaults.contextSize', 1, Number.MAX_SAFE_INTEGER, issues); integer(u.gpuLayers, 'uiDefaults.gpuLayers', 0, Number.MAX_SAFE_INTEGER, issues);
    for (const field of ['modelPath', 'modelName', 'build', 'deviceA', 'deviceB', 'cacheK', 'cacheV', 'specType', 'extraArgs', 'chatTemplateFile', 'chatTemplateKwargs']) if (launch[field] !== '' && (typeof launch[field] !== 'string' || launch[field].trim() === '')) issues.push('launch.' + field + ' must be a non-empty string when provided');
    integer(launch.ctx, 'launch.ctx', 1, Number.MAX_SAFE_INTEGER, issues); integer(launch.ngl, 'launch.ngl', 0, Number.MAX_SAFE_INTEGER, issues); integer(launch.port, 'launch.port', 1, 65535, issues); integer(launch.specDraftNMax, 'launch.specDraftNMax', 0, Number.MAX_SAFE_INTEGER, issues);
    for (const field of ['fa', 'reasoningPreserve', 'jinja']) if (typeof launch[field] !== 'boolean') issues.push('launch.' + field + ' must be a boolean');
    if (launch.splitMode !== '' && (typeof launch.splitMode !== 'string' || launch.splitMode.trim() === '')) issues.push('launch.splitMode must be a non-empty string when provided');
    if (typeof launch.tensorSplit !== 'number' || !Number.isFinite(launch.tensorSplit) || launch.tensorSplit < 0 || launch.tensorSplit > 100) issues.push('launch.tensorSplit must be a number between 0 and 100');
    if (typeof launch.temp !== 'number' || !Number.isFinite(launch.temp) || launch.temp <= 0) issues.push('launch.temp must be a number greater than 0');
    if (typeof u.tensorSplit !== 'number' || !Number.isFinite(u.tensorSplit) || u.tensorSplit < 0 || u.tensorSplit > 100) issues.push('uiDefaults.tensorSplit must be a number between 0 and 100');
    if (typeof u.temperature !== 'number' || !Number.isFinite(u.temperature) || u.temperature <= 0) issues.push('uiDefaults.temperature must be a number greater than 0');
    if (!Array.isArray(t.providers) || !t.providers.every(v => typeof v === 'string' && ['nvidia', 'amd', 'linux'].includes(v))) issues.push('telemetry.providers must contain only nvidia, amd, or linux');
    if (t.source !== 'monitor' && t.source !== 'builtin') issues.push('telemetry.source must be "monitor" or "builtin"');
    if (!Array.isArray(l.builds)) issues.push('llama.builds must be an array'); else l.builds.forEach((b, i) => { if (!isObject(b)) issues.push('llama.builds.' + i + ' must be an object'); else { checkUnknown(b, { id: 0, label: 0, path: 0 }, 'llama.builds.' + i, issues); nonEmpty(b.id, 'llama.builds.' + i + '.id', issues); nonEmpty(b.label, 'llama.builds.' + i + '.label', issues); nonEmpty(b.path, 'llama.builds.' + i + '.path', issues); } });
    if (!Array.isArray(w.transportPresets)) issues.push('worker.transportPresets must be an array'); else w.transportPresets.forEach((preset, i) => { if (!isObject(preset)) issues.push('worker.transportPresets.' + i + ' must be an object'); else { checkUnknown(preset, { id: 0, label: 0 }, 'worker.transportPresets.' + i, issues); nonEmpty(preset.id, 'worker.transportPresets.' + i + '.id', issues); nonEmpty(preset.label, 'worker.transportPresets.' + i + '.label', issues); } });
    const commands = [w.startCommand, w.stopCommand, w.statusCommand, w.logsCommand] as unknown[];
    if (commands.some(v => typeof v === 'string' && v !== '') && !commands.every(v => typeof v === 'string' && v !== '')) issues.push('worker command section requires all four commands when any command is non-empty');
}

function resolvePath(value: string, base: string): string { return path.isAbsolute(value) ? value : path.resolve(base, value); }
function sourceFor(sources: Record<string, Source>, key: string): Source { return sources[key] || 'default'; }

export async function loadConfig(opts: { appRoot: string; env?: Record<string, string | undefined>; log?: (line: string) => void }): Promise<DashboardConfig> {
    const env = opts.env || process.env;
    const log = opts.log || console.log;
    const appRoot = path.resolve(opts.appRoot);
    const configured = env.DASHBOARD_CONFIG;
    const candidates = configured ? [path.resolve(appRoot, configured)] : [path.join(appRoot, 'config/dashboard.json'), path.join(appRoot, 'dashboard.config.json')];
    let filePath: string | undefined;
    const newFile = path.join(appRoot, 'config/dashboard.json');
    const legacyFile = path.join(appRoot, 'dashboard.config.json');
    if (configured) {
        if (!fs.existsSync(candidates[0])) throw new ConfigError(['DASHBOARD_CONFIG file not found: ' + candidates[0]]);
        filePath = candidates[0];
    } else filePath = candidates.find(fs.existsSync);
    if (fs.existsSync(newFile) && fs.existsSync(legacyFile)) log('[config] legacy dashboard.config.json ignored; using config/dashboard.json');
    const raw = clone(defaults) as Raw;
    const sources: Record<string, Source> = {};
    let fileBase = appRoot;
    if (filePath) {
        fileBase = path.dirname(filePath);
        let parsed: unknown;
        try { parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (error) { throw new ConfigError(['config file invalid: ' + (error as Error).message]); }
        if (!isObject(parsed)) throw new ConfigError(['config file must contain an object']);
        const legacy = filePath.endsWith('dashboard.config.json') && !configured;
        if (legacy) {
            const mapped: Raw = {};
            if (Array.isArray(parsed.llamaServerBuilds)) mapped.llama = { builds: parsed.llamaServerBuilds };
            else if (typeof parsed.llamaServerBinary === 'string') mapped.llama = { builds: [{ id: 'default', label: 'Default', path: parsed.llamaServerBinary }] };
            merge(raw, mapped);
            if (mapped.llama) sources['llama.builds'] = 'file';
        } else {
            const issues: string[] = []; checkUnknown(parsed, shape, '', issues); merge(raw, parsed); validate(raw, issues); if (issues.length) throw new ConfigError(issues);
            function mark(value: unknown, prefix = ''): void { if (!isObject(value)) { sources[prefix] = 'file'; return; } for (const [key, child] of Object.entries(value)) mark(child, prefix ? prefix + '.' + key : key); }
            mark(parsed);
        }
    }
    if (!filePath || (filePath.endsWith('dashboard.config.json') && !configured)) { const issues: string[] = []; validate(raw, issues); if (issues.length) throw new ConfigError(issues); }
    const envIssues: string[] = [];
    if (env.DASHBOARD_HOST !== undefined) { raw.server = raw.server as Raw; (raw.server as Raw).host = env.DASHBOARD_HOST; sources['server.host'] = 'env'; }
    if (env.DASHBOARD_LOGS_DIR !== undefined) { (raw.paths as Raw).logsDirectory = env.DASHBOARD_LOGS_DIR; sources['paths.logsDirectory'] = 'env'; }
    if (env.DASHBOARD_PORT !== undefined) { const port = Number(env.DASHBOARD_PORT); if (!Number.isInteger(port) || port < 1 || port > 65535) envIssues.push('DASHBOARD_PORT must be an integer between 1 and 65535'); else { (raw.server as Raw).port = port; sources['server.port'] = 'env'; } }
    validate(raw, envIssues); if (envIssues.length) throw new ConfigError(envIssues);
    const cfg = raw as unknown as DashboardConfig;
    cfg.paths.modelDirectories = cfg.paths.modelDirectories.map(v => resolvePath(v, fileBase));
    cfg.paths.logsDirectory = resolvePath(cfg.paths.logsDirectory, fileBase);
    cfg.paths.monitorScript = resolvePath(cfg.paths.monitorScript, fileBase);
    const cacheValue = env.HF_HOME || env.HUGGINGFACE_HUB_CACHE || cfg.paths.huggingFaceCache || path.join(os.homedir(), '.cache', 'huggingface', 'hub');
    if (env.HF_HOME || env.HUGGINGFACE_HUB_CACHE) sources['paths.huggingFaceCache'] = 'env';
    else if (!cfg.paths.huggingFaceCache) sources['paths.huggingFaceCache'] = 'default';
    cfg.paths.huggingFaceCache = resolvePath(cacheValue, fileBase);
    cfg.llama.builds = cfg.llama.builds.map(build => ({ ...build, path: resolvePath(build.path, fileBase) }));
    if (cfg.paths.pythonCommand.includes('/') || cfg.paths.pythonCommand.includes('\\')) cfg.paths.pythonCommand = resolvePath(cfg.paths.pythonCommand, fileBase);
    log('[config] source: built-in defaults' + (filePath ? ', file: ' + filePath : ''));
    function print(value: unknown, prefix = ''): void { if (Array.isArray(value) || !isObject(value)) { log('[config] ' + prefix + ' = ' + (typeof value === 'string' ? value : JSON.stringify(value)) + ' (' + sourceFor(sources, prefix) + ')'); return; } for (const [key, child] of Object.entries(value)) print(child, prefix ? prefix + '.' + key : key); }
    print(cfg);
    return cfg;
}

export function publicConfig(cfg: DashboardConfig): unknown {
    const worker = cfg.worker;
    const { modelPath, ...launch } = cfg.launch;
    return { uiDefaults: cfg.uiDefaults, launch: { ...launch, modelName: modelPath ? path.basename(modelPath) : '' }, llama: { defaultPort: cfg.llama.defaultPort, defaultHost: cfg.llama.defaultHost, rpcPort: cfg.llama.rpcPort, builds: cfg.llama.builds.map(({ id, label }) => ({ id, label })) }, worker: { enabled: !!worker.sshHost && [worker.startCommand, worker.stopCommand, worker.statusCommand, worker.logsCommand].every(Boolean), sshHost: worker.sshHost, rpcTarget: worker.rpcTarget, transportPresets: worker.transportPresets }, telemetry: { enabled: cfg.telemetry.enabled, pollMs: cfg.telemetry.pollMs, providers: cfg.telemetry.providers } };
}
