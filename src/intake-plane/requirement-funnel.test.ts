import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureFunnelCandidates, collectFunnelCandidates, runRequirementFunnel, type DirectiveRow, type FunnelDirectiveRow, type IncomingRequirement, type RequirementSources } from './requirement-funnel.js';
import { RequirementLedger } from '../requirements/requirement-ledger.js';
import { debug } from '../debug/log.js';
import type { TaskCard } from '../task-cards/card-store.js';
import type { IntakeItem } from './items.js';

const now = new Date('2026-10-06T00:00:00Z');
const directive: DirectiveRow = { ts: '2026-10-05T01:00:00Z',
  track: 'OP', text: '새 요구', source_file: '/tmp/directive.jsonl', line_no: 2 };
const intake = (id: string, text: string): IntakeItem => ({ id, source: 'github', sources: ['github'], kind: 'repo', text,
  url: `https://example.test/${id}`, observedAt: '2026-10-05T02:00:00Z', lastSeenAt: '2026-10-05T02:00:00Z',
  signals: {}, privacy: 'public', status: 'new', outputs: [] });
const grounding: IncomingRequirement = { id: 'ground', text: '그라운딩 요구', link: 'https://example.test/ground', receivedAt: '2026-10-05T03:00:00Z' };
const placement = { schedules: [{ version: '0.2.18', cutAt: '2026-10-07T00:00:00Z', landBy: '2026-10-08T00:00:00Z', updatedAt: directive.ts, updatedBy: 'OP' }],
  released: '0.2.17', merged24h: 50, seatCap: { OP: 100 }, checklist: (version: string) => ({ version, released: '0.2.17', dev: version, items: [], history: [] }) };
const reqLedger = () => new RequirementLedger({ stateDir: mkdtempSync(join(tmpdir(), 'req-funnel-')), now: () => now });
const captureSources: RequirementSources = {
  directives: [directive],
  intake: [intake('cap-one', '흡수 요구')],
  grounding: [grounding],
  coordination: [{ id: 'cap-coord', text: '조율 요구', link: 'coord:9', receivedAt: directive.ts, priority: 'P1' }],
  linear: [{ id: 'cap-lin', text: 'Linear 요구', link: 'linear:9', receivedAt: directive.ts, priority: 'P2' }],
};

test('five adapters, per-source counts, cross-source normalization and directive precedence', () => {
  const result = runRequirementFunnel({ now, cells: [], sources: { directives: [directive], intake: [intake('one', ' 새   요구 '), intake('two', '유료 의존')],
    grounding: [grounding], coordination: [{ id: 'coord', text: '조율', link: 'coord:1', receivedAt: directive.ts }],
    linear: [{ id: 'lin', text: 'Linear', link: 'linear:1', receivedAt: directive.ts }] }, placement });
  expect(result.counts).toEqual({ directive: 1, intake: 2, grounding: 1, coordination: 1, linear: 1 });
  expect(result.candidates).toBe(5);
  expect(result.decisions[0]?.sources.map(source => source.source)).toEqual(['directive', 'intake']);
  expect(result.unlinkedDirectives.map(source => source.text)).toEqual(['새 요구']);
  expect(result.briefItems.some(item => item.priority === 'P0' && item.domain === '판')).toBe(true);
});

test('linked directive is adopted even when shadow; paid intake is proposed; shadow writes no cells', () => {
  let writes = 0;
  const result = runRequirementFunnel({ now, cells: [{ version: '0.2.18', item: { id: 'REQ-1', title: '새 요구',
    status: 'yellow', updatedAt: directive.ts, updatedBy: 'OP', evidence: '/tmp/directive.jsonl#L2' } }],
  sources: { directives: [directive], intake: [intake('paid', '유료 의존'), intake('safe', '안전 요구')], grounding: [grounding] },
  dailyCap: 2, allowedLicenses: ['MIT'], placement, adopt: () => { writes++; } });
  expect(result.candidates).toBe(4);
  expect(result.decisions[0]).toMatchObject({ status: 'adopted', cellId: 'REQ-1', version: '0.2.18' });
  expect(result.decisions[1]).toMatchObject({ status: 'proposal', reason: 'P1/P2 판정 없음' });
  expect(writes).toBe(0);
  expect(result.unlinkedDirectives).toEqual([]);
});

