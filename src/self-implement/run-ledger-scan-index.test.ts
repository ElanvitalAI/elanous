import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLedgerScanIndexPath } from './run-ledger.js';

// ⭐ 프로세스 간 유효 스캔 색인(칸 CONTEXT-NOW-RUN-SCAN-INDEX)의 초점 시험.
//   `/now` 워커는 요청마다 «새 프로세스»다 — 그래서 매 쿼리를 자식 bun 프로세스로 돌려
//   «같은 프로세스 두 번째 호출»이 아니라 «프로세스 경계 너머 재사용»을 잰다.
const runLedgerUrl = new URL('./run-ledger.ts', import.meta.url).href;
const childScript = `import(${JSON.stringify(runLedgerUrl)}).then((m) => {
  const result = m.queryUnfinishedRunLedgers({ dir: process.env.TEST_DIR, goalsDir: process.env.TEST_DIR });
  process.stdout.write(JSON.stringify({
    scope: result.scope,
    cacheHits: result.cacheHits,
    cacheMisses: result.cacheMisses,
    indexHits: result.indexHits,
    indexOrigin: result.indexOrigin,
    unreadableLedgerCount: result.unreadableLedgerCount,
    entries: result.entries.map((entry) => ({
      runId: entry.runId,
      status: entry.status,
      branch: entry.branch,
      lifecycle: entry.lifecycle,
      lastActivityTimestamp: entry.lastActivityTimestamp,
      lastActivityStatus: entry.lastActivityStatus,
      plannedPathStatus: entry.plannedPathStatus,
    })),
  }));
});`;

interface ChildQuery {
  scope: string;
  cacheHits?: number;
  cacheMisses?: number;
  indexHits?: number;
  indexOrigin?: string;
  unreadableLedgerCount: number;
  entries: Array<{
    runId: string;
    status: string;
    branch: string | null;
    lifecycle: string;
    lastActivityTimestamp: string | null;
    lastActivityStatus: string;
    plannedPathStatus: string;
  }>;
}

function childQuery(dir: string): ChildQuery {
  const stdout = execFileSync(process.execPath, ['-e', childScript], {
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', TEST_DIR: dir },
    encoding: 'utf8',
  });
  return JSON.parse(stdout) as ChildQuery;
}

test('a fresh worker process reuses the persisted scan index, invalidates on ledger writes, and survives a malformed index', () => {
  const dir = mkdtempSync(join(tmpdir(), 'run-ledger-scan-index-'));
  const id = (n: number) => `run-00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
  const entry = (runId: string, event: string, timestamp: string, data: Record<string, unknown> = {}) =>
    JSON.stringify({ runId, event, timestamp, data }) + '\n';
  try {
    // 3 terminal ledgers, 2 unfinished ledgers — fixed old timestamps keep lifecycle deterministic.
    for (let n = 0; n < 5; n += 1) {
      const runId = id(n);
      writeFileSync(join(dir, `${runId}.jsonl`),
        entry(runId, 'start', '2026-01-01T00:00:00Z', { branch: `branch-${n}` })
        + (n < 3 ? entry(runId, 'run-status', '2026-01-01T00:01:00Z', { runStatus: 'completed' }) : ''), 'utf8');
    }
    const index = runLedgerScanIndexPath(dir);

    // ① First worker process: nothing persisted yet — every ledger is a miss, and the index is written.
    const first = childQuery(dir);
    expect(first).toMatchObject({ scope: 'self-implement-run-ledger', cacheHits: 0, cacheMisses: 5, indexHits: 0, indexOrigin: 'fresh', unreadableLedgerCount: 0 });
    expect(first.entries.map(({ runId }) => runId)).toEqual([id(3), id(4)]);
    for (const observed of first.entries) {
      expect(observed).toMatchObject({ status: 'terminal-status-missing', lifecycle: 'orphaned', lastActivityTimestamp: '2026-01-01T00:00:00Z', lastActivityStatus: 'available' });
    }
    expect(existsSync(index)).toBe(true);
    expect(JSON.parse(readFileSync(index, 'utf8')).version).toBe(1);

    // ② A fresh worker process (the /now shape) reuses the persisted facts: all hits, zero re-reads, identical rows.
    const second = childQuery(dir);
    expect(second).toMatchObject({ cacheHits: 5, cacheMisses: 0, indexHits: 5, indexOrigin: 'loaded', unreadableLedgerCount: 0 });
    expect(second.entries).toEqual(first.entries);

    // ③ A ledger write (append) invalidates exactly that entry: one re-read, the rest stay index hits.
    const terminalPath = join(dir, `${id(3)}.jsonl`);
    appendFileSync(terminalPath, entry(id(3), 'run-status', '2026-01-02T00:00:00Z', { runStatus: 'failed' }), 'utf8');
    const third = childQuery(dir);
    expect(third).toMatchObject({ cacheHits: 4, cacheMisses: 1, indexHits: 4, indexOrigin: 'loaded', unreadableLedgerCount: 0 });
    expect(third.entries.map(({ runId }) => runId)).toEqual([id(4)]);

    // ④ A non-terminal append updates last-activity through the same single-entry invalidation.
    const livePath = join(dir, `${id(4)}.jsonl`);
    appendFileSync(livePath, entry(id(4), 'progress', '2026-02-01T00:00:00Z', { note: 'still going' }), 'utf8');
    const fourth = childQuery(dir);
    expect(fourth).toMatchObject({ cacheHits: 4, cacheMisses: 1, indexHits: 4, indexOrigin: 'loaded', unreadableLedgerCount: 0 });
    expect(fourth.entries).toEqual([expect.objectContaining({ runId: id(4), lastActivityTimestamp: '2026-02-01T00:00:00Z' })]);

    // ⑤ A malformed index behaves as absent: honest re-reads, then a valid index is written back.
    writeFileSync(index, '{not json', 'utf8');
    const fifth = childQuery(dir);
    expect(fifth).toMatchObject({ cacheHits: 0, cacheMisses: 5, indexHits: 0, indexOrigin: 'fresh', unreadableLedgerCount: 0 });
    expect(fifth.entries).toEqual(fourth.entries);
    expect(JSON.parse(readFileSync(index, 'utf8')).version).toBe(1);

    // ⑥ noCache bypasses the index and keeps the honest-read contract.
    const bypassed = JSON.parse(execFileSync(process.execPath, ['-e', `import(${JSON.stringify(runLedgerUrl)}).then((m) => {
      const result = m.queryUnfinishedRunLedgers({ dir: process.env.TEST_DIR, goalsDir: process.env.TEST_DIR, noCache: true });
      process.stdout.write(JSON.stringify({ cacheHits: result.cacheHits, cacheMisses: result.cacheMisses, indexOrigin: result.indexOrigin, entries: result.entries.length }));
    });`], { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', TEST_DIR: dir }, encoding: 'utf8' }));
    expect(bypassed).toEqual({ cacheHits: 0, cacheMisses: 5, indexOrigin: 'bypassed', entries: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});