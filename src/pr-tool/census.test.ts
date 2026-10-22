import { afterEach, expect, test, spyOn } from 'bun:test';
import { debug } from '../debug/log.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { withFakeBins } from '../ux-sim/fake-bin.js';
import { CensusDiffCache, resetCensusDiffCache, sharedCensusDiffCache, cardIdFromBody, censusOpenPrs, guardNewPr, parseDiffHunks, readOpenPrs, recordGuardUnmeasured, sliceMarkerFromBody, spawnParallelCommands,
  type PrToolCall, type PrToolCommand, type PrToolCommandResult, type PrToolParallelCommand } from './census.js';

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

test('sibling slices sharing a card never reuse a different slice branch', () => {
  const body = '칸: PR-SAME-CELL-SLICE\n카드: ta-shared\n조각 1/3 — 부모 PR-SAME-CELL-SLICE';
  const inventory = readOpenPrs(fixture([pr(7, ['src/a.ts'], { body })]).run);
  expect(inventory).toMatchObject({ status: 'checked', prs: [{ slice: { slice: 1, total: 3 } }] });
  const candidate = { files: ['src/b.ts'], cellId: 'PR-SAME-CELL-SLICE', cardId: 'ta-shared',
    slice: { slice: 2, total: 3 } };
  expect(guardNewPr(candidate, inventory).sameCellReuse).toBeUndefined();
  expect(guardNewPr({ ...candidate, slice: { slice: 1, total: 3 } }, inventory).sameCellReuse)
    .toMatchObject({ number: 7, cardId: 'ta-shared' });
  expect(guardNewPr({ ...candidate, slice: null }, inventory).sameCellReuse).toBeUndefined();
  expect(sliceMarkerFromBody('조각 2/3 · 설명만 있음')).toBeNull();
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

// ── PR-CENSUS-PARALLEL: bounded parallel diff fetch ⊕ headSha cache ─────────────────────────────────

const patchFor = (number: number) => `diff --git a/src/shared.ts b/src/shared.ts\n--- a/src/shared.ts\n+++ b/src/shared.ts\n@@ -${number * 10},2 +${number * 10},3 @@\n`;

/** fixture() plus `gh pr diff <N> --patch`; `diffs` records every diff call. */
function diffFixture(rows: ReturnType<typeof pr>[], options: { failDiff?: readonly number[] } = {}) {
  const base = fixture(rows);
  const diffs: number[] = [];
  const run: PrToolCommand = (command, args, opts) => {
    if (args[0] === 'pr' && args[1] === 'diff') {
      const number = Number(args[2]);
      diffs.push(number);
      return options.failDiff?.includes(number) ? { ok: false, out: '', err: `diff ${number} unavailable` } : { ok: true, out: patchFor(number) };
    }
    return base.run(command, args, opts);
  };
  return { run, diffs };
}

/** Parallel seam over an injected runner that executes calls in REVERSE order — the result order must not depend on it. */
function reversedParallel(run: PrToolCommand, seen: { concurrency: number[]; calls: PrToolCall[][] }): PrToolParallelCommand {
  return (calls, concurrency) => {
    seen.concurrency.push(concurrency);
    seen.calls.push([...calls]);
    const results: PrToolCommandResult[] = new Array(calls.length);
    for (let i = calls.length - 1; i >= 0; i--) results[i] = run(calls[i]!.command, calls[i]!.args, calls[i]!.opts);
    return results;
  };
}

const overlapping = (count: number) => Array.from({ length: count }, (_, i) => pr(i + 1, ['src/shared.ts'], { head: { ref: `branch-${i + 1}`, sha: `${i + 1}`.padStart(40, 'b') } }));

test('PR-CENSUS-PARALLEL: real spawn pool keeps in-flight ≤ cap and actually overlaps (>1)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'census-pool-'));
  try {
    const log = join(dir, 'events.log');
    const calls: PrToolCall[] = Array.from({ length: 14 }, (_, i) => ({ command: 'sh', args: ['-c', `echo s >> "${log}"; sleep 0.15; echo e >> "${log}"; printf 'out-${i}'`] }));
    const results = spawnParallelCommands(calls, { concurrency: 4 });
    expect(results.map(r => r.out)).toEqual(calls.map((_, i) => `out-${i}`));
    expect(results.every(r => r.ok)).toBe(true);
    let inFlight = 0; let peak = 0;
    for (const event of readFileSync(log, 'utf8').trim().split('\n')) { inFlight += event === 's' ? 1 : -1; peak = Math.max(peak, inFlight); }
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
    // A failing call reports its own failure without hiding the others.
    const mixed = spawnParallelCommands([{ command: 'sh', args: ['-c', 'echo bad >&2; exit 3'] }, { command: 'sh', args: ['-c', 'printf ok'] }], { concurrency: 2 });
    expect(mixed).toEqual([{ ok: false, out: '', err: 'bad' }, { ok: true, out: 'ok', err: '' }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('PR-CENSUS-PARALLEL: parallel verdict equals the sequential verdict (prs · hunks · status), input order kept', () => {
  const rows = [...overlapping(8), pr(20, ['src/other.ts'])];
  const sequential = diffFixture(rows);
  const parallel = diffFixture(rows);
  const seen = { concurrency: [] as number[], calls: [] as PrToolCall[][] };
  const before = readOpenPrs(sequential.run, { candidateFiles: ['src/shared.ts'] });
  const after = readOpenPrs(parallel.run, { candidateFiles: ['src/shared.ts'], runParallel: reversedParallel(parallel.run, seen) });
  expect(after).toEqual(before);
  expect(after).toMatchObject({ status: 'checked', prs: [...Array.from({ length: 8 }, (_, i) => ({ number: i + 1, hunks: [{ path: 'src/shared.ts', start: (i + 1) * 10 }] })), { number: 20 }] });
  expect(seen.concurrency).toEqual([6]);
  expect(seen.calls[0]!.map(call => call.args.join(' '))).toEqual(Array.from({ length: 8 }, (_, i) => `pr diff ${i + 1} --patch`));
  expect(parallel.diffs.sort((a, b) => a - b)).toEqual(sequential.diffs);
  const candidate = { files: ['src/shared.ts'], hunks: [{ path: 'src/shared.ts', start: 30, end: 31 }], cellId: 'X-CELL' };
  expect(guardNewPr(candidate, after)).toEqual(guardNewPr(candidate, before));
});

test('PR-CENSUS-PARALLEL: the same headSha is served from the cache on the second guard call; a new head refetches', () => {
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    const cache = new CensusDiffCache();
    const rows = overlapping(5);
    const f = diffFixture(rows);
    const seen = { concurrency: [] as number[], calls: [] as PrToolCall[][] };
    const first = readOpenPrs(f.run, { candidateFiles: ['src/shared.ts'], runParallel: reversedParallel(f.run, seen), diffCache: cache });
    expect(f.diffs.length).toBe(5);
    const second = readOpenPrs(f.run, { candidateFiles: ['src/shared.ts'], runParallel: reversedParallel(f.run, seen), diffCache: cache });
    expect(f.diffs.length).toBe(5);
    expect(seen.calls.length).toBe(1);
    expect(second).toEqual(first);
    const scans = log.mock.calls.filter(([category, event]) => category === 'pr-tool.census' && event === 'diff-scan').map(call => call[2]);
    expect(scans).toEqual([
      expect.objectContaining({ openPrs: 5, projected: 5, restFallback: 0, projectionFailed: false, fileOverlap: 5, patchFetched: 5, concurrency: 6, cacheHits: 0, status: 'checked', elapsedMs: expect.any(Number) }),
      expect.objectContaining({ openPrs: 5, fileOverlap: 5, patchFetched: 0, cacheHits: 5, status: 'checked' }),
    ]);
    const moved = diffFixture([{ ...rows[0]!, head: { ref: 'branch-1', sha: 'c'.repeat(40) } }, ...rows.slice(1)]);
    readOpenPrs(moved.run, { candidateFiles: ['src/shared.ts'], diffCache: cache });
    expect(moved.diffs).toEqual([1]);
    const bounded = new CensusDiffCache(2);
    bounded.set(1, 'a', 'p1'); bounded.set(2, 'a', 'p2'); bounded.set(3, 'a', 'p3');
    expect([bounded.size, bounded.get(1, 'a'), bounded.get(3, 'a')]).toEqual([2, undefined, 'p3']);
    // Byte ceilings: total bytes evict the oldest; one patch above the per-entry limit is never cached.
    const bytes = new CensusDiffCache(100, 10, 6);
    bytes.set(1, 'a', 'aaaa'); bytes.set(2, 'a', 'bbbb'); bytes.set(3, 'a', 'cccc');
    expect([bytes.size, bytes.bytes, bytes.get(1, 'a'), bytes.get(3, 'a')]).toEqual([2, 8, undefined, 'cccc']);
    bytes.set(4, 'a', 'x'.repeat(7));
    expect([bytes.get(4, 'a'), bytes.size, bytes.bytes]).toEqual([undefined, 2, 8]);
  } finally { log.mockRestore(); }
});

test('PR-CENSUS-PARALLEL: one failed diff keeps the whole inventory unknown (first failure in input order), nothing cached', () => {
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    const cache = new CensusDiffCache();
    const f = diffFixture(overlapping(6), { failDiff: [5, 3] });
    const result = readOpenPrs(f.run, { candidateFiles: ['src/shared.ts'], runParallel: reversedParallel(f.run, { concurrency: [], calls: [] }), diffCache: cache });
    expect(result).toEqual({ status: 'unknown', reason: 'PR #3: 수정 줄 조회 실패: diff 3 unavailable' });
    expect(cache.size).toBe(0);
    expect(guardNewPr({ files: ['src/shared.ts'] }, result).status).toBe('unknown');
    const sequential = readOpenPrs(diffFixture(overlapping(6), { failDiff: [5, 3] }).run, { candidateFiles: ['src/shared.ts'] });
    expect(sequential).toEqual(result);
    expect(log).toHaveBeenCalledWith('pr-tool.census', 'diff-scan', expect.objectContaining({ status: 'diff-failed', fileOverlap: 6 }));
    // A pool that loses results is unknown too, never a silent no-overlap.
    expect(readOpenPrs(f.run, { candidateFiles: ['src/shared.ts'], runParallel: () => [] }))
      .toMatchObject({ status: 'unknown', reason: expect.stringContaining('판정 불가') });
  } finally { log.mockRestore(); }
});

test('PR-CENSUS-PARALLEL: fake gh · 30 overlapping PRs · 0.2s per diff — bounded parallel beats sequential', async () => {
  await withFakeBins({ gh: { sleepSeconds: 0.2, stdout: patchFor(1) } }, (fakeBins) => {
    const rows = overlapping(30);
    const inventoryOnly = fixture(rows).run; // REST pages and file projection stay injected; only `gh pr diff` spawns.
    // Sequential baseline: three real one-by-one calls, scaled to 30 (running all 30 would cost ~6s+).
    const sampleStarted = Date.now();
    for (let i = 0; i < 3; i++) expect(spawnSync(fakeBins.bin('gh'), ['pr', 'diff', 'sample', '--patch'], { encoding: 'utf8' }).status).toBe(0);
    const sequentialEstimateMs = Math.round(((Date.now() - sampleStarted) / 3) * rows.length);
    const started = Date.now();
    const inventory = readOpenPrs(inventoryOnly, {
      candidateFiles: ['src/shared.ts'],
      runParallel: (calls, concurrency) => spawnParallelCommands(calls, { concurrency, env: fakeBins.env }),
      diffCache: new CensusDiffCache(),
    });
    const parallelMs = Date.now() - started;
    expect(inventory).toMatchObject({ status: 'checked' });
    if (inventory.status === 'checked') expect(inventory.prs.every(row => row.hunks?.length === 1)).toBe(true);
    expect(fakeBins.calls().filter(call => call.argv[1] === 'diff' && call.argv[2] !== 'sample').length).toBe(30);
    console.info(`[PR-CENSUS-PARALLEL] 30 diffs · cap 6 · 0.2s each: sequential estimate ${sequentialEstimateMs}ms vs parallel ${parallelMs}ms`);
    expect(parallelMs).toBeLessThan(sequentialEstimateMs / 3);
  });
}, 30_000);

afterEach(() => { resetCensusDiffCache(); });

test('PR-CENSUS-PARALLEL: the shared production cache serves a later call and resetCensusDiffCache empties it', () => {
  const f = diffFixture(overlapping(3));
  readOpenPrs(f.run, { candidateFiles: ['src/shared.ts'], diffCache: sharedCensusDiffCache });
  expect([f.diffs.length, sharedCensusDiffCache.size]).toEqual([3, 3]);
  readOpenPrs(f.run, { candidateFiles: ['src/shared.ts'], diffCache: sharedCensusDiffCache });
  expect(f.diffs.length).toBe(3);
  resetCensusDiffCache();
  expect([sharedCensusDiffCache.size, sharedCensusDiffCache.bytes]).toEqual([0, 0]);
  readOpenPrs(f.run, { candidateFiles: ['src/shared.ts'], diffCache: sharedCensusDiffCache });
  expect(f.diffs.length).toBe(6);
});

/** Live fake-gh processes: the shell keeps its script path in argv (non-zero exitCode ⇒ no exec), and its
 *  `sleep` child carries the unique duration. */
function liveFakeGh(dir: string, sleepArg: string): string[] {
  const ps = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  return (ps.stdout ?? '').split('\n').filter(line => line.includes(dir) || line.includes(`sleep ${sleepArg}`));
}
async function waitNoLive(dir: string, sleepArg: string): Promise<string[]> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const live = liveFakeGh(dir, sleepArg);
    if (live.length === 0 || Date.now() >= deadline) return live;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

test('PR-CENSUS-PARALLEL: per-call timeout kills the gh group → inventory unknown, no gh left', async () => {
  await withFakeBins({ gh: { sleepSeconds: 41.731, exitCode: 1 } }, async (fakeBins) => {
    const started = Date.now();
    const inventory = readOpenPrs(fixture(overlapping(4)).run, {
      candidateFiles: ['src/shared.ts'], diffCache: new CensusDiffCache(),
      runParallel: (calls, concurrency) => spawnParallelCommands(calls, { concurrency, env: fakeBins.env, timeoutMs: 800 }),
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(inventory).toEqual({ status: 'unknown', reason: 'PR #1: 수정 줄 조회 실패: timed out after 800ms' });
    // A loaded host may kill a shim before it records its argv; the kill itself is what matters.
    expect(fakeBins.calls().length).toBeGreaterThan(0);
    expect(await waitNoLive(fakeBins.dir, '41.731')).toEqual([]);
  });
}, 20_000);

test('PR-CENSUS-PARALLEL: pool ceiling (SIGTERM to the pool) kills every in-flight gh → inventory unknown, no gh left', async () => {
  await withFakeBins({ gh: { sleepSeconds: 43.917, exitCode: 1 } }, async (fakeBins) => {
    const started = Date.now();
    const inventory = readOpenPrs(fixture(overlapping(3)).run, {
      candidateFiles: ['src/shared.ts'], diffCache: new CensusDiffCache(),
      runParallel: (calls, concurrency) => spawnParallelCommands(calls, { concurrency, env: fakeBins.env, timeoutMs: 60_000, poolTimeoutMs: 1_500 }),
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(inventory).toMatchObject({ status: 'unknown', reason: expect.stringContaining('parallel runner timed out or was killed') });
    expect(fakeBins.calls().length).toBeGreaterThan(0);
    expect(await waitNoLive(fakeBins.dir, '43.917')).toEqual([]);
  });
}, 20_000);

// ── PR-CENSUS-PARALLEL 2단계: file list first · patch only the overlap · parallel REST fallback · observation ──

/** 300-scale gh: REST pages of 100, one-shot projection (or its failure), REST files, diffs — every call counted by kind. */
function bigFixture(rows: ReturnType<typeof pr>[], options: { projection?: 'ok' | 'fail' | 'garbage' | 'object' | 'unusable' | 'duplicate' } = {}) {
  const counts = { pulls: 0, list: 0, files: 0, diff: 0 };
  const run: PrToolCommand = (_command, args) => {
    if (args[0] === 'pr' && args[1] === 'list') {
      counts.list += 1;
      if (options.projection === 'fail') return { ok: false, out: '', err: 'GraphQL: API rate limit exceeded for installation' };
      if (options.projection === 'garbage') return { ok: true, out: '{ definitely invalid JSON' };
      if (options.projection === 'object') return { ok: true, out: '{"not":"an array"}' };
      if (options.projection === 'unusable') return { ok: true, out: JSON.stringify(rows.map(row => ({ number: row.number, changedFiles: row.files.length + 1, files: row.files.map(path => ({ path })) }))) };
      if (options.projection === 'duplicate') {
        const projected = rows.map(row => ({ number: row.number, changedFiles: row.files.length, files: row.files.map(path => ({ path })) }));
        return { ok: true, out: JSON.stringify([...projected, projected[0]]) };
      }
      return { ok: true, out: JSON.stringify(rows.map(row => ({ number: row.number, changedFiles: row.files.length, files: row.files.map(path => ({ path })) }))) };
    }
    if (args[0] === 'pr' && args[1] === 'diff') { counts.diff += 1; return { ok: true, out: patchFor(Number(args[2])) }; }
    const endpoint = args[args.indexOf('--slurp') + 1] ?? '';
    if (endpoint.includes('/files?')) {
      counts.files += 1;
      const number = Number(endpoint.match(/pulls\/(\d+)\/files/)?.[1]);
      return { ok: true, out: JSON.stringify([(rows.find(row => row.number === number)?.files ?? []).map(filename => ({ filename }))]) };
    }
    if (endpoint.includes('/pulls?')) {
      counts.pulls += 1;
      const chunks: unknown[][] = [];
      for (let i = 0; i < rows.length; i += 100) chunks.push(rows.slice(i, i + 100));
      return { ok: true, out: JSON.stringify(chunks) };
    }
    throw new Error(endpoint);
  };
  return { run, counts };
}

const openThreeHundred = () => Array.from({ length: 300 }, (_, i) => {
  const number = 1000 + i;
  const overlaps = [7, 50, 123, 200, 299].includes(i);
  return pr(number, overlaps ? ['src/shared.ts', `src/own-${i}.ts`] : [`src/own-${i}.ts`], { head: { ref: `branch-${number}`, sha: `${number}`.padStart(40, 'c') } });
});

test('PR-CENSUS-PARALLEL 2: 300 open PRs · 5 real file overlaps → exactly 5 patches, one list call, 0 REST files, same verdict as sequential', () => {
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    const rows = openThreeHundred();
    const sequential = bigFixture(rows);
    const parallel = bigFixture(rows);
    const seen = { concurrency: [] as number[], calls: [] as PrToolCall[][] };
    const before = readOpenPrs(sequential.run, { candidateFiles: ['src/shared.ts'] });
    const after = readOpenPrs(parallel.run, { candidateFiles: ['src/shared.ts'], runParallel: reversedParallel(parallel.run, seen), diffCache: new CensusDiffCache() });
    expect(after).toEqual(before);
    expect(after.status).toBe('checked');
    if (after.status === 'checked') expect(after.prs.filter(row => row.hunks).map(row => row.number)).toEqual([1007, 1050, 1123, 1200, 1299]);
    expect(parallel.counts).toEqual({ pulls: 1, list: 1, files: 0, diff: 5 });
    expect(sequential.counts).toEqual({ pulls: 1, list: 1, files: 0, diff: 5 });
    expect(log).toHaveBeenCalledWith('pr-tool.census', 'diff-scan', expect.objectContaining({
      openPrs: 300, projected: 300, restFallback: 0, projectionFailed: false, fileOverlap: 5, patchFetched: 5, cacheHits: 0, concurrency: 6, status: 'checked' }));
  } finally { log.mockRestore(); }
});

test('PR-CENSUS-PARALLEL 2: one-shot list fails → 300 REST file reads go through the pool, the failure reason is recorded, verdict unchanged', () => {
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    const rows = openThreeHundred();
    const reference = readOpenPrs(bigFixture(rows).run, { candidateFiles: ['src/shared.ts'] });
    const sequential = bigFixture(rows, { projection: 'fail' });
    const parallel = bigFixture(rows, { projection: 'fail' });
    const seen = { concurrency: [] as number[], calls: [] as PrToolCall[][] };
    const before = readOpenPrs(sequential.run, { candidateFiles: ['src/shared.ts'] });
    const after = readOpenPrs(parallel.run, { candidateFiles: ['src/shared.ts'], runParallel: reversedParallel(parallel.run, seen), diffCache: new CensusDiffCache() });
    expect(after).toEqual(before);
    expect(after).toEqual(reference);
    expect(parallel.counts).toEqual({ pulls: 1, list: 1, files: 300, diff: 5 });
    expect(seen.concurrency).toEqual([6, 6]);
    expect(seen.calls.map(batch => batch.length)).toEqual([300, 5]);
    expect(seen.calls[0]![0]!.args).toEqual(['api', '--paginate', '--slurp', 'repos/{owner}/{repo}/pulls/1000/files?per_page=100']);
    expect(log).toHaveBeenCalledWith('pr-tool.census', 'diff-scan', expect.objectContaining({
      openPrs: 300, projected: 0, restFallback: 300, projectionFailed: true,
      projectionReason: expect.stringContaining('gh pr list 실패: GraphQL: API rate limit'), fileOverlap: 5, patchFetched: 5, status: 'checked' }));
    // A malformed one-shot answer is a recorded failure too, never a silent fallback.
    log.mockClear();
    readOpenPrs(bigFixture(rows, { projection: 'garbage' }).run, { candidateFiles: ['src/shared.ts'], runParallel: reversedParallel(parallel.run, seen) });
    expect(log).toHaveBeenCalledWith('pr-tool.census', 'diff-scan', expect.objectContaining({ projectionFailed: true, projectionReason: expect.stringContaining('JSON 오류'), restFallback: 300 }));
    for (const [projection, reason] of [['object', 'gh pr list 응답이 배열 아님'], ['unusable', 'gh pr list 300행 모두 사용 불가']] as const) {
      log.mockClear();
      const shaped = bigFixture(rows, { projection });
      expect(readOpenPrs(shaped.run, { candidateFiles: ['src/shared.ts'], runParallel: reversedParallel(shaped.run, seen) })).toEqual(reference);
      expect(log).toHaveBeenCalledWith('pr-tool.census', 'diff-scan', expect.objectContaining({ projectionFailed: true, projectionReason: reason, restFallback: 300 }));
    }
    // A duplicated number counts once as skipped (the duplicate), never its first valid row.
    log.mockClear();
    readOpenPrs(bigFixture(rows, { projection: 'duplicate' }).run, { candidateFiles: ['src/shared.ts'] });
    expect(log).toHaveBeenCalledWith('pr-tool.census', 'diff-scan', expect.objectContaining({ projectionFailed: false, projected: 300, projectionSkipped: 1, restFallback: 0 }));
  } finally { log.mockRestore(); }
});

test('PR-CENSUS-PARALLEL 2: one failed REST file read in the pool keeps the inventory unknown (first failure in input order)', () => {
  const rows = openThreeHundred().slice(0, 12);
  const base = bigFixture(rows, { projection: 'fail' });
  const run: PrToolCommand = (command, args, opts) =>
    /pulls\/(1003|1009)\/files/.test(args.join(' ')) ? { ok: false, out: '', err: 'HTTP 502' } : base.run(command, args, opts);
  const parallel = readOpenPrs(run, { candidateFiles: ['src/shared.ts'], runParallel: reversedParallel(run, { concurrency: [], calls: [] }) });
  expect(parallel).toEqual({ status: 'unknown', reason: 'gh api repos/{owner}/{repo}/pulls/1003/files?per_page=100: HTTP 502' });
  expect(readOpenPrs(run, { candidateFiles: ['src/shared.ts'] })).toEqual(parallel);
});
