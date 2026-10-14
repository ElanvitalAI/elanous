import { expect, test } from 'bun:test';
import { repairNextMove } from './repair-next-move.js';

const input = { pr: 30, head: 'a'.repeat(40), branch: 'feature', mustFix: ['correct the guard'] };

test('review must-fix routes the existing narrow move through the graph to dispatch', () => {
  const first = repairNextMove({ ...input, priorNarrowAttempts: 0, priorAlternativeAttempts: 0 });
  expect(first).toMatchObject({ kind: 'dispatch', source: 'pr:30', judgement: { move: 'narrow-relaunch' }, route: { from: 'next-move', on: 'move', label: 'narrow-relaunch', to: 'dispatch', source: 'graph' } });
  const second = repairNextMove({ ...input, priorNarrowAttempts: 1, priorAlternativeAttempts: 0 });
  expect(second).toMatchObject({ kind: 'dispatch', judgement: { move: 'narrow-relaunch' }, route: { to: 'dispatch' } });
});

test('missing must-fix or exhausted alternative cannot dispatch a repair', () => {
  expect(repairNextMove({ ...input, mustFix: [], priorNarrowAttempts: 0, priorAlternativeAttempts: 0 })).toMatchObject({ kind: 'stop', reason: 'review must-fix text unavailable' });
  expect(repairNextMove({ ...input, priorNarrowAttempts: 2, priorAlternativeAttempts: 0 })).toMatchObject({ kind: 'stop', reason: 'repair convergence failed after two relaunches', judgement: { move: 'alternative' } });
});
