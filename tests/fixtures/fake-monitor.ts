export {}; // module marker: keep top-level consts out of the global scope (typecheck)
const port = Number(process.env.FAKE_MONITOR_PORT || 0);

if (process.env.FAKE_MONITOR_PIDFILE) Bun.write(process.env.FAKE_MONITOR_PIDFILE, String(process.pid));

Bun.serve({
    port,
    hostname: '127.0.0.1',
    fetch: req => {
        if (req.method === 'POST' && req.url.endsWith('/stats')) {
            return Response.json({ master: { gpu_util: 42, gpu_pwr: 55, gpu_temp: 51, cpu_util: 7, cpu_temp: 44, vram_used: 2048, net_bytes: 1048576, ram_used: 500, process_ram: 250 }, worker: null });
        }
        return new Response('not found', { status: 404 });
    }
});
