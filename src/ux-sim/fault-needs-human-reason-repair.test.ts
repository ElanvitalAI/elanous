import { describe, expect, test } from 'bun:test';
import { superviseRun, type SupervisorJobResult } from '../self-dev/run-supervisor.js';
import { simulateNeedsHumanReasonRepair } from './fault-needs-human-reason-repair.js';

describe('simNeedsHumanReasonRepair — production supervisor repair boundary', () => {
  test('four injected reasons each get one repair attempt, then stop for a human with one observed event', async () => {
    const cases = await simulateNeedsHumanReasonRepair();
    expect(cases).toHaveLength(4);
    expect(cases.map(({ reason }) => reason).sort()).toEqual([
      'missing-path', 'no-piece', 'scope-expansion', 'step-timeout',
    ]);
    for (const item of cases) {
      expect(item.reruns).toBe(1);
      expect(item.repairGoal).toBeTruthy();
      expect(item.repairGoal).toContain(item.goalText);
      expect(item.stopReason).toBe('needs-human');
      expect(item.why).toContain('attempt: 1/1');
      const healEvents = item.events.filter(({ event }) => event === 'supervisor-self-heal');
      expect(healEvents).toHaveLength(1);
      expect(healEvents[0]).toMatchObject({
        event: 'supervisor-self-heal',
        data: { runId: item.runId, reason: `supervisor-${item.reason}`, attempt: 1,
          taskIds: [item.taskId], outcome: 'relaunching', repairGoalTasks: [item.taskId] },
      });
    }
  });

  test('needs-human reason repair stays disabled by default', async () => {
    const candidate: SupervisorJobResult = {
      taskId: 'default-off-piece', feature: 'missing path piece', status: 'failed', stage: 'error',
      targetPaths: ['src/gone.ts'], error: { code: 'ENOENT', message: 'missing src/gone.ts' },
    };
    let reruns = 0;
    const skipped: Array<Record<string, unknown>> = [];
    await superviseRun({
      initial: [candidate],
      repairGoalExecution: true,
      // needsHumanReasonRepairExecution is intentionally omitted: the separate kill switch defaults off.
      rerun: async (previous) => { reruns++; return previous; },
      sweepPendingMerges: async () => ({ pending: 0, merged: 0 }),
      taskAgentShadow: false,
      observe: (event, data) => { if (event === 'supervisor.reason-repair-skipped') skipped.push(data); },
    });
    expect(reruns).toBe(0);
    expect(skipped).toEqual([{ taskId: 'default-off-piece', reason: 'disabled' }]);
  });
});
