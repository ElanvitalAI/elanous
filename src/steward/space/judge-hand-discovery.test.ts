// JUD-HAND-DISCOVERY (0.3.38 P0 · 11-28 00:5x) — live: steward:JUD R3 deferred «no-judge-hand» 20–36×/h while JUD-3 ·
// JUD-B · JUD-C · REVIEW-1 sat idle 18–99 min, and 19 cells «merged ⊕ same-head receipt» stayed unsigned (greens ~6/h).
// Causes: ① one PR per hand per 30-min cooldown (2 per tick) · ② the queue held open PRs only — the cells the judge-butler
// refuses with «JUD signs this one» (security-4 · a veto that stands) never reached a judge · ③ the defer reason hid that the
// judges were cooling, not missing. Seeded with the real roster shape and the butler's real last-tick lines. Literal expectations.
import { describe, expect, test } from 'bun:test';
import { resolveScope } from './config.js';
import { emptyScopeState, planJudge, type Snapshot } from './model.js';
import { parseButlerJudgeCells } from './sources.js';

const NOW = Date.parse('2026-11-27T15:50:00.000Z');
const ago = (min: number): string => new Date(NOW - min * 60_000).toISOString();
const agoMs = (min: number): number => NOW - min * 60_000;
const live = (caps?: { judge?: number }) => resolveScope('JUD', 'OP', { scopes: { JUD: { mode: 'live', ...(caps ? { caps } : {}) } } });

// The butler's last tick (2026-11-27T15:54Z) — the four refusal shapes it writes, verbatim prefixes.
const BUTLER_TICK = {
  at: ago(5),
  notSigned: [
    { cell: 'CLAUDE-OP-PROXY-BUS', why: 'security-4 → JUD/Terra — security-4: auth:src/els/server-auth.ts, auth:src/org/org-map.ts — JUD/Terra signs this one' },
    { cell: 'SIM-WORLD-JUDGING', why: 'veto stands (set back after the butler signed 2026-11-27T10:31:05.721Z · re-sign only when PR head / receipt changes) — #40451@9bb2b1a1e875 40451-9bb2b1a1e875-minim5 doc-only · E4 없음 → FU' },
    { cell: 'LEDGER-DRIVEN-UMBRELLA', why: 'veto stands (set back after the butler signed 2026-11-27T11:41:07.380Z · re-sign only when PR head / receipt changes) — #40436@33e9a2779a1c 40436-33e9a2779a1c-minim5 doc-only · #40445@5d237548c458 40445-5d237548c458-minim5 focused' },
    { cell: 'DORMANT-SEAT-ROUTE-E4', why: 'missing — E4 cell: its own E4 evidence run («E4 test|sim 층 — … · 칸 DORMANT-SEAT-ROUTE-E4 · … · rc 0») — a parent PR\'s focused receipt is not E4 evidence' },
    { cell: 'SEAT-ROLE-CARD-AND-SELF-RETRO', why: 'missing — #38255 same-head receipt (pregate --light on 9176db9ff643)' },
    { cell: 'BULLETIN-NOW-STALE', why: 'security-4 → JUD/Terra — security-4: auth:src/org/org-map.ts — JUD/Terra signs this one' },
    { cell: 'GONE-GREEN', why: 'veto stands (set back after the butler signed ? · re-sign only when PR head / receipt changes) — #40549@fd59a7f00bbc' },
  ],
};

function roster(over: Partial<Snapshot> = {}): Snapshot {
  const yellow = (id: string) => ({ id, title: id, status: 'yellow', owner: 'OP', priority: 'P0', updatedAt: ago(300) });
  return {
    nowMs: NOW, hq: 'OP', coordinators: ['JUD', 'TC'],
    parent: { 'JUD-3': 'JUD', 'JUD-B': 'JUD', 'JUD-C': 'JUD', 'REVIEW-1': 'JUD', 'TC-H-CX-1': 'TC', JUD: 'OP', TC: 'OP' },
    seats: [
      { seat: 'JUD', activity: 'working', idleForMs: null },
      { seat: 'JUD-3', activity: 'idle', idleForMs: 18 * 60_000 },
      { seat: 'JUD-B', activity: 'idle', idleForMs: 99 * 60_000 },
      { seat: 'JUD-C', activity: 'idle', idleForMs: 45 * 60_000 },
      { seat: 'REVIEW-1', activity: 'idle', idleForMs: 60 * 60_000 },
      { seat: 'TC-H-CX-1', activity: 'idle', idleForMs: 120 * 60_000 },
    ],
    version: '0.3.38',
    cells: [...['CLAUDE-OP-PROXY-BUS', 'SIM-WORLD-JUDGING', 'LEDGER-DRIVEN-UMBRELLA', 'DORMANT-SEAT-ROUTE-E4', 'SEAT-ROLE-CARD-AND-SELF-RETRO', 'BULLETIN-NOW-STALE'].map(yellow),
      { id: 'GONE-GREEN', title: 'g', status: 'green', owner: 'OP', priority: 'P0', updatedAt: ago(2) }],
    prs: [
      { number: 40576, head: '9e2267b7e16d'.padEnd(40, '0'), branch: 'tc-h-cx-1/x', title: 'x', draft: false, updatedAt: ago(60) },
      { number: 40558, head: 'fcb891a5f86b'.padEnd(40, '0'), branch: 'tc/y', title: 'y', draft: false, updatedAt: ago(60), files: ['src/oauth/token.ts'] },
    ],
    merged: [],
    receipts: [
      { pr: 40576, head12: '9e2267b7e16d', host: 'node-b', status: 'LIGHT_PASS_NOT_FULL_GATE', atMs: agoMs(90) },
      { pr: 40558, head12: 'fcb891a5f86b', host: 'node-b', status: 'LIGHT_PASS_NOT_FULL_GATE', atMs: agoMs(40) },
    ],
    verdicts: [], hosts: [], utilAgeMs: null, openHands: [], sourceErrors: [],
    judgeCells: parseButlerJudgeCells(BUTLER_TICK, NOW),
    ...over,
  };
}