test('ABSORB-ADOPT accepts only explicitly evidenced safe work within the configured cap; shadow vs live', () => {
  const safe: IncomingRequirement = { id: 'safe', text: '안전 요구', link: 'https://example.test/safe', receivedAt: directive.ts,
    priority: 'P2', risk: 1, cost: 0, security: 0, license: 'MIT', patentPrivatePath: false };
  let writes = 0;
  const base = { now, cells: [], sources: { grounding: [safe] }, dailyCap: 1, allowedLicenses: ['MIT'], placement,
    adopt: () => { writes++; } };
  expect(runRequirementFunnel(base).decisions[0]).toMatchObject({ status: 'would-adopt', version: '0.2.18' });
  expect(writes).toBe(0);
  expect(runRequirementFunnel({ ...base, mode: 'live' }).decisions[0]?.status).toBe('adopted');
  expect(writes).toBe(1);
  expect(runRequirementFunnel({ ...base, adoptedToday: 1 }).decisions[0]).toMatchObject({ status: 'proposal', reason: '하루 상한 도달' });
  expect(runRequirementFunnel({ ...base, dailyCap: undefined }).decisions[0]).toMatchObject({ status: 'proposal', reason: '하루 상한 미설정' });
  expect(runRequirementFunnel({ ...base, sources: { grounding: [{ ...safe, cost: 1 }] } }).decisions[0]).toMatchObject({ status: 'proposal', reason: '돈 0 미확인' });
  expect(runRequirementFunnel({ ...base, sources: { grounding: [{ ...safe, risk: Number.NaN }] } }).decisions[0]).toMatchObject({ status: 'proposal', reason: '위험≤1 미확인' });
});

test('older unlinked directive is counted in the backlog but only the last 24 hours are named at P0', () => {
  const older = { ...directive, text: '예전 요구', ts: '2026-09-01T00:00:00Z', line_no: 1 };
  const result = runRequirementFunnel({ now, cells: [], sources: { directives: [directive] }, historicalDirectives: [older], placement });
  expect(result.counts.directive).toBe(1);
  expect(result.unlinkedDirectives.map(row => row.text)).toEqual(['예전 요구', '새 요구']);
  const p0 = result.briefItems.find(item => item.priority === 'P0')?.text;
  expect(p0).toContain('최근 24시간 1: 새 요구');
  expect(p0).toContain('전체 누계 2');
  expect(p0).not.toContain('예전 요구');
});

test('directive is an adoption target even when RUBRIC-PLACE cannot place it', () => {
  const result = runRequirementFunnel({ now, cells: [], sources: { directives: [directive] }, placement: {
    ...placement, schedules: [],
  } });
  expect(result.decisions[0]).toMatchObject({ status: 'would-adopt', rubric: expect.stringContaining('판 배치 보류') });
  expect(result.unlinkedDirectives).toHaveLength(1);
});

test('a backlog with nothing in the last 24 hours is one P1 count line, never a P0 list', () => {
  const history = Array.from({ length: 7 }, (_, n) => ({ ...directive, text: `옛 요구 ${n}`, ts: `2026-09-0${n + 1}T00:00:00Z`, line_no: 10 + n }));
  const result = runRequirementFunnel({ now, cells: [], sources: {}, historicalDirectives: history, placement });
  expect(result.unlinkedDirectives).toHaveLength(7);
  expect(result.briefItems.filter(item => item.priority === 'P0')).toHaveLength(0);
  const line = result.briefItems.filter(item => item.text.startsWith('대표 지시 중 아직 칸 없는 것'));
  expect(line).toHaveLength(1);
  expect(line[0]).toMatchObject({ priority: 'P1', text: '대표 지시 중 아직 칸 없는 것 — 최근 24시간 0 · 전체 누계 7' });
});

