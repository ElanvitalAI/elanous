import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import type { Checklist, ChecklistItem } from '../release-loop/checklist.js';
import type { ReleaseSchedule } from '../release-loop/release-schedule.js';
import type { ContextNowAnswer } from '../context-bus/context-now.js';
import { dispatchReleaseStatus, RELEASE_STATUS_SPEC, type ReleaseToolDeps } from './release-tool.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); resetElanousConfigDir(); });
const item = (id: string, status: ChecklistItem['status'], extra: Partial<ChecklistItem> = {}): ChecklistItem =>
  ({ id, title: `${id} 제목\n둘째 줄`, status, updatedAt: '', updatedBy: '', ...extra });
const data = (version: string, items: ChecklistItem[] = [], released = '0.2.22'): Checklist =>
  ({ version, dev: '0.2.23', released, items, history: [] });
const fixture = (overrides: Partial<ReleaseToolDeps> = {}): ReleaseToolDeps => ({
  devVersion: () => '0.2.23', checklist: v => data(v), schedule: () => null, latestRun: () => null,
  publishedRecord: () => undefined, ...overrides,
});
const schedule = (version: string, publishAt?: string): ReleaseSchedule => ({
  version, cutAt: '2026-10-10T00:00:00Z', landBy: '2026-10-11T00:00:00Z',
  freezeFrom: '2026-10-09T00:00:00Z', freezeUntil: '2026-10-10T00:00:00Z', publishAt: publishAt ?? null,
  updatedAt: '', updatedBy: '',
});

test('status reads published, missing, malformed and unknown without asserting unpublished; reads actual local record', () => {
  const at = '2026-10-09T02:45:37.371Z';
  for (const [record, state, phrase] of [
    [{ version: '0.2.22', publishedAt: at }, 'published', '발행 판 0.2.22'],
    [undefined, 'no-record', '발행 기록 없음'],
    ['{broken', 'unreadable', '발행 기록 못 읽음'],
  ] as const) {
    const output = dispatchReleaseStatus({}, fixture({ publishedRecord: () => record }));
    expect(output.structured.published).toEqual({ version: '0.2.22', publishedAt: state === 'published' ? at : null, state });
    expect(output.text).toContain(phrase);
    expect(output.text).not.toContain('미발행');
  }
  const unknown = dispatchReleaseStatus({}, fixture({ checklist: v => data(v, [], '') }));
  expect(unknown.structured.published).toEqual({ version: null, publishedAt: null, state: 'unknown' });
  expect(unknown.text).toContain('발행 판 모름');
  expect(unknown.text).not.toContain('미발행');
  const root = mkdtempSync(join(tmpdir(), 'release-topics-'));
  roots.push(root);
  setElanousConfigDir(root);
  mkdirSync(join(root, 'release', '0.2.22'), { recursive: true });
  writeFileSync(join(root, 'release', '0.2.22', 'release.json'), JSON.stringify({ version: '0.2.22', publishedAt: at }));
  const { publishedRecord: _unused, ...real } = fixture();
  expect(dispatchReleaseStatus({}, real).structured.published).toEqual({ version: '0.2.22', publishedAt: at, state: 'published' });
  writeFileSync(join(root, 'release', '0.2.22', 'release.json'), '{broken');
  expect(dispatchReleaseStatus({}, real).structured.published).toEqual({ version: '0.2.22', publishedAt: null, state: 'unreadable' });
  rmSync(join(root, 'release', '0.2.22', 'release.json'));
  expect(dispatchReleaseStatus({}, real).structured.published).toEqual({ version: '0.2.22', publishedAt: null, state: 'no-record' });
  expect(RELEASE_STATUS_SPEC.description).toContain('컷 언제');
  expect(RELEASE_STATUS_SPEC.description).toContain('Grep');
});

test('status retains cards and release entries and appends publication time', () => {
  const output = dispatchReleaseStatus({}, fixture({ schedule: v => schedule(v, '2026-10-11T02:00:00Z') }));
  expect(output.text).toContain('```elanous-card');
  expect(output.text).toContain('발행 11:00 KST');
  expect((output.structured.releases as Array<{ schedule: ReleaseSchedule }>)[0]?.schedule.publishAt).toBe('2026-10-11T02:00:00Z');
});

