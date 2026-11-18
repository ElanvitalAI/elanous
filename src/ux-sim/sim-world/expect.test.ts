import { describe, expect, test } from 'bun:test';
import { classifySimWorldOutcome, judgeSimWorldScenario, lookupSimWorldExpectation, parseSimWorldExpectTable, resolveSimWorldExpectation } from './expect.js';
import { checkSimWorldRatchet } from './ratchet.js';
import type { SimWorldActual } from './types.js';

// Case table (SIM-WORLD §4 + 대표 red-reason bar + OPS-RULES §14 three-way) written before the code:
// expected × actual × previously green × promote × observed reason → verdict. Every verdict is an independent literal.
// reason column: 'same' = observed equals the row's redReason · 'other' = a different reason · 'none' = no reason reported.
type Reason = 'same' | 'other' | 'none';
const CASES: [expected: 'red' | 'green', actual: 'fail' | 'pass', previouslyGreen: boolean, promote: boolean, reason: Reason, verdict: string][] = [
  ['red', 'fail', false, false, 'same', 'xfail'],
  ['red', 'fail', false, false, 'other', 'wrong-reason-red'],
  ['red', 'fail', false, false, 'none', 'unmeasured'],
  ['red', 'fail', false, true, 'same', 'regression'],
  ['red', 'pass', false, false, 'none', 'promote-required'],
  ['red', 'pass', false, true, 'none', 'promoted'],
  ['red', 'fail', true, false, 'same', 'ratchet-violation'],
  ['red', 'fail', true, true, 'same', 'ratchet-violation'],
  ['red', 'pass', true, false, 'none', 'ratchet-violation'],
  ['red', 'pass', true, true, 'none', 'ratchet-violation'],
  ['green', 'fail', false, false, 'none', 'regression'],
  ['green', 'fail', false, true, 'none', 'regression'],
  ['green', 'pass', false, false, 'none', 'pass'],
  ['green', 'pass', false, true, 'none', 'pass'],
  ['green', 'fail', true, false, 'other', 'regression'],
  ['green', 'fail', true, true, 'none', 'regression'],
  ['green', 'pass', true, false, 'none', 'pass'],
  ['green', 'pass', true, true, 'none', 'pass'],
];
const RED_REASON = 'runner.ts:2732 memory fixed to []';
const observed = (reason: Reason) => reason === 'same' ? 'runner.ts:2732 memory fixed to []' : reason === 'other' ? 'unknown provider "test-fake-llm"' : null;

describe('sim-world verdict case table', () => {
  test.each(CASES)('expected %s · actual %s · previously green %p · promote %p · reason %s → %s', (expected, actual, previouslyGreen, promote, reason, verdict) => {
    expect(judgeSimWorldScenario({ expected, actual, previouslyGreen, promote, redReason: expected === 'red' ? RED_REASON : null, observedReason: observed(reason) }))
      .toBe(verdict as never);
  });

  // Rule 14 rows: known bad first, then absent; none of them is ever a pass.
  const RULE14: [SimWorldActual, 'red' | 'green' | null, string][] = [
    ['infra-error', 'green', 'infra-error'],
    ['infra-error', null, 'infra-error'],
    ['malformed', 'green', 'malformed'],
    ['malformed', null, 'malformed'],
    ['absent', 'green', 'unmeasured'],
    ['absent', 'red', 'unmeasured'],
    ['pass', null, 'unlisted'],
    ['fail', null, 'unlisted'],
  ];
  test.each(RULE14)('actual %s · expected %p → %s', (actual, expected, verdict) => {
    expect(judgeSimWorldScenario({ expected, actual, previouslyGreen: false, promote: false, redReason: null, observedReason: null })).toBe(verdict as never);
  });

  const OUTCOMES: [unknown, string, string | null, string | null][] = [
    [undefined, 'absent', 'scenario returned no outcome', null],
    [null, 'absent', 'scenario returned no outcome', null],
    [{ ok: 'yes' }, 'malformed', 'malformed scenario outcome: {"ok":"yes"}', null],
    [{ ok: false }, 'malformed', 'malformed scenario outcome: {"ok":false}', null],
    [{ ok: false, diff: 'x', reason: 7 }, 'malformed', 'malformed scenario outcome: {"ok":false,"diff":"x","reason":7}', null],
    [[true], 'malformed', 'malformed scenario outcome: [true]', null],
    ['ok', 'malformed', 'malformed scenario outcome: "ok"', null],
    [{ ok: true }, 'pass', null, null],
    [{ ok: false, diff: 'got 0' }, 'fail', 'got 0', null],
    [{ ok: false, diff: 'got 0', reason: 'depth 3' }, 'fail', 'got 0', 'depth 3'],
  ];
  for (const [raw, actual, diff, reason] of OUTCOMES) {
    test(`scenario outcome ${JSON.stringify(raw) ?? 'undefined'} → ${actual} (rule 14)`, () => {
      expect(classifySimWorldOutcome(raw)).toEqual({ actual, diff, reason } as never);
    });
  }
});

