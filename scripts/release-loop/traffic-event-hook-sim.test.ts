import { expect, spyOn, test } from 'bun:test';
import { debug } from '../../src/debug/log.js';
import { simulateReleaseTrafficHook } from './traffic-event-hook-sim.js';
import { evaluateReleaseTrafficHook, RLA_TRAFFIC_EVENT_HOOK_TABLE, type ReleaseTrafficHookEvent, type ReleaseTrafficHookState } from './traffic-event-hook.js';

function initialState(): ReleaseTrafficHookState {
  return {
    workerStopAt: '2026-11-07T23:59:00+09:00',
    gateReservation: null,
    globalCap: 12,
    taCaps: { OP: 3, TC: 3, MK: 3, UX: 3 },
    hosts: {
      'busy-host': { cap: 1, targetCap: 1, slotPrefixes: ['busy-'], healthy: true, overloaded: false, gateReserved: false },
      'gate-host': { cap: 0, targetCap: 3, slotPrefixes: ['gate-a', 'gate-b', 'gate-c'], healthy: true, overloaded: false, gateReserved: false },
      'short-prefix-host': { cap: 3, targetCap: 3, slotPrefixes: ['short-a', 'short-b'], healthy: true, overloaded: false, gateReserved: false },
      'failed-host': { cap: 2, targetCap: 2, slotPrefixes: ['failed-a', 'failed-b'], healthy: true, overloaded: false, gateReserved: false },
    },
  };
}

test('RLA traffic hook simulation follows all ten event kinds in order and logs each judgment', () => {
  const events: ReleaseTrafficHookEvent[] = [
    { type: 'cut-minus-30', minutesToCut: 30, landBy: '2026-11-08T06:30:00+09:00', gateHost: 'gate-host', runId: 'release-037' },
    { type: 'gate-start', host: 'gate-host', runId: 'release-037' },
    { type: 'gate-failure', host: 'gate-host', runId: 'release-037', retryable: true },
    { type: 'gate-start', host: 'gate-host', runId: 'release-037' },
    { type: 'gate-pass', host: 'gate-host', runId: 'release-037' },
    { type: 'gate-failure', host: 'gate-host', runId: 'release-037', retryable: true },
    { type: 'gate-failure', host: 'gate-host', runId: 'release-037', retryable: false },
    { type: 'publish', runId: 'release-037' },
    { type: 'host-failure', host: 'failed-host' },
    { type: 'host-load', host: 'busy-host', loadPercent: 111 },
    { type: 'host-load', host: 'busy-host', loadPercent: 40 },
    { type: 'host-load', host: 'gate-host', loadPercent: 9 },
    { type: 'host-load', host: 'short-prefix-host', loadPercent: 37 },
    { type: 'global-cap', cap: 8, emergency: true, reason: 'gate host emergency reserve' },
    { type: 'ta-cap', seat: 'TC', cap: 6 },
    { type: 'pod-phase-prewarm', phase: 'gate', readyPods: 3, targetPods: 3 },
  ];

  const observations: Array<{ category: string; event: string; data?: unknown }> = [];
  const log = spyOn(debug, 'log').mockImplementation((category, event, data) => { observations.push({ category, event, data }); });
  const result = simulateReleaseTrafficHook(initialState(), events);
  log.mockRestore();
  expect(Object.keys(RLA_TRAFFIC_EVENT_HOOK_TABLE.events)).toHaveLength(10);
  expect([...new Set(events.map(({ type }) => type))]).toEqual([
    'cut-minus-30', 'gate-start', 'gate-failure', 'gate-pass', 'publish', 'host-failure',
    'host-load', 'global-cap', 'ta-cap', 'pod-phase-prewarm',
  ]);
  expect(result.steps).toHaveLength(16);
  expect(result.state.workerStopAt).toBe('2026-11-08T06:30:00+09:00');
  expect(result.steps[0]?.state.gateReservation).toEqual({ runId: 'release-037', host: 'gate-host', phase: 'reserved' });
  expect(result.steps[1]?.state.gateReservation).toEqual({ runId: 'release-037', host: 'gate-host', phase: 'running' });
  expect(result.steps[2]?.state.gateReservation).toEqual({ runId: 'release-037', host: 'gate-host', phase: 'reserved' });
  expect(result.steps[3]?.state.gateReservation).toEqual({ runId: 'release-037', host: 'gate-host', phase: 'running' });
  expect(result.steps[4]?.state.gateReservation).toEqual({ runId: 'release-037', host: 'gate-host', phase: 'passed' });
  expect(result.steps[5]?.ignored).toBe('gate-failure-requires-running');
  expect(result.steps[6]?.ignored).toBe('gate-failure-requires-running');
  expect(result.steps[5]?.state.gateReservation).toEqual({ runId: 'release-037', host: 'gate-host', phase: 'passed' });
  expect(result.steps[7]?.state.gateReservation).toBeNull();
  expect(result.steps[8]?.state.hosts['failed-host']).toMatchObject({ healthy: false, cap: 0 });
  expect(result.steps[9]?.state.hosts['busy-host']).toMatchObject({ cap: 0, overloaded: true });
  expect(result.steps[10]?.state.hosts['busy-host']).toMatchObject({ cap: 1, overloaded: false });
  expect(result.steps[11]?.state.hosts['gate-host']).toMatchObject({ cap: 3, overloaded: false });
  expect(result.steps[12]?.state.hosts['short-prefix-host']).toMatchObject({ cap: 2, overloaded: false });
  expect(result.steps[0]?.changes).toContainEqual(expect.objectContaining({ kind: 'host-cap', host: 'short-prefix-host', from: 3, to: 2 }));
  expect(result.steps.slice(13).map((step) => step.event.type)).toEqual(['global-cap', 'ta-cap', 'pod-phase-prewarm']);
  expect(result.steps[13]?.state).toMatchObject({ globalCap: 8, taCaps: { OP: 2, TC: 2, MK: 2, UX: 2 } });
  expect(result.steps[13]?.judgment).toMatchObject({ verdict: 'hold', emergency: true, reasons: ['emergency:gate host emergency reserve', 'global-cap-bound'] });
  expect(Object.values(result.steps[14]?.state.taCaps ?? {}).reduce((sum, cap) => sum + (cap ?? 0), 0)).toBe(8);
  expect(result.steps[14]?.state.taCaps?.TC).toBe(4);
  expect(result.steps[14]?.judgment).toMatchObject({ verdict: 'hold', emergency: false, reasons: ['global-cap-bound'] });
  expect(result.steps[15]?.state.podPhasePrewarm?.gate).toEqual({ readyPods: 3, targetPods: 3, ready: true });
  expect(result.steps[15]?.judgment).toEqual({ verdict: 'allow', emergency: false, reasons: [] });
  expect(observations).toHaveLength(16);
  expect(observations.map(({ category, event }) => [category, event])).toEqual(events.map(() => ['release-loop.traffic-hook', 'event-decision']));
  expect(observations.map(({ data }) => (data as { eventType: string; judgment: unknown }).eventType)).toEqual(events.map(({ type }) => type));
  expect(observations[13]?.data).toMatchObject({ judgment: { verdict: 'hold', emergency: true } });
});

