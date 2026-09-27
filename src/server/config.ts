import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ConfigResponse } from '../../shared/contracts';

export interface Build { id: string; label: string; path: string }
export interface TransportPreset { id: string; label: string }

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

// --- THE SCHEMA, WRITTEN ONCE --------------------------------------------
// One table is the whole config: it produces the defaults, the set of keys a
// file may set, the validation, and the DashboardConfig type. Adding a setting
// used to mean four edits in four parallel structures (the interface, the
// defaults, the `shape` key list, and validate()), and missing the `shape` one
// silently rejected a valid file. There is no fourth structure to miss now.

/** Validates one value. Push zero or more human-readable problems. */
type Check = (value: unknown, field: string, issues: string[]) => void;
/** Validates a whole group, for rules that span sibling fields. */
type GroupCheck = (value: Raw, field: string, issues: string[]) => void;

interface Leaf<T> { readonly value: T; readonly check?: Check }
interface Group<G = GroupSpec> { readonly group: G; readonly check?: GroupCheck }
type GroupSpec = { readonly [key: string]: Node };
type Node = Leaf<unknown> | Group;

type InferNode<N> =
    N extends { group: infer G } ? { [K in keyof G]: InferNode<G[K]> }
        : N extends { value: infer V } ? V
            : never;

function leaf<T>(value: T, check?: Check): Leaf<T> { return { value, check }; }
function group<G extends GroupSpec>(spec: G, check?: GroupCheck): Group<G> { return { group: spec, check }; }

// --- checks ----------------------------------------------------------------
// The messages are the contract: they are all a rejected user ever sees.

const nonEmpty: Check = (value, field, issues) => {
    if (typeof value !== 'string' || value.trim() === '') issues.push(`${field} must be a non-empty string`);
};

const aString: Check = (value, field, issues) => {
    if (typeof value !== 'string') issues.push(`${field} must be a string`);
};

const aBoolean: Check = (value, field, issues) => {
    if (typeof value !== 'boolean') issues.push(`${field} must be a boolean`);
};

const intBetween = (min: number, max: number): Check => (value, field, issues) => {
    if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
        issues.push(`${field} must be an integer between ${min} and ${max}`);
    }
};

const numBetween = (min: number, max: number): Check => (value, field, issues) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
        issues.push(`${field} must be a number between ${min} and ${max}`);
    }
};

const numAbove = (min: number): Check => (value, field, issues) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= min) {
        issues.push(`${field} must be a number greater than ${min}`);
    }
};

const stringArray: Check = (value, field, issues) => {
    if (!Array.isArray(value) || !value.every(item => typeof item === 'string' && item.trim())) {
        issues.push(`${field} must be an array of non-empty strings`);
    }
};

/** A string that may be left empty, but not set to something meaningless. */
const stringWhenProvided: Check = (value, field, issues) => {
    if (value !== '' && (typeof value !== 'string' || value.trim() === '')) {
        issues.push(`${field} must be a non-empty string when provided`);
    }
};

/** null means "not configured"; anything else has to be a real path. */
const nullableNonEmpty: Check = (value, field, issues) => {
    if (value !== null) nonEmpty(value, field, issues);
};

const PROVIDERS = ['nvidia', 'amd', 'linux'] as const;

const providerList: Check = (value, field, issues) => {
    if (!Array.isArray(value) || !value.every(v => typeof v === 'string' && (PROVIDERS as readonly string[]).includes(v))) {
        issues.push(`${field} must contain only nvidia, amd, or linux`);
    }
};

const oneOf = (allowed: readonly string[]): Check => (value, field, issues) => {
    if (typeof value !== 'string' || !allowed.includes(value)) {
        issues.push(`${field} must be "monitor" or "builtin"`);
    }
};

/** A list of `{ id, label }` records, rejecting unknown keys inside each. */
const recordArray = (keys: readonly string[]): Check => (value, field, issues) => {
    if (!Array.isArray(value)) {
        issues.push(`${field} must be an array`);
        return;
    }
    const allowed: Raw = Object.fromEntries(keys.map(k => [k, 0]));
    value.forEach((entry, index) => {
        const at = `${field}.${index}`;
        if (!isObject(entry)) {
            issues.push(`${at} must be an object`);
            return;
        }
        checkUnknown(entry, allowed, at, issues);
        for (const key of keys) nonEmpty(entry[key], `${at}.${key}`, issues);
    });
};

const WORKER_COMMANDS = ['startCommand', 'stopCommand', 'statusCommand', 'logsCommand'] as const;

/** All four worker commands or none: a half-configured worker cannot start. */
const workerCommandsTogether: GroupCheck = (value, _field, issues) => {
    const commands = WORKER_COMMANDS.map(key => value[key]);
    const set = commands.filter(v => typeof v === 'string' && v !== '');
    if (set.length !== 0 && set.length !== WORKER_COMMANDS.length) {
        issues.push('worker command section requires all four commands when any command is non-empty');
    }
};

