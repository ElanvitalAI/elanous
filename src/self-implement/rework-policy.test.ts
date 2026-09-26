import { lookupLlmTierSpec } from '../model-tier/index.js';
import { describe, it, expect } from 'bun:test';
import {
  resolveAdaptiveMaxRework, resolveAdaptiveMaxReworkDecision, measureReviewFindingRepeat, shouldEscalateModel, resolveEscalateTier, resolveEscalateTarget, resolveExplicitChildEscalateTarget,
  buildReworkFeature, failIndicator, parseContractConflictRelaxation, parseReworkBudgetDecision, appendReworkHistory, applyReworkBudgetDecision, resolveContractConflictDisposition, resolveReworkBudgetCarry, stripReworkBudgetHeaders, countConsecutiveMustFixIds, assessConvergence, isSubstantiveReviewFindingRepeat, resolveConvergenceDisposition, mergeReworkNotes, resolveReworkKind,
  type ReworkStopReason,
} from './rework-policy.js';
import { MUST_FIX_REFUTATION_ACKNOWLEDGEMENT, parseMustFixRefutations } from './reflect-mustfix.js';
import { reviewFindingKey } from '../agent-substrate/review-finding-key.js';

// ★ self-dev rework 소진-복구 정책(대표 PLAN·2026-07-22) 계약.
describe('resolveAdaptiveMaxRework — #3 적응형 연장', () => {
  it('2개 미만이면 baseMax 유지(판단 근거 부족)', () => {
    expect(resolveAdaptiveMaxRework(2, [])).toBe(2);
    expect(resolveAdaptiveMaxRework(2, [5])).toBe(2);
  });
  it('감소 추세면 +1 연장(수렴 여유)', () => {
    expect(resolveAdaptiveMaxRework(2, [5, 3])).toBe(3);   // 진전
  });
  it('정체/악화면 연장 없음(무한루프·비용 가드)', () => {
    expect(resolveAdaptiveMaxRework(2, [3, 3])).toBe(2);   // 정체
    expect(resolveAdaptiveMaxRework(2, [3, 5])).toBe(2);   // 악화
  });
  it('미설정 hardCap 기본값은 이전 5보다 큰 6이다', () => {
    expect(resolveAdaptiveMaxRework(5, [3, 1])).toBe(6);
  });
  it('설정한 hardCap 상한을 모든 이력 경로에서 존중한다', () => {
    expect(resolveAdaptiveMaxRework(2, [3, 1], 3)).toBe(3);
    expect(resolveAdaptiveMaxRework(5, [3, 1], 5)).toBe(5);
    expect(resolveAdaptiveMaxRework(5, [], 3)).toBe(3);
    expect(resolveAdaptiveMaxRework(5, [1], 3)).toBe(3);
  });
});

describe('resolveAdaptiveMaxReworkDecision — 반복 근거를 보존하는 적응형 연장', () => {
  const alpha = 'Guard `alpha` and `alphaState` before persisting.';
  const beta = 'Guard `beta` and `betaState` before persisting.';
  const alphaBeta = 'Guard `alpha`, `alphaState`, and `beta` before persisting.';

  it('실패 수 감소는 완전 심볼 겹침 반복보다 우선해 연장한다', () => {
    expect(resolveAdaptiveMaxReworkDecision(2, [5, 3], 6, [[alphaBeta], [alphaBeta]])).toMatchObject({
      maxRework: 3, reason: 'extended-by-fail-count', failCountTrend: 'decreased', repeatSignal: 'repeat',
    });
    expect(resolveAdaptiveMaxReworkDecision(2, [5, 3], 6, [[alphaBeta], [alpha]])).toMatchObject({
      maxRework: 3, reason: 'extended-by-fail-count', failCountTrend: 'decreased', repeatSignal: 'repeat',
    });
  });

  it('감소와 비반복이면 종전처럼 연장하며 다수 지적 중 반복도 개선 증거를 덮지 않는다', () => {
    expect(resolveAdaptiveMaxReworkDecision(2, [5, 3], 6, [[alpha], [beta]])).toMatchObject({
      maxRework: 3, reason: 'extended-by-fail-count', failCountTrend: 'decreased', repeatSignal: 'no-repeat',
    });
    expect(resolveAdaptiveMaxReworkDecision(2, [5, 3], 6, [[beta, alpha], [alpha]])).toMatchObject({
      maxRework: 3, reason: 'extended-by-fail-count', failCountTrend: 'decreased', repeatSignal: 'repeat',
    });
  });

  it('측정 불가·빈 이력·첫 라운드 및 라운드 안 중복은 반복 없음으로 접지 않고 종전 상한 동작을 유지한다', () => {
    expect(resolveAdaptiveMaxReworkDecision(2, [5, 3], 6, [['No cited symbol.'], [alpha]])).toMatchObject({
      maxRework: 3, reason: 'extended-by-fail-count', failCountTrend: 'decreased', repeatSignal: 'unmeasurable',
    });
    expect(measureReviewFindingRepeat([[], [alpha]])).toBe('no-repeat');
    expect(measureReviewFindingRepeat([[alpha]])).toBe('insufficient-history');
    expect(measureReviewFindingRepeat([['same finding', 'same finding'], ['same finding']])).toBe('unmeasurable');
    expect(resolveAdaptiveMaxRework(2, [5, 3], 6, [['No cited symbol.'], [alpha]])).toBe(3);
  });

  it('리뷰 없는 게이트 라운드는 오래된 리뷰 반복을 현재 실패 감소와 결합하지 않는다', () => {
    expect(resolveAdaptiveMaxReworkDecision(2, [5, 3], 6, [[alpha], [alpha], undefined])).toMatchObject({
      maxRework: 3, reason: 'extended-by-fail-count', failCountTrend: 'decreased', repeatSignal: 'insufficient-history',
    });
  });

  it('실패 수가 감소하지 않고 반복이면 기존처럼 반복 차단 이유로 연장하지 않는다', () => {
    expect(resolveAdaptiveMaxReworkDecision(2, [3, 3], 6, [[alphaBeta], [alphaBeta]])).toMatchObject({
      maxRework: 2, reason: 'repeat-blocked-extension', failCountTrend: 'not-decreased', repeatSignal: 'repeat',
    });
  });

  it('실패 수가 감소하지 않고 반복이 아니면 종전처럼 연장하지 않는다', () => {
    expect(resolveAdaptiveMaxReworkDecision(2, [3, 3], 6, [[alpha], [beta]])).toMatchObject({
      maxRework: 2, reason: 'fail-count-not-decreased', failCountTrend: 'not-decreased', repeatSignal: 'no-repeat',
    });
  });

  it('두 라운드 모두 실패 0은 정체와 구별해 zero-failures 이유로 연장하지 않는다', () => {
    expect(resolveAdaptiveMaxReworkDecision(2, [0, 0], 6, [[alpha], [beta]])).toMatchObject({
      maxRework: 2, reason: 'zero-failures', failCountTrend: 'zero-failures', repeatSignal: 'no-repeat',
    });
    expect(resolveAdaptiveMaxReworkDecision(2, [5, 5], 6, [[alpha], [beta]])).toMatchObject({
      maxRework: 2, reason: 'fail-count-not-decreased', failCountTrend: 'not-decreased', repeatSignal: 'no-repeat',
    });
  });

  it('hardCap이 최종 후보를 제한하면 이력 부족·비감소 경로도 제한 근거를 우선 보존한다', () => {
    expect(resolveAdaptiveMaxReworkDecision(5, [], 3)).toMatchObject({
      maxRework: 3, reason: 'hard-cap', failCountTrend: 'insufficient-history', repeatSignal: 'insufficient-history',
    });
    expect(resolveAdaptiveMaxReworkDecision(5, [3, 3], 3, [[alpha], [beta]])).toMatchObject({
      maxRework: 3, reason: 'hard-cap', failCountTrend: 'not-decreased', repeatSignal: 'no-repeat',
    });
  });

  it('기존 적응형 공개 경로는 hardCap 설정을 출처로 한 전체 확인 요청을 함께 노출한다', () => {
    const decision = resolveAdaptiveMaxReworkDecision(3, [3, 3, 3], 3, [[alpha], [alpha], [alpha]]);
    expect(decision.convergence).toMatchObject({
      threshold: { nonConvergenceScore: 3 }, thresholdReached: true, requiresFullReview: true,
    });
    expect(decision.convergenceDisposition).toEqual({ stop: false, reason: undefined, requiresFullReview: true });
  });
});

