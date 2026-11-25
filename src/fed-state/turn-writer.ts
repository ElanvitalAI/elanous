// fed-state TUI writers — turn opener and hand busy/idle (feeds «% OP turns by mail» and idle-with-work).
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

/** Seat of this TUI process: ELANOUS_TRACK only (no guess) — a non-seat TUI writes nothing. */
export function fedSeat(env: NodeJS.ProcessEnv = process.env): string | null {
  const s = env.ELANOUS_TRACK?.trim().toUpperCase();
  return s ? s : null;
}

export function recordTurnStart(door: string, source?: string, path?: string): void {
  const seat = fedSeat(); if (!seat) return;
  recordFact({ type: 'turn', seat, state: turnOpenerOf(door, source), ...(source ? { kind: source } : {}), source: 'tui' }, path);
}

export function recordHandActivity(busy: boolean, path?: string): void {
  const seat = fedSeat(); if (!seat) return;
  recordFact({ type: 'hand', seat, state: busy ? 'busy' : 'idle', source: 'tui' }, path);
}
