/**
 * CAPSULE-B1-DONE-EVENT (내부 문서 `TURN-CAPSULE-EVENTS` §3.3 ③-1) — a capsule's completion leaves the chat
 * child as a frame, not only as a queued `<task-notification>` for «the next turn».
 *
 * Wire: one stderr line per event, `ELANOUS_TUI_CAPSULE\t{json}` (the child's stderr is read for the whole session,
 * also while the TUI is idle — that is what makes a completion able to knock). The child always writes it
 * (no switch since CAPSULE-FLAGS-REMOVE-DEFAULT); the TUI parser accepts it always.
 *
 * The frame never carries raw tool output: `summary` is label · status · duration. The child's own
 * `<task-notification>` drain still brings the result into the turn the event opens.
 */
import {
  CAPSULE_KINDS,
  type CapsuleDoneEvent, type CapsuleEvent, type CapsuleKind, type CapsuleStatus, type TurnEvent,
} from './contract.js';

export const CAPSULE_FRAME_PREFIX = 'ELANOUS_TUI_CAPSULE\t';

/** Longest `summary` / progress `line` a frame may carry. 출처: 접힌 한 줄(§3.3 ④) — a status row, not a transcript. */
export const CAPSULE_FRAME_TEXT_CAP = 160;

const STATUSES: readonly CapsuleStatus[] = ['ok', 'failed', 'timeout', 'cancelled'];

function oneLine(text: string): string {
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > CAPSULE_FRAME_TEXT_CAP ? `${flat.slice(0, CAPSULE_FRAME_TEXT_CAP - 1)}…` : flat;
}

/** The subset of an agent task the completion frame reads (kept narrow so tests need no registry). */
export interface CapsuleTaskLike {
  readonly id: string;
  readonly label?: string;
  readonly definition: { readonly name: string };
  readonly state: string;
  readonly startedAt?: number;
  readonly finishedAt?: number;
}

const TASK_STATUS: Readonly<Record<string, CapsuleStatus>> = { done: 'ok', error: 'failed', aborted: 'cancelled' };

/** A finished background Agent task → `capsule-done`. Null while the task is not terminal. */
export function capsuleDoneFromAgentTask(task: CapsuleTaskLike, sessionId: string, now = Date.now()): CapsuleDoneEvent | null {
  const status = TASK_STATUS[task.state];
  if (!status) return null;
  const endedAt = task.finishedAt ?? now;
  const startedAt = Math.min(task.startedAt ?? endedAt, endedAt);
  const seconds = Math.round((endedAt - startedAt) / 1000);
  return {
    type: 'capsule-done', capsuleId: task.id, kind: 'agent', sessionId, startedAt, endedAt, status,
    summary: oneLine(`${task.label ?? task.definition.name} · ${status} · ${seconds}s`),
  };
}

export function encodeCapsuleFrame(event: CapsuleEvent): string {
  const safe = event.type === 'capsule-done'
    ? { ...event, summary: oneLine(event.summary) }
    : { ...event, line: oneLine(event.line) };
  return `${CAPSULE_FRAME_PREFIX}${JSON.stringify(safe)}\n`;
}

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isKind = (value: unknown): value is CapsuleKind => (CAPSULE_KINDS as readonly unknown[]).includes(value);

/** Strict reader for the JSON after the prefix: anything malformed, or of another session, is null. */
export function parseCapsuleFrame(json: string, sessionId: string): CapsuleEvent | null {
  let value: unknown;
  try { value = JSON.parse(json); } catch { return null; }
  if (!value || typeof value !== 'object') return null;
  const frame = value as Record<string, unknown>;
  if (frame.sessionId !== sessionId || !isText(frame.capsuleId) || !isKind(frame.kind)) return null;
  if (frame.type === 'capsule-progress') {
    if (!isTime(frame.at) || typeof frame.line !== 'string') return null;
    return { type: 'capsule-progress', capsuleId: frame.capsuleId, kind: frame.kind, sessionId, at: frame.at, line: oneLine(frame.line) };
  }
  if (frame.type !== 'capsule-done' || !isTime(frame.startedAt) || !isTime(frame.endedAt) || frame.endedAt < frame.startedAt
    || !(STATUSES as readonly unknown[]).includes(frame.status) || typeof frame.summary !== 'string') return null;
  return {
    type: 'capsule-done', capsuleId: frame.capsuleId, kind: frame.kind, sessionId,
    ...(isText(frame.seat) ? { seat: frame.seat } : {}),
    startedAt: frame.startedAt, endedAt: frame.endedAt, status: frame.status as CapsuleStatus, summary: oneLine(frame.summary),
  };
}

/** `capsule-done` → the bus event (lane C adapter input). Same capsule = same dedupeKey, so a replay is a duplicate. */
export function capsuleDoneTurnEvent(event: CapsuleDoneEvent, arrivedAt = Date.now()): TurnEvent {
  return {
    id: `capsule-done:${event.capsuleId}`,
    source: 'capsule-done',
    dedupeKey: `capsule:${event.capsuleId}`,
    arrivedAt,
    text: `[capsule ${event.kind} ${event.capsuleId} ${event.status}] ${event.summary}`,
    capsule: event,
  };
}
