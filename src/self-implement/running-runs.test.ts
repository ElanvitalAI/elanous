import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LogStore, LogStoreRow } from '../mss/logging/log-store.js';
import { SELF_IMPLEMENT_PROGRESS_STAGES } from './orchestrator.js';
import { debug } from '../debug/log.js';
import { assessLingeringLaunchParents, assessRunningRuns, collectObservedRunPhases, queryRunningRuns, renderRunningRuns } from './running-runs.js';
import { queryFederatedUnfinishedRunLedgers, type FederatedUnfinishedRunLedgerEntry, type FederatedUnfinishedRunLedgerQuery } from './run-ledger.js';

const ledger = (
  runId: string,
  lifecycle: FederatedUnfinishedRunLedgerEntry['lifecycle'],
  ledgerDirectory = `/state/${runId}`,
  lastActivityTimestamp: string | null = null,
): FederatedUnfinishedRunLedgerEntry => ({
  runId, lifecycle, ledgerDirectory, branch: null, status: 'terminal-status-missing', plannedPaths: [], plannedPathStatus: 'unknown', declaredPaths: [], declaredPathStatus: 'unknown', pathMatchReasons: {}, goalDocumentPath: null, goalDocumentSearchDirectory: null, lastActivityTimestamp, lastActivityAgeMs: lastActivityTimestamp ? 0 : null, lastActivityStatus: lastActivityTimestamp ? 'available' : 'timestamp-missing',
});

test('separates confirmed and probable runs while preserving termination and unknown reasons', () => {
  const result = assessRunningRuns([
    ledger('run-running', 'live', '/prod/run-running', '2026-08-16T00:00:00.000Z'),
    ledger('run-running', 'orphaned', '/test/run-running'),
    ledger('run-missing-pty', 'live', '/prod/run-missing-pty', '2026-08-16T00:00:01.000Z'),
    ledger('run-ended', 'human-stopped'),
    ledger('run-terminal', 'terminal-other-vocabulary'),
    ledger('run-orphaned', 'orphaned'),
    ledger('run-unjudgeable', 'unjudgeable'),
  ], {
    refs: [
      { instance: 'prod', id: 'pty-running', kind: 'shell', alive: true, runId: 'run-running' },
      { instance: 'test:isolated', id: 'pty-only', kind: 'shell', alive: true, runId: 'run-pty-only' },
    ],
    unreadable: [],
  });

  expect(result.counts).toEqual({ running: 1, 'probable-running': 1, 'ended-unclosed': 2, unknown: 3 });
  expect(result.countedStatuses).toEqual(['running', 'probable-running']);
  expect(result.observation).toEqual({ runsNotYetInLedgerDuringAuthoringAreNotCounted: true, includesTest: null });
  expect(result.quantities).toEqual({
    counts: { value: result.counts, population: 'all assessed runs', observation: result.observation },
    total: { value: result.total, population: 'all assessed runs', observation: result.observation },
    entries: { value: result.entries.length, population: 'all assessed runs', observation: result.observation },
    running: { value: 2, population: 'assessed runs whose status is in countedStatuses', observation: result.observation },
  });
  expect(result.entries).toEqual([
    expect.objectContaining({ runId: 'run-ended', status: 'ended-unclosed', presence: 'ledger-without-pty-observed', reason: 'ledger-positive-termination-evidence' }),
    expect.objectContaining({ runId: 'run-missing-pty', status: 'probable-running', presence: 'ledger-live-pty-not-observed', reason: 'ledger-without-live-pty', lastActivityTimestamp: '2026-08-16T00:00:01.000Z' }),
    expect.objectContaining({ runId: 'run-orphaned', status: 'unknown', presence: 'ledger-without-pty-observed', reason: 'ledger-without-live-pty' }),
    expect.objectContaining({ runId: 'run-pty-only', status: 'unknown', presence: 'pty-without-ledger-observed', reason: 'pty-without-unfinished-ledger' }),
    expect.objectContaining({ runId: 'run-running', status: 'running', presence: 'ledger-live-and-pty-observed', reason: 'ledger-live-and-pty-alive', lastActivityTimestamp: '2026-08-16T00:00:00.000Z', ledgerDirectories: ['/prod/run-running', '/test/run-running'] }),
    expect.objectContaining({ runId: 'run-terminal', status: 'ended-unclosed', reason: 'ledger-positive-termination-evidence' }),
    expect.objectContaining({ runId: 'run-unjudgeable', status: 'unknown', reason: 'ledger-without-live-pty' }),
  ]);
  expect(renderRunningRuns(result)).toContain('running runs: 2 confirmed: 1 probable: 1 countedStatuses=running,probable-running');
  expect(renderRunningRuns(result)).toContain('status=probable-running presence=ledger-live-pty-not-observed reason=ledger-without-live-pty lifecycle=live lastActivity=2026-08-16T00:00:01.000Z');
});

test('counts only verified terminated-run launch parents and reports each excluded PID state through the query-to-render path', () => {
  const terminated = [
    ledger('run-valid', 'human-stopped'),
    ledger('run-without-pid', 'terminal-other-vocabulary'),
    ledger('run-reused-pid', 'terminal-other-vocabulary'),
    ledger('run-unreadable-start', 'terminal-run-status-superseded'),
  ];
  const result = queryRunningRuns({}, {
    queryLedgers: () => ({ entries: terminated, ledgerDirectories: [], goalsDirectory: '/goals', unreadableLedgerCount: 0, unreadableLedgerDirectoryCount: 0, reconciledTerminatedElsewhereCount: 0, scope: 'self-implement-run-ledger-federated', note: 'fixture', missingLedgerDirectoryCount: 0, unreadableLedgerDirectoryAccessCount: 0, indeterminateLedgerDirectoryCount: 0 }),
    ptyTargets: () => [],
    listPtyRefs: () => ({ refs: [], unreadable: [] }),
    loadRun: (runId) => ({
      'run-valid': { runId, pid: 41, createdAt: 2_000 },
      'run-without-pid': { runId, createdAt: 2_000 },
      'run-reused-pid': { runId, pid: 43, createdAt: 2_000 },
      'run-unreadable-start': { runId, pid: 44, createdAt: 2_000 },
    }[runId] ?? null) as never,
    isProcessAlive: (pid) => pid !== 42,
    processStartedAt: (pid) => ({ 41: 1_000, 43: 3_000, 44: null }[pid] ?? null),
  });

  expect(result.lingeringLaunchParents).toEqual({ observation: 'observed', count: 1, withoutPidCount: 1, uncountedCount: 1, reusedPidCount: 1 });
  expect(result.counts.running + result.counts['probable-running']).toBe(0);
  expect(renderRunningRuns(result)).toContain('lingering launch parents: 1 without pid: 1 uncounted: 1 reused pid: 1');
});

