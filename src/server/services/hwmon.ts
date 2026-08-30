// In-process hardware telemetry collector. Ports monitor.py's stat collection
// (nvidia-smi / amdgpu_top / ssh / /proc + /sys reads) into the Bun server so
// telemetry no longer needs a Python child or the 8081 HTTP hop. The legacy
// monitor.py path (telemetry.source = 'monitor') stays available; this is the
// 'builtin' source. Response shapes are intentionally identical to monitor.py's
// /stats output -- csvlog.ts and the client read the same fields.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import type { TelemetryStats } from './types';

// monitor.py's /stats response values include strings (gpu_name), booleans
// (same_host) and arrays (throttle_reasons) even though the loose
// TelemetryStats type says number|null -- the cast at collectStats() is the
// one deliberate boundary for that pre-existing looseness.
export type StatBlock = Record<string, number | string | boolean | null | string[] | Record<string, unknown>>;

const NVIDIA_QUERY = '--query-gpu=name,memory.used,memory.total,power.draw,temperature.gpu,utilization.gpu,clocks_throttle_reasons.hw_thermal_slowdown,clocks_throttle_reasons.sw_thermal_slowdown,clocks_throttle_reasons.sw_power_cap,clocks_throttle_reasons.hw_power_brake_slowdown';
const NVIDIA_APPS_QUERY = '--query-compute-apps=used_memory,name';
const THROTTLE_FIELDS = ['hw_thermal_slowdown', 'sw_thermal_slowdown', 'sw_power_cap', 'hw_power_brake_slowdown'];
// Remote worker: one ssh round-trip, sections delimited by ===MARKER=== lines
// (verbatim from monitor.py -- changing it would change remote behavior).
const REMOTE_SHELL_CMD =
    "nvidia-smi '" + NVIDIA_QUERY + "' '--format=csv,noheader,nounits' 2>/dev/null || true; " +
    "echo '===APPS==='; " +
    "nvidia-smi '" + NVIDIA_APPS_QUERY + "' '--format=csv,noheader,nounits' 2>/dev/null || true; " +
    "echo '===MEMINFO==='; " +
    "cat /proc/meminfo 2>/dev/null || true; " +
    "echo '===PS==='; " +
    "ps ax -o rss,comm 2>/dev/null || true; " +
    "echo '===CPUSTAT==='; " +
    "cat /proc/stat 2>/dev/null || true; " +
    "echo '===CPUINFO==='; " +
    "cat /proc/cpuinfo 2>/dev/null || true; " +
    "echo '===TEMP==='; " +
    'for f in /sys/class/thermal/thermal_zone[0-9]*/temp; do cat "$f" 2>/dev/null && echo "($f)" || true; done; echo \'===NETDEV===\'; ' +
    'cat /proc/net/dev 2>/dev/null || true';

function readText(file: string): Promise<string> {
    return readFile(file, 'utf8').catch(() => '');
}

// Run a command with a hard timeout; resolve (never throw) with ok = exit 0.
// Python check_output equivalent: non-zero exit or timeout => ok: false.
async function runCmd(cmd: string[], timeoutMs: number): Promise<{ ok: boolean; out: string }> {
    let proc: Bun.Subprocess;
    try {
        proc = Bun.spawn(cmd, { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' });
    } catch {
        return { ok: false, out: '' };
    }
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* already gone */ } }, timeoutMs);
    try {
        const [code, out] = await Promise.all([proc.exited, proc.stdout instanceof ReadableStream ? new Response(proc.stdout).text() : Promise.resolve('')]);
        return { ok: code === 0, out };
    } finally {
        clearTimeout(timer);
    }
}

// --- pure parsers (exported for tests) ---

// True if an SSH-style target ('[user@]host') points at this machine. Port of
// monitor.py _is_same_host -- a loopback/own-hostname RPC target (or the local
// second-GPU mode) shares master's machine-level cpu/ram/net pool, so the
// worker slot is marked same_host and the frontend does not show them twice.
export function isSameHost(sshTarget: string): boolean {
    let host = (sshTarget.split('@').pop() || '').trim().replace(/^[\][]+|[\][]+$/g, '').toLowerCase();
    // A single-colon "host:port" (e.g. the raw --rpc "127.0.0.1:50052") must
    // not defeat loopback detection; a bare IPv6 literal (multiple colons,
    // e.g. ::1) is left intact.
    const parts = host.split(':');
    if (parts.length === 2 && /^\d+$/.test(parts[1])) host = parts[0];
    if (!host) return false;
    return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1' || host === os.hostname().toLowerCase();
}

