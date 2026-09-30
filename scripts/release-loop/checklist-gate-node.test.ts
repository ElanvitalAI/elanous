import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addItem, checklistGate, listChecklist, setItem, summarizeChecklist } from '../../src/release-loop/checklist.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../../src/elanous-config-dir.js';
import { runChecklistGate } from './checklist-gate-node.js';

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
  expect(listChecklist('0.2.7').items).toEqual([]);
  expect(summarizeChecklist(listChecklist('0.2.6'))).toEqual(original);
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

test('move passes and copies once to next patch without replacing an existing item', () => isolated((root) => {
  addItem('0.2.6', { id: 'K13', title: 'Carry over', owner: 'TC' });
  setItem('0.2.6', 'K13', { disposition: 'move' }, 'TC');
  expect(node(root, '0.2.6').result).toMatchObject({ outcome: 'ok', moved: ['K13'] });
  expect(node(root, '0.2.6').result.outcome).toBe('ok');
  expect(listChecklist('0.2.7').items).toMatchObject([{ id: 'K13', title: 'Carry over', status: 'yellow', owner: 'TC' }]);
  expect(listChecklist('0.2.7').items).toHaveLength(1);
  expect(listChecklist('0.2.7').history).toHaveLength(1);
  expect(node(root, '0.2.7').result).toMatchObject({ outcome: 'fail', undecided: ['K13'] });
  addItem('0.2.8', { id: 'K13', title: 'Already present' });
  setItem('0.2.7', 'K13', { disposition: 'move' }, 'TC');
  expect(node(root, '0.2.7').result.outcome).toBe('ok');
  expect(listChecklist('0.2.8').items).toMatchObject([{ id: 'K13', title: 'Already present' }]);
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
