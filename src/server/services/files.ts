// Model file tree browsing + deletion (gap G5, docs/gap-analysis.md).
// Mirrors the old dashboard /api/files + /api/files/delete with the same
// path-guard: a requested path must resolve inside modelsDir.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { FilesEntry, FilesResponse } from '../../../shared/contracts';

export function resolveInside(root: string, requested: string): string {
    const rootResolved = path.resolve(root);
    const target = path.resolve(rootResolved, requested || '');
    const rel = path.relative(rootResolved, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error('path must stay inside the models directory');
    }
    return target;
}

export async function listFiles(modelsDir: string, requestedPath: string): Promise<FilesResponse> {
    const root = path.resolve(modelsDir);
    const target = resolveInside(root, requestedPath);
    let stat;
    try {
        stat = await fs.stat(target);
    } catch {
        throw new Error('requested path is not a directory');
    }
    if (!stat.isDirectory()) throw new Error('requested path is not a directory');
    const entries: FilesEntry[] = [];
    try {
        const items = await fs.readdir(target, { withFileTypes: true });
        for (const item of items) {
            const entry: FilesEntry = {
                name: item.name,
                path: path.relative(root, path.join(target, item.name)).split(path.sep).join('/'),
                isDir: item.isDirectory(),
                size: null,
            };
            if (!entry.isDir) {
                try { entry.size = (await fs.stat(path.join(target, item.name))).size; } catch { entry.size = null; }
            }
            entries.push(entry);
        }
    } catch { /* unreadable dir -> empty list */ }
    entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    return { root, path: path.relative(root, target).split(path.sep).join('/'), entries };
}

export async function deleteFile(modelsDir: string, requestedPath: string): Promise<void> {
    const root = path.resolve(modelsDir);
    const target = resolveInside(root, requestedPath);
    if (target === root) throw new Error('refusing to delete the models directory itself');
    const stat = await fs.stat(target).catch(() => null);
    if (!stat) throw new Error('file not found');
    if (stat.isDirectory()) throw new Error('only files can be deleted');
    await fs.unlink(target);
}
