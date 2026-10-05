import { test, expect, describe, spyOn } from 'bun:test';
import { debug } from '../debug/log.js';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveSelfDevRun, loadSelfDevRun, selfDevRunsDir } from './run-store.js';
import { decideNextRun, superviseRun, madeProgress, countLanded, countBaseCompleted, appendRound, SUPERVISOR_STOP_REASONS, type SupervisorRound, type SupervisorStopReason } from './run-supervisor.js';

const merged = (id: string) => ({ taskId: id, feature: id, status: 'done', stage: 'merged', merged: true }) as never;
const worktreeCompleted = (id: string) => ({ taskId: id, feature: id, status: 'done', stage: 'worktree-completed' }) as never;
const mergedWithGoalPlanRevision = (goalPlanRevision: unknown) => ({
  taskId: 'a', feature: 'a', status: 'done', stage: 'merged', merged: true, goalPlanRevision,
}) as never;
const lockRace = (id: string) => ({
  taskId: id, feature: id, status: 'failed', stage: 'error',
  error: { code: 'SELF_IMPL_FAILED', message: "error: cannot lock ref 'refs/remotes/origin/main': is at abc123" },
}) as never;
const depFailed = (id: string) => ({
  taskId: id, feature: id, status: 'cancelled', error: { code: 'DEP_FAILED', message: 'dependency failed' },
}) as never;
const unconverged = (id: string) => ({ taskId: id, feature: id, status: 'done', stage: 'pr-opened' }) as never;
const decomposable = (id: string, feature = id, pieces: Array<{ id: string; feature: string; dependsOn: string[] }> = [{ id: 'part-a', feature: 'part a', dependsOn: [] }, { id: 'part-b', feature: 'part b', dependsOn: [] }]) => ({
  taskId: id, feature, status: 'done', stage: 'pr-opened',
  decomposeProposal: { pieces },
}) as never;
const repairable = (id: string) => ({
  taskId: id, feature: id, status: 'done', stage: 'pr-opened', goalCauseObserved: true,
}) as never;
const mystery = (id: string) => ({
  taskId: id, feature: id, status: 'failed', stage: 'error',
  error: { code: 'BOOM', message: 'TypeError: undefined is not a function' },
}) as never;
const falseFailure = (id: string) => ({
  taskId: id, feature: id, status: 'failed', stage: 'merged', merged: true,
  error: { code: 'PARENT_SIGNAL_LOST', message: 'parent lost child completion signal' },
}) as never;

