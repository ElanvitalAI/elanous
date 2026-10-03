import { expect, test } from 'bun:test';
import { leaksInternal, toPublicText } from './public-text';

const uuid = 'a1b2c3d4-1234-abcd-9876-0123456789ab';

test('public text removes each private marker and shortens run identifiers before token filtering', () => {
  const privateText = `\u{1F451} 🪑 🅞 OP MK TC UX /Users/alice/work /home/bob/log /private/tmp/key C:\\Users\\alice\\key email@example.com ${'a'.repeat(40)} run-${uuid}`;
  expect(leaksInternal(privateText)).toEqual(expect.arrayContaining([
    '\u{1F451}', '🪑', '🅞', 'OP', 'MK', 'TC', 'UX', '/Users/alice/work', '/home/bob/log',
    '/private/tmp/key', 'C:\\Users\\alice\\key', 'email@example.com', 'a'.repeat(40), `run-${uuid}`,
  ]));
  expect(toPublicText(privateText)).toContain('COO CMO CTO CXO');
  expect(toPublicText(privateText)).toContain('run-a1b2c3');
  expect(leaksInternal(toPublicText(privateText))).toEqual([]);
});

test('seat replacements observe word boundaries, preserve public names and do not mutate inspection input', () => {
  const input = 'SCOPE OP OPERATOR MK TC UX CO OPMK COO CMO CTO CXO';
  expect(leaksInternal(input)).toEqual(['OP', 'MK', 'TC', 'UX']);
  expect(toPublicText(input)).toBe('SCOPE COO OPERATOR CMO CTO CXO CO OPMK COO CMO CTO CXO');
  expect(input).toContain(' OP ');
});

test('all public transformations obey the zero-leak invariant individually and together', () => {
  for (const raw of ['\u{1F451}', '🅣', '/Users/a/b', '/home/a/b', '/private/a/b', 'C:\\temp\\file',
    'x@y.io', 'X'.repeat(40), `run-${uuid}`, 'OP', 'MK', 'TC', 'UX',
    `OP /home/a/b run-${uuid} ${'z'.repeat(45)} x@y.io`,
    'a'.repeat(20) + '\u{1F451}' + 'b'.repeat(20)]) {
    expect(leaksInternal(toPublicText(raw))).toEqual([]);
  }
});

test('repo file names with hyphens survive; real key shapes do not (review must-fix · INSIDE1a)', () => {
  const doc = 'docs/manual/MANUAL-mission-fabric-integration-2026-09-03.md';
  expect(leaksInternal(doc)).toEqual([]);
  expect(toPublicText(doc)).toBe(doc);
  const key = `sk-${'Ab3'.repeat(10)}`;
  expect(leaksInternal(`token ${key}`)).toEqual([key]);
  expect(toPublicText(`token ${key}`)).toBe('token ');
});

test('machine names are masked like the public capture mode', () => {
  expect(leaksInternal('node-b 에 3칸')).toEqual(['node-b']);
  expect(toPublicText('node-b 에 3칸 · MSB2 도')).toBe('remote-1 에 3칸 · remote-2 도');
  expect(leaksInternal(toPublicText('node-b'))).toEqual([]);
});
