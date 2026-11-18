/**
 * ELN-EXTERNAL-EVENTS-BETWEEN-TURNS test ④ — a burst of external events
 * becomes one idle turn, not one turn per event. The door stays closed
 * while a turn is running; those events wait and leave together.
 */

export interface ExternalEventBundleItem {
  id: string;
  source: string;
}

export interface ExternalEventBundle {
  /** One turn's text. Empty when nothing is waiting. */
  text: string;
  ids: readonly string[];
  /** Events dropped because the waiting queue was already full. */
  overflow: number;
}

export interface ExternalEventBundleLimits {
  /** Distinct waiting events. Default 50. */
  maxItems?: number;
  /** Characters of one idle turn, including the overflow line. Default 8000. */
  maxChars?: number;
}

export interface ExternalEventBundler {
  /** Queue one event. Same id twice is ignored. Returns false when dropped. */
  push(item: ExternalEventBundleItem): boolean;
  /** How many distinct events are waiting. */
  depth(): number;
  /** How many arrivals were dropped since the last take. */
  overflow(): number;
  /**
   * Take every waiting event as one bundle and clear the queue.
   * Null while a turn is running, or when the queue is empty.
   * A full queue keeps the newest events and reports the rest as overflow.
   */
  take(busy: boolean): ExternalEventBundle | null;
}

/** OP #38303: one idle turn keeps at most this many waiting events. */
export const EXTERNAL_EVENT_BUNDLE_MAX_ITEMS = 50;
/** OP #38303: one idle turn stays within this many characters. */
export const EXTERNAL_EVENT_BUNDLE_MAX_CHARS = 8000;

function overflowLine(count: number): string {
  return `외 ${count}건`;
}

export function createExternalEventBundler(
  limits: ExternalEventBundleLimits = {},
): ExternalEventBundler {
  const maxItems = limits.maxItems ?? EXTERNAL_EVENT_BUNDLE_MAX_ITEMS;
  const maxChars = limits.maxChars ?? EXTERNAL_EVENT_BUNDLE_MAX_CHARS;
  const waiting: ExternalEventBundleItem[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  return {
    push(item) {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      waiting.push(item);
      if (waiting.length > maxItems) {
        const oldest = waiting.shift();
        if (oldest) seen.delete(oldest.id);
        dropped += 1;
      }
      return true;
    },
    depth: () => waiting.length,
    overflow: () => dropped,
    take(busy) {
      if (busy || waiting.length === 0) return null;
      let overflow = dropped;
      dropped = 0;
      const kept: ExternalEventBundleItem[] = [];
      let used = overflow > 0 ? overflowLine(overflow).length + 1 : 0;
      for (let i = waiting.length - 1; i >= 0; i -= 1) {
        const item = waiting[i]!;
        const next = item.source.length + (kept.length > 0 || overflow > 0 ? 1 : 0);
        if (kept.length > 0 && used + next > maxChars) {
          overflow += 1;
          seen.delete(item.id);
          continue;
        }
        kept.push(item);
        used += next;
      }
      waiting.length = 0;
      for (const item of kept) seen.delete(item.id);
      kept.reverse();
      const lines = kept.map((item) => item.source);
      if (overflow > 0) lines.push(overflowLine(overflow));
      return {
        ids: kept.map((item) => item.id),
        overflow,
        text: lines.join('\n'),
      };
    },
  };
}
