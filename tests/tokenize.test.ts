// ponytail: documents current behavior — the tokenizer has no escape-sequence
// support and collapses adjacent empty quotes; see src/server/lib/tokenize.js.
import { test, expect } from 'bun:test';
import { tokenizeCommand, extractLastFlagValue } from '../src/server/lib/tokenize';

const CASES: [string, string[]][] = [
  // ponytail: empty string and whitespace-only yield NO empty tokens.
  ['', []],
  ['   ', []],
  ['foo bar baz', ['foo', 'bar', 'baz']],
  ['a  b', ['a', 'b']],
  ['tab\there', ['tab', 'here']],
  ['trailing ', ['trailing']],
  ['  leading', ['leading']],
  ['"quoted arg" plain', ['quoted arg', 'plain']],
  ['plain "quoted arg" tail', ['plain', 'quoted arg', 'tail']],
  ["'single quoted with space'", ['single quoted with space']],
  ['a"b c"d', ['ab cd']],
  ["embedded''empty", ['embeddedempty']],
  ['""', []],
  ["''", []],
  ['a\\b c', ['a\\b', 'c']],
  ['café 日本語', ['café', '日本語']],
  ["--chat-template-kwargs '{\"preserve_thinking\": true}'", ['--chat-template-kwargs', '{"preserve_thinking": true}']],
  ['--port 8080 --model "my model.gguf"', ['--port', '8080', '--model', 'my model.gguf']],
  ['a "b c', ['a', 'b c']],
  ["a 'b c", ['a', 'b c']],
];

test('tokenizeCommand: all fixture cases match current behavior', () => {
  for (const [input, expected] of CASES) {
    expect(tokenizeCommand(input)).toEqual(expected);
  }
});

test('extractLastFlagValue: later occurrence wins', () => {
  expect(extractLastFlagValue(['--port', '8080', '--port', '9000'], '--port')).toBe('9000');
});
test('extractLastFlagValue: returns undefined when flag absent', () => {
  expect(extractLastFlagValue(['-m', 'x'], '--port')).toBeUndefined();
});
test('extractLastFlagValue: returns undefined when flag is last token', () => {
  expect(extractLastFlagValue(['--model'], '--model')).toBeUndefined();
});