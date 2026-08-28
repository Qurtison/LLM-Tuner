import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseHelpFlags, HELP_DESC_COLUMN, type HelpFlagEntry } from '../src/server/lib/helpparse';

const fixture = readFileSync(new URL('./fixtures/llama_help_sample.txt', import.meta.url), 'utf-8');

test('parseHelpFlags: HELP_DESC_COLUMN is 40 (column-aligned descriptions)', () => {
  expect(HELP_DESC_COLUMN).toBe(40);
});

test('parseHelpFlags: parses fixture flag entries', () => {
  const entries = parseHelpFlags(fixture);
  // 10 flag entries: usage, --model, --ctx-size, --host, --port, --metrics,
  // --temp, --top-k, --top-p, --prefill-assistant
  expect(entries.length).toBe(10);
});

test('parseHelpFlags: sections derived from --- header lines', () => {
  const entries = parseHelpFlags(fixture);
  const byFlag = (f: string): HelpFlagEntry => entries.find(e => e.flags.startsWith(f))!;
  expect(byFlag('-m FNAME').section).toBe('general');
  expect(byFlag('--host').section).toBe('Server options');
  expect(byFlag('--port').section).toBe('Server options');
  expect(byFlag('--metrics').section).toBe('Server options');
  expect(byFlag('--temp').section).toBe('Model options');
  expect(byFlag('--prefill-assistant').section).toBe('Specular options');
});

test('parseHelpFlags: primaryFlag is the long form (or short when no long)', () => {
  const entries = parseHelpFlags(fixture);
  const m = entries.find(e => e.flags.startsWith('-m FNAME'))!;
  expect(m.primaryFlag).toBe('--model');
  expect(m.insertText).toBe('--model ');
});

test('parseHelpFlags: continuation line appends to previous description', () => {
  const entries = parseHelpFlags(fixture);
  const pref = entries.find(e => e.flags.startsWith('--prefill-assistant'))!;
  // the indented continuation line joined into the description (current behavior)
  expect(pref.description).toContain('detailed continuation for the prefill flag line');
});

test('parseHelpFlags: short-flag-only line yields primaryFlag as the short form', () => {
  // -m alone (no long form) -> primaryFlag stays '-m' (current behavior)
  const entries = parseHelpFlags('-m FNAME model');
  expect(entries[0].primaryFlag).toBe('-m');
});

test('parseHelpFlags: empty input yields no entries', () => {
  expect(parseHelpFlags('')).toEqual([]);
});

test('parseHelpFlags: blank lines are skipped', () => {
  expect(parseHelpFlags('\n\n  \n')).toEqual([]);
});

test('parseHelpFlags: unknown/no-flag line still becomes an entry', () => {
  // ponytail: documents current behavior — a non-flag line with no leading
  // whitespace is treated as a flag entry (flags field = whole line).
  const entries = parseHelpFlags('just a plain word on a line');
  expect(entries.length).toBe(1);
  expect(entries[0].flags).toBe('just a plain word on a line');
  expect(entries[0].section).toBe('general');
});

test('parseHelpFlags: overflowing flag line gets empty description until continuation', () => {
  // ponytail: documents current behavior — '--prefill-assistant, --no-prefill-assistant  ...'
  // exceeds HELP_DESC_COLUMN so descPart starts empty; the following indented
  // continuation line is appended into description.
  const entries = parseHelpFlags(fixture);
  const pref = entries.find(e => e.flags.startsWith('--prefill-assistant'))!;
  expect(pref.description).not.toBe('');
});