// /proc/meminfo -> [total_kb, used_kb] with used = Total - Available (the
// standard Linux "true used" figure; always >= any single process's RSS).
export function parseMeminfo(data: string): [number, number] {
    const values: Record<string, number> = {};
    for (const line of data.split('\n')) {
        const parts = line.split(/\s+/);
        if (parts.length >= 2) {
            const value = parseInt(parts[1], 10);
            if (Number.isFinite(value)) values[parts[0].replace(/:$/, '')] = value;
        }
    }
    const total = values['MemTotal'] || 0;
    const available = values['MemAvailable'] || 0;
    return [total, Math.max(total - available, 0)];
}

// /proc/stat aggregate cpu line -> utilization 0-100, one decimal. Same
// formula monitor.py uses (busy = total - idle; iowait/irq/softirq/steal
// count as busy).
export function parseCpuUtil(statData: string): number {
    for (const line of statData.split('\n')) {
        if (!line.startsWith('cpu ')) continue;
        const parts = line.split(/\s+/);
        if (parts.length < 5) continue;
        const fields = parts.slice(1).map(Number);
        while (fields.length < 8) fields.push(0);
        const total = fields.slice(0, 8).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
        const idle = Number.isFinite(fields[3]) ? fields[3] : 0;
        const busy = total - idle;
        return total > 0 ? Math.round((busy / total) * 1000) / 10 : 0;
    }
    return 0;
}

// /proc/net/dev -> [totalBytes, {iface: {rx, tx, total}}] (port of
// monitor.py _parse_netdev; values[8] is the TX bytes column).
export function parseNetdev(data: string): [number, Record<string, { rx: number; tx: number; total: number }>] {
    let total = 0;
    const byIface: Record<string, { rx: number; tx: number; total: number }> = {};
    for (const raw of data.split('\n')) {
        const line = raw.trim();
        if (!line || !line.includes(':')) continue;
        const cut = line.indexOf(':');
        const iface = line.slice(0, cut).trim();
        const values = line.slice(cut + 1).trim().split(/\s+/);
        if (values.length < 10) continue;
        const rx = parseInt(values[0], 10);
        const tx = parseInt(values[8], 10);
        if (!Number.isFinite(rx) || !Number.isFinite(tx)) continue;
        total += rx + tx;
        byIface[iface] = { rx, tx, total: rx + tx };
    }
    return [total, byIface];
}

// First "model name" line of /proc/cpuinfo -> CPU name ('Unknown CPU' if none).
export function parseCpuName(cpuinfo: string): string {
    for (const line of cpuinfo.split('\n')) {
        if (line.includes('model name')) {
            const segment = line.split(':')[1];
            if (segment !== undefined) return segment.trim();
        }
    }
    return 'Unknown CPU';
}

// Thermal-zone output (millidegrees) -> first valid reading in whole degrees.
// Handles both the local single-value form and the remote "value (path)" form
// produced by monitor.py's TEMP section loop.
export function parseCpuTemp(tempOut: string): number {
    for (const raw of tempOut.split('\n')) {
        const line = raw.trim().replace(/[()]+$/, '');
        const tokens = line.split(/\s+/);
        const candidate = Number(tokens.length > 1 ? tokens[tokens.length - 1] : line);
        if (Number.isInteger(candidate) && candidate > 0 && candidate < 200000) return Math.trunc(candidate / 1000);
    }
    return 0;
}

// Split monitor.py's ===MARKER===-delimited ssh output into sections; data
// before the first marker belongs to 'gpu' (the leading nvidia-smi query).
export function parseSections(text: string): Record<string, string> {
    const lines: Record<string, string[]> = {};
    let current = 'gpu';
    for (const line of text.split('\n')) {
        const stripped = line.trim();
        if (stripped.startsWith('===') && stripped.endsWith('===')) {
            current = stripped.replace(/^=+|=+$/g, '');
            continue; // marker lines delimit, they are not section content
        }
        (lines[current] ??= []).push(line);
    }
    const out: Record<string, string> = {};
    for (const [name, sectionLines] of Object.entries(lines)) out[name] = sectionLines.join('\n').trim();
    return out;
}