describe('countConsecutiveMustFixIds — 현재 라운드까지의 must-fix 연속성', () => {
  it('빈 이력 또는 빈 현재 목록은 빈 결과와 0을 낸다', () => {
    expect(countConsecutiveMustFixIds([])).toEqual({ counts: [], longestId: null, longestConsecutiveRounds: 0 });
    expect(countConsecutiveMustFixIds([['MF-aaaaaaaa'], []])).toEqual({ counts: [], longestId: null, longestConsecutiveRounds: 0 });
  });

  it('세 라운드 모두에 있는 정규화 키는 연속 3라운드다', () => {
    expect(countConsecutiveMustFixIds([['symbol:["validateRun"]'], ['symbol:["validateRun"]'], ['symbol:["validateRun"]']]))
      .toEqual({ counts: [{ id: 'symbol:["validateRun"]', consecutiveRounds: 3 }], longestId: 'symbol:["validateRun"]', longestConsecutiveRounds: 3 });
  });

  it('같은 심볼을 인용하지만 문면이 달라진 지적은 연속 2라운드로 센다', () => {
    const first = reviewFindingKey('Call `validateRun` before persisting the review result.');
    const second = reviewFindingKey('Guard the result write through `validateRun` after validation.');
    expect(first).toEqual({ key: 'symbol:["validateRun"]', source: 'symbol' });
    expect(second).toEqual(first);
    expect(countConsecutiveMustFixIds([[first.key], [second.key]])).toEqual({
      counts: [{ id: first.key, consecutiveRounds: 2 }],
      longestId: first.key,
      longestConsecutiveRounds: 2,
    });
  });

  it('어느 식별자도 두 라운드에 걸치지 않으면 최장 연속은 1이다', () => {
    expect(countConsecutiveMustFixIds([['MF-aaaaaaaa'], ['MF-bbbbbbbb'], ['MF-cccccccc']]))
      .toEqual({ counts: [{ id: 'MF-cccccccc', consecutiveRounds: 1 }], longestId: 'MF-cccccccc', longestConsecutiveRounds: 1 });
  });

  it('중간 라운드에서 사라진 식별자가 재등장해도 연속을 이어 붙이지 않는다', () => {
    expect(countConsecutiveMustFixIds([['MF-aaaaaaaa'], [], ['MF-aaaaaaaa']]))
      .toEqual({ counts: [{ id: 'MF-aaaaaaaa', consecutiveRounds: 1 }], longestId: 'MF-aaaaaaaa', longestConsecutiveRounds: 1 });
  });

  it('동률은 현재 라운드 최초 등장 순서로 고르고 라운드 내 중복은 한 번으로 센다', () => {
    expect(countConsecutiveMustFixIds([
      ['MF-aaaaaaaa', 'MF-bbbbbbbb'],
      ['MF-aaaaaaaa', 'MF-bbbbbbbb'],
      ['MF-bbbbbbbb', 'MF-aaaaaaaa', 'MF-aaaaaaaa'],
    ])).toEqual({
      counts: [
        { id: 'MF-bbbbbbbb', consecutiveRounds: 3 },
        { id: 'MF-aaaaaaaa', consecutiveRounds: 3 },
      ],
      longestId: 'MF-bbbbbbbb',
      longestConsecutiveRounds: 3,
    });
  });
});

describe('assessConvergence — 라운드 횡단 누적 비수렴 판정', () => {
  const threshold = { nonConvergenceScore: 4 };

  it('공개 중단 사유는 실제 전체 확인 경로가 생성하는 non-convergence만 허용한다', () => {
    const reason: ReworkStopReason = 'non-convergence';
    expect(reason).toBe('non-convergence');
    // @ts-expect-error budget decisions do not create a convergence stop reason.
    const speculativeReason: ReworkStopReason = 'budget-decision';
    void speculativeReason;
  });

  it('정체·악화와 반복 must-fix를 모든 인접 라운드에 걸쳐 하나의 누적 점수로 낸다', () => {
    const alpha = 'Guard `alpha` and `alphaState` before persisting.';
    const beta = 'Guard `beta` and `betaState` before persisting.';
    expect(assessConvergence(
      [3, 3, 3, 3, 1, 1, 3],
      [[alpha], [alpha], [alpha], [alpha], [beta], [beta], [beta]],
      threshold,
    )).toMatchObject({
      nonConvergenceScore: 10,
      threshold,
      thresholdReached: true,
      requiresFullReview: true,
      repeatedMustFixFindings: 5,
      nonDecreasingFailTransitions: 5,
      totalMustFixComparisons: 6,
      unmeasurableMustFixComparisons: 0,
    });
  });

  it('함수 이름 하나만 공유하는 서로 다른 결함은 반복으로 접지 않는다', () => {
    const previous = 'Guard `childInstanceScope` before persisting the instance root.';
    const current = 'Record `childInstanceScope` when the child worktree is created.';
    expect(isSubstantiveReviewFindingRepeat(current, previous)).toBe(false);
    expect(assessConvergence([5, 3], [[previous], [current]], { nonConvergenceScore: 1 })).toMatchObject({
      nonConvergenceScore: 0,
      repeatedMustFixFindings: 0,
      totalMustFixComparisons: 1,
      thresholdReached: false,
    });
  });

  it('같은 두 심볼 결함을 다른 산문으로 지적하면 반복으로 판정한다', () => {
    const previous = 'Guard `persistReview` and `reviewResult` before writing.';
    const current = 'Do not write `reviewResult` until `persistReview` validates the result.';
    expect(isSubstantiveReviewFindingRepeat(current, previous)).toBe(true);
    const assessment = assessConvergence([5, 3], [[previous], [current]], { nonConvergenceScore: 1 });
    expect(assessment).toMatchObject({
      nonConvergenceScore: 1,
      repeatedMustFixFindings: 1,
      totalMustFixComparisons: 1,
      unmeasurableMustFixComparisons: 0,
      thresholdReached: true,
      requiresFullReview: true,
    });
    expect(resolveConvergenceDisposition(assessment, undefined)).toEqual({ stop: false, reason: undefined, requiresFullReview: true });
  });

  it('같은 두 심볼 결함에 인용 심볼을 하나 더 달아도 포함 겹침 반복으로 판정한다', () => {
    const previous = 'Guard `persistReview` and `reviewResult` before writing.';
    const current = 'Validate `persistReview`, `reviewResult`, and `reviewLog` before persisting.';
    expect(isSubstantiveReviewFindingRepeat(current, previous)).toBe(true);
    expect(measureReviewFindingRepeat([[previous], [current]])).toBe('repeat');
  });

  it('표기 정규화로 접힌 심볼의 완전 포함을 반복으로 판정한다', () => {
    const previous = 'Fix `terminal.id` and `terminalId` and `bar`.';
    const current = 'Same defect in `terminalId` and `bar` and `baz`.';
    expect(isSubstantiveReviewFindingRepeat(current, previous)).toBe(true);
    expect(assessConvergence([5, 3], [[previous], [current]], { nonConvergenceScore: 1 }).repeatedMustFixComparisons)
      .toContainEqual(expect.objectContaining({ sharedSymbolCount: 2, overlapRatio: 1 }));
  });

  it('정규화해도 하나만 공유한 지적은 반복으로 판정하지 않는다', () => {
    expect(isSubstantiveReviewFindingRepeat(
      'Fix `terminalId` and `baz`.',
      'Fix `terminal.id` and `bar`.',
    )).toBe(false);
  });

  it('정규화된 심볼 집합이 완전 포함되지 않으면 반복으로 판정하지 않는다', () => {
    expect(isSubstantiveReviewFindingRepeat(
      'Fix `alpha` and `gamma` and `delta`.',
      'Fix `alpha` and `beta` and `gamma`.',
    )).toBe(false);
  });

  it('심볼이 없거나 비교 불가능한 같은 산문은 반복으로 판정하지 않는다', () => {
    const proseOnly = 'Persist the review result only after validation.';
    expect(isSubstantiveReviewFindingRepeat(proseOnly, proseOnly)).toBe(false);
    expect(measureReviewFindingRepeat([[proseOnly], [proseOnly]])).toBe('unmeasurable');
  });

  it('세 반복 지적은 지적 수를 가리키는 계수에 셋으로 누적한다', () => {
    const repeated = 'Guard `alpha` and `alphaState` before persisting.';
    expect(assessConvergence([5, 3], [[repeated, repeated, repeated], [repeated, repeated, repeated]], { nonConvergenceScore: 3 }))
      .toMatchObject({ repeatedMustFixFindings: 1, totalMustFixComparisons: 1 });
    expect(assessConvergence([5, 3], [[
      'Guard `alpha` and `alphaState` before persisting.',
      'Guard `beta` and `betaState` before persisting.',
      'Guard `gamma` and `gammaState` before persisting.',
    ], [
      'Guard `alpha` and `alphaState` before persisting.',
      'Guard `beta` and `betaState` before persisting.',
      'Guard `gamma` and `gammaState` before persisting.',
    ]], { nonConvergenceScore: 3 })).toMatchObject({
      repeatedMustFixFindings: 3,
      totalMustFixComparisons: 9,
    });
  });

  it('비교 불가 사유를 양쪽·이전만·현재만 인용 부재로 전수 집계하고 비교 가능한 짝은 제외한다', () => {
    const assessment = assessConvergence(
      [5, 3],
      [
        ['No cited symbol.', 'Prior cites `previousOnly`.', 'Prior cites `comparable`.'],
        ['Also prose only.', 'Current cites `currentOnly`.', 'Current cites `comparable`.'],
      ],
      threshold,
    );
    expect(assessment).toMatchObject({
      nonConvergenceScore: 0,
      repeatedMustFixFindings: 0,
      nonDecreasingFailTransitions: 0,
      totalMustFixComparisons: 9,
      unmeasurableMustFixComparisons: 5,
      unmeasurableMustFixComparisonsWithoutCitations: 1,
      unmeasurableMustFixComparisonsWithoutPreviousCitations: 2,
      unmeasurableMustFixComparisonsWithoutCurrentCitations: 2,
    });
    expect(
      assessment.unmeasurableMustFixComparisonsWithoutCitations
      + assessment.unmeasurableMustFixComparisonsWithoutPreviousCitations
      + assessment.unmeasurableMustFixComparisonsWithoutCurrentCitations,
    ).toBe(assessment.unmeasurableMustFixComparisons);
    expect(assessment.repeatedMustFixComparisons.filter(({ comparable }) => comparable)).toHaveLength(4);
  });

  it('보존할 비교 배열이 잘려도 실제 비교 총수와 사유별 비교 불가 수는 독립적으로 읽힌다', () => {
    const previous = Array.from({ length: 8 }, (_, index) => index < 4
      ? `No cited prior defect ${String.fromCharCode(97 + index)}.`
      : `Prior cites \`prior${String.fromCharCode(97 + index)}\`.`,
    );
    const current = Array.from({ length: 8 }, (_, index) => index < 2
      ? `No cited current defect ${String.fromCharCode(97 + index)}.`
      : `Current cites \`current${String.fromCharCode(97 + index)}\`.`,
    );
    const assessment = assessConvergence([5, 3], [previous, current], threshold);
    expect(assessment).toMatchObject({
      totalMustFixComparisons: 64,
      unmeasurableMustFixComparisons: 40,
      unmeasurableMustFixComparisonsWithoutCitations: 8,
      unmeasurableMustFixComparisonsWithoutPreviousCitations: 24,
      unmeasurableMustFixComparisonsWithoutCurrentCitations: 8,
      repeatedMustFixFindings: 0,
    });
    expect(
      assessment.unmeasurableMustFixComparisonsWithoutCitations
      + assessment.unmeasurableMustFixComparisonsWithoutPreviousCitations
      + assessment.unmeasurableMustFixComparisonsWithoutCurrentCitations,
    ).toBe(assessment.unmeasurableMustFixComparisons);
    expect(assessment.repeatedMustFixComparisons).toHaveLength(64);
  });

  it('하나의 라운드면 반복 비교와 반복 점수를 만들지 않는다', () => {
    expect(assessConvergence([5], [['Guard `alpha` before persisting.']], threshold)).toMatchObject({
      nonConvergenceScore: 0,
      repeatedMustFixFindings: 0,
      repeatedMustFixComparisons: [],
      totalMustFixComparisons: 0,
      unmeasurableMustFixComparisons: 0,
    });
  });

  it('감소와 새 지적만 있으면 임계를 넘지 않으며 같은 입력에는 같은 결과를 낸다', () => {
    const input = [['Guard `alpha` before persisting.'], ['Guard `beta` before persisting.'], ['Guard `gamma` before persisting.']];
    const first = assessConvergence([5, 3, 1], input, threshold);
    expect(first).toMatchObject({
      nonConvergenceScore: 0,
      threshold,
      thresholdReached: false,
      requiresFullReview: false,
      repeatedMustFixFindings: 0,
      nonDecreasingFailTransitions: 0,
      totalMustFixComparisons: 2,
      unmeasurableMustFixComparisons: 0,
    });
    expect(assessConvergence([5, 3, 1], input, threshold)).toEqual(first);
  });

  it('임계는 호출자가 제공한 값으로 보존하며 음수는 0으로 정규화해 거짓 확인을 만들지 않는다', () => {
    const repeated = [['Guard `alpha` and `alphaState` before persisting.'], ['Guard `alpha` and `alphaState` before persisting.']];
    expect(assessConvergence([3, 3], repeated, { nonConvergenceScore: 3 })).toMatchObject({
      nonConvergenceScore: 2, threshold: { nonConvergenceScore: 3 }, thresholdReached: false, requiresFullReview: false,
    });
    expect(assessConvergence([3, 3], repeated, { nonConvergenceScore: -1 })).toMatchObject({
      threshold: { nonConvergenceScore: 0 }, thresholdReached: false, requiresFullReview: false,
    });
  });

  it('임계 초과는 전부 확인을 요청할 뿐, 확인이 recoverable이면 멈추지 않는다', () => {
    const assessment = assessConvergence([3, 3, 3], [['MF-a'], ['MF-a'], ['MF-a']], { nonConvergenceScore: 2 });
    expect(resolveConvergenceDisposition(assessment, undefined)).toEqual({ stop: false, reason: undefined, requiresFullReview: true });
    expect(resolveConvergenceDisposition(assessment, 'recoverable')).toEqual({ stop: false, reason: undefined, requiresFullReview: true });
  });

  it('전부 확인이 unconvergeable이면 예산 소진과 구별되는 non-convergence 이유로 즉시 멈춘다', () => {
    const assessment = assessConvergence([3, 3, 3], [['MF-a'], ['MF-a'], ['MF-a']], { nonConvergenceScore: 2 });
    expect(resolveConvergenceDisposition(assessment, 'unconvergeable'))
      .toEqual({ stop: true, reason: 'non-convergence', requiresFullReview: true });
  });
});

