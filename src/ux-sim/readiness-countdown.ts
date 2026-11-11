/**
 * Deterministic readiness-countdown contract probe for RLA-LAUNCH-COUNTDOWN-PHASES.
 * Inputs are simulated boundary events; this module never reads wall time,
 * GitHub, a host pool, or a release graph.
 */
export type CountdownGate = 'cutoff' | 'gate' | 'publish' | 'announcement' | 'cleanup';
export type LaunchCountdownPhase = 'T-24h' | 'T-11h' | 'T-7h' | 'T-2h' | 'T-30m' | 'T0' | 'T+' | 'publish' | 'verify' | 'cleanup';

export interface ReadinessRequirement {
  readonly id: string;
  readonly gates: readonly CountdownGate[];
  readonly expectedReadyAt: number;
  /** If present, this requirement is satisfied only by the matching simulated PR-land event. */
  readonly pr?: { readonly number: number; readonly headSha: string };
}

export type ReadinessEvent =
  | { readonly at: number; readonly type: 'requirement-ready'; readonly id: string }
  | { readonly at: number; readonly type: 'pr-landed'; readonly number: number; readonly headSha: string }
  | { readonly at: number; readonly type: 'hold'; readonly reason: string }
  | { readonly at: number; readonly type: 'release-hold' }
  | { readonly at: number; readonly type: 'host-ready'; readonly host: string }
  | { readonly at: number; readonly type: 'host-unready'; readonly host: string }
  | { readonly at: number; readonly type: 'gate-duration'; readonly milliseconds: number }
  | { readonly at: number; readonly type: 'milestone-complete'; readonly gate: CountdownGate }
  | { readonly at: number; readonly type: 'phase-transition'; readonly phase: LaunchCountdownPhase }
  | { readonly at: number; readonly type: 'clock-tick' };

export interface ReadinessCountdownInput {
  readonly fixedTimeConstraint: number;
  readonly requirements: readonly ReadinessRequirement[];
  readonly events: readonly ReadinessEvent[];
  /** Initial schedule phase; existing scenarios retain the T-11h default. */
  readonly initialLaunchPhase?: LaunchCountdownPhase;
  /** Include the simulated post-release cleanup gate after publish and verification. */
  readonly includeCleanup?: boolean;
  readonly countdownMilliseconds: number;
  readonly hostReservationLeadMilliseconds: number;
  readonly hostReservationBufferMilliseconds: number;
  /** Stop this simulated launch and disposition it to the next cycle at this distinct-hold count. */
  readonly maxHoldsBeforeNextCycle?: number;
  /** Notify the principal once when ETA moves beyond the fixed constraint by this much. */
  readonly materialDelayThresholdMilliseconds?: number;
  /** Historical gate durations used to estimate the next gate's duration. */
  readonly priorGateDurationsMilliseconds?: readonly number[];
}

export interface ReadinessSnapshot {
  readonly at: number;
  readonly launchPhase: LaunchCountdownPhase;
  readonly holdCount: number;
  readonly phase: 'no-go' | 'hold' | 'countdown' | 'ready';
  readonly readyGate: CountdownGate | null;
  readonly noGo: readonly string[];
  /** Reasons the current milestone cannot complete at this exact event. */
  readonly milestoneBlockers: readonly string[];
  readonly holdReason: string | null;
  readonly eta: number;
  readonly notifications: readonly { readonly type: 'eta-changed' | 'material-delay'; readonly eta: number }[];
  readonly host: string | null;
  readonly hostReservedUntil: number | null;
  readonly completed: readonly CountdownGate[];
  readonly disposition: 'active' | 'next-cycle';
  readonly gateDurationEstimateMilliseconds: number;
}

const GATES: readonly CountdownGate[] = ['cutoff', 'gate', 'publish', 'announcement', 'cleanup'];

function pendingRequirements(requirements: readonly ReadinessRequirement[], ready: ReadonlyMap<string, number>, gate: CountdownGate): string[] {
  return requirements.filter((requirement) => requirement.gates.includes(gate) && !ready.has(requirement.id)).map(({ id }) => id);
}

