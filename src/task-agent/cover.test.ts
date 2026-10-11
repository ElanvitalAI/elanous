import { expect, test } from 'bun:test';
import { formatLandingThroughput, formatTaskAgentCover, measureLandingThroughput, measureTaskAgentCover } from './cover.js';

test('daily landing funnel reproduces the 10-08 launch, card PR, and TASK-AGENT landing formula', () => {
  const row = measureLandingThroughput({
    taskAgentActions: [], allLands: [], launched: 327, cardPrs: 10, pendingLandingAgeSeconds: [600, 7_200],
  });
  expect(row).toMatchObject({
    launched: 327, cardPrs: 10, taskAgentLandings: 0,
    launchToPrRatio: 10 / 327, prToLandingRatio: 0,
    failureReasons: { load: 0, oom: 0, 'time-limit': 0, conflict: 0, review: 0, other: 0 },
    pendingLandings: 2, oldestPendingAgeSeconds: 7_200,
  });
  expect(formatLandingThroughput(row)).toBe('처리량(1d) 발사 327 → 카드 PR 10 → TA 착지 0 (발사→PR 3.1% · PR→착지 0.0%) · 착지 실패 부하 0 · OOM 0 · 시간 한도 0 · 충돌 0 · 리뷰 0 · 기타 0 · 착지 대기 2건, 최장 2.0h');
});

test('failure distribution maps failed actions once and keeps unreadable sources unknown', () => {
  const row = measureLandingThroughput({
    taskAgentActions: [
      { kind: 'retry', result: 'failed', reason: 'load average pressure' },
      { kind: 'retry', result: 'failed', reason: 'OOMKilled' },
      { kind: 'retry', result: 'failed', reason: 'step-timeout elapsed' },
      { kind: 'land', result: 'failed', reason: 'merge conflict' },
      { kind: 'review', result: 'failed', reason: 'review command failed' },
      { kind: 'retry', result: 'failed', reason: 'unclassified provider failure' },
      { kind: 'retry', result: 'done', reason: 'no failure' },
    ],
    allLands: [], pendingLandingAgeSeconds: [],
  });
  expect(row.failureReasons).toEqual({ load: 1, oom: 1, 'time-limit': 1, conflict: 1, review: 1, other: 1 });
  expect(row.pendingLandings).toBe(0);
  expect(formatLandingThroughput(row)).toContain('착지 대기 0건, 최장 없음');

  const unreadable = measureLandingThroughput({
    taskAgentActions: null, allLands: [], launched: null, cardPrs: null, pendingLandingAgeSeconds: null,
  });
  expect(unreadable).toMatchObject({
    launched: null, cardPrs: null, taskAgentLandings: null, launchToPrRatio: null, prToLandingRatio: null,
    failureReasons: null, pendingLandings: null, oldestPendingAgeSeconds: null,
  });
  expect(formatLandingThroughput(unreadable)).toContain('착지 실패 못 잼 · 착지 대기 -건, 최장 못 잼');
});

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

test('card denominator counts distinct cards with a done action per verb, leaving land untouched', () => {
  const rows = measureTaskAgentCover({
    taskAgentActions: [
      { kind: 'review', result: 'done', taskId: 'c1' }, { kind: 'review', result: 'done', taskId: 'c1' },
      { kind: 'review', result: 'done', taskId: 'c2' }, { kind: 'review', result: 'failed', taskId: 'c3' },
      { kind: 'review', result: 'done', taskId: 'outside' }, { kind: 'land', result: 'done', taskId: 'c1' },
    ],
    allLands: [{ step: 'merge', ok: true }, { step: 'merge', ok: true }],
    taskCards: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }],
  });
  expect(rows[1]).toMatchObject({ verb: 'review', byTaskAgent: 2, total: 3, ratio: 2 / 3, state: 'measured', stewardTransition: 'observed' });
  expect(rows[2]).toMatchObject({ verb: 'retry', byTaskAgent: 0, total: 3, ratio: 0, state: 'measured', stewardTransition: 'not-observed' });
  expect(rows[3]).toMatchObject({ verb: 'green', total: 3, state: 'measured' });
  expect(rows[0]).toMatchObject({ verb: 'land', byTaskAgent: 1, total: 2, ratio: 0.5, state: 'measured' });
});

test('card denominator: no cards is no-denominator, unreadable ledger is unreadable (never zero)', () => {
  const actions = [{ kind: 'review' as const, result: 'done', taskId: 'c1' }];
  expect(measureTaskAgentCover({ taskAgentActions: actions, allLands: [], taskCards: [] })[1])
    .toMatchObject({ verb: 'review', byTaskAgent: 0, total: 0, ratio: null, state: 'no-denominator', stewardTransition: 'unmeasured' });
  expect(measureTaskAgentCover({ taskAgentActions: actions, allLands: [], taskCards: null })[1])
    .toMatchObject({ verb: 'review', byTaskAgent: null, total: null, ratio: null, state: 'unreadable', stewardTransition: 'unmeasured' });
  expect(measureTaskAgentCover({ taskAgentActions: null, allLands: [], taskCards: [{ id: 'c1' }] })[1])
    .toMatchObject({ byTaskAgent: null, total: null, state: 'unreadable' });
});
