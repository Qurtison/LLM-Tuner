// APPLY (regenerate launch script from active preset, install unit,
// optionally restart; native mode launches through the dashboard child).
import path from 'node:path';
import fs from 'node:fs/promises';
import { formatCommand } from '../services/llama';
import { validatePreset } from '../services/presets';
import * as unitMod from '../services/unit';
import * as launch from '../lib/launch';
import { parseJsonBody, type RouteCtx } from './context';

export async function handle(ctx: RouteCtx, req: Request, url: URL): Promise<Response | null> {
    const route = url.pathname;
    const method = req.method;

    if (route === '/api/apply' && method === 'POST') {
        const active = await ctx.presets.getActive();
        if (!active) return ctx.json({ ok: false, error: 'no active preset', warnings: [] });
        const body = await parseJsonBody(ctx, req).catch(() => ({} as Record<string, unknown>));
        const restart = (body as Record<string, unknown>)?.restart === true;
        try {
            const resolved = launch.resolveLaunchCommand(active.config, ctx.config.llama.builds, {
                rpcPort: ctx.config.llama.rpcPort,
                defaultPort: ctx.config.llama.defaultPort,
            });
            const command = formatCommand(resolved.command, resolved.args);
            const warnings = await validatePreset(active, ctx.config.paths.modelDirectories);
            let restartOk: boolean | undefined;
            let restartOutput: string | undefined;
            if (ctx.config.service.manageViaSystemd && ctx.config.service.unitName) {
                // Shared helper keeps script + unit paths distinct (the old
                // unitPath fallback made both the same and installUnit
                // overwrote the freshly written script with the unit file).
                const scriptPath = unitMod.scriptPathFor(ctx.config.service, ctx.appRoot);
                await fs.mkdir(path.dirname(scriptPath), { recursive: true });
                const script = '#!/usr/bin/env bash\nset -euo pipefail\nexec ' + command + '\n';
                await fs.writeFile(scriptPath, script);
                await fs.chmod(scriptPath, 0o755);
                const unitPath = unitMod.unitFilePathFor(ctx.config.service);
                // In systemd mode the unit must be enabled so the model
                // survives reboots (A+D); enableOnApply is ignored there.
                const installed = await unitMod.installUnit(unitPath, scriptPath, ctx.config.service.unitName, true);
                if (!installed.ok) return ctx.json({ ok: false, error: installed.output, command, warnings });
                if (restart) {
                    const r = await unitMod.restart(ctx.config.service.unitName);
                    restartOk = r.ok; restartOutput = r.output;
                }
            } else {
                // Native mode: apply launches the active preset through the
                // dashboard-managed child (same path as /api/start).
                if (ctx.llama.running) {
                    return ctx.json({ ok: false, error: 'a model server is already running (stop it first)', command, warnings });
                }
                try {
                    ctx.llama.launch(active.config);
                } catch (err) {
                    return ctx.json({ ok: false, error: err instanceof Error ? err.message : String(err), command, warnings });
                }
            }
            return ctx.json({ ok: true, command, warnings, restartOk, restartOutput });
        } catch (err) {
            return ctx.json({ ok: false, error: err instanceof Error ? err.message : String(err), warnings: [] });
        }
    }

    return null;
}
