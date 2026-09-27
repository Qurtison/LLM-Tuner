/*
 * Golden snapshot of the launch resolver's arg rendering.
 *
 * Not a test: this prints buildLlamaArgs/resolveLaunchCommand output for a
 * fixed set of configs so a refactor can be diffed before/after. Run it on
 * both sides of a change and compare stdout.
 *
 *   bun scripts/snap-launch-args.ts > /tmp/before.txt
 */
import { buildLlamaArgs, resolveLaunchCommand, toFiniteNumber, toNonEmptyString, hostFromRpcTarget, getLlamaServerBinary } from '../src/server/lib/launch';
import type { LaunchInput } from '../src/server/lib/launch';
import type { BuildEntry } from '../shared/contracts';

const builds: BuildEntry[] = [{ id: 'default', label: 'Default', path: '/opt/llama/llama-server' }];
const mapModelPath = (p: string): string => p;

const cases: Array<[string, LaunchInput]> = [
    ['minimal', { modelPath: '/m/model.gguf', ctx: 4096, ngl: 99 }],
    ['sampling', { modelPath: '/m/model.gguf', ctx: 4096, ngl: 99, temp: 0.7, topP: 0.9, minP: 0.05, presencePenalty: 0.1, repeatPenalty: 1.1, topK: 40 }],
    ['kv+fa', { modelPath: '/m/model.gguf', ctx: 4096, ngl: 99, fa: true, cacheK: 'q8_0', cacheV: 'q4_0' }],
    ['fa-false', { modelPath: '/m/model.gguf', ctx: 4096, ngl: 99, fa: false }],
    ['jinja', { modelPath: '/m/model.gguf', ctx: 4096, ngl: 99, jinja: true }],
    ['jinja-via-template', { modelPath: '/m/model.gguf', ctx: 4096, ngl: 99, chatTemplateFile: '/t.j2' }],
    ['verbosity', { modelPath: '/m/model.gguf', ctx: 4096, ngl: 99, verbosity: 4 }],
    ['loadMode', { modelPath: '/m/model.gguf', ctx: 4096, ngl: 99, loadMode: 'mmap' }],
    ['nCpuMoe', { modelPath: '/m/model.gguf', ctx: 4096, ngl: 99, nCpuMoe: 8 }],
    ['spec-simple', { modelPath: '/m/model.gguf', ctx: 4096, ngl: 99, specType: 'ngram-simple', specNgramSizeN: 8, specNgramSizeM: 4, specNgramMinHits: 2 }],
    ['spec-multi', { modelPath: '/m/model.gguf', ctx: 4096, ngl: 99, specType: 'draft-mtp,ngram-map-k,ngram-map-k4v', specDraftNMax: 5, specDraftNMin: 1, specDraftModel: '/m/draft.gguf', specDraftNgl: 12 }],
    ['reasoning', { modelPath: '/m/model.gguf', ctx: 4096, ngl: 99, preserveThinking: true, reasoningPreserve: true }],
    ['reasoning-preserve-only', { modelPath: '/m/model.gguf', ctx: 4096, ngl: 99, reasoningPreserve: true }],
    ['port-override', { modelPath: '/m/model.gguf', ctx: 4096, ngl: 99, port: 18083 }],
    ['port-zero', { modelPath: '/m/model.gguf', ctx: 4096, ngl: 99, port: 0 }],
    ['local-split', { modelPath: '/m/model.gguf', ctx: 4096, ngl: 99, deviceA: 'CUDA0', deviceB: 'CUDA1', tensorSplit: '30,70' }],
    ['local-split-legacy-pct', { modelPath: '/m/model.gguf', ctx: 4096, ngl: 99, deviceA: 'CUDA0', deviceB: 'CUDA1', tensorSplit: 30 }],
    ['local-split-ratios', { modelPath: '/m/model.gguf', ctx: 4096, ngl: 99, deviceA: 'CUDA0', deviceB: 'CUDA1', tensorSplit: ['0.75', '1.25'] }],
    ['rpc', { modelPath: '/m/model.gguf', ctx: 4096, ngl: 99, rpcTarget: 'user@10.0.0.9:22', tensorSplit: '50,50' }],
    ['overrides', { modelPath: '/m/model.gguf', ctx: 4096, ngl: 99, paramOverrides: { top_k: 20, metrics: true, cache_type_k: 'q4_0' } }],
    ['overrides-unknown-id', { modelPath: '/m/model.gguf', ctx: 4096, ngl: 99, paramOverrides: { not_a_param: 1, top_k: 20 } }],
    ['overrides-legacy-snake', { modelPath: '/m/model.gguf', ctx: 4096, ngl: 99, paramOverrides: { ctx_size: 8192, n_gpu_layers: 33, cache_type_k: 'q4_0' } }],
    ['overrides-jinja', { modelPath: '/m/model.gguf', ctx: 4096, ngl: 99, paramOverrides: { jinja: true, verbosity: 5, reasoning_preserve: true } }],
    ['overrides-negated-toggles', { modelPath: '/m/model.gguf', ctx: 4096, ngl: 99, paramOverrides: { no_jinja: true, no_reasoning_preserve: true, metrics: true } }],
    ['overrides-toggles-off', { modelPath: '/m/model.gguf', ctx: 4096, ngl: 99, paramOverrides: { no_jinja: false, metrics: false } }],
    ['overrides-zero', { modelPath: '/m/model.gguf', ctx: 4096, ngl: 99, paramOverrides: { min_p: 0, top_k: 0 } }],
    ['argstring-remap', { modelPath: '/m/model.gguf', ctx: 4096, ngl: 99, argString: '  --temp 0.3   -m /other/override.gguf --jinja ' }],
    ['argstring-dedupe', { modelPath: '/m/model.gguf', ctx: 4096, ngl: 99, temp: 0.7, argString: '--temp 0.3' }],
    ['argstring-alias-dedupe', { modelPath: '/m/model.gguf', ctx: 4096, ngl: 99, argString: '--ctx-size 8192' }],
    ['argstring-repeatable', { modelPath: '/m/model.gguf', ctx: 4096, ngl: 99, argString: '--lora /l/a.gguf --lora /l/b.gguf --header "X: 1"' }],
    ['argstring-negative-value', { modelPath: '/m/model.gguf', ctx: 4096, ngl: 99, argString: '--top-p -0.5' }],
    ['blank-knobs', { modelPath: '/m/model.gguf', ctx: '', ngl: '' }],
    ['zero-ctx', { modelPath: '/m/model.gguf', ctx: 0, ngl: 0 }],
    ['bad-port-text', { modelPath: '/m/model.gguf', ctx: 4096, ngl: 99, port: 'abc' }],
    ['router-ini-text', { modelPath: '/m/model.gguf', ctx: 4096, ngl: 99, router: { enabled: true, iniText: '[models]\nfoo=/m/a.gguf\n' } }],
    ['router-generated', { modelPath: '', ctx: 8192, ngl: 99, temp: 0.5, router: { enabled: true, models: [{ modelPath: '/m/a.gguf', loadOnStartup: true }] } }],
    ['router-argstring-drops-m', { ctx: 8192, ngl: 99, argString: '-m /nope.gguf --temp 0.2', router: { enabled: true } }],
    ['no-model', { ctx: 4096, ngl: 99 }],
    ['not-an-object-router', { modelPath: '/m/model.gguf', ctx: 4096, ngl: 99, router: 'nope' }],
    ['garbage-models', { modelPath: '/m/model.gguf', ctx: 4096, ngl: 99, router: { enabled: true, models: [null, 3, { nope: 1 }, { modelPath: '/m/a.gguf' }] } }],
];

