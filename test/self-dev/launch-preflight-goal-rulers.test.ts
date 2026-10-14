import { describe, expect, test } from 'bun:test';
import { decideAskPreflight, renderLaunchPreflight } from '../../src/self-dev/launch-preflight.js';

const options = {
  goalFile: 'goal.md',
  liveRunWindowMinutes: 30,
  recentChangeWindowDays: 7,
};

function deps(document: string) {
  return {
    readGoalDocument: () => document,
    tracedPaths: () => ['src/self-dev/launch-preflight.ts'],
    listOpenPrs: () => [],
    listUnfinishedRuns: () => [],
    countRecentChanges: () => ({}),
    listPreexistingFailureTestFiles: () => ({ state: 'checked' as const, files: [] }),
  };
}

describe('launch preflight goal rulers', () => {
  test('reports positive premise and multi-exit observations without blocking launch', () => {
    const document = [
      '서버 문은 이미 있다. `GET /v1/sessions`.',
      '판정 신호: 조건 = `/v1/sessions` 를 흉내 내는 목 서버를 띄운다; 관측 = 기록; 기대 = 받았다.',
      'function multipleReturns(ok: boolean): string { if (ok) return "yes"; return "no"; }',
    ].join('\n');
    const decision = decideAskPreflight(options, deps(document), false);

    expect(decision.result.premiseMockedBySignal).toEqual({ state: 'checked', count: 1 });
    expect(decision.result.invariantFunctionExits).toEqual({ state: 'checked', count: 1 });
    expect(decision.result.blockers).toEqual([]);
    expect(decision.shouldLaunch).toBe(true);
    expect(renderLaunchPreflight(decision.result)).toContain('전제를 목으로 세운 판정 신호: 1건 조회');
    expect(renderLaunchPreflight(decision.result)).toContain('반환 지점 둘 이상 함수: 1건 조회');
  });

  test('renders explicit zero counts for both rulers when no raw finding exists', () => {
    const decision = decideAskPreflight(options, deps('새 골을 만든다.\nfunction oneReturn(): number { return 1; }'), false);
    const rendered = renderLaunchPreflight(decision.result);

    expect(decision.result.premiseMockedBySignal).toEqual({ state: 'checked', count: 0 });
    expect(decision.result.invariantFunctionExits).toEqual({ state: 'checked', count: 0 });
    expect(rendered).toContain('전제를 목으로 세운 판정 신호: 0건 조회');
    expect(rendered).toContain('반환 지점 둘 이상 함수: 0건 조회');
    expect(decision.shouldLaunch).toBe(true);
  });

  test('preserves the target-path blocker when the goal document is unreadable', () => {
    const decision = decideAskPreflight(options, {
      ...deps('unused'),
      readGoalDocument: () => { throw new Error('EACCES'); },
    }, false);

    expect(decision.result.blockers.map((blocker) => blocker.kind)).toEqual(['no-target-paths', 'goal-unreadable']);
    expect(decision.shouldLaunch).toBe(false);
    expect(decision.result.premiseMockedBySignal).toMatchObject({ state: 'unknown', reason: '골 문서 판독 불가: EACCES' });
    expect(decision.result.invariantFunctionExits).toMatchObject({ state: 'unknown', reason: '골 문서 판독 불가: EACCES' });
  });

  test('reports unreadable goal rulers without adding a blocker', () => {
    const decision = decideAskPreflight(options, {
      ...deps('새 골을 만든다.'),
      findPremiseMockedBySignal: () => { throw new Error('ruler unavailable'); },
    }, false);
    const rendered = renderLaunchPreflight(decision.result);

    expect(decision.result.blockers).toEqual([]);
    expect(decision.shouldLaunch).toBe(true);
    expect(decision.result.premiseMockedBySignal).toMatchObject({ state: 'unknown', reason: '골 규율 판독 불가: ruler unavailable' });
    expect(decision.result.invariantFunctionExits).toMatchObject({ state: 'unknown', reason: '골 규율 판독 불가: ruler unavailable' });
    expect(rendered).toContain('전제를 목으로 세운 판정 신호: ⚠️ 미지 — 골 규율 판독 불가: ruler unavailable');
    expect(rendered).toContain('반환 지점 둘 이상 함수: ⚠️ 미지 — 골 규율 판독 불가: ruler unavailable');
  });
});
