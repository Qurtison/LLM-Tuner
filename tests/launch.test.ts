// ponytail: documents current behavior — unknown/stale build ids fall back
// to builds[0]; empty builds list throws; defaults host 0.0.0.0 port 8080.
// See src/server/lib/launch.js.
import { test, expect } from 'bun:test';
import {
  resolveLaunchCommand,
  getLlamaServerBinary,
  isValidBuild,
  buildLlamaArgs,
  hostFromRpcTarget,
} from '../src/server/lib/launch';
import { argsToIniEntries, routerModelId } from '../src/server/lib/router';
import { validateRouterIni } from '../shared/router-ini';
import { PARAM_BY_ID } from '../shared/llama-params';

const BUILDS = [
  { id: 'default', label: 'Default', path: '/bin/llama-server' },
  { id: 'cuda', label: 'CUDA', path: '/opt/cuda/llama-server' },
];

test('resolveLaunchCommand: defaults (host 0.0.0.0, port 8080, --metrics)', () => {
  const { command, args } = resolveLaunchCommand({ modelPath: '/m/x.gguf', ctx: 4096, ngl: 32 }, BUILDS);
  expect(command).toBe('/bin/llama-server');
  expect(args).toEqual(['-m', '/m/x.gguf', '-c', '4096', '-ngl', '32', '--host', '0.0.0.0', '--port', '8080', '--metrics']);
});

test('resolveLaunchCommand: port override applied when set', () => {
  const { args } = resolveLaunchCommand({ modelPath: '/m/x.gguf', ctx: 4096, ngl: 32, port: 10061 }, BUILDS);
  expect(args).toContain('--port');
  expect(args[args.indexOf('--port') + 1]).toBe('10061');
});

test('resolveLaunchCommand: stale/unknown build id falls back to builds[0]', () => {
  expect(resolveLaunchCommand({ modelPath: '/m/x.gguf', ctx: 4096, ngl: 32, build: 'stale' }, BUILDS).command).toBe('/bin/llama-server');
});

test('resolveLaunchCommand: unknown build id uses first build', () => {
  expect(resolveLaunchCommand({ modelPath: '/m/x.gguf', ctx: 4096, ngl: 32, build: 'nope' }, BUILDS).command).toBe('/bin/llama-server');
});

test('resolveLaunchCommand: known build id resolves its path', () => {
  expect(resolveLaunchCommand({ modelPath: '/m/x.gguf', ctx: 4096, ngl: 32, build: 'cuda' }, BUILDS).command).toBe('/opt/cuda/llama-server');
});

test('resolveLaunchCommand: missing build field falls back to builds[0]', () => {
  expect(resolveLaunchCommand({ modelPath: '/m/x.gguf', ctx: 4096, ngl: 32 }, BUILDS).command).toBe('/bin/llama-server');
});

test('resolveLaunchCommand: empty builds list throws', () => {
  expect(() => resolveLaunchCommand({ modelPath: '/m/x.gguf', ctx: 4096, ngl: 32 }, [])).toThrow('No valid llama-server builds configured');
});

test('resolveLaunchCommand: missing modelPath throws', () => {
  expect(() => resolveLaunchCommand({ ctx: 4096, ngl: 32 }, BUILDS)).toThrow('modelPath is required');
});

test('resolveLaunchCommand: non-numeric ctx throws', () => {
  expect(() => resolveLaunchCommand({ modelPath: '/m/x.gguf', ctx: 'abc', ngl: 32 }, BUILDS)).toThrow('ctx and ngl must be numbers');
});

test('resolveLaunchCommand: port 0 throws', () => {
  expect(() => resolveLaunchCommand({ modelPath: '/m/x.gguf', ctx: 4096, ngl: 32, port: 0 }, BUILDS)).toThrow('port must be an integer between 1 and 65535');
});

test('resolveLaunchCommand: port 70000 throws', () => {
  expect(() => resolveLaunchCommand({ modelPath: '/m/x.gguf', ctx: 4096, ngl: 32, port: 70000 }, BUILDS)).toThrow('port must be an integer between 1 and 65535');
});

