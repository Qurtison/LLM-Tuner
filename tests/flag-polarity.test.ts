import { test, expect } from 'bun:test';
import { PARAM_BY_ID } from '../shared/llama-params';
import {
    hasNegativeSpelling,
    negativeSpellings,
    offSpelling,
    positiveSpellings,
    isExplicitOff,
} from '../shared/flag-polarity';

// A ParamDef lists every spelling of ONE option, in llama-server's own order:
// `--jinja, --no-jinja`. So `flags[0]` is the enabling spelling, and the
// disabling one has to be found by pattern -- position cannot tell them apart,
// because `-kvo, --kv-offload, -nkvo, --no-kv-offload` puts a positive ALIAS at
// index 1. Getting this wrong inverts a launch flag.

test('a positive alias at index 1 is not mistaken for a disabling spelling', () => {
    const flags = ['-kvo', '--kv-offload', '-nkvo', '--no-kv-offload'];
    expect(negativeSpellings(flags)).toEqual(['-nkvo', '--no-kv-offload']);
    expect(positiveSpellings(flags)).toEqual(['-kvo', '--kv-offload']);
});

test('short disabling aliases are recognised', () => {
    expect(negativeSpellings(['--repack', '-nr', '--no-repack'])).toEqual(['-nr', '--no-repack']);
    expect(negativeSpellings(['-cb', '--cont-batching', '-nocb', '--no-cont-batching']))
        .toEqual(['-nocb', '--no-cont-batching']);
    expect(negativeSpellings(['-kvu', '--kv-unified', '-no-kvu', '--no-kv-unified']))
        .toEqual(['-no-kvu', '--no-kv-unified']);
});

test('a param with no --no- spelling has no disabling spelling', () => {
    expect(hasNegativeSpelling(['-fa', '--flash-attn'])).toBe(false);
    expect(offSpelling(['-fa', '--flash-attn'])).toBeUndefined();
});

test('a standalone -n flag is not treated as a disabling alias', () => {
    // -ngl merely starts with -n. Only a --no-<x> spelling proves a pair exists.
    expect(hasNegativeSpelling(['-ngl', '--n-gpu-layers'])).toBe(false);
    expect(negativeSpellings(['-ngl', '--n-gpu-layers'])).toEqual([]);
    expect(offSpelling(['-ngl', '--n-gpu-layers'])).toBeUndefined();
});

test('offSpelling prefers the longest long form', () => {
    // upstream: `--mmproj-auto, --no-mmproj, --no-mmproj-auto` -- the longest is
    // the specific spelling that names this option.
    expect(offSpelling(['--mmproj-auto', '--no-mmproj', '--no-mmproj-auto'])).toBe('--no-mmproj-auto');
    expect(offSpelling(['--ui', '--webui', '--no-ui', '--no-webui'])).toBe('--no-webui');
});

test('a negative-only option has no off spelling', () => {
    // llama.cpp's --no-host is its own switch ("bypass host buffer"), not the
    // negation of --host. ON already emits it, so emitting it for false too
    // would make true and false identical.
    expect(hasNegativeSpelling(['--no-host'])).toBe(true);
    expect(positiveSpellings(['--no-host'])).toEqual([]);
    expect(offSpelling(['--no-host'])).toBeUndefined();
});

test('isExplicitOff is narrow on purpose', () => {
    for (const value of [false, 'false', 0]) {
        expect(isExplicitOff(value), JSON.stringify(value)).toBe(true);
    }
    for (const value of [true, 'true', 1, '', '  ', null, undefined, 'abc', [], {}]) {
        expect(isExplicitOff(value), JSON.stringify(value)).toBe(false);
    }
});

// Guards the registry itself rather than a hand-written fixture: every on/off
// pair the binary documents must yield a disabling spelling the emission path
// can use, and only a genuinely negative-only option may lack one.
test('every registry on/off pair yields a usable off spelling', () => {
    const pairs = Object.values(PARAM_BY_ID).filter(def => hasNegativeSpelling(def.flags ?? []));
    expect(pairs.length).toBe(28);

    const negativeOnly = pairs.filter(def => positiveSpellings(def.flags ?? []).length === 0).map(def => def.id);
    expect(negativeOnly).toEqual(['no_host']);

    const unusable = pairs
        .filter(def => positiveSpellings(def.flags ?? []).length > 0)
        .filter(def => offSpelling(def.flags ?? []) === undefined)
        .map(def => def.id);
    expect(unusable).toEqual([]);
});

test('an off spelling is always one of the param\'s own flags', () => {
    const stray = Object.values(PARAM_BY_ID)
        .map(def => ({ id: def.id, off: offSpelling(def.flags ?? []) }))
        .filter(entry => entry.off !== undefined && !(PARAM_BY_ID[entry.id].flags ?? []).includes(entry.off!))
        .map(entry => entry.id);
    expect(stray).toEqual([]);
});
