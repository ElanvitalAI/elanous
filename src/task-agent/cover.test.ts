import { expect, test } from 'bun:test';
import { formatLandingThroughput, formatSevenVerbLive, formatTaskAgentCover,
  measureLandingThroughput as rawLandingThroughput, measureSevenVerbLive as rawSevenVerbLive,
  measureTaskAgentCover as rawTaskAgentCover, type TaskAgentCoverInput } from './cover.js';

const measureLandingThroughput = (input: TaskAgentCoverInput) => rawLandingThroughput({ liveLandMoves: [], ...input });
const measureSevenVerbLive = (input: TaskAgentCoverInput) => rawSevenVerbLive({ liveLandMoves: [], ...input });
const measureTaskAgentCover = (input: TaskAgentCoverInput) => rawTaskAgentCover({ liveLandMoves: [], ...input });

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
      { kind: 'land', result: 'done', taskId: 'ta-land' }, { kind: 'review', result: 'done' },
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

test('actual live land success is counted once with legacy action, while skipped and failed moves are excluded', () => {
  const input = {
    taskAgentActions: [{ kind: 'land' as const, result: 'done', taskId: 'ta-old' }],
    liveLandMoves: [
      { card: 'ta-old', executed: true, ok: true },
      { card: 'ta-new', executed: true, ok: true },
      { card: 'ta-new', executed: true, ok: true },
      { card: 'ta-skip', executed: false, ok: true },
      { card: 'ta-fail', executed: true, ok: false },
    ],
    allLands: Array.from({ length: 4 }, () => ({ step: 'merge', ok: true })),
  };
  expect(measureTaskAgentCover(input)[0]).toMatchObject({ byTaskAgent: 2, total: 4, ratio: 0.5 });
  expect(measureLandingThroughput(input).taskAgentLandings).toBe(2);
  expect(measureTaskAgentCover({ ...input, liveLandMoves: null })[0]).toMatchObject({ byTaskAgent: null, state: 'unreadable' });
  const landUnreadable = measureSevenVerbLive({ ...input, liveLandMoves: null, goalAsks: [], goalRuns: [] });
  expect(formatSevenVerbLive(landUnreadable)).toBe('7동사 live -/7 · 못 잼(착지 원장 null·절단) · 출처 없음 구현·정리');
  expect(rawTaskAgentCover({ taskAgentActions: input.taskAgentActions, allLands: input.allLands })[0])
    .toMatchObject({ byTaskAgent: null, state: 'unreadable' });
  expect(measureTaskAgentCover({ ...input, taskAgentActions: [{ kind: 'land', result: 'done' }] })[0])
    .toMatchObject({ byTaskAgent: null, state: 'unreadable' });
  expect(measureTaskAgentCover({ ...input, truncated: { taskAgentActions: false, allLands: false, liveLandMoves: true } })[0])
    .toMatchObject({ byTaskAgent: null, state: 'unreadable' });
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
    taskAgentActions: [{ kind: 'land' as const, result: 'done', taskId: 'ta-land' }, { kind: 'review' as const, result: 'done' }],
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
    taskAgentActions: [{ kind: 'land', result: 'done', taskId: 'ta-land' }, { kind: 'review', result: 'shadow' }],
    allLands: [{ step: 'merge', ok: true }, { step: 'merge', ok: true }],
  });
  expect(formatTaskAgentCover(rows[0]!)).toBe('land: TA 1/2 (50.0%) · live 1 · shadow 0 · steward-transition observed');
  expect(formatTaskAgentCover(rows[1]!)).toBe('review: TA 0/- (-) · live 0 · shadow 1 · steward-transition unmeasured');
  const unreadable = measureTaskAgentCover({ taskAgentActions: null, allLands: null });
  expect(formatTaskAgentCover(unreadable[0]!)).toBe('land: TA -/- (-) · live - · shadow - · steward-transition unmeasured');
  const incomplete = measureTaskAgentCover({ taskAgentActions: null, allLands: [{ step: 'merge', ok: true }] });
  expect(formatTaskAgentCover(incomplete[0]!)).toBe('land: TA -/1 (-) · live - · shadow - · steward-transition unmeasured');
});

