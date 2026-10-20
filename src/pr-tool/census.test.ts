import { expect, test, spyOn } from 'bun:test';
import { debug } from '../debug/log.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cardIdFromBody, censusOpenPrs, guardNewPr, parseDiffHunks, readOpenPrs, recordGuardUnmeasured, type PrToolCommand } from './census.js';

const pr = (number: number, files: string[], extra: Record<string, unknown> = {}) => ({
  number, title: `PR ${number}`, state: 'open', draft: false, updated_at: '2026-10-16T00:00:00Z',
  head: { ref: `branch-${number}`, sha: 'a'.repeat(40) }, body: '', labels: [], files, ...extra,
});

function fixture(rows: ReturnType<typeof pr>[], options: { failAt?: string; filePages?: Record<number, string[][]> } = {}) {
  const calls: string[] = [];
  const run: PrToolCommand = (_command, args) => {
    if (args[0] === 'pr' && args[1] === 'list') {
      calls.push('gh pr list');
      if (options.failAt) return { ok: false, out: '', err: 'projection unavailable' };
      return { ok: true, out: JSON.stringify(rows.map(row => ({
        number: row.number,
        changedFiles: options.filePages?.[row.number]?.flat().length ?? row.files.length,
        files: row.files.map(path => ({ path })),
      }))) };
    }
    const endpoint = args.includes('--slurp') ? args[args.indexOf('--slurp') + 1] ?? '' : args[1] ?? '';
    calls.push(endpoint);
    if (endpoint.includes(options.failAt ?? '\u0000')) return { ok: false, out: '', err: 'network unavailable' };
    if (endpoint.includes('/commits/')) return { ok: true, out: '2026-10-13T00:00:00Z' };
    if (endpoint.includes('/files?')) {
      const number = Number(endpoint.match(/pulls\/(\d+)\/files/)?.[1]);
      const paths = options.filePages?.[number] ?? [rows.find(row => row.number === number)?.files ?? []];
      return { ok: true, out: JSON.stringify(paths.map(page => page.map(filename => ({ filename })))) };
    }
    if (endpoint.includes('/pulls?')) return { ok: true, out: JSON.stringify([rows.slice(0, 2), rows.slice(2)].filter(page => page.length)) };
    throw new Error(endpoint);
  };
  return { run, calls };
}

test('inventory traverses every page and all PR file pages; later-page file overlap warns', () => {
  const f = fixture([
    pr(1, ['src/a.ts']), pr(2, ['src/b.ts']), pr(3, ['src/c.ts']),
  ], { filePages: { 3: [['src/first.ts'], ['src/c.ts']] } });
  const inventory = readOpenPrs(f.run);
  expect(inventory).toMatchObject({ status: 'checked', prs: [{ number: 1 }, { number: 2 }, { number: 3 }] });
  const verdict = guardNewPr({ files: ['src/c.ts'] }, inventory);
  expect(verdict.status).toBe('allow');
  expect(verdict.warnings).toContainEqual(expect.objectContaining({ code: 'file-overlap', prs: [3] }));
  expect(f.calls.some(endpoint => endpoint.includes('/pulls/3/files?'))).toBe(true);
});

test('inventory failure and GitHub file cap stay unknown, never become no-overlap', () => {
  expect(readOpenPrs(fixture([]).run)).toMatchObject({ status: 'checked', prs: [] });
  const failed = readOpenPrs(fixture([pr(1, ['src/a.ts'])], { failAt: '/pulls/1/files?' }).run);
  expect(failed.status).toBe('unknown');
  expect(guardNewPr({ files: ['src/z.ts'] }, failed).status).toBe('unknown');
  const capped = readOpenPrs(fixture([pr(1, [])], { filePages: { 1: Array.from({ length: 30 }, () => Array.from({ length: 100 }, (_, i) => `src/${i}.ts`)) } }).run);
  expect(capped).toMatchObject({ status: 'unknown', reason: expect.stringContaining('3000') });
  const source = fixture([pr(1, ['src/a.ts'])]).run;
  const failedHunk: PrToolCommand = (command, args, opts) =>
    args[0] === 'pr' && args[1] === 'diff'
      ? { ok: false, out: '', err: 'diff unavailable' }
      : source(command, args, opts);
  expect(readOpenPrs(failedHunk, { candidateFiles: ['src/a.ts'] }))
    .toMatchObject({ status: 'unknown', reason: expect.stringContaining('수정 줄 조회 실패') });
});

