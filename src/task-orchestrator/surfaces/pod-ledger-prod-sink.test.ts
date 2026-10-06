import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogStore } from '../../mss/logging/log-store.js';
import { launchHomeLogsDb, operationalReemit, POD_REEMIT_LOGS_DB_ENV } from './pod-ledger-prod-sink.js';
import { collectPodLedgers } from './pod-ledger-collect.js';

describe('POD-OBS — Pod ledger reemit also lands in the launch home logs.db', () => {
  test('no launch-home env, same db, or a test process without an injected store → no extra write', () => {
    expect(launchHomeLogsDb({})).toBeUndefined();
    expect(operationalReemit({ operationalDb: undefined, currentDb: '/a/logs.db', testProcess: false })).toBeNull();
    expect(operationalReemit({ operationalDb: '/a/logs.db', currentDb: '/a/logs.db', open: () => ({ insertBatch: () => {} }) })).toBeNull();
    expect(operationalReemit({ operationalDb: '/home/logs.db', currentDb: '/tree/logs.db', testProcess: true })).toBeNull();
  });

  test('parent universe A gets the reemit (+ one targetUniverse line); child universe B gets none', () => {
    const a = join(mkdtempSync(join(tmpdir(), 'pod-obs-a-')), 'logs.db');
    const b = join(mkdtempSync(join(tmpdir(), 'pod-obs-b-')), 'logs.db');
    const toB: string[] = [];
    const emit = operationalReemit({ operationalDb: a, currentDb: b, open: (path) => new LogStore(path, { instance: 'prod' }), fallback: (_c, e) => { toB.push(e); } });
    emit!('self-implement', 'pre-pr-sync', { runId: 'run-x', origin: 'pod', podLedgerOffset: 0 });
    const store = new LogStore(a, { readonly: true });
    try {
      expect(store.countMatching({ events: ['pre-pr-sync'] })).toBe(1);
      expect(store.countMatching({ events: ['reemit-target'] })).toBe(1);
    } finally { store.close(); }
    expect(toB).toEqual([]);
  });

  test('A cannot be opened → the line falls back to B with exactly one warning', () => {
    const toB: string[] = [];
    const emit = operationalReemit({ operationalDb: '/home/logs.db', currentDb: '/tree/logs.db', open: () => { throw new Error('locked'); }, fallback: (_c, e) => { toB.push(e); } });
    expect(() => emit!('self-implement', 'pre-pr-sync', {})).not.toThrow();
    emit!('self-implement', 'gate-passed', {});
    emit!('self-implement', 'review-done', {});
    // 세 줄 모두 B 로 떨어지고 경고는 한 번.
    expect(toB).toEqual(['pre-pr-sync', 'reemit-target-unavailable', 'gate-passed', 'review-done']);
  });

  test('env name is the one the dispatcher sets', () => {
    expect(POD_REEMIT_LOGS_DB_ENV).toBe('ELANOUS_POD_REEMIT_LOGS_DB');
    expect(launchHomeLogsDb({ ELANOUS_POD_REEMIT_LOGS_DB: ' /h/logs.db ' })).toBe('/h/logs.db');
  });

  test('collectPodLedgers still takes injected emit/log (tests never reach the default sink)', () => {
    const seen: string[] = [];
    collectPodLedgers('', { dir: mkdtempSync(join(tmpdir(), 'pod-obs-dir-')), log: (_c, e) => { seen.push(e); }, emit: (_c, e) => { seen.push(e); } });
    expect(seen).toEqual([]);
  });

  test('real collectPodLedgers: Pod lines land in A with origin/runId/offset, none in B; A failure warns once across log+emit', async () => {
    const { gzipSync } = await import('node:zlib');
    const { appendRunLedgerEntry, runLedgerDir } = await import('../../self-implement/run-ledger.js');
    const { readFileSync } = await import('node:fs');
    const runId = 'run-podobs-real';
    const src = runLedgerDir(mkdtempSync(join(tmpdir(), 'pod-obs-src-')));
    appendRunLedgerEntry({ runId, event: 'start', data: { origin: 'x' } }, src);
    appendRunLedgerEntry({ runId, category: 'self-implement.review', event: 'pre-pr-sync', data: { status: 'clean' } } as never, src);
    const jsonl = readFileSync(join(src, `${runId}.jsonl`), 'utf8');
    const encoded = gzipSync(Buffer.from(jsonl)).toString('base64');
    const logs = `ELANOUS_RUN_LEDGER ${runId} 1/1 ${encoded}`;

    const a = join(mkdtempSync(join(tmpdir(), 'pod-obs-a2-')), 'logs.db');
    const toB: string[] = [];
    const sink = operationalReemit({ operationalDb: a, currentDb: '/tree/b.db', open: (path) => new LogStore(path, { instance: 'prod' }), fallback: (_c, e) => { toB.push(e); } })!;
    collectPodLedgers(logs, { dir: runLedgerDir(mkdtempSync(join(tmpdir(), 'pod-obs-dst-'))), log: sink, emit: sink });
    const store = new LogStore(a, { readonly: true });
    try {
      const rows = store.query({ events: ['pre-pr-sync'], limit: 5 });
      expect(rows).toHaveLength(1);
      expect(typeof rows[0]!.data === 'string' ? JSON.parse(rows[0]!.data as string) : rows[0]!.data).toMatchObject({ runId, origin: 'pod', podLedgerOffset: expect.any(Number) });
      expect(store.countMatching({ events: ['ledger-collected'] })).toBe(1);
    } finally { store.close(); }
    expect(toB).toEqual([]);

    const warnB: string[] = [];
    const broken = operationalReemit({ operationalDb: '/nope/logs.db', currentDb: '/tree/b.db', open: () => { throw new Error('locked'); }, fallback: (_c, e) => { warnB.push(e); } })!;
    collectPodLedgers(logs, { dir: runLedgerDir(mkdtempSync(join(tmpdir(), 'pod-obs-dst2-'))), log: broken, emit: broken });
    expect(warnB.filter((e) => e === 'reemit-target-unavailable')).toHaveLength(1);
    expect(warnB).toContain('pre-pr-sync');
  });
});

