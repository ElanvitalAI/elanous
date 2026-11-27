/**
 * SIM — (w) P0 cells without done-when come first (CEO 11-26 21:5x «구조적 문제도 고쳐주세요»). Today's shape: the goal
 * line read «JUD-BUTLER … — done when (no done-when on the cell)» and «JUDGE-THROUGHPUT …» the same; OP never wrote one.
 * Seeds 1–5 vary how many P0 cells lack it, their owners and ages, plus a directive and a stale bulletin competing.
 */
import { describe, expect, test } from 'bun:test';
import { planNextActions, renderNextActionBlock, executeNextActions, type NaCell, type NextActionState } from './op-next-action.js';

const NOW = '2026-11-26T12:50:00.000Z';
const ago = (min: number) => new Date(Date.parse(NOW) - min * 60_000).toISOString();
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const base = (cells: NaCell[]): NextActionState => ({ now: NOW, version: '0.3.38', released: '0.3.37', cells, hands: [], handRaises: [], land: { readyToLand: 0, landedLastHour: 2, mode: 'live' },
  releases: [], bulletin: { ageMin: 300 }, directives: [{ msgId: 190001, crownDirective: 'crown-x', from: 'OP', body: 'do Y', createdAt: ago(5) }] });

describe('SIM (w) write done-when — seeds 1–5', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    test(`seed ${seed}: P0 cells without done-when lead the plan; writing one removes it`, async () => {
      const r = rng(seed);
      const n = 1 + Math.floor(r() * 5);
      const cells: NaCell[] = [
        { id: 'JUD-BUTLER', title: '판정국 집사', status: 'yellow', priority: 'P0', owner: 'JUD', updatedAt: ago(600 + seed) },
        { id: 'JUDGE-THROUGHPUT', title: 'judge throughput', status: 'red', priority: 'P0', owner: 'JUD', updatedAt: ago(500) },
        ...Array.from({ length: n }, (_, i) => ({ id: `P0-NODW-${seed}-${i}`, title: `x ${i}`, status: 'yellow' as const, priority: 'P0' as const, updatedAt: ago(100 + Math.floor(r() * 300)) })),
        { id: 'P1-NODW', title: 'p1 without one', status: 'yellow', priority: 'P1', updatedAt: ago(900) },
        { id: 'P0-UMB', title: 'umbrella', status: 'yellow', priority: 'P0', dispatchKind: 'umbrella', updatedAt: ago(900) },
        { id: 'P0-OK', title: 'has one', status: 'yellow', priority: 'P0', doneCriterion: 'bun test x passes', updatedAt: ago(800) },
        { id: 'P0-GREEN', title: 'done', status: 'green', priority: 'P0', updatedAt: ago(10) },
      ];
      const plan = planNextActions(base(cells));
      const w = plan.actions.filter(a => a.rule === 'w');
      // Red first, then oldest: JUDGE-THROUGHPUT (red) · JUD-BUTLER (oldest yellow) · then the oldest seeded one.
      expect(w.map(a => a.target?.cell).slice(0, 2)).toEqual(['JUDGE-THROUGHPUT', 'JUD-BUTLER']);
      expect(w.length).toBe(3);
      expect(plan.actions[0]?.rule).toBe('w');
      expect(plan.actions.map(a => a.rule).filter((x, i, all) => all.indexOf(x) === i)).toEqual(['w', 'a', 'f']);
      expect(w[0]?.commands[0]).toBe("eln release checklist set JUDGE-THROUGHPUT --done '<what is observed when it is done — a command, a screen, a number>' --version 0.3.38");
      expect(w[0]?.evidence).toContain(`${n + 2} P0 cells without one in all`);
      expect(w.some(a => ['P1-NODW', 'P0-UMB', 'P0-OK', 'P0-GREEN'].includes(a.target?.cell ?? ''))).toBe(false);
      const block = renderNextActionBlock(await executeNextActions(plan, {}, 'live'), plan.goals);
      expect(block).toContain('NEXT ACTION (do it) — (w) write the done-when of P0 JUDGE-THROUGHPUT');
      // OP writes the done-when (the checklist set --done effect) → the cell leaves (w), the next one moves up.
      const after = cells.map(c => c.id === 'JUDGE-THROUGHPUT' ? { ...c, doneCriterion: 'judge queue median ≤ 30 min for 2 h' } : c);
      expect(planNextActions(base(after)).actions[0]?.target?.cell).toBe('JUD-BUTLER');
    });
  }
  test('no P0 cell lacks a done-when → no (w) action', () => {
    expect(planNextActions(base([{ id: 'A', title: 'a', status: 'yellow', priority: 'P0', doneCriterion: 'x', updatedAt: ago(1) }])).actions.some(a => a.rule === 'w')).toBe(false);
  });
});
