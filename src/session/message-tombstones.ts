// TUI-ANSWER-VANISH ⑤ (대표 11-24 «when chat is removed it must be observable · which utterance disappeared») —
// a chat row (a person's line or a shown answer) that a history rewrite drops leaves a tombstone beside the session
// ({msgId, removedAt, cause}) and one `tui.transcript message-removed` log line with a redacted one-line preview.
// The sidecar is never replayed to a model; `elanous session show` prints «[removed HH:MM · cause]» in place.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { redactSecretText } from '../debug/secret-redaction.js';
import type { SerializedMessage } from './index.js';

export interface MessageTombstone {
  readonly msgId: string;
  readonly role: 'user' | 'assistant';
  readonly createdAt: string;
  readonly removedAt: string;
  readonly cause: string;
  readonly chars: number;
  readonly preview: string;
}

/** Individually logged removals per rewrite; the rest are counted in one summary line (tombstones keep all). */
const LOGGED_PER_REWRITE = 20;
const PREVIEW_CHARS = 120;

export function tombstoneFile(id: string, root: string): string { return join(root, `${id}.tombstones.jsonl`); }

function rowKey(message: Pick<SerializedMessage, 'turn_id' | 'role' | 'ts'>): string {
  return message.turn_id !== undefined ? String(message.turn_id) : `${message.role}@${message.ts}`;
}

/** A row the person reads in the chat: their own line, or an answer the chat showed (final or a failure card). */
function isChatRow(message: SerializedMessage): message is SerializedMessage & { role: 'user' | 'assistant' } {
  if (message.role === 'user') return message.interruptionMarker !== true && message.content.length > 0;
  return message.role === 'assistant' && message.goalInterim !== true && (message.replyFinal === true || message.replyFailure === true);
}

function preview(content: string): string {
  const line = redactSecretText(content).replace(/\s+/g, ' ').trim();
  return line.length > PREVIEW_CHARS ? `${line.slice(0, PREVIEW_CHARS - 1)}…` : line;
}

/** Chat rows of `before` that `after` no longer holds (matched by turn_id, or by role+ts when a rewrite re-minted). */
export function removedChatRows(before: readonly SerializedMessage[], after: readonly SerializedMessage[]): SerializedMessage[] {
  const kept = new Set<string>();
  for (const row of after) { kept.add(rowKey(row)); kept.add(`${row.role}@${row.ts}`); }
  return before.filter((row) => isChatRow(row) && !kept.has(rowKey(row)) && !kept.has(`${row.role}@${row.ts}`));
}

/** Record every chat row a rewrite of session `id` removed. Fail-open: a tombstone never blocks the rewrite. */
export function recordRemovedMessages(id: string, before: readonly SerializedMessage[], after: readonly SerializedMessage[],
  cause: string, root: string, now: () => Date = () => new Date()): MessageTombstone[] {
  let removed: SerializedMessage[];
  try { removed = removedChatRows(before, after); } catch { return []; }
  if (removed.length === 0) return [];
  const removedAt = now().toISOString();
  const stones: MessageTombstone[] = removed.map((row) => ({
    msgId: rowKey(row), role: row.role as 'user' | 'assistant', createdAt: row.ts, removedAt, cause,
    chars: row.content.length, preview: preview(row.content),
  }));
  try { appendFileSync(tombstoneFile(id, root), stones.map((stone) => JSON.stringify(stone)).join('\n') + '\n', 'utf-8'); }
  catch { /* observability is fail-open */ }
  try {
    for (const stone of stones.slice(0, LOGGED_PER_REWRITE)) {
      debug.log('tui.transcript', 'message-removed', { sessionId: id, ...stone }, { level: 'info' });
    }
    if (stones.length > LOGGED_PER_REWRITE) {
      debug.log('tui.transcript', 'message-removed', { sessionId: id, cause, more: stones.length - LOGGED_PER_REWRITE, removedAt }, { level: 'info' });
    }
  } catch { /* observability is fail-open */ }
  return stones;
}

export function loadTombstones(id: string, root: string): MessageTombstone[] {
  const file = tombstoneFile(id, root);
  if (!existsSync(file)) return [];
  const out: MessageTombstone[] = [];
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as MessageTombstone); } catch { /* skip a torn line */ }
  }
  return out;
}

/** Saved rows and tombstones in creation order: each tombstone sits where its row was (before the first row created
 *  after it). */
export function interleaveTombstones<T extends { ts: string }>(messages: readonly T[], stones: readonly MessageTombstone[]):
  Array<{ kind: 'message'; message: T } | { kind: 'removed'; stone: MessageTombstone }> {
  const pending = [...stones].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const out: Array<{ kind: 'message'; message: T } | { kind: 'removed'; stone: MessageTombstone }> = [];
  let next = 0;
  for (const message of messages) {
    while (next < pending.length && pending[next]!.createdAt < message.ts) out.push({ kind: 'removed', stone: pending[next++]! });
    out.push({ kind: 'message', message });
  }
  while (next < pending.length) out.push({ kind: 'removed', stone: pending[next++]! });
  return out;
}

/** «[removed 11:44 · compaction] user · 921 chars · <preview>» — one line for `elanous session show`. */
export function formatTombstoneLine(stone: MessageTombstone): string {
  const at = new Date(stone.removedAt);
  const hhmm = Number.isNaN(at.getTime()) ? stone.removedAt
    : `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  return `[removed ${hhmm} · ${stone.cause}] ${stone.role} · ${stone.chars} chars · ${stone.preview}`;
}
