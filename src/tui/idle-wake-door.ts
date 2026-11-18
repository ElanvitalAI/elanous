/**
 * IDLE-WAKE-SINGLE-DOOR — the one knock that opens a turn on an idle seat.
 *
 * Self-pull, a graph-node notice, seat mail, and an external-event bundle
 * all used to call injectKey(queueWake) themselves. They now register here.
 * Order is the head of the dispatchQueued queue, not a priority on this
 * door. The door only decides whether a knock is allowed (the seat is
 * idle) and fires that one key.
 */

export interface IdleWakeDoorDeps {
  busy: () => boolean;
  injectKey: (key: unknown) => boolean | void;
  queueWake: unknown;
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
  const registered = new Map<string, IdleWakeSource>();
  return {
    register(source) {
      registered.set(source.id, source);
    },
    knock(sourceId) {
      if (!registered.has(sourceId)) return false;
      if (deps.busy()) return false;
      deps.injectKey(deps.queueWake);
      return true;
    },
  };
}
