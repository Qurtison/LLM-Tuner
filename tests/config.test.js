import { describe, it, expect } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadConfig, publicConfig, ConfigError } from '../src/server/config.ts';

function dir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-')); }
function json(root, value, name = 'config/dashboard.json') { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); return file; }
function load(root, env = {}) { return loadConfig({ appRoot: root, env, log: () => {} }); }
function rejects(root, value, text) { return expect(load(root)).rejects.toMatchObject({ issues: expect.arrayContaining([expect.stringContaining(text)]) }); }

describe('typed dashboard config', () => {
    it('uses defaults without file', async () => {
        const root = dir(); const cfg = await load(root);
        expect(cfg.server.port).toBe(3000); expect(cfg.llama.builds).toEqual([]); expect(cfg.processes.cleanupManagedPortsOnStart).toBe(false);
        expect(cfg.paths.logsDirectory).toBe(path.join(root, 'logs')); expect(cfg.paths.huggingFaceCache).toBe(path.join(os.homedir(), '.cache', 'huggingface', 'hub'));
    });
    it('loads new file overrides and resolves paths', async () => {
        const root = dir(); json(root, { server: { port: 3105 }, llama: { builds: [{ id: 'x', label: 'X', path: './bin' }] }, paths: { logsDirectory: './custom-logs', modelDirectories: ['./m'] } });
        const cfg = await load(root); expect(cfg.server.port).toBe(3105); expect(cfg.paths.logsDirectory).toBe(path.join(root, 'config/custom-logs')); expect(cfg.paths.modelDirectories).toEqual([path.join(root, 'config/m')]); expect(cfg.llama.builds[0].path).toBe(path.join(root, 'config/bin'));
    });
    it('resolves relative paths from config directory', async () => { const root = dir(); json(root, { paths: { modelDirectories: ['./m'] } }, 'nested/dashboard.json'); expect((await load(root, { DASHBOARD_CONFIG: 'nested/dashboard.json' })).paths.modelDirectories).toEqual([path.join(root, 'nested/m')]); });
    it('selects DASHBOARD_CONFIG file', async () => { const root = dir(); const file = json(root, { server: { port: 3106 } }, 'other/a.json'); expect((await load(root, { DASHBOARD_CONFIG: 'other/a.json' })).server.port).toBe(3106); expect(file).toBeTruthy(); });
    it('lets environment beat file', async () => { const root = dir(); json(root, { server: { port: 3105 } }); const cfg = await load(root, { DASHBOARD_PORT: '3200', DASHBOARD_HOST: '0.0.0.0', DASHBOARD_LOGS_DIR: './env-logs' }); expect(cfg.server.port).toBe(3200); expect(cfg.server.host).toBe('0.0.0.0'); expect(cfg.paths.logsDirectory).toBe(path.join(root, 'config/env-logs')); });
    it('rejects unknown keys', async () => { const root = dir(); json(root, { server: { bogus: true } }); await rejects(root, null, 'server.bogus'); });
    it('rejects invalid fields', async () => {
        for (const [value, name] of [[{ server: { port: 'abc' } }, 'server.port'], [{ server: { port: 70000 } }, 'server.port'], [{ telemetry: { pollMs: 10 } }, 'telemetry.pollMs'], [{ uiDefaults: { tensorSplit: 150 } }, 'uiDefaults.tensorSplit']]) { const root = dir(); json(root, value); await rejects(root, null, name); }
    });
    it('rejects partial worker commands and bad providers', async () => { let root = dir(); json(root, { worker: { startCommand: 'x', stopCommand: '', statusCommand: '', logsCommand: '' } }); await rejects(root, null, 'worker'); root = dir(); json(root, { telemetry: { providers: ['nvidia', 'voodoo'] } }); await rejects(root, null, 'telemetry.providers'); });
    it('maps legacy fields and ignores legacy unknown keys', async () => { let root = dir(); json(root, { llamaServerBinary: '/tmp/x/llama-server', ignored: 1 }, 'dashboard.config.json'); expect((await load(root)).llama.builds).toEqual([{ id: 'default', label: 'Default', path: '/tmp/x/llama-server' }]); root = dir(); json(root, { llamaServerBuilds: [{ id: 'x', label: 'X', path: '/tmp/y' }] }, 'dashboard.config.json'); expect((await load(root)).llama.builds[0].id).toBe('x'); });
    it('prefers new file over legacy file', async () => { const root = dir(); json(root, { server: { port: 3105 } }); json(root, { llamaServerBinary: '/tmp/old' }, 'dashboard.config.json'); const cfg = await load(root); expect(cfg.server.port).toBe(3105); expect(cfg.llama.builds).toEqual([]); });
    it('uses file cache then HF_HOME cache', async () => { const root = dir(); json(root, { paths: { huggingFaceCache: './hf' } }); expect((await load(root)).paths.huggingFaceCache).toBe(path.join(root, 'config/hf')); expect((await load(root, { HF_HOME: '/tmp/home' })).paths.huggingFaceCache).toBe('/tmp/home'); });
    it('hides private config fields', async () => { const root = dir(); json(root, { worker: { sshHost: '', transportPresets: [{ id: 'a', label: 'A' }] }, llama: { builds: [{ id: 'x', label: 'X', path: '/tmp/x' }] } }); const text = JSON.stringify(publicConfig(await load(root))); expect(text).not.toContain('logsDirectory'); expect(text).not.toContain('startCommand'); expect(publicConfig(await load(root)).llama.builds[0]).not.toHaveProperty('path'); expect(publicConfig(await load(root)).worker.enabled).toBe(false); });
    it('rejects invalid and missing DASHBOARD_CONFIG', async () => { const root = dir(); await expect(load(root, { DASHBOARD_PORT: 'abc' })).rejects.toBeInstanceOf(ConfigError); await expect(load(root, { DASHBOARD_CONFIG: 'gone.json' })).rejects.toMatchObject({ issues: expect.arrayContaining([expect.stringContaining('DASHBOARD_CONFIG')]) }); });
});
