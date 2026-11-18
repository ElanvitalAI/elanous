/**
 * TURN-CAPSULE-EVENTS contract (내부 문서 `TURN-CAPSULE-EVENTS` §3) — the shared names every lane builds on.
 *
 * Principle (CEO, 11-18): no capsule (subagent · harness child · long shell · graph run · long MCP call) may hijack the
 * main turn; the seat can always talk to the outside. A capsule runs detached, its completion comes back as an event,
 * and that event opens a new turn through the one door.
 *
 * This file is types, constants and event ordering — no wiring. Lane B
 * (capsule host · completion frames), lane C (event bus · the door) and lane A (capsule policy) implement against it;
 * the SIM-WORLD-CAPSULE-EVENTS devices use the same names. Capsule behavior has no switch.
 */

// ── Capsules ──────────────────────────────────────────────────────────────────────────────────────────────
export const CAPSULE_KINDS = ['shell', 'agent', 'harness', 'graph', 'mcp'] as const;
export type CapsuleKind = (typeof CAPSULE_KINDS)[number];

export type CapsuleStatus = 'ok' | 'failed' | 'timeout' | 'cancelled';

/** One folded progress line of a running capsule (the «key activity» line, cell CAPSULE-B3). */
export interface CapsuleProgressEvent {
  readonly type: 'capsule-progress';
  readonly capsuleId: string;
  readonly kind: CapsuleKind;
  readonly sessionId: string;
  readonly at: number;
  readonly line: string;
}

/** A capsule finished (any status). It returns to the main loop as a turn event (source `capsule-done`). */
export interface CapsuleDoneEvent {
  readonly type: 'capsule-done';
  readonly capsuleId: string;
  readonly kind: CapsuleKind;
  readonly sessionId: string;
  readonly seat?: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly status: CapsuleStatus;
  /** Short, already-redacted summary for the notice turn — never raw tool output. */
  readonly summary: string;
}

export type CapsuleEvent = CapsuleProgressEvent | CapsuleDoneEvent;

// ── Turn events (one bus) ─────────────────────────────────────────────────────────────────────────────────
/** Highest priority first. A person always goes before anything automatic. */
export const TURN_EVENT_SOURCES = ['human', 'urgent-mail', 'capsule-done', 'wakeup', 'mail', 'watch'] as const;
export type TurnEventSource = (typeof TURN_EVENT_SOURCES)[number];

export interface TurnEvent {
  readonly id: string;
  readonly source: TurnEventSource;
  /** Same key = same logical event (msgId · wakeupId · capsuleId); a second publish is a duplicate, never a second turn. */
  readonly dedupeKey: string;
  readonly arrivedAt: number;
  /** Latest useful delivery time; past it the event is still delivered (late), never dropped silently. */
  readonly deliverBy?: number;
  readonly text: string;
  readonly capsule?: CapsuleDoneEvent;
}

/** Bus order: source priority, then arrival, then id — total and deterministic. */
export function compareTurnEvents(a: TurnEvent, b: TurnEvent): number {
  const rank = TURN_EVENT_SOURCES.indexOf(a.source) - TURN_EVENT_SOURCES.indexOf(b.source);
  if (rank !== 0) return rank;
  if (a.arrivedAt !== b.arrivedAt) return a.arrivedAt - b.arrivedAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * How a batch left the door (v1.1 · JUD FU 1):
 * - responded — the turn answered: events are done (seen).
 * - failed    — the turn errored: events go back to waiting with the source's backoff.
 * - cancelled — a person cancelled the turn: events go back to waiting at once, no backoff (they were not wrong).
 * - stopped   — a cap or the system stopped the turn (wall cap · shutdown): events go back to waiting at once and the
 *               next offer carries the checkpoint; never counted as a failure.
 */
export type TurnEventOutcome = 'responded' | 'failed' | 'cancelled' | 'stopped';
export const TURN_EVENT_OUTCOMES: readonly TurnEventOutcome[] = ['responded', 'failed', 'cancelled', 'stopped'];

/** Lane C (CAPSULE-C1). Sources publish only through adapters; the door is the only consumer. */
export interface TurnEventBus {
  publish(event: TurnEvent): { readonly duplicate: boolean };
  /** Waiting events in bus order, without taking them. */
  pending(): readonly TurnEvent[];
  /** Up to `max` events in bus order, moved to in-flight until acked. */
  take(max: number): readonly TurnEvent[];
  /** See {@link TurnEventOutcome}: responded → done · failed → waiting with backoff · cancelled/stopped → waiting now. */
  ack(ids: readonly string[], outcome: TurnEventOutcome): void;
}

// ── The one door (lane C · CAPSULE-C2) ────────────────────────────────────────────────────────────────────
export interface DoorReservation {
  readonly token: string;
  readonly reservedAt: number;
}

export type DoorOfferReason = 'event' | 'turn-end' | 'boot' | 'watchdog';

/** Why the door would not reserve: a turn is already reserved/running, or a person is typing (a person goes first). */
export type DoorRefusal = 'busy' | 'human-first';
export type DoorReserveResult =
  | { readonly ok: true; readonly reservation: DoorReservation }
  | { readonly ok: false; readonly refusal: DoorRefusal };

// ── Turn state machine (v1.1 · JUD FU 3) ─────────────────────────────────────────────────────────────────
/** idle → reserved (reserve) → running (start) → closing (end) → idle (batch acked). reserved → idle = start never came. */
export const TURN_STATES = ['idle', 'reserved', 'running', 'closing'] as const;
export type TurnState = (typeof TURN_STATES)[number];

export const TURN_TRANSITIONS: Readonly<Record<TurnState, readonly TurnState[]>> = {
  idle: ['reserved'],
  reserved: ['running', 'idle'],
  running: ['closing'],
  closing: ['idle'],
};

export function canTurnTransition(from: TurnState, to: TurnState): boolean {
  return TURN_TRANSITIONS[from].includes(to);
}

export interface TurnDoor {
  /** Something may be waiting: the door decides (idle · no human typing) and starts at most one turn. */
  offer(reason: DoorOfferReason): void;
  /** Synchronous: marks busy before any await, so two offers can never open two turns (v1.1 · JUD FU 2: the refusal says why). */
  reserve(): DoorReserveResult;
  start(reservation: DoorReservation, batch: readonly TurnEvent[]): void;
  end(reservation: DoorReservation, outcome: TurnEventOutcome): void;
  busy(): boolean;
}

// ── Capsule policy (lane A · CAPSULE-A1) ──────────────────────────────────────────────────────────────────
/** Longest a capsule may hold the main turn synchronously before it is detached. 출처: CEO principle 11-18 18:1x («짧은 상한 · 예 10초»). */
export const CAPSULE_SYNC_CAP_MS = 10_000;

export interface CapsuleDecisionInput {
  readonly tool: string;
  readonly kind: CapsuleKind | null;
  readonly requestedBackground?: boolean;
}

export interface CapsuleDecision {
  readonly mode: 'sync' | 'detach';
  /** For `sync`: how long the main turn may wait before handing the capsule to the background. */
  readonly syncCapMs: number;
  readonly reason: string;
}

export interface CapsulePolicy {
  decide(input: CapsuleDecisionInput): CapsuleDecision;
}

// ── No switches (대표 11-18 21:5x CAPSULE-FLAGS-REMOVE-DEFAULT) ─────────────────────────────────────────────────
// The capsule path is the only path: no `turn.capsuleMode`, no `turn.capsuleStages`, no env override. The way back is a revert PR.
