/*
 * Shared launch form: model + build + GPU A/B + RPC + raw command
 * + Preview/Start/Stop. Multiple panels (LaunchBar, RPC Worker, etc.)
 * pull pieces off this so they can compose into one Start request.
 * Launch requests are built on top of the PresetDock draft (unsaved
 * edits included); form fields override the draft per request.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { useServer } from '../state/server';
import { usePresets } from '../hooks/usePresets';
import { useDevices } from '../hooks/useDevices';
import { fieldClass } from './Field';
import type { BuildEntry, LaunchConfig, ModelEntry, PreviewCommandResponse } from '../../../shared/contracts';

export interface LaunchForm {
    modelPath: string;
    build: string;
    deviceA: string;
    deviceB: string;
    rpcTarget: string;
    workerSsh: string;
    transport: string;
    rawCommand: string;
}

const baseForm: LaunchForm = { modelPath: '', build: '', deviceA: '', deviceB: '', rpcTarget: '', workerSsh: '', transport: 'WiFi', rawCommand: '' };

export function useLaunchForm(): {
    form: LaunchForm;
    set: <K extends keyof LaunchForm>(k: K, v: LaunchForm[K]) => void;
    models: ModelEntry[];
    builds: BuildEntry[];
    devices: { id: string; description: string }[];
    devicesError: string;
    request: () => LaunchConfig;
    preview: string;
    previewBusy: boolean;
    actionError: string;
    setActionError: (s: string) => void;
    start: () => Promise<void>;
    stop: () => Promise<void>;
    previewCommand: () => Promise<void>;
} {
    const { state, config } = useServer();
    const { draft } = usePresets();
    const [form, setForm] = useState<LaunchForm>(baseForm);
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
                setForm(old => {
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

    const set = <K extends keyof LaunchForm>(k: K, v: LaunchForm[K]) => setForm(old => ({ ...old, [k]: v }));

    const presetBase: LaunchConfig = useMemo(() => draft ?? {}, [draft]);
    const request = (): LaunchConfig => ({
        ...presetBase,
        modelPath: form.modelPath || presetBase.modelPath,
        build: form.build || presetBase.build || '',
        deviceA: form.deviceA,
        deviceB: form.deviceB,
        devices: [form.deviceA, form.deviceB].filter(Boolean).join(','),
        rpcTarget: form.rpcTarget ? (form.workerSsh || presetBase.rpcTarget || '') : '',
        transport: form.transport,
        rawCommand: form.rawCommand,
    });

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

    return { form, set, models, builds, devices, devicesError, request, preview, previewBusy, actionError, setActionError, start, stop, previewCommand };
}

export { fieldClass };
