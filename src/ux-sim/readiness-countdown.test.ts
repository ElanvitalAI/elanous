import { describe, expect, test } from 'bun:test';
import { readinessCountdown1107Scenario, readinessCountdownPhasesScenario, simulateReadinessCountdown } from './readiness-countdown.js';

describe('readiness countdown contract probe · RLA-LAUNCH-COUNTDOWN-PHASES', () => {
  test('cutoff requires the exact simulated PR-land identity', () => {
    const t = Date.parse('2026-11-07T06:00:00+09:00');
    const rows = simulateReadinessCountdown({
      fixedTimeConstraint: t,
      countdownMilliseconds: 0,
      hostReservationLeadMilliseconds: 0,
      hostReservationBufferMilliseconds: 0,
      requirements: [{ id: 'cut-branch', gates: ['cutoff'], expectedReadyAt: t, pr: { number: 35841, headSha: 'abc123' } }],
      events: [
        { at: t, type: 'pr-landed', number: 35840, headSha: 'abc123' },
        { at: t, type: 'milestone-complete', gate: 'cutoff' },
        { at: t + 1, type: 'pr-landed', number: 35841, headSha: 'wrong' },
        { at: t + 1, type: 'milestone-complete', gate: 'cutoff' },
        { at: t + 2, type: 'pr-landed', number: 35841, headSha: 'abc123' },
        { at: t + 2, type: 'milestone-complete', gate: 'cutoff' },
      ],
    });

    expect(rows[2]?.completed).not.toContain('cutoff');
    expect(rows[4]?.completed).not.toContain('cutoff');
    expect(rows.at(-1)?.completed).toContain('cutoff');
  });

  test('generic readiness events cannot satisfy a PR-bound prerequisite', () => {
    const t = Date.parse('2026-11-07T06:00:00+09:00');
    const rows = simulateReadinessCountdown({
      fixedTimeConstraint: t,
      countdownMilliseconds: 0,
      hostReservationLeadMilliseconds: 0,
      hostReservationBufferMilliseconds: 0,
      requirements: [{ id: 'cut-branch', gates: ['cutoff'], expectedReadyAt: t, pr: { number: 35841, headSha: 'abc123' } }],
      events: [
        { at: t, type: 'requirement-ready', id: 'cut-branch' },
        { at: t, type: 'milestone-complete', gate: 'cutoff' },
      ],
    });

    expect(rows[1]?.noGo).toContain('cut-branch');
    expect(rows.at(-1)?.completed).not.toContain('cutoff');
  });

  test('scrubs to next cycle when distinct hold count reaches its configured limit', () => {
    const t = Date.parse('2026-11-07T06:00:00+09:00');
    const rows = simulateReadinessCountdown({
      fixedTimeConstraint: t,
      countdownMilliseconds: 0,
      hostReservationLeadMilliseconds: 0,
      hostReservationBufferMilliseconds: 0,
      maxHoldsBeforeNextCycle: 2,
      requirements: [],
      events: [
        { at: t, type: 'hold', reason: 'prerequisite delay' },
        { at: t + 1, type: 'hold', reason: 'duplicate hold' },
        { at: t + 2, type: 'release-hold' },
        { at: t + 3, type: 'hold', reason: 'scrub threshold reached' },
        { at: t + 4, type: 'release-hold' },
        { at: t + 5, type: 'milestone-complete', gate: 'cutoff' },
      ],
    });

    expect(rows[1]?.holdCount).toBe(1);
    expect(rows[2]?.holdCount).toBe(1);
    expect(rows[4]?.holdCount).toBe(2);
    expect(rows[4]?.disposition).toBe('next-cycle');
    expect(rows.at(-1)?.completed).not.toContain('cutoff');
    expect(rows.at(-1)?.disposition).toBe('next-cycle');
  });

  test('requires a positive integer hold limit when next-cycle scrubbing is enabled', () => {
    const base = {
      fixedTimeConstraint: 0,
      countdownMilliseconds: 0,
      hostReservationLeadMilliseconds: 0,
      hostReservationBufferMilliseconds: 0,
      requirements: [],
      events: [],
    } as const;

    for (const maxHoldsBeforeNextCycle of [0, -1, 1.5]) {
      expect(() => simulateReadinessCountdown({ ...base, maxHoldsBeforeNextCycle })).toThrow(RangeError);
    }
  });

  test('sends coordinator ETA changes promptly and material-delay notice only beyond threshold', () => {
    const t = Date.parse('2026-11-07T06:00:00+09:00');
    const rows = simulateReadinessCountdown({
      fixedTimeConstraint: t,
      countdownMilliseconds: 0,
      hostReservationLeadMilliseconds: 0,
      hostReservationBufferMilliseconds: 0,
      materialDelayThresholdMilliseconds: 30 * 60_000,
      requirements: [{ id: 'ready', gates: ['cutoff'], expectedReadyAt: t }],
      events: [
        { at: t + 10 * 60_000, type: 'requirement-ready', id: 'ready' },
        { at: t + 20 * 60_000, type: 'hold', reason: 'short delay' },
        { at: t + 25 * 60_000, type: 'clock-tick' },
        { at: t + 30 * 60_000, type: 'clock-tick' },
        { at: t + 30 * 60_000 + 1, type: 'clock-tick' },
      ],
    });

    const belowThreshold = rows.find((row) => row.at === t + 25 * 60_000)!;
    const atThreshold = rows.find((row) => row.at === t + 30 * 60_000)!;
    const aboveThreshold = rows.find((row) => row.at === t + 30 * 60_000 + 1)!;
    expect(belowThreshold.notifications).toContainEqual({ type: 'eta-changed', eta: belowThreshold.eta });
    expect(belowThreshold.notifications.some((notice) => notice.type === 'material-delay')).toBe(false);
    expect(atThreshold.eta - t).toBe(30 * 60_000);
    expect(atThreshold.notifications.some((notice) => notice.type === 'material-delay')).toBe(false);
    expect(aboveThreshold.notifications).toContainEqual({ type: 'material-delay', eta: aboveThreshold.eta });
  });

  test('uses even-sized historical median and the maximum of history and current gate duration', () => {
    const t = Date.parse('2026-11-07T06:00:00+09:00');
    const base = {
      fixedTimeConstraint: t,
      countdownMilliseconds: 0,
      hostReservationLeadMilliseconds: 0,
      hostReservationBufferMilliseconds: 0,
      priorGateDurationsMilliseconds: [4 * 60_000, 8 * 60_000],
      requirements: [],
    } as const;
    const atHistoricalMedian = simulateReadinessCountdown({
      ...base,
      events: [
        { at: t, type: 'host-ready', host: 'gate-host' },
        { at: t, type: 'milestone-complete', gate: 'cutoff' },
      ],
    }).at(-1)!;
    const withCurrentMeasurement = simulateReadinessCountdown({
      ...base,
      events: [
        { at: t, type: 'host-ready', host: 'gate-host' },
        { at: t, type: 'milestone-complete', gate: 'cutoff' },
        { at: t + 1, type: 'gate-duration', milliseconds: 9 * 60_000 },
      ],
    }).at(-1)!;

    expect(atHistoricalMedian.gateDurationEstimateMilliseconds).toBe(6 * 60_000);
    expect(atHistoricalMedian.eta).toBe(t + 6 * 60_000);
    expect(withCurrentMeasurement.gateDurationEstimateMilliseconds).toBe(9 * 60_000);
    expect(withCurrentMeasurement.eta).toBe(t + 9 * 60_000);
  });

  test('simulates T−11h through T0 with two explicit holds and blocks premature gate completion', () => {
    const scenario = readinessCountdownPhasesScenario();
    const rows = simulateReadinessCountdown(scenario);
    const t0 = Date.parse('2026-11-07T00:00:00+09:00');
    const at = (hoursBefore: number) => t0 - hoursBefore * 60 * 60_000;
    const phase = (name: 'T-11h' | 'T-7h' | 'T-2h' | 'T-30m' | 'T0') => rows.find((row) => row.launchPhase === name)!;
    const firstHold = rows.find((row) => row.holdReason?.startsWith('HOLD-1'))!;
    const cutoffAttempts = scenario.events.flatMap((event, index) => event.type === 'milestone-complete' && event.gate === 'cutoff' ? [index] : []);
    const heldCutoffAttempt = rows[cutoffAttempts[0]! + 1]!;
    const recoveredCutoffAttempt = rows[cutoffAttempts[1]! + 1]!;
    const secondHold = rows.find((row) => row.holdReason?.startsWith('HOLD-2'))!;
    const gateAttempt = scenario.events.findIndex((event) => event.type === 'milestone-complete' && event.gate === 'gate');
    const heldGateAttempt = rows[gateAttempt + 1]!;

    expect(phase('T-11h').at).toBe(at(11));
    expect(phase('T-7h').at).toBe(at(7));
    expect(phase('T-2h').at).toBe(at(2));
    expect(phase('T-30m').at).toBe(t0 - 30 * 60_000);
    expect(phase('T0').at).toBe(t0);
    expect(firstHold.holdCount).toBe(1);
    expect(firstHold.completed).not.toContain('cutoff');
    expect(heldCutoffAttempt.at).toBe(at(10));
    expect(heldCutoffAttempt.holdReason).toBe('HOLD-1: cut branch is not landed');
    expect(heldCutoffAttempt.noGo).toEqual([]);
    expect(heldCutoffAttempt.milestoneBlockers).toEqual(['active-hold']);
    expect(heldCutoffAttempt.completed).not.toContain('cutoff');
    expect(recoveredCutoffAttempt.holdReason).toBeNull();
    expect(recoveredCutoffAttempt.completed).toContain('cutoff');
    expect(secondHold.holdCount).toBe(2);
    expect(secondHold.completed).toContain('cutoff');
    expect(heldGateAttempt.at).toBe(at(1));
    expect(heldGateAttempt.noGo).toEqual([]);
    expect(heldGateAttempt.milestoneBlockers).toEqual(['active-hold']);
    expect(heldGateAttempt.phase).toBe('hold');
    expect(heldGateAttempt.readyGate).toBe('gate');
    expect(heldGateAttempt.completed).not.toContain('gate');
    expect(rows.at(-1)?.launchPhase).toBe('T0');
    expect(rows.at(-1)?.holdCount).toBe(2);
    expect(rows.at(-1)?.phase).toBe('ready');
    expect(rows.at(-1)?.completed).toEqual(['cutoff', 'gate', 'publish', 'announcement']);
  });

  test('duplicate hold is idempotent; a hold after explicit release starts a new hold count', () => {
    const t0 = Date.parse('2026-11-07T00:00:00+09:00');
    const rows = simulateReadinessCountdown({
      fixedTimeConstraint: t0,
      countdownMilliseconds: 0,
      hostReservationLeadMilliseconds: 0,
      hostReservationBufferMilliseconds: 0,
      requirements: [],
      events: [
        { at: t0, type: 'hold', reason: 'HOLD-1: initial blocker' },
        { at: t0 + 1, type: 'hold', reason: 'duplicate signal must not replace the active hold' },
        { at: t0 + 2, type: 'release-hold' },
        { at: t0 + 3, type: 'hold', reason: 'HOLD-2: separate blocker' },
      ],
    });
    expect(rows[1]?.holdCount).toBe(1);
    expect(rows[1]?.holdReason).toBe('HOLD-1: initial blocker');
    expect(rows.at(-1)?.holdCount).toBe(2);
    expect(rows.at(-1)?.holdReason).toBe('HOLD-2: separate blocker');
  });

  test('06:00 remains a constraint; late readiness shifts ETA and host lease without starting early', () => {
    const rows = simulateReadinessCountdown(readinessCountdown1107Scenario());
    const atSix = rows.find((row) => row.at === Date.parse('2026-11-06T21:00:00.000Z'))!;
    const cutoffReady = rows.find((row) => row.at === Date.parse('2026-11-06T22:05:00.000Z') && row.readyGate === 'gate')!;
    const finishedGate = rows.find((row) => row.at === Date.parse('2026-11-06T22:18:00.000Z'))!;

    expect(atSix.phase).toBe('no-go');
    expect(atSix.eta).toBe(Date.parse('2026-11-06T22:25:00.000Z'));
    expect(atSix.hostReservedUntil).toBeNull();
    expect(cutoffReady.phase).toBe('no-go');
    expect(cutoffReady.noGo).toContain('regressions-clear');
    expect(cutoffReady.eta).toBe(Date.parse('2026-11-06T22:25:00.000Z'));
    expect(cutoffReady.hostReservedUntil).toBe(Date.parse('2026-11-06T22:55:00.000Z'));
    expect(cutoffReady.notifications).toEqual([]);
    const gateReady = rows.find((row) => row.at === Date.parse('2026-11-06T22:10:00.000Z') && row.readyGate === 'gate' && row.eta === Date.parse('2026-11-06T22:33:00.000Z'))!;
    expect(gateReady.hostReservedUntil).toBe(Date.parse('2026-11-06T23:03:00.000Z'));
    expect(gateReady.notifications).toEqual([{ type: 'eta-changed', eta: gateReady.eta }]);
    expect(finishedGate.readyGate).toBe('publish');
    expect(finishedGate.eta).toBe(Date.parse('2026-11-06T22:25:00.000Z'));
    expect(finishedGate.hostReservedUntil).toBeNull();
    expect(rows.at(-1)?.phase).toBe('ready');
    expect(rows.at(-1)?.eta).toBe(Date.parse('2026-11-06T22:25:00.000Z'));
    expect(rows.at(-1)?.hostReservedUntil).toBeNull();
    expect(rows.at(-1)?.notifications).toEqual([]);
  });

  test('emergency hold names its reason and blocks GO until an explicit release', () => {
    const fixture = readinessCountdown1107Scenario();
    const rows = simulateReadinessCountdown({
      ...fixture,
      events: [
        ...fixture.events.slice(0, 5),
        { at: Date.parse('2026-11-06T22:06:00.000Z'), type: 'hold', reason: 'manual emergency hold: host image mismatch' },
        { at: Date.parse('2026-11-06T22:08:00.000Z'), type: 'milestone-complete', gate: 'gate' },
        ...fixture.events.slice(5),
      ],
    });
    const emergency = rows.find((row) => row.holdReason?.includes('host image mismatch'))!;
    expect(emergency.phase).toBe('hold');
    expect(emergency.holdReason).toBe('manual emergency hold: host image mismatch');
    expect(emergency.readyGate).toBe('gate');
    expect(rows.some((row) => row.phase === 'ready' && row.at < emergency.at)).toBe(false);
    expect(rows.at(-1)?.phase).toBe('hold');
    expect(rows.at(-1)?.completed).not.toContain('gate');
  });

  test('readiness before the fixed time starts its countdown at the constraint and elapsed ticks reduce ETA', () => {
    const fixed = Date.parse('2026-11-06T21:00:00.000Z');
    const complete = Date.parse('2026-11-06T20:30:00.000Z');
    const fiveMinutesLater = Date.parse('2026-11-06T21:05:00.000Z');
    const countdownDone = Date.parse('2026-11-06T21:15:00.000Z');
    const rows = simulateReadinessCountdown({
      fixedTimeConstraint: fixed,
      countdownMilliseconds: 15 * 60_000,
      hostReservationLeadMilliseconds: 30 * 60_000,
      hostReservationBufferMilliseconds: 30 * 60_000,
      requirements: [
        { id: 'cutoff', gates: ['cutoff'], expectedReadyAt: complete },
      ],
      events: [
        { at: complete, type: 'requirement-ready', id: 'cutoff' },
        { at: fiveMinutesLater, type: 'clock-tick' },
        { at: fiveMinutesLater, type: 'milestone-complete', gate: 'cutoff' },
        { at: countdownDone, type: 'clock-tick' },
        { at: countdownDone, type: 'milestone-complete', gate: 'cutoff' },
      ],
    });
    expect(rows[1]?.phase).toBe('no-go');
    expect(rows[1]?.noGo).toContain('fixed-time-constraint:not-reached');
    expect(rows[1]?.eta).toBe(countdownDone);
    expect(rows[2]?.phase).toBe('countdown');
    expect(rows[2]?.eta).toBe(countdownDone);
    expect(rows[3]?.eta).toBe(countdownDone);
    expect(rows[4]?.completed).not.toContain('cutoff');
    expect(rows.at(-2)?.phase).toBe('countdown');
    expect(rows.at(-2)?.eta).toBe(countdownDone);
    expect(rows.at(-1)?.completed).toContain('cutoff');
  });

  test('clock ticks acquire T-minus reservation without another release event and later ETA delays extend it', () => {
    const t = (hour: number, minute: number) => Date.parse(`2026-11-06T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`);
    const rows = simulateReadinessCountdown({
      fixedTimeConstraint: t(21, 0),
      countdownMilliseconds: 15 * 60_000,
      hostReservationLeadMilliseconds: 30 * 60_000,
      hostReservationBufferMilliseconds: 30 * 60_000,
      requirements: [
        { id: 'cutoff', gates: ['cutoff'], expectedReadyAt: t(20, 30) },
        { id: 'regression', gates: ['gate'], expectedReadyAt: t(22, 30) },
      ],
      events: [
        { at: t(21, 0), type: 'host-ready', host: 'host-t-minus' },
        { at: t(20, 30), type: 'requirement-ready', id: 'cutoff' },
        { at: t(21, 0), type: 'clock-tick' },
        { at: t(21, 15), type: 'clock-tick' },
        { at: t(21, 15), type: 'milestone-complete', gate: 'cutoff' },
        { at: t(22, 0), type: 'clock-tick' },
        { at: t(22, 15), type: 'clock-tick' },
        { at: t(22, 20), type: 'gate-duration', milliseconds: 60 * 60_000 },
      ],
    });
    expect(rows.find((row) => row.at === t(22, 0))?.hostReservedUntil).toBeNull();
    expect(rows.find((row) => row.at === t(22, 15))?.hostReservedUntil).toBe(t(23, 15));
    expect(rows.at(-1)?.eta).toBe(t(23, 30));
    expect(rows.at(-1)?.hostReservedUntil).toBe(Date.parse('2026-11-07T00:00:00.000Z'));
  });

  test('hold pauses elapsed T-minus time and moves ETA by the held duration', () => {
    const t = (hour: number, minute: number) => Date.parse(`2026-11-06T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`);
    const rows = simulateReadinessCountdown({
      fixedTimeConstraint: t(21, 0),
      countdownMilliseconds: 15 * 60_000,
      hostReservationLeadMilliseconds: 30 * 60_000,
      hostReservationBufferMilliseconds: 30 * 60_000,
      requirements: [{ id: 'cutoff', gates: ['cutoff'], expectedReadyAt: t(20, 30) }],
      events: [
        { at: t(20, 30), type: 'requirement-ready', id: 'cutoff' },
        { at: t(21, 0), type: 'clock-tick' },
        { at: t(21, 5), type: 'clock-tick' },
        { at: t(21, 5), type: 'hold', reason: 'gate owner paused the countdown' },
        { at: t(21, 20), type: 'clock-tick' },
        { at: t(21, 20), type: 'release-hold' },
        { at: t(21, 30), type: 'clock-tick' },
        { at: t(21, 30), type: 'milestone-complete', gate: 'cutoff' },
      ],
    });
    const held = rows.find((row) => row.holdReason === 'gate owner paused the countdown')!;
    expect(held.phase).toBe('hold');
    expect(held.eta).toBe(t(21, 15));
    const resumed = rows.find((row) => row.at === t(21, 20) && row.holdReason === null)!;
    expect(resumed.eta).toBe(t(21, 30));
    expect(rows.at(-1)?.completed).toContain('cutoff');
  });
});