test('features reads every status including done and limits output at 60 with total', () => {
  const four = [item('G', 'green', { owner: 'OP', priority: 'P0' }), item('Y', 'yellow'), item('R', 'red'), item('D', 'done')];
  const deps = fixture({ checklist: v => data(v, four) });
  const out = dispatchReleaseStatus({ topic: 'features', version: '0.2.24' }, deps);
  expect(out.structured).toMatchObject({ version: '0.2.24', total: 4, truncated: false, counts: { green: 1, yellow: 1, red: 1, done: 1 } });
  expect(out.structured.items).toEqual([
    { id: 'G', title: 'G 제목', status: 'green', owner: 'OP', priority: 'P0' },
    { id: 'Y', title: 'Y 제목', status: 'yellow', owner: null, priority: null },
    { id: 'R', title: 'R 제목', status: 'red', owner: null, priority: null },
    { id: 'D', title: 'D 제목', status: 'done', owner: null, priority: null },
  ]);
  const many = dispatchReleaseStatus({ topic: 'features' }, fixture({ checklist: v => data(v, Array.from({ length: 61 }, (_, i) => item(`I${i}`, 'done'))) }));
  expect((many.structured.items as unknown[]).length).toBe(60);
  expect(many.structured).toMatchObject({ total: 61, truncated: true, counts: { done: 61 } });
});

test('cell checks dev then next then released, reports searched scope only and first-line evidence', () => {
  const deps = fixture({ checklist: v => data(v, v === '0.2.24' ? [item('TUI-OPS-QA', 'yellow', { evidence: '첫 근거\n숨긴 줄' })] : []) });
  const found = dispatchReleaseStatus({ topic: 'cell', id: 'TUI-OPS-QA' }, deps);
  expect(found.structured).toMatchObject({ found: true, version: '0.2.24', item: { id: 'TUI-OPS-QA', evidence: '첫 근거' } });
  expect(found.text).not.toContain('숨긴 줄');
  const missing = dispatchReleaseStatus({ topic: 'cell', id: 'NOPE' }, deps);
  expect(missing.structured).toEqual({ found: false, searched: ['0.2.23', '0.2.24', '0.2.22'] });
  expect(missing.text).toContain('살핀 판');
  expect(dispatchReleaseStatus({ topic: 'cell', id: 'NOPE', version: '0.2.30' }, deps).structured).toEqual({ found: false, searched: ['0.2.30'] });
});

test('schedule selects releases later than released, numerically ordered and formats publication', () => {
  const out = dispatchReleaseStatus({ topic: 'schedule' }, fixture({ schedules: () => [schedule('0.2.24', '2026-10-11T02:00:00Z'), schedule('0.2.21'), schedule('0.2.23')] }));
  expect((out.structured.schedules as ReleaseSchedule[]).map(s => s.version)).toEqual(['0.2.23', '0.2.24']);
  expect(out.structured.schedules).toMatchObject([{ freezeFrom: '2026-10-09T00:00:00Z', freezeUntil: '2026-10-10T00:00:00Z' }, { publishAt: '2026-10-11T02:00:00Z' }]);
  expect(out.text).toContain('발행');
  expect(out.text).not.toContain('0.2.21');
});

test('ops preserves operational facts including unreadable; invalid topic throws', () => {
  const facts: ContextNowAnswer['facts'] = [
    { kind: 'run', goal: 'goal', phase: 'build', elapsed: '3분', source: 'run://1' },
    { kind: 'release', version: '0.2.23', node: 'publish', status: 'running', source: 'release://1' },
    { kind: 'schedule-late', count: null, names: [], source: 'schedule://1', unreadable: '실패' },
    { kind: 'cell', version: '0.2.23', id: 'OTHER', title: '', status: 'green', owner: null, source: 'cell://1' },
  ];
  let received: unknown;
  const out = dispatchReleaseStatus({ topic: 'ops' }, fixture({ contextNow: options => {
    received = options;
    return { at: '', topic: null, facts, events: [], guide: [] };
  } }));
  expect(received).toEqual({});
  expect(out.structured.facts).toEqual(facts.slice(0, 3));
  expect(out.text).toContain('unreadable');
  expect(() => dispatchReleaseStatus({ topic: 'weather' }, fixture())).toThrow('topic 은 status, features, cell, schedule, ops 중 하나');
});
