import { expect, test } from 'bun:test';
import { simulateGraphRunLifecycleWorld } from './graph-run-lifecycle-world.js';

test('GRAPH-INSTANCE-PAUSE-CANCEL-FORK preserves lifecycle decisions across node-owner death', async () => {
  const scenarios = await simulateGraphRunLifecycleWorld();
  expect(scenarios.map(({ id }) => id)).toEqual([
    'pause-after-owner-death', 'cancel-after-owner-death', 'fork-after-owner-death',
  ]);
  expect(scenarios.every(({ invariant }) => invariant)).toBe(true);
  expect(scenarios.map(({ status }) => status)).toEqual(['done', 'cancelled', 'done']);
});