describe('sim-world expectation table', () => {
  const table = parseSimWorldExpectTable(JSON.stringify({ schema: 1, entries: {
    'ta/A01': { expect: 'green', greenSince: '2026-11-18', reason: 'legacy baseline' },
    'ta/A01@graph': { expect: 'red', reason: 'graph engine not wired', redReason: 'si-engine graph: no driver' },
    'memory/M01': { expect: 'red', reason: 'memory fixed empty', redReason: 'runner.ts:2732 memory fixed to []' },
  } }));

  test('engine-specific row wins over the engine-agnostic row', () => {
    expect(lookupSimWorldExpectation(table, 'ta', 'A01', 'graph')?.key).toBe('ta/A01@graph');
    expect(lookupSimWorldExpectation(table, 'ta', 'A01', 'legacy')?.key).toBe('ta/A01');
    expect(lookupSimWorldExpectation(table, 'ta', 'A02', 'legacy')).toBeNull();
  });

  test('promote = base red and head green in the same PR; previously green = base greenSince', () => {
    const head = parseSimWorldExpectTable(JSON.stringify({ schema: 1, entries: {
      'memory/M01': { expect: 'green', greenSince: '2026-11-20', reason: 'scopes landed' } } }));
    expect(resolveSimWorldExpectation(head, table, 'memory', 'M01', 'legacy')).toEqual({ expected: 'red', promote: true, previouslyGreen: false, redReason: 'runner.ts:2732 memory fixed to []' });
    expect(resolveSimWorldExpectation(table, null, 'ta', 'A01', 'legacy')).toEqual({ expected: 'green', promote: false, previouslyGreen: true, redReason: null });
    expect(resolveSimWorldExpectation(table, null, 'ta', 'A09', 'legacy')).toEqual({ expected: null, promote: false, previouslyGreen: false, redReason: null });
  });

  test('a new row added in this PR is judged by the head row', () => {
    const base = parseSimWorldExpectTable('{"schema":1,"entries":{}}');
    expect(resolveSimWorldExpectation(table, base, 'memory', 'M01', 'graph')).toEqual({ expected: 'red', promote: false, previouslyGreen: false, redReason: 'runner.ts:2732 memory fixed to []' });
  });

  test.each([
    ['{"schema":2,"entries":{}}', 'sim-world expect table must declare schema: 1'],
    ['{"schema":1,"entries":{"nope/M01":{"expect":"red","reason":"x"}}}', 'sim-world expect key is invalid: nope/M01'],
    ['{"schema":1,"entries":{"ta/A01":{"expect":"amber","reason":"x"}}}', 'sim-world expect row needs expect red|green: ta/A01'],
    ['{"schema":1,"entries":{"ta/A01":{"expect":"red","reason":" "}}}', 'sim-world expect row needs a reason: ta/A01'],
    ['{"schema":1,"entries":{"ta/A01":{"expect":"red","reason":"x"}}}', 'sim-world expect red row needs a literal redReason: ta/A01'],
    ['{"schema":1,"entries":{"ta/A01":{"expect":"green","reason":"x"}}}', 'sim-world expect green row needs greenSince: ta/A01'],
  ])('refuses a malformed table loudly: %s', (text, message) => {
    expect(() => parseSimWorldExpectTable(text)).toThrow(message);
  });
});

