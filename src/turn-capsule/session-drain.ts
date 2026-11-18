/**
 * CAPSULE-K3-d (seat-state/TC/CAPSULE-K3-SEAT-LIFETIME-DESIGN-1118.md gap ⑧) — the Next TUI chat child delivers only
 * its own session's completed background tasks (plus unscoped legacy notices), never a sibling session's.
 *
 * Before: `globalTaskNotificationQueue.drain()` (repl/index.ts runOneTurn) took every session's receipts from the
 * shared queue file — a resumed or /new session could swallow another session's results. The ACP bridge already
 * drains this way (`acp/core-turn-bridge.ts` · drainForParentSessionOrUnscoped).
 * Always on (CAPSULE-FLAGS-REMOVE-DEFAULT · no switch).
 */
import type { PendingTaskNotification } from '../agent/task-notification.js';

export interface DrainableNotificationQueue {
  drainForParentSessionOrUnscoped(parentSessionId: string): PendingTaskNotification[];
}

export function drainNextTuiNotifications(queue: DrainableNotificationQueue, sessionId: string): PendingTaskNotification[] {
  return queue.drainForParentSessionOrUnscoped(sessionId);
}
