// Precedence rules for assembling a Start/Preview request from the launch
// form state and the PresetDock draft (src/client/lib/launchRequest.ts).
// Form beats preset; untouched form fields fall back to the preset; the
// router section merges form switch with preset router config.
import { test, expect } from 'bun:test';
import { buildLaunchRequest, effectiveRouterEnabled, effectiveRouterIniText, type LaunchForm } from '../src/client/lib/launchRequest';
import type { LaunchConfig } from '../shared/contracts';

const baseForm: LaunchForm = {
    modelPath: '', build: '', deviceA: '', deviceB: '', rpcTarget: '', workerSsh: '', transport: 'WiFi', rawCommand: '',
    routerEnabled: false, routerMax: '', routerAutoload: true, routerStartup: {}, routerIniText: '',
};

const form = (over: Partial<LaunchForm>): LaunchForm => ({ ...baseForm, ...over });
const preset = (over: LaunchConfig): LaunchConfig => ({ modelPath: '/m/preset.gguf', ...over });

test('empty form + empty preset: structured fields default to blanks, transport from form', () => {
    const req = buildLaunchRequest(form({}), {});
    expect(req.build).toBe('');
    expect(req.deviceA).toBe('');
    expect(req.deviceB).toBe('');
    expect(req.devices).toBe('');
    expect(req.rpcTarget).toBe('');
    expect(req.transport).toBe('WiFi');
    expect(req.rawCommand).toBe('');
    expect(req.router).toBeUndefined();
    expect(req.modelPath).toBeUndefined();
});

test('untouched form fields fall back to the preset instead of wiping it', () => {
    const p = preset({ build: 'cuda', deviceA: '/dev/dri/renderD128', deviceB: '/dev/dri/renderD129', rawCommand: '' });
    const req = buildLaunchRequest(form({ transport: 'LAN' }), p);
    expect(req.modelPath).toBe('/m/preset.gguf');
    expect(req.build).toBe('cuda');
    expect(req.deviceA).toBe('/dev/dri/renderD128');
    expect(req.deviceB).toBe('/dev/dri/renderD129');
    expect(req.devices).toBe('/dev/dri/renderD128,/dev/dri/renderD129');
    expect(req.rawCommand).toBe('');
});

test('form fields override the preset when set', () => {
    const p = preset({ build: 'cuda', deviceA: 'a', deviceB: 'b', rawCommand: 'no' });
    const req = buildLaunchRequest(form({ modelPath: '/m/other.gguf', build: 'cpu', deviceA: 'x', rawCommand: 'mine' }), p);
    expect(req.modelPath).toBe('/m/other.gguf');
    expect(req.build).toBe('cpu');
    expect(req.deviceA).toBe('x');
    expect(req.deviceB).toBe('b');
    expect(req.devices).toBe('x,b');
    expect(req.rawCommand).toBe('mine');
});

test('devices joins whichever of A/B resolve, skipping blanks', () => {
    const req = buildLaunchRequest(form({ deviceA: 'a' }), {});
    expect(req.devices).toBe('a');
    const req2 = buildLaunchRequest(form({ deviceB: 'b' }), {});
    expect(req2.devices).toBe('b');
});

test('rpcTarget: empty form field means no RPC, even with a preset rpcTarget', () => {
    const req = buildLaunchRequest(form({}), preset({ rpcTarget: 'worker:500' }));
    expect(req.rpcTarget).toBe('');
});

test('rpcTarget: form field present, workerSsh overrides preset rpcTarget', () => {
    const req = buildLaunchRequest(form({ rpcTarget: 'worker1:500', workerSsh: 'other:9' }), preset({ rpcTarget: 'worker:500' }));
    expect(req.rpcTarget).toBe('other:9');
    const req2 = buildLaunchRequest(form({ rpcTarget: 'worker1:500' }), preset({ rpcTarget: 'worker:500' }));
    expect(req2.rpcTarget).toBe('worker:500');
});

test('preset-only keys (ctx, paramOverrides, label) pass through untouched', () => {
    const req = buildLaunchRequest(form({}), { ctx: 8192, ngl: 8, label: 'dev', paramOverrides: { temp: 0.7 } });
    expect(req.ctx).toBe(8192);
    expect(req.ngl).toBe(8);
    expect(req.label).toBe('dev');
    expect(req.paramOverrides).toEqual({ temp: 0.7 });
});

