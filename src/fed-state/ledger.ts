// fed-state — one federation state ledger (SIGNAL-STATE-NOT-MAIL · 대표 11-25 20:4x).
//
// S: the same facts (lands, cell states, hand idle/busy, mail flow, steward wakes) lived in mail, cards,
//    the board, logs and ad-hoc scripts — every count disagreed.
// C: «OP inbound/h» and «% OP turns opened by mail» could not even be measured.
// A: append-only typed facts under the resolver state root (`<stateRoot>/fed-state/facts.jsonl`);
//    every writer is fail-open (a ledger fault never breaks mail, checklist or work), one reader (kpi.ts).
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';

export const FACT_TYPES = ['land', 'green', 'cell', 'hand', 'judge', 'slot', 'mail', 'turn', 'beat', 'phase', 'steward', 'work'] as const;
export type FactType = typeof FACT_TYPES[number];

export interface Fact {
  ts: string;            // ISO
  type: FactType;
  seat?: string;
  cell?: string;
  /** land: pr · cell: claim|block|release|green · hand: idle|busy · mail: post|ack · turn: mail|other ·
   *  steward: wake|reclaim · work: claimed|empty|block · slot: pregate|land · judge: enqueue|verdict · phase: burst|rhythm */
  state?: string;
  from?: string;
  to?: string;
  kind?: string;
  /** hand idle: is READY work waiting for this hand? */
  workReady?: boolean;
  ref?: string;
  source?: string;       // writer id (msg-store · checklist · work-next · steward · cli · backfill:<src>)
}

export function fedStatePath(root: string = elanousStateRoot()): string { return join(root, 'fed-state', 'facts.jsonl'); }

export function isFactType(t: string): t is FactType { return (FACT_TYPES as readonly string[]).includes(t); }

/** Append one fact. Fail-open: returns false (never throws) on any fault. */
export function recordFact(fact: Omit<Fact, 'ts'> & { ts?: string }, path?: string): boolean {
  try {
    if (process.env.ELANOUS_FED_STATE_OFF === '1') return false;
    // unit tests never touch the real ledger unless they pass an explicit path.
    if (!path && process.env.NODE_ENV === 'test' && !process.env.ELANOUS_FED_STATE_IN_TEST) return false;
    const p = path ?? fedStatePath();
    mkdirSync(dirname(p), { recursive: true });
    const row: Fact = { ...fact, ts: fact.ts ?? new Date().toISOString() } as Fact;
    appendFileSync(p, JSON.stringify(row) + '\n');
    return true;
  } catch { return false; }
}

/** Read facts with ts in [since, until). Malformed lines are skipped (counted in `skipped`). */
export function readFacts(opts: { since?: Date; until?: Date; path?: string } = {}): { facts: Fact[]; skipped: number } {
  const p = opts.path ?? fedStatePath();
  if (!existsSync(p)) return { facts: [], skipped: 0 };
  const facts: Fact[] = []; let skipped = 0;
  const lo = opts.since?.getTime() ?? -Infinity; const hi = opts.until?.getTime() ?? Infinity;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const f = JSON.parse(line) as Fact; const t = Date.parse(f.ts);
      if (!Number.isFinite(t) || !isFactType(String(f.type))) { skipped++; continue; }
      if (t >= lo && t < hi) facts.push(f);
    } catch { skipped++; }
  }
  return { facts, skipped };
}
