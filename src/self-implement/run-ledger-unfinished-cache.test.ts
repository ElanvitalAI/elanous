import { expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { queryUnfinishedRunLedgers, type RunLedgerReader } from './run-ledger.js';

test('caches 50 terminal and two unfinished ledgers, invalidates only the appended file, and preserves uncached results', () => {
  const dir = mkdtempSync(join(tmpdir(), 'unfinished-ledger-cache-'));
  const id = (n: number) => `run-00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
  const entry = (runId: string, event: string, timestamp: string, data: Record<string, unknown> = {}) =>
    JSON.stringify({ runId, event, timestamp, data }) + '\n';
  let reads = 0;
  const read: RunLedgerReader = (path, encoding) => {
    if (path.endsWith('.jsonl')) reads += 1;
    return readFileSync(path, encoding);
  };
  const originalLog = debug.log;
  const originalNow = Date.now;
  const observations: Array<{ event: string; data: unknown }> = [];
  try {
    for (let n = 0; n < 52; n += 1) {
      const runId = id(n);
      writeFileSync(join(dir, `${runId}.jsonl`), entry(runId, 'start', '2026-09-27T00:00:00Z', { branch: `branch-${n}` })
        + (n < 50 ? entry(runId, 'run-status', '2026-09-27T00:01:00Z', { runStatus: 'completed' }) : ''), 'utf8');
    }
    const changedPath = join(dir, `${id(50)}.jsonl`);
    const fixedMtime = new Date('2026-09-26T00:00:00.000Z');
    utimesSync(changedPath, fixedMtime, fixedMtime);
    (debug as { log: typeof debug.log }).log = ((category, event, data) => {
      if (category === 'self-implement.run-ledger') observations.push({ event, data });
    }) as typeof debug.log;
    Date.now = () => Date.parse('2026-09-27T01:00:00Z');
    const query = (noCache = false) => queryUnfinishedRunLedgers({ dir, goalsDir: dir, read, noCache });
    const first = query();
    expect(reads).toBe(52);
    expect(first).toMatchObject({ cacheHits: 0, cacheMisses: 52, terminalByTrailingRunStatus: 0 });
    expect(first.entries.map(({ runId }) => runId)).toEqual([id(50), id(51)]);
    const firstUncached = query(true);
    expect(first.entries).toEqual(firstUncached.entries);
    expect(first.terminalByTrailingRunStatus).toBe(firstUncached.terminalByTrailingRunStatus);
    reads = 0;
    const second = query();
    expect(reads).toBe(0);
    expect(second).toMatchObject({ cacheHits: 52, cacheMisses: 0 });
    const beforeAppend = statSync(changedPath);
    appendFileSync(changedPath, entry(id(50), 'run-status', '2026-09-27T00:02:00Z', { runStatus: 'failed' }), 'utf8');
    utimesSync(changedPath, beforeAppend.atime, beforeAppend.mtime);
    reads = 0;
    const third = query();
    expect(reads).toBe(1);
    expect(third).toMatchObject({ cacheHits: 51, cacheMisses: 1 });
    expect(third.entries.map(({ runId }) => runId)).toEqual([id(51)]);
    for (const cached of [first, second, third]) expect(cached.unreadableLedgerCount).toBe(0);
    expect(second.entries).toEqual(firstUncached.entries);
    expect(second.terminalByTrailingRunStatus).toBe(firstUncached.terminalByTrailingRunStatus);
    const uncached = query(true);
    expect(third.entries).toEqual(uncached.entries);
    expect(third.unreadableLedgerCount).toBe(uncached.unreadableLedgerCount);
    expect(third.terminalByTrailingRunStatus).toBe(uncached.terminalByTrailingRunStatus);
    expect(uncached.cacheHits).toBe(0);
    expect(uncached.cacheMisses).toBe(52);
    const unreadableId = id(51);
    const unreadablePath = join(dir, `${unreadableId}.jsonl`);
    writeFileSync(unreadablePath, '{invalid json}\n', 'utf8');
    const broken = query();
    expect(broken.entries).toEqual([expect.objectContaining({ runId: unreadableId, status: 'ledger-unreadable' })]);
    expect(broken).toMatchObject({ unreadableLedgerCount: 1, cacheHits: 51, cacheMisses: 1 });
    expect(observations.filter(({ event }) => event === 'unfinished-query').map(({ data }) => data)).toEqual([
      expect.objectContaining({ cacheHits: 0, cacheMisses: 52 }),
      expect.objectContaining({ cacheHits: 0, cacheMisses: 52 }),
      expect.objectContaining({ cacheHits: 52, cacheMisses: 0 }),
      expect.objectContaining({ cacheHits: 51, cacheMisses: 1 }),
      expect.objectContaining({ cacheHits: 0, cacheMisses: 52 }),
      expect.objectContaining({ cacheHits: 51, cacheMisses: 1 }),
    ]);
  } finally {
    Date.now = originalNow;
    (debug as { log: typeof debug.log }).log = originalLog;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isolates injected readers and their read failures from one another and from the default reader', () => {
  const dir = mkdtempSync(join(tmpdir(), 'unfinished-reader-isolation-'));
  const runId = 'run-00000000-0000-4000-8000-0000000000aa';
  const path = join(dir, `${runId}.jsonl`);
  const start = JSON.stringify({ runId, event: 'start', timestamp: '2026-09-27T00:00:00Z', data: { branch: 'default' } }) + '\n';
  const terminal = JSON.stringify({ runId, event: 'run-status', timestamp: '2026-09-27T00:01:00Z', data: { runStatus: 'completed' } }) + '\n';
  const readerA: RunLedgerReader = (file, encoding) => file === path ? start + terminal : readFileSync(file, encoding);
  const readerB: RunLedgerReader = (file, encoding) => file === path ? start : readFileSync(file, encoding);
  const failingReader: RunLedgerReader = (file, encoding) => {
    if (file === path) throw new Error('injected read failure');
    return readFileSync(file, encoding);
  };
  try {
    writeFileSync(path, start + terminal, 'utf8');
    const query = (read?: RunLedgerReader, noCache = false) => queryUnfinishedRunLedgers({ dir, goalsDir: dir, read, noCache });
    const defaultFirst = query();
    expect(defaultFirst).toMatchObject({ entries: [], cacheHits: 0, cacheMisses: 1 });
    const fromA = query(readerA);
    expect(fromA).toMatchObject({ entries: [], cacheHits: 0, cacheMisses: 1 });
    const fromB = query(readerB);
    expect(fromB).toMatchObject({ cacheHits: 0, cacheMisses: 1 });
    expect(fromB.entries).toEqual(query(readerB, true).entries);
    expect(fromB.entries).toEqual([expect.objectContaining({ runId, branch: 'default', status: 'terminal-status-missing' })]);
    const failed = query(failingReader);
    expect(failed).toMatchObject({ unreadableLedgerCount: 1, cacheHits: 0, cacheMisses: 1 });
    expect(failed.entries).toEqual(query(failingReader, true).entries);
    expect(failed.entries).toEqual([expect.objectContaining({ runId, status: 'ledger-unreadable' })]);
    expect(query()).toMatchObject({ entries: [], cacheHits: 1, cacheMisses: 0 });
    expect(query(readerA)).toMatchObject({ entries: [], cacheHits: 1, cacheMisses: 0 });
    expect(query(readerB)).toMatchObject({ cacheHits: 1, cacheMisses: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