test('router: no preset router and toggle off -> no router key', () => {
    expect(buildLaunchRequest(form({}), preset({})).router).toBeUndefined();
});

test('router: form toggle on with no preset router -> enabled, no maxModels, form autoload', () => {
    const req = buildLaunchRequest(form({ routerEnabled: true, routerStartup: { '/m/a.gguf': true } }), {});
    expect(req.router).toEqual({
        enabled: true,
        autoload: true,
        models: [{ modelPath: '/m/a.gguf', loadOnStartup: true }],
    });
});

test('router: preset-only enablement keeps preset maxModels, replaces models with form startup set', () => {
    const p = preset({ router: { enabled: true, maxModels: 6, modelsDir: '/models', models: [{ modelPath: '/m/old.gguf', loadOnStartup: true }] } });
    const req = buildLaunchRequest(form({ routerStartup: { '/m/new.gguf': true, '/m/off.gguf': false } }), p);
    expect(req.router).toEqual({
        enabled: true,
        modelsDir: '/models',
        maxModels: 6,
        autoload: true,
        models: [{ modelPath: '/m/new.gguf', loadOnStartup: true }],
    });
});

test('router: form maxModels wins over preset, parsed to a number', () => {
    const p = preset({ router: { enabled: true, maxModels: 6 } });
    const req = buildLaunchRequest(form({ routerEnabled: true, routerMax: '9' }), p);
    expect(req.router?.maxModels).toBe(9);
});

test('router: blank/whitespace maxModels omits the key, leaving llama-server default', () => {
    const req = buildLaunchRequest(form({ routerEnabled: true, routerMax: '   ' }), {});
    expect(req.router?.maxModels).toBeUndefined();
    const p = preset({ router: { enabled: true, maxModels: 5 } });
    const req2 = buildLaunchRequest(form({ routerMax: '  ' }), p);
    expect(req2.router?.maxModels).toBe(5);
});

test('router: autoload follows the form flag, including false', () => {
    const req = buildLaunchRequest(form({ routerEnabled: true, routerAutoload: false }), {});
    expect(req.router?.autoload).toBe(false);
});

test('router: form iniText wins over preset iniText; empty omits the key', () => {
    const p = preset({ router: { enabled: true, iniText: 'preset ini' } });
    expect(buildLaunchRequest(form({ routerIniText: 'form ini' }), p).router?.iniText).toBe('form ini');
    expect(buildLaunchRequest(form({}), p).router?.iniText).toBe('preset ini');
    expect(buildLaunchRequest(form({ routerEnabled: true }), {}).router?.iniText).toBeUndefined();
});

test('router: form toggle off cannot disable a preset router — enablement is OR, documented behavior', () => {
    const p = preset({ router: { enabled: true, maxModels: 6, modelsDir: '/models' } });
    const req = buildLaunchRequest(form({ routerEnabled: false }), p);
    expect(req.router?.enabled).toBe(true);
    expect(req.router?.maxModels).toBe(6);
});

test('effectiveRouterEnabled: OR-only — form on, preset on, both off, preset present but disabled', () => {
    expect(effectiveRouterEnabled(form({ routerEnabled: true }), {})).toBe(true);
    expect(effectiveRouterEnabled(form({}), preset({ router: { enabled: true } }))).toBe(true);
    expect(effectiveRouterEnabled(form({}), {})).toBe(false);
    expect(effectiveRouterEnabled(form({ routerEnabled: false }), preset({ router: { enabled: true } }))).toBe(true);
    expect(effectiveRouterEnabled(form({}), preset({ router: { enabled: false, maxModels: 2 } }))).toBe(false);
});

test('router: preset router present but not enabled stays disabled with its other keys', () => {
    const p = preset({ router: { enabled: false, maxModels: 6 } });
    const req = buildLaunchRequest(form({}), p);
    expect(req.router).toEqual({ enabled: false, maxModels: 6 });
});


test('effectiveRouterIniText: form first, then preset, then blank', () => {
    expect(effectiveRouterIniText(form({ routerIniText: 'a' }), preset({ router: { enabled: true, iniText: 'b' } }))).toBe('a');
    expect(effectiveRouterIniText(form({}), preset({ router: { enabled: true, iniText: 'b' } }))).toBe('b');
    expect(effectiveRouterIniText(form({}), preset({}))).toBe('');
});
