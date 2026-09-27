/*
 * End-to-end acceptance check: render a launch through the REFACTORED resolver
 * and hand the exact command line to a real llama-server.
 *
 *   bun scripts/e2e-resolver-launch.ts <llama-server> <model.gguf> <port>
 *
 * Prints the resolvers' own argv (shell-quoted) so the same line can be run by
 * hand, then execs it. Success = the binary accepts every rendered flag and
 * reaches "model loaded".
 */
import { spawn } from 'node:child_process';
import { resolveLaunchCommand } from '../src/server/lib/launch';
import type { LaunchConfig } from '../shared/contracts';
import type { BuildEntry } from '../shared/contracts';

const [binary, model, portArg] = process.argv.slice(2);
if (!binary || !model || !portArg) throw new Error('usage: e2e-resolver-launch.ts <llama-server> <model.gguf> <port>');

const builds: BuildEntry[] = [{ id: 'default', label: 'Default', path: binary }];

// Exercises every emission-table group: pre-spec (fa/cache), base, post-spec,
// device, and a spread of post-device rows.
const config: LaunchConfig = {
    modelPath: model,
    ctx: 2048,
    ngl: 0,
    fa: true,
    cacheK: 'q8_0',
    cacheV: 'q8_0',
    jinja: true,
    loadMode: 'mmap',
    verbosity: 3,
    temp: 0.7,
    topK: 40,
    topP: 0.9,
    minP: 0.05,
    repeatPenalty: 1.1,
    presencePenalty: 0.1,
} as LaunchConfig;

const resolved = resolveLaunchCommand(config, builds, {
    defaultPort: Number(portArg),
    appRoot: process.cwd(),
    modelsDir: '',
});

const quote = (s: string): string => (/^[A-Za-z0-9._/:-]+$/.test(s) ? s : "'" + s.replace(/'/g, "'\\''") + "'");
console.log('argv: ' + [resolved.command, ...resolved.args].map(quote).join(' '));

const child = spawn(resolved.command, resolved.args, { stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
let reported = false;
const onData = (b: Buffer): void => {
    if (reported) return;
    output += b.toString();
    if (output.includes('listening on')) {
        reported = true;
        console.log('RESULT: accepted -- server reached "listening on"');
        child.kill('SIGTERM');
    }
};
child.stdout.on('data', onData);
child.stderr.on('data', onData);
child.on('exit', code => {
    const rejected = /error: invalid argument|unknown argument/i.exec(output);
    if (rejected) console.log('RESULT: REJECTED -- ' + rejected[0]);
    else if (!output.includes('listening on')) console.log('RESULT: did not reach listening (exit ' + code + ')');
    process.exit(0);
});
setTimeout(() => { console.log('RESULT: timeout'); child.kill('SIGKILL'); }, 60_000).unref();
