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