// First JSON object in a string, tolerating trailing garbage (port of the
// raw_decode salvage in monitor.py's amdgpu_top path).
export function parseFirstJson(text: string): Record<string, unknown> | null {
    const parse = (candidate: string): Record<string, unknown> | null => {
        try {
            const parsed: unknown = JSON.parse(candidate.trim());
            return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
        } catch {
            return null;
        }
    };
    const direct = parse(text);
    if (direct) return direct;
    // raw_decode salvage: trailing garbage after the JSON object (partial
    // output after the amdgpu_top force-kill).
    const end = text.lastIndexOf('}');
    return end > 0 ? parse(text.slice(0, end + 1)) : null;
}

// Walk a nested object by key path; if the final value is an object return its
// 'value' field (amdgpu_top's {unit, value} leaf shape). Port of _val().
export function val(data: unknown, keys: string[], fallback = 0): number {
    let cur: unknown = data;
    for (const key of keys) {
        if (typeof cur !== 'object' || cur === null || Array.isArray(cur)) return fallback;
        if (!(key in (cur as Record<string, unknown>))) return fallback;
        cur = (cur as Record<string, unknown>)[key];
    }
    if (typeof cur === 'object' && cur !== null && !Array.isArray(cur)) {
        const v = (cur as Record<string, unknown>)['value'];
        return typeof v === 'number' ? v : fallback;
    }
    return typeof cur === 'number' ? cur : fallback;
}

// --- nvidia-smi CSV parsing (shared by local and remote) ---

interface GpuFields {
    name: string;
    vramUsed: number;
    vramTotal: number;
    pwr: number;
    temp: number;
    util: number;
    throttleReasons: string[];
}

const UNKNOWN_GPU: GpuFields = { name: 'Unknown', vramUsed: 0, vramTotal: 1, pwr: 0, temp: 0, util: 0, throttleReasons: [] };

function parseNvidiaGpu(gpuOut: string, hadError: boolean): GpuFields {
    if (hadError || gpuOut.trim() === '') return { ...UNKNOWN_GPU };
    try {
        const parts = gpuOut.split('\n')[0].split(',');
        if (parts.length < 6) return { ...UNKNOWN_GPU };
        const vramUsed = Math.trunc(Number(parts[1]));
        const vramTotal = Math.trunc(Number(parts[2]));
        const pwrRaw = parts[3].trim();
        const pwr = pwrRaw === '[Not Supported]' ? 0 : Number(pwrRaw);
        const temp = Math.trunc(Number(parts[4].trim()));
        const util = Math.trunc(Number(parts[5].trim()));
        if (![vramUsed, vramTotal, pwr, temp, util].every(Number.isFinite)) return { ...UNKNOWN_GPU };
        const throttleReasons: string[] = [];
        for (let i = 0; i < THROTTLE_FIELDS.length; i++) {
            const idx = 6 + i;
            if (idx < parts.length && parts[idx].trim() === 'Active') throttleReasons.push(THROTTLE_FIELDS[i]);
        }
        return { name: parts[0].trim(), vramUsed, vramTotal: vramTotal || 1, pwr, temp, util, throttleReasons };
    } catch {
        return { ...UNKNOWN_GPU };
    }
}

// Sum VRAM of llama-server / ggml-rpc-server lines from
// nvidia-smi --query-compute-apps output (used_memory column).
export function parseProcessVram(appsOut: string): number {
    let total = 0;
    for (const line of appsOut.split('\n')) {
        if (!line.includes('llama') && !line.includes('ggml-rpc')) continue;
        const parts = line.trim().split(',');
        if (parts.length >= 2) {
            const v = Math.trunc(Number(parts[0]));
            if (Number.isFinite(v)) total += v;
        }
    }
    return total;
}

// Sum RSS (kB -> MB) of llama-server / ggml-rpc-server lines from
// 'ps ax -o rss,comm'. RSS includes file-backed mmap pages deliberately.
export function parseProcessRam(psOut: string): number {
    let total = 0;
    for (const line of psOut.split('\n')) {
        if (!line.includes('llama-server') && !line.includes('ggml-rpc-server')) continue;
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2) {
            const rss = Number(parts[0]);
            if (Number.isFinite(rss)) total += Math.trunc(rss / 1024);
        }
    }
    return total;
}

