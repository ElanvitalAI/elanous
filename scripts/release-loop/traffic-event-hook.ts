import { debug } from '../../src/debug/log.js';

export const RLA_TRAFFIC_EVENT_HOOK_TABLE = {
  cutMinusMinutes: 30,
  events: {
    'cut-minus-30': { workerStopAt: 'schedule.landBy', reserveGateHost: true, excludeHostFromTrainCap: true },
    'gate-start': { reservationPhase: 'running', excludeHostFromTrainCap: true },
    'gate-failure': { retryable: 'retain-reservation', terminal: 'release-reservation' },
    'gate-pass': { reservationPhase: 'passed', releaseOn: 'publish' },
    publish: { reservation: 'release' },
    'host-failure': { hostCap: 0, rerouteGateReservation: true },
    'host-load': { shedAtOrAbovePercent: 80, restoreAtOrBelowPercent: 40, restoreCapFrom: 'targetCap' },
    'global-cap': { minimum: 0, scope: 'aggregate-ta-caps' },
    'ta-cap': { minimum: 0, scope: 'bounded-by-global-cap' },
    'pod-phase-prewarm': { readyWhen: 'readyPods>=targetPods' },
  },
} as const;

export type ReleaseTrafficHookSeat = 'OP' | 'TC' | 'MK' | 'UX';
export type ReleaseTrafficHookEventType = keyof typeof RLA_TRAFFIC_EVENT_HOOK_TABLE.events;

export interface ReleaseTrafficHookHost {
  /** Current train-manager host cap. */
  cap: number;
  /** Reviewed cap to restore after load recovery, before slot-prefix clamping. */
  targetCap: number;
  /** Existing per-host slot prefixes; a cap may never exceed this count. */
  slotPrefixes: readonly string[];
  healthy: boolean;
  overloaded: boolean;
  gateReserved: boolean;
}

export interface ReleaseTrafficHookState {
  /** Derived from the release schedule for this cut; never a calendar constant. */
  workerStopAt: string | null;
  gateReservation: { runId: string; host: string; phase: 'reserved' | 'running' | 'passed' } | null;
  /** Terminal runs cannot re-reserve a host when delayed duplicate events arrive. */
  terminalRunIds?: readonly string[];
  /** Release-wide max and per-seat caps, kept separate from host slot caps. */
  globalCap?: number;
  taCaps?: Partial<Record<ReleaseTrafficHookSeat, number>>;
  /** Last simulated prewarm observation per release phase. */
  podPhasePrewarm?: Record<string, { readyPods: number; targetPods: number; ready: boolean }>;
  hosts: Record<string, ReleaseTrafficHookHost>;
}

export type ReleaseTrafficHookEvent =
  | { type: 'cut-minus-30'; minutesToCut: number; landBy: string; gateHost?: string; runId?: string }
  | { type: 'gate-start'; host: string; runId: string }
  | { type: 'gate-failure'; host: string; runId: string; retryable: boolean }
  | { type: 'gate-pass'; host: string; runId: string }
  | { type: 'publish'; runId: string }
  | { type: 'host-failure'; host: string; gateHostCandidates?: readonly string[] }
  | { type: 'host-load'; host: string; loadPercent: number }
  | { type: 'global-cap'; cap: number; emergency?: boolean; reason?: string }
  | { type: 'ta-cap'; seat: ReleaseTrafficHookSeat; cap: number; emergency?: boolean; reason?: string }
  | { type: 'pod-phase-prewarm'; phase: string; readyPods: number; targetPods: number };

export type ReleaseTrafficHookChange =
  | { kind: 'worker-stop-at'; from: string | null; to: string; reason: 'release-schedule-land-by' }
  | { kind: 'host-cap'; host: string; from: number; to: number; reason: string }
  | { kind: 'global-cap'; from: number | null; to: number; reason: string }
  | { kind: 'ta-cap'; seat: ReleaseTrafficHookSeat; from: number | null; to: number; reason: string }
  | { kind: 'pod-phase-prewarm'; phase: string; from: { readyPods: number; targetPods: number; ready: boolean } | null; to: { readyPods: number; targetPods: number; ready: boolean } }
  | { kind: 'gate-reservation'; action: 'reserve' | 'start' | 'retain' | 'release' | 'reroute'; runId: string; from?: string; to?: string; reason: string };

