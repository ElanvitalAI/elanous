// TUI-ANSWER-VANISH-ON-TOOLCALL (stale steer marker) — «조향 대기 n건 · 다음 도구 경계에 넣음» is written once when a
// line is sent as a steer and was only rewritten by a later status event. When the steer left the queue some other
// way (joined while the listener was not attached, carried to the next turn, recalled, cancelled) the footer kept
// claiming «1 steer pending · joins at next tool boundary» for as long as nothing else wrote the status (observed
// ~15 min on the OP seat, 11-24). The claim is about the queue, so it is derived from the queue at render time.

const PENDING_HEAD = /^조향 대기 (\d+)건(?= · 다음 도구 경계에 넣음)/u;

export interface LiveSteerStatus {
  readonly text: string;
  /** The stored status claimed a steer count the queue no longer has. */
  readonly stale: boolean;
}

/** Keep the pending-steer head only while steers really wait; its count always follows the queue. */
export function liveSteerStatus(status: string, steerCount: number, busy: boolean): LiveSteerStatus {
  const head = PENDING_HEAD.exec(status);
  if (!head) return { text: status, stale: false };
  const count = Math.max(0, Math.floor(steerCount));
  if (count === 0) return { text: busy ? '응답 중 · Esc 취소' : 'Enter 전송', stale: true };
  if (Number(head[1]) === count) return { text: status, stale: false };
  return { text: status.replace(PENDING_HEAD, `조향 대기 ${count}건`), stale: true };
}

/** The part of a waiting queue row the echo needs (a queue snapshot satisfies it). */
export interface SteerQueueRow { readonly kind: string; readonly text: string; readonly steerId?: string }
/** The saved person row a joined steer becomes (session `appendMessage` shape). */
export interface JoinedSteerRow {
  readonly role: 'user'; readonly content: string; readonly ts: string;
  readonly from: { readonly kind: 'human' }; readonly steerJoined: true;
}

/** TUI-ANSWER-VANISH-ON-TOOLCALL ③ — the person's lines among `steerIds` (read BEFORE the queue marks them
 *  delivered) become saved user rows at the join point: below the tool results, above the next answer. Seat-mail
 *  notices are not the person's words and are not echoed. */
export function joinedSteerRows(waiting: readonly SteerQueueRow[], steerIds: readonly string[], now: () => string): JoinedSteerRow[] {
  const joined = new Set(steerIds);
  return waiting
    .filter((row) => row.kind === 'user' && row.steerId !== undefined && joined.has(row.steerId))
    .map((row) => ({ role: 'user', content: row.text, ts: now(), from: { kind: 'human' }, steerJoined: true }));
}
