// FED-FACT-OP-ACTIONS sims — seeds 1–5 replay the 11-27 OP hour (mail:ack only → 성과 1) and the same hour with OP's actions
// recorded. Fake ledger paths only; expectations are literals (rule 11).
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRubricPolicy, parseRubricPolicy, recordAction, seatAchievement } from './actions.js';
import { fedKpi, formatFedKpi } from './kpi.js';
import { readFacts, recordFact } from './ledger.js';

const at = (m: number) => new Date(Date.UTC(2026, 10, 27, 2, m)).toISOString(); // 11:00 KST + m
const START = new Date(at(0)); const END = new Date(at(60));
const POLICY = loadRubricPolicy(); // the shipped graphs/policies/fed-rubric.yaml
const ledger = () => join(mkdtempSync(join(tmpdir(), 'fed-act-')), 'facts.jsonl');
function ackHour(p: string): void { for (const m of [3, 9, 21, 33, 48]) recordFact({ ts: at(m), type: 'mail', state: 'ack', seat: 'OP' }, p); }

describe('seed 1 — the 11-27 hour: only mail:ack → 성과 1 · with OP actions recorded → 성과 rises', () => {
  test('acks never count · assign×2 · veto · reassign · ✋ resolve · decision raise · HOLD lift = 7/h → 4/5', () => {
    const p = ledger(); ackHour(p);
    expect(seatAchievement(readFacts({ path: p }).facts, 'OP', START, END, POLICY)).toEqual({ seat: 'OP', actions: 0, perHour: 0, byKind: {}, score: 1 });
    recordAction({ kind: 'assign', by: 'op', cell: 'CELLLESS-PR-AUTO-CELL', to: 'tc', ref: '0.3.38', source: 'seat-assign', ts: at(5) }, p);
    recordAction({ kind: 'assign', by: 'OP', cell: 'FED-FACT-OP-ACTIONS', to: 'UX', ref: '0.3.38', source: 'seat-assign', ts: at(6) }, p);
    recordAction({ kind: 'veto', by: 'OP', cell: 'THROTTLE-AUDIT', why: 'wrong scope', source: 'seat-veto', ts: at(12) }, p);
    recordAction({ kind: 'reassign', by: 'OP', cell: 'LAND-CELL-LINK-ALWAYS', to: 'TC', why: 'TC owns the land graph', source: 'seat-veto', ts: at(14) }, p);
    recordAction({ kind: 'decision', verb: 'resolve', by: 'OP', to: 'TC', ref: 'msg:191500', source: 'msg-hand', ts: at(20) }, p);
    recordAction({ kind: 'decision', verb: 'raise', by: 'OP', ref: 'D-2026-11-27-01', why: 'teamclaude reset', source: 'decisions', ts: at(30) }, p);
    recordFact({ ts: at(40), type: 'hold', seat: 'OP', state: 'lift', ref: 'H-12', decidedBy: 'OP', source: 'hold-ledger' }, p);
    const a = seatAchievement(readFacts({ path: p }).facts, 'OP', START, END, POLICY);
    expect(a).toEqual({ seat: 'OP', actions: 7, perHour: 7, score: 4,
      byKind: { 'cell:assign': 2, 'cell:veto': 1, 'cell:reassign': 1, 'decision:resolve': 1, 'decision:raise': 1, 'hold:lift': 1 } });
  });
});

describe('seed 2 — attribution: by=<actor seat> decides who scores', () => {
  test('TC\'s assign is TC\'s · a green decided by JUD is JUD\'s even with seat=OP · out-of-window facts never count', () => {
    const p = ledger();
    recordAction({ kind: 'assign', by: 'TC', cell: 'A1', to: 'TC-1', source: 'seat-assign', ts: at(10) }, p);
    recordFact({ ts: at(11), type: 'cell', state: 'green', seat: 'OP', cell: 'A2', decidedBy: 'JUD', source: 'checklist' }, p);
    recordAction({ kind: 'decision', verb: 'decide', by: 'OP', ref: 'D-1', source: 'decisions', ts: '2026-11-27T01:59:00.000Z' }, p);
    const facts = readFacts({ path: p }).facts;
    expect(seatAchievement(facts, 'OP', START, END, POLICY).actions).toBe(0);
    expect(seatAchievement(facts, 'TC', START, END, POLICY).byKind).toEqual({ 'cell:assign': 1 });
    expect(seatAchievement(facts, 'JUD', START, END, POLICY).byKind).toEqual({ 'cell:green': 1 });
  });
});

