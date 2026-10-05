import { setDefaultTimeout, expect, test, spyOn } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addItem, checklistGate, listChecklist, setItem, summarizeChecklist } from '../../src/release-loop/checklist.js';
import { setSchedule } from '../../src/release-loop/release-schedule.js';
import * as store from '../../src/release-loop/feature-store.js';
import { debug } from '../../src/debug/log.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../../src/elanous-config-dir.js';
import { runChecklistGate } from './checklist-gate-node.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const repo = join(import.meta.dir, '../..');

function isolated(fn: (root: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'checklist-gate-'));
  const root = join(home, '.elanous');
  mkdirSync(root);
  setElanousConfigDir(root);
  try { fn(root); } finally { resetElanousConfigDir(); rmSync(home, { recursive: true, force: true }); }
}

function context(version: string) { return { input: { version, previousVersion: '0.2.5' }, outputs: {} }; }

function node(root: string, version: string) {
  const path = join(root, 'context.json');
  writeFileSync(path, JSON.stringify(context(version)));
  const run = spawnSync('bun', [join(import.meta.dir, 'checklist-gate-node.ts')], { cwd: repo, encoding: 'utf8', env: { ...process.env, ELANOUS_GRAPH_CONTEXT: path, ELANOUS_STATE_DIR: root, HOME: join(root, '..') } });
  return { code: run.status, result: JSON.parse(run.stdout.trim()) as ReturnType<typeof runChecklistGate> };
}

test('red and undecided yellow fail while known issues, moves and blocked stay separate', () => isolated((root) => {
  for (const id of ['red', 'undecided', 'known', 'moved', 'blocked', 'green', 'done']) addItem('0.2.6', { id, title: `title ${id}`, owner: 'TC' });
  setItem('0.2.6', 'red', { status: 'red' }, 'TC');
  setItem('0.2.6', 'known', { disposition: 'known-issue', evidence: 'tracked issue' }, 'TC');
  setItem('0.2.6', 'moved', { disposition: 'move' }, 'TC');
  setItem('0.2.6', 'blocked', { disposition: 'block' }, 'TC');
  setItem('0.2.6', 'green', { status: 'green', disposition: 'block' }, 'TC');
  setItem('0.2.6', 'done', { status: 'done' }, 'TC');
  const original = summarizeChecklist(listChecklist('0.2.6'));
  const { code, result } = node(root, '0.2.6');
  expect(code).toBe(1);
  expect(result).toMatchObject({ outcome: 'fail', verdict: 'fail', ok: false, red: ['red'], undecided: ['undecided'], blocked: ['blocked'], moved: ['moved'], knownIssues: [{ id: 'known', title: 'title known', evidence: 'tracked issue' }] });
  expect(result.summary).toContain('🔴1 (red)');
  expect(result.summary).toContain('판정 없음 1');
  expect(listChecklist('0.2.7').items).toMatchObject([{ id: 'moved', status: 'yellow', owner: 'TC' }]);
  expect(listChecklist('0.2.6').items.some((item) => item.id === 'moved')).toBe(false);
  expect(summarizeChecklist(listChecklist('0.2.6')).yellow).toBe(3);
  expect(original).toMatchObject({ green: 1, yellow: 4, red: 1, done: 1, blocked: ['red'], byOwner: { TC: 7 } });
  expect(listChecklist('0.2.6').items.find((item) => item.id === 'known')).toMatchObject({ status: 'yellow', evidence: 'tracked issue', owner: 'TC', disposition: 'known-issue' });
  expect(listChecklist('0.2.6').history).toContainEqual(expect.objectContaining({ id: 'known', field: 'disposition', from: null, to: 'known-issue', by: 'TC' }));
}));

test('a single red item fails with its id in the summary', () => isolated((root) => {
  addItem('0.2.6', { id: 'K13', title: 'Release blocker' });
  setItem('0.2.6', 'K13', { status: 'red', disposition: 'move' }, 'TC');
  const { code, result } = node(root, '0.2.6');
  expect(code).toBe(1);
  expect(result).toMatchObject({ ok: false, outcome: 'fail', red: ['K13'], moved: [] });
  expect(result.summary).toContain('🔴1 (K13)');
  expect(listChecklist('0.2.7').items).toEqual([]);
}));