test('does not count a second-resolution process start whose interval overlaps the run creation instant', () => {
  const result = assessLingeringLaunchParents(
    [ledger('run-same-second', 'human-stopped')],
    (runId) => ({ runId, pid: 41, createdAt: 2_100 }) as never,
    () => true,
    () => 2_000,
    { unreadableLedgerCount: 0, unreadableLedgerDirectoryCount: 0, unreadableLedgerDirectoryAccessCount: 0, indeterminateLedgerDirectoryCount: 0 },
  );

  expect(result).toEqual({ observation: 'observed', count: 0, withoutPidCount: 0, uncountedCount: 1, reusedPidCount: 0 });
});

test('keeps missing ledger directories distinct from unreadable ledger observations for lingering-parent assessment', () => {
  const terminated = [ledger('run-terminated', 'terminal-run-status-superseded')];
  const queryWithDirectoryObservation = (observation: Pick<FederatedUnfinishedRunLedgerQuery, 'missingLedgerDirectoryCount' | 'unreadableLedgerDirectoryAccessCount' | 'indeterminateLedgerDirectoryCount'>) => queryRunningRuns({}, {
    queryLedgers: () => ({ entries: terminated, ledgerDirectories: [], goalsDirectory: '/goals', unreadableLedgerCount: 0, unreadableLedgerDirectoryCount: observation.missingLedgerDirectoryCount + observation.unreadableLedgerDirectoryAccessCount + observation.indeterminateLedgerDirectoryCount, reconciledTerminatedElsewhereCount: 0, scope: 'self-implement-run-ledger-federated', note: 'fixture', ...observation }),
    ptyTargets: () => [],
    listPtyRefs: () => ({ refs: [], unreadable: [] }),
    loadRun: (runId) => ({ runId, pid: 42, createdAt: 2_000 }) as never,
    isProcessAlive: () => true,
    processStartedAt: () => 1_000,
  });

  const missingOnly = queryWithDirectoryObservation({ missingLedgerDirectoryCount: 1, unreadableLedgerDirectoryAccessCount: 0, indeterminateLedgerDirectoryCount: 0 });
  const unreadablePresent = queryWithDirectoryObservation({ missingLedgerDirectoryCount: 0, unreadableLedgerDirectoryAccessCount: 1, indeterminateLedgerDirectoryCount: 0 });
  const indeterminatePresent = queryWithDirectoryObservation({ missingLedgerDirectoryCount: 0, unreadableLedgerDirectoryAccessCount: 0, indeterminateLedgerDirectoryCount: 1 });

  expect(missingOnly.lingeringLaunchParents).toEqual({ observation: 'observed', count: 1, withoutPidCount: 0, uncountedCount: 0, reusedPidCount: 0 });
  expect(unreadablePresent.lingeringLaunchParents).toEqual({ observation: 'indeterminate' });
  expect(indeterminatePresent.lingeringLaunchParents).toEqual({ observation: 'indeterminate' });
  expect(assessLingeringLaunchParents(terminated, () => ({ runId: 'run-terminated', pid: 42, createdAt: 2_000 }) as never, () => false, () => null)).toEqual({ observation: 'indeterminate' });
});

test('uses the maximum available PTY updatedAt for a run and null when none is available', () => {
  const result = assessRunningRuns([
    ledger('run-with-pty-times', 'live'),
    ledger('run-without-pty-times', 'live'),
  ], {
    refs: [
      { instance: 'prod', id: 'pty-earlier', kind: 'shell', alive: true, runId: 'run-with-pty-times', updatedAt: 100 },
      { instance: 'prod', id: 'pty-later', kind: 'shell', alive: true, runId: 'run-with-pty-times', updatedAt: 200 },
      { instance: 'prod', id: 'pty-unknown', kind: 'shell', alive: true, runId: 'run-without-pty-times' },
    ],
    unreadable: [],
  });

  expect(result.entries).toEqual([
    expect.objectContaining({ runId: 'run-with-pty-times', ptyUpdatedAt: 200 }),
    expect.objectContaining({ runId: 'run-without-pty-times', ptyUpdatedAt: null }),
  ]);
});

test('uses the latest valid ledger activity timestamp independently of ledger entry order', () => {
  const entries = [
    ledger('run-multiple-ledgers', 'live', '/prod/run-multiple-ledgers', '2026-08-16T00:00:01.000Z'),
    ledger('run-multiple-ledgers', 'orphaned', '/test/run-multiple-ledgers', '2026-08-16T00:00:03.000Z'),
    ledger('run-multiple-ledgers', 'orphaned', '/other/run-multiple-ledgers', 'not-a-timestamp'),
  ];
  const pty = { refs: [{ instance: 'prod', id: 'pty-multiple', kind: 'shell' as const, alive: true, runId: 'run-multiple-ledgers' }], unreadable: [] };

  for (const observedLedgers of [entries, [...entries].reverse()]) {
    expect(assessRunningRuns(observedLedgers, pty).entries).toEqual([
      expect.objectContaining({
        runId: 'run-multiple-ledgers', status: 'running', lifecycle: 'live', lastActivityTimestamp: '2026-08-16T00:00:03.000Z',
      }),
    ]);
  }
});

test('reports unreadable PTY observation as unknown rather than probable', () => {
  const result = assessRunningRuns([ledger('run-live-unreadable', 'live')], { refs: [], unreadable: ['test:isolated'] });
  expect(result.entries).toEqual([expect.objectContaining({ runId: 'run-live-unreadable', status: 'unknown', presence: 'pty-observation-unreadable', reason: 'pty-query-unreadable' })]);
  expect(result.counts.running).toBe(0);
  expect(result.counts['probable-running']).toBe(0);
});

