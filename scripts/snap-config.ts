/*
 * Golden snapshot of config loading: the resolved config, the provenance log
 * lines, and the exact validation issues for a sweep of hostile inputs.
 *
 * The point is the *exact* issue strings and their order. tests/config.test.ts
 * only asserts stringContaining(fieldName), so a reworded or reordered message
 * would pass there and fail here -- which is the point, since those messages
 * are the only thing a user sees when their config is rejected.
 *
 * The sweep is generated from the loaded defaults rather than a hand-written
 * copy of the schema, so it covers every field without duplicating the schema
 * here (which is the very thing this file exists to catch).
 *
 *   bun scripts/snap-config.ts > /tmp/cfg-before.txt
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig, publicConfig, ConfigError } from '../src/server/config';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfgsnap-'));
const home = os.homedir();

function normalize(text: string): string {
    return text.split(root).join('<ROOT>').split(home).join('<HOME>').split('\\').join('/');
}

let caseNo = 0;
const out: string[] = [];

async function attempt(label: string, file: unknown, env: Record<string, string | undefined> = {}, name = 'config/dashboard.json', rawText?: string): Promise<void> {
    const dir = path.join(root, 'c' + caseNo++);
    if (rawText !== undefined || file !== undefined) {
        const target = path.join(dir, name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, rawText ?? JSON.stringify(file));
    }
    const logs: string[] = [];
    let result: string;
    try {
        const cfg = await loadConfig({ appRoot: dir, env, log: line => logs.push(line) });
        result = 'OK ' + normalize(JSON.stringify(cfg));
    } catch (err) {
        if (err instanceof ConfigError) {
            result = 'ISSUES[' + err.issues.length + '] ' + normalize(err.issues.join(' | '));
        } else {
            result = 'THROW ' + (err as Error).constructor.name + ': ' + normalize((err as Error).message);
        }
    }
    out.push(label.padEnd(46) + result);
    for (const line of logs) out.push('    log| ' + normalize(line));
}

// --- baseline --------------------------------------------------------------

out.push('=== baseline: no config file ===');
await attempt('no file', undefined);

out.push('');
out.push('=== baseline: empty object ===');
await attempt('empty object', {});

out.push('');
out.push('=== publicConfig (what the client receives) ===');
{
    const dir = path.join(root, 'pub');
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config/dashboard.json'), JSON.stringify({
        launch: { modelPath: '/models/m.gguf', chatTemplateFile: '/t.j2', specType: 'draft-mtp', reasoningPreserve: true },
        worker: { sshHost: 'h', startCommand: 'a', stopCommand: 'b', statusCommand: 'c', logsCommand: 'd', transportPresets: [{ id: 'p', label: 'P' }] },
        llama: { builds: [{ id: 'x', label: 'X', path: '/tmp/x' }] },
    }));
    const cfg = await loadConfig({ appRoot: dir, env: {}, log: () => {} });
    out.push('publicConfig ' + normalize(JSON.stringify(publicConfig(cfg))));
}

// --- legacy files ----------------------------------------------------------

out.push('');
out.push('=== legacy dashboard.config.json ===');
await attempt('legacy binary string', { llamaServerBinary: '/tmp/x/llama-server' }, {}, 'dashboard.config.json');
await attempt('legacy builds array', { llamaServerBuilds: [{ id: 'x', label: 'X', path: '/tmp/y' }] }, {}, 'dashboard.config.json');
await attempt('legacy unknown key ignored', { llamaServerBinary: '/tmp/x', ignored: 1, nested: { a: 1 } }, {}, 'dashboard.config.json');
await attempt('legacy both binary forms', { llamaServerBinary: '/tmp/a', llamaServerBuilds: [{ id: 'x', label: 'X', path: '/tmp/b' }] }, {}, 'dashboard.config.json');
await attempt('legacy empty object', {}, {}, 'dashboard.config.json');
await attempt('both files present', { server: { port: 3105 } });
{ // new file wins, legacy ignored
    const dir = path.join(root, 'both');
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config/dashboard.json'), JSON.stringify({ server: { port: 3105 } }));
    fs.writeFileSync(path.join(dir, 'dashboard.config.json'), JSON.stringify({ llamaServerBinary: '/tmp/old' }));
    const logs: string[] = [];
    const cfg = await loadConfig({ appRoot: dir, env: {}, log: l => logs.push(l) });
    out.push('both files'.padEnd(46) + 'OK port=' + cfg.server.port + ' builds=' + JSON.stringify(cfg.llama.builds));
    for (const line of logs.filter(l => l.includes('legacy'))) out.push('    log| ' + normalize(line));
}

// --- env overrides ---------------------------------------------------------

out.push('');
out.push('=== env overrides ===');
await attempt('DASHBOARD_PORT valid', undefined, { DASHBOARD_PORT: '3200' });
await attempt('DASHBOARD_PORT non-numeric', undefined, { DASHBOARD_PORT: 'abc' });
await attempt('DASHBOARD_PORT zero', undefined, { DASHBOARD_PORT: '0' });
await attempt('DASHBOARD_PORT too big', undefined, { DASHBOARD_PORT: '70000' });
await attempt('DASHBOARD_PORT float', undefined, { DASHBOARD_PORT: '3000.5' });
await attempt('DASHBOARD_PORT empty', undefined, { DASHBOARD_PORT: '' });
await attempt('DASHBOARD_HOST empty', undefined, { DASHBOARD_HOST: '  ' });
await attempt('DASHBOARD_LOGS_DIR relative', undefined, { DASHBOARD_LOGS_DIR: './env-logs' });
await attempt('HF_HOME', undefined, { HF_HOME: '/tmp/hfhome' });
await attempt('HUGGINGFACE_HUB_CACHE', undefined, { HUGGINGFACE_HUB_CACHE: '/tmp/hubcache' });
await attempt('both cache envs', undefined, { HF_HOME: '/tmp/a', HUGGINGFACE_HUB_CACHE: '/tmp/b' });
await attempt('DASHBOARD_CONFIG missing', undefined, { DASHBOARD_CONFIG: 'gone.json' });
await attempt('env beats file', { server: { port: 3105, host: 'file-host' } }, { DASHBOARD_PORT: '3200', DASHBOARD_HOST: 'env-host' });
await attempt('malformed json', undefined, {}, 'config/dashboard.json', '{ not json');
await attempt('empty file', undefined, {}, 'config/dashboard.json', '');
await attempt('json null', undefined, {}, 'config/dashboard.json', 'null');
await attempt('json string', undefined, {}, 'config/dashboard.json', '"hello"');
await attempt('json array not object', [], {});

// --- unknown keys ----------------------------------------------------------

out.push('');
out.push('=== unknown keys ===');
for (const group of ['server', 'paths', 'llama', 'telemetry', 'processes', 'service', 'upgrade', 'worker', 'uiDefaults', 'launch']) {
    await attempt(`unknown key in ${group}`, { [group]: { bogusKey: 1 } });
}
await attempt('unknown top-level group', { notAGroup: { a: 1 } });
await attempt('unknown key deep in builds', { llama: { builds: [{ id: 'a', label: 'b', path: 'c', extra: 1 }] } });
await attempt('unknown key in transportPresets', { worker: { transportPresets: [{ id: 'a', label: 'b', nope: 2 }] } });

// --- group type confusion --------------------------------------------------

out.push('');
out.push('=== group replaced by a scalar ===');
for (const group of ['server', 'paths', 'llama', 'telemetry', 'processes', 'service', 'upgrade', 'worker', 'uiDefaults', 'launch']) {
    await attempt(`${group} as string`, { [group]: 'nope' });
}

// --- per-field hostile sweep ----------------------------------------------
// Key list comes from the loaded defaults, so this covers every field the
// schema has without restating the schema here.

out.push('');
out.push('=== per-field hostile values ===');
{
    const dir = path.join(root, 'seed');
    fs.mkdirSync(dir, { recursive: true });
    const base = await loadConfig({ appRoot: dir, env: { HF_HOME: '/tmp/hf' }, log: () => {} });
    const paths: string[] = [];
    const walk = (value: unknown, prefix: string): void => {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            for (const [k, v] of Object.entries(value)) walk(v, prefix ? `${prefix}.${k}` : k);
        } else {
            paths.push(prefix);
        }
    };
    walk(base, '');
    paths.sort();

    const HOSTILE: Array<[string, unknown]> = [
        ['string', 'not-a-number'],
        ['empty', ''],
        ['blank', '   '],
        ['null', null],
        ['true', true],
        ['array', [1, 2]],
        ['object', { a: 1 }],
        ['neg', -1],
        ['huge', 999999999],
    ];
    const setPath = (dotted: string, value: unknown): Record<string, unknown> => {
        const parts = dotted.split('.');
        const root_: Record<string, unknown> = {};
        let node = root_;
        for (let i = 0; i < parts.length - 1; i++) {
            node[parts[i]] = {};
            node = node[parts[i]] as Record<string, unknown>;
        }
        node[parts[parts.length - 1]] = value;
        return root_;
    };
    for (const dotted of paths) {
        for (const [label, value] of HOSTILE) {
            await attempt(`${dotted} = ${label}`, setPath(dotted, value), { HF_HOME: '/tmp/hf' });
        }
    }
}

console.log(out.join('\n'));
