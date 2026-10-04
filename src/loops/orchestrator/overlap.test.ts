import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
  expect(calls).toEqual([['pr', 'list', '--state', 'open', '--limit', '1000', '--json', 'number,title,body,headRefName,files,isDraft,labels']]);
  expect(observed).toEqual({ work, excluded: { stalled: 0, superseded: 0, draft: 0 }, unreadableTrees: 0, unreadableGoals: 0 });
  expect(findOverlaps(observed.work)).toEqual(findOverlaps(work));
});

test('CLI --json keeps stdout parseable while retaining the summary on stderr; text mode ends in summary', () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-overlap-cli-')); roots.push(root);
  const bin = join(root, 'bin'); mkdirSync(bin);
  for (const [name, script] of [
    ['bun', '#!/bin/sh\nprintf "%s\\n" "${PR_LIST:-[]}"\n'],
    ['ps', '#!/bin/sh\nexit 0\n'],
  ]) {
    const path = join(bin, name);
    writeFileSync(path, script);
    chmodSync(path, 0o755);
  }
  const run = (args: string[], prList = '[]') => spawnSync(process.execPath, [join(import.meta.dir, 'overlap.ts'), ...args], {
    cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, NODE_ENV: 'test',
      PR_LIST: prList, XDG_CONFIG_HOME: join(root, 'config'), ELANOUS_SUPPRESS_XDG_WARNING: '1' },
  });
  const json = run(['--json']);
  expect(json.status).toBe(0);
  expect(JSON.parse(json.stdout)).toEqual({ work: [], overlaps: [], excluded: { stalled: 0, superseded: 0, draft: 0 }, seatNull: 0, unreadableTrees: 0, unreadableGoals: 0 });
  expect(json.stderr.trim().split('\n').at(-1)).toBe('overlap work=0 files=0 cells=0 crossSeat=0 unreadable=0 excluded=stalled:0,superseded:0,draft:0 seatNull=0 unreadableTrees=0 unreadableGoals=0');
  const text = run([]);
  expect(text.status).toBe(0);
  expect(text.stdout.trim()).toBe('overlap work=0 files=0 cells=0 crossSeat=0 unreadable=0 excluded=stalled:0,superseded:0,draft:0 seatNull=0 unreadableTrees=0 unreadableGoals=0');

  const configDir = join(root, 'config', 'elanous');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ loops: { orchestrator: { seatTrees: { TC: [join(root, 'missing')] } } } }));
  const logDir = join(root, '.elanous', 'debug');
  const readExchanges = () => readdirSync(logDir).filter(name => name.startsWith('debug-')).flatMap(name =>
    readFileSync(join(logDir, name), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)))
    .filter(event => event.category === 'loop.orchestrator' && event.event === 'exchange')
    // Several debug-* files are concatenated by name; order by event time so slice(before) takes the newest.
    .sort((a, b) => String(a.ts ?? a.timestamp ?? '').localeCompare(String(b.ts ?? b.timestamp ?? '')));
  for (const prs of [
    [{ number: 301, title: '[MK] Prefixed', files: [], isDraft: false, labels: [] }],
    [{ number: 302, title: 'Parked', files: [], isDraft: true, labels: [] }],
    [],
  ]) {
    const before = readExchanges().length;
    const observed = run(['--json'], JSON.stringify(prs));
    expect(observed.status).toBe(0);
    expect(JSON.parse(observed.stdout).unreadableTrees).toBe(1);
    expect(observed.stderr.trim().split('\n').at(-1)).toContain('unreadableTrees=1');
    expect(observed.stderr.trim().split('\n').at(-1)).toContain('seatNull=0');
    const freshExchanges = readExchanges().slice(before);
    expect(freshExchanges).toHaveLength(1);
    expect(freshExchanges[0].data.unreadableTrees).toBe(1);
    expect(freshExchanges[0].data).toMatchObject({
      seatNull: 0, excluded: { stalled: 0, superseded: 0, draft: prs[0]?.number === 302 ? 1 : 0 },
    });
  }
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
  expect(result).toEqual({ work: [
    { kind: 'goal', ref: 'ASK-X.txt', seat: null, files: [], cells: [], unreadable: true },
    { kind: 'goal', ref: 'ASK-X.txt', seat: null, files: [], cells: [], unreadable: true },
    { kind: 'goal', ref: 'ASK-X.txt', seat: null, files: ['src/b.ts'], cells: ['OBSERVED'] },
    { kind: 'goal', ref: 'ASK-X.txt', seat: null, files: ['src/a.ts'], cells: ['ORCH2'] },
  ], excluded: { stalled: 0, superseded: 0, draft: 0 }, unreadableTrees: 0, unreadableGoals: 0 });
  expect(findOverlaps(result.work)).toEqual([]);
});

test('PR title alone and body alone each contribute cell ids, without duplicate cells', () => {
  const observed = collectWork({
    runGh: () => JSON.stringify([
      { number: 1, title: '[TC] 0.2.14 칸 ORCH2', body: '0.2.14 칸 ORCH2', headRefName: 'one', files: [], isDraft: false },
      { number: 2, title: '[MK] another PR', body: '0.2.14 칸 ORCH2', headRefName: 'two', files: [], isDraft: false },
    ]),
    listProcesses: () => ({ status: 'ok', records: [], excludedCount: 0 }),
    config: { seatTrees: {} },
  });
  expect(observed.work.map(item => item.cells)).toEqual([['ORCH2'], ['ORCH2']]);
  expect(findOverlaps(observed.work)).toEqual([{
    type: 'cell', cell: 'ORCH2', refs: [{ kind: 'pr', ref: '#1', seat: 'TC' }, { kind: 'pr', ref: '#2', seat: 'MK' }], crossSeat: true,
  }]);
});