test('resolveLaunchCommand: rpc target injects split-mode + rpc', () => {
  const { args } = resolveLaunchCommand({ modelPath: '/m/x.gguf', ctx: 4096, ngl: 32, rpcTarget: 'user@host:22' }, BUILDS);
  expect(args).toEqual(['-m', '/m/x.gguf', '-c', '4096', '-ngl', '32', '--host', '0.0.0.0', '--port', '8080', '--metrics', '--split-mode', 'layer', '--rpc', 'host:50052']);
});

test('resolveLaunchCommand: local split injects dev + tensor split', () => {
  const { args } = resolveLaunchCommand({ modelPath: '/m/x.gguf', ctx: 4096, ngl: 32, deviceA: 'cuda', deviceB: 'vulkan', tensorSplit: 30 }, BUILDS);
  expect(args).toEqual(['-m', '/m/x.gguf', '-c', '4096', '-ngl', '32', '--host', '0.0.0.0', '--port', '8080', '--metrics', '--split-mode', 'layer', '-dev', 'cuda,vulkan', '-ts', '30,70']);
});

test('resolveLaunchCommand: tensor split list (array + string) survives parsing', () => {
  // The preset dock's `list` control splits on commas and stores an array;
  // a legacy preset keeps the joined string. Both used to vanish (NaN -> no
  // -ts), which loaded the model on one device and OOMed.
  for (const [tensorSplit, want] of [[['0.75', '1.25'], '0.75,1.25'], ['0.75, 1.25', '0.75,1.25'], ['3,1', '3,1']] as [unknown, string][]) {
    const { args } = resolveLaunchCommand({ modelPath: '/m/x.gguf', ctx: 4096, ngl: 32, deviceA: 'CUDA0', deviceB: 'VULKAN1', tensorSplit }, BUILDS);
    expect(args.slice(-2)).toEqual(['-ts', want]);
  }
});

test('resolveLaunchCommand: garbage tensor split is dropped, not emitted raw', () => {
  for (const tensorSplit of ['a,b', '-1,2', '', '100']) {
    const { args } = resolveLaunchCommand({ modelPath: '/m/x.gguf', ctx: 4096, ngl: 32, deviceA: 'cuda', deviceB: 'vulkan', tensorSplit }, BUILDS);
    expect(args).not.toContain('-ts');
  }
});

test('resolveLaunchCommand: argString merged after structured args', () => {
  const { args } = resolveLaunchCommand({ modelPath: '/m/x.gguf', ctx: 4096, ngl: 32, argString: '--temp 0.7' }, BUILDS);
  expect(args).toEqual(['-m', '/m/x.gguf', '-c', '4096', '-ngl', '32', '--host', '0.0.0.0', '--port', '8080', '--metrics', '--temp', '0.7']);
});

test('resolveLaunchCommand: argString -m remaps through mapModelPath', () => {
  const { args } = resolveLaunchCommand({ modelPath: '/m/x.gguf', ctx: 4096, ngl: 32, argString: '--temp 0.7 -m remapped.gguf' }, BUILDS);
  expect(args).toEqual(['-m', '/m/x.gguf', '-c', '4096', '-ngl', '32', '--host', '0.0.0.0', '--port', '8080', '--metrics', '--temp', '0.7', '-m', 'remapped.gguf']);
});

test('resolveLaunchCommand: identical devicesA/B yields no split-mode', () => {
  const { args } = resolveLaunchCommand({ modelPath: '/m/x.gguf', ctx: 4096, ngl: 32, deviceA: 'cuda', deviceB: 'cuda' }, BUILDS);
  expect(args).not.toContain('--split-mode');
});

test('getLlamaServerBinary: stale/unknown id falls back to builds[0]', () => {
  expect(getLlamaServerBinary(BUILDS, 'stale')).toBe('/bin/llama-server');
});

test('getLlamaServerBinary: undefined id falls back to builds[0]', () => {
  expect(getLlamaServerBinary(BUILDS, undefined)).toBe('/bin/llama-server');
});

test('getLlamaServerBinary: empty builds throws', () => {
  expect(() => getLlamaServerBinary([], 'x')).toThrow('No valid llama-server builds configured');
});

