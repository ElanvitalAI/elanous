/**
 * SIM — 11-26 22:43 «TC ready 0 / idle 8 — leaders: split cells» (board steward), while the hand pool said TC 14 working /
 * 0 idle and the OP planner saw 24–46 ready cells. Both were right about different things: the 8 idle TC panes each HELD
 * an open cell (assigned, pane idle). Seeds 1–5 vary how many idle hands hold a cell, how many are truly free, and the
 * ready supply. Expect: the board counts holders apart (no false «short» and no «leaders: split cells» line); the OP
 * planner wakes each holder on its own cell (a wake, not an assignment); truly free hands still get the supply card.
 */
import { describe, expect, test } from 'bun:test';
import { boardHealth, breaches, type BoardCellIn, type HandIn } from './model.js';
import { executeNextActions, planNextActions, type NaHand, type NextActionState } from '../../loops/op-next-action.js';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const NOW = Date.parse('2026-11-26T13:43:00.000Z');

function today(seed: number) {
  const r = rng(seed);
  const holding = 5 + Math.floor(r() * 4); // 5–8 idle TC hands holding a cell (8 live)
  const free = Math.floor(r() * 3); // 0–2 truly free idle hands
  const hands: HandIn[] = []; const cells: BoardCellIn[] = []; const pool: NaHand[] = [];
  for (let i = 0; i < holding; i++) {
    hands.push({ seat: `TC-H${i}`, space: 'TC', idle: true });
    cells.push({ id: `TC-C${i}`, title: `cell ${i}`, status: 'yellow', owner: `TC-H${i}`, priority: 'P0', updatedAt: new Date(NOW - 3_600_000).toISOString() } as BoardCellIn);
    pool.push({ seat: `TC-H${i}`, home: 'TC', state: 'working', since: NOW - (20 + i) * 60_000, ownerIdleCell: `TC-C${i}` });
  }
  for (let i = 0; i < free; i++) { hands.push({ seat: `TC-F${i}`, space: 'TC', idle: true }); pool.push({ seat: `TC-F${i}`, home: 'TC', state: 'idle', since: NOW - 30 * 60_000 }); }
  for (let i = 0; i < 4; i++) { hands.push({ seat: `JUD-H${i}`, space: 'JUD', idle: true }); pool.push({ seat: `JUD-H${i}`, home: 'JUD', state: 'idle', judge: true }); }
  return { hands, cells, pool, holding, free };
}

describe('SIM idle hands holding their own cell — seeds 1–5', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    test(`seed ${seed}: the board splits holders from free hands; the planner wakes every holder on its cell`, async () => {
      const w = today(seed);
      const health = boardHealth({ cells: w.cells, hands: w.hands, order: [], scopeOf: (s) => s.split('-')[0]!, waitingOn: () => null, isCoordinator: (s) => s === 'OP' || s === 'TC' || s === 'JUD' });
      const tc = health.spaces.find((s) => s.space === 'TC')!;
      expect(tc).toMatchObject({ ready: 0, idleHands: w.free, idleHolding: w.holding, short: w.free > 0 });
      const lines = breaches({ health, leader: { flagged: false, by: null }, cut: null, phaseChanged: false }).map((b) => b.line);
      expect(lines.some((l) => l.includes('leaders: split cells'))).toBe(false);
      expect(lines).toContain(`idle hands holding their own open cell: TC ${w.holding} — the OP planner (b) wakes each on its cell`);
      expect(lines.some((l) => l.startsWith('ready < 2× idle hands in') && l.includes('TC 0/'))).toBe(w.free > 0);
      // The planner wakes each holder on its cell (one wake, no re-assignment — OP-PUSH-BUDGET).
      const state: NextActionState = { now: new Date(NOW).toISOString(), version: '0.3.38', released: '0.3.37',
        cells: w.cells.map((c) => ({ id: c.id, title: c.title, status: 'yellow', owner: c.owner, priority: 'P0', doneCriterion: 'x', updatedAt: c.updatedAt })),
        hands: w.pool, directives: [], handRaises: [], land: { readyToLand: 0, landedLastHour: 1, mode: 'live' }, releases: [], bulletin: { ageMin: 5 } };
      const woke: string[] = [];
      const results = await executeNextActions(planNextActions(state), { wake: (seat, lines) => {
        for (const l of lines) { const m = /^you hold (\S+) /u.exec(l); if (m) woke.push(`${seat}:${m[1]}`); } return 'mail #1 · wake sent'; } }, 'live');
      expect(woke.sort()).toEqual(Array.from({ length: w.holding }, (_, i) => `TC-H${i}:TC-C${i}`).sort());
      expect(results.filter((x) => x.action.key.startsWith('b:wake:')).every((x) => x.status === 'did')).toBe(true);
      expect(woke.some((x) => x.startsWith('JUD-'))).toBe(false);
    });
  }
});
