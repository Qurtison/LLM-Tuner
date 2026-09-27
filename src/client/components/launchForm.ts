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
import type { BuildEntry, IniWarning, LaunchConfig, ModelEntry, PreviewCommandResponse } from '../../../shared/contracts';
import { validateRouterIni } from '../../../shared/router-ini';

export interface LaunchForm {
    modelPath: string;
    build: string;
    deviceA: string;
    deviceB: string;
    rpcTarget: string;
    workerSsh: string;
    transport: string;
    rawCommand: string;
    // Router mode (llama-server with --models-dir, no -m). The per-model knobs
    // still come from the preset; these only describe the router itself.
    routerEnabled: boolean;
    // Blank = leave llama-server's default (4) alone.
    routerMax: string;
    routerAutoload: boolean;
    // Model path -> load at router startup. Models are discovered from the
    // models dir either way; this only picks which one is already resident.
    routerStartup: Record<string, boolean>;
    // A hand-written preset INI, edited in the LaunchBar. Empty = generate one
    // from the preset; non-empty = this text is used verbatim.
    routerIniText: string;
}

const baseForm: LaunchForm = {
    modelPath: '', build: '', deviceA: '', deviceB: '', rpcTarget: '', workerSsh: '', transport: 'WiFi', rawCommand: '',
    routerEnabled: false, routerMax: '', routerAutoload: true, routerStartup: {}, routerIniText: '',
};

// Shared across panels; exported so non-panel pickers (HF search) can write
// into the same form the LaunchBar Start button reads.
export const launchFormStore = new Value<LaunchForm>(baseForm);

export function useLaunchForm(): {
    form: LaunchForm;
    set: <K extends keyof LaunchForm>(k: K, v: LaunchForm[K]) => void;
    models: ModelEntry[];
    builds: BuildEntry[];
    devices: { id: string; description: string }[];
    devicesError: string;
    request: () => LaunchConfig;
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
    const { state, config } = useServer();
    const { draft } = usePresets();
    const form = useSyncExternalStore(launchFormStore.subscribe, launchFormStore.get, launchFormStore.get);
    const [models, setModels] = useState<ModelEntry[]>([]);
    const [builds, setBuilds] = useState<BuildEntry[]>([]);
    const { devices, error: devicesError } = useDevices(form.build || '');
    const [actionError, setActionError] = useState('');
    const [preview, setPreview] = useState('');
    const [previewBusy, setPreviewBusy] = useState(false);
    const locked = state?.state !== undefined && state.state !== 'stopped';

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

    const set = <K extends keyof LaunchForm>(k: K, v: LaunchForm[K]) => launchFormStore.update(old => ({ ...old, [k]: v }));

    const presetBase: LaunchConfig = useMemo(() => draft ?? {}, [draft]);
    // Router mode is a launch-level switch, but the preset may also carry one
    // (a preset saved with router settings should not need the toggle re-set).
    // The form wins when it disagrees; per-model knobs always come from the
    // preset, since that is where ctx/ngl/cache/sampling live.
    const routerEnabled = form.routerEnabled || presetBase.router?.enabled === true;
    const routerMax = form.routerMax || (presetBase.router?.maxModels !== undefined ? String(presetBase.router.maxModels) : '');
    const routerIniText = form.routerIniText || presetBase.router?.iniText || '';
    // Live check of the hand-written preset. The registry is shared with the
    // server, so this matches what the router will actually accept.
    const iniWarnings = useMemo(() => (routerIniText ? validateRouterIni(routerIniText) : []), [routerIniText]);
    const request = (): LaunchConfig => ({
        ...presetBase,
        modelPath: form.modelPath || presetBase.modelPath,
        build: form.build || presetBase.build || '',
        // Untouched form fields fall back to the preset instead of wiping it.
        deviceA: form.deviceA || presetBase.deviceA || '',
        deviceB: form.deviceB || presetBase.deviceB || '',
        devices: [form.deviceA || presetBase.deviceA, form.deviceB || presetBase.deviceB].filter(Boolean).join(','),
        rpcTarget: form.rpcTarget ? (form.workerSsh || presetBase.rpcTarget || '') : '',
        transport: form.transport,
        rawCommand: form.rawCommand || presetBase.rawCommand || '',
        router: routerEnabled ? {
            ...(presetBase.router || { enabled: true }),
            enabled: true,
            ...(routerMax.trim() ? { maxModels: Number(routerMax) } : {}),
            autoload: form.routerAutoload,
            models: Object.entries(form.routerStartup)
                .filter(([, on]) => on)
                .map(([modelPath]) => ({ modelPath, loadOnStartup: true })),
            // A hand-written preset is the source of truth when present: the
            // server uses it verbatim instead of generating one.
            ...(routerIniText ? { iniText: routerIniText } : {}),
        } : (presetBase.router ? { ...presetBase.router, enabled: false } : undefined),
    });

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

    return { form, set, models, builds, devices, devicesError, request, preview, ini, iniWarnings, previewBusy, actionError, setActionError, start, stop, previewCommand };
}

export { fieldClass };