/** Replays the release launch checks from boundary events in event-time order. */
export function simulateReadinessCountdown(input: ReadinessCountdownInput): ReadinessSnapshot[] {
  if (input.maxHoldsBeforeNextCycle !== undefined && (!Number.isInteger(input.maxHoldsBeforeNextCycle) || input.maxHoldsBeforeNextCycle <= 0)) {
    throw new RangeError('maxHoldsBeforeNextCycle must be a positive integer');
  }
  const events = [...input.events].sort((a, b) => a.at - b.at);
  const ready = new Map<string, number>();
  const completed = new Set<CountdownGate>();
  const snapshots: ReadinessSnapshot[] = [];
  let now = Math.min(input.fixedTimeConstraint, events[0]?.at ?? input.fixedTimeConstraint);
  let holdReason: string | null = null;
  let host: string | null = null;
  let hostReady = false;
  let hostReadyAt: number | null = null;
  let reservationStarted = false;
  let measuredGateDuration = 0;
  let stageOpenedAt = now;
  let countdownDeferredByHold = false;
  let countdownStartedAt: number | null = null;
  let countdownPausedAt: number | null = null;
  let countdownPausedMilliseconds = 0;
  let previousEta: number | null = null;
  let reservedUntil: number | null = null;
  let launchPhase: LaunchCountdownPhase = input.initialLaunchPhase ?? 'T-11h';
  let holdCount = 0;
  let disposition: ReadinessSnapshot['disposition'] = 'active';
  let materialDelayNotified = false;
  const priorDurations = (input.priorGateDurationsMilliseconds ?? []).filter((duration) => Number.isFinite(duration) && duration >= 0).sort((a, b) => a - b);
  const priorGateMedian = priorDurations.length === 0 ? 0 : priorDurations.length % 2 === 1
    ? priorDurations[Math.floor(priorDurations.length / 2)]!
    : (priorDurations[priorDurations.length / 2 - 1]! + priorDurations[priorDurations.length / 2]!) / 2;

  const currentGate = () => (input.includeCleanup ? GATES : GATES.slice(0, -1)).find((candidate) => !completed.has(candidate)) ?? null;
  const gateDurationEstimate = (): number => Math.max(priorGateMedian, measuredGateDuration);
  const stageDuration = (gate: CountdownGate): number => Math.max(input.countdownMilliseconds, gate === 'gate' ? gateDurationEstimate() : 0);
  const stageElapsed = (): number => countdownStartedAt === null ? 0 : Math.max(0, now - countdownStartedAt - countdownPausedMilliseconds - (countdownPausedAt === null ? 0 : now - countdownPausedAt));
  const stageRemaining = (gate: CountdownGate): number => countdownStartedAt === null
    ? stageDuration(gate)
    : Math.max(0, stageDuration(gate) - stageElapsed());
  const syncCountdown = (): void => {
    const gate = currentGate();
    if (!gate) { countdownStartedAt = null; countdownPausedAt = null; countdownPausedMilliseconds = 0; return; }
    const readyForGate = pendingRequirements(input.requirements, ready, gate).length === 0 && (gate !== 'gate' || hostReady);
    const mayRun = readyForGate && !holdReason && now >= input.fixedTimeConstraint;
    if (countdownStartedAt === null) {
      if (readyForGate && now >= input.fixedTimeConstraint && holdReason) countdownDeferredByHold = true;
      else if (mayRun) {
        const observedReadiness = Math.max(stageOpenedAt, ...input.requirements.filter((requirement) => requirement.gates.includes(gate)).map((requirement) => ready.get(requirement.id) ?? stageOpenedAt), gate === 'gate' ? hostReadyAt ?? stageOpenedAt : stageOpenedAt);
        countdownStartedAt = countdownDeferredByHold ? now : Math.max(input.fixedTimeConstraint, observedReadiness);
        countdownPausedMilliseconds = 0;
        countdownDeferredByHold = false;
      }
      return;
    }
    if (mayRun && countdownPausedAt !== null) {
      countdownPausedMilliseconds += now - countdownPausedAt;
      countdownPausedAt = null;
    }
    else if (!mayRun && countdownPausedAt === null) countdownPausedAt = now;
  };

  const snapshot = (): ReadinessSnapshot => {
    const gate = currentGate();
    const missing = gate ? pendingRequirements(input.requirements, ready, gate) : [];
    const noGo = [...missing];
    if (gate === 'gate' && !hostReady) noGo.push(`host:${host ?? 'unassigned'}:not-ready`);
    if (now < input.fixedTimeConstraint) noGo.push('fixed-time-constraint:not-reached');
    const expectedReadyAt = gate
      ? Math.max(now, ...input.requirements.map((requirement) => ready.get(requirement.id) ?? requirement.expectedReadyAt))
      : now;
    const remaining = gate ? stageRemaining(gate) : 0;
    // A fixed clock constrains the earliest start; it never fires a launch by itself.
    const eta = Math.max(input.fixedTimeConstraint, expectedReadyAt) + remaining;
    const notifications: ReadinessSnapshot['notifications'][number][] = previousEta !== null && previousEta !== eta ? [{ type: 'eta-changed', eta }] : [];
    const materiallyDelayed = eta - input.fixedTimeConstraint > (input.materialDelayThresholdMilliseconds ?? Number.POSITIVE_INFINITY);
    if (materiallyDelayed && !materialDelayNotified) {
      notifications.push({ type: 'material-delay', eta });
      materialDelayNotified = true;
    }
    if (previousEta !== eta) previousEta = eta;
    if (gate !== 'gate' || !hostReady) reservationStarted = false;
    else if (eta - now <= input.hostReservationLeadMilliseconds) reservationStarted = true;
    reservedUntil = reservationStarted ? eta + input.hostReservationBufferMilliseconds : null;
    return {
      at: now,
      launchPhase,
      holdCount,
      phase: holdReason ? 'hold' : noGo.length ? 'no-go' : gate ? 'countdown' : 'ready',
      readyGate: gate,
      noGo,
      milestoneBlockers: gate === null ? [] : [
        ...missing.map((id) => `requirement:${id}`),
        ...(gate === 'gate' && !hostReady ? [`host:${host ?? 'unassigned'}:not-ready`] : []),
        ...(now < input.fixedTimeConstraint ? ['fixed-time-constraint:not-reached'] : []),
        ...(stageRemaining(gate) > 0 ? ['countdown:incomplete'] : []),
        ...(holdReason ? ['active-hold'] : []),
      ],
      holdReason,
      eta,
      notifications,
      host: hostReady ? host : null,
      hostReservedUntil: hostReady ? reservedUntil : null,
      completed: [...completed],
      disposition,
      gateDurationEstimateMilliseconds: gateDurationEstimate(),
    };
  };

  snapshots.push(snapshot());
  for (const event of events) {
    if (disposition === 'next-cycle') break;
    now = event.at;
    switch (event.type) {
      case 'requirement-ready':
        if (!input.requirements.some((requirement) => requirement.id === event.id && requirement.pr)) ready.set(event.id, event.at);
        break;
      case 'pr-landed':
        for (const requirement of input.requirements) {
          if (requirement.pr?.number === event.number && requirement.pr.headSha === event.headSha) ready.set(requirement.id, event.at);
        }
        break;
      case 'hold':
        // A repeated hold signal is idempotent while the same no-go is active.
        if (holdReason === null) {
          holdReason = event.reason;
          holdCount++;
          if (input.maxHoldsBeforeNextCycle !== undefined && holdCount >= input.maxHoldsBeforeNextCycle) disposition = 'next-cycle';
        }
        break;
      case 'release-hold': holdReason = null; break;
      case 'host-ready': host = event.host; hostReady = true; hostReadyAt = event.at; break;
      case 'host-unready': if (host === event.host) { hostReady = false; hostReadyAt = null; reservationStarted = false; } break;
      case 'gate-duration': measuredGateDuration = Math.max(0, event.milliseconds); break;
      case 'milestone-complete': {
        syncCountdown();
        const gate = currentGate();
        const missing = gate ? pendingRequirements(input.requirements, ready, gate) : [];
        if (event.gate === gate && !holdReason && now >= input.fixedTimeConstraint && missing.length === 0 && (gate !== 'gate' || hostReady) && gate !== null && stageRemaining(gate) === 0) {
          completed.add(event.gate);
          countdownStartedAt = null;
          countdownPausedAt = null;
          countdownPausedMilliseconds = 0;
          countdownDeferredByHold = false;
          stageOpenedAt = now;
          if (event.gate === 'gate') measuredGateDuration = 0;
        }
        break;
      }
      case 'phase-transition': launchPhase = event.phase; break;
      case 'clock-tick': break;
    }
    syncCountdown();
    snapshots.push(snapshot());
  }
  return snapshots;
}

