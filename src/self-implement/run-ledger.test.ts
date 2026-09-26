import { afterAll, describe, expect, it } from 'bun:test';
import { appendRunLedgerEntry, cleanupUnfinishedRunLedgers, classifyFederatedLedgerDirectoryReadFailure, describeFederatedMissingRunLedger, dispositionUnfinishedRunLedger, isTerminatedUnfinishedLifecycle, loadFederatedRunLedger, classifyUnfinishedLifecycle, loadRunLedger, loadRunLedgerWithMetadata, lookupPrGoalAcceptance, parseRunShardIdentity, queryCompletedRunLedgers, queryFederatedCompletedRunLedgers, queryFederatedInterruptedRunLedgers, queryFederatedUnfinishedRunLedgers, queryInterruptedRunLedgers, queryRunChain, queryRunLedgerTimeline, queryRunScreenKey, queryUnfinishedRunLedgers, recordHumanStoppedRun, renderRunLedger, renderUnfinishedRunLedgers, runLedgerDir, summarizeRunLedgerRounds, TERMINATED_UNFINISHED_LIFECYCLES, type RunChainLogStore, type RunLedgerEntry, type RunLedgerReader, type UnfinishedRunLedgerEntry } from './run-ledger.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { LogStore } from '../mss/logging/log-store.js';


// ⛔⭐⭐⭐ 미완 «판별» — 종전엔 이 조회가 낸 것이 한 값(`terminal-status-missing`)뿐이었다.
//   📏 2026-08-11 실측: 그 한 값에 「실제로 도는 것 2 · 5.2일 된 잔해 51 · 종료를 «다른 이름»으로
//     적은 것 5」가 섞여 있었다 ⇒ 회고에서 「무엇이 내 찌꺼기인가」를 못 갈랐다.
//   ⭐ 등급 이름은 `harness worktrees` 사다리와 같은 결(특히 `unjudgeable`).