// --- the table -------------------------------------------------------------

const PORT = intBetween(1, 65535);
const ANY_INT = intBetween(1, Number.MAX_SAFE_INTEGER);

const CONFIG_SPEC = group({
    server: group({
        host: leaf('127.0.0.1', nonEmpty),
        port: leaf(3000, PORT),
        corsOrigins: leaf<string[]>([], stringArray),
        maxBodyBytes: leaf(10 * 1024 * 1024, ANY_INT),
    }),
    paths: group({
        modelDirectories: leaf(['./models'], stringArray),
        // SAFETY: the null default is a sentinel meaning "derive this from the
        // environment". loadConfig replaces it with a real path before the
        // config is returned, so no caller can observe the null.
        huggingFaceCache: leaf<string>(null as unknown as string, nullableNonEmpty),
        logsDirectory: leaf('./logs', nonEmpty),
    }),
    llama: group({
        builds: leaf<Build[]>([], recordArray(['id', 'label', 'path'])),
        defaultPort: leaf(8080, PORT),
        defaultHost: leaf('127.0.0.1', nonEmpty),
        rpcPort: leaf(50052, PORT),
    }),
    telemetry: group({
        enabled: leaf(true, aBoolean),
        host: leaf('127.0.0.1', nonEmpty),
        port: leaf(8081, PORT),
        pollMs: leaf(1000, intBetween(50, 60000)),
        providers: leaf<string[]>([...PROVIDERS], providerList),
        source: leaf<'monitor' | 'builtin'>('builtin', oneOf(['monitor', 'builtin'])),
    }),
    processes: group({
        cleanupManagedPortsOnStart: leaf(false, aBoolean),
        stopGraceMs: leaf(3000, ANY_INT),
    }),
    service: group({
        unitName: leaf('llama-dashboard-server.service', aString),
        unitPath: leaf('', aString),
        enableOnApply: leaf(false, aBoolean),
        manageViaSystemd: leaf(false, aBoolean),
    }),
    upgrade: group({
        repoDir: leaf('', aString),
        buildDir: leaf('', aString),
        enabled: leaf(false, aBoolean),
    }),
    worker: group({
        sshHost: leaf('', aString),
        rpcTarget: leaf('', aString),
        workDirectory: leaf('', aString),
        startCommand: leaf('docker compose -f docker-compose.worker.yml up -d', aString),
        stopCommand: leaf('docker compose -f docker-compose.worker.yml down', aString),
        statusCommand: leaf('docker compose -f docker-compose.worker.yml ps --filter status=running -q', aString),
        logsCommand: leaf('docker compose -f docker-compose.worker.yml logs --tail=50', aString),
        transportPresets: leaf<TransportPreset[]>([], recordArray(['id', 'label'])),
    }, workerCommandsTogether),
    uiDefaults: group({
        contextSize: leaf(4096, ANY_INT),
        gpuLayers: leaf(0, intBetween(0, Number.MAX_SAFE_INTEGER)),
        tensorSplit: leaf(50, numBetween(0, 100)),
        temperature: leaf(0.8, numAbove(0)),
    }),
    launch: group({
        modelPath: leaf('', stringWhenProvided),
        modelName: leaf('', stringWhenProvided),
        build: leaf('', stringWhenProvided),
        deviceA: leaf('', stringWhenProvided),
        deviceB: leaf('', stringWhenProvided),
        splitMode: leaf('none', stringWhenProvided),
        ctx: leaf(110000, ANY_INT),
        ngl: leaf(999, intBetween(0, Number.MAX_SAFE_INTEGER)),
        port: leaf(8080, PORT),
        fa: leaf(true, aBoolean),
        cacheK: leaf('q8_0', stringWhenProvided),
        cacheV: leaf('q8_0', stringWhenProvided),
        specType: leaf('', stringWhenProvided),
        specDraftNMax: leaf(2, intBetween(0, Number.MAX_SAFE_INTEGER)),
        reasoningPreserve: leaf(false, aBoolean),
        jinja: leaf(false, aBoolean),
        temp: leaf(0.8, numAbove(0)),
        tensorSplit: leaf(50, numBetween(0, 100)),
        extraArgs: leaf('', stringWhenProvided),
        chatTemplateFile: leaf('', stringWhenProvided),
        chatTemplateKwargs: leaf('', stringWhenProvided),
    }),
});

/** The resolved config, described by the table above. */
export type DashboardConfig = InferNode<typeof CONFIG_SPEC>;

// --- deriving the rest from the table --------------------------------------

function isGroup(node: Node): node is Group { return typeof node === 'object' && node !== null && 'group' in node; }

