import { describe, it, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig, ConfigError } from '../src/server/config';

// The config schema is one table now (CONFIG_SPEC in src/server/config.ts). It
// used to be four parallel structures, and a setting added to one but not
// another was silently accepted or silently rejected depending on which one
// was missed. These tests hold the three derived views -- defaults, the key
// list a file may set, and the validation -- to each other.

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfgschema-'));
let counter = 0;

/** Write one config file and load it, returning the issues it produced. */
async function issuesFor(value: unknown, env: Record<string, string | undefined> = {}): Promise<string[]> {
    const dir = path.join(root, 'c' + counter++);
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config/dashboard.json'), JSON.stringify(value));
    try {
        await loadConfig({ appRoot: dir, env: { HF_HOME: '/tmp/hf', ...env }, log: () => {} });
        return [];
    } catch (err) {
        if (err instanceof ConfigError) return err.issues;
        throw err;
    }
}

function setPath(dotted: string, value: unknown): Record<string, unknown> {
    const parts = dotted.split('.');
    const out: Record<string, unknown> = {};
    let node = out;
    for (let i = 0; i < parts.length - 1; i++) {
        node[parts[i]] = {};
        node = node[parts[i]] as Record<string, unknown>;
    }
    node[parts[parts.length - 1]] = value;
    return out;
}

/** Every dotted leaf path of the loaded defaults, with its default value. */
async function leaves(): Promise<Array<[string, unknown]>> {
    const cfg = await loadConfig({ appRoot: path.join(root, 'seed'), env: { HF_HOME: '/tmp/hf' }, log: () => {} });
    const found: Array<[string, unknown]> = [];
    const walk = (value: unknown, prefix: string): void => {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            for (const [key, child] of Object.entries(value)) walk(child, prefix ? `${prefix}.${key}` : key);
        } else {
            found.push([prefix, value]);
        }
    };
    walk(cfg, '');
    return found.sort(([a], [b]) => a.localeCompare(b));
}

describe('config schema stays in sync across its derived views', () => {
    it('every default key is a key a config file may set', async () => {
        // If a leaf is in the defaults but missing from the key list, writing
        // that key is rejected as "unknown key" -- the failure this guards.
        const all = await leaves();
        expect(all.length).toBeGreaterThan(40);
        for (const [dotted, value] of all) {
            const issues = await issuesFor(setPath(dotted, value));
            expect(issues.filter(i => i.includes('unknown key')), dotted).toEqual([]);
        }
    });

    it('every leaf is actually validated', async () => {
        // A leaf with no check would let a nonsense value through silently.
        const all = await leaves();
        for (const [dotted] of all) {
            const rejected: string[] = [];
            for (const hostile of ['@@not a value@@', 12345, null, [], true, -1]) {
                const issues = await issuesFor(setPath(dotted, hostile));
                if (issues.some(i => i.includes(dotted))) { rejected.push(...issues); break; }
            }
            expect(rejected, `${dotted} accepted every hostile value`).not.toEqual([]);
        }
    });
});

describe('a group replaced by a scalar is rejected, not half-applied', () => {
    // Reading a field off a scalar yields undefined, so every leaf in the group
    // reports its own problem. The alternative -- skipping the group -- lets a
    // server boot with config.server set to a string.
    for (const group of ['server', 'paths', 'llama', 'telemetry', 'processes', 'service', 'upgrade', 'worker', 'uiDefaults', 'launch']) {
        it(`${group} as a string is rejected`, async () => {
            const issues = await issuesFor({ [group]: 'nope' });
            expect(issues.length, group).toBeGreaterThan(0);
            expect(issues.every(i => i.startsWith(group + '.')), issues.join(' | ')).toBe(true);
        });
    }
});