// --- local collection ---

// Local /proc/net/dev total RX+TX bytes (monitor.py get_net_bytes).
export async function localNetBytes(): Promise<number> {
    const data = await readText('/proc/net/dev');
    let total = 0;
    for (const line of data.split('\n').slice(2)) {
        // trim first: leading iface padding makes JS split() yield an empty
        // parts[0] (Python str.split() does not), which would shift every
        // column index and silently drop padded interfaces.
        const parts = line.trim().split(/\s+/);
        if (parts.length < 2) continue;
        const rx = parseInt(parts[1], 10);
        const tx = parts.length > 9 ? parseInt(parts[9], 10) : 0;
        if (Number.isFinite(rx)) total += rx;
        if (Number.isFinite(tx)) total += tx;
    }
    return total;
}

export async function getLocalStats(): Promise<StatBlock> {
    const [gpuRes, appsRes, psRes, cpuStat, cpuinfo, tempOut, [memTotalKb, memUsedKb], netBytes] = await Promise.all([
        runCmd(['nvidia-smi', NVIDIA_QUERY, '--format=csv,noheader,nounits'], 2000),
        runCmd(['nvidia-smi', NVIDIA_APPS_QUERY, '--format=csv,noheader,nounits'], 2000),
        runCmd(['ps', 'ax', '-o', 'rss,comm'], 2000),
        readText('/proc/stat'),
        readText('/proc/cpuinfo'),
        readText('/sys/class/thermal/thermal_zone0/temp'),
        (async () => {
            const [total, used] = parseMeminfo(await readText('/proc/meminfo'));
            return [total, used] as [number, number];
        })(),
        localNetBytes()
    ]);
    const gpu = parseNvidiaGpu(gpuRes.out, !gpuRes.ok);
    return {
        gpu_name: gpu.name,
        gpu_throttle: gpu.throttleReasons.length > 0,
        throttle_reasons: gpu.throttleReasons,
        vram_used: gpu.vramUsed,
        vram_total: gpu.vramTotal,
        process_vram: parseProcessVram(appsRes.out),
        gpu_pwr: gpu.pwr,
        gpu_temp: gpu.temp,
        gpu_util: gpu.util,
        ram_used: Math.max(Math.trunc(memUsedKb / 1024), 0),
        ram_total: Math.max(Math.trunc(memTotalKb / 1024), 1),
        process_ram: parseProcessRam(psRes.out),
        cpu_name: parseCpuName(cpuinfo),
        cpu_util: parseCpuUtil(cpuStat),
        cpu_temp: parseCpuTemp(tempOut),
        net_bytes: netBytes,
        net_by_interface: {},
        nvidia_smi_error: !gpuRes.ok || gpuRes.out.trim() === ''
    };
}

// --- remote (ssh) collection ---

function offlineBlock(): StatBlock {
    return {
        gpu_name: 'Offline', gpu_throttle: false, throttle_reasons: [],
        vram_used: 0, vram_total: 1, process_vram: 0,
        gpu_pwr: 0, gpu_temp: 0, gpu_util: 0,
        ram_used: 0, ram_total: 1, process_ram: 0,
        cpu_name: 'Offline', cpu_util: 0.0, cpu_temp: 0,
        net_bytes: 0, nvidia_smi_error: true
    };
}

export async function getRemoteStats(sshPrefix: string): Promise<StatBlock> {
    const res = await runCmd(
        ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', sshPrefix, REMOTE_SHELL_CMD],
        3000
    );
    if (!res.ok) return offlineBlock();
    const sections = parseSections(res.out);
    const gpu = parseNvidiaGpu(sections['gpu'] || '', false);
    const [memTotalKb, memUsedKb] = parseMeminfo(sections['MEMINFO'] || '');
    const [netBytes, netByInterface] = parseNetdev(sections['NETDEV'] || '');
    return {
        gpu_name: gpu.name,
        gpu_throttle: gpu.throttleReasons.length > 0,
        throttle_reasons: gpu.throttleReasons,
        vram_used: gpu.vramUsed,
        vram_total: gpu.vramTotal,
        process_vram: parseProcessVram(sections['APPS'] || ''),
        gpu_pwr: gpu.pwr,
        gpu_temp: gpu.temp,
        gpu_util: gpu.util,
        ram_used: Math.max(Math.trunc(memUsedKb / 1024), 0),
        ram_total: Math.max(Math.trunc(memTotalKb / 1024), 1),
        process_ram: parseProcessRam(sections['PS'] || ''),
        cpu_name: parseCpuName(sections['CPUINFO'] || ''),
        cpu_util: parseCpuUtil(sections['CPUSTAT'] || ''),
        cpu_temp: parseCpuTemp(sections['TEMP'] || ''),
        net_bytes: netBytes,
        net_by_interface: netByInterface,
        nvidia_smi_error: (sections['gpu'] || '').trim() === ''
    };
}