test('undecided or blocked fails alone, known issue alone passes', () => isolated((root) => {
  addItem('0.2.6', { id: 'K13', title: 'Known issue' });
  expect(node(root, '0.2.6').result).toMatchObject({ outcome: 'fail', undecided: ['K13'] });
  setItem('0.2.6', 'K13', { disposition: 'block' }, 'TC');
  expect(node(root, '0.2.6').result).toMatchObject({ outcome: 'fail', blocked: ['K13'] });
  setItem('0.2.6', 'K13', { disposition: 'known-issue', evidence: 'tracked' }, 'TC');
  expect(node(root, '0.2.6').result).toMatchObject({ outcome: 'ok', knownIssues: [{ id: 'K13', title: 'Known issue', evidence: 'tracked' }] });
  expect(checklistGate('0.2.6').ok).toBe(true);
}));

test('move transfers once to next patch without replacing a colliding item', () => isolated((root) => {
  addItem('0.2.6', { id: 'K13', title: 'Carry over', owner: 'TC' });
  setItem('0.2.6', 'K13', { disposition: 'move' }, 'TC');
  expect(node(root, '0.2.6').result).toMatchObject({ outcome: 'ok', moved: ['K13'], carried: ['K13'] });
  expect(node(root, '0.2.6').result.outcome).toBe('ok');
  expect(listChecklist('0.2.7').items).toMatchObject([{ id: 'K13', title: 'Carry over', status: 'yellow', owner: 'TC' }]);
  expect(listChecklist('0.2.7').items).toHaveLength(1);
  expect(listChecklist('0.2.7').history).toContainEqual(expect.objectContaining({ id: 'K13', field: 'move', from: '0.2.6', to: '0.2.7' }));
  expect(listChecklist('0.2.6').items).toEqual([]);
  expect(node(root, '0.2.7').result).toMatchObject({ outcome: 'fail', undecided: ['K13'] });
  addItem('0.2.8', { id: 'K13', title: 'Already present' }, { allowDuplicateId: true });
  setItem('0.2.7', 'K13', { disposition: 'move' }, 'TC');
  const { code, result } = node(root, '0.2.7');
  expect(code).toBe(1);
  expect(result).toMatchObject({ outcome: 'fail', verdict: 'fail', ok: false, carried: [] });
  expect(result.summary).toStartWith('이월 충돌: K13 — 다음 판에 다른 칸이 같은 ID · 확인표');
  expect(listChecklist('0.2.8').items).toMatchObject([{ id: 'K13', title: 'Already present' }]);
  expect(listChecklist('0.2.7').items).toHaveLength(1);
}));

test('same carry evidence closes the original only when title and owner also match', () => isolated(() => {
  addItem('0.2.6', { id: 'K13', title: 'Carry over', owner: 'TC' });
  setItem('0.2.6', 'K13', { disposition: 'move' }, 'TC');
  addItem('0.2.7', { id: 'K13', title: 'Carry over', owner: 'TC' }, { allowDuplicateId: true });
  setItem('0.2.7', 'K13', { evidence: '0.2.6에서 이월 · reviewed' }, 'TC');
  const result = runChecklistGate(context('0.2.6'));
  expect(result).toMatchObject({ outcome: 'ok', ok: true, moved: ['K13'], carried: [] });
  expect(listChecklist('0.2.6').items).toEqual([]);
  expect(listChecklist('0.2.7').items).toMatchObject([{ id: 'K13', title: 'Carry over', owner: 'TC', evidence: '0.2.6에서 이월 · reviewed' }]);
  expect(listChecklist('0.2.7').items).toHaveLength(1);
}));

test('a real earlier move recorded in next-version history counts as the same carry', () => isolated(() => {
  addItem('0.2.6', { id: 'K13', title: 'Carry over', owner: 'TC' });
  setItem('0.2.6', 'K13', { disposition: 'move' }, 'TC');
  expect(runChecklistGate(context('0.2.6'))).toMatchObject({ outcome: 'ok', carried: ['K13'] });
  addItem('0.2.6', { id: 'K13', title: 'Carry over', owner: 'TC' }, { allowDuplicateId: true });
  setItem('0.2.6', 'K13', { disposition: 'move' }, 'TC');
  expect(runChecklistGate(context('0.2.6'))).toMatchObject({ outcome: 'ok', ok: true, carried: [] });
  expect(listChecklist('0.2.6').items).toEqual([]);
  expect(listChecklist('0.2.7').items.map((item) => item.id)).toEqual(['K13']);
}));