test('recent unlinked directives are one P0 line: a few named oldest first, the rest counted, plus the full backlog', () => {
  const recent = Array.from({ length: 7 }, (_, n) => ({ ...directive, text: `새 요구 ${n}`, ts: `2026-10-05T0${n + 1}:00:00Z`, line_no: 20 + n }));
  const older = { ...directive, text: '예전 요구', ts: '2026-09-01T00:00:00Z', line_no: 1 };
  const result = runRequirementFunnel({ now, cells: [], sources: {}, historicalDirectives: [older, ...recent], placement });
  const p0 = result.briefItems.filter(item => item.priority === 'P0');
  expect(p0).toHaveLength(1);
  expect(p0[0]?.text).toContain('최근 24시간 7: 새 요구 0');
  expect(p0[0]?.text).not.toContain('새 요구 6');
  expect(p0[0]?.text).toContain('외 2');
  expect(p0[0]?.text).toContain('전체 누계 8');
  expect(p0[0]?.text).not.toContain('예전 요구');
});

const funnelDirective: FunnelDirectiveRow = {
  ts: '2026-10-06T00:00:00Z', session_id: 's1', track: null,
  text: '요구 깔때기 만들어 루브릭: A3 E2 R2 D1 M1 B1 S1 X0\n상세 줄', source_file: 'session.jsonl', line_no: 7,
};
const funnelIntake: IntakeItem = {
  id: 'ix1', source: 'github', sources: ['github'], kind: 'repo', title: 'repo X',
  text: '루브릭 없음', observedAt: '', lastSeenAt: '', signals: {}, privacy: 'public', status: 'new', outputs: [],
};
const funnelWish: TaskCard = { id: 'c1', goalId: 'wish:linear:ENG-12', title: '소원 하나', status: 'open', createdAt: '', sections: [] };

const funnelFixtures = {
  directives: [funnelDirective],
  intakeItems: [funnelIntake, { ...funnelIntake, id: 'ix2', status: 'discarded' as const }],
  cards: [funnelWish, { ...funnelWish, id: 'c2', goalId: 'goal:x' }, { ...funnelWish, id: 'c3', goalId: 'wish:pwa:9', status: 'closed' as const }],
};

test('collects eligible directive, intake, wish and scores only explicit rubrics', () => {
  const input = structuredClone(funnelFixtures);
  const rows = collectFunnelCandidates(input);
  expect(rows.map(({ source, id }) => [source, id])).toEqual([
    ['directive', 's1:7'], ['intake', 'ix1'], ['wish', 'wish:linear:ENG-12'],
  ]);
  expect(rows[0]).toEqual({ source: 'directive', id: 's1:7', title: '요구 깔때기 만들어 루브릭: A3 E2 R2 D1 M1 B1 S1 X0', score: 17, grade: 'P1' });
  expect(rows.slice(1).map(({ score, grade }) => [score, grade])).toEqual([[null, null], [null, null]]);
  expect(input).toEqual(funnelFixtures);
});

test('sorts scored candidates first, with stable original order for equal scores and nulls; truncates first title line', () => {
  const rows = collectFunnelCandidates({
    directives: [{ ...funnelDirective, text: 'plain\nother', line_no: 8 }, funnelDirective],
    intakeItems: [{ ...funnelIntake, id: 'ix3', title: 'z'.repeat(82) + '\nother', text: '루브릭: A1 E1 R1 D1 M1 B1 S1 X0' }, funnelIntake],
    cards: [funnelWish],
  });
  expect(rows.map((row) => row.id)).toEqual(['s1:7', 'ix3', 's1:8', 'ix1', 'wish:linear:ENG-12']);
  expect(rows[1]!.title).toBe('z'.repeat(80));
});

