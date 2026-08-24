// Named launch presets (gap G1, docs/gap-analysis.md). A preset is
// { name, build, label?, config: LaunchConfig }. Stored as JSON files in
// config.paths.presetsDirectory (default <appRoot>/presets). The active
// preset name is persisted in <presetsDirectory>/active.json.
//
// Keep the shape compatible with the old dashboard's mental model (named
// configs, one active) while reusing the existing LaunchConfig fields so
// /api/start can consume a preset directly.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { LaunchConfig } from '../../../shared/contracts';

export interface Preset {
    name: string;
    build: string;
    label?: string;
    config: LaunchConfig;
}

// Same alphabet as the old dashboard's _NAME_RE: preset names become file
// names, so anything outside this is a path-traversal vector.
const NAME_RE = /^[A-Za-z0-9._-]+$/;

function validName(name: unknown): name is string {
    return typeof name === 'string' && NAME_RE.test(name);
}

export class PresetStore {
    private readonly dir: string;
    private readonly activePath: string;
    private cache: Map<string, Preset> | null = null;

    constructor(presetsDirectory: string) {
        this.dir = presetsDirectory;
        this.activePath = path.join(presetsDirectory, 'active.json');
    }

    private async ensure(): Promise<void> {
        await fs.mkdir(this.dir, { recursive: true });
    }

    private async load(): Promise<Map<string, Preset>> {
        if (this.cache) return this.cache;
        const map = new Map<string, Preset>();
        await this.ensure();
        let names: string[];
        try {
            names = (await fs.readdir(this.dir)).filter(n => n.endsWith('.json') && n !== 'active.json');
        } catch {
            names = [];
        }
        for (const name of names) {
            try {
                const raw = JSON.parse(await fs.readFile(path.join(this.dir, name), 'utf8')) as Preset;
                if (raw && typeof raw.name === 'string' && raw.config && typeof raw.config === 'object') {
                    map.set(raw.name, raw);
                }
            } catch { /* unreadable/corrupt preset file: skip, list stays usable */ }
        }
        this.cache = map;
        return map;
    }

    private invalidate(): void { this.cache = null; }

    async list(): Promise<Preset[]> {
        const map = await this.load();
        return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
    }

    async get(name: string): Promise<Preset | null> {
        const map = await this.load();
        return map.get(name) ?? null;
    }

    async save(preset: Preset): Promise<void> {
        if (!validName(preset.name)) throw new Error('invalid preset name: ' + String(preset.name));
        if (!preset.config || typeof preset.config !== 'object') throw new Error('preset needs a config object');
        await this.ensure();
        const file = path.join(this.dir, preset.name + '.json');
        await fs.writeFile(file, JSON.stringify(preset, null, 2) + '\n');
        this.invalidate();
        await this.load();
    }

    async delete(name: string): Promise<boolean> {
        if (!validName(name)) throw new Error('invalid preset name: ' + String(name));
        const file = path.join(this.dir, name + '.json');
        try {
            await fs.unlink(file);
        } catch {
            return false;
        }
        this.invalidate();
        const active = await this.getActiveName();
        if (active === name) await this.setActiveName(null);
        return true;
    }

    async getActiveName(): Promise<string | null> {
        try {
            const raw = JSON.parse(await fs.readFile(this.activePath, 'utf8')) as { active?: unknown };
            return typeof raw.active === 'string' ? raw.active : null;
        } catch {
            return null;
        }
    }

    async setActiveName(name: string | null): Promise<void> {
        await this.ensure();
        await fs.writeFile(this.activePath, JSON.stringify({ active: name }, null, 2) + '\n');
    }

    async getActive(): Promise<Preset | null> {
        const name = await this.getActiveName();
        if (!name) return null;
        return this.get(name);
    }
}

// File-arg values that must point at an existing file before a launch is
// worth attempting (mirrors old dashboard FILE_ARGS).
const FILE_ARGS = ['model', 'mmproj', 'lora', 'lora-scaled', 'control-vector', 'modelPath', 'specDraftModel'];

export async function validatePreset(preset: Preset, modelDirectories: string[]): Promise<string[]> {
    const warnings: string[] = [];
    const config = preset.config || {};
    for (const key of FILE_ARGS) {
        const value = config[key as keyof LaunchConfig];
        if (value === undefined || value === null || value === '') continue;
        const raw = String(value);
        for (const part of raw.split(',')) {
            const p = part.trim();
            if (!p) continue;
            const candidates = path.isAbsolute(p)
                ? [p]
                : modelDirectories.map(d => path.join(d, p));
            let exists = false;
            for (const c of candidates) { try { if ((await fs.stat(c)).isFile()) { exists = true; break; } } catch { /* not found */ } }
            if (!exists) {
                warnings.push(key + ': file not found: ' + p);
            }
        }
    }
    return warnings;
}
