// PRESETS (gap G1).
import { validatePreset, type Preset } from '../services/presets';
import { jsonBodyOr400, type RouteCtx } from './context';

export async function handle(ctx: RouteCtx, req: Request, url: URL): Promise<Response | null> {
    const route = url.pathname;
    const method = req.method;

    if (route === '/api/presets' && method === 'GET') {
        const presets = await ctx.presets.list();
        const active = await ctx.presets.getActiveName();
        return ctx.json({ presets, active });
    }
    if (route === '/api/presets' && method === 'POST') {
        const body = await jsonBodyOr400(ctx, req);
        const name = typeof body.name === 'string' ? body.name : '';
        if (!name) return ctx.json({ error: 'preset needs a name' }, 400);
        const existing = await ctx.presets.get(name);
        const preset = {
            name,
            build: typeof body.build === 'string' && body.build ? body.build : (existing?.build || ctx.config.launch.build || ''),
            label: typeof body.label === 'string' ? body.label : undefined,
            config: (body.config && typeof body.config === 'object' ? body.config : existing?.config || {}),
        } as Preset;
        try {
            await ctx.presets.save(preset);
        } catch (err) {
            return ctx.json({ error: err instanceof Error ? err.message : String(err) }, 400);
        }
        const warnings = await validatePreset(preset, ctx.config.paths.modelDirectories);
        return ctx.json({ ok: true, warnings });
    }
    const presetMatch = route.match(/^\/api\/presets\/([^/]+)$/);
    if (presetMatch && method === 'DELETE') {
        const name = decodeURIComponent(presetMatch[1]);
        const ok = await ctx.presets.delete(name);
        return ctx.json({ ok });
    }
    if (presetMatch && method === 'GET') {
        const name = decodeURIComponent(presetMatch[1]);
        const preset = await ctx.presets.get(name);
        if (!preset) return ctx.json({ error: 'not found' }, 404);
        return ctx.json(preset);
    }
    const activateMatch = route.match(/^\/api\/presets\/([^/]+)\/activate$/);
    if (activateMatch && method === 'POST') {
        const name = decodeURIComponent(activateMatch[1]);
        const preset = await ctx.presets.get(name);
        if (!preset) return ctx.json({ error: 'not found' }, 404);
        await ctx.presets.setActiveName(name);
        return ctx.json({ ok: true, active: name });
    }
    if (route === '/api/presets/validate' && method === 'POST') {
        const body = await jsonBodyOr400(ctx, req);
        const warnings = await validatePreset({ name: String(body.name || 'x'), build: String(body.build || ''), config: (body.config as never) || {} } as Preset, ctx.config.paths.modelDirectories);
        return ctx.json({ warnings });
    }

    return null;
}
