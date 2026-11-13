import { expect, test } from 'bun:test';
import { decideHqPriorityCandidate } from './arbiter.contract.js';

const at = 1000;
const up = { reachable: true, at };
const down = { reachable: false, at };

test('A36 keeps mshq while reachable and chooses node-b before aws1', () => {
  expect(decideHqPriorityCandidate({ now: at, observations: { 'mshq': up, 'node-b': up, 'aws1': up } }))
    .toEqual({ kind: 'hold', host: 'mshq' });
  expect(decideHqPriorityCandidate({ now: at, observations: { 'mshq': down, 'node-b': up, 'aws1': up } }))
    .toEqual({ kind: 'candidate', host: 'node-b', prior: ['mshq'] });
  expect(decideHqPriorityCandidate({ now: at, observations: { 'mshq': down, 'node-b': down, 'aws1': up } }))
    .toEqual({ kind: 'candidate', host: 'aws1', prior: ['mshq', 'node-b'] });
});

test('A36 declares entire HQ unavailable only after three fresh down observations', () => {
  expect(decideHqPriorityCandidate({ now: at, observations: { 'mshq': down, 'node-b': down, 'aws1': down } }))
    .toEqual({ kind: 'office-unavailable', hosts: ['mshq', 'node-b', 'aws1'] });
  expect(decideHqPriorityCandidate({ now: at, observations: { 'mshq': down, 'node-b': down } }))
    .toEqual({ kind: 'unknown', host: 'aws1', reason: 'missing-or-stale-observation' });
  expect(decideHqPriorityCandidate({ now: at + 1501, observations: { 'mshq': down, 'node-b': down, 'aws1': up } }))
    .toEqual({ kind: 'unknown', host: 'mshq', reason: 'missing-or-stale-observation' });
  expect(decideHqPriorityCandidate({ now: at, observations: { 'mshq': down, 'aws1': up } }))
    .toEqual({ kind: 'unknown', host: 'node-b', reason: 'missing-or-stale-observation' });
});

test('A36 treats missing or malformed reachability as unknown before any lower host', () => {
  for (const malformed of [undefined, null, 0, 'false']) {
    const observation = { at, reachable: malformed } as unknown as { at: number; reachable: boolean };
    expect(decideHqPriorityCandidate({ now: at, observations: { 'mshq': observation, 'node-b': up, 'aws1': up } }))
      .toEqual({ kind: 'unknown', host: 'mshq', reason: 'missing-or-stale-observation' });
    expect(decideHqPriorityCandidate({ now: at, observations: { 'mshq': down, 'node-b': observation, 'aws1': up } }))
      .toEqual({ kind: 'unknown', host: 'node-b', reason: 'missing-or-stale-observation' });
    expect(decideHqPriorityCandidate({ now: at, observations: { 'mshq': down, 'node-b': down, 'aws1': observation } }))
      .toEqual({ kind: 'unknown', host: 'aws1', reason: 'missing-or-stale-observation' });
  }
  for (const observedAt of [Number.NaN, at + 1, at - 1501]) {
    expect(decideHqPriorityCandidate({ now: at, observations: {
      'mshq': down, 'node-b': { reachable: false, at: observedAt }, 'aws1': up,
    } })).toEqual({ kind: 'unknown', host: 'node-b', reason: 'missing-or-stale-observation' });
  }
});
