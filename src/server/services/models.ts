import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ModelEntry } from '../../../shared/contracts';

async function scanDirForGgufs(dir: string, source: ModelEntry['source']): Promise<ModelEntry[]> {
    let files: ModelEntry[] = [];
    try {
        const items = await fs.readdir(dir, { withFileTypes: true });
        for (const item of items) {
            const fullPath = path.join(dir, item.name);
            if (item.isDirectory()) files = files.concat(await scanDirForGgufs(fullPath, source));
            else if (item.name.endsWith('.gguf')) {
                const stats = await fs.stat(fullPath);
                files.push({ name: item.name, path: fullPath, size: (stats.size / (1024 * 1024 * 1024)).toFixed(2), source });
            }
        }
    } catch { /* skip inaccessible dirs */ }
    return files;
}

export async function scanModels(modelDirectories: string[], hfCacheDir: string): Promise<ModelEntry[]> {
    let models: ModelEntry[] = [];
    for (const dir of modelDirectories) {
        try {
            const items = await fs.readdir(dir, { withFileTypes: true });
            for (const item of items) {
                if (item.isDirectory()) {
                    models.push(...(await scanDirForGgufs(path.join(dir, item.name), 'local')));
                    continue;
                }
                if (!item.name.endsWith('.gguf')) continue;
                const fullPath = path.join(dir, item.name);
                const stats = await fs.stat(fullPath);
                models.push({ name: item.name, path: fullPath, size: (stats.size / (1024 * 1024 * 1024)).toFixed(2), source: 'local' });
            }
        } catch { /* skip inaccessible dirs */ }
    }
    models = models.concat(await scanDirForGgufs(hfCacheDir, 'huggingface'));
    return models.filter((model, index, all) => all.findIndex(other => other.path === model.path) === index);
}