// ── REQ-INTAKE-ALL (0.2.25) 첫 조각 — 입구 다섯을 REQ-LEDGER 에 capture ──
test('REQ-INTAKE-ALL ①: five entrance candidates each capture one captured row (fr · tags=[priority])', () => {
  const store = reqLedger();
  const events: { category: unknown; event: unknown; payload: unknown }[] = [];
  const spy = spyOn(debug, 'log').mockImplementation(((...args: unknown[]) =>
    events.push({ category: args[0], event: args[1], payload: args[2] })) as typeof debug.log);
  try {
    runRequirementFunnel({ now, cells: [], sources: captureSources, placement, ledger: store });
    const rows = store.list();
    expect(rows).toHaveLength(5);
    expect(rows.map(row => [row.source.kind, row.statement, row.status, row.kind, row.tags])).toEqual(expect.arrayContaining([
      ['directive', '새 요구', 'captured', 'fr', ['P2']],
      ['intake', '흡수 요구', 'captured', 'fr', ['P1']],
      ['grounding', '그라운딩 요구', 'captured', 'fr', ['P1']],
      ['coordination', '조율 요구', 'captured', 'fr', ['P1']],
      ['linear', 'Linear 요구', 'captured', 'fr', ['P2']],
    ]));
    expect(events.filter(entry => entry.category === 'requirements.intake' && entry.event === 'captured')
      .map(entry => entry.payload)).toEqual(expect.arrayContaining([
      { source: 'directive', count: 1 }, { source: 'intake', count: 1 }, { source: 'grounding', count: 1 },
      { source: 'coordination', count: 1 }, { source: 'linear', count: 1 },
    ]));
  } finally { spy.mockRestore(); }
});

test('REQ-INTAKE-ALL ②: running the same candidates twice adds no row (idempotent on candidate id)', () => {
  const store = reqLedger();
  const first = runRequirementFunnel({ now, cells: [], sources: captureSources, placement, ledger: store });
  expect(store.list()).toHaveLength(5);
  captureFunnelCandidates(first.decisions, store);
  expect(store.list()).toHaveLength(5);
  runRequirementFunnel({ now, cells: [], sources: captureSources, placement, ledger: store });
  expect(store.list()).toHaveLength(5);
});

test('REQ-INTAKE-ALL ③: adopted candidates fold to placed, others stay captured', () => {
  const store = reqLedger();
  const result = runRequirementFunnel({ now, cells: [{ version: '0.2.18', item: { id: 'REQ-1', title: '새 요구',
    status: 'yellow', updatedAt: directive.ts, updatedBy: 'OP', evidence: '/tmp/directive.jsonl#L2' } }],
  sources: { directives: [directive], grounding: [grounding] }, placement, ledger: store });
  const [adopted] = result.decisions;
  expect(adopted).toMatchObject({ status: 'adopted', cellId: 'REQ-1', version: '0.2.18' });
  const directiveRow = store.list().find(row => row.source.kind === 'directive');
  expect(directiveRow?.id).toBe(adopted?.candidate.id);
  expect(directiveRow?.status).toBe('placed');
  expect(store.list().find(row => row.source.kind === 'grounding')?.status).toBe('captured');
  captureFunnelCandidates(result.decisions, store);
  expect(store.list()).toHaveLength(2);
  expect(store.list().find(row => row.source.kind === 'directive')?.status).toBe('placed');
});

test('REQ-INTAKE-ALL ④: offset times are stored as UTC Z and one failing candidate does not stop the rest', () => {
  const first = runRequirementFunnel({ now, cells: [], sources: captureSources, placement });
  const decisions = first.decisions.map((decision, index) => ({ ...decision, sources: decision.sources.map(candidate => ({
    ...candidate,
    receivedAt: index === 0 ? 'not-a-date' : index === 1 ? candidate.receivedAt.replace(/Z$/, '+00:00').replace(/\.\d{3}\+/, '+') : candidate.receivedAt,
  })) }));
  const store = reqLedger();
  const events: { category: unknown; event: unknown; payload: unknown }[] = [];
  const spy = spyOn(debug, 'log').mockImplementation(((...args: unknown[]) =>
    events.push({ category: args[0], event: args[1], payload: args[2] })) as typeof debug.log);
  try {
    captureFunnelCandidates(decisions, store);
  } finally { spy.mockRestore(); }
  const total = decisions.reduce((sum, decision) => sum + decision.sources.length, 0);
  const failedIds = decisions[0]!.sources.map(candidate => candidate.id);
  expect(store.list()).toHaveLength(total - failedIds.length);
  expect(store.list().every(row => row.source.at.endsWith('Z'))).toBe(true);
  expect(events.filter(entry => entry.event === 'ledger-capture-failed').map(entry => (entry.payload as { id: string }).id)).toEqual(failedIds);
});