describe('validation messages', () => {
    it('names the range for an out-of-range port', async () => {
        expect(await issuesFor({ server: { port: 70000 } }))
            .toEqual(['server.port must be an integer between 1 and 65535']);
    });
    it('requires a non-empty string for a host', async () => {
        expect(await issuesFor({ llama: { defaultHost: '  ' } }))
            .toEqual(['llama.defaultHost must be a non-empty string']);
    });
    it('requires a boolean, not a truthy value', async () => {
        expect(await issuesFor({ telemetry: { enabled: 'yes' } }))
            .toEqual(['telemetry.enabled must be a boolean']);
    });
    it('requires an array of non-empty strings', async () => {
        expect(await issuesFor({ paths: { modelDirectories: ['ok', ''] } }))
            .toEqual(['paths.modelDirectories must be an array of non-empty strings']);
    });
    it('bounds a percentage', async () => {
        expect(await issuesFor({ uiDefaults: { tensorSplit: 150 } }))
            .toEqual(['uiDefaults.tensorSplit must be a number between 0 and 100']);
    });
    it('requires a positive temperature', async () => {
        expect(await issuesFor({ launch: { temp: 0 } }))
            .toEqual(['launch.temp must be a number greater than 0']);
    });
    it('restricts telemetry providers', async () => {
        expect(await issuesFor({ telemetry: { providers: ['nvidia', 'voodoo'] } }))
            .toEqual(['telemetry.providers must contain only nvidia, amd, or linux']);
    });
    it('restricts the telemetry source', async () => {
        expect(await issuesFor({ telemetry: { source: 'guess' } }))
            .toEqual(['telemetry.source must be "monitor" or "builtin"']);
    });
    it('allows an empty launch string but not a blank one', async () => {
        expect(await issuesFor({ launch: { chatTemplateFile: '' } })).toEqual([]);
        expect(await issuesFor({ launch: { chatTemplateFile: '   ' } }))
            .toEqual(['launch.chatTemplateFile must be a non-empty string when provided']);
    });
    it('treats a null huggingFaceCache as "derive it"', async () => {
        expect(await issuesFor({ paths: { huggingFaceCache: null } })).toEqual([]);
        expect(await issuesFor({ paths: { huggingFaceCache: '' } }))
            .toEqual(['paths.huggingFaceCache must be a non-empty string']);
    });
    it('reports every unknown key, at depth', async () => {
        const issues = await issuesFor({ server: { bogus: 1 }, llama: { builds: [{ id: 'a', label: 'b', path: 'c', extra: 2 }] } });
        expect(issues).toEqual(['unknown key: server.bogus', 'unknown key: llama.builds.0.extra']);
    });
    it('rejects prototype keys without mutating built-in prototypes', async () => {
        const malicious = JSON.parse('{"__proto__":{"cfgPolluted":true},"server":{"constructor":{"prototype":{"cfgPolluted":true}}}}');
        expect(await issuesFor(malicious)).toEqual([
            'unknown key: __proto__',
            'unknown key: server.constructor',
        ]);
        expect((Object.prototype as { cfgPolluted?: boolean }).cfgPolluted).toBeUndefined();
    });
    it('requires all four worker commands together', async () => {
        const issues = await issuesFor({ worker: { startCommand: 'x', stopCommand: '', statusCommand: '', logsCommand: '' } });
        expect(issues).toEqual(['worker command section requires all four commands when any command is non-empty']);
        expect(await issuesFor({ worker: { startCommand: 'x', stopCommand: 'y', statusCommand: 'z', logsCommand: 'w' } })).toEqual([]);
    });
    it('checks each build record', async () => {
        const issues = await issuesFor({ llama: { builds: [{ id: '', label: 'L', path: 'p' }, 'nope'] } });
        expect(issues).toEqual([
            'llama.builds.0.id must be a non-empty string',
            'llama.builds.1 must be an object',
        ]);
    });
    it('reports several problems at once', async () => {
        const issues = await issuesFor({ server: { port: 0 }, telemetry: { pollMs: 1 } });
        expect(issues).toEqual([
            'server.port must be an integer between 1 and 65535',
            'telemetry.pollMs must be an integer between 50 and 60000',
        ]);
    });
});
