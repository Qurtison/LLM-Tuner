import fs = require('node:fs/promises');
import path = require('node:path');
import type { ModelEntry } from '../../../shared/contracts';

async function scanDirForGgufs(dir: string): Promise<ModelEntry[]> {
    let files: ModelEntry[] = [];
    try {
        const items = await fs.readdir(dir, { withFileTypes: true });
        for (const item of items) {
            const fullPath = path.join(dir, item.name);
            if (item.isDirectory()) files = files.concat(await scanDirForGgufs(fullPath));
            else if (item.name.endsWith('.gguf')) {
                const stats = await fs.stat(fullPath);
                files.push({ name: item.name, path: fullPath, size: (stats.size / (1024 * 1024 * 1024)).toFixed(2), source: 'huggingface' });
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
                if (!item.isFile() || !item.name.endsWith('.gguf')) continue;
                const fullPath = path.join(dir, item.name);
                const stats = await fs.stat(fullPath);
                models.push({ name: item.name, path: fullPath, size: (stats.size / (1024 * 1024 * 1024)).toFixed(2), source: 'local' });
            }
        } catch { /* skip inaccessible dirs */ }
    }
    models = models.concat(await scanDirForGgufs(hfCacheDir));
    return models.filter((model, index, all) => all.findIndex(other => other.path === model.path) === index);
}
