/*
 * Shared launch form: model + build + GPU A/B + RPC + raw command
 * + Preview/Start/Stop. Several surfaces (the LaunchBar strip card, the
 * RPC Worker panel, etc.) pull pieces off this so they can compose into
 * one Start request.
 * Launch requests are built on top of the PresetDock draft (unsaved
 * edits included); form fields override the draft per request.
 *
 * The form lives in ONE module-level store: LaunchBar and RpcWorkerPanel
 * used to hold independent useState copies, so RPC settings chosen in the
 * panel never reached Start and Start clobbered preset devices.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { api } from '../api/client';
import { useServer } from '../state/server';
import { usePresets } from '../hooks/usePresets';
import { useDevices } from '../hooks/useDevices';
import { Value } from '../state/value';
import { fieldClass } from './Field';
import { buildLaunchRequest, effectiveRouterEnabled, effectiveRouterIniText, type LaunchForm } from '../lib/launchRequest';
import type { BuildEntry, IniWarning, LaunchConfig, ModelEntry, PreviewCommandResponse } from '../../../shared/contracts';
import { validateRouterIni } from '../../../shared/router-ini';
// Kept for importers that already pull the type from here.
export type { LaunchForm } from '../lib/launchRequest';

const baseForm: LaunchForm = {
    modelPath: '', build: '', deviceA: '', deviceB: '', rpcTarget: '', workerSsh: '', transport: 'WiFi', rawCommand: '',
    routerEnabled: false, routerMax: '', routerAutoload: true, routerStartup: {}, routerIniText: '',
};

// Shared across panels; exported so non-panel pickers (HF search) can write
// into the same form the LaunchBar Start button reads.
export const launchFormStore = new Value<LaunchForm>(baseForm);

// Set once the form has been seeded from the running launch (a page refresh
// lands on a server that is already up). After that, user edits win.
let seededFromRunningLaunch = false;

export function useLaunchForm(): {
    form: LaunchForm;
    set: <K extends keyof LaunchForm>(k: K, v: LaunchForm[K]) => void;
    models: ModelEntry[];
    builds: BuildEntry[];
    devices: { id: string; description: string }[];
    devicesError: string;
    request: () => LaunchConfig;
    // Effective router toggle (form OR preset) — what the next launch will do.
    routerOn: boolean;
    preview: string;
    // Router mode only: the generated model preset the launch writes to disk.
    ini: string;
    iniWarnings: IniWarning[];
    previewBusy: boolean;
    actionError: string;
    setActionError: (s: string) => void;
    start: () => Promise<void>;
    stop: () => Promise<void>;
    previewCommand: () => Promise<void>;
} {
    const { config, state } = useServer();
    const { draft } = usePresets();
    const form = useSyncExternalStore(launchFormStore.subscribe, launchFormStore.get, launchFormStore.get);
    const [models, setModels] = useState<ModelEntry[]>([]);
    const [builds, setBuilds] = useState<BuildEntry[]>([]);
    const { devices, error: devicesError } = useDevices(form.build || '');
    const [actionError, setActionError] = useState('');
    const [preview, setPreview] = useState('');
    const [previewBusy, setPreviewBusy] = useState(false);

    useEffect(() => {
        let dead = false;
        (async () => {
            try {
                const [ms, bs] = await Promise.all([api<ModelEntry[]>('/api/models'), api<{ builds: BuildEntry[] }>('/api/builds')]);
                if (dead) return;
                setModels(ms);
                setBuilds(bs.builds || []);
                launchFormStore.update(old => {
                    const next: LaunchForm = { ...old };
                    if (!next.build) next.build = bs.builds[0]?.id || '';
                    // modelPath intentionally NOT defaulted here: the active
                    // preset owns the model (edited via the dock's dropdown);
                    // request() falls back to presetBase.modelPath.
                    if (config?.launch.build) next.build = config.launch.build;
                    if (config?.launch.deviceA) next.deviceA = config.launch.deviceA;
                    if (config?.launch.deviceB) next.deviceB = config.launch.deviceB;
                    return next;
                });
            } catch (err) {
                if (!dead) setActionError(err instanceof Error ? err.message : 'Could not load launch choices.');
            }
        })();
        return () => { dead = true; };
    }, [config]);

    // The running launch config arrives in the first /api/status frame after
    // a refresh; the router switch (and its fields) are launch-level, so the
    // form must reflect them or the bar claims single-model on a router launch.
    useEffect(() => {
        if (seededFromRunningLaunch) return;
        const rc = state?.launchConfig?.router;
        if (!state || state.state === 'stopped' || rc?.enabled !== true) return;
        seededFromRunningLaunch = true;
        launchFormStore.update(old => ({
            ...old,
            routerEnabled: true,
            routerMax: old.routerMax || (rc.maxModels !== undefined ? String(rc.maxModels) : ''),
            routerAutoload: rc.autoload === false ? false : old.routerAutoload,
            routerStartup: rc.models
                ? { ...Object.fromEntries(rc.models.filter(m => m.loadOnStartup).map(m => [m.modelPath, true])), ...old.routerStartup }
                : old.routerStartup,
            routerIniText: old.routerIniText || rc.iniText || '',
        }));
    }, [state]);

    const set = <K extends keyof LaunchForm>(k: K, v: LaunchForm[K]) => launchFormStore.update(old => ({ ...old, [k]: v }));

    const presetBase: LaunchConfig = useMemo(() => draft ?? {}, [draft]);
    // Precedence (form beats preset, router merge) lives in the pure builder;
    // see src/client/lib/launchRequest.ts and tests/launch-request.test.ts.
    const request = () => buildLaunchRequest(form, presetBase);
    const routerOn = effectiveRouterEnabled(form, presetBase);
    // Live check of the hand-written preset. The registry is shared with the
    // server, so this matches what the router will actually accept.
    const routerIniText = effectiveRouterIniText(form, presetBase);
    const iniWarnings = useMemo(() => (routerIniText ? validateRouterIni(routerIniText) : []), [routerIniText]);

    // Router mode: what the launch actually applies lives in the generated INI,
    // so the preview has to show it too or the command looks like it lost every
    // per-model setting.
    const [ini, setIni] = useState('');
    async function previewCommand() {
        setPreviewBusy(true); setActionError('');
        try {
            const data = await api<PreviewCommandResponse>('/api/preview-command', { method: 'POST', body: JSON.stringify(request()) });
            if (data.error) throw new Error(data.error);
            // Preview is read-only: it must NOT write form.rawCommand —
            // a non-empty rawCommand makes the server launch the literal
            // string and silently ignore every structured field (preset
            // diffs, paramOverrides) edited after the preview.
            setPreview(data.command);
            setIni(data.ini || '');
        } catch (err) {
            setActionError(err instanceof Error ? err.message : 'Command preview failed.');
        } finally { setPreviewBusy(false); }
    }
    async function start() {
        setActionError('');
        try { await api('/api/start', { method: 'POST', body: JSON.stringify(request()) }); }
        catch (err) { setActionError(err instanceof Error ? err.message : 'Start failed.'); }
    }
    async function stop() {
        setActionError('');
        try { await api('/api/stop', { method: 'POST', body: '{}' }); }
        catch (err) { setActionError(err instanceof Error ? err.message : 'Stop failed.'); }
    }

    return { form, set, models, builds, devices, devicesError, request, routerOn, preview, ini, iniWarnings, previewBusy, actionError, setActionError, start, stop, previewCommand };
}

export { fieldClass };
