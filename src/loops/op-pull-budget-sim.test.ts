/**
 * SIM — OP-PUSH-BUDGET (11-27). At 15:24Z the next-action actuator sent 27 `[SEAT-ASSIGN] … by OP` mails in one burst
 * (OP→hands 60/h) against the CEO-approved pull model («OP stops direct-assign; reorder with eln work priority»).
 * Seeds 1–5: 27 ready cells × 10 idle hands, plus 0–14 OP→hand mails already sent this hour. Expect: the planner writes
 * one priorityOrder ⊕ pull-hint ledger, sends no assign mail, at most one wake per hand and never more than the hourly
 * budget (15) allows; every hinted hand — woken or folded — claims its hinted cell through the real `workNext`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeNextActions, planNextActions, type NaCell, type NaHand, type NextActionState } from './op-next-action.js';
import { addPullHints, readPriorityOrder } from '../steward/space/work-next-cli.js';
import { workNext, type BoardCell } from '../steward/space/work-next.js';

const T0 = Date.parse('2026-11-26T15:24:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'op-pull-budget-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('SIM OP pull budget — 27 ready × 10 idle, seeds 1–5', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    test(`seed ${seed}: hints ⊕ ≤1 wake per hand ⊕ ≤15 OP→hand mails/h; hands claim their hinted cells via work next`, async () => {
      const r = rng(seed);
      const hands: NaHand[] = Array.from({ length: 10 }, (_, i) => ({ seat: `TC-H${i}`, home: 'TC', state: 'idle' as const, since: T0 - (5 + Math.floor(r() * 90)) * 60_000 }));
      let cells: NaCell[] = Array.from({ length: 27 }, (_, i) => ({ id: `R${seed}-${String(i).padStart(2, '0')}`, title: `ready ${i}`, status: 'yellow' as const,
        priority: r() < 0.5 ? 'P0' as const : 'P1' as const, doneCriterion: `test ${i} passes`, updatedAt: iso(T0 - (30 + i) * 60_000) }));
      const sentThisHour = Math.floor(r() * 15); // 0–14 OP→hand mails already out
      const state: NextActionState = { now: iso(T0), version: '0.3.38', released: '0.3.37', cells, hands, directives: [], handRaises: [],
        land: { readyToLand: 0, landedLastHour: 3, mode: 'live' }, releases: [], bulletin: { ageMin: 5 } };
      const mails: string[] = []; let ledgerWrites = 0;
      const plan = planNextActions(state);
      expect(plan.actions.some(a => a.commands.some(c => c.startsWith('eln seat assign')))).toBe(false);
      const results = await executeNextActions(plan, {
        hint: (entries) => { ledgerWrites++; addPullHints(root, entries, 'OP', T0); return `hints ${entries.length}`; },
        wake: (seat) => { mails.push(`wake ${seat}`); return `mail #${mails.length}`; },
        handMailBudget: () => 15 - sentThisHour,
      }, 'live');
      const pulls = plan.actions.filter(a => a.do === 'pull');
      expect(pulls.length).toBeGreaterThan(0);
      expect(ledgerWrites).toBe(1);
      expect(mails.every(m => m.startsWith('wake '))).toBe(true);
      expect(new Set(mails).size).toBe(mails.length); // one wake per hand
      expect(mails.length).toBeLessThanOrEqual(10);
      expect(sentThisHour + mails.length).toBeLessThanOrEqual(15);
      expect(mails.length).toBe(Math.min(pulls.length, 15 - sentThisHour));
      expect(results.filter(x => x.evidence.includes('wake folded')).length).toBe(pulls.length - mails.length);
      // The ledger: hinted cells lead priorityOrder; each carries its hand.
      const ledger = readPriorityOrder(root);
      expect(ledger.order.slice(0, pulls.length)).toEqual(pulls.map(a => a.target!.cell!));
      // Every hinted hand (woken now or folded — it pulls on its next turn) claims its own hinted cell via work next.
      const deps = (seat: string) => ({
        now: () => T0 + 60_000, version: '0.3.38', cells: () => cells as unknown as readonly BoardCell[], scopeOf: () => 'TC', lastActiveMs: () => T0,
        priorityOrder: () => readPriorityOrder(root).order,
        hintOf: (c: BoardCell) => { const h = readPriorityOrder(root).hints?.[c.id]; return h && Date.parse(h.until) > T0 + 60_000 ? h.seat : undefined; },
        swap: (id: string, input: { expectedOwner: string | null; to: string }) => {
          const c = cells.find(x => x.id === id);
          if (!c || (c.owner ?? null) !== input.expectedOwner) return { outcome: 'lost' as const };
          cells = cells.map(x => x.id === id ? { ...x, owner: input.to } : x); return { outcome: 'swapped' as const };
        },
        isCoordinator: (s: string) => s === 'TC', isJudge: () => false,
      });
      // Hands pull in a shuffled order — a hint holds even when another hand asks first.
      const order = pulls.map(a => a.target!.seat!).sort(() => r() - 0.5);
      for (const seat of order) {
        const got = workNext(seat, deps(seat));
        expect(got.code).toBe(0);
        expect(got.code === 0 && got.cell.id).toBe(pulls.find(a => a.target!.seat === seat)!.target!.cell!);
      }
    });
  }
  test('the hourly budget already spent → hints only, every wake folds', async () => {
    const hands: NaHand[] = [{ seat: 'TC-H1', home: 'TC', state: 'idle', since: T0 - 600_000 }];
    const cells: NaCell[] = [{ id: 'R1', title: 'ready', status: 'yellow', priority: 'P0', doneCriterion: 'x', updatedAt: iso(T0) }];
    const plan = planNextActions({ now: iso(T0), version: '0.3.38', released: '0.3.37', cells, hands, directives: [], handRaises: [],
      land: { readyToLand: 0, landedLastHour: 3, mode: 'live' }, releases: [], bulletin: { ageMin: 5 } });
    const mails: string[] = [];
    const res = await executeNextActions(plan, { hint: () => 'hints 1', wake: (s) => { mails.push(s); return 'x'; }, handMailBudget: () => 0 }, 'live');
    expect(mails).toEqual([]);
    expect(res.find(x => x.action.do === 'pull')?.evidence).toContain('wake folded (OP→hand budget 15/h spent');
  });
  test('a holder wake (#40316) stays a wake — no hint, no assignment', async () => {
    const hands: NaHand[] = [{ seat: 'TC-H1', home: 'TC', state: 'idle', since: T0 - 600_000, ownerIdleCell: 'MINE' }];
    const cells: NaCell[] = [{ id: 'MINE', title: 'held', status: 'yellow', priority: 'P0', owner: 'TC-H1', doneCriterion: 'x', updatedAt: iso(T0) }];
    const plan = planNextActions({ now: iso(T0), version: '0.3.38', released: '0.3.37', cells, hands, directives: [], handRaises: [],
      land: { readyToLand: 0, landedLastHour: 3, mode: 'live' }, releases: [], bulletin: { ageMin: 5 } });
    const hinted: string[] = []; const woke: string[][] = [];
    await executeNextActions(plan, { hint: (e) => { hinted.push(...e.map(x => x.cell)); return 'h'; }, wake: (s, l) => { woke.push([s, ...l]); return 'mail #1'; } }, 'live');
    expect(hinted).toEqual([]);
    expect(woke).toEqual([['TC-H1', 'you hold MINE and your pane is idle — continue it or hand it back']]);
  });
});
