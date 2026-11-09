import { expect, mock, test } from 'bun:test';
import { runEmergencyPublishSwitchSimulation } from './emergency-publish-switch-sim.js';

function graphContext() {
  return JSON.stringify({ graphId: 'release-loop', nodeId: 'emergency-switch', runId: 'normal-run-1',
    input: { version: '0.3.7', previousVersion: '0.3.6', emergencyPublish: {
      securityFix: true, hotfixCommits: ['a'.repeat(40)],
      blockedSince: '2026-11-08T00:00:00.000Z', nowMs: Date.parse('2026-11-08T03:00:00.000Z'),
      shadowSamples: Array.from({ length: 3 }, (_, index) => ({ eventType: 'normal-release-blocked', policyVersion: 1,
        runId: `caller-supplied-${index}`, observedAt: `2026-11-08T0${index}:00:00.000Z`, shadowEligible: true })),
    } }, outputs: { gate: { outcome: 'regression', verdict: 'fail' } } });
}

test('production switch node ignores caller-supplied promotion evidence and remains off', () => {
  const output = mock((...args: unknown[]) => { void args; });
  const previousLog = console.log;
  console.log = output;
  try {
    expect(runEmergencyPublishSwitchSimulation({ ELANOUS_GRAPH_CONTEXT: graphContext() })).toBe(0);
    expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toMatchObject({
      outcome: 'stay-normal', verdict: 'pass', action: 'stay-normal', eligible: false, promoted: false,
      normalRunId: 'normal-run-1', reasons: ['emergency-publish-disabled-by-default'],
    });
  } finally { console.log = previousLog; }
});

test('production switch node requires the graph run identity', () => {
  const output = mock((...args: unknown[]) => { void args; });
  const previousLog = console.log;
  console.log = output;
  try {
    expect(runEmergencyPublishSwitchSimulation({ ELANOUS_GRAPH_CONTEXT: JSON.stringify({ input: { version: '0.3.7', previousVersion: '0.3.6' }, outputs: {} }) })).toBe(2);
    expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toMatchObject({ outcome: 'error', verdict: 'fail',
      summary: 'v0.3.7: current normal release runId required' });
  } finally { console.log = previousLog; }
});
