import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { addItem, checklistGate, listChecklist, removeItem, setItem, summarizeChecklist, type Checklist } from './checklist.js';
import * as features from './feature-store.js';

let dir: string;
function setup(): string { dir = mkdtempSync(join(tmpdir(), 'release-features-')); setElanousConfigDir(dir); return dir; }
afterEach(() => { resetElanousConfigDir(); if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });
function fixture(version: string): Checklist {
  const data: Checklist = { version, released: '0.2.6', dev: '0.2.10-dev.1', items: [
    { id: 'L13e', title: '같은 제목', status: 'yellow', disposition: 'move', owner: 'OP', evidence: '#123', updatedAt: '2026-10-01T00:00:00Z', updatedBy: 'OP' },
    { id: `X${version}`, title: '화면', status: 'red', kind: 'screen', updatedAt: '2026-10-01T00:00:00Z', updatedBy: 'OP' },
  ], history: [{ at: '2026-10-01T00:00:00Z', by: 'OP', id: 'L13e', field: 'add', from: null, to: 'original', released: '0.2.6', dev: '0.2.10-dev.1' }] };
  const folder = join(dir, 'release', version);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'checklist.json'), JSON.stringify(data));
  return data;
}

test('네 판 JSON 들이기: 집계와 노랑 처분·parity 게이트가 그대로이며 재수입은 멱등', () => {
  setup();
  for (const version of ['0.2.7', '0.2.8', '0.2.9', '0.2.10']) {
    const original = fixture(version);
    expect(features.importJson(version)).toBe(true);
    expect(features.importJson(version)).toBe(false);
    expect(summarizeChecklist(listChecklist(version))).toEqual(summarizeChecklist(original));
    expect(checklistGate(version)).toMatchObject({ ok: false, red: [`X${version}`], moved: ['L13e'], parity: [{ id: `X${version}`, why: '근거에 짝: 줄이 없다' }] });
    expect(listChecklist(version).history).toEqual(original.history);
  }
  const db = new Database(join(dir, 'release/features.sqlite'));
  expect(db.query('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
  db.close();
});

test('서로 다른 판의 옛 제목은 수입 전후 그대로이고 retitle 은 한 정체성으로 합친다', () => {
  setup(); fixture('0.2.9'); fixture('0.2.10');
  const path = join(dir, 'release/0.2.10/checklist.json');
  const changed = JSON.parse(readFileSync(path, 'utf8')) as Checklist;
  changed.items[0]!.title = '다른 판 제목';
  changed.items[0]!.owner = 'TC';
  changed.items[0]!.kind = 'screen';
  writeFileSync(path, JSON.stringify(changed));
  features.importJson('0.2.9'); features.importJson('0.2.10');
  expect(listChecklist('0.2.9').items[0]).toMatchObject({ title: '같은 제목', owner: 'OP' });
  expect(listChecklist('0.2.9').items[0]?.kind).toBeUndefined();
  expect(listChecklist('0.2.10').items[0]).toMatchObject({ title: '다른 판 제목', owner: 'TC', kind: 'screen' });
  expect(features.details('L13e')).toMatchObject({ id: 'L13e', owner: 'OP', kind: null, createdAt: '2026-10-01T00:00:00Z' });
  expect(features.details('X0.2.9')).toMatchObject({ id: 'X0.2.9', owner: null, kind: 'screen', createdAt: '2026-10-01T00:00:00Z' });
  features.retitle('L13e', '같은 제목', 'OP');
  expect(listChecklist('0.2.10').items[0]?.title).toBe('같은 제목');
  expect(features.history('L13e').filter((row) => row.field === 'title')).toMatchObject([
    { version: '0.2.10', from: '다른 판 제목', to: '같은 제목' },
  ]);
  features.retitle('L13e', '합친 제목', 'OP');
  expect(listChecklist('0.2.9').items[0]?.title).toBe('합친 제목');
  expect(listChecklist('0.2.10').items[0]?.title).toBe('합친 제목');
  const titles = features.history('L13e').filter((row) => row.field === 'title');
  expect(titles[0]).toMatchObject({ version: '0.2.10', from: '다른 판 제목', to: '같은 제목' });
  expect(titles.slice(1).map(({ version, from, to }) => ({ version, from, to }))).toEqual([
    { version: '0.2.10', from: '같은 제목', to: '합친 제목' },
    { version: '0.2.9', from: '같은 제목', to: '합친 제목' },
  ]);
});

test('내보낸 스냅샷은 재시작 후에도 수입되지 않아 DB의 최신 상태가 남는다', () => {
  setup();
  const item = { id: 'K1', title: '원본', status: 'yellow' as const, updatedAt: '2026-10-02T00:00:00Z', updatedBy: 'OP' };
  features.add('0.2.10', item);
  features.exportJson('0.2.10');
  features.set('0.2.10', 'K1', { status: 'green' }, 'OP');
  expect(features.importJson('0.2.10')).toBe(false);
  expect(listChecklist('0.2.10').items[0]?.status).toBe('green');
});

test('새 판에 먼저 쓴 칸은 나중에 생긴 오래된 JSON 이 덮지 못한다', () => {
  setup();
  const item = { id: 'L13e', title: 'DB 칸', status: 'green' as const, updatedAt: '2026-10-02T00:00:00Z', updatedBy: 'OP' };
  features.add('0.2.10', item);
  const old = fixture('0.2.10');
  expect(features.importJson('0.2.10')).toBe(false);
  expect(listChecklist('0.2.10').items).toEqual([item]);
  expect(summarizeChecklist(old).red).toBe(1);
});

test('잘못된 JSON 수입은 트랜잭션을 롤백하고 수리 뒤 재시도한다', () => {
  setup(); fixture('0.2.9');
  const path = join(dir, 'release/0.2.9/checklist.json');
  const original = JSON.parse(readFileSync(path, 'utf8')) as Checklist;
  writeFileSync(path, JSON.stringify({ ...original, items: [...original.items, original.items[0]] }));
  expect(() => features.importJson('0.2.9')).toThrow('잘못된 체크리스트 칸');
  const db = new Database(join(dir, 'release/features.sqlite'));
  expect(db.query('SELECT COUNT(*) AS n FROM assignments').get()).toEqual({ n: 0 });
  db.close();
  writeFileSync(path, JSON.stringify(original));
  expect(features.importJson('0.2.9')).toBe(true);
  expect(listChecklist('0.2.9').items).toHaveLength(2);
});

test('들여오기 전 충돌 이동도 수입·이벤트·배치를 모두 롤백한다', () => {
  setup(); fixture('0.2.9'); fixture('0.2.10');
  expect(() => features.move('L13e', '0.2.9', '0.2.10', 'OP')).toThrow('이미 있는 칸');
  const db = new Database(join(dir, 'release/features.sqlite'));
  for (const table of ['features', 'assignments', 'events', 'imported_versions']) {
    expect(db.query(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
  }
  db.close();
});

test('한 트랜잭션 이동은 상태·제목·근거를 보존하고 이벤트 한 줄; 충돌 실패는 어느 판도 바꾸지 않는다', () => {
  setup(); fixture('0.2.9'); fixture('0.2.10');
  features.importJson('0.2.9'); features.importJson('0.2.10');
  const beforeFrom = listChecklist('0.2.9'), beforeTo = listChecklist('0.2.10');
  const before = features.history('L13e');
  expect(() => features.move('L13e', '0.2.9', '0.2.10', 'OP', '', '')).toThrow('이미 있는 칸');
  expect(listChecklist('0.2.9').items).toEqual(beforeFrom.items);
  expect(listChecklist('0.2.10').items).toEqual(beforeTo.items);
  expect(features.history('L13e')).toEqual(before);
  // The target's existing cell is explicitly removed, not silently overwritten by move.
  features.remove('0.2.10', 'L13e', 'OP', '', '');
  const count = features.history('L13e').length;
  features.move('L13e', '0.2.9', '0.2.10', 'OP', '', '');
  expect(listChecklist('0.2.9').items.find((i) => i.id === 'L13e')).toBeUndefined();
  expect(listChecklist('0.2.10').items.find((i) => i.id === 'L13e')).toMatchObject({ title: '같은 제목', status: 'yellow', evidence: '#123', disposition: 'move' });
  expect(features.history('L13e').slice(count)).toMatchObject([{ version: '0.2.10', field: 'move', from: '0.2.9', to: '0.2.10' }]);
});

test('history 와 retitle 은 아직 방문하지 않은 판의 JSON 도 들여와 전체 정체성을 찾는다', () => {
  setup(); fixture('0.2.9'); fixture('0.2.10');
  expect(features.history('L13e').map((entry) => entry.version)).toEqual(['0.2.9', '0.2.10']);
  features.retitle('L13e', '새 제목', 'OP');
  expect(listChecklist('0.2.9').items[0]?.title).toBe('새 제목');
  expect(listChecklist('0.2.10').items[0]?.title).toBe('새 제목');
});

test('추가된 PR 참조를 기존 known-issue 게이트와 내보내기에서 소비한다', () => {
  setup(); fixture('0.2.9');
  features.importJson('0.2.9');
  features.set('0.2.9', 'L13e', { disposition: 'known-issue' }, 'OP');
  features.evidenceAdd('L13e', '0.2.9', '#321', 'OP');
  expect(features.details('L13e')).toMatchObject({ owner: 'OP', kind: null, createdAt: '2026-10-01T00:00:00Z', evidence: [
    { version: '0.2.9', ref: '#321', by: 'OP', at: expect.any(String) },
  ] });
  expect(listChecklist('0.2.9').items[0]?.evidence).toBe('#123\n#321');
  expect(checklistGate('0.2.9').knownIssues).toEqual([{ id: 'L13e', title: '같은 제목', evidence: '#123\n#321' }]);
  expect(features.exportJson('0.2.9').items[0]?.evidence).toBe('#123\n#321');
});

test('삭제 후 같은 ID·판 재추가에는 삭제한 수명의 근거 참조가 되살아나지 않는다', () => {
  setup(); fixture('0.2.9');
  features.evidenceAdd('L13e', '0.2.9', '#old', 'OP');
  removeItem('0.2.9', 'L13e', 'OP');
  addItem('0.2.9', { id: 'L13e', title: '다시 추가' });
  setItem('0.2.9', 'L13e', { disposition: 'known-issue' }, 'OP');
  expect(listChecklist('0.2.9').items[0]?.evidence).toBeUndefined();
  expect(checklistGate('0.2.9').knownIssues).toEqual([{ id: 'L13e', title: '다시 추가', evidence: '' }]);
  expect(features.exportJson('0.2.9').items[0]?.evidence).toBeUndefined();
  expect(features.details('L13e')?.evidence).toEqual([]);
  expect(features.history('L13e').map((row) => row.field)).toEqual(['add', 'evidence.add', 'remove', 'add', 'disposition']);
});

test('setItem 근거 교체는 참조 행까지 제거하고 상태·gate·export를 새 값만으로 읽는다', () => {
  setup(); fixture('0.2.9');
  features.evidenceAdd('L13e', '0.2.9', '#old', 'OP');
  setItem('0.2.9', 'L13e', { disposition: 'known-issue', evidence: '#new' }, 'OP');
  expect(listChecklist('0.2.9').items[0]?.evidence).toBe('#new');
  expect(checklistGate('0.2.9').knownIssues).toEqual([{ id: 'L13e', title: '같은 제목', evidence: '#new' }]);
  expect(features.exportJson('0.2.9').items[0]?.evidence).toBe('#new');
  expect(features.details('L13e')?.evidence).toEqual([]);
  expect(features.history('L13e').some((row) => row.field === 'evidence' && row.from === '#123\n#old' && row.to === '#new')).toBe(true);
});

test('배치가 모두 제거된 피처는 제목을 고칠 수 없고 빈 판 이벤트도 만들지 않는다', () => {
  setup(); fixture('0.2.9');
  features.importJson('0.2.9');
  features.remove('0.2.9', 'L13e', 'OP');
  const before = features.history('L13e');
  expect(() => features.retitle('L13e', '유령 제목', 'OP')).toThrow('없는 칸: L13e');
  expect(features.history('L13e')).toEqual(before);
  expect(features.history('L13e').every((entry) => entry.version === '0.2.9')).toBe(true);
});

test('제목 변경은 상태와 이전 이력을 보존하며 빈 제목 거부; 참조와 판 이동은 시간 순 이력', () => {
  setup(); fixture('0.2.9');
  features.importJson('0.2.9');
  const before = features.history('L13e');
  expect(() => features.retitle('L13e', ' ', 'OP', '', '')).toThrow('칸 제목이 비었다');
  expect(features.history('L13e')).toEqual(before);
  features.retitle('L13e', '새 제목', 'OP', '', '');
  features.evidenceAdd('L13e', '0.2.9', '#321', 'OP', '', '');
  features.move('L13e', '0.2.9', '0.2.10', 'OP', '', '');
  expect(listChecklist('0.2.10').items[0]).toMatchObject({ title: '새 제목', status: 'yellow', evidence: '#123\n#321' });
  expect(checklistGate('0.2.10').moved).toEqual(['L13e']);
  features.set('0.2.10', 'L13e', { status: 'green' }, 'OP');
  expect(listChecklist('0.2.10').items[0]?.evidence).toBe('#123\n#321');
  expect(features.history('L13e').slice(1).map((e) => [e.version, e.field, e.to])).toEqual([
    ['0.2.9', 'title', '새 제목'], ['0.2.9', 'evidence.add', '#321'], ['0.2.10', 'move', '0.2.10'], ['0.2.10', 'status', 'green'],
  ]);
  const db = new Database(join(dir, 'release/features.sqlite'));
  expect(db.query('SELECT version, ref FROM evidence').all()).toEqual([{ version: '0.2.10', ref: '#321' }]);
  db.close();
  const data = features.exportJson('0.2.10', '', '');
  expect(data.items[0]?.evidence).toBe('#123\n#321');
  expect(JSON.parse(readFileSync(join(dir, 'release/0.2.10/checklist.json'), 'utf8'))).toEqual(data);
  expect(features.importJson('0.2.10')).toBe(false);
  expect(listChecklist('0.2.10').history).toEqual(data.history);
});

test('setItem 으로 바꾼 owner·kind 가 features 표에도 반영되어 details 와 체크리스트가 같은 값을 낸다', () => {
  setup(); fixture('0.2.9');
  setItem('0.2.9', 'L13e', { owner: 'TC', kind: 'screen' }, 'OP');
  expect(listChecklist('0.2.9').items.find((item) => item.id === 'L13e')).toMatchObject({ owner: 'TC', kind: 'screen' });
  expect(features.details('L13e')).toMatchObject({ owner: 'TC', kind: 'screen' });
});
