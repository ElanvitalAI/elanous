import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncMergedPrChecklist, type MergedPrChecklistDeps } from './merged-pr-checklist.js';
import { addItem, listChecklist, type ChecklistItem } from './checklist.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';

const item = (id: string, status: ChecklistItem['status'] = 'yellow', evidence?: string): ChecklistItem => ({
  id, title: id, status, ...(evidence ? { evidence } : {}), updatedAt: '2026-10-01T00:00:00Z', updatedBy: 'UX',
});

function fixture(items: ChecklistItem[], title = 'unrelated', body = '칸: X', goal?: string) {
  const root = mkdtempSync(join(tmpdir(), 'merged-pr-checklist-'));
  const path = goal === undefined ? undefined : join(root, 'goal.txt');
  if (path && goal !== undefined) writeFileSync(path, goal);
  const calls: string[] = [];
  const events: string[] = [];
  const deps: MergedPrChecklistDeps = {
    readPr: () => ({ state: 'MERGED', baseRefName: 'main', title, body, mergedAt: '2026-10-02T00:00:00Z' }),
    versions: () => ['0.2.12'],
    checklist: (version) => ({ version, released: '', dev: version, items, history: [] }),
    addEvidence: (id, _version, ref) => { calls.push(`evidence ${id} ${ref}`); items.find((entry) => entry.id === id)!.evidence = ref; },
    setStatus: (_version, id, patch) => { calls.push(`status ${id} ${patch.status}`); items.find((entry) => entry.id === id)!.status = patch.status!; return { version: '0.2.12', released: '', dev: '0.2.12', items, history: [] }; },
    log: (_category, event) => { events.push(event); },
  };
  return { root, path, calls, events, deps, items };
}