const out: string[] = [];
for (const [name, config] of cases) {
    let line: string;
    try {
        line = buildLlamaArgs(structuredClone(config), { mapModelPath, deviceArgs: [] }).join(' ');
    } catch (err) {
        line = 'THROWS: ' + (err as Error).message;
    }
    out.push(`${name.padEnd(28)} ${line}`);
}
out.push('');
out.push('--- resolveLaunchCommand ---');
for (const [name, config] of cases) {
    let line: string;
    try {
        const r = resolveLaunchCommand(structuredClone(config), builds, { modelsDir: '/models', appRoot: '/app' });
        line = `${r.command} ${r.args.join(' ')}${r.ini ? '\n    INI<<<\n' + r.ini + '    >>>INI' : ''}`;
    } catch (err) {
        line = 'THROWS: ' + (err as Error).message;
    }
    out.push(`${name.padEnd(28)} ${line}`);
}
out.push('');
out.push('--- helpers ---');
for (const v of [0, 1, '', '  ', 'abc', '1.5', '-0.5', true, false, null, undefined, [], ['1', '2']]) {
    out.push(`toFiniteNumber(${JSON.stringify(v)}) = ${String(toFiniteNumber(v))}`);
}
for (const v of ['', '  ', '0', ' x ', 0, false, null, undefined]) {
    out.push(`toNonEmptyString(${JSON.stringify(v)}) = ${JSON.stringify(toNonEmptyString(v))}`);
}
for (const v of ['user@host:22', 'host', 'host:50052', '@h', '', 'a@b@c:1:2']) {
    out.push(`hostFromRpcTarget(${JSON.stringify(v)}) = ${JSON.stringify(hostFromRpcTarget(v))}`);
}
out.push(`getLlamaServerBinary = ${getLlamaServerBinary(builds, 'nope')}`);

console.log(out.join('\n'));
