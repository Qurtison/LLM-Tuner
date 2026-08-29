type Stats = Record<string, unknown>;

const BAD_GPU_NAMES = new Set(['', 'Unknown', 'Offline', 'Unknown AMD GPU']);

export function toNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function stat(stats: Stats | null, key: string): number | null {
    return stats ? toNumber(stats[key]) : null;
}

export function gpuLabel(stats: Stats | null, fallback: string): string {
    const name = stats && typeof stats.gpu_name === 'string' ? stats.gpu_name.trim() : '';
    return BAD_GPU_NAMES.has(name) ? fallback : name;
}


export function vramParts(stats: Stats | null): { used: number | null; free: number | null; total: number | null } {
    const used = stat(stats, 'vram_used');
    const free = stat(stats, 'vram_free');
    const total = stat(stats, 'vram_total') ?? (used !== null && free !== null ? used + free : null);
    return { used, free, total };
}