test('ready harness PRs resolve seats from goal documents while parked and unlabeled drafts are excluded', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orch-overlap-seats-'))); roots.push(root);
  const mk = join(root, 'mk');
  const tc = join(root, 'tc');
  for (const tree of [mk, tc]) mkdirSync(join(tree, 'docs', 'goals'), { recursive: true });
  writeFileSync(join(mk, 'docs', 'goals', 'mk.md'), 'prNumber: 101\n');
  writeFileSync(join(tc, 'docs', 'goals', 'tc.md'), 'prNumber: 102\n');
  const pr = (number: number, isDraft: boolean, labels: string[] = []) => ({ number, title: `Harness PR ${number}`,
    body: '', headRefName: `pr-${number}`, files: [{ path: 'src/a.ts' }], isDraft, labels: labels.map(name => ({ name })) });
  const result = collectWork({
    runGh: () => JSON.stringify([
      pr(101, false), pr(102, false), pr(103, true, ['elanous:stalled']),
      pr(104, true, ['elanous:superseded']), pr(105, true),
    ]),
    listProcesses: () => ({ status: 'ok', records: [], excludedCount: 0 }),
    config: { seatTrees: { MK: [mk], TC: [tc] } },
  });
  expect(result.work.map(({ ref, seat }) => ({ ref, seat }))).toEqual([
    { ref: '#101', seat: 'MK' }, { ref: '#102', seat: 'TC' },
  ]);
  expect(result.excluded).toEqual({ stalled: 1, superseded: 1, draft: 1 });
  expect(result.unreadableTrees).toBe(0);
  expect(findOverlaps(result.work)).toEqual([{ type: 'file', path: 'src/a.ts', refs: [
    { kind: 'pr', ref: '#101', seat: 'MK' }, { kind: 'pr', ref: '#102', seat: 'TC' },
  ], crossSeat: true }]);

  writeFileSync(join(tc, 'docs', 'goals', 'duplicate.md'), 'prNumber: 101\n');
  const ambiguous = collectWork({
    runGh: () => JSON.stringify([pr(101, false), pr(102, false)]),
    listProcesses: () => ({ status: 'ok', records: [], excludedCount: 0 }),
    config: { seatTrees: { MK: [mk], TC: [tc] } },
  });
  expect(ambiguous.work.map(item => item.seat)).toEqual([null, 'TC']);
  expect(findOverlaps(ambiguous.work)[0]?.crossSeat).toBe(false);
});

test('unreadable seat trees are counted without erasing readable trees or prefixed seats', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orch-overlap-unreadable-'))); roots.push(root);
  const tc = join(root, 'tc');
  mkdirSync(join(tc, 'docs', 'goals'), { recursive: true });
  writeFileSync(join(tc, 'docs', 'goals', 'tc.md'), 'prNumber: 201\n');
  writeFileSync(join(tc, 'docs', 'goals', 'prefixed.md'), 'prNumber: 202\n');
  const result = collectWork({
    runGh: () => JSON.stringify([
      { number: 201, title: 'Harness PR', files: [], isDraft: false, labels: [] },
      { number: 202, title: '[MK] Prefixed', files: [], isDraft: false, labels: [] },
      { number: 203, title: 'Unmatched PR', files: [], isDraft: false, labels: [] },
    ]),
    listProcesses: () => ({ status: 'ok', records: [], excludedCount: 0 }),
    config: { seatTrees: { TC: [tc], MK: [join(root, 'missing')] } },
  });
  expect(result.work.map(item => item.seat)).toEqual(['TC', 'MK', null]);
  expect(result.unreadableTrees).toBe(1);
});

test('unreadable seat trees are counted independently of whether ready PRs need seat lookup', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orch-overlap-no-lookup-'))); roots.push(root);
  const missing = join(root, 'missing');
  const listProcesses = () => ({ status: 'ok' as const, records: [], excludedCount: 0 });
  const config = { seatTrees: { TC: [missing] } };
  for (const prs of [
    [{ number: 301, title: '[MK] Prefixed', files: [], isDraft: false, labels: [] }],
    [{ number: 302, title: 'Parked', files: [], isDraft: true, labels: [] }],
    [],
  ]) {
    const result = collectWork({ runGh: () => JSON.stringify(prs), listProcesses, config });
    expect(result.unreadableTrees).toBe(1);
    expect(result.work.map(item => item.seat)).toEqual(prs[0]?.number === 301 ? ['MK'] : []);
  }
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

test('one unreadable goal file is counted without dropping the rest of that tree', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orch-overlap-goal-file-'))); roots.push(root);
  const mk = join(root, 'mk');
  mkdirSync(join(mk, 'docs', 'goals'), { recursive: true });
  writeFileSync(join(mk, 'docs', 'goals', 'a-broken.md'), 'prNumber: 300\n');
  writeFileSync(join(mk, 'docs', 'goals', 'b-ok.md'), 'prNumber: 301\n');
  const result = collectWork({
    runGh: () => JSON.stringify([{ number: 301, title: 'Harness PR', files: [], isDraft: false, labels: [] }]),
    listProcesses: () => ({ status: 'ok', records: [], excludedCount: 0 }),
    readGoal: path => { if (path.endsWith('a-broken.md')) throw new Error('EACCES'); return readFileSync(path, 'utf8'); },
    config: { seatTrees: { MK: [mk] } },
  });
  expect(result.work.map(item => item.seat)).toEqual(['MK']);
  expect(result.unreadableGoals).toBe(1);
  expect(result.unreadableTrees).toBe(0);
});
