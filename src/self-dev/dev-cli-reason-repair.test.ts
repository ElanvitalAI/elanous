import { expect, spyOn, test } from 'bun:test';
import { debug } from '../debug/log.js';
import { setUserConfigOverlay } from '../user-config.js';
import type { SelfImplementResult } from '../self-implement/orchestrator.js';
import { executeDevSelfRun } from './dev-cli.js';

test('dev runtime requires both reasonRepair opt-in and executePiece capability for target-bearing repair', async () => {
  const logs: Array<{ category: string; event: string; data: unknown }> = [];
  const log = spyOn(debug, 'log').mockImplementation((category, event, data) => { logs.push({ category, event, data }); });
  const feature = '# Dev CLI failure\n\n## TRACED PATHS\n- src/self-dev/dev-cli.ts — verified target';
  // No runId: terminal supervisor state persistence is skipped, keeping the test process-default store untouched.
  const failed = { ok: false, stage: 'error', node: 'complete', outcome: 'failed' } as unknown as SelfImplementResult;
  const repaired = { ok: true, stage: 'merged', node: 'merge', outcome: 'completed', merged: true } as unknown as SelfImplementResult;
  let initialCalls = 0;
  let pieceCalls = 0;
  try {
    setUserConfigOverlay((config) => ({ ...config, tools: { ...config.tools,
      selfImplement: { ...config.tools.selfImplement, supervisor: undefined } } }));
    await executeDevSelfRun(feature, async () => { initialCalls++; return failed; }, {
      rounds: 2, printDecision: () => {}, executePiece: async () => { pieceCalls++; return repaired; },
      taskAgentShadow: false, taskAgentRejudge: false, sweepPendingMerges: async () => ({ pending: 0, merged: 0 }),
    });
    expect(initialCalls).toBe(1);
    expect(pieceCalls).toBe(0);
    expect(logs).toContainEqual(expect.objectContaining({
      category: 'self-dev.supervisor', event: 'supervisor.reason-repair-skipped',
      data: expect.objectContaining({ reason: 'disabled' }),
    }));

    setUserConfigOverlay((config) => ({ ...config, tools: { ...config.tools,
      selfImplement: { ...config.tools.selfImplement, supervisor: { reasonRepair: true } } } }));
    const beforeMissingCapability = logs.length;
    await executeDevSelfRun(feature, async () => { initialCalls++; return failed; }, {
      rounds: 2, printDecision: () => {}, taskAgentShadow: false, taskAgentRejudge: false,
      sweepPendingMerges: async () => ({ pending: 0, merged: 0 }),
    });
    expect(initialCalls).toBe(2);
    expect(pieceCalls).toBe(0);
    const missingCapabilityLogs = logs.slice(beforeMissingCapability);
    expect(missingCapabilityLogs).toContainEqual(expect.objectContaining({
      category: 'self-dev.supervisor', event: 'supervisor.reason-repair-skipped',
      data: expect.objectContaining({ reason: 'disabled' }),
    }));
    expect(missingCapabilityLogs.filter((row) => row.event === 'supervisor-self-heal')).toEqual([]);

    const beforeEnabledRepair = logs.length;
    await executeDevSelfRun(feature, async () => { initialCalls++; return failed; }, {
      rounds: 2, printDecision: () => {}, executePiece: async () => { pieceCalls++; return repaired; },
      taskAgentShadow: false, taskAgentRejudge: false, sweepPendingMerges: async () => ({ pending: 0, merged: 0 }),
    });
    expect(initialCalls).toBe(3);
    expect(pieceCalls).toBe(1);
    const enabledRepairLogs = logs.slice(beforeEnabledRepair);
    expect(enabledRepairLogs).toContainEqual(expect.objectContaining({
      event: 'supervisor-self-heal', data: expect.objectContaining({ reason: 'supervisor-no-piece', outcome: 'relaunching' }),
    }));
    expect(enabledRepairLogs.filter((row) => row.event === 'supervisor.reason-repair-skipped')).toEqual([]);
  } finally {
    log.mockRestore();
    setUserConfigOverlay(null);
  }
});