export interface ReleaseTrafficHookJudgment {
  verdict: 'allow' | 'hold';
  emergency: boolean;
  reasons: string[];
}

export interface ReleaseTrafficHookDecision {
  state: ReleaseTrafficHookState;
  changes: ReleaseTrafficHookChange[];
  ignored?: string;
  judgment: ReleaseTrafficHookJudgment;
}

function copyState(state: ReleaseTrafficHookState): ReleaseTrafficHookState {
  return {
    workerStopAt: state.workerStopAt,
    gateReservation: state.gateReservation ? { ...state.gateReservation } : null,
    ...(state.terminalRunIds ? { terminalRunIds: [...state.terminalRunIds] } : {}),
    ...(state.globalCap === undefined ? {} : { globalCap: state.globalCap }),
    ...(state.taCaps ? { taCaps: { ...state.taCaps } } : {}),
    ...(state.podPhasePrewarm ? { podPhasePrewarm: Object.fromEntries(Object.entries(state.podPhasePrewarm).map(([phase, value]) => [phase, { ...value }])) } : {}),
    hosts: Object.fromEntries(Object.entries(state.hosts).map(([host, value]) => [host, { ...value, slotPrefixes: [...value.slotPrefixes] }])),
  };
}

function validCap(cap: number): boolean {
  return Number.isSafeInteger(cap) && cap >= RLA_TRAFFIC_EVENT_HOOK_TABLE.events['global-cap'].minimum;
}

function judgeEvent(event: ReleaseTrafficHookEvent, changes: readonly ReleaseTrafficHookChange[], ignored: string | undefined, requestBounded = false): ReleaseTrafficHookJudgment {
  const reasons: string[] = ignored ? [ignored] : [];
  let emergency = 'emergency' in event && event.emergency === true;
  if (emergency && 'reason' in event && event.reason?.trim()) reasons.push(`emergency:${event.reason.trim()}`);
  if (changes.some((change) => change.kind === 'host-cap' && change.to === 0)) {
    emergency = true;
    reasons.push('host-cap-zero');
  }
  if (requestBounded || changes.some((change) => (change.kind === 'global-cap' || change.kind === 'ta-cap') && change.reason === 'global-cap-bound')) {
    reasons.push('global-cap-bound');
  }
  if (event.type === 'global-cap' && event.cap === 0) {
    emergency = true;
    reasons.push('global-cap-zero');
  }
  if (event.type === 'ta-cap' && event.cap === 0) {
    emergency = true;
    reasons.push(`ta-cap-zero:${event.seat}`);
  }
  if (event.type === 'pod-phase-prewarm' && event.readyPods < event.targetPods) reasons.push('pod-phase-prewarm-incomplete');
  return { verdict: reasons.length || emergency ? 'hold' : 'allow', emergency, reasons: [...new Set(reasons)] };
}

function observeDecision(event: ReleaseTrafficHookEvent, judgment: ReleaseTrafficHookJudgment, changes: readonly ReleaseTrafficHookChange[], ignored?: string): void {
  try {
    debug.log('release-loop.traffic-hook', 'event-decision', {
      eventType: event.type,
      input: event,
      judgment,
      changes,
      ignored: ignored ?? null,
    });
  } catch {
    // Observation must not alter the deterministic traffic decision.
  }
}

function slotBoundedCap(host: ReleaseTrafficHookHost, requested: number): number {
  if (!Number.isFinite(requested) || requested <= 0 || !host.healthy || host.overloaded || host.gateReserved) return 0;
  return Math.min(Math.floor(requested), host.slotPrefixes.length);
}

function changeCap(state: ReleaseTrafficHookState, hostName: string, requested: number, reason: string, changes: ReleaseTrafficHookChange[]): void {
  const host = state.hosts[hostName];
  if (!host) return;
  const next = slotBoundedCap(host, requested);
  if (host.cap === next) return;
  changes.push({ kind: 'host-cap', host: hostName, from: host.cap, to: next, reason });
  host.cap = next;
}

function enforceSlotBounds(state: ReleaseTrafficHookState, changes: ReleaseTrafficHookChange[]): void {
  for (const [hostName, host] of Object.entries(state.hosts)) {
    const next = slotBoundedCap(host, host.cap);
    if (host.cap === next) continue;
    changes.push({ kind: 'host-cap', host: hostName, from: host.cap, to: next, reason: 'slot-prefix-cap-bound' });
    host.cap = next;
  }
}

