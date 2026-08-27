import { test, expect } from 'bun:test';
import { FATAL_LINE_RE, isFatalLogLine } from '../src/server/lib/fatallogs';

// Matches llama-server lines that mean the child process died fatally.
// Source: server4.js FATAL_LINE_RE (line 616) -- the `FATAL_LINE_RE.test(line)`
// decision at the fatal branch in spawnLlamaProcess's handleLogs.
const FATAL_INPUTS = [
  'llama_server: fatal error: something went wrong',
  'out of memory while loading',
  'SEGFAULT occurred in worker',
  'Out Of Memory allocating buffer',
];

// Non-fatal noise: llama-server emits these constantly during healthy runs.
// The old substring 'error:'/'abort' check would have killed a healthy
// server over these -- the regex deliberately excludes them.
const NON_FATAL_INPUTS = [
  'error: client aborted request',
  'request aborted by client',
  'some error: thing happened',
  'warning: aborted read',
  'aborting speculative decode',
  'memory pressure detected',
  'llama_log: kv cache miss',
  'failed to fit params to free device memory', // no longer fatal since 843b50a
  '',
];

test('isFatalLogLine: FATAL_LINE_RE matches each fatal pattern', () => {
  for (const line of FATAL_INPUTS) {
    expect(isFatalLogLine(line)).toBe(true);
  }
});

test('isFatalLogLine: non-fatal noise lines do NOT match', () => {
  for (const line of NON_FATAL_INPUTS) {
    expect(isFatalLogLine(line)).toBe(false);
  }
});

// ponytail: documents current behavior — "segmentation fault" is NOT matched;
// only the bare token "segfault" triggers (case-insensitive).
test('isFatalLogLine: "segmentation fault" does NOT match (only "segfault")', () => {
  expect(isFatalLogLine('segmentation fault')).toBe(false);
  expect(isFatalLogLine('segfault')).toBe(true);
});

// ponytail: documents current behavior — substring "error:" anywhere is NOT
// enough; the regex requires one of the exact fatal phrases.
test('isFatalLogLine: bare "error:" line is not fatal', () => {
  expect(isFatalLogLine('error: something')).toBe(false);
});

test('FATAL_LINE_RE: is the exported regex object', () => {
  expect(FATAL_LINE_RE).toBeInstanceOf(RegExp);
});

test('isFatalLogLine: empty string is not fatal', () => {
  expect(isFatalLogLine('')).toBe(false);
});