describe('resolveEscalateTier — #2 단일 승급 사다리(terra→sol)', () => {
  it('상한과 그 이후 라운드는 최상위 칸 없이 sol에 머문다', () => {
    expect(resolveEscalateTier(2, 2)).toBe('sol');
    expect(resolveEscalateTier(3, 2)).toBe('sol');
  });
  it('직전 라운드도 sol — 적응형 연장 시 승급 자리는 함께 뒤로 간다', () => {
    expect(resolveEscalateTier(1, 2)).toBe('sol');
    expect(resolveEscalateTier(2, 3)).toBe('sol');
  });
  it('리뷰 보완 재시도는 같은 라운드와 예산에서도 승격하지 않고, 게이트 실패는 sol을 유지한다', () => {
    expect(resolveEscalateTier(2, 2, 'review')).toBe('none');
    expect(resolveEscalateTier(1, 2, 'gate')).toBe('sol');
    expect(resolveEscalateTier(1, 2, undefined)).toBe('sol');
  });
  it('그 앞 라운드는 base terra(none)다', () => {
    expect(resolveEscalateTier(0, 2)).toBe('none');
    expect(resolveEscalateTier(0, 3)).toBe('none');
    expect(resolveEscalateTier(1, 3)).toBe('none');
  });
  it('effectiveMax=1의 마지막 재작업은 sol이며 최초 실행·0/음수 예산 또는 round는 none이다', () => {
    expect(resolveEscalateTier(1, 1)).toBe('sol');
    expect(resolveEscalateTier(0, 1)).toBe('none');
    expect(resolveEscalateTier(0, 0)).toBe('none');
    expect(resolveEscalateTier(-1, 2)).toBe('none');
  });
});

describe('shouldEscalateModel — 티어!==none 래퍼(힌트·관측)', () => {
  it('sol에서만 true이고 base terra는 false다', () => {
    expect(shouldEscalateModel(2, 2)).toBe(true);
    expect(shouldEscalateModel(1, 2)).toBe(true);
    expect(shouldEscalateModel(0, 2)).toBe(false);
    expect(shouldEscalateModel(0, 0)).toBe(false);
  });
});

