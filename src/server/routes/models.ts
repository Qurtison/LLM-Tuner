// Read-only info routes: model scan, public config, configured builds,
// server paths.
import { scanModels } from '../services/models';
import { publicConfig } from '../config';
import type { RouteCtx } from './context';

export async function handle(ctx: RouteCtx, req: Request, url: URL): Promise<Response | null> {
    const route = url.pathname;

    if (route === '/api/models') {
        const models = await scanModels(ctx.config.paths.modelDirectories, ctx.config.paths.huggingFaceCache);
        return ctx.json(models);
    }

    // PUBLIC CONFIG (safe UI defaults + feature flags; no paths, no
    // commands -- see publicConfig)
    if (route === '/api/config') {
        return ctx.json(publicConfig(ctx.config));
    }

    // LIST CONFIGURED BUILDS (shape includes paths)
    if (route === '/api/builds') {
        return ctx.json({ builds: ctx.config.llama.builds });
    }

    // SERVER PATHS (gap G7; read-only, path info the UI needs)
    if (route === '/api/server-paths') {
        const builds = ctx.config.llama.builds;
        return ctx.json({
            modelsDir: ctx.config.paths.modelDirectories[0] || '',
            logsDir: ctx.config.paths.logsDirectory,
            repoDir: ctx.config.upgrade.repoDir || null,
            buildDirs: builds.map(b => b.path),
            activeBuildDir: (await ctx.presets.getActive())?.build || builds[0]?.id || null,
        });
    }

    return null;
}