test('isValidBuild: rejects empty/whitespace/missing path', () => {
  expect(isValidBuild({ id: 'e', path: '' })).toBe(false);
  expect(isValidBuild({ path: '   ' })).toBe(false);
  expect(isValidBuild({ id: 'e' })).toBe(false);
  // ponytail: documents current behavior — isValidBuild(null) returns null
  // (short-circuit of b && ...), not false; treat as falsy.
  expect(isValidBuild(null)).toBeFalsy();
  expect(isValidBuild({ id: 'x', path: '/bin/x' })).toBe(true);
});

test('hostFromRpcTarget: strips user and port', () => {
  expect(hostFromRpcTarget('user@host:22')).toBe('host');
  expect(hostFromRpcTarget('host')).toBe('host');
  expect(hostFromRpcTarget('host:22')).toBe('host');
  expect(hostFromRpcTarget('')).toBe('');
});

test('buildLlamaArgs: fa on emits -fa on', () => {
  const args = buildLlamaArgs({ modelPath: '/m/x.gguf', ctx: 4096, ngl: 32, fa: true }, { mapModelPath: p => p, deviceArgs: [] });
  expect(args).toContain('-fa');
  expect(args[args.indexOf('-fa') + 1]).toBe('on');
});

test('buildLlamaArgs: no_reasoning_preserve=true emits --reasoning-preserve with no value', () => {
  const args = buildLlamaArgs({ modelPath: '/m/x.gguf', ctx: 4096, ngl: 32, paramOverrides: { no_reasoning_preserve: true } }, { mapModelPath: p => p, deviceArgs: [] });
  const i = args.indexOf('--reasoning-preserve');
  expect(i).toBeGreaterThan(-1);
  expect(args[i + 1]).toBeUndefined();
});

test('buildLlamaArgs: no_reasoning_preserve=false emits no flag (llama.cpp default)', () => {
  const args = buildLlamaArgs({ modelPath: '/m/x.gguf', ctx: 4096, ngl: 32, paramOverrides: { no_reasoning_preserve: false } }, { mapModelPath: p => p, deviceArgs: [] });
  expect(args).not.toContain('--reasoning-preserve');
  expect(args).not.toContain('--no-reasoning-preserve');
});

// --- ROUTER MODE ---
// ponytail: documents current behavior — router mode replaces -m with
// --models-dir/--models-preset and moves every per-model knob into a
// generated INI. See src/server/lib/router.ts.

const ROUTER_OPTS = { modelsDir: '/home/ai/llm/models', appRoot: '/app' };

test('router mode: command line carries the router flags and no -m', () => {
  const { args } = resolveLaunchCommand(
    { ctx: 262144, ngl: 999, router: { enabled: true } },
    BUILDS,
    { ...ROUTER_OPTS, defaultPort: 18083 },
  );
  expect(args).not.toContain('-m');
  expect(args).not.toContain('--model');
  expect(args).toEqual([
    '--models-dir', '/home/ai/llm/models',
    '--models-preset', '/app/generated/router.ini',
    '--host', '0.0.0.0', '--port', '18083', '--metrics',
    // llama-server would default to 4 resident models; a models dir full of
    // 27Bs OOMs long before that, so the dashboard caps at 1.
    '--models-max', '1',
  ]);
});

test('router mode: does not require modelPath/ctx/ngl', () => {
  expect(() => resolveLaunchCommand({ router: { enabled: true } }, BUILDS, ROUTER_OPTS)).not.toThrow();
  // ...but a bad port is still rejected.
  expect(() => resolveLaunchCommand({ router: { enabled: true }, port: 0 }, BUILDS, ROUTER_OPTS))
    .toThrow('port must be an integer between 1 and 65535');
});

test('router mode: modelsDir falls back to server config, then to router.modelsDir', () => {
  const fromConfig = resolveLaunchCommand({ router: { enabled: true } }, BUILDS, ROUTER_OPTS).args;
  expect(fromConfig[fromConfig.indexOf('--models-dir') + 1]).toBe('/home/ai/llm/models');
  const overridden = resolveLaunchCommand({ router: { enabled: true, modelsDir: '/other' } }, BUILDS, ROUTER_OPTS).args;
  expect(overridden[overridden.indexOf('--models-dir') + 1]).toBe('/other');
});

