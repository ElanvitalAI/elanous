// BOARD-STEWARD sim world — tonight-like stream over 3 seeds: 114 cells, 25 idle hands, demo P0 set, a hand hoarding
// 16 cells, a 04:00 cut with mixed green/yellow, a publish then the next board, a leader reordering, demo-freeze.
// Expectations are independent literals (not recomputed with the product's rules).
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PulsePhase } from '../../loops/op-pulse.js';
import { boardTick, cutListPath, digestPath, type BoardDeps } from './tick.js';
import { cardsAllowed, leaderWrite, rankBoard, type BoardCellIn, type HandIn, type OrderLedger } from './model.js';

const SPACES = ['TC', 'UX', 'MK', 'RES', 'JUD'];

function rng(seed: number): () => number { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }

interface World { owner: string; sent: Array<{ to: string; line: string }>; cells: Map<string, BoardCellIn & { owner?: string }>; hands: HandIn[]; order: OrderLedger; phase: PulsePhase; published: Set<string>; cards: string[]; returned: string[]; resets: PulsePhase[] }

function world(seed: number): World {
  const r = rng(seed);
  const cells = new Map<string, BoardCellIn & { owner?: string }>();
  const t0 = Date.parse('2026-11-25T20:00:00Z');
  for (let i = 0; i < 114; i++) {
    const id = `C${String(i).padStart(3, '0')}`;
    const space = SPACES[i % 5]!;
    const status = i < 20 ? 'green' : 'yellow';
    const demo = i >= 20 && i < 26; // demo P0 set: C020..C025
    cells.set(id, { id, title: demo ? `demo screen ${i}` : `cell ${i}`, status, space, priority: demo ? 'P0' : (['P1', 'P2', undefined][Math.floor(r() * 3)]),
      deadlineVersion: i >= 100 ? '0.3.39' : '0.3.38', updatedAt: new Date(t0 + Math.floor(r() * 3_600_000)).toISOString(),
      ...(i === 30 ? { must: { version: '0.3.38' } } : {}), ...(i >= 40 && i < 50 ? { knownIssue: 'minor wording' } : {}) });
  }
  // HOARD hoards 16 yellow cells (C060..C075)
  for (let i = 60; i < 76; i++) { const c = cells.get(`C0${i}`)!; cells.set(c.id, { ...c, owner: 'HOARD' }); }
  // C080 waits on JUD-1
  const hands: HandIn[] = Array.from({ length: 25 }, (_, i) => ({ seat: `H${i}`, space: SPACES[i % 5]!, idle: true }));
  return { owner: 'OP', sent: [], cells, hands, order: { order: [] }, phase: 'build', published: new Set(), cards: [], returned: [], resets: [] };
}

function deps(w: World, dir: string, at: string, live = true): BoardDeps {
  return {
    cardCap: () => 3, dir, live, now: () => new Date(at), version: () => '0.3.38', nextVersion: () => '0.3.39', phase: () => w.phase,
    cells: (v) => [...w.cells.values()].filter((c) => (c.deadlineVersion ?? v) === v || (v === '0.3.39' && c.status !== 'green')),
    hands: () => w.hands, scopeOf: (s) => (s === 'HOARD' ? 'TC' : 'OP'), isCoordinator: (s) => s === 'OP' || s === 'TC',
    waitingOn: (c) => (c.id === 'C080' ? 'JUD-1' : null),
    readOrder: () => w.order, writeOrder: (order) => { w.order = { order, by: 'BOARD' }; },
    publishedAt: (v) => (w.published.has(v) ? '2026-11-26T06:00:00Z' : null),
    resetPhase: (p) => { w.resets.push(p); },
    returnCell: (_v, id, owner) => { const c = w.cells.get(id); if (!c || c.owner !== owner) return false; const { owner: _o, ...rest } = c; w.cells.set(id, rest); w.returned.push(id); return true; },
    owner: () => w.owner,
    card: (line, to) => { w.cards.push(line); w.sent.push({ to, line }); },
  };
}

