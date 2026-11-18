/**
 * IDLE-WAKE-SINGLE-DOOR — the one knock that opens a turn on an idle seat.
 *
 * Self-pull, a graph-node notice, seat mail, and an external-event bundle
 * all used to call injectKey(queueWake) themselves. They now register here.
 * Order is the head of the dispatchQueued queue, not a priority on this
 * door. The door only decides whether a knock is allowed (the seat is
 * idle) and fires that one key.
 */

import { emitTurnLife } from '../debug/turn-life.js';

export interface IdleWakeDoorDeps {
  busy: () => boolean;
  injectKey: (key: unknown) => boolean | void;
  queueWake: unknown;
  /** ELN-SEAT-IDLE-QUEUE-STALL: a knock that does not reach the loop is an event, never a silent no-op. */
  log?: (event: string, data: Record<string, unknown>) => void;
  /** OBSERVE-TURN-EVENT-LIFECYCLE — turn-life observation hook (fail-open). */
  turnLifeLog?: (event: string, data: Record<string, unknown>) => void;
}

export interface IdleWakeSource {
  id: string;
}

export interface IdleWakeDoor {
  register(source: IdleWakeSource): void;
  /** Knock once if the seat is idle. A busy seat keeps the queued notice. */
  knock(sourceId: string): boolean;
}

export function createIdleWakeDoor(deps: IdleWakeDoorDeps): IdleWakeDoor {
  const turnLifeLog = deps.turnLifeLog ?? emitTurnLife;
  const registered = new Map<string, IdleWakeSource>();
  return {
    register(source) {
      registered.set(source.id, source);
    },
    knock(sourceId) {
      if (!registered.has(sourceId)) {
        deps.log?.('wake-knock-unregistered', { source: sourceId });
        return false;
      }
      // Busy: the queued item waits for the turn end's own knock (and the idle-queue watchdog behind it).
      if (deps.busy()) {
        deps.log?.('wake-knock-deferred', { source: sourceId });
        // OBSERVE-TURN-EVENT-LIFECYCLE — 바쁜 문: 알림은 대기하고 턴 끝의 노크가 다시 연다.
        try { turnLifeLog('turn-life:event-while-busy', { source: sourceId, action: 'wait' }); } catch { /* observability is fail-open */ }
        return false;
      }
      if (deps.injectKey(deps.queueWake) === false) {
        deps.log?.('wake-knock-refused', { source: sourceId });
        return false;
      }
      return true;
    },
  };
}