describe('resolveEscalateTarget — 단일 중간 모델/provider/effort', () => {
  it('sol = codex 사다리 best 칸(모델 이름을 박지 않는다 — 사다리를 바꾸면 따라온다)', () => {
    const best = lookupLlmTierSpec('openai-codex', 'best');
    const t = resolveEscalateTarget('sol', {});
    expect(t).toEqual({ model: best.model, provider: 'openai-codex', effort: best.reasoningLevel ?? 'high' });
  });
  it('결정 명시 자식은 «같은 provider» 사다리 안에서만 한 칸 승급한다 — 다른 provider 로 넘어가지 않는다', () => {
    const cases: Array<[string, string]> = [
      ['openrouter', lookupLlmTierSpec('openrouter', 'balanced').model],
      ['grok', lookupLlmTierSpec('grok', 'balanced').model],
      ['anthropic', lookupLlmTierSpec('anthropic', 'balanced').model],
      ['openai-codex', lookupLlmTierSpec('openai-codex', 'budget').model],
    ];
    expect(resolveExplicitChildEscalateTarget('none', {}, { provider: 'openrouter', model: cases[0]![1] })).toBeNull();
    for (const [provider, model] of cases) {
      const t = resolveExplicitChildEscalateTarget('sol', {}, { provider, model });
      expect({ provider, model, target: t?.provider }).toEqual({ provider, model, target: provider });
      expect(t!.model === model ? 'same-model' : 'next-model').toBe('next-model');
    }
    // 예: openrouter balanced(glm) → better 칸
    expect(resolveExplicitChildEscalateTarget('sol', {}, { provider: 'openrouter', model: lookupLlmTierSpec('openrouter', 'balanced').model })!.model)
      .toBe(lookupLlmTierSpec('openrouter', 'better').model);
  });
  it('사다리 꼭대기(더 높은 칸이 같은 모델·같은 노력뿐)이면 승급하지 않는다 · codex 는 loaded(astra)로 자동 도달하지 않는다', () => {
    expect(resolveExplicitChildEscalateTarget('sol', {}, { provider: 'openrouter', model: lookupLlmTierSpec('openrouter', 'loaded').model })).toBeNull();
    expect(resolveExplicitChildEscalateTarget('sol', {}, { provider: 'openai-codex', model: lookupLlmTierSpec('openai-codex', 'best').model })).toBeNull();
  });
  it('자식을 모르면(명시 자식이 아니면) 이 해석은 승급하지 않는다 — 기본 경로는 resolveEscalateTarget 이다', () => {
    expect(resolveExplicitChildEscalateTarget('sol', {})).toBeNull();
  });
  it('🩸 2026-09-23 — 승급 타깃에 옛 세대(gpt-5.6-*)·GPT-6 에 없는 terra 가 나오지 않는다', () => {
    const targets = [resolveEscalateTarget('sol', {}), resolveEscalateTarget('opus', {}),
      resolveExplicitChildEscalateTarget('sol', {}, { provider: 'openai-codex', model: lookupLlmTierSpec('openai-codex', 'budget').model })];
    for (const t of targets) {
      expect(t!.model).not.toMatch(/^gpt-5\.6-/);
      expect(t!.model).not.toMatch(/terra/);
    }
    expect(resolveEscalateTarget('opus', {})!.model).toBe(lookupLlmTierSpec('anthropic', 'loaded').model);
  });
  it('운영자의 SOL 환경 변수 덮어쓰기는 명시 자식에도 그대로 우선한다', () => {
    expect(resolveExplicitChildEscalateTarget('sol', {
      ELANOUS_SELFDEV_SOL_MODEL: 'configured-terra', ELANOUS_SELFDEV_SOL_PROVIDER: 'configured-codex', ELANOUS_SELFDEV_SOL_EFFORT: 'medium',
    }, { provider: 'openrouter', model: 'openrouter/z-ai/glm-5.3' })).toEqual({ model: 'configured-terra', provider: 'configured-codex', effort: 'medium' });
  });
  it('none 은 null(미주입=종전 base)이고 SOL 환경 변수는 중간 승급만 바꾼다', () => {
    expect(resolveEscalateTarget('none', {})).toBeNull();
    expect(resolveEscalateTarget('sol', { ELANOUS_SELFDEV_SOL_MODEL: 'configured-sol', ELANOUS_SELFDEV_SOL_EFFORT: 'medium' }))
      .toEqual({ model: 'configured-sol', provider: 'openai-codex', effort: 'medium' });
  });
});

