import { setDefaultTimeout, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { appendRunLedgerEntry, loadRunLedger, queryUnfinishedRunLedgers, runLedgerPath, type RunLedgerEntry } from './run-ledger.js';
import { applyLedgerCompaction, OWNERLESS_LOCK_STALE_MS, planLedgerCompaction, readRunLedgerSummaries, restoreArchivedRunLedger, withRunLedgerLock } from './run-ledger-compact.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const id = (tail: string) => `run-00000000-0000-4000-8000-00000000${tail}`;
const old = '2026-09-24T00:00:00.000Z';
const now = new Date('2026-09-26T00:00:00.000Z');
const entry = (runId: string, event: string, timestamp = old, data: Record<string, unknown> = {}): RunLedgerEntry => ({ timestamp, runId, event, data });
const lines = (entries: RunLedgerEntry[]) => entries.map((row) => JSON.stringify(row) + '\n').join('');
const fixture = (dir: string, runId: string) => {
  const original = lines([
    entry(runId, 'start', old, { goalFile: '/fixture/goal.txt', branch: 'feature', machine: 'host-A', substrate: 'pod' }),
    entry(runId, 'pr-opened', old, { prUrl: 'https://example.test/pull/1' }),
    entry(runId, 'run-status', old, { runStatus: 'completed' }),
    entry(runId, 'run-rollup'), entry(runId, 'progress-delivery'),
  ]);
  writeFileSync(runLedgerPath(runId, dir), original);
  return original;
};

function inDirectory(work: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-compact-'));
  try { work(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('run ledger archive', () => {
  it('plans without mutation, moves only old terminal ledgers, round-trips bytes and preserves unfinished query', () => inDirectory((dir) => {
    const archived = id('a001'), unfinished = id('a002'), recent = id('a003'), broken = id('a004');
    const original = fixture(dir, archived);
    writeFileSync(runLedgerPath(unfinished, dir), lines([entry(unfinished, 'start')]));
    writeFileSync(runLedgerPath(recent, dir), lines([entry(recent, 'run-status', '2026-09-25T23:00:00.000Z', { runStatus: 'failed' })]));
    writeFileSync(runLedgerPath(broken, dir), '{bad}\n');
    const before = queryUnfinishedRunLedgers({ dir, goalsDir: dir });
    const plan = planLedgerCompaction({ dir, now });
    expect(plan.move).toHaveLength(1);
    expect(plan.move[0]).toMatchObject({ runId: archived, to: join(dir, 'archive', '2026-09', `${archived}.jsonl.gz`), summary: { runId: archived, status: 'completed', endedAt: old, goalFile: '/fixture/goal.txt', branch: 'feature', prUrl: 'https://example.test/pull/1', machine: 'host-A', substrate: 'pod' } });
    expect(plan.keep).toEqual(expect.arrayContaining([{ runId: unfinished, reason: 'unfinished' }, { runId: recent, reason: 'too-recent' }, { runId: broken, reason: 'unreadable' }]));
    expect(readFileSync(runLedgerPath(archived, dir), 'utf8')).toBe(original);
    expect(applyLedgerCompaction(plan)).toMatchObject({ moved: 1, kept: 3, failures: [] });
    expect(gunzipSync(readFileSync(plan.move[0]!.to)).toString()).toBe(original);
    expect(existsSync(runLedgerPath(archived, dir))).toBe(false);
    expect(readRunLedgerSummaries(dir)).toEqual([plan.move[0]!.summary]);
    expect(readFileSync(join(dir, 'archive', `.archived-${archived}`), 'utf8')).toBe(plan.move[0]!.to);
    expect(queryUnfinishedRunLedgers({ dir, goalsDir: dir }).entries.map(({ lastActivityAgeMs, ...row }) => row))
      .toEqual(before.entries.filter((row) => row.runId !== archived).map(({ lastActivityAgeMs, ...row }) => row));
    for (const runId of [unfinished, recent, broken]) expect(existsSync(runLedgerPath(runId, dir))).toBe(true);
  }));

  it('recovers an interrupted compaction without duplicating index entries', () => inDirectory((dir) => {
    const runId = id('b004');
    const original = fixture(dir, runId);
    const plan = planLedgerCompaction({ dir, now });
    expect(applyLedgerCompaction(plan, { __testCrashAfterIndex: true }).failures).toHaveLength(1);
    expect(existsSync(runLedgerPath(runId, dir))).toBe(true);
    expect(readRunLedgerSummaries(dir)).toHaveLength(1);
    expect(existsSync(join(dir, 'archive', `.restoring-${runId}`))).toBe(true);
    expect(applyLedgerCompaction(plan)).toMatchObject({ moved: 1, failures: [] });
    expect(gunzipSync(readFileSync(plan.move[0]!.to)).toString()).toBe(original);
    expect(readRunLedgerSummaries(dir)).toHaveLength(1);
  }));

  it('a writer recovers compaction when the source is gone but its marker remains', () => inDirectory((dir) => {
    const runId = id('b009');
    const original = fixture(dir, runId);
    const plan = planLedgerCompaction({ dir, now });
    expect(applyLedgerCompaction(plan).moved).toBe(1);
    const archived = join(dir, 'archive', `.archived-${runId}`);
    writeFileSync(join(dir, 'archive', `.restoring-${runId}`), plan.move[0]!.to);
    const next = entry(runId, 'start', '2026-09-26T01:00:00.000Z');
    appendRunLedgerEntry(next, dir);
    expect(readFileSync(runLedgerPath(runId, dir), 'utf8')).toBe(original + lines([next]));
    expect(readRunLedgerSummaries(dir)).toEqual([]);
    expect(existsSync(archived)).toBe(false);
    expect(existsSync(plan.move[0]!.to)).toBe(false);
  }));

  it('a writer recovers interrupted compaction before gzip creation', () => inDirectory((dir) => {
    const runId = id('b006');
    const original = fixture(dir, runId);
    const plan = planLedgerCompaction({ dir, now });
    const failed = applyLedgerCompaction(plan, { __testWriteGzip: () => { throw new Error('gzip unavailable'); } });
    expect(failed.failures).toHaveLength(1);
    // Nothing moved: no size is counted and the ledger is reported as kept.
    expect(failed).toMatchObject({ moved: 0, bytesBefore: 0, bytesAfter: 0, kept: plan.keep.length + 1 });
    appendRunLedgerEntry(entry(runId, 'start', '2026-09-26T01:00:00.000Z'), dir);
    expect(readFileSync(runLedgerPath(runId, dir), 'utf8')).toStartWith(original);
    expect(readRunLedgerSummaries(dir)).toEqual([]);
  }));

  it('a writer recovers an interrupted compaction before appending', () => inDirectory((dir) => {
    const runId = id('b005');
    const original = fixture(dir, runId);
    const plan = planLedgerCompaction({ dir, now });
    expect(applyLedgerCompaction(plan, { __testCrashAfterIndex: true }).failures).toHaveLength(1);
    const next = entry(runId, 'start', '2026-09-26T01:00:00.000Z');
    appendRunLedgerEntry(next, dir);
    expect(readFileSync(runLedgerPath(runId, dir), 'utf8')).toBe(original + lines([next]));
    expect(readRunLedgerSummaries(dir)).toEqual([]);
    expect(existsSync(plan.move[0]!.to)).toBe(false);
  }));

  it('rejects a stale plan rather than moving a ledger appended after planning', () => inDirectory((dir) => {
    const runId = id('b003');
    fixture(dir, runId);
    const plan = planLedgerCompaction({ dir, now });
    appendRunLedgerEntry(entry(runId, 'start', '2026-09-26T03:00:00.000Z'), dir);
    const result = applyLedgerCompaction(plan);
    expect(result.moved).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(existsSync(runLedgerPath(runId, dir))).toBe(true);
    expect(existsSync(plan.move[0]!.to)).toBe(false);
  }));

  it('keeps the source when a written gzip cannot round-trip and continues with other files', () => inDirectory((dir) => {
    const first = id('b007'), second = id('b008');
    const original = fixture(dir, first);
    fixture(dir, second);
    const result = applyLedgerCompaction(planLedgerCompaction({ dir, now }), {
      __testWriteGzip: (path, bytes) => writeFileSync(path, path.includes(first) ? gzipSync(Buffer.from('wrong bytes')) : bytes),
    });
    expect(result.moved).toBe(1);
    expect(result.failures).toEqual([{ runId: first, error: 'gzip round-trip differs' }]);
    expect(readFileSync(runLedgerPath(first, dir), 'utf8')).toBe(original);
    expect(existsSync(runLedgerPath(second, dir))).toBe(false);
  }));

  it('leaves neither an archive hint nor a restore marker when gzip writing fails', () => inDirectory((dir) => {
    const runId = id('b010');
    const original = fixture(dir, runId);
    const result = applyLedgerCompaction(planLedgerCompaction({ dir, now }), {
      __testWriteGzip: () => { throw new Error('gzip unavailable'); },
    });
    expect(result.failures).toHaveLength(1);
    expect(readFileSync(runLedgerPath(runId, dir), 'utf8')).toBe(original);
    expect(existsSync(join(dir, 'archive', `.archived-${runId}`))).toBe(false);
    expect(existsSync(join(dir, 'archive', `.restoring-${runId}`))).toBe(false);
  }));

  it('keeps the source when gzip write fails and continues with other files', () => inDirectory((dir) => {
    const first = id('b001'), second = id('b002');
    const original = fixture(dir, first);
    fixture(dir, second);
    const result = applyLedgerCompaction(planLedgerCompaction({ dir, now }), {
      __testWriteGzip: (path, bytes) => { if (path.includes(first)) throw new Error('injected gzip write failure'); writeFileSync(path, bytes); },
    });
    expect(result).toMatchObject({ moved: 1, failures: [{ runId: first, error: 'injected gzip write failure' }] });
    expect(readFileSync(runLedgerPath(first, dir), 'utf8')).toBe(original);
    expect(existsSync(runLedgerPath(second, dir))).toBe(false);
  }));

  for (const crash of ['live-written', 'index-replaced'] as const) {
    it(`finishes restore after ${crash} interruption without duplicating either append`, () => inDirectory((dir) => {
      const runId = id(crash === 'live-written' ? 'c001' : 'c002');
      const original = fixture(dir, runId);
      const plan = planLedgerCompaction({ dir, now });
      applyLedgerCompaction(plan);
      const first = entry(runId, 'start', '2026-09-26T01:00:00.000Z');
      const second = entry(runId, 'run-rollup', '2026-09-26T02:00:00.000Z');
      const marker = join(dir, 'archive', `.restoring-${runId}`);
      expect(() => withRunLedgerLock(dir, runId, () => restoreArchivedRunLedger(dir, runId, lines([first]), { __testCrashAfter: crash }))).toThrow('test crash');
      expect(existsSync(marker)).toBe(true);
      expect(existsSync(plan.move[0]!.to)).toBe(true);
      expect(readRunLedgerSummaries(dir).filter((row) => row.runId === runId)).toHaveLength(crash === 'live-written' ? 1 : 0);
      expect(readFileSync(runLedgerPath(runId, dir), 'utf8')).toBe(original + lines([first]));
      appendRunLedgerEntry(second, dir);
      expect(readFileSync(runLedgerPath(runId, dir), 'utf8')).toBe(original + lines([first, second]));
      expect(readRunLedgerSummaries(dir).filter((row) => row.runId === runId)).toHaveLength(0);
      expect(existsSync(plan.move[0]!.to)).toBe(false);
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(join(dir, 'archive', `.archived-${runId}`))).toBe(false);
      expect(planLedgerCompaction({ dir, now: new Date('2026-09-29T00:00:00.000Z') }).keep).toContainEqual({ runId, reason: 'unfinished' });
    }));
  }

  it('restores a normally archived run when its next record arrives', () => inDirectory((dir) => {
    const runId = id('d003');
    const original = fixture(dir, runId);
    const plan = planLedgerCompaction({ dir, now });
    applyLedgerCompaction(plan);
    const next = entry(runId, 'run-rollup', '2026-09-26T03:00:00.000Z');
    appendRunLedgerEntry(next, dir);
    expect(readFileSync(runLedgerPath(runId, dir), 'utf8')).toBe(original + lines([next]));
    expect(existsSync(plan.move[0]!.to)).toBe(false);
    expect(existsSync(join(dir, 'archive', `.archived-${runId}`))).toBe(false);
    expect(readRunLedgerSummaries(dir)).toEqual([]);
  }));

  it('finishes an interrupted restore when apply is the next caller', () => inDirectory((dir) => {
    const runId = id('d004');
    const another = id('d005');
    fixture(dir, runId);
    fixture(dir, another);
    const plan = planLedgerCompaction({ dir, now });
    applyLedgerCompaction({ move: plan.move.filter((item) => item.runId === runId), keep: [] });
    expect(() => withRunLedgerLock(dir, runId, () => restoreArchivedRunLedger(dir, runId, lines([entry(runId, 'start', '2026-09-26T03:00:00.000Z')]), { __testCrashAfter: 'index-replaced' }))).toThrow();
    const result = applyLedgerCompaction({ move: plan.move.filter((item) => item.runId === another), keep: [] });
    expect(result).toMatchObject({ moved: 1, failures: [] });
    expect(readRunLedgerSummaries(dir).map((row) => row.runId)).toEqual([another]);
    expect(existsSync(join(dir, 'archive', `.restoring-${runId}`))).toBe(false);
  }));

  it('planning an interrupted restore is read-only, including the index, gzip and marker', () => inDirectory((dir) => {
    const runId = id('d008');
    fixture(dir, runId);
    const firstPlan = planLedgerCompaction({ dir, now });
    applyLedgerCompaction(firstPlan);
    const resumed = entry(runId, 'start', '2026-09-26T03:00:00.000Z');
    expect(() => withRunLedgerLock(dir, runId, () => restoreArchivedRunLedger(dir, runId, lines([resumed]), { __testCrashAfter: 'live-written' }))).toThrow();
    const marker = join(dir, 'archive', `.restoring-${runId}`);
    const live = runLedgerPath(runId, dir);
    const index = join(dir, 'archive', 'index.jsonl');
    const before = [readFileSync(live), readFileSync(index), readFileSync(firstPlan.move[0]!.to), readFileSync(marker)];
    expect(planLedgerCompaction({ dir, now })).toMatchObject({ move: [], keep: [{ runId, reason: 'unfinished' }] });
    expect([readFileSync(live), readFileSync(index), readFileSync(firstPlan.move[0]!.to), readFileSync(marker)]).toEqual(before);
    expect(applyLedgerCompaction(planLedgerCompaction({ dir, now })).failures).toEqual([]);
    expect(readRunLedgerSummaries(dir)).toEqual([]);
    expect(existsSync(marker)).toBe(false);
  }));

  it('CLI --dry-run leaves an interrupted restore untouched', () => inDirectory((stateDir) => {
    const dir = join(stateDir, 'run-ledger');
    mkdirSync(dir);
    const runId = id('d011');
    fixture(dir, runId);
    const plan = planLedgerCompaction({ dir, now });
    applyLedgerCompaction(plan);
    expect(() => withRunLedgerLock(dir, runId, () => restoreArchivedRunLedger(dir, runId, lines([entry(runId, 'start', '2026-09-26T03:00:00.000Z')]), { __testCrashAfter: 'live-written' }))).toThrow();
    const paths = [runLedgerPath(runId, dir), join(dir, 'archive', 'index.jsonl'), plan.move[0]!.to, join(dir, 'archive', `.restoring-${runId}`)];
    const before = paths.map((path) => readFileSync(path));
    const cli = Bun.spawnSync({ cmd: [process.execPath, join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs'), `--test=${stateDir}`, 'self', 'ledger', 'compact', '--dry-run', '--json'], env: { ...process.env, ELANOUS_STATE_DIR: stateDir }, stdout: 'pipe', stderr: 'pipe' });
    expect(cli.exitCode, cli.stderr.toString()).toBe(0);
    expect(JSON.parse(cli.stdout.toString()).dryRun).toBe(true);
    expect(paths.map((path) => readFileSync(path))).toEqual(before);
  }));

  it('rejects a stale plan even when the added status or metadata has the same timestamp', () => inDirectory((dir) => {
    for (const [suffix, event, data] of [
      ['d009', 'run-status', { runStatus: 'failed' }],
      ['d010', 'run-rollup', { machine: 'new-machine' }],
      ['d012', 'run-rollup', { unchangedSummaryField: 'new-record' }],
    ] as const) {
      const runId = id(suffix);
      const original = fixture(dir, runId);
      const plan = planLedgerCompaction({ dir, now });
      appendRunLedgerEntry(entry(runId, event, old, data), dir);
      expect(applyLedgerCompaction({ move: plan.move.filter((item) => item.runId === runId), keep: [] })).toMatchObject({ moved: 0, failures: [{ runId, error: 'ledger changed since plan' }] });
      expect(readFileSync(runLedgerPath(runId, dir), 'utf8')).toBe(original + lines([entry(runId, event, old, data)]));
      expect(readRunLedgerSummaries(dir).filter((row) => row.runId === runId)).toEqual([]);
    }
  }));

  it('observes an interrupted restore in planning and finishes it during apply', () => inDirectory((dir) => {
    const runId = id('d002');
    fixture(dir, runId);
    const plan = planLedgerCompaction({ dir, now });
    applyLedgerCompaction(plan);
    const resumed = entry(runId, 'start', '2026-09-26T03:00:00.000Z');
    expect(() => withRunLedgerLock(dir, runId, () => restoreArchivedRunLedger(dir, runId, lines([resumed]), { __testCrashAfter: 'live-written' }))).toThrow();
    expect(planLedgerCompaction({ dir, now }).keep).toContainEqual({ runId, reason: 'unfinished' });
    expect(readRunLedgerSummaries(dir)).toHaveLength(1);
    expect(existsSync(plan.move[0]!.to)).toBe(true);
    expect(existsSync(join(dir, 'archive', `.restoring-${runId}`))).toBe(true);
    expect(applyLedgerCompaction(planLedgerCompaction({ dir, now })).failures).toEqual([]);
    expect(loadRunLedger(runId, dir)?.filter((row) => row.event === 'start')).toHaveLength(2);
    expect(readRunLedgerSummaries(dir)).toEqual([]);
    expect(existsSync(plan.move[0]!.to)).toBe(false);
    expect(existsSync(join(dir, 'archive', `.restoring-${runId}`))).toBe(false);
  }));

  it('isolates a broken restore gzip, reports its run and still compacts an unrelated ledger', () => inDirectory((dir) => {
    const damaged = id('d013'), healthy = id('d014');
    fixture(dir, damaged);
    const archivedPlan = planLedgerCompaction({ dir, now });
    expect(applyLedgerCompaction(archivedPlan).moved).toBe(1);
    const gzip = archivedPlan.move[0]!.to;
    writeFileSync(join(dir, 'archive', `.restoring-${damaged}`), gzip);
    writeFileSync(gzip, 'not gzip');
    const original = fixture(dir, healthy);
    const plan = planLedgerCompaction({ dir, now });
    expect(plan.move.map((item) => item.runId)).toEqual([healthy]);
    const result = applyLedgerCompaction(plan);
    expect(result.moved).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.runId).toBe(damaged);
    expect(gunzipSync(readFileSync(plan.move[0]!.to)).toString()).toBe(original);
    expect(existsSync(runLedgerPath(healthy, dir))).toBe(false);
    expect(readFileSync(gzip, 'utf8')).toBe('not gzip');
    expect(existsSync(join(dir, 'archive', `.restoring-${damaged}`))).toBe(true);
    expect(readRunLedgerSummaries(dir).map((row) => row.runId).sort()).toEqual([damaged, healthy].sort());
  }));

  it('reports a failed restore on a planned run once and leaves that source intact', () => inDirectory((dir) => {
    const failed = id('d015'), healthy = id('d016');
    const original = fixture(dir, failed);
    fixture(dir, healthy);
    const plan = planLedgerCompaction({ dir, now });
    const to = plan.move.find((item) => item.runId === failed)!.to;
    mkdirSync(join(dir, 'archive', '2026-09'), { recursive: true });
    writeFileSync(join(dir, 'archive', `.restoring-${failed}`), to);
    writeFileSync(to, 'corrupt gzip');
    const result = applyLedgerCompaction(plan);
    expect(result.moved).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.runId).toBe(failed);
    expect(readFileSync(runLedgerPath(failed, dir), 'utf8')).toBe(original);
    expect(existsSync(runLedgerPath(healthy, dir))).toBe(false);
  }));

  it('indexes human-stop and terminal after an earlier run-status as the actual terminating event, including CLI JSON', () => inDirectory((stateDir) => {
    const dir = join(stateDir, 'run-ledger');
    mkdirSync(dir);
    const human = id('d017'), terminal = id('d018');
    for (const [runId, event] of [[human, 'human-stop'], [terminal, 'terminal']] as const) {
      writeFileSync(runLedgerPath(runId, dir), lines([
        entry(runId, 'run-status', old, { runStatus: 'completed' }),
        entry(runId, event, old, event === 'terminal' ? { terminal: 'escalated' } : { stoppedBy: 'person' }),
      ]));
    }
    const plan = planLedgerCompaction({ dir, now });
    expect(plan.move.map((item) => [item.runId, item.summary.status]).sort()).toEqual([[human, 'human-stop'], [terminal, 'terminal']].sort());
    const cli = Bun.spawnSync({ cmd: [process.execPath, join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs'), `--test=${stateDir}`, 'self', 'ledger', 'compact', '--dry-run', '--json'], env: { ...process.env, ELANOUS_STATE_DIR: stateDir }, stdout: 'pipe', stderr: 'pipe' });
    expect(cli.exitCode, cli.stderr.toString()).toBe(0);
    expect(JSON.parse(cli.stdout.toString()).plan.move.map((item: { runId: string; summary: { status: string } }) => [item.runId, item.summary.status]).sort()).toEqual([[human, 'human-stop'], [terminal, 'terminal']].sort());
    expect(applyLedgerCompaction(plan)).toMatchObject({ moved: 2, failures: [] });
    expect(readRunLedgerSummaries(dir).map((row) => [row.runId, row.status]).sort()).toEqual([[human, 'human-stop'], [terminal, 'terminal']].sort());
  }));

  it('recovers conflicts in apply without deleting either copy', () => inDirectory((dir) => {
    const runId = id('d006'), another = id('d007');
    fixture(dir, runId);
    fixture(dir, another);
    const plan = planLedgerCompaction({ dir, now });
    applyLedgerCompaction({ move: plan.move.filter((item) => item.runId === runId), keep: [] });
    expect(() => withRunLedgerLock(dir, runId, () => restoreArchivedRunLedger(dir, runId, lines([entry(runId, 'start')]), { __testCrashAfter: 'live-written' }))).toThrow();
    writeFileSync(runLedgerPath(runId, dir), 'conflicting contents\n');
    const result = applyLedgerCompaction({ move: plan.move.filter((item) => item.runId === another), keep: [] });
    // The other run still compacts, and the unplanned run's restore conflict is reported (not hidden).
    expect(result.moved).toBe(1);
    expect(result.failures).toEqual([{ runId, error: expect.stringMatching(/^restore-conflict:/) }]);
    expect(existsSync(plan.move.find((item) => item.runId === runId)!.to)).toBe(true);
    expect(readRunLedgerSummaries(dir).map((row) => row.runId).sort()).toEqual([runId, another].sort());
    expect(readFileSync(runLedgerPath(runId, dir), 'utf8')).toBe('conflicting contents\n');
    expect(existsSync(join(dir, 'archive', `.restoring-${runId}`))).toBe(true);
  }));

  it('reports pending restore conflicts in planning without deleting either copy', () => inDirectory((dir) => {
    const runId = id('d001');
    fixture(dir, runId);
    const plan = planLedgerCompaction({ dir, now });
    applyLedgerCompaction(plan);
    expect(() => withRunLedgerLock(dir, runId, () => restoreArchivedRunLedger(dir, runId, lines([entry(runId, 'start')]), { __testCrashAfter: 'live-written' }))).toThrow();
    writeFileSync(runLedgerPath(runId, dir), 'conflicting contents\n');
    expect(planLedgerCompaction({ dir, now }).keep).toContainEqual({ runId, reason: 'restore-conflict' });
    expect(existsSync(plan.move[0]!.to)).toBe(true);
    expect(readRunLedgerSummaries(dir)).toHaveLength(1);
    expect(existsSync(join(dir, 'archive', `.restoring-${runId}`))).toBe(true);
  }));

  it('appends a new run without reading a damaged archive index', () => inDirectory((dir) => {
    const runId = id('e002');
    mkdirSync(join(dir, 'archive'));
    writeFileSync(join(dir, 'archive', 'index.jsonl'), '{invalid}\n');
    const next = entry(runId, 'start');
    appendRunLedgerEntry(next, dir);
    expect(readFileSync(runLedgerPath(runId, dir), 'utf8')).toBe(lines([next]));
  }));

  it('recovers dead pid locks promptly', () => inDirectory((dir) => {
    const runId = id('e001');
    const lock = join(dir, `.${runId}.lock`);
    mkdirSync(lock);
    writeFileSync(join(lock, 'pid'), '999999999');
    const start = performance.now();
    appendRunLedgerEntry(entry(runId, 'start'), dir);
    expect(performance.now() - start).toBeLessThan(1_000);
    expect(loadRunLedger(runId, dir)).toHaveLength(1);
  }));

  it('does not reap a new owner after a waiter probed the old dead pid', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-reap-handoff-'));
    try {
      const runId = id('e004');
      const lock = join(dir, `.${runId}.lock`);
      mkdirSync(lock);
      writeFileSync(join(lock, 'pid'), '999999999');
      const probed = join(dir, 'probed');
      const proceed = join(dir, 'proceed');
      const owned = join(dir, 'owned');
      const release = join(dir, 'release');
      const entered = join(dir, 'entered');
      const module = JSON.stringify(join(import.meta.dir, 'run-ledger-compact.ts'));
      const waiterScript = `import { existsSync, writeFileSync } from 'node:fs'; import { withRunLedgerLock } from ${module}; const [dir, runId, probed, proceed, entered] = process.argv.slice(1); const kill = process.kill.bind(process); process.kill = ((pid, signal) => { if (pid === 999999999) { writeFileSync(probed, 'yes'); while (!existsSync(proceed)) Bun.sleepSync(2); const error = new Error('dead'); Object.assign(error, { code: 'ESRCH' }); throw error; } return kill(pid, signal); }) as typeof process.kill; withRunLedgerLock(dir, runId, () => writeFileSync(entered, 'yes'));`;
      const ownerScript = `import { existsSync, writeFileSync } from 'node:fs'; import { withRunLedgerLock } from ${module}; const [dir, runId, owned, release] = process.argv.slice(1); withRunLedgerLock(dir, runId, () => { writeFileSync(owned, 'yes'); while (!existsSync(release)) Bun.sleepSync(2); });`;
      const waiter = Bun.spawn([process.execPath, '-e', waiterScript, dir, runId, probed, proceed, entered], { stderr: 'pipe' });
      const waitFor = (path: string) => { const deadline = Date.now() + 5_000; while (!existsSync(path) && Date.now() < deadline) Bun.sleepSync(5); expect(existsSync(path)).toBe(true); };
      waitFor(probed);
      const owner = Bun.spawn([process.execPath, '-e', ownerScript, dir, runId, owned, release], { stderr: 'pipe' });
      try {
        waitFor(owned);
        writeFileSync(proceed, 'go');
        Bun.sleepSync(100);
        expect(readFileSync(join(lock, 'pid'), 'utf8')).toBe(String(owner.pid));
        expect(existsSync(entered)).toBe(false);
      } finally {
        writeFileSync(release, 'go');
        if (!existsSync(proceed)) writeFileSync(proceed, 'go');
      }
      expect(await owner.exited, await new Response(owner.stderr).text()).toBe(0);
      expect(await waiter.exited, await new Response(waiter.stderr).text()).toBe(0);
      expect(existsSync(entered)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 12_000);

  it('serializes competing dead-lock reapers and never removes a new owner pid', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-reap-race-'));
    try {
      const runId = id('e003');
      const lock = join(dir, `.${runId}.lock`);
      const occupied = join(dir, 'occupied');
      const script = `import { existsSync, unlinkSync, writeFileSync } from 'node:fs'; import { withRunLedgerLock } from ${JSON.stringify(join(import.meta.dir, 'run-ledger-compact.ts'))}; import { appendRunLedgerEntry } from ${JSON.stringify(join(import.meta.dir, 'run-ledger.ts'))}; const [dir, runId, occupied, start, ready, ordinal] = process.argv.slice(1); writeFileSync(ready, 'ready'); while (!existsSync(start)) Bun.sleepSync(1); withRunLedgerLock(dir, runId, () => { writeFileSync(occupied, ordinal, { flag: 'wx' }); Bun.sleepSync(80); unlinkSync(occupied); }); appendRunLedgerEntry({ runId, event: 'reaped-' + ordinal, data: {} }, dir);`;
      for (let round = 0; round < 6; round++) {
        mkdirSync(lock);
        writeFileSync(join(lock, 'pid'), '999999999');
        const start = join(dir, `start-${round}`);
        const children = [0, 1].map((ordinal) => Bun.spawn([
          process.execPath, '-e', script, dir, runId, occupied, start, join(dir, `ready-${round}-${ordinal}`), String(round * 2 + ordinal),
        ], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' }));
        const deadline = Date.now() + 5_000;
        while (![0, 1].every((ordinal) => existsSync(join(dir, `ready-${round}-${ordinal}`))) && Date.now() < deadline) Bun.sleepSync(5);
        expect([0, 1].every((ordinal) => existsSync(join(dir, `ready-${round}-${ordinal}`)))).toBe(true);
        writeFileSync(start, 'go');
        for (const child of children) expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
        expect(existsSync(occupied)).toBe(false);
        expect(existsSync(lock)).toBe(false);
      }
      expect(loadRunLedger(runId, dir)?.filter((row) => row.event.startsWith('reaped-'))).toHaveLength(12);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);

  it('lets the same child writer waiting on a compactor lock restore and append after compaction', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-compact-child-'));
    try {
      const runId = id('f001');
      fixture(dir, runId);
      const plan = planLedgerCompaction({ dir, now });
      const ready = join(dir, 'child-ready');
      const script = `import { writeFileSync } from 'node:fs'; import { appendRunLedgerEntry } from ${JSON.stringify(join(import.meta.dir, 'run-ledger.ts'))}; writeFileSync(${JSON.stringify(ready)}, 'ready'); appendRunLedgerEntry(${JSON.stringify(entry(runId, 'child-record', '2026-09-26T04:00:00.000Z'))}, ${JSON.stringify(dir)});`;
      let child: ReturnType<typeof Bun.spawn> | undefined;
      const result = applyLedgerCompaction(plan, {
        __testWhileLocked: () => {
          child = Bun.spawn([process.execPath, '-e', script], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' });
          const deadline = Date.now() + 5_000;
          while (!existsSync(ready) && Date.now() < deadline) Bun.sleepSync(10);
          expect(existsSync(ready)).toBe(true);
          Bun.sleepSync(100);
          expect(child.exitCode).toBeNull();
          expect(existsSync(join(dir, `.${runId}.lock`, 'pid'))).toBe(true);
        },
      });
      expect(result.failures).toEqual([]);
      expect(result.moved).toBe(1);
      expect(child).toBeDefined();
      expect(await child!.exited).toBe(0);
      expect(loadRunLedger(runId, dir)?.filter((row) => row.event === 'child-record')).toHaveLength(1);
      expect(readRunLedgerSummaries(dir)).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 10_000);

  it('reclaims a lock that stayed ownerless (no pid) past the stale window', () => inDirectory((dir) => {
    const runId = id('f101');
    fixture(dir, runId);
    const lock = join(dir, `.${runId}.lock`);
    mkdirSync(lock);
    const old = new Date(Date.now() - OWNERLESS_LOCK_STALE_MS - 60_000);
    utimesSync(lock, old, old);
    const started = Date.now();
    appendRunLedgerEntry(entry(runId, 'start', '2026-09-26T04:00:00.000Z'), dir);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(existsSync(lock)).toBe(false);
  }));

  it('replaces an unpublished archive left after rename but before the marker (no index row)', () => inDirectory((dir) => {
    const runId = id('f102');
    const original = fixture(dir, runId);
    const plan = planLedgerCompaction({ dir, now });
    const item = plan.move.find((m) => m.runId === runId)!;
    mkdirSync(dirname(item.to), { recursive: true });
    writeFileSync(item.to, gzipSync(Buffer.from('stale bytes from a crashed compactor\n')));
    const result = applyLedgerCompaction(plan);
    expect(result).toMatchObject({ moved: 1, failures: [] });
    expect(gunzipSync(readFileSync(item.to)).toString()).toBe(original);
  }));

  it('replaces a corrupt unpublished archive (gunzip fails) from the live ledger', () => inDirectory((dir) => {
    const runId = id('f103');
    const original = fixture(dir, runId);
    const plan = planLedgerCompaction({ dir, now });
    const item = plan.move.find((m) => m.runId === runId)!;
    mkdirSync(dirname(item.to), { recursive: true });
    writeFileSync(item.to, Buffer.from('not a gzip at all'));
    expect(applyLedgerCompaction(plan)).toMatchObject({ moved: 1, failures: [] });
    expect(gunzipSync(readFileSync(item.to)).toString()).toBe(original);
  }));

  it('reclaims a dead-pid lock even when a crashed reaper left a stale .reaping mutex', () => inDirectory((dir) => {
    const runId = id('f104');
    fixture(dir, runId);
    const lock = join(dir, `.${runId}.lock`);
    mkdirSync(lock);
    writeFileSync(join(lock, 'pid'), '999999');
    const reap = `${lock}.reaping`;
    mkdirSync(reap);
    const old = new Date(Date.now() - OWNERLESS_LOCK_STALE_MS - 60_000);
    utimesSync(reap, old, old);
    const started = Date.now();
    appendRunLedgerEntry(entry(runId, 'start', '2026-09-26T04:00:00.000Z'), dir);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(existsSync(lock)).toBe(false);
    expect(existsSync(reap)).toBe(false);
  }));
});
