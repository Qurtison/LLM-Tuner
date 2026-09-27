/*
 * Verify the launch-arg emission table against a REAL llama-server binary.
 *
 *   bun scripts/verify-flags-real.ts <path-to-llama-server>
 *
 * Checks three things:
 *   1. every flag the resolver actually renders (from the golden snapshot
 *      cases) is accepted by the binary's own --help;
 *   2. every flag in the generated registry is accepted -- paramOverrides can
 *      emit any registry id, so the registry is a live input surface;
 *   3. reports registry flags the binary does NOT know (registry/binary drift).
 */
import { readFileSync } from 'node:fs';
import { parseHelpFlags } from '../src/server/lib/helpparse';
import { LAUNCH_ARGS } from '../shared/launch-params';
import { PARAM_BY_ID } from '../shared/llama-params';

const helpPath = process.argv[2];
if (!helpPath) throw new Error('usage: bun scripts/verify-flags-real.ts <help.txt>');

const help = readFileSync(helpPath, 'utf-8');
const accepted = new Set<string>();
for (const entry of parseHelpFlags(help)) {
    for (const token of entry.flags.split(/[\s,]+/)) {
        if (/^--?[A-Za-z][A-Za-z0-9_-]*$/.test(token)) accepted.add(token);
    }
}

// Flags the resolver can render. Values are excluded, including negative
// numbers (--top-p -0.5), which are not flags.
const looksLikeFlag = (t: string): boolean => t.startsWith('-') && t !== '-' && !/^-\d+(\.\d+)?$/.test(t);

// Flags the resolver renders itself, taken from the golden snapshot cases.
// Lines are `${caseName padEnd 28} ${argv}`; section headers ('--- x ---') are
// skipped, and argString cases are skipped because their text is user-typed
// passthrough, not resolver output.
const rendered = new Set<string>();
for (const file of ['/tmp/args-after.txt', '/tmp/args-before.txt']) {
    for (const line of readFileSync(file, 'utf-8').split('\n')) {
        if (line.startsWith('---') || !line.trim()) continue;
        const caseName = line.slice(0, 28).trim();
        if (caseName.startsWith('argstring')) continue;
        for (const token of line.split(/\s+/)) {
            if (looksLikeFlag(token)) rendered.add(token);
        }
    }
}

// Fixed spellings the resolver writes by hand (not from the table): base
// server flags, the speculative block, the device block, and router mode.
const hardcoded = [
    '-m', '-c', '-ngl', '--host', '--port', '--metrics', '-np',
    '--spec-type', '--spec-draft-n-max', '--spec-draft-n-min', '--spec-draft-model',
    '--spec-ngram-simple-size-n', '--spec-ngram-simple-size-m', '--spec-ngram-simple-min-hits',
    '--spec-ngram-map-k-size-n', '--spec-ngram-map-k-size-m', '--spec-ngram-map-k-min-hits',
    '--spec-ngram-map-k4v-size-n', '--spec-ngram-map-k4v-size-m', '--spec-ngram-map-k4v-min-hits',
    '--split-mode', '-dev', '--rpc', '-ts',
    '--models-dir', '--models-preset', '--models-max', '--no-models-autoload',
];
for (const f of hardcoded) rendered.add(f);

// Table overrides + registry spellings (paramOverrides may emit any of them).
const tableFlags = new Set<string>();
for (const binding of LAUNCH_ARGS) {
    const def = PARAM_BY_ID[binding.paramId];
    const flag = binding.flag ?? def?.flags?.[0];
    if (flag) tableFlags.add(flag);
}
const registryFlags = new Set<string>();
for (const def of Object.values(PARAM_BY_ID)) {
    if (Array.isArray(def.flags) && def.flags[0]) registryFlags.add(def.flags[0]);
}

const missing = (set: Set<string>): string[] => [...set].filter(f => !accepted.has(f)).sort();
const notRendered = missing(rendered);
const notInTable = missing(tableFlags);
const registryMissing = missing(registryFlags);

console.log(`binary accepts ${accepted.size} flags from --help`);
console.log(`rendered by the resolver/snapshot cases: ${rendered.size} flags`);
console.log(`emission-table flags: ${tableFlags.size}`);
console.log(`registry flags[0]: ${registryFlags.size}`);
console.log('');
console.log(`rendered-but-unknown-to-binary: ${notRendered.length}${notRendered.length ? ' -> ' + notRendered.join(' ') : ' (none)'}`);
console.log(`table-flag-unknown-to-binary:   ${notInTable.length}${notInTable.length ? ' -> ' + notInTable.join(' ') : ' (none)'}`);
console.log(`registry-flag-unknown-to-binary: ${registryMissing.length}`);
if (registryMissing.length) console.log('  ' + registryMissing.join(' '));
