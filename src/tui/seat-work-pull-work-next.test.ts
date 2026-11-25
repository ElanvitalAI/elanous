import { describe, expect, test } from 'bun:test';

// KNOCK-USES-WORK-NEXT (OP 11-25 20:4x) — the TUI idle pull knock claims through the SAME function as `eln work next`.
// Live finding: the knock said «대상(내 칸·주인 없음) 0칸» while 5 leader-held READY cells sat on the board.
// Expectations are independent literals (rule 11): cell ids, seats and the notice prefix are spelled out here.

import { createSeatWorkPull, fileWipKnockStore, type WipKnockStore } from './seat-work-pull.js';
import { wireWorkPullKnock } from './work-pull-knock.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BoardCell, WorkNextDeps } from '../steward/space/work-next.js';

const NOW = Date.parse('2026-11-25T20:45:00Z');
const OLD = '2026-11-25T18:00:00Z';

// Federation in this test universe: TC = coordinator, TC-H-1/TC-H-2 = hands, JUD = judge coordinator, JUD-1 = judge hand.
const SCOPE: Record<string, string> = { 'TC-H-1': 'TC', 'TC-H-2': 'TC', 'JUD-1': 'JUD', TC: 'OP', JUD: 'OP' };

function universe(cells: BoardCell[], extra: Partial<WorkNextDeps> = {}) {
  const board = cells.map((c) => ({ ...c }));
  const swaps: Array<{ id: string; to: string; reason: string }> = [];
  const deps = (): WorkNextDeps => ({
    now: () => NOW,
    version: '9.9.9',
    cells: () => board,
    scopeOf: (s) => SCOPE[s] ?? 'OP',
    lastActiveMs: () => NOW,
    isCoordinator: (s) => s === 'TC' || s === 'JUD',
    isJudge: (s) => s === 'JUD' || s.startsWith('JUD-'),
    swap: (id, input) => {
      const cell = board.find((c) => c.id === id);
      if (!cell) return { outcome: 'missing' };
      if ((cell.owner ?? null) !== input.expectedOwner) return { outcome: 'lost' };
      (cell as { owner?: string }).owner = input.to;
      swaps.push({ id, to: input.to, reason: input.reason });
      return { outcome: 'swapped' };
    },
    ...extra,
  });
  return { board, swaps, deps };
}

const memStore = (): WipKnockStore => { const m = new Map<string, number>(); return { last: (k) => m.get(k), mark: (k, at) => { m.set(k, at); } }; };

function knock(seat: string, deps: () => WorkNextDeps, store: WipKnockStore = memStore(), now: () => number = () => NOW) {
  const notices: string[] = [];
  let injects = 0;
  const pull = createSeatWorkPull({
    seat, busy: () => false, workNextDeps: deps, wipStore: store, now,
    enqueueNotice: (text) => { notices.push(text); }, injectKey: () => { injects += 1; }, queueWake: 'WAKE',
  });
  return { pull, notices, injects: () => injects };
}

const leaderCells = (): BoardCell[] => ['L-1', 'L-2', 'L-3', 'L-4', 'L-5'].map((id) => ({ id, title: `leader cell ${id}`, status: 'yellow', owner: 'TC', priority: 'P1', updatedAt: OLD }));

describe('KNOCK-USES-WORK-NEXT', () => {
  test('0 unowned + 5 leader-held READY cells → the knock claims one (assignedBy: TC)', () => {
    const u = universe([...leaderCells(), { id: 'OTHER', title: 'other hand', status: 'yellow', owner: 'TC-H-2', priority: 'P0', updatedAt: OLD }]);
    const k = knock('TC-H-1', u.deps);
    const out = k.pull();
    expect(out).toEqual({ claimed: 'L-1' });
    expect(u.swaps).toEqual([{ id: 'L-1', to: 'TC-H-1', reason: 'work next · board cell (assignedBy: TC)' }]);
    expect(k.notices.length).toBe(1);
    expect(k.notices[0]!.startsWith('[SEAT-WORK-PULL · eln work next] L-1 · leader cell L-1')).toBe(true);
    expect(k.injects()).toBe(1);
  });

  test('judge seat never claims an implementation cell → «일감 0» with the work-next breakdown', () => {
    const u = universe(leaderCells());
    const k = knock('JUD-1', u.deps);
    const out = k.pull() as { noWork: string };
    expect(u.swaps).toEqual([]);
    expect(k.injects()).toBe(0);
    expect(out.noWork.startsWith('일감 0 — no READY cell in JUD or the pool (9.9.9) — board 5 · yellow 5 · done 0')).toBe(true);
    expect(out.noWork).toContain('claimable 0 · side judge');
  });

  test('blocked cell re-offered → its last holder gets it before a higher-priority leader cell', () => {
    const u = universe([
      { id: 'HI', title: 'p0 leader cell', status: 'yellow', owner: 'TC', priority: 'P0', updatedAt: OLD },
      { id: 'BLK', title: 'blocked earlier', status: 'yellow', owner: 'TC', priority: 'P2', updatedAt: OLD },
    ], { blockOf: (c) => (c.id === 'BLK' ? 'reoffer' : undefined), resume: () => {} });
    const out = knock('TC-H-1', u.deps).pull();
    expect(out).toEqual({ claimed: 'BLK' });
    expect(u.swaps[0]!.reason).toBe('work next · re-offered after block (assignedBy: TC)');
  });

  test('idle hand holding a cell → one wip-continue turn; repeat within 15 min (even after restart) → none; after 15 min → one more', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wip-continue-'));
    try {
      const u = universe([{ id: 'MINE', title: 'my cell', status: 'yellow', owner: 'TC-H-1', priority: 'P1', updatedAt: OLD }]);
      const store = () => fileWipKnockStore(join(dir, 'wip-continue-knocks.json'));
      let now = NOW;
      const k1 = knock('TC-H-1', u.deps, store(), () => now);
      expect(k1.pull()).toEqual({ claimed: 'MINE', wip: true });
      expect(k1.notices.length).toBe(1);
      expect(k1.notices[0]!.startsWith('[SEAT-WORK-PULL · wip-continue] continue your cell MINE: take the next step toward its done-when.')).toBe(true);
      expect(k1.notices[0]).toContain('close it green with that evidence');
      expect(k1.notices[0]).toContain('eln work block MINE --on <seat>');
      now = NOW + 14 * 60_000;
      const k2 = knock('TC-H-1', u.deps, store(), () => now); // a restarted TUI reads the same file
      expect((k2.pull() as { noWork: string }).noWork).toContain('wip-continue knocked 14 min ago');
      expect(k2.injects()).toBe(0);
      now = NOW + 15 * 60_000;
      expect(k2.pull()).toEqual({ claimed: 'MINE', wip: true });
      expect(u.swaps).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('the knock logs a wip-continue as claimed:wip-continue with the cell', () => {
    const logs: unknown[] = [];
    let fire: () => void = () => {};
    wireWorkPullKnock({ pull: () => ({ claimed: 'MINE', wip: true }), personTurnStarted: () => true, schedule: (f) => { fire = f; return () => {}; }, log: (_e, d) => { logs.push(d); } });
    fire();
    expect(logs).toEqual([{ claimed: 'wip-continue', cell: 'MINE' }]);
  });

  test('deps failure → noWork line, no notice (knock never throws)', () => {
    const k = knock('TC-H-1', () => { throw new Error('ladder unreadable'); });
    expect(k.pull()).toEqual({ noWork: '일감 조회 실패 — ladder unreadable' });
    expect(k.notices).toEqual([]);
  });
});
