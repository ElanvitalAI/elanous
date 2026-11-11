// PR-3 of multi-platform substrate ROADMAP — terminal host facade.
//
// The facade is a thin publish/subscribe wrapper around the existing
// terminal:mouse-intent emit path. Its job is to provide a multi-
// publisher seam without speculative wiring (G2): this arc only the
// dashboard subscribes to its publish stream. ACP / Discord / PWA
// gateways will attach via subscribePublish in a future arc.
//
// Why this exists:
//
// Today (post PR-2) terminal:mouse-intent flows are:
//   external-terminal-pane / vw pane-content
//     → dashboard.emitTerminalMouseIntent (lambda)
//     → displayEvents.emit('terminal:mouse-intent', ...)
//     → dashboard subscribes for ring-buffer push + runtime dispatch
//
// The dashboard lambda is the implicit single publish point. Adding
// a second consumer (ACP gateway etc.) requires touching the lambda.
// This facade externalizes the publish point so future consumers
// attach via a stable seam:
//
//   external-terminal-pane / vw pane-content
//     → facade.publishMouseIntent (publish API)
//     → emits canonical event + fans out to subscribers
//
// Per G2 / G6 / G7 invariants: this PR only adds the seam. No external
// host wiring this arc. No vocabulary change. No new event shape.
// The facade re-uses buildTerminalMouseIntentEvent so transport /
// posture / interactionPolicy continue to flow through the canonical
// path landed in PR #1333.

import type { DisplayEventBus } from '../display/events.js';
import {
  buildTerminalMouseIntentEvent,
  type TerminalMouseIntentEvent,
  type TerminalMouseIntentSpec,
} from '../surface/terminal-surface-intent.js';

export interface TerminalHostFacadeDeps {
  displayEvents: DisplayEventBus;
  /** Optional debug log. Falls back to no-op when absent. */
  logDebug?: (category: string, event: string, data?: unknown) => void;
  /** Optional debug-enabled gate so log site allocation stays free
   *  when debug is off. */
  isDebugEnabled?: () => boolean;
}

export type TerminalHostPublishSubscriber = (event: TerminalMouseIntentEvent) => void;

export interface TerminalHostFacade {
  /**
   * Build a canonical terminal:mouse-intent event from a spec and
   * publish it through both:
   *   1. the underlying displayEvents bus (preserves PR #1333 behavior
   *      so dashboard subscribers see the same event shape)
   *   2. facade-local subscribers attached via subscribePublish
   *
   * Skips both paths when nobody cares (no displayEvents subscribers
   * AND no facade subscribers) so the hot path stays cheap.
   */
  publishMouseIntent(spec: TerminalMouseIntentSpec): void;
  /**
   * Attach a subscriber to the facade publish stream. Per G2: this
   * arc the only intended subscriber is the dashboard event mirror.
   * External hosts (ACP / Discord / PWA gateways) will attach here
   * in a future arc when their wiring lands.
   *
   * Throwing in a subscriber is isolated; other subscribers still
   * receive the event.
   */
  subscribePublish(cb: TerminalHostPublishSubscriber): () => void;
  /** Snapshot of current subscriber count. Useful for tests. */
  publishSubscriberCount(): number;
  dispose(): void;
}

export function createTerminalHostFacade(
  deps: TerminalHostFacadeDeps,
): TerminalHostFacade {
  const subscribers = new Set<TerminalHostPublishSubscriber>();
  let disposed = false;

  const log = (category: string, event: string, data?: unknown) => {
    if (!deps.logDebug) return;
    if (deps.isDebugEnabled && !deps.isDebugEnabled()) return;
    deps.logDebug(category, event, data);
  };

  log('terminal.host-facade.boot', 'created', { subscriberCount: 0 });

  const publishMouseIntent = (spec: TerminalMouseIntentSpec): void => {
    if (disposed) return;
    const hasBusSubs = deps.displayEvents.hasSubscribers('terminal:mouse-intent');
    const hasFacadeSubs = subscribers.size > 0;
    if (!hasBusSubs && !hasFacadeSubs) {
      // Nobody cares — skip event construction entirely (matches the
      // previous emitTerminalMouseIntent fast-path).
      return;
    }
    const event = buildTerminalMouseIntentEvent(spec);
    if (hasBusSubs) {
      deps.displayEvents.emit(event);
    }
    if (hasFacadeSubs) {
      log('terminal.host-facade.publish', event.mouseType, {
        surfaceId: event.surfaceId,
        paneKind: event.paneKind,
        subscribers: subscribers.size,
        userExposure: event.exposure.userExposure,
      });
      for (const cb of subscribers) {
        try {
          cb(event);
        } catch (err) {
          log('terminal.host-facade.subscriber-throw', 'caught', {
            error: String(err),
          });
        }
      }
    }
  };

  const subscribePublish = (cb: TerminalHostPublishSubscriber): () => void => {
    subscribers.add(cb);
    log('terminal.host-facade.subscribe', 'attached', {
      subscriberCount: subscribers.size,
    });
    return () => {
      if (subscribers.delete(cb)) {
        log('terminal.host-facade.subscribe', 'detached', {
          subscriberCount: subscribers.size,
        });
      }
    };
  };

  return {
    publishMouseIntent,
    subscribePublish,
    publishSubscriberCount: () => subscribers.size,
    dispose() {
      subscribers.clear();
      disposed = true;
      log('terminal.host-facade.dispose', 'cleared', {});
    },
  };
}