test('incomplete pod prewarm is held and invalid caps fail closed with a logged judgment', () => {
  const observations: Array<{ category: string; event: string; data?: unknown }> = [];
  const log = spyOn(debug, 'log').mockImplementation((category, event, data) => { observations.push({ category, event, data }); });
  const prewarm = evaluateReleaseTrafficHook(initialState(), { type: 'pod-phase-prewarm', phase: 'gate', readyPods: 1, targetPods: 3 });
  const invalidCap = evaluateReleaseTrafficHook(prewarm.state, { type: 'global-cap', cap: -1 });
  log.mockRestore();
  expect(prewarm.judgment).toEqual({ verdict: 'hold', emergency: false, reasons: ['pod-phase-prewarm-incomplete'] });
  expect(invalidCap.ignored).toBe('global-cap-invalid');
  expect(invalidCap.judgment).toMatchObject({ verdict: 'hold', emergency: false, reasons: ['global-cap-invalid'] });
  expect(observations.map(({ data }) => (data as { judgment: { verdict: string } }).judgment.verdict)).toEqual(['hold', 'hold']);
});

test('TA caps fail closed until the global cap is known and report requests bounded without a state change', () => {
  const withoutGlobalCap = initialState();
  delete withoutGlobalCap.globalCap;
  const unset = evaluateReleaseTrafficHook(withoutGlobalCap, { type: 'ta-cap', seat: 'TC', cap: 6 });
  expect(unset.ignored).toBe('global-cap-unset');
  expect(unset.state.taCaps).toEqual(withoutGlobalCap.taCaps);
  expect(unset.judgment).toMatchObject({ verdict: 'hold', reasons: ['global-cap-unset'] });

  const constrained = initialState();
  constrained.globalCap = 1;
  constrained.taCaps = { OP: 1, TC: 0 };
  const decision = evaluateReleaseTrafficHook(constrained, { type: 'ta-cap', seat: 'TC', cap: 1 });
  expect(decision.state.taCaps).toEqual({ OP: 1, TC: 0 });
  expect(decision.changes.filter((change) => change.kind === 'ta-cap')).toEqual([]);
  expect(decision.judgment).toMatchObject({ verdict: 'hold', reasons: ['global-cap-bound'] });
});