test('matching title and owner without source-version carry evidence is still a collision', () => isolated(() => {
  addItem('0.2.6', { id: 'K13', title: 'Carry over', owner: 'TC' });
  setItem('0.2.6', 'K13', { disposition: 'move' }, 'TC');
  addItem('0.2.7', { id: 'K13', title: 'Carry over', owner: 'TC' }, { allowDuplicateId: true });
  setItem('0.2.7', 'K13', { evidence: '0.2.5에서 이월' }, 'TC');
  expect(runChecklistGate(context('0.2.6'))).toMatchObject({ outcome: 'fail', ok: false, carried: [], summary: expect.stringMatching(/^이월 충돌: K13 — 다음 판에 다른 칸이 같은 ID · 확인표/) });
  expect(listChecklist('0.2.6').items.map((item) => item.id)).toEqual(['K13']);
}));

test('one collision prevents all carries, including earlier noncolliding items', () => isolated(() => {
  for (const id of ['FIRST', 'K13']) {
    addItem('0.2.6', { id, title: `title ${id}`, owner: 'TC' });
    setItem('0.2.6', id, { disposition: 'move' }, 'TC');
  }
  addItem('0.2.7', { id: 'K13', title: 'Different', owner: 'UX' }, { allowDuplicateId: true });
  const events: Array<{ category: string; event: string; data: unknown }> = [];
  const log = spyOn(debug, 'log').mockImplementation((category, event, data) => { events.push({ category, event, data }); });
  try {
    const result = runChecklistGate(context('0.2.6'));
    expect(result).toMatchObject({ outcome: 'fail', ok: false, moved: ['FIRST', 'K13'], carried: [] });
    expect(result.summary).toStartWith('이월 충돌: K13 — 다음 판에 다른 칸이 같은 ID · 확인표');
    expect(events).toContainEqual({ category: 'release-loop.checklist-gate', event: 'carry-collision', data: { id: 'K13', from: '0.2.6', to: '0.2.7' } });
    expect(listChecklist('0.2.6').items.map((item) => item.id)).toEqual(['FIRST', 'K13']);
    expect(listChecklist('0.2.7').items.map((item) => item.id)).toEqual(['K13']);
  } finally { log.mockRestore(); }
}));

test('a move exception reports already carried ids so retry can continue', () => isolated(() => {
  for (const id of ['FIRST', 'SECOND']) {
    addItem('0.2.6', { id, title: `title ${id}`, owner: 'TC' });
    setItem('0.2.6', id, { disposition: 'move' }, 'TC');
  }
  const originalMove = store.move;
  const move = spyOn(store, 'move');
  move.mockImplementation((...args) => {
    if (args[0] === 'SECOND') throw new Error('injected move failure');
    return originalMove(...args);
  });
  try {
    const result = runChecklistGate(context('0.2.6'));
    expect(result).toMatchObject({ outcome: 'fail', ok: false, moved: ['FIRST', 'SECOND'], carried: ['FIRST'] });
    expect(result.summary).toContain('이월 실패: SECOND — injected move failure');
    expect(listChecklist('0.2.6').items.map((item) => item.id)).toEqual(['SECOND']);
    expect(listChecklist('0.2.7').items.map((item) => item.id)).toEqual(['FIRST']);
  } finally { move.mockRestore(); }
}));

