import { expect, test } from 'bun:test';
import { formatTaskAgentCover, measureTaskAgentCover } from './cover.js';

test('four successful merges and one TASK-AGENT land yield a measured quarter', () => {
  const rows = measureTaskAgentCover({
    taskAgentActions: [
      { kind: 'land', result: 'done' }, { kind: 'review', result: 'done' },
      { kind: 'review', result: 'done' }, { kind: 'retry', result: 'shadow' },
    ],
    allLands: [
      ...Array.from({ length: 4 }, () => ({ step: 'merge', ok: true })),
      { step: 'merge', ok: false }, { step: 'preflight', ok: true },
    ],
  });
  expect(rows[0]).toMatchObject({ verb: 'land', byTaskAgent: 1, total: 4, observedActions: 1, ratio: 0.25, state: 'measured', liveActions: 1, shadowActions: 0, stewardTransition: 'observed' });
  expect(rows[1]).toMatchObject({ verb: 'review', byTaskAgent: 2, total: null, observedActions: 2, ratio: null, state: 'no-denominator', liveActions: 2, shadowActions: 0, stewardTransition: 'unmeasured' });
  expect(rows[2]).toMatchObject({ verb: 'retry', byTaskAgent: 0, total: null, observedActions: 1, ratio: null, state: 'no-denominator', liveActions: 0, shadowActions: 1, stewardTransition: 'unmeasured' });
  expect(rows[3]).toMatchObject({ verb: 'green', byTaskAgent: 0, total: null, observedActions: 0, ratio: null, state: 'no-denominator', liveActions: 0, shadowActions: 0, stewardTransition: 'unmeasured' });
});

test('empty observed sources have no denominator, not a zero ratio; unreadable differs from empty', () => {
  expect(measureTaskAgentCover({ taskAgentActions: [], allLands: [] })[0]).toMatchObject({
    verb: 'land', byTaskAgent: 0, total: 0, observedActions: 0, ratio: null, state: 'no-denominator',
    liveActions: 0, shadowActions: 0, stewardTransition: 'unmeasured',
  });
  expect(measureTaskAgentCover({ taskAgentActions: null, allLands: [] })[0]).toMatchObject({
    verb: 'land', byTaskAgent: null, total: 0, observedActions: null, ratio: null, state: 'unreadable',
    liveActions: null, shadowActions: null, stewardTransition: 'unmeasured',
  });
  expect(measureTaskAgentCover({ taskAgentActions: null, allLands: [] })[1]).toMatchObject({
    verb: 'review', byTaskAgent: null, total: null, observedActions: null, ratio: null, state: 'unreadable',
    liveActions: null, shadowActions: null, stewardTransition: 'unmeasured',
  });
  expect(measureTaskAgentCover({ taskAgentActions: [], allLands: null })[0]).toMatchObject({
    verb: 'land', byTaskAgent: 0, total: null, observedActions: 0, ratio: null, state: 'unreadable',
    liveActions: 0, shadowActions: 0, stewardTransition: 'unmeasured',
  });
});

test('a bounded source never yields a measured land ratio or an invented total', () => {
  const input = {
    taskAgentActions: [{ kind: 'land' as const, result: 'done' }, { kind: 'review' as const, result: 'done' }],
    allLands: [{ step: 'merge', ok: true }, { step: 'merge', ok: true }],
  };
  const limitedLands = measureTaskAgentCover({ ...input, truncated: { taskAgentActions: false, allLands: true } });
  expect(limitedLands[0]).toMatchObject({ verb: 'land', byTaskAgent: 1, total: null, observedActions: 1, ratio: null, state: 'unreadable', liveActions: 1, shadowActions: 0, stewardTransition: 'unmeasured' });
  const limitedActions = measureTaskAgentCover({ ...input, truncated: { taskAgentActions: true, allLands: false } });
  expect(limitedActions[0]).toMatchObject({ byTaskAgent: null, total: 2, observedActions: null, ratio: null, state: 'unreadable' });
  expect(limitedActions[1]).toMatchObject({ byTaskAgent: null, total: null, observedActions: null, ratio: null, state: 'unreadable', liveActions: null, shadowActions: null, stewardTransition: 'unmeasured' });
});

test('failed live actions and shadow proposals are distinct from successful substitution', () => {
  const [land] = measureTaskAgentCover({
    taskAgentActions: [{ kind: 'land', result: 'failed' }, { kind: 'land', result: 'shadow' }],
    allLands: [{ step: 'merge', ok: true }],
  });
  expect(land).toMatchObject({ byTaskAgent: 0, total: 1, ratio: 0, observedActions: 2,
    liveActions: 1, shadowActions: 1, stewardTransition: 'not-observed' });
  expect(formatTaskAgentCover(land!)).toBe('land: TA 0/1 (0.0%) · live 1 · shadow 1 · steward-transition not-observed');
});

test('one-line formatter preserves measured and unknown denominators', () => {
  const rows = measureTaskAgentCover({
    taskAgentActions: [{ kind: 'land', result: 'done' }, { kind: 'review', result: 'shadow' }],
    allLands: [{ step: 'merge', ok: true }, { step: 'merge', ok: true }],
  });
  expect(formatTaskAgentCover(rows[0]!)).toBe('land: TA 1/2 (50.0%) · live 1 · shadow 0 · steward-transition observed');
  expect(formatTaskAgentCover(rows[1]!)).toBe('review: TA 0/- (-) · live 0 · shadow 1 · steward-transition unmeasured');
  const unreadable = measureTaskAgentCover({ taskAgentActions: null, allLands: null });
  expect(formatTaskAgentCover(unreadable[0]!)).toBe('land: TA -/- (-) · live - · shadow - · steward-transition unmeasured');
  const incomplete = measureTaskAgentCover({ taskAgentActions: null, allLands: [{ step: 'merge', ok: true }] });
  expect(formatTaskAgentCover(incomplete[0]!)).toBe('land: TA -/1 (-) · live - · shadow - · steward-transition unmeasured');
});
