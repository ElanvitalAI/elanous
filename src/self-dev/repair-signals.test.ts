import { test, expect, describe } from 'bun:test';
import { analyzeRepairSignals } from './repair-signals.js';
import type { ParkedGoal } from './run-store.js';

const pg = (feature: string, over: Partial<ParkedGoal> = {}): ParkedGoal =>
  ({ feature, status: 'failed', runId: `r-${feature}`, updatedAt: 1, ...over });

describe('analyzeRepairSignals (G7 · 관측→수리 신호)', () => {
  test('같은 패턴의 서로 다른 run 2건+ → system 수리 후보 / 단일 run → goal 이슈', () => {
    const signals = analyzeRepairSignals([
      pg('A', { stage: 'merge-conflict', runId: 'first' }),
      pg('B', { stage: 'merge-conflict', runId: 'second' }),
      pg('C', { stage: 'review-blocked' }), // 단발
    ]);
    const bySys = new Map(signals.map((s) => [s.pattern, s]));
    expect(bySys.get('merge-conflict')!).toMatchObject({ kind: 'system', count: 2, runCount: 2 });
    expect(bySys.get('review-blocked')!).toMatchObject({ kind: 'goal', runCount: 1 });
  });

  test('한 run의 같은 패턴 여섯 항목은 원시 count 6·runCount 1로 보존하고 goal로 분류한다', () => {
    const signal = analyzeRepairSignals(
      Array.from({ length: 6 }, (_, index) => pg(`descendant ${index}`, { stage: 'gate-failed', runId: 'one-run' })),
    )[0]!;
    expect(signal).toMatchObject({ pattern: 'gate-failed', count: 6, runCount: 1, kind: 'goal' });
    expect(Object.keys(signal).sort()).toEqual(['affectedFeatures', 'count', 'hypothesis', 'kind', 'pattern', 'runCount']);
  });

  test('같은 패턴의 서로 다른 세 run 항목은 count 3·runCount 3로 보존하고 system으로 분류한다', () => {
    const signal = analyzeRepairSignals([
      pg('first', { stage: 'gate-failed', runId: 'one' }),
      pg('second', { stage: 'gate-failed', runId: 'two' }),
      pg('third', { stage: 'gate-failed', runId: 'three' }),
    ])[0]!;
    expect(signal).toMatchObject({ pattern: 'gate-failed', count: 3, runCount: 3, kind: 'system' });
  });

  test('취소된 하위 항목은 같은 run의 상위 실패 패턴으로 귀속하고 독립 run 증거가 되지 않는다', () => {
    const signal = analyzeRepairSignals([
      pg('upstream', { stage: 'gate-failed', runId: 'one-run' }),
      ...Array.from({ length: 5 }, (_, index) => pg(`cancelled ${index}`, { status: 'cancelled', runId: 'one-run' })),
    ])[0]!;
    expect(signal).toMatchObject({ pattern: 'gate-failed', count: 6, runCount: 1, kind: 'goal' });
  });

  test('복수 상위 실패의 취소 항목은 독립 신호로 집계하지 않는다', () => {
    const signals = analyzeRepairSignals([
      pg('first failure one', { stage: 'gate-failed', runId: 'one-run' }),
      pg('second failure one', { stage: 'review-blocked', runId: 'one-run' }),
      pg('cancelled descendant one', { status: 'cancelled', runId: 'one-run' }),
      pg('first failure two', { stage: 'gate-failed', runId: 'two-run' }),
      pg('second failure two', { stage: 'review-blocked', runId: 'two-run' }),
      pg('cancelled descendant two', { status: 'cancelled', runId: 'two-run' }),
    ]);
    expect(signals.some((signal) => signal.pattern === 'cancelled')).toBe(false);
    expect(signals.find((signal) => signal.pattern === 'gate-failed')).toMatchObject({ count: 2, runCount: 2, kind: 'system' });
    expect(signals.find((signal) => signal.pattern === 'review-blocked')).toMatchObject({ count: 2, runCount: 2, kind: 'system' });
  });

  test('취소 항목이 먼저여도 상위 실패의 분류 근거와 가설을 보존한다', () => {
    const input = [
      pg('cancelled descendant', { status: 'cancelled', runId: 'one-run' }),
      pg('upstream', {
        stage: 'review-blocked',
        runId: 'one-run',
        failureClassification: 'goal-unconvergeable-candidate',
        classificationBasis: 'upstream-basis',
      } as unknown as Partial<ParkedGoal>),
    ];
    const signal = analyzeRepairSignals(input)[0]!;
    expect(signal).toMatchObject({
      pattern: 'goal-unconvergeable-candidate', count: 2, runCount: 1, kind: 'goal', classificationBasis: 'upstream-basis',
    });
    expect(signal.hypothesis).toContain('goal 스펙');
  });

  test('system 신호가 먼저(actionable) · hypothesis 동봉', () => {
    const signals = analyzeRepairSignals([
      pg('C', { stage: 'review-blocked' }),
      pg('A', { error: { code: 'SELF_IMPL_FAILED', message: 'x' } }),
      pg('B', { error: { code: 'SELF_IMPL_FAILED', message: 'y' } }),
    ]);
    expect(signals[0]!.kind).toBe('system'); // system 우선 정렬
    expect(signals[0]!.pattern).toBe('SELF_IMPL_FAILED');
    expect(signals[0]!.hypothesis).toContain('worktree'); // 인프라 힌트
  });

  test('빈 입력 → 빈 신호', () => {
    expect(analyzeRepairSignals([])).toEqual([]);
  });

  test('stage 우선·없으면 errorCode·없으면 status 로 클러스터', () => {
    const s = analyzeRepairSignals([pg('A', { status: 'interrupted' }), pg('B', { status: 'interrupted' })]);
    expect(s[0]!.pattern).toBe('interrupted');
    expect(s[0]!.kind).toBe('system');
  });

  test('reconcileMismatch(false-failure) → salvage 신호 최상단(A 힐링)', () => {
    const s = analyzeRepairSignals([
      pg('A', { stage: 'gate-failed', reconcileMismatch: true }),
      pg('B', { stage: 'gate-failed' }),   // 정당 실패
    ]);
    expect(s[0]!.pattern).toBe('false-failure');   // salvage 우선(최상단)
    expect(s[0]!.kind).toBe('goal');
    expect(s[0]!.count).toBe(1);
    expect(s[0]!.runCount).toBe(1);
    expect(s[0]!.hypothesis).toContain('salvage');
    expect(s[0]!.hypothesis).toContain('재빌드 금지');
  });

  test('timed-out 다발 → hang 특정 수리 가설(B 근본수리 힐링 루프)', () => {
    const s = analyzeRepairSignals([pg('A', { stage: 'timed-out' }), pg('B', { stage: 'timed-out' })]);
    expect(s[0]!.pattern).toBe('timed-out');
    expect(s[0]!.kind).toBe('system');
    expect(s[0]!.hypothesis).toContain('step-timeout');   // 어느 step 이 끊기는지 로그로 특정하라는 힐링 방향
  });

  test('기록된 분류가 stage보다 우선하고 goal 원인·판정 근거를 드러낸다', () => {
    const s = analyzeRepairSignals([
      pg('goal cause', {
        stage: 'review-blocked',
        failureClassification: 'goal-unconvergeable-candidate',
        classificationBasis: 'supervisor-unconvergeable-goal-candidate',
      } as unknown as Partial<ParkedGoal>),
      pg('legacy review A', { stage: 'review-blocked' }),
      pg('legacy review B', { stage: 'review-blocked' }),
    ]);
    const byPattern = new Map(s.map((signal) => [signal.pattern, signal]));
    const classified = byPattern.get('goal-unconvergeable-candidate')!;
    expect(classified.kind).toBe('goal');
    expect(classified.hypothesis).toContain('goal-unconvergeable-candidate');
    expect(classified.hypothesis).toContain('goal 스펙');
    expect(classified.hypothesis).not.toContain('리뷰 기준');
    expect(classified.classificationBasis).toBe('supervisor-unconvergeable-goal-candidate');
    expect(byPattern.get('review-blocked')!.hypothesis).toContain('리뷰 기준');
  });

  test('goal-unconvergeable-candidate system 처방은 골 축·구현 축·둘을 가르는 관측을 명시한다', () => {
    const system = analyzeRepairSignals([
      pg('system A', { failureClassification: 'goal-unconvergeable-candidate', runId: 'system-one' } as unknown as Partial<ParkedGoal>),
      pg('system B', { failureClassification: 'goal-unconvergeable-candidate', runId: 'system-two' } as unknown as Partial<ParkedGoal>),
    ])[0]!;

    expect(system.kind).toBe('system');
    expect(system.hypothesis).toContain('goal 스펙의 모순·모호성');
    expect(system.hypothesis).toContain('자식 구현이 리뷰 must-fix 지적을 해결하지 못함');
    expect(system.hypothesis).toContain('반복된 must-fix 문면을 열어 goal 계약과 상충하는지 확인');
  });

  test('goal-unconvergeable-candidate goal 처방은 골 축·구현 축·둘을 가르는 관측을 명시한다', () => {
    const goal = analyzeRepairSignals([
      pg('goal', { failureClassification: 'goal-unconvergeable-candidate', runId: 'goal-one' } as unknown as Partial<ParkedGoal>),
    ])[0]!;

    expect(goal.kind).toBe('goal');
    expect(goal.hypothesis).toContain('goal 스펙의 모순·모호성');
    expect(goal.hypothesis).toContain('자식 구현이 리뷰 must-fix 지적을 해결하지 못함');
    expect(goal.hypothesis).toContain('반복된 must-fix 문면을 열어 goal 계약과 상충하는지 확인');
  });

  test('같은 stage의 유효한 서로 다른 분류는 각각 클러스터하고 신규 분류도 신호화한다', () => {
    const s = analyzeRepairSignals([
      pg('approved A', { stage: 'review-blocked', failureClassification: 'merge-approved-abandoned' } as unknown as Partial<ParkedGoal>),
      pg('approved B', { stage: 'review-blocked', failureClassification: 'merge-approved-abandoned' } as unknown as Partial<ParkedGoal>),
      pg('credential', { stage: 'review-blocked', failureClassification: 'credential-failure' } as unknown as Partial<ParkedGoal>),
    ]);
    const byPattern = new Map(s.map((signal) => [signal.pattern, signal]));
    expect(byPattern.get('merge-approved-abandoned')).toMatchObject({ count: 2, kind: 'system' });
    expect(byPattern.get('merge-approved-abandoned')!.hypothesis).toContain('착지');
    expect(byPattern.get('credential-failure')).toMatchObject({ count: 1, kind: 'goal' });
    expect(byPattern.has('review-blocked')).toBe(false);
  });

  test('원장 분류가 같은 파생 분류를 서로 다른 패턴·가설로 분리한다', () => {
    const signals = analyzeRepairSignals([
      pg('implementation', {
        runId: 'implementation-run',
        failureClassification: 'goal-unconvergeable-candidate',
        ledgerAbandonedClassification: 'implementation-deficit',
      }),
      pg('provider', {
        runId: 'provider-run',
        failureClassification: 'goal-unconvergeable-candidate',
        ledgerAbandonedClassification: 'provider-error',
      }),
    ]);
    const byPattern = new Map(signals.map((signal) => [signal.pattern, signal]));
    expect([...byPattern.keys()].sort()).toEqual(['implementation-deficit', 'provider-error']);
    expect(byPattern.get('implementation-deficit')).toMatchObject({ kind: 'goal', count: 1, runCount: 1 });
    expect(byPattern.get('provider-error')).toMatchObject({ kind: 'goal', count: 1, runCount: 1 });
    expect(byPattern.get('provider-error')!.hypothesis).toContain('provider 오류 단발');
    expect(byPattern.get('provider-error')!.hypothesis).not.toContain('두 원인 후보');
  });

  test('원장 분류가 없으면 파생 분류를 계속 우선하고 둘 다 없으면 stage로 떨어진다', () => {
    const signals = analyzeRepairSignals([
      pg('derived', {
        runId: 'derived-run',
        stage: 'review-blocked',
        failureClassification: 'contract-conflict',
        ledgerAbandonedClassification: null,
      }),
      pg('stage', {
        runId: 'stage-run',
        stage: 'gate-failed',
        ledgerAbandonedClassification: '',
      }),
    ]);
    const byPattern = new Map(signals.map((signal) => [signal.pattern, signal]));
    expect(byPattern.get('contract-conflict')).toMatchObject({ kind: 'goal', count: 1 });
    expect(byPattern.get('gate-failed')).toMatchObject({ kind: 'goal', count: 1 });
  });

  test('run-deadline-exceeded 는 수확·재분해 힌트이고 할당량 소진으로 읽지 않는다', () => {
    const signal = analyzeRepairSignals([
      pg('deadline', { stage: 'aborted', failureClassification: 'run-deadline-exceeded' } as unknown as Partial<ParkedGoal>),
    ])[0]!;
    expect(signal.pattern).toBe('run-deadline-exceeded');
    expect(signal.hypothesis).toContain('수확');
    expect(signal.hypothesis).toContain('재분해');
    expect(signal.hypothesis).not.toContain('쿼터');
  });
  test('already-satisfied repair advice says there is nothing to fix and does not ask to reinforce evidence', () => {
    const signal = analyzeRepairSignals([
      pg('already there', { stage: 'review-blocked', failureClassification: 'already-satisfied' } as unknown as Partial<ParkedGoal>),
    ])[0]!;
    expect(signal.pattern).toBe('already-satisfied');
    expect(signal.hypothesis).toContain('고칠 것이 없다');
    expect(signal.hypothesis).not.toMatch(/보강/);
    const report = analyzeRepairSignals([
      pg('report', { stage: 'review-blocked', failureClassification: 'report-deficit' } as unknown as Partial<ParkedGoal>),
    ])[0]!;
    expect(report.hypothesis).toContain('해당 goal의 산출물·완료 증거를 보강.');
  });

  test('원장 행처럼 failureClassification이 없으면 stage로 떨어져도 신호가 난다', () => {
    const s = analyzeRepairSignals([
      pg('ledger A', { stage: 'UNCONVERGEABLE', status: 'interrupted', runId: 'ledger-one' }),
      pg('ledger B', { stage: 'UNCONVERGEABLE', status: 'interrupted', runId: 'ledger-two' }),
    ]);
    expect(s[0]).toMatchObject({ pattern: 'UNCONVERGEABLE', count: 2, runCount: 2, kind: 'system' });
    expect(s[0]!.hypothesis).toContain('UNCONVERGEABLE');
  });

  test('없는·형식 불량 분류는 기존 stage/errorCode/status 폴백과 임계치를 보존한다', () => {
    const s = analyzeRepairSignals([
      pg('stage A', { stage: 'gate-failed', failureClassification: 'unknown-classification' } as unknown as Partial<ParkedGoal>),
      pg('stage B', { stage: 'gate-failed', classificationBasis: 42 } as unknown as Partial<ParkedGoal>),
      pg('error', { error: { code: 'SELF_IMPL_FAILED', message: 'x' }, failureClassification: { bad: true } } as unknown as Partial<ParkedGoal>),
    ]);
    const byPattern = new Map(s.map((signal) => [signal.pattern, signal]));
    expect(byPattern.get('gate-failed')).toMatchObject({ count: 2, kind: 'system' });
    expect(byPattern.get('gate-failed')!.hypothesis).toContain('gate');
    expect(byPattern.get('SELF_IMPL_FAILED')).toMatchObject({ count: 1, kind: 'goal' });
  });
});
