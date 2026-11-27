import { afterEach, describe, expect, test } from 'bun:test';
import { capsulePolicyKindForTool, createCapsulePolicy } from './capsule-policy.js';
import type { CapsuleDecisionInput } from '../turn-capsule/contract.js';

const decide = (turn: unknown, input: CapsuleDecisionInput) =>
  createCapsulePolicy({ turnConfig: () => turn, log: () => {} }).decide(input);

// CAPSULE-FLAGS-REMOVE-DEFAULT: the old switch names must not change a verdict any more.
const savedSwitches = { mode: process.env.ELANOUS_TURN_CAPSULE_MODE, stages: process.env.ELANOUS_TURN_CAPSULE_STAGES };
afterEach(() => {
  if (savedSwitches.mode === undefined) delete process.env.ELANOUS_TURN_CAPSULE_MODE; else process.env.ELANOUS_TURN_CAPSULE_MODE = savedSwitches.mode;
  if (savedSwitches.stages === undefined) delete process.env.ELANOUS_TURN_CAPSULE_STAGES; else process.env.ELANOUS_TURN_CAPSULE_STAGES = savedSwitches.stages;
});

describe('capsule policy (no switch)', () => {
  const shell = { tool: 'Bash', kind: 'shell' } as const;
  test('no switch: no config and an old off env still get the capsule cap; syncCapMs 0 never detaches by policy', () => {
    expect(decide(undefined, shell)).toEqual({ mode: 'sync', syncCapMs: 10000, reason: 'capsule-sync-cap' });
    process.env.ELANOUS_TURN_CAPSULE_MODE = 'off';
    process.env.ELANOUS_TURN_CAPSULE_STAGES = 'none';
    expect(decide({ capsuleMode: false, capsuleStages: { A2: false } }, shell)).toEqual({ mode: 'sync', syncCapMs: 10000, reason: 'capsule-sync-cap' });
    expect(decide({ syncCapMs: 0 }, shell)).toEqual({ mode: 'sync', syncCapMs: Infinity, reason: 'sync-cap-zero' });
    expect(decide({ syncCapMs: 0 }, { ...shell, requestedBackground: true })).toEqual({ mode: 'detach', syncCapMs: 0, reason: 'requested-background' });
  });
  test('all capsule kinds receive the default cap; unrelated tools remain synchronous', () => {
    const cases: CapsuleDecisionInput[] = [
      { tool: 'Bash', kind: 'shell' }, { tool: 'RunShell', kind: 'shell' },
      { tool: 'Agent', kind: 'agent' }, { tool: 'RunDevHarness', kind: 'harness' },
      { tool: 'graph-run', kind: 'graph' }, { tool: 'remote-tool', kind: 'mcp' },
    ];
    for (const input of cases) expect(decide({}, input)).toEqual({ mode: 'sync', syncCapMs: 10000, reason: 'capsule-sync-cap' });
    expect(decide({}, { tool: 'Read', kind: null })).toEqual({ mode: 'sync', syncCapMs: Infinity, reason: 'not-a-capsule' });
  });
  test('configured cap, malformed cap and explicit background', () => {
    expect(decide({ syncCapMs: 27 }, shell)).toEqual({ mode: 'sync', syncCapMs: 27, reason: 'capsule-sync-cap' });
    for (const syncCapMs of [-1, NaN, Infinity, '10']) expect(decide({ syncCapMs }, shell)).toEqual({ mode: 'sync', syncCapMs: 10000, reason: 'capsule-sync-cap' });
    expect(decide({}, { ...shell, requestedBackground: true })).toEqual({ mode: 'detach', syncCapMs: 0, reason: 'requested-background' });
  });
  test('observer receives only decision metadata and cannot break a verdict', () => {
    const events: unknown[] = [];
    const policy = createCapsulePolicy({ turnConfig: () => ({}), correlation: { turnId: 'turn-1' }, log: (event, data) => { events.push([event, data]); throw Error('log'); } });
    expect(policy.decide(shell)).toEqual({ mode: 'sync', syncCapMs: 10000, reason: 'capsule-sync-cap' });
    expect(events).toEqual([['turn-life:capsule-policy', { turnId: 'turn-1', tool: 'Bash', kind: 'shell', mode: 'sync', syncCapMs: 10000, reason: 'capsule-sync-cap' }]]);
  });
});

// CAPSULE-A1-POLICY junction mapper — the §1.5 capsule families (the 11-18 §C isolation axes + graph
// runs); a dispatched tool outside the families is not a capsule: null, and the junction emits no row.
describe('capsulePolicyKindForTool (junction mapper)', () => {
  test('maps every capsule family; a non-capsule tool name is null', () => {
    expect(capsulePolicyKindForTool('Bash')).toBe('shell');
    expect(capsulePolicyKindForTool('RunShell')).toBe('shell');
    expect(capsulePolicyKindForTool('WebTerminal')).toBe('shell');
    expect(capsulePolicyKindForTool('Agent')).toBe('agent');
    expect(capsulePolicyKindForTool('Task')).toBe('agent');
    expect(capsulePolicyKindForTool('RunDevHarness')).toBe('harness');
    expect(capsulePolicyKindForTool('HarnessProbe')).toBe('harness');
    expect(capsulePolicyKindForTool('GraphRun')).toBe('graph');
    expect(capsulePolicyKindForTool('RunGraph')).toBe('graph');
    expect(capsulePolicyKindForTool('mcp__a1_sample__probe')).toBe('mcp');
    expect(capsulePolicyKindForTool('Read')).toBeNull();
    expect(capsulePolicyKindForTool('ScheduleWakeup')).toBeNull();
    expect(capsulePolicyKindForTool('')).toBeNull();
  });
});