describe('buildReworkFeature — #1+#4 진단 합성', () => {
  it('진단 있으면 "왜+어떻게"를 최우선으로 앞세움', () => {
    const f = buildReworkFeature('구현 X', 1, 2, '[gate 실패] 1 fail', '정규식 replace it with 미처리 → \\breplace\\b');
    expect(f).toContain('진단 — 왜 실패했고 어떻게 고칠지');
    expect(f).toContain('replace it with 미처리');
    expect(f).toContain('원 지적');
  });
  it('진단 없으면 raw note 폴백(무회귀)', () => {
    const f = buildReworkFeature('구현 X', 1, 2, '[gate 실패] 1 fail');
    expect(f).not.toContain('진단 —');
    expect(f).toContain('[gate 실패] 1 fail');
  });
  it('CONTRACT-CONFLICT 계획 수정 지시와 감독 이유 및 타당한 자식 반박을 다음 자식에게 전달한다', () => {
    const f = buildReworkFeature('구현 X', 1, 2, '[리뷰 must-fix — 반드시 반영]\n- 현장과 다른 요구', '진단 본문', undefined, undefined, {
      reason: '보존 계약 줄이 현장 API와 어긋난다',
      refutations: [{ findingId: 'MF-12345678', finding: '현장과 다른 요구', quote: '- Checkable preservation criterion: 기존 API를 고정한다', reason: '현재 API는 이미 이 기준을 만족할 수 없다' }],
    });
    expect(f).toContain('[감독 계획 수정 지시 — 현장이 기존 계획과 어긋남]');
    expect(f).toContain('감독 이유: 보존 계약 줄이 현장 API와 어긋난다');
    expect(f).not.toContain('골 문서는 이 라운드에서 고쳐 쓰지 않는다');
    expect(f).not.toContain('검증된 완화가 적용된 골 문서의 수용 기준을 이번 구현의 기준으로 사용하라');
    expect(f).toContain('원본 골 문서는 수정되지 않았다. 완화가 검증·적용될 때까지 원본 수용 기준을 추측해 바꾸지 말고 재계획 또는 명확화가 필요하다는 상태와 이유를 보고하라.');
    expect(f).toContain('[타당하다고 확인된 자식 반박]');
    expect(f).toContain('[MF-12345678] 현장과 다른 요구');
    expect(f).toContain('인용: - Checkable preservation criterion: 기존 API를 고정한다');
  });
  it('계획 수정 문맥은 이유·반박을 결정적으로 제한하고 전체 rework 예산 안에 보존한다', () => {
    const f = buildReworkFeature('X', 1, 3, '원 지적', undefined, undefined, undefined, {
      reason: `REASON-FIRST-${'r'.repeat(2000)}`,
      refutations: Array.from({ length: 5 }, (_, index) => ({
        findingId: `MF-${String(index).padStart(8, '0')}`,
        finding: `FINDING-${index}-${'f'.repeat(500)}`,
        quote: `QUOTE-${index}-${'q'.repeat(500)}`,
        reason: `REFUTATION-${index}-${'x'.repeat(500)}`,
      })),
    });
    const context = f.slice(f.indexOf('[감독 계획 수정 지시'));
    expect(context.length).toBeLessThanOrEqual(5000);
    expect(context).toContain('REASON-FIRST-');
    expect(context).toContain('…[감독 이유 절단]');
    expect(context).toContain('MF-00000000');
    expect(context).toContain('MF-00000002');
    expect(context).not.toContain('MF-00000003');
    expect(context).toContain('…[타당한 자식 반박 2개 생략됨]');
    expect(context).toContain('…[반박 절단]');
  });
  it('⭐ 원 지적이 상한을 넘으면 앞부분 결손을 명시한다', () => {
    const f = buildReworkFeature('X', 1, 3, `NOTE-FIRST-${'n'.repeat(3500)}-NOTE-LAST`);
    expect(f).toContain('[상한 3000자 — 앞부분');
    expect(f).toContain('NOTE-LAST');
    expect(f).not.toContain('NOTE-FIRST');
  });
  it('단일 중간 승급 모델 힌트(sol)는 실제 triage 판단이 있을 때만 그 판단을 다음 자식 입력에 렌더한다', () => {
    const judged = buildReworkFeature('X', 2, 2, 'note', undefined, undefined, undefined, undefined, undefined, undefined, 'TRIAGE: contract mismatch');
    expect(judged).toContain('중간 승급 모델(sol)');
    expect(judged).toContain('트리아지 판단: TRIAGE: contract mismatch');
    for (const unavailable of [undefined, '', '   ']) {
      const prompt = buildReworkFeature('X', 2, 2, 'note', undefined, undefined, undefined, undefined, undefined, undefined, unavailable);
      expect(prompt).toContain('중간 승급 모델(sol)');
      expect(prompt).not.toContain('트리아지 판단');
      expect(prompt).not.toContain('트리아지 판단을 반영');
    }
    expect(buildReworkFeature('X', 0, 2, 'note')).not.toContain('모델(');
  });
  it('리뷰 must-fix에 안정 ID 스냅샷과 strict REFUTE 회부 문법을 제공하고 감독 판정을 요구한다', () => {
    const f = buildReworkFeature('X', 2, 3, '[리뷰 must-fix — 반드시 반영]\n- 이번 지적', undefined, ['지난 지적 A', '지난 지적 B'], [{ id: 'MF-12345678', item: '이번 지적' }]);
    expect(f).toContain('[리뷰 must-fix — 반드시 반영]');
    expect(f).toContain('[직전 라운드에 지적받아 반영한 것]\n- 지난 지적 A\n- 지난 지적 B');
    expect(f).toContain('- [MF-12345678] 이번 지적');
    expect(f).toContain('REFUTE [MF-안정ID] "JSON 문자열로 인코딩한 골의 원문 줄" — 근거 한 줄');
    expect(f).toContain('REFUTE [MF-낮은ID] CONFLICT [MF-높은ID] "JSON 문자열로 인코딩한 골의 원문 줄" — 두 지적을 동시에 만족할 수 없다: 양립 불가 이유');
    expect(f).toContain('위 스냅샷의 서로 다른 두 ID와 실제 적격 골 인용을 모두 요구하며, 순차적으로 나타난 지적이나 단순히 무관한 두 지적에는 쓰지 않는다.');
    expect(f).toContain('순차적으로 나타난 지적이나 단순히 무관한 두 지적에는 쓰지 않는다.');
    expect(f).toContain('감독이 ACCEPT 또는 REJECT로 판정한다.');
  });

  it('반박 가능한 지적이 있으면 gate와 supervisor 재작업에도 같은 REFUTE 안내를 제공한다', () => {
    const findings = [{ id: 'MF-gate0001', item: 'gate 지적' }, { id: 'MF-gate0002', item: 'gate 지적 둘' }];
    const gate = buildReworkFeature('X', 1, 2, '[gate 실패] fail', undefined, undefined, findings);
    const supervisor = buildReworkFeature('X', 1, 2, '[감독 지시] 재작업', undefined, undefined, findings);
    for (const prompt of [gate, supervisor]) {
      expect(prompt).toContain('[기각 가능한 원본 must-fix — ID는 라운드 간 불변]');
      expect(prompt).toContain('REFUTE [MF-안정ID] "JSON 문자열로 인코딩한 골의 원문 줄" — 근거 한 줄');
      expect(prompt).toContain('- [MF-gate0001] gate 지적');
      expect(prompt).toContain('- [MF-gate0002] gate 지적 둘');
    }
  });

  it('반박 가능한 지적이 없거나 첫 라운드면 REFUTE 안내를 제공하지 않는다', () => {
    const findings = [{ id: 'MF-first000', item: '첫 라운드 지적' }];
    expect(buildReworkFeature('X', 1, 2, '[gate 실패] fail', undefined, undefined, [])).not.toContain('[기각 가능한 원본 must-fix — ID는 라운드 간 불변]');
    expect(buildReworkFeature('X', 0, 2, '[리뷰 must-fix — 반드시 반영]\n- 첫 지적', undefined, undefined, findings)).not.toContain('[기각 가능한 원본 must-fix — ID는 라운드 간 불변]');
  });

  it('스냅샷 없는 기존 review rework는 기존 출력을 바이트 수준으로 보존한다', () => {
    const legacyReview = buildReworkFeature('X', 1, 2, '[리뷰 must-fix — 반드시 반영]\n- fail');
    expect(legacyReview).toBe('X\n\n[라운드 1/2 (중간 승급 모델(sol)) — 아래를 반드시 고쳐 통과시켜라. 참조한 심볼/필드는 정의·선언까지 완성(소비만 하고 미정의 금지)]\n[리뷰 must-fix — 반드시 반영]\n- fail');
  });
  it('round 0에서는 직전 항목 절을 렌더하지 않는다', () => {
    const f = buildReworkFeature('X', 0, 3, 'note', undefined, ['지난 지적']);
    expect(f).not.toContain('직전 라운드');
  });
  it('유효한 요구 증거 태그가 있으면 마지막에 이번 라운드 전체 재제출을 명시한다', () => {
    const feature = '원 골\n\n## REQUIRED EVIDENCE\n- [criterion-1] 구현 대상 확인';
    const f = buildReworkFeature(feature, 1, 2, 'note');
    expect(f.startsWith(feature)).toBe(true);
    expect(f).toEndWith('이번 라운드에도 골이 이름으로 요구한 증거를 전체 다시 내야 한다. 고친 것만 적으면 요구 전체가 누락으로 판정된다.');
  });
  it('유효한 요구 증거 태그가 없으면 기존 산출을 바이트 수준으로 보존한다', () => {
    const feature = '원 골\n\n## REQUIRED EVIDENCE\n- [criterion-1]';
    expect(buildReworkFeature(feature, 1, 2, 'note')).toBe(
      `${feature}\n\n[라운드 1/2 (중간 승급 모델(sol)) — 아래를 반드시 고쳐 통과시켜라. 참조한 심볼/필드는 정의·선언까지 완성(소비만 하고 미정의 금지)]\nnote`,
    );
  });
  it('큰 직전 이력도 현재 must-fix를 보존하고 전체 rework 지시문 예산 안에서 항목 경계로 생략을 표시한다', () => {
    const currentFirst = 'CURRENT-MUST-FIX-FIRST';
    const currentLast = 'CURRENT-MUST-FIX-LAST';
    const note = `[리뷰 must-fix — 반드시 반영]\n- ${currentFirst}\n- ${'n'.repeat(2900)}\n- ${currentLast}`;
    const prior = ['FIRST-PRIOR-MUST-FIX', 'SECOND-PRIOR-MUST-FIX', 'THIRD-PRIOR-MUST-FIX'];
    const f = buildReworkFeature('X', 1, 3, note, undefined, prior.map((item) => `${item}-${'p'.repeat(1965)}`));
    const contextStart = f.indexOf('[리뷰 must-fix');
    expect(contextStart).toBeGreaterThanOrEqual(0);
    const context = f.slice(contextStart);
    const priorStart = context.indexOf('[직전 라운드에 지적받아 반영한 것]');
    expect(context.length).toBeLessThanOrEqual(5000);
    expect(context).toContain(currentFirst);
    expect(context).toContain(currentLast);
    expect(priorStart).toBeGreaterThanOrEqual(0);
    const priorSection = context.slice(priorStart);
    expect(priorSection).toContain('…[직전 항목 3개 생략됨]');
    expect(priorSection).not.toContain('FIRST-PRIOR-MUST-FIX');
    expect(priorSection).not.toContain('SECOND-PRIOR-MUST-FIX');
    expect(priorSection).not.toContain(currentFirst);
    expect(priorSection).not.toContain(currentLast);
  });
  it('직전 절의 첫 항목도 예산에 맞지 않으면 중간 문장 절단 없이 생략 표식만 남긴다', () => {
    const f = buildReworkFeature('X', 1, 3, '현재 지적', undefined, ['UNSPLITTABLE-PRIOR-ITEM-' + 'p'.repeat(6000)]);
    expect(f).toContain('[직전 라운드에 지적받아 반영한 것]\n…[직전 항목 1개 생략됨]');
    expect(f).not.toContain('UNSPLITTABLE-PRIOR-ITEM');
  });

  it('리뷰 must-fix 재작업은 회부 의무를 머리 지시 직후에 단일 블록으로 두고, 값싼 acknowledgement보다 먼저 요구한다', () => {
    const feature = '골\n- Checkable preservation criterion: 기존 parser를 수정하지 않는다';
    const note = `[리뷰 must-fix — 반드시 반영]\n- 버그\n- LONG-GUIDANCE-${'g'.repeat(4500)}-GUIDANCE-END`;
    const f = buildReworkFeature(feature, 1, 3, note, undefined, undefined, [{ id: 'MF-deadbeef', item: '버그' }]);
    const block = '[기각 가능한 원본 must-fix — ID는 라운드 간 불변]';
    const blockStart = f.indexOf(block);
    const guidanceStart = f.indexOf('GUIDANCE-END');
    const headerEnd = f.indexOf(']\n\n') + 1;
    expect(blockStart).toBe(headerEnd + 2);
    expect(blockStart).toBeLessThan(f.length / 2);
    expect(blockStart).toBeLessThan(guidanceStart);
    expect(f.match(/^\[기각 가능한 원본 must-fix — ID는 라운드 간 불변\]$/gm)).toHaveLength(1);
    expect(f).toContain('리뷰 must-fix가 골의 허용된 보존 계약과 충돌하거나 골이 요청한 기준 자체를 되돌려 골 자기모순을 만든다고 판단하면 반드시 `REFUTE [MF-안정ID] "JSON 문자열로 인코딩한 골의 원문 줄" — 근거 한 줄`로 회부하라');
    expect(f).toContain('REFUTE [MF-낮은ID] CONFLICT [MF-높은ID]');
    expect(f).toContain('두 현재 must-fix가 동시에 만족될 수 없을 때');
    expect(f).toContain('순차적으로 나타난 지적이나 단순히 무관한 두 지적에는 쓰지 않는다');
    expect(f).toContain(MUST_FIX_REFUTATION_ACKNOWLEDGEMENT);
    expect(f).toContain('반론 검토 결과를 반드시 제출하라: 있으면 위 REFUTE 형식으로 회부하고, 없으면 정확히 `REFUTE: NONE` 한 줄을 남겨라.');
    expect(f).not.toContain('이 줄을 생략해도 런은 계속되지만 검토 여부는 미지로 관측된다');
    expect(f).not.toMatch(/생략해도.*런은 계속/);
    expect(f).toContain('REFUTE [MF-deadbeef] "- Checkable preservation criterion: 기존 parser를 수정하지 않는다" — 이 지적은 인용한 골 계약과 충돌한다.');
    expect(f.indexOf('반론 검토 결과를 반드시 제출하라')).toBeGreaterThan(f.indexOf('반드시 `REFUTE'));
  });

  it('반박 블록은 대상 없는 라운드에는 붙지 않고, 변경 전 독립 길이 기준을 넘지 않으며 다른 절을 보존한다', () => {
    const feature = '골';
    const note = '[리뷰 must-fix — 반드시 반영]\n- 버그';
    const findings = [{ id: 'MF-deadbeef', item: '버그' }];
    const current = buildReworkFeature(feature, 1, 3, note, undefined, undefined, findings);
    const blockStart = current.indexOf('[기각 가능한 원본 must-fix — ID는 라운드 간 불변]');
    const guidanceStart = current.lastIndexOf(note);
    const withoutBlock = current.slice(0, blockStart - 2) + current.slice(guidanceStart - 1);
    // 변경 전 HEAD 조립 결과의 고정 길이(동일 feature/note/findings): 현재 조립 조각에서 유도하지 않는다.
    const LEGACY_TAIL_PROMPT_LENGTH = 960;
    expect(withoutBlock).toBe(buildReworkFeature(feature, 1, 3, note));
    expect(current.length).toBeLessThanOrEqual(LEGACY_TAIL_PROMPT_LENGTH);
    expect(buildReworkFeature(feature, 1, 3, note, undefined, undefined, [])).not.toContain('[기각 가능한 원본 must-fix — ID는 라운드 간 불변]');
  });

  it('리뷰 must-fix 문면은 보존 계약 종류의 첫 적격 골 줄을 쓴 유효한 REFUTE 예시를 정확히 한 번 보이고 kind를 보존한다', () => {
    const feature = '골\n- Checkable requested criterion: 기존 문법을 보존한다\n- Checkable preservation criterion: 기존 parser를 수정하지 않는다';
    const findings = [
      { id: 'MF-deadbeef', item: '첫 지적' },
      { id: 'MF-12345678', item: '둘째 지적' },
    ];
    const f = buildReworkFeature(feature, 1, 3, '[리뷰 must-fix — 반드시 반영]\n- 첫 지적', undefined, undefined, findings);
    const example = f.split(/\r?\n/).find((line) => line.startsWith('REFUTE [MF-deadbeef]'));
    expect(f.match(/^REFUTE \[MF-deadbeef\]/gm)).toHaveLength(1);
    expect(f).toContain('예시(위 첫 항목 ID와 이 골의 실제 인용 줄):');
    expect(example).toBe('REFUTE [MF-deadbeef] "- Checkable preservation criterion: 기존 parser를 수정하지 않는다" — 이 지적은 인용한 골 계약과 충돌한다.');
    expect(parseMustFixRefutations(example!, feature, findings)).toEqual([{
      findingId: 'MF-deadbeef',
      finding: '첫 지적',
      quote: '- Checkable preservation criterion: 기존 parser를 수정하지 않는다',
      kind: 'preservation-contract',
      reason: '이 지적은 인용한 골 계약과 충돌한다.',
    }]);
  });

  it('보존 계약 종류가 없으면 다른 적격 종류로 대체하지 않고 기존 예시 생략 문면을 쓴다', () => {
    const feature = '골\n- Checkable requested criterion: 기존 문법을 보존한다\n- Invariant candidate: 기존 불변식을 유지한다';
    const findings = [{ id: 'MF-deadbeef', item: '첫 지적' }];
    const f = buildReworkFeature(feature, 1, 3, '[리뷰 must-fix — 반드시 반영]\n- 첫 지적', undefined, undefined, findings);
    expect(f).not.toContain('REFUTE [MF-deadbeef]');
    expect(f).toContain('예시를 만들 인용 가능 골 원문 줄이 없어 REFUTE 예시는 생략한다. 실제 회부 시에는 아래 문법대로 골의 적격 원문 줄 전체를 JSON 문자열로 인용하라.');
  });

  it('SCOPE BOUNDARY 결정 줄만 적격이어도 실제 생성 예시를 strict parser가 수용한다', () => {
    const scopeDecision = '- ⛔ 결정 1: 파서 계약은 바꾸지 않는다.';
    const feature = `골\n\n## SCOPE BOUNDARY\n${scopeDecision}`;
    const findings = [{ id: 'MF-deadbeef', item: '첫 지적' }];
    const f = buildReworkFeature(feature, 1, 3, '[리뷰 must-fix — 반드시 반영]\n- 첫 지적', undefined, undefined, findings);
    const example = f.split(/\r?\n/).find((line) => line.startsWith('REFUTE [MF-deadbeef]'));
    expect(example).toBe(`REFUTE [MF-deadbeef] ${JSON.stringify(scopeDecision)} — 이 지적은 인용한 골 계약과 충돌한다.`);
    expect(parseMustFixRefutations(example!, feature, findings)).toEqual([{
      findingId: 'MF-deadbeef',
      finding: '첫 지적',
      quote: scopeDecision,
      kind: 'preservation-contract',
      reason: '이 지적은 인용한 골 계약과 충돌한다.',
    }]);
  });
});

