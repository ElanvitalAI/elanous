import { expect, test } from 'bun:test';
import { detectWaitCycles } from './wait-cycle.js';

const now = 1_000_000;
const old = now - 600_000;

test('detects a two-seat cycle at the ten-minute boundary', () => {
  expect(detectWaitCycles([{ from: 'A', to: 'B', sinceMs: old }, { from: 'B', to: 'A', sinceMs: old }], now)).toEqual([['A', 'B']]);
});

test('requires all cycle dependencies to be old enough', () => {
  expect(detectWaitCycles([{ from: 'A', to: 'B', sinceMs: old }, { from: 'B', to: 'A', sinceMs: old + 1 }], now)).toEqual([]);
});

test('does not confuse a chain, unknown target or invalid clock with a cycle', () => {
  expect(detectWaitCycles([{ from: 'A', to: 'B', sinceMs: old }, { from: 'B', to: null, sinceMs: old }, { from: 'B', to: 'A', sinceMs: NaN }, { from: 'C', to: 'C', sinceMs: now + 1 }], now)).toEqual([]);
  expect(() => detectWaitCycles([], NaN)).toThrow(RangeError);
});

test('groups overlapping cycles and leaves upstream waiters out', () => {
  const edges = [['D', 'A'], ['A', 'B'], ['B', 'A'], ['B', 'C'], ['C', 'B'], ['Z', 'Z']].map(([from, to]) => ({ from: from!, to: to!, sinceMs: old }));
  expect(detectWaitCycles(edges, now)).toEqual([['A', 'B', 'C'], ['Z']]);
});