test('guard refuses goal-only, warns on duplicate files and a measured seat cap', () => {
  const f = fixture([pr(1, ['src/a.ts']), pr(2, ['docs/goals/GOAL-x.md'])]);
  const inventory = readOpenPrs(f.run, { seatOfPr: () => 'UX' });
  expect(guardNewPr({ files: ['docs/goals/GOAL-x.md'], seat: 'UX', seatCap: 2 }, inventory)).toMatchObject({
    status: 'refuse', reasons: [{ code: 'goal-only' }], warnings: [{ code: 'file-overlap', prs: [2] }, { code: 'seat-cap' }],
  });
  expect(guardNewPr({ files: ['src/new.ts'], seat: 'UX', seatCap: 2 }, inventory)).toMatchObject({ status: 'allow', warnings: [{ code: 'seat-cap' }] });
  expect(guardNewPr({ files: null }, inventory).status).toBe('unknown');
});

test('TA card seat callback takes precedence over PR seat label', () => {
  const source = fixture([pr(7, ['src/a.ts'], { labels: [{ name: 'seat:TC' }] })]).run;
  expect(readOpenPrs(source, { seatOfPr: ({ number }) => number === 7 ? 'UX' : null }))
    .toMatchObject({ status: 'checked', prs: [{ number: 7, seat: 'UX' }] });
});

test('five open PRs touching pr-cli.ts are warnings; same cell refuses; line-range hunk warns unless refuse mode', () => {
  const source = readOpenPrs(fixture([1, 2, 3, 4, 5].map(number => pr(number, ['src/cli/pr-cli.ts']))).run);
  const verdict = guardNewPr({ files: ['src/cli/pr-cli.ts'] }, source);
  expect(verdict.status).toBe('allow');
  expect(verdict.warnings).toContainEqual(expect.objectContaining({ code: 'file-overlap', prs: [1, 2, 3, 4, 5] }));
  if (source.status !== 'checked') throw new Error('fixture inventory unreadable');
  const sameCell = { status: 'checked' as const, prs: [{ ...source.prs[0]!, cellId: 'PR-TOOL-SMART-MERGE' }] };
  expect(guardNewPr({ files: ['src/other.ts'], cellId: 'PR-TOOL-SMART-MERGE' }, sameCell))
    .toMatchObject({ status: 'refuse', reasons: [{ code: 'same-cell', prs: [1] }] });
  const hunk = { status: 'checked' as const, prs: [{ ...source.prs[0]!, hunks: [{ path: 'src/cli/pr-cli.ts', start: 50, end: 55 }] }] };
  const hunkWarn = guardNewPr({ files: ['src/cli/pr-cli.ts'], hunks: [{ path: 'src/cli/pr-cli.ts', start: 54, end: 60 }] }, hunk);
  expect(hunkWarn).toMatchObject({ status: 'allow', reasons: [] });
  expect(hunkWarn.warnings).toContainEqual(expect.objectContaining({ code: 'hunk-overlap', prs: [1], files: ['src/cli/pr-cli.ts'] }));
  expect(guardNewPr({ files: ['src/cli/pr-cli.ts'], hunks: [{ path: 'src/cli/pr-cli.ts', start: 54, end: 60 }], hunkOverlap: 'refuse' }, hunk))
    .toMatchObject({ status: 'refuse', reasons: [{ code: 'hunk-overlap', prs: [1], files: ['src/cli/pr-cli.ts'] }] });
  expect(guardNewPr({ files: ['src/cli/pr-cli.ts'], hunks: [{ path: 'src/cli/pr-cli.ts', start: 54, end: 60 }], cellId: 'PR-TOOL-SMART-MERGE' }, { status: 'checked', prs: [{ ...hunk.prs[0]!, cellId: 'PR-TOOL-SMART-MERGE' }] }))
    .toMatchObject({ status: 'refuse', reasons: [{ code: 'same-cell', prs: [1] }] });
  expect(parseDiffHunks('diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n@@ -4,2 +9,3 @@\n'))
    .toEqual([{ path: 'src/a.ts', start: 4, end: 5 }]);
  expect(parseDiffHunks('diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ /dev/null\n@@ -10,3 +0,0 @@\n'))
    .toEqual([{ path: 'src/a.ts', start: 10, end: 12 }]);
  expect(parseDiffHunks('diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -4,2 +4,0 @@\n--- a/src/fake.ts\n@@ -20,2 +18,0 @@\n'))
    .toEqual([{ path: 'src/a.ts', start: 4, end: 5 }, { path: 'src/a.ts', start: 20, end: 21 }]);
});