describe('failIndicator — 적응형 입력 추출', () => {
  it('gate log 의 N fail 합', () => {
    expect(failIndicator('gate', '2 fail\n3 fail', 0)).toBe(5);
    expect(failIndicator('gate', '0 fail', 0)).toBe(0);
  });
  it('review 는 mustFix 수', () => {
    expect(failIndicator('review', undefined, 3)).toBe(3);
  });
});


describe('rework budget judgment rail', () => {
  it('EXTEND 고정 첫 줄을 결정론적으로 파싱한다', () => {
    expect(parseReworkBudgetDecision('BUDGET: EXTEND\nREASON: 새 지적이 좁아졌다\n진단')).toEqual({ verdict: 'EXTEND', reason: '새 지적이 좁아졌다' });
  });

  it('SUFFICIENT 고정 첫 줄을 결정론적으로 파싱한다', () => {
    expect(parseReworkBudgetDecision('BUDGET: SUFFICIENT\nREASON: 비블로커다')).toEqual({ verdict: 'SUFFICIENT', reason: '비블로커다' });
  });

  it('UNCONVERGEABLE 고정 첫 줄을 결정론적으로 파싱한다', () => {
    expect(parseReworkBudgetDecision('BUDGET: UNCONVERGEABLE\nREASON: 같은 지적 반복')).toEqual({ verdict: 'UNCONVERGEABLE', reason: '같은 지적 반복' });
  });

  it('CONTRACT-CONFLICT 고정 첫 줄을 reason 문자열을 해석하지 않고 파싱한다', () => {
    expect(parseReworkBudgetDecision('BUDGET: CONTRACT-CONFLICT\nREASON: 골 보존 기준과 리뷰 지적이 충돌')).toEqual({ verdict: 'CONTRACT-CONFLICT', reason: '골 보존 기준과 리뷰 지적이 충돌' });
    expect(parseReworkBudgetDecision('BUDGET: EXTEND\nREASON: CONTRACT-CONFLICT라는 단어가 있어도 연장')).toEqual({ verdict: 'EXTEND', reason: 'CONTRACT-CONFLICT라는 단어가 있어도 연장' });
  });

  it('CONTRACT-CONFLICT 구조화 완화 계약을 파싱하고 부분 입력은 기존 reason-only 호환으로 남긴다', () => {
    expect(parseContractConflictRelaxation('BUDGET: CONTRACT-CONFLICT\nREASON: conflict\nTARGET: AC-1\nEXPECTED: - old criterion\nREPLACEMENT: - relaxed criterion'))
      .toEqual({ target: 'AC-1', expected: '- old criterion', replacement: '- relaxed criterion' });
    expect(parseContractConflictRelaxation('BUDGET: CONTRACT-CONFLICT\nREASON: legacy')).toBeUndefined();
    expect(parseContractConflictRelaxation('TARGET: AC-1\nEXPECTED: old')).toBeUndefined();
  });

  it.each([
    'TARGET: AC-1\nTARGET: AC-2\nEXPECTED: - old criterion\nREPLACEMENT: - relaxed criterion',
    'TARGET: AC-1\nEXPECTED: - old criterion\nEXPECTED: - conflicting criterion\nREPLACEMENT: - relaxed criterion',
    'TARGET: AC-1\nEXPECTED: - old criterion\nREPLACEMENT: - relaxed criterion\nREPLACEMENT: - conflicting criterion',
  ])('CONTRACT-CONFLICT 완화 계약의 중복 구조 필드를 거부한다', (payload) => {
    expect(parseContractConflictRelaxation(payload)).toBeUndefined();
  });

  it('손상된 첫 두 줄은 판정 없음으로 fail-soft 한다', () => {
    expect(parseReworkBudgetDecision('BUDGET: extend\nREASON: nope')).toBeUndefined();
    expect(parseReworkBudgetDecision('BUDGET: EXTEND\n진단만 있음')).toBeUndefined();
    expect(parseReworkBudgetDecision(undefined)).toBeUndefined();
  });

  it('이력은 항목별 1200자·보관 5라운드 — 판단자는 현재분을 뺀 4라운드를 본다', () => {
    let history: string[] = [];
    // ⚠️ 라운드 표지를 **앞**에 둔다 — 실제 note 도 `[gate 실패]`/`[리뷰 must-fix …]` 로 시작하고,
    //    절단이 앞부분을 보존하므로(리뷰 should-fix) 표지는 머리에서 살아남아야 한다.
    for (let round = 1; round <= 6; round++) history = appendReworkHistory(history, `${round}:${'x'.repeat(1300)}`);
    expect(history).toHaveLength(5);                  // 보관 = 5(최근 2..6)
    expect(history[0]!.startsWith('2:')).toBe(true);
    expect(history[4]!.startsWith('6:')).toBe(true);
    expect(history[4]!.length).toBeLessThanOrEqual(1200);
    // ⭐ 보관이 5인 이유 — 호출부가 **현재 지적 1건을 뺀다**(자기 자신과 비교 금지). 보관을 4로 두면
    //   판단자는 3라운드만 보게 되어 문맥이 오히려 줄어든다(리뷰 should-fix). 실제 전달분을 단정한다.
    const seenByJudge = history.slice(0, -1);
    expect(seenByJudge).toHaveLength(4);              // 설계대로 최대 4라운드
    expect(seenByJudge[3]!.startsWith('5:')).toBe(true);
  });

  it('미설정 EXTEND는 기본 hardCap 6에 도달하고 넘지 않는다', () => {
    let effectiveMax = 2;
    for (let round = 0; round < 6; round++) effectiveMax = applyReworkBudgetDecision(effectiveMax, { verdict: 'EXTEND', reason: '좁아짐' }).effectiveMax;
    expect(effectiveMax).toBe(6);
    expect(applyReworkBudgetDecision(effectiveMax, { verdict: 'EXTEND', reason: '좁아짐' })).toEqual({ effectiveMax: 6, stop: false, exit: 'continue', applied: false });
  });

  it('설정한 hardCap에서 EXTEND를 차단하고 기존 경고 경로가 판별할 applied=false를 보존한다', () => {
    expect(applyReworkBudgetDecision(3, { verdict: 'EXTEND', reason: '좁아짐' }, 3))
      .toEqual({ effectiveMax: 3, stop: false, exit: 'continue', applied: false });
    expect(applyReworkBudgetDecision(2, { verdict: 'EXTEND', reason: '좁아짐' }, 3))
      .toEqual({ effectiveMax: 3, stop: false, exit: 'continue', applied: true });
  });

  it('EXTEND는 effectiveMax가 hardCap과 같으면 차단하고 이미 크면 상한으로 정규화한다', () => {
    expect(applyReworkBudgetDecision(5, { verdict: 'EXTEND', reason: '좁아짐' }, 5)).toEqual({ effectiveMax: 5, stop: false, exit: 'continue', applied: false });
    expect(applyReworkBudgetDecision(7, { verdict: 'EXTEND', reason: '좁아짐' }, 5)).toEqual({ effectiveMax: 5, stop: false, exit: 'continue', applied: false });
  });

  it('SUFFICIENT 종료는 레일에서 review만 PR 진행 disposition으로 결정한다', () => {
    expect(applyReworkBudgetDecision(2, { verdict: 'SUFFICIENT', reason: '비블로커' }, 5, 'review')).toEqual({ effectiveMax: 2, stop: true, exit: 'proceed', applied: true });
    expect(applyReworkBudgetDecision(2, { verdict: 'SUFFICIENT', reason: '게이트 실패' }, 5, 'gate')).toEqual({ effectiveMax: 2, stop: false, exit: 'continue', applied: false });
  });

  it('UNCONVERGEABLE 종료는 레일에서 차단 disposition으로 결정한다', () => {
    expect(applyReworkBudgetDecision(2, { verdict: 'UNCONVERGEABLE', reason: '반복' })).toEqual({ effectiveMax: 2, stop: true, exit: 'blocked', applied: true });
  });

  it('CONTRACT-CONFLICT는 자동 집행 없이 단발 처분을 명시하고 기존 예산과 종결 처분을 유지한다', () => {
    expect(applyReworkBudgetDecision(2, { verdict: 'CONTRACT-CONFLICT', reason: '충돌' }, 5, 'review', 0))
      .toEqual({ effectiveMax: 2, stop: false, exit: 'continue', applied: false, contractConflictDisposition: 'first-observed' });
    expect(applyReworkBudgetDecision(2, undefined, 5, 'review', 0))
      .toEqual({ effectiveMax: 2, stop: false, exit: 'continue', applied: false });
  });

  it('CONTRACT-CONFLICT 반복 처분은 직전 계약 충돌에만 반응하고 helper와 결정론적으로 일치한다', () => {
    expect(resolveContractConflictDisposition()).toBe('first-observed');
    expect(resolveContractConflictDisposition('EXTEND')).toBe('first-observed');
    expect(resolveContractConflictDisposition('CONTRACT-CONFLICT')).toBe('repeated');
    expect(applyReworkBudgetDecision(2, { verdict: 'CONTRACT-CONFLICT', reason: '같은 충돌' }, 5, 'gate', 2, true, 'CONTRACT-CONFLICT'))
      .toEqual({ effectiveMax: 2, stop: false, exit: 'continue', applied: false, contractConflictDisposition: 'repeated' });
  });

  it('이전 비충돌 라운드와 생략된 이력은 최초 계약 충돌로 남기며 priorRounds와 이유 문면을 반복 근거로 쓰지 않는다', () => {
    const conflict = { verdict: 'CONTRACT-CONFLICT' as const, reason: '같은 충돌' };
    expect(applyReworkBudgetDecision(2, conflict, 5, 'review', 2, false, 'EXTEND'))
      .toEqual({ effectiveMax: 2, stop: false, exit: 'continue', applied: false, contractConflictDisposition: 'first-observed' });
    expect(applyReworkBudgetDecision(2, conflict, 5, 'review', 2))
      .toEqual({ effectiveMax: 2, stop: false, exit: 'continue', applied: false, contractConflictDisposition: 'first-observed' });
  });

  it('첫 review UNCONVERGEABLE은 다음 must-fix 수정 시도를 보장하고, 이전 라운드가 있으면 종료한다', () => {
    expect(applyReworkBudgetDecision(2, { verdict: 'UNCONVERGEABLE', reason: '재발' }, 5, 'review', 0, false))
      .toEqual({ effectiveMax: 2, stop: false, exit: 'continue', applied: false, shadowed: false });
    expect(applyReworkBudgetDecision(2, { verdict: 'UNCONVERGEABLE', reason: '재발' }, 5, 'review', 1, false))
      .toEqual({ effectiveMax: 2, stop: true, exit: 'blocked', applied: true });
  });

  it('shadowStop=false는 EXTEND·SUFFICIENT·UNCONVERGEABLE·판정없음의 종전 결과를 보존한다', () => {
    expect(applyReworkBudgetDecision(2, { verdict: 'EXTEND', reason: '좁아짐' }, 5, 'review', 1, false))
      .toEqual({ effectiveMax: 3, stop: false, exit: 'continue', applied: true });
    expect(applyReworkBudgetDecision(2, { verdict: 'SUFFICIENT', reason: '비블로커' }, 5, 'review', 1, false))
      .toEqual({ effectiveMax: 2, stop: true, exit: 'proceed', applied: true });
    expect(applyReworkBudgetDecision(2, { verdict: 'SUFFICIENT', reason: '게이트' }, 5, 'gate', 1, false))
      .toEqual({ effectiveMax: 2, stop: false, exit: 'continue', applied: false });
    expect(applyReworkBudgetDecision(2, { verdict: 'UNCONVERGEABLE', reason: '반복' }, 5, 'review', 1, false))
      .toEqual({ effectiveMax: 2, stop: true, exit: 'blocked', applied: true });
    expect(applyReworkBudgetDecision(2, undefined, 5, 'review', 1, false))
      .toEqual({ effectiveMax: 2, stop: false, exit: 'continue', applied: false });
  });

  it('shadowStop=true는 종료 판정을 반사실로만 남기고 EXTEND·gate SUFFICIENT는 그대로 적용한다', () => {
    expect(applyReworkBudgetDecision(2, { verdict: 'SUFFICIENT', reason: '비블로커' }, 5, 'review', 1, true))
      .toEqual({ effectiveMax: 2, stop: false, exit: 'continue', applied: false, shadowed: true, wouldExit: 'proceed' });
    expect(applyReworkBudgetDecision(2, { verdict: 'UNCONVERGEABLE', reason: '반복' }, 5, 'review', 1, true))
      .toEqual({ effectiveMax: 2, stop: false, exit: 'continue', applied: false, shadowed: true, wouldExit: 'blocked' });
    expect(applyReworkBudgetDecision(2, { verdict: 'EXTEND', reason: '좁아짐' }, 5, 'review', 1, true))
      .toEqual({ effectiveMax: 3, stop: false, exit: 'continue', applied: true });
    expect(applyReworkBudgetDecision(2, { verdict: 'SUFFICIENT', reason: '게이트' }, 5, 'gate', 1, true))
      .toEqual({ effectiveMax: 2, stop: false, exit: 'continue', applied: false });
  });

  describe('carry policy', () => {
    const extend = { verdict: 'EXTEND' as const, reason: '좁아짐' };
    const sufficient = { verdict: 'SUFFICIENT' as const, reason: '비블로커' };
    const unconvergeable = { verdict: 'UNCONVERGEABLE' as const, reason: '반복' };

    it('shadowed UNCONVERGEABLE preserves the prior carry', () => {
      expect(resolveReworkBudgetCarry(unconvergeable, 3, 5, true)).toBe(5);
    });

    it('shadowed SUFFICIENT preserves the prior carry', () => {
      expect(resolveReworkBudgetCarry(sufficient, 3, 5, true)).toBe(5);
    });

    it('non-shadowed UNCONVERGEABLE drops the carry', () => {
      expect(resolveReworkBudgetCarry(unconvergeable, 3, 5, false)).toBeUndefined();
    });

    it('non-shadowed SUFFICIENT drops the carry', () => {
      expect(resolveReworkBudgetCarry(sufficient, 3, 5, false)).toBeUndefined();
    });

    it('EXTEND carries the current effectiveMax whether shadowed or not', () => {
      expect(resolveReworkBudgetCarry(extend, 5, 4, false)).toBe(5);
      expect(resolveReworkBudgetCarry(extend, 5, 4, true)).toBe(5);
    });

    it('preserves an EXTEND-raised carry through a shadowed UNCONVERGEABLE', () => {
      const raisedCarry = resolveReworkBudgetCarry(extend, 5, 4, false);
      expect(resolveReworkBudgetCarry(unconvergeable, 3, raisedCarry, true)).toBe(5);
    });
  });
});

