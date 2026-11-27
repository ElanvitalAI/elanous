// SIM — ADMIN-RESOLVE-NOT-NAG (0.3.38 P0). Replays the 11-27 07:43 shapes: 행정관 mailed «idle 16m — 보드에 일감이
// 있습니다 · eln work next» to free hands and «idle hands holding their own open cell: TC 8» / «ready < 2× idle hands» to OP,
// and nothing moved. Seeds vary free hands · holders · board cells · judge hands. Expect: every free maker hand that a
// board cell fits gets an `assign` row (no nudge); a free hand is nudged only when no cell fits; each holder is woken on
// its own cell; no row is addressed to OP; no cell twice; maker ≠ judge. Expectations are literals or counted from the
// fixture (rule 11), never from the product's constants.
import { describe, expect, test } from 'bun:test';
import { resolveScope } from './config.js';
import { emptyScopeState, planMatch, type Snapshot } from './model.js';
import { assignFollowingCell } from './tick.js';

const NOW = Date.parse('2026-11-27T07:43:00.000Z');
const ago = (min: number): string => new Date(NOW - min * 60_000).toISOString();
function rng(seed: number): () => number { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }

function world(seed: number) {
  const r = rng(seed);
  const free = 1 + Math.floor(r() * 4); // 1–4 free TC hands (idle 16m+)
  const holders = Math.floor(r() * 9); // 0–8 TC hands idle on their own cell
  const boardN = Math.floor(r() * 6); // 0–5 unowned / leader-held yellow cells
  const parent: Record<string, string> = { TC: 'OP', JUD: 'OP', 'JUD-B': 'JUD' };
  const seats: Snapshot['seats'][number][] = [{ seat: 'TC', activity: 'working', idleForMs: null }, { seat: 'JUD-B', activity: 'idle', idleForMs: 40 * 60_000 }];
  const cells: Snapshot['cells'][number][] = [];
  for (let i = 0; i < free; i++) { parent[`TC-F${i}`] = 'TC'; seats.push({ seat: `TC-F${i}`, activity: 'idle', idleForMs: (16 + i) * 60_000 }); }
  for (let i = 0; i < holders; i++) {
    parent[`TC-H${i}`] = 'TC'; seats.push({ seat: `TC-H${i}`, activity: 'idle', idleForMs: (20 + i) * 60_000 });
    cells.push({ id: `OWN-${i}`, title: `own ${i}`, status: 'yellow', owner: `TC-H${i}`, priority: 'P1', updatedAt: ago(30) });
  }
  for (let i = 0; i < boardN; i++) cells.push({ id: `BRD-${i}`, title: `board ${i}`, status: 'yellow', ...(i % 2 ? { owner: 'TC' } : {}), priority: i === 0 ? 'P1' : 'P2', updatedAt: ago(60 + i) });
  const snap: Snapshot = { nowMs: NOW, hq: 'OP', coordinators: ['JUD', 'TC'], parent, seats, version: '0.3.38', cells, prs: [], merged: [], receipts: [], verdicts: [],
    hosts: [], utilAgeMs: 60_000, openHands: [], sourceErrors: [] };
  return { snap, free, holders, boardN };
}

describe('SIM 07:43 행정관 — act, do not nag (seeds 1, 7, 42, 1127)', () => {
  for (const seed of [1, 7, 42, 1127]) {
    test(`seed ${seed}`, () => {
      const w = world(seed);
      const scope = resolveScope('TC', 'OP', { scopes: { TC: { mode: 'live', caps: { assign: 20 } } } });
      const plan = planMatch(w.snap, { scope, state: emptyScopeState() });
      const assigns = plan.rows.filter((r) => r.action === 'assign');
      const nudges = plan.rows.filter((r) => r.action === 'wake' && r.target === r.seat);
      const wakes = plan.rows.filter((r) => r.action === 'wake' && r.target !== r.seat);
      // Free hands: a board cell each while cells last; only the rest keep a nudge.
      expect(assigns).toHaveLength(Math.min(w.free, w.boardN));
      expect(nudges).toHaveLength(w.boardN === 0 ? 0 : Math.max(0, w.free - w.boardN));
      expect(assigns.every((r) => r.reason.startsWith('pull-for-idle:idle-no-pull:') && r.seat!.startsWith('TC-F') && r.target.startsWith('BRD-'))).toBe(true);
      expect(new Set(assigns.map((r) => r.target)).size).toBe(assigns.length);
      if (assigns.length) expect(assigns[0]!.target).toBe('BRD-0'); // P1 before P2
      // Holders: woken on their own cell (the existing wake path), never handed a board cell.
      expect(wakes.map((r) => `${r.seat}:${r.target}`).sort()).toEqual(Array.from({ length: w.holders }, (_, i) => `TC-H${i}:OWN-${i}`).sort());
      // Nothing to OP, no judge hand on a maker cell.
      expect(plan.rows.some((r) => r.seat === 'OP' || r.target === 'OP')).toBe(false);
      expect(plan.rows.some((r) => r.seat === 'JUD-B')).toBe(false);
    });
  }
});

test('assignFollowingCell: unknown-cell in the snapshot release → follow once into the default release', () => {
  const calls: Array<string | undefined> = [];
  const moved = assignFollowingCell('0.3.38', (v) => { calls.push(v); return v ? { ok: false, code: 'unknown-cell' } : { ok: true }; });
  expect(moved).toEqual({ parsed: { ok: true }, followed: true });
  expect(calls).toEqual(['0.3.38', undefined]);
  const gone = assignFollowingCell('0.3.38', () => ({ ok: false, code: 'unknown-cell' }));
  expect(gone).toEqual({ parsed: { ok: false, code: 'unknown-cell' }, followed: false });
  const other: Array<string | undefined> = [];
  expect(assignFollowingCell('0.3.38', (v) => { other.push(v); return { ok: false, code: 'live-writer' }; }).followed).toBe(false);
  expect(other).toEqual(['0.3.38']);
});
