import type { Message } from './msg-store.js';

/** Public GitHub mirror policy for the seat-message ledger. */
export const MIRROR_EVENT_KINDS = ['incident', 'decision', 'correction'] as const;
export const MIRROR_SUMMARY_INTERVAL_MS = 2 * 60 * 60 * 1000;
export const MIRROR_ROTATE_AT = 2_300;

const mirrorKinds: ReadonlySet<string> = new Set(MIRROR_EVENT_KINDS);

export type MirrorEvent = Pick<Message, 'id' | 'from' | 'to' | 'body' | 'kind' | 'createdAt'>;

/** Routine reports and loop traffic never become public mirror comments. */
export function isMirrorEvent(message: Pick<Message, 'kind'>): boolean {
  return typeof message.kind === 'string' && mirrorKinds.has(message.kind);
}

/** Returns only new eligible messages, in ledger order, without changing the input. */
export function selectMirrorEvents(messages: readonly MirrorEvent[], afterId: number): MirrorEvent[] {
  if (!Number.isSafeInteger(afterId) || afterId < 0) throw new Error('afterId must be a nonnegative safe integer');
  return messages
    .filter(message => Number.isSafeInteger(message.id) && message.id > afterId && isMirrorEvent(message))
    .slice()
    .sort((a, b) => a.id - b.id);
}

/** Build a deterministic, non-LLM summary for one closed two-hour interval. */
export function buildMirrorSummary(
  messages: readonly MirrorEvent[],
  windowStart: string,
  windowEnd: string,
): string | null {
  const start = Date.parse(windowStart);
  const end = Date.parse(windowEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error('invalid summary window');
  const events = messages
    .filter(message => isMirrorEvent(message) && Number.isFinite(Date.parse(message.createdAt)))
    .filter(message => {
      const at = Date.parse(message.createdAt);
      return at >= start && at < end;
    })
    .sort((a, b) => a.id - b.id);
  if (events.length === 0) return null;

  const counts = new Map<string, number>();
  for (const event of events) counts.set(event.kind!, (counts.get(event.kind!) ?? 0) + 1);
  const breakdown = MIRROR_EVENT_KINDS
    .filter(kind => counts.has(kind))
    .map(kind => `${kind} ${counts.get(kind)}`)
    .join(' · ');
  const from = new Date(start).toISOString();
  const to = new Date(end).toISOString();
  return `## Seat message summary (${from} – ${to})\n\n${events.length} mirrored events · ${breakdown}\n\n` +
    events.map(event => `- #${event.id} **${event.kind}** · ${event.from} → ${event.to}: ${event.body.trim()}`).join('\n');
}

/** Rotate before GitHub's hard comment wall; callers must persist the new channel pointer. */
export function shouldRotateMirrorChannel(commentCount: number, threshold: number = MIRROR_ROTATE_AT): boolean {
  if (!Number.isSafeInteger(commentCount) || commentCount < 0) throw new Error('commentCount must be a nonnegative safe integer');
  if (!Number.isSafeInteger(threshold) || threshold < 1 || threshold >= 2_500) throw new Error('threshold must be between 1 and 2499');
  return commentCount >= threshold;
}
