/**
 * CAPSULE-C2-ONE-DOOR — the one turn door (내부 문서 `TURN-CAPSULE-EVENTS` §3.4 · contract `TurnDoor`).
 *
 * Every turn opens here: a queued notice, an internal wake, a person's Enter. `reserve()` is synchronous, so the busy
 * mark is set before any await and two offers can never open two turns (D7). An automatic reserve is refused while a
 * person is typing (D8 · the same «human typing» read as the internal-turn gate). A busy or held offer is not dropped:
 * it rings the bell once, and the door offers again when the turn ends (K5 pendingWake).
 *
 * Pure module: no TUI, no timers. Entry always wires it (CAPSULE-FLAGS-REMOVE-DEFAULT).
 */
import {
  canTurnTransition,
  type DoorOfferReason,
  type DoorReservation,
  type DoorReserveResult,
  type TurnDoor,
  type TurnEvent,
  type TurnEventOutcome,
  type TurnState,
} from '../../turn-capsule/contract.js';

export interface TurnDoorDeps {
  /** Why a person goes first now (`buffer` · `unread-keys` · `typeahead` · `quiet-window`), or null. */
  readonly humanFirst: () => string | null;
  /** CAPSULE-C2-FU: the next opener is a person's queued line — human-first holds automatic events only. */
  readonly nextIsHuman?: () => boolean;
  /** The door may open one turn: the caller calls `reserve()` and, on ok, `start()`. Called only when idle. */
  readonly onOffer: (reason: DoorOfferReason) => void;
  readonly now?: () => number;
  readonly log?: (event: string, data: Record<string, unknown>) => void;
}

export interface OneTurnDoor extends TurnDoor {
  /** A person's Enter: never refused for «human-first»; replaces an automatic reservation that has not started yet. */
  reserveForHuman(): DoorReserveResult;
  /** False once the reservation was replaced, released or ended — the holder must not start a turn with it. */
  holds(reservation: DoorReservation): boolean;
  /** reserved → idle without a turn (the holder had nothing to start). Rings again if an offer waited. */
  release(reservation: DoorReservation): void;
  state(): TurnState;
  /** Offers that waited (busy · person first) and will ring once at the next idle. */
  bellPending(): boolean;
}

export function createTurnDoor(deps: TurnDoorDeps): OneTurnDoor {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  let state: TurnState = 'idle';
  let current: DoorReservation | null = null;
  let seq = 0;
  let bell = false;
  let ringing = false;

  const move = (to: TurnState, why: string): boolean => {
    if (!canTurnTransition(state, to)) {
      log('door-transition-refused', { from: state, to, why });
      return false;
    }
    state = to;
    return true;
  };

  const issue = (by: 'auto' | 'human'): DoorReservation => {
    current = { token: `door-${++seq}`, reservedAt: now() };
    move('reserved', 'reserve');
    log('door-reserved', { token: current.token, by });
    return current;
  };

  const ring = (): void => {
    // One ring at a time: onOffer may reserve → release → ring again; that inner ring is the bell, not a loop.
    if (!bell || state !== 'idle' || ringing) return;
    bell = false;
    ringing = true;
    try { door.offer('turn-end'); } finally { ringing = false; }
  };

  const holds = (reservation: DoorReservation): boolean => current !== null && current.token === reservation.token;

  const door: OneTurnDoor = {
    offer(reason) {
      if (state !== 'idle') {
        bell = true;
        log('door-hold', { reason, why: 'busy', state });
        return;
      }
      const typing = deps.nextIsHuman?.() === true ? null : deps.humanFirst();
      if (typing) {
        bell = true;
        log('door-hold', { reason, why: 'human-first', detail: typing });
        return;
      }
      deps.onOffer(reason);
    },
    reserve() {
      if (state !== 'idle') return { ok: false, refusal: 'busy' };
      if (deps.humanFirst()) {
        bell = true;
        return { ok: false, refusal: 'human-first' };
      }
      return { ok: true, reservation: issue('auto') };
    },
    reserveForHuman() {
      if (state === 'reserved' && current !== null) {
        // The automatic turn has not started: the person goes first; its holder sees holds() = false and keeps its event.
        log('door-superseded', { token: current.token, by: 'human' });
        current = null;
        move('idle', 'superseded');
        bell = true;
      }
      if (state !== 'idle') return { ok: false, refusal: 'busy' };
      return { ok: true, reservation: issue('human') };
    },
    start(reservation, batch: readonly TurnEvent[]) {
      if (!holds(reservation)) {
        log('door-start-refused', { token: reservation.token, why: 'not-held', state });
        return;
      }
      move('running', 'start');
      log('door-start', { token: reservation.token, batch: batch.length });
    },
    end(reservation, outcome: TurnEventOutcome) {
      if (!holds(reservation) || state !== 'running') {
        log('door-end-refused', { token: reservation.token, outcome, state });
        return;
      }
      move('closing', 'end');
      current = null;
      move('idle', 'acked');
      log('door-end', { token: reservation.token, outcome });
      ring();
    },
    release(reservation) {
      if (!holds(reservation) || state !== 'reserved') return;
      current = null;
      move('idle', 'released');
      ring();
    },
    busy: () => state !== 'idle',
    holds,
    state: () => state,
    bellPending: () => bell,
  };
  return door;
}