describe('JUD-HAND-DISCOVERY — R3 finds the idle judges and hands them the cells only a judge can sign', () => {
  test('butler last tick → judge cells: security-4 and standing vetoes only, PRs parsed; stale or malformed = source error', () => {
    expect(parseButlerJudgeCells(BUTLER_TICK, NOW).map((c) => [c.cell, c.kind, c.prs])).toEqual([
      ['CLAUDE-OP-PROXY-BUS', 'security-4', []],
      ['SIM-WORLD-JUDGING', 'veto', [40451]],
      ['LEDGER-DRIVEN-UMBRELLA', 'veto', [40436, 40445]],
      ['BULLETIN-NOW-STALE', 'security-4', []],
      ['GONE-GREEN', 'veto', [40549]],
    ]);
    expect(() => parseButlerJudgeCells({ ...BUTLER_TICK, at: ago(61) }, NOW)).toThrow('butler last tick 61m old');
    expect(() => parseButlerJudgeCells({ notSigned: [] }, NOW)).toThrow('butler last tick: no «at»');
    expect(() => parseButlerJudgeCells(null, NOW)).toThrow('butler last tick: no «at»');
  });

  test('real roster: 4 idle judges found, cells first (security-4 → veto) then PRs, round-robin batches; the maker hand gets none', () => {
    const rows = planJudge(roster(), { scope: live({ judge: 4 }), state: emptyScopeState() });
    expect(rows.map((r) => [r.action, r.target, r.seat ?? null, r.reason])).toEqual([
      ['judge-assign', 'BULLETIN-NOW-STALE', 'JUD-B', 'cell-security-4'],
      ['judge-assign', 'CLAUDE-OP-PROXY-BUS', 'REVIEW-1', 'cell-security-4'],
      ['judge-assign', 'LEDGER-DRIVEN-UMBRELLA', 'JUD-C', 'cell-veto'],
      ['judge-assign', 'SIM-WORLD-JUDGING', 'JUD-3', 'cell-veto'],
      ['judge-assign', '#40558', 'JUD-B', 'green-no-verdict:security-4'],
      ['judge-assign', '#40576', 'REVIEW-1', 'green-no-verdict'],
    ]);
  });

  test('default caps (2 hands per tick): two batches of up to 5, nothing deferred for want of a hand', () => {
    const rows = planJudge(roster(), { scope: live(), state: emptyScopeState() });
    expect(rows.map((r) => [r.action, r.target, r.seat ?? r.reason])).toEqual([
      ['judge-assign', 'BULLETIN-NOW-STALE', 'JUD-B'],
      ['judge-assign', 'CLAUDE-OP-PROXY-BUS', 'REVIEW-1'],
      ['judge-assign', 'LEDGER-DRIVEN-UMBRELLA', 'JUD-B'],
      ['judge-assign', 'SIM-WORLD-JUDGING', 'REVIEW-1'],
      ['judge-assign', '#40558', 'JUD-B'],
      ['judge-assign', '#40576', 'REVIEW-1'],
    ]);
    // judge: 1 ⊕ 6 items → the one batch holds 5, the 6th waits for the next tick (tick-cap), never «no hand».
    expect(planJudge(roster(), { scope: live({ judge: 1 }), state: emptyScopeState() }).map((r) => [r.action, r.seat ?? r.reason]))
      .toEqual([['judge-assign', 'JUD-B'], ['judge-assign', 'JUD-B'], ['judge-assign', 'JUD-B'], ['judge-assign', 'JUD-B'], ['judge-assign', 'JUD-B'], ['defer', 'tick-cap']]);
  });

  test('every judge cooling after a batch: the defer says so (not «no-judge-hand»); an asked cell is not re-asked within 2 h', () => {
    const state = emptyScopeState();
    for (const seat of ['JUD-3', 'JUD-B', 'JUD-C', 'REVIEW-1']) state.seatCooldown[seat] = ago(10);
    expect([...new Set(planJudge(roster(), { scope: live(), state }).map((r) => `${r.action}:${r.reason}`))])
      .toEqual(['defer:no-free-judge-hand:cooling=4,fresh=0,busy=0']);
    const asked = emptyScopeState();
    asked.judgeAssigned['cell:BULLETIN-NOW-STALE'] = { seat: 'JUD-B', at: ago(90) };
    asked.judgeAssigned['cell:SIM-WORLD-JUDGING'] = { seat: 'JUD-3', at: ago(121) };
    expect(planJudge(roster(), { scope: live({ judge: 4 }), state: asked }).map((r) => r.target))
      .toEqual(['CLAUDE-OP-PROXY-BUS', 'LEDGER-DRIVEN-UMBRELLA', 'SIM-WORLD-JUDGING', '#40558', '#40576']);
  });

  test('no butler facts (source error) → R3 still judges open PRs with the idle judges', () => {
    const rows = planJudge(roster({ judgeCells: undefined, sourceErrors: ['judgeCells: butler last tick 75m old'] }), { scope: live(), state: emptyScopeState() });
    expect(rows.map((r) => [r.action, r.target, r.seat])).toEqual([['judge-assign', '#40558', 'JUD-B'], ['judge-assign', '#40576', 'REVIEW-1']]);
  });
});