test('candidate limit fails closed for unknown pool and preserves legacy when omitted', () => {
  for (const cap of [null, 0]) {
    const w = world(1); const dir = mkdtempSync(join(tmpdir(), 'board-cap-'));
    const r = boardTick({ ...deps(w, dir, '2026-11-25T23:20:00Z'), candidateCap: () => cap });
    expect(r.cards).toEqual([]);
  }
  const w = world(1); const dir = mkdtempSync(join(tmpdir(), 'board-cap-legacy-'));
  expect(boardTick(deps(w, dir, '2026-11-25T23:20:00Z')).cards.length).toBeGreaterThan(0);
});

for (const seed of [1, 7, 42]) {
  describe(`board steward sim · seed ${seed}`, () => {
    test('tonight stream: rank → hoard → leader → demo-freeze → cut 04:00 → publish → next board', () => {
      const w = world(seed); const dir = mkdtempSync(join(tmpdir(), `board-sim-${seed}-`));
      // 23:20 build tick: order written by BOARD; MUST C030 first; hoarder gives back 15 of 16
      let r = boardTick(deps(w, dir, '2026-11-25T23:20:00Z'));
      expect(r.order[0]).toBe('C030');
      expect(r.order.length).toBe(32);
      expect(w.order.by).toBe('BOARD');
      expect(r.returned.length).toBe(15);
      expect(w.returned.length).toBe(15);
      expect([...w.cells.values()].filter((c) => c.owner === 'HOARD').length).toBe(1);
      expect(r.cards.some((c) => c.includes('HOARD holds 16'))).toBe(true);
      // 23:25 leader TC reorders → flagged and overwritten
      w.order = { order: ['C099', 'C098'], by: 'TC' };
      r = boardTick(deps(w, dir, '2026-11-25T23:25:00Z'));
      expect(r.leaderFlag).toBe('TC');
      expect(w.order.by).toBe('BOARD');
      expect(w.order.order[0]).toBe('C030');
      // 23:40 demo-freeze → demo P0 set on top
      w.phase = 'demo-freeze';
      r = boardTick(deps(w, dir, '2026-11-25T23:40:00Z'));
      expect(r.order.slice(0, 6).sort()).toEqual(['C020', 'C021', 'C022', 'C023', 'C024', 'C025']);
      // 04:00 pre-cut → cut list file for L-0: 20 ship · 10 waive · hold C030 · rest defer
      w.phase = 'pre-cut';
      r = boardTick(deps(w, dir, '2026-11-26T04:00:00Z'));
      expect(r.cut!.counts.ship).toBe(20);
      expect(r.cut!.counts.waive).toBe(10);
      expect(r.cut!.holds).toEqual(['C030']);
      expect(r.cut!.counts.defer).toBe(69);
      expect(existsSync(cutListPath(dir, '0.3.38'))).toBe(true);
      expect(JSON.parse(readFileSync(cutListPath(dir, '0.3.38'), 'utf8')).by).toBe('steward:BOARD');
      // 06:00 publish signal → next board opens, pulse reset
      w.published.add('0.3.38'); w.phase = 'release-window';
      r = boardTick(deps(w, dir, '2026-11-26T06:05:00Z'));
      expect(r.opened!.version).toBe('0.3.39');
      expect(r.version).toBe('0.3.39');
      expect(r.phase).toBe('post-release');
      expect(w.resets).toEqual(['post-release']);
      expect(r.opened!.fresh.length).toBe(14);
      // 06:15 next tick stays on 0.3.39 (publish not replayed)
      r = boardTick(deps(w, dir, '2026-11-26T06:15:00Z'));
      expect(r.opened).toBeNull();
      expect(r.version).toBe('0.3.39');
      // one digest row per tick
      expect(readFileSync(digestPath(dir), 'utf8').trim().split('\n').length).toBe(6);
    });

    test('shadow: no order write, no returns, no cards delivered', () => {
      const w = world(seed); const dir = mkdtempSync(join(tmpdir(), `board-shadow-${seed}-`));
      const r = boardTick(deps(w, dir, '2026-11-25T23:20:00Z', false));
      expect(w.order.order.length).toBe(0);
      expect(w.returned.length).toBe(0);
      expect(w.cards.length).toBe(0);
      expect(r.returned.every((x) => x.ok === false)).toBe(true);
    });
  });
}