test('first global cap is recorded from unset and log exceptions do not change decisions', () => {
  const withoutGlobalCap = initialState();
  delete withoutGlobalCap.globalCap;
  const firstCap = evaluateReleaseTrafficHook(withoutGlobalCap, { type: 'global-cap', cap: 5 });
  expect(firstCap.changes).toContainEqual({ kind: 'global-cap', from: null, to: 5, reason: 'global-cap-event' });

  const log = spyOn(debug, 'log').mockImplementation(() => { throw new Error('logging unavailable'); });
  try {
    const decision = evaluateReleaseTrafficHook(initialState(), { type: 'global-cap', cap: 0, emergency: true });
    expect(decision.state.globalCap).toBe(0);
    expect(decision.judgment).toMatchObject({ verdict: 'hold', emergency: true, reasons: ['global-cap-bound', 'global-cap-zero'] });
  } finally {
    log.mockRestore();
  }
});

test('a countdown outside the T-30 table row cannot replace the worker deadline', () => {
  const state = initialState();
  const result = simulateReleaseTrafficHook(state, [
    { type: 'cut-minus-30', minutesToCut: 45, landBy: '2026-11-08T06:30:00+09:00', gateHost: 'gate-host', runId: 'release-037' },
  ]);
  expect(result.state.workerStopAt).toBe(state.workerStopAt);
  expect(result.steps[0]?.changes).toEqual([
    expect.objectContaining({ kind: 'host-cap', host: 'short-prefix-host', from: 3, to: 2 }),
  ]);
});

test('cut-minus-30 requires run and gate host before changing traffic controls', () => {
  const state = initialState();
  const missingRun = evaluateReleaseTrafficHook(state, {
    type: 'cut-minus-30', minutesToCut: 30, landBy: '2026-11-08T06:30:00+09:00', gateHost: 'gate-host',
  });
  expect(missingRun.ignored).toBe('cut-minus-30-requires-run-id-and-gate-host');
  expect(missingRun.state.workerStopAt).toBe(state.workerStopAt);
  expect(missingRun.state.gateReservation).toBeNull();
  const missingHost = evaluateReleaseTrafficHook(state, {
    type: 'cut-minus-30', minutesToCut: 30, landBy: '2026-11-08T06:30:00+09:00', runId: 'missing-host',
  });
  expect(missingHost.ignored).toBe('cut-minus-30-requires-run-id-and-gate-host');
  expect(missingHost.state.workerStopAt).toBe(state.workerStopAt);
});

test('cut-minus-30 does not move worker deadline when another run owns the gate reservation', () => {
  const state = initialState();
  state.gateReservation = { runId: 'other-release', host: 'gate-host', phase: 'reserved' };
  state.hosts['gate-host']!.gateReserved = true;
  const result = evaluateReleaseTrafficHook(state, {
    type: 'cut-minus-30', minutesToCut: 30, landBy: '2026-11-08T06:30:00+09:00',
    gateHost: 'gate-host', runId: 'release-037',
  });
  expect(result.ignored).toBe('gate-host-already-reserved');
  expect(result.state.workerStopAt).toBe(state.workerStopAt);
  expect(result.state.gateReservation).toEqual(state.gateReservation);
  expect(result.changes).not.toContainEqual(expect.objectContaining({ kind: 'worker-stop-at' }));
});