describe('run shard identity parsing', () => {
  it('converts the producer identity to zero-based ledger fields and excludes itself from siblings', () => {
    const request = `implement this\n\n## Shard identity\n${JSON.stringify({
      orchestrationId: 'orchestration-1', shardId: 'shard-b', totalShards: 3, position: 2, siblings: [
        { shardId: 'shard-a', summary: 'first' },
        { shardId: 'shard-b', summary: 'self' },
        { shardId: 'shard-c', summary: 'third' },
      ],
    })}`;

    expect(parseRunShardIdentity(request)).toEqual({
      orchestrationId: 'orchestration-1',
      shardId: 'shard-b',
      siblingShardIds: ['shard-a', 'shard-c'],
      pieceIndex: 1,
      pieceTotal: 3,
    });
  });

  it('reads the real header when a sibling summary contains the heading text', () => {
    const request = `implement this\n\n## Shard identity\n${JSON.stringify({
      shardId: 'shard-b', totalShards: 3, position: 2, siblings: [
        { shardId: 'shard-a', summary: 'first' },
        { shardId: 'shard-b', summary: 'request mentions ## Shard identity after the real header' },
        { shardId: 'shard-c', summary: 'third' },
      ],
    })}`;

    expect(parseRunShardIdentity(request)).toEqual({
      shardId: 'shard-b',
      siblingShardIds: ['shard-a', 'shard-c'],
      pieceIndex: 1,
      pieceTotal: 3,
    });
  });

  it('ignores heading text embedded in prose and uses the last real header line', () => {
    const secondIdentity = JSON.stringify({ shardId: 'second', totalShards: 2, position: 2, siblings: [{ shardId: 'first' }] });
    const request = `prose includes ## Shard identity but is not a header\r\n\r\n## Shard identity\r\n{broken}\n## Shard identity\n${secondIdentity}`;

    expect(parseRunShardIdentity(request)).toEqual({
      shardId: 'second',
      siblingShardIds: ['first'],
      pieceIndex: 1,
      pieceTotal: 2,
    });
  });

  it('distinguishes an unsharded request from a malformed identity without changing the fallback piece total', () => {
    const unsharded = parseRunShardIdentity('implement this');
    const malformed = parseRunShardIdentity('implement this\n\n## Shard identity\n{broken');

    expect(() => parseRunShardIdentity('implement this')).not.toThrow();
    expect(unsharded).toEqual({ pieceTotal: 1 });
    expect(() => parseRunShardIdentity('implement this\n\n## Shard identity\n{broken')).not.toThrow();
    expect(malformed).toEqual({ pieceTotal: 1, shardIdentityReadFailure: 'malformed-structure' });
    expect(malformed.pieceTotal).toBe(unsharded.pieceTotal);
    expect(parseRunShardIdentity('implement this\n\n## Shard identity\n{broken')).toEqual(malformed);
  });

  it('omits a read failure for a valid identity', () => {
    expect(parseRunShardIdentity('## Shard identity\n{"shardId":"only","totalShards":1,"position":1}').shardIdentityReadFailure)
      .toBeUndefined();
  });

  it('keeps an explicitly empty sibling list distinct from an omitted or invalid sibling field', () => {
    expect(parseRunShardIdentity('## Shard identity\n{"shardId":"only","totalShards":1,"position":1,"siblings":[]}'))
      .toEqual({ shardId: 'only', siblingShardIds: [], pieceIndex: 0, pieceTotal: 1 });
    expect(parseRunShardIdentity('## Shard identity\n{"shardId":"unknown","totalShards":1,"position":1}'))
      .toEqual({ shardId: 'unknown', pieceIndex: 0, pieceTotal: 1 });
    expect(parseRunShardIdentity('## Shard identity\n{"shardId":"legacy","totalShards":2,"position":1,"siblings":[]}').orchestrationId)
      .toBeUndefined();
    expect(parseRunShardIdentity('## Shard identity\n{"shardId":"partial","totalShards":2,"position":1,"siblings":[{"shardId":"sibling"},{"summary":"missing id"}]}'))
      .toEqual({ shardId: 'partial', pieceIndex: 0, pieceTotal: 2 });
  });

  it('reports invalid values while retaining the unsharded fallback total', () => {
    for (const request of [
      '## Shard identity\n{"totalShards":2,"position":1,"siblings":[]}',
      '## Shard identity\n{"shardId":42,"totalShards":2,"position":1,"siblings":[]}',
      '## Shard identity\n{"shardId":"","totalShards":2,"position":1,"siblings":[]}',
      '## Shard identity\n{"shardId":"   ","totalShards":2,"position":1,"siblings":[]}',
    ]) {
      expect(parseRunShardIdentity(request)).toEqual({ pieceTotal: 1, shardIdentityReadFailure: 'invalid-values' });
    }
  });

  it('leaves sibling identities unknown when any sibling id is blank', () => {
    expect(parseRunShardIdentity('## Shard identity\n{"shardId":"current","totalShards":2,"position":1,"siblings":[{"shardId":""}]}'))
      .toEqual({ shardId: 'current', pieceIndex: 0, pieceTotal: 2 });
    expect(parseRunShardIdentity('## Shard identity\n{"shardId":"current","totalShards":2,"position":1,"siblings":[{"shardId":"  "}]}'))
      .toEqual({ shardId: 'current', pieceIndex: 0, pieceTotal: 2 });
  });

  it('round-trips optional shard fields while loading legacy ledger records unchanged', () => {
    const directory = mkdtempSync(join(tmpdir(), 'run-ledger-shard-'));
    const runId = 'run-00000000-0000-4000-8000-000000000998';
    try {
      appendRunLedgerEntry({ runId, event: 'start', data: {}, ...parseRunShardIdentity('## Shard identity\n{"orchestrationId":"orchestration-round-trip","shardId":"shard-b","totalShards":3,"position":2,"siblings":[{"shardId":"shard-a"},{"shardId":"shard-c"}]}') }, directory);
      appendRunLedgerEntry({ runId, event: 'identity-read-failed', data: {}, ...parseRunShardIdentity('## Shard identity\n{broken') }, directory);
      appendRunLedgerEntry({ runId, event: 'legacy', data: {} }, directory);

      expect(loadRunLedger(runId, directory)).toEqual([
        expect.objectContaining({ orchestrationId: 'orchestration-round-trip', shardId: 'shard-b', siblingShardIds: ['shard-a', 'shard-c'], pieceIndex: 1, pieceTotal: 3 }),
        expect.objectContaining({ event: 'identity-read-failed', pieceTotal: 1, shardIdentityReadFailure: 'malformed-structure' }),
        { runId, event: 'legacy', data: {} },
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('queryRunChain cache freshness', () => {
  it('avoids a second ledger scan, returns an independent result, and refreshes after append, rewrite, deletion, and recreation', () => {
    const root = mkdtempSync(join(tmpdir(), 'run-chain-cache-'));
    const directory = join(root, 'run-ledger');
    const logStorePath = join(root, 'missing-logs.db');
    const firstRun = 'run-00000000-0000-4000-8000-00000000c001';
    const secondRun = 'run-00000000-0000-4000-8000-00000000c002';
    let reads = 0;
    const read: RunLedgerReader = (path, encoding) => { reads += 1; return readFileSync(path, encoding); };
    try {
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, `${firstRun}.jsonl`), `${JSON.stringify({ timestamp: '2026-08-17T00:00:00.000Z', runId: firstRun, event: 'merged', data: { number: 1, merged: true } })}\n`, 'utf8');
      const first = queryRunChain({ dir: directory, logStorePath, read });
      const firstCost = reads;
      (first.entries[0] as { runId: string }).runId = 'corrupted-return';
      const second = queryRunChain({ dir: directory, logStorePath, read });
      const secondCost = reads - firstCost;
      expect(firstCost).toBeGreaterThan(0);
      expect(secondCost).toBe(0);
      expect(second.entries.map((entry) => entry.runId)).toEqual([firstRun]);

      appendRunLedgerEntry({ timestamp: '2026-08-17T00:01:00.000Z', runId: secondRun, event: 'merged', data: { number: 2, merged: true } }, directory);
      expect(queryRunChain({ dir: directory, logStorePath, read }).entries.map((entry) => entry.runId)).toEqual([firstRun, secondRun]);
      writeFileSync(join(directory, `${firstRun}.jsonl`), `${JSON.stringify({ timestamp: '2026-08-17T00:02:00.000Z', runId: firstRun, event: 'merged', data: { number: 9, merged: false } })}\n`, 'utf8');
      expect(queryRunChain({ dir: directory, logStorePath, read }).entries.find((entry) => entry.runId === firstRun)?.merged).toBe(false);
      unlinkSync(join(directory, `${secondRun}.jsonl`));
      expect(queryRunChain({ dir: directory, logStorePath, read }).entries.map((entry) => entry.runId)).toEqual([firstRun]);
      writeFileSync(join(directory, `${secondRun}.jsonl`), `${JSON.stringify({ timestamp: '2026-08-17T00:03:00.000Z', runId: secondRun, event: 'merged', data: { number: 2, merged: true } })}\n`, 'utf8');
      expect(queryRunChain({ dir: directory, logStorePath, read }).entries.map((entry) => entry.runId)).toEqual([firstRun, secondRun]);
      const logStore = new LogStore(logStorePath, { instance: 'test' });
      logStore.insertBatch([{ surface: 'test', rec: { ts: '2026-08-17T00:04:00.000Z', category: 'dev-pipeline', event: 'plan', data: { runId: firstRun, goalId: 'fresh-log-goal' } } }]);
      logStore.close();
      expect(queryRunChain({ dir: directory, logStorePath, read }).entries.find((entry) => entry.runId === firstRun)?.goalId).toBe('fresh-log-goal');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('queryRunChain batched log observations', () => {
  const runId = (suffix: string) => `run-00000000-0000-4000-8000-00000000${suffix}`;

  it('uses one store query for multiple ledger runs while preserving each joined chain entry', () => {
    const root = mkdtempSync(join(tmpdir(), 'run-chain-batch-'));
    const directory = join(root, 'run-ledger');
    const firstRun = runId('d001');
    const secondRun = runId('d002');
    let queries = 0;
    const row = (id: number, category: string, event: string, data: Record<string, unknown>) => ({
      id, ts: '2026-08-17T00:00:00.000Z', ts_ms: Date.parse('2026-08-17T00:00:00.000Z'), level: 'info', instance: 'test', surface: 'test', category, event, session_id: null, trace_id: null, data: JSON.stringify(data),
    });
    const rows = [
      row(1, 'dev-pipeline', 'plan', { runId: firstRun, goalId: 'first-goal', originSession: 'first-session' }),
      row(2, 'self-implement', 'start', { runId: firstRun, goalSource: 'natural-language-dispatch' }),
      row(3, 'daemon-tools.self-implement', 'dispatch', { sessionId: 'first-session', userText: 'first request' }),
      row(4, 'daemon-tools.self-implement', 'done', { runId: firstRun, pr: 'https://github.com/acme/elanous/pull/1' }),
      row(5, 'dev-pipeline', 'plan', { runId: secondRun, goalId: 'second-goal', originSession: 'second-session' }),
      row(6, 'self-implement', 'start', { runId: secondRun, goalSource: 'natural-language-dispatch' }),
      row(7, 'daemon-tools.self-implement', 'dispatch', { sessionId: 'second-session', userText: 'second request' }),
      row(8, 'daemon-tools.self-implement', 'done', { runId: secondRun, pr: 'https://github.com/acme/elanous/pull/2' }),
    ];
    const store: RunChainLogStore = {
      query: () => { throw new Error('unbounded query must not run'); },
      queryRunChainRows(runIds) {
        queries += 1;
        expect(runIds).toEqual([firstRun, secondRun]);
        return { rows, unreadableRunIds: [] };
      },
    };
    try {
      mkdirSync(directory, { recursive: true });
      for (const [id, number] of [[firstRun, 1], [secondRun, 2]] as const) {
        writeFileSync(join(directory, `${id}.jsonl`), `${JSON.stringify({ timestamp: '2026-08-17T00:00:00.000Z', runId: id, event: 'merged', data: { number, merged: true } })}\n`, 'utf8');
      }
      const result = queryRunChain({ dir: directory, logStorePath: join(root, 'logs.db'), logStore: store });
      expect(queries).toBe(1);
      expect(result.entries).toEqual([
        expect.objectContaining({ runId: firstRun, fingerprint: 'first request', goalId: 'first-goal', prNumber: 1, hops: { fingerprint: 'connected', goalId: 'connected', runId: 'connected', pr: 'connected', merged: 'connected' } }),
        expect.objectContaining({ runId: secondRun, fingerprint: 'second request', goalId: 'second-goal', prNumber: 2, hops: { fingerprint: 'connected', goalId: 'connected', runId: 'connected', pr: 'connected', merged: 'connected' } }),
      ]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('falls back per run after a batch failure, retaining readable sibling observations and isolating one unreadable run', () => {
    const root = mkdtempSync(join(tmpdir(), 'run-chain-batch-fallback-'));
    const directory = join(root, 'run-ledger');
    const firstRun = runId('d003');
    const unreadableRun = runId('d004');
    const secondRun = runId('d005');
    const row = (id: number, runId: string, goalId: string) => ({
      id, ts: '2026-08-17T00:00:00.000Z', ts_ms: Date.parse('2026-08-17T00:00:00.000Z'), level: 'info', instance: 'test', surface: 'test', category: 'dev-pipeline', event: 'plan', session_id: null, trace_id: null, data: JSON.stringify({ runId, goalId }),
    });
    let queries = 0;
    const store: RunChainLogStore = {
      query: () => { throw new Error('per-run fallback must not run'); },
      queryRunChainRows(runIds) {
        queries += 1;
        expect(runIds).toEqual([firstRun, unreadableRun, secondRun]);
        return { rows: [row(1, firstRun, 'first-goal'), row(2, secondRun, 'second-goal')], unreadableRunIds: [unreadableRun] };
      },
    };
    try {
      mkdirSync(directory, { recursive: true });
      for (const [id, number] of [[firstRun, 3], [unreadableRun, 4], [secondRun, 5]] as const) {
        writeFileSync(join(directory, `${id}.jsonl`), `${JSON.stringify({ timestamp: '2026-08-17T00:00:00.000Z', runId: id, event: 'merged', data: { number, merged: true } })}\n`, 'utf8');
      }
      const result = queryRunChain({ dir: directory, logStorePath: join(root, 'unreadable.db'), logStore: store });
      expect(queries).toBe(1);
      expect(result.logStoreStatus).toBe('read');
      expect(result.entries).toEqual([
        expect.objectContaining({ runId: firstRun, goalId: 'first-goal', hops: expect.objectContaining({ goalId: 'connected' }) }),
        expect.objectContaining({ runId: unreadableRun, goalId: null, hops: expect.objectContaining({ goalId: 'not-countable' }) }),
        expect.objectContaining({ runId: secondRun, goalId: 'second-goal', hops: expect.objectContaining({ goalId: 'connected' }) }),
      ]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('does not query the log store when the ledger has no observable entries', () => {
    const root = mkdtempSync(join(tmpdir(), 'run-chain-empty-'));
    let queries = 0;
    const store: RunChainLogStore = {
      query: () => { queries += 1; return []; },
      queryRunChainRows: () => { queries += 1; return { rows: [], unreadableRunIds: [] }; },
    };
    try {
      const result = queryRunChain({ dir: join(root, 'empty-ledger'), logStorePath: join(root, 'logs.db'), logStore: store });
      expect(result.entries).toEqual([]);
      expect(queries).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('preserves missing store status without converting it into absent observations', () => {
    const root = mkdtempSync(join(tmpdir(), 'run-chain-batch-status-'));
    const directory = join(root, 'run-ledger');
    const id = runId('d006');
    try {
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, `${id}.jsonl`), `${JSON.stringify({ timestamp: '2026-08-17T00:00:00.000Z', runId: id, event: 'merged', data: { number: 6, merged: true } })}\n`, 'utf8');
      const missing = queryRunChain({ dir: directory, logStorePath: join(root, 'missing.db') });
      expect(missing.logStoreStatus).toBe('missing');
      expect(missing.entries[0]).toMatchObject({ runId: id, hops: { goalId: 'not-countable' } });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('lookupPrGoalAcceptance', () => {
  const runId = (suffix: string) => `run-00000000-0000-4000-8000-00000000${suffix}`;
  const acceptanceBody = '조건 = bun test src/self-implement/run-ledger.test.ts; 관측 = goalLoaded; 기대 = true';

  it('returns the 판정 신호 section for a ledger-backed PR with a non-empty acceptance', () => {
    const root = mkdtempSync(join(tmpdir(), 'pr-goal-acceptance-'));
    const directory = join(root, 'run-ledger');
    const goalsDir = join(root, 'goals');
    const id = runId('a001');
    const prNumber = 14002;
    const goalFile = join(goalsDir, 'GOAL-pr-acceptance-a001-2026-08-29.txt');
    try {
      mkdirSync(directory, { recursive: true });
      mkdirSync(goalsDir, { recursive: true });
      writeFileSync(goalFile, `## Situation\nledger-backed PR\n\n## 판정 신호\n${acceptanceBody}\n`, 'utf8');
      writeFileSync(join(directory, `${id}.jsonl`), [
        JSON.stringify({ timestamp: '2026-08-29T00:00:00.000Z', runId: id, event: 'start', data: { goalFile } }),
        JSON.stringify({ timestamp: '2026-08-29T00:01:00.000Z', runId: id, event: 'merged', data: { number: prNumber, merged: true } }),
      ].join('\n') + '\n', 'utf8');

      const result = lookupPrGoalAcceptance(prNumber, { dir: directory, logStorePath: join(root, 'missing-logs.db') });
      expect(result.goalLoaded).toBe(true);
      expect(result.acceptanceChars).toBeGreaterThan(0);
      expect(result.acceptance).toBe(acceptanceBody);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('treats an absent or manual PR as missing rather than inventing a goal', () => {
    const root = mkdtempSync(join(tmpdir(), 'pr-goal-acceptance-missing-'));
    const directory = join(root, 'run-ledger');
    const goalsDir = join(root, 'goals');
    const id = runId('a002');
    const goalFile = join(goalsDir, 'GOAL-pr-acceptance-a002-2026-08-29.txt');
    try {
      mkdirSync(directory, { recursive: true });
      mkdirSync(goalsDir, { recursive: true });
      writeFileSync(goalFile, `## 판정 신호\n${acceptanceBody}\n`, 'utf8');
      writeFileSync(join(directory, `${id}.jsonl`), [
        JSON.stringify({ timestamp: '2026-08-29T00:00:00.000Z', runId: id, event: 'start', data: { goalFile } }),
        JSON.stringify({ timestamp: '2026-08-29T00:01:00.000Z', runId: id, event: 'merged', data: { number: 14002, merged: true } }),
      ].join('\n') + '\n', 'utf8');

      const result = lookupPrGoalAcceptance(999999, { dir: directory, logStorePath: join(root, 'missing-logs.db') });
      expect(result).toEqual({ goalLoaded: false, acceptanceChars: 0 });
      expect(result).not.toHaveProperty('acceptance');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('fail-softs thrown lookup and goal-document read failures without inventing acceptance', () => {
    const root = mkdtempSync(join(tmpdir(), 'pr-goal-acceptance-fail-'));
    const directory = join(root, 'run-ledger');
    const goalsDir = join(root, 'goals');
    const id = runId('a003');
    const prNumber = 14003;
    const goalFile = join(goalsDir, 'GOAL-pr-acceptance-a003-2026-08-29.txt');
    try {
      mkdirSync(directory, { recursive: true });
      mkdirSync(goalsDir, { recursive: true });
      writeFileSync(goalFile, `## 판정 신호\n${acceptanceBody}\n`, 'utf8');
      writeFileSync(join(directory, `${id}.jsonl`), [
        JSON.stringify({ timestamp: '2026-08-29T00:00:00.000Z', runId: id, event: 'start', data: { goalFile } }),
        JSON.stringify({ timestamp: '2026-08-29T00:01:00.000Z', runId: id, event: 'merged', data: { number: prNumber, merged: true } }),
      ].join('\n') + '\n', 'utf8');

      const throwingList = (): string[] => { throw new Error('ledger lookup failed'); };
      expect(() => lookupPrGoalAcceptance(prNumber, { dir: directory, logStorePath: join(root, 'missing-logs.db'), list: throwingList })).not.toThrow();
      expect(lookupPrGoalAcceptance(prNumber, { dir: directory, logStorePath: join(root, 'missing-logs.db'), list: throwingList }))
        .toEqual({ goalLoaded: false, acceptanceChars: 0 });

      const read: RunLedgerReader = (path, encoding) => {
        if (path === goalFile) throw new Error('goal document unreadable');
        return readFileSync(path, encoding);
      };
      expect(() => lookupPrGoalAcceptance(prNumber, { dir: directory, logStorePath: join(root, 'missing-logs.db'), read })).not.toThrow();
      const unread = lookupPrGoalAcceptance(prNumber, { dir: directory, logStorePath: join(root, 'missing-logs.db'), read });
      expect(unread).toEqual({ goalLoaded: false, acceptanceChars: 0 });
      expect(unread).not.toHaveProperty('acceptance');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('mission timeline run-ledger projection', () => {
  const directories: string[] = [];
  const runId = (suffix: string) => `run-00000000-0000-4000-8000-00000000${suffix}`;

  it('projects only a single matching goalId and fixes each shard at its first execution event', () => {
    const directory = mkdtempSync(join(tmpdir(), 'run-ledger-timeline-'));
    directories.push(directory);
    const first = runId('0201');
    const second = runId('0202');
    const otherMission = runId('0203');
    const ambiguous = runId('0204');
    appendRunLedgerEntry({ timestamp: '2026-08-16T09:00:00.000Z', runId: first, event: 'pipeline-node-entry', goalId: 'apm-mission', orchestrationId: 'orch-1', shardId: 'one', pieceIndex: 0, pieceTotal: 2, data: {} }, directory);
    appendRunLedgerEntry({ timestamp: '2026-08-16T10:00:00.000Z', runId: first, event: 'start', goalId: 'apm-mission', orchestrationId: 'orch-1', shardId: 'one', pieceIndex: 0, pieceTotal: 2, data: {} }, directory);
    appendRunLedgerEntry({ timestamp: '2026-08-16T12:00:00.000Z', runId: first, event: 'reviewed', goalId: 'apm-mission', orchestrationId: 'orch-1', shardId: 'one', pieceIndex: 0, pieceTotal: 2, data: {} }, directory);
    appendRunLedgerEntry({ timestamp: '2026-08-16T11:00:00.000Z', runId: second, event: 'start', goalId: 'apm-mission', orchestrationId: 'orch-1', shardId: 'two', pieceIndex: 1, pieceTotal: 2, data: {} }, directory);
    appendRunLedgerEntry({ timestamp: '2026-08-16T09:00:00.000Z', runId: otherMission, event: 'start', goalId: 'apm-other', data: {} }, directory);
    appendRunLedgerEntry({ timestamp: '2026-08-16T08:00:00.000Z', runId: ambiguous, event: 'start', goalId: 'apm-mission', data: {} }, directory);
    appendRunLedgerEntry({ timestamp: '2026-08-16T08:30:00.000Z', runId: ambiguous, event: 'rework', goalId: 'apm-other', data: {} }, directory);

    expect(queryRunLedgerTimeline('apm-mission', { dir: directory })).toEqual([
      expect.objectContaining({ runId: first, executedAt: '2026-08-16T10:00:00.000Z', pieceIndex: 0 }),
      expect.objectContaining({ runId: second, executedAt: '2026-08-16T11:00:00.000Z', pieceIndex: 1 }),
    ]);
    expect(queryRunLedgerTimeline('orch-1', { dir: directory })).toEqual([]);
    expect(queryRunLedgerTimeline('apm-other', { dir: directory })).toEqual([
      expect.objectContaining({ runId: otherMission, executedAt: '2026-08-16T09:00:00.000Z' }),
    ]);
  });

  it('skips missing, malformed, and timestamp-less candidate ledgers', () => {
    const directory = mkdtempSync(join(tmpdir(), 'run-ledger-timeline-boundary-'));
    directories.push(directory);
    const malformed = runId('0205');
    const timestampLess = runId('0206');
    writeFileSync(join(directory, `${malformed}.jsonl`), '{broken}\n', 'utf8');
    appendRunLedgerEntry({ runId: timestampLess, event: 'start', goalId: 'apm-mission', data: {} }, directory);

    expect(queryRunLedgerTimeline('apm-mission', { dir: directory })).toEqual([]);
  });

  afterAll(() => {
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  });
});

describe('human run ledger round summaries', () => {
  const runId = 'run-00000000-0000-4000-8000-000000000777';
  const entry = (event: string, data: Record<string, unknown>): RunLedgerEntry => ({ runId, event, data });

  it('renders ordered rounds, separates blocking ids, preserves repeated overlap states, and uses recorded submission counts', () => {
    const entries = [
      entry('reviewed', { round: 2, mustFix: 1, shouldFix: 1, findingIds: ['MF-repeat', 'SF-only'] }),
      entry('refute-submitted', { round: 2, refutableCount: 1, submittedCount: 7, findingIds: ['MF-repeat'] }),
      entry('rework-budget', { round: 2, verdict: 'UNCONVERGEABLE', effectiveMaxBefore: 2, effectiveMaxAfter: 1, repeatedBlockingFindingCount: 1, repeatedBlockingFindingIds: ['MF-repeat'] }),
      entry('reviewed', { round: 1, mustFix: 2, shouldFix: 1, findingIds: ['MF-first', 'MF-second', 'SF-old'] }),
      entry('refute-not-submitted', { round: 1, refutableCount: 2, submittedCount: 0 }),
      entry('rework-budget', { round: 1, verdict: 'CONTINUE', effectiveMaxBefore: 3, effectiveMaxAfter: 2, repeatedBlockingFindingCount: null, repeatedBlockingFindingIds: null }),
      entry('reviewed', { round: 3, mustFix: 0, shouldFix: 1, findingIds: ['SF-alone'] }),
      entry('rework-budget', { round: 3, verdict: null, effectiveMaxBefore: 1, effectiveMaxAfter: 1, repeatedBlockingFindingCount: 0, repeatedBlockingFindingIds: [] }),
    ];

    expect(summarizeRunLedgerRounds(entries)).toEqual([
      expect.objectContaining({ round: 1, blocking: 2, findingIds: 'recorded', repeated: 'unknown', refutable: 2, submitted: 0, citedReviewSymbolRepeatCount: null, citedReviewSymbolBaseNameRepeatCount: null, reviewFindingComparableCount: null, reviewFindingKeyRepeatCount: null, recurrenceDisagreementKind: null }),
      expect.objectContaining({ round: 2, blocking: 1, findingIds: 'recorded', repeated: 1, refutable: 1, submitted: 7, citedReviewSymbolRepeatCount: null, citedReviewSymbolBaseNameRepeatCount: null, reviewFindingComparableCount: null, reviewFindingKeyRepeatCount: null, recurrenceDisagreementKind: null }),
      expect.objectContaining({ round: 3, blocking: 0, findingIds: 'recorded', repeated: 'none', citedReviewSymbolRepeatCount: null, citedReviewSymbolBaseNameRepeatCount: null, reviewFindingComparableCount: null, reviewFindingKeyRepeatCount: null, recurrenceDisagreementKind: null }),
    ]);
    const rendered = renderRunLedger(entries);
    expect(rendered).toContain('rework-summary round=1 blocking=2 repeated=unknown findingIds=recorded budget=3->2 verdict=CONTINUE refutations=eligible:2,submitted:0 symbolRepeat=incomparable symbolBaseRepeat=incomparable keyRepeat=incomparable comparable=absent disagreement=absent');
    expect(rendered).toContain('rework-summary round=2 blocking=1 repeated=1 findingIds=recorded budget=2->1 verdict=UNCONVERGEABLE refutations=eligible:1,submitted:7 symbolRepeat=incomparable symbolBaseRepeat=incomparable keyRepeat=incomparable comparable=absent disagreement=absent');
    expect(rendered).toContain('rework-summary round=3 blocking=0 repeated=none findingIds=recorded budget=1->1 verdict=none refutations=eligible:absent,submitted:absent symbolRepeat=incomparable symbolBaseRepeat=incomparable keyRepeat=incomparable comparable=absent disagreement=absent');
    expect(rendered.indexOf('rework-summary round=1')).toBeLessThan(rendered.indexOf('rework-summary round=2'));
    expect(rendered).toContain('"findingIds":["MF-repeat","SF-only"]');
    expect(rendered).not.toContain('MF-repeat\n');
  });

  it('adds a measured-none marker without round rows for a run without rework', () => {
    const rendered = renderRunLedger([entry('start', { feature: 'no rework' })]);
    expect(rendered).toContain('start runId=' + runId);
    expect(rendered).toContain('rework-summary measured=none');
    expect(rendered).not.toContain('rework-summary round=');
  });

  it('renders legacy records without finding identifiers as absent rather than zero', () => {
    const rendered = renderRunLedger([
      entry('reviewed', { round: 1, mustFix: 3, shouldFix: 0 }),
      entry('rework-budget', { round: 1, verdict: 'CONTINUE', effectiveMaxBefore: 2, effectiveMaxAfter: 1, repeatedBlockingFindingCount: null }),
    ]);
    expect(rendered).toContain('rework-summary round=1 blocking=3 repeated=unknown findingIds=absent budget=2->1 verdict=CONTINUE refutations=eligible:absent,submitted:absent symbolRepeat=incomparable symbolBaseRepeat=incomparable keyRepeat=incomparable comparable=absent disagreement=absent');
  });

  it('keeps repeated=none while showing live symbol-repeat and comparable counts on the same line', () => {
    const rendered = renderRunLedger([
      entry('rework-budget', {
        round: 1,
        verdict: 'CONTINUE',
        effectiveMaxBefore: 3,
        effectiveMaxAfter: 2,
        repeatedBlockingFindingCount: 0,
        citedReviewSymbolRepeatCount: 2,
        citedReviewSymbolBaseNameRepeatCount: 1,
        reviewFindingComparableCount: 3,
        reviewFindingKeyRepeatCount: 2,
        recurrenceDisagreementKind: 'symbol-repeat-without-blocking-repeat',
      }),
    ]);
    expect(rendered).toContain('rework-summary round=1 blocking=absent repeated=none findingIds=absent budget=3->2 verdict=CONTINUE refutations=eligible:absent,submitted:absent symbolRepeat=2 symbolBaseRepeat=1 keyRepeat=2 comparable=3 disagreement=symbol-repeat-without-blocking-repeat');
    expect(rendered).toMatch(/rework-summary round=1 .*repeated=none.*symbolRepeat=2.*keyRepeat=2.*comparable=3/);
  });

  it('shows measured symbol-repeat 0 only when comparable findings exist, and keeps unmeasured disagreement off the incomparable alphabet', () => {
    const missingComparable = renderRunLedger([
      entry('rework-budget', {
        round: 1,
        verdict: 'CONTINUE',
        effectiveMaxBefore: 2,
        effectiveMaxAfter: 1,
        repeatedBlockingFindingCount: 0,
      }),
    ]);
    const measuredZero = renderRunLedger([
      entry('rework-budget', {
        round: 2,
        verdict: 'CONTINUE',
        effectiveMaxBefore: 2,
        effectiveMaxAfter: 1,
        repeatedBlockingFindingCount: 0,
        citedReviewSymbolRepeatCount: 0,
        citedReviewSymbolBaseNameRepeatCount: 0,
        reviewFindingComparableCount: 3,
        reviewFindingKeyRepeatCount: 0,
        recurrenceDisagreementKind: 'none',
      }),
    ]);
    const unmeasured = renderRunLedger([
      entry('rework-budget', {
        round: 3,
        verdict: 'CONTINUE',
        effectiveMaxBefore: 2,
        effectiveMaxAfter: 1,
        repeatedBlockingFindingCount: 0,
        citedReviewSymbolRepeatCount: 0,
        citedReviewSymbolBaseNameRepeatCount: 0,
        reviewFindingComparableCount: 0,
        recurrenceDisagreementKind: 'unmeasured',
      }),
    ]);

    expect(missingComparable).toContain('rework-summary round=1 blocking=absent repeated=none findingIds=absent budget=2->1 verdict=CONTINUE refutations=eligible:absent,submitted:absent symbolRepeat=incomparable symbolBaseRepeat=incomparable keyRepeat=incomparable comparable=absent disagreement=absent');
    expect(missingComparable).not.toMatch(/rework-summary round=1 .*keyRepeat=\d/);
    expect(missingComparable).not.toMatch(/rework-summary round=1 .*symbolRepeat=\d/);
    expect(measuredZero).toContain('rework-summary round=2 blocking=absent repeated=none findingIds=absent budget=2->1 verdict=CONTINUE refutations=eligible:absent,submitted:absent symbolRepeat=0 symbolBaseRepeat=0 keyRepeat=0 comparable=3 disagreement=none');
    expect(unmeasured).toContain('rework-summary round=3 blocking=absent repeated=none findingIds=absent budget=2->1 verdict=CONTINUE refutations=eligible:absent,submitted:absent symbolRepeat=incomparable symbolBaseRepeat=incomparable keyRepeat=incomparable comparable=incomparable disagreement=unmeasured');
    expect(unmeasured).not.toMatch(/rework-summary round=3 .*keyRepeat=\d/);
    expect(unmeasured).not.toMatch(/rework-summary round=3 .*symbolRepeat=\d/);
    expect(unmeasured).toContain('comparable=incomparable');
    expect(unmeasured).toContain('disagreement=unmeasured');
    expect(missingComparable).not.toContain('disagreement=unmeasured');
    expect(measuredZero).not.toContain('symbolRepeat=incomparable');
    expect(measuredZero).not.toContain('keyRepeat=incomparable');
    expect(measuredZero).not.toContain('disagreement=unmeasured');
  });
});

describe('federated run ledger lookup', () => {
  const directories: string[] = [];

  function ledgerTarget(stateDir: string) {
    return { name: `test:${stateDir}`, dbPath: join(stateDir, 'logs', 'logs.db') };
  }

  function writeLedger(directory: string, runId: string): void {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${runId}.jsonl`), `${JSON.stringify({ runId, event: 'start', data: {} })}\n`, 'utf8');
  }

  function temporaryStateDir(): string {
    const directory = mkdtempSync(join(tmpdir(), 'federated-run-ledger-'));
    directories.push(directory);
    return directory;
  }

  it('finds a ledger present only in the second shared candidate directory', () => {
    const firstStateDir = temporaryStateDir();
    const secondStateDir = temporaryStateDir();
    const runId = 'run-00000000-0000-4000-8000-000000000101';
    writeLedger(runLedgerDir(secondStateDir), runId);

    expect(loadFederatedRunLedger(runId, { targets: [ledgerTarget(firstStateDir), ledgerTarget(secondStateDir)] }))
      .toEqual([expect.objectContaining({ runId, event: 'start' })]);
  });

  it('classifies only confirmed missing and access errors, retaining unknown failures as indeterminate', () => {
    expect(classifyFederatedLedgerDirectoryReadFailure({ code: 'ENOENT' })).toBe('missing');
    expect(classifyFederatedLedgerDirectoryReadFailure({ code: 'EACCES' })).toBe('unreadable');
    expect(classifyFederatedLedgerDirectoryReadFailure({ code: 'EPERM' })).toBe('unreadable');
    expect(classifyFederatedLedgerDirectoryReadFailure({ code: 'EIO' })).toBe('indeterminate');
    expect(classifyFederatedLedgerDirectoryReadFailure(new Error('no errno'))).toBe('indeterminate');
  });

  it('keeps the no-argument loader scoped to its existing default directory', () => {
    const runId = 'run-00000000-0000-4000-8000-000000000102';
    const defaultPath = join(runLedgerDir(), `${runId}.jsonl`);
    const read: RunLedgerReader = (path) => {
      expect(path).toBe(defaultPath);
      return JSON.stringify({ runId, event: 'start', data: {} });
    };

    expect(loadRunLedger(runId, undefined, read)).toEqual([expect.objectContaining({ runId })]);
  });

  it('skips only an invalid non-newline trailing fragment and reports its source byte count', () => {
    const runId = 'run-00000000-0000-4000-8000-000000000104';
    const completeEntry = Buffer.from(`${JSON.stringify({ runId, event: 'start', data: {} })}\n`, 'utf8');
    const trailingFragment = Buffer.from('{"runId":"incomplete-한글"', 'utf8').subarray(0, -1);
    const loaded = loadRunLedgerWithMetadata(runId, undefined, () => Buffer.concat([completeEntry, trailingFragment]));

    expect(loaded).toEqual({
      entries: [{ runId, event: 'start', data: {} }],
      skippedTrailingBytes: trailingFragment.length,
    });
  });

  it('keeps a complete non-newline final record and rejects invalid final records', () => {
    const runId = 'run-00000000-0000-4000-8000-000000000105';
    const completeEntry = JSON.stringify({ runId, event: 'start', data: {} });
    const finalEntry = JSON.stringify({ runId, event: 'finish', data: {} });

    expect(loadRunLedgerWithMetadata(runId, undefined, () => `${completeEntry}\n${finalEntry}`)).toEqual({
      entries: [{ runId, event: 'start', data: {} }, { runId, event: 'finish', data: {} }],
    });
    expect(() => loadRunLedgerWithMetadata(runId, undefined, () => `${completeEntry}\n${JSON.stringify({ runId: 'wrong-run', event: 'finish', data: {} })}`))
      .toThrow(`runId does not match ${runId}`);
    expect(() => loadRunLedgerWithMetadata(runId, undefined, () => `${completeEntry}\n${JSON.stringify({ runId, event: 'finish', data: [] })}`))
      .toThrow('invalid run ledger entry at line 2');
    expect(() => loadRunLedgerWithMetadata(runId, undefined, () => `${completeEntry}\n{broken}`))
      .toThrow('invalid run ledger JSON at line 2');
    expect(() => loadRunLedgerWithMetadata(runId, undefined, () => `${completeEntry}\n{\"runId\":!}`))
      .toThrow('invalid run ledger JSON at line 2');
    expect(() => loadRunLedgerWithMetadata(runId, undefined, () => `${completeEntry}\n{broken}\n`))
      .toThrow('invalid run ledger JSON at line 2');
  });

  it('reports every federated ledger and checkpoint path when absent', () => {
    const firstStateDir = temporaryStateDir();
    const secondStateDir = temporaryStateDir();
    const runId = 'run-00000000-0000-4000-8000-000000000103';
    const missing = describeFederatedMissingRunLedger(runId, {
      targets: [ledgerTarget(firstStateDir), ledgerTarget(secondStateDir)],
    });

    expect(missing.checkedPaths).toEqual([
      join(firstStateDir, 'run-ledger', `${runId}.jsonl`),
      join(secondStateDir, 'run-ledger', `${runId}.jsonl`),
      join(firstStateDir, 'self-dev-runs', `${runId}.json`),
      join(secondStateDir, 'self-dev-runs', `${runId}.json`),
    ]);
  });

  it('stops checkpoint inspection and records only checkpoint paths actually inspected after the first match', () => {
    const firstStateDir = temporaryStateDir();
    const secondStateDir = temporaryStateDir();
    const runId = 'run-00000000-0000-4000-8000-000000000104';
    const inspectedDirectories: string[] = [];
    const missing = describeFederatedMissingRunLedger(runId, {
      targets: [ledgerTarget(firstStateDir), ledgerTarget(secondStateDir)],
      loadCheckpoint: (_id, directory) => {
        inspectedDirectories.push(directory);
        return directory === join(firstStateDir, 'self-dev-runs');
      },
    });

    expect(inspectedDirectories).toEqual([join(firstStateDir, 'self-dev-runs')]);
    expect(missing.checkedPaths).toEqual([
      join(firstStateDir, 'run-ledger', `${runId}.jsonl`),
      join(secondStateDir, 'run-ledger', `${runId}.jsonl`),
      join(firstStateDir, 'self-dev-runs', `${runId}.json`),
    ]);
    expect(missing.selfDevRunFound).toBe(true);
  });

  it('renders three checked ledger directories with zero unreadable directories', () => {
    const stateDirectories = [temporaryStateDir(), temporaryStateDir(), temporaryStateDir()];
    for (const stateDirectory of stateDirectories) mkdirSync(runLedgerDir(stateDirectory), { recursive: true });

    const rendered = renderUnfinishedRunLedgers(queryFederatedUnfinishedRunLedgers({
      goalsDir: stateDirectories[0],
      targets: stateDirectories.map(ledgerTarget),
    }));

    expect(rendered).toContain('ledger directories checked: 3; unreadable ledger directories: 0');
  });

  it('renders three checked ledger directories with one unreadable directory', () => {
    const readableStateDirectories = [temporaryStateDir(), temporaryStateDir()];
    const missingStateDirectory = temporaryStateDir();
    for (const stateDirectory of readableStateDirectories) mkdirSync(runLedgerDir(stateDirectory), { recursive: true });

    const rendered = renderUnfinishedRunLedgers(queryFederatedUnfinishedRunLedgers({
      goalsDir: readableStateDirectories[0],
      targets: [...readableStateDirectories, missingStateDirectory].map(ledgerTarget),
    }));

    expect(rendered).toContain('ledger directories checked: 3; unreadable ledger directories: 1');
  });

  it('renders checked ledger directory counts when the federated result is empty', () => {
    const rendered = renderUnfinishedRunLedgers(queryFederatedUnfinishedRunLedgers({ targets: [] }));

    expect(rendered).toContain('ledger directories checked: 0; unreadable ledger directories: 0');
    expect(rendered).toContain('unfinished runs: 0');
  });

  it('keeps ledger-directory counts scoped to federated results', () => {
    const missingStateDirectory = temporaryStateDir();

    const rendered = renderUnfinishedRunLedgers(queryUnfinishedRunLedgers({ dir: runLedgerDir(missingStateDirectory) }));

    expect(rendered).toContain('ledger directory status: missing (no run ledgers were scanned)');
    expect(rendered).not.toContain('ledger directories checked:');
    expect(rendered).not.toContain('unreadable ledger directories:');
  });

  it('reads only the requested unfinished ledger when runIds names one of three', () => {
    const stateDir = temporaryStateDir();
    const directory = runLedgerDir(stateDir);
    const runA = 'run-00000000-0000-4000-8000-0000000000a1';
    const runB = 'run-00000000-0000-4000-8000-0000000000b2';
    const runC = 'run-00000000-0000-4000-8000-0000000000c3';
    for (const runId of [runA, runB, runC]) writeLedger(directory, runId);

    const narrowed = queryFederatedUnfinishedRunLedgers({ goalsDir: stateDir, ledgerDirectories: [directory], runIds: [runA] });
    const full = queryFederatedUnfinishedRunLedgers({ goalsDir: stateDir, ledgerDirectories: [directory] });

    expect(narrowed.entries.map((entry) => entry.runId)).toEqual([runA]);
    expect(full.entries.map((entry) => entry.runId)).toEqual([runA, runB, runC]);
  });

  it('counts missing, unreadable, and indeterminate candidates separately while preserving their total and readable entry order', () => {
    const missingStateDir = temporaryStateDir();
    const unreadableStateDir = temporaryStateDir();
    const indeterminateStateDir = temporaryStateDir();
    const readableStateDir = temporaryStateDir();
    const firstRunId = 'run-00000000-0000-4000-8000-000000000105';
    const secondRunId = 'run-00000000-0000-4000-8000-000000000106';
    writeLedger(runLedgerDir(readableStateDir), secondRunId);
    writeLedger(runLedgerDir(readableStateDir), firstRunId);
    const unreadableDirectory = runLedgerDir(unreadableStateDir);
    const indeterminateDirectory = runLedgerDir(indeterminateStateDir);
    const result = queryFederatedUnfinishedRunLedgers({
      goalsDir: readableStateDir,
      targets: [ledgerTarget(missingStateDir), ledgerTarget(unreadableStateDir), ledgerTarget(indeterminateStateDir), ledgerTarget(readableStateDir)],
      list: (directory) => {
        if (directory === unreadableDirectory) throw Object.assign(new Error('denied'), { code: 'EACCES' });
        if (directory === indeterminateDirectory) throw Object.assign(new Error('io failure'), { code: 'EIO' });
        return directory === runLedgerDir(missingStateDir) ? (() => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); })() : ['ignore.txt', `${secondRunId}.jsonl`, `${firstRunId}.jsonl`];
      },
    });

    expect(result).toMatchObject({
      missingLedgerDirectoryCount: 1,
      unreadableLedgerDirectoryAccessCount: 1,
      indeterminateLedgerDirectoryCount: 1,
      unreadableLedgerDirectoryCount: 3,
    });
    expect(result.unreadableLedgerDirectoryCount).toBe(
      result.missingLedgerDirectoryCount + result.unreadableLedgerDirectoryAccessCount + result.indeterminateLedgerDirectoryCount,
    );
    expect(result.entries.map((entry) => entry.runId)).toEqual([firstRunId, secondRunId]);
    expect(renderUnfinishedRunLedgers(result)).toContain('ledger directories checked: 4; unreadable ledger directories: 3\nledger directory:');
    expect(renderUnfinishedRunLedgers(result)).toContain('missing ledger directories: 1\nunreadable ledger directory access: 1\nindeterminate ledger directories: 1');
  });

  afterAll(() => {
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  });
});

describe('federated run screen lookup', () => {
  const runId = 'run-00000000-0000-4000-8000-000000000201';
  const currentPath = '/fixture/current/logs.db';
  const childPath = '/fixture/child/logs.db';
  const unavailablePath = '/fixture/unavailable/logs.db';
  const row = (id: number, ts: string, category: string, event: string, data: Record<string, unknown>) => ({ id, ts, ts_ms: 0, level: 'info', instance: 'test', surface: 'test', category, event, session_id: null, trace_id: null, data: JSON.stringify(data) });
  const store = (rows: ReturnType<typeof row>[]): RunChainLogStore => ({ query: () => rows });
  const options = (stores: Record<string, RunChainLogStore>, targets = [{ name: 'child', dbPath: childPath }]) => ({
    logTargets: targets,
    openLogStore: (path: string) => path === unavailablePath
      ? { status: 'unreadable' as const }
      : { store: stores[path] ?? stores[currentPath], status: (stores[path] ?? stores[currentPath]) ? 'read' as const : 'missing' as const },
  });

  it('finds a screen recorded only in a different universe before its parent terminal event can mislead the caller', () => {
    const result = queryRunScreenKey(runId, options({
      [currentPath]: store([row(1, '2026-08-15T00:02:00.000Z', 'dev-pipeline', 'done', { runId })]),
      [childPath]: store([row(1, '2026-08-15T00:01:00.000Z', 'self-implement', 'headless.spawn', { runId, screenKey: 'child-live-screen' })]),
    }));
    expect(result).toMatchObject({ screenKey: 'child-live-screen', matchedSpawnCount: 1, logStoreStatus: 'read' });
  });

  it('keeps an explicit store path strictly single-store', () => {
    const opened: string[] = [];
    const result = queryRunScreenKey(runId, {
      logStorePath: currentPath,
      logTargets: [{ name: 'child', dbPath: childPath }],
      openLogStore: (path) => {
        opened.push(path);
        return { store: store([]), status: 'read' as const };
      },
    });
    expect(opened).toEqual([currentPath]);
    expect(result.screenKey).toBeNull();
  });

  it('selects the newest matching screen across universes using the existing timestamp rule', () => {
    const result = queryRunScreenKey(runId, options({
      [currentPath]: store([row(9, '2026-08-15T00:01:00.000Z', 'self-implement', 'headless.spawn', { runId, screenKey: 'parent-old' })]),
      [childPath]: store([row(1, '2026-08-15T00:02:00.000Z', 'self-implement', 'headless.spawn', { runId, screenKey: 'child-new' })]),
    }));
    expect(result).toMatchObject({ screenKey: 'child-new', matchedSpawnCount: 2 });
  });

  it('preserves unreadable universe evidence instead of folding it into no record', () => {
    const result = queryRunScreenKey(runId, options({ [currentPath]: store([]) }, [
      { name: 'current-duplicate', dbPath: currentPath },
      { name: 'unavailable', dbPath: unavailablePath },
    ]));
    expect(result).toMatchObject({ screenKey: null, logStoreStatus: 'read', unreadableLogStoreCount: 1 });
    expect(result.logStoreStatuses).toContainEqual({ path: unavailablePath, status: 'unreadable' });
  });

  it('chooses the latest run event from every readable universe when no screen exists', () => {
    const result = queryRunScreenKey(runId, options({
      [currentPath]: store([row(1, '2026-08-15T00:01:00.000Z', 'self-implement', 'start', { runId })]),
      [childPath]: store([row(2, '2026-08-15T00:03:00.000Z', 'dev-pipeline', 'error', { runId })]),
    }));
    expect(result).toMatchObject({ screenKey: null, lastEvent: { category: 'dev-pipeline', event: 'error', timestamp: '2026-08-15T00:03:00.000Z' } });
  });
});

describe('interrupted run ledger queries', () => {
  const directories: string[] = [];
  const runId = (suffix: string) => `run-00000000-0000-4000-8000-00000000${suffix}`;
  const directory = (): string => {
    const value = mkdtempSync(join(tmpdir(), 'run-ledger-interrupted-'));
    directories.push(value);
    return value;
  };
  const write = (dir: string, id: string, entries: readonly Omit<RunLedgerEntry, 'runId'>[]): void => {
    writeFileSync(join(dir, `${id}.jsonl`), entries.map((entry) => JSON.stringify({ ...entry, runId: id })).join('\n'), 'utf8');
  };

  it('returns only interrupted terminal runs with their recorded reason, round, repair instructions, and decomposition context in run-id order', () => {
    const dir = directory();
    const later = runId('0202');
    const earlier = runId('0201');
    write(dir, later, [
      { timestamp: '2026-08-17T00:02:00.000Z', event: 'rework-budget', data: { round: 4, verdict: 'UNCONVERGEABLE', reason: 'same blocking finding repeated' } },
      { timestamp: '2026-08-17T00:03:00.000Z', event: 'rework-blocked-draft-pr', data: { undeliveredSupervisorInputs: [{ text: 'split the dependency chain', reason: 'supervisor-rework-blocked' }] } },
      { timestamp: '2026-08-17T00:04:00.000Z', event: 'decomposition-shadow-goals', data: { round: 4, pieceCount: 2, pieces: [{ id: 'one' }, { id: 'two' }] } },
      { timestamp: '2026-08-17T00:05:00.000Z', event: 'run-status', data: { stage: 'aborted', runStatus: 'failed' } },
    ]);
    write(dir, earlier, [
      { timestamp: '2026-08-17T00:01:00.000Z', event: 'rework-budget', data: { round: 2, verdict: 'UNCONVERGEABLE', reason: 'budget exhausted' } },
      { timestamp: '2026-08-17T00:02:00.000Z', event: 'run-status', data: { stage: 'gate-failed', runStatus: 'failed' } },
    ]);
    write(dir, runId('0203'), [{ timestamp: '2026-08-17T00:01:00.000Z', event: 'run-status', data: { stage: 'merged', runStatus: 'completed' } }]);
    write(dir, runId('0207'), [
      { timestamp: '2026-08-17T00:01:00.000Z', event: 'rework-budget', data: { round: 1, verdict: 'CONTINUE', reason: 'another review round is available' } },
      { timestamp: '2026-08-17T00:02:00.000Z', event: 'run-status', data: { stage: 'gate-failed', runStatus: 'failed' } },
    ]);
    write(dir, runId('0208'), [
      { timestamp: '2026-08-17T00:01:00.000Z', event: 'rework-budget', data: { round: 1, verdict: 'UNCONVERGEABLE', reason: 'still running' } },
      { timestamp: '2026-08-17T00:02:00.000Z', event: 'run-status', data: { stage: 'gate', runStatus: 'running' } },
    ]);

    const result = queryInterruptedRunLedgers({ dir });
    expect(result.entries.map((entry) => entry.runId)).toEqual([earlier, later]);
    expect(result.entries.map((entry) => entry.runId)).not.toEqual(expect.arrayContaining([runId('0203'), runId('0207'), runId('0208')]));
    expect(result.entries[1]).toMatchObject({ status: 'interrupted', interruptionVerdict: 'UNCONVERGEABLE', interruptionReason: 'same blocking finding repeated', reworkRound: 4 });
    expect(result.entries[1]?.undeliveredSupervisorRepairEntries).toHaveLength(1);
    expect(result.entries[1]?.decompositionEntries).toHaveLength(1);
    expect(result.unreadableLedgerCount).toBe(0);
  });

  it('counts only actual non-empty undelivered supervisor lists, once per recorded ledger entry', () => {
    const dir = directory();
    const undelivered = runId('0211');
    const delivered = runId('0212');
    const malformed = runId('0213');
    const interrupted = (data: Record<string, unknown>): readonly Omit<RunLedgerEntry, 'runId'>[] => [
      { timestamp: '2026-08-17T00:01:00.000Z', event: 'rework-budget', data: { verdict: 'UNCONVERGEABLE' } },
      { timestamp: '2026-08-17T00:02:00.000Z', event: 'rework-blocked-draft-pr', data },
      { timestamp: '2026-08-17T00:03:00.000Z', event: 'run-status', data: { runStatus: 'failed' } },
    ];
    write(dir, undelivered, interrupted({ undeliveredSupervisorInputs: [
      { text: 'repair dependency', reason: 'rework-round-limit' },
      { text: 'repair dependency', reason: 'rework-round-limit' },
    ] }));
    write(dir, delivered, interrupted({ undeliveredSupervisorInputs: [] }));
    write(dir, malformed, interrupted({ undeliveredSupervisorInputs: [{ text: '', reason: 'missing instruction' }, 'not-an-input'] }));

    const entries = queryInterruptedRunLedgers({ dir }).entries;
    expect(entries.find((entry) => entry.runId === undelivered)?.undeliveredSupervisorRepairEntries).toHaveLength(1);
    expect(entries.find((entry) => entry.runId === delivered)?.undeliveredSupervisorRepairEntries).toEqual([]);
    expect(entries.find((entry) => entry.runId === malformed)?.undeliveredSupervisorRepairEntries).toEqual([]);
  });

  it('preserves terminal interruption candidates with missing verdict as unknown and distinguishes unreadable ledgers from an empty result', () => {
    const dir = directory();
    const unknown = runId('0204');
    const missingReworkBudget = runId('0209');
    const unusableVerdict = runId('0210');
    const unreadable = runId('0205');
    write(dir, unknown, [{ timestamp: '2026-08-17T00:01:00.000Z', event: 'rework-budget', data: { round: 1, verdict: null } }, { timestamp: '2026-08-17T00:02:00.000Z', event: 'run-status', data: { stage: 'gate-failed', runStatus: 'failed' } }]);
    write(dir, missingReworkBudget, [{ timestamp: '2026-08-17T00:02:00.000Z', event: 'run-status', data: { stage: 'gate-failed', runStatus: 'failed' } }]);
    write(dir, unusableVerdict, [{ timestamp: '2026-08-17T00:01:00.000Z', event: 'rework-budget', data: { round: 5, verdict: 'DAMAGED', reason: 'unsupported producer value' } }, { timestamp: '2026-08-17T00:02:00.000Z', event: 'run-status', data: { stage: 'gate-failed', runStatus: 'failed' } }]);
    write(dir, unreadable, [{ timestamp: '2026-08-17T00:01:00.000Z', event: 'run-status', data: { stage: 'review-blocked', runStatus: 'failed' } }]);

    const result = queryInterruptedRunLedgers({ dir, read: (path, encoding) => path.endsWith(`${unreadable}.jsonl`) ? (() => { throw Object.assign(new Error('missing after list'), { code: 'ENOENT' }); })() : readFileSync(path, encoding) });
    expect(result.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: unknown, status: 'interruption-status-unknown', interruptionVerdict: null }),
      expect.objectContaining({ runId: missingReworkBudget, status: 'interruption-status-unknown', interruptionVerdict: null, reworkBudgetEntries: [] }),
      expect.objectContaining({ runId: unusableVerdict, status: 'interruption-status-unknown', interruptionVerdict: null, interruptionReason: 'unsupported producer value', reworkRound: 5 }),
      expect.objectContaining({ runId: unreadable, status: 'ledger-unreadable' }),
    ]));
    expect(result.unreadableLedgerCount).toBe(1);
    expect(queryInterruptedRunLedgers({ dir: directory() }).entries).toEqual([]);
  });

  it('reuses federated targets and preserves missing directory status', () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'run-ledger-interrupted-state-'));
    directories.push(stateRoot);
    const dir = join(stateRoot, 'run-ledger');
    mkdirSync(dir);
    const id = runId('0206');
    write(dir, id, [
      { timestamp: '2026-08-17T00:01:00.000Z', event: 'rework-budget', data: { round: 1, verdict: 'UNCONVERGEABLE', reason: 'blocked' } },
      { timestamp: '2026-08-17T00:02:00.000Z', event: 'run-status', data: { stage: 'gate-failed', runStatus: 'failed' } },
    ]);
    const result = queryFederatedInterruptedRunLedgers({ targets: [{ name: 'local', dbPath: join(stateRoot, 'mss', 'logs.db') }, { name: 'missing', dbPath: join(tmpdir(), 'interrupted-missing', 'mss', 'logs.db') }] });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ runId: id, ledgerDirectory: dir });
    expect(result.missingLedgerDirectoryCount).toBe(1);
  });

  it('applies a federated limit after ledger-directory and run-id ordering, and returns that limit to consumers', () => {
    const firstStateRoot = mkdtempSync(join(tmpdir(), 'run-ledger-interrupted-limit-a-'));
    const secondStateRoot = mkdtempSync(join(tmpdir(), 'run-ledger-interrupted-limit-b-'));
    directories.push(firstStateRoot, secondStateRoot);
    const firstDirectory = join(firstStateRoot, 'run-ledger');
    const secondDirectory = join(secondStateRoot, 'run-ledger');
    mkdirSync(firstDirectory);
    mkdirSync(secondDirectory);
    const firstId = runId('0301');
    const secondId = runId('0302');
    const interrupted = (runId: string) => [
      { timestamp: '2026-08-17T00:01:00.000Z', event: 'rework-budget', data: { verdict: 'UNCONVERGEABLE', reason: 'bounded' } },
      { timestamp: '2026-08-17T00:02:00.000Z', event: 'run-status', data: { runStatus: 'failed' } },
    ];
    write(firstDirectory, firstId, interrupted(firstId));
    write(secondDirectory, secondId, interrupted(secondId));

    const result = queryFederatedInterruptedRunLedgers({
      targets: [
        { name: 'second', dbPath: join(secondStateRoot, 'mss', 'logs.db') },
        { name: 'first', dbPath: join(firstStateRoot, 'mss', 'logs.db') },
      ],
      limit: 1,
    });
    expect(result.limit).toBe(1);
    expect(result.entries).toEqual([expect.objectContaining({ runId: firstId, ledgerDirectory: firstDirectory })]);
  });

  it('applies its limit within an optional target path scope while preserving unscoped ordering', () => {
    const root = mkdtempSync(join(tmpdir(), 'run-ledger-interrupted-path-scope-'));
    directories.push(root);
    const ledgerDirectory = runLedgerDir(root);
    const goalsDirectory = join(root, 'goals');
    mkdirSync(ledgerDirectory);
    mkdirSync(goalsDirectory);
    const unscopedFirst = runId('0311');
    const scopedSecond = runId('0312');
    const targetPath = 'src/self-implement/run-ledger.ts';
    writeFileSync(join(goalsDirectory, 'scoped.md'), `## TRACED PATHS\n1. ${targetPath} — target\n`, 'utf8');
    writeFileSync(join(goalsDirectory, 'other.md'), '## TRACED PATHS\n1. src/other.ts — target\n', 'utf8');
    const interrupted = (goalFile: string) => [
      { timestamp: '2026-08-17T00:01:00.000Z', event: 'start', data: { goalFile } },
      { timestamp: '2026-08-17T00:02:00.000Z', event: 'rework-budget', data: { verdict: 'UNCONVERGEABLE' } },
      { timestamp: '2026-08-17T00:03:00.000Z', event: 'run-status', data: { runStatus: 'failed' } },
    ];
    write(ledgerDirectory, unscopedFirst, interrupted(join(goalsDirectory, 'other.md')));
    write(ledgerDirectory, scopedSecond, interrupted(join(goalsDirectory, 'scoped.md')));
    const targets = [{ name: 'local', dbPath: join(root, 'mss', 'logs.db') }];
    const unscoped = queryFederatedInterruptedRunLedgers({ targets, limit: 1 });
    const scoped = queryFederatedInterruptedRunLedgers({ targets, limit: 1, path: targetPath });
    expect(unscoped).toMatchObject({ entries: [expect.objectContaining({ runId: unscopedFirst })], limit: 1 });
    expect(scoped).toMatchObject({ entries: [expect.objectContaining({ runId: scopedSecond })], limit: 1, pathFilter: targetPath, matchingPathCount: 1 });
  });

  it('matches every requested path before applying one shared limit', () => {
    const root = mkdtempSync(join(tmpdir(), 'run-ledger-interrupted-multi-path-'));
    directories.push(root);
    const ledgerDirectory = runLedgerDir(root);
    const goalsDirectory = join(root, 'goals');
    mkdirSync(ledgerDirectory);
    mkdirSync(goalsDirectory);
    const first = runId('0314');
    const second = runId('0315');
    const paths = ['src/a.ts', 'src/a.test.ts'];
    const interrupted = (goalFile: string) => [
      { event: 'start', data: { goalFile } },
      { event: 'rework-budget', data: { verdict: 'UNCONVERGEABLE' } },
      { event: 'run-status', data: { runStatus: 'failed' } },
    ];
    const firstGoal = join(goalsDirectory, 'first.md');
    const secondGoal = join(goalsDirectory, 'second.md');
    writeFileSync(firstGoal, `## TRACED PATHS\n1. ${paths[0]} — target\n`, 'utf8');
    writeFileSync(secondGoal, `## TRACED PATHS\n1. ${paths[1]} — target\n`, 'utf8');
    write(ledgerDirectory, first, interrupted(firstGoal));
    write(ledgerDirectory, second, interrupted(secondGoal));

    const result = queryFederatedInterruptedRunLedgers({
      targets: [{ name: 'local', dbPath: join(root, 'mss', 'logs.db') }],
      paths,
      limit: 1,
    });

    expect(result).toMatchObject({
      entries: [expect.objectContaining({ runId: first })],
      limit: 1,
      pathFilters: paths,
      matchingPathCount: 2,
    });
  });

  it('counts an initially null ledger once and excludes it from an interrupted path scope', () => {
    const root = mkdtempSync(join(tmpdir(), 'run-ledger-interrupted-path-null-'));
    directories.push(root);
    const ledgerDirectory = runLedgerDir(root);
    const goalsDirectory = join(root, 'goals');
    mkdirSync(ledgerDirectory);
    mkdirSync(goalsDirectory);
    const id = runId('0313');
    const targetPath = 'src/self-implement/run-ledger.ts';
    const goalFile = join(goalsDirectory, 'scoped.md');
    writeFileSync(goalFile, `## TRACED PATHS\n1. ${targetPath} — target\n`, 'utf8');
    write(ledgerDirectory, id, [
      { event: 'start', data: { goalFile } },
      { event: 'rework-budget', data: { verdict: 'UNCONVERGEABLE' } },
      { event: 'run-status', data: { runStatus: 'failed' } },
    ]);
    let reads = 0;
    const result = queryFederatedInterruptedRunLedgers({
      targets: [{ name: 'local', dbPath: join(root, 'mss', 'logs.db') }],
      path: targetPath,
      read: (path, encoding) => {
        if (path.endsWith(`${id}.jsonl`)) {
          reads += 1;
          throw Object.assign(new Error('missing after list'), { code: 'ENOENT' });
        }
        return readFileSync(path, encoding);
      },
    });
    expect(result).toMatchObject({ entries: [], unreadableLedgerCount: 1, pathFilter: targetPath, matchingPathCount: 0 });
    expect(reads).toBe(1);
  });

  afterAll(() => {
    for (const dir of directories) rmSync(dir, { recursive: true, force: true });
  });
});

describe('completed run ledger queries', () => {
  const directories: string[] = [];
  const runId = (suffix: string) => `run-00000000-0000-4000-8000-00000000${suffix}`;
  const directory = (): string => {
    const value = mkdtempSync(join(tmpdir(), 'run-ledger-completed-'));
    directories.push(value);
    return value;
  };
  const write = (dir: string, id: string, entries: readonly Omit<RunLedgerEntry, 'runId'>[]): void => {
    writeFileSync(join(dir, `${id}.jsonl`), entries.map((entry) => JSON.stringify({ ...entry, runId: id })).join('\n'), 'utf8');
  };

  it('includes only ledgers whose latest valid run-status is completed and keeps unreadable ledgers distinct', () => {
    const dir = directory();
    const completed = runId('0401');
    const laterFailed = runId('0402');
    const cancelled = runId('0403');
    const missingStatus = runId('0404');
    const unreadable = runId('0405');
    write(dir, completed, [{ event: 'run-status', data: { runStatus: 'completed' } }]);
    write(dir, laterFailed, [{ event: 'run-status', data: { runStatus: 'completed' } }, { event: 'run-status', data: { runStatus: 'failed' } }]);
    write(dir, cancelled, [{ event: 'run-status', data: { runStatus: 'cancelled' } }]);
    write(dir, missingStatus, [{ event: 'start', data: {} }]);
    write(dir, unreadable, [{ event: 'run-status', data: { runStatus: 'completed' } }]);

    const result = queryCompletedRunLedgers({ dir, read: (path, encoding) => path.endsWith(`${unreadable}.jsonl`) ? (() => { throw Object.assign(new Error('missing after list'), { code: 'ENOENT' }); })() : readFileSync(path, encoding) });
    expect(result.entries).toEqual([expect.objectContaining({ runId: completed, terminal: expect.objectContaining({ data: { runStatus: 'completed' } }) })]);
    expect(result.unreadableLedgerCount).toBe(1);
    expect(queryCompletedRunLedgers({ dir: directory() })).toMatchObject({ entries: [], unreadableLedgerCount: 0 });
  });

  it('preserves federated ordering, unreadable-directory breakdowns, and query limits', () => {
    const firstRoot = mkdtempSync(join(tmpdir(), 'run-ledger-completed-a-'));
    const secondRoot = mkdtempSync(join(tmpdir(), 'run-ledger-completed-b-'));
    const missingRoot = mkdtempSync(join(tmpdir(), 'run-ledger-completed-missing-'));
    directories.push(firstRoot, secondRoot, missingRoot);
    const firstDirectory = runLedgerDir(firstRoot);
    const secondDirectory = runLedgerDir(secondRoot);
    mkdirSync(firstDirectory);
    mkdirSync(secondDirectory);
    const first = runId('0411');
    const second = runId('0412');
    write(firstDirectory, first, [{ event: 'run-status', data: { runStatus: 'completed' } }]);
    write(secondDirectory, second, [{ event: 'run-status', data: { runStatus: 'completed' } }]);

    const result = queryFederatedCompletedRunLedgers({
      targets: [
        { name: 'second', dbPath: join(secondRoot, 'mss', 'logs.db') },
        { name: 'missing', dbPath: join(missingRoot, 'mss', 'logs.db') },
        { name: 'first', dbPath: join(firstRoot, 'mss', 'logs.db') },
      ],
      limit: 1,
    });
    expect(result.entries).toEqual([expect.objectContaining({ runId: first, ledgerDirectory: firstDirectory })]);
    expect(result.limit).toBe(1);
    expect(result.truncated).toBe(true);
    expect(result.missingLedgerDirectoryCount).toBe(1);
    expect(result.unreadableLedgerDirectoryCount).toBe(1);
    for (const limit of [0, -1, 1.5]) {
      expect(() => queryFederatedCompletedRunLedgers({ targets: [], limit })).toThrow('positive safe integer');
    }
  });

  it('applies its limit within an optional target path scope and keeps scoped truncation semantics', () => {
    const root = mkdtempSync(join(tmpdir(), 'run-ledger-completed-path-scope-'));
    directories.push(root);
    const ledgerDirectory = runLedgerDir(root);
    const goalsDirectory = join(root, 'goals');
    mkdirSync(ledgerDirectory);
    mkdirSync(goalsDirectory);
    const unscopedFirst = runId('0413');
    const scopedSecond = runId('0414');
    const targetPath = 'src/self-implement/run-ledger.ts';
    writeFileSync(join(goalsDirectory, 'scoped.md'), `## TRACED PATHS\n1. ${targetPath} — target\n`, 'utf8');
    writeFileSync(join(goalsDirectory, 'other.md'), '## TRACED PATHS\n1. src/other.ts — target\n', 'utf8');
    const completed = (goalFile: string) => [
      { timestamp: '2026-08-17T00:01:00.000Z', event: 'start', data: { goalFile } },
      { timestamp: '2026-08-17T00:02:00.000Z', event: 'run-status', data: { runStatus: 'completed' } },
    ];
    write(ledgerDirectory, unscopedFirst, completed(join(goalsDirectory, 'other.md')));
    write(ledgerDirectory, scopedSecond, completed(join(goalsDirectory, 'scoped.md')));
    const targets = [{ name: 'local', dbPath: join(root, 'mss', 'logs.db') }];
    const unscoped = queryFederatedCompletedRunLedgers({ targets, limit: 1 });
    const scoped = queryFederatedCompletedRunLedgers({ targets, limit: 1, path: targetPath });
    expect(unscoped).toMatchObject({ entries: [expect.objectContaining({ runId: unscopedFirst })], limit: 1, truncated: true });
    expect(scoped).toMatchObject({ entries: [expect.objectContaining({ runId: scopedSecond })], limit: 1, truncated: true, pathFilter: targetPath, matchingPathCount: 1 });
  });

  it('matches every requested path before applying one shared limit', () => {
    const root = mkdtempSync(join(tmpdir(), 'run-ledger-completed-multi-path-'));
    directories.push(root);
    const ledgerDirectory = runLedgerDir(root);
    const goalsDirectory = join(root, 'goals');
    mkdirSync(ledgerDirectory);
    mkdirSync(goalsDirectory);
    const first = runId('0416');
    const second = runId('0417');
    const paths = ['src/a.ts', 'src/a.test.ts'];
    const completed = (goalFile: string) => [
      { event: 'start', data: { goalFile } },
      { event: 'run-status', data: { runStatus: 'completed' } },
    ];
    const firstGoal = join(goalsDirectory, 'first.md');
    const secondGoal = join(goalsDirectory, 'second.md');
    writeFileSync(firstGoal, `## TRACED PATHS\n1. ${paths[0]} — target\n`, 'utf8');
    writeFileSync(secondGoal, `## TRACED PATHS\n1. ${paths[1]} — target\n`, 'utf8');
    write(ledgerDirectory, first, completed(firstGoal));
    write(ledgerDirectory, second, completed(secondGoal));

    const result = queryFederatedCompletedRunLedgers({
      targets: [{ name: 'local', dbPath: join(root, 'mss', 'logs.db') }],
      paths,
      limit: 1,
    });

    expect(result).toMatchObject({
      entries: [expect.objectContaining({ runId: first })],
      limit: 1,
      truncated: true,
      pathFilters: paths,
      matchingPathCount: 2,
    });
  });

  it('counts an initially null ledger once and excludes it from a completed path scope', () => {
    const root = mkdtempSync(join(tmpdir(), 'run-ledger-completed-path-null-'));
    directories.push(root);
    const ledgerDirectory = runLedgerDir(root);
    const goalsDirectory = join(root, 'goals');
    mkdirSync(ledgerDirectory);
    mkdirSync(goalsDirectory);
    const id = runId('0415');
    const targetPath = 'src/self-implement/run-ledger.ts';
    const goalFile = join(goalsDirectory, 'scoped.md');
    writeFileSync(goalFile, `## TRACED PATHS\n1. ${targetPath} — target\n`, 'utf8');
    write(ledgerDirectory, id, [
      { event: 'start', data: { goalFile } },
      { event: 'run-status', data: { runStatus: 'completed' } },
    ]);
    let reads = 0;
    const result = queryFederatedCompletedRunLedgers({
      targets: [{ name: 'local', dbPath: join(root, 'mss', 'logs.db') }],
      path: targetPath,
      read: (path, encoding) => {
        if (path.endsWith(`${id}.jsonl`)) {
          reads += 1;
          throw Object.assign(new Error('missing after list'), { code: 'ENOENT' });
        }
        return readFileSync(path, encoding);
      },
    });
    expect(result).toMatchObject({ entries: [], unreadableLedgerCount: 1, goalDocumentMissingCount: 0, pathFilter: targetPath, matchingPathCount: 0 });
    expect(reads).toBe(1);
  });

  it('counts a readable ledger whose goal document is gone in goalDocumentMissingCount, not unreadableLedgerCount', () => {
    const root = mkdtempSync(join(tmpdir(), 'run-ledger-completed-goal-gone-'));
    directories.push(root);
    const ledgerDirectory = runLedgerDir(root);
    mkdirSync(ledgerDirectory);
    const id = runId('0418');
    const targetPath = 'src/self-implement/run-ledger.ts';
    const goalFile = join(root, 'gone.md');
    write(ledgerDirectory, id, [
      { event: 'start', data: { goalFile } },
      { event: 'run-status', data: { runStatus: 'completed' } },
    ]);
    const unnamed = runId('0419');
    write(ledgerDirectory, unnamed, [
      { event: 'start', data: {} },
      { event: 'run-status', data: { runStatus: 'completed' } },
    ]);

    const result = queryFederatedCompletedRunLedgers({
      targets: [{ name: 'local', dbPath: join(root, 'mss', 'logs.db') }],
      path: targetPath,
    });

    expect(result.unreadableLedgerCount).toBe(0);
    expect(result.goalDocumentMissingCount).toBe(1);
    expect(result.entries).toEqual([]);
    expect(result.matchingPathCount).toBe(0);
  });

  it('keeps a corrupt ledger in unreadableLedgerCount and does not count it as a missing goal document', () => {
    const root = mkdtempSync(join(tmpdir(), 'run-ledger-completed-corrupt-'));
    directories.push(root);
    const ledgerDirectory = runLedgerDir(root);
    mkdirSync(ledgerDirectory);
    const id = runId('0420');
    writeFileSync(join(ledgerDirectory, `${id}.jsonl`), '{not json\n', 'utf8');

    const result = queryFederatedCompletedRunLedgers({
      targets: [{ name: 'local', dbPath: join(root, 'mss', 'logs.db') }],
      path: 'src/self-implement/run-ledger.ts',
    });

    expect(result.unreadableLedgerCount).toBe(1);
    expect(result.goalDocumentMissingCount).toBe(0);
    expect(result.entries).toEqual([]);
  });

  afterAll(() => {
    for (const dir of directories) rmSync(dir, { recursive: true, force: true });
  });
});

describe('human-stopped run ledger records', () => {
  const directories: string[] = [];

  it('persists the stopping human and timestamp through the existing append/read path', () => {
    const directory = mkdtempSync(join(tmpdir(), 'run-ledger-human-stop-'));
    directories.push(directory);
    const runId = 'run-00000000-0000-4000-8000-000000000105';
    appendRunLedgerEntry({ timestamp: '2026-08-14T00:00:00.000Z', runId, event: 'pipeline-node-entry', data: {} }, directory);
    recordHumanStoppedRun(runId, { stoppedBy: 'operator', stoppedAt: '2026-08-14T00:01:00.000Z', dir: directory });

    expect(loadRunLedger(runId, directory)).toEqual([
      expect.objectContaining({ event: 'pipeline-node-entry' }),
      { timestamp: '2026-08-14T00:01:00.000Z', runId, event: 'human-stop', data: { stoppedBy: 'operator', stoppedAt: '2026-08-14T00:01:00.000Z' } },
    ]);
    expect(queryUnfinishedRunLedgers({ dir: directory, goalsDir: directory }).entries).toEqual([]);
  });

  afterAll(() => {
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  });
});

describe('classifyUnfinishedLifecycle — 「남은 것」을 가려서 본다', () => {

  const WINDOW = 30 * 60_000;
  const at = (event: string, data: Record<string, unknown> = {}) => ({ runId: 'r', event, data });

  it('[live] 활동이 임계 «안»이면 도는 중일 수 있다', () => {
    expect(classifyUnfinishedLifecycle([at('pipeline-node-entry')], 60_000, WINDOW)).toBe('live');
  });

  it('[orphaned] 임계를 크게 넘겼고 어느 어휘로도 종결이 없다', () => {
    expect(classifyUnfinishedLifecycle([at('pipeline-node-entry')], 5 * 24 * 3600_000, WINDOW)).toBe('orphaned');
  });

  it('[terminal-other-vocabulary] 종료를 «다른 이름»으로 적은 것은 「종결 없음」과 다른 값이다', () => {
    // 📏 실측 문면: {"event":"terminal","data":{"terminal":"escalated","ok":false,…}}
    const ledger = [at('start'), at('terminal', { terminal: 'escalated', ok: false })];
    expect(classifyUnfinishedLifecycle(ledger, 5 * 24 * 3600_000, WINDOW)).toBe('terminal-other-vocabulary');
    // ⛔ 순서가 뜻을 가진다 — 나이가 아무리 많아도 「적었다」가 먼저다.
    expect(classifyUnfinishedLifecycle(ledger, 60_000, WINDOW)).toBe('terminal-other-vocabulary');
  });

  it('[human-stopped] 사람이 멈춘 기록은 최근·오래된 활동보다 먼저 비실행으로 분류한다', () => {
    const ledger = [at('pipeline-node-entry'), at('human-stop', { stoppedBy: 'operator', stoppedAt: '2026-08-14T00:00:00.000Z' })];
    expect(classifyUnfinishedLifecycle(ledger, 60_000, WINDOW)).toBe('human-stopped');
    expect(classifyUnfinishedLifecycle(ledger, 5 * 24 * 3600_000, WINDOW)).toBe('human-stopped');
  });

  it('[resumed-after-run-status] 마지막 run-status 뒤 start는 나이 규칙으로 live 또는 orphaned를 가른다', () => {
    const ledger = [at('start'), at('run-status', { runStatus: 'failed' }), at('start'), at('progress-delivery-outcome')];
    expect(classifyUnfinishedLifecycle(ledger, 60_000, WINDOW)).toBe('live');
    expect(classifyUnfinishedLifecycle(ledger, 2 * 60 * 60_000, WINDOW)).toBe('orphaned');
  });

  it('[unjudgeable] 나이를 «모르면» live 도 orphaned 도 아니다', () => {
    // ⛔ 「모른다」를 어느 등급에도 섞지 않는다 — 이 저장소의 0 vs 못 셈 규율.
    expect(classifyUnfinishedLifecycle([at('start')], null, WINDOW)).toBe('unjudgeable');
  });

  it('[window-comes-from-the-caller] 임계는 호출자가 준다 — 같은 나이가 임계에 따라 갈린다', () => {
    const ledger = [at('start')];
    expect(classifyUnfinishedLifecycle(ledger, 10 * 60_000, 30 * 60_000)).toBe('live');
    expect(classifyUnfinishedLifecycle(ledger, 10 * 60_000, 5 * 60_000)).toBe('orphaned');
  });
});

describe('unfinished run ledger terminal vocabulary', () => {
  const directories: string[] = [];
  const runId = (suffix: string) => `run-00000000-0000-4000-8000-00000000${suffix}`;

  function queryEntries(event: string, data: Record<string, unknown> = {}) {
    const directory = mkdtempSync(join(tmpdir(), 'run-ledger-terminal-vocabulary-'));
    directories.push(directory);
    const id = runId(String(directories.length).padStart(4, '0'));
    writeFileSync(join(directory, `${id}.jsonl`), [
      JSON.stringify({ timestamp: '2026-08-12T00:00:00.000Z', runId: id, event: 'start', data: {} }),
      JSON.stringify({ timestamp: '2026-08-12T00:01:00.000Z', runId: id, event, data }),
    ].join('\n'), 'utf8');
    return queryUnfinishedRunLedgers({ dir: directory, goalsDir: directory }).entries;
  }

  it('excludes terminal-only and canonical run-status ledgers but retains ledgers with neither terminal vocabulary', () => {
    expect(queryEntries('terminal', { terminal: 'published', ok: true })).toEqual([]);
    expect(queryEntries('run-status', { runStatus: 'failed' })).toEqual([]);
    expect(queryEntries('pipeline-node-entry')).toHaveLength(1);
  });

  it('retains a ledger when activity follows a canonical terminal run-status', () => {
    const directory = mkdtempSync(join(tmpdir(), 'run-ledger-post-terminal-activity-'));
    directories.push(directory);
    const id = runId(String(directories.length).padStart(4, '0'));
    writeFileSync(join(directory, `${id}.jsonl`), [
      JSON.stringify({ timestamp: '2026-08-12T00:00:00.000Z', runId: id, event: 'start', data: {} }),
      JSON.stringify({ timestamp: '2026-08-12T00:01:00.000Z', runId: id, event: 'run-status', data: { runStatus: 'failed' } }),
      JSON.stringify({ timestamp: '2026-08-12T00:02:00.000Z', runId: id, event: 'rework', data: {} }),
      JSON.stringify({ timestamp: '2026-08-12T00:03:00.000Z', runId: id, event: 'progress-delivery-outcome', data: {} }),
    ].join('\n'), 'utf8');

    expect(queryUnfinishedRunLedgers({ dir: directory, goalsDir: directory }).entries)
      .toEqual([expect.objectContaining({ runId: id, lastActivityTimestamp: '2026-08-12T00:03:00.000Z', lifecycle: 'terminal-run-status-superseded' })]);
  });

  it('treats trailing bookkeeping after the last valid run-status as finished and keeps later non-bookkeeping unfinished', () => {
    const directory = mkdtempSync(join(tmpdir(), 'run-ledger-trailing-bookkeeping-'));
    directories.push(directory);
    const finishedId = runId('9101');
    const resumedId = runId('9102');
    const missingStatusId = runId('9103');
    const line = (id: string, timestamp: string, event: string, data: Record<string, unknown> = {}) =>
      JSON.stringify({ timestamp, runId: id, event, data });
    writeFileSync(join(directory, `${finishedId}.jsonl`), [
      line(finishedId, '2026-09-26T00:00:00.000Z', 'start'),
      line(finishedId, '2026-09-26T00:01:00.000Z', 'run-status', { runStatus: 'completed' }),
      line(finishedId, '2026-09-26T00:02:00.000Z', 'run-rollup'),
      line(finishedId, '2026-09-26T00:03:00.000Z', 'progress-delivery'),
      line(finishedId, '2026-09-26T00:04:00.000Z', 'pipeline-traversal-shadow'),
    ].join('\n'), 'utf8');
    writeFileSync(join(directory, `${resumedId}.jsonl`), [
      line(resumedId, '2026-09-26T00:00:00.000Z', 'start'),
      line(resumedId, '2026-09-26T00:01:00.000Z', 'run-status', { runStatus: 'failed', stage: 'aborted' }),
      line(resumedId, '2026-09-26T00:02:00.000Z', 'run-rollup'),
      line(resumedId, '2026-09-26T00:03:00.000Z', 'role'),
      line(resumedId, '2026-09-26T00:04:00.000Z', 'quota-refresh'),
    ].join('\n'), 'utf8');
    writeFileSync(join(directory, `${missingStatusId}.jsonl`), [
      line(missingStatusId, '2026-09-26T00:00:00.000Z', 'start'),
      line(missingStatusId, '2026-09-26T00:01:00.000Z', 'pipeline-node-entry'),
    ].join('\n'), 'utf8');

    const query = queryUnfinishedRunLedgers({ dir: directory, goalsDir: directory });
    const unfinishedIds = query.entries.map((entry) => entry.runId);
    expect(unfinishedIds).not.toContain(finishedId);
    expect(unfinishedIds).toEqual(expect.arrayContaining([resumedId, missingStatusId]));
    expect(query.terminalByTrailingRunStatus).toBe(1);
  });

  afterAll(() => {
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  });
});

describe('terminated unfinished run lifecycles', () => {
  it('includes exactly the terminal lifecycles and rejects live or missing values', () => {
    expect([...TERMINATED_UNFINISHED_LIFECYCLES]).toEqual([
      'human-stopped',
      'terminal-other-vocabulary',
      'terminal-run-status-superseded',
    ]);
    for (const lifecycle of TERMINATED_UNFINISHED_LIFECYCLES) {
      expect(isTerminatedUnfinishedLifecycle(lifecycle)).toBe(true);
    }
    expect(isTerminatedUnfinishedLifecycle('live')).toBe(false);
    expect(isTerminatedUnfinishedLifecycle(undefined)).toBe(false);
  });
});

describe('terminated unfinished lifecycle consumers', () => {
  it('keeps the three implementation files free of inline terminal lifecycle decisions', () => {
    const implementationFiles = [
      new URL('./run-ledger.ts', import.meta.url),
      new URL('./running-runs.ts', import.meta.url),
      new URL('../self-dev/launch-preflight.ts', import.meta.url),
    ];
    const terminalLifecycles = [
      'human-stopped',
      'terminal-other-vocabulary',
      'terminal-run-status-superseded',
    ];
    const inlineDecision = /===|!==|\.includes\(|new Set\(\[|\bcase\s/;
    for (const file of implementationFiles) {
      const lines = readFileSync(file, 'utf8').split('\n');
      const canonicalDefinitionStart = file.pathname.endsWith('/run-ledger.ts')
        ? lines.findIndex((line) => line.startsWith('export const TERMINATED_UNFINISHED_LIFECYCLES'))
        : -1;
      const canonicalDefinitionEnd = canonicalDefinitionStart < 0
        ? -1
        : lines.findIndex((line, index) => index >= canonicalDefinitionStart && line === ']);');
      const violations = lines
        .filter((line, index) => index < canonicalDefinitionStart || index > canonicalDefinitionEnd)
        .filter((line) => terminalLifecycles.some((lifecycle) => line.includes(`'${lifecycle}'`) || line.includes(`\"${lifecycle}\"`)))
        .filter((line) => inlineDecision.test(line));
      expect(violations).toEqual([]);
    }
  });
});

describe('unfinished run ledger cleanup disposition', () => {
  const directories: string[] = [];
  const NOW = Date.parse('2026-08-12T12:00:00.000Z');
  const WINDOW = 30 * 60_000;
  const runId = (suffix: string) => `run-00000000-0000-4000-8000-00000000${suffix}`;
  const entry = (lifecycle: UnfinishedRunLedgerEntry['lifecycle']): UnfinishedRunLedgerEntry => ({
    runId: runId('9999'), branch: null, status: 'terminal-status-missing', plannedPaths: [], plannedPathStatus: 'unknown',
    declaredPaths: [], declaredPathStatus: 'unknown', pathMatchReasons: {},
    goalDocumentPath: null, goalDocumentSearchDirectory: null, lastActivityTimestamp: null, lastActivityAgeMs: null,
    lastActivityStatus: lifecycle === 'unjudgeable' ? 'timestamp-missing' : 'available', lifecycle,
  });

  function temporaryLedgerDir(): string {
    const directory = mkdtempSync(join(tmpdir(), 'run-ledger-cleanup-'));
    directories.push(directory);
    return directory;
  }

  function writeLedger(directory: string, id: string, timestamp: string, event = 'start'): string {
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `${id}.jsonl`);
    writeFileSync(path, `${JSON.stringify({ timestamp, runId: id, event, data: {} })}\n`, 'utf8');
    return path;
  }

  it('maps only orphaned entries to reclaim-safe and keeps terminal, live, and unknown entries conservative', () => {
    expect(dispositionUnfinishedRunLedger(entry('orphaned'))).toBe('reclaim-safe');
    expect(dispositionUnfinishedRunLedger(entry('terminal-other-vocabulary'))).not.toBe('reclaim-safe');
    expect(dispositionUnfinishedRunLedger(entry('live'))).not.toBe('reclaim-safe');
    expect(dispositionUnfinishedRunLedger(entry('unjudgeable'))).toBe('unjudgeable');
  });

  it('plans by default without deleting and explicitly deletes only reclaim-safe ledgers with disposition counts', () => {
    const directory = temporaryLedgerDir();
    const orphanedId = runId('0001');
    const liveId = runId('0002');
    const terminalId = runId('0003');
    const unknownId = runId('0004');
    const orphanedPath = writeLedger(directory, orphanedId, '2026-08-01T00:00:00.000Z');
    const livePath = writeLedger(directory, liveId, '2026-08-12T11:50:00.000Z');
    const terminalPath = writeLedger(directory, terminalId, '2026-08-01T00:00:00.000Z', 'terminal');
    const unknownPath = writeLedger(directory, unknownId, 'invalid');
    const dateNow = Date.now;
    Date.now = () => NOW;
    try {
      const planned = cleanupUnfinishedRunLedgers({ dir: directory, liveWindowMs: WINDOW });
      expect(planned.plannedRemoval).toEqual([orphanedPath]);
      expect(planned.removed).toEqual([]);
      expect(planned.counts).toEqual({
        disposition: { 'reclaim-safe': 1, 'needs-human': 0, 'do-not-touch': 1, unjudgeable: 1 },
        removed: { 'reclaim-safe': 0, 'needs-human': 0, 'do-not-touch': 0, unjudgeable: 0 },
        preserved: { 'reclaim-safe': 1, 'needs-human': 0, 'do-not-touch': 1, unjudgeable: 1 },
        unavailable: { 'reclaim-safe': 0, 'needs-human': 0, 'do-not-touch': 0, unjudgeable: 0 },
        queryUnavailable: 0,
      });
      expect([orphanedPath, livePath, terminalPath, unknownPath].every(existsSync)).toBe(true);

      const removed = cleanupUnfinishedRunLedgers({ dir: directory, liveWindowMs: WINDOW, remove: true });
      expect(removed.removed).toEqual([orphanedPath]);
      expect(removed.preserved).toEqual(expect.arrayContaining([livePath, unknownPath]));
      expect(removed.counts.removed).toEqual({ 'reclaim-safe': 1, 'needs-human': 0, 'do-not-touch': 0, unjudgeable: 0 });
      expect(existsSync(orphanedPath)).toBe(false);
      expect([livePath, terminalPath, unknownPath].every(existsSync)).toBe(true);
    } finally {
      Date.now = dateNow;
    }
  });

  it('distinguishes an unavailable query from a successfully empty ledger directory', () => {
    const emptyDirectory = temporaryLedgerDir();
    const empty = cleanupUnfinishedRunLedgers({ dir: emptyDirectory, liveWindowMs: WINDOW });
    const unavailable = cleanupUnfinishedRunLedgers({
      dir: emptyDirectory,
      liveWindowMs: WINDOW,
      list: () => { throw new Error('directory unavailable'); },
    });

    expect(empty.unavailable).toBe(false);
    expect(empty.counts.queryUnavailable).toBe(0);
    expect(unavailable.unavailable).toBe(true);
    expect(unavailable.counts.queryUnavailable).toBe(1);
    expect(unavailable.plannedRemoval).toEqual([]);
  });

  it('keeps actual ledger files when a reader fails and reports the query as unavailable', () => {
    const directory = temporaryLedgerDir();
    const firstPath = writeLedger(directory, runId('0010'), '2026-08-01T00:00:00.000Z');
    const secondPath = writeLedger(directory, runId('0014'), '2026-08-01T00:00:00.000Z');
    const dateNow = Date.now;
    Date.now = () => NOW;
    try {
      const result = cleanupUnfinishedRunLedgers({
        dir: directory,
        liveWindowMs: WINDOW,
        remove: true,
        read: (path, encoding) => {
          if (path === firstPath) throw new Error('reader blocked');
          return readFileSync(path, encoding);
        },
      });
      expect(result.unavailable).toBe(true);
      expect(result.counts.queryUnavailable).toBe(1);
      expect(result.assessments).toEqual([]);
      expect(result.plannedRemoval).toEqual([]);
      expect(result.removed).toEqual([]);
      expect(result.counts.disposition).toEqual({ 'reclaim-safe': 0, 'needs-human': 0, 'do-not-touch': 0, unjudgeable: 0 });
      expect([firstPath, secondPath].every(existsSync)).toBe(true);
    } finally {
      Date.now = dateNow;
    }
  });

  it('continues after an unlink failure and reports partial success as unavailable', () => {
    const directory = temporaryLedgerDir();
    const firstId = runId('0011');
    const secondId = runId('0012');
    const firstPath = writeLedger(directory, firstId, '2026-08-01T00:00:00.000Z');
    const secondPath = writeLedger(directory, secondId, '2026-08-01T00:00:00.000Z');
    const dateNow = Date.now;
    Date.now = () => NOW;
    try {
      const result = cleanupUnfinishedRunLedgers({
        dir: directory,
        liveWindowMs: WINDOW,
        remove: true,
        unlink: (path) => {
          if (path === firstPath) throw new Error('unlink blocked');
          rmSync(path);
        },
      });
      expect(result.unavailable).toBe(true);
      expect(result.removed).toEqual([secondPath]);
      expect(result.preserved).toContain(firstPath);
      expect(result.counts.removed['reclaim-safe']).toBe(1);
      expect(result.counts.preserved['reclaim-safe']).toBe(1);
      expect(result.counts.unavailable['reclaim-safe']).toBe(1);
      expect(existsSync(firstPath)).toBe(true);
      expect(existsSync(secondPath)).toBe(false);
    } finally {
      Date.now = dateNow;
    }
  });

  it('rejects non-finite and negative caller thresholds without querying or deleting files', () => {
    const directory = temporaryLedgerDir();
    const path = writeLedger(directory, runId('0013'), '2026-08-01T00:00:00.000Z');
    for (const liveWindowMs of [Number.NaN, -1]) {
      let listCalls = 0;
      const result = cleanupUnfinishedRunLedgers({
        dir: directory,
        liveWindowMs,
        remove: true,
        list: () => {
          listCalls += 1;
          return [];
        },
      });
      expect(result.unavailable).toBe(true);
      expect(result.invalidLiveWindow).toBe(true);
      expect(result.counts.queryUnavailable).toBe(0);
      expect(listCalls).toBe(0);
      expect(result.removed).toEqual([]);
      expect(existsSync(path)).toBe(true);
    }
  });

  it('executes the cleanup CLI as plan-only by default, removes only on request, and blocks incomplete queries', () => {
    const stateDir = temporaryLedgerDir();
    const ledgerDir = join(stateDir, 'run-ledger');
    const oldId = runId('0020');
    const liveId = runId('0021');
    const oldPath = writeLedger(ledgerDir, oldId, new Date(Date.now() - 60 * 60_000).toISOString());
    const livePath = writeLedger(ledgerDir, liveId, new Date(Date.now() - 1_000).toISOString());
    const elanous = join(process.cwd(), 'bin', 'elanous.mjs');
    const invoke = (...args: string[]) => Bun.spawnSync({
      cmd: [process.execPath, elanous, `--test=${stateDir}`, 'self', 'unfinished-runs-cleanup', '--json', ...args],
      cwd: process.cwd(),
      env: { ...process.env, ELANOUS_STATE_DIR: stateDir },
      stdout: 'pipe', stderr: 'pipe',
    });
    const parse = (result: ReturnType<typeof invoke>) => JSON.parse(new TextDecoder().decode(result.stdout));

    const planned = invoke();
    expect(planned.exitCode, new TextDecoder().decode(planned.stderr)).toBe(0);
    expect(parse(planned)).toMatchObject({ plannedRemoval: [oldPath], removed: [], preserved: expect.arrayContaining([oldPath, livePath]) });
    expect([oldPath, livePath].every(existsSync)).toBe(true);

    const removed = invoke('--remove');
    expect(removed.exitCode, new TextDecoder().decode(removed.stderr)).toBe(0);
    expect(parse(removed)).toMatchObject({ removed: [oldPath], preserved: expect.arrayContaining([livePath]) });
    expect(existsSync(oldPath)).toBe(false);
    expect(existsSync(livePath)).toBe(true);

    const blockedPath = writeLedger(ledgerDir, runId('0022'), new Date(Date.now() - 60 * 60_000).toISOString());
    writeFileSync(join(ledgerDir, `${runId('0023')}.jsonl`), '{not json}\n', 'utf8');
    const incomplete = invoke('--remove');
    expect(incomplete.exitCode, new TextDecoder().decode(incomplete.stderr)).toBe(0);
    expect(parse(incomplete)).toMatchObject({ unavailable: true, removed: [], counts: { queryUnavailable: 1 } });
    expect(existsSync(blockedPath)).toBe(true);

    for (const age of ['60s', '1,000', '1oops']) {
      const invalid = invoke('--remove', '--age', age);
      expect(invalid.exitCode).not.toBe(0);
      expect(new TextDecoder().decode(invalid.stderr)).toContain('--age must be a non-negative number of minutes');
      expect(existsSync(blockedPath)).toBe(true);
    }
  }, 15_000);

  afterAll(() => {
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  });
});

describe('unfinished run ledger target-root goal lookup', () => {
  it('reads target-relative and branch goals from A while retaining caller-cwd lookup for legacy ledgers', () => {
    const root = mkdtempSync(join(tmpdir(), 'run-ledger-target-'));
    const target = join(root, 'target-A');
    const caller = join(root, 'caller-B');
    const directory = join(root, 'ledgers');
    const goalDirectory = join(target, 'docs', 'goals');
    const relativeGoal = join('docs', 'goals', 'relative.md');
    const branchGoal = join(goalDirectory, 'GOAL-branch-a1b2c3d4-2026-09-27.txt');
    const ids = [1, 2, 3].map((index) => `run-00000000-0000-4000-8000-00000000010${index}`);
    const previousCwd = process.cwd();
    const originalLog = debug.log;
    const observations: Array<{ category: string; event: string; data: unknown }> = [];
    try {
      mkdirSync(goalDirectory, { recursive: true });
      mkdirSync(caller);
      mkdirSync(directory);
      writeFileSync(join(target, relativeGoal), '## TRACED PATHS\n1. src/relative.ts — target\n');
      writeFileSync(branchGoal, '## TRACED PATHS\n1. src/branch.ts — target\n');
      for (const [index, id] of ids.entries()) {
        appendRunLedgerEntry({ runId: id!, event: 'start', data: {
          branch: 'self-impl-a1b2c3d4',
          ...(index < 2 ? { targetRoot: target } : {}),
          ...(index !== 1 ? { goalFile: relativeGoal } : {}),
        } }, directory);
      }
      process.chdir(caller);
      (debug as { log: typeof debug.log }).log = ((category, event, data) => {
        observations.push({ category, event, data });
      }) as typeof debug.log;
      const result = queryUnfinishedRunLedgers({ dir: directory });
      expect(result.entries).toEqual([
        expect.objectContaining({ runId: ids[0], goalLookupBasis: 'ledger-target', plannedPathStatus: 'found-ledger-goal-file', goalDocumentPath: join(target, relativeGoal), plannedPaths: ['src/relative.ts'], goalDocumentSearchDirectory: null }),
        expect.objectContaining({ runId: ids[1], goalLookupBasis: 'ledger-target', plannedPathStatus: 'found-branch-fallback', goalDocumentPath: branchGoal, plannedPaths: ['src/branch.ts'], goalDocumentSearchDirectory: goalDirectory }),
        expect.objectContaining({ runId: ids[2], goalLookupBasis: 'caller-cwd', plannedPathStatus: 'goal-document-unreadable', goalDocumentPath: relativeGoal, goalDocumentSearchDirectory: null }),
      ]);
      expect(observations).toContainEqual({ category: 'self-implement.run-ledger', event: 'goal-lookup-basis', data: { ledgerTarget: 2, callerCwd: 1 } });
      const federated = queryFederatedUnfinishedRunLedgers({ ledgerDirectories: [directory] });
      expect(federated.entries.map(({ runId, goalLookupBasis, plannedPathStatus }) => ({ runId, goalLookupBasis, plannedPathStatus }))).toEqual(result.entries.map(({ runId, goalLookupBasis, plannedPathStatus }) => ({ runId, goalLookupBasis, plannedPathStatus })));
    } finally {
      (debug as { log: typeof debug.log }).log = originalLog;
      process.chdir(previousCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('unfinished run ledger path axes', () => {
  const directories: string[] = [];
  const runId = (suffix: string) => `run-00000000-0000-4000-8000-00000000${suffix}`;
  const temporaryDirectory = (prefix: string): string => {
    const directory = mkdtempSync(join(tmpdir(), prefix));
    directories.push(directory);
    return directory;
  };
  const writeRun = (ledgerDir: string, id: string, goalFile: string): void => {
    writeFileSync(join(ledgerDir, `${id}.jsonl`), `${JSON.stringify({ timestamp: '2026-08-13T00:00:00.000Z', runId: id, event: 'start', data: { goalFile } })}\n`, 'utf8');
  };
  const goal = (ask: string | null, traced: readonly string[]): string => [
    ...(ask === null ? [] : ['Original ask (verbatim, unmodified):', '```', ask, '```']),
    '## TRACED PATHS',
    ...traced.map((path, index) => `${index + 1}. ${path}`),
  ].join('\n');

  it('keeps declared targets and traced evidence separate, deduplicates their union, and labels every match reason', () => {
    const ledgerDir = temporaryDirectory('run-ledger-axes-ledger-');
    const goalsDir = temporaryDirectory('run-ledger-axes-goals-');
    const goalFile = join(goalsDir, 'GOAL-path-axes-a1b2c3d4-2026-08-13.txt');
    writeFileSync(goalFile, goal('대상 경로: src/declared.ts · src/shared.ts · src/declared.ts', ['src/traced.ts', 'src/shared.ts', 'src/traced.ts']), 'utf8');
    writeRun(ledgerDir, runId('0101'), goalFile);

    const entry = queryUnfinishedRunLedgers({ dir: ledgerDir, goalsDir }).entries[0]!;
    expect(entry.plannedPaths).toEqual(['src/traced.ts', 'src/shared.ts']);
    expect(entry.declaredPaths).toEqual(['src/declared.ts', 'src/shared.ts']);
    expect(entry.declaredPathStatus).toBe('found');
    expect(entry.pathMatchReasons).toEqual({ 'src/declared.ts': 'declared', 'src/shared.ts': 'both', 'src/traced.ts': 'traced' });
    expect(queryUnfinishedRunLedgers({ dir: ledgerDir, goalsDir, path: 'src/traced.ts' }).matchingPathCount).toBe(1);
    expect(queryUnfinishedRunLedgers({ dir: ledgerDir, goalsDir, path: 'src/declared.ts' }).matchingPathCount).toBe(1);
  });

  it('does not treat inherited object property names as matched paths', () => {
    const ledgerDir = temporaryDirectory('run-ledger-axes-inherited-ledger-');
    const goalsDir = temporaryDirectory('run-ledger-axes-inherited-goals-');
    const goalFile = join(goalsDir, 'GOAL-inherited-a2b3c4d5-2026-08-13.txt');
    writeFileSync(goalFile, goal('대상 경로: src/declared.ts', ['src/traced.ts']), 'utf8');
    writeRun(ledgerDir, runId('0102'), goalFile);

    for (const path of ['constructor', 'toString']) {
      const queried = queryUnfinishedRunLedgers({ dir: ledgerDir, goalsDir, path });
      expect(queried.matchingPathCount).toBe(0);
      expect(queried.entries).toEqual([]);
    }
  });

  it('retains declaration-unknown entries but excludes confirmed empty declarations for unrelated path filters', () => {
    const ledgerDir = temporaryDirectory('run-ledger-axes-filtered-status-ledger-');
    const goalsDir = temporaryDirectory('run-ledger-axes-filtered-status-goals-');
    const emptyGoal = join(goalsDir, 'GOAL-filter-empty-b2c3d4e5-2026-08-13.txt');
    const labelMissingGoal = join(goalsDir, 'GOAL-filter-label-missing-c3d4e5f6-2026-08-13.txt');
    const legacyGoal = join(goalsDir, 'GOAL-filter-legacy-d4e5f6a7-2026-08-13.txt');
    writeFileSync(emptyGoal, goal('대상 경로:', []), 'utf8');
    writeFileSync(labelMissingGoal, goal('이 ask에는 대상 경로 라벨이 없다.', []), 'utf8');
    writeFileSync(legacyGoal, goal(null, []), 'utf8');
    writeRun(ledgerDir, runId('0098'), emptyGoal);
    writeRun(ledgerDir, runId('0099'), labelMissingGoal);
    writeRun(ledgerDir, runId('0100'), legacyGoal);

    const queried = queryUnfinishedRunLedgers({ dir: ledgerDir, goalsDir, path: 'src/unrelated.ts' });
    expect(queried.matchingPathCount).toBe(0);
    expect(queried.unknownPathCount).toBe(2);
    expect(queried.entries.map((entry) => entry.runId)).toEqual([runId('0099'), runId('0100')]);
    expect(queried.entries.map((entry) => entry.declaredPathStatus)).toEqual(['label-missing', 'original-ask-missing']);
  });

  it('distinguishes an empty declaration, missing target label, missing original ask, and unreadable goal document without losing traced evidence', () => {
    const ledgerDir = temporaryDirectory('run-ledger-axes-status-ledger-');
    const goalsDir = temporaryDirectory('run-ledger-axes-status-goals-');
    const emptyGoal = join(goalsDir, 'GOAL-empty-c3d4e5f6-2026-08-13.txt');
    const labelMissingGoal = join(goalsDir, 'GOAL-label-missing-d4e5f6a7-2026-08-13.txt');
    const legacyGoal = join(goalsDir, 'GOAL-legacy-e5f6a7b8-2026-08-13.txt');
    const unreadableGoal = join(goalsDir, 'GOAL-unreadable-f6a7b8c9-2026-08-13.txt');
    writeFileSync(emptyGoal, goal('대상 경로:', ['src/evidence.ts']), 'utf8');
    writeFileSync(labelMissingGoal, goal('이 ask에는 대상 경로 라벨이 없다.', ['src/label-evidence.ts']), 'utf8');
    writeFileSync(legacyGoal, goal(null, ['src/legacy-evidence.ts']), 'utf8');
    writeFileSync(unreadableGoal, goal('대상 경로: src/unreadable.ts', ['src/unreadable-evidence.ts']), 'utf8');
    writeRun(ledgerDir, runId('0103'), emptyGoal);
    writeRun(ledgerDir, runId('0104'), labelMissingGoal);
    writeRun(ledgerDir, runId('0105'), legacyGoal);
    writeRun(ledgerDir, runId('0106'), unreadableGoal);

    const entries = queryUnfinishedRunLedgers({
      dir: ledgerDir,
      goalsDir,
      read: (path, encoding) => path === unreadableGoal ? (() => { throw new Error('unreadable'); })() : readFileSync(path, encoding),
    }).entries;
    expect(entries.find((entry) => entry.runId === runId('0103'))).toMatchObject({ declaredPaths: [], declaredPathStatus: 'no-declared-paths', plannedPaths: ['src/evidence.ts'] });
    expect(entries.find((entry) => entry.runId === runId('0104'))).toMatchObject({ declaredPaths: [], declaredPathStatus: 'label-missing', plannedPaths: ['src/label-evidence.ts'] });
    expect(entries.find((entry) => entry.runId === runId('0105'))).toMatchObject({ declaredPaths: [], declaredPathStatus: 'original-ask-missing', plannedPaths: ['src/legacy-evidence.ts'] });
    expect(entries.find((entry) => entry.runId === runId('0106'))).toMatchObject({ declaredPaths: [], declaredPathStatus: 'goal-document-unreadable', plannedPaths: [] });
  });

  afterAll(() => {
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  });
});