test('router mode: no models dir anywhere is an error, not a broken launch', () => {
  expect(() => resolveLaunchCommand({ router: { enabled: true } }, BUILDS, { appRoot: '/app' }))
    .toThrow(/needs a models directory/);
});

test('router mode: maxModels and autoload reach the router command line', () => {
  const { args } = resolveLaunchCommand(
    { router: { enabled: true, maxModels: 3, autoload: false } },
    BUILDS,
    ROUTER_OPTS,
  );
  expect(args[args.indexOf('--models-max') + 1]).toBe('3');
  expect(args).toContain('--no-models-autoload');
  // Autoload is llama-server's default; only the opt-out is emitted.
  expect(resolveLaunchCommand({ router: { enabled: true } }, BUILDS, ROUTER_OPTS).args)
    .not.toContain('--no-models-autoload');
});

test('router mode: router-controlled args stay off the router command line', () => {
  const { ini } = resolveLaunchCommand(
    { ctx: 8192, ngl: 99, router: { enabled: true, maxModels: 1 } },
    BUILDS,
    ROUTER_OPTS,
  );
  for (const forbidden of ['host =', 'port =', 'models-dir =', 'models-preset =', 'models-max =', 'alias =']) {
    expect(ini).not.toContain(forbidden);
  }
});

test('router mode: the INI starts with version and a shared [*] block', () => {
  const { ini } = resolveLaunchCommand(
    { ctx: 262144, ngl: 999, paramOverrides: { cache_type_k: 'q4_0', metrics: true } , router: { enabled: true } },
    BUILDS,
    ROUTER_OPTS,
  );
  const lines = (ini as string).split('\n');
  expect(lines[0]).toBe('version = 1');
  expect(lines).toContain('[*]');
  expect(ini).toContain('ctx-size = 262144');
  // The INI key is the param's first LONG flag: --gpu-layers for -ngl.
  expect(ini).toContain('gpu-layers = 999');
  expect(ini).toContain('cache-type-k = q4_0');
  expect(ini).toContain('metrics = true');
});

test('router mode: the same preset yields the same knobs as a single-model launch', () => {
  const knobs = { ctx: 262144, ngl: 999, specType: 'draft-mtp,ngram-mod', paramOverrides: { cache_type_k: 'q4_0', top_k: 20 } };
  const { args: single } = resolveLaunchCommand({ ...knobs, modelPath: '/m/x.gguf' }, BUILDS);
  const { ini } = resolveLaunchCommand({ ...knobs, router: { enabled: true } }, BUILDS, ROUTER_OPTS);
  for (const flag of ['--spec-type', 'draft-mtp,ngram-mod', '--cache-type-k', 'q4_0', '--top-k', '20']) {
    expect(single).toContain(flag);
  }
  expect(ini).toContain('spec-type = draft-mtp,ngram-mod');
  expect(ini).toContain('cache-type-k = q4_0');
  expect(ini).toContain('top-k = 20');
});

test('router mode: a leftover -m in argString cannot downgrade back to single-model', () => {
  const { args, ini } = resolveLaunchCommand(
    { ctx: 4096, argString: '--temp 0.7 -m sneaky.gguf', router: { enabled: true } },
    BUILDS,
    ROUTER_OPTS,
  );
  expect(args).not.toContain('-m');
  expect(args.join(' ')).not.toContain('sneaky.gguf');
  // `--temp`'s canonical flag is the short one, so the key is `temp`, not
  // `temperature`; both are accepted by the router.
  expect(ini).toContain('temp = 0.7');
  expect(ini).not.toContain('sneaky.gguf');
});

test('router mode: single-model mode is untouched (no ini)', () => {
  const { args, ini } = resolveLaunchCommand({ modelPath: '/m/x.gguf', ctx: 4096, ngl: 32 }, BUILDS);
  expect(ini).toBeUndefined();
  expect(args).toContain('-m');
  expect(args).toContain('/m/x.gguf');
});