const minute = 60_000;
const at = (hour: number, minutes: number): number => Date.parse(`2026-11-07T${String(hour).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00+09:00`);

/** 11-07 reconstruction fixture: 06:00 was a constraint; readiness arrived later. */
export function readinessCountdown1107Scenario(): ReadinessCountdownInput {
  return {
    fixedTimeConstraint: at(6, 0),
    countdownMilliseconds: 0,
    hostReservationLeadMilliseconds: 30 * minute,
    hostReservationBufferMilliseconds: 30 * minute,
    requirements: [
      { id: 'pr-landed', gates: ['cutoff'], expectedReadyAt: at(7, 5) },
      { id: 'image-pinned', gates: ['cutoff', 'gate'], expectedReadyAt: at(7, 0) },
      { id: 'regressions-clear', gates: ['gate'], expectedReadyAt: at(7, 10) },
      { id: 'verify-ready', gates: ['publish', 'announcement'], expectedReadyAt: at(7, 25) },
    ],
    events: [
      { at: at(6, 0), type: 'hold', reason: 'cutoff prerequisites are not ready' },
      { at: at(6, 0), type: 'host-ready', host: 'gate-host-a' },
      { at: at(7, 5), type: 'requirement-ready', id: 'pr-landed' },
      { at: at(7, 5), type: 'requirement-ready', id: 'image-pinned' },
      { at: at(7, 5), type: 'release-hold' },
      { at: at(7, 5), type: 'milestone-complete', gate: 'cutoff' },
      { at: at(7, 10), type: 'requirement-ready', id: 'regressions-clear' },
      { at: at(7, 10), type: 'gate-duration', milliseconds: 8 * minute },
      { at: at(7, 18), type: 'milestone-complete', gate: 'gate' },
      { at: at(7, 25), type: 'requirement-ready', id: 'verify-ready' },
      { at: at(7, 25), type: 'milestone-complete', gate: 'publish' },
      { at: at(7, 25), type: 'milestone-complete', gate: 'announcement' },
    ],
  };
}

