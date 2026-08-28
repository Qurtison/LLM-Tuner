import { test, expect } from 'bun:test';
import {
  splitCsvLine,
  parseNumOrNull,
  csvValue,
  csvQuote,
} from '../src/server/lib/csv';

// ponytail: documents current behavior — splitCsvLine returns [] for empty input
test('splitCsvLine: empty string returns []', () => {
  expect(splitCsvLine('')).toEqual([]);
});

test('splitCsvLine: plain comma split', () => {
  expect(splitCsvLine('a,b,c')).toEqual(['a', 'b', 'c']);
});

test('splitCsvLine: quoted field with embedded comma', () => {
  expect(splitCsvLine('a,"b,c",d')).toEqual(['a', 'b,c', 'd']);
});

test('splitCsvLine: quoted field with embedded quote is escaped', () => {
  expect(splitCsvLine('plain,"embedded "" quote",x')).toEqual(['plain', 'embedded " quote', 'x']);
});

test('splitCsvLine: trailing comma yields empty final field', () => {
  expect(splitCsvLine('1,2,3,')).toEqual(['1', '2', '3', '']);
});

// ponytail: documents current behavior — the 4-quote sequence """" collapses
// to a single quote char then the next char; no infinite loop (regression test).
test('splitCsvLine: 4-quote sequence collapses safely', () => {
  expect(splitCsvLine('""""x')).toEqual(['"x']);
});

// ponytail: documents current behavior — an unterminated quote keeps consuming
// to end of line as a single field (no closing quote -> stays in field).
test('splitCsvLine: unterminated quoted field stays in field', () => {
  expect(splitCsvLine('"unterminated')).toEqual(['unterminated']);
});

// ponytail: documents current behavior — `,`"`"` parses as [empty, empty]:
// the comma starts field 2, then """" is an empty quoted field.
test('splitCsvLine: empty quoted field after comma', () => {
  expect(splitCsvLine(',""')).toEqual(['', '']);
});

test('parseNumOrNull: zero survives (not collapsed to null)', () => {
  expect(parseNumOrNull('0')).toBe(0);
  expect(parseNumOrNull('0.0')).toBe(0);
});

test('parseNumOrNull: non-numeric/empty/null/undefined -> null', () => {
  expect(parseNumOrNull('abc')).toBeNull();
  expect(parseNumOrNull('')).toBeNull();
  expect(parseNumOrNull(null)).toBeNull();
  expect(parseNumOrNull(undefined)).toBeNull();
});

test('parseNumOrNull: trims whitespace', () => {
  expect(parseNumOrNull('  3  ')).toBe(3);
});

test('csvValue: null/undefined -> empty string', () => {
  expect(csvValue(null)).toBe('');
  expect(csvValue(undefined)).toBe('');
});

// ponytail: documents current behavior — NaN/Infinity become '' (not stringified).
test('csvValue: NaN/Infinity -> empty string', () => {
  expect(csvValue(NaN)).toBe('');
  expect(csvValue(Infinity)).toBe('');
  expect(csvValue(-Infinity)).toBe('');
});

test('csvValue: newlines collapsed to spaces', () => {
  expect(csvValue('a\nb')).toBe('a b');
  expect(csvValue('a\r\nb')).toBe('a b');
});

test('csvQuote: wraps comma/quote/newline fields', () => {
  expect(csvQuote('a,b')).toBe('"a,b"');
  expect(csvQuote('a"b')).toBe('"a""b"');
  expect(csvQuote('a\nb')).toBe('"a\nb"');
});

test('csvQuote: plain field left unquoted', () => {
  expect(csvQuote('plain')).toBe('plain');
});

test('csvQuote: null/undefined -> empty quoted pair', () => {
  expect(csvQuote(null)).toBe('""');
  expect(csvQuote(undefined)).toBe('""');
});
