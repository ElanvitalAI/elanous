// NEXUS · event bus (Phase N-1 PR δ · NEXUS N-1.5 PR b SSoT).
//
// **★ SSoT for in-process pub/sub** post NEXUS N-1.5 cutover (2026-05-06).
// Replaces `src/control/event-bus.ts` which is freeze-deprecated under
// decision #13/#15/#18 (control-server hard landing). Topic shape:
// `kind` prefix matching (NexusEvent), not the legacy `topic` whitelist.
// Migrated consumers should subscribe via `bus.subscribe(cb, [prefix])`
// rather than absorb the legacy ControlEvent shape.
//
// Tiny in-process pub/sub so SSE subscribers (and future PWA/PWA-mirror
// clients) can stream NexusEvents without polling the ring buffer.
// State.events is still the authoritative log; this bus is the
// notification edge.
//
// Topic filter: subscribers pass a list of topic prefixes (e.g.
//   ['nexus.', 'tab.']). When the list is empty/undefined, every
//   event flows through. Matching is prefix-based to keep the
//   namespace cheap to extend.

import type { NexusEvent } from '../state/state.js';

export type NexusEventListener = (ev: NexusEvent) => void;

export interface AppRowChangeEvent {
  appSlug: string;
  table: string;
  operation: 'insert' | 'update' | 'delete';
  rowId: string;
  row: Record<string, unknown>;
}

export class NexusEventBus {
  private listeners = new Set<{ cb: NexusEventListener; prefixes: string[] | undefined }>();

  /** Subscribe to events. `prefixes` is matched against `event.kind`
   *  by `startsWith`; pass undefined / empty for all events. */
  subscribe(cb: NexusEventListener, prefixes?: readonly string[]): () => void {
    const entry = { cb, prefixes: prefixes && prefixes.length > 0 ? [...prefixes] : undefined };
    this.listeners.add(entry);
    return () => { this.listeners.delete(entry); };
  }

  /** Publish an event to all matching subscribers. Listener throws
   *  are swallowed so one bad consumer can't break the loop. */
  publish(ev: NexusEvent): void {
    for (const entry of this.listeners) {
      if (entry.prefixes && !entry.prefixes.some((p) => ev.kind.startsWith(p))) continue;
      try { entry.cb(ev); } catch { /* swallow — observability boundary */ }
    }
  }

  /** Publish a committed app row change on the shared Nexus event stream. */
  publishAppRowChange(change: AppRowChangeEvent): void {
    this.publish({
      ts: Date.now(),
      kind: `app.row.${change.operation}`,
      detail: { ...change },
    });
  }

  size(): number { return this.listeners.size; }
}
