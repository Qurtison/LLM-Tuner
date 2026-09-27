/*
 * Pure assembly of a Start/Preview request from the launch form state and
 * the PresetDock draft. No React, no API: the precedence rules (form beats
 * preset, preset beats nothing, router merge) live here so they can be
 * reviewed and tested without the form hook.
 */
import type { LaunchConfig } from '../../../shared/contracts';

// The one shared launch form state (LaunchBar, RpcWorkerPanel, HF search
// all read/write the same store).
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

// The hand-written preset INI that wins for the launch: form text first,
// then the preset's. Non-empty = the server uses it verbatim.
export function effectiveRouterIniText(form: LaunchForm, preset: LaunchConfig): string {
    return form.routerIniText || preset.router?.iniText || '';
}
// Whether the launch will run in router mode. OR-only: the form toggle can
// only ADD enablement, it cannot turn off a router the preset enables.
// A preset router that is present but not enabled stays off.
export function effectiveRouterEnabled(form: LaunchForm, preset: LaunchConfig): boolean {
    return form.routerEnabled || preset.router?.enabled === true;
}


export function buildLaunchRequest(form: LaunchForm, preset: LaunchConfig): LaunchConfig {
    // Router mode: the toggle is OR-only (effectiveRouterEnabled) — the form
    // can switch a preset router on, never off. The per-model knobs always
    // come from the preset, since that is where ctx/ngl/cache/sampling live.
    const routerEnabled = effectiveRouterEnabled(form, preset);
    const routerMax = form.routerMax || (preset.router?.maxModels !== undefined ? String(preset.router.maxModels) : '');
    const routerIniText = effectiveRouterIniText(form, preset);

    return {
        ...preset,
        modelPath: form.modelPath || preset.modelPath,
        build: form.build || preset.build || '',
        // Untouched form fields fall back to the preset instead of wiping it.
        deviceA: form.deviceA || preset.deviceA || '',
        deviceB: form.deviceB || preset.deviceB || '',
        devices: [form.deviceA || preset.deviceA, form.deviceB || preset.deviceB].filter(Boolean).join(','),
        rpcTarget: form.rpcTarget ? (form.workerSsh || preset.rpcTarget || '') : '',
        transport: form.transport,
        rawCommand: form.rawCommand || preset.rawCommand || '',
        router: routerEnabled ? {
            ...(preset.router || { enabled: true }),
            enabled: true,
            ...(routerMax.trim() ? { maxModels: Number(routerMax) } : {}),
            autoload: form.routerAutoload,
            models: Object.entries(form.routerStartup)
                .filter(([, on]) => on)
                .map(([modelPath]) => ({ modelPath, loadOnStartup: true })),
            // A hand-written preset is the source of truth when present: the
            // server uses it verbatim instead of generating one.
            ...(routerIniText ? { iniText: routerIniText } : {}),
        } : (preset.router ? { ...preset.router, enabled: false } : undefined),
    };
}