function applyTaCaps(
  state: ReleaseTrafficHookState,
  requested: Partial<Record<ReleaseTrafficHookSeat, number>>,
  reason: string,
  changes: ReleaseTrafficHookChange[],
): void {
  const seats: readonly ReleaseTrafficHookSeat[] = ['OP', 'TC', 'MK', 'UX'];
  const active = seats.filter((seat) => requested[seat] !== undefined);
  const total = active.reduce((sum, seat) => sum + requested[seat]!, 0);
  const cap = state.globalCap;
  const next = { ...requested };
  if (cap !== undefined && total > cap && active.length > 0) {
    const scaled = new Map<ReleaseTrafficHookSeat, number>();
    let assigned = 0;
    for (const seat of active) {
      const value = Math.floor(requested[seat]! * cap / total);
      scaled.set(seat, value);
      assigned += value;
    }
    let remainder = cap - assigned;
    for (const seat of active) {
      if (remainder === 0) break;
      if (scaled.get(seat)! < requested[seat]!) {
        scaled.set(seat, scaled.get(seat)! + 1);
        remainder--;
      }
    }
    for (const seat of active) next[seat] = scaled.get(seat)!;
  }
  const previous = state.taCaps ?? {};
  for (const seat of seats) {
    const from = previous[seat] ?? null;
    const to = next[seat];
    if (to === undefined || from === to) continue;
    changes.push({ kind: 'ta-cap', seat, from, to,
      reason: to < requested[seat]! ? 'global-cap-bound' : reason });
  }
  state.taCaps = next;
}

function releaseReservation(state: ReleaseTrafficHookState, runId: string, changes: ReleaseTrafficHookChange[], reason: string): void {
  const reservation = state.gateReservation;
  if (!reservation || reservation.runId !== runId) return;
  const host = state.hosts[reservation.host];
  if (host) {
    host.gateReserved = false;
    changeCap(state, reservation.host, host.overloaded ? 0 : host.targetCap, 'gate-reservation-released', changes);
  }
  changes.push({ kind: 'gate-reservation', action: 'release', runId, from: reservation.host, reason });
  state.gateReservation = null;
  state.terminalRunIds = [...new Set([...(state.terminalRunIds ?? []), runId])];
}

function reserveHost(state: ReleaseTrafficHookState, hostName: string, runId: string, phase: 'reserved' | 'running', excludeFromTrainCap: boolean, changes: ReleaseTrafficHookChange[]): string | undefined {
  const current = state.gateReservation;
  if (current && (current.runId !== runId || current.host !== hostName)) return 'gate-host-already-reserved';
  const host = state.hosts[hostName];
    if (!host || !host.healthy || host.overloaded || host.slotPrefixes.length === 0) return 'gate-host-unavailable';
  if (!current) {
    host.gateReserved = excludeFromTrainCap;
    if (excludeFromTrainCap) changeCap(state, hostName, 0, 'reserved-for-release-gate', changes);
    state.gateReservation = { runId, host: hostName, phase };
    changes.push({ kind: 'gate-reservation', action: 'reserve', runId, to: hostName, reason: 'release-gate-window' });
  } else if (current.phase === 'reserved' && phase === 'running') {
    current.phase = phase;
    changes.push({ kind: 'gate-reservation', action: 'start', runId, to: hostName, reason: 'gate-started' });
  }
  return undefined;
}