function isObject(value: unknown): value is Raw {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** The key list a config file is allowed to set. A miss here is a rejected file. */
function shapeOf(spec: GroupSpec): Raw {
    const out: Raw = {};
    for (const [key, node] of Object.entries(spec)) out[key] = isGroup(node) ? shapeOf(node.group) : 0;
    return out;
}

/** The built-in defaults, in table order, which is also the reported order. */
function defaultsOf(spec: GroupSpec): Raw {
    const out: Raw = {};
    for (const [key, node] of Object.entries(spec)) out[key] = isGroup(node) ? defaultsOf(node.group) : (node as Leaf<unknown>).value;
    return out;
}

/** A fresh copy of the defaults, since each load merges into its own. */
function freshDefaults(): Raw { return structuredClone(defaults); }

function checkUnknown(value: unknown, allowed: Raw, prefix: string, issues: string[]): void {
    if (!isObject(value)) return;
    for (const key of Object.keys(value)) {
        const name = prefix ? prefix + '.' + key : key;
        if (!Object.hasOwn(allowed, key)) {
            issues.push('unknown key: ' + name);
        } else if (isObject(allowed[key])) {
            checkUnknown(value[key], allowed[key], name, issues);
        }
    }
}

const EMPTY: Raw = {};

function validateSpec(spec: GroupSpec, value: Raw, prefix: string, issues: string[]): void {
    for (const [key, node] of Object.entries(spec)) {
        const field = prefix ? `${prefix}.${key}` : key;
        if (isGroup(node)) {
            const child = (value as Raw)[key];
            // A group must be an object. If the file set one to a scalar, every
            // leaf still reports its own problem -- reading a field off a scalar
            // yields undefined -- which is both the pre-existing behaviour and the
            // only thing standing between a bad file and a server that starts
            // with `config.server` set to a string.
            const group = isObject(child) ? child : EMPTY;
            validateSpec(node.group, group, field, issues);
            node.check?.(group, field, issues);
        } else {
            (node as Leaf<unknown>).check?.((value as Raw)[key], field, issues);
        }
    }
}

function validate(raw: Raw, issues: string[]): void {
    validateSpec(CONFIG_SPEC.group, raw, '', issues);
}

const shape = shapeOf(CONFIG_SPEC.group);
const defaults = defaultsOf(CONFIG_SPEC.group);

// Unknown keys are reported by checkUnknown, but must never reach the merge:
// assigning __proto__ or constructor into ordinary objects can mutate their prototype.
function merge(target: Raw, source: Raw): void {
    for (const [key, value] of Object.entries(source)) {
        if (!Object.hasOwn(target, key)) continue;
        if (isObject(value) && isObject(target[key])) merge(target[key] as Raw, value);
        else target[key] = value;
    }
}

function resolvePath(value: string, base: string): string { return path.isAbsolute(value) ? value : path.resolve(base, value); }
function sourceFor(sources: Record<string, Source>, key: string): Source { return sources[key] || 'default'; }

export async function loadConfig(opts: { appRoot: string; env?: Record<string, string | undefined>; log?: (line: string) => void }): Promise<DashboardConfig> {
    const env = opts.env || process.env;
    const log = opts.log || console.log;
    const appRoot = path.resolve(opts.appRoot);
    const configured = env.DASHBOARD_CONFIG;
    const newFile = path.join(appRoot, 'config/dashboard.json');
    const legacyFile = path.join(appRoot, 'dashboard.config.json');

    let filePath: string | undefined;
    if (configured) {
        const resolved = path.resolve(appRoot, configured);
        if (!fs.existsSync(resolved)) throw new ConfigError(['DASHBOARD_CONFIG file not found: ' + resolved]);
        filePath = resolved;
    } else {
        filePath = [newFile, legacyFile].find(candidate => fs.existsSync(candidate));
    }
    if (fs.existsSync(newFile) && fs.existsSync(legacyFile)) {
        log('[config] legacy dashboard.config.json ignored; using config/dashboard.json');
    }

    const raw = freshDefaults();
    const sources: Record<string, Source> = {};
    let fileBase = appRoot;

    if (filePath) {
        fileBase = path.dirname(filePath);
        let parsed: unknown;
        try {
            parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch (error) {
            throw new ConfigError(['config file invalid: ' + (error as Error).message]);
        }
        if (!isObject(parsed)) throw new ConfigError(['config file must contain an object']);

        const legacy = filePath === legacyFile && !configured;
        if (legacy) {
            // The old file is a different shape entirely, so it is translated
            // rather than validated: unknown keys there are simply not ours.
            const mapped: Raw = {};
            if (Array.isArray(parsed.llamaServerBuilds)) {
                mapped.llama = { builds: parsed.llamaServerBuilds };
            } else if (typeof parsed.llamaServerBinary === 'string') {
                mapped.llama = { builds: [{ id: 'default', label: 'Default', path: parsed.llamaServerBinary }] };
            }
            merge(raw, mapped);
            if (mapped.llama) sources['llama.builds'] = 'file';
        } else {
            const issues: string[] = [];
            checkUnknown(parsed, shape, '', issues);
            merge(raw, parsed);
            validate(raw, issues);
            if (issues.length) throw new ConfigError(issues);
            // Every key the file set is reported as coming from the file.
            const mark = (value: unknown, prefix = ''): void => {
                if (!isObject(value)) { sources[prefix] = 'file'; return; }
                for (const [key, child] of Object.entries(value)) mark(child, prefix ? prefix + '.' + key : key);
            };
            mark(parsed);
        }
    } else {
        const issues: string[] = [];
        validate(raw, issues);
        if (issues.length) throw new ConfigError(issues);
    }

    const envIssues: string[] = [];
    if (env.DASHBOARD_HOST !== undefined) { (raw.server as Raw).host = env.DASHBOARD_HOST; sources['server.host'] = 'env'; }
    if (env.DASHBOARD_LOGS_DIR !== undefined) { (raw.paths as Raw).logsDirectory = env.DASHBOARD_LOGS_DIR; sources['paths.logsDirectory'] = 'env'; }
    if (env.DASHBOARD_PORT !== undefined) {
        const port = Number(env.DASHBOARD_PORT);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            envIssues.push('DASHBOARD_PORT must be an integer between 1 and 65535');
        } else {
            (raw.server as Raw).port = port;
            sources['server.port'] = 'env';
        }
    }
    validate(raw, envIssues);
    if (envIssues.length) throw new ConfigError(envIssues);

    // SAFETY: raw is a fresh copy of the spec's defaults with the parsed file
    // and the environment merged over it, and validate() has just confirmed every
    // leaf matches the check the spec declares for it. The spec is the only
    // description of the shape, so this is its own type by construction.
    const cfg = raw as unknown as DashboardConfig;
    cfg.paths.modelDirectories = cfg.paths.modelDirectories.map(v => resolvePath(v, fileBase));
    cfg.paths.logsDirectory = resolvePath(cfg.paths.logsDirectory, fileBase);

    // The HF cache is the one setting the environment can fill in on its own.
    const cacheFromEnv = env.HF_HOME || env.HUGGINGFACE_HUB_CACHE;
    const cacheValue = cacheFromEnv || cfg.paths.huggingFaceCache || path.join(os.homedir(), '.cache', 'huggingface', 'hub');
    if (cacheFromEnv) sources['paths.huggingFaceCache'] = 'env';
    else if (!cfg.paths.huggingFaceCache) sources['paths.huggingFaceCache'] = 'default';
    cfg.paths.huggingFaceCache = resolvePath(cacheValue, fileBase);

    cfg.llama.builds = cfg.llama.builds.map(build => ({ ...build, path: resolvePath(build.path, fileBase) }));

    log('[config] source: built-in defaults' + (filePath ? ', file: ' + filePath : ''));
    const print = (value: unknown, prefix = ''): void => {
        if (Array.isArray(value) || !isObject(value)) {
            const shown = typeof value === 'string' ? value : JSON.stringify(value);
            log('[config] ' + prefix + ' = ' + shown + ' (' + sourceFor(sources, prefix) + ')');
            return;
        }
        for (const [key, child] of Object.entries(value)) print(child, prefix ? prefix + '.' + key : key);
    };
    print(cfg);
    return cfg;
}

/**
 * The client-facing projection of the config. Typed as ConfigResponse so the
 * wire shape is checked in both directions instead of being `unknown` here
 * and a guess in the browser.
 */
export function publicConfig(cfg: DashboardConfig): ConfigResponse {
    const worker = cfg.worker;
    // modelPath is a host path; the browser gets the basename only.
    const { modelPath, ...launch } = cfg.launch;
    return {
        uiDefaults: cfg.uiDefaults,
        launch: { ...launch, modelName: modelPath ? path.basename(modelPath) : '' },
        llama: {
            defaultPort: cfg.llama.defaultPort,
            defaultHost: cfg.llama.defaultHost,
            rpcPort: cfg.llama.rpcPort,
            // The binary path is host-local, so the client only ever sees labels.
            builds: cfg.llama.builds.map(({ id, label }) => ({ id, label })),
        },
        worker: {
            enabled: !!worker.sshHost && [worker.startCommand, worker.stopCommand, worker.statusCommand, worker.logsCommand].every(Boolean),
            sshHost: worker.sshHost,
            rpcTarget: worker.rpcTarget,
            transportPresets: worker.transportPresets,
        },
        telemetry: { enabled: cfg.telemetry.enabled, pollMs: cfg.telemetry.pollMs, providers: cfg.telemetry.providers },
    };
}