test('router mode: loadOnStartup gets its own section for one model', () => {
  const { ini } = resolveLaunchCommand(
    {
      ctx: 8192, ngl: 99, router: {
        enabled: true,
        models: [{ modelPath: '/home/ai/llm/models/ukisai--Swift/Swift-Q4_K_L.gguf', loadOnStartup: true, ctx: 262144 }],
      },
    },
    BUILDS,
    ROUTER_OPTS,
  );
  // The section is named for the model DIRECTORY, not the .gguf inside it:
  // naming the file makes the router list the same weights twice.
  expect(ini).toContain('[ukisai--Swift]');
  expect(ini).not.toContain('[ukisai--Swift/Swift-Q4_K_L]');
  expect(ini).toContain('load-on-startup = true');
  // Per-model ctx differs from the shared block, so it is written out.
  expect(ini).toContain('ctx-size = 262144');
});

test('router mode: a model identical to the shared block needs no section', () => {
  const { ini } = resolveLaunchCommand(
    {
      ctx: 8192, ngl: 99, router: {
        enabled: true,
        models: [{ modelPath: '/home/ai/llm/models/plain.gguf', ctx: 8192, paramOverrides: { n_gpu_layers: '99' } }],
      },
    },
    BUILDS,
    ROUTER_OPTS,
  );
  expect(ini).toContain('[*]');
  expect(ini).not.toContain('[plain]');
});

test('router mode: a model outside modelsDir names itself', () => {
  const { ini } = resolveLaunchCommand(
    { ctx: 8192, router: { enabled: true, models: [{ modelPath: '/elsewhere/odd.gguf', loadOnStartup: false }] } },
    BUILDS,
    ROUTER_OPTS,
  );
  expect(ini).toContain('[odd]');
  expect(ini).toContain('model = /elsewhere/odd.gguf');
});

test('router mode: non-object entries in the model list are dropped', () => {
  const { ini } = resolveLaunchCommand(
    { ctx: 8192, router: { enabled: true, models: [null, 'nope', { noPath: true }, { modelPath: '/home/ai/llm/models/ok.gguf', loadOnStartup: true }] } },
    BUILDS,
    ROUTER_OPTS,
  );
  expect(ini).toContain('[ok]');
  expect(ini).not.toContain('nope');
  expect(ini).not.toContain('noPath');
});

test('routerModelId: strips the gguf suffix and collapses to the model directory', () => {
  expect(routerModelId('/m/models/llama-3.2-1b-Q4_K_M.gguf', '/m/models')).toBe('llama-3.2-1b-Q4_K_M');
  expect(routerModelId('/m/models/gemma-3-4b-it-Q8_0/gemma-3-4b-it-Q8_0.gguf', '/m/models')).toBe('gemma-3-4b-it-Q8_0');
  expect(routerModelId('/m/models/a/b/c.gguf', '/m/models')).toBe('a');
  // Outside the models dir there is nothing to collapse to.
  expect(routerModelId('/elsewhere/x.gguf', '/m/models')).toBe('x');
});

test('argsToIniEntries: every emitted key is a real llama-server flag', () => {
  // An unrecognized key aborts the whole router, so nothing may reach the INI
  // that --help did not produce.
  const known = new Set<string>();
  for (const def of Object.values(PARAM_BY_ID)) for (const f of def.flags) if (f.startsWith('--')) known.add(f.slice(2));
  const entries = argsToIniEntries(['-c', '4096', '-ngl', '99', '--metrics', '--cache-type-k', 'q4_0', '--host', '0.0.0.0', '--port', '8080', '--spec-draft-type-k', 'q4_0']);
  expect(entries.length).toBeGreaterThan(0);
  for (const e of entries) expect(known.has(e.key)).toBe(true);
});

test('router mode: maxModels defaults to 1, and 0 still means unlimited', () => {
  const cap = (maxModels?: number) => {
    const { args } = resolveLaunchCommand(
      { router: { enabled: true, ...(maxModels === undefined ? {} : { maxModels }) } },
      BUILDS,
      ROUTER_OPTS,
    );
    return args[args.indexOf('--models-max') + 1];
  };
  expect(cap()).toBe('1');
  expect(cap(0)).toBe('0');
  expect(cap(2)).toBe('2');
});

// --- HAND-WRITTEN PRESET ---
// ponytail: documents current behavior — a supplied iniText is used verbatim,
// and is never merged with the generated entries.

