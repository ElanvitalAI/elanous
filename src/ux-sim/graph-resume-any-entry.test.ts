import { expect, test } from 'bun:test';
import { simulateGraphResumeAnyEntry } from './graph-resume-any-entry.js';

test('GRAPH-RESUME-ANY-ENTRY-SIM runs five resume paths through the production graph runner', async () => {
  const scenarios = await simulateGraphResumeAnyEntry();
  expect(scenarios.map(({ id }) => id)).toEqual([
    'hitl-receipt', 'budget-exceeded', 'repeated-approval', 'healed-edge', 'arg-instance',
  ]);
  expect(scenarios.every(({ invariant }) => invariant)).toBe(true);
  expect(scenarios.map(({ status }) => status)).toEqual(['done', 'done', 'done', 'done', 'done']);
});
