// Gap-closing route tests: presets (G1), files (G5), unit (G2 disabled
// path), apply, server-paths (G7). Unit tests use manageViaSystemd=false
// so systemctl is never invoked.
const { afterAll, beforeAll, describe, expect, it } = require('bun:test');
const fs = require('fs');
const path = require('path');
const { startTestServer, stopTestServer } = require('./helpers/test-server');

let server;

async function json(url, options) {
    return fetch(url, options).then(async response => ({ response, body: await response.json().catch(() => null) }));
}
async function post(route, body) {
    return json(server.url(route), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

describe('gap routes', () => {
    beforeAll(async () => {
        server = await startTestServer({
            models: ['fake.gguf'],
            config: {
                service: { unitName: 'test-unit.service', unitPath: path.join(server ? server.tempDir : '/tmp', 'x'), enableOnApply: false, manageViaSystemd: false },
                upgrade: { repoDir: '', buildDir: '', enabled: false },
            },
        });
    });
    afterAll(async () => { if (server) await stopTestServer(server); });

    it('presets CRUD + active + validate', async () => {
        const created = await post('/api/presets', { name: 'test-preset', build: 'fake', config: { modelPath: 'fake.gguf', ctx: 4096, ngl: 99 } });
        expect(created.response.status).toBe(200);
        expect(created.body.ok).toBe(true);
        const list = await json(server.url('/api/presets'));
        expect(list.body.presets.some(p => p.name === 'test-preset')).toBe(true);
        const activate = await post('/api/presets/test-preset/activate', {});
        expect(activate.body.active).toBe('test-preset');
        const got = await json(server.url('/api/presets/test-preset'));
        expect(got.body.config.ctx).toBe(4096);
        const validate = await post('/api/presets/validate', { name: 'x', config: { model: 'missing.gguf' } });
        expect(validate.body.warnings.length).toBeGreaterThan(0);
        const del = await fetch(server.url('/api/presets/test-preset'), { method: 'DELETE' });
        expect(del.status).toBe(200);
        const list2 = await json(server.url('/api/presets'));
        expect(list2.body.presets.some(p => p.name === 'test-preset')).toBe(false);
    });

    it('files tree + delete', async () => {
        const list = await json(server.url('/api/files'));
        expect(list.body.entries.some(e => e.name === 'fake.gguf' && !e.isDir)).toBe(true);
        const del = await post('/api/files/delete', { path: 'fake.gguf' });
        expect(del.body.ok).toBe(true);
        const list2 = await json(server.url('/api/files'));
        expect(list2.body.entries.some(e => e.name === 'fake.gguf')).toBe(false);
        // traversal guard
        const bad = await json(server.url('/api/files?path=..%2F..%2Fetc'));
        expect(bad.response.status).toBe(400);
    });

    it('unit disabled path + apply without active preset', async () => {
        const status = await json(server.url('/api/unit/status'));
        expect(status.body.activeState).toBe('disabled');
        const start = await post('/api/unit/start', {});
        expect(start.response.status).toBe(400);
        const apply = await post('/api/apply', { restart: false });
        expect(apply.body.ok).toBe(false);
        expect(apply.body.error).toContain('no active preset');
    });

    it('server-paths returns config-driven paths', async () => {
        const resp = await json(server.url('/api/server-paths'));
        expect(resp.body.modelsDir).toContain('models');
        expect(Array.isArray(resp.body.buildDirs)).toBe(true);
        expect(resp.body.activeBuildDir).toBe('fake'); // falls back to first configured build
    });
});