describe('board steward owner switch OP→TC mid-run', () => {
  for (const seed of [3, 11, 99]) test(`seed ${seed}`, () => {
    const w = world(seed); const dir = mkdtempSync(join(tmpdir(), `board-owner-${seed}-`));
    let r = boardTick(deps(w, dir, '2026-11-25T23:20:00Z'));
    expect(r.owner).toBe('OP');
    expect(w.sent.every((s) => s.to === 'OP')).toBe(true);
    w.owner = 'TC'; w.sent = [];
    w.order = { order: ['C099'], by: 'TC' };           // the owner's own write is not a leader write
    r = boardTick(deps(w, dir, '2026-11-25T23:35:00Z'));
    expect(r.owner).toBe('TC');
    expect(r.leaderFlag).toBeNull();
    w.order = { order: ['C098'], by: 'OP' };           // OP stays an allowed writer (federation HQ)
    expect(boardTick(deps(w, dir, '2026-11-25T23:36:00Z')).leaderFlag).toBeNull();
    w.order = { order: ['C097'], by: 'UX' };           // other leaders still flagged → card to TC
    r = boardTick(deps(w, dir, '2026-11-25T23:37:00Z'));
    expect(r.leaderFlag).toBe('UX');
    expect(w.sent.length).toBe(1);
    expect(w.sent[0]!.to).toBe('TC');
    expect(w.order.order[0]).toBe('C030');           // federation-wide ranking unchanged by the owner swap
  });
});

describe('board steward edges', () => {
  test('card cap: ≤3 per 10 min, no repeat key', () => {
    const b = [{ key: 'a', line: 'a' }, { key: 'b', line: 'b' }, { key: 'c', line: 'c' }, { key: 'd', line: 'd' }];
    expect(cardsAllowed(b, [], 0, 3).map((x) => x.key)).toEqual(['a', 'b', 'c']);
    expect(cardsAllowed(b, [], 0, null)).toEqual([]);
    expect(cardsAllowed(b, [], 0, 0)).toEqual([]);
    expect(cardsAllowed(b, [], 0, Number.NaN)).toEqual([]);
    expect(cardsAllowed([b[0]!, b[0]!, b[1]!, b[2]!], [], 0, 3).map((x) => x.key)).toEqual(['a', 'b', 'c']);
    expect(cardsAllowed(b, [{ at: 0, key: 'a' }, { at: 0, key: 'b' }], 60_000, 3).map((x) => x.key)).toEqual(['c']);
    expect(cardsAllowed(b, [{ at: 0, key: 'a' }], 600_001, 3).map((x) => x.key)).toEqual(['a', 'b', 'c']);
  });
  test('leader write: OP/BOARD allowed, empty never flagged', () => {
    expect(leaderWrite({ order: ['X'], by: 'op' }).flagged).toBe(false);
    expect(leaderWrite({ order: ['X'], by: 'BOARD' }).flagged).toBe(false);
    expect(leaderWrite({ order: ['X'], by: 'UX' }).flagged).toBe(true);
    expect(leaderWrite({ order: [], by: 'UX' }).flagged).toBe(false);
  });
  test('rank skips decision/umbrella and closed cells', () => {
    const at = '2026-11-25T00:00:00Z';
    expect(rankBoard([{ id: 'A', title: 'a', status: 'yellow', dispatchKind: 'decision', updatedAt: at }, { id: 'B', title: 'b', status: 'green', updatedAt: at },
      { id: 'C', title: 'c', status: 'red', updatedAt: at }], 'build', '0.3.38')).toEqual(['C']);
  });
  test('synthetic scratch board: supply breach fires one card', () => {
    const dir = mkdtempSync(join(tmpdir(), 'board-synth-'));
    const cards: string[] = [];
    const cells: BoardCellIn[] = [{ id: 'SYN-1', title: 'synthetic', status: 'yellow', space: 'SYN', tags: ['synthetic'], updatedAt: '2026-11-25T00:00:00Z' }];
    const d: BoardDeps = { dir, live: true, now: () => new Date('2026-11-25T23:30:00Z'), version: () => '9.9.9', nextVersion: () => '9.9.10', phase: () => 'build', cells: () => cells,
      cardCap: () => 3, synthetic: true, hands: () => [{ seat: 'S1', space: 'SYN', idle: true }, { seat: 'S2', space: 'SYN', idle: true }], scopeOf: () => 'SYN', isCoordinator: () => false, waitingOn: () => null,
      readOrder: () => ({ order: [] }), writeOrder: () => {}, publishedAt: () => null, resetPhase: () => {}, returnCell: () => false, card: (l) => { cards.push(l); } };
    boardTick(d); boardTick(d);
    expect(cards.length).toBe(1);
    expect(cards[0]).toContain('SYN 1/2');
  });
});

