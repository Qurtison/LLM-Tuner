import { test, expect } from 'bun:test';
import {
    isSameHost, parseMeminfo, parseCpuUtil, parseNetdev, parseCpuName, parseCpuTemp,
    parseSections, parseFirstJson, val, parseProcessVram, parseProcessRam
} from '../src/server/services/hwmon';
import { startTestServer, type TestServer } from './helpers/test-server';

test('isSameHost marks shared-host worker targets (port of monitor._is_same_host)', () => {
    const cases: [string, boolean][] = [
        ['localhost', true],
        ['127.0.0.1', true],
        ['::1', true],
        ['0.0.0.0', true],
        ['user@localhost', true],
        ['[::1]', true],
        ['kyle4090@169.254.61.173', false],
        ['192.168.1.50', false],
        ['', false]
    ];
    for (const [target, expected] of cases) expect(isSameHost(target), target).toBe(expected);
});

test('parseMeminfo returns total and true-used (Total - Available)', () => {
    expect(parseMeminfo('MemTotal:       16384000 kB\nMemFree:        1000000 kB\nMemAvailable:   8192000 kB\n')).toEqual([16384000, 8192000]);
    expect(parseMeminfo('')).toEqual([0, 0]);
});

test('parseCpuUtil uses only the aggregate cpu line', () => {
    const stat = [
        'cpu  1000 0 500 8000 100 0 50 0 0 0',
        'cpu0 10 0 10 900 0 0 0 0 0 0',
        'cpu1 20 0 20 800 0 0 0 0 0 0',
        'intr 12345'
    ].join('\n');
    // busy = 1650, total = 9650 -> 17.1
    expect(parseCpuUtil(stat)).toBe(17.1);
    expect(parseCpuUtil('cpu  0 0 0 1000 0 0 0 0 0 0')).toBe(0);
    expect(parseCpuUtil('')).toBe(0);
});

test('parseNetdev sums rx+tx per interface (values[8] is TX bytes)', () => {
    const data = [
        'Inter-|   Receive                                                |  Transmit',
        '   | bytes   packets errs drop fifo frame compressed multicast|bytes   packets errs drop fifo colls carrier compressed',
        'eth0: 1000 10 0 0 0 0 0 0 2000 20 0 0 0 0 0',
        'lo: 500 5 0 0 0 0 0 0 500 5 0 0 0 0 0'
    ].join('\n');
    const [total, byIface] = parseNetdev(data);
    expect(total).toBe(4000);
    expect(byIface['eth0']).toEqual({ rx: 1000, tx: 2000, total: 3000 });
    expect(parseNetdev('')).toEqual([0, {}]);
});

test('parseCpuName extracts the first model name line', () => {
    expect(parseCpuName('processor\t: 0\nmodel name\t: Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz\n')).toBe('Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz');
    expect(parseCpuName('nothing here')).toBe('Unknown CPU');
});

test('parseCpuTemp handles local and remote (value + path annotation) forms', () => {
    expect(parseCpuTemp('45000\n')).toBe(45);
    expect(parseCpuTemp('45000\n(/sys/class/thermal/thermal_zone0/temp)\n')).toBe(45);
    expect(parseCpuTemp('300000\n')).toBe(0); // out of valid millidegree range
    expect(parseCpuTemp('')).toBe(0);
});

test('parseSections splits ===MARKER=== output; pre-marker data is gpu', () => {
    const out = 'GPU line 1\n===APPS===\napp line\n===MEMINFO===\nMemTotal: 1 kB\n';
    const sections = parseSections(out);
    expect(sections['gpu']).toBe('GPU line 1');
    expect(sections['APPS']).toBe('app line');
    expect(sections['MEMINFO']).toBe('MemTotal: 1 kB');
});

test('parseFirstJson parses the leading object, rejects non-objects', () => {
    expect(parseFirstJson('{"devices": []} trailing garbage')).toEqual({ devices: [] });
    expect(parseFirstJson('[1, 2]')).toBeNull();
    expect(parseFirstJson('no json')).toBeNull();
});

test('val walks amdgpu_top {unit, value} leaf shapes', () => {
    const device = { VRAM: { 'Total VRAM Usage': { unit: 'MiB', value: 1234 }, 'Total VRAM': { unit: 'MiB', value: 16384 } } };
    expect(val(device, ['VRAM', 'Total VRAM Usage'])).toBe(1234);
    expect(val(device, ['VRAM', 'Missing'])).toBe(0);
    expect(val(device, ['Missing', 'Deep'])).toBe(0);
});

test('parseProcessVram / parseProcessRam sum only llama and ggml-rpc lines', () => {
    expect(parseProcessVram('12345, /usr/bin/llama-server\n678, other\n567, ggml-rpc-server\n')).toBe(12912);
    expect(parseProcessRam('1234567 llama-server\n999 bench\n655360 ggml-rpc-server\n')).toBe(1205 + 640);
});

test('server boots with telemetry.source=builtin and serves /api/telemetry/latest', async () => {
    let server: TestServer | null = null;
    try {
        server = await startTestServer({ config: { telemetry: { enabled: true, source: 'builtin' } } });
        expect(server.output).toContain('in-process hwmon collector active');
        const until = Date.now() + 10000;
        type Latest = { t: number; stats: { master?: Record<string, unknown>; worker?: Record<string, unknown> | null } | null };
        let stats: Latest | null = null;
        while (Date.now() < until) {
            const body = (await (await fetch(server.url('/api/telemetry/latest'))).json()) as Latest;
            if (body.stats) { stats = body; break; }
            await Bun.sleep(150);
        }
        expect(stats, 'telemetry/latest never populated: ' + server.output.slice(-2000)).not.toBeNull();
        const master = stats!.stats!.master!;
        expect(typeof master['gpu_name']).toBe('string');
        expect(typeof master['cpu_util']).toBe('number');
        expect(typeof master['ram_total']).toBe('number');
        expect((master['ram_total'] as number) > 0).toBe(true);
        // No launch config in a fresh test server -> worker slot is the local
        // AMD second GPU, marked same_host exactly like monitor.py did.
        const worker = stats!.stats!.worker;
        expect(worker).toBeTruthy();
        expect((worker as Record<string, unknown>)['same_host']).toBe(true);
    } finally {
        if (server) await server.stop();
    }
}, 30000);
