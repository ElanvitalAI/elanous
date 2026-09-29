import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { GoalRunStore, withRecordOrigin, inspectGoalRun, loadGoalRunQuery, loadLatestGoalRunStatusByGoalFile, renderGoalRunInspection, renderGoalRunQuery, summarizePriorGoalTermination, type GoalLatestRunStatusDeps } from './goal-run-store.js';
import { queryFederatedUnfinishedRunLedgers, renderUnfinishedRunLedgers, type UnfinishedRunLedgerQuery } from './run-ledger.js';
import { LogStore } from '../mss/logging/log-store.js';
import { debug } from '../debug/log.js';
import type { GoalExecutionRecord } from './orchestrator.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function record(runId: string, outcome: 'completed' | 'abandoned' = 'completed'): GoalExecutionRecord {
  return { runId, stage: 'pr-opened', outcome, ok: outcome === 'completed', startedAt: '2026-08-08T00:00:00.000Z', rounds: 1, model: 'test-model' };
}

function store(): { store: GoalRunStore; goalFile: string } {
  const directory = mkdtempSync(join(tmpdir(), 'goal-run-store-'));
  directories.push(directory);
  const goalFile = join(directory, 'GOAL-test.txt');
  writeFileSync(goalFile, 'Test goal\n- GoalId: 0123456789abcdef\n');
  return { store: new GoalRunStore(join(directory, 'self-implement', 'goal-runs.db')), goalFile };
}

function unfinishedLedgerQuery(
  runIds: readonly string[] = [],
  unreadableLedgerCount = 0,
  goalDocumentPaths: Readonly<Record<string, string | null>> = {},
  lastActivityTimestamps: Readonly<Record<string, string>> = {},
): UnfinishedRunLedgerQuery {
  return {
    entries: runIds.map((runId) => ({
      runId,
      branch: null,
      status: 'terminal-status-missing' as const,
      plannedPaths: [],
      plannedPathStatus: 'unknown' as const,
      declaredPaths: [],
      declaredPathStatus: 'unknown' as const,
      pathMatchReasons: {},
      goalDocumentPath: goalDocumentPaths[runId] ?? null,
      goalDocumentSearchDirectory: null,
      lastActivityTimestamp: lastActivityTimestamps[runId] ?? null,
      lastActivityAgeMs: lastActivityTimestamps[runId] ? 0 : null,
      lastActivityStatus: lastActivityTimestamps[runId] ? 'available' as const : 'timestamp-missing' as const,
      lifecycle: 'unjudgeable' as const,
    })),
    ledgerDirectory: '/tmp/run-ledger',
    goalsDirectory: '/tmp/goals',
    unreadableLedgerCount,
    ledgerDirectoryMissing: false,
    scope: 'self-implement-run-ledger',
    note: 'test fixture',
  };
}

function latestStatusDeps(
  query: UnfinishedRunLedgerQuery,
  startedAtByRunId: Readonly<Record<string, string>> = {},
): GoalLatestRunStatusDeps {
  return {
    unfinishedRunLedgers: query,
    loadUnfinishedRunLedger: (runId) => [{
      runId,
      event: 'start',
      timestamp: startedAtByRunId[runId],
      data: {},
    }],
  };
}

function clarifyPendingGoalRows(rows: readonly string[]): readonly string[] {
  expect(rows.at(-1)).toMatch(/^summary: /);
  return rows.slice(0, -1).filter((row) => row !== 'now answerable:' && row !== 'past:');
}

describe('federated unfinished run ledgers', () => {
  test('reads every physical ledger directory, keeps source paths per row, and preserves path counters', () => {
    const root = mkdtempSync(join(tmpdir(), 'federated-unfinished-ledgers-'));
    directories.push(root);
    const goalsDir = join(root, 'docs', 'goals');
    const firstStateDir = join(root, 'first-state');
    const secondStateDir = join(root, 'second-state');
    const firstLedgerDir = join(firstStateDir, 'run-ledger');
    const secondLedgerDir = join(secondStateDir, 'run-ledger');
    const matchingGoal = join(goalsDir, 'GOAL-matching-a1b2c3d4-2026-08-10.txt');
    mkdirSync(firstLedgerDir, { recursive: true });
    mkdirSync(secondLedgerDir, { recursive: true });
    mkdirSync(goalsDir, { recursive: true });
    writeFileSync(matchingGoal, '## TRACED PATHS\n1. src/index.ts\n', 'utf8');
    const firstRunId = 'run-00000000-0000-4000-8000-000000000041';
    const secondRunId = 'run-00000000-0000-4000-8000-000000000042';
    writeFileSync(join(firstLedgerDir, `${firstRunId}.jsonl`), `${JSON.stringify({ timestamp: '2026-08-10T00:00:00.000Z', runId: firstRunId, event: 'start', data: { goalFile: matchingGoal } })}\n`, 'utf8');
    writeFileSync(join(secondLedgerDir, `${secondRunId}.jsonl`), `${JSON.stringify({ timestamp: '2026-08-10T00:00:00.000Z', runId: secondRunId, event: 'run-start', data: {} })}\n`, 'utf8');

    const result = queryFederatedUnfinishedRunLedgers({
      goalsDir,
      path: 'src/index.ts',
      targets: [
        { name: 'test:monad-agent', dbPath: join(firstStateDir, 'logs', 'logs.db') },
        { name: 'test:monad-agent', dbPath: join(secondStateDir, 'logs', 'logs.db') },
      ],
    });

    expect(result.ledgerDirectories).toEqual([firstLedgerDir, secondLedgerDir]);
    expect(result.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: firstRunId, ledgerDirectory: firstLedgerDir, plannedPaths: ['src/index.ts'] }),
      expect.objectContaining({ runId: secondRunId, ledgerDirectory: secondLedgerDir, plannedPathStatus: 'branch-missing' }),
    ]));
    expect(result.matchingPathCount).toBe(1);
    expect(result.unknownPathCount).toBe(1);
    expect(result.unreadableLedgerDirectoryCount).toBe(0);
    const rendered = renderUnfinishedRunLedgers(result);
    expect(rendered).toContain(`ledger directory: ${firstLedgerDir}`);
    expect(rendered).toContain(`ledger directory: ${secondLedgerDir}`);
    expect(rendered).toContain(`runId=${firstRunId} ledgerDirectory=${firstLedgerDir}`);
    expect(rendered).toContain('matching paths: 1\nunknown paths: 1');
  });

  test('reconciles an unfinished ledger when another physical directory records terminal-only completion', () => {
    const root = mkdtempSync(join(tmpdir(), 'federated-terminal-reconciliation-'));
    directories.push(root);
    const firstStateDir = join(root, 'first-state');
    const secondStateDir = join(root, 'second-state');
    const firstLedgerDir = join(firstStateDir, 'run-ledger');
    const secondLedgerDir = join(secondStateDir, 'run-ledger');
    const runId = 'run-00000000-0000-4000-8000-000000000043';
    mkdirSync(firstLedgerDir, { recursive: true });
    mkdirSync(secondLedgerDir, { recursive: true });
    writeFileSync(join(firstLedgerDir, `${runId}.jsonl`), `${JSON.stringify({ runId, event: 'start', data: {} })}\n`, 'utf8');
    writeFileSync(join(secondLedgerDir, `${runId}.jsonl`), `${JSON.stringify({ runId, event: 'terminal', data: { terminal: 'published', ok: true } })}\n`, 'utf8');

    const result = queryFederatedUnfinishedRunLedgers({
      goalsDir: join(root, 'docs', 'goals'),
      targets: [
        { name: 'test:monad-agent', dbPath: join(firstStateDir, 'logs', 'logs.db') },
        { name: 'test:monad-agent', dbPath: join(secondStateDir, 'logs', 'logs.db') },
      ],
    });

    expect(result.entries).toEqual([]);
    expect(result.reconciledTerminatedElsewhereCount).toBe(1);
  });

  test('uses the CLI --all and --include-test registry policy and reports only opened ledger directories', () => {
    const root = mkdtempSync(join(tmpdir(), 'unfinished-runs-cli-'));
    directories.push(root);
    const home = join(root, 'home');
    const prodStateDir = join(home, '.elanous');
    const testStateDir = join(root, 'test-state');
    const missingLedgerStateDir = join(root, 'missing-ledger-state');
    const prodRunId = 'run-00000000-0000-4000-8000-000000000051';
    const testRunId = 'run-00000000-0000-4000-8000-000000000052';
    for (const stateDir of [prodStateDir, testStateDir, missingLedgerStateDir]) {
      mkdirSync(join(stateDir, 'logs'), { recursive: true });
      writeFileSync(join(stateDir, 'logs', 'logs.db'), '');
    }
    mkdirSync(join(prodStateDir, 'run-ledger'), { recursive: true });
    mkdirSync(join(testStateDir, 'run-ledger'), { recursive: true });
    writeFileSync(join(prodStateDir, 'run-ledger', `${prodRunId}.jsonl`), `${JSON.stringify({ timestamp: '2026-08-10T00:00:00.000Z', runId: prodRunId, event: 'start', data: {} })}\n`);
    writeFileSync(join(testStateDir, 'run-ledger', `${testRunId}.jsonl`), `${JSON.stringify({ timestamp: '2026-08-10T00:00:00.000Z', runId: testRunId, event: 'start', data: {} })}\n`);
    mkdirSync(join(prodStateDir, 'logs'), { recursive: true });
    writeFileSync(join(prodStateDir, 'logs', 'instances.json'), JSON.stringify({
      instances: [
        { name: 'test:monad-agent', stateDir: testStateDir, kind: 'test', pid: process.pid, startedAt: '2026-08-10T00:00:00.000Z' },
        { name: 'test:monad-agent', stateDir: missingLedgerStateDir, kind: 'test', pid: process.pid, startedAt: '2026-08-10T00:00:00.000Z' },
      ],
    }));

    const env = { ...process.env, HOME: home, ELANOUS_STATE_DIR: prodStateDir };
    const all = Bun.spawnSync({
      cmd: [process.execPath, 'bin/elanous.mjs', 'self', 'unfinished-runs', '--all', '--json'],
      cwd: process.cwd(), env, stdout: 'pipe', stderr: 'pipe',
    });
    const allAndTest = Bun.spawnSync({
      cmd: [process.execPath, 'bin/elanous.mjs', 'self', 'unfinished-runs', '--all', '--include-test', '--path', 'src/index.ts', '--json'],
      cwd: process.cwd(), env, stdout: 'pipe', stderr: 'pipe',
    });

    expect(all.exitCode).toBe(0);
    expect(JSON.parse(all.stdout.toString())).toMatchObject({
      ledgerDirectories: [join(prodStateDir, 'run-ledger')],
      unreadableLedgerDirectoryCount: 0,
      entries: [expect.objectContaining({ runId: prodRunId, ledgerDirectory: join(prodStateDir, 'run-ledger') })],
    });
    expect(allAndTest.exitCode).toBe(0);
    expect(JSON.parse(allAndTest.stdout.toString())).toMatchObject({
      ledgerDirectories: [join(prodStateDir, 'run-ledger'), join(testStateDir, 'run-ledger')],
      unreadableLedgerDirectoryCount: 1,
      matchingPathCount: 0,
      unknownPathCount: 2,
      entries: [
        expect.objectContaining({ runId: prodRunId, ledgerDirectory: join(prodStateDir, 'run-ledger') }),
        expect.objectContaining({ runId: testRunId, ledgerDirectory: join(testStateDir, 'run-ledger') }),
      ],
    });
  }, 20_000);
});

