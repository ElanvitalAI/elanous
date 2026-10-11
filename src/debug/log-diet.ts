import type { DebugEvent } from './log.js';

export const LOG_DIET_WINDOW_MS = 60_000;

/** LOG-DIET-2 — minimum spacing between two `log.diet/suppressed` summary releases.
 *  One diet window: a folded stream costs at most one summary row per window instead of one per flush. */
export const LOG_DIET_SUMMARY_MIN_INTERVAL_MS = LOG_DIET_WINDOW_MS;

/** LOG-DIET-2 — pending-stream pressure that releases summaries before the interval elapses. */
export const LOG_DIET_SUMMARY_MAX_PENDING = 256;

export const LOG_DIET_KEYS: Readonly<Record<string, 'repeat' | 'consecutive'>> = {
  'watchdog/activity': 'consecutive',
  'user-config.llm/provider-resolved': 'repeat',
  'hitl.card-bridge/skipped': 'repeat',
  'input.cursor.claim/chat-main': 'repeat',
  'tox.loop/waiting-capacity': 'repeat',
  'tox.loop/tick': 'repeat',
  'llm.credential/provider-key-missing': 'repeat',
  'llm.credential/provider-key-resolved': 'repeat',
  'pty.manifest/output-bytes-flushed': 'repeat',
  // `pod-lease/admit-by-usage` is NOT folded: dispatch backpressure and the TA parent-host admission
  // read it back from logs and count rows (`admissionCounts`) — it is a judgment-path event.
};

export interface LogDietSummary {
  category: string;
  event: string;
  count: number;
  windowMs: number;
  firstSuppressedAt: string;
  lastSuppressedAt: string;
  runId?: string;
  sessionId?: string;
}

type Policy = 'repeat' | 'consecutive';
type DietRecord = Pick<DebugEvent, 'category' | 'event' | 'data' | 'level' | 'session_id' | 'runId'>;

interface Stream {
  category: string;
  event: string;
  runId?: string;
  sessionId?: string;
  value: string;
  lastEmittedAt: number;
  count: number;
  firstSuppressedAt?: string;
  lastSuppressedAt?: string;
}

/** Canonicalize objects (not arrays) so payload property insertion order is not an identity. */
function stableValue(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'bigint') return `${item}n`;
    if (item && typeof item === 'object') {
      if (seen.has(item)) return '<circular>';
      seen.add(item);
      if (Array.isArray(item)) return item;
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
    }
    return item;
  }) ?? 'undefined';
}

export class LogDietGuard {
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly keys: Readonly<Record<string, Policy>>;
  private readonly maxStreams: number;
  private readonly summaryMinIntervalMs: number;
  private readonly summaryMaxPending: number;
  private readonly disabled: boolean;
  private readonly streams = new Map<string, Stream>();
  private lastSummaryReleaseAt = Number.NEGATIVE_INFINITY;
  private pendingStreams = 0;

  constructor(opts: { windowMs?: number; now?: () => number; keys?: Readonly<Record<string, Policy>>; maxStreams?: number; summaryMinIntervalMs?: number; summaryMaxPending?: number } = {}) {
    this.windowMs = opts.windowMs ?? LOG_DIET_WINDOW_MS;
    this.now = opts.now ?? Date.now;
    this.keys = opts.keys ?? LOG_DIET_KEYS;
    this.maxStreams = Math.max(1, opts.maxStreams ?? 2000);
    this.summaryMinIntervalMs = Math.max(0, opts.summaryMinIntervalMs ?? LOG_DIET_SUMMARY_MIN_INTERVAL_MS);
    this.summaryMaxPending = Math.max(1, opts.summaryMaxPending ?? LOG_DIET_SUMMARY_MAX_PENDING);
    this.disabled = process.env.ELANOUS_LOG_DIET === 'off';
  }