// ⭐ 리뷰 should-fix 회귀 가드(2026-07-27 · 사람 인수) —
//   ① 이력 절단이 **앞부분을 보존**해야 한다(꼬리만 남기면 종류 표지·첫 지적이 날아가 "반복 감지"가 죽는다).
//   ② 예산 제어 헤더가 **구현 에이전트 프롬프트로 새면 안 된다**(진단 계약 오염).
describe('rework 예산 — 이력 절단·헤더 격리', () => {
  it('이력 절단은 앞부분을 보존하고 잘렸음을 명시한다(꼬리 절단 금지)', () => {
    const note = `[리뷰 must-fix — 반드시 반영]\n- 첫 지적 A\n${'x'.repeat(4000)}\n- 마지막 지적 Z`;
    const [entry] = appendReworkHistory([], note, 4, 300);
    expect(entry!.startsWith('[리뷰 must-fix — 반드시 반영]')).toBe(true);   // 종류 표지 보존
    expect(entry).toContain('첫 지적 A');                                    // 첫 지적 보존
    expect(entry).toContain('…[절단]');                                      // 침묵 절단 금지
    expect(entry!.length).toBeLessThanOrEqual(300);
  });

  it('한도 이내면 원문 그대로다(무회귀)', () => {
    expect(appendReworkHistory([], 'short note', 4, 300)).toEqual(['short note']);
  });

  it('상한보다 긴 항목 하나만 중간에서 자르고 모든 항목의 앞부분을 남긴다', () => {
    const shortA = '- 짧은 지적 A 는 그대로 남는다';
    const long = `- 긴 지적 ${'본문'.repeat(400)} 끝`;
    const shortB = '- 뒤 항목 B 도 통째로 사라지지 않는다';
    const note = `[리뷰 must-fix — 반드시 반영]\n${shortA}\n${long}\n${shortB}`;
    const [entry] = appendReworkHistory([], note, 4, 300);
    expect(entry!.startsWith('[리뷰 must-fix — 반드시 반영]')).toBe(true);
    expect(entry).toContain(shortA);
    expect(entry).toContain(shortB);
    expect(entry).toContain('- 긴 지적 본문');
    expect(entry).toContain('…[절단]');
    const cutLines = entry!.split('\n').filter((line) => line.includes('…[절단]'));
    expect(cutLines).toHaveLength(1);
    expect(cutLines[0]!.startsWith('- 긴 지적')).toBe(true);
    expect(entry).not.toContain('끝');
    expect(entry!.length).toBeLessThanOrEqual(300);
    expect(entry).toMatch(/…\[\d+항목·\d+자 절단\]/);
  });

  it('예산 제어 헤더 2줄을 걷어내고 진단만 남긴다', () => {
    expect(stripReworkBudgetHeaders('BUDGET: EXTEND\nREASON: 좁아짐\n왜: A\n어떻게: B'))
      .toBe('왜: A\n어떻게: B');
  });

  it('헤더가 없으면 원문을 그대로 돌려준다(무회귀)', () => {
    expect(stripReworkBudgetHeaders('왜: A\n어떻게: B')).toBe('왜: A\n어떻게: B');
    expect(stripReworkBudgetHeaders(undefined)).toBe('');
  });
});