describe('GoalRunStore concurrent writers', () => {
  test('two actual Bun processes persist 200 rows each without busy-lost', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-run-parallel-'));
    directories.push(dir);
    const path = join(dir, 'goal-runs.db');
    const modulePath = new URL('./goal-run-store.ts', import.meta.url).href;
    const script = `import { GoalRunStore } from ${JSON.stringify(modulePath)};
      import { debug } from ${JSON.stringify(new URL('../debug/log.ts', import.meta.url).href)};
      debug.registerSink({ name: 'busy-observer', emit(rec) {
        if (rec.category === 'store.sqlite' && rec.event === 'busy-lost') console.error('BUSY_LOST', JSON.stringify(rec.data));
      } });
      const store = new GoalRunStore(process.argv[1]);
      const hold = process.argv[2] === 'a';
      const timeout = store['db'].query('PRAGMA busy_timeout').get().timeout;
      if (timeout !== 5000) throw new Error('writer busy_timeout must be 5000, got ' + timeout);
      if (hold) { store['db'].run('BEGIN IMMEDIATE'); console.log('locked'); }
      try {
        for (let i = 0; i < 200; i++) store.insert('parallel-goal', {
          runId: process.argv[2] + '-' + i, stage: 'pr-opened', outcome: 'completed', ok: true,
          startedAt: '2026-09-29T00:00:00.000Z', rounds: 1, model: 'test-model'
        }, 'parallel-goal');
      } finally {
        if (hold) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
          store['db'].run('COMMIT');
        }
        store.close();
      }`;
    const launch = (id: string) => Bun.spawn({
      cmd: [process.execPath, '-e', script, path, id], stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, NODE_ENV: 'test' },
    });
    const first = launch('a');
    const reader = first.stdout.getReader();
    const ready = await reader.read();
    reader.releaseLock();
    expect(new TextDecoder().decode(ready.value)).toContain('locked');
    const workers = [first, launch('b')];
    const results = await Promise.all(workers.map(async (worker) => ({
      code: await worker.exited, stderr: await new Response(worker.stderr).text(),
    })));
    expect(results.map((result) => result.code)).toEqual([0, 0]);
    expect(results.flatMap((result) => result.stderr.split('\n').filter((line) => line.startsWith('BUSY_LOST')))).toHaveLength(0);
    const stored = new GoalRunStore(path, true);
    try { expect(stored.recordCount()).toBe(400); }
    finally { stored.close(); }
  }, 20_000);
});

