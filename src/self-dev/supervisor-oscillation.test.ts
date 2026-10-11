import { describe, expect, test, spyOn } from 'bun:test';
import { debug } from '../debug/log.js';
import { measureReviewRework } from '../self-implement/orchestrator.js';
import { parseSelfImplementJson } from '../task-orchestrator/surfaces/self-implement.js';
import { runSelfImplementCliCommand, singleRunAsJobResult } from '../self-implement/self-implement-cli.js';
import { orchestrateSelfDev } from './orchestrate.js';
import { aggregateReviewTrend, appendRound, decideNextRun, madeProgress, superviseRun } from './run-supervisor.js';
import { routeSupervisorVerdict } from './supervisor-verdict-edges.js';
import type { SupervisorJobResult } from './run-supervisor.js';

const signature = 'implementation-deficit:MF-a,MF-b';
const result = (trend: 'oscillating' | 'improving' = 'oscillating'): SupervisorJobResult => ({
  taskId: 'one', feature: 'original request', status: 'failed', stage: 'review-blocked', prNumber: 10,
  reviewMustFix: ['- fix A', '- fix B'], rework: { trend, signature, rounds: 4 },
});

describe('supervisor sees child review oscillation', () => {
  test('first decision authors a helper-repair fragment once, then the same task stops for human decision', async () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const first = decideNextRun({ results: [result()], repairGoalExecution: true });
      expect(first).toMatchObject({ action: 'add-repair-task', oscillation: { helper: 'review-oscillation', taskIds: ['one'], signature }, pendingDecision: 'attempt-care-escalation' });
      expect(first.oscillation?.repairGoals?.one).toContain('## 남은 must-fix (원문)\n- fix A\n- fix B');
      const history = appendRound([], [result()], first.reviewMustFixTrend, first);
      expect(history[0]?.oscillationRepairTaskIds).toEqual(['one', 'one']);
      expect(history[0]?.oscillationRepairFeatures).toEqual(['original request', first.oscillation!.repairGoals!.one]);
      // A rerun that ran the repair text as the piece's feature under a new taskId (orchestrate) is the same repaired goal.
      expect(decideNextRun({ results: [{ ...result(), taskId: 'repair-piece', feature: first.oscillation!.repairGoals!.one! }], history, repairGoalExecution: true }).stopReason).toBe('review-oscillating');
      expect(history[0]?.signatures?.one).toBe(signature);
      const second = decideNextRun({ results: [result()], history });
      expect(second).toMatchObject({ action: 'stop', stopReason: 'review-oscillating' });
      expect(second.why).toContain(signature);
      expect(routeSupervisorVerdict(second.stopReason!)).toMatchObject({ next: 'human-gate' });
      expect(second.why).toContain('사람 결정 필요(같은 전략 재발사 금지)');
      expect(log.mock.calls.filter((call) => call[0] === 'self-dev.supervisor' && call[1] === 'oscillation-seen')).toHaveLength(3);
      expect(madeProgress(history[0], { ...history[0]!, round: 1, reviewMustFixTrend: 'oscillating' })).toBe(false);
    } finally { log.mockRestore(); }
  });

  test('same nonempty signature in preceding round blocks improving relaunch; different task or missing data does not', () => {
    const prior = appendRound([], [result('improving')]);
    expect(decideNextRun({ results: [result('improving')], history: prior, repairGoalExecution: true }).action).toBe('add-repair-task');
    expect(decideNextRun({ results: [{ ...result('improving'), taskId: 'two' }], history: prior }).action).toBe('relaunch');
    expect(decideNextRun({ results: [{ ...result(), rework: undefined }], history: prior }).action).toBe('relaunch');
  });

  test('without original must-fix or PR, no same-strategy relaunch is allowed', () => {
    const decision = decideNextRun({ results: [{ ...result(), prNumber: undefined, reviewMustFix: undefined }], repairGoalExecution: true });
    expect(decision).toMatchObject({ action: 'stop', stopReason: 'review-oscillating' });
    expect(decision.why).toContain('수리 원문/PR 관측 불가');
    const declined = decideNextRun({ results: [result()], repairGoalExecution: false });
    expect(declined.action).toBe('stop');
    expect(declined.why).toContain('수리 골 실행을 선언하지 않았다');
  });

  test('pure decision without a caller flag names the first repair (goal signal 1)', () => {
    expect(decideNextRun({ results: [result()] })).toMatchObject({ action: 'add-repair-task', oscillation: { helper: 'review-oscillation' } });
  });

  test('repair is tracked per task: a repaired task is held for a human while a fresh one gets its first repair', () => {
    const first = decideNextRun({ results: [result()], repairGoalExecution: true });
    const history = appendRound([], [result()], first.reviewMustFixTrend, first);
    const other: SupervisorJobResult = { ...result(), taskId: 'two', feature: 'other request' };
    const mixed = decideNextRun({ results: [result(), other], history, repairGoalExecution: true });
    expect(mixed).toMatchObject({ action: 'add-repair-task', oscillation: { taskIds: ['two'] } });
    expect(mixed.needsHuman).toContain('one');
    expect([...mixed.rerunnable, ...mixed.reworkable, ...mixed.decomposable, ...mixed.repairable]).not.toContain('one');
    expect(Object.keys(mixed.oscillation?.repairGoals ?? {})).toEqual(['two']);
  });

  test('dev surface runs the authored repair goal through the piece executor once, then stops on the second oscillation', async () => {
    const { executeDevSelfRun } = await import('./dev-cli.js');
    const oscillatingRun = (runId: string) => ({ runId, ok: false, stage: 'review-blocked', node: 'review', outcome: 'abandoned', prNumber: 10,
      review: { reviewed: true, verdict: 'fail', mustFix: ['- fix A'], shouldFix: [] }, rework: { trend: 'oscillating', signature, rounds: 4 } }) as never;
    let executions = 0;
    const pieces: string[] = [];
    const executed = await executeDevSelfRun('oscillating goal', async () => { executions++; return oscillatingRun(`dev-${executions}`); }, {
      rounds: 4, printDecision: () => {},
      executePiece: async (pieceFeature) => { pieces.push(pieceFeature); return oscillatingRun(`piece-${pieces.length}`); },
    });
    expect(executions).toBe(1);
    expect(pieces).toHaveLength(1);
    expect(pieces[0]).toContain('## 남은 must-fix (원문)\n- fix A');
    expect(executed.supervisorStopReason).toBe('review-oscillating');
  });

  test('dev surface without a piece executor cannot run the repair goal: one execution, stop review-oscillating', async () => {
    const { executeDevSelfRun } = await import('./dev-cli.js');
    let executions = 0;
    const executed = await executeDevSelfRun('oscillating goal', async () => {
      executions++;
      return { runId: `dev-${executions}`, ok: false, stage: 'review-blocked', node: 'review', outcome: 'abandoned', prNumber: 10,
        review: { reviewed: true, verdict: 'fail', mustFix: ['- fix A'], shouldFix: [] }, rework: { trend: 'oscillating', signature, rounds: 4 } } as never;
    }, { rounds: 4, printDecision: () => {} });
    expect(executions).toBe(1);
    expect(executed.supervisorStopReason).toBe('review-oscillating');
  });

  test('a live task sharing a feature with a repaired live task is not «already repaired»', () => {
    const first = decideNextRun({ results: [result()], repairGoalExecution: true });
    const history = appendRound([], [result()], first.reviewMustFixTrend, first);
    const twin: SupervisorJobResult = { ...result(), taskId: 'twin' };
    const decision = decideNextRun({ results: [result(), twin], history, repairGoalExecution: true });
    expect(decision).toMatchObject({ action: 'add-repair-task', oscillation: { taskIds: ['twin'], heldTaskIds: ['one'] } });
    // A rerun that minted a new taskId is the same task only through explicit lineage — not a shared feature.
    expect(decideNextRun({ results: [{ ...result(), taskId: 'one-next', oscillationRepairOf: 'one' }], history, repairGoalExecution: true }).stopReason).toBe('review-oscillating');
    expect(decideNextRun({ results: [{ ...result(), taskId: 'distinct' }], history, repairGoalExecution: true }).action).toBe('add-repair-task');
  });

  test('prior stop guards win over oscillation', () => {
    expect(decideNextRun({ results: [result()], limits: { maxRounds: 0 } }).stopReason).toBe('max-rounds');
    expect(decideNextRun({ results: [result()], history: [
      { round: 0, landed: 0, actionable: 1 }, { round: 1, landed: 0, actionable: 1 },
    ] }).stopReason).toBe('no-progress');
  });

  test('aggregate takes oscillating first and otherwise the worst measured trend, not absence', () => {
    expect(aggregateReviewTrend([{ ...result(), rework: undefined }])).toBeUndefined();
    expect(aggregateReviewTrend([result('improving'), { ...result(), taskId: 'two', rework: { trend: 'worsening', signature: '', rounds: 2 } }])).toBe('worsening');
    expect(aggregateReviewTrend([result('improving'), result()])).toBe('oscillating');
  });

  test('superviseRun carries measured trend, passes repair goal, then stops without another rerun', async () => {
    const decisions: string[] = [];
    let reruns = 0;
    await superviseRun({ initial: [result()], repairGoalExecution: true, taskAgentShadow: false, sweepPendingMerges: async () => ({ pending: 0, merged: 0 }),
      limits: { stallRounds: 4 },
      onDecision: (decision) => decisions.push(`${decision.action}:${decision.reviewMustFixTrend}`),
      rerun: async (_, invocation) => {
        reruns++;
        expect(invocation.repairGoals?.one).toContain('기존 시험 설계를 보존하고 리뷰 진동');
        return [result()];
      },
    });
    expect(reruns).toBe(1);
    expect(decisions).toEqual(['add-repair-task:oscillating', 'stop:oscillating']);
  });

  test('a rerun that does not declare repair execution stops on the first oscillation with zero reruns', async () => {
    const decisions: string[] = [];
    let reruns = 0;
    await superviseRun({ initial: [result()], taskAgentShadow: false, sweepPendingMerges: async () => ({ pending: 0, merged: 0 }),
      limits: { stallRounds: 4 },
      onDecision: (decision) => decisions.push(`${decision.action}:${decision.stopReason ?? ''}`),
      rerun: async () => { reruns++; return [{ ...result(), taskId: `child-${reruns}` }]; },
    });
    expect(reruns).toBe(0);
    expect(decisions).toEqual(['stop:review-oscillating']);
  });

  test('mixed round: the rerun receives the fresh task with its repair goal and never the already-repaired one', async () => {
    const other: SupervisorJobResult = { ...result(), taskId: 'two', feature: 'other request' };
    const received: string[][] = [];
    const goals: string[][] = [];
    const stops: string[] = [];
    const final = await superviseRun({ initial: [result()], repairGoalExecution: true, taskAgentShadow: false, sweepPendingMerges: async () => ({ pending: 0, merged: 0 }),
      limits: { stallRounds: 4 },
      onDecision: (decision) => { if (decision.stopReason) stops.push(decision.stopReason); },
      rerun: async (previous, invocation) => {
        received.push(previous.map((job) => job.taskId));
        goals.push(Object.keys(invocation.repairGoals ?? {}));
        return received.length === 1 ? [result(), other] : [];
      },
    });
    expect(received).toEqual([['one'], ['two']]);
    expect(goals).toEqual([['one'], ['two']]);
    // The held task is not lost: it stays in the final results and the run ends on the human stop.
    expect(final.map((job) => job.taskId)).toEqual(['one']);
    expect(stops).toEqual(['review-oscillating']);
  });

  test('a rerun that declares it cannot run the repair goal stops on the first oscillation', async () => {
    const decisions: string[] = [];
    let reruns = 0;
    await superviseRun({ initial: [result()], repairGoalExecution: false, taskAgentShadow: false, sweepPendingMerges: async () => ({ pending: 0, merged: 0 }),
      onDecision: (decision) => decisions.push(`${decision.action}:${decision.stopReason ?? ''}`),
      rerun: async () => { reruns++; return [result()]; },
    });
    expect(reruns).toBe(0);
    expect(decisions).toEqual(['stop:review-oscillating']);
  });

  test('JSON disposition accepts complete rework only; missing or malformed stays unobserved', () => {
    const valid = parseSelfImplementJson(JSON.stringify({ stage: 'review-blocked', rework: { trend: 'oscillating', signature: 'x', rounds: 4 } }));
    expect(valid?.rework).toEqual({ trend: 'oscillating', signature: 'x', rounds: 4 });
    const bad = parseSelfImplementJson(JSON.stringify({ stage: 'review-blocked', rework: { trend: 'zig' } }));
    expect(bad?.rework).toBeUndefined();
    expect(parseSelfImplementJson(JSON.stringify({ stage: 'review-blocked', rework: { trend: 'stable', signature: '', rounds: 0 } }))?.rework).toBeUndefined();
    expect(parseSelfImplementJson(JSON.stringify({ stage: 'review-blocked', rework: { trend: ['oscillating'], signature: 'x', rounds: 4 } }))?.rework).toBeUndefined();
    expect(parseSelfImplementJson(JSON.stringify({ stage: 'review-blocked', rework: { trend: 'oscillating', signature: 'x', rounds: 1 } }))?.rework).toBeUndefined();
    expect(parseSelfImplementJson(JSON.stringify({ stage: 'review-blocked', rework: { trend: 'improving', signature: 'x', rounds: 1 } }))?.rework).toBeUndefined();
    expect(parseSelfImplementJson(JSON.stringify({ stage: 'review-blocked', rework: { trend: 'unmeasured', signature: '', rounds: 2 } }))?.rework).toBeUndefined();
    expect(singleRunAsJobResult('request', { runId: 'one', ok: false, stage: 'review-blocked', node: 'review', outcome: { termination: 'abandoned' }, rework: valid!.rework } as never).rework).toEqual(valid!.rework);
  });

  test('single-run CLI repairs with the authored goal and keeps task identity across a new child runId', async () => {
    let launches = 0;
    const decisions: string[] = [];
    const original = 'request for implementation';
    const outcome = await runSelfImplementCliCommand(original, { supervise: { rounds: 4, stallRounds: 4,
      onDecision: (decision) => decisions.push(decision.action) } }, {
      executeReroute: (async (spec: import('./dev-pipeline.js').DevPipelineSpec) => {
        launches++;
        if (launches === 2) expect((spec.input as { text: string }).text).toContain('## 남은 must-fix (원문)');
        return { exitCode: 1, result: {
          runId: `child-${launches}`, ok: false, stage: 'review-blocked', node: 'review', outcome: 'abandoned',
          prNumber: 10, review: { reviewed: true, verdict: 'fail', mustFix: ['- fix A'] },
          rework: { trend: 'oscillating', signature, rounds: 4 },
        } };
      }) as never,
    });
    expect(outcome.ok).toBe(true);
    expect(launches).toBe(2);
    expect(decisions).toEqual(['add-repair-task', 'stop']);
  });

  test('child JSON reaches the parallel SelfDevJobResult without accepting malformed measurements', async () => {
    for (const [payload, expected] of [
      [{ trend: 'oscillating', signature: 'x', rounds: 4 }, 'oscillating'],
      [{ trend: 'zig' }, undefined],
    ] as const) {
      const [job] = await orchestrateSelfDev({
        goals: [{ feature: 'one' }],
        spawn: (input) => ({ address: input.spaceId, done: Promise.resolve({
          exitCode: 1, output: '', disposition: parseSelfImplementJson(JSON.stringify({ stage: 'review-blocked', rework: payload }))!,
        }) }),
      });
      expect(job?.rework?.trend).toBe(expected);
    }
  });

  test('count changes and resolved stable IDs classify independently; signature sorts and deduplicates', () => {
    const findings = (ids: string[]) => ids.map((id) => ({ id, item: id }));
    expect(measureReviewRework([3, 1, 2], [findings(['a', 'b', 'c']), findings(['d']), findings(['e', 'f'])]).trend).toBe('oscillating');
    expect(measureReviewRework([2, 2, 2], [findings(['a']), findings(['a']), findings(['a'])]).trend).toBe('stable');
    expect(measureReviewRework([3, 2, 1], [findings(['a']), findings(['b']), findings(['c'])]).trend).toBe('improving');
    expect(measureReviewRework([1, 2, 3], [findings(['a']), findings(['b']), findings(['c'])]).trend).toBe('worsening');
    expect(measureReviewRework([1], [findings(['b', 'a', 'a'])])).toEqual({ trend: 'unmeasured', signature: 'a,b', rounds: 1 });
    expect(measureReviewRework([2, 1, 1], [findings(['a', 'b']), findings(['c']), findings(['a'])]).trend).toBe('oscillating');
  });
});
