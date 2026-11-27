// OP-NEXT-BEST-ACTION 3/3 — turn-end outcome check and the goal line from top cells. Expectations are literals (rule 11).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Fact } from '../fed-state/ledger.js';
import { classifyTurns, turnOutcomeLines } from './op-turn-outcome.js';
import { retroDraft } from './trigger-nodes.js';
import { goalNoteFromCells } from './op-next-action.js';

const T = (hhmm: string) => `2026-11-26T${hhmm}:00.000Z`;
const since = new Date(T('09:00')); const until = new Date(T('10:00'));

// One hour of OP on 11-26 (shape): a mail-only turn, a turn that assigned, a beat turn, a quiet turn, a request turn.
const facts: Fact[] = [
  { ts: T('09:01'), type: 'turn', seat: 'OP', state: 'mail' },
  { ts: T('09:02'), type: 'mail', state: 'post', from: 'OP', to: 'STEWARD', kind: 'request' },
  { ts: T('09:03'), type: 'mail', state: 'post', from: 'OP', to: 'TC', kind: 'coord' },
  { ts: T('09:10'), type: 'turn', seat: 'OP', state: 'internal' },
  { ts: T('09:11'), type: 'cell', seat: 'OP', cell: 'UX-12', state: 'claim' },
  { ts: T('09:11'), type: 'mail', state: 'post', from: 'OP', to: 'UX-H1', kind: 'assign' },
  { ts: T('09:20'), type: 'turn', seat: 'OP', state: 'internal' },
  { ts: T('09:21'), type: 'mail', state: 'post', from: 'OP', to: 'TC', kind: 'beat' },
  { ts: T('09:30'), type: 'turn', seat: 'OP', state: 'wake' },
  { ts: T('09:40'), type: 'turn', seat: 'OP', state: 'mail' },
  { ts: T('09:41'), type: 'cell', seat: 'TC', cell: 'X', state: 'green' },
  { ts: T('09:42'), type: 'mail', state: 'post', from: 'OP', to: 'UX', kind: 'request' },
  { ts: T('09:43'), type: 'mail', state: 'post', from: 'OP', to: 'OP', kind: 'request' },
  { ts: T('08:59'), type: 'turn', seat: 'OP', state: 'mail' },
  { ts: T('09:50'), type: 'turn', seat: 'TC', state: 'mail' },
];

describe('classifyTurns', () => {
  test('each OP turn runs to the next start; another seat\'s state change or a self-mail does not count', () => {
    const turns = classifyTurns(facts, { seat: 'OP', since, until });
    expect(turns.map(t => t.verdict)).toEqual(['requests-only', 'acted', 'acted', 'quiet', 'requests-only']);
    expect(turns[0]).toMatchObject({ startedAt: T('09:01'), endedAt: T('09:10'), opener: 'mail', stateChanges: 0, requests: ['request→STEWARD', 'coord→TC'] });
    expect(turns[1]).toMatchObject({ stateChanges: 1, outputs: ['assign→UX-H1'] });
    expect(turns[4]).toMatchObject({ endedAt: T('10:00'), requests: ['request→UX'] });
  });
  test('retro lines: the count, then each request-only turn (KST clock)', () => {
    expect(turnOutcomeLines(classifyTurns(facts, { seat: 'OP', since, until }))).toEqual([
      '- 턴 결과: OP 턴 5 · 행동 2 · ⚠ 요청만(상태 변화 0) 2 · 조용 1',
      '  ⚠ 18:01 (mail) 우편 2통 request→STEWARD coord→TC · 상태 변화 0 — 요청 대신 했어야 할 일은 다음 펄스 NEXT ACTION',
      '  ⚠ 18:40 (mail) 우편 1통 request→UX · 상태 변화 0 — 요청 대신 했어야 할 일은 다음 펄스 NEXT ACTION',
    ]);
    expect(turnOutcomeLines([])).toEqual(['- 턴 결과: OP 턴 0 (fed-state turn 사실 없음)']);
  });
});

describe('retro draft carries the turn outcome', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'op-turn-outcome-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = (turnOutcome: boolean) => ({ graphId: 'op-retro', runId: 'r1',
    input: { stage: 'shadow' as const, window: T('10:16'), attempt: 1, shadowDir: join(dir, 'shadow'), vars: { stateRoot: join(dir, 'state'), seatState: join(dir, 'seat') } },
    nodeInput: { seat: 'OP', file: '{seatState}/OP/retro/R.md', measures: [], ...(turnOutcome ? { turn_outcome: true } : {}) } });

  test('turn_outcome: true reads the fed-state ledger under the run state root and flags request-only turns', () => {
    mkdirSync(join(dir, 'state', 'fed-state'), { recursive: true });
    writeFileSync(join(dir, 'state', 'fed-state', 'facts.jsonl'), facts.map(f => JSON.stringify(f)).join('\n'));
    retroDraft(ctx(true), { now: () => new Date(T('10:00')), run: () => ({ status: 0, stdout: '', stderr: '' }) });
    const text = readFileSync(join(dir, 'seat', 'OP', 'retro', 'R.md'), 'utf8');
    expect(text).toContain('- 턴 결과: OP 턴 5 · 행동 2 · ⚠ 요청만(상태 변화 0) 2 · 조용 1');
    expect(text).toContain('  ⚠ 18:01 (mail) 우편 2통 request→STEWARD coord→TC');
  });
  test('without turn_outcome the draft is unchanged (no ledger read)', () => {
    mkdirSync(join(dir, 'state', 'fed-state'), { recursive: true });
    writeFileSync(join(dir, 'state', 'fed-state', 'facts.jsonl'), facts.map(f => JSON.stringify(f)).join('\n'));
    retroDraft(ctx(false), { now: () => new Date(T('10:00')) });
    expect(readFileSync(join(dir, 'seat', 'OP', 'retro', 'R.md'), 'utf8')).not.toContain('턴 결과');
  });
});

describe('goal line from the top open cells', () => {
  test('ids of the top three (P0 first, red before yellow), then the rest as a count; no open cell → null', () => {
    const cells = [
      { id: 'P1-OLD', title: 'a', status: 'yellow' as const, priority: 'P1' as const, updatedAt: T('01:00') },
      { id: 'P0-Y', title: 'b', status: 'yellow' as const, priority: 'P0' as const, updatedAt: T('02:00') },
      { id: 'P0-R', title: 'c', status: 'red' as const, priority: 'P0' as const, updatedAt: T('03:00') },
      { id: 'UMB', title: 'd', status: 'yellow' as const, priority: 'P0' as const, dispatchKind: 'umbrella' },
      { id: 'DONE', title: 'e', status: 'green' as const, priority: 'P0' as const },
      { id: 'P2', title: 'f', status: 'yellow' as const, priority: 'P2' as const },
    ];
    expect(goalNoteFromCells(cells)).toBe('P0-R · P0-Y · P1-OLD (+1 open)');
    expect(goalNoteFromCells(cells.filter(c => c.status === 'green'))).toBe(null);
  });
});