test('review and land done are live, retry shadow is shadow-only, and liveVerbs counts only live verbs', () => {
  const measured = measureSevenVerbLive({
    taskAgentActions: [
      { kind: 'review', result: 'done' }, { kind: 'land', result: 'done', taskId: 'ta-land' }, { kind: 'retry', result: 'shadow' },
    ],
    allLands: [], goalAsks: [], goalRuns: [],
  });
  expect(measured.verbs).toEqual([
    { verb: '리뷰', source: 'review', liveDone: 1, shadow: 0, state: 'live' },
    { verb: '착지', source: 'land', liveDone: 1, shadow: 0, state: 'live' },
    { verb: '수리', source: 'retry', liveDone: 0, shadow: 1, state: 'shadow-only' },
    { verb: '검증', source: 'green', liveDone: 0, shadow: 0, state: 'none' },
    { verb: '저작', source: 'goal-ask+goal-run', liveDone: 0, shadow: 0, state: 'none' },
    { verb: '구현', source: null, liveDone: null, shadow: null, state: 'no-source' },
    { verb: '정리', source: null, liveDone: null, shadow: null, state: 'no-source' },
  ]);
  expect(measured.liveVerbs).toBe(2);
  expect(measured.measuredVerbs).toBe(5);
  expect(formatSevenVerbLive(measured)).toBe('7동사 live 2/7 · 출처 없음 구현·정리');
});

test('구현·정리 remain no-source even when the four action verbs are live', () => {
  const measured = measureSevenVerbLive({
    taskAgentActions: [{ kind: 'review', result: 'done' }, { kind: 'land', result: 'done', taskId: 'ta-land' }, { kind: 'retry', result: 'done' }, { kind: 'green', result: 'done' }],
    allLands: [], goalAsks: [], goalRuns: [],
  });
  expect(measured.verbs.filter((row) => row.state === 'no-source').map((row) => row.verb)).toEqual(['구현', '정리']);
  expect(measured.liveVerbs).toBe(4);
  expect(formatSevenVerbLive(measured)).toBe('7동사 live 4/7 · 출처 없음 구현·정리');
});

test('null or truncated taskAgentActions marks every verb unreadable and liveVerbs null, not 0', () => {
  const unreadable = measureSevenVerbLive({ taskAgentActions: null, allLands: [] });
  expect(unreadable.verbs.filter((row) => row.source !== null).every((row) => row.state === 'unreadable')).toBe(true);
  expect(unreadable.verbs.filter((row) => row.source === null).map((row) => row.verb)).toEqual(['구현', '정리']);
  expect(unreadable.verbs.every((row) => row.liveDone === null && row.shadow === null)).toBe(true);
  expect(unreadable.liveVerbs).toBe(null);
  expect(unreadable.measuredVerbs).toBe(5);
  expect(formatSevenVerbLive(unreadable)).toBe('7동사 live -/7 · 못 잼(행동·저작·골 원장 null·절단) · 출처 없음 구현·정리');

  const truncated = measureSevenVerbLive({
    taskAgentActions: [{ kind: 'review', result: 'done' }],
    allLands: [],
    truncated: { taskAgentActions: true, allLands: false },
  });
  expect(truncated.verbs.filter((row) => row.source !== null).every((row) => row.state === 'unreadable')).toBe(true);
  expect(truncated.liveVerbs).toBe(null);
});

