// SIDETAB-TWO-MARKS (대표 11-24 14:0x): every seat row carries TWO marks — slot 1 = activity, slot 2 = attention.
//   slot 1: 🟢 working · ⚪ idle · 🔴 failed/exited-bad · 🟤 stalled
//   slot 2: ✋ a person is needed · ✉N unread mail · ⏳ waiting on a reply/timer · blank
// A seat blocked on a person is «⚪✋» (idle, but waiting for a human) and sorts first in its group. Codes only: the marks come
// from the seat state the pane's eln published (SEAT-STATE-ENUM) and the mail badge — never from screen text.
import type { BlockReason, SeatState } from '../agent-events/protocol.js';

export interface SeatMarkInput {
  /** The activity word of the row (working · idle · failed · stalled · …), as the list shows it. */
  readonly word: string;
  readonly seatState?: SeatState;
  readonly seatReason?: BlockReason;
  /** Unread mail count of the seat's inbox (0 or absent = none). */
  readonly unread?: number;
}

/** A person must act: an approval prompt, or a block that is not merely a dependency wait. */
export function needsPerson(seatState: SeatState | undefined, seatReason: BlockReason | undefined): boolean {
  if (seatState === 'WAITING_APPROVAL') return true;
  return seatState === 'BLOCKED' && seatReason !== 'DEPENDENCY_WAIT';
}

/** Waiting on a reply or a timer/dependency — not a person. */
export function isWaiting(seatState: SeatState | undefined, seatReason: BlockReason | undefined): boolean {
  return seatState === 'WAITING_REPLY' || (seatState === 'BLOCKED' && seatReason === 'DEPENDENCY_WAIT');
}

const ACTIVITY: Readonly<Record<string, string>> = { working: '🟢', idle: '⚪', failed: '🔴', stalled: '🟤', blocked: '🟡', done: '✅', unknown: '?' };

export function seatMarks(input: SeatMarkInput): { readonly activity: string; readonly attention: string; readonly needsPerson: boolean } {
  const person = needsPerson(input.seatState, input.seatReason);
  const unread = input.unread !== undefined && input.unread > 0 ? Math.floor(input.unread) : 0;
  const attention = person ? '✋' : unread > 0 ? `✉${unread}` : isWaiting(input.seatState, input.seatReason) ? '⏳' : '';
  const activity = input.seatState === 'STALLED' ? ACTIVITY.stalled! : ACTIVITY[input.word] ?? '⚪';
  return { activity, attention, needsPerson: person };
}