// --- AMD local second-GPU collection ---

// Resolve amdgpu_top even when it is not on PATH (systemd user units have a
// minimal PATH). Port of monitor.py find_amdgpu_top.
export function findAmdgpuTop(): string | null {
    const candidates: string[] = (process.env.PATH || '').split(':').filter(Boolean).map(dir => path.join(dir, 'amdgpu_top'));
    candidates.push(
        path.join(os.homedir(), '.local', 'bin', 'amdgpu_top'),
        '/usr/local/bin/amdgpu_top',
        '/usr/bin/amdgpu_top',
        '/bin/amdgpu_top'
    );
    // accessSync signals success by not throwing (it returns void), so the
    // check is exception-based -- a truthiness test would always fail.
    for (const candidate of candidates) {
        try {
            fs.accessSync(candidate, fs.constants.X_OK);
            return candidate;
        } catch { /* keep looking */ }
    }
    return null;
}

// AMD GPU power (W) and temperature (C) straight from sysfs hwmon -- cheap
// file reads, preferred over amdgpu_top's own JSON Sensors fields (null on the
// current card/driver combo). Port of monitor.py read_amdgpu_hwmon.
export async function readAmdgpuHwmon(): Promise<[number | null, number | null]> {
    let entries: string[];
    try {
        entries = (await readdir('/sys/class/hwmon')).filter(name => name.startsWith('hwmon'));
    } catch {
        return [null, null];
    }
    for (const entry of entries) {
        const base = path.join('/sys/class/hwmon', entry);
        const name = (await readText(path.join(base, 'name'))).trim();
        if (name !== 'amdgpu') continue;
        let power: number | null = null;
        const powerRaw = (await readText(path.join(base, 'power1_average'))).trim();
        if (powerRaw !== '') {
            const uw = Number(powerRaw);
            if (Number.isFinite(uw)) power = uw / 1e6; // uW -> W
        }
        const temps: Record<string, number> = {};
        try {
            for (const file of (await readdir(base)).filter(f => /^temp\d+_input$/.test(f))) {
                const label = (await readText(path.join(base, file.replace('_input', '_label')))).trim();
                const raw = (await readText(path.join(base, file))).trim();
                const v = Number(raw);
                if (label && Number.isFinite(v)) temps[label] = v / 1000;
            }
        } catch { /* no temps available */ }
        const temp = temps['junction'] ?? temps['edge'] ?? null;
        return [power, temp]; // first amdgpu hwmon device only -- single-GPU assumption
    }
    return [null, null];
}

