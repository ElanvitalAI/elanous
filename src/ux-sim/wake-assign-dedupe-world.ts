// SIM-WAKE-ASSIGN-DEDUPE-1125 — one hour of a TC space with every waker running at once, measured before/after the
// shared wake ledger and the «live steward owns assignment» rule (PR #40096):
//   H1 = duplicate hand wakes / h  — a wake of a seat already woken (any source) inside 20 min.
//   H2 = double / stale assigns / h — an assign landing on a hand that another source assigned or woke inside 20 min.
// World: 15 TC hands, 10 idle on their own cell (worst case: nobody answers), wakers = 행정관 every 10 min (cap 4),
// idle-nudge every 5 min (each hand idle ≥ 10 min), coach every 15 min (2 hands), OP assigns 6/h (1 of them P0).
// The «after» run goes through the real ledger (claimSeatWake on a temp db) and the real seatAssign refusal.
//
// 세 얼굴: 관측 = H1 · H2 counts per run · 판단 근거 = real ledger ⊕ real seatAssign · 수복과 인계 = a regression
//          (after ≥ before, or after H1/H2 above the literal) fails the device test.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimSeatWake } from '../seat/wake-ledger.js';
import { seatAssign, type SeatAssignDeps } from '../seat/seat-assign.js';

export interface DedupeOutcome { readonly h1: number; readonly h2: number; readonly wakes: number; readonly assigns: number; readonly refused: number }

const HANDS = Array.from({ length: 15 }, (_, i) => `TC-H-${i + 1}`);
const IDLE_OWNERS = HANDS.slice(0, 10);
const WINDOW = 20 * 60_000;
const T0 = Date.parse('2026-11-25T07:00:00.000Z');

/** Deterministic event list for one hour: [atMs, source, seat, kind, p0]. */
function events(): Array<{ at: number; by: string; seat: string; kind: 'wake' | 'assign'; p0?: boolean }> {
  const out: Array<{ at: number; by: string; seat: string; kind: 'wake' | 'assign'; p0?: boolean }> = [];
  for (let m = 0; m < 60; m += 10) IDLE_OWNERS.slice((m / 10 * 4) % 10, (m / 10 * 4) % 10 + 4).forEach((seat) => out.push({ at: T0 + m * 60_000, by: 'steward:TC', seat, kind: 'wake' }));
  for (let m = 2; m < 60; m += 5) out.push({ at: T0 + m * 60_000, by: 'idle-nudge', seat: IDLE_OWNERS[(m * 3) % 10]!, kind: 'wake' });
  for (let m = 7; m < 60; m += 15) [0, 1].forEach((k) => out.push({ at: T0 + m * 60_000 + k, by: 'coach', seat: IDLE_OWNERS[(m + k * 5) % 10]!, kind: 'wake' }));
  [4, 13, 22, 31, 44, 53].forEach((m, i) => out.push({ at: T0 + m * 60_000, by: 'OP', seat: IDLE_OWNERS[(m * 7) % 10]!, kind: 'assign', p0: i === 2 }));
  return out.sort((a, b) => a.at - b.at || a.by.localeCompare(b.by));
}

function deps(dbPath: string | null, liveSteward: boolean, at: number): SeatAssignDeps {
  return {
    now: () => new Date(at),
    coordinators: () => ({ hq: 'OP', spaces: ['TC'] }),
    federationSeats: () => new Set(['OP', 'TC', ...HANDS]),
    findCell: (id) => ({ version: '0.3.36', item: { id, title: id, status: 'yellow', updatedAt: new Date(T0).toISOString(), updatedBy: 'OP' } }),
    writers: () => [],
    assign: () => ({ from: null, outcome: 'assigned' }),
    post: () => ({ id: 1 }),
    wake: async () => ({ result: 'injected' }),
    pool: () => ({ hosts: [], scope: 'sim', source: 'code-default' }),
    ...(liveSteward ? { liveStewardScope: () => 'TC' } : {}),
    ...(dbPath ? { claimWake: (seat: string, cell: string, by: string) => claimSeatWake(dbPath, { seat, cell, by, atMs: at }) } : {}),
  };
}

/** `after` = shared ledger ⊕ live-steward assignment rule. */
export async function runDedupeWorld(after: boolean): Promise<DedupeOutcome> {
  const dir = mkdtempSync(join(tmpdir(), 'sim-wake-dedupe-'));
  const db = join(dir, 'wake.sqlite');
  const lastTouch = new Map<string, { at: number; by: string }>();
  let h1 = 0; let h2 = 0; let wakes = 0; let assigns = 0; let refused = 0;
  try {
    for (const e of events()) {
      const prior = lastTouch.get(e.seat);
      const recent = prior !== undefined && e.at - prior.at < WINDOW;
      if (e.kind === 'wake') {
        if (after && !claimSeatWake(db, { seat: e.seat, by: e.by, atMs: e.at }).ok) continue;
        wakes++;
        if (recent) h1++;
        lastTouch.set(e.seat, { at: e.at, by: e.by });
      } else {
        const result = await seatAssign({ seat: e.seat, cellId: `CELL-${e.seat}`, actor: e.by, ...(e.p0 ? { p0: true } : {}) }, deps(after ? db : null, after, e.at));
        if (!result.ok) { refused++; continue; }
        assigns++;
        if (recent && prior!.by !== e.by) h2++;
        if (!result.wake.startsWith('skipped')) { if (recent) h1++; wakes++; lastTouch.set(e.seat, { at: e.at, by: e.by }); }
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  return { h1, h2, wakes, assigns, refused };
}