describe('GoalRunStore', () => {
  test('keeps both records when the same run ID is recorded twice', () => {
    const { store: goalRunStore, goalFile } = store();
    try {
      goalRunStore.insert(goalFile, record('run-shared'));
      goalRunStore.insert(goalFile, record('run-shared', 'abandoned'));

      const records = goalRunStore.byRunId('run-shared');
      expect(records).toHaveLength(2);
      expect(records.map((entry) => entry.record.outcome)).toEqual(['completed', 'abandoned']);
      expect(records.map((entry) => entry.id)).not.toEqual([records[1]!.id, records[0]!.id]);
    } finally {
      goalRunStore.close();
    }
  });

  test('round-trips GoalType provenance while legacy records retain omitted optional fields', () => {
    const { store: goalRunStore, goalFile } = store();
    try {
      goalRunStore.insert(goalFile, {
        ...record('run-goal-type'),
        goalType: 'research',
        goalTypeSource: 'declared',
      });
      goalRunStore.insert(goalFile, record('run-legacy'));

      expect(goalRunStore.byRunId('run-goal-type')[0]?.record).toMatchObject({
        goalType: 'research',
        goalTypeSource: 'declared',
      });
      expect(goalRunStore.byRunId('run-legacy')[0]?.record).not.toHaveProperty('goalType');
      expect(goalRunStore.byRunId('run-legacy')[0]?.record).not.toHaveProperty('goalTypeSource');
    } finally {
      goalRunStore.close();
    }
  });

  test('separates records with different run IDs and reads by goal file', () => {
    const { store: goalRunStore, goalFile } = store();
    try {
      goalRunStore.insert(goalFile, record('run-one'));
      goalRunStore.insert(goalFile, record('run-two'));

      expect(goalRunStore.byRunId('run-one')).toHaveLength(1);
      expect(goalRunStore.byRunId('run-two')).toHaveLength(1);
      expect(goalRunStore.byGoalFile(goalFile)).toHaveLength(2);
    } finally {
      goalRunStore.close();
    }
  });

  test('reads the newest record for a goal ID without changing the stored schema', () => {
    const { store: goalRunStore, goalFile } = store();
    try {
      goalRunStore.insert(goalFile, record('run-earlier'), 'goal-same');
      goalRunStore.insert(goalFile, record('run-latest', 'abandoned'), 'goal-same');
      goalRunStore.insert(goalFile, record('run-other'), 'goal-other');

      expect(goalRunStore.latestByGoalId('goal-same')).toEqual(expect.objectContaining({
        runId: 'run-latest',
        record: expect.objectContaining({ outcome: 'abandoned' }),
      }));
      expect(goalRunStore.latestByGoalId('goal-missing')).toBeUndefined();
      const legacyRecord = goalRunStore.byRunId('run-earlier')[0]?.record;
      expect(legacyRecord).not.toHaveProperty('goalType');
      expect(legacyRecord).not.toHaveProperty('goalTypeSource');
    } finally {
      goalRunStore.close();
    }
  });

  test('classifies latest goal-file runs across finished records, unfinished ledgers, and absent records', () => {
    const { store: goalRunStore, goalFile } = store();
    const missingGoalFile = join(dirname(goalFile), 'GOAL-missing.txt');
    try {
      expect(goalRunStore.latestStatusByGoalFile(missingGoalFile, { queryUnfinishedRunLedgers: () => unfinishedLedgerQuery() })).toEqual({ kind: 'no-record' });

      goalRunStore.insert(goalFile, { ...record('run-completed'), startedAt: '2026-08-08T00:00:00.000Z' }, 'goal-status');
      expect(goalRunStore.latestStatusByGoalFile(goalFile, { queryUnfinishedRunLedgers: () => unfinishedLedgerQuery() })).toEqual({ kind: 'finished', outcome: 'completed' });

      expect(goalRunStore.latestStatusByGoalFile(goalFile, latestStatusDeps(
        unfinishedLedgerQuery(
          ['run-active'], 0, { 'run-active': `./${relative(process.cwd(), goalFile)}` }, { 'run-active': '2026-08-09T00:00:00.000Z' },
        ),
        { 'run-active': '2026-08-09T00:00:00.000Z' },
      ))).toEqual({ kind: 'unfinished' });
    } finally {
      goalRunStore.close();
    }
  });

  test('uses the same started-at axis across terminal and unfinished runs and returns unavailable for incomplete queries', () => {
    const { store: goalRunStore, goalFile } = store();
    try {
      goalRunStore.insert(goalFile, { ...record('run-finished-new'), startedAt: '2026-08-10T00:00:00.000Z' }, 'goal-status');
      expect(goalRunStore.latestStatusByGoalFile(goalFile, latestStatusDeps(
        unfinishedLedgerQuery(
          ['run-active-old'], 0, { 'run-active-old': goalFile }, { 'run-active-old': '2026-08-12T00:00:00.000Z' },
        ),
        { 'run-active-old': '2026-08-09T00:00:00.000Z' },
      ))).toEqual({ kind: 'finished', outcome: 'completed' });
      expect(goalRunStore.latestStatusByGoalFile(goalFile, latestStatusDeps(
        unfinishedLedgerQuery(
          ['run-active-new'], 0, { 'run-active-new': goalFile }, { 'run-active-new': '2026-08-11T01:00:00.000Z' },
        ),
        { 'run-active-new': '2026-08-11T00:00:00.000Z' },
      ))).toEqual({ kind: 'unfinished' });
      expect(goalRunStore.latestStatusByGoalFile(goalFile, {
        queryUnfinishedRunLedgers: () => unfinishedLedgerQuery([], 1),
      })).toEqual({ kind: 'unavailable' });
      expect(goalRunStore.latestStatusByGoalFile(goalFile, {
        queryUnfinishedRunLedgers: () => { throw new Error('ledger unavailable'); },
      })).toEqual({ kind: 'unavailable' });
    } finally {
      goalRunStore.close();
    }
  });

  test('normalizes stored and queried goal-file path representations', () => {
    const { store: goalRunStore, goalFile } = store();
    const relativeGoalFile = relative(process.cwd(), goalFile);
    try {
      goalRunStore.insert(`./${relativeGoalFile}`, record('run-relative-finished'), 'goal-relative');
      expect(goalRunStore.latestStatusByGoalFile(goalFile, { unfinishedRunLedgers: unfinishedLedgerQuery() })).toEqual({
        kind: 'finished',
        outcome: 'completed',
      });
      expect(goalRunStore.byGoalFile(`./${relativeGoalFile}`)).toHaveLength(1);
    } finally {
      goalRunStore.close();
    }
  });

  // ⛔⭐ 이 축이 «두 번» 죽었다(2026-08-23 · run-b522e846 · run-cb82c79d) — 그래서 «반증부터» 적는다.
  //   실측: 원장을 «쓴» cwd 에서 1행, «다른» cwd 에서 0행. 하니스 자식은 격리 worktree 에서 돌기 때문에
  //   그 어긋남이 «예외»가 아니라 «기본»이었다. ⇒ 「같은 골 파일인데 못 찾는다」가 조용히 났다.
  test('legacy relative rows stay findable from a different working directory when the base is threaded', () => {
    const { store: goalRunStore, goalFile } = store();
    const storedRelativeGoalFile = relative(process.cwd(), goalFile);
    const writerBase = dirname(goalFile);
    const writerRelativeGoalFile = relative(writerBase, goalFile);
    const differentBase = join(writerBase, 'different-base');
    try {
      // 레거시 형태(상대경로)로 저장된 행을 세운다.
      goalRunStore.insert(`./${storedRelativeGoalFile}`, record('run-cross-cwd'), 'goal-cross-cwd');

      // ⓐ 기준을 «주면» — 읽는 프로세스의 cwd 가 무엇이든 찾는다.
      expect(goalRunStore.byGoalFile(goalFile, writerBase)).toHaveLength(1);
      expect(goalRunStore.latestStatusByGoalFile(goalFile, {
        unfinishedRunLedgers: unfinishedLedgerQuery(),
        baseDirectory: writerBase,
      })).toEqual({ kind: 'finished', outcome: 'completed' });

      // ⓑ ⛔ 반증 — ***상대경로로 조회할 때*** 기준이 어긋나면 «다른 절대경로»가 되어 못 찾는다.
      //   ⭐ 이것이 실측된 결손의 기전이다(같은 cwd 1행 · 다른 cwd 0행) — `resolve()` 가 cwd 를 썼다.
      expect(goalRunStore.byGoalFile(`./${writerRelativeGoalFile}`, writerBase)).toHaveLength(1);
      expect(goalRunStore.byGoalFile(`./${writerRelativeGoalFile}`, differentBase)).toHaveLength(0);
    } finally {
      goalRunStore.close();
    }
  });

  // ⚠️ 불변식 — 기준을 «안 주면» 지금과 같이 `process.cwd()` 로 돈다(기존 호출자 무변).
  test('omitting the base keeps the previous process.cwd() behavior', () => {
    const { store: goalRunStore, goalFile } = store();
    const relativeGoalFile = relative(process.cwd(), goalFile);
    try {
      goalRunStore.insert(`./${relativeGoalFile}`, record('run-default-base'), 'goal-default-base');
      expect(goalRunStore.byGoalFile(goalFile)).toHaveLength(1);
      expect(goalRunStore.byGoalFile(goalFile)).toEqual(goalRunStore.byGoalFile(goalFile, process.cwd()));
    } finally {
      goalRunStore.close();
    }
  });

  test('finds an unfinished run when the terminal database is absent', () => {
    const { goalFile } = store();
    const missingDatabase = join(dirname(goalFile), 'missing-goal-runs.db');
    expect(loadLatestGoalRunStatusByGoalFile(goalFile, missingDatabase, latestStatusDeps(
      unfinishedLedgerQuery(
        ['run-active'], 0, { 'run-active': goalFile }, { 'run-active': '2026-08-11T01:00:00.000Z' },
      ),
      { 'run-active': '2026-08-11T00:00:00.000Z' },
    ))).toEqual({ kind: 'unfinished' });
  });

  test('reports every finished outcome and uses started-at then ID for latest goal-file status', () => {
    const { store: goalRunStore, goalFile } = store();
    try {
      for (const outcome of ['completed', 'abandoned', 'budget-exhausted'] as const) {
        const outcomeGoalFile = `${goalFile}-${outcome}`;
        goalRunStore.insert(outcomeGoalFile, record(`run-${outcome}`, outcome === 'budget-exhausted' ? 'abandoned' : outcome), `goal-${outcome}`);
        if (outcome === 'budget-exhausted') {
          goalRunStore.insert(outcomeGoalFile, { ...record(`run-${outcome}-terminal`), outcome }, `goal-${outcome}`);
        }
        expect(goalRunStore.latestStatusByGoalFile(outcomeGoalFile)).toEqual({ kind: 'finished', outcome });
      }

      goalRunStore.insert(goalFile, { ...record('run-newer'), startedAt: '2026-08-09T00:00:00.000Z' }, 'goal-order');
      goalRunStore.insert(goalFile, { ...record('run-same-time', 'abandoned'), startedAt: '2026-08-09T00:00:00.000Z' }, 'goal-order');
      goalRunStore.insert(goalFile, { ...record('run-older'), startedAt: '2026-08-08T00:00:00.000Z' }, 'goal-order');
      expect(goalRunStore.latestStatusByGoalFile(goalFile)).toEqual({ kind: 'finished', outcome: 'abandoned' });
    } finally {
      goalRunStore.close();
    }
  });

  test('selects the latest started record when an older record is inserted later', () => {
    const { store: goalRunStore, goalFile } = store();
    try {
      goalRunStore.insert(goalFile, {
        ...record('run-newer'),
        startedAt: '2026-08-09T00:00:00.000Z',
        lastReviewFindings: {
          items: ['newer review finding'],
          itemCount: 1,
          shownChars: 21,
          totalChars: 21,
          truncated: false,
          fullyIncludedItems: 1,
          truncatedItems: 0,
          omittedItems: 0,
        },
      }, 'goal-same');
      goalRunStore.insert(goalFile, {
        ...record('run-older'),
        startedAt: '2026-08-08T00:00:00.000Z',
        lastReviewFindings: {
          items: ['older review finding'],
          itemCount: 1,
          shownChars: 21,
          totalChars: 21,
          truncated: false,
          fullyIncludedItems: 1,
          truncatedItems: 0,
          omittedItems: 0,
        },
      }, 'goal-same');

      expect(goalRunStore.latestByGoalId('goal-same')).toEqual(expect.objectContaining({
        runId: 'run-newer',
        record: expect.objectContaining({
          lastReviewFindings: expect.objectContaining({ items: ['newer review finding'] }),
        }),
      }));
    } finally {
      goalRunStore.close();
    }
  });

  test('projects newest prior runs with total, truncation, digest, and supervisor verdict', () => {
    const { store: goalRunStore, goalFile } = store();
    try {
      goalRunStore.insert(goalFile, {
        ...record('run-old'),
        startedAt: '2026-08-07T00:00:00.000Z',
      }, 'goal-history');
      goalRunStore.insert(goalFile, {
        ...record('run-middle', 'abandoned'),
        startedAt: '2026-08-08T00:00:00.000Z',
        failureClassification: 'contract-conflict',
        supervisorVerdict: 'CONTRACT-CONFLICT',
        lastReviewFindings: {
          items: ['first must fix', 'second must fix'],
          itemCount: 2,
          shownChars: 31,
          totalChars: 31,
          truncated: false,
          fullyIncludedItems: 2,
          truncatedItems: 0,
          omittedItems: 0,
        },
      }, 'goal-history');
      goalRunStore.insert(goalFile, {
        ...record('run-new'),
        startedAt: '2026-08-09T00:00:00.000Z',
      }, 'goal-history');

      expect(goalRunStore.priorRunsByGoalId('goal-history', 2)).toEqual({
        priorRuns: [
          { runId: 'run-new', outcome: 'completed', stage: 'pr-opened', mustFixDigest: [] },
          {
            runId: 'run-middle',
            outcome: 'abandoned',
            stage: 'pr-opened',
            failureClassification: 'contract-conflict',
            supervisorVerdict: 'CONTRACT-CONFLICT',
            mustFixDigest: ['first must fix', 'second must fix'],
          },
        ],
        total: 3,
        truncated: true,
      });
      const completeHistory = goalRunStore.priorRunsByGoalId('goal-history', 3);
      expect(completeHistory).toMatchObject({ total: 3, truncated: false });
      expect(completeHistory).not.toBeNull();
      expect(completeHistory!.total).toBe(completeHistory!.priorRuns.length);
      expect(goalRunStore.priorRunsByGoalId('goal-empty', 2)).toEqual({ priorRuns: [], total: 0, truncated: false });
      expect(goalRunStore.priorRunsByGoalId('goal-history', 0)).toEqual({ priorRuns: [], total: 3, truncated: true });
      expect(() => goalRunStore.priorRunsByGoalId('goal-history', -1)).toThrow(RangeError);
      expect(() => goalRunStore.priorRunsByGoalId('goal-history', 1.5)).toThrow(RangeError);
      expect(() => goalRunStore.priorRunsByGoalId('goal-history', Number.NaN)).toThrow(RangeError);
      expect(() => goalRunStore.priorRunsByGoalId('goal-history', Number.POSITIVE_INFINITY)).toThrow(RangeError);
    } finally {
      goalRunStore.close();
    }
  });

  test('projects the newest prior termination separately from vertical prior runs', () => {
    const { store: goalRunStore, goalFile } = store();
    try {
      expect(goalRunStore.priorTerminationByGoalId('goal-empty')).toEqual({ status: 'absent' });
      goalRunStore.insert(goalFile, { ...record('run-older'), startedAt: '2026-08-07T00:00:00.000Z' }, 'goal-termination');
      goalRunStore.insert(goalFile, {
        ...record('run-prior', 'abandoned'),
        startedAt: '2026-08-08T00:00:00.000Z',
        rounds: 3,
        failureClassification: 'contract-conflict',
        classificationBasis: 'supervisor-contract-conflict',
        lastReviewFindings: {
          items: ['blocked by missing evidence'], itemCount: 1, shownChars: 27, totalChars: 27,
          truncated: false, fullyIncludedItems: 1, truncatedItems: 0, omittedItems: 0,
        },
      }, 'goal-termination');
      goalRunStore.insert(goalFile, { ...record('run-other'), startedAt: '2026-08-10T00:00:00.000Z' }, 'other-goal');
      goalRunStore.insert(goalFile, { ...record('run-current'), startedAt: '2026-08-09T00:00:00.000Z' }, 'goal-termination');
      const current = goalRunStore.latestByGoalId('goal-termination')!;
      expect(goalRunStore.priorTerminationByGoalId('goal-termination', current)).toEqual({
        status: 'present', runId: 'run-prior', outcome: 'abandoned', stage: 'pr-opened',
        failureClassification: 'contract-conflict', classificationBasis: 'supervisor-contract-conflict', rounds: 3,
        lastReviewFindings: expect.objectContaining({ items: ['blocked by missing evidence'] }),
      });
      expect(goalRunStore.priorTerminationByGoalId('goal-termination')).toMatchObject({ status: 'present', runId: 'run-current' });
      expect(goalRunStore.priorRunsByGoalId('goal-termination', 1)).toEqual({
        priorRuns: [{ runId: 'run-current', outcome: 'completed', stage: 'pr-opened', mustFixDigest: [] }],
        total: 3, truncated: true,
      });
    } finally {
      goalRunStore.close();
    }
  });

  test('keeps successful termination free of an abandoned reason and marks malformed history unreadable', () => {
    const { store: goalRunStore, goalFile } = store();
    try {
      goalRunStore.insert(goalFile, { ...record('run-success'), startedAt: '2026-08-08T00:00:00.000Z', rounds: 2 }, 'goal-success');
      expect(goalRunStore.priorTerminationByGoalId('goal-success')).toEqual({
        status: 'present', runId: 'run-success', outcome: 'completed', stage: 'pr-opened', rounds: 2,
      });
      goalRunStore.insert(goalFile, { ...record('run-malformed'), startedAt: '2026-08-09T00:00:00.000Z', rounds: undefined }, 'goal-malformed');
      expect(goalRunStore.priorTerminationByGoalId('goal-malformed')).toEqual({ status: 'unreadable' });
    } finally {
      goalRunStore.close();
    }
  });

  test('summarizes already-read prior records without mutation or storage access', () => {
    const input = [{
      id: 1, runId: 'run-pure', goalId: 'goal-pure', goalFile: 'GOAL.txt',
      record: { ...record('run-pure', 'abandoned'), rounds: 4 },
    }];
    const before = structuredClone(input);
    expect(summarizePriorGoalTermination(input)).toEqual({
      status: 'present', runId: 'run-pure', outcome: 'abandoned', stage: 'pr-opened', rounds: 4,
    });
    expect(summarizePriorGoalTermination(input)).toEqual(summarizePriorGoalTermination(input));
    expect(input).toEqual(before);
  });

  test('finds filtered runs newest first and reports ledger metadata without writing the ledger', () => {
    const { store: goalRunStore, goalFile } = store();
    const path = goalRunStore.path;
    try {
      goalRunStore.insert(goalFile, { ...record('run-old', 'completed'), startedAt: '2026-08-07T00:00:00.000Z', stage: 'gate-failed' }, 'goal-one');
      goalRunStore.insert(goalFile, { ...record('run-middle', 'abandoned'), startedAt: '2026-08-08T00:00:00.000Z', stage: 'pr-opened' }, 'goal-one');
      goalRunStore.insert(goalFile, { ...record('run-new', 'abandoned'), startedAt: '2026-08-09T00:00:00.000Z', stage: 'pr-opened' }, 'goal-two');

      expect(goalRunStore.query({ limit: 2 })).toMatchObject({
        oldestStartedAt: '2026-08-07T00:00:00.000Z', total: 3, truncated: true,
        records: [{ runId: 'run-new' }, { runId: 'run-middle' }],
      });
      expect(goalRunStore.query({ goalId: 'goal-one', limit: 10 })?.records.map(({ runId }) => runId)).toEqual(['run-middle', 'run-old']);
      expect(goalRunStore.query({ startedAt: '2026-08-08T00:00:00.000Z', outcome: 'abandoned', stage: 'pr-opened', limit: 10 })?.records.map(({ runId }) => runId)).toEqual(['run-new', 'run-middle']);
      expect(goalRunStore.query({ outcome: 'completed', limit: 1 })).toMatchObject({ total: 1, truncated: false, records: [{ runId: 'run-old' }] });
    } finally {
      goalRunStore.close();
    }

    const openCalls: Array<{ spec: string; options: { readonly?: boolean } | undefined }> = [];
    const reader = new GoalRunStore(path, true, class extends Database {
      constructor(spec: string, options?: { readonly?: boolean }) {
        openCalls.push({ spec, options });
        super(spec, options);
      }
    });
    try {
      expect(reader.query({ limit: 10 })).toMatchObject({ total: 3, truncated: false });
    } finally {
      reader.close();
    }
    expect(openCalls).toEqual([{ spec: path, options: { readonly: true } }]);
    expect(openCalls[0]?.spec).not.toStartWith('file:');
    expect(openCalls[0]?.spec).not.toContain('?mode=ro');
    expect(loadGoalRunQuery({ limit: 10 }, path)).toMatchObject({ total: 3, truncated: false });
    const emptyPath = join(mkdtempSync(join(tmpdir(), 'empty-goal-run-store-')), 'goal-runs.db');
    directories.push(dirname(emptyPath));
    expect(loadGoalRunQuery({ limit: 10 }, emptyPath)).toEqual({ records: [], oldestStartedAt: null, total: 0, truncated: false });
  });

  test('logs failed ledger opens while preserving the null sentinel and stays quiet on success', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    const unreadablePath = mkdtempSync(join(tmpdir(), 'goal-run-store-unreadable-'));
    directories.push(unreadablePath);
    try {
      expect(loadGoalRunQuery({ limit: 10 }, unreadablePath)).toBeNull();
      expect(log).toHaveBeenCalledWith('goal-ledger.read', 'goal-run-query-failed', {
        path: unreadablePath,
        error: expect.any(String),
      });
      expect(log.mock.calls[0]?.[2]).toMatchObject({
        path: unreadablePath,
        error: expect.stringMatching(/\S/),
      });

      const { store: goalRunStore } = store();
      try {
        expect(loadGoalRunQuery({ limit: 10 }, goalRunStore.path)).toMatchObject({ total: 0 });
      } finally {
        goalRunStore.close();
      }
      expect(log).toHaveBeenCalledTimes(1);
    } finally {
      log.mockRestore();
    }
  });

  test('renders zero completed records with scoped unfinished-run counts and unreadable-state distinctions', () => {
    const empty = { records: [], oldestStartedAt: null, total: 0, truncated: false };
    const noUnfinished = renderGoalRunQuery(empty, { queryUnfinishedRunLedgers: () => unfinishedLedgerQuery() });
    expect(noUnfinished).toContain('total matching records: 0');
    expect(noUnfinished).toContain('unfinished run count: 0 (no unfinished run ledgers found)');

    const unscoped = renderGoalRunQuery(empty, { queryUnfinishedRunLedgers: () => unfinishedLedgerQuery(['run-pending-one', 'run-pending-two']) });
    expect(unscoped).toContain('unfinished run count: 2 (all goals; query was not narrowed)');
    expect(unscoped).toContain('more to inspect:\nquery command: elanous self unfinished-runs');
    expect(unscoped).not.toContain('reproduction:');
    expect(unscoped).not.toContain('relaunch command:');
    expect(unscoped).not.toContain('view all unfinished runs:');
    expect(unscoped).not.toContain('run-pending-one');

    const scoped = renderGoalRunQuery(
      { ...empty, goalDocumentPath: '/tmp/GOAL-this.txt' },
      { queryUnfinishedRunLedgers: () => unfinishedLedgerQuery(
        ['run-this-goal', 'run-other-one', 'run-other-two'],
        0,
        { 'run-this-goal': '/tmp/GOAL-this.txt', 'run-other-one': '/tmp/GOAL-other.txt', 'run-other-two': '/tmp/GOAL-other.txt' },
      ) },
    );
    expect(scoped).toContain('unfinished run count: 1 (scoped to this goal)');
    expect(scoped).toContain('more to inspect:\nquery command: elanous self unfinished-runs');
    expect(scoped).toContain(unscoped.match(/more to inspect:\nquery command: .+/)?.[0]!);
    expect(scoped).not.toContain('reproduction:');
    expect(scoped).not.toContain('relaunch command:');
    expect(scoped).not.toContain('view all unfinished runs:');
    expect(scoped).not.toContain('run-other-one');

    const autopsyRoot = '/tmp/.elanous-test';
    const autopsy = renderGoalRunInspection({
      runId: 'run-autopsy',
      records: [{
        id: 1,
        runId: 'run-autopsy',
        goalId: 'goal-autopsy',
        goalFile: '/tmp/GOAL-autopsy.txt',
        record: { ...record('run-autopsy', 'abandoned'), resolvedBase: 'main', configRoot: autopsyRoot, stateRoot: autopsyRoot },
      }],
      ledgerError: null,
      logs: { count: 0, categories: [], instances: [], unreadableInstances: [] },
    });
    expect(autopsy).toContain('reproduction:');
    expect(autopsy).toContain('relaunch command: bun bin/elanous.mjs');

    const unavailableScope = renderGoalRunQuery(
      { ...empty, goalDocumentPath: null },
      { queryUnfinishedRunLedgers: () => unfinishedLedgerQuery(['run-unscoped']) },
    );
    expect(unavailableScope).toContain('unfinished run count: 1 (goal document path unavailable; scope not narrowed)');
    expect(unavailableScope).not.toContain('unfinished run count: 0');

    const unreadable = renderGoalRunQuery(empty, { queryUnfinishedRunLedgers: () => unfinishedLedgerQuery([], 1) });
    expect(unreadable).toContain('unfinished run count: unavailable (1 ledger unreadable)');
    expect(unreadable).not.toContain('unfinished run count: 0');

    const queryFailure = renderGoalRunQuery(empty, { queryUnfinishedRunLedgers: () => { throw new Error('ledger directory unavailable'); } });
    expect(queryFailure).toContain('unfinished run count: unavailable (unfinished run ledgers could not be read)');

    const completed = { records: [{ id: 1, runId: 'run-completed', goalId: 'goal-completed', goalFile: '/tmp/GOAL.txt', record: record('run-completed') }], oldestStartedAt: '2026-08-08T00:00:00.000Z', total: 1, truncated: false };
    expect(renderGoalRunQuery(completed, { queryUnfinishedRunLedgers: () => { throw new Error('must not query unfinished runs'); } }))
      .toBe('oldest record: 2026-08-08T00:00:00.000Z\ntotal matching records: 1\ntruncated: false\n\n{"id":1,"runId":"run-completed","goalId":"goal-completed","goalFile":"/tmp/GOAL.txt","record":{"runId":"run-completed","stage":"pr-opened","outcome":"completed","ok":true,"startedAt":"2026-08-08T00:00:00.000Z","rounds":1,"model":"test-model"}}');
  });

  test('self goal-run-search CLI returns metadata and matching records', () => {
    const { store: goalRunStore, goalFile } = store();
    try {
      goalRunStore.insert(goalFile, {
        ...record('run-cli-search', 'abandoned'),
        startedAt: '2026-08-09T00:00:00.000Z',
        failureClassification: 'implementation-deficit',
        classificationBasis: 'must-fix-reported',
        supervisorReason: 'repeated finding remains after rework',
      }, 'goal-cli');
      goalRunStore.insert(goalFile, {
        ...record('run-unreadable-worktree', 'abandoned'),
        startedAt: '2026-08-09T00:00:00.000Z',
        failureClassification: 'implementation-deficit',
        classificationBasis: 'no-must-fix-without-clean-worktree-or-completed-without-changes',
      }, 'goal-cli');
      goalRunStore.insert(goalFile, {
        ...record('run-no-basis', 'abandoned'),
        startedAt: '2026-08-09T00:00:00.000Z',
        failureClassification: 'report-deficit',
        classificationBasis: 'no-must-fix-clean-worktree-and-completed-without-changes',
      }, 'goal-other');

      expect(goalRunStore.byRunId('run-cli-search')[0]?.record).toMatchObject({
        failureClassification: 'implementation-deficit',
        classificationBasis: 'must-fix-reported',
        supervisorReason: 'repeated finding remains after rework',
      });
      expect(goalRunStore.byRunId('run-unreadable-worktree')[0]?.record).not.toHaveProperty('supervisorReason');
      expect(goalRunStore.byRunId('run-unreadable-worktree')[0]?.record.classificationBasis)
        .toBe('no-must-fix-without-clean-worktree-or-completed-without-changes');
      expect(goalRunStore.byRunId('run-no-basis')[0]?.record.classificationBasis)
        .toBe('no-must-fix-clean-worktree-and-completed-without-changes');
    } finally {
      goalRunStore.close();
    }
    const stateDir = goalFile.slice(0, goalFile.lastIndexOf('/'));
    const result = Bun.spawnSync({
      cmd: [process.execPath, 'bin/elanous.mjs', 'self', 'goal-run-search', '--goal', 'goal-cli', '--outcome', 'abandoned', '--json'],
      cwd: process.cwd(),
      env: { ...process.env, ELANOUS_STATE_DIR: stateDir },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(result.exitCode).toBe(0);
    const cliJson = JSON.parse(result.stdout.toString());
    expect(cliJson).toMatchObject({ total: 2, oldestStartedAt: '2026-08-09T00:00:00.000Z' });
    expect(cliJson.records.find(({ runId }: { runId: string }) => runId === 'run-cli-search')).toMatchObject({
      record: {
        failureClassification: 'implementation-deficit',
        classificationBasis: 'must-fix-reported',
        supervisorReason: 'repeated finding remains after rework',
      },
    });
    expect(cliJson.records.find(({ runId }: { runId: string }) => runId === 'run-unreadable-worktree').record)
      .not.toHaveProperty('supervisorReason');

    const noMatch = Bun.spawnSync({
      cmd: [process.execPath, 'bin/elanous.mjs', 'self', 'goal-run-search', '--goal', 'no-such-goal'],
      cwd: process.cwd(),
      env: { ...process.env, ELANOUS_STATE_DIR: stateDir },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const noMatchJson = Bun.spawnSync({
      cmd: [process.execPath, 'bin/elanous.mjs', 'self', 'goal-run-search', '--goal', 'no-such-goal', '--json'],
      cwd: process.cwd(),
      env: { ...process.env, ELANOUS_STATE_DIR: stateDir },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(noMatch.exitCode).toBe(0);
    expect(noMatch.stdout.toString()).toContain('total matching records: 0');
    expect(noMatch.stdout.toString()).toContain('unfinished run count: 0');
    expect(noMatchJson.exitCode).toBe(0);
    expect(JSON.parse(noMatchJson.stdout.toString())).toMatchObject({ total: 0, records: [] });
  }, 20_000);

  test('inspects a run ledger with category-only federated log summaries and preserves unreadable instances', () => {
    const { store: goalRunStore, goalFile } = store();
    const stateDir = dirname(goalFile);
    const readablePath = join(stateDir, 'logs', 'readable.db');
    const unreadablePath = join(stateDir, 'logs', 'unreadable.db');
    try {
      goalRunStore.insert(goalFile, record('run-autopsy'));
      const logs = new LogStore(readablePath);
      logs.insertBatch([
        { surface: 'harness:self-implement', rec: { ts: '2026-08-09T01:00:00.000Z', level: 'info', category: 'goal.run', event: 'started', data: 'run-autopsy' } },
        { surface: 'harness:self-implement', rec: { ts: '2026-08-09T02:00:00.000Z', level: 'info', category: 'goal.run', event: 'completed', data: 'run-autopsy' } },
        { surface: 'harness:self-implement', rec: { ts: '2026-08-09T03:00:00.000Z', level: 'info', category: 'other', event: 'ignored', data: 'other-run' } },
      ]);
      logs.close();
      const inspection = inspectGoalRun('run-autopsy', goalRunStore.path, {
        targets: [{ name: 'readable', dbPath: readablePath }, { name: 'locked', dbPath: unreadablePath }],
        openLogStore: (path) => {
          if (path === unreadablePath) throw new Error('database is locked');
          return LogStore.openReadOnly(path);
        },
      });
      expect(inspection).toMatchObject({
        runId: 'run-autopsy',
        records: [{ runId: 'run-autopsy' }],
        ledgerError: null,
        logs: {
          count: 2,
          categories: [{ category: 'goal.run', count: 2, firstAt: '2026-08-09T01:00:00.000Z', lastAt: '2026-08-09T02:00:00.000Z' }],
          instances: ['readable'],
          unreadableInstances: ['locked'],
        },
      });
      expect(JSON.parse(JSON.stringify(inspection))).toMatchObject({ logs: { unreadableInstances: ['locked'] } });
      const rendered = renderGoalRunInspection(inspection);
      expect(rendered).toContain('ledger records: 1');
      expect(rendered).toContain('log summary count: 2');
      expect(rendered).toContain('unreadable instances: 1');
      expect(rendered).toContain('locked');
    } finally {
      goalRunStore.close();
    }
  });

  test('renders a failure-only recurrence section from prior runs with the exact four-field signature', () => {
    const { store: goalRunStore, goalFile } = store();
    try {
      const failed = (runId: string, overrides: Partial<GoalExecutionRecord> = {}) => ({
        ...record(runId, 'abandoned'),
        stage: 'gate-failed' as const,
        failureClassification: 'implementation-deficit' as const,
        supervisorVerdict: 'UNCONVERGEABLE' as const,
        ...overrides,
      });
      goalRunStore.insert(goalFile, failed('run-one'), 'goal-recurrence');
      goalRunStore.insert(goalFile, failed('run-two'), 'goal-recurrence');
      goalRunStore.insert(goalFile, failed('run-three'), 'goal-recurrence');
      goalRunStore.insert(goalFile, failed('run-four'), 'goal-recurrence');
      goalRunStore.insert(goalFile, failed('run-different-stage', { stage: 'pr-opened' }), 'goal-recurrence');
      goalRunStore.insert(goalFile, failed('run-different-outcome', { outcome: 'completed', ok: true }), 'goal-recurrence');
      goalRunStore.insert(goalFile, failed('run-different-classification', { failureClassification: 'report-deficit' }), 'goal-recurrence');
      goalRunStore.insert(goalFile, failed('run-different-verdict', { supervisorVerdict: 'CONTRACT-CONFLICT' }), 'goal-recurrence');
      goalRunStore.insert(goalFile, failed('run-current'), 'goal-recurrence');

      const inspection = inspectGoalRun('run-current', goalRunStore.path, { targets: [] });
      const rendered = renderGoalRunInspection(inspection);
      expect(rendered).toContain('recurrence:');
      expect(rendered).toContain('matching prior failures: 4');
      expect(rendered).toContain('this is failure #5 with this signature');
      expect(rendered).toContain('prior run IDs: run-four, run-three, run-two');
      expect(rendered).toContain('1 additional matching prior failure not shown');
      expect(rendered).toContain('view all: elanous self goal-run-search --goal goal-recurrence');
      expect(rendered).toContain('reproduction:');
      expect(JSON.parse(JSON.stringify(inspection))).not.toHaveProperty('priorRuns');

      goalRunStore.insert(goalFile, failed('run-no-match', { stage: 'pr-opened' }), 'goal-no-match');
      const noMatch = renderGoalRunInspection(inspectGoalRun('run-no-match', goalRunStore.path, { targets: [] }));
      expect(noMatch).toContain('matching prior failures: 0');
      expect(noMatch).toContain('no prior failure has the same signature');

      const unavailable = { ...inspectGoalRun('run-current', goalRunStore.path, { targets: [] }) };
      Object.defineProperty(unavailable, 'priorRuns', { value: null, enumerable: false });
      expect(renderGoalRunInspection(unavailable)).toContain('unavailable: prior runs could not be read');

      goalRunStore.insert(goalFile, record('run-success'), 'goal-recurrence');
      const success = renderGoalRunInspection(inspectGoalRun('run-success', goalRunStore.path, { targets: [] }));
      expect(success).not.toContain('recurrence:');
      expect(success).toContain('reproduction:');
    } finally {
      goalRunStore.close();
    }
  });

  test('counts unique prior run IDs and excludes every duplicate current-run row from recurrence', () => {
    const { store: goalRunStore, goalFile } = store();
    try {
      const failed = (runId: string) => ({
        ...record(runId, 'abandoned'),
        stage: 'gate-failed' as const,
        failureClassification: 'implementation-deficit' as const,
        supervisorVerdict: 'UNCONVERGEABLE' as const,
      });
      goalRunStore.insert(goalFile, failed('run-prior-duplicate'), 'goal-deduplicated-recurrence');
      goalRunStore.insert(goalFile, failed('run-prior-duplicate'), 'goal-deduplicated-recurrence');
      goalRunStore.insert(goalFile, failed('run-current-duplicate'), 'goal-deduplicated-recurrence');
      goalRunStore.insert(goalFile, failed('run-current-duplicate'), 'goal-deduplicated-recurrence');

      const rendered = renderGoalRunInspection(inspectGoalRun('run-current-duplicate', goalRunStore.path, { targets: [] }));
      const recurrence = rendered.slice(rendered.indexOf('recurrence:'), rendered.indexOf('\n\nreproduction:'));
      expect(recurrence).toContain('matching prior failures: 1');
      expect(recurrence).toContain('this is failure #2 with this signature');
      expect(recurrence).toContain('prior run IDs: run-prior-duplicate');
      expect(recurrence).not.toContain('run-current-duplicate');
      expect(recurrence).not.toContain('matching prior failures: 2');
    } finally {
      goalRunStore.close();
    }
  });

  test('marks recurrence counts and ordinals unavailable when prior history is truncated', () => {
    const { store: goalRunStore, goalFile } = store();
    try {
      for (let index = 0; index < 1_001; index++) {
        goalRunStore.insert(goalFile, {
          ...record(`run-prior-${index}`, 'abandoned'),
          stage: 'gate-failed',
          startedAt: `2026-08-08T00:00:${String(index % 60).padStart(2, '0')}.${String(index).padStart(3, '0')}Z`,
          failureClassification: 'implementation-deficit',
          supervisorVerdict: 'UNCONVERGEABLE',
        }, 'goal-truncated-recurrence');
      }
      goalRunStore.insert(goalFile, {
        ...record('run-truncated-current', 'abandoned'),
        stage: 'gate-failed',
        startedAt: '2026-08-09T00:00:00.000Z',
        failureClassification: 'implementation-deficit',
        supervisorVerdict: 'UNCONVERGEABLE',
      }, 'goal-truncated-recurrence');

      const rendered = renderGoalRunInspection(inspectGoalRun('run-truncated-current', goalRunStore.path, { targets: [] }));
      expect(rendered).toContain('matching prior failures: at least 1000 in 1000 displayed prior runs');
      expect(rendered).toContain('prior run query truncated: 1001 total prior runs; exact recurrence count and ordinal are unavailable');
      expect(rendered).toContain('prior run IDs from displayed history:');
      expect(rendered).toContain('view all: elanous self goal-run-search --goal goal-truncated-recurrence');
      expect(rendered).not.toContain('this is failure #');
      expect(rendered).not.toContain('matching prior failures: 1000\n');
    } finally {
      goalRunStore.close();
    }
  });

  test('renders reproduction anchors and a relaunch command only for an exactly representable test universe', () => {
    const { store: goalRunStore, goalFile } = store();
    try {
      const testRoot = join(dirname(goalFile), '.elanous-test');
      goalRunStore.insert(goalFile, {
        ...record('run-repro', 'abandoned'),
        resolvedBase: 'feature/reproduce',
        prNumber: 42,
        configRoot: testRoot,
        stateRoot: testRoot,
      });
      const rendered = renderGoalRunInspection(inspectGoalRun('run-repro', goalRunStore.path, { targets: [] }));
      expect(rendered).toContain('reproduction:');
      expect(rendered).toContain('resolved base: feature/reproduce');
      expect(rendered).toContain('PR number: 42');
      expect(rendered).toContain(`config root: ${testRoot}`);
      expect(rendered).toContain(`state root: ${testRoot}`);
      expect(rendered).toContain(`relaunch command: bun bin/elanous.mjs --test='${testRoot}' dev --file '${goalFile}' --base 'feature/reproduce'`);

      const shellSensitiveGoalFile = "/tmp/goal file '$(touch injected)`";
      const shellSensitiveRoot = "/tmp/test root '$(touch injected)`/.elanous-test";
      const shellSensitive = renderGoalRunInspection({
        ...inspectGoalRun('run-repro', goalRunStore.path, { targets: [] }),
        records: [{
          id: 2,
          runId: 'run-shell-sensitive',
          goalId: '0123456789abcdef',
          goalFile: shellSensitiveGoalFile,
          record: {
            ...record('run-shell-sensitive', 'abandoned'),
            resolvedBase: "base name '$(touch injected)`",
            configRoot: shellSensitiveRoot,
            stateRoot: shellSensitiveRoot,
          },
        }],
      });
      expect(shellSensitive).toContain("relaunch command: bun bin/elanous.mjs --test='/tmp/test root '\\''$(touch injected)`/.elanous-test' dev --file '/tmp/goal file '\\''$(touch injected)`' --base 'base name '\\''$(touch injected)`'");

      goalRunStore.insert(goalFile, record('run-missing', 'abandoned'));
      const missing = renderGoalRunInspection(inspectGoalRun('run-missing', goalRunStore.path, { targets: [] }));
      expect(missing).toContain('missing anchors: resolvedBase, configRoot, stateRoot');
      expect(missing).not.toContain('relaunch command:');

      const differentRoots = renderGoalRunInspection({
        ...inspectGoalRun('run-repro', goalRunStore.path, { targets: [] }),
        records: [{
          id: 1,
          runId: 'run-different-roots',
          goalId: '0123456789abcdef',
          goalFile,
          record: { ...record('run-different-roots', 'abandoned'), resolvedBase: 'feature/reproduce', configRoot: testRoot, stateRoot: join(dirname(goalFile), 'other-state') },
        }],
      });
      expect(differentRoots).toContain('relaunch command unavailable: configRoot and stateRoot cannot be represented exactly by global flags.');
      expect(differentRoots).not.toContain('relaunch command: bun');
    } finally {
      goalRunStore.close();
    }
  });

  test('self goal-run CLI preserves unreadable federated instances on stdout and exits zero', () => {
    const { store: goalRunStore, goalFile } = store();
    const stateDir = dirname(goalFile);
    const home = mkdtempSync(join(tmpdir(), 'goal-run-cli-home-'));
    directories.push(home);
    const lockedStateDir = join(home, 'locked-state');
    const lockedDbPath = join(lockedStateDir, 'logs', 'logs.db');
    try {
      const testRoot = join(stateDir, '.elanous-test');
      goalRunStore.insert(goalFile, {
        ...record('run-cli-locked', 'abandoned'),
        resolvedBase: 'reproduction-base',
        configRoot: testRoot,
        stateRoot: testRoot,
      });
      mkdirSync(dirname(lockedDbPath), { recursive: true });
      writeFileSync(lockedDbPath, 'not a SQLite database');
      const registryPath = join(home, '.elanous', 'logs', 'instances.json');
      mkdirSync(dirname(registryPath), { recursive: true });
      writeFileSync(registryPath, JSON.stringify({
        instances: [{ name: 'locked', stateDir: lockedStateDir, pid: process.pid, startedAt: '2026-08-09T00:00:00.000Z' }],
      }));
      const env = { ...process.env, HOME: home, ELANOUS_STATE_DIR: stateDir };
      const human = Bun.spawnSync({
        cmd: [process.execPath, 'bin/elanous.mjs', 'self', 'goal-run', 'run-cli-locked'],
        cwd: process.cwd(), env, stdout: 'pipe', stderr: 'pipe',
      });
      const json = Bun.spawnSync({
        cmd: [process.execPath, 'bin/elanous.mjs', 'self', 'goal-run', 'run-cli-locked', '--json'],
        cwd: process.cwd(), env, stdout: 'pipe', stderr: 'pipe',
      });
      expect(human.exitCode).toBe(0);
      expect(human.stdout.toString()).toContain('unreadable instances:');
      expect(human.stdout.toString()).toContain('locked');
      expect(human.stdout.toString()).toContain(`relaunch command: bun bin/elanous.mjs --test='${testRoot}' dev --file '${goalFile}' --base 'reproduction-base'`);
      expect(json.exitCode).toBe(0);
      expect(JSON.parse(json.stdout.toString())).toMatchObject({
        records: [{ record: { resolvedBase: 'reproduction-base', configRoot: testRoot, stateRoot: testRoot } }],
        logs: { unreadableInstances: expect.arrayContaining(['locked']) },
      });
    } finally {
      goalRunStore.close();
    }
  }, 20_000);

  test('keeps ledger read failures distinct from absent records and exhaustively summarizes exact run IDs', () => {
    const { store: goalRunStore, goalFile } = store();
    const stateDir = dirname(goalFile);
    const logPath = join(stateDir, 'logs', 'large.db');
    try {
      const logs = new LogStore(logPath);
      logs.insertBatch(Array.from({ length: 1_001 }, (_, index) => ({
        surface: 'harness:self-implement',
        rec: { ts: `2026-08-09T00:${String(index % 60).padStart(2, '0')}:00.000Z`, level: 'info' as const, category: 'goal.run', event: 'completed', data: { runId: 'run-exact' } },
      })));
      logs.insertBatch([
        { surface: 'harness:self-implement', rec: { ts: '2026-08-09T04:00:00.000Z', level: 'info', category: 'wrong', event: 'run-exact-suffix', data: 'not the target' } },
        { surface: 'harness:self-implement', rec: { ts: '2026-08-09T04:01:00.000Z', level: 'info', category: 'wrong', event: 'other', data: 'run-exactly' } },
        { surface: 'harness:self-implement', rec: { ts: '2026-08-09T04:02:00.000Z', level: 'info', category: 'wrong', event: 'failed', data: 'failed to load run-exact' } },
        { surface: 'harness:self-implement', rec: { ts: '2026-08-09T04:03:00.000Z', level: 'info', category: 'whole-value', event: 'run-exact', data: 'unrelated' } },
        { surface: 'harness:self-implement', rec: { ts: '2026-08-09T04:04:00.000Z', level: 'info', category: 'structured', event: 'completed', data: { runId: 'run-exact' } } },
      ]);
      logs.close();
      const inspection = inspectGoalRun('run-exact', goalRunStore.path, { targets: [{ name: 'large', dbPath: logPath }] });
      expect(inspection).toMatchObject({
        ledgerError: null,
        records: [],
        logs: {
          count: 1_003,
          categories: [
            { category: 'goal.run', count: 1_001 },
            { category: 'structured', count: 1 },
            { category: 'whole-value', count: 1 },
          ],
        },
      });
      const brokenLedger = join(stateDir, 'broken.db');
      writeFileSync(brokenLedger, 'not a SQLite database');
      const ledgerFailure = inspectGoalRun('run-exact', brokenLedger, { targets: [] });
      expect(ledgerFailure).toMatchObject({ records: [], ledgerError: expect.any(String) });
      expect(renderGoalRunInspection(ledgerFailure)).toContain('ledger error:');
    } finally {
      goalRunStore.close();
    }
  });

  test('self clarify pending preserves two goal-row prefixes and appends one run-status column without filtering rows', () => {
    const workingDirectory = mkdtempSync(join(tmpdir(), 'clarify-pending-cli-'));
    directories.push(workingDirectory);
    const goalsDirectory = join(workingDirectory, 'docs', 'goals');
    const stateDir = join(workingDirectory, '.elanous-test');
    mkdirSync(goalsDirectory, { recursive: true });
    const clarification = (id: string) => [
      '- Clarification:',
      `  - id: ${id}`,
      '  - header: Scope',
      '  - question: Choose a scope',
      '  - options:',
      '    - label: A',
      '      description: First scope',
      '    - label: B',
      '      description: Second scope',
      '  - includeOther: false',
      '  - answer: DEFERRED-UNTIL: Choose a scope',
    ].join('\n');
    writeFileSync(join(goalsDirectory, 'GOAL-first.md'), `# First goal\n${clarification('first-choice')}\n`);
    writeFileSync(join(goalsDirectory, 'GOAL-second.md'), `# Second goal\n${clarification('second-choice')}\n`);
    writeFileSync(join(goalsDirectory, 'GOAL-without-pending.md'), '# Goal without clarification\n');
    const cli = join(process.cwd(), 'bin', 'elanous.mjs');
    const result = Bun.spawnSync({
      cmd: [process.execPath, cli, `--test=${stateDir}`, 'self', 'clarify', 'pending'],
      cwd: workingDirectory,
      env: process.env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const rows = result.stdout.toString().trim().split('\n');
    const goalRows = clarifyPendingGoalRows(rows);
    expect(goalRows).toHaveLength(2);
    expect(goalRows).toEqual([
      'docs/goals/GOAL-first.md: 1 pending — first-choice — run: no-record',
      'docs/goals/GOAL-second.md: 1 pending — second-choice — run: no-record',
    ]);
    expect(rows.at(-1)).toBe(`summary: 3 goal documents scanned; 2 with unanswered clarifications — this lists records written in goal documents, not live waits; live waits: questions pending — scope: population goal-run-store path=${join(stateDir, 'self-implement', 'goal-runs.db')} records=0 state=missing; unfinished-run-ledger directory=${join(stateDir, 'run-ledger')} entries=0 state=missing`);
  }, 60_000);

  test('self clarify pending uses the discovered repository root from a nested cwd and --dir', () => {
    const workingDirectory = mkdtempSync(join(tmpdir(), 'clarify-pending-repository-root-'));
    directories.push(workingDirectory);
    const goalsDirectory = join(workingDirectory, 'docs', 'goals');
    const nestedDirectory = join(workingDirectory, 'nested');
    const stateDir = join(workingDirectory, '.elanous-test');
    mkdirSync(goalsDirectory, { recursive: true });
    mkdirSync(nestedDirectory, { recursive: true });
    writeFileSync(join(workingDirectory, 'package.json'), JSON.stringify({ name: 'elanous' }));
    writeFileSync(join(goalsDirectory, 'GOAL-nested.md'), [
      '# Nested goal',
      '- Clarification:',
      '  - id: nested-choice',
      '  - header: Scope',
      '  - question: Choose a scope',
      '  - options:',
      '    - label: A',
      '      description: First scope',
      '  - includeOther: false',
      '  - answer: DEFERRED-UNTIL: Choose a scope',
    ].join('\n'));
    const result = Bun.spawnSync({
      cmd: [process.execPath, join(process.cwd(), 'bin', 'elanous.mjs'), `--test=${stateDir}`, 'self', 'clarify', 'pending', '--dir', '../docs/goals'],
      cwd: nestedDirectory,
      env: process.env,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(clarifyPendingGoalRows(result.stdout.toString().trim().split('\n'))).toEqual([
      'docs/goals/GOAL-nested.md: 1 pending — nested-choice — run: no-record',
    ]);
  }, 60_000);

  test('self clarify pending emits exactly one final summary after every goal row', () => {
    const workingDirectory = mkdtempSync(join(tmpdir(), 'clarify-pending-summary-cli-'));
    directories.push(workingDirectory);
    const goalsDirectory = join(workingDirectory, 'docs', 'goals');
    const stateDir = join(workingDirectory, '.elanous-test');
    mkdirSync(goalsDirectory, { recursive: true });
    const clarification = [
      '- Clarification:',
      '  - id: final-summary-choice',
      '  - header: Scope',
      '  - question: Choose a scope',
      '  - options:',
      '    - label: A',
      '      description: First scope',
      '  - includeOther: false',
      '  - answer: DEFERRED-UNTIL: Choose a scope',
    ].join('\n');
    writeFileSync(join(goalsDirectory, 'GOAL-pending.md'), `# Goal\n${clarification}\n`);
    const cli = join(process.cwd(), 'bin', 'elanous.mjs');
    const result = Bun.spawnSync({
      cmd: [process.execPath, cli, `--test=${stateDir}`, 'self', 'clarify', 'pending'],
      cwd: workingDirectory,
      env: process.env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const rows = result.stdout.toString().trim().split('\n');
    const summaryRows = rows.filter((row) => row.startsWith('summary: '));
    expect(summaryRows).toEqual([
      `summary: 1 goal documents scanned; 1 with unanswered clarifications — this lists records written in goal documents, not live waits; live waits: questions pending — scope: population goal-run-store path=${join(stateDir, 'self-implement', 'goal-runs.db')} records=0 state=missing; unfinished-run-ledger directory=${join(stateDir, 'run-ledger')} entries=0 state=missing`,
    ]);
    expect(rows.at(-1)).toBe(summaryRows[0]);
    expect(clarifyPendingGoalRows(rows)).toEqual([
      'docs/goals/GOAL-pending.md: 1 pending — final-summary-choice — run: no-record',
    ]);
  }, 60_000);

  test('clarify-pending rows reject output without a final summary row', () => {
    const rows = ['docs/goals/GOAL-first.md: 1 pending — first-choice — run: no-record'];

    expect(() => clarifyPendingGoalRows(rows)).toThrow();
  });

  test('self goal-run CLI reports present and absent ledgers with JSON log summaries', () => {
    const workingDirectory = mkdtempSync(join(tmpdir(), 'goal-run-cli-'));
    directories.push(workingDirectory);
    const stateDir = join(workingDirectory, '.elanous-test');
    const goalFile = join(stateDir, 'GOAL-test.txt');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(goalFile, 'Test goal\n- GoalId: 0123456789abcdef\n');
    const goalRunStore = new GoalRunStore(join(stateDir, 'self-implement', 'goal-runs.db'));
    try {
      goalRunStore.insert(goalFile, record('run-cli-autopsy'));
    } finally {
      goalRunStore.close();
    }
    const logs = new LogStore(join(stateDir, 'logs', 'logs.db'));
    logs.insertBatch([{ surface: 'harness:self-implement', rec: { ts: '2026-08-09T01:00:00.000Z', level: 'info', category: 'goal.run', event: 'started', data: 'run-cli-autopsy' } }]);
    logs.close();
    const cli = join(process.cwd(), 'bin', 'elanous.mjs');
    const present = Bun.spawnSync({
      cmd: [process.execPath, cli, `--test=${stateDir}`, 'self', 'goal-run', 'run-cli-autopsy', '--json'],
      cwd: process.cwd(), env: process.env, stdout: 'pipe', stderr: 'pipe',
    });
    const absent = Bun.spawnSync({
      cmd: [process.execPath, cli, `--test=${stateDir}`, 'self', 'goal-run', 'run-cli-absent'],
      cwd: process.cwd(), env: process.env, stdout: 'pipe', stderr: 'pipe',
    });
    expect(present.exitCode, present.stderr.toString()).toBe(0);
    expect(JSON.parse(present.stdout.toString())).toMatchObject({
      runId: 'run-cli-autopsy',
      records: [{ runId: 'run-cli-autopsy' }],
      logs: {
        count: 1,
        categories: [{ category: 'goal.run', count: 1, firstAt: '2026-08-09T01:00:00.000Z', lastAt: '2026-08-09T01:00:00.000Z' }],
      },
    });
    expect(absent.exitCode).toBe(0);
    expect(absent.stdout.toString()).toContain('ledger records: 0');
    expect(absent.stdout.toString()).toContain('ledger: no goal run record');
  }, 60_000);

  test('self goal-runs CLI prints both SQLite records for one run ID', () => {
    const { store: goalRunStore, goalFile } = store();
    try {
      goalRunStore.insert(goalFile, record('run-cli-proof'));
      goalRunStore.insert(goalFile, record('run-cli-proof', 'abandoned'));
    } finally {
      goalRunStore.close();
    }
    const stateDir = goalFile.slice(0, goalFile.lastIndexOf('/'));
    const result = Bun.spawnSync({
      cmd: [process.execPath, 'bin/elanous.mjs', 'self', 'goal-runs', 'run-cli-proof', '--json'],
      cwd: process.cwd(),
      env: { ...process.env, ELANOUS_STATE_DIR: stateDir },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim().split('\n')).toHaveLength(2);
    expect(result.stdout.toString()).toContain('run-cli-proof');
  }, 60_000);

  test('attaches a recorded child brain from a fixture headless.spawn onto the existing run row', () => {
    const { store: goalRunStore, goalFile } = store();
    const logPath = join(dirname(goalFile), 'logs', 'child-brain.db');
    try {
      goalRunStore.insert(goalFile, record('run-brain'), 'goal-brain');
      const logs = new LogStore(logPath);
      logs.insertBatch([{
        surface: 'harness:self-implement',
        rec: {
          ts: '2026-08-09T01:00:00.000Z',
          level: 'info',
          category: 'self-implement',
          event: 'headless.spawn',
          data: { runId: 'run-brain', childLlm: { provider: 'anthropic', model: 'claude-opus-4-8' } },
        },
      }]);
      logs.close();

      const result = loadGoalRunQuery({ limit: 10 }, goalRunStore.path, {
        targets: [{ name: 'fixture', dbPath: logPath }],
      });
      expect(result?.records[0]?.childBrain).toEqual({
        status: 'recorded',
        provider: 'anthropic',
        model: 'claude-opus-4-8',
        selectedFrom: {
          policy: 'newest-headless-spawn',
          targetId: logPath,
          eventId: expect.any(Number),
          eventAt: '2026-08-09T01:00:00.000Z',
        },
      });
      expect(result?.records[0]?.childBrain).not.toHaveProperty('selectedFrom.candidateCount');
      expect(result?.records).toHaveLength(1);
      expect(result?.records[0]).toMatchObject({
        runId: 'run-brain',
        goalId: 'goal-brain',
        goalFile: expect.any(String),
        record: { runId: 'run-brain', outcome: 'completed', rounds: 1, model: 'test-model' },
      });
      expect(result).not.toHaveProperty('completionRate');
      expect(result).not.toHaveProperty('byBrain');
    } finally {
      goalRunStore.close();
    }
  });

  test('keeps one row for many child spawns and exposes which newest event was chosen', () => {
    const { store: goalRunStore, goalFile } = store();
    const logPath = join(dirname(goalFile), 'logs', 'multi-spawn.db');
    try {
      goalRunStore.insert(goalFile, record('run-multi'), 'goal-multi');
      const logs = new LogStore(logPath);
      logs.insertBatch([
        {
          surface: 'harness:self-implement',
          rec: {
            ts: '2026-08-09T01:00:00.000Z',
            level: 'info',
            category: 'self-implement',
            event: 'headless.spawn',
            data: { runId: 'run-multi', childLlm: { provider: 'openai', model: 'gpt-5' } },
          },
        },
        {
          surface: 'harness:self-implement',
          rec: {
            ts: '2026-08-09T02:00:00.000Z',
            level: 'info',
            category: 'self-implement',
            event: 'headless.spawn',
            data: { runId: 'run-multi', childLlm: { provider: 'anthropic', model: 'claude-sonnet-4-6' } },
          },
        },
        {
          surface: 'harness:self-implement',
          rec: {
            ts: '2026-08-09T02:00:00.000Z',
            level: 'info',
            category: 'self-implement',
            event: 'headless.spawn',
            data: { runId: 'run-multi', childLlm: { provider: 'grok', model: 'grok-4.6' } },
          },
        },
      ]);
      logs.close();

      const result = loadGoalRunQuery({ limit: 10 }, goalRunStore.path, {
        targets: [{ name: 'fixture', dbPath: logPath }],
      });
      expect(result?.records).toHaveLength(1);
      const selected = result?.records[0]?.childBrain;
      expect(selected).toEqual({
        status: 'recorded',
        provider: 'grok',
        model: 'grok-4.6',
        selectedFrom: {
          policy: 'newest-headless-spawn',
          targetId: logPath,
          eventId: expect.any(Number),
          eventAt: '2026-08-09T02:00:00.000Z',
        },
      });
      expect(selected).not.toHaveProperty('selectedFrom.candidateCount');
    } finally {
      goalRunStore.close();
    }
  });

  test('reports explicit absence, unspecified, and unknown as distinct child-brain statuses', () => {
    const { store: goalRunStore, goalFile } = store();
    const logPath = join(dirname(goalFile), 'logs', 'absence.db');
    try {
      goalRunStore.insert(goalFile, { ...record('run-absent'), startedAt: '2026-08-09T00:00:00.000Z' }, 'goal-absent');
      goalRunStore.insert(goalFile, { ...record('run-unspecified'), startedAt: '2026-08-09T00:01:00.000Z' }, 'goal-unspecified');
      goalRunStore.insert(goalFile, { ...record('run-unknown'), startedAt: '2026-08-09T00:02:00.000Z' }, 'goal-unknown');
      const logs = new LogStore(logPath);
      logs.insertBatch([
        {
          surface: 'harness:self-implement',
          rec: {
            ts: '2026-08-09T01:00:00.000Z',
            level: 'info',
            category: 'self-implement',
            event: 'headless.spawn',
            data: { runId: 'run-unspecified', childLlm: null },
          },
        },
        {
          surface: 'harness:self-implement',
          rec: {
            ts: '2026-08-09T01:01:00.000Z',
            level: 'info',
            category: 'self-implement',
            event: 'headless.spawn',
            data: { runId: 'run-unknown', cwd: '/tmp' },
          },
        },
        {
          surface: 'harness:self-implement',
          rec: {
            ts: '2026-08-09T01:02:00.000Z',
            level: 'info',
            category: 'other',
            event: 'headless.spawn',
            data: { runId: 'run-absent', childLlm: { provider: 'openai', model: 'gpt-5' } },
          },
        },
        {
          surface: 'harness:self-implement',
          rec: {
            ts: '2026-08-09T01:03:00.000Z',
            level: 'info',
            category: 'self-implement',
            event: 'headless.done',
            data: { runId: 'run-absent', childLlm: { provider: 'openai', model: 'gpt-5' } },
          },
        },
        {
          surface: 'harness:self-implement',
          rec: {
            ts: '2026-08-09T01:04:00.000Z',
            level: 'info',
            category: 'self-implement',
            event: 'headless.spawn',
            data: { runId: 'run-other', childLlm: { provider: 'openai', model: 'gpt-5' } },
          },
        },
      ]);
      logs.close();

      const result = loadGoalRunQuery({ limit: 10 }, goalRunStore.path, {
        targets: [{ name: 'fixture', dbPath: logPath }],
      });
      const byRunId = Object.fromEntries((result?.records ?? []).map((entry) => [entry.runId, entry.childBrain]));
      expect(byRunId['run-absent']).toEqual({ status: 'absent' });
      expect(byRunId['run-unspecified']).toMatchObject({
        status: 'unspecified',
        selectedFrom: { policy: 'newest-headless-spawn', targetId: logPath, eventAt: '2026-08-09T01:00:00.000Z' },
      });
      expect(byRunId['run-unknown']).toMatchObject({
        status: 'unknown',
        selectedFrom: { policy: 'newest-headless-spawn', targetId: logPath, eventAt: '2026-08-09T01:01:00.000Z' },
      });
      expect(byRunId['run-unspecified']).not.toHaveProperty('selectedFrom.candidateCount');
      expect(byRunId['run-unknown']).not.toHaveProperty('selectedFrom.candidateCount');
      expect(byRunId['run-absent']).not.toEqual(byRunId['run-unspecified']);
      expect(byRunId['run-absent']).not.toEqual(byRunId['run-unknown']);
      expect(byRunId['run-unspecified']).not.toEqual(byRunId['run-unknown']);
      expect(JSON.stringify(byRunId['run-absent'])).not.toContain('""');
    } finally {
      goalRunStore.close();
    }
  });

  test('survives unreadable log stores and missing provider or model without failing the query', () => {
    const { store: goalRunStore, goalFile } = store();
    const readablePath = join(dirname(goalFile), 'logs', 'partial.db');
    const unreadablePath = join(dirname(goalFile), 'logs', 'missing.db');
    try {
      goalRunStore.insert(goalFile, record('run-partial'), 'goal-partial');
      goalRunStore.insert(goalFile, record('run-unreadable-only'), 'goal-unreadable');
      const logs = new LogStore(readablePath);
      logs.insertBatch([{
        surface: 'harness:self-implement',
        rec: {
          ts: '2026-08-09T01:00:00.000Z',
          level: 'info',
          category: 'self-implement',
          event: 'headless.spawn',
          data: { runId: 'run-partial', childLlm: { provider: 'anthropic', model: '' } },
        },
      }]);
      logs.close();

      const result = loadGoalRunQuery({ limit: 10 }, goalRunStore.path, {
        targets: [{ name: 'readable', dbPath: readablePath }, { name: 'locked', dbPath: unreadablePath }],
        openLogStore: (path) => {
          if (path === unreadablePath) throw new Error('database is locked');
          return LogStore.openReadOnly(path);
        },
      });
      expect(result).not.toBeNull();
      const byRunId = Object.fromEntries((result?.records ?? []).map((entry) => [entry.runId, entry.childBrain]));
      expect(byRunId['run-partial']).toMatchObject({
        status: 'unknown',
        selectedFrom: { policy: 'newest-headless-spawn', targetId: readablePath },
      });
      expect(byRunId['run-partial']).not.toHaveProperty('selectedFrom.candidateCount');
      expect(byRunId['run-unreadable-only']).toEqual({ status: 'unreadable' });
    } finally {
      goalRunStore.close();
    }
  });

  test('does not read or select headless.spawn events from run IDs outside the queried page', () => {
    const { store: goalRunStore, goalFile } = store();
    const logPath = join(dirname(goalFile), 'logs', 'scoped.db');
    const queried: Array<{ grep?: string; events?: string[] }> = [];
    try {
      goalRunStore.insert(goalFile, { ...record('run-visible'), startedAt: '2026-08-09T02:00:00.000Z' }, 'goal-visible');
      goalRunStore.insert(goalFile, { ...record('run-other-page'), startedAt: '2026-08-09T01:00:00.000Z' }, 'goal-other');
      const logs = new LogStore(logPath);
      logs.insertBatch([
        {
          surface: 'harness:self-implement',
          rec: {
            ts: '2026-08-09T03:00:00.000Z',
            level: 'info',
            category: 'self-implement',
            event: 'headless.spawn',
            data: { runId: 'run-visible', childLlm: { provider: 'anthropic', model: 'claude-opus-4-8' } },
          },
        },
        {
          surface: 'harness:self-implement',
          rec: {
            ts: '2026-08-09T04:00:00.000Z',
            level: 'info',
            category: 'self-implement',
            event: 'headless.spawn',
            data: { runId: 'run-other-page', childLlm: { provider: 'openai', model: 'gpt-5' } },
          },
        },
        {
          surface: 'harness:self-implement',
          rec: {
            ts: '2026-08-09T05:00:00.000Z',
            level: 'info',
            category: 'self-implement',
            event: 'headless.spawn',
            data: { runId: 'run-never-queried', childLlm: { provider: 'grok', model: 'grok-4.6' } },
          },
        },
      ]);
      logs.close();

      const result = loadGoalRunQuery({ limit: 1 }, goalRunStore.path, {
        targets: [{ name: 'fixture', dbPath: logPath }],
        openLogStore: (path) => {
          const store = LogStore.openReadOnly(path);
          return {
            query: (filters = {}) => {
              queried.push({ grep: filters.grep, events: filters.events });
              return store.query(filters);
            },
            close: () => store.close(),
          };
        },
      });
      expect(result?.records).toHaveLength(1);
      expect(result?.records[0]?.runId).toBe('run-visible');
      expect(result?.records[0]?.childBrain).toMatchObject({
        status: 'recorded',
        provider: 'anthropic',
        model: 'claude-opus-4-8',
        selectedFrom: { targetId: logPath },
      });
      expect(queried.every((call) => call.events?.includes('headless.spawn'))).toBe(true);
      expect(queried.map((call) => call.grep)).toEqual(['run-visible']);
      expect(queried.some((call) => call.grep === 'run-other-page' || call.grep === 'run-never-queried')).toBe(false);
    } finally {
      goalRunStore.close();
    }
  });

  test('selects the same federated source when target order and local event ids collide', () => {
    const { store: goalRunStore, goalFile } = store();
    const firstPath = join(dirname(goalFile), 'logs', 'first.db');
    const secondPath = join(dirname(goalFile), 'logs', 'second.db');
    try {
      goalRunStore.insert(goalFile, record('run-federated'), 'goal-federated');
      const sameTs = '2026-08-09T02:00:00.000Z';
      for (const [path, provider, model] of [
        [firstPath, 'openai', 'gpt-5'],
        [secondPath, 'anthropic', 'claude-sonnet-4-6'],
      ] as const) {
        const logs = new LogStore(path);
        logs.insertBatch([{
          surface: 'harness:self-implement',
          rec: {
            ts: sameTs,
            level: 'info',
            category: 'self-implement',
            event: 'headless.spawn',
            data: { runId: 'run-federated', childLlm: { provider, model } },
          },
        }]);
        logs.close();
      }

      const firstThenSecond = loadGoalRunQuery({ limit: 10 }, goalRunStore.path, {
        targets: [{ name: 'first', dbPath: firstPath }, { name: 'second', dbPath: secondPath }],
      });
      const secondThenFirst = loadGoalRunQuery({ limit: 10 }, goalRunStore.path, {
        targets: [{ name: 'second', dbPath: secondPath }, { name: 'first', dbPath: firstPath }],
      });
      const selected = firstThenSecond?.records[0]?.childBrain;
      expect(selected).toEqual(secondThenFirst?.records[0]?.childBrain);
      expect(selected).toMatchObject({
        status: 'recorded',
        selectedFrom: {
          policy: 'newest-headless-spawn',
          eventAt: sameTs,
        },
      });
      expect(selected && 'selectedFrom' in selected ? selected.selectedFrom.targetId : undefined).toBe(
        firstPath.localeCompare(secondPath) > 0 ? firstPath : secondPath,
      );
      expect(firstThenSecond?.records).toHaveLength(1);
    } finally {
      goalRunStore.close();
    }
  });
});

describe('RFC 런 출처 O5 — goal_run 기계 칸 (2026-09-25)', () => {
  test('기록에 기계 칸이 없으면 넣는 프로세스의 값으로 채우고, 이미 있으면 그대로 둔다(pod·원격 값이 이긴다)', () => {
    const origin = () => ({ hostId: '01THISHOST', hostname: 'mac' });
    expect(withRecordOrigin(record('run-o5a'), origin)).toMatchObject({ hostId: '01THISHOST', hostname: 'mac' });
    expect(withRecordOrigin({ ...record('run-o5b'), hostId: '01PODHOST', hostname: 'k3d-node' }, origin)).toMatchObject({ hostId: '01PODHOST', hostname: 'k3d-node' });
    expect(withRecordOrigin(record('run-o5c'), () => { throw new Error('no id'); })).not.toHaveProperty('hostId');
  });

  test('host_id 생성 열로 기계별로 셀 수 있고, 옛 스키마 DB 에는 열이 더해진다(옛 행은 NULL)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-run-o5-'));
    const path = join(dir, 'goal-runs.db');
    const old = new Database(path);
    old.run(`CREATE TABLE goal_run (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, goal_id TEXT NOT NULL, goal_file TEXT NOT NULL, doc TEXT NOT NULL,
      started_at TEXT GENERATED ALWAYS AS (json_extract(doc, '$.startedAt')) VIRTUAL, outcome TEXT GENERATED ALWAYS AS (json_extract(doc, '$.outcome')) VIRTUAL,
      rounds INTEGER GENERATED ALWAYS AS (json_extract(doc, '$.rounds')) VIRTUAL, executor TEXT GENERATED ALWAYS AS (json_extract(doc, '$.model')) VIRTUAL)`);
    old.run("INSERT INTO goal_run (run_id, goal_id, goal_file, doc) VALUES ('run-old', 'g', '/g.md', '{\"runId\":\"run-old\"}')");
    old.close();
    const store = new GoalRunStore(path);
    try {
      store.insert('/g.md', { ...record('run-new'), hostId: '01WINHOST', hostname: 'host-e' }, 'g');
      const db = new Database(path, { readonly: true });
      const rows = db.query('SELECT run_id, host_id FROM goal_run ORDER BY id').all() as Array<{ run_id: string; host_id: string | null }>;
      db.close();
      expect(rows).toEqual([{ run_id: 'run-old', host_id: null }, { run_id: 'run-new', host_id: '01WINHOST' }]);
      expect(store.query({ limit: 10, docFilters: [{ path: '$.hostId', value: '01WINHOST' }] })?.total).toBe(1);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
