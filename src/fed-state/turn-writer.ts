// fed-state TUI writers — turn opener and hand busy/idle (feeds «% OP turns by mail» and idle-with-work).
import { callerSeat } from '../kit/mail-route/sender.js';
import { recordFact } from './ledger.js';

export type TurnOpener = 'mail' | 'person' | 'internal' | 'wake';

/** Map the TUI turn-start label (door · source) to one opener. */
export function turnOpenerOf(door: string, source?: string): TurnOpener {
  const s = (source ?? '').toLowerCase();
  if (door === 'human' || door === 'queue-user') return 'person';
  if (s.includes('wake') || s === 'scheduled' || s.includes('timer')) return 'wake';
  if (door === 'queue-notice') return 'mail';
  return 'internal';
}

/** Seat of this TUI process: the caller-identity kit (ELANOUS_TRACK → ELANOUS_SEAT → seats/<SEAT> cwd) — a non-seat TUI
 *  writes nothing. OP-HELPERS-STABILIZE (11-27): ELANOUS_TRACK alone never matched an els seat pane (the els server starts
 *  the OP tab in seats/OP with no ELANOUS_TRACK), so the ledger held 0 turn and 0 hand facts since #40140 and `eln fed kpi`
 *  printed «OP turns opened by mail: n/a (0/0)». The els workspace is not read here: a hand pane in workspace TC is not TC. */
export function fedSeat(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string | null {
  return callerSeat(env, cwd);
}

export function recordTurnStart(door: string, source?: string, path?: string): void {
  const seat = fedSeat(); if (!seat) return;
  recordFact({ type: 'turn', seat, state: turnOpenerOf(door, source), ...(source ? { kind: source } : {}), source: 'tui' }, path);
}

export function recordHandActivity(busy: boolean, path?: string): void {
  const seat = fedSeat(); if (!seat) return;
  recordFact({ type: 'hand', seat, state: busy ? 'busy' : 'idle', source: 'tui' }, path);
}