test('deadline carries undecided yellows with reason, audit event and a one-line list', () => isolated(() => {
  setSchedule('0.2.6', { cutAt: '2026-10-05T06:00+09:00', landBy: '2026-10-05T05:40+09:00' }, 'OP');
  addItem('0.2.6', { id: 'LATE', title: 'Missed deadline', owner: 'TC', priority: 'P1', kind: 'screen' });
  const events: Array<{ category: string; event: string; data: unknown }> = [];
  const originalLog = debug.log;
  debug.log = ((category: string, event: string, data?: unknown) => {
    events.push({ category, event, data });
    return originalLog.call(debug, category, event, data);
  }) as typeof debug.log;
  try {
    const result = runChecklistGate(context('0.2.6'), new Date('2026-10-04T20:41:00Z'));
    expect(result).toMatchObject({ outcome: 'ok', moved: ['LATE'], undecided: [], carried: ['LATE'] });
    expect(result.summary).toContain('이월 1(LATE)');
    expect(result.summary.includes('\n')).toBe(false);
    expect(events).toContainEqual({ category: 'release-loop.checklist-gate', event: 'carried', data: { id: 'LATE', from: '0.2.6', to: '0.2.7' } });
    expect(listChecklist('0.2.6').items).toEqual([]);
    expect(listChecklist('0.2.7').items[0]).toMatchObject({ id: 'LATE', kind: 'screen', owner: 'TC', priority: 'P1', status: 'yellow' });
    expect(listChecklist('0.2.7').history).toContainEqual(expect.objectContaining({ id: 'LATE', field: 'move', reason: '컷 자동 이월 · 마감 05:40' }));
    expect(runChecklistGate(context('0.2.6'), new Date('2026-10-04T20:42:00Z')).carried).toEqual([]);
  } finally { debug.log = originalLog; }
}));

test('block or P0 stays in the current version and stops the gate after deadline', () => isolated(() => {
  setSchedule('0.2.6', { cutAt: '2026-10-05T06:00+09:00', landBy: '2026-10-05T05:40+09:00' }, 'OP');
  addItem('0.2.6', { id: 'BLOCK', title: 'Owner blocked' });
  setItem('0.2.6', 'BLOCK', { disposition: 'block' }, 'TC');
  addItem('0.2.6', { id: 'P0-MOVE', title: 'Urgent move', priority: 'P0' });
  setItem('0.2.6', 'P0-MOVE', { disposition: 'move' }, 'TC');
  addItem('0.2.6', { id: 'P0-NONE', title: 'Urgent undecided', priority: 'P0' });
  const result = runChecklistGate(context('0.2.6'), new Date('2026-10-04T20:41:00Z'));
  expect(result).toMatchObject({ outcome: 'fail', blocked: ['BLOCK', 'P0-MOVE', 'P0-NONE'], moved: [], carried: [] });
  expect(listChecklist('0.2.6').items).toHaveLength(3);
  expect(listChecklist('0.2.7').items).toEqual([]);
}));

test('before the deadline an undecided yellow is not carried and still blocks the gate', () => isolated(() => {
  setSchedule('0.2.6', { cutAt: '2026-10-05T06:00+09:00', landBy: '2026-10-05T05:40+09:00' }, 'OP');
  addItem('0.2.6', { id: 'WAIT', title: 'Before deadline' });
  const result = runChecklistGate(context('0.2.6'), new Date('2026-10-04T20:39:00Z'));
  expect(result).toMatchObject({ outcome: 'fail', undecided: ['WAIT'], carried: [] });
  expect(listChecklist('0.2.7').items).toEqual([]);
}));

test('known issue without evidence is carried without an evidence gate', () => isolated((root) => {
  addItem('0.2.6', { id: 'K13', title: 'Known issue' });
  setItem('0.2.6', 'K13', { disposition: 'known-issue' }, 'TC');
  expect(node(root, '0.2.6').result).toMatchObject({ outcome: 'ok', knownIssues: [{ id: 'K13', title: 'Known issue', evidence: '' }] });
}));

