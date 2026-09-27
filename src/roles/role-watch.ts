import type { RoleObjectRead } from '../cli/role-cli.js';
import { validSeatRank } from './machine-profile.js';
import { nextAccept, nextClaim, parseRoleLease, type RoleLeaseDoc } from './role-lease.js';

export interface WatchState {
  readonly generation?: number;
  readonly objectGen?: string;
  readonly unchangedTicks: number;
  readonly absentTicks?: number;
}

export const initialWatchState: WatchState = { unchangedTicks: 0, absentTicks: 0 };

// One missed observation can precede a healthy holder's next 60-second renewal.
export const MIN_TAKEOVER_TICKS = 2;

export interface WatchConfig {
  readonly me: string;
  readonly rank?: number;
  readonly takeoverTicks: number;
  readonly now: number;
}

type TickDecision = {
  readonly state: WatchState;
  readonly action: 'claim' | 'renew' | 'takeover' | 'accept' | 'observe';
  readonly holder?: string;
  readonly generation?: number;
  readonly doc?: RoleLeaseDoc;
  readonly ifGen?: string;
};

function nextGeneration(generation: number): number {
  if (!Number.isSafeInteger(generation + 1)) throw new Error('lease generation exhausted');
  return generation + 1;
}

/** Only successful server-generation CAS writes establish ownership; timestamps never decide expiry. */
export function decideTick(state: WatchState, read: RoleObjectRead, cfg: WatchConfig): TickDecision {
  if (!Number.isSafeInteger(cfg.takeoverTicks) || cfg.takeoverTicks < MIN_TAKEOVER_TICKS) {
    throw new Error(`takeover-ticks must be at least ${MIN_TAKEOVER_TICKS} (one missed renewal can precede a live holder)`);
  }
  if (cfg.rank !== undefined && !validSeatRank(cfg.rank)) throw new Error('rank must be an integer from 1 to 99');
  if (read.kind === 'unmeasured') throw new Error(`lease unreadable: ${read.why}`);
  if (read.kind === 'absent') {
    const absentTicks = (state.absentTicks ?? 0) + 1;
    const next: WatchState = { unchangedTicks: 0, absentTicks };
    return cfg.rank !== undefined && absentTicks >= (cfg.rank - 1) * cfg.takeoverTicks
      ? { state: next, action: 'claim', doc: nextClaim({ kind: 'absent' }, cfg.me, cfg.now), ifGen: '0', holder: cfg.me, generation: 1 }
      : { state: next, action: 'observe' };
  }
  const parsed = parseRoleLease(read.text);
  if (parsed.kind !== 'present') throw new Error(`lease unreadable: ${parsed.kind === 'unmeasured' ? parsed.why : 'lease absent'}`);
  const doc = parsed.doc;
  const changed = state.generation !== doc.generation || state.objectGen !== read.gen;
  const unchangedTicks = changed ? 0 : state.unchangedTicks + 1;
  const next: WatchState = { generation: doc.generation, objectGen: read.gen, unchangedTicks, absentTicks: 0 };
  const base = { state: next, holder: doc.holder, generation: doc.generation };
  if (doc.holder === cfg.me) {
    if (doc.state === 'handing-off') return { ...base, action: 'accept', doc: nextAccept(doc, cfg.me, cfg.now), ifGen: read.gen };
    return { ...base, action: 'renew', doc: nextClaim({ kind: 'present', doc }, cfg.me, cfg.now), ifGen: read.gen };
  }
  if (doc.state === 'held' && cfg.rank !== undefined && unchangedTicks >= cfg.takeoverTicks * cfg.rank) {
    return { ...base, action: 'takeover', doc: {
      holder: cfg.me, generation: nextGeneration(doc.generation), state: 'held', renewedAt: cfg.now,
    }, ifGen: read.gen };
  }
  return { ...base, action: 'observe' };
}