test('hand-written preset: used verbatim instead of the generated one', () => {
  const iniText = 'version = 1\n\n[*]\nctx-size = 4096\n\n[gemma-4-12b-it-UD-Q4_K_XL]\nload-on-startup = true\n';
  const { ini, args } = resolveLaunchCommand(
    { ctx: 262144, ngl: 999, paramOverrides: { cache_type_k: 'q4_0' }, router: { enabled: true, iniText } },
    BUILDS,
    ROUTER_OPTS,
  );
  expect(ini).toBe(iniText);
  // Nothing from the launch config leaks in: the user's text stands alone.
  expect(ini).not.toContain('gpu-layers');
  expect(ini).not.toContain('cache-type-k');
  // The command line is unaffected either way.
  expect(args).toContain('--models-preset');
  expect(args).toContain('/app/generated/router.ini');
});

test('hand-written preset: blank or whitespace falls back to generating one', () => {
  for (const iniText of ['', '   \n  ']) {
    const { ini } = resolveLaunchCommand(
      { ctx: 4096, ngl: 99, router: { enabled: true, iniText } },
      BUILDS,
      ROUTER_OPTS,
    );
    expect(ini).toContain('ctx-size = 4096');
    expect(ini).toContain('gpu-layers = 99');
  }
});

test('validateRouterIni: a clean generated preset reports nothing', () => {
  const { ini } = resolveLaunchCommand(
    { ctx: 262144, ngl: 999, paramOverrides: { cache_type_k: 'q4_0', metrics: true }, router: { enabled: true } },
    BUILDS,
    ROUTER_OPTS,
  );
  expect(validateRouterIni(ini as string)).toEqual([]);
});

test('validateRouterIni: an unknown key is reported with its line', () => {
  const warnings = validateRouterIni('version = 1\n\n[*]\nthis-is-not-a-real-key = 5\n');
  expect(warnings).toHaveLength(1);
  expect(warnings[0].line).toBe(4);
  expect(warnings[0].key).toBe('this-is-not-a-real-key');
  expect(warnings[0].message).toContain('refuse to start');
});

test('validateRouterIni: router-controlled keys start but get overwritten', () => {
  for (const key of ['host', 'port', 'models-max', 'alias']) {
    const warnings = validateRouterIni(`[*]\n${key} = 1\n`);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('overwritten');
  }
});

test('validateRouterIni: accepts the shapes people actually type', () => {
  // Underscores, mixed case, comments, section headers and preset-only keys.
  const warnings = validateRouterIni([
    '; a comment',
    '# another',
    'version = 1',
    '[*]',
    'ctx_size = 4096',
    'CTX-SIZE = 8192',
    'reasoning-preserve = true',
    'cache-type-k = q4_0',
    'load-on-startup = true',
    'stop-timeout = 30',
  ].join('\n'));
  expect(warnings).toEqual([]);
});

test('validateRouterIni: a stray line with no = is reported', () => {
  const warnings = validateRouterIni('[*]\nctx-size 4096\n');
  expect(warnings).toHaveLength(1);
  expect(warnings[0].line).toBe(2);
  expect(warnings[0].message).toContain('key = value');
});

test('validateRouterIni: every generated key survives its own validator', () => {
  // The generator and the validator must agree, or the editor would flag a
  // preset the dashboard just produced.
  const { ini } = resolveLaunchCommand(
    {
      ctx: 262144, ngl: 999, specType: 'draft-mtp,ngram-mod', cacheK: 'q4_0', cacheV: 'q4_0',
      paramOverrides: { cache_type_k_draft: 'q4_0', no_reasoning_preserve: true, metrics: true, top_k: 20, min_p: 0 },
      tensorSplit: '0.75,1.25', deviceA: 'CUDA0', deviceB: 'VULKAN1', temp: 1, reasoningPreserve: true,
      router: { enabled: true, models: [{ modelPath: '/home/ai/llm/models/a/b.gguf', loadOnStartup: true, ctx: 4096 }] },
    },
    BUILDS,
    ROUTER_OPTS,
  );
  expect(validateRouterIni(ini as string)).toEqual([]);
});
