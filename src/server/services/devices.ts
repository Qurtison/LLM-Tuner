import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseHelpFlags } from '../lib/helpparse';

const execFileAsync = promisify(execFile);
const cachedFlagReferenceByBinary = new Map<string, unknown[]>();

export async function flagReference(binaryPath: string, helpTimeoutMs = 8000): Promise<{ flags: unknown[]; error?: string }> {
    if (cachedFlagReferenceByBinary.has(binaryPath)) return { flags: cachedFlagReferenceByBinary.get(binaryPath)! };
    try {
        const { stdout } = await execFileAsync(binaryPath, ['--help'], { timeout: helpTimeoutMs, maxBuffer: 1024 * 1024 });
        const flags = parseHelpFlags(stdout);
        cachedFlagReferenceByBinary.set(binaryPath, flags);
        return { flags };
    } catch (error) {
        return { flags: [], error: (error as Error).message };
    }
}

export async function listDevices(binaryPath: string): Promise<{ devices: { id: string; description: string; totalMib: number; freeMib: number }[]; error?: string }> {
    try {
        const { stdout } = await execFileAsync(binaryPath, ['--list-devices'], { timeout: 8000, maxBuffer: 1024 * 1024 });
        const devices: { id: string; description: string; totalMib: number; freeMib: number }[] = [];
        const lineRe = /^(\S+):\s*(.+?)\s*\((\d+) MiB, (\d+) MiB free\)$/;
        for (const rawLine of stdout.split('\n')) {
            const match = rawLine.trim().match(lineRe);
            if (match) devices.push({ id: match[1], description: match[2], totalMib: parseInt(match[3], 10), freeMib: parseInt(match[4], 10) });
        }
        return { devices };
    } catch (error) {
        const childError = error as { killed?: boolean; signal?: string; message?: string };
        return { devices: [], error: childError.killed || childError.signal ? 'timed out' : (childError.message || 'failed') };
    }
}
