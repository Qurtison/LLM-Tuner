import { test, expect } from 'bun:test';
import { PARAM_BY_ID } from '../shared/llama-params';
import {
    LAUNCH_ARGS,
    LAUNCH_BAG_ALIASES,
    LAUNCH_FIELD_TO_PARAM,
    appendLaunchArg,
} from '../shared/launch-params';
import { overridesFromConfig, paramForField } from '../src/client/features/presets/registry';
import type { LaunchConfig } from '../shared/contracts';

// shared/launch-params.ts is the only place allowed to map a LaunchConfig field
// to a llama-server flag. It used to be four hand-maintained copies, and three
// of them had drifted from the generated registry -- silently, because the map
// is `| undefined` so a bad id compiles fine. These tests are the tripwire.

test('every mapped field resolves to a real ParamDef', () => {
    const broken = Object.entries(LAUNCH_FIELD_TO_PARAM)
        .filter(([, id]) => id !== undefined && !PARAM_BY_ID[id])
        .map(([field, id]) => `${field} -> ${id}`);
    expect(broken).toEqual([]);
});

test('every emission row resolves to a real ParamDef with a flag', () => {
    for (const binding of LAUNCH_ARGS) {
        const def = PARAM_BY_ID[binding.paramId];
        expect(def, `${binding.field} -> ${binding.paramId}`).toBeDefined();
        expect(def!.flags.length, `${binding.paramId} has no flag`).toBeGreaterThan(0);
    }
});

// The six that resolved to nothing before, plus one that resolved to the wrong
// param. Each is a field the preset editor could not label, badge or diff.
test('fields that had drifted now resolve to the intended param', () => {
    expect(paramForField('verbosity')?.id).toBe('log_verbosity');
    expect(paramForField('jinja')?.id).toBe('no_jinja');
    expect(paramForField('reasoningPreserve')?.id).toBe('no_reasoning_preserve');
    expect(paramForField('preserveThinking')?.id).toBe('no_reasoning_preserve');
    expect(paramForField('specDraftNMax')?.id).toBe('spec_draft_n_max');
    expect(paramForField('specDraftNMin')?.id).toBe('spec_draft_n_min');
    // Was chat_template, which is a different flag (--chat-template).
    expect(paramForField('chatTemplateFile')?.id).toBe('chat_template_file');
});

test('the drifted fields now reach the preset diff', () => {
    // verbosity: 4 differs from log_verbosity's default of 3, so it is a real
    // override. Before the fix this field was invisible to the editor.
    const config: LaunchConfig = { ctx: 4096, ngl: 99, verbosity: 4 };
    const ids = overridesFromConfig(config).map(entry => entry.paramId);
    expect(ids).toContain('log_verbosity');
});

test('deliberate exclusions stay unmapped', () => {
    // These are excluded on purpose (see the note above LAUNCH_FIELD_TO_PARAM),
    // not by accident. If the registry grows a match and someone wires one up,
    // the preset diff starts showing rows nobody asked for.
    for (const field of ['specDraftNgl', 'nPrompt', 'nGen', 'depths', 'reps', 'rawCommand', 'argString', 'rpcTarget', 'router'] as const) {
        expect(LAUNCH_FIELD_TO_PARAM[field], field).toBeUndefined();
    }
});

test('every bag alias targets a real LaunchConfig field', () => {
    const fields = LAUNCH_FIELD_TO_PARAM as Record<string, unknown>;
    for (const [id, field] of Object.entries(LAUNCH_BAG_ALIASES)) {
        expect(Object.keys(fields), `${id} -> ${field}`).toContain(field);
    }
});

test('emission takes the flag spelling from the registry', () => {
    const args: string[] = [];
    appendLaunchArg(args, { field: 'verbosity', paramId: 'log_verbosity', group: 'post-device' }, { verbosity: 5 });
    expect(args).toEqual(['-lv', '5']);

    args.length = 0;
    appendLaunchArg(args, { field: 'temp', paramId: 'temperature', group: 'post-device' }, { temp: 0.5 });
    expect(args).toEqual(['--temp', '0.5']);
});

test('an unset or unusable value emits nothing', () => {
    const binding = { field: 'verbosity', paramId: 'log_verbosity', group: 'post-device' } as const;
    for (const value of [undefined, null, '', '   ', 'abc']) {
        const args: string[] = [];
        appendLaunchArg(args, binding, { verbosity: value });
        expect(args, JSON.stringify(value)).toEqual([]);
    }
});

test('a false toggle stays off instead of rendering "false"', () => {
    // -fa off would be a real flag, but the field means "flash attention on",
    // and the pre-existing behaviour is to omit it entirely.
    const args: string[] = [];
    appendLaunchArg(args, { field: 'fa', paramId: 'flash_attn', group: 'pre-spec', text: raw => (raw ? 'on' : undefined) }, { fa: false });
    expect(args).toEqual([]);
});

test('a bare toggle emits the flag with no value', () => {
    const args: string[] = [];
    appendLaunchArg(args, { field: 'reasoningPreserve', paramId: 'no_reasoning_preserve', group: 'post-spec', when: raw => !!raw }, { reasoningPreserve: true });
    expect(args).toEqual(['--reasoning-preserve']);
});

test('a zero value is a real value, not a missing one', () => {
    const args: string[] = [];
    appendLaunchArg(args, { field: 'specDraftNMin', paramId: 'spec_draft_n_min', group: 'post-spec' }, { specDraftNMin: 0 });
    expect(args).toEqual(['--spec-draft-n-min', '0']);
});

// --- explicit off -> the disabling spelling -------------------------------

test('an explicit false emits the disabling spelling', () => {
    const args: string[] = [];
    appendLaunchArg(args, { field: 'jinja', paramId: 'no_jinja', group: 'post-device' }, { jinja: false });
    expect(args).toEqual(['--no-jinja']);
});

test('true still emits the enabling spelling', () => {
    const args: string[] = [];
    appendLaunchArg(args, { field: 'jinja', paramId: 'no_jinja', group: 'post-device' }, { jinja: true });
    expect(args).toEqual(['--jinja']);
});

test('absent emits neither spelling, so the default stands', () => {
    const args: string[] = [];
    appendLaunchArg(args, { field: 'jinja', paramId: 'no_jinja', group: 'post-device' }, {});
    expect(args).toEqual([]);
});

test('a gate satisfied by another field wins over an explicit false', () => {
    // `jinja: false` next to a chat template keeps today's behaviour instead of
    // emitting --no-jinja and a template that then has nothing to run with.
    const binding = { field: 'jinja', paramId: 'no_jinja', group: 'post-device', when: (raw: unknown, cfg: Record<string, unknown>) => !!raw || !!cfg.chatTemplateFile } as const;
    const args: string[] = [];
    appendLaunchArg(args, binding, { jinja: false, chatTemplateFile: '/t.j2' });
    expect(args).toEqual(['--jinja']);
});

test('a negative-only option has no off spelling, so false emits nothing', () => {
    // `--no-host` is its own switch (llama.cpp help: "bypass host buffer"), not
    // the negation of `--host`: emitting it for true AND false would be wrong.
    const args: string[] = [];
    appendLaunchArg(args, { field: 'noHost', paramId: 'no_host', group: 'post-device' }, { noHost: false });
    expect(args).toEqual([]);
});