describe('board steward release edges (0.3.36 cut)', () => {
  test('steward restart mid-cut: state survives, cut list rewritten identically, no duplicate card', () => {
    const w = world(5); const dir = mkdtempSync(join(tmpdir(), 'board-restart-'));
    w.phase = 'pre-cut';
    const a = boardTick(deps(w, dir, '2026-11-26T04:00:00Z'));
    const first = JSON.parse(readFileSync(cutListPath(dir, '0.3.38'), 'utf8'));
    const cardsBefore = w.cards.length;
    // «restart» = a fresh deps object over the same dir, 5 min later (same breaches inside the 10-min window)
    const b = boardTick(deps(w, dir, '2026-11-26T04:05:00Z'));
    const second = JSON.parse(readFileSync(cutListPath(dir, '0.3.38'), 'utf8'));
    expect(second.rows).toEqual(first.rows);
    expect(second.counts).toEqual({ ship: 20, waive: 10, defer: 69, hold: 1 });
    expect(b.version).toBe(a.version);
    expect(w.cards.length).toBe(cardsBefore);
  });
  test('cut list written twice: one file, last write wins, valid JSON', () => {
    const w = world(6); const dir = mkdtempSync(join(tmpdir(), 'board-twice-'));
    w.phase = 'release-window';
    boardTick(deps(w, dir, '2026-11-26T04:30:00Z'));
    w.cells.set('C050', { ...w.cells.get('C050')!, status: 'green' });
    boardTick(deps(w, dir, '2026-11-26T04:31:00Z'));
    const cut = JSON.parse(readFileSync(cutListPath(dir, '0.3.38'), 'utf8'));
    expect(cut.counts.ship).toBe(21);
    expect(cut.at).toBe('2026-11-26T04:31:00.000Z');
    expect(existsSync(`${cutListPath(dir, '0.3.38')}.tmp`)).toBe(false);
  });
  test('publish signal missing: board stays on the version, no reset', () => {
    const w = world(8); const dir = mkdtempSync(join(tmpdir(), 'board-nopub-'));
    w.phase = 'release-window';
    const r = boardTick(deps(w, dir, '2026-11-26T07:00:00Z'));
    expect(r.version).toBe('0.3.38');
    expect(r.opened).toBeNull();
    expect(w.resets).toEqual([]);
  });
  test('owner switch during release window: cut list unchanged, cards follow owner', () => {
    const w = world(9); const dir = mkdtempSync(join(tmpdir(), 'board-ownrw-'));
    w.phase = 'release-window';
    boardTick(deps(w, dir, '2026-11-26T04:10:00Z'));
    const before = JSON.parse(readFileSync(cutListPath(dir, '0.3.38'), 'utf8'));
    w.owner = 'TC'; w.sent = [];
    w.order = { order: ['C097'], by: 'MK' };
    boardTick(deps(w, dir, '2026-11-26T04:12:00Z'));
    const after = JSON.parse(readFileSync(cutListPath(dir, '0.3.38'), 'utf8'));
    expect(after.rows).toEqual(before.rows);
    expect(w.sent.map((s) => s.to)).toEqual(['TC']);
  });
  test('synthetic-tagged cells never reach the real board', () => {
    const w = world(10); const dir = mkdtempSync(join(tmpdir(), 'board-synreal-'));
    w.cells.set('SYN-9', { id: 'SYN-9', title: 'synthetic P0', status: 'yellow', priority: 'P0', tags: ['synthetic'], must: { version: '0.3.38' }, deadlineVersion: '0.3.38', updatedAt: '2026-11-25T00:00:00Z' });
    w.phase = 'pre-cut';
    const r = boardTick(deps(w, dir, '2026-11-26T04:00:00Z'));
    expect(r.order.includes('SYN-9')).toBe(false);
    expect(r.cut!.rows.some((x) => x.id === 'SYN-9')).toBe(false);
    expect(r.cut!.holds).toEqual(['C030']);
  });
});