test('uses unreadable ledger files, not absent candidate directories, for PTY-only query failures', () => {
  const pty = {
    refs: [{ instance: 'prod', id: 'pty-observed', kind: 'shell' as const, alive: true, runId: 'run-ledger-unreadable' }],
    unreadable: [],
  };
  const missingDirectoryResult = assessRunningRuns([], pty, { unreadableLedgerCount: 0, unreadableLedgerDirectoryCount: 3, missingLedgerDirectoryCount: 3, unreadableLedgerDirectoryAccessCount: 0, indeterminateLedgerDirectoryCount: 0 });
  const unreadableLedgerResult = assessRunningRuns([], pty, { unreadableLedgerCount: 1, unreadableLedgerDirectoryCount: 3, missingLedgerDirectoryCount: 3, unreadableLedgerDirectoryAccessCount: 0, indeterminateLedgerDirectoryCount: 0 });

  expect(missingDirectoryResult.entries).toEqual([expect.objectContaining({
    runId: 'run-ledger-unreadable', status: 'unknown', reason: 'pty-without-unfinished-ledger',
  })]);
  expect(missingDirectoryResult.ledger).toEqual({
    ledgerDirectories: [], unreadableLedgerCount: 0, unreadableLedgerDirectoryCount: 3,
    missingLedgerDirectoryCount: 3, unreadableLedgerDirectoryAccessCount: 0, indeterminateLedgerDirectoryCount: 0,
  });
  expect(renderRunningRuns(missingDirectoryResult)).toContain('unreadable ledger directories: 3 missing ledger directories: 3 unreadable ledger directory accesses: 0 indeterminate ledger directories: 0');
  expect(unreadableLedgerResult.entries).toEqual([expect.objectContaining({
    runId: 'run-ledger-unreadable', status: 'unknown', reason: 'ledger-query-unreadable-pty-observed',
  })]);
  expect(unreadableLedgerResult.counts).toEqual({ running: 0, 'probable-running': 0, 'ended-unclosed': 0, unknown: 1 });
});

test('passes includeTest consistently to the injected ledger and PTY target readers', () => {
  const includes: boolean[] = [];
  const federatedLedger = (options: { includeTest?: boolean }): FederatedUnfinishedRunLedgerQuery => {
    includes.push(Boolean(options.includeTest));
    return {
      entries: [], ledgerDirectories: [], goalsDirectory: '/goals', unreadableLedgerCount: 0, unreadableLedgerDirectoryCount: 0,
      reconciledTerminatedElsewhereCount: 0, scope: 'self-implement-run-ledger-federated', note: 'fixture',
      missingLedgerDirectoryCount: 0, unreadableLedgerDirectoryAccessCount: 0, indeterminateLedgerDirectoryCount: 0,
    };
  };
  const targets = (options: { includeTest?: boolean }) => {
    includes.push(Boolean(options.includeTest));
    return [];
  };

  const pty = { refs: [{ instance: 'prod', id: 'pty-live', kind: 'shell' as const, alive: true, runId: 'run-live' }], unreadable: [] };
  const deps = { queryLedgers: federatedLedger, ptyTargets: targets, listPtyRefs: () => pty };
  const withoutTest = queryRunningRuns({}, deps);
  const withTest = queryRunningRuns({ includeTest: true }, deps);

  expect(includes).toEqual([false, false, true, true]);
  expect(withoutTest.observation).toEqual({ runsNotYetInLedgerDuringAuthoringAreNotCounted: true, includesTest: false });
  expect(withTest.observation).toEqual({ runsNotYetInLedgerDuringAuthoringAreNotCounted: true, includesTest: true });
  expect(withoutTest.counts).toEqual(withTest.counts);
  expect(withoutTest.entries.map(({ runId, status, presence, reason, lifecycle }) => ({ runId, status, presence, reason, lifecycle }))).toEqual(withTest.entries.map(({ runId, status, presence, reason, lifecycle }) => ({ runId, status, presence, reason, lifecycle })));
  expect(withoutTest.quantities.counts.value).toEqual(withoutTest.counts);
  expect(withoutTest.quantities.total.value).toBe(withoutTest.total);
  expect(withoutTest.quantities.entries.value).toBe(withoutTest.entries.length);
  expect(withoutTest.quantities.running).toEqual({
    value: withoutTest.counts.running + withoutTest.counts['probable-running'],
    population: 'assessed runs whose status is in countedStatuses',
    observation: withoutTest.observation,
  });
  expect(withoutTest.pty).toMatchObject({ observedRefCount: 1, withoutRunIdCount: 0, notCountedRefCount: 1 });
  expect(withTest.pty).toMatchObject({ observedRefCount: 1, withoutRunIdCount: 0, notCountedRefCount: 1 });
  expect(withoutTest.quantities.total.observation.includesTest).toBe(false);
  expect(withTest.quantities.total.observation.includesTest).toBe(true);
  expect(renderRunningRuns(withoutTest)).toContain('observation limit: runs still in the post-launch authoring window and not yet recorded in the run ledger are not counted');
  expect(renderRunningRuns(withoutTest)).toContain('observation scope: isolated test universes excluded');
  expect(renderRunningRuns(withTest)).toContain('observation scope: isolated test universes included');
  expect(renderRunningRuns(withoutTest).split('\n').slice(-5).join('\n')).toContain('quantity scope: running=0 population=assessed runs whose status is in countedStatuses; total=1 entries=1 population=all assessed runs; isolated test universes excluded');
  expect(renderRunningRuns(withoutTest).split('\n').slice(-5).join('\n')).toContain('quantity limit: runs still in the post-launch authoring window and not yet recorded in the run ledger are not counted');
});

