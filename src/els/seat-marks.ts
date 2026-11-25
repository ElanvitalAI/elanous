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
  /** Who said so: `reported` = the pane's own eln, `derived` = the server's facts (an unreachable folder). */
  readonly seatSource?: 'reported' | 'derived';
  /** Unread mail count of the seat's inbox (0 or absent = none). */
  readonly unread?: number;
}

/**
 * A person must act: an approval prompt, or a block. A BLOCKED the seat's eln reported is always its stop «a person is needed ·
 * any key resumes» — whatever the code (DEPENDENCY_WAIT included: the seat does not wake by itself) — so it reads ✋
 * (11-25 05:55: TC-H-CC-2 said NEED HUMAN and mailed its coordinator while its row read ⚪⏳). Only the server's own
 * dependency wait (an unreachable folder, `derived`) is a wait, not a person.
 */
export function needsPerson(seatState: SeatState | undefined, seatReason: BlockReason | undefined, seatSource?: 'reported' | 'derived'): boolean {
  if (seatState === 'WAITING_APPROVAL') return true;
  return seatState === 'BLOCKED' && (seatReason !== 'DEPENDENCY_WAIT' || seatSource === 'reported');
}

/** Waiting on a reply or a timer/dependency — not a person. */
export function isWaiting(seatState: SeatState | undefined, seatReason: BlockReason | undefined, seatSource?: 'reported' | 'derived'): boolean {
  return seatState === 'WAITING_REPLY' || (seatState === 'BLOCKED' && seatReason === 'DEPENDENCY_WAIT' && seatSource !== 'reported');
}

const ACTIVITY: Readonly<Record<string, string>> = { working: '🟢', idle: '⚪', failed: '🔴', stalled: '🟤', blocked: '🟡', done: '✅', unknown: '?' };

export function seatMarks(input: SeatMarkInput): { readonly activity: string; readonly attention: string; readonly needsPerson: boolean } {
  const person = needsPerson(input.seatState, input.seatReason, input.seatSource);
  const unread = input.unread !== undefined && input.unread > 0 ? Math.floor(input.unread) : 0;
  const attention = person ? '✋' : unread > 0 ? `✉${unread}` : isWaiting(input.seatState, input.seatReason, input.seatSource) ? '⏳' : '';
  const activity = input.seatState === 'STALLED' ? ACTIVITY.stalled! : ACTIVITY[input.word] ?? '⚪';
  return { activity, attention, needsPerson: person };
}
