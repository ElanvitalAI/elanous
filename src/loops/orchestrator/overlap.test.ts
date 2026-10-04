import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectWork, findOverlaps, renderOverlaps, type WorkItem } from './overlap.js';
import type { HarnessProcessRecord } from '../../harness/harness-cli-command.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const work: WorkItem[] = [
  { kind: 'pr', ref: '#1', seat: 'TC', files: ['src/a.ts', 'release/next.md'], cells: ['W9'] },
  { kind: 'goal', ref: 'ASK-X.txt', seat: 'MK', files: ['src/a.ts', 'release/next.md'], cells: ['ORCH2'] },
  { kind: 'goal', ref: 'ASK-Y.txt', seat: 'UX', files: ['src/b.ts'], cells: ['ORCH2'] },
  { kind: 'goal', ref: 'ASK-Z.txt', seat: 'TC', files: [], cells: [], unreadable: true },
];

test('four-work fixture exposes exactly the file and cell across seats; common append-only file is excluded', () => {
  const found = findOverlaps(work);
  expect(found).toEqual([
    { type: 'file', path: 'src/a.ts', refs: [
      { kind: 'pr', ref: '#1', seat: 'TC' }, { kind: 'goal', ref: 'ASK-X.txt', seat: 'MK' },
    ], crossSeat: true },
    { type: 'cell', cell: 'ORCH2', refs: [
      { kind: 'goal', ref: 'ASK-X.txt', seat: 'MK' }, { kind: 'goal', ref: 'ASK-Y.txt', seat: 'UX' },
    ], crossSeat: true },
  ]);
  expect(work.filter(item => item.unreadable)).toHaveLength(1);
  expect(renderOverlaps(found)).toEqual([
    '⚠ 겹침 file src/a.ts — PR #1(TC) · goal ASK-X.txt(MK) · 먼저 착지하는 쪽 뒤에 다른 쪽 rebase',
    '⚠ 같은 칸 ORCH2 — goal ASK-X.txt(MK) · goal ASK-Y.txt(UX)',
  ]);
  expect(findOverlaps(work, [])).toContainEqual({ type: 'file', path: 'release/next.md', refs: [
    { kind: 'pr', ref: '#1', seat: 'TC' }, { kind: 'goal', ref: 'ASK-X.txt', seat: 'MK' },
  ], crossSeat: true });
});

test('collectWork reads open PR title/body and running goal documents, keeping unreadable distinct from empty', () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-overlap-')); roots.push(root);
  const seats = ['tc', 'mk', 'ux'].map(name => {
    const cwd = join(root, name);
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(join(cwd, '.git'), 'gitdir: elsewhere\n');
    writeFileSync(join(cwd, '.claude', 'seat'), name.toUpperCase());
    return cwd;
  });
  const [tc, mk, ux] = seats as [string, string, string];
  writeFileSync(join(mk, 'ASK-X.txt'), '대상 경로: src/a.ts · release/next.md\n\n0.2.14 칸 ORCH2\n');
  writeFileSync(join(ux, 'ASK-Y.txt'), '대상 경로: src/b.ts\n\n0.2.14 칸 ORCH2\n');
  const process = (pid: number, cwd: string, command: string): HarnessProcessRecord => ({
    pid, ppid: 1, cpuPercent: 0, elapsedSeconds: 20, command, cwd, cwdStatus: 'observed',
  });
  const records = [
    process(10, mk, 'bun bin/elanous.mjs harness ask ASK-X.txt'),
    process(11, ux, 'bun bin/elanous.mjs harness say --file ASK-Y.txt'),
    process(12, tc, 'bun bin/elanous.mjs dev --implement ASK-Z.txt'),
    process(13, tc, 'bun bin/elanous.mjs harness processes'),
    process(14, tc, 'bun -e "console.log(\'harness ask ASK-X.txt\')"'),
    process(15, tc, 'bun bin/elanous.mjs gh pr list --search harness ask ASK-X.txt'),
    process(16, tc, 'bun bin/elanous.mjs dev --json harness ask ASK-X.txt'),
  ];
  const calls: string[][] = [];
  const observed = collectWork({
    runGh: args => {
      calls.push(args);
      return JSON.stringify([{ number: 1, title: '[TC] PR W9 0.2.14 칸 W9', body: '0.2.14 칸 W9', headRefName: 'work', isDraft: false,
        files: [{ path: 'src/a.ts' }, { path: 'release/next.md' }] }]);
    },
    listProcesses: () => ({ status: 'ok', records, excludedCount: 0 }),
  });
  expect(calls).toEqual([['pr', 'list', '--state', 'open', '--limit', '1000', '--json', 'number,title,body,headRefName,files,isDraft']]);
  expect(observed).toEqual(work);
  expect(findOverlaps(observed)).toEqual(findOverlaps(work));
});

