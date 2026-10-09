import { describe, expect, spyOn, test } from 'bun:test';
import { createPack } from './kgs/pack.js';
import type { KnowledgeCard } from './kgs/types.js';
import { KgsSqliteStore } from './kgs/sqlite-store.js';
import { queryInstalledPack } from './query.js';
import { Command } from 'commander';
import { registerKnowCommand } from '../cli/know-cli.js';
import { knowFind, type DirectiveRow as KnowDirectiveRow, type KnowFindDeps } from './know-find.js';
import { debug } from '../debug/log.js';
// directive-index is excluded from the public export — describe the full index row here instead of importing it.
type DirectiveRow = KnowDirectiveRow & { agent: string; session_id: string; cwd: string | null; track: string | null;
  released: string | null; dev: string | null; codename: string | null };
import { DecisionLedger, type DecisionEntry, type SeatDecisionRecord } from '../decisions/decision-ledger.js';
import type { LessonRow } from '../lessons/lesson-ledger.js';

const at = '2026-10-01T00:00:00.000Z';
const directive: DirectiveRow = { ts: at, agent: 'elanous', session_id: 'session', cwd: null, track: null,
  released: null, dev: null, codename: null, text: 'AUTHOR-POD 기본 꺼짐', source_file: '/tmp/ask.md', line_no: 8 };
const decision = (id: string, status: DecisionEntry['status'], title: string): DecisionEntry => ({
  id, title, category: 'scope', scqa: { s: 'AUTHOR-POD 상황', c: '기본 꺼짐', a: '기준 유지' },
  options: [], recommendation: { skipped: true, reason: '미상' }, raisedBy: { agent: 'owner' },
  status, raisedAt: at, history: [],
});
const seatDecision: SeatDecisionRecord = { id: 'SD-20261006-01', title: '0.2.11 A안', decision: 'ST1e 연기',
  seat: 'OP', delegation: '일정 17:00', reporting: 'posthoc', recordedAt: '2026-10-06T09:00:00Z',
  decidedAt: '2026-10-06T08:00:00Z' };
const lesson: LessonRow = { id: 'L1', incident: 'AUTHOR-POD 장애', cause: '기본 꺼짐', remedy: '확인',
  enforced_by: '', disproof: null, owner: 'TC', status: 'candidate', created_at: at, updated_at: at, occurrence_count: 2 };

function sources(): KnowFindDeps {
  return {
    directives: () => [directive], decisions: () => [decision('D-open', 'open', 'AUTHOR-POD 열린 결정'),
      decision('D-closed', 'decided', 'AUTHOR-POD 닫힌 결정')],
    seatDecisions: () => [],
    checklist: (version) => ({ version, released: '1.0.0', dev: '1.0.1', history: [],
      items: version === '1.0.0' ? [{ id: 'K1', title: 'AUTHOR-POD 칸', status: 'yellow', updatedAt: at, updatedBy: 'TC' }] : [] }),
    lessons: () => [lesson], versions: () => ['1.0.0', '1.0.1'], now: () => new Date('2026-10-05T00:00:00Z'),
  };
}