describe('seed 3 — the writer: one typed fact per action · fail-open', () => {
  test('shape · upper-cased seats · one-line why ≤ 120 · empty actor / ledger off → false, never a throw', () => {
    const p = ledger();
    expect(recordAction({ kind: 'reassign', by: 'op', cell: 'X-CELL', to: 'ux', ref: '0.3.38', why: `line one\nline two ${'x'.repeat(200)}`, source: 'seat-veto', ts: at(1) }, p)).toBe(true);
    const [f] = readFacts({ path: p }).facts;
    expect(f).toMatchObject({ type: 'cell', state: 'reassign', seat: 'OP', decidedBy: 'OP', cell: 'X-CELL', to: 'UX', ref: '0.3.38', source: 'seat-veto' });
    expect(f!.kind!.startsWith('line one line two xxx')).toBe(true);
    expect(f!.kind!.length).toBe(120);
    recordAction({ kind: 'decision', verb: 'escalate', by: 'TC', to: 'OP', ref: 'msg:7', source: 'msg-hand', ts: at(2) }, p);
    expect(readFacts({ path: p }).facts[1]).toMatchObject({ type: 'decision', state: 'escalate', seat: 'TC', decidedBy: 'TC', to: 'OP', ref: 'msg:7' });
    expect(recordAction({ kind: 'assign', by: '  ', source: 'seat-assign' }, p)).toBe(false);
    process.env.ELANOUS_FED_STATE_OFF = '1';
    try { expect(recordAction({ kind: 'assign', by: 'OP', source: 'seat-assign' }, p)).toBe(false); } finally { delete process.env.ELANOUS_FED_STATE_OFF; }
    expect(recordAction({ kind: 'assign', by: 'OP', source: 'seat-assign' }, '/dev/null/nope/facts.jsonl')).toBe(false);
    expect(readFacts({ path: p }).facts).toHaveLength(2);
  });
});

describe('seed 4 — the rubric is YAML: count list and steps', () => {
  test('a policy without hold:* does not count the HOLD lift · steps move the score · malformed policy throws', () => {
    const p = ledger();
    recordFact({ ts: at(5), type: 'hold', seat: 'OP', state: 'narrow', decidedBy: 'OP', source: 'hold-ledger' }, p);
    recordAction({ kind: 'veto', by: 'OP', cell: 'A', source: 'seat-veto', ts: at(6) }, p);
    const facts = readFacts({ path: p }).facts;
    const noHold = parseRubricPolicy('achievement:\n  count: [cell:veto]\n  actions_per_hour_steps: [1, 2, 3, 4]\n');
    expect(seatAchievement(facts, 'OP', START, END, noHold)).toMatchObject({ actions: 1, score: 2 });
    expect(seatAchievement(facts, 'OP', START, END, POLICY)).toMatchObject({ actions: 2, score: 2 });
    expect(() => parseRubricPolicy('achievement:\n  count: [mail ack]\n  actions_per_hour_steps: [1, 3, 6, 10]\n')).toThrow('achievement.count');
    expect(() => parseRubricPolicy('achievement:\n  count: [cell:veto]\n  actions_per_hour_steps: [3, 1, 6, 10]\n')).toThrow('actions_per_hour_steps');
  });
});

describe('seed 5 — `eln fed kpi` carries the OP actions line', () => {
  test('ledger with OP actions → «OP actions: …· 성과 N/5» · unreadable rubric → no line, KPI still answers', () => {
    const p = ledger(); ackHour(p);
    for (const m of [5, 15, 25]) recordAction({ kind: 'assign', by: 'OP', cell: `C${m}`, to: 'TC', source: 'seat-assign', ts: at(m) }, p);
    const k = fedKpi({ window: '1h', now: END, path: p });
    expect(k.opAchievement).toMatchObject({ seat: 'OP', actions: 3, score: 3 });
    expect(formatFedKpi(k).split('\n').at(-1)).toBe('OP actions: 3 (3/h) · cell:assign 3 · 성과 3/5');
    const bad = join(mkdtempSync(join(tmpdir(), 'fed-rub-')), 'r.yaml');
    writeFileSync(bad, 'achievement:\n  count: []\n');
    const k2 = fedKpi({ window: '1h', now: END, path: p, rubricPath: bad });
    expect(k2.opAchievement).toBeUndefined();
    expect(formatFedKpi(k2)).not.toContain('OP actions');
    expect(k2.landed).toBe(0);
  });
});