/** Deterministic event-to-traffic decision. It computes desired knobs but performs no file, host, or queue operations. */
export function evaluateReleaseTrafficHook(state: ReleaseTrafficHookState, event: ReleaseTrafficHookEvent): ReleaseTrafficHookDecision {
  const next = copyState(state);
  const changes: ReleaseTrafficHookChange[] = [];
  let ignored: string | undefined;
  let requestBounded = false;

  if ('runId' in event && typeof event.runId === 'string' && next.terminalRunIds?.includes(event.runId)) {
    ignored = 'release-run-terminal';
  }

  if (!ignored) switch (event.type) {
    case 'cut-minus-30': {
      if (!event.runId?.trim() || !event.gateHost?.trim()) {
        ignored = 'cut-minus-30-requires-run-id-and-gate-host';
        break;
      }
      if (!Number.isFinite(event.minutesToCut) || event.minutesToCut < 0 || event.minutesToCut > RLA_TRAFFIC_EVENT_HOOK_TABLE.cutMinusMinutes) {
        ignored = 'outside-cut-minus-30-window';
        break;
      }
      if (!Number.isFinite(Date.parse(event.landBy))) {
        ignored = 'release-schedule-land-by-invalid';
        break;
      }
      if (RLA_TRAFFIC_EVENT_HOOK_TABLE.events['cut-minus-30'].reserveGateHost) {
        ignored = reserveHost(next, event.gateHost, event.runId, 'reserved',
          RLA_TRAFFIC_EVENT_HOOK_TABLE.events['cut-minus-30'].excludeHostFromTrainCap, changes);
      }
      // Treat reservation and worker deadline as one decision: a conflicting or
      // unavailable gate host must not stop workers for a release it cannot serve.
      if (!ignored && RLA_TRAFFIC_EVENT_HOOK_TABLE.events['cut-minus-30'].workerStopAt === 'schedule.landBy' && next.workerStopAt !== event.landBy) {
        changes.push({ kind: 'worker-stop-at', from: next.workerStopAt, to: event.landBy, reason: 'release-schedule-land-by' });
        next.workerStopAt = event.landBy;
      }
      break;
    }
    case 'gate-start': {
      const reservation = next.gateReservation;
      if (!reservation || reservation.runId !== event.runId || reservation.host !== event.host) {
        ignored = 'gate-reservation-run-or-host-mismatch';
      } else if (reservation.phase === 'reserved') {
        const host = next.hosts[event.host];
        if (!host || !host.healthy || host.overloaded || host.slotPrefixes.length === 0) ignored = 'gate-host-unavailable';
        else {
          reservation.phase = RLA_TRAFFIC_EVENT_HOOK_TABLE.events['gate-start'].reservationPhase;
          changes.push({ kind: 'gate-reservation', action: 'start', runId: event.runId, to: event.host, reason: 'gate-started' });
        }
      } else if (reservation.phase !== 'running') ignored = 'gate-reservation-not-startable';
      break;
    }
    case 'gate-failure': {
      const reservation = next.gateReservation;
      if (!reservation || reservation.runId !== event.runId || reservation.host !== event.host) {
        ignored = 'gate-reservation-not-owned-by-run';
      } else if (reservation.phase !== 'running') {
        ignored = 'gate-failure-requires-running';
      } else if (event.retryable && RLA_TRAFFIC_EVENT_HOOK_TABLE.events['gate-failure'].retryable === 'retain-reservation') {
        reservation.phase = 'reserved';
        changes.push({ kind: 'gate-reservation', action: 'retain', runId: event.runId, to: event.host, reason: 'retryable-gate-failure' });
      } else if (!event.retryable && RLA_TRAFFIC_EVENT_HOOK_TABLE.events['gate-failure'].terminal === 'release-reservation') {
        releaseReservation(next, event.runId, changes, 'terminal-gate-failure');
      } else ignored = 'gate-failure-not-configured';
      break;
    }
    case 'gate-pass': {
      const reservation = next.gateReservation;
      if (!reservation || reservation.runId !== event.runId || reservation.host !== event.host) ignored = 'gate-reservation-run-or-host-mismatch';
      else if (reservation.phase === 'running'
        && RLA_TRAFFIC_EVENT_HOOK_TABLE.events['gate-pass'].releaseOn === 'publish') {
        reservation.phase = RLA_TRAFFIC_EVENT_HOOK_TABLE.events['gate-pass'].reservationPhase;
        changes.push({ kind: 'gate-reservation', action: 'retain', runId: event.runId, to: event.host, reason: 'gate-passed-awaiting-publish' });
      } else ignored = 'gate-must-be-running-before-pass';
      break;
    }
    case 'publish': {
      if (RLA_TRAFFIC_EVENT_HOOK_TABLE.events.publish.reservation === 'release') {
        const reservation = next.gateReservation;
        if (!reservation || reservation.runId !== event.runId) ignored = 'gate-reservation-run-mismatch';
        else if (reservation.phase !== 'passed') ignored = 'gate-must-pass-before-publish';
        else releaseReservation(next, event.runId, changes, 'release-published');
      }
      break;
    }
    case 'host-failure': {
      const failed = next.hosts[event.host];
      if (!failed) { ignored = 'host-unknown'; break; }
      failed.healthy = false;
      changeCap(next, event.host, RLA_TRAFFIC_EVENT_HOOK_TABLE.events['host-failure'].hostCap, 'host-failed', changes);
      if (RLA_TRAFFIC_EVENT_HOOK_TABLE.events['host-failure'].rerouteGateReservation && next.gateReservation?.host === event.host) {
        const reservation = next.gateReservation;
        const replacementName = (event.gateHostCandidates ?? []).find((candidate) => {
          const candidateHost = next.hosts[candidate];
          return candidate !== event.host && candidateHost?.healthy && !candidateHost.overloaded && candidateHost.slotPrefixes.length > 0;
        });
        failed.gateReserved = false;
        if (!replacementName) {
          changes.push({ kind: 'gate-reservation', action: 'release', runId: reservation.runId, from: event.host, reason: 'reserved-gate-host-failed-no-eligible-replacement' });
          next.gateReservation = null;
        } else {
          const replacement = next.hosts[replacementName]!;
          replacement.gateReserved = RLA_TRAFFIC_EVENT_HOOK_TABLE.events['host-failure'].rerouteGateReservation;
          if (replacement.gateReserved) changeCap(next, replacementName, 0, 'rerouted-release-gate-reservation', changes);
          next.gateReservation = { ...reservation, host: replacementName, phase: 'reserved' };
          changes.push({ kind: 'gate-reservation', action: 'reroute', runId: reservation.runId, from: event.host, to: replacementName, reason: 'reserved-gate-host-failed' });
        }
      }
      break;
    }
    case 'host-load': {
      const host = next.hosts[event.host];
      if (!host) { ignored = 'host-unknown'; break; }
      if (!Number.isFinite(event.loadPercent) || event.loadPercent < 0) { ignored = 'load-percent-invalid'; break; }
      const rule = RLA_TRAFFIC_EVENT_HOOK_TABLE.events['host-load'];
      if (event.loadPercent >= rule.shedAtOrAbovePercent) {
        host.overloaded = true;
        changeCap(next, event.host, 0, 'load-at-or-above-80-percent', changes);
      } else if (event.loadPercent <= rule.restoreAtOrBelowPercent) {
        host.overloaded = false;
        changeCap(next, event.host, rule.restoreCapFrom === 'targetCap' ? host.targetCap : host.cap, 'load-at-or-below-40-percent', changes);
      }
      break;
    }
    case 'global-cap': {
      if (!validCap(event.cap)) { ignored = 'global-cap-invalid'; break; }
      const from = next.globalCap ?? null;
      if (from !== event.cap) changes.push({ kind: 'global-cap', from, to: event.cap, reason: event.reason ?? 'global-cap-event' });
      next.globalCap = event.cap;
      if (next.taCaps) applyTaCaps(next, next.taCaps, 'global-cap-event', changes);
      break;
    }
    case 'ta-cap': {
      if (!validCap(event.cap)) { ignored = 'ta-cap-invalid'; break; }
      if (next.globalCap === undefined) { ignored = 'global-cap-unset'; break; }
      applyTaCaps(next, { ...next.taCaps, [event.seat]: event.cap }, event.reason ?? 'ta-cap-event', changes);
      requestBounded = next.taCaps?.[event.seat] !== event.cap;
      break;
    }
    case 'pod-phase-prewarm': {
      if (!event.phase.trim() || !Number.isSafeInteger(event.readyPods) || event.readyPods < 0
        || !Number.isSafeInteger(event.targetPods) || event.targetPods < 0) {
        ignored = 'pod-phase-prewarm-invalid';
        break;
      }
      const from = next.podPhasePrewarm?.[event.phase] ?? null;
      const to = { readyPods: event.readyPods, targetPods: event.targetPods, ready: event.readyPods >= event.targetPods };
      next.podPhasePrewarm = { ...next.podPhasePrewarm, [event.phase]: to };
      changes.push({ kind: 'pod-phase-prewarm', phase: event.phase, from, to });
      break;
    }
  }

  enforceSlotBounds(next, changes);
  const judgment = judgeEvent(event, changes, ignored, requestBounded);
  observeDecision(event, judgment, changes, ignored);
  return { state: next, changes, ...(ignored ? { ignored } : {}), judgment };
}
