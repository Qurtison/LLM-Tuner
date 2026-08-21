const { afterEach, describe, expect, it } = require('bun:test');
const { spawn, spawnSync } = require('child_process');
const { startTestServer, stopTestServer } = require('./helpers/test-server');

function port() { return 20000 + Math.floor(Math.random() * 20001); }

function startDummy(target) {
    const child = spawn(process.execPath, ['-e', `Bun.serve({ port: ${target}, hostname: '127.0.0.1', fetch: () => new Response('dummy') });`], { stdio: 'ignore' });
    return child;
}

async function ready(target) {
    const end = Date.now() + 5000;
    while (Date.now() < end) {
        try { if (await (await fetch('http://127.0.0.1:' + target + '/')).text() === 'dummy') return; } catch {}
        await Bun.sleep(50);
    }
    throw new Error('Dummy listener did not start');
}

async function eventuallyFails(url) {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
        try { await fetch(url); } catch { return; }
        await Bun.sleep(100);
    }
    throw new Error('Port owner survived cleanup');
}

describe('startup port cleanup', () => {
    let dashboard;
    let dummy;
    afterEach(async () => {
        if (dashboard) await stopTestServer(dashboard);
        dashboard = null;
        if (dummy && dummy.exitCode === null) dummy.kill('SIGKILL');
        dummy = null;
    });

    it('default config never kills an unrelated port owner', async () => {
        const target = port();
        dummy = startDummy(target);
        await ready(target);
        dashboard = await startTestServer({ config: { server: { port: port() }, llama: { defaultPort: target, builds: [] }, telemetry: { enabled: false }, processes: { cleanupManagedPortsOnStart: false } } });
        expect(await (await fetch('http://127.0.0.1:' + target + '/')).text()).toBe('dummy');
    });

    it('opt-in cleanup kills the port owner', async () => {
        if (spawnSync('which', ['fuser']).status !== 0) {
            console.log('Skipping: fuser is unavailable on PATH');
            return;
        }
        const target = port();
        dummy = startDummy(target);
        await ready(target);
        dashboard = await startTestServer({ config: { server: { port: port() }, llama: { defaultPort: target, builds: [] }, telemetry: { enabled: false }, processes: { cleanupManagedPortsOnStart: true } } });
        await eventuallyFails('http://127.0.0.1:' + target + '/');
        dummy = null;
    });
});