test('CLI --json keeps stdout parseable while retaining the summary on stderr; text mode ends in summary', () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-overlap-cli-')); roots.push(root);
  const bin = join(root, 'bin'); mkdirSync(bin);
  for (const [name, script] of [
    ['bun', '#!/bin/sh\nprintf "[]\\n"\n'],
    ['ps', '#!/bin/sh\nexit 0\n'],
  ]) {
    const path = join(bin, name);
    writeFileSync(path, script);
    chmodSync(path, 0o755);
  }
  const run = (args: string[]) => spawnSync(process.execPath, [join(import.meta.dir, 'overlap.ts'), ...args], {
    cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, NODE_ENV: 'test' },
  });
  const json = run(['--json']);
  expect(json.status).toBe(0);
  expect(JSON.parse(json.stdout)).toEqual({ work: [], overlaps: [] });
  expect(json.stderr.trim().split('\n').at(-1)).toBe('overlap work=0 files=0 cells=0 crossSeat=0 unreadable=0');
  const text = run([]);
  expect(text.status).toBe(0);
  expect(text.stdout.trim()).toBe('overlap work=0 files=0 cells=0 crossSeat=0 unreadable=0');
});

test('relative goal paths require observed cwd even when another tree has a same-named document', () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-overlap-cwd-')); roots.push(root);
  const observed = join(root, 'observed');
  mkdirSync(observed);
  writeFileSync(join(root, 'ASK-X.txt'), '대상 경로: src/a.ts\n0.2.14 칸 ORCH2\n');
  writeFileSync(join(observed, 'ASK-X.txt'), '대상 경로: src/b.ts\n0.2.14 칸 OBSERVED\n');
  const absolute = join(root, 'ASK-X.txt');
  const record = (pid: number, command: string, cwd?: string, cwdStatus?: 'observed' | 'unknown'): HarnessProcessRecord => ({
    pid, ppid: 1, cpuPercent: 0, elapsedSeconds: 20, command, cwd, cwdStatus,
  });
  const records = [
    record(1, 'bun bin/elanous.mjs harness ask ASK-X.txt', root, 'unknown'),
    record(2, 'bun bin/elanous.mjs harness ask ASK-X.txt'),
    record(3, 'bun bin/elanous.mjs harness ask ASK-X.txt', observed, 'observed'),
    record(4, `bun bin/elanous.mjs harness ask ${absolute}`, undefined, 'unknown'),
  ];
  const reads: string[] = [];
  const result = collectWork({
    runGh: () => '[]',
    listProcesses: () => ({ status: 'ok', records, excludedCount: 0 }),
    config: { seatTrees: {} },
    readGoal: path => { reads.push(path); return readFileSync(path, 'utf8'); },
  });
  expect(reads).toEqual([join(observed, 'ASK-X.txt'), absolute]);
  expect(result).toEqual([
    { kind: 'goal', ref: 'ASK-X.txt', seat: null, files: [], cells: [], unreadable: true },
    { kind: 'goal', ref: 'ASK-X.txt', seat: null, files: [], cells: [], unreadable: true },
    { kind: 'goal', ref: 'ASK-X.txt', seat: null, files: ['src/b.ts'], cells: ['OBSERVED'] },
    { kind: 'goal', ref: 'ASK-X.txt', seat: null, files: ['src/a.ts'], cells: ['ORCH2'] },
  ]);
  expect(findOverlaps(result)).toEqual([]);
});

test('PR title alone and body alone each contribute cell ids, without duplicate cells', () => {
  const observed = collectWork({
    runGh: () => JSON.stringify([
      { number: 1, title: '[TC] 0.2.14 칸 ORCH2', body: '0.2.14 칸 ORCH2', headRefName: 'one', files: [], isDraft: true },
      { number: 2, title: '[MK] another PR', body: '0.2.14 칸 ORCH2', headRefName: 'two', files: [], isDraft: false },
    ]),
    listProcesses: () => ({ status: 'ok', records: [], excludedCount: 0 }),
    config: { seatTrees: {} },
  });
  expect(observed.map(item => item.cells)).toEqual([['ORCH2'], ['ORCH2']]);
  expect(findOverlaps(observed)).toEqual([{
    type: 'cell', cell: 'ORCH2', refs: [{ kind: 'pr', ref: '#1', seat: 'TC' }, { kind: 'pr', ref: '#2', seat: 'MK' }], crossSeat: true,
  }]);
});

test('empty readable goal, duplicate entries and unknown seats do not manufacture conflicts', () => {
  const items: WorkItem[] = [
    { kind: 'goal', ref: 'one', seat: null, files: ['src/a.ts', 'src/a.ts'], cells: ['ORCH2', 'ORCH2'] },
    { kind: 'goal', ref: 'two', seat: null, files: [], cells: [] },
  ];
  expect(findOverlaps(items)).toEqual([]);
  items.push({ kind: 'goal', ref: 'three', seat: 'MK', files: ['src/a.ts'], cells: ['ORCH2'] });
  expect(findOverlaps(items).map(overlap => overlap.crossSeat)).toEqual([false, false]);
});