describe('confirmed main merge checklist sync', () => {
  test('completion declaration adds evidence before green once in the isolated ledger', () => {
    const root = mkdtempSync(join(tmpdir(), 'merged-pr-checklist-ledger-'));
    const goal = join(root, 'goal.txt');
    writeFileSync(goal, '칸: X\n이 칸 완료\n');
    setElanousConfigDir(root);
    try {
      addItem('0.2.12', { id: 'X', title: 'X' });
      const events: string[] = [];
      const deps: MergedPrChecklistDeps = {
        readPr: () => ({ state: 'MERGED', baseRefName: 'main', title: 'misc', body: '칸: X', mergedAt: '2026-10-02T00:00:00Z' }),
        versions: () => ['0.2.12'],
        log: (_category, event) => { events.push(event); },
      };
      syncMergedPrChecklist(42, root, goal, deps);
      syncMergedPrChecklist(42, root, goal, deps);
      const snapshot = listChecklist('0.2.12');
      expect(snapshot.items.find(({ id }) => id === 'X')).toMatchObject({ status: 'green', evidence: '#42' });
      expect(snapshot.history.filter(({ field }) => field === 'evidence.add')).toHaveLength(1);
      expect(snapshot.history.filter(({ field }) => field === 'status')).toMatchObject([{ id: 'X', from: 'yellow', to: 'green', by: 'harness' }]);
      expect(events.filter((event) => event === 'merged-pr-evidence-added')).toHaveLength(1);
      expect(events.filter((event) => event === 'merged-pr-status-green')).toHaveLength(1);
    } finally { resetElanousConfigDir(); rmSync(root, { recursive: true, force: true }); }
  });

  test('isolated ledger retains exactly one PR evidence row and unchanged yellow without a completion declaration', () => {
    const root = mkdtempSync(join(tmpdir(), 'merged-pr-checklist-ledger-'));
    const goal = join(root, 'goal.txt');
    writeFileSync(goal, '칸: X\n진행 중\n');
    setElanousConfigDir(root);
    try {
      addItem('0.2.12', { id: 'X', title: 'X' });
      const deps: MergedPrChecklistDeps = {
        readPr: () => ({ state: 'MERGED', baseRefName: 'main', title: 'misc', body: '칸: X', mergedAt: '2026-10-02T00:00:00Z' }),
        versions: () => ['0.2.12'],
        log: () => {},
      };
      syncMergedPrChecklist(42, root, goal, deps);
      syncMergedPrChecklist(42, root, goal, deps);
      const snapshot = listChecklist('0.2.12');
      expect(snapshot.items.find(({ id }) => id === 'X')).toMatchObject({ status: 'yellow', evidence: '#42' });
      expect(snapshot.history.filter(({ field }) => field === 'evidence.add')).toHaveLength(1);
      expect(snapshot.history.filter(({ field }) => field === 'status')).toHaveLength(0);
    } finally { resetElanousConfigDir(); rmSync(root, { recursive: true, force: true }); }
  });

  test('칸: X in PR body adds one #number evidence line and leaves status unchanged without declaration; repeat is idempotent', () => {
    const f = fixture([item('X')]);
    try {
      syncMergedPrChecklist(42, f.root, undefined, f.deps);
      syncMergedPrChecklist(42, f.root, undefined, f.deps);
      expect(f.calls).toEqual(['evidence X #42']);
      expect(f.items[0]).toMatchObject({ status: 'yellow', evidence: '#42' });
      expect(f.events).toContain('merged-pr-evidence-added');
      expect(f.events).not.toContain('merged-pr-status-green');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test('already green evidence is added once without changing status', () => {
    const f = fixture([item('X', 'green')]);
    try {
      syncMergedPrChecklist(47, f.root, undefined, f.deps);
      expect(f.calls).toEqual(['evidence X #47']);
      expect(f.items[0]).toMatchObject({ status: 'green', evidence: '#47' });
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test('title cell line with a goal declaration turns red green after evidence and logs the transition', () => {
    const f = fixture([item('X', 'red'), item('Y')], '칸: X', '', '칸: X\n이 칸 완료\n');
    try {
      const events: Array<{ event: string; data: unknown }> = [];
      syncMergedPrChecklist(43, f.root, f.path, { ...f.deps, log: (_category, event, data) => { events.push({ event, data }); } });
      expect(f.calls).toEqual(['evidence X #43', 'status X green']);
      expect(f.items[0]).toMatchObject({ status: 'green', evidence: '#43' });
      expect(f.items[1]).toMatchObject({ status: 'yellow' });
      expect(events).toEqual([
        { event: 'merged-pr-evidence-added', data: { version: '0.2.12', id: 'X', pr: 43, ref: '#43' } },
        { event: 'merged-pr-status-green', data: { version: '0.2.12', id: 'X', pr: 43, from: 'red', to: 'green' } },
      ]);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test('a PR citing X and Y with a goal that names only X greens X and skips Y after both get evidence', () => {
    const f = fixture([item('X'), item('Y')], 'unrelated', '칸: X, Y', '칸: X\n이 칸 완료\n');
    try {
      const events: Array<{ event: string; data: unknown }> = [];
      syncMergedPrChecklist(44, f.root, f.path, { ...f.deps, log: (_category, event, data) => { events.push({ event, data }); } });
      expect(f.items[0]).toMatchObject({ status: 'green', evidence: '#44' });
      expect(f.items[1]).toMatchObject({ status: 'yellow', evidence: '#44' });
      expect(f.calls).toEqual(['evidence X #44', 'status X green', 'evidence Y #44']);
      expect(events.filter(({ event }) => event === 'merged-pr-status-green')).toHaveLength(1);
      expect(events.filter(({ event }) => event === 'merged-pr-status-skipped')).toEqual([
        { event: 'merged-pr-status-skipped', data: { version: '0.2.12', id: 'Y', pr: 44, reason: 'goal-does-not-name-cell' } },
      ]);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test('a goal quoting another PR\'s «칸: Y» in prose, a quote or code does not complete Y', () => {
    const goal = '칸: X — 이번 골\n> 지난 PR: 칸: Y — 예전 문구\n설명 속 칸: Y 언급\n```\n칸: Y\n```\n이 칸 완료\n';
    const f = fixture([item('X'), item('Y')], 'unrelated', '칸: X, Y', goal);
    try {
      syncMergedPrChecklist(45, f.root, f.path, f.deps);
      expect(f.events.filter((event) => event === 'merged-pr-status-green')).toHaveLength(1);
      expect(f.events.filter((event) => event === 'merged-pr-status-skipped')).toHaveLength(1);
      expect(f.items[0]).toMatchObject({ status: 'green' });
      expect(f.items[1]).toMatchObject({ status: 'yellow', evidence: '#45' });
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test('code fences close only on the same marker and indented code is not a designation', () => {
    const goal = '칸: X — 이번 골\n```\n~~~\n칸: Y\n```\n    칸: Y\n이 칸 완료\n';
    const f = fixture([item('X'), item('Y')], 'unrelated', '칸: X, Y', goal);
    try {
      syncMergedPrChecklist(46, f.root, f.path, f.deps);
      expect(f.events.filter((event) => event === 'merged-pr-status-green')).toHaveLength(1);
      expect(f.events.filter((event) => event === 'merged-pr-status-skipped')).toHaveLength(1);
      expect(f.items[0]).toMatchObject({ status: 'green' });
      expect(f.items[1]).toMatchObject({ status: 'yellow', evidence: '#46' });
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test('PR body labels inside a quote, a fence or indented code are not evidence; a fenced completion line is not a declaration', () => {
    const body = '> 칸: Y\n```\n칸: Y\n```\n    칸: Y\n칸: X — 실제 라벨\n';
    const f = fixture([item('X'), item('Y')], 'unrelated', body, '칸: X\n```\n이 칸 완료\n```\n');
    try {
      syncMergedPrChecklist(47, f.root, f.path, f.deps);
      expect(f.calls).toEqual(['evidence X #47']);
      expect(f.items[0]?.status).toBe('yellow');
      expect(f.events).not.toContain('merged-pr-status-green');
      expect(f.items[1]?.evidence).toBeUndefined();
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test('a designated cell that does not exist is observed by id even when another cell matched', () => {
    const f = fixture([item('X')], 'unrelated', '칸: X, Z');
    try {
      const events: Array<{ event: string; data: unknown }> = [];
      syncMergedPrChecklist(48, f.root, undefined, { ...f.deps, log: (_c, event, data) => { events.push({ event, data }); } });
      expect(f.calls).toEqual(['evidence X #48']);
      expect(events).toContainEqual({ event: 'merged-pr-cell-not-found', data: { pr: 48, id: 'Z' } });
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test('PR title 칸: X — suffix identifies the cell without a body marker', () => {
    const f = fixture([item('X')], '칸: X — release automation', 'background');
    try {
      syncMergedPrChecklist(49, f.root, undefined, f.deps);
      expect(f.calls).toEqual(['evidence X #49']);
      expect(f.items[0]).toMatchObject({ status: 'yellow', evidence: '#49' });
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test('a prose mention of 칸: X in the PR body is not evidence', () => {
    const f = fixture([item('X')], 'misc', 'Implements 칸: X — release automation');
    try {
      syncMergedPrChecklist(57, f.root, undefined, f.deps);
      expect(f.calls).toEqual([]);
      expect(f.events).toEqual(['merged-pr-cell-not-found']);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test('a line-head body label 칸: X — … adds evidence once while preserving yellow without a goal declaration', () => {
    const f = fixture([item('X')], 'misc', '칸: X — release automation');
    try {
      syncMergedPrChecklist(53, f.root, undefined, f.deps);
      syncMergedPrChecklist(53, f.root, undefined, f.deps);
      expect(f.calls).toEqual(['evidence X #53']);
      expect(f.items[0]).toMatchObject({ status: 'yellow', evidence: '#53' });
      expect(f.events).toEqual(['merged-pr-evidence-added']);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test('inline body label in an isolated ledger writes one history evidence event and no status event', () => {
    const root = mkdtempSync(join(tmpdir(), 'merged-pr-checklist-ledger-'));
    setElanousConfigDir(root);
    try {
      addItem('0.2.12', { id: 'X', title: 'X' });
      const deps: MergedPrChecklistDeps = {
        readPr: () => ({ state: 'MERGED', baseRefName: 'main', title: 'misc', body: '칸: X — release automation', mergedAt: '2026-10-02T00:00:00Z' }),
        versions: () => ['0.2.12'], log: () => {},
      };
      syncMergedPrChecklist(53, root, undefined, deps);
      syncMergedPrChecklist(53, root, undefined, deps);
      const snapshot = listChecklist('0.2.12');
      expect(snapshot.items.find(({ id }) => id === 'X')).toMatchObject({ evidence: '#53', status: 'yellow' });
      expect(snapshot.history.filter(({ field }) => field === 'evidence.add')).toHaveLength(1);
      expect(snapshot.history.filter(({ field }) => field === 'status')).toHaveLength(0);
    } finally { resetElanousConfigDir(); rmSync(root, { recursive: true, force: true }); }
  });

  test('duplicate cell ID in different versions is ambiguous and writes neither evidence nor green', () => {
    const root = mkdtempSync(join(tmpdir(), 'merged-pr-checklist-ledger-'));
    const goal = join(root, 'goal.txt');
    writeFileSync(goal, '이 칸 완료\n');
    setElanousConfigDir(root);
    try {
      addItem('0.2.12', { id: 'X', title: 'X' });
      addItem('0.2.13', { id: 'X', title: 'X' }, { allowDuplicateId: true });
      const events: string[] = [];
      syncMergedPrChecklist(54, root, goal, {
        readPr: () => ({ state: 'MERGED', baseRefName: 'main', title: '칸: X', body: '', mergedAt: '2026-10-02T00:00:00Z' }),
        versions: () => ['0.2.12', '0.2.13'], log: (_category, event) => { events.push(event); },
      });
      for (const version of ['0.2.12', '0.2.13']) {
        const snapshot = listChecklist(version);
        expect(snapshot.items.find(({ id }) => id === 'X')).toMatchObject({ status: 'yellow' });
        expect(snapshot.items.find(({ id }) => id === 'X')?.evidence).toBeUndefined();
        expect(snapshot.history.filter(({ field }) => field === 'evidence.add' || field === 'status')).toHaveLength(0);
      }
      expect(events).toContain('merged-pr-cell-ambiguous');
      expect(events).not.toContain('merged-pr-evidence-added');
    } finally { resetElanousConfigDir(); rmSync(root, { recursive: true, force: true }); }
  });

  test('ambiguous reused ID does not block a different uniquely matched cell', () => {
    const versions = ['0.2.12', '0.2.13'];
    const byVersion = new Map(versions.map((version) => [version, version === '0.2.12' ? [item('X'), item('Y')] : [item('X')]]));
    const writes: string[] = [];
    const events: string[] = [];
    syncMergedPrChecklist(57, '/repo', undefined, {
      readPr: () => ({ state: 'MERGED', baseRefName: 'main', title: '칸: X, Y', body: '', mergedAt: '2026-10-02T00:00:00Z' }),
      versions: () => versions,
      checklist: (version) => ({ version, released: '', dev: version, items: byVersion.get(version)!, history: [] }),
      addEvidence: (id, version, ref) => { writes.push(`${version} ${id} ${ref}`); },
      log: (_category, event) => { events.push(event); },
    });
    expect(writes).toEqual(['0.2.12 Y #57']);
    expect(events).toEqual(['merged-pr-cell-ambiguous', 'merged-pr-evidence-added']);
  });

  test('SQLite-only checklist version is discovered without a schedule or a legacy directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'merged-pr-checklist-ledger-'));
    setElanousConfigDir(root);
    try {
      addItem('8.7.6', { id: 'X', title: 'X' });
      syncMergedPrChecklist(52, root, undefined, {
        readPr: () => ({ state: 'MERGED', baseRefName: 'main', title: 'misc', body: '칸: X', mergedAt: '2026-10-02T00:00:00Z' }),
        log: () => {},
      });
      expect(listChecklist('8.7.6').items.find(({ id }) => id === 'X')).toMatchObject({ status: 'yellow', evidence: '#52' });
    } finally { resetElanousConfigDir(); rmSync(root, { recursive: true, force: true }); }
  });

  test('a PR title marker does not attach to a similarly prefixed cell id', () => {
    const f = fixture([item('X'), item('X2')], '[TC] 칸: X2 — release automation', 'background');
    try {
      syncMergedPrChecklist(51, f.root, undefined, f.deps);
      expect(f.calls).toEqual(['evidence X2 #51']);
      expect(f.items[0]).toMatchObject({ status: 'yellow' });
      expect(f.items[0]?.evidence).toBeUndefined();
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test('inline PR title label identifies X without a body marker', () => {
    const f = fixture([item('X'), item('X2')], 'Implements 칸: X — release automation', 'background');
    try {
      syncMergedPrChecklist(56, f.root, undefined, f.deps);
      expect(f.calls).toEqual(['evidence X #56']);
      expect(f.items[0]).toMatchObject({ status: 'yellow', evidence: '#56' });
      expect(f.items[1]?.evidence).toBeUndefined();
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test('PR title prefix followed by 칸: X identifies X without a body marker', () => {
    const f = fixture([item('X')], '[TC] 칸: X — release automation', 'background');
    try {
      syncMergedPrChecklist(50, f.root, undefined, f.deps);
      expect(f.calls).toEqual(['evidence X #50']);
      expect(f.items[0]).toMatchObject({ status: 'yellow', evidence: '#50' });
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test('an unreadable goal never prevents PR evidence or changes status', () => {
    const f = fixture([item('X')]);
    try {
      syncMergedPrChecklist(48, f.root, join(f.root, 'missing-goal.txt'), f.deps);
      expect(f.calls).toEqual(['evidence X #48']);
      expect(f.items[0]).toMatchObject({ status: 'yellow', evidence: '#48' });
      expect(f.events).toEqual(['merged-pr-goal-unreadable', 'merged-pr-evidence-added']);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test('strong title without a 칸: line is not sufficient for automatic evidence', () => {
    const f = fixture([item('X')], 'X fixed', 'background');
    try {
      syncMergedPrChecklist(46, f.root, undefined, f.deps);
      expect(f.calls).toEqual([]);
      expect(f.events).toEqual(['merged-pr-cell-not-found']);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test('unknown cell is observation only; mention alone and non-main merge do not write', () => {
    const f = fixture([item('Y')], 'other', '칸: X');
    try {
      syncMergedPrChecklist(44, f.root, undefined, f.deps);
      expect(f.calls).toEqual([]);
      expect(f.events).toEqual(['merged-pr-cell-not-found']);
      f.deps.readPr = () => ({ state: 'MERGED', baseRefName: 'other', title: '칸: Y', body: '', mergedAt: '2026-10-02T00:00:00Z' });
      syncMergedPrChecklist(45, f.root, undefined, f.deps);
      expect(f.calls).toEqual([]);
      expect(f.events).toEqual(['merged-pr-cell-not-found']);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
});