  private summary(stream: Stream): LogDietSummary | undefined {
    if (!stream.count) return undefined;
    return {
      category: stream.category,
      event: stream.event,
      count: stream.count,
      windowMs: this.windowMs,
      firstSuppressedAt: stream.firstSuppressedAt!,
      lastSuppressedAt: stream.lastSuppressedAt!,
      ...(stream.runId !== undefined ? { runId: stream.runId } : {}),
      ...(stream.sessionId !== undefined ? { sessionId: stream.sessionId } : {}),
    };
  }

  admit(rec: DietRecord): { pass: boolean; summaries: LogDietSummary[] } {
    const policy = this.keys[`${rec.category}/${rec.event}`];
    // LOG-DIET-2 — a registered key folds at warn too; unregistered warn/error/critical alarms never fold.
    if (this.disabled || !policy || rec.category === 'log.diet'
      || rec.level === 'error' || rec.level === 'critical') {
      return { pass: true, summaries: [] };
    }

    const runId = rec.runId ?? (rec.data && typeof rec.data === 'object' && !Array.isArray(rec.data)
      ? (rec.data as Record<string, unknown>).runId : undefined);
    const sessionId = rec.session_id;
    let value: string;
    try {
      value = stableValue([stableValue(rec.data), rec.level ?? 'debug', sessionId, runId]);
    } catch {
      return { pass: true, summaries: [] }; // Logging must remain fail-open for unusual payloads.
    }
    const key = stableValue(policy === 'repeat'
      ? [rec.category, rec.event, value]
      : [rec.category, rec.event, sessionId, runId]);
    const time = this.now();
    const summaries: LogDietSummary[] = [];
    const stream = this.streams.get(key);
    if (stream) {
      this.streams.delete(key); // Evict the least recently observed flow.
      this.streams.set(key, stream);
      if ((policy === 'repeat' || stream.value === value) && time - stream.lastEmittedAt < this.windowMs) {
        if (stream.count === 0) this.pendingStreams++;
        stream.count++;
        const at = new Date(time).toISOString();
        stream.firstSuppressedAt ??= at;
        stream.lastSuppressedAt = at;
        return { pass: false, summaries };
      }
      const pending = this.summary(stream);
      if (pending) { summaries.push(pending); this.pendingStreams--; }
      stream.count = 0;
      stream.firstSuppressedAt = undefined;
      stream.lastSuppressedAt = undefined;
      stream.value = value;
      stream.lastEmittedAt = time;
      return { pass: true, summaries };
    }

    if (this.streams.size >= this.maxStreams) {
      const oldestKey = this.streams.keys().next().value!;
      const oldest = this.streams.get(oldestKey)!;
      const pending = this.summary(oldest);
      if (pending) { summaries.push(pending); this.pendingStreams--; }
      this.streams.delete(oldestKey);
    }
    this.streams.set(key, { category: rec.category, event: rec.event,
      ...(typeof runId === 'string' ? { runId } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      value, lastEmittedAt: time, count: 0 });
    return { pass: true, summaries };
  }

  /** Emit pending counts without reopening the current sample windows.
   *  LOG-DIET-2 — releases are spaced by `summaryMinIntervalMs` unless forced (drain)
   *  or the pending-stream pressure cap is hit. Deferred counts stay accumulated on
   *  their streams, so a held-back release never drops a suppressed event. */
  flushPending(force = false): LogDietSummary[] {
    if (!force && !this.summaryReleaseDue()) return [];
    const summaries: LogDietSummary[] = [];
    for (const stream of this.streams.values()) {
      const pending = this.summary(stream);
      if (pending) summaries.push(pending);
      stream.count = 0;
      stream.firstSuppressedAt = undefined;
      stream.lastSuppressedAt = undefined;
    }
    this.pendingStreams = 0;
    this.lastSummaryReleaseAt = this.now();
    return summaries;
  }

  private summaryReleaseDue(): boolean {
    if (this.pendingStreams >= this.summaryMaxPending) return true;
    return this.now() - this.lastSummaryReleaseAt >= this.summaryMinIntervalMs;
  }

  drain(): LogDietSummary[] {
    const summaries = this.flushPending(true);
    this.streams.clear();
    return summaries;
  }
}
