import { expect, mock, test } from 'bun:test';
import { runEmergencyPublishSwitchSimulation } from './emergency-publish-switch-sim.js';

const commit = 'a'.repeat(40);
const now = Date.now();
// Source: #36117 — simulator boundaries exercise the two-hour gate-failure window and nearby retry/error cases.
const TIME_FIXTURES = {
  twoHoursMs: 2 * 60 * 60 * 1000,
  threeHoursMs: 3 * 60 * 60 * 1000,
  fourHoursMs: 4 * 60 * 60 * 1000,
  tenMinutesMs: 10 * 60 * 1000,
  twoMinutesMs: 2 * 60 * 1000,
  oneMinuteMs: 60 * 1000,
  boundarySlackMs: 1_000,
} as const;
function graphContext(endedAt = new Date(now - TIME_FIXTURES.twoHoursMs).toISOString(), startedAt = new Date(now - TIME_FIXTURES.threeHoursMs).toISOString()) {
  return JSON.stringify({ graphId: 'release-loop', nodeId: 'emergency-switch', runId: 'normal-run-1',
    startedAt: new Date(now - TIME_FIXTURES.threeHoursMs).toISOString(),
    input: { version: '0.3.8', previousVersion: '0.3.7', emergencyPublish: { securityFix: true, hotfixCommits: [commit],
      blockedSince: '1900-01-01T00:00:00.000Z', shadowSamples: [{ callerSupplied: true }] } },
    outputs: { gate: { outcome: 'regression', verdict: 'fail' } },
    nodeHistory: [{ nodeId: 'gate', executionId: 'gate-exec-1', startedAt, endedAt,
      output: { outcome: 'regression', verdict: 'fail' } }] });
}

function invoke(context: string, clock: () => number = Date.now) {
  const output = mock((...args: unknown[]) => { void args; });
  const previousLog = console.log;
  console.log = output;
  try {
    const exitCode = runEmergencyPublishSwitchSimulation({ ELANOUS_GRAPH_CONTEXT: context }, clock);
    return { exitCode, result: JSON.parse(String(output.mock.calls.at(-1)?.[0])) as Record<string, unknown> };
  } finally { console.log = previousLog; }
}

test('switch node selects the lane from the executed gate and its recorded start time; caller time/samples do not count', () => {
  const run = invoke(graphContext());
  expect(run.exitCode).toBe(0);
  expect(run.result).toMatchObject({ outcome: 'switch', verdict: 'pass', action: 'switch', eligible: true,
    promoted: true, normalRunId: 'normal-run-1', hotfixCommit: commit,
    evidence: { normalGateOutcome: 'regression', hotfixCommitCount: 1 } });
});

test('switch node measures from failure confirmation, not a long-running gate start or caller timestamp', () => {
  const run = invoke(graphContext(new Date(now - TIME_FIXTURES.tenMinutesMs).toISOString(), new Date(now - TIME_FIXTURES.threeHoursMs).toISOString()));
  expect(run.result).toMatchObject({ outcome: 'stay-normal', action: 'stay-normal', eligible: false,
    reasons: ['normal-release-blocked-too-short'] });
});

test('a same-run re-evaluation can switch after two hours from the first confirmed failure', () => {
  const startedAt = new Date(now - TIME_FIXTURES.threeHoursMs).toISOString();
  const firstFailure = new Date(now - TIME_FIXTURES.twoHoursMs - 1).toISOString();
  const secondFailure = new Date(now - TIME_FIXTURES.oneMinuteMs).toISOString();
  const context = JSON.parse(graphContext(secondFailure, startedAt)) as Record<string, unknown>;
  context.nodeHistory = [
    { nodeId: 'gate', executionId: 'gate-first', startedAt, endedAt: firstFailure,
      output: { outcome: 'regression', verdict: 'fail' } },
    { nodeId: 'gate', executionId: 'gate-retry', startedAt: new Date(now - TIME_FIXTURES.twoMinutesMs).toISOString(), endedAt: secondFailure,
      output: { outcome: 'regression', verdict: 'fail' } },
  ];
  const run = invoke(JSON.stringify(context));
  expect(run.result).toMatchObject({ outcome: 'switch', action: 'switch', eligible: true,
    evidence: { normalGateOutcome: 'regression', hotfixCommitCount: 1 } });
});

test('a gate error breaks the confirmed-failure streak and cannot age a later failure', () => {
  const context = JSON.parse(graphContext(new Date(now - 60 * 1000).toISOString())) as Record<string, unknown>;
  context.nodeHistory = [
    { nodeId: 'gate', executionId: 'gate-error', startedAt: new Date(now - TIME_FIXTURES.fourHoursMs).toISOString(),
      endedAt: new Date(now - TIME_FIXTURES.threeHoursMs).toISOString(), output: { outcome: 'error', verdict: 'fail' } },
    { nodeId: 'gate', executionId: 'gate-failure', startedAt: new Date(now - TIME_FIXTURES.twoMinutesMs).toISOString(),
      endedAt: new Date(now - TIME_FIXTURES.oneMinuteMs).toISOString(), output: { outcome: 'regression', verdict: 'fail' } },
  ];
  const run = invoke(JSON.stringify(context));
  expect(run.result).toMatchObject({ outcome: 'stay-normal', eligible: false,
    reasons: ['normal-release-blocked-too-short'] });
  expect((run.result.evidence as { blockedMs: number }).blockedMs).toBeGreaterThanOrEqual(TIME_FIXTURES.oneMinuteMs);
  expect((run.result.evidence as { blockedMs: number }).blockedMs).toBeLessThan(TIME_FIXTURES.oneMinuteMs + TIME_FIXTURES.boundarySlackMs);
});

test('switch node fails closed without gate timing or a valid emergency request', () => {
  const noHistory = JSON.parse(graphContext()) as Record<string, unknown>;
  noHistory.nodeHistory = [];
  expect(invoke(JSON.stringify(noHistory)).result).toMatchObject({ outcome: 'error', verdict: 'fail',
    summary: 'v0.3.8: same-run failed-gate confirmation time and emergency security-fix request required' });
});