test('query reaches terminal evidence through the federated post-terminal activity ledger path', () => {
  const root = mkdtempSync(join(tmpdir(), 'running-runs-post-terminal-federated-'));
  const stateRoot = join(root, 'state');
  const ledgerDirectory = join(stateRoot, 'run-ledger');
  const runId = 'run-00000000-0000-4000-8000-00000000f001';
  mkdirSync(ledgerDirectory, { recursive: true });
  writeFileSync(join(ledgerDirectory, `${runId}.jsonl`), [
    JSON.stringify({ timestamp: '2026-08-16T00:00:00.000Z', runId, event: 'start', data: {} }),
    JSON.stringify({ timestamp: '2026-08-16T00:01:00.000Z', runId, event: 'run-status', data: { runStatus: 'failed' } }),
    JSON.stringify({ timestamp: '2026-08-16T00:02:00.000Z', runId, event: 'rework', data: {} }),
    JSON.stringify({ timestamp: '2026-08-16T00:03:00.000Z', runId, event: 'progress-delivery-outcome', data: {} }),
  ].join('\n') + '\n', 'utf8');
  try {
    const result = queryRunningRuns({}, {
      queryLedgers: () => queryFederatedUnfinishedRunLedgers({
        goalsDir: root,
        targets: [{ name: 'fixture', dbPath: join(stateRoot, 'mss', 'logs.db') }],
      }),
      ptyTargets: () => [],
      listPtyRefs: () => ({ refs: [{ instance: 'fixture', id: 'pty-post-terminal', kind: 'shell' as const, alive: true, runId }], unreadable: [] }),
    });

    expect(result.entries).toEqual([expect.objectContaining({
      runId, status: 'ended-unclosed', presence: 'ledger-and-pty-observed', ledgerDirectories: [ledgerDirectory], lifecycle: 'terminal-run-status-superseded',
    })]);
    expect(result.ledger.ledgerDirectories).toEqual([ledgerDirectory]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('query maps a restarted post-status ledger with a live PTY to running', () => {
  const root = mkdtempSync(join(tmpdir(), 'running-runs-restarted-federated-'));
  const stateRoot = join(root, 'state');
  const ledgerDirectory = join(stateRoot, 'run-ledger');
  const runId = 'run-00000000-0000-4000-8000-00000000f002';
  const now = Date.now();
  mkdirSync(ledgerDirectory, { recursive: true });
  writeFileSync(join(ledgerDirectory, `${runId}.jsonl`), [
    JSON.stringify({ timestamp: new Date(now - 4 * 60_000).toISOString(), runId, event: 'start', data: {} }),
    JSON.stringify({ timestamp: new Date(now - 3 * 60_000).toISOString(), runId, event: 'run-status', data: { runStatus: 'failed' } }),
    JSON.stringify({ timestamp: new Date(now - 2 * 60_000).toISOString(), runId, event: 'start', data: {} }),
    JSON.stringify({ timestamp: new Date(now - 60_000).toISOString(), runId, event: 'progress-delivery-outcome', data: {} }),
  ].join('\n') + '\n', 'utf8');
  try {
    const result = queryRunningRuns({}, {
      queryLedgers: () => queryFederatedUnfinishedRunLedgers({
        goalsDir: root,
        targets: [{ name: 'fixture', dbPath: join(stateRoot, 'mss', 'logs.db') }],
      }),
      ptyTargets: () => [],
      listPtyRefs: () => ({ refs: [{ instance: 'fixture', id: 'pty-restarted', kind: 'shell' as const, alive: true, runId }], unreadable: [] }),
    });

    expect(result.entries).toEqual([expect.objectContaining({
      runId, status: 'running', presence: 'ledger-live-and-pty-observed', lifecycle: 'live', ledgerDirectories: [ledgerDirectory],
    })]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('query does not classify terminal statuses followed by headless.done activity as running', () => {
  const root = mkdtempSync(join(tmpdir(), 'running-runs-terminal-headless-done-'));
  const stateRoot = join(root, 'state');
  const ledgerDirectory = join(stateRoot, 'run-ledger');
  const runId = 'run-00000000-0000-4000-8000-00000000f003';
  mkdirSync(ledgerDirectory, { recursive: true });
  writeFileSync(join(ledgerDirectory, `${runId}.jsonl`), [
    JSON.stringify({ timestamp: '2026-08-16T00:00:00.000Z', runId, event: 'start', data: {} }),
    JSON.stringify({ timestamp: '2026-08-16T00:01:00.000Z', runId, event: 'run-status', data: { runStatus: 'failed', failureKind: 'timed-out' } }),
    JSON.stringify({ timestamp: '2026-08-16T00:02:00.000Z', runId, event: 'start', data: {} }),
    JSON.stringify({ timestamp: '2026-08-16T00:03:00.000Z', runId, event: 'run-status', data: { runStatus: 'failed', failureKind: 'crashed' } }),
    JSON.stringify({ timestamp: '2026-08-16T00:04:00.000Z', runId, event: 'headless.done', data: {} }),
  ].join('\n') + '\n', 'utf8');
  try {
    const result = queryRunningRuns({}, {
      queryLedgers: () => queryFederatedUnfinishedRunLedgers({
        goalsDir: root,
        targets: [{ name: 'fixture', dbPath: join(stateRoot, 'mss', 'logs.db') }],
      }),
      ptyTargets: () => [],
      listPtyRefs: () => ({ refs: [{ instance: 'fixture', id: 'pty-terminal', kind: 'shell' as const, alive: true, runId }], unreadable: [] }),
    });

    expect(result.entries).toEqual([expect.objectContaining({
      runId, status: 'ended-unclosed', presence: 'ledger-and-pty-observed', lifecycle: 'terminal-run-status-superseded', ledgerDirectories: [ledgerDirectory],
    })]);
    expect(result.counts).toMatchObject({ running: 0, 'probable-running': 0, 'ended-unclosed': 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('query retains a post-terminal ledger for the existing terminal-evidence PTY branch', () => {
  const runId = 'run-post-terminal-activity';
  const ledgerDirectory = '/state/run-post-terminal-activity';
  const deps = {
    queryLedgers: (): FederatedUnfinishedRunLedgerQuery => ({
      entries: [ledger(runId, 'terminal-other-vocabulary', ledgerDirectory, '2026-08-16T00:03:00.000Z')],
      ledgerDirectories: [ledgerDirectory], goalsDirectory: '/goals', unreadableLedgerCount: 0, unreadableLedgerDirectoryCount: 0,
      reconciledTerminatedElsewhereCount: 0, scope: 'self-implement-run-ledger-federated', note: 'fixture',
      missingLedgerDirectoryCount: 0, unreadableLedgerDirectoryAccessCount: 0, indeterminateLedgerDirectoryCount: 0,
    }),
    ptyTargets: () => [],
    listPtyRefs: () => ({ refs: [{ instance: 'prod', id: 'pty-post-terminal', kind: 'shell' as const, alive: true, runId }], unreadable: [] }),
  };

  const result = queryRunningRuns({}, deps);

  expect(result.entries).toEqual([expect.objectContaining({
    runId, status: 'ended-unclosed', presence: 'ledger-and-pty-observed', ledgerDirectories: [ledgerDirectory],
  })]);
  expect(result.ledger.ledgerDirectories).toEqual([ledgerDirectory]);
});

test('query preserves PTYs without a runId separately from an empty observation', () => {
  const deps = {
    queryLedgers: (): FederatedUnfinishedRunLedgerQuery => ({
      entries: [], ledgerDirectories: [], goalsDirectory: '/goals', unreadableLedgerCount: 0, unreadableLedgerDirectoryCount: 0,
      reconciledTerminatedElsewhereCount: 0, scope: 'self-implement-run-ledger-federated', note: 'fixture',
      missingLedgerDirectoryCount: 0, unreadableLedgerDirectoryAccessCount: 0, indeterminateLedgerDirectoryCount: 0,
    }),
    ptyTargets: () => [],
    listPtyRefs: () => ({ refs: [{ instance: 'prod', id: 'pty-query-missing-run-id', kind: 'shell' as const, alive: true }], unreadable: [] }),
  };
  const result = queryRunningRuns({}, deps);

  expect(result.pty).toMatchObject({ observedRefCount: 1, withoutRunIdCount: 1, notCountedRefCount: 0 });
  expect(renderRunningRuns(result)).toContain('observed live ptys: 1 without runId: 1 not counted as running: 0');
});

test('reports observed PTYs without a runId separately from an empty observation', () => {
  const empty = assessRunningRuns([], { refs: [], unreadable: [] });
  const missingRunIds = assessRunningRuns([], {
    refs: [
      { instance: 'prod', id: 'pty-empty-run-id', kind: 'shell', alive: true, runId: '' },
      { instance: 'prod', id: 'pty-missing-run-id', kind: 'shell', alive: true },
    ],
    unreadable: [],
  });

  expect(empty.pty).toMatchObject({ observedRefCount: 0, withoutRunIdCount: 0, notCountedRefCount: 0 });
  expect(missingRunIds.pty).toMatchObject({ observedRefCount: 2, withoutRunIdCount: 2, notCountedRefCount: 0 });
  expect(renderRunningRuns(empty)).toContain('observed live ptys: 0 without runId: 0 not counted as running: 0');
  expect(renderRunningRuns(missingRunIds)).toContain('observed live ptys: 2 without runId: 2 not counted as running: 0');
});

test('reports observed joined PTYs excluded from the running headline', () => {
  const orphaned = assessRunningRuns([ledger('run-orphaned-pty', 'orphaned')], {
    refs: [{ instance: 'prod', id: 'pty-orphaned', kind: 'shell', alive: true, runId: 'run-orphaned-pty' }],
    unreadable: [],
  });
  const humanStopped = assessRunningRuns([ledger('run-human-stopped-pty', 'human-stopped')], {
    refs: [{ instance: 'prod', id: 'pty-human-stopped', kind: 'shell', alive: true, runId: 'run-human-stopped-pty' }],
    unreadable: [],
  });

  for (const result of [orphaned, humanStopped]) {
    expect(result.counts.running + result.counts['probable-running']).toBe(0);
    expect(result.pty).toMatchObject({ observedRefCount: 1, withoutRunIdCount: 0, notCountedRefCount: 1 });
    expect(renderRunningRuns(result)).toContain('running runs: 0 confirmed: 0 probable: 0 countedStatuses=running,probable-running');
    expect(renderRunningRuns(result)).toContain('observed live ptys: 1 without runId: 0 not counted as running: 1');
  }
  expect(orphaned.entries).toEqual([expect.objectContaining({ status: 'unknown', ptyRefs: [{ instance: 'prod', id: 'pty-orphaned', kind: 'shell' }] })]);
  expect(humanStopped.entries).toEqual([expect.objectContaining({ status: 'ended-unclosed', ptyRefs: [{ instance: 'prod', id: 'pty-human-stopped', kind: 'shell' }] })]);
});

test('pairs empty assessment quantities with the unknown direct-assessment scope', () => {
  const result = assessRunningRuns([], { refs: [], unreadable: [] });

  expect(result.counts).toEqual({ running: 0, 'probable-running': 0, 'ended-unclosed': 0, unknown: 0 });
  expect(result.total).toBe(0);
  expect(result.quantities).toEqual({
    counts: { value: result.counts, population: 'all assessed runs', observation: result.observation },
    total: { value: 0, population: 'all assessed runs', observation: result.observation },
    entries: { value: 0, population: 'all assessed runs', observation: result.observation },
    running: { value: 0, population: 'assessed runs whose status is in countedStatuses', observation: result.observation },
  });
  expect(renderRunningRuns(result).split('\n').slice(-2)).toEqual([
    'quantity scope: running=0 population=assessed runs whose status is in countedStatuses; total=0 entries=0 population=all assessed runs; isolated test universes unknown',
    'quantity limit: runs still in the post-launch authoring window and not yet recorded in the run ledger are not counted',
  ]);
});

test('reports each running run latest observed phase without changing its status assessment', () => {
  const deps = {
    queryLedgers: (): FederatedUnfinishedRunLedgerQuery => ({
      entries: [ledger('run-awaiting', 'live'), ledger('run-implementing', 'live')], ledgerDirectories: [], goalsDirectory: '/goals', unreadableLedgerCount: 0, unreadableLedgerDirectoryCount: 0,
      reconciledTerminatedElsewhereCount: 0, scope: 'self-implement-run-ledger-federated', note: 'fixture',
      missingLedgerDirectoryCount: 0, unreadableLedgerDirectoryAccessCount: 0, indeterminateLedgerDirectoryCount: 0,
    }),
    ptyTargets: () => [],
    listPtyRefs: () => ({ refs: [
      { instance: 'prod', id: 'pty-awaiting', kind: 'shell' as const, alive: true, runId: 'run-awaiting' },
      { instance: 'prod', id: 'pty-implementing', kind: 'shell' as const, alive: true, runId: 'run-implementing' },
    ], unreadable: [] }),
    readRunPhases: () => ({ events: [
      { runId: 'run-awaiting', phase: 'implementing', observedAt: '2026-09-12T07:05:07.000Z' },
      { runId: 'run-awaiting', phase: 'awaiting-clarification', observedAt: '2026-09-12T07:05:08.000Z' },
      { runId: 'run-implementing', phase: 'implementing', observedAt: '2026-09-12T07:05:09.000Z' },
    ], targetCount: 1, unreadableTargets: [] }),
  };

  const result = queryRunningRuns({}, deps);

  expect(result.entries).toEqual([
    expect.objectContaining({ runId: 'run-awaiting', status: 'running', presence: 'ledger-live-and-pty-observed', reason: 'ledger-live-and-pty-alive', lifecycle: 'live', phaseObservation: 'observed', lastPhase: 'awaiting-clarification', lastPhaseObservedAt: '2026-09-12T07:05:08.000Z' }),
    expect.objectContaining({ runId: 'run-implementing', status: 'running', presence: 'ledger-live-and-pty-observed', reason: 'ledger-live-and-pty-alive', lifecycle: 'live', phaseObservation: 'observed', lastPhase: 'implementing', lastPhaseObservedAt: '2026-09-12T07:05:09.000Z' }),
  ]);
  expect(renderRunningRuns(result)).toContain('runId=run-awaiting status=running presence=ledger-live-and-pty-observed reason=ledger-live-and-pty-alive lifecycle=live lastActivity=null phaseObservation=observed lastPhase=awaiting-clarification lastPhaseObservedAt=2026-09-12T07:05:08.000Z');
});

test('retains readable phase events when one of three phase stores cannot be opened', () => {
  const rows = (runId: string, event: string, ts: string): readonly Pick<LogStoreRow, 'data' | 'event' | 'ts'>[] => [
    { data: JSON.stringify({ runId }), event, ts },
  ];
  const observed = collectObservedRunPhases([
    { name: 'first', dbPath: '/first.db' },
    { name: 'missing', dbPath: '/missing.db' },
    { name: 'last', dbPath: '/last.db' },
  ], ['run-live'], (dbPath) => {
    if (dbPath === '/missing.db') throw new Error('unable to open database file');
    const storeRows = dbPath === '/first.db'
      ? rows('run-live', 'implementing', '2026-09-12T07:05:07.000Z')
      : rows('run-live', 'reviewing', '2026-09-12T07:05:08.000Z');
    return {
      queryByDataKeys: () => storeRows,
      close: () => {},
    } as unknown as Pick<LogStore, 'queryByDataKeys' | 'close'>;
  });
  const result = queryRunningRuns({}, {
    queryLedgers: () => ({ entries: [ledger('run-live', 'live')], ledgerDirectories: [], goalsDirectory: '/goals', unreadableLedgerCount: 0, unreadableLedgerDirectoryCount: 0, reconciledTerminatedElsewhereCount: 0, scope: 'self-implement-run-ledger-federated', note: 'fixture', missingLedgerDirectoryCount: 0, unreadableLedgerDirectoryAccessCount: 0, indeterminateLedgerDirectoryCount: 0 }),
    ptyTargets: () => [],
    listPtyRefs: () => ({ refs: [{ instance: 'prod', id: 'pty-live', kind: 'shell' as const, alive: true, runId: 'run-live' }], unreadable: [] }),
    readRunPhases: () => observed,
  });

  expect(observed).toEqual({ events: [
    { runId: 'run-live', phase: 'implementing', observedAt: '2026-09-12T07:05:07.000Z' },
    { runId: 'run-live', phase: 'reviewing', observedAt: '2026-09-12T07:05:08.000Z' },
  ], targetCount: 3, unreadableTargets: ['missing'], discardedNonStageEventCount: 0 });
  expect(result.phases).toEqual({ targetCount: 3, readableTargetCount: 2, unreadableTargetCount: 1, unreadableTargets: ['missing'], discardedNonStageEventCount: 0 });
  expect(result.entries).toEqual([expect.objectContaining({ phaseObservation: 'partially-unreadable', lastPhase: 'reviewing', lastPhaseObservedAt: '2026-09-12T07:05:08.000Z' })]);
  expect(renderRunningRuns(result)).toContain('phase stores: 3 readable: 2 unreadable: 1 unreadable targets: missing');
});

test('uses producer stage SSoT and discards later non-stage events without making phase observation unreadable', () => {
  const stagedRunId = 'run-staged';
  const noiseOnlyRunId = 'run-noise-only';
  const rows = [
    ...SELF_IMPLEMENT_PROGRESS_STAGES.map((phase, index) => ({ data: JSON.stringify({ runId: stagedRunId }), event: phase, ts: `2026-09-12T07:05:${String(index).padStart(2, '0')}.000Z` })),
    { data: JSON.stringify({ runId: stagedRunId }), event: 'headless.progress', ts: '2026-09-12T07:06:00.000Z' },
    { data: JSON.stringify({ runId: stagedRunId }), event: 'implement.result', ts: '2026-09-12T07:06:01.000Z' },
    { data: JSON.stringify({ runId: noiseOnlyRunId }), event: 'poll.heartbeat', ts: '2026-09-12T07:06:02.000Z' },
  ];
  const observed = collectObservedRunPhases([{ name: 'fixture', dbPath: '/fixture.db' }], [stagedRunId, noiseOnlyRunId], () => ({
    queryByDataKeys: () => rows,
    close: () => {},
  }) as unknown as Pick<LogStore, 'queryByDataKeys' | 'close'>);
  const result = queryRunningRuns({}, {
    queryLedgers: () => ({ entries: [ledger(stagedRunId, 'live'), ledger(noiseOnlyRunId, 'live')], ledgerDirectories: [], goalsDirectory: '/goals', unreadableLedgerCount: 0, unreadableLedgerDirectoryCount: 0, reconciledTerminatedElsewhereCount: 0, scope: 'self-implement-run-ledger-federated', note: 'fixture', missingLedgerDirectoryCount: 0, unreadableLedgerDirectoryAccessCount: 0, indeterminateLedgerDirectoryCount: 0 }),
    ptyTargets: () => [],
    listPtyRefs: () => ({ refs: [
      { instance: 'prod', id: 'pty-staged', kind: 'shell' as const, alive: true, runId: stagedRunId },
      { instance: 'prod', id: 'pty-noise-only', kind: 'shell' as const, alive: true, runId: noiseOnlyRunId },
    ], unreadable: [] }),
    readRunPhases: () => observed,
  });

  expect(observed.events.map((event) => event.phase)).toEqual([...SELF_IMPLEMENT_PROGRESS_STAGES]);
  expect(observed.discardedNonStageEventCount).toBe(3);
  expect(result.entries).toEqual([
    expect.objectContaining({ runId: noiseOnlyRunId, phaseObservation: 'not-observed', lastPhase: null, lastPhaseObservedAt: null }),
    expect.objectContaining({ runId: stagedRunId, phaseObservation: 'observed', lastPhase: SELF_IMPLEMENT_PROGRESS_STAGES.at(-1), lastPhaseObservedAt: `2026-09-12T07:05:${String(SELF_IMPLEMENT_PROGRESS_STAGES.length - 1).padStart(2, '0')}.000Z` }),
  ]);
  expect(result.phases).toEqual(expect.objectContaining({ discardedNonStageEventCount: 3 }));
  expect(renderRunningRuns(result)).toContain('non-stage events discarded: 3');
});

test('distinguishes partial and complete phase-store failures', () => {
  const queryLedgers = (): FederatedUnfinishedRunLedgerQuery => ({ entries: [ledger('run-live', 'live')], ledgerDirectories: [], goalsDirectory: '/goals', unreadableLedgerCount: 0, unreadableLedgerDirectoryCount: 0, reconciledTerminatedElsewhereCount: 0, scope: 'self-implement-run-ledger-federated', note: 'fixture', missingLedgerDirectoryCount: 0, unreadableLedgerDirectoryAccessCount: 0, indeterminateLedgerDirectoryCount: 0 });
  const shared = { queryLedgers, ptyTargets: () => [], listPtyRefs: () => ({ refs: [{ instance: 'prod', id: 'pty-live', kind: 'shell' as const, alive: true, runId: 'run-live' }], unreadable: [] }) };
  const partial = queryRunningRuns({}, { ...shared, readRunPhases: () => ({ events: [], targetCount: 3, unreadableTargets: ['missing'] }) });
  const unreadable = queryRunningRuns({}, { ...shared, readRunPhases: () => ({ events: [], targetCount: 3, unreadableTargets: ['first', 'middle', 'last'] }) });

  expect(partial.entries).toEqual([expect.objectContaining({ phaseObservation: 'partially-unreadable', lastPhase: null })]);
  expect(unreadable.entries).toEqual([expect.objectContaining({ phaseObservation: 'unreadable', lastPhase: null })]);
  expect(partial.phases?.unreadableTargetCount).toBe(1);
  expect(unreadable.phases?.unreadableTargetCount).toBe(3);
});

test('passes provided runIds to the ledger query and leaves an omitted list unscoped', () => {
  const received: Array<{ includeTest?: boolean; ledgerDirectories?: readonly string[]; runIds?: readonly string[] }> = [];
  const queryLedgers = (options: { includeTest?: boolean; ledgerDirectories?: readonly string[]; runIds?: readonly string[] }): FederatedUnfinishedRunLedgerQuery => {
    received.push(options);
    return { entries: [], ledgerDirectories: [], goalsDirectory: '/goals', unreadableLedgerCount: 0, unreadableLedgerDirectoryCount: 0, reconciledTerminatedElsewhereCount: 0, scope: 'self-implement-run-ledger-federated', note: 'fixture', missingLedgerDirectoryCount: 0, unreadableLedgerDirectoryAccessCount: 0, indeterminateLedgerDirectoryCount: 0 };
  };
  const shared = { queryLedgers, ptyTargets: () => [], listPtyRefs: () => ({ refs: [], unreadable: [] }) };

  queryRunningRuns({ runIds: ['run-a', 'run-b'] }, shared);
  queryRunningRuns({}, shared);

  expect(received[0]?.runIds).toEqual(['run-a', 'run-b']);
  expect(received[1]).not.toHaveProperty('runIds');
});

test('preserves the injected ledger query contract without adding collected live directories', () => {
  const queryLedgers = (options: { includeTest?: boolean; ledgerDirectories?: readonly string[] }): FederatedUnfinishedRunLedgerQuery => {
    expect(options).toEqual({ includeTest: undefined });
    return { entries: [], ledgerDirectories: [], goalsDirectory: '/goals', unreadableLedgerCount: 0, unreadableLedgerDirectoryCount: 0, reconciledTerminatedElsewhereCount: 0, scope: 'self-implement-run-ledger-federated', note: 'fixture', missingLedgerDirectoryCount: 0, unreadableLedgerDirectoryAccessCount: 0, indeterminateLedgerDirectoryCount: 0 };
  };

  const result = queryRunningRuns({}, {
    queryLedgers,
    ptyTargets: () => [],
    listPtyRefs: () => ({ refs: [], unreadable: [] }),
  });

  expect(result.total).toBe(0);
});

function withControlledClock<T>(run: (advance: (elapsedMs: number) => void) => T): T {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    return run((elapsedMs) => { now += elapsedMs; });
  } finally {
    Date.now = originalNow;
  }
}

test('emits one query observation with exact timing and existing scale fields', () => {
  const observations: unknown[] = [];
  const result = withControlledClock((advance) => queryRunningRuns({}, {
    ledgerDirectories: () => { advance(11); return ['/ledger-a', '/ledger-excluded']; },
    queryLedgers: (options) => {
      expect(options.ledgerDirectories).toEqual(['/ledger-a', '/ledger-excluded']);
      advance(13);
      return { entries: [ledger('run-live', 'live'), ledger('run-ended', 'human-stopped')], ledgerDirectories: ['/ledger-a'], goalsDirectory: '/goals', unreadableLedgerCount: 0, unreadableLedgerDirectoryCount: 0, reconciledTerminatedElsewhereCount: 0, scope: 'self-implement-run-ledger-federated', note: 'fixture', missingLedgerDirectoryCount: 0, unreadableLedgerDirectoryAccessCount: 0, indeterminateLedgerDirectoryCount: 0 };
    },
    ptyTargets: () => { advance(2); return []; },
    listPtyRefs: () => { advance(17); return { refs: [{ instance: 'prod', id: 'pty-live', kind: 'shell' as const, alive: true, runId: 'run-live' }], unreadable: [] }; },
    readRunPhases: () => { advance(23); return { events: [], targetCount: 3, unreadableTargets: [], discardedNonStageEventCount: 4 }; },
    loadRun: () => { advance(29); return null; },
    observeQuery: (observation) => observations.push(observation),
  }));

  expect(result.total).toBe(2);
  expect(observations).toEqual([{
    caller: null,
    cacheHits: 0,
    cacheMisses: 0,
    elapsedMs: 95,
    ledgerDirectoryCollectionElapsedMs: 11,
    ledgerReadElapsedMs: 13,
    screenProcessReadElapsedMs: 19,
    stageStoreReadElapsedMs: 23,
    launchParentClassificationElapsedMs: 29,
    ledgerDirectoryCount: 1,
    ledgerEntryCount: 2,
    stageStoreCount: 3,
    discardedNonStageEventCount: 4,
  }]);
});

test('attributes running-run query logs to the caller and forwards cache diagnostics without changing assessments', () => {
  const observations: unknown[] = [];
  const received: unknown[] = [];
  const deps = {
    queryLedgers: (options: { noCache?: boolean }) => {
      received.push(options);
      return { entries: [ledger('run-live', 'live')], ledgerDirectories: [], goalsDirectory: '/goals', unreadableLedgerCount: 0, unreadableLedgerDirectoryCount: 0, reconciledTerminatedElsewhereCount: 0, scope: 'self-implement-run-ledger-federated' as const, note: 'fixture', missingLedgerDirectoryCount: 0, unreadableLedgerDirectoryAccessCount: 0, indeterminateLedgerDirectoryCount: 0, cacheHits: 52, cacheMisses: 0 };
    },
    ptyTargets: () => [],
    listPtyRefs: () => ({ refs: [], unreadable: [] }),
    readRunPhases: () => ({ events: [], targetCount: 0, unreadableTargets: [] }),
    observeQuery: (observation: unknown) => observations.push(observation),
  };
  const named = queryRunningRuns({ caller: 'nexus.terminals', noCache: true }, deps);
  const unnamed = queryRunningRuns({}, deps);
  expect(named.entries).toEqual(unnamed.entries);
  expect(named.counts).toEqual(unnamed.counts);
  expect(named.ledger).toMatchObject({ cacheHits: 52, cacheMisses: 0 });
  expect(received[0]).toMatchObject({ noCache: true });
  expect(received[1]).not.toHaveProperty('noCache');
  expect(observations).toEqual([
    expect.objectContaining({ caller: 'nexus.terminals', cacheHits: 52, cacheMisses: 0 }),
    expect.objectContaining({ caller: null, cacheHits: 52, cacheMisses: 0 }),
  ]);
});

test('writes caller and null to running-runs query log', () => {
  const originalLog = debug.log;
  const logged: unknown[] = [];
  try {
    (debug as { log: typeof debug.log }).log = ((category, event, data) => {
      if (category === 'self-implement.running-runs' && event === 'query') logged.push(data);
    }) as typeof debug.log;
    const deps = {
      queryLedgers: () => ({ entries: [], ledgerDirectories: [], goalsDirectory: '/goals', unreadableLedgerCount: 0, unreadableLedgerDirectoryCount: 0, reconciledTerminatedElsewhereCount: 0, scope: 'self-implement-run-ledger-federated' as const, note: 'fixture', missingLedgerDirectoryCount: 0, unreadableLedgerDirectoryAccessCount: 0, indeterminateLedgerDirectoryCount: 0, cacheHits: 52, cacheMisses: 0 }),
      ptyTargets: () => [],
      listPtyRefs: () => ({ refs: [], unreadable: [] }),
      readRunPhases: () => ({ events: [], targetCount: 0, unreadableTargets: [] }),
    };
    queryRunningRuns({ caller: 'nexus.terminals' }, deps);
    queryRunningRuns({}, deps);
    expect(logged).toEqual([
      expect.objectContaining({ caller: 'nexus.terminals', cacheHits: 52, cacheMisses: 0 }),
      expect.objectContaining({ caller: null, cacheHits: 52, cacheMisses: 0 }),
    ]);
  } finally {
    (debug as { log: typeof debug.log }).log = originalLog;
  }
});

test('emits exact timing through a failing query stage while preserving the original exception', () => {
  const observations: unknown[] = [];
  const queryError = new Error('screen process unavailable');
  let received: unknown;
  withControlledClock((advance) => {
    try {
      queryRunningRuns({}, {
        ledgerDirectories: () => { advance(11); return ['/ledger']; },
        queryLedgers: () => { advance(13); return { entries: [], ledgerDirectories: ['/ledger'], goalsDirectory: '/goals', unreadableLedgerCount: 0, unreadableLedgerDirectoryCount: 0, reconciledTerminatedElsewhereCount: 0, scope: 'self-implement-run-ledger-federated', note: 'fixture', missingLedgerDirectoryCount: 0, unreadableLedgerDirectoryAccessCount: 0, indeterminateLedgerDirectoryCount: 0 }; },
        ptyTargets: () => { advance(17); throw queryError; },
        observeQuery: (observation) => observations.push(observation),
      });
    } catch (error) {
      received = error;
    }
  });

  expect(received).toBe(queryError);
  expect(observations).toEqual([{
    caller: null,
    cacheHits: 0,
    cacheMisses: 0,
    elapsedMs: 41,
    ledgerDirectoryCollectionElapsedMs: 11,
    ledgerReadElapsedMs: 13,
    screenProcessReadElapsedMs: 17,
    stageStoreReadElapsedMs: 0,
    launchParentClassificationElapsedMs: 0,
    ledgerDirectoryCount: 1,
    ledgerEntryCount: 0,
    stageStoreCount: 0,
    discardedNonStageEventCount: 0,
  }]);
});

test('keeps query results and original query errors unchanged when observation writing fails', () => {
  const shared = {
    ledgerDirectories: () => ['/ledger'],
    queryLedgers: () => ({ entries: [ledger('run-live', 'live')], ledgerDirectories: ['/ledger'], goalsDirectory: '/goals', unreadableLedgerCount: 0, unreadableLedgerDirectoryCount: 0, reconciledTerminatedElsewhereCount: 0, scope: 'self-implement-run-ledger-federated' as const, note: 'fixture', missingLedgerDirectoryCount: 0, unreadableLedgerDirectoryAccessCount: 0, indeterminateLedgerDirectoryCount: 0 }),
    ptyTargets: () => [],
    listPtyRefs: () => ({ refs: [{ instance: 'prod', id: 'pty-live', kind: 'shell' as const, alive: true, runId: 'run-live' }], unreadable: [] }),
    readRunPhases: () => ({ events: [], targetCount: 0, unreadableTargets: [], discardedNonStageEventCount: 0 }),
  };
  const expected = queryRunningRuns({}, { ...shared, observeQuery: () => {} });
  const observed = queryRunningRuns({}, { ...shared, observeQuery: () => { throw new Error('observation store unavailable'); } });
  const queryError = new Error('ledger unavailable');
  let received: unknown;
  try {
    queryRunningRuns({}, {
      ...shared,
      queryLedgers: () => { throw queryError; },
      observeQuery: () => { throw new Error('observation store unavailable'); },
    });
  } catch (error) {
    received = error;
  }

  expect(observed).toEqual(expected);
  expect(received).toBe(queryError);
});

test('distinguishes unreadable phase observation from no observed phase without changing status assessment', () => {
  const queryLedgers = (): FederatedUnfinishedRunLedgerQuery => ({
    entries: [ledger('run-live', 'live')], ledgerDirectories: [], goalsDirectory: '/goals', unreadableLedgerCount: 0, unreadableLedgerDirectoryCount: 0,
    reconciledTerminatedElsewhereCount: 0, scope: 'self-implement-run-ledger-federated', note: 'fixture',
    missingLedgerDirectoryCount: 0, unreadableLedgerDirectoryAccessCount: 0, indeterminateLedgerDirectoryCount: 0,
  });
  const shared = {
    queryLedgers,
    ptyTargets: () => [],
    listPtyRefs: () => ({ refs: [{ instance: 'prod', id: 'pty-live', kind: 'shell' as const, alive: true, runId: 'run-live' }], unreadable: [] }),
  };

  const notObserved = queryRunningRuns({}, { ...shared, readRunPhases: () => ({ events: [], targetCount: 1, unreadableTargets: [] }) });
  const unreadable = queryRunningRuns({}, { ...shared, readRunPhases: () => { throw new Error('logs unavailable'); } });

  expect(notObserved.entries).toEqual([expect.objectContaining({ status: 'running', presence: 'ledger-live-and-pty-observed', reason: 'ledger-live-and-pty-alive', lifecycle: 'live', phaseObservation: 'not-observed', lastPhase: null, lastPhaseObservedAt: null })]);
  expect(unreadable.entries).toEqual([expect.objectContaining({ status: 'running', presence: 'ledger-live-and-pty-observed', reason: 'ledger-live-and-pty-alive', lifecycle: 'live', phaseObservation: 'unreadable', lastPhase: null, lastPhaseObservedAt: null })]);
  expect(renderRunningRuns(unreadable)).toContain('phaseObservation=unreadable lastPhase=none lastPhaseObservedAt=none');
});