test('published and terminally failed runs ignore delayed cutoff events without re-reserving hosts', () => {
  for (const terminalEvent of [
    { type: 'publish' as const, runId: 'published-run' },
    { type: 'gate-failure' as const, host: 'gate-host', runId: 'failed-run', retryable: false },
  ]) {
    const runId = terminalEvent.runId;
    const terminal = simulateReleaseTrafficHook(initialState(), [
      { type: 'cut-minus-30', minutesToCut: 30, landBy: '2026-11-08T06:30:00+09:00', gateHost: 'gate-host', runId },
      { type: 'gate-start', host: 'gate-host', runId },
      ...(terminalEvent.type === 'publish' ? [{ type: 'gate-pass' as const, host: 'gate-host', runId }] : []),
      terminalEvent,
      { type: 'cut-minus-30', minutesToCut: 20, landBy: '2026-11-08T06:20:00+09:00', gateHost: 'gate-host', runId },
    ]);
    expect(terminal.steps.at(-1)?.ignored).toBe('release-run-terminal');
    expect(terminal.state.gateReservation).toBeNull();
    expect(terminal.state.terminalRunIds).toContain(runId);
  }
});

test('repeated cutoff events never regress a running or passed gate reservation', () => {
  const result = simulateReleaseTrafficHook(initialState(), [
    { type: 'cut-minus-30', minutesToCut: 30, landBy: '2026-11-08T06:30:00+09:00', gateHost: 'gate-host', runId: 'repeat' },
    { type: 'gate-start', host: 'gate-host', runId: 'repeat' },
    { type: 'cut-minus-30', minutesToCut: 25, landBy: '2026-11-08T06:30:00+09:00', gateHost: 'gate-host', runId: 'repeat' },
    { type: 'gate-pass', host: 'gate-host', runId: 'repeat' },
    { type: 'cut-minus-30', minutesToCut: 20, landBy: '2026-11-08T06:30:00+09:00', gateHost: 'gate-host', runId: 'repeat' },
    { type: 'gate-start', host: 'gate-host', runId: 'repeat' },
  ]);
  expect(result.steps[2]?.state.gateReservation).toEqual({ runId: 'repeat', host: 'gate-host', phase: 'running' });
  expect(result.steps[4]?.state.gateReservation).toEqual({ runId: 'repeat', host: 'gate-host', phase: 'passed' });
  expect(result.steps[5]?.state.gateReservation).toEqual({ runId: 'repeat', host: 'gate-host', phase: 'passed' });
});

test('every returned host cap is bounded by available slot prefixes', () => {
  const state = initialState();
  const result = simulateReleaseTrafficHook(state, [
    { type: 'host-load', host: 'busy-host', loadPercent: 50 },
  ]);
  expect(result.steps[0]?.state.hosts['short-prefix-host']?.cap).toBe(2);
  expect(result.steps[0]?.changes).toContainEqual(expect.objectContaining({
    kind: 'host-cap', host: 'short-prefix-host', from: 3, to: 2, reason: 'slot-prefix-cap-bound',
  }));
});

test('gate start requires reservation and an available host; terminal failure releases it', () => {
  const result = simulateReleaseTrafficHook(initialState(), [
    { type: 'gate-start', host: 'gate-host', runId: 'unreserved' },
    { type: 'cut-minus-30', minutesToCut: 30, landBy: '2026-11-08T06:30:00+09:00', gateHost: 'gate-host', runId: 'retryable' },
    { type: 'host-load', host: 'gate-host', loadPercent: 95 },
    { type: 'gate-start', host: 'gate-host', runId: 'retryable' },
    { type: 'host-load', host: 'gate-host', loadPercent: 40 },
    { type: 'gate-start', host: 'gate-host', runId: 'retryable' },
    { type: 'gate-failure', host: 'gate-host', runId: 'retryable', retryable: true },
    { type: 'gate-start', host: 'gate-host', runId: 'retryable' },
    { type: 'gate-failure', host: 'gate-host', runId: 'retryable', retryable: false },
  ]);
  expect(result.steps[0]?.ignored).toBe('gate-reservation-run-or-host-mismatch');
  expect(result.steps[1]?.state.gateReservation).toEqual({ runId: 'retryable', host: 'gate-host', phase: 'reserved' });
  expect(result.steps[3]?.ignored).toBe('gate-host-unavailable');
  expect(result.steps[3]?.state.gateReservation).toEqual({ runId: 'retryable', host: 'gate-host', phase: 'reserved' });
  expect(result.steps[5]?.state.gateReservation).toEqual({ runId: 'retryable', host: 'gate-host', phase: 'running' });
  expect(result.steps[6]?.state.gateReservation).toEqual({ runId: 'retryable', host: 'gate-host', phase: 'reserved' });
  expect(result.steps[8]?.state.gateReservation).toBeNull();
});

