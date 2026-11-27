// KIT mail-route · ✋ by reference (HAND-RAISE-DOMAIN-ROUTING) — the post layer (MsgStore.post · `hand-ask:` ref) folds
// the same ✋ ask from the same seat inside the dedupe window into its first row. This module is what the asking seat is
// told instead: the first row's answer (the receiver's reply to the seat), or «still open at <rung>».
//
// 세 얼굴: 관측 = debug `msg.hand-ask.by-reference` (store) ⊕ the reference line the sender reads · 판단 근거 = the first
// row's thread (reply_to) — structured, never body text · 수복과 인계 = an unanswered first row keeps climbing on the hand
// ladder (10-min sweep) exactly as before; the repeat adds nothing to it.
import type { Message, MsgStore } from '../../msg/msg-store.js';

export interface HandAskReference {
  readonly firstId: number;
  readonly to: string;
  /** The reply that answers the first ✋ (null = still open). */
  readonly answer: Message | null;
  readonly line: string;
}

const oneLine = (s: string, n: number): string => { const t = s.replace(/\s+/gu, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** The answer to ✋ #firstId for `seat`: the first reply in its thread written by someone else. Never throws. */
export function handAskAnswer(store: Pick<MsgStore, 'listReplies'>, firstId: number, seat: string): Message | null {
  try {
    const me = seat.trim().toUpperCase();
    return store.listReplies(firstId).find((r) => r.from.trim().toUpperCase() !== me) ?? null;
  } catch { return null; }
}

/** The line a repeated ✋ gets instead of a new row. Pure over the store read. */
export function handAskReference(store: Pick<MsgStore, 'listReplies'>, first: Pick<Message, 'id' | 'to' | 'from'>): HandAskReference {
  const answer = handAskAnswer(store, first.id, first.from);
  const line = answer
    ? `✋ answered by reference: same ask as #${first.id} — ${answer.from} answered #${answer.id}: ${oneLine(answer.body, 240)}`
    : `✋ by reference: same ask as #${first.id} is still open at ${first.to} — its answer resumes you; nothing new was sent`;
  return { firstId: first.id, to: first.to, answer, line };
}
