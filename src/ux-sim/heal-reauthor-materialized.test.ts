import { describe, expect, test } from 'bun:test';
import { renderHealReauthor, simHealReauthorMaterialized } from './heal-reauthor-materialized.js';

describe('heal-reauthor-materialized — production heal graph, isolated state', () => {
  test('no-progress + repeated mustFix + materialized path mismatch records goal refinement and exactly one relaunch', async () => {
    const observation = await simHealReauthorMaterialized('materialized-mismatch', { runId: 'sim-heal-materialized-1' });
    console.log(renderHealReauthor(observation).join('\n'));
    expect(observation).toMatchObject({ runId: 'sim-heal-materialized-1', scenario: 'materialized-mismatch',
      outcome: 'done', reauthor: 'relaunched', relaunchCount: 1 });
    expect(observation.revisedGoal).toContain('대상 경로: src/actual.ts');
    expect(observation.goalRefinedEvents).toHaveLength(1);
    expect(observation.goalRefinedEvents[0]).toMatchObject({ runId: 'sim-heal-materialized-1-failure',
      data: { outcome: 'refined', reason: 'materialized-run-mismatch', relaunchCount: 1 } });
    expect(observation.relaunchRequestEvents).toHaveLength(1);
    expect(observation.relaunchRequestEvents[0]).toMatchObject({ runId: observation.goalRefinedEvents[0]!.runId,
      data: { revisedGoal: observation.revisedGoal } });
    expect(observation.relaunchResultEvents).toHaveLength(1);
    expect(observation.healGraphRunId).toEqual(expect.stringMatching(/\S/));
    expect(observation.relaunchResultEvents[0]!.data.requestRunId).toBe(observation.healGraphRunId);
    expect(observation.relaunchResultEvents[0]).toMatchObject({ runId: 'sim-heal-materialized-1-failure',
      data: { outcome: 'started', result: { runId: 'sim-heal-materialized-1-outer-relaunch' } } });
    expect(observation.relaunchCalls).toHaveLength(1);
    expect(observation.relaunchCalls[0]).toMatchObject({ runId: 'sim-heal-materialized-1-failure',
      goalText: observation.revisedGoal, goalId: expect.stringMatching(/^sim-cell-/),
      cellKey: expect.stringMatching(/^sim-cell-/), stateRoot: expect.stringContaining('ux-sim-heal-reauthor-') });
  }, 120_000);

  test('zero materialized paths fails closed, records the reason, and never relaunches', async () => {
    const observation = await simHealReauthorMaterialized('zero-materialized-paths', { runId: 'sim-heal-zero-paths-1' });
    console.log(renderHealReauthor(observation).join('\n'));
    expect(observation).toMatchObject({ scenario: 'zero-materialized-paths', outcome: 'failed', reauthor: 'needs-human', relaunchCount: 0 });
    expect(observation.goalRefinedEvents).toHaveLength(0);
    expect(observation.relaunchRequestEvents).toHaveLength(0);
    expect(observation.relaunchResultEvents).toHaveLength(1);
    expect(observation.relaunchResultEvents[0]).toMatchObject({ runId: 'sim-heal-zero-paths-1-failure',
      data: { outcome: 'needs-human', reason: 'insufficient-materialized-evidence' } });
  }, 120_000);
});