// ⭐ 실전 오탐 회귀 가드(2026-07-27 · run-9135a622) — 이력에 **현재 지적이 그대로** 들어가 판단자가
//   자기 자신과 비교하고 "동일 지적 재발"이라 판정했다. 게이트를 통과하고 조치 가능한 must-fix 5건을
//   가진 런이 **1라운드 만에** 죽었다. 근본은 호출부(이전 라운드만 전달)이고, 아래는 구조 가드다.
describe('감독 재투입 note 병합', () => {
  it('gate·review·감독 사유를 결정된 순서로 손실 없이 병합한다', () => {
    expect(mergeReworkNotes([
      { source: 'supervisor', note: '입력 제안 A' },
      { source: 'gate', note: '타입 오류' },
      { source: 'review', note: '테스트 추가' },
      { source: 'supervisor', note: '입력 제안 B' },
    ])).toEqual({
      sources: ['gate', 'review', 'supervisor'],
      note: '[gate 실패]\n타입 오류\n\n[리뷰 must-fix — 반드시 반영]\n테스트 추가\n\n[감독 input 제안 — 다음 라운드에서 반드시 검토]\n입력 제안 A\n입력 제안 B',
    });
  });

  it('빈 감독 제안은 재투입 사유를 만들지 않는다', () => {
    expect(mergeReworkNotes([{ source: 'supervisor', note: '  ' }])).toEqual({ sources: [], note: '' });
  });

  it('종료 분류은 병합 순서가 아니라 모든 사유의 명시적 우선순위로 review를 보존한다', () => {
    expect(resolveReworkKind(['supervisor', 'review'])).toBe('review');
    expect(resolveReworkKind(['review', 'gate', 'supervisor'])).toBe('review');
    expect(resolveReworkKind(['gate', 'supervisor'])).toBe('supervisor');
    expect(resolveReworkKind([])).toBe('gate');
  });
});

describe('rework 예산 — UNCONVERGEABLE 종료 근거', () => {
  it('첫 재작업은 source와 무관하게 UNCONVERGEABLE을 관측만 하고 다음 수정 시도를 보장한다', () => {
    for (const kind of ['review', 'gate', 'supervisor'] as const) {
      expect(applyReworkBudgetDecision(2, { verdict: 'UNCONVERGEABLE', reason: '재발' }, 5, kind, 0))
        .toEqual({ effectiveMax: 2, stop: false, exit: 'continue', applied: false, shadowed: false });
      expect(applyReworkBudgetDecision(2, { verdict: 'UNCONVERGEABLE', reason: '재발' }, 5, kind, 0, true))
        .toEqual({ effectiveMax: 2, stop: false, exit: 'continue', applied: false, shadowed: false });
    }
  });

  it('이전 라운드가 1 이상이면 종전대로 즉시 종료한다', () => {
    expect(applyReworkBudgetDecision(2, { verdict: 'UNCONVERGEABLE', reason: '재발' }, 5, 'review', 1))
      .toEqual({ effectiveMax: 2, stop: true, exit: 'blocked', applied: true });
  });

  it('가드는 UNCONVERGEABLE 에만 걸린다 — EXTEND·SUFFICIENT 는 이력 0 에서도 종전대로', () => {
    expect(applyReworkBudgetDecision(2, { verdict: 'EXTEND', reason: '좁아짐' }, 5, 'review', 0).effectiveMax).toBe(3);
    expect(applyReworkBudgetDecision(2, { verdict: 'SUFFICIENT', reason: '비블로커' }, 5, 'review', 0))
      .toEqual({ effectiveMax: 2, stop: true, exit: 'proceed', applied: true });
  });

  it('priorRounds 미지정이면 종전 동작(무회귀) — 기존 호출자가 안 깨진다', () => {
    expect(applyReworkBudgetDecision(2, { verdict: 'UNCONVERGEABLE', reason: '재발' }))
      .toEqual({ effectiveMax: 2, stop: true, exit: 'blocked', applied: true });
  });
});

// 대표 09-25 BACKLOG B9 — 재작업 승급은 codex·anthropic 이 아닐 때만.
import { escalationAllowedForProvider, isRepeatedUnverifiedOnlyGateFailure, unverifiedRepeatKey } from './rework-policy.js';
it('escalation is suppressed for codex and anthropic only', () => {
  for (const p of ['openai-codex', 'anthropic', 'auto:openai-codex']) expect(escalationAllowedForProvider(p)).toBe(false);
  for (const p of ['grok', 'openrouter', 'local', 'gemini', undefined]) expect(escalationAllowedForProvider(p)).toBe(true);
});

describe('isRepeatedUnverifiedOnlyGateFailure — 미검증 집합이 반복 열쇠', () => {
  const prev = unverifiedRepeatKey(['src/b.ts', 'src/a.ts']);
  it('같은 집합(순서 무관) ⊕ 실패 0 이면 반복', () => {
    expect(isRepeatedUnverifiedOnlyGateFailure({ previousKey: prev, unverified: ['src/a.ts', 'src/b.ts'], gateLog: '0 fail' })).toBe(true);
  });
  it('첫 등장·빈 집합·다른 집합·실패 시험·도입 실패는 반복이 아니다', () => {
    expect(isRepeatedUnverifiedOnlyGateFailure({ previousKey: undefined, unverified: ['src/a.ts'], gateLog: '' })).toBe(false);
    expect(isRepeatedUnverifiedOnlyGateFailure({ previousKey: prev, unverified: [], gateLog: '' })).toBe(false);
    expect(isRepeatedUnverifiedOnlyGateFailure({ previousKey: prev, unverified: ['src/a.ts'], gateLog: '' })).toBe(false);
    expect(isRepeatedUnverifiedOnlyGateFailure({ previousKey: prev, unverified: ['src/a.ts', 'src/b.ts'], gateLog: '2 fail' })).toBe(false);
    expect(isRepeatedUnverifiedOnlyGateFailure({ previousKey: prev, unverified: ['src/a.ts', 'src/b.ts'], gateLog: '', introduced: 1 })).toBe(false);
  });
});