test('authored goal joins a completed goal by id, not a dangling assigned id or failed goal', () => {
  const input = {
    taskAgentActions: [{ kind: 'review' as const, result: 'done' }, { kind: 'land' as const, result: 'done', taskId: 'ta-land' }, { kind: 'retry' as const, result: 'done' }, { kind: 'green' as const, result: 'done' }],
    allLands: [],
    goalAsks: [
      { authorRunId: 'author-ok', goalId: 'goal-ok' }, { authorRunId: 'author-ok', goalId: 'goal-ok' },
      { authorRunId: 'author-ok', goalId: 'goal-ok-2' },
      { authorRunId: 'author-failed', goalId: 'goal-failed' },
    ],
    goalRuns: [{ goalId: 'goal-ok', stage: 'merged', outcome: 'completed' }, { goalId: 'goal-ok-2', stage: 'merged', outcome: 'completed' }, { goalId: 'goal-failed', stage: 'failed', outcome: 'abandoned' }],
  };
  const measured = measureSevenVerbLive(input);
  expect(measured.verbs[4]).toEqual({ verb: '저작', source: 'goal-ask+goal-run', liveDone: 2, shadow: 0, state: 'live' });
  expect(measured.liveVerbs).toBe(5);
  expect(measured.measuredVerbs).toBe(5);
  expect(formatSevenVerbLive(measured)).toBe('7동사 live 5/7 · 출처 없음 구현·정리');
  const dangling = measureSevenVerbLive({ ...input, goalAsks: [{ authorRunId: 'author-failed', goalId: 'goal-failed' }], goalRuns: [{ goalId: 'goal-failed', stage: 'failed', outcome: 'abandoned' }] });
  expect(dangling.verbs[4]).toMatchObject({ liveDone: 0, state: 'none' });
  for (const patch of [{ goalAsks: null }, { goalRuns: null }, { truncated: { taskAgentActions: false, allLands: false, goalAsks: true } }, { truncated: { taskAgentActions: false, allLands: false, goalRuns: true } }]) {
    const unknown = measureSevenVerbLive({ ...input, ...patch });
    expect(unknown.verbs[4]).toMatchObject({ liveDone: null, state: 'unreadable' });
    expect(unknown.liveVerbs).toBeNull();
    expect(formatSevenVerbLive(unknown)).toContain('출처 없음 구현·정리');
  }
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

test('구현 counts card-bound runs whose own ledger recorded a successful merge, once per card', () => {
  const bindings = [
    { cardId: 'c-merged', runId: 'run-merged' },
    { cardId: 'c-child', runId: 'run-parent', runChildId: 'run-child' },
    { cardId: 'c-failed', runId: 'run-failed' },
    { cardId: 'c-launched', runId: 'run-launched' },
    { cardId: 'c-unbound', runId: null, runChildId: null },
    { cardId: 'c-merged', runId: 'run-merged' },
  ];
  const merges = new Map([
    ['run-merged', { merged: true }],
    ['run-child', { merged: true }],
    ['run-failed', { merged: false }],
    ['run-unrelated', { merged: true }],
  ]);
  const measured = measureSevenVerbLive({
    taskAgentActions: [], allLands: [], goalAsks: [], goalRuns: [],
    implementCardRuns: bindings, implementRunMerges: merges,
  });
  expect(measured.verbs[5]).toEqual({ verb: '구현', source: 'card-run+merged', liveDone: 2, shadow: 0, state: 'live' });
  expect(measured.liveVerbs).toBe(1);
  expect(measured.measuredVerbs).toBe(6);
  expect(formatSevenVerbLive(measured)).toBe('7동사 live 1/7 · 출처 없음 정리');
  // 결합이 하나도 완료로 이어지지 않으면 none(0) — 실패·발사만·무관·묶이지 않은 런은 완료로 세지 않는다.
  const none = measureSevenVerbLive({
    taskAgentActions: [], allLands: [], goalAsks: [], goalRuns: [],
    implementCardRuns: bindings.filter((binding) => binding.cardId !== 'c-merged' && binding.cardId !== 'c-child'),
    implementRunMerges: merges,
  });
  expect(none.verbs[5]).toEqual({ verb: '구현', source: 'card-run+merged', liveDone: 0, shadow: 0, state: 'none' });
  expect(none.liveVerbs).toBe(0);
  // 카드 없음([])은 측정된 0 이지 못 잼이 아니다.
  const empty = measureSevenVerbLive({
    taskAgentActions: [], allLands: [], goalAsks: [], goalRuns: [],
    implementCardRuns: [], implementRunMerges: new Map(),
  });
  expect(empty.verbs[5]).toEqual({ verb: '구현', source: 'card-run+merged', liveDone: 0, shadow: 0, state: 'none' });
});

test('KNOWHOW-PACK isolated card and run ledgers distinguish null implementation from unreadable input and bound cleanup outcomes', () => {
  const base: TaskAgentCoverInput = { taskAgentActions: [], liveLandMoves: [], allLands: [], goalAsks: [], goalRuns: [],
    implementCardRuns: [{ cardId: 'c1', runId: 'run-1' }], implementRunMerges: new Map([['run-1', { merged: true }]]),
    cleanupCards: [{ cardId: 'c1', outcome: 'complete' }, { cardId: 'c1', outcome: 'complete' },
      { cardId: 'c2', outcome: 'partial' }],
  };
  const measured = measureSevenVerbLive(base);
  expect(measured.verbs[5]).toMatchObject({ liveDone: 1, state: 'live' });
  expect(measured.verbs[6]).toEqual({ verb: '정리', source: 'card:postland-card+postLand', liveDone: 1, shadow: 0, state: 'live' });
  expect(measured.liveVerbs).toBe(2);
  expect(measureSevenVerbLive({ ...base, cleanupCards: [{ cardId: 'c2', outcome: 'partial' }] }).verbs[6])
    .toMatchObject({ liveDone: 0, state: 'none' });
  const missingCleanup = measureSevenVerbLive({ ...base, cleanupCards: null });
  expect(missingCleanup.verbs[6]).toMatchObject({ liveDone: null, state: 'unreadable' });
  expect(formatSevenVerbLive(missingCleanup)).toBe('7동사 live -/7 · 못 잼(정리 카드 원장 null·절단)');
  expect(measureSevenVerbLive({ ...base, implementCardRuns: null }).verbs[5])
    .toMatchObject({ reason: 'card-ledger-null', liveDone: null, state: 'unreadable' });
  expect(measureSevenVerbLive({ ...base, implementRunMerges: null }).verbs[5])
    .toMatchObject({ reason: 'run-ledger-null', liveDone: null, state: 'unreadable' });
  expect(measureSevenVerbLive({ ...base, truncated: { taskAgentActions: false, allLands: false, implementRunMerges: true } }).verbs[5])
    .toMatchObject({ reason: 'run-ledger-truncated', liveDone: null, state: 'unreadable' });
});

test('구현 stays no-source unwired, and unreadable card or merge ledgers never read as zero', () => {
  // 배선 없음(기본) — 종전 계약 그대로 no-source.
  const unwired = measureSevenVerbLive({ taskAgentActions: [], allLands: [], goalAsks: [], goalRuns: [] });
  expect(unwired.verbs[5]).toEqual({ verb: '구현', source: null, liveDone: null, shadow: null, state: 'no-source' });
  expect(unwired.measuredVerbs).toBe(5);
  expect(formatSevenVerbLive(unwired)).toBe('7동사 live 0/7 · 출처 없음 구현·정리');
  const merges = new Map([['run-merged', { merged: true }]]);
  for (const patch of [
    { implementCardRuns: null, implementRunMerges: merges },
    { implementCardRuns: [{ cardId: 'c-merged', runId: 'run-merged' }], implementRunMerges: null },
    { implementCardRuns: [{ cardId: 'c-merged', runId: 'run-merged' }], implementRunMerges: new Map(), truncated: { taskAgentActions: false, allLands: false, implementRunMerges: true } },
  ]) {
    const unknown = measureSevenVerbLive({ taskAgentActions: [], allLands: [], goalAsks: [], goalRuns: [], ...patch });
    expect(unknown.verbs[5]).toMatchObject({ verb: '구현', source: 'card-run+merged', liveDone: null, shadow: null, state: 'unreadable' });
    expect(unknown.liveVerbs).toBeNull();
    expect(formatSevenVerbLive(unknown)).toBe('7동사 live -/7 · 못 잼(구현 카드·런 원장 null·절단) · 출처 없음 정리');
  }
  // 한 심만 주어지면 다른 심은 null — 전체는 unreadable.
  const halfWired = measureSevenVerbLive({
    taskAgentActions: [], allLands: [], goalAsks: [], goalRuns: [],
    implementCardRuns: [{ cardId: 'c-merged', runId: 'run-merged' }],
  });
  expect(halfWired.verbs[5]).toMatchObject({ source: 'card-run+merged', liveDone: null, state: 'unreadable' });
  expect(halfWired.liveVerbs).toBeNull();
  const multipleFailures = measureSevenVerbLive({
    taskAgentActions: null, allLands: null, goalAsks: null, goalRuns: null,
    implementCardRuns: null, implementRunMerges: null,
  });
  expect(formatSevenVerbLive(multipleFailures)).toBe(
    '7동사 live -/7 · 못 잼(행동·저작·골·구현 카드·런 원장 null·절단) · 출처 없음 정리',
  );
});
