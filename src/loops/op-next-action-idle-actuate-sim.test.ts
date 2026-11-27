/**
 * SIM — rule (c) actuates (CEO 11-26 21:5x «구조적 문제도 고쳐주세요» item 2). Today's shape on build 2126: the board read
 * TC 0 ready / 6 idle · JUD 0 / 4 and OP only mailed «leaders: split cells». The open cells were owned by coordinators
 * (OP · TC · JUD), not hands, so nothing counted as «ready». Seeds 1–5 vary idle hands, cell owners, ages and how many
 * cells carry a done-when. Each run: the planner's actuators change the world (owners · split ledger); after the
 * 30-min deadline an unsplit cell is OP's FORCED first action.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeNextActions, planNextActions, renderNextActionBlock, type NaCell, type NaHand, type NaSplitRequest, type NextActionState } from './op-next-action.js';
import { liveNextActuators, readSplitRequests } from './op-next-action-live.js';

const T0 = Date.parse('2026-11-26T12:50:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

class World {
  cells: NaCell[] = []; hands: NaHand[] = []; splits: NaSplitRequest[] = []; mails: string[] = []; hints = new Map<string, string>();
  state(now: number): NextActionState {
    return { now: iso(now), version: '0.3.38', released: '0.3.37', cells: this.cells.map(c => ({ ...c })), hands: this.hands.map(h => ({ ...h })), directives: [], handRaises: [],
      land: { readyToLand: 0, landedLastHour: 2, mode: 'live' }, releases: [], bulletin: { ageMin: 5 }, splitRequests: [...this.splits] };
  }
  act(now: number) {
    return {
      // OP-PUSH-BUDGET: hint ⊕ one wake; the woken hand claims its hinted cell (work next honours the hint).
      hint: (entries: readonly { seat: string; cell: string }[]) => { for (const e of entries) this.hints.set(e.cell, e.seat); return `hints ${entries.length}`; },
      wake: (seat: string) => {
        const cell = [...this.hints].find(([c, s]) => s === seat && this.cells.find(x => x.id === c)?.owner !== seat)?.[0];
        if (cell) { this.cells = this.cells.map(c => c.id === cell ? { ...c, owner: seat } : c); this.hands = this.hands.map(h => h.seat === seat ? { ...h, state: 'working' as const } : h); }
        this.mails.push(`wake ${seat}`); return `mail #${this.mails.length}`;
      },
      requestSplit: (cell: string, deadline: string, why: string) => { this.splits.push({ cell, at: iso(now), deadline, why }); return `split request ${cell}`; },
    };
  }
}

function today(seed: number): { w: World; idle: number; withDone: number } {
  const r = rng(seed); const w = new World();
  const idle = 3 + Math.floor(r() * 4); // 3–6 idle TC hands (6 live)
  for (let i = 0; i < idle; i++) w.hands.push({ seat: `TC-H${i}`, home: 'TC', state: 'idle', since: T0 - (10 + i * 7) * 60_000 });
  for (let i = 0; i < 4; i++) w.hands.push({ seat: `JUD-H${i}`, home: 'JUD', state: 'idle', judge: true });
  w.hands.push({ seat: 'TC-W', home: 'TC', state: 'working' });
  const withDone = 1 + Math.floor(r() * 3);
  const owners = ['OP', 'TC', 'JUD', 'HAND-GONE'];
  for (let i = 0; i < withDone; i++) w.cells.push({ id: `D${seed}-${i}`, title: `has done ${i}`, status: 'yellow', priority: i ? 'P1' : 'P0', owner: owners[i % owners.length], doneCriterion: `test ${i} passes`, updatedAt: iso(T0 - (300 - i) * 60_000) });
  w.cells.push({ id: 'JUD-BUTLER', title: '판정국 집사', status: 'yellow', priority: 'P0', owner: 'JUD', updatedAt: iso(T0 - 900 * 60_000) });
  w.cells.push({ id: 'JUDGE-THROUGHPUT', title: 'judge throughput', status: 'yellow', priority: 'P0', owner: 'OP', updatedAt: iso(T0 - 800 * 60_000) });
  w.cells.push({ id: 'BUSY', title: 'someone on it', status: 'yellow', priority: 'P0', owner: 'TC-W', doneCriterion: 'x', updatedAt: iso(T0 - 999 * 60_000) });
  w.cells.push({ id: 'BLOCKED', title: 'waits', status: 'yellow', priority: 'P0', owner: 'OP', doneCriterion: 'x', predecessors: ['BUSY'], updatedAt: iso(T0 - 999 * 60_000) });
  w.cells.push({ id: 'UMB', title: 'umbrella', status: 'yellow', priority: 'P0', dispatchKind: 'umbrella', updatedAt: iso(T0 - 999 * 60_000) });
  return { w, idle, withDone };
}

describe('SIM (c) idle hands + 0 ready → actuate — seeds 1–5', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    test(`seed ${seed}: cells with done-when are hinted and pulled, the rest get split requests, overdue → FORCED`, async () => {
      const { w, idle, withDone } = today(seed);
      const plan = planNextActions(w.state(T0));
      expect(plan.actions.some(a => a.actor === 'op' && a.rule === 'c')).toBe(false); // no «go split» chore while cells can move
      const results = await executeNextActions(plan, w.act(T0), 'live');
      // Every done-when cell nobody is on goes to a TC hand (longest idle first); judge hands and busy/blocked cells untouched.
      const assigned = w.cells.filter(c => c.id.startsWith(`D${seed}-`) && c.owner?.startsWith('TC-H'));
      expect(assigned.length).toBe(Math.min(withDone, idle));
      expect(w.cells.find(c => c.id === `D${seed}-0`)?.owner).toBe(`TC-H${idle - 1}`);
      expect(w.cells.find(c => c.id === 'BUSY')?.owner).toBe('TC-W');
      expect(w.cells.find(c => c.id === 'BLOCKED')?.owner).toBe('OP');
      expect(w.cells.some(c => c.owner?.startsWith('JUD-H'))).toBe(false);
      // The two cells without a done-when got split requests (oldest first), recorded by the planner — not mailed.
      expect(w.splits.map(s => s.cell)).toEqual(['JUD-BUTLER', 'JUDGE-THROUGHPUT']);
      expect(w.splits[0]!.deadline).toBe(iso(T0 + 30 * 60_000));
      expect(w.mails.every(m => m.startsWith('wake '))).toBe(true); // wakes only — no assign mail
      expect(results.filter(r => r.status === 'did').length).toBe(Math.min(withDone, idle) + 2);
      // 10 min later: requests open, not overdue → no new request, nothing forced.
      expect(planNextActions(w.state(T0 + 10 * 60_000)).actions.some(a => a.key.startsWith('c:split') || !!a.forced)).toBe(false);
      // A hand frees up again; 31 min later JUD-BUTLER is still unsplit, no done-when → FORCED first NEXT ACTION for OP.
      w.hands = w.hands.map(h => h.seat === 'TC-H0' ? { ...h, state: 'idle' } : h);
      w.cells = w.cells.map(c => c.owner === 'TC-H0' ? { ...c, status: 'green' } : c);
      const late = planNextActions(w.state(T0 + 31 * 60_000));
      expect(late.actions[0]).toMatchObject({ rule: 'c', actor: 'op', key: 'c:split-overdue:JUD-BUTLER' });
      expect(late.actions[0]!.forced).toContain('deadline passed 1 min ago');
      const block = renderNextActionBlock(await executeNextActions(late, {}, 'live'), late.goals);
      expect(block).toContain('NEXT ACTION (do it) — (c) split JUD-BUTLER');
      expect(block).toContain('  FORCED: split request for JUD-BUTLER recorded 12:50Z, deadline passed 1 min ago');
      // OP writes the done-when instead → the request is satisfied and the cell is simply assigned next time.
      w.cells = w.cells.map(c => c.id === 'JUD-BUTLER' || c.id === 'JUDGE-THROUGHPUT' ? { ...c, doneCriterion: 'queue median ≤ 30 min' } : c);
      const done = planNextActions(w.state(T0 + 32 * 60_000));
      expect(done.actions.some(a => !!a.forced)).toBe(false);
      expect(done.actions.find(a => a.target?.cell === 'JUD-BUTLER')).toMatchObject({ actor: 'planner', do: 'pull' });
    });
  }
  test('no free cell at all → the old OP split action (fallback)', () => {
    const w = new World();
    w.hands = [{ seat: 'H1', home: 'TC', state: 'idle' }, { seat: 'H2', home: 'TC', state: 'working' }];
    w.cells = [{ id: 'X', title: 'x', status: 'yellow', priority: 'P0', owner: 'H2', doneCriterion: 'x passes', updatedAt: iso(T0) }]; // a done-when, so (w) does not lead (#40308)
    expect(planNextActions(w.state(T0)).actions[0]).toMatchObject({ rule: 'c', actor: 'op', key: 'c:X' });
  });
});

describe('split request ledger (live)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'op-split-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  test('requestSplit appends; readSplitRequests keeps the latest per cell from the last 24 h', async () => {
    const act = liveNextActuators({ stateRoot: dir, seatState: dir });
    await act.requestSplit!('A', '2026-11-26T13:20:00.000Z', 'no done-when');
    await act.requestSplit!('A', '2026-11-26T13:40:00.000Z', 'again');
    const rows = readSplitRequests(dir, Date.now());
    expect(rows.map(r => [r.cell, r.deadline])).toEqual([['A', '2026-11-26T13:40:00.000Z']]);
    expect(readFileSync(join(dir, 'loops', 'op-split-requests.jsonl'), 'utf8').split('\n').filter(Boolean).length).toBe(2);
    expect(readSplitRequests(dir, Date.now() + 25 * 3_600_000)).toEqual([]);
  });
});
