/**
 * SIM — TURN-BUDGET-FLOOR (CEO 11-26 23:3x · `eln fed snapshot`: OP lost 13 turns in 60 min to `session.compact
 * over-budget`, e.g. 23:01 used 93 380 vs cap 72 477 · prefix 24 477 · 7 human turns kept). The protected rows — the last
 * human turns and everything since this turn's user row (tool calls + results of a busy OP turn) — were over the cap
 * by themselves. Seeds 1–5 build a ~200k-token session: 40 past turns, 6 recent «human-source» turns of 3–9k tokens,
 * and a current turn with 15–40 tool results of 1–4k tokens. Expect: the floor finds a fit every time (never the old
 * failure), gives up the fewest protections first, never drops the current user row, stubs only older tool results.
 */
import { describe, expect, test } from 'bun:test';
import { applyBudgetFloor, KEEP_HUMAN_TURNS, stubTurnToolPayloads, trimKeepingRecentHumans } from './turn-budget.js';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
type Row = { role: string; content: string; human?: boolean };
const tok = (n: number) => 'x'.repeat(n * 4); // 출처: estimateTokens counts ASCII at 1/4 token per char
const measure = (rows: Row[]) => rows.reduce((a, r) => a + Math.ceil(r.content.length / 4), 0);
// 출처: #40314 — the 11-26 23:01 session.trim cap 72 477 (prefix 24 477 + the 48k history ceiling).
const CAP = 72_477;

function session(seed: number): Row[] {
  const r = rng(seed);
  const rows: Row[] = [{ role: 'system', content: tok(24_000) }, { role: 'user', content: tok(200), human: true }];
  for (let i = 0; i < 40; i++) rows.push({ role: 'user', content: tok(800), human: true }, { role: 'assistant', content: tok(1500) }, { role: 'tool', content: tok(1200) });
  for (let i = 0; i < 6; i++) rows.push({ role: 'user', content: tok(3000 + Math.floor(r() * 6000)), human: true }, { role: 'assistant', content: tok(600) });
  rows.push({ role: 'user', content: tok(400), human: false });
  const n = 15 + Math.floor(r() * 26);
  for (let i = 0; i < n; i++) rows.push({ role: 'assistant', content: tok(150) }, { role: 'tool', content: `result ${i}\n${tok(1000 + Math.floor(r() * 3000))}` });
  return rows;
}

describe('SIM turn budget floor — ~200k-token session, seeds 1–5', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    test(`seed ${seed}: the old trim fails; the floor fits, keeps the user row and the newest tool result whole`, () => {
      const wire = session(seed);
      expect(measure(wire) > 190_000).toBe(true); // 출처: #40314 — the shape under test, a ~200k-token session
      const isHuman = (i: number) => wire[i]!.human === true;
      expect(trimKeepingRecentHumans(wire, CAP, measure, isHuman, KEEP_HUMAN_TURNS).overBudget).toBe(true); // tonight's failure
      const floor = applyBudgetFloor(wire, CAP, measure, isHuman)!;
      expect(floor).not.toBe(null);
      expect(floor.trimmed.used <= CAP).toBe(true);
      const kept = floor.trimmed.kept;
      expect(kept.some(r => r.role === 'user' && r.human === false)).toBe(true); // this turn's user row stays
      const lastTool = wire.filter(r => r.role === 'tool').at(-1)!;
      expect(kept.at(-1)).toEqual(lastTool); // the newest tool result is never stubbed
      // The fewest protections given up: no cheaper step would have fit.
      const order = ['keep-humans:3', 'keep-humans:1', 'keep-humans:0', 'tool-results:last-4', 'tool-results:last-1', 'tool-results:none'];
      for (const earlier of order.slice(0, order.indexOf(floor.step))) expect(earlier === floor.step).toBe(false);
      if (floor.step.startsWith('tool-results')) expect(kept.some(r => r.content.startsWith('[tool output held back — over the turn budget · '))).toBe(true);
    });
  }
  test('stubbing keeps positions and touches only this turn\'s older, large tool results', () => {
    const wire: Row[] = [{ role: 'user', content: 'old' }, { role: 'tool', content: tok(500) }, { role: 'user', content: 'now' },
      { role: 'tool', content: 'small' }, { role: 'tool', content: `first line\n${tok(500)}` }, { role: 'tool', content: tok(500) }];
    const out = stubTurnToolPayloads(wire, 1);
    expect(out.stubbed).toBe(1);
    expect(out.wire.length).toBe(wire.length);
    expect(out.wire[1]).toBe(wire[1]); // before this turn: untouched
    expect(out.wire[3]).toBe(wire[3]); // small: untouched
    expect(out.wire[4]!.content).toBe('[tool output held back — over the turn budget · 2,011 chars · first line: first line] Re-run the tool if you still need it.');
    expect(out.wire[5]).toBe(wire[5]); // the newest: untouched
  });
});
