import { describe, expect, test } from 'bun:test';
import { finishRetroCycleRun, type RetroCycleActionRefs } from './retro-cycle-observation.js';

describe('retro cycle lifecycle observations', () => {
  test('uses one generated runId for action refs, returned JSON identity, and both events', () => {
    const actions: RetroCycleActionRefs[] = [];
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const runId = finishRetroCycleRun({
      period: 'weekly', reportPath: '/tmp/REFLECTION-weekly.md', hasProposal: true, proposalId: 'proposal-1',
    }, {
      createId: () => 'generated-123',
      recordAction: refs => actions.push(refs),
      log: (category, event, data) => events.push({ category, event, data }),
    });

    expect(runId).toBe('retro-generated-123');
    expect(actions).toEqual([{ runId, reportPath: '/tmp/REFLECTION-weekly.md' }]);
    expect(events).toEqual([
      { category: 'retro.cycle', event: 'collected', data: { runId, period: 'weekly', reportPath: '/tmp/REFLECTION-weekly.md', hasProposal: true } },
      { category: 'retro.cycle', event: 'proposed', data: { runId, period: 'weekly', reportPath: '/tmp/REFLECTION-weekly.md', proposalId: 'proposal-1' } },
    ]);
  });

  test('assigns distinct identities across runs and omits proposed when no proposal exists', () => {
    const actions: RetroCycleActionRefs[] = [];
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    let sequence = 0;
    const deps = {
      createId: () => `generated-${++sequence}`,
      recordAction: (refs: RetroCycleActionRefs) => actions.push(refs),
      log: (_category: string, event: string, data: Record<string, unknown>) => events.push({ event, data }),
    };
    const report = { period: 'monthly' as const, reportPath: '/tmp/REFLECTION-monthly.md', hasProposal: false };
    const firstRunId = finishRetroCycleRun(report, deps);
    const firstEventCount = events.length;
    const secondRunId = finishRetroCycleRun(report, deps);

    expect(firstRunId).not.toBe(secondRunId);
    expect(actions.map(action => action.runId)).toEqual([firstRunId, secondRunId]);
    expect(events.slice(0, firstEventCount).map(event => event.event)).toEqual(['collected']);
    expect(events.slice(0, firstEventCount)[0]?.data.runId).toBe(firstRunId);
    expect(events.slice(firstEventCount).map(event => event.event)).toEqual(['collected']);
    expect(events.slice(firstEventCount)[0]?.data.runId).toBe(secondRunId);
  });
});