test('a reserved gate cannot start after its final slot prefix disappears', () => {
  const reserved = evaluateReleaseTrafficHook(initialState(), {
    type: 'cut-minus-30', minutesToCut: 30, landBy: '2026-11-08T06:30:00+09:00', gateHost: 'gate-host', runId: 'no-slots',
  });
  reserved.state.hosts['gate-host']!.slotPrefixes = [];
  const started = evaluateReleaseTrafficHook(reserved.state, { type: 'gate-start', host: 'gate-host', runId: 'no-slots' });
  expect(started.ignored).toBe('gate-host-unavailable');
  expect(started.state.gateReservation).toEqual({ runId: 'no-slots', host: 'gate-host', phase: 'reserved' });
});

test('a reserved gate host failure reroutes only to a healthy host with an available slot prefix', () => {
  const result = simulateReleaseTrafficHook(initialState(), [
    { type: 'host-load', host: 'busy-host', loadPercent: 90 },
    { type: 'gate-start', host: 'busy-host', runId: 'overloaded-gate' },
    { type: 'cut-minus-30', minutesToCut: 30, landBy: '2026-11-08T06:30:00+09:00', gateHost: 'gate-host', runId: 'release-037' },
    { type: 'gate-start', host: 'gate-host', runId: 'release-037' },
    { type: 'host-failure', host: 'gate-host', gateHostCandidates: ['busy-host', 'short-prefix-host', 'failed-host'] },
    { type: 'gate-pass', host: 'short-prefix-host', runId: 'release-037' },
    { type: 'publish', runId: 'release-037' },
    { type: 'gate-start', host: 'short-prefix-host', runId: 'release-037' },
    { type: 'gate-pass', host: 'short-prefix-host', runId: 'release-037' },
    { type: 'gate-pass', host: 'short-prefix-host', runId: 'release-037' },
    { type: 'publish', runId: 'release-037' },
  ]);
  expect(result.state.hosts['gate-host']).toMatchObject({ healthy: false, cap: 0, gateReserved: false });
  expect(result.state.hosts['busy-host']).toMatchObject({ healthy: true, overloaded: true, gateReserved: false });
  expect(result.state.hosts['short-prefix-host']).toMatchObject({ healthy: true, cap: 2, gateReserved: false });
  expect(result.state.gateReservation).toBeNull();
  expect(result.steps[1]?.ignored).toBe('gate-reservation-run-or-host-mismatch');
  expect(result.steps[4]?.state.gateReservation).toEqual({ runId: 'release-037', host: 'short-prefix-host', phase: 'reserved' });
  expect(result.steps[4]?.changes).toContainEqual(expect.objectContaining({ kind: 'gate-reservation', action: 'reroute', from: 'gate-host', to: 'short-prefix-host' }));
  expect(result.steps[5]?.ignored).toBe('gate-must-be-running-before-pass');
  expect(result.steps[6]?.ignored).toBe('gate-must-pass-before-publish');
  expect(result.steps[7]?.state.gateReservation).toEqual({ runId: 'release-037', host: 'short-prefix-host', phase: 'running' });
  expect(result.steps[8]?.state.gateReservation).toEqual({ runId: 'release-037', host: 'short-prefix-host', phase: 'passed' });
  expect(result.steps[9]?.ignored).toBe('gate-must-be-running-before-pass');
  expect(result.steps[10]?.state.hosts['short-prefix-host']).toMatchObject({ cap: 2, gateReserved: false });

  const passedHostReroute = simulateReleaseTrafficHook(initialState(), [
    { type: 'cut-minus-30', minutesToCut: 30, landBy: '2026-11-08T06:30:00+09:00', gateHost: 'gate-host', runId: 'passed-reroute' },
    { type: 'gate-start', host: 'gate-host', runId: 'passed-reroute' },
    { type: 'gate-pass', host: 'gate-host', runId: 'passed-reroute' },
    { type: 'host-failure', host: 'gate-host', gateHostCandidates: ['short-prefix-host'] },
  ]);
  expect(passedHostReroute.state.gateReservation).toEqual({ runId: 'passed-reroute', host: 'short-prefix-host', phase: 'reserved' });
});