export async function getAmdStats(): Promise<StatBlock> {
    let device: Record<string, unknown> | null = null;
    const binary = findAmdgpuTop();
    if (binary) {
        // -n 1 exits on its own in ~0.2s on the current amdgpu_top; the 1s
        // SIGKILL is the safety net for a bad device state (port of the
        // force-kill/salvage path -- partial stdout is still parseable).
        const proc = Bun.spawn([binary, '-J', '-s', '150', '-n', '1'], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' });
        const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* already gone */ } }, 1000);
        try {
            const text = proc.stdout instanceof ReadableStream ? await new Response(proc.stdout).text() : '';
            const obj = parseFirstJson(text);
            const devices = obj?.['devices'];
            if (Array.isArray(devices) && devices.length > 0) device = devices[0] as Record<string, unknown>;
        } catch { /* fall through to the Offline placeholder */ }
        finally {
            clearTimeout(timer);
        }
    }
    if (!device) {
        return {
            gpu_name: 'Offline', gpu_throttle: false, throttle_reasons: [],
            vram_used: 0, vram_total: 1, process_vram: 0,
            gpu_pwr: 0, gpu_temp: 0, gpu_util: 0,
            ram_used: 0, ram_total: 1, process_ram: 0,
            cpu_name: 'Offline', cpu_util: 0.0, cpu_temp: 0,
            net_bytes: 0, amdgpu_top_error: true
        };
    }
    let deviceName: string | null = null; // DeviceName is a string leaf; val() is for numeric leaves
    const info = (device as Record<string, unknown>)['Info'];
    if (typeof info === 'object' && info !== null) {
        const n = (info as Record<string, unknown>)['DeviceName'];
        if (typeof n === 'string') deviceName = n;
    }
    const vramUsed = Math.trunc(val(device, ['VRAM', 'Total VRAM Usage']));
    const vramTotal = Math.max(Math.trunc(val(device, ['VRAM', 'Total VRAM'], 1)), 1);
    const gpuUtil = Math.trunc(val(device, ['gpu_activity', 'GFX']));
    const [hwmonPower, hwmonTemp] = await readAmdgpuHwmon();
    let gpuPwr = hwmonPower;
    if (gpuPwr === null) gpuPwr = val(device, ['Sensors', 'Average Power'], val(device, ['Sensors', 'GFX Power'], 0));
    let gpuTemp = hwmonTemp;
    if (gpuTemp === null) gpuTemp = Math.trunc(val(device, ['Sensors', 'Junction Temperature'], val(device, ['Sensors', 'Edge Temperature'], 0)));
    let processVram = 0;
    const fdinfo = (device as Record<string, unknown>)['fdinfo'];
    if (typeof fdinfo === 'object' && fdinfo !== null) {
        for (const entry of Object.values(fdinfo as Record<string, unknown>)) {
            if (typeof entry !== 'object' || entry === null) continue;
            const e = entry as Record<string, unknown>;
            const name = typeof e['name'] === 'string' ? e['name'] : '';
            if (name.includes('llama') || name.includes('ggml-rpc')) {
                processVram += Math.trunc(val(e, ['usage', 'usage', 'VRAM']));
            }
        }
    }
    const [memTotalKb, memUsedKb] = parseMeminfo(await readText('/proc/meminfo'));
    const cpuStat = await readText('/proc/stat');
    const cpuinfo = await readText('/proc/cpuinfo');
    return {
        gpu_name: deviceName ?? 'Unknown AMD GPU',
        gpu_throttle: false,
        throttle_reasons: [],
        vram_used: vramUsed,
        vram_total: vramTotal,
        process_vram: processVram,
        gpu_pwr: gpuPwr ?? 0,
        gpu_temp: Math.trunc(gpuTemp ?? 0),
        gpu_util: gpuUtil,
        ram_used: Math.max(Math.trunc(memUsedKb / 1024), 0),
        ram_total: Math.max(Math.trunc(memTotalKb / 1024), 1),
        process_ram: 0,
        cpu_name: parseCpuName(cpuinfo),
        cpu_util: parseCpuUtil(cpuStat),
        cpu_temp: 0,
        net_bytes: await localNetBytes(),
        amdgpu_top_error: false
    };
}

// --- entry point ---

// Same worker-slot decision the legacy fetchStats() body made for the
// /stats request: deviceB => local AMD second GPU; rpcTarget => ssh worker
// (same-host targets collect locally); no launch config => AMD second GPU.
export async function collectStats(launch: { deviceB?: string; rpcTarget?: string } | null | undefined): Promise<TelemetryStats> {
    const master = await getLocalStats();
    const stats: { master: StatBlock; worker?: StatBlock } = { master };
    if (launch?.deviceB) {
        const worker = await getAmdStats();
        worker['same_host'] = true;
        stats.worker = worker;
    } else if (launch?.rpcTarget) {
        if (isSameHost(launch.rpcTarget)) {
            const worker = await getLocalStats();
            worker['same_host'] = true;
            stats.worker = worker;
        } else {
            stats.worker = await getRemoteStats(launch.rpcTarget);
        }
    } else if (!launch) {
        const worker = await getAmdStats();
        worker['same_host'] = true;
        stats.worker = worker;
    }
    return stats as unknown as TelemetryStats;
}