describe('런 슈퍼바이저 — 「끝까지 돌린다」의 판정', () => {
  test('finished merge timeout waits for human harvest instead of no-actionable-work', () => {
    const result = { taskId: 'finished', feature: 'finished', status: 'failed' as const, stage: 'timed-out', branch: 'self-impl/finished', harvestable: true as const };
    const decision = decideNextRun({ results: [result] });
    expect(decision).toMatchObject({ action: 'stop', stopReason: 'harvestable-awaiting-human' });
    expect(decision.why).toContain(result.branch);
    expect(SUPERVISOR_STOP_REASONS).toContain('harvestable-awaiting-human');
    expect(decideNextRun({ results: [{ ...result, harvestable: undefined }] }).stopReason).not.toBe('harvestable-awaiting-human');
  });
  test('each supervision sweep resumes deferred merges without rerunning an implemented job', async () => {
    let sweeps = 0;
    let reruns = 0;
    await superviseRun({ initial: [merged('a')], rerun: async (prior) => { reruns++; return prior; },
      sweepPendingMerges: async () => { sweeps++; return { pending: 0, merged: 1 }; } });
    expect(sweeps).toBe(1);
    expect(reruns).toBe(0);
  });
  test('⭐ 북극성 실물 — 다시 건다고 답한다(사람이 볼 것은 0이었다)', () => {
    const d = decideNextRun({
      results: [merged('2'), merged('4'), lockRace('3'), depFailed('5'), depFailed('6'), unconverged('0'), unconverged('1')],
    });
    expect(d.action).toBe('relaunch');
    expect(d.rerunnable.sort()).toEqual(['3', '5', '6']);
    expect(d.reworkable.sort()).toEqual(['0', '1']);
    expect(d.decomposable).toEqual([]);
    expect(d.repairable).toEqual([]);
    expect(d.needsHuman).toEqual([]);
  });

  test('수확 자식에게 넘긴 실패만 남으면 재시작하지 않고 인계 사유와 jobId를 기록한다', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    const handedOff = { taskId: 'salvaged', feature: 'salvaged', status: 'failed' as const, stage: 'review-blocked', salvage: 'launched' as const };
    let reruns = 0;
    try {
      const decision = decideNextRun({ results: [handedOff] });
      expect(decision).toMatchObject({ action: 'stop', stopReason: 'handed-off-to-salvage' });
      expect(decision.why).toContain('수확 자식에게 넘겼다');
      expect(decision.rerunnable).toEqual([]);
      expect(decision.reworkable).toEqual([]);
      expect(decision.decomposable).toEqual([]);
      expect(decision.repairable).toEqual([]);
      expect(SUPERVISOR_STOP_REASONS).toContain('handed-off-to-salvage');
      expect(log).toHaveBeenCalledWith('self-dev.supervisor', 'handed-off-to-salvage', { jobId: 'salvaged' });
      const decisions: string[] = [];
      await superviseRun({
        initial: [handedOff],
        rerun: async (previous) => { reruns++; return previous; },
        onDecision: (next) => decisions.push(next.stopReason ?? 'none'),
      });
      expect(reruns).toBe(0);
      expect(decisions).toEqual(['handed-off-to-salvage']);
    } finally { log.mockRestore(); }
  });

  test('인계된 재실행·재작업·분해·수리 후보를 제외하고 남은 실패만 다시 건다', () => {
    const results = [
      { taskId: 'retry-handed', feature: 'retry-handed', status: 'failed' as const, stage: 'review-blocked', salvage: 'launched' as const },
      { taskId: 'rework-handed', feature: 'rework-handed', status: 'done' as const, stage: 'pr-opened', salvage: 'launched' as const },
      { taskId: 'split-handed', feature: 'split-handed', status: 'done' as const, stage: 'pr-opened', decomposeProposal: { pieces: [{ id: 'a', feature: 'a', dependsOn: [] }, { id: 'b', feature: 'b', dependsOn: [] }] }, salvage: 'launched' as const },
      { taskId: 'repair-handed', feature: 'repair-handed', status: 'done' as const, stage: 'pr-opened', goalCauseObserved: true as const, salvage: 'launched' as const },
      lockRace('retry-active'),
    ];
    const decision = decideNextRun({ results });
    expect(decision.action).toBe('relaunch');
    expect(decision.rerunnable).toEqual(['retry-active']);
    expect(decision.reworkable).toEqual([]);
    expect(decision.decomposable).toEqual([]);
    expect(decision.repairable).toEqual([]);
    expect(appendRound([], results)[0]?.actionable).toBe(1);
    for (const salvage of [undefined, 'parked'] as const) {
      const retry = decideNextRun({ results: [{ taskId: 'ordinary', feature: 'ordinary', status: 'failed' as const, stage: 'error', error: { code: 'SELF_IMPL_FAILED', message: "error: cannot lock ref 'refs/remotes/origin/main': is at abc123" }, ...(salvage ? { salvage } : {}) }] });
      expect(retry.action).toBe('relaunch');
      expect(retry.rerunnable).toEqual(['ordinary']);
    }
  });

  test('전부 착지하면 converged 로 «선다»', () => {
    const d = decideNextRun({ results: [merged('a'), merged('b')] });
    expect(d.action).toBe('stop');
    expect(d.stopReason).toBe('converged');
  });

  test('사람 중단과 부모 신호 적색 정지 사유는 닫힌 어휘에 예약되지만 기존 판정 흐름은 바꾸지 않는다', () => {
    const humanStopped: SupervisorStopReason = 'human-stopped';
    const parentSignalsRed: SupervisorStopReason = 'parent-signals-red';
    expect(SUPERVISOR_STOP_REASONS).toContain(humanStopped);
    expect(SUPERVISOR_STOP_REASONS).toContain(parentSignalsRed);
    expect(decideNextRun({ results: [merged('a')] })).toMatchObject({
      action: 'stop',
      stopReason: 'converged',
    });
  });

  test('생략한 merge 완결성과 review must-fix 추세는 명시적으로 unmeasured이며 기존 완주를 보존한다', () => {
    const d = decideNextRun({ results: [merged('a')] });
    expect(d.stopReason).toBe('converged');
    expect(d.deliverableMergeCompleteness).toBe('unmeasured');
    expect(d.reviewMustFixTrend).toBe('unmeasured');
  });

  test('완결 병합 증거만 merge 전용 이유로 재시작을 멈추며 부분 병합은 기존 완주 판정을 보존한다', () => {
    const incomplete = decideNextRun({ results: [merged('a')], deliverableMerge: { expected: 2, merged: 1 } });
    const complete = decideNextRun({ results: [merged('a')], deliverableMerge: { expected: 2, merged: 2 } });
    expect(incomplete.stopReason).toBe('converged');
    expect(incomplete.deliverableMergeCompleteness).toBe('incomplete');
    expect(complete.stopReason).toBe('deliverable-merged');
    expect(complete.deliverableMergeCompleteness).toBe('complete');
    expect(complete.why).toBe('산출물 전체가 이미 병합됐다 — 기대 2 · 병합 2');
  });

  test('완결 병합은 미해결 조각이 재시작 가능한 경우에도 재발사를 막고, 생략·부분 병합은 기존 동작을 보존한다', () => {
    const results = [lockRace('retry')];
    const omitted = decideNextRun({ results });
    const incomplete = decideNextRun({ results, deliverableMerge: { expected: 2, merged: 1 } });
    const complete = decideNextRun({ results, deliverableMerge: { expected: 2, merged: 2 } });
    expect(omitted).toMatchObject({ action: 'relaunch', deliverableMergeCompleteness: 'unmeasured' });
    expect(incomplete).toMatchObject({ action: 'relaunch', deliverableMergeCompleteness: 'incomplete' });
    expect(complete).toMatchObject({ action: 'stop', stopReason: 'deliverable-merged', deliverableMergeCompleteness: 'complete' });
  });

  test('review must-fix 추세는 측정값을 보존하지만 병합 전용 정지를 만들지 않는다', () => {
    const d = decideNextRun({ results: [merged('a')], reviewMustFixTrend: 'worsening' });
    expect(d.stopReason).toBe('converged');
    expect(d.reviewMustFixTrend).toBe('worsening');
  });

  test('리뷰 미실행 사유는 no-diff만 converged로, 실패와 생략은 review-unobserved로 가른다', () => {
    const results = [merged('a')];
    expect(decideNextRun({ results, reviewed: true }).stopReason).toBe('converged');
    expect(decideNextRun({ results, reviewed: false, reviewReason: 'no-diff' }).stopReason).toBe('converged');
    expect(decideNextRun({ results, reviewed: false, reviewReason: 'reviewer unavailable' }).stopReason).toBe('review-unobserved');
    expect(decideNextRun({ results, reviewed: false }).stopReason).toBe('review-unobserved');
    expect(decideNextRun({ results }).stopReason).toBe('converged');
  });

  test('⛔ 모르는 실패만 남으면 needs-human 으로 «선다» — 무한 재실행 금지', () => {
    const d = decideNextRun({ results: [merged('a'), mystery('x')] });
    expect(d.action).toBe('stop');
    expect(d.stopReason).toBe('needs-human');
    expect(d.needsHuman).toEqual(['x']);
  });

  test('false-failure만 남고 자동·사람 작업이 모두 0이면 no-actionable-work으로 멈춘다', () => {
    const d = decideNextRun({ results: [falseFailure('signal-lost')] });
    expect(d.action).toBe('stop');
    expect(d.stopReason).toBe('no-actionable-work');
    expect(d.stopReason).not.toBe('converged');
    expect(d.stopReason).not.toBe('needs-human');
    expect(d.needsHuman).toEqual([]);
    expect(d.rerunnable).toEqual([]);
    expect(d.reworkable).toEqual([]);
    expect(d.decomposable).toEqual([]);
    expect(d.repairable).toEqual([]);
    expect(d.classifications).toMatchObject([{ taskId: 'signal-lost', kind: 'false-failure', action: 'no-action' }]);
    expect(d.why).toBe('자동으로 다시 걸 수 있는 조각도 사람이 볼 것도 없다 — 미해결 분류는 완료로 재분류하지 않는다');
  });

  test('quota-only rerun candidates stop immediately with provider and count, not goal blame', () => {
    const quota = { taskId: 'q', feature: 'q', status: 'failed', stage: 'timed-out', failureClassification: 'provider-error', providerErrors: { count: 5, provider: 'grok', category: 'quota' } } as const;
    const decision = decideNextRun({ results: [quota], history: [{ round: 0, landed: 0, actionable: 1 }, { round: 1, landed: 0, actionable: 1 }] });
    expect(decision.action).toBe('stop');
    expect(decision.stopReason).toBe('provider-exhausted');
    expect(decision.why).toContain('grok');
    expect(decision.why).toContain('5');
    expect(decision.why).toContain('elanous usage');
    expect(decision.why).not.toContain('골·불변식');
    expect(decision.classifications[0]).toMatchObject({ kind: 'transient', action: 'rerun' });
    expect(decideNextRun({ results: [{ ...quota, providerErrors: { ...quota.providerErrors, category: 'other' as const } }] }).action).toBe('relaunch');
    expect(decideNextRun({ results: [quota, lockRace('other')] }).action).toBe('relaunch');
    expect(decideNextRun({ results: [quota, { ...quota, taskId: 'q2', providerErrors: undefined }] }).action).toBe('relaunch');
  });

  test('a stall whose retry candidates all timed out names step-timeout instead of blaming the goal', () => {
    const history = [{ round: 0, landed: 0, actionable: 1 }, { round: 1, landed: 0, actionable: 1 }];
    const timedOut = { taskId: 't', feature: 't', status: 'failed', stage: 'timed-out', failureClassification: 'provider-error', providerErrors: { count: 3, provider: 'grok', category: 'other' } } as const;
    const decision = decideNextRun({ results: [timedOut], history });
    expect(decision.action).toBe('stop');
    expect(decision.stopReason).toBe('step-timeout');
    expect(decision.why).toContain('단계 시간 초과');
    expect(decision.why).toContain('grok 3건');
    expect(decision.why).not.toContain('골·불변식');
    // 같은 제자리라도 시간 초과가 아닌 실패면 종전대로 no-progress.
    const gateFailed = { taskId: 'g', feature: 'g', status: 'failed', stage: 'gate-failed', failureClassification: 'provider-error' } as const;
    expect(decideNextRun({ results: [gateFailed], history }).stopReason).toBe('no-progress');
    // 섞여 있으면 이름을 대지 않는다.
    expect(decideNextRun({ results: [timedOut, gateFailed], history: [{ round: 0, landed: 0, actionable: 2 }, { round: 1, landed: 0, actionable: 2 }] }).stopReason).not.toBe('step-timeout');
  });

  test('superviseRun does not invoke rerun for quota-only failures', async () => {
    let reruns = 0;
    const decisions: string[] = [];
    await superviseRun({
      initial: [{ taskId: 'q', feature: 'q', status: 'failed', stage: 'timed-out', failureClassification: 'provider-error', providerErrors: { count: 5, provider: 'grok', category: 'quota' } }],
      rerun: async (previous) => { reruns++; return previous; },
      onDecision: (decision) => { decisions.push(decision.stopReason ?? 'none'); },
    });
    expect(reruns).toBe(0);
    expect(decisions).toEqual(['provider-exhausted']);
  });

  test('⛔ 라운드 상한에 닿으면 «상한에 닿았다»고 말한다(조용히 계속하지 않는다)', () => {
    const history: SupervisorRound[] = [
      { round: 0, landed: 1, actionable: 3 },
      { round: 1, landed: 1, actionable: 2 },
      { round: 2, landed: 1, actionable: 1 },
    ];
    const d = decideNextRun({ results: [lockRace('z')], history, limits: { maxRounds: 3 } });
    expect(d.action).toBe('stop');
    expect(d.stopReason).toBe('max-rounds');
    expect(d.why).toContain('3');
  });

  test('⭐⛔ 퇴화 — 분해 제안이 없으면 기존 «제자리» 사유와 문면으로 선다', () => {
    const history: SupervisorRound[] = [
      { round: 0, landed: 0, actionable: 2 },
      { round: 1, landed: 0, actionable: 2 },
    ];
    // 이번 라운드도 landed 0 · actionable 2 ⇒ 3연속 제자리
    const d = decideNextRun({ results: [lockRace('p'), lockRace('q')], history, limits: { maxRounds: 9, stallRounds: 2 } });
    expect(d.action).toBe('stop');
    expect(d.stopReason).toBe('no-progress');
    expect(d.why).toBe('2라운드 연속 제자리 — base=main 기준 완료 0 · 착지 0 · 남은 조각도 안 줄었다(2). 골·불변식을 의심할 자리 · 골 개정 관측 불가 — 결과에 관측이 없다');
  });

  test('리뷰 must-fix improving 추이는 이력에 실려 제자리 정지를 막지만 stable·worsening·unmeasured는 막지 않는다', () => {
    const history: SupervisorRound[] = [
      { round: 0, landed: 0, actionable: 1, reviewMustFixTrend: 'stable' },
      { round: 1, landed: 0, actionable: 1, reviewMustFixTrend: 'stable' },
    ];
    const results = [lockRace('retry')];

    const improving = decideNextRun({
      results,
      history,
      limits: { maxRounds: 9, stallRounds: 2 },
      reviewMustFixTrend: 'improving',
    });
    expect(improving.action).toBe('relaunch');
    expect(improving.stopReason).not.toBe('no-progress');
    expect(improving.reviewMustFixTrend).toBe('improving');

    for (const reviewMustFixTrend of ['stable', 'worsening', undefined] as const) {
      expect(decideNextRun({
        results,
        history,
        limits: { maxRounds: 9, stallRounds: 2 },
        ...(reviewMustFixTrend === undefined ? {} : { reviewMustFixTrend }),
      }).stopReason).toBe('no-progress');
    }
  });

  test('improving 추이가 반복되어도 기존 max-rounds 상한에서 멈춘다', () => {
    const history: SupervisorRound[] = [
      { round: 0, landed: 0, actionable: 1, reviewMustFixTrend: 'improving' },
      { round: 1, landed: 0, actionable: 1, reviewMustFixTrend: 'improving' },
      { round: 2, landed: 0, actionable: 1, reviewMustFixTrend: 'improving' },
    ];
    const d = decideNextRun({
      results: [lockRace('retry')],
      history,
      limits: { maxRounds: 3, stallRounds: 2 },
      reviewMustFixTrend: 'improving',
    });

    expect(d).toMatchObject({ action: 'stop', stopReason: 'max-rounds', reviewMustFixTrend: 'improving' });
  });

  test('madeProgress는 improving만 추가 신호로 쓰며 landed와 actionable 감소를 보존한다', () => {
    const previous: SupervisorRound = { round: 0, landed: 0, actionable: 3, reviewMustFixTrend: 'stable' };
    expect(madeProgress(previous, { round: 1, landed: 0, actionable: 3, reviewMustFixTrend: 'improving' })).toBe(true);
    expect(madeProgress(previous, { round: 1, landed: 0, actionable: 3, reviewMustFixTrend: 'stable' })).toBe(false);
    expect(madeProgress(previous, { round: 1, landed: 0, actionable: 3, reviewMustFixTrend: 'worsening' })).toBe(false);
    expect(madeProgress(previous, { round: 1, landed: 0, actionable: 3, reviewMustFixTrend: 'unmeasured' })).toBe(false);
    expect(madeProgress(previous, { round: 1, landed: 1, actionable: 3, reviewMustFixTrend: 'stable' })).toBe(true);
    expect(madeProgress(previous, { round: 1, landed: 0, actionable: 2, reviewMustFixTrend: 'stable' })).toBe(true);
  });

  test('퇴화 중 두 조각 이상 분해 제안은 제자리와 구별해 목표·조각 수·조각 설명을 말한다', () => {
    const history: SupervisorRound[] = [
      { round: 0, landed: 0, actionable: 1 },
      { round: 1, landed: 0, actionable: 1 },
    ];
    const d = decideNextRun({
      results: [decomposable('split', '결제 흐름', [
        { id: 'api', feature: 'API 분리', dependsOn: [] },
        { id: 'ui', feature: 'UI 분리', dependsOn: ['api'] },
      ])],
      history,
      limits: { maxRounds: 9, stallRounds: 2 },
    });
    expect(d.action).toBe('stop');
    expect(d.stopReason).toBe('decomposable-no-progress');
    expect(d.stopReason).not.toBe('no-progress');
    expect(d.why).toBe('2라운드 연속 제자리지만 분해 제안이 있다 — 결제 흐름을(를) 조각 2개로: API 분리 · UI 분리');
  });

  test('수리 조각만 있으면 taskId를 직접 보존하고 add-repair-task로 판정한다', () => {
    const d = decideNextRun({ results: [repairable('repair-a'), repairable('repair-b')] });
    expect(d.action).toBe('add-repair-task');
    expect(d.repairable).toEqual(['repair-a', 'repair-b']);
    expect(d.decomposable).toEqual([]);
    expect(d.why).toContain('수리 조각을 붙인다');
  });

  test('수리 조각은 재실행·재작업·분해와 섞여도 add-repair-task를 우선한다', () => {
    const d = decideNextRun({ results: [repairable('repair'), lockRace('retry'), unconverged('rework'), decomposable('split')] });
    expect(d.action).toBe('add-repair-task');
    expect(d.repairable).toEqual(['repair']);
    expect(d.rerunnable).toEqual(['retry']);
    expect(d.reworkable).toEqual(['rework']);
    expect(d.decomposable).toEqual(['split']);
  });

  test('수리 조각만 남아도 실제 수를 기록하고 제자리 정지 사유에 드러낸다', () => {
    const history: SupervisorRound[] = [
      { round: 0, landed: 0, actionable: 2 },
      { round: 1, landed: 0, actionable: 2 },
    ];
    const results = [repairable('a'), repairable('b')];
    const d = decideNextRun({ results, history, limits: { maxRounds: 9, stallRounds: 2 } });
    expect(d.action).toBe('stop');
    expect(d.stopReason).toBe('no-progress');
    expect(d.repairable).toEqual(['a', 'b']);
    expect(d.why).toContain('2');
    expect(appendRound(history, results)[2]).toEqual({ round: 2, landed: 0, actionable: 2 });
    expect(madeProgress({ round: 0, landed: 0, actionable: 3 }, { round: 1, landed: 0, actionable: 1 })).toBe(true);
  });

  test('분해 조각만 있으면 taskId를 직접 보존하고 기존 relaunch를 유지한다', () => {
    const results = [decomposable('split-a'), decomposable('split-b')];
    const d = decideNextRun({ results });
    expect(d.action).toBe('relaunch');
    expect(d.decomposable).toEqual(['split-a', 'split-b']);
    expect(d.repairable).toEqual([]);
    expect(d.why).toContain('분해 2');
    expect(appendRound([], results)).toEqual([{ round: 0, landed: 0, actionable: 2 }]);
  });

  test('rerunnable 만 있는 기존 입력의 판정과 숫자는 그대로다', () => {
    const d = decideNextRun({ results: [lockRace('a'), lockRace('b')] });
    expect(d.action).toBe('relaunch');
    expect(d.why).toContain('그대로 재실행 2');
    expect(appendRound([], [lockRace('a'), lockRace('b')])).toEqual([{ round: 0, landed: 0, actionable: 2 }]);
  });

  test('⭐ 착지가 «하나라도» 있으면 제자리가 아니다 — 계속 돈다', () => {
    const history: SupervisorRound[] = [
      { round: 0, landed: 0, actionable: 2 },
      { round: 1, landed: 0, actionable: 2 },
    ];
    const d = decideNextRun({ results: [merged('ok'), lockRace('p'), lockRace('q')], history, limits: { maxRounds: 9, stallRounds: 2 } });
    expect(d.action).toBe('relaunch');
  });

  test('남은 조각이 «줄면» 진전이다', () => {
    expect(madeProgress({ round: 0, landed: 0, actionable: 5 }, { round: 1, landed: 0, actionable: 3 })).toBe(true);
    expect(madeProgress({ round: 0, landed: 0, actionable: 3 }, { round: 1, landed: 0, actionable: 3 })).toBe(false);
    expect(madeProgress(undefined, { round: 0, landed: 0, actionable: 3 })).toBe(true);
  });

  test('열린 PR(done · pr-opened · 미병합)은 2라운드여도 needs-human 이고 why 에 번호와 mergeReason 이 있다', () => {
    const openPr = {
      taskId: 'open-pr', feature: 'open-pr', status: 'done', stage: 'pr-opened', merged: false,
      prNumber: 19915, mergeReason: 'decision-signal-red',
    } as never;
    const first = decideNextRun({ results: [openPr] });
    expect(first.action).toBe('stop');
    expect(first.stopReason).toBe('needs-human');
    expect(first.why).toContain('19915');
    expect(first.why).toContain('decision-signal-red');
    expect(first.why).not.toContain('골·불변식을 의심');
    expect(first.reworkable).toEqual([]);
    const second = decideNextRun({
      results: [openPr],
      history: [{ round: 0, landed: 0, actionable: 0 }],
    });
    expect(second.stopReason).toBe('needs-human');
    expect(second.stopReason).not.toBe('no-progress');
    expect(second.stopReason).not.toBe('decomposable-no-progress');
    expect(second.why).toContain('19915');
    expect(second.why).toContain('decision-signal-red');
    expect(second.classifications.map((c) => `${c.kind}:${c.action}`)).toEqual(['awaiting-human:needs-human']);
  });
  test('ok=true 이고 자기 base 대비 커밋이 있으면 착지 0 이어도 제자리가 아니다', () => {
    const finished = (id: string) => ({
      taskId: id, feature: id, status: 'done', stage: 'committed', merged: false,
      ok: true, base: 'bench/x', commitsAheadOfBase: 2,
    }) as never;
    const stillOpen = {
      taskId: 'open', feature: 'open', status: 'done', stage: 'pr-opened', merged: false,
      ok: false, base: 'bench/x', commitsAheadOfBase: 0,
    } as never;
    const history: SupervisorRound[] = [
      { round: 0, landed: 0, baseCompleted: 1, base: 'bench/x', actionable: 2 },
      { round: 1, landed: 0, baseCompleted: 1, base: 'bench/x', actionable: 2 },
    ];
    const results = [finished('a'), finished('b'), stillOpen];
    const next = appendRound(history, results)[2]!;
    expect(countLanded(results)).toBe(0);
    expect(countBaseCompleted(results)).toBe(2);
    expect(next).toEqual({ round: 2, landed: 0, baseCompleted: 2, base: 'bench/x', actionable: 3 });
    expect(madeProgress(history[1], next)).toBe(true);
    const decision = decideNextRun({ results, history, limits: { maxRounds: 9, stallRounds: 2 } });
    expect(decision.stopReason).not.toBe('no-progress');
    expect(decision.action).toBe('relaunch');
  });

  test('ok=true 여도 base 대비 커밋이 0 이면 지금처럼 제자리다', () => {
    const empty = (id: string) => ({
      taskId: id, feature: id, status: 'done', stage: 'committed', merged: false,
      ok: true, base: 'bench/x', commitsAheadOfBase: 0,
    }) as never;
    const history: SupervisorRound[] = [
      { round: 0, landed: 0, baseCompleted: 0, base: 'bench/x', actionable: 1 },
      { round: 1, landed: 0, baseCompleted: 0, base: 'bench/x', actionable: 1 },
    ];
    const results = [empty('a'), lockRace('stuck')];
    const decision = decideNextRun({ results, history, limits: { maxRounds: 9, stallRounds: 2 } });
    expect(countBaseCompleted(results)).toBe(0);
    expect(decision.stopReason).toBe('no-progress');
    expect(decision.why).toContain('base=bench/x 기준 완료 0 · 착지 0');
    expect(madeProgress(history[1], appendRound(history, results)[2]!)).toBe(false);
  });

  test('커밋이 있어도 ok 가 아니면 완료로 세지 않는다', () => {
    const unfinished = (id: string) => ({
      taskId: id, feature: id, status: 'failed', stage: 'gate-failed',
      ok: false, base: 'bench/x', commitsAheadOfBase: 2,
    }) as never;
    const history: SupervisorRound[] = [
      { round: 0, landed: 0, actionable: 1 },
      { round: 1, landed: 0, actionable: 1 },
    ];
    const results = [unfinished('a')];
    expect(countBaseCompleted(results)).toBe(0);
    expect(appendRound(history, results)[2]).toEqual({ round: 2, landed: 0, baseCompleted: 0, base: 'bench/x', actionable: 1 });
    const decision = decideNextRun({ results, history, limits: { maxRounds: 9, stallRounds: 2 } });
    expect(decision.stopReason).toBe('no-progress');
    expect(decision.why).toContain('base=bench/x 기준 완료 0 · 착지 0');
  });

  test('worktree-only 완료는 병합 없이 라운드 진전이며 남은 실패는 다시 건다', () => {
    const first = [lockRace('a'), lockRace('b')];
    const second = [worktreeCompleted('a'), lockRace('b')];
    const history = appendRound([], first);
    const next = appendRound(history, second)[1]!;
    expect(history[0]).toEqual({ round: 0, landed: 0, actionable: 2 });
    expect(countLanded(second)).toBe(1);
    expect(next).toEqual({ round: 1, landed: 1, actionable: 1 });
    expect(madeProgress(history[0], next)).toBe(true);
    const decision = decideNextRun({ results: second, history, limits: { maxRounds: 9, stallRounds: 1 } });
    expect(decision.action).toBe('relaunch');
    expect(decision.stopReason).not.toBe('no-progress');
    expect(decision.rerunnable).toEqual(['b']);
    expect(decision.reworkable).toEqual([]);
    expect(decision.decomposable).toEqual([]);
  });

  test('countLanded — done 이 아니라 merged 를 센다(그 둘은 다른 값)', () => {
    expect(countLanded([merged('a'), unconverged('b')])).toBe(1);
    expect(countLanded([unconverged('b')])).toBe(0);
  });

  test('appendRound — 라운드 기록이 «잰 값»으로 쌓인다', () => {
    let h = appendRound([], [merged('a'), lockRace('b')]);
    expect(h).toEqual([{ round: 0, landed: 1, actionable: 1 }]);
    h = appendRound(h, [merged('b')]);
    expect(h[1]).toEqual({ round: 1, landed: 1, actionable: 0 });
  });

  test('appendRound는 결정의 이미 정규화된 review must-fix 추이를 다음 제자리 비교용 이력에 보존한다', () => {
    const history = appendRound([], [lockRace('retry')], 'improving');
    expect(history).toEqual([{ round: 0, landed: 0, actionable: 1, reviewMustFixTrend: 'improving' }]);
    expect(madeProgress(history[0], { round: 1, landed: 0, actionable: 1, reviewMustFixTrend: 'stable' })).toBe(false);
  });

  test('⛔ 이 모듈은 아무것도 «실행»하지 않는다 — 판정만 낸다', () => {
    const src = require('node:fs').readFileSync(require('node:path').join(import.meta.dir, 'run-supervisor.ts'), 'utf-8');
    // ⛔ 문자열 포함으로 세지 않는다 — 이 파일 «주석»이 respawn 을 인용하고 있어서 그렇게 세면 거짓 양성이 난다.
    //   (2026-08-19: 첫 판이 정확히 그것으로 걸렸다.) 실행을 뜻하는 «호출·import» 만 본다.
    expect(src).not.toMatch(/child_process/);
    expect(src).not.toMatch(/spawnSync\(|execFileSync\(|execSync\(/);
    expect(src).not.toMatch(/orchestrateSelfDev\(/);
  });

  test('골 개정 관측을 실은 결과가 없으면 no-progress 정지 문면에 관측 불가를 구별해 낸다', () => {
    const noObservation = decideNextRun({
      results: [lockRace('a')],
      history: [
        { round: 0, landed: 0, actionable: 1 },
        { round: 1, landed: 0, actionable: 1 },
      ],
    });
    const noAttempts = decideNextRun({
      results: [
        {
          taskId: 'a', feature: 'a', status: 'failed', stage: 'error',
          error: { code: 'SELF_IMPL_FAILED', message: "error: cannot lock ref 'refs/remotes/origin/main': is at abc123" },
          goalPlanRevision: { status: 'read', attempted: 0, applied: 0, failureReasons: [] },
        } as never,
      ] as never,
      history: [
        { round: 0, landed: 0, actionable: 1 },
        { round: 1, landed: 0, actionable: 1 },
      ],
    });

    expect(noObservation.stopReason).toBe('no-progress');
    expect(noObservation.why).toBe('2라운드 연속 제자리 — base=main 기준 완료 0 · 착지 0 · 남은 조각도 안 줄었다(1). 골·불변식을 의심할 자리 · 골 개정 관측 불가 — 결과에 관측이 없다');
    expect(noObservation.why).not.toContain('골 개정 시도 없음 — 원장을 읽었으나 시도 0 · 적용 0');
    expect(noObservation.why).not.toBe(noAttempts.why);
    expect(noAttempts.why).toBe('2라운드 연속 제자리 — base=main 기준 완료 0 · 착지 0 · 남은 조각도 안 줄었다(1). 골·불변식을 의심할 자리 · 골 개정 시도 없음 — 원장을 읽었으나 시도 0 · 적용 0');
  });

  test('골 개정 관측을 아직 읽지 않았음을 정지 문면에 구별해 낸다', () => {
    const d = decideNextRun({
      results: [mergedWithGoalPlanRevision(undefined)],
    });
    expect(d.stopReason).toBe('converged');
    expect(d.why).toBe('완주 — 미해결 조각 0 · 이번 라운드 착지 1 · 골 개정 관측을 아직 읽지 않았다');
  });

  test('골 개정 관측 읽기 실패를 정지 사유는 바꾸지 않고 이유로 낸다', () => {
    const d = decideNextRun({
      results: [mergedWithGoalPlanRevision({
        status: 'read-failed', reason: 'unreadable-files', scannedFiles: 2, unreadableFiles: 1, ledgerDirectory: '/tmp/ledger',
      })],
    });
    expect(d.stopReason).toBe('converged');
    expect(d.why).toBe('완주 — 미해결 조각 0 · 이번 라운드 착지 1 · 골 개정 관측 읽기 실패 — unreadable-files');
  });

  test('읽었지만 골 개정 시도가 없던 결과를 정지 문면에 구별해 낸다', () => {
    const d = decideNextRun({
      results: [mergedWithGoalPlanRevision({
        status: 'read', attempted: 0, applied: 0, failureReasons: [],
      })],
    });
    expect(d.stopReason).toBe('converged');
    expect(d.why).toBe('완주 — 미해결 조각 0 · 이번 라운드 착지 1 · 골 개정 시도 없음 — 원장을 읽었으나 시도 0 · 적용 0');
  });

  test('전부 실패한 골 개정 시도는 횟수·적용 수·이름 있는 실패 사유를 정지 문면에 낸다', () => {
    const d = decideNextRun({
      results: [mergedWithGoalPlanRevision({
        status: 'read', attempted: 2, applied: 0, failureReasons: ['contract-conflict', 'budget-exhausted'],
      })],
    });
    expect(d.stopReason).toBe('converged');
    expect(d.why).toBe('완주 — 미해결 조각 0 · 이번 라운드 착지 1 · 골 개정 시도 2 · 적용 0 · 실패 사유 contract-conflict · budget-exhausted');
  });

  test('혼합 shard의 미읽음과 읽은 시도 결과를 함께 보존한다', () => {
    const d = decideNextRun({
      results: [
        mergedWithGoalPlanRevision(undefined),
        { taskId: 'b', feature: 'b', status: 'done', stage: 'merged', merged: true,
          goalPlanRevision: { status: 'read', attempted: 2, applied: 1, failureReasons: ['budget-exhausted'] } } as never,
      ],
    });
    expect(d.stopReason).toBe('converged');
    expect(d.why).toBe('완주 — 미해결 조각 0 · 이번 라운드 착지 2 · 골 개정 관측을 아직 읽지 않았다 · 골 개정 시도 2 · 적용 1 · 실패 사유 budget-exhausted');
  });

  test('혼합 shard의 읽기 실패와 성공한 읽기 결과를 함께 보존한다', () => {
    const d = decideNextRun({
      results: [
        mergedWithGoalPlanRevision({
          status: 'read-failed', reason: 'unreadable-files', scannedFiles: 2, unreadableFiles: 1, ledgerDirectory: '/tmp/ledger',
        }),
        { taskId: 'b', feature: 'b', status: 'done', stage: 'merged', merged: true,
          goalPlanRevision: { status: 'read', attempted: 3, applied: 2, failureReasons: ['contract-conflict'] } } as never,
      ],
    });
    expect(d.stopReason).toBe('converged');
    expect(d.why).toBe('완주 — 미해결 조각 0 · 이번 라운드 착지 2 · 골 개정 관측 읽기 실패 — unreadable-files · 골 개정 시도 3 · 적용 2 · 실패 사유 contract-conflict');
  });

  test('혼합 read shard의 성공과 적용 실패를 합산해 실패 사유를 보존한다', () => {
    const d = decideNextRun({
      results: [
        mergedWithGoalPlanRevision({ status: 'read', attempted: 1, applied: 1, failureReasons: [] }),
        { taskId: 'b', feature: 'b', status: 'done', stage: 'merged', merged: true,
          goalPlanRevision: { status: 'read', attempted: 2, applied: 0, failureReasons: ['expected-text-not-found'] } } as never,
      ],
    });
    expect(d.stopReason).toBe('converged');
    expect(d.why).toBe('완주 — 미해결 조각 0 · 이번 라운드 착지 2 · 골 개정 시도 3 · 적용 1 · 실패 사유 expected-text-not-found');
  });

  test('wiring — superviseRun decision observations retain runId while dev-cli and orchestrate-cli keep their existing surface wrappers', async () => {
    const runId = 'decision-observation-run-id';
    const observations: Array<{ event: string; data: Record<string, unknown> }> = [];

    await superviseRun({
      initial: [{
        taskId: 'landed', feature: 'landed', status: 'done', stage: 'merged', merged: true, runId,
      } as never],
      rerun: async (previous) => previous,
      limits: { maxRounds: 1 },
      observe: (event, data) => { observations.push({ event, data }); },
    });

    expect(observations.find(({ event }) => event === 'decision')?.data.runId).toBe(runId);
  });

  test('superviseRun forwards no-diff only when every unreviewed child has no diff', async () => {
    const stopReasonFor = async (reviewReasons: Array<string | undefined>): Promise<string | undefined> => {
      const decisions: Array<{ stopReason?: string }> = [];
      await superviseRun({
        initial: reviewReasons.map((reviewReason, index) => ({
          taskId: `unreviewed-${index}`, feature: 'unreviewed', status: 'done', stage: 'merged', merged: true, reviewed: false,
          ...(reviewReason !== undefined ? { reviewReason } : {}),
        })),
        rerun: async (previous) => previous,
        onDecision: (decision) => { decisions.push(decision); },
      });
      expect(decisions).toHaveLength(1);
      return decisions[0]?.stopReason;
    };

    expect(await stopReasonFor(['no-diff'])).toBe('converged');
    expect(await stopReasonFor(['reviewer unavailable'])).toBe('review-unobserved');
    expect(await stopReasonFor([undefined])).toBe('review-unobserved');
    expect(await stopReasonFor(['no-diff', 'reviewer unavailable'])).toBe('review-unobserved');
    expect(await stopReasonFor(['reviewer unavailable', 'no-diff'])).toBe('review-unobserved');
    expect(await stopReasonFor(['no-diff', undefined])).toBe('review-unobserved');
    expect(await stopReasonFor([undefined, 'no-diff'])).toBe('review-unobserved');
    expect(await stopReasonFor(['no-diff', 'no-diff'])).toBe('converged');
  });

  test('wiring — decideNextRun이 내부 formatter를 정지 문면에 연결하고 runSelfOrchestrateCliCommand의 superviseRun 경로가 판정에 닿는다', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const supervisor = fs.readFileSync(path.join(import.meta.dir, 'run-supervisor.ts'), 'utf-8');
    const caller = fs.readFileSync(path.join(import.meta.dir, 'orchestrate-cli.ts'), 'utf-8');
    expect(supervisor).toMatch(/const goalPlanRevisionObservation = formatGoalPlanRevisionObservation\(results\)/);
    expect(supervisor).toMatch(/why: withGoalPlanRevisionObservation\(/);
    expect(supervisor).not.toMatch(/export function formatGoalPlanRevisionObservation/);
    expect(supervisor).toMatch(/const decision = decideNextRun\(/);
    expect(caller).toMatch(/export async function runSelfOrchestrateCliCommand[\s\S]*?results = await superviseRun\(/);
  });
});

describe('산출물의 «눈» — 판정 «전»에 보고, 「안 쟀다」와 「못 쟀다」를 가른다', () => {
  const brokenDeploy = new Map([
    ['single', { target: 'http://127.0.0.1:31415/', findings: [{ kind: 'empty-body', certainty: 'confirmed' } as never] }],
  ]);

  test('⭐⭐ 눈이 「깨졌다」고 답하면 «판정»이 그것을 본다 — 종전엔 구조적으로 못 봤다', () => {
    const landed = { taskId: 'single', feature: 'f', status: 'done', stage: 'merged', merged: true } as never;
    const blind = decideNextRun({ results: [landed] });
    const seeing = decideNextRun({ results: [landed], deployFindings: brokenDeploy });
    // ⛔ 같은 결과인데 «눈이 있을 때만» 조치할 것이 생긴다.
    expect(blind.classifications.length).toBe(0);
    expect(seeing.classifications.length).toBeGreaterThan(0);
    expect(seeing.classifications.some((c) => c.kind === 'deliverable-broken')).toBe(true);
  });

  test("⛔ 「못 쟀다」는 「결함 0」이 «아니다» — deliverableUnmeasured 가 판정에 흐른다", () => {
    const landed = { taskId: 'single', feature: 'f', status: 'done', stage: 'merged', merged: true } as never;
    // ⛔⭐ 세 상태가 «서로 다른 값»이어야 한다 — boolean 으로 접으면 둘이 뭉개진다.
    const notAttempted = decideNextRun({ results: [landed] });
    const failed = decideNextRun({ results: [landed], deliverableObservation: 'failed' });
    const observed = decideNextRun({ results: [landed], deployFindings: new Map(), deliverableObservation: 'observed' });

    expect(notAttempted.deliverableObservation).toBe('not-attempted');
    expect(failed.deliverableObservation).toBe('failed');
    expect(observed.deliverableObservation).toBe('observed');
    // 🔑 그리고 앞의 «둘»은 서로도 달라야 한다 — 「원래 볼 게 없다」와 「봐야 하는데 못 봤다」.
    expect(notAttempted.deliverableObservation).not.toBe(failed.deliverableObservation);
    // ⊕ 「봤다」만 「결함 0」을 말할 자격이 있다.
    expect(observed.deliverableUnmeasured).toBe(false);
    // ⛔ 「모르는 기본값」 금지 — findings 가 «왔는데» 상태를 안 주면 「안 달았다」가 아니라 「봤다」다.
    const inferred = decideNextRun({ results: [landed], deployFindings: new Map() });
    expect(inferred.deliverableObservation).toBe('observed');
    expect(notAttempted.deliverableUnmeasured).toBe(true);
    expect(failed.deliverableUnmeasured).toBe(true);
  });

  test('superviseRun observes the same run identifier at both entrances and reuses the result fallback for terminal persistence', async () => {
    const operatorDir = mkdtempSync(join(tmpdir(), 'supervisor-decision-run-id-'));
    const runStoreRunId = 'run-store-wins';
    const resultRunId = 'result-fallback';
    saveSelfDevRun({ runId: runStoreRunId, createdAt: 1, updatedAt: 1, results: [] }, operatorDir);
    saveSelfDevRun({ runId: resultRunId, createdAt: 1, updatedAt: 1, results: [] }, operatorDir);
    const observations: Array<{ event: string; data: Record<string, unknown> }> = [];

    await superviseRun({
      initial: [{
        taskId: 'unknown', feature: 'unknown', status: 'failed', stage: 'error', runId: resultRunId,
        error: { code: 'BOOM', message: 'TypeError: undefined is not a function' },
      } as never],
      rerun: async (previous) => previous,
      runStore: { runId: runStoreRunId, operatorDir },
      observe: (event, data) => { observations.push({ event, data }); },
    });

    expect(observations.find(({ event }) => event === 'decision')!.data.runId).toBe(runStoreRunId);
    expect(observations).toContainEqual({
      event: 'supervisor-stop.persisted',
      data: {
        runId: runStoreRunId,
        reason: 'needs-human',
        outcome: 'persisted',
        storagePath: operatorDir,
        storageSource: 'operator-dir',
      },
    });

    const fallbackObservations: Array<{ event: string; data: Record<string, unknown> }> = [];
    await superviseRun({
      initial: [{
        taskId: 'unknown', feature: 'unknown', status: 'failed', stage: 'error', runId: resultRunId,
        error: { code: 'BOOM', message: 'TypeError: undefined is not a function' },
      } as never],
      rerun: async (previous) => previous,
      runStore: { operatorDir },
      observe: (event, data) => { fallbackObservations.push({ event, data }); },
    });

    expect(fallbackObservations.find(({ event }) => event === 'decision')!.data.runId).toBe(resultRunId);
    expect(fallbackObservations).toContainEqual({
      event: 'supervisor-stop.persisted',
      data: {
        runId: resultRunId,
        reason: 'needs-human',
        outcome: 'persisted',
        storagePath: operatorDir,
        storageSource: 'operator-dir',
      },
    });
  });

  test('superviseRun observes a missing run identifier as null rather than omitting it', async () => {
    const observations: Array<{ event: string; data: Record<string, unknown> }> = [];
    await superviseRun({
      initial: [{
        taskId: 'unknown', feature: 'unknown', status: 'failed', stage: 'error',
        error: { code: 'BOOM', message: 'TypeError: undefined is not a function' },
      } as never],
      rerun: async (previous) => previous,
      observe: (event, data) => { observations.push({ event, data }); },
    });

    expect(observations.find(({ event }) => event === 'decision')!.data).toMatchObject({ runId: null });
  });

  test('superviseRun writes terminal reasons to the operator store rather than an isolated checkpoint directory', async () => {
    const operatorDir = mkdtempSync(join(tmpdir(), 'supervisor-stop-operator-'));
    const isolatedDir = mkdtempSync(join(tmpdir(), 'supervisor-stop-isolated-'));
    const runId = 'persisted-needs-human';
    saveSelfDevRun({ runId, createdAt: 1, updatedAt: 1, results: [] }, operatorDir);
    saveSelfDevRun({ runId, createdAt: 1, updatedAt: 1, results: [] }, isolatedDir);

    const observations: Array<{ event: string; data: Record<string, unknown> }> = [];
    await superviseRun({
      initial: [{
        taskId: 'unknown', feature: 'unknown', status: 'failed', stage: 'error', runId,
        error: { code: 'BOOM', message: 'TypeError: undefined is not a function' },
      } as never],
      rerun: async (previous) => previous,
      runStore: { runId, operatorDir, isolatedDir },
      observe: (event, data) => { observations.push({ event, data }); },
    });

    expect(loadSelfDevRun(runId, operatorDir)?.supervisorStopReason).toBe('needs-human');
    expect(loadSelfDevRun(runId, isolatedDir)?.supervisorStopReason).toBeUndefined();
    expect(observations).toContainEqual({
      event: 'supervisor-stop.persisted',
      data: {
        runId,
        reason: 'needs-human',
        outcome: 'persisted',
        storagePath: operatorDir,
        storageSource: 'operator-dir',
      },
    });
  });

  test('superviseRun preserves the legacy runStore dir as the operator-store alias', async () => {
    const operatorDir = mkdtempSync(join(tmpdir(), 'supervisor-stop-legacy-operator-'));
    const isolatedDir = mkdtempSync(join(tmpdir(), 'supervisor-stop-legacy-isolated-'));
    const runId = 'legacy-operator-dir';
    saveSelfDevRun({ runId, createdAt: 1, updatedAt: 1, results: [] }, operatorDir);
    saveSelfDevRun({ runId, createdAt: 1, updatedAt: 1, results: [] }, isolatedDir);

    await superviseRun({
      initial: [{
        taskId: 'unknown', feature: 'unknown', status: 'failed', stage: 'error', runId,
        error: { code: 'BOOM', message: 'TypeError: undefined is not a function' },
      } as never],
      rerun: async (previous) => previous,
      runStore: { runId, dir: operatorDir, isolatedDir },
    });

    expect(loadSelfDevRun(runId, operatorDir)?.supervisorStopReason).toBe('needs-human');
    expect(loadSelfDevRun(runId, isolatedDir)?.supervisorStopReason).toBeUndefined();
  });

  test('superviseRun observes a missing operator run record using the result runId', async () => {
    const operatorDir = mkdtempSync(join(tmpdir(), 'supervisor-stop-missing-'));
    const runId = 'missing-operator-record';
    const observations: Array<{ event: string; data: Record<string, unknown> }> = [];

    await superviseRun({
      initial: [{
        taskId: 'unknown', feature: 'unknown', status: 'failed', stage: 'error', runId,
        error: { code: 'BOOM', message: 'TypeError: undefined is not a function' },
      } as never],
      rerun: async (previous) => previous,
      runStore: { operatorDir },
      observe: (event, data) => { observations.push({ event, data }); },
    });

    expect(observations).toContainEqual({
      event: 'supervisor-stop.missing-record',
      data: {
        runId,
        reason: 'needs-human',
        outcome: 'missing-record',
        storagePath: operatorDir,
        storageSource: 'operator-dir',
      },
    });
  });

  test('superviseRun records run-store-dir and process-default storage sources without selecting isolatedDir', async () => {
    const runStoreDir = mkdtempSync(join(tmpdir(), 'supervisor-stop-run-store-'));
    const isolatedDir = mkdtempSync(join(tmpdir(), 'supervisor-stop-default-isolated-'));
    const legacyRunId = 'legacy-store-source';
    saveSelfDevRun({ runId: legacyRunId, createdAt: 1, updatedAt: 1, results: [] }, runStoreDir);
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    await superviseRun({
      initial: [{ taskId: 'unknown', feature: 'unknown', status: 'failed', stage: 'error', runId: legacyRunId,
        error: { code: 'BOOM', message: 'TypeError: undefined is not a function' } } as never],
      rerun: async (previous) => previous,
      runStore: { runId: legacyRunId, dir: runStoreDir, isolatedDir },
      observe: (event, data) => { events.push({ event, data }); },
    });
    expect(events).toContainEqual({
      event: 'supervisor-stop.persisted',
      data: {
        runId: legacyRunId,
        reason: 'needs-human',
        outcome: 'persisted',
        storagePath: runStoreDir,
        storageSource: 'run-store-dir',
      },
    });
    // loadSelfDevRun falls back to the machine-ledger mirror (#22313), so check isolatedDir's own checkpoint file.
    expect(existsSync(join(isolatedDir, `${legacyRunId}.json`))).toBe(false);

    const missingDir = join(mkdtempSync(join(tmpdir(), 'supervisor-stop-missing-dir-')), 'absent');
    const missingDirectoryEvents: Array<{ event: string; data: Record<string, unknown> }> = [];
    await superviseRun({
      initial: [{ taskId: 'unknown', feature: 'unknown', status: 'failed', stage: 'error', runId: 'missing-dir-source',
        error: { code: 'BOOM', message: 'TypeError: undefined is not a function' } } as never],
      rerun: async (previous) => previous,
      runStore: { operatorDir: missingDir },
      observe: (event, data) => { missingDirectoryEvents.push({ event, data }); },
    });
    expect(missingDirectoryEvents).toContainEqual({
      event: 'supervisor-stop.missing-directory',
      data: {
        runId: 'missing-dir-source',
        reason: 'needs-human',
        outcome: 'missing-directory',
        storagePath: missingDir,
        storageSource: 'operator-dir',
      },
    });

    const ioErrorPath = join(mkdtempSync(join(tmpdir(), 'supervisor-stop-io-error-')), 'not-a-directory');
    writeFileSync(ioErrorPath, 'not a run store');
    const ioErrorEvents: Array<{ event: string; data: Record<string, unknown> }> = [];
    await superviseRun({
      initial: [{ taskId: 'unknown', feature: 'unknown', status: 'failed', stage: 'error', runId: 'io-error-source',
        error: { code: 'BOOM', message: 'TypeError: undefined is not a function' } } as never],
      rerun: async (previous) => previous,
      runStore: { operatorDir: ioErrorPath },
      observe: (event, data) => { ioErrorEvents.push({ event, data }); },
    });
    expect(ioErrorEvents).toContainEqual({
      event: 'supervisor-stop.io-error',
      data: {
        runId: 'io-error-source',
        reason: 'needs-human',
        outcome: 'io-error',
        storagePath: ioErrorPath,
        storageSource: 'operator-dir',
      },
    });

    const defaultStateDir = mkdtempSync(join(tmpdir(), 'supervisor-stop-process-default-'));
    const defaultRunId = `process-default-source-${crypto.randomUUID()}`;
    const defaultRunStoreDir = selfDevRunsDir(defaultStateDir);
    const priorStateDir = process.env.ELANOUS_STATE_DIR;
    const defaultEvents: Array<{ event: string; data: Record<string, unknown> }> = [];
    try {
      mkdirSync(defaultRunStoreDir, { recursive: true });
      process.env.ELANOUS_STATE_DIR = defaultStateDir;
      await superviseRun({
        initial: [{ taskId: 'unknown', feature: 'unknown', status: 'failed', stage: 'error', runId: defaultRunId,
          error: { code: 'BOOM', message: 'TypeError: undefined is not a function' } } as never],
        rerun: async (previous) => previous,
        observe: (event, data) => { defaultEvents.push({ event, data }); },
      });
    } finally {
      if (priorStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = priorStateDir;
      rmSync(defaultStateDir, { recursive: true, force: true });
    }
    expect(defaultEvents).toContainEqual({
      event: 'supervisor-stop.missing-record',
      data: {
        runId: defaultRunId,
        reason: 'needs-human',
        outcome: 'missing-record',
        storagePath: defaultRunStoreDir,
        storageSource: 'process-default',
      },
    });
  });

  test('⭐ superviseRun 이 라운드마다 눈을 «부른다» — 그리고 그 답이 판정에 실린다', async () => {
    let called = 0;
    const seen: string[] = [];
    await superviseRun({
      initial: [{ taskId: 'single', feature: 'f', status: 'done', stage: 'merged', merged: true } as never],
      limits: { maxRounds: 1 },
      observeDeliverables: async () => {
        called += 1;
        return { deployFindings: brokenDeploy, unmeasured: [] };
      },
      observe: (event) => { seen.push(event); },
      rerun: async (prev) => prev,
    });
    expect(called).toBeGreaterThan(0);
    expect(seen).toContain('decision');
  });

  test('성공한 눈의 주소별 결과와 세 상태가 관측 기록에 남는다', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const landed = { taskId: 'single', feature: 'f', status: 'done', stage: 'merged', merged: true } as never;
    await superviseRun({
      initial: [landed],
      limits: { maxRounds: 1 },
      observeDeliverables: async () => ({
        deployFindings: new Map([['single', { target: 'http://127.0.0.1:31415/', findings: [] }]]),
        unmeasured: [],
      }),
      observe: (event, data) => { events.push({ event, data }); },
      rerun: async (previous) => previous,
    });

    expect(events.find(({ event }) => event === 'deliverable-observe.observed')!.data).toEqual({
      addressCount: 1,
      results: [{ taskId: 'single', target: 'http://127.0.0.1:31415/', findings: [] }],
      unmeasured: [],
    });
    expect(events.find(({ event }) => event === 'decision')!.data).toMatchObject({
      deliverableObservation: 'observed',
      deliverableUnmeasured: false,
    });

    const states: Array<Record<string, unknown>> = [];
    for (const observeDeliverables of [
      undefined,
      async () => { throw new Error('CDP 없음'); },
    ] as const) {
      await superviseRun({
        initial: [landed],
        limits: { maxRounds: 1 },
        ...(observeDeliverables ? { observeDeliverables } : {}),
        observe: (event, data) => { if (event === 'decision') states.push(data); },
        rerun: async (previous) => previous,
      });
    }
    expect(states).toEqual([
      expect.objectContaining({ deliverableObservation: 'not-attempted', deliverableUnmeasured: true }),
      expect.objectContaining({ deliverableObservation: 'failed', deliverableUnmeasured: true }),
    ]);
  });

  test('⛔⭐ 눈이 «죽으면» 「완주」라 부르지 않는다 — stopReason 이 갈린다', async () => {
    // ⚠️ 이 창의 앞선 주장(*"눈이 죽어도 루프가 «안 멈춘다»"*)은 «틀렸다»(리뷰 #10556).
    //   조각이 다 끝났으면 조치할 것이 없어 «멈추는 게 맞다». 문제는 «무슨 이름으로» 멈추냐였다.
    //   ⇒ 계약은 「안 멈춘다」가 아니라 ***「'converged' 라 부르지 않는다」***이다.
    const decisions: Array<{ stopReason?: string; deliverableObservation: string }> = [];
    await superviseRun({
      initial: [{ taskId: 'single', feature: 'f', status: 'done', stage: 'merged', merged: true } as never],
      limits: { maxRounds: 1 },
      observeDeliverables: async () => { throw new Error('CDP 없음'); },
      onDecision: (d) => { decisions.push(d as never); },
      rerun: async (prev) => prev,
    });
    expect(decisions[0]!.stopReason).toBe('deliverable-unobserved');
    expect(decisions[0]!.stopReason).not.toBe('converged');

    // 대조 — 눈이 «답을 내면» 같은 결과가 진짜 완주다.
    const ok: Array<{ stopReason?: string }> = [];
    await superviseRun({
      initial: [{ taskId: 'single', feature: 'f', status: 'done', stage: 'merged', merged: true } as never],
      limits: { maxRounds: 1 },
      observeDeliverables: async () => ({ deployFindings: new Map(), unmeasured: [] }),
      onDecision: (d) => { ok.push(d as never); },
      rerun: async (prev) => prev,
    });
    expect(ok[0]!.stopReason).toBe('converged');
  });

  test('⛔ 눈이 죽은 사실이 관측·판정 «양쪽»에 남는다', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const decisions: Array<{ deliverableObservation: string; deliverableUnmeasured: boolean }> = [];
    const out = await superviseRun({
      initial: [{ taskId: 'single', feature: 'f', status: 'done', stage: 'merged', merged: true } as never],
      limits: { maxRounds: 1 },
      observeDeliverables: async () => { throw new Error('CDP 없음'); },
      observe: (event, data) => { events.push({ event, data }); },
      onDecision: (d) => { decisions.push(d); },
      rerun: async (prev) => prev,
    });
    expect(out).toHaveLength(1);                                   // 루프가 멈추지 않았다
    expect(events.some((e) => e.event === 'deliverable-observe.failed')).toBe(true);
    // ⛔⭐ 이벤트만 보면 «두 상태가 붕괴돼도» 통과한다(리뷰 #10556: Goodhart 시험).
    //   ⇒ 「판정에 «무엇으로» 남았나」를 문다 — 눈이 죽었으면 'failed' 여야 하고 'not-attempted' 면 안 된다.
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.deliverableObservation).toBe('failed');
    expect(decisions[0]!.deliverableUnmeasured).toBe(true);
  });

  test('supervisor rerun callback alone receives the relaunch marker', async () => {
    const invocations: Array<{ relaunch: true }> = [];
    await superviseRun({
      initial: [decomposable('split')],
      limits: { maxRounds: 1 },
      rerun: async (_previous, invocation) => {
        invocations.push(invocation);
        return [merged('split')];
      },
    });
    expect(invocations).toEqual([{ relaunch: true }]);
  });

  test('분해 승격 심을 생략하면 기존 재실행과 decision 관측이 유지된다', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    let reruns = 0;
    await superviseRun({
      initial: [decomposable('split')],
      limits: { maxRounds: 1 },
      observe: (event, data) => { events.push({ event, data }); },
      rerun: async () => {
        reruns += 1;
        return [merged('split')];
      },
    });
    expect(reruns).toBe(1);
    expect(events.find(({ event }) => event === 'decision')!.data).toMatchObject({
      decomposePromotionAttempted: false,
      decomposePromotionReason: 'shim-omitted',
    });
  });

  test('분해 판정이 있으면 승격 심을 부르고 기존 stop 사유를 늘리지 않는다', async () => {
    const calls: Array<{ decomposable: string[]; previous: string[] }> = [];
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const results = await superviseRun({
      initial: [decomposable('split')],
      limits: { maxRounds: 1 },
      promoteDecomposition: ({ decision, previous }) => {
        calls.push({ decomposable: decision.decomposable, previous: previous.map(({ taskId }) => taskId) });
        return { reason: 'promotion-deferred-for-test' };
      },
      observe: (event, data) => { events.push({ event, data }); },
      rerun: async () => [merged('split')],
    });
    expect(calls).toEqual([{ decomposable: ['split'], previous: ['split'] }]);
    expect(results).toHaveLength(1);
    expect(events.find(({ event }) => event === 'decision')!.data).toMatchObject({
      decomposePromotionAttempted: true,
      decomposePromotionReason: 'promotion-deferred-for-test',
    });
  });

  test('⭐ 승격 심이 «세는 값»을 내면 원장에 «구조화 필드»로 실린다 — 문자열을 파싱하지 않게', async () => {
    // 🩸 계기(2026-09-08): 조각 수·간선 수가 `reason` «문자열 안»에만 있어,
    //   두 트랙이 조각 실행을 진단하며 «각자 정규식»을 지었고 둘 다 n=1 로 끝났다.
    //   ⇒ 「문자열 안의 수」는 세는 사람마다 «다른 자»를 만든다.
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    await superviseRun({
      initial: [decomposable('split')],
      limits: { maxRounds: 1 },
      promoteDecomposition: () => ({
        reason: 'dev-piece-execution: 3 piece(s) topologically ordered',
        pieceCount: 3, dependsOnEdges: 2, hotPathEdges: 1,
      }),
      observe: (event, data) => { events.push({ event, data }); },
      rerun: async () => [merged('split')],
    });
    expect(events.find(({ event }) => event === 'decision')!.data).toMatchObject({
      decomposePromotionAttempted: true,
      decomposePieceCount: 3,
      decomposeDependsOnEdges: 2,
      decomposeHotPathEdges: 1,
    });
  });

  test('⛔ 승격이 «안 됐으면» 그 칸이 «없다» — 0 이 아니다(「안 셌음」과 「0」을 가른다)', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    await superviseRun({
      initial: [decomposable('split')],
      limits: { maxRounds: 1 },
      promoteDecomposition: () => ({ reason: 'promotion-deferred-for-test' }),   // 세는 값을 «안 낸다»
      observe: (event, data) => { events.push({ event, data }); },
      rerun: async () => [merged('split')],
    });
    const decision = events.find(({ event }) => event === 'decision')!.data;
    expect(decision).not.toHaveProperty('decomposePieceCount');
    expect(decision).not.toHaveProperty('decomposeDependsOnEdges');
    expect(decision).not.toHaveProperty('decomposeHotPathEdges');
  });

  test('정지 판정의 분해 제안은 승격 심을 호출하지 않고 이유를 관측한다', async () => {
    let promotions = 0;
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    await superviseRun({
      initial: [decomposable('split')],
      limits: { maxRounds: 0 },
      promoteDecomposition: () => {
        promotions += 1;
        return { reason: 'must-not-run-after-stop' };
      },
      observe: (event, data) => { events.push({ event, data }); },
      rerun: async (previous) => previous,
    });
    expect(promotions).toBe(0);
    expect(events.find(({ event }) => event === 'decision')!.data).toMatchObject({
      action: 'stop',
      stopReason: 'max-rounds',
      decomposePromotionAttempted: false,
      decomposePromotionReason: 'decision-stopped',
    });
  });

  test('⛔ 눈을 «안 달면» «판정»이 안 바뀐다 — ⚠️ 「바이트 동일」이 아니라 「결정 동일」이다', async () => {
    // ⚠️ 이 창의 앞선 주장(*"바이트 동일"*)은 «틀렸다»(리뷰 #10556):
    //   새 필드 둘이 «항상» 실리므로 객체는 달라진다. 지킬 수 있는 계약은 그것이 아니라
    //   ***「무엇을 할지(action)·왜 멈추는지(stopReason)·무엇이 걸렸는지(classifications)가 안 바뀐다」***이다.
    const landed = { taskId: 'single', feature: 'f', status: 'done', stage: 'merged', merged: true } as never;
    const decisions: unknown[] = [];
    await superviseRun({
      initial: [landed],
      limits: { maxRounds: 1 },
      onDecision: (d) => { decisions.push(d); },
      rerun: async (prev) => prev,
    });
    const d = decisions[0] as unknown as { action: string; stopReason?: string; classifications: unknown[]; deliverableObservation: string };
    const reference = decideNextRun({ results: [landed] });
    expect({ action: d.action, stopReason: d.stopReason, classifications: d.classifications })
      .toEqual({ action: reference.action, stopReason: reference.stopReason, classifications: reference.classifications });
    expect(d.deliverableObservation).toBe('not-attempted');
  });
});

describe('단일 경로 «실물 흐름» — 골 선언 → 타깃 → 눈 → 판정 → 수리 조각', () => {
  // ⛔ 리뷰 #10556 should-fix: 이 창이 «손으로 돌려» 본 흐름이 시험으로 재현되지 않았다.
  //   ⇒ 손으로 돌린 것은 「그때 됐다」이고, 시험은 「앞으로도 된다」다. 둘은 다른 값이다.
  //   ⚠️ 여기서 심으로 대신하는 것은 «브라우저 하나»뿐이다 — 그 위 층은 전부 진짜다.

  test('⭐⭐ dev --file 이 싣는 «골 문서 전문»에서 켜기 선언을 읽어 수리 조각까지 간다', async () => {
    const { buildDeliverableTargets } = await import('./deliverable-target-wiring.js');
    // `dev --file <골>` 이 feature 로 싣는 그 모양 — 문서 «전문»이다(dev-pipeline `feature: text`).
    const goalDocument = [
      '# 골', '', '## 산출물을 어떻게 켜나', '',
      '- Entrypoint: apps/demo/server.ts',
      '- Port: 31415',
      '- Environment: DEMO_TOKEN', '',
    ].join('\n');

    // ① 선언 → 타깃 (단일 경로가 self-implement-cli 에서 하는 것과 «같은 호출»)
    const wiring = buildDeliverableTargets(goalDocument, ['single'], 'all', '127.0.0.1');
    expect(wiring.wired).toBe(true);
    if (!wiring.wired) return;
    expect(wiring.targets).toEqual([{ taskId: 'single', target: 'http://127.0.0.1:31415/' }]);

    // ②~④ 눈 → 판정 → 조치
    const askedFor: string[] = [];
    const decisions: Array<{ action: string; deliverableObservation: string; classifications: Array<{ kind: string; errorCode?: string }> }> = [];
    await superviseRun({
      initial: [{ taskId: 'single', feature: goalDocument, status: 'done', stage: 'merged', merged: true } as never],
      limits: { maxRounds: 1 },
      observeDeliverables: async () => {
        for (const t of wiring.targets) askedFor.push(t.target);
        return {
          deployFindings: new Map(wiring.targets.map((t) => [
            t.taskId,
            { target: t.target, findings: [{ kind: 'empty-body', certainty: 'confirmed' } as never] },
          ])),
          unmeasured: [],
        };
      },
      onDecision: (d) => { decisions.push(d as never); },
      rerun: async (prev) => prev,
    });

    expect(askedFor).toContain('http://127.0.0.1:31415/');       // 눈이 «그 URL 을» 봤다
    const first = decisions[0]!;
    expect(first.deliverableObservation).toBe('observed');        // 「봤다」가 값으로 남는다
    expect(first.classifications.map((c) => c.kind)).toContain('deliverable-broken');
    expect(first.action).toBe('add-repair-task');                 // 수리 조각이 붙는다
    // 🔑 지문이 «포트를 담는다» — 다른 앱과 안 섞인다(#10556 의 둘째 결함).
    expect(first.classifications[0]!.errorCode).toBe('web|empty-body|http://127.0.0.1:31415/');
  });

  test('⛔ 켜기 선언이 «없는» 골은 눈을 안 단다 — 빈 관측으로 「결함 0」을 만들지 않는다', async () => {
    const { buildDeliverableTargets } = await import('./deliverable-target-wiring.js');
    const w = buildDeliverableTargets('# 골\n\n본문뿐이다.\n', ['single'], 'all', '127.0.0.1');
    expect(w.wired).toBe(false);

    // 단일 경로는 이때 심을 «안 준다» ⇒ 판정은 'not-attempted' 여야 한다.
    const decisions: Array<{ deliverableObservation: string }> = [];
    await superviseRun({
      initial: [{ taskId: 'single', feature: 'f', status: 'done', stage: 'merged', merged: true } as never],
      limits: { maxRounds: 1 },
      onDecision: (d) => { decisions.push(d as never); },
      rerun: async (prev) => prev,
    });
    expect(decisions[0]!.deliverableObservation).toBe('not-attempted');
  });
});
