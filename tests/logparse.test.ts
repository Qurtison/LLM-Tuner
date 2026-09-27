import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseLogLine, fatalMessage } from '../src/server/lib/logparse';

// Verbatim llama-server output -- see the fixture header for provenance
// (llama.cpp 0.5.0-dev, commit 9588757, CPU-only, with and without ngram
// speculation). Tests below fail if a marker stops matching real output, which
// is the whole point: every marker except one was confirmed against this file.
const FIXTURE = readFileSync(new URL('./fixtures/llama-server-log-real.txt', import.meta.url), 'utf-8');
const REAL_LINES = FIXTURE.split('\n').filter(line => line.trim() !== '' && !line.startsWith('#'));

// The one real line that legitimately carries no event (emitted by the same
// print_timings() call as the timing lines).
const NO_EVENT_LINE = 'graphs reused';

function real(needle: string): string {
  const line = REAL_LINES.find(candidate => candidate.includes(needle));
  if (!line) throw new Error('fixture line not found: ' + needle);
  return line;
}

// --- real captured lines -------------------------------------------------

test('parseLogLine: real load_model line -> loading', () => {
  expect(parseLogLine(real('load_model: loading model'))).toEqual([{ kind: 'loading' }]);
});

test('parseLogLine: real llama_server line -> ready', () => {
  expect(parseLogLine(real('llama_server: model loaded'))).toEqual([{ kind: 'ready' }]);
});

test('parseLogLine: real launch_slot_ line -> task-start', () => {
  expect(parseLogLine(real('launch_slot_:'))).toEqual([{ kind: 'task-start' }]);
});

test('parseLogLine: real prompt-processing line -> prefill event + framed broadcast', () => {
  expect(parseLogLine(real('prompt processing, n_tokens ='))).toEqual([{
    kind: 'prefill',
    prefillTps: 262.23,
    prefillProgress: 0.83,
    prefillTokens: 2048,
    frame: 'PREFILL_PROGRESS:0.83:262.23:2048',
  }]);
});

test('parseLogLine: real n_gen line -> gen event preferring tg_3s over tg', () => {
  // The line carries both 'tg = 24.30' and 'tg_3s = 24.55'; the 3s rolling
  // rate wins.
  expect(parseLogLine(real('n_gen =    100'))).toEqual([{
    kind: 'gen',
    genTps: 24.55,
    genTokens: 100,
    frame: 'GEN_PROGRESS:24.55:100',
  }]);
});

test('parseLogLine: real prompt eval time -> prompt timing patch for the task', () => {
  expect(parseLogLine(real('prompt eval time'))).toEqual([{
    kind: 'task-timing',
    taskId: '0',
    patch: { promptMs: 9944.17, promptTokens: 2463, promptTps: 247.68 },
  }]);
});

test('parseLogLine: real eval time -> generation timing patch for the task', () => {
  // llama-SERVER writes "105 tokens" here (the CLI's "runs" wording is a
  // different binary -- see the synthetic case below).
  // Matched by the timing value, not "eval time =": the prompt-eval line
  // contains that substring too, so a looser needle picks the wrong line.
  expect(parseLogLine(real('4284.46'))).toEqual([{
    kind: 'task-timing',
    taskId: '0',
    patch: { genMs: 4284.46, genTokens: 105, genTps: 24.27 },
  }]);
});

test('parseLogLine: real total time -> task-total with wall time in seconds', () => {
  expect(parseLogLine(real('total time ='))).toEqual([{
    kind: 'task-total',
    taskId: '0',
    wallTimeS: '14.23',
  }]);
});

test('parseLogLine: real graphs reused line -> no events', () => {
  expect(parseLogLine(real(NO_EVENT_LINE))).toEqual([]);
});

test('parseLogLine: real stop processing line -> task-aborted', () => {
  expect(parseLogLine(real('stop processing: n_tokens ='))).toEqual([{
    kind: 'task-aborted',
    taskId: '0',
  }]);
});

test('parseLogLine: real draft acceptance line -> draft patch', () => {
  expect(parseLogLine(real('draft acceptance'))).toEqual([{
    kind: 'task-draft',
    taskId: '0',
    patch: { draftAcceptRate: 0.1, draftAccepted: 5, draftGenerated: 50, draftMeanLen: 3.5 },
  }]);
});

test('parseLogLine: every captured line parses except graphs reused', () => {
  const silent = REAL_LINES.filter(line => parseLogLine(line).length === 0);
  expect(silent.map(line => (line.includes(NO_EVENT_LINE) ? NO_EVENT_LINE : line))).toEqual([NO_EVENT_LINE]);
});

test('parseLogLine: a print_timing line is classified by its content, not its prefix', () => {
  // Every timing line shares the "print_timing:" prefix (__func__ truncated to
  // 12 chars). The prefill line must not be swallowed by the gen/timing branch,
  // which is why 'prompt processing' is tested first.
  const prefill = parseLogLine(real('prompt processing, n_tokens ='));
  expect(prefill).toHaveLength(1);
  expect(prefill[0].kind).toBe('prefill');
});

// --- prefill edge cases --------------------------------------------------

test('parseLogLine: prompt-processing line without a progress figure -> no events', () => {
  expect(parseLogLine('slot print_timing: id  0 | task 0 | prompt processing, n_tokens = 512, t = 1.0 s')).toEqual([]);
});

test('parseLogLine: progress 1.00 is accepted', () => {
  const [event] = parseLogLine('prompt processing, n_tokens = 4096, progress = 1.00, 300.00 tokens per second');
  expect(event).toEqual({
    kind: 'prefill',
    prefillTps: 300,
    prefillProgress: 1,
    prefillTokens: 4096,
    frame: 'PREFILL_PROGRESS:1.00:300.00:4096',
  });
});

