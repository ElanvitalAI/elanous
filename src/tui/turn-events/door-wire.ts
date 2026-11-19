/**
 * CAPSULE-C2 PR-b — how entry holds the one door (no capsule switch).
 *
 * Entry opens a turn in three places (queued item · internal wake · a person's Enter). Each takes a reservation here
 * first; `startChatTurn` runs only with the reservation this holder carries (`beginTurn`), and the turn's end gives it
 * back (`endTurn`). Pure: the TUI facts (draft · unread keys · last key) come in as functions.
 */
import { type DoorReservation, type TurnEventOutcome } from '../../turn-capsule/contract.js';
import type { NextTuiQueueItemKind } from '../core/queue.js';
import { createTurnDoor, type OneTurnDoor, type TurnDoorDeps } from './door.js';

/** Same quiet window as the internal-turn gate (`humanQuietMs` default). */
export const DOOR_HUMAN_QUIET_MS = 10_000;

export interface HumanFirstFacts {
  readonly draft: () => string;
  readonly unreadKeys: () => number;
  /** Last person key, ms (0 = none). */
  readonly lastHumanKeyAt: () => number;
  readonly now: () => number;
  readonly quietMs?: number;
  /** TURN-FIELD-BUG-5: the key that submitted the last person turn (0 = none) — keys up to it are not «typing». */
  readonly lastHumanTurnKeyAt?: () => number;
}

/** The internal-turn gate's «human typing» read, for the door: a person goes first. */
export function humanFirstDetail(facts: HumanFirstFacts): string | null {
  if (facts.draft().length > 0) return 'buffer';
  if (facts.unreadKeys() > 0) return 'unread-keys';
  const last = facts.lastHumanKeyAt();
  const mark = facts.lastHumanTurnKeyAt?.() ?? 0;
  if (last > 0 && last > mark && facts.now() - last < (facts.quietMs ?? DOOR_HUMAN_QUIET_MS)) return 'quiet-window';
  return null;
}

/** CAPSULE-C2-FU: who opens the next queued turn — a person's line first (no human-first), then a held notice. */
export type DoorOpener = 'person' | 'held-notice' | 'queue-notice' | 'none';

export function nextDoorOpener(facts: { readonly headKind: NextTuiQueueItemKind | null; readonly hasHeldNotice: boolean }): DoorOpener {
  if (facts.headKind === 'user') return 'person';
  if (facts.hasHeldNotice) return 'held-notice';
  return facts.headKind === 'notice' ? 'queue-notice' : 'none';
}

export type DoorTurnKind = 'completed' | 'cancelled' | 'failed' | 'stopped';

export function doorOutcomeOf(kind: DoorTurnKind | undefined): TurnEventOutcome {
  // CAPSULE-C2-FU: a stall-abort is 'stopped' (waiting now), not a person's cancel.
  return kind === 'completed' ? 'responded' : kind === 'cancelled' ? 'cancelled' : kind === 'stopped' ? 'stopped' : 'failed';
}

export interface EntryTurnDoor {
  readonly door: OneTurnDoor;
  /** Automatic opener (queued notice · internal wake). Null = refused (busy · a person first): the bell remembers it. */
  reserveAuto(): DoorReservation | null;
  /** A person's Enter. Null only when a turn is already running. */
  reserveHuman(): DoorReservation | null;
  /** startChatTurn: true when the held reservation may start now (then the door is running). */
  beginTurn(): boolean;
  /** The chat turn ended (busy → false). No-op unless a door turn is running. */
  endTurn(kind?: DoorTurnKind): void;
  /** The opener had nothing to start (empty queue · duplicate notice · import failed). */
  releaseIfUnstarted(reservation: DoorReservation): void;
}

export function createEntryTurnDoor(deps: TurnDoorDeps): EntryTurnDoor {
  const door = createTurnDoor(deps);
  let held: DoorReservation | null = null;
  const take = (result: ReturnType<OneTurnDoor['reserve']>): DoorReservation | null => {
    if (!result.ok) return null;
    held = result.reservation;
    return held;
  };
  return {
    door,
    reserveAuto: () => take(door.reserve()),
    reserveHuman: () => take(door.reserveForHuman()),
    beginTurn() {
      if (held === null || !door.holds(held) || door.state() !== 'reserved') {
        deps.log?.('door-begin-refused', { held: held?.token ?? null, state: door.state() });
        return false;
      }
      door.start(held, []);
      return true;
    },
    endTurn(kind) {
      if (held === null || door.state() !== 'running') return;
      const reservation = held;
      held = null;
      door.end(reservation, doorOutcomeOf(kind));
    },
    releaseIfUnstarted(reservation) {
      if (!door.holds(reservation) || door.state() !== 'reserved') return;
      if (held?.token === reservation.token) held = null;
      door.release(reservation);
    },
  };
}

/**
 * CAPSULE-C2-FU: run a turn start through the door. False = the door refused (body not run). A throw before the turn
 * went busy would leave the door running forever (busy never flips back, so endTurn never comes): end it as 'failed'
 * and rethrow. No holder (flag off) = the body alone, unchanged.
 */
export function runDoorTurn(holder: EntryTurnDoor | null, isBusy: () => boolean, body: () => void): boolean {
  if (holder && !holder.beginTurn()) return false;
  try {
    body();
  } catch (error) {
    if (!isBusy()) holder?.endTurn('failed');
    throw error;
  }
  return true;
}