describe('knowFind', () => {
  test('returns five rows across four existing readers with current entries before closed decisions', () => {
    const calls: string[] = [];
    const deps = sources();
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const found = knowFind('AUTHOR-POD', {
        ...deps, directives: (query) => { calls.push(`directive:${query}`); return deps.directives(query); },
        decisions: () => { calls.push('decision'); return deps.decisions(); },
        seatDecisions: () => { calls.push('seat-decision'); return deps.seatDecisions(); },
        checklist: (version) => { calls.push(`checklist:${version}`); return deps.checklist(version); },
        lessons: (query) => { calls.push(`lesson:${query}`); return deps.lessons(query); },
      });
      expect(calls).toEqual(['directive:AUTHOR-POD', 'decision', 'seat-decision', 'checklist:1.0.0', 'checklist:1.0.1', 'lesson:AUTHOR-POD']);
      expect(found.rows).toHaveLength(5);
      expect(found.unavailable).toEqual([]);
      expect(found.rows.map(row => row.source)).toEqual(expect.arrayContaining(['directive', 'decision', 'checklist', 'lesson']));
      const closed = found.rows.findIndex(row => row.id === 'D-closed');
      expect(found.rows.findIndex(row => row.id === 'D-open')).toBeLessThan(closed);
      expect(found.rows.findIndex(row => row.id === 'K1')).toBeLessThan(closed);
      expect(found.rows.find(row => row.id === 'L1')).toMatchObject({ current: true, ref: 'lesson show L1' });
      expect(log).toHaveBeenCalledWith('knowledge.know', 'query', {
        query: 'AUTHOR-POD', counts: { directive: 1, decision: 2, checklist: 1, lesson: 1 }, unavailable: [],
      });
    } finally { log.mockRestore(); }
  });

  test('lesson reader failure retains the other four rows and its reason instead of treating it as zero matches', () => {
    const found = knowFind('AUTHOR-POD', { ...sources(), lessons: () => { throw new Error('lesson offline'); } });
    expect(found.rows).toHaveLength(4);
    expect(found.unavailable).toEqual([{ source: 'lesson', reason: 'lesson offline' }]);
  });

  test('matches decision SCQA and checklist id by question words; stale directives do not count as current', () => {
    const deps = sources();
    const found = knowFind('AUTHOR-POD', { ...deps, directives: () => [{ ...directive, ts: '2026-08-01T00:00:00Z' }] });
    expect(found.rows.find(row => row.source === 'directive')?.current).toBe(false);
    expect(found.rows.find(row => row.id === 'D-closed')?.current).toBe(false);
  });

  test('searches seat title, decision and delegation with all query words and emits the seat-report reference', () => {
    const deps = { ...sources(), directives: () => [], lessons: () => [], seatDecisions: () => [seatDecision] };
    expect(knowFind('A안', deps).rows).toEqual([{
      source: 'decision', id: 'SD-20261006-01', title: '0.2.11 A안', status: 'seat-posthoc',
      at: '2026-10-06T08:00:00Z', current: false, ref: 'decisions seat-report --seat OP',
    }]);
    expect(knowFind('0.2.11 ST1e 17:00', deps).rows.map(row => row.id)).toEqual(['SD-20261006-01']);
    expect(knowFind('A안 불일치', deps).rows).toEqual([]);
    expect(knowFind('17:00', { ...deps, seatDecisions: () => [{ ...seatDecision, decidedAt: undefined }] }).rows[0]?.at)
      .toBe(seatDecision.recordedAt);
  });

  test('default seat reader uses DecisionLedger.seatReport without changing the representative reader', () => {
    const readSeat = spyOn(DecisionLedger.prototype, 'seatReport').mockReturnValue([seatDecision]);
    try {
      const { seatDecisions: _seatDecisions, ...otherSources } = sources();
      const found = knowFind('A안', { ...otherSources, directives: () => [], lessons: () => [] });
      expect(readSeat).toHaveBeenCalledTimes(1);
      expect(found.rows.map(row => row.id)).toEqual(['SD-20261006-01']);
    } finally { readSeat.mockRestore(); }
  });

  test('registerKnowCommand executes the existing knowFind path for seat decisions', async () => {
    const output: string[] = [];
    const program = new Command();
    registerKnowCommand(program, { ...sources(), directives: () => [], lessons: () => [], seatDecisions: () => [seatDecision] },
      { log: (line) => { output.push(line); }, error: (line) => { output.push(line); } });
    await program.parseAsync(['know', 'A안'], { from: 'user' });
    expect(output).toEqual(['[decision] SD-20261006-01 · 0.2.11 A안 · seat-posthoc']);
  });

  test('selected installed pack returns only its indexed cards, with citations; old CLI sources stay unchanged', async () => {
    const store = new KgsSqliteStore(':memory:');
    try {
      const card: KnowledgeCard = { schema_version: 2, id: 'card-1', title: '반도체 식각', body: '식각 온도는 40도',
        kind: 'card', createdAt: at, updatedAt: at, author: 'test', nature: 'fact', reliability: 'verified',
        source: { kind: 'manual' }, tags: [] };
      store.writePack(createPack({ id: { slug: 'fab-knowledge', version: '1.0.0' }, title: '공정', intent: '공정 지식',
        audience: 'team', kind: 'generic', author: 'test', cards: [card] }));
      store.writePack(createPack({ id: { slug: 'other-pack', version: '1.0.0' }, title: '다른 팩', intent: '비공개',
        audience: 'team', kind: 'generic', author: 'test', cards: [{ ...card, id: 'card-2', body: '식각 온도는 99도' }] }));
      const pack = (id: string, query: string) => queryInstalledPack(id, query, store);
      expect(pack('pack:fab-knowledge@1.0.0', '식각')).toMatchObject([{ body: '식각 온도는 40도', ref: 'pack:fab-knowledge@1.0.0#card-1' }]);
      expect(pack('pack:fab-knowledge@1.0.0', '99도')).toEqual([]);
      expect(() => pack('pack:missing-pack@1.0.0', '식각')).toThrow('pack not installed');
      const deps = { ...sources(), pack };
      const found = knowFind('식각', deps, 'pack:fab-knowledge@1.0.0');
      expect(found.rows.filter(row => row.source === 'pack')).toMatchObject([{ title: '반도체 식각', ref: 'pack:fab-knowledge@1.0.0#card-1' }]);
      expect(knowFind('AUTHOR-POD', deps).rows).toHaveLength(5);
      const output: string[] = [];
      const program = new Command();
      registerKnowCommand(program, deps, { log: line => { output.push(line); }, error: line => { output.push(line); } });
      await program.parseAsync(['know', 'AUTHOR-POD'], { from: 'user' });
      expect(output.some(line => line.includes('[pack]'))).toBe(false);
    } finally { store.close(); }
  });

  test('seat-report failure records decision unavailable and retains representative decisions in their original order', () => {
    const deps = sources();
    const before = knowFind('AUTHOR-POD', deps).rows;
    const found = knowFind('AUTHOR-POD', { ...deps, seatDecisions: () => { throw new Error('seat-report offline'); } });
    expect(found.rows).toEqual(before);
    expect(found.rows.filter(row => row.source === 'decision').map(row => row.id)).toEqual(['D-open', 'D-closed']);
    expect(found.unavailable).toEqual([{ source: 'decision', reason: 'seat-report offline' }]);
  });
});