test('CLI disposition set and piped 100-item status JSON remain complete', () => isolated((root) => {
  const dir = join(root, 'release', '0.2.6');
  mkdirSync(dir, { recursive: true });
  const items = Array.from({ length: 100 }, (_, index) => ({ id: `K${index}`, title: `title ${index} ${'long description '.repeat(45)}`, status: 'yellow', updatedAt: new Date().toISOString(), updatedBy: 'TC' }));
  writeFileSync(join(dir, 'checklist.json'), JSON.stringify({ version: '0.2.6', released: '', dev: '', items, history: [] }));
  const env = { ...process.env, HOME: join(root, '..'), ELANOUS_STATE_DIR: root };
  const set = spawnSync('bun', ['bin/elanous.mjs', '--config-dir', root, '--test', 'release', 'checklist', 'set', 'K0', '--version', '0.2.6', '--disposition', 'known-issue'], { cwd: repo, encoding: 'utf8', env });
  expect(set.status).toBe(0);
  const invalid = spawnSync('bun', ['bin/elanous.mjs', '--config-dir', root, '--test', 'release', 'checklist', 'set', 'K0', '--version', '0.2.6', '--disposition', 'skip'], { cwd: repo, encoding: 'utf8', env });
  expect(invalid.status).not.toBe(0);
  const piped = spawnSync('bash', ['-o', 'pipefail', '-c', `bun bin/elanous.mjs --config-dir "$1" --test release checklist status --version 0.2.6 --json | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d["items"]), d["items"][0]["disposition"], len(d["history"]))'`, 'bash', root], { cwd: repo, encoding: 'utf8', env });
  expect(piped.stderr).toBe('');
  expect(piped.status).toBe(0);
  expect(piped.stdout.trim()).toBe('100 known-issue 1');
  expect(readFileSync(join(dir, 'checklist.json'), 'utf8').length).toBeGreaterThan(68_000);
}), 30_000);

test('screen cells without a full 짝: line or with an untracked ⏳ warn without changing the verdict', () => isolated((root) => {
  addItem('0.2.6', { id: 'NOLINE', title: 'no parity line', kind: 'screen' });
  addItem('0.2.6', { id: 'SHORT', title: 'four columns', kind: 'screen' });
  addItem('0.2.6', { id: 'UNTRACKED', title: 'untracked wait', kind: 'screen' });
  addItem('0.2.6', { id: 'FULL', title: 'all tracked', kind: 'screen' });
  addItem('0.2.6', { id: 'PLAIN', title: 'not a screen cell' });
  setItem('0.2.6', 'NOLINE', { status: 'green', evidence: '#1 landed' }, 'TC');
  setItem('0.2.6', 'SHORT', { status: 'green', evidence: '짝: PWA ✅ · 데스크톱 ✅ · 폴드 ✅ · 아이폰 ✅' }, 'TC');
  setItem('0.2.6', 'UNTRACKED', { status: 'green', evidence: '#2\n짝: PWA ✅ · 데스크톱 ⏳(DT3) · 폴드 ❌(대안: 텔레그램) · 아이폰 ⏳(칸 F1b) · 아이패드 —' }, 'TC');
  setItem('0.2.6', 'FULL', { status: 'green', evidence: '짝: PWA ✅ · 데스크톱 ✅ #3 · 폴드 ❌(대안: 텔레그램 @자리) · 아이폰 ⏳(칸 F1b) · 아이패드 ⏳(칸 F1b)' }, 'TC');
  setItem('0.2.6', 'PLAIN', { status: 'green' }, 'TC');
  const { code, result } = node(root, '0.2.6');
  expect(code).toBe(0);
  expect(result).toMatchObject({ outcome: 'ok', ok: true });
  expect(result.parity!.map((p) => p.id)).toEqual(['NOLINE', 'SHORT', 'UNTRACKED']);
  expect(result.parity!.find((p) => p.id === 'UNTRACKED')!.why).toBe('⏳ 에 (칸 …) 번호가 없다: 데스크톱');
  expect(result.summary).toContain('⚠ 짝 경고 3(NOLINE, SHORT, UNTRACKED)');
  expect(() => setItem('0.2.6', 'PLAIN', { kind: 'widget' as 'screen' }, 'TC')).toThrow('잘못된 종류');
}));

test('a moved screen cell keeps its kind in the next patch', () => isolated((root) => {
  addItem('0.2.6', { id: 'S1', title: 'screen moved', kind: 'screen' });
  setItem('0.2.6', 'S1', { disposition: 'move', evidence: '짝: PWA ✅ · 데스크톱 ⏳(칸 DT9) · 폴드 — · 아이폰 — · 아이패드 —' }, 'TC');
  expect(node(root, '0.2.6').result).toMatchObject({ outcome: 'ok', moved: ['S1'], parity: [] });
  expect(listChecklist('0.2.7').items[0]).toMatchObject({ id: 'S1', kind: 'screen' });
}));
