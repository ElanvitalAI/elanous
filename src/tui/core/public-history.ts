import { TURN_INTERRUPTED_MARKER } from '../../chat/interjection.js';
import type { SerializedMessage } from '../../session/index.js';
import { projectKnownAuthFailure, streamReplyFailure, streamReplyFinal } from './next-public-reply.js';

/** Preserve saved indexes for log anchors while showing only the final public answer in the basic chat view. */
export function nextTuiPublicHistory(messages: readonly SerializedMessage[], omitLastTurnAnswer = false): SerializedMessage[] {
  const visible = messages.map((message) => message.role === 'tool' || message.role === 'assistant'
    ? { role: 'system' as const, content: '', ts: message.ts }
    : message);
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
      ? (projectKnownAuthFailure(message.replyFailureKind) ?? streamReplyFailure(turnId))
      : streamReplyFinal(turnId, message.content);
    const publicAnswer = message.replyFinal === undefined && legacyLastAnswer
      ? `이전 버전 기록 · 완료 여부 확인 안 됨\n\n${answer}` : answer;
    if (answer) visible[candidate] = { role: 'assistant', content: publicAnswer, ts: message.ts };
    candidate = -1;
  };
  for (const [index, message] of messages.entries()) {
    if (message.role === 'user') {
      // Legacy runTurn stored a partial assistant before this interruption marker.
      if (message.content.startsWith(TURN_INTERRUPTED_MARKER) || message.content === '[Request interrupted by user]') candidate = -1;
      else commit();
      turn++;
    }
    else if (message.role === 'assistant') candidate = message.replyFailure === true || (message.replyFinal !== false && !message.goalInterim) ? index : -1;
    else if (message.role === 'tool') candidate = -1;
  }
  if (!omitLastTurnAnswer) commit(true);
  return visible;
}
