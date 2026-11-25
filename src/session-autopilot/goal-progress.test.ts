import { expect, test } from 'bun:test';
import { checklistCountProgress, observeChecklistHighWater, type ChecklistCountObservation } from './goal-progress.js';

const before: ChecklistCountObservation = { goalId: 'pin:a', version: '0.3.36', status: 'green', target: 10, count: 3 };
test('only an increase toward the same goal and checklist count is progress', () => {
  expect(checklistCountProgress(before, { ...before, count: 4 })).toBe(true);
  expect(checklistCountProgress(before, { ...before })).toBe(false);
  expect(checklistCountProgress(before, { ...before, count: 2 })).toBe(false);
  expect(checklistCountProgress(before, { ...before, count: 4, goalId: 'pin:b' })).toBe(false);
  expect(checklistCountProgress(before, { ...before, count: 4, version: '0.3.37' })).toBe(false);
  expect(checklistCountProgress(before, { ...before, count: 4, status: 'yellow' })).toBe(false);
  expect(checklistCountProgress(before, { ...before, count: 4, target: 11 })).toBe(false);
});
test('a fall and rebound below the high water mark cannot repeatedly grant progress', () => {
  const first = observeChecklistHighWater(undefined, before);
  expect(first.progress).toBe(false);
  const rise = observeChecklistHighWater(first.highWater, { ...before, count: 5 });
  expect(rise.progress).toBe(true);
  const fall = observeChecklistHighWater(rise.highWater, { ...before, count: 3 });
  expect(fall.progress).toBe(false);
  const rebound = observeChecklistHighWater(fall.highWater, { ...before, count: 5 });
  expect(rebound.progress).toBe(false);
  expect(observeChecklistHighWater(rebound.highWater, { ...before, count: 6 }).progress).toBe(true);
  expect(observeChecklistHighWater(rebound.highWater, { ...before, goalId: 'other', count: 9 }).progress).toBe(false);
});

test('missing, invalid, or already complete observations do not grant progress', () => {
  expect(checklistCountProgress(undefined, before)).toBe(false);
  expect(checklistCountProgress(before, undefined)).toBe(false);
  expect(checklistCountProgress(before, { ...before, count: NaN })).toBe(false);
  expect(checklistCountProgress({ ...before, count: -1 }, before)).toBe(false);
  expect(checklistCountProgress({ ...before, count: 10 }, { ...before, count: 11 })).toBe(false);
  expect(checklistCountProgress({ ...before, goalId: '' }, { ...before, goalId: '', count: 4 })).toBe(false);
});
