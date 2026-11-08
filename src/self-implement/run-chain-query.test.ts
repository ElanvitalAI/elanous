import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogStore, type LogQuery } from '../mss/logging/log-store.js';
import { parseRunShardIdentity, queryMergeAttribution, queryMergedRunLedgers, queryRunChain, queryRunScreenKey, queryUnfinishedRunLedgers, renderRunChain, type RunChainLogStore } from './run-ledger.js';

function appendLog(store: LogStore, category: string, event: string, data: Record<string, unknown>): void {
  store.insertBatch([{ surface: 'test', rec: { ts: '2026-08-06T00:00:00.000Z', category, event, data } }]);
  if (category === 'dev-pipeline' && event === 'plan' && typeof data.runId === 'string') {
    store.insertBatch([{ surface: 'test', rec: { ts: '2026-08-06T00:00:00.000Z', category: 'self-implement', event: 'start', data: { runId: data.runId, goalSource: 'natural-language-dispatch' } } }]);
  }
}

function fixture(runId: string, prNumber: number, merged: boolean): { root: string; ledgerDir: string; logPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'run-chain-query-'));
  const ledgerDir = join(root, 'run-ledger');
  const logPath = join(root, 'logs', 'logs.db');
  mkdirSync(ledgerDir, { recursive: true });
  writeFileSync(join(ledgerDir, `${runId}.jsonl`), `${JSON.stringify({ timestamp: '2026-08-06T00:01:00.000Z', runId, event: 'merged', data: { number: prNumber, merged } })}\n`, 'utf8');
  return { root, ledgerDir, logPath };
}

function readonlyStore(path: string): LogStore {
  return LogStore.openReadOnly(path);
}

