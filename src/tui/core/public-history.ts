import { queueNoticeBody, stripQueueModelContext } from '../../chat/interjection.js';
import type { SerializedMessage } from '../../session/index.js';
import { projectKnownAuthFailure, savedFailureCause, streamReplyFailure, streamReplyFinal } from './next-public-reply.js';

/** Marker under a person's line that joined a running turn at a tool boundary. */
export const STEER_JOINED_MARK = '(joined mid-turn)';

/** While a turn runs, its own answer is still the live preview. `true` hides the trailing answer outright; `{ since }`
 *  hides it only when it was saved at or after the running turn started (TUI-ANSWER-VANISH-ON-TOOLCALL ④). */
export type OmitLastTurnAnswer = boolean | { readonly since: number };

/** Preserve saved indexes for log anchors while showing only the final public answer in the basic chat view. */
export function nextTuiPublicHistory(messages: readonly SerializedMessage[], omitLastTurnAnswer: OmitLastTurnAnswer = false): SerializedMessage[] {
  const visible = messages.map((message) => message.role === 'tool' || message.role === 'assistant' || (message.role === 'user' && message.interruptionMarker === true)
    ? { role: 'system' as const, content: '', ts: message.ts }
    : message.role === 'user' ? publicUserRow(message) : message);
  let candidate = -1;
  let turn = 0;
  const commit = (legacyLastAnswer = false): void => {
    if (candidate < 0) return;
    const message = messages[candidate]!;
    // A later user turn cannot certify an older unmarked reply: the process may
    // have stopped after persisting partial text. Legacy runTurn wrote its last
    // assistant response on return, so recover that terminal answer on resume.
    if (message.replyFailure !== true && message.replyFinal === undefined && !legacyLastAnswer) { candidate = -1; return; }
    const turnId = String(message.turn_id ?? `history-${turn}`);
    const answer = message.replyFailure === true
      ? (projectKnownAuthFailure(message.replyFailureKind) ?? withSavedCause(streamReplyFailure(turnId), message.content))
      : streamReplyFinal(turnId, message.content);
    const publicAnswer = message.replyFinal === undefined && legacyLastAnswer
      ? `이전 버전 기록 · 완료 여부 확인 안 됨\n\n${answer}` : answer;
    if (answer) visible[candidate] = publicAnswerRow(message, publicAnswer);
    candidate = -1;
  };
  for (const [index, message] of messages.entries()) {
    if (message.role === 'user') {
      // MX13 marker provenance — a generated interruption marker is detected ONLY by its
      // persisted interruptionMarker flag, never by its text. A flagged marker hides the
      // preceding partial reply even when it was flagged final; a human message whose text
      // merely collides with a marker string commits the turn normally, so string
      // coincidences can no longer erase a completed answer or failure card.
      if (message.interruptionMarker === true) candidate = -1;
      else commit();
      turn++;
    }
    else if (message.role === 'assistant') candidate = message.replyFailure === true || (message.replyFinal !== false && !message.goalInterim) ? index : -1;
    else if (message.role === 'tool') candidate = -1;
  }
  // ④ An automatic turn (seat-mail notice, wake-up, capsule done) has no echoed user row yet, so the previous
  // turn's finished answer is the trailing row; hiding it blanked the answer the moment the next turn started.
  const trailing = candidate >= 0 ? messages[candidate] : undefined;
  const ownTurnAnswer = typeof omitLastTurnAnswer === 'object'
    ? !(Date.parse(trailing?.ts ?? '') < omitLastTurnAnswer.since)
    : omitLastTurnAnswer;
  if (!ownTurnAnswer) commit(true);
  return visible;
}

// TUI-LONG-PASTE-SPIN — the public copy of a saved row is made once per row object (and per answer text): the
// transcript's row memo is keyed by row object, so a fresh copy every recompute re-wrapped the whole transcript, and
// the notice/context strip below ran over every saved user row on every recompute (13% of a stalled frame).
const publicUserRows = new WeakMap<SerializedMessage, SerializedMessage>();
function publicUserRow(message: SerializedMessage): SerializedMessage {
  const hit = publicUserRows.get(message);
  if (hit) return hit;
  // A200 · ELN-QUEUE-SUPERSEDE — interrupted-on-purpose and «대체 후보» lines are model context; the bubble shows the person's words.
  const row = message.steerJoined === true
    // TUI-ANSWER-VANISH-ON-TOOLCALL ③ — a steer reads as the person's message, marked where it joined.
    ? { ...message, content: `${stripQueueModelContext(message.content)}\n${STEER_JOINED_MARK}` }
    : stripQueueModelContext(message.content) !== message.content
      ? { ...message, content: publicUserText(message.content) }
      : message;
  publicUserRows.set(message, row);
  return row;
}

const publicAnswerRows = new WeakMap<SerializedMessage, SerializedMessage>();
function publicAnswerRow(message: SerializedMessage, content: string): SerializedMessage {
  const hit = publicAnswerRows.get(message);
  if (hit && hit.content === content) return hit;
  const row: SerializedMessage = { role: 'assistant', content, ts: message.ts,
    ...(message.replyFailure === true ? { replyFailure: true, replyFailureKind: message.replyFailureKind } : {}) };
  publicAnswerRows.set(message, row);
  return row;
}

/** The person-facing text of a saved user row: model-only heads removed. A queue notice row keeps its saved text — the
 *  chat draws it as one folded summary line that opens on click (NOTICE-FOLD-1LINE · chat/notice-fold.ts), which keeps
 *  the TUI-ANSWER-VANISH ⑤ guarantee (a notice turn starting never pushes the previous answer off screen). */
export function publicUserText(content: string): string {
  return queueNoticeBody(content) !== null ? content : stripQueueModelContext(content);
}

/** NEXT-TUI-FEATURE-COMPLETE ② — keep the known cause label the live turn showed. */
function withSavedCause(notice: string, saved: string): string {
  const cause = savedFailureCause(saved);
  return cause ? `${notice} (${cause})` : notice;
}

/** TUI-ANSWER-VANISH-ON-TOOLCALL — how many answers the basic chat can show from these saved rows. A reload that
 *  returns fewer than the screen held means stored answers disappeared under it (observed as `tui.transcript`). */
export function shownAnswerCount(messages: readonly SerializedMessage[]): number {
  let count = 0;
  for (const message of messages) {
    if (message.role === 'assistant' && message.goalInterim !== true && (message.replyFinal === true || message.replyFailure === true)) count++;
  }
  return count;
}
