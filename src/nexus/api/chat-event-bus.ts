// Phase B-4 (PWA chat streaming · 2026-05-06) — chat event fanout bus.
//
// `POST /v1/prompt/stream` (B-1+) is single-receiver: only the tab
// that fired the request sees the SSE event stream. Multi-tab
// dogfood — same user with `/chat` open on iPad + laptop — leaves
// the second tab blind to the first tab's turn.
//
// This bus is the wire foundation for multi-tab consistency. Every
// SSE event the prompt-stream handler writes is also published here;
// any peer subscribed to `/v1/chat/events?sessionId=…` receives the
// same shape (re-emitted) on a long-lived observer stream.
//
// Scope (PWA-only · in-process):
//
//   1. Single-process pub/sub — no IPC, no cross-NEXUS broadcast.
//      Multi-process fanout is a v2 concern (likely needs an
//      external event bus or supervisor relay).
//
//   2. Per-session topic — subscribers filter by `sessionId`. A turn
//      against session A does not reach a tab subscribed to session B.
//      This matches the existing daemon-history boundary.
//
//   3. No replay — late subscribers see only events emitted AFTER
//      they subscribed. A history endpoint (replay last N turns) is
//      a deliberate follow-up (`/v1/chat/events/history`).
//
//   4. Backpressure: enqueueing always succeeds for active subscribers.
//      A slow subscriber is the subscriber's problem (they'll fall
//      behind on their ReadableStream); the bus does not buffer.
//
// Consumers other than the PWA (NEXUS itself · MCP server · plugins)
// can subscribe through the same surface — the bus is intentionally
// shape-agnostic about who reads.

export interface ChatBusEvent {
  /** SSE event name — `text-delta` · `image-block` · `tool-call` ·
   *  `tool-result` · `turn-begin` · `turn-end` · `error`. */
  event: string;
  /** Already-encoded JSON payload. Kept as `unknown` so the bus does
   *  not pin to a specific phase's wire shape — handlers downcast. */
  data: unknown;
}

export type ChatBusListener = (e: ChatBusEvent) => void;

export interface ChatEventBus {
  /** Publish an event for `sessionId`. Subscribers for that session
   *  receive it synchronously; mismatched sessions are skipped. */
  publish(sessionId: string, event: ChatBusEvent): void;
  /** Subscribe to events for `sessionId`. Returns an unsubscribe
   *  function the caller MUST invoke on stream close to avoid a
   *  reference leak. */
  subscribe(sessionId: string, listener: ChatBusListener, onClose?: () => void): () => void;
  /** Revoke all current observers for a deleted session before its id can be reused. */
  closeSession(sessionId: string): void;
  /** Diagnostic — current subscriber count for `sessionId`. */
  subscriberCount(sessionId: string): number;
}

export function createChatEventBus(): ChatEventBus {
  const listeners = new Map<string, Set<{ listener: ChatBusListener; onClose?: () => void }>>();
  return {
    publish(sessionId, event): void {
      const set = listeners.get(sessionId);
      if (!set || set.size === 0) return;
      for (const entry of set) {
        try {
          entry.listener(event);
        } catch {
          // Bus must not let one bad listener break the others.
          // Subscribers that throw simply drop the event; the SSE
          // handler-side already wraps writes in try/catch.
        }
      }
    },
    subscribe(sessionId, listener, onClose): () => void {
      let set = listeners.get(sessionId);
      if (!set) {
        set = new Set();
        listeners.set(sessionId, set);
      }
      const entry = { listener, onClose };
      set.add(entry);
      return () => {
        const cur = listeners.get(sessionId);
        if (!cur) return;
        cur.delete(entry);
        if (cur.size === 0) listeners.delete(sessionId);
      };
    },
    closeSession(sessionId): void {
      const set = listeners.get(sessionId);
      if (!set) return;
      listeners.delete(sessionId);
      for (const entry of set) {
        try { entry.onClose?.(); } catch { /* one observer cannot hold the others open */ }
      }
    },
    subscriberCount(sessionId): number {
      return listeners.get(sessionId)?.size ?? 0;
    },
  };
}

// Process-singleton instance — daemon launchers wire this into both
// the producer (handlePromptStreamPost) and the observer endpoint
// (handleChatEventsGet) so the fanout works without explicit DI for
// the common case. Tests can use a fresh bus via createChatEventBus().
let processBus: ChatEventBus | null = null;
export function defaultChatEventBus(): ChatEventBus {
  processBus ??= createChatEventBus();
  return processBus;
}

/** Test-only — replace the process singleton. Returns a disposer that
 *  restores the previous instance. Never call this from production
 *  code. */
export function __setChatEventBusForTest(bus: ChatEventBus): () => void {
  const prev = processBus;
  processBus = bus;
  return () => { processBus = prev; };
}