describe('run-ledger scan queries', () => {
  it('counts only canonical run-<uuid>.jsonl files', () => {
    const root = mkdtempSync(join(tmpdir(), 'run-ledger-canonical-files-'));
    const ledgerDir = join(root, 'run-ledger');
    const runId = 'run-00000000-0000-4000-8000-0000000000ff';
    const noncanonicalFiles = ['a-b.jsonl', 'x.jsonl', 'noop.jsonl', 'my-feat.jsonl', 'run.jsonl', 'caller-run-9.jsonl', 'keep-slug-fallback.jsonl'];
    try {
      mkdirSync(ledgerDir, { recursive: true });
      writeFileSync(join(ledgerDir, `${runId}.jsonl`), `${JSON.stringify({ timestamp: '2026-08-06T00:01:00.000Z', runId, event: 'merged', data: { number: 42, merged: true } })}\n`, 'utf8');
      for (const fileName of noncanonicalFiles) {
        const fixtureRunId = fileName.slice(0, -'.jsonl'.length);
        writeFileSync(join(ledgerDir, fileName), `${JSON.stringify({ timestamp: '2026-08-06T00:01:00.000Z', runId: fixtureRunId, event: 'merged', data: { number: 99, merged: true } })}\n`, 'utf8');
      }

      expect(queryMergedRunLedgers({ dir: ledgerDir }).entries).toEqual([expect.objectContaining({ runId, prNumber: 42 })]);
      expect(queryMergeAttribution({ dir: ledgerDir }).elanousMergedEntries).toEqual([expect.objectContaining({ runId, prNumber: 42 })]);
      expect(queryUnfinishedRunLedgers({ dir: ledgerDir, goalsDir: join(root, 'missing-goals') }).entries).toEqual([expect.objectContaining({ runId })]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('queryRunChain', () => {
  it('propagates merged-ledger exclusion counters into structured and rendered chain output', () => {
    const runId = 'run-00000000-0000-4000-8000-0000000000fd';
    const excludedRunId = 'run-00000000-0000-4000-8000-0000000000fc';
    const unreadableRunId = 'run-00000000-0000-4000-8000-0000000000fb';
    const f = fixture(runId, 40, true);
    try {
      writeFileSync(join(f.ledgerDir, `${excludedRunId}.jsonl`), [
        JSON.stringify({ timestamp: '2026-08-06T00:01:00.000Z', runId: excludedRunId, event: 'merged', data: { number: 41, merged: true } }),
        JSON.stringify({ timestamp: '2026-08-06T00:02:00.000Z', runId: excludedRunId, event: 'merged', data: { number: 42, merged: true } }),
      ].join('\n'), 'utf8');
      writeFileSync(join(f.ledgerDir, `${unreadableRunId}.jsonl`), '{invalid json}\n', 'utf8');

      const result = queryRunChain({ dir: f.ledgerDir, logStorePath: f.logPath });

      expect(result).toMatchObject({
        excludedLedgerCount: 1,
        excludedMergedEntryCount: 2,
        unreadableLedgerCount: 1,
      });
      expect(result.entries.map((entry) => entry.runId)).toEqual([runId]);
      expect(renderRunChain(result)).toContain('excluded ledgers: 1; excluded merged entries: 2; unreadable ledgers: 1');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('returns producer shard identities and only same-orchestration siblings from one ledger scan', () => {
    const runIds = [
      'run-00000000-0000-4000-8000-0000000000c1',
      'run-00000000-0000-4000-8000-0000000000c2',
      'run-00000000-0000-4000-8000-0000000000c3',
      'run-00000000-0000-4000-8000-0000000000d1',
    ] as const;
    const f = fixture(runIds[0], 61, true);
    let readCount = 0;
    try {
      const identities = [
        parseRunShardIdentity('implement\n\n## Shard identity\n{"orchestrationId":"orchestration-a","shardId":"a-0","totalShards":3,"position":1}'),
        parseRunShardIdentity('implement\n\n## Shard identity\n{"orchestrationId":"orchestration-a","shardId":"a-1","totalShards":3,"position":2}'),
        parseRunShardIdentity('implement\n\n## Shard identity\n{"orchestrationId":"orchestration-a","shardId":"a-2","totalShards":3,"position":3}'),
        parseRunShardIdentity('implement\n\n## Shard identity\n{"orchestrationId":"orchestration-b","shardId":"b-0","totalShards":2,"position":1}'),
      ];
      for (const [index, runId] of runIds.entries()) {
        writeFileSync(join(f.ledgerDir, `${runId}.jsonl`), `${JSON.stringify({ timestamp: '2026-08-06T00:01:00.000Z', runId, event: 'start', data: {}, ...identities[index] })}\n${JSON.stringify({ timestamp: '2026-08-06T00:02:00.000Z', runId, event: 'merged', data: { number: 61 + index, merged: true } })}\n`, 'utf8');
      }
      const result = queryRunChain({ dir: f.ledgerDir, logStorePath: f.logPath, read: (path, encoding) => { readCount += 1; return readFileSync(path, encoding); } });
      const selected = result.entries.find((entry) => entry.runId === runIds[1])!;
      expect(selected.shardIdentity).toEqual({ orchestrationId: 'orchestration-a', shardId: 'a-1', pieceIndex: 1, pieceTotal: 3 });
      expect(selected.shardSiblings).toEqual([
        { runId: runIds[0], shardId: 'a-0', pieceIndex: 0 },
        { runId: runIds[2], shardId: 'a-2', pieceIndex: 2 },
      ]);
      expect(selected.shardSiblings.map((sibling) => sibling.runId)).not.toContain(runIds[1]);
      expect(selected.shardSiblings.map((sibling) => sibling.runId)).not.toContain(runIds[3]);
      expect(readCount).toBe(runIds.length);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('preserves producer distinction between an unsharded run and identity read failures without inferring legacy rows', () => {
    const runIds = [
      'run-00000000-0000-4000-8000-0000000000e1',
      'run-00000000-0000-4000-8000-0000000000e2',
      'run-00000000-0000-4000-8000-0000000000e3',
    ] as const;
    const f = fixture(runIds[0], 71, true);
    try {
      const identities = [
        parseRunShardIdentity('implement'),
        parseRunShardIdentity('implement\n\n## Shard identity\n{broken'),
        parseRunShardIdentity('implement\n\n## Shard identity\n{"shardId":"","totalShards":2,"position":1}'),
      ];
      for (const [index, runId] of runIds.entries()) {
        writeFileSync(join(f.ledgerDir, `${runId}.jsonl`), `${JSON.stringify({ timestamp: '2026-08-06T00:01:00.000Z', runId, event: 'start', data: {}, ...identities[index] })}\n${JSON.stringify({ timestamp: '2026-08-06T00:02:00.000Z', runId, event: 'merged', data: { number: 71 + index, merged: true } })}\n`, 'utf8');
      }
      const legacyRunId = 'run-00000000-0000-4000-8000-0000000000e4';
      writeFileSync(join(f.ledgerDir, `${legacyRunId}.jsonl`), `${JSON.stringify({ timestamp: '2026-08-06T00:02:00.000Z', runId: legacyRunId, event: 'merged', data: { number: 74, merged: true } })}\n`, 'utf8');
      const byRunId = new Map(queryRunChain({ dir: f.ledgerDir, logStorePath: f.logPath }).entries.map((entry) => [entry.runId, entry]));
      expect(byRunId.get(runIds[0])?.shardIdentity).toEqual({ pieceTotal: 1 });
      expect(byRunId.get(runIds[1])?.shardIdentity).toEqual({ pieceTotal: 1, shardIdentityReadFailure: 'malformed-structure' });
      expect(byRunId.get(runIds[2])?.shardIdentity).toEqual({ pieceTotal: 1, shardIdentityReadFailure: 'invalid-values' });
      expect(byRunId.get(legacyRunId)?.shardIdentity).toBeNull();
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('counts a same-runId multi-start ledger once without arbitrary goalSource attribution', () => {
    const runId = 'run-00000000-0000-4000-8000-0000000000fe';
    const f = fixture(runId, 41, true);
    try {
      const store = new LogStore(f.logPath, { instance: 'test' });
      store.insertBatch([
        { surface: 'test', rec: { ts: '2026-08-06T00:00:00.000Z', category: 'dev-pipeline', event: 'plan', data: { runId, goalId: 'goal-multi-start', originSession: 'origin-multi-start' } } },
        { surface: 'test', rec: { ts: '2026-08-06T00:00:01.000Z', category: 'self-implement', event: 'start', data: { runId, feature: 'feature-one', goalSource: 'natural-language-dispatch' } } },
        { surface: 'test', rec: { ts: '2026-08-06T00:00:02.000Z', category: 'self-implement', event: 'start', data: { runId, feature: 'feature-two', goalSource: 'authored-goal-file' } } },
        { surface: 'test', rec: { ts: '2026-08-06T00:00:03.000Z', category: 'daemon-tools.self-implement', event: 'done', data: { runId, pr: 'https://github.com/acme/elanous/pull/41' } } },
      ]);
      store.close();
      for (const [fixtureRunId, prNumber] of [['feature-one', 51], ['feature-two', 52]] as const) {
        writeFileSync(join(f.ledgerDir, `${fixtureRunId}.jsonl`), `${JSON.stringify({ timestamp: '2026-08-06T00:01:00.000Z', runId: fixtureRunId, event: 'merged', data: { number: prNumber, merged: true } })}\n`, 'utf8');
      }

      const result = queryRunChain({ dir: f.ledgerDir, logStorePath: f.logPath });
      expect(result.entries.map((entry) => entry.runId)).toEqual([runId]);
      expect(result.entries.map((entry) => entry.prNumber)).toEqual([41]);
      expect(result.entries[0]).toMatchObject({ runId, goalId: 'goal-multi-start', prNumber: 41, merged: true });
      expect(result.entries[0]?.hops).toEqual({ fingerprint: 'not-countable', goalId: 'connected', runId: 'not-countable', pr: 'not-countable', merged: 'connected' });
      // Conflicting starts are the third cause that collapses goalSource to null — alongside
      // "no start event" and "start without a string goalSource". The field narrows the
      // ambiguity; it does not claim to have removed it.
      expect(result.entries[0]?.goalSource).toBeNull();
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('joins real read-only log-store rows into fingerprint→goalId→runId→PR→merged', () => {
    const f = fixture('run-00000000-0000-4000-8000-000000000001', 42, true);
    try {
      const store = new LogStore(f.logPath, { instance: 'test' });
      appendLog(store, 'dev-pipeline', 'plan', { runId: 'run-00000000-0000-4000-8000-000000000001', goalId: 'goal-1', originRoot: 'human', originAgent: 'agent-1', originSession: 'origin-1' });
      appendLog(store, 'daemon-tools.self-implement', 'dispatch', { sessionId: 'origin-1', userText: 'human request fingerprint' });
      appendLog(store, 'daemon-tools.self-implement', 'done', { runId: 'run-00000000-0000-4000-8000-000000000001', pr: 'https://github.com/acme/elanous/pull/42' });
      store.close();
      const result = queryRunChain({ dir: f.ledgerDir, logStorePath: f.logPath });
      expect(result.entries).toEqual([expect.objectContaining({ fingerprint: 'human request fingerprint', goalId: 'goal-1', runId: 'run-00000000-0000-4000-8000-000000000001', prNumber: 42, merged: true, goalSource: 'natural-language-dispatch', hops: { fingerprint: 'connected', goalId: 'connected', runId: 'connected', pr: 'connected', merged: 'connected' } })]);
      expect(renderRunChain(result).split('\n')[3]).toBe('fingerprint=human request fingerprint goalId=goal-1 runId=run-00000000-0000-4000-8000-000000000001 PR=42 merged=true goalSource="natural-language-dispatch" hops=fingerprint:connected,goalId:connected,runId:connected,PR:connected,merged:connected');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('reports daemon-only hops as not-applicable for authored goal-file runs', () => {
    const f = fixture('run-00000000-0000-4000-8000-000000000002', 45, true);
    try {
      const store = new LogStore(f.logPath, { instance: 'test' });
      store.insertBatch([
        { surface: 'test', rec: { ts: '2026-08-06T00:00:00.000Z', category: 'dev-pipeline', event: 'plan', data: { runId: 'run-00000000-0000-4000-8000-000000000002', goalId: 'goal-authored', originSession: 'origin-authored' } } },
        { surface: 'test', rec: { ts: '2026-08-06T00:00:00.000Z', category: 'self-implement', event: 'start', data: { runId: 'run-00000000-0000-4000-8000-000000000002', goalSource: 'authored-goal-file' } } },
      ]);
      store.close();
      const result = queryRunChain({ dir: f.ledgerDir, logStorePath: f.logPath });
      expect(result.entries[0]?.hops).toEqual({ fingerprint: 'not-applicable', goalId: 'connected', runId: 'not-applicable', pr: 'not-applicable', merged: 'connected' });
      expect(renderRunChain(result)).toContain('hops=fingerprint:not-applicable,goalId:connected,runId:not-applicable,PR:not-applicable,merged:connected');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('reports daemon-only hops as not-applicable for no-goal-file runs', () => {
    const f = fixture('run-00000000-0000-4000-8000-000000000003', 46, true);
    try {
      const store = new LogStore(f.logPath, { instance: 'test' });
      store.insertBatch([
        { surface: 'test', rec: { ts: '2026-08-06T00:00:00.000Z', category: 'dev-pipeline', event: 'plan', data: { runId: 'run-00000000-0000-4000-8000-000000000003', goalId: 'goal-no-goal-file', originSession: 'origin-no-goal-file' } } },
        { surface: 'test', rec: { ts: '2026-08-06T00:00:00.000Z', category: 'self-implement', event: 'start', data: { runId: 'run-00000000-0000-4000-8000-000000000003', goalSource: 'no-goal-file' } } },
      ]);
      store.close();
      const entry = queryRunChain({ dir: f.ledgerDir, logStorePath: f.logPath }).entries[0]!;
      expect(entry.hops).toEqual({ fingerprint: 'not-applicable', goalId: 'connected', runId: 'not-applicable', pr: 'not-applicable', merged: 'connected' });
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('marks daemon-only hops not-countable when goalSource is absent', () => {
    const f = fixture('run-00000000-0000-4000-8000-000000000004', 46, true);
    try {
      const store = new LogStore(f.logPath, { instance: 'test' });
      store.insertBatch([{ surface: 'test', rec: { ts: '2026-08-06T00:00:00.000Z', category: 'dev-pipeline', event: 'plan', data: { runId: 'run-00000000-0000-4000-8000-000000000004', goalId: 'goal-unknown', originSession: 'origin-unknown' } } }]);
      store.close();
      const entry = queryRunChain({ dir: f.ledgerDir, logStorePath: f.logPath }).entries[0]!;
      expect(entry.hops).toEqual({ fingerprint: 'not-countable', goalId: 'connected', runId: 'not-countable', pr: 'not-countable', merged: 'connected' });
      expect(entry.goalSource).toBeNull();
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('marks daemon-only hops not-countable for an unrecognized goalSource', () => {
    const f = fixture('run-00000000-0000-4000-8000-000000000005', 47, true);
    try {
      const store = new LogStore(f.logPath, { instance: 'test' });
      store.insertBatch([
        { surface: 'test', rec: { ts: '2026-08-06T00:00:00.000Z', category: 'dev-pipeline', event: 'plan', data: { runId: 'run-00000000-0000-4000-8000-000000000005', goalId: 'goal-unrecognized', originSession: 'origin-unrecognized' } } },
        { surface: 'test', rec: { ts: '2026-08-06T00:00:00.000Z', category: 'self-implement', event: 'start', data: { runId: 'run-00000000-0000-4000-8000-000000000005', goalSource: 'future-dispatch-source' } } },
      ]);
      store.close();
      const entry = queryRunChain({ dir: f.ledgerDir, logStorePath: f.logPath }).entries[0]!;
      expect(entry.hops).toEqual({ fingerprint: 'not-countable', goalId: 'connected', runId: 'not-countable', pr: 'not-countable', merged: 'connected' });
      expect(entry.goalSource).toBe('future-dispatch-source');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  // The two not-countable causes above — an absent goalSource and an unrecognized one — reach the
  // hops wearing the same face, because `daemonObservationApplicability` funnels every unmatched
  // source into the same catch-all. Reporting the axis is what lets a reader tell them apart, so
  // this pins the distinction at the surface rather than only in the hop.
  it('separates the two not-countable causes by reporting goalSource on the entry and the rendered row', () => {
    const absent = fixture('run-00000000-0000-4000-8000-00000000000a', 51, true);
    const unrecognized = fixture('run-00000000-0000-4000-8000-00000000000b', 52, true);
    try {
      const absentStore = new LogStore(absent.logPath, { instance: 'test' });
      absentStore.insertBatch([{ surface: 'test', rec: { ts: '2026-08-06T00:00:00.000Z', category: 'dev-pipeline', event: 'plan', data: { runId: 'run-00000000-0000-4000-8000-00000000000a', goalId: 'goal-absent', originSession: 'origin-absent' } } }]);
      absentStore.close();
      const unrecognizedStore = new LogStore(unrecognized.logPath, { instance: 'test' });
      unrecognizedStore.insertBatch([
        { surface: 'test', rec: { ts: '2026-08-06T00:00:00.000Z', category: 'dev-pipeline', event: 'plan', data: { runId: 'run-00000000-0000-4000-8000-00000000000b', goalId: 'goal-unrecognized', originSession: 'origin-unrecognized' } } },
        { surface: 'test', rec: { ts: '2026-08-06T00:00:00.000Z', category: 'self-implement', event: 'start', data: { runId: 'run-00000000-0000-4000-8000-00000000000b', goalSource: 'future-dispatch-source' } } },
      ]);
      unrecognizedStore.close();

      const absentResult = queryRunChain({ dir: absent.ledgerDir, logStorePath: absent.logPath });
      const unrecognizedResult = queryRunChain({ dir: unrecognized.ledgerDir, logStorePath: unrecognized.logPath });

      // Same hop verdict on both — that is the ambiguity the column exists to resolve.
      expect(absentResult.entries[0]?.hops.runId).toBe('not-countable');
      expect(unrecognizedResult.entries[0]?.hops.runId).toBe('not-countable');

      expect(absentResult.entries[0]?.goalSource).toBeNull();
      expect(unrecognizedResult.entries[0]?.goalSource).toBe('future-dispatch-source');
      expect(renderRunChain(absentResult)).toContain('goalSource=null');
      expect(renderRunChain(unrecognizedResult)).toContain('goalSource="future-dispatch-source"');
    } finally {
      rmSync(absent.root, { recursive: true, force: true });
      rmSync(unrecognized.root, { recursive: true, force: true });
    }
  });

  // A sentinel drawn from the same namespace as the data re-creates the very collision this
  // column exists to remove: a producer that logs the literal string "unknown" must not render
  // identically to a run that logged nothing. Quoting the observed value keeps the two apart.
  it('keeps an absent goalSource distinct from one whose observed value is the literal string "unknown"', () => {
    const absent = fixture('run-00000000-0000-4000-8000-00000000000c', 53, true);
    const literal = fixture('run-00000000-0000-4000-8000-00000000000d', 54, true);
    try {
      const absentStore = new LogStore(absent.logPath, { instance: 'test' });
      absentStore.insertBatch([{ surface: 'test', rec: { ts: '2026-08-06T00:00:00.000Z', category: 'dev-pipeline', event: 'plan', data: { runId: 'run-00000000-0000-4000-8000-00000000000c', goalId: 'goal-absent', originSession: 'origin-absent' } } }]);
      absentStore.close();
      const literalStore = new LogStore(literal.logPath, { instance: 'test' });
      literalStore.insertBatch([
        { surface: 'test', rec: { ts: '2026-08-06T00:00:00.000Z', category: 'dev-pipeline', event: 'plan', data: { runId: 'run-00000000-0000-4000-8000-00000000000d', goalId: 'goal-literal', originSession: 'origin-literal' } } },
        { surface: 'test', rec: { ts: '2026-08-06T00:00:00.000Z', category: 'self-implement', event: 'start', data: { runId: 'run-00000000-0000-4000-8000-00000000000d', goalSource: 'unknown' } } },
      ]);
      literalStore.close();

      const absentRow = renderRunChain(queryRunChain({ dir: absent.ledgerDir, logStorePath: absent.logPath }));
      const literalRow = renderRunChain(queryRunChain({ dir: literal.ledgerDir, logStorePath: literal.logPath }));

      expect(absentRow).toContain('goalSource=null');
      expect(literalRow).toContain('goalSource="unknown"');
      expect(absentRow).not.toContain('goalSource="unknown"');
      expect(literalRow).not.toContain('goalSource=null');
    } finally {
      rmSync(absent.root, { recursive: true, force: true });
      rmSync(literal.root, { recursive: true, force: true });
    }
  });

  it('marks a present dispatch with non-string userText as a broken fingerprint hop', () => {
    const f = fixture('run-00000000-0000-4000-8000-000000000006', 43, true);
    try {
      const store = new LogStore(f.logPath, { instance: 'test' });
      appendLog(store, 'dev-pipeline', 'plan', { runId: 'run-00000000-0000-4000-8000-000000000006', goalId: 'goal-invalid', originSession: 'origin-invalid' });
      appendLog(store, 'daemon-tools.self-implement', 'dispatch', { sessionId: 'origin-invalid', userText: 42 });
      appendLog(store, 'daemon-tools.self-implement', 'done', { runId: 'run-00000000-0000-4000-8000-000000000006', pr: 'https://github.com/acme/elanous/pull/43' });
      store.close();
      const entry = queryRunChain({ dir: f.ledgerDir, logStorePath: f.logPath }).entries[0]!;
      expect(entry.fingerprint).toBeNull();
      expect(entry.hops).toEqual({ fingerprint: 'broken', goalId: 'connected', runId: 'connected', pr: 'connected', merged: 'connected' });
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('pages past a full matching dispatch result page to find an old matching session', () => {
    const f = fixture('run-00000000-0000-4000-8000-000000000007', 9, true);
    try {
      const store = new LogStore(f.logPath, { instance: 'test' });
      appendLog(store, 'dev-pipeline', 'plan', { runId: 'run-00000000-0000-4000-8000-000000000007', goalId: 'goal-old', originSession: 'origin-old' });
      appendLog(store, 'daemon-tools.self-implement', 'done', { runId: 'run-00000000-0000-4000-8000-000000000007', pr: 'https://github.com/acme/elanous/pull/9' });
      appendLog(store, 'daemon-tools.self-implement', 'dispatch', { sessionId: 'origin-old', userText: 'old request fingerprint' });
      store.insertBatch(Array.from({ length: 1_000 }, (_, index) => ({
        surface: 'test',
        rec: {
          ts: '2026-08-06T00:00:00.000Z',
          category: 'daemon-tools.self-implement',
          event: 'dispatch',
          data: { sessionId: `origin-old-distractor-${index}`, userText: 'distractor' },
        },
      })));
      store.close();
      const readOnly = readonlyStore(f.logPath);
      const dispatchQueries: LogQuery[] = [];
      const observingStore: RunChainLogStore = {
        query(query) {
          const logQuery = query ?? {};
          if (logQuery.exactCategories?.includes('daemon-tools.self-implement') && logQuery.events?.includes('dispatch') && logQuery.grep === 'origin-old') dispatchQueries.push(logQuery);
          return readOnly.query(logQuery);
        },
      };
      try {
        const entry = queryRunChain({ dir: f.ledgerDir, logStorePath: f.logPath, logStore: observingStore }).entries[0]!;
        expect(entry.fingerprint).toBe('old request fingerprint');
        expect(entry.hops.fingerprint).toBe('connected');
        expect(dispatchQueries).toHaveLength(2);
        expect(dispatchQueries[0]).toMatchObject({ limit: 1_000 });
        expect(dispatchQueries[1]).toMatchObject({ limit: 1_000 });
        expect(dispatchQueries[1]?.beforeId).toEqual(expect.any(Number));
      } finally { readOnly.close(); }
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('isolates a query failure to its run instead of contaminating a later readable run', () => {
    const f = fixture('run-00000000-0000-4000-8000-000000000008', 7, true);
    try {
      writeFileSync(join(f.ledgerDir, 'run-00000000-0000-4000-8000-000000000009.jsonl'), `${JSON.stringify({ timestamp: '2026-08-06T00:02:00.000Z', runId: 'run-00000000-0000-4000-8000-000000000009', event: 'merged', data: { number: 8, merged: true } })}\n`, 'utf8');
      const store = new LogStore(f.logPath, { instance: 'test' });
      appendLog(store, 'dev-pipeline', 'plan', { runId: 'run-00000000-0000-4000-8000-000000000009', goalId: 'goal-good', originSession: 'origin-good' });
      appendLog(store, 'daemon-tools.self-implement', 'dispatch', { sessionId: 'origin-good', userText: 'good request' });
      appendLog(store, 'daemon-tools.self-implement', 'done', { runId: 'run-00000000-0000-4000-8000-000000000009', pr: 'https://github.com/acme/elanous/pull/8' });
      store.close();
      const readOnly = readonlyStore(f.logPath);
      const failingStore: RunChainLogStore = {
        query(query) {
          const logQuery = query ?? {};
          if (logQuery.grep === 'run-00000000-0000-4000-8000-000000000008') throw new Error('fixture read failure');
          return readOnly.query(logQuery);
        },
      };
      try {
        const result = queryRunChain({ dir: f.ledgerDir, logStorePath: f.logPath, logStore: failingStore });
        const byRunId = new Map(result.entries.map((entry) => [entry.runId, entry]));
        expect(result.logStoreStatus).toBe('read');
        expect(byRunId.get('run-00000000-0000-4000-8000-000000000008')?.hops).toEqual({ fingerprint: 'not-countable', goalId: 'not-countable', runId: 'not-countable', pr: 'not-countable', merged: 'connected' });
        expect(byRunId.get('run-00000000-0000-4000-8000-000000000009')).toEqual(expect.objectContaining({ fingerprint: 'good request', hops: { fingerprint: 'connected', goalId: 'connected', runId: 'connected', pr: 'connected', merged: 'connected' } }));
      } finally { readOnly.close(); }
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('marks only fingerprint not-countable when its dispatch page fails after direct plan and done evidence succeeded', () => {
    const f = fixture('run-00000000-0000-4000-8000-00000000000a', 44, true);
    try {
      const store = new LogStore(f.logPath, { instance: 'test' });
      appendLog(store, 'dev-pipeline', 'plan', { runId: 'run-00000000-0000-4000-8000-00000000000a', goalId: 'goal-dispatch-failed', originSession: 'origin-dispatch-failed' });
      appendLog(store, 'daemon-tools.self-implement', 'done', { runId: 'run-00000000-0000-4000-8000-00000000000a', pr: 'https://github.com/acme/elanous/pull/44' });
      store.close();
      const readOnly = readonlyStore(f.logPath);
      const dispatchFailingStore: RunChainLogStore = {
        query(query) {
          const logQuery = query ?? {};
          if (logQuery.exactCategories?.includes('daemon-tools.self-implement') && logQuery.events?.includes('dispatch')) throw new Error('dispatch page unavailable');
          return readOnly.query(logQuery);
        },
      };
      try {
        const entry = queryRunChain({ dir: f.ledgerDir, logStorePath: f.logPath, logStore: dispatchFailingStore }).entries[0]!;
        expect(entry).toMatchObject({ goalId: 'goal-dispatch-failed', runId: 'run-00000000-0000-4000-8000-00000000000a', prNumber: 44, merged: true });
        expect(entry.hops).toEqual({ fingerprint: 'not-countable', goalId: 'connected', runId: 'connected', pr: 'connected', merged: 'connected' });
      } finally { readOnly.close(); }
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('reports a done PR mismatch as broken and unavailable log reads as not-countable', () => {
    const f = fixture('run-00000000-0000-4000-8000-00000000000b', 7, true);
    try {
      const store = new LogStore(f.logPath, { instance: 'test' });
      appendLog(store, 'dev-pipeline', 'plan', { runId: 'run-00000000-0000-4000-8000-00000000000b', goalId: 'goal-2', originSession: 'origin-2' });
      appendLog(store, 'daemon-tools.self-implement', 'done', { runId: 'run-00000000-0000-4000-8000-00000000000b', pr: 'https://github.com/acme/elanous/pull/8' });
      store.close();
      expect(queryRunChain({ dir: f.ledgerDir, logStorePath: f.logPath }).entries[0]?.hops).toEqual({ fingerprint: 'broken', goalId: 'connected', runId: 'connected', pr: 'broken', merged: 'connected' });
      expect(queryRunChain({ dir: f.ledgerDir, logStorePath: join(f.root, 'missing.db') }).entries[0]?.hops).toEqual({ fingerprint: 'not-countable', goalId: 'not-countable', runId: 'not-countable', pr: 'not-countable', merged: 'connected' });
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
});

describe('run screen key log-store failures', () => {
  const runId = 'run-00000000-0000-4000-8000-0000000000aa';

  it('returns unreadable rather than throwing when the injected query seam fails', () => {
    const failingStore: RunChainLogStore = { query: () => { throw new Error('fixture query failure'); } };
    expect(queryRunScreenKey(runId, { logStorePath: '/fixture/logs.db', logStore: failingStore }))
      .toMatchObject({ runId, screenKey: null, matchedSpawnCount: 0, logStoreStatus: 'unreadable' });
  });

  it('returns missing and unreadable states for unavailable real log-store paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'run-screen-log-store-'));
    try {
      expect(queryRunScreenKey(runId, { logStorePath: join(root, 'missing.db') }))
        .toMatchObject({ screenKey: null, matchedSpawnCount: 0, logStoreStatus: 'missing' });
      const directoryPath = join(root, 'logs-directory');
      mkdirSync(directoryPath);
      expect(queryRunScreenKey(runId, { logStorePath: directoryPath }))
        .toMatchObject({ screenKey: null, matchedSpawnCount: 0, logStoreStatus: 'unreadable' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