test('same-cell reuse requires one open PR with the exact card lineage and branch identity', () => {
  const rows = [pr(7, ['src/a.ts'], { body: '칸: PR-SAME-CELL-REUSE\n카드: ta-123' })];
  const inventory = readOpenPrs(fixture(rows).run);
  expect(inventory).toMatchObject({ status: 'checked', prs: [{ headRefName: 'branch-7', cardId: 'ta-123' }] });
  expect(cardIdFromBody('카드: ta-123\n카드: ta-456')).toBeNull();
  expect(cardIdFromBody('카드: ta-123\n카드: ta-123')).toBe('ta-123');
  expect(cardIdFromBody('카드: ta-123\n카드: invalid value')).toBeNull();
  const candidate = { files: ['src/b.ts'], cellId: 'PR-SAME-CELL-REUSE', cardId: 'ta-123' };
  expect(guardNewPr(candidate, inventory).sameCellReuse).toMatchObject({ number: 7, branch: 'branch-7', cardId: 'ta-123' });
  expect(guardNewPr({ ...candidate, cardId: 'ta-other' }, inventory).sameCellReuse).toBeUndefined();
  const ambiguous = readOpenPrs(fixture([pr(7, ['src/a.ts'], { body: '칸: PR-SAME-CELL-REUSE\n카드: ta-123\n카드: ta-other' })]).run);
  expect(guardNewPr(candidate, ambiguous).sameCellReuse).toBeUndefined();
  expect(ambiguous).toMatchObject({ status: 'checked', prs: [{ cardId: null, cardMarkerPresent: true }] });
  expect(guardNewPr({ ...candidate, boundPrNumber: 7 }, ambiguous).sameCellReuse).toBeUndefined();
  if (inventory.status !== 'checked') throw new Error('fixture inventory unreadable');
  expect(guardNewPr(candidate, { status: 'checked', prs: [...inventory.prs, { ...inventory.prs[0]!, number: 8 }] }).sameCellReuse).toBeUndefined();
  const legacy = readOpenPrs(fixture([pr(7, ['src/a.ts'], { body: '칸: PR-SAME-CELL-REUSE' })]).run);
  expect(guardNewPr({ ...candidate, boundPrNumber: 7 }, legacy).sameCellReuse).toMatchObject({ number: 7, legacyBound: true });
  expect(guardNewPr({ ...candidate, boundPrNumber: 8 }, legacy).sameCellReuse).toBeUndefined();
});

test('census uses last commit date for stale draft and identifies close candidates', () => {
  const f = fixture([
    pr(1, ['docs/goals/GOAL-x.md']),
    pr(2, ['src/a.ts'], { draft: true }),
    pr(3, ['src/b.ts'], { labels: [{ name: 'elanous:superseded' }] }),
  ]);
  const inventory = readOpenPrs(f.run, { includeDraftCommitDates: true, seatOfPr: ({ number }) => number === 1 ? 'UX' : null });
  const result = censusOpenPrs(inventory, Date.parse('2026-10-16T00:00:00Z'));
  expect(result).toMatchObject({ status: 'checked', total: 3, rows: [
    { seat: 'UX', open: 1, goalOnly: 1 },
    { seat: 'unknown', open: 2, staleDraft: 1, supersededOpen: 1 },
  ], closeCandidates: [
    { number: 1, reason: 'goal-only' }, { number: 2, reason: 'stale-draft' }, { number: 3, reason: 'superseded-open' },
  ] });
  expect(f.calls.some(endpoint => endpoint.includes('/commits/'))).toBe(true);
});

test('refusal emits pr.tool observation with reason code', () => {
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    guardNewPr({ files: ['docs/goals/GOAL-x.md'] }, { status: 'checked', prs: [] });
    expect(log).toHaveBeenCalledWith('pr.tool', 'guard-refuse', expect.objectContaining({ reasons: [expect.objectContaining({ code: 'goal-only' })] }));
  } finally { log.mockRestore(); }
});

test('same-seat unmeasured reads allow three in one hour, then block; another seat has its own count', () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'pr-tool-unmeasured-'));
  try {
    const call = (seat: 'UX' | 'TC', now: number, host = 'node-b') => recordGuardUnmeasured({ seat, reason: 'network', stateRoot, host, now });
    expect(call('UX', 1_000_000)).toMatchObject({ count: 1, blocked: false });
    expect(call('UX', 1_000_001)).toMatchObject({ count: 2, blocked: false });
    expect(call('UX', 1_000_002)).toMatchObject({ count: 3, blocked: false });
    expect(call('UX', 1_000_003)).toMatchObject({ count: 4, blocked: true });
    expect(call('TC', 1_000_004)).toMatchObject({ count: 1, blocked: false });
    expect(call('UX', 1_000_005, 'node-c')).toMatchObject({ count: 1, blocked: false });
    expect(call('UX', 1_000_000 + 3_600_001)).toMatchObject({ count: 3, blocked: false });
    const lines = readFileSync(join(stateRoot, 'pr-tool', 'guard-unmeasured.jsonl'), 'utf8').trim().split('\n');
    expect(lines.length).toBe(5);
  } finally { rmSync(stateRoot, { recursive: true, force: true }); }
});
