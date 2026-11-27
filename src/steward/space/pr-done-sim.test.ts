/**
 * SIM — PR-DONE (CEO 11-27 07:3x · revised 07:5x OPS-RULES «처리량 정책 개정 11-27» ①②). The land line owns the receipt
 * and the main merge; a hand's «done» is the PR handed off — branch pushed, worktree clean. Seeds 1–5 draw each hand's
 * own-PR state; expect: dirty tree or unpushed commits → exit 4 with the literal move; no receipt / behind main /
 * receipted / verdict / no local tree → the hand claims the next cell (handed to the land line); a draft is WIP 1.
 */
import { describe, expect, test } from 'bun:test';
import { cellWaitOf, prDoneTodo, type AuthorTree, type WaitFacts, type WaitPr } from './cell-wait.js';
import { workNext, type BoardCell } from './work-next.js';

const NOW = Date.parse('2026-11-27T08:00:00.000Z');
function rng(seed: number): () => number { let a = seed; return () => { a = (a * 1103515245 + 12345) % 2147483648; return a / 2147483648; }; }
type State = 'dirty' | 'unpushed' | 'no-receipt' | 'receipted' | 'verdict' | 'no-tree' | 'draft';
const STATES: readonly State[] = ['dirty', 'unpushed', 'no-receipt', 'receipted', 'verdict', 'no-tree', 'draft'];

describe('SIM PR-DONE (handoff) — seeds 1–5', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    test(`seed ${seed}: only a dirty tree or unpushed commits hold the hand; everything else is handed to the land line`, () => {
      const r = rng(seed);
      const hands = Array.from({ length: 7 }, (_, i) => ({ seat: `TC-H-CX-${i}`, state: STATES[Math.floor(r() * STATES.length)]! }));
      let cells: BoardCell[] = hands.map((h, i) => ({ id: `OWN-${seed}-${i}`, title: 'own', status: 'yellow', owner: h.seat, priority: 'P1', updatedAt: '2026-11-27T07:00:00.000Z' }));
      cells.push(...Array.from({ length: 7 }, (_, i) => ({ id: `NEW-${seed}-${i}`, title: 'ready', status: 'yellow', priority: 'P0', updatedAt: '2026-11-27T06:00:00.000Z' }) as BoardCell));
      const prs: WaitPr[] = hands.map((h, i) => ({ number: 41000 + i, head: `${i}`.repeat(40), branch: `tc/own-${seed}-${i}`, title: `fix: OWN-${seed}-${i}`, draft: h.state === 'draft' }));
      const facts: WaitFacts = { prs,
        receipts: hands.flatMap((h, i) => (h.state === 'receipted' ? [{ pr: 41000 + i, head12: `${i}`.repeat(12), status: 'LIGHT_PASS_NOT_FULL_GATE' }] : [])),
        verdicts: hands.flatMap((h, i) => (h.state === 'verdict' ? [{ pr: 41000 + i, head12: `${i}`.repeat(12), kind: 'jud', verdict: 'PASS' }] : [])) };
      const treeOf = (branch: string): AuthorTree | null => {
        const i = prs.findIndex(p => p.branch === branch); const st = hands[i]!.state;
        if (st === 'no-tree') return null;
        return { path: `/wt/${branch}`, dirty: st === 'dirty', unpushed: st === 'unpushed' ? 2 : 0 };
      };
      const deps = {
        now: () => NOW, version: '0.3.38', cells: () => cells, scopeOf: () => 'TC', lastActiveMs: () => NOW,
        waitOf: (c: BoardCell) => cellWaitOf(c.id, facts), prDone: (c: BoardCell) => prDoneTodo(c.id, facts, treeOf)?.line ?? null,
        swap: (id: string, input: { expectedOwner: string | null; to: string }) => {
          const c = cells.find(x => x.id === id);
          if (!c || (c.owner ?? null) !== input.expectedOwner) return { outcome: 'lost' as const };
          cells = cells.map(x => (x.id === id ? { ...x, owner: input.to } : x)); return { outcome: 'swapped' as const };
        },
        isCoordinator: (s: string) => s === 'TC', isJudge: () => false,
      };
      hands.forEach((h, i) => {
        const got = workNext(h.seat, deps);
        if (h.state === 'dirty') { expect(got.code).toBe(4); expect(got.line).toContain(`PR #${41000 + i}: your worktree /wt/tc/own-${seed}-${i} has uncommitted changes — commit and push (or clean it)`); }
        else if (h.state === 'unpushed') { expect(got.code).toBe(4); expect(got.line).toContain(`PR #${41000 + i}: 2 commit(s) on tc/own-${seed}-${i} not pushed — git push`); }
        else if (h.state === 'draft') expect(got.code).toBe(4); // a draft PR is the owner's own active work (WIP 1)
        else { expect(got.code).toBe(0); expect(got.code === 0 && got.cell.id.startsWith(`NEW-${seed}-`)).toBe(true); }
      });
    });
  }
  test('prDoneTodo literals — receipt and main are the land line\'s, never a hold', () => {
    const pr: WaitPr = { number: 7, head: 'a'.repeat(40), branch: 'x/C-1', title: 'C-1', draft: false };
    const clean = () => ({ path: '/wt/x', dirty: false, unpushed: 0 });
    expect(prDoneTodo('C-1', { prs: [pr] }, clean)).toBe(null);
    expect(prDoneTodo('C-1', { prs: [pr] }, () => null)).toBe(null);
    expect(prDoneTodo('C-1', { prs: [pr] }, () => ({ path: '/wt/x', dirty: true, unpushed: 0 }))).toEqual({ pr: 7, why: 'dirty', line: 'PR #7: your worktree /wt/x has uncommitted changes — commit and push (or clean it)' });
    expect(prDoneTodo('C-1', { prs: [pr] }, () => ({ path: '/wt/x', dirty: false, unpushed: 1 }))?.why).toBe('unpushed');
    expect(prDoneTodo('C-1', { prs: [pr] }, () => { throw new Error('git missing'); })).toBe(null);
  });
});