test('parseLogLine: progress 1.0 is NOT accepted (regex wants two decimals)', () => {
  // llama-server prints progress with %.2f, so '1.0' is not a shape it emits.
  expect(parseLogLine('prompt processing, n_tokens = 4096, progress = 1.0, 300.00 tokens per second')).toEqual([]);
});

test('parseLogLine: missing token count and rate fall back to "0" in the frame', () => {
  const [event] = parseLogLine('prompt processing, n_tokens = , progress = 0.50');
  expect(event).toEqual({
    kind: 'prefill',
    prefillTps: undefined,
    prefillProgress: 0.5,
    prefillTokens: undefined,
    frame: 'PREFILL_PROGRESS:0.50:0:0',
  });
});

// --- gen edge cases ------------------------------------------------------

test('parseLogLine: gen line without a rate -> no events', () => {
  expect(parseLogLine('slot print_timing: id  0 | task 0 | n_gen =  128')).toEqual([]);
});

test('parseLogLine: gen line falls back to tg when tg_3s is absent', () => {
  const [event] = parseLogLine('slot print_timing: id  0 | task 0 | n_gen = 64, tg = 12.50 t/s');
  expect(event).toEqual({ kind: 'gen', genTps: 12.5, genTokens: 64, frame: 'GEN_PROGRESS:12.50:64' });
});

test('parseLogLine: n_decoded is accepted in place of n_gen', () => {
  const [event] = parseLogLine('slot print_timing: id  0 | task 0 | n_decoded = 64, tg = 12.50 t/s');
  expect(event).toEqual({ kind: 'gen', genTps: 12.5, genTokens: 64, frame: 'GEN_PROGRESS:12.50:64' });
});

// --- timing edge cases ---------------------------------------------------

test('parseLogLine: eval time with the CLI wording "runs" -> no events', () => {
  // llama-cli/common writes "/ 105 runs"; llama-server writes "/ 105 tokens".
  // Only the server wording matches the timing regex. The server prefix is
  // supplied so the line reaches that regex instead of stopping at the guard.
  expect(parseLogLine('slot print_timing: id 0 | task 0 | eval time = 4284.46 ms / 105 runs (41.20 ms per token, 24.27 tokens per second)')).toEqual([]);
});

test('parseLogLine: unparseable total time still ends the task', () => {
  // The entry is dropped regardless: the service deletes before checking the
  // number, so a failed match must still yield the event.
  expect(parseLogLine('slot print_timing: id 0 | task 0 | total time = n/a')).toEqual([{
    kind: 'task-total',
    taskId: '0',
    wallTimeS: undefined,
  }]);
});

test('parseLogLine: timing segment without an id/task pair -> no events', () => {
  expect(parseLogLine('slot print_timing: total time = 14228.63 ms / 2568 tokens')).toEqual([]);
});

test('parseLogLine: draft acceptance without mean len -> draftMeanLen null', () => {
  const [event] = parseLogLine('slot print_timing: id 0 | task 0 | draft acceptance = 0.50000 (    1 accepted /    2 generated)');
  expect(event).toEqual({
    kind: 'task-draft',
    taskId: '0',
    patch: { draftAcceptRate: 0.5, draftAccepted: 1, draftGenerated: 2, draftMeanLen: null },
  });
});

test('parseLogLine: stop processing without a task number -> no events', () => {
  expect(parseLogLine('stop processing: n_tokens = 5, truncated = 0')).toEqual([]);
});

// --- fatal lines ---------------------------------------------------------

test('parseLogLine: fatal line -> fatal event, tail-truncated passthrough', () => {
  expect(parseLogLine('llama_server: fatal error: boom')).toEqual([{
    kind: 'fatal',
    message: 'Process error: llama_server: fatal error: boom',
  }]);
});

test('parseLogLine: fatal line mentioning failed-to-fit gets the VRAM message', () => {
  // The translation only applies to a line that is ALSO fatal -- 'failed to
  // fit params' alone is no longer fatal (see fatallogs.test.ts).
  expect(parseLogLine('llama_server: fatal error: failed to fit params to free device memory')).toEqual([{
    kind: 'fatal',
    message: 'Failed to allocate VRAM: Reduce n_gpu_layers or use a smaller model.',
  }]);
  expect(parseLogLine('failed to fit params to free device memory')).toEqual([]);
});

test('fatalMessage: keeps only the last 200 characters', () => {
  const line = 'x'.repeat(500) + 'END';
  const message = fatalMessage(line);
  // slice(-200) keeps the TAIL, so the trailing 'END' survives and the
  // leading 303 x's are dropped.
  expect(message).toBe('Process error: ' + 'x'.repeat(197) + 'END');
  expect(message.length).toBe('Process error: '.length + 200);
});

// --- classification order ------------------------------------------------

test('parseLogLine: the first matching marker wins', () => {
  // 'loading' is tested before 'ready' and before the timing markers.
  expect(parseLogLine('load_model: loading model / llama_server: model loaded')).toEqual([{ kind: 'loading' }]);
  expect(parseLogLine('llama_server: model loaded / prompt processing, n_tokens = 1, progress = 0.50')).toEqual([{ kind: 'ready' }]);
});

test('parseLogLine: unrecognised line -> no events', () => {
  expect(parseLogLine('llama_perf_context_print: total time = 1.00 ms')).toEqual([]);
  expect(parseLogLine('')).toEqual([]);
});