describe('sim-world ratchet', () => {
  const base = parseSimWorldExpectTable(JSON.stringify({ schema: 1, entries: {
    'graph/B03': { expect: 'green', greenSince: '2026-11-18', reason: 'static fan-out' },
    'graph/B01': { expect: 'red', reason: 'depth 3', redReason: 'r' },
  } }));

  test('promotion red → green and new rows pass the ratchet', () => {
    const head = parseSimWorldExpectTable(JSON.stringify({ schema: 1, entries: {
      'graph/B03': { expect: 'green', greenSince: '2026-11-18', reason: 'static fan-out' },
      'graph/B01': { expect: 'green', greenSince: '2026-11-20', reason: 'depth 5' },
      'graph/B02': { expect: 'red', reason: 'new', redReason: 'r' },
    } }));
    expect(checkSimWorldRatchet(base, head)).toEqual([]);
  });

  test('green → red, a removed greenSince, a deleted row and red-with-greenSince are each refused', () => {
    expect(checkSimWorldRatchet(base, parseSimWorldExpectTable(JSON.stringify({ schema: 1, entries: {
      'graph/B03': { expect: 'red', reason: 'flaky', redReason: 'r' }, 'graph/B01': { expect: 'red', reason: 'depth 3', redReason: 'r' } } }))))
      .toEqual([{ key: 'graph/B03@legacy', kind: 'green-to-red' }, { key: 'graph/B03@graph', kind: 'green-to-red' }]);
    expect(checkSimWorldRatchet(base, parseSimWorldExpectTable(JSON.stringify({ schema: 1, entries: {
      'graph/B03': { expect: 'green', greenSince: '2026-11-19', reason: 'x' }, 'graph/B01': { expect: 'red', reason: 'depth 3', redReason: 'r' } } }))))
      .toEqual([{ key: 'graph/B03', kind: 'green-since-changed' }]);
    expect(checkSimWorldRatchet(base, parseSimWorldExpectTable(JSON.stringify({ schema: 1, entries: {
      'graph/B03': { expect: 'green', greenSince: '2026-11-18', reason: 'x' } } }))))
      .toEqual([{ key: 'graph/B01', kind: 'deleted' }]);
    expect(checkSimWorldRatchet(base, parseSimWorldExpectTable(JSON.stringify({ schema: 1, entries: {
      'graph/B03': { expect: 'green', greenSince: '2026-11-18', reason: 'x' }, 'graph/B01': { expect: 'red', reason: 'd', redReason: 'r' },
      'graph/B09': { expect: 'red', greenSince: '2026-11-18', reason: 'walked back', redReason: 'r' } } }))))
      .toEqual([{ key: 'graph/B09', kind: 'red-with-green-since' }]);
  });

  // MF1 (Terra #38444): the ratchet judges the EFFECTIVE (scenario, engine) expectation, not raw rows.
  const table = (entries: Record<string, unknown>) => parseSimWorldExpectTable(JSON.stringify({ schema: 1, entries }));
  const GREEN = { expect: 'green', greenSince: '2026-11-18', reason: 'g' };
  const RED = { expect: 'red', reason: 'r', redReason: 'not wired' };

  test('common green → engine-specific red is refused for that engine', () => {
    expect(checkSimWorldRatchet(table({ 'ta/A01': GREEN }), table({ 'ta/A01': GREEN, 'ta/A01@graph': RED })))
      .toEqual([{ key: 'ta/A01@graph', kind: 'green-to-red' }]);
  });

  test('engine-specific green → common red is refused (row deleted and effective green-to-red)', () => {
    expect(checkSimWorldRatchet(table({ 'ta/A01@graph': GREEN }), table({ 'ta/A01': RED })))
      .toEqual([{ key: 'ta/A01@graph', kind: 'deleted' }, { key: 'ta/A01@graph', kind: 'green-to-red' }]);
  });

  test('common red → engine-specific green is a promote and allowed', () => {
    expect(checkSimWorldRatchet(table({ 'ta/A01': RED }), table({ 'ta/A01': RED, 'ta/A01@graph': GREEN }))).toEqual([]);
  });

  test('common green + engine green unchanged passes', () => {
    expect(checkSimWorldRatchet(table({ 'ta/A01': GREEN, 'ta/A01@graph': GREEN }), table({ 'ta/A01': GREEN, 'ta/A01@graph': GREEN }))).toEqual([]);
  });
});
