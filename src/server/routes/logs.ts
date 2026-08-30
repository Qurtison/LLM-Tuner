// BENCHMARK LOG + read models: manual row append, CSV download, per-request
// sample rings, recent rows, summary aggregation.
import path from 'node:path';
import fs from 'node:fs/promises';
import { appendBenchmarkRow, CSV_COL } from '../services/csvlog';
import * as csv from '../lib/csv';
import { jsonBodyOr400, type RouteCtx } from './context';

export async function handle(ctx: RouteCtx, req: Request, url: URL): Promise<Response | null> {
    const route = url.pathname;
    const method = req.method;

    // BENCHMARK LOG (manual/external logging)
    if (route === '/api/log' && method === 'POST') {
        const body = await jsonBodyOr400(ctx, req);
        const runId = await appendBenchmarkRow(ctx.config.paths.logsDirectory, body);
        return ctx.json({ success: true, run_id: runId });
    }

    // CSV DOWNLOAD
    if (route === '/api/logs/csv' && method === 'GET') {
        try {
            const csvText = await fs.readFile(path.join(ctx.config.paths.logsDirectory, 'benchmarks.csv'), 'utf-8');
            return ctx.json(csvText, 200, { 'Content-Type': 'text/csv' });
        } catch {
            return new Response(null, { status: 404 });
        }
    }

    // PER-REQUEST OMNI GRAPH SAMPLES (in-memory ring, capped at 30)
    if (route.startsWith('/api/logs/samples') && method === 'GET') {
        const runId = url.searchParams.get('runId') || '';
        return ctx.json({ samples: ctx.telemetry.recentSamples(runId) });
    }

    // IN-PROGRESS REQUEST SAMPLES (read-only peek, NOT a drain)
    if (route === '/api/logs/active-samples' && method === 'GET') {
        return ctx.json({ samples: ctx.telemetry.liveSamples() });
    }

    // RECENT COMPLETED REQUESTS (structured CSV backfill)
    if (route.startsWith('/api/logs/recent') && method === 'GET') {
        try {
            const limit = Math.max(1, Math.min(parseInt(url.searchParams.get('limit') || '', 10) || 50, 500));
            const csvText = await fs.readFile(path.join(ctx.config.paths.logsDirectory, 'benchmarks.csv'), 'utf-8');
            const lines = csvText.trim().split('\n').slice(1).filter(l => l.trim());
            const recentLines = lines.slice(-limit);
            const rows: unknown[] = [];
            for (const line of recentLines) {
                const cols = csv.splitCsvLine(line);
                if (cols.length < 32) continue; // only schema v3+ rows have model_name/transport at known offsets
                rows.push({
                    timestamp: cols[CSV_COL.timestamp],
                    runId: cols[CSV_COL.runId],
                    model: cols[CSV_COL.model],
                    transport: cols[CSV_COL.transport],
                    promptTps: csv.parseNumOrNull(cols[CSV_COL.promptTps]),
                    genTps: csv.parseNumOrNull(cols[CSV_COL.genTps]),
                    promptTokens: csv.parseNumOrNull(cols[CSV_COL.promptTokens]),
                    genTokens: csv.parseNumOrNull(cols[CSV_COL.genTokens]),
                    wallTime: csv.parseNumOrNull(cols[CSV_COL.wallTime]),
                    draftAcceptRate: cols.length > CSV_COL.draftAcceptRate ? csv.parseNumOrNull(cols[CSV_COL.draftAcceptRate]) : null,
                    draftAccepted: cols.length > CSV_COL.draftAccepted ? csv.parseNumOrNull(cols[CSV_COL.draftAccepted]) : null,
                    draftGenerated: cols.length > CSV_COL.draftGenerated ? csv.parseNumOrNull(cols[CSV_COL.draftGenerated]) : null,
                    draftMeanLen: cols.length > CSV_COL.draftMeanLen ? csv.parseNumOrNull(cols[CSV_COL.draftMeanLen]) : null,
                    aborted: cols.length > CSV_COL.aborted ? cols[CSV_COL.aborted] === '1' : false,
                });
            }
            return ctx.json({ rows });
        } catch {
            return ctx.json({ rows: [] });
        }
    }

    // LOGS SUMMARY (schema v2/v3/old auto-detection)
    if (route.startsWith('/api/logs/summary') && method === 'GET') {
        try {
            const filterModel = url.searchParams.get('model') || '';
            const filterTransport = url.searchParams.get('transport') || '';
            const csvText = await fs.readFile(path.join(ctx.config.paths.logsDirectory, 'benchmarks.csv'), 'utf-8');
            const lines = csvText.trim().split('\n').slice(1);
            if (lines.length === 0) return ctx.json({ count: 0 });
            // Column maps (0-indexed) by schema: v3+ = 32 cols with
            // launch_command; v2 = 31 cols without; old = 30 cols.
            let n = 0, sumPromptTps = 0, sumGenTps = 0, sumPromptLat = 0, sumWallTime = 0, sumLoadTime = 0;
            let bestPromptTps = 0, bestGenTps = 0, bestPromptLat = Infinity, bestWallTime = Infinity, bestLoadTime = Infinity;
            let lastModel: string | null = null, lastTimestamp: string | null = null, lastPromptTps: number | null = null, lastGenTps: number | null = null, lastLoadTime: number | null = null, lastConfig: unknown = null;
            for (const line of lines) {
                if (!line.trim()) continue;
                const cols = csv.splitCsvLine(line);
                if (cols.length < 25) continue;
                if (cols.length >= 32) {
                    const rowModel = cols[CSV_COL.model];
                    const rowTransport = cols[CSV_COL.transport];
                    if (filterModel && rowModel !== filterModel) continue;
                    if (filterTransport && rowTransport !== filterTransport) continue;
                    lastModel = rowModel;
                    lastTimestamp = cols[0];
                    lastConfig = null;
                    if (cols.length >= 33 && cols[32]) {
                        try { lastConfig = JSON.parse(cols[32]); } catch { /* older/malformed row -- skip */ }
                    }
                } else if (filterModel || filterTransport) {
                    continue;
                }
                // Older schemas shift everything after arg_string: v2 (no
                // launch_command) by 1, old (no launch_command/config_json) by 2.
                const shift = cols.length >= 32 ? 0 : cols.length >= 31 ? 1 : 2;
                const pTps = parseFloat(cols[CSV_COL.promptTps - shift]);
                const gTps = parseFloat(cols[CSV_COL.genTps - shift]);
                const pLat = parseFloat(cols[CSV_COL.promptLatency - shift]);
                const wTime = parseFloat(cols[CSV_COL.wallTime - shift]);
                const lTime = parseFloat(cols[CSV_COL.loadTime - shift]);
                lastPromptTps = Number.isFinite(pTps) ? pTps : null;
                lastGenTps = Number.isFinite(gTps) ? gTps : null;
                lastLoadTime = Number.isFinite(lTime) ? lTime : null;
                if (Number.isFinite(pTps)) { sumPromptTps += pTps; if (pTps > bestPromptTps) bestPromptTps = pTps; }
                if (Number.isFinite(gTps)) { sumGenTps += gTps; if (gTps > bestGenTps) bestGenTps = gTps; }
                if (Number.isFinite(pLat)) { sumPromptLat += pLat; if (pLat < bestPromptLat) bestPromptLat = pLat; }
                if (Number.isFinite(wTime)) { sumWallTime += wTime; if (wTime < bestWallTime) bestWallTime = wTime; }
                if (Number.isFinite(lTime)) { sumLoadTime += lTime; if (lTime < bestLoadTime) bestLoadTime = lTime; }
                n++;
            }
            const avg = (v: number, c: number) => c > 0 ? Math.round((v / c) * 10) / 10 : 0;
            const round1 = (v: number | null) => Number.isFinite(v as number) ? Math.round((v as number) * 10) / 10 : 0;
            if (n === 0) return ctx.json({ count: 0, filtered: !!(filterModel || filterTransport) });
            return ctx.json({
                count: n,
                lastModel,
                lastConfig,
                lastTimestamp,
                lastPromptTps: round1(lastPromptTps),
                lastGenTps: round1(lastGenTps),
                lastLoadTime: round1(lastLoadTime),
                filtered: !!(filterModel || filterTransport),
                avgPromptTps: avg(sumPromptTps, n),
                avgGenTps: avg(sumGenTps, n),
                avgPromptLatency: avg(sumPromptLat, n),
                avgWallTime: avg(sumWallTime, n),
                avgLoadTime: avg(sumLoadTime, n),
                bestPromptTps: round1(bestPromptTps),
                bestGenTps: round1(bestGenTps),
                bestPromptLatency: isFinite(bestPromptLat) ? round1(bestPromptLat) : 0,
                bestWallTime: isFinite(bestWallTime) ? round1(bestWallTime) : 0,
                bestLoadTime: isFinite(bestLoadTime) ? round1(bestLoadTime) : 0,
            });
        } catch {
            return ctx.json({ count: 0 });
        }
    }

    return null;
}
