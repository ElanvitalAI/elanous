import { expect, test } from 'bun:test';
import { summarizeGateProgress } from './gate-shard-dispatch.js';

test('gate progress summary counts settled serial groups and records the active host group duration', () => {
  expect(summarizeGateProgress({ executor: 'host', nowMs: 65_000, groups: [
    { id: 'src-cli', state: 'done', host: 'node-c', startedAtMs: 10_000, endedAtMs: 30_000 },
    { id: 'src-rest', state: 'running', host: 'node-c', startedAtMs: 40_000 },
    { id: 'test', state: 'pending', host: 'node-c' },
  ] })).toEqual({
    executor: 'host', host: 'node-c', completed: 1, total: 3, failed: 0,
    groups: [
      { id: 'src-cli', state: 'done', host: 'node-c', elapsedMs: 20_000 },
      { id: 'src-rest', state: 'running', host: 'node-c', elapsedMs: 25_000 },
      { id: 'test', state: 'pending', host: 'node-c', elapsedMs: null },
    ],
  });
});

test('gate progress summary reports multi-host Pod shards and terminal failures without changing the gate verdict', () => {
  expect(summarizeGateProgress({ executor: 'pod', nowMs: 90_000, groups: [
    { id: 'pod-0', state: 'done', host: 'pool-a', startedAtMs: 0, endedAtMs: 80_000 },
    { id: 'pod-1', state: 'timeout', host: 'pool-b', startedAtMs: 10_000 },
    { id: 'pod-2', state: 'pending' },
  ] })).toEqual({
    executor: 'pod', host: 'pool-a,pool-b', completed: 2, total: 3, failed: 1,
    groups: [
      { id: 'pod-0', state: 'done', host: 'pool-a', elapsedMs: 80_000 },
      { id: 'pod-1', state: 'timeout', host: 'pool-b', elapsedMs: 80_000 },
      { id: 'pod-2', state: 'pending', host: null, elapsedMs: null },
    ],
  });
});