/** Simulates the scheduled release phases, then injected publish, verify and cleanup failures after T0. */
export function readinessCountdownPhasesScenario(): ReadinessCountdownInput {
  const t0 = Date.parse('2026-11-07T00:00:00+09:00');
  const minus = (milliseconds: number) => t0 - milliseconds;
  const hour = 60 * minute;
  return {
    fixedTimeConstraint: minus(11 * hour),
    initialLaunchPhase: 'T-24h',
    includeCleanup: true,
    countdownMilliseconds: 0,
    hostReservationLeadMilliseconds: 30 * minute,
    hostReservationBufferMilliseconds: 30 * minute,
    requirements: [
      { id: 'cut-branch-landed', gates: ['cutoff'], expectedReadyAt: minus(10 * hour) },
      { id: 'image-pinned', gates: ['gate'], expectedReadyAt: minus(30 * minute) },
      { id: 'regressions-clear', gates: ['gate'], expectedReadyAt: minus(30 * minute) },
      { id: 'publish-ready', gates: ['publish', 'announcement'], expectedReadyAt: t0 },
      { id: 'verify-ready', gates: ['announcement'], expectedReadyAt: t0 + 20 * minute },
      { id: 'cleanup-ready', gates: ['cleanup'], expectedReadyAt: t0 + 30 * minute },
    ],
    events: [
      { at: minus(24 * hour), type: 'phase-transition', phase: 'T-24h' },
      { at: minus(11 * hour), type: 'phase-transition', phase: 'T-11h' },
      { at: minus(11 * hour), type: 'hold', reason: 'HOLD-1: cut branch is not landed' },
      { at: minus(10 * hour), type: 'requirement-ready', id: 'cut-branch-landed' },
      { at: minus(10 * hour), type: 'milestone-complete', gate: 'cutoff' },
      { at: minus(10 * hour), type: 'release-hold' },
      { at: minus(10 * hour), type: 'milestone-complete', gate: 'cutoff' },
      { at: minus(7 * hour), type: 'phase-transition', phase: 'T-7h' },
      { at: minus(2 * hour), type: 'phase-transition', phase: 'T-2h' },
      { at: minus(2 * hour), type: 'hold', reason: 'HOLD-2: image and regression checks are not ready' },
      { at: minus(1 * hour), type: 'requirement-ready', id: 'image-pinned' },
      { at: minus(1 * hour), type: 'requirement-ready', id: 'regressions-clear' },
      { at: minus(1 * hour), type: 'host-ready', host: 'gate-host-a' },
      { at: minus(1 * hour), type: 'milestone-complete', gate: 'gate' },
      { at: minus(30 * minute), type: 'phase-transition', phase: 'T-30m' },
      { at: minus(30 * minute), type: 'release-hold' },
      { at: minus(30 * minute), type: 'gate-duration', milliseconds: 30 * minute },
      { at: t0, type: 'phase-transition', phase: 'T0' },
      { at: t0, type: 'milestone-complete', gate: 'gate' },
      { at: t0, type: 'requirement-ready', id: 'publish-ready' },
      { at: t0 + 5 * minute, type: 'phase-transition', phase: 'T+' },
      { at: t0 + 5 * minute, type: 'phase-transition', phase: 'publish' },
      { at: t0 + 5 * minute, type: 'hold', reason: 'publish failed: simulated registry unavailable' },
      { at: t0 + 5 * minute, type: 'milestone-complete', gate: 'publish' },
      { at: t0 + 10 * minute, type: 'release-hold' },
      { at: t0 + 10 * minute, type: 'milestone-complete', gate: 'publish' },
      { at: t0 + 15 * minute, type: 'phase-transition', phase: 'verify' },
      { at: t0 + 15 * minute, type: 'hold', reason: 'verify failed: simulated published artifact mismatch' },
      { at: t0 + 15 * minute, type: 'milestone-complete', gate: 'announcement' },
      { at: t0 + 20 * minute, type: 'release-hold' },
      { at: t0 + 20 * minute, type: 'requirement-ready', id: 'verify-ready' },
      { at: t0 + 20 * minute, type: 'milestone-complete', gate: 'announcement' },
      { at: t0 + 25 * minute, type: 'phase-transition', phase: 'cleanup' },
      { at: t0 + 25 * minute, type: 'hold', reason: 'cleanup failed: simulated host lease still active' },
      { at: t0 + 25 * minute, type: 'milestone-complete', gate: 'cleanup' },
      { at: t0 + 30 * minute, type: 'release-hold' },
      { at: t0 + 30 * minute, type: 'requirement-ready', id: 'cleanup-ready' },
      { at: t0 + 30 * minute, type: 'milestone-complete', gate: 'cleanup' },
    ],
  };
}

export function renderReadinessCountdown1107(): string[] {
  const rows = simulateReadinessCountdown(readinessCountdown1107Scenario());
  return [
    'readiness-countdown · fixed 06:00 constraint · injected readiness 07:xx',
    ...rows.map((row) => `  ${new Date(row.at).toISOString()} · ${row.phase} · gate=${row.readyGate ?? 'complete'} · eta=${new Date(row.eta).toISOString()} · hold=${row.holdReason ?? '-'} · host-until=${row.hostReservedUntil === null ? '-' : new Date(row.hostReservedUntil).toISOString()}${row.notifications.length ? ' · ETA changed notice' : ''}`),
  ];
}
