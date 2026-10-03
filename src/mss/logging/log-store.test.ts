/**
 * LogStore / StoreSink — 통합 로그 패브릭 LF0 계약 (2026-07-13).
 *
 * 전부 `:memory:` DB — 실 ~/.elanous/logs 미접촉. 기본 싱글톤은 NODE_ENV=test
 * 에서 null 이므로(오염 가드) 여기서는 명시 인스턴스만 쓴다.
 */
import { setDefaultTimeout, afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LogRecord } from './record.js';
import type { LogSink } from './sink.js';
import {
  LOG_STORE_READONLY_BUSY_TIMEOUT_MS,
  LogStore,
  StoreSink,
  deriveLogLevel,
  logsDbPath,
  getDefaultLogStore,
  resolveLogInstanceName,
  setLogInstanceName,
  registerLogStoreSink,
  _resetDefaultLogStoreForTest,
} from './log-store.js';
import { debug } from '../../debug/log.js';
import { resetNestBootObservationForTest } from '../../agent/nest-depth.js';
import * as nestDepth from '../../agent/nest-depth.js';
import { prodInstanceRoot, resetEffectiveInstanceRoot, setTreeDerivedTestForTesting } from '../../instance/resolve.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

function rec(over: Partial<LogRecord> = {}): LogRecord {
  return {
    ts: new Date().toISOString(),
    category: 'voice.stt.openai',
    event: 'handshake.ok',
    ...over,
  };
}

describe('deriveLogLevel — 명시 level only · 기본 debug (OH10 PR-b2)', () => {
  it('명시 level 을 그대로 물질화한다 (critical 포함)', () => {
    expect(deriveLogLevel(rec({ event: 'handshake.error', level: 'critical' }))).toBe('critical');
    expect(deriveLogLevel(rec({ event: 'iteration', level: 'warn' }))).toBe('warn');
    expect(deriveLogLevel(rec({ event: 'aborted', level: 'error' }))).toBe('error');
    expect(deriveLogLevel(rec({ event: 'start', level: 'info' }))).toBe('info');
  });
  it('명시가 없으면 event/category 접미사와 무관하게 debug (유도 삭제됨)', () => {
    // 접미사 유도가 삭제됐으므로 error/warn/info 접미사여도 명시 없으면 debug.
    expect(deriveLogLevel(rec({ event: 'handshake.error' }))).toBe('debug');
    expect(deriveLogLevel(rec({ event: 'spawn.failed' }))).toBe('debug');
    expect(deriveLogLevel(rec({ event: 'handshake.timeout' }))).toBe('debug');
    expect(deriveLogLevel(rec({ event: 'tts.degraded' }))).toBe('debug');
    expect(deriveLogLevel(rec({ category: 'voice.chat.error', event: 'toggle' }))).toBe('debug');
    // info 접미사(라이프사이클) 도 명시 안 하면 debug 로 강등 — PLAN 의도.
    expect(deriveLogLevel(rec({ event: 'handshake.ok' }))).toBe('debug');
    expect(deriveLogLevel(rec({ event: 'boot' }))).toBe('debug');
    expect(deriveLogLevel(rec({ event: 'phase' }))).toBe('debug');
  });
});

describe('LogStore writer contention', () => {
  it('exposes a 5000ms writer timeout without changing the read-only timeout', () => {
    const store = new LogStore(':memory:');
    try {
      expect(((store as unknown as { db: Database }).db.query('PRAGMA busy_timeout').get() as { timeout: number }).timeout).toBe(5000);
    } finally { store.close(); }
  });

  it('carries a failed open observation to the next writable connection', () => {
    const dir = mkdtempSync(join(tmpdir(), 'elanous-log-loss-'));
    const path = join(dir, 'logs.db');
    const db = new Database(path);
    db.run(`CREATE TABLE logs (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, ts_ms INTEGER NOT NULL,
      level TEXT NOT NULL, instance TEXT NOT NULL DEFAULT '', surface TEXT NOT NULL,
      category TEXT NOT NULL, event TEXT NOT NULL, session_id TEXT, trace_id TEXT, data TEXT)`);
    db.run('PRAGMA journal_mode = WAL');
    db.run('BEGIN EXCLUSIVE');
    const observed: LogRecord[] = [];
    const off = debug.registerSink({ name: 'busy-loss-test', emit: (row) => observed.push(row) });
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(() => new LogStore(path)).toThrow();
      expect(stderr.mock.calls.some(([line]) => String(line).includes('[store.sqlite] busy-lost'))).toBe(true);
      db.run('COMMIT');
      const store = new LogStore(path);
      try {
        expect(observed.some((row) => row.category === 'store.sqlite' && row.event === 'busy-lost'
          && (row.data as { store: string; op: string; waitedMs: number }).store === 'logs'
          && (row.data as { op: string }).op === 'open')).toBe(true);
        expect(store.query({ exactCategories: ['store.sqlite'], events: ['busy-lost'] })).toHaveLength(1);
      } finally { store.close(); }
    } finally {
      try { db.run('ROLLBACK'); } catch { /* already committed */ }
      db.close();
      off();
      stderr.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 35_000);

  it('opens and persists a row while a second connection holds BEGIN IMMEDIATE for 1.5 seconds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elanous-log-busy-'));
    const path = join(dir, 'logs.db');
    const seed = new Database(path);
    seed.run(`CREATE TABLE logs (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, ts_ms INTEGER NOT NULL,
      level TEXT NOT NULL, instance TEXT NOT NULL DEFAULT '', surface TEXT NOT NULL,
      category TEXT NOT NULL, event TEXT NOT NULL, session_id TEXT, trace_id TEXT, data TEXT)`);
    seed.close();
    const holder = Bun.spawn({
      cmd: [process.execPath, '-e', `import { Database } from 'bun:sqlite';
        const db = new Database(process.argv[1]);
        db.run('BEGIN IMMEDIATE');
        console.log('locked');
        setTimeout(() => { db.run('COMMIT'); db.close(); }, 1500);`, path],
      stdout: 'pipe', stderr: 'pipe',
    });
    try {
      const reader = holder.stdout.getReader();
      const ready = await reader.read();
      reader.releaseLock();
      expect(new TextDecoder().decode(ready.value)).toContain('locked');
      const openedAt = Date.now();
      const writer = new LogStore(path);
      try {
        expect(((writer as unknown as { db: Database }).db.query('PRAGMA busy_timeout').get() as { timeout: number }).timeout).toBe(5000);
        expect(Date.now() - openedAt).toBeGreaterThanOrEqual(1000);
        writer.insertBatch([{ rec: rec({ event: 'after-lock' }), surface: 'nexus' }]);
        expect(writer.count()).toBe(1);
        const check = new Database(path, { readonly: true });
        try { expect((check.query('SELECT COUNT(*) AS count FROM logs').get() as { count: number }).count).toBe(1); }
        finally { check.close(); }
      } finally { writer.close(); }
      expect(await holder.exited).toBe(0);
    } finally {
      if (holder.exitCode === null) holder.kill();
      await holder.exited;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});

describe('LogStore host identity', () => {
  it('inserts inherited host ID with explicit data.hostId precedence and empty fallback', () => {
    const previous = process.env.ELANOUS_HOST_ID;
    const store = new LogStore(':memory:', { instance: 'test:universe' });
    try {
      process.env.ELANOUS_HOST_ID = '01HOSTTEST';
      store.insertBatch([
        { rec: rec({ event: 'inherited', data: { value: 1 } }), surface: 'nexus' },
        { rec: rec({ event: 'explicit', data: { hostId: 'caller-host' } }), surface: 'nexus' },
      ]);
      delete process.env.ELANOUS_HOST_ID;
      store.insertBatch([{ rec: rec({ event: 'absent' }), surface: 'nexus' }]);
      const rows = Object.fromEntries(store.recent(3).map((row) => [row.event, row]));
      expect(rows.inherited!.host_id).toBe('01HOSTTEST');
      expect(rows.explicit!.host_id).toBe('caller-host');
      expect(rows.absent!.host_id).toBe('');
      expect(rows.inherited!.instance).toBe('test:universe');
    } finally {
      store.close();
      if (previous === undefined) delete process.env.ELANOUS_HOST_ID;
      else process.env.ELANOUS_HOST_ID = previous;
    }
  });

  it('migrates old schema without changing old row host identity', () => {
    const dir = mkdtempSync(join(tmpdir(), 'elanous-host-migrate-'));
    const path = join(dir, 'logs.db');
    try {
      const old = new Database(path);
      old.run(`CREATE TABLE logs (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, ts_ms INTEGER NOT NULL,
        level TEXT NOT NULL, instance TEXT NOT NULL DEFAULT '', surface TEXT NOT NULL,
        category TEXT NOT NULL, event TEXT NOT NULL, session_id TEXT, trace_id TEXT, data TEXT)`);
      old.run(`INSERT INTO logs (ts, ts_ms, level, instance, surface, category, event)
        VALUES ('2026-01-01T00:00:00Z', 1, 'info', 'prod', 'nexus', 'boot', 'old')`);
      old.close();
      const store = new LogStore(path);
      expect(store.recent(1)[0]!.host_id).toBe('');
      expect(store.recent(1)[0]!.instance).toBe('prod');
      store.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('LogStore — 적재/조회/보존', () => {
  it('insertBatch → recent 왕복 (명시 level·surface 물질화 포함)', () => {
    const store = new LogStore(':memory:');
    store.insertBatch([
      // 명시 없음 → debug (접미사 유도 삭제됨).
      { rec: rec({ event: 'handshake.ok', data: { elapsedMs: 12 } }), surface: 'nexus' },
      // 명시 error → error (safety-net·error 사이트가 쓰는 명시 채널).
      { rec: rec({ event: 'handshake.error', level: 'error' }), surface: 'pwa' },
    ]);
    const rows = store.recent(10);
    expect(rows.length).toBe(2);
    // 내림차순 — 최신 먼저. 같은 ts_ms 면 id 내림차순(뒤에 넣은 것 먼저).
    expect(rows[0]!.surface).toBe('pwa');
    expect(rows[0]!.level).toBe('error');
    expect(rows[1]!.surface).toBe('nexus');
    expect(rows[1]!.level).toBe('debug');
    expect(JSON.parse(rows[1]!.data!)).toEqual({ elapsedMs: 12 });
    store.close();
  });

  it('aggregateRuns groups valid JSON by run, filters before grouping and bounds only the run count', () => {
    const store = new LogStore(':memory:');
    const base = Date.parse('2026-09-28T00:00:00.000Z');
    try {
      store.insertBatch([
        { rec: rec({ ts: new Date(base).toISOString(), data: { run_id: 'old', parentRunId: 'parent' } }), surface: 'nexus' },
        { rec: rec({ ts: new Date(base + 1000).toISOString(), data: { runId: 'old', parentRunId: '' } }), surface: 'nexus' },
        { rec: rec({ ts: new Date(base + 2000).toISOString(), data: { runId: 'new' } }), surface: 'pwa' },
        { rec: rec({ ts: new Date(base + 3000).toISOString(), data: { runId: '' } }), surface: 'nexus' },
        { rec: rec({ ts: new Date(base + 4000).toISOString() }), surface: 'nexus' },
      ]);
      const db = (store as unknown as { db: Database }).db;
      db.run("INSERT INTO logs (ts, ts_ms, level, instance, surface, category, event, data) VALUES (?, ?, 'info', 'prod', 'nexus', 'test', 'bad', '{bad')", [new Date(base + 5000).toISOString(), base + 5000]);
      expect(store.aggregateRuns({ sinceMs: base, untilMs: base + 2500 }, 10)).toEqual([
        { runId: 'new', parentRunId: null, firstTs: new Date(base + 2000).toISOString(), lastTs: new Date(base + 2000).toISOString(), rows: 1 },
        { runId: 'old', parentRunId: 'parent', firstTs: new Date(base).toISOString(), lastTs: new Date(base + 1000).toISOString(), rows: 2 },
      ]);
      expect(store.aggregateRuns({ surfaces: ['nexus'], sinceMs: base, untilMs: base + 2500 }, 1).map((run) => run.runId)).toEqual(['old']);
      expect(store.count()).toBe(6);
    } finally { store.close(); }
  });

  it('aggregateRuns chooses first and last timestamps by ts_ms across different timezone offsets', () => {
    const store = new LogStore(':memory:');
    const firstTs = '2026-09-28T10:00:00+09:00'; // 01:00Z, lexically later than the last timestamp
    const lastTs = '2026-09-28T03:00:00+00:00';
    try {
      store.insertBatch([
        { rec: rec({ ts: lastTs, data: { runId: 'offset-run' } }), surface: 'nexus' },
        { rec: rec({ ts: firstTs, data: { run_id: 'offset-run', parentRunId: 'parent' } }), surface: 'nexus' },
      ]);
      expect(store.aggregateRuns({}, 10)).toEqual([
        { runId: 'offset-run', parentRunId: 'parent', firstTs, lastTs, rows: 2 },
      ]);
      expect(store.aggregateRuns({ sinceMs: Date.parse(lastTs) }, 10)).toEqual([
        { runId: 'offset-run', parentRunId: null, firstTs: lastTs, lastTs, rows: 1 },
      ]);
    } finally { store.close(); }
  });

  it('countMatching 은 조회 상한 없이 같은 필터의 전체 일치 수를 센다', () => {
    const store = new LogStore(':memory:');
    store.insertBatch([
      { rec: rec({ category: 'self-implement.run', event: 'done' }), surface: 'nexus' },
      { rec: rec({ category: 'self-implement.run', event: 'failed' }), surface: 'pwa' },
      { rec: rec({ category: 'other.run', event: 'done' }), surface: 'nexus' },
    ]);
    expect(store.countMatching({ categories: ['self-implement'] })).toBe(2);
    expect(store.countMatching({ categories: ['self-implement'], surfaces: ['nexus'] })).toBe(1);
    expect(store.countMatching({ grep: 'failed' })).toBe(1);
    store.close();
  });

  it('정확 event/category 필터는 false positive·접두 충돌 없이 기존 prefix/grep 의미와 함께 동작한다', () => {
    const store = new LogStore(':memory:');
    store.insertBatch([
      { rec: rec({ category: 'signal', event: 'lifecycle.bridge-attached' }), surface: 'nexus' },
      { rec: rec({ category: 'signal.gate1', event: 'headless.progress', data: { terminalTail: 'lifecycle.bridge-attached' } }), surface: 'nexus' },
      { rec: rec({ category: 'signal.gate2', event: 'lifecycle.bridge-attached.more' }), surface: 'nexus' },
      { rec: rec({ category: 'other', event: 'other.event', data: { text: 'lifecycle.bridge-attached' } }), surface: 'pwa' },
    ]);

    expect(store.query({ events: ['lifecycle.bridge-attached'], limit: 10 }).map((row) => row.event))
      .toEqual(['lifecycle.bridge-attached']);
    expect(store.query({ exactCategories: ['signal'], limit: 10 }).map((row) => row.category))
      .toEqual(['signal']);
    expect(store.query({ categories: ['signal'], limit: 10 }).map((row) => row.category).sort())
      .toEqual(['signal', 'signal.gate1', 'signal.gate2']);
    expect(store.query({ grep: 'lifecycle.bridge-attached', limit: 10 }).map((row) => row.event).sort())
      .toEqual(['headless.progress', 'lifecycle.bridge-attached', 'lifecycle.bridge-attached.more', 'other.event']);

    for (const query of [
      { events: ['lifecycle.bridge-attached'] },
      { exactCategories: ['signal'] },
    ]) {
      expect(store.query({ ...query, limit: 10 }).length).toBe(store.countMatching(query));
    }
    expect(store.query({ events: [], exactCategories: [], limit: 10 }).map((row) => row.id))
      .toEqual(store.query({ limit: 10 }).map((row) => row.id));
    store.close();
  });

  it('events()는 필터 안의 찍힌 이벤트 이름을 DISTINCT로 모으고 events 축은 받지 않는다', () => {
    const store = new LogStore(':memory:');
    const now = Date.now();
    store.insertBatch([
      { rec: rec({ ts: new Date(now).toISOString(), category: 'goal-author', event: 'plan-sizing' }), surface: 'nexus' },
      { rec: rec({ ts: new Date(now).toISOString(), category: 'goal-author', event: 'plan-sizing' }), surface: 'pwa' },
      { rec: rec({ ts: new Date(now).toISOString(), category: 'goal-author', event: 'ledger' }), surface: 'nexus' },
      { rec: rec({ ts: new Date(now - 48 * 3_600_000).toISOString(), category: 'goal-author', event: 'stale' }), surface: 'nexus' },
      { rec: rec({ ts: new Date(now).toISOString(), category: 'other', event: 'outside' }), surface: 'nexus' },
    ]);
    expect(store.events({ categories: ['goal-author'], sinceMs: now - 24 * 3_600_000 })).toEqual(['ledger', 'plan-sizing']);
    expect(store.events({ categories: ['goal-author'], sinceMs: now - 24 * 3_600_000 })).not.toContain('stale');
    expect(store.events({ categories: ['goal-author'], sinceMs: now - 24 * 3_600_000 })).not.toContain('outside');
    store.close();
  });

  it('OH10 명시 level 이 접미사 유도를 이기고 level 컬럼에 물질화된다', () => {
    const store = new LogStore(':memory:');
    store.insertBatch([
      // event 'iteration' 은 유도상 debug 이나 명시 warn → warn 으로 저장.
      { rec: rec({ category: 'goal.loop', event: 'iteration', level: 'warn' }), surface: 'nexus' },
      // event 'aborted' + 명시 error (goal.loop 계측 공백 신설 패턴).
      { rec: rec({ category: 'goal.loop', event: 'aborted', level: 'error' }), surface: 'nexus' },
    ]);
    const rows = store.recent(10);
    const byEvent = Object.fromEntries(rows.map((r) => [r.event, r.level]));
    expect(byEvent['iteration']).toBe('warn');
    expect(byEvent['aborted']).toBe('error');
    store.close();
  });

  it('session_id/trace_id 가 컬럼으로 분리 적재된다', () => {
    const store = new LogStore(':memory:');
    store.insertBatch([{
      rec: { ...rec(), session_id: 'sess-1', trace_id: 'tr-1' } as LogRecord,
      surface: 'nexus',
    }]);
    const row = store.recent(1)[0]!;
    expect(row.session_id).toBe('sess-1');
    expect(row.trace_id).toBe('tr-1');
    store.close();
  });

  it('보존정책 — maxAgeDays 초과 행 삭제', () => {
    const store = new LogStore(':memory:');
    const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
    store.insertBatch([
      { rec: rec({ ts: old }), surface: 'nexus' },
      { rec: rec(), surface: 'nexus' },
    ]);
    const { deletedByAge } = store.enforceRetention({ maxAgeDays: 7, maxDbMb: 0 });
    expect(deletedByAge).toBe(1);
    expect(store.count()).toBe(1);
    store.close();
  });

  it('보존정책 0 = 정리 안 함', () => {
    const store = new LogStore(':memory:');
    const old = new Date(Date.now() - 100 * 86_400_000).toISOString();
    store.insertBatch([{ rec: rec({ ts: old }), surface: 'nexus' }]);
    const r = store.enforceRetention({ maxAgeDays: 0, maxDbMb: 0 });
    expect(r.deletedByAge).toBe(0);
    expect(store.count()).toBe(1);
    store.close();
  });
});

describe('StoreSink — 배치·가드·fail-soft', () => {
  it('임계 도달 시 setImmediate 로 detach flush 된다', async () => {
    const store = new LogStore(':memory:');
    const sink = new StoreSink(store, 'nexus', { flushBatchSize: 3, flushIntervalMs: 60_000, installExitHandlers: false });
    sink.emit(rec());
    sink.emit(rec());
    expect(store.count()).toBe(0); // 아직 버퍼
    sink.emit(rec()); // 임계 → setImmediate flush
    await new Promise((r2) => setImmediate(r2));
    expect(store.count()).toBe(3);
    expect(sink.pending).toBe(0);
    store.close();
  });

  it('자기참조 가드 — logs.* 카테고리는 스토어 재진입 금지', () => {
    const store = new LogStore(':memory:');
    const sink = new StoreSink(store, 'nexus', { installExitHandlers: false });
    sink.emit(rec({ category: 'logs.stream', event: 'open' }));
    sink.flush();
    expect(store.count()).toBe(0);
    store.close();
  });

  it('스토어 실패는 삼킨다 (파일 트레일이 진실원 — emit/flush 무throw)', () => {
    const store = new LogStore(':memory:');
    store.close(); // 닫힌 DB → insert 실패 유도
    const sink = new StoreSink(store, 'nexus', { installExitHandlers: false });
    sink.emit(rec());
    expect(() => sink.flush()).not.toThrow();
  });

  it('버퍼 하드캡 — 실패 누적 시 오래된 것부터 드롭(메모리 가드)', () => {
    const store = new LogStore(':memory:');
    store.close();
    const sink = new StoreSink(store, 'nexus', { bufferCap: 5, flushBatchSize: 1_000_000, flushIntervalMs: 60_000, installExitHandlers: false });
    for (let i = 0; i < 20; i++) sink.emit(rec({ event: `e${i}` }));
    expect(sink.pending).toBeLessThanOrEqual(5);
  });
});

describe('StoreSink — 종료 플러시', () => {
  const storeSrc = join(import.meta.dir, 'log-store.ts');

  type ProcessListener = (...args: unknown[]) => void;

  function snapshotListeners(): Record<'beforeExit' | 'SIGINT' | 'SIGTERM', Set<ProcessListener>> {
    return {
      beforeExit: new Set(process.listeners('beforeExit') as ProcessListener[]),
      SIGINT: new Set(process.listeners('SIGINT') as ProcessListener[]),
      SIGTERM: new Set(process.listeners('SIGTERM') as ProcessListener[]),
    };
  }

  function addedListeners(
    event: 'beforeExit' | 'SIGINT' | 'SIGTERM',
    before: ReturnType<typeof snapshotListeners>,
  ): ProcessListener[] {
    return (process.listeners(event) as ProcessListener[]).filter((listener) => !before[event].has(listener));
  }

  function removeAddedListeners(before: ReturnType<typeof snapshotListeners>): void {
    for (const event of ['beforeExit', 'SIGINT', 'SIGTERM'] as const) {
      for (const listener of addedListeners(event, before)) {
        process.removeListener(event, listener as (...args: unknown[]) => void);
      }
    }
  }

  async function pollUntil(pred: () => boolean, ms: number, label: string): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (pred()) return;
      await Bun.sleep(15);
    }
    throw new Error(`timeout waiting for ${label}`);
  }

  function writeChildScript(dir: string): string {
    const path = join(dir, 'store-signal-child.ts');
    const body = [
      "import { writeFileSync } from 'fs';",
      `import { LogStore, StoreSink } from ${JSON.stringify(storeSrc)};`,
      '',
      'const dbPath = process.env.STORE_DB_PATH!;',
      'const markerPath = process.env.STORE_MARKER_PATH!;',
      'const readyPath = process.env.STORE_READY_PATH!;',
      'const mode = process.env.STORE_MODE!;',
      'const signal = process.env.STORE_SIGNAL as NodeJS.Signals;',
      "const lastEvent = process.env.STORE_LAST_EVENT ?? 'last-line';",
      '',
      'const rec = (event: string) => ({',
      '  ts: new Date().toISOString(),',
      "  category: 'repo-design-check',",
      '  event,',
      '});',
      '',
      'const preexisting = process.listeners(signal).slice();',
      'const before = preexisting.length;',
      'const store = new LogStore(dbPath);',
      'const sink = new StoreSink(store, \'cli\', {',
      '  flushIntervalMs: 60_000,',
      '  flushBatchSize: 1_000_000,',
      '  installExitHandlers: true,',
      '});',
      "sink.emit(rec('install'));",
      "if (mode === 'double') {",
      "  sink.emit(rec('second'));",
      '  const after = process.listeners(signal).length;',
      '  writeFileSync(markerPath, JSON.stringify({ before, after, delta: after - before }));',
      '  process.exit(0);',
      "} else if (mode === 'exit') {",
      '  sink.emit(rec(lastEvent));',
      '} else {',
      '  for (const listener of preexisting) {',
      '    process.removeListener(signal, listener as (...args: unknown[]) => void);',
      '  }',
      '  sink.emit(rec(lastEvent));',
      "  if (mode === 'other') {",
      '    process.on(signal, () => {',
      "      writeFileSync(markerPath, 'call', { flag: 'a' });",
      '    });',
      '  }',
      "  writeFileSync(readyPath, 'ready');",
      '  setInterval(() => {}, 1 << 30);',
      '}',
      '',
    ].join('\n');
    writeFileSync(path, body);
    return path;
  }

  async function spawnStoreChild(opts: {
    dir: string;
    signal: 'SIGINT' | 'SIGTERM';
    mode: 'other' | 'none' | 'double' | 'exit';
    lastEvent?: string;
  }): Promise<{
    proc: ReturnType<typeof Bun.spawn>;
    dbPath: string;
    markerPath: string;
    readyPath: string;
  }> {
    const dbPath = join(opts.dir, 'logs.db');
    const markerPath = join(opts.dir, 'marker.txt');
    const readyPath = join(opts.dir, 'ready.txt');
    const childPath = writeChildScript(opts.dir);
    const proc = Bun.spawn(['bun', childPath], {
      cwd: opts.dir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        STORE_DB_PATH: dbPath,
        STORE_MARKER_PATH: markerPath,
        STORE_READY_PATH: readyPath,
        STORE_MODE: opts.mode,
        STORE_SIGNAL: opts.signal,
        STORE_LAST_EVENT: opts.lastEvent ?? 'last-line',
      },
    });
    return { proc, dbPath, markerPath, readyPath };
  }

  function ledgerHasEvent(dbPath: string, event: string): boolean {
    try {
      const store = LogStore.openReadOnly(dbPath);
      try {
        return store.query({ exactCategories: ['repo-design-check'], events: [event] }).length >= 1;
      } finally {
        store.close();
      }
    } catch {
      return false;
    }
  }

  function defaultSignalExit(signal: 'SIGINT' | 'SIGTERM', code: number | null, got: string | null): boolean {
    if (got === signal) return true;
    if (signal === 'SIGINT' && code === 130) return true;
    if (signal === 'SIGTERM' && code === 143) return true;
    return false;
  }

  it('기본값은 installExitHandlers=true 이고 첫 emit 때 게으르게 등록한다', () => {
    const store = new LogStore(':memory:');
    const before = snapshotListeners();
    const sink = new StoreSink(store, 'nexus', { flushIntervalMs: 60_000, flushBatchSize: 1_000_000 });
    expect(addedListeners('beforeExit', before)).toHaveLength(0);
    expect(addedListeners('SIGINT', before)).toHaveLength(0);
    expect(addedListeners('SIGTERM', before)).toHaveLength(0);
    sink.emit(rec({ event: 'first' }));
    expect(addedListeners('beforeExit', before)).toHaveLength(1);
    expect(addedListeners('SIGINT', before)).toHaveLength(1);
    expect(addedListeners('SIGTERM', before)).toHaveLength(1);
    sink.emit(rec({ event: 'second' }));
    expect(addedListeners('beforeExit', before)).toHaveLength(1);
    expect(addedListeners('SIGINT', before)).toHaveLength(1);
    expect(addedListeners('SIGTERM', before)).toHaveLength(1);
    sink.close();
    expect(addedListeners('beforeExit', before)).toHaveLength(0);
    expect(addedListeners('SIGINT', before)).toHaveLength(0);
    expect(addedListeners('SIGTERM', before)).toHaveLength(0);
    store.close();
  });

  it('installExitHandlers=false 면 종료 훅을 달지 않는다', () => {
    const store = new LogStore(':memory:');
    const before = snapshotListeners();
    const sink = new StoreSink(store, 'nexus', { installExitHandlers: false, flushIntervalMs: 60_000 });
    sink.emit(rec({ event: 'no-hook' }));
    expect(addedListeners('beforeExit', before)).toHaveLength(0);
    expect(addedListeners('SIGINT', before)).toHaveLength(0);
    expect(addedListeners('SIGTERM', before)).toHaveLength(0);
    expect(sink.pending).toBe(1);
    store.close();
  });

  it('beforeExit 는 마지막 문장으로 남은 버퍼를 원장에 보낸다', () => {
    const store = new LogStore(':memory:');
    const before = snapshotListeners();
    const sink = new StoreSink(store, 'nexus', { flushIntervalMs: 60_000, flushBatchSize: 1_000_000 });
    sink.emit(rec({ event: 'last-line' }));
    expect(store.count()).toBe(0);
    expect(sink.pending).toBe(1);
    const [onExit] = addedListeners('beforeExit', before);
    expect(onExit).toBeFunction();
    (onExit as (code: number) => void)(0);
    expect(store.count()).toBe(1);
    expect(store.recent(1)[0]!.event).toBe('last-line');
    expect(sink.pending).toBe(0);
    sink.close();
    expect(addedListeners('beforeExit', before)).toHaveLength(0);
    store.close();
  });

  it('SIGINT 는 자기 리스너만 떼고 남의 리스너는 남긴 채 버퍼를 원장에 보낸다', () => {
    const store = new LogStore(':memory:');
    const before = snapshotListeners();
    const other = (): void => {};
    process.on('SIGINT', other);
    try {
      const sink = new StoreSink(store, 'nexus', { flushIntervalMs: 60_000, flushBatchSize: 1_000_000 });
      sink.emit(rec({ event: 'sigint-last' }));
      const added = addedListeners('SIGINT', before).filter((listener) => listener !== other);
      expect(added).toHaveLength(1);
      (added[0] as () => void)();
      expect(store.count()).toBe(1);
      expect(store.recent(1)[0]!.event).toBe('sigint-last');
      expect(sink.pending).toBe(0);
      expect(process.listeners('SIGINT')).toContain(other);
      expect(process.listeners('SIGINT')).not.toContain(added[0]);
      sink.close();
      expect(process.listeners('SIGINT')).toContain(other);
      expect(addedListeners('SIGINT', before).filter((listener) => listener !== other)).toHaveLength(0);
    } finally {
      process.removeListener('SIGINT', other);
      removeAddedListeners(before);
      store.close();
    }
  });

  it('SIGTERM 은 자기 리스너만 떼고 남의 리스너는 남긴 채 버퍼를 원장에 보낸다', () => {
    const store = new LogStore(':memory:');
    const before = snapshotListeners();
    const other = (): void => {};
    process.on('SIGTERM', other);
    try {
      const sink = new StoreSink(store, 'nexus', { flushIntervalMs: 60_000, flushBatchSize: 1_000_000 });
      sink.emit(rec({ event: 'sigterm-last' }));
      const added = addedListeners('SIGTERM', before).filter((listener) => listener !== other);
      expect(added).toHaveLength(1);
      (added[0] as () => void)();
      expect(store.count()).toBe(1);
      expect(store.recent(1)[0]!.event).toBe('sigterm-last');
      expect(sink.pending).toBe(0);
      expect(process.listeners('SIGTERM')).toContain(other);
      expect(process.listeners('SIGTERM')).not.toContain(added[0]);
      sink.close();
      expect(process.listeners('SIGTERM')).toContain(other);
      expect(addedListeners('SIGTERM', before).filter((listener) => listener !== other)).toHaveLength(0);
    } finally {
      process.removeListener('SIGTERM', other);
      removeAddedListeners(before);
      store.close();
    }
  });

  it('종료 플러시 실패는 dropCounts.flushFailure 축에 남긴다', () => {
    const store = new LogStore(':memory:');
    store.close();
    const before = snapshotListeners();
    const sink = new StoreSink(store, 'nexus', { flushIntervalMs: 60_000, flushBatchSize: 1_000_000 });
    sink.emit(rec({ event: 'lost-on-exit' }));
    const [onExit] = addedListeners('beforeExit', before);
    expect(() => (onExit as (code: number) => void)(0)).not.toThrow();
    expect(sink.pending).toBe(0);
    expect(sink.dropped).toEqual({ total: 1, flushFailure: 1, bufferCap: 0 });
    sink.close();
    expect(addedListeners('beforeExit', before)).toHaveLength(0);
  });

  it('종료 훅이 있어도 200ms unref 배치 타이머는 그대로 돈다', async () => {
    const store = new LogStore(':memory:');
    const before = snapshotListeners();
    const sink = new StoreSink(store, 'nexus', { flushIntervalMs: 30, flushBatchSize: 1_000_000 });
    sink.emit(rec({ event: 'batched' }));
    const timer = (sink as unknown as { timer: { hasRef?: () => boolean } | null }).timer;
    expect(timer).not.toBeNull();
    if (typeof timer?.hasRef === 'function') {
      expect(timer.hasRef()).toBe(false);
    }
    expect(store.count()).toBe(0);
    await new Promise((r) => setTimeout(r, 80));
    expect(store.count()).toBe(1);
    expect(store.recent(1)[0]!.event).toBe('batched');
    expect(sink.pending).toBe(0);
    sink.close();
    expect(addedListeners('beforeExit', before)).toHaveLength(0);
    store.close();
  });

  it('짧은 프로세스가 emit 후 바로 끝나도 원장에 마지막 줄이 남는다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elanous-storesink-exit-'));
    try {
      const { proc, dbPath } = await spawnStoreChild({
        dir,
        signal: 'SIGINT',
        mode: 'exit',
        lastEvent: 'last-line',
      });
      const code = await proc.exited;
      expect(code).toBe(0);
      await pollUntil(() => ledgerHasEvent(dbPath, 'last-line'), 5_000, 'flushed last log');
      expect(ledgerHasEvent(dbPath, 'last-line')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  it('debug.log 가 프로세스의 마지막 문장이어도 임시 logs.db 에 그 category 행이 1개 이상이다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elanous-storesink-debug-log-'));
    const dbPath = join(dir, 'logs.db');
    const childPath = join(dir, 'last-debug-log.ts');
    const debugSrc = join(import.meta.dir, '../../debug/log.ts');
    const storeSrc = join(import.meta.dir, 'log-store.ts');
    writeFileSync(childPath, [
      `import { debug } from ${JSON.stringify(debugSrc)};`,
      `import { LogStore, StoreSink } from ${JSON.stringify(storeSrc)};`,
      '',
      'const dbPath = process.env.STORE_DB_PATH!;',
      'const store = new LogStore(dbPath);',
      "const sink = new StoreSink(store, 'cli', {",
      '  flushIntervalMs: 60_000,',
      '  flushBatchSize: 1_000_000,',
      '  installExitHandlers: true,',
      '});',
      'debug.registerSink(sink);',
      "debug.log('repo-design-check', 'last-line');",
    ].join('\n'));
    try {
      const proc = Bun.spawn(['bun', childPath], {
        cwd: dir,
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          STORE_DB_PATH: dbPath,
          NODE_ENV: 'production',
          ELANOUS_STATE_DIR: dir,
        },
      });
      const code = await proc.exited;
      expect(code).toBe(0);
      await pollUntil(() => existsSync(dbPath), 5_000, 'logs.db created');
      await pollUntil(() => {
        try {
          const store = LogStore.openReadOnly(dbPath);
          try {
            return store.query({ exactCategories: ['repo-design-check'] }).length >= 1;
          } finally {
            store.close();
          }
        } catch {
          return false;
        }
      }, 5_000, 'debug.log last line in logs.db');
      const store = LogStore.openReadOnly(dbPath);
      try {
        const rows = store.query({ exactCategories: ['repo-design-check'] });
        expect(rows.length).toBeGreaterThanOrEqual(1);
        expect(rows.some((row) => row.event === 'last-line')).toBe(true);
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  it('SIGINT 로 죽어도 그때까지의 버퍼가 원장에 닿고 남의 리스너는 산다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elanous-storesink-int-'));
    try {
      const { proc, dbPath, markerPath, readyPath } = await spawnStoreChild({
        dir,
        signal: 'SIGINT',
        mode: 'other',
        lastEvent: 'sigint-last',
      });
      try {
        await pollUntil(() => existsSync(readyPath), 5_000, 'child ready');
        proc.kill('SIGINT');
        await pollUntil(() => existsSync(markerPath), 5_000, 'other-handler marker');
        await pollUntil(() => ledgerHasEvent(dbPath, 'sigint-last'), 5_000, 'flushed last log');
        await Bun.sleep(300);
        expect(readFileSync(markerPath, 'utf8')).toBe('call');
        expect(ledgerHasEvent(dbPath, 'sigint-last')).toBe(true);
      } finally {
        proc.kill('SIGKILL');
        await proc.exited;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  it('SIGTERM 으로 죽어도 그때까지의 버퍼가 원장에 닿고 남의 리스너는 산다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elanous-storesink-term-'));
    try {
      const { proc, dbPath, markerPath, readyPath } = await spawnStoreChild({
        dir,
        signal: 'SIGTERM',
        mode: 'other',
        lastEvent: 'sigterm-last',
      });
      try {
        await pollUntil(() => existsSync(readyPath), 5_000, 'child ready');
        proc.kill('SIGTERM');
        await pollUntil(() => existsSync(markerPath), 5_000, 'other-handler marker');
        await pollUntil(() => ledgerHasEvent(dbPath, 'sigterm-last'), 5_000, 'flushed last log');
        await Bun.sleep(300);
        expect(readFileSync(markerPath, 'utf8')).toBe('call');
        expect(ledgerHasEvent(dbPath, 'sigterm-last')).toBe(true);
      } finally {
        proc.kill('SIGKILL');
        await proc.exited;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  it('남은 리스너가 없으면 SIGINT 를 재전달한다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elanous-storesink-int-solo-'));
    try {
      const { proc, dbPath, readyPath } = await spawnStoreChild({
        dir,
        signal: 'SIGINT',
        mode: 'none',
        lastEvent: 'solo-flush',
      });
      await pollUntil(() => existsSync(readyPath), 5_000, 'child ready');
      proc.kill('SIGINT');
      const code = await proc.exited;
      await pollUntil(() => ledgerHasEvent(dbPath, 'solo-flush'), 5_000, 'flushed last log');
      expect(ledgerHasEvent(dbPath, 'solo-flush')).toBe(true);
      expect(defaultSignalExit('SIGINT', proc.exitCode ?? code, proc.signalCode)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  it('남은 리스너가 없으면 SIGTERM 을 재전달한다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elanous-storesink-term-solo-'));
    try {
      const { proc, dbPath, readyPath } = await spawnStoreChild({
        dir,
        signal: 'SIGTERM',
        mode: 'none',
        lastEvent: 'solo-term',
      });
      await pollUntil(() => existsSync(readyPath), 5_000, 'child ready');
      proc.kill('SIGTERM');
      const code = await proc.exited;
      await pollUntil(() => ledgerHasEvent(dbPath, 'solo-term'), 5_000, 'flushed last log');
      expect(ledgerHasEvent(dbPath, 'solo-term')).toBe(true);
      expect(defaultSignalExit('SIGTERM', proc.exitCode ?? code, proc.signalCode)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  it('같은 sink 를 두 번 emit 해도 SIGINT 리스너는 하나다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elanous-storesink-double-'));
    try {
      const { proc, markerPath } = await spawnStoreChild({
        dir,
        signal: 'SIGINT',
        mode: 'double',
      });
      const code = await proc.exited;
      expect(code).toBe(0);
      const report = JSON.parse(readFileSync(markerPath, 'utf8')) as { delta: number };
      expect(report.delta).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);
});

describe('registerLogStoreSink — sink 이후 부팅 관측', () => {
  function withLogStoreEnv<T>(fn: () => T): T {
    const nodeEnv = process.env.NODE_ENV;
    const stateDir = process.env.ELANOUS_STATE_DIR;
    const dir = mkdtempSync(join(tmpdir(), 'elanous-logstore-sink-'));
    process.env.NODE_ENV = 'production';
    process.env.ELANOUS_STATE_DIR = dir;
    _resetDefaultLogStoreForTest();
    resetNestBootObservationForTest();
    try {
      return fn();
    } finally {
      _resetDefaultLogStoreForTest();
      resetNestBootObservationForTest();
      rmSync(dir, { recursive: true, force: true });
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;
      if (stateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = stateDir;
    }
  }

  async function withLogStoreEnvAsync(fn: () => Promise<void>): Promise<void> {
    const nodeEnv = process.env.NODE_ENV;
    const stateDir = process.env.ELANOUS_STATE_DIR;
    const dir = mkdtempSync(join(tmpdir(), 'elanous-logstore-sink-'));
    process.env.NODE_ENV = 'production';
    process.env.ELANOUS_STATE_DIR = dir;
    _resetDefaultLogStoreForTest();
    resetNestBootObservationForTest();
    try {
      await fn();
    } finally {
      _resetDefaultLogStoreForTest();
      resetNestBootObservationForTest();
      rmSync(dir, { recursive: true, force: true });
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;
      if (stateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = stateDir;
    }
  }

  it('성공 등록 뒤 boot 관측이 등록된 sink를 거쳐 스토어에 도달하며, 여러 등록에도 한 번이다', () => withLogStoreEnv(() => {
    const sinks: StoreSink[] = [];
    const registerSink = (sink: LogSink): (() => void) => {
      expect(sink).toBeInstanceOf(StoreSink);
      sinks.push(sink as StoreSink);
      return debug.registerSink(sink);
    };
    const observeSpy = spyOn(nestDepth, 'observeNestAtBoot');
    try {
      const off1 = registerLogStoreSink(registerSink, 'test');
      const off2 = registerLogStoreSink(registerSink, 'test');
      expect(off1).toBeFunction();
      expect(off2).toBeFunction();
      expect(sinks).toHaveLength(2);
      expect(observeSpy).toHaveBeenCalledTimes(2);
      for (const sink of sinks) sink.flush();
      const rows = getDefaultLogStore()?.recent(10) ?? [];
      expect(rows.filter((row) => row.category === 'substrate.nest' && row.event === 'boot')).toHaveLength(1);
      off1?.();
      off2?.();
    } finally {
      observeSpy.mockRestore();
    }
  }));

  it('등록된 sink 는 종료 훅이 켜져 마지막 emit 이 원장에 닿는다', () => withLogStoreEnv(() => {
    const sinks: StoreSink[] = [];
    const registerSink = (sink: LogSink): (() => void) => {
      sinks.push(sink as StoreSink);
      return () => {};
    };
    const preexisting = {
      beforeExit: new Set(process.listeners('beforeExit')),
      SIGINT: new Set(process.listeners('SIGINT')),
      SIGTERM: new Set(process.listeners('SIGTERM')),
    };
    const off = registerLogStoreSink(registerSink, 'test');
    try {
      expect(off).toBeFunction();
      expect(sinks).toHaveLength(1);
      const sink = sinks[0]!;
      sink.emit(rec({ category: 'repo-design-check', event: 'last-line' }));
      const addedExit = process.listeners('beforeExit').filter((listener) => !preexisting.beforeExit.has(listener));
      expect(addedExit).toHaveLength(1);
      expect(getDefaultLogStore()?.query({ exactCategories: ['repo-design-check'] }).length ?? 0).toBe(0);
      (addedExit[0] as (code: number) => void)(0);
      const rows = getDefaultLogStore()?.query({ exactCategories: ['repo-design-check'] }) ?? [];
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows[0]!.event).toBe('last-line');
    } finally {
      off?.();
      for (const event of ['beforeExit', 'SIGINT', 'SIGTERM'] as const) {
        expect(process.listeners(event).filter((listener) => !preexisting[event].has(listener))).toHaveLength(0);
      }
    }
  }));

  it('store 불가(null)면 관측을 발화하지 않는다', () => {
    resetNestBootObservationForTest();
    const nodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    const observeSpy = spyOn(nestDepth, 'observeNestAtBoot');
    try {
      expect(registerLogStoreSink(() => () => {}, 'test')).toBeNull();
      expect(observeSpy).not.toHaveBeenCalled();
    } finally {
      observeSpy.mockRestore();
      resetNestBootObservationForTest();
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;
    }
  });

  it('관측이 던져도 반환과 retention 배선은 유지한다', async () => withLogStoreEnvAsync(async () => {
    const store = getDefaultLogStore();
    expect(store).not.toBeNull();
    const retention = { maxAgeDays: 1, maxDbMb: 1 };
    const retentionSpy = spyOn(store!, 'enforceRetention');
    const observeSpy = spyOn(nestDepth, 'observeNestAtBoot').mockImplementation(() => { throw new Error('observation unavailable'); });
    let unregistered = false;
    try {
      const off = registerLogStoreSink(() => () => { unregistered = true; }, 'test', retention);
      expect(off).toBeFunction();
      expect(observeSpy).toHaveBeenCalledTimes(1);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(retentionSpy).toHaveBeenCalledWith(retention);
      off?.();
      expect(unregistered).toBe(true);
    } finally {
      observeSpy.mockRestore();
      retentionSpy.mockRestore();
    }
  }));
});

describe('경로/싱글톤 격리', () => {
  it('logsDbPath 는 ELANOUS_STATE_DIR 을 존중한다', () => {
    const prev = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = '/tmp/elanous-isolated';
    try {
      expect(logsDbPath()).toBe('/tmp/elanous-isolated/logs/logs.db');
    } finally {
      if (prev === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = prev;
    }
  });

  it('NODE_ENV=test 에서 기본 싱글톤은 null (실 DB 오염 가드)', () => {
    expect(getDefaultLogStore()).toBeNull();
  });

  it('테스트 비활성화는 debug에 남기고 열기 실패만 stderr에 한 번 알린다', () => {
    const nodeEnv = process.env.NODE_ENV;
    const stateDir = process.env.ELANOUS_STATE_DIR;
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdout = spyOn(process.stdout, 'write').mockImplementation(() => true);
    const debugLog = spyOn(debug, 'log').mockImplementation(() => undefined);
    const dir = mkdtempSync(join(tmpdir(), 'elanous-logstore-unavailable-'));
    try {
      process.env.NODE_ENV = 'test';
      _resetDefaultLogStoreForTest();
      expect(getDefaultLogStore()).toBeNull();
      expect(getDefaultLogStore()).toBeNull();
      expect(debugLog).toHaveBeenCalledTimes(1);
      expect(debugLog).toHaveBeenCalledWith('mss.log-store', 'default log store unavailable', { detail: 'disabled because NODE_ENV=test' });
      expect(stderr).not.toHaveBeenCalled();

      process.env.NODE_ENV = 'production';
      process.env.ELANOUS_STATE_DIR = join(dir, 'state-file');
      writeFileSync(process.env.ELANOUS_STATE_DIR, 'not a directory');
      _resetDefaultLogStoreForTest();
      expect(getDefaultLogStore()).toBeNull();
      expect(getDefaultLogStore()).toBeNull();
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(String(stderr.mock.calls[0]![0])).toContain('could not be opened');
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      debugLog.mockRestore();
      stderr.mockRestore();
      stdout.mockRestore();
      _resetDefaultLogStoreForTest();
      rmSync(dir, { recursive: true, force: true });
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;
      if (stateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = stateDir;
    }
  });

  it('MSS_LOG_STORE_DIAGNOSTICS=0이면 null 반환은 유지하고 진단을 내지 않는다', () => {
    const nodeEnv = process.env.NODE_ENV;
    const diagnostics = process.env.MSS_LOG_STORE_DIAGNOSTICS;
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      process.env.NODE_ENV = 'test';
      process.env.MSS_LOG_STORE_DIAGNOSTICS = '0';
      _resetDefaultLogStoreForTest();
      expect(getDefaultLogStore()).toBeNull();
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
      _resetDefaultLogStoreForTest();
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;
      if (diagnostics === undefined) delete process.env.MSS_LOG_STORE_DIAGNOSTICS;
      else process.env.MSS_LOG_STORE_DIAGNOSTICS = diagnostics;
    }
  });
});

describe('인스턴스 identity (LF7-a) — 멀티 엘라누스 출처 스탬프', () => {
  const originalStateDir = process.env.ELANOUS_STATE_DIR;

  beforeEach(() => {
    setLogInstanceName(undefined);
    setTreeDerivedTestForTesting(false);
    if (originalStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = originalStateDir;
    resetEffectiveInstanceRoot();
  });

  afterEach(() => {
    setLogInstanceName(undefined);
    setTreeDerivedTestForTesting(undefined);
    if (originalStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = originalStateDir;
    resetEffectiveInstanceRoot();
  });

  function withStateDir<T>(dir: string | undefined, fn: () => T): T {
    const prev = process.env.ELANOUS_STATE_DIR;
    if (dir === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = dir;
    resetEffectiveInstanceRoot();
    try { return fn(); } finally {
      if (prev === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = prev;
      resetEffectiveInstanceRoot();
    }
  }

  it('운영 루트를 명시했을 때만 prod 이름을 쓴다', () => {
    withStateDir(prodInstanceRoot(), () => {
      expect(resolveLogInstanceName()).toBe('prod');
    });
  });

  it('.elanous-test state dir → test:<repo폴더명>', () => {
    withStateDir('/Users/x/source/monad-agent/.elanous-test', () => {
      expect(resolveLogInstanceName()).toBe('test:monad-agent');
    });
  });

  it('그 외 state dir → test:<dir 이름> (telegram-test 등)', () => {
    withStateDir('/Users/x/.elanous/telegram-test', () => {
      expect(resolveLogInstanceName()).toBe('test:telegram-test');
    });
  });

  it('setLogInstanceName 오버라이드가 유도보다 이긴다 · 빈 문자열은 무시', () => {
    withStateDir(prodInstanceRoot(), () => {
      expect(resolveLogInstanceName()).toBe('prod');
      setLogInstanceName('pilot-2');
      try {
        expect(resolveLogInstanceName()).toBe('pilot-2');
        setLogInstanceName('   ');
        expect(resolveLogInstanceName()).toBe('prod');
      } finally {
        setLogInstanceName(undefined);
      }
    });
  });

  it('insertBatch 는 스토어 instance 를 각 행에 박제 · query.instances 필터', () => {
    const store = new LogStore(':memory:', { instance: 'test:monad-agent' });
    store.insertBatch([{ rec: rec(), surface: 'nexus' }]);
    const rows = store.recent(1);
    expect(rows[0]!.instance).toBe('test:monad-agent');
    expect(store.query({ instances: ['test:monad-agent'] }).length).toBe(1);
    expect(store.query({ instances: ['prod'] }).length).toBe(0);
    store.close();
  });

  it('facets 에 instances 집계 포함', () => {
    const store = new LogStore(':memory:', { instance: 'prod' });
    store.insertBatch([{ rec: rec(), surface: 'nexus' }, { rec: rec(), surface: 'pwa' }]);
    const f = store.facets();
    expect(f.instances).toEqual([{ instance: 'prod', count: 2 }]);
    store.close();
  });

  it('구 스키마 DB 마이그레이션 — instance 컬럼 추가 + 자기 이름 backfill', () => {
    const dir = mkdtempSync(join(tmpdir(), 'elanous-logstore-'));
    const path = join(dir, 'logs.db');
    // LF7-a 이전 스키마를 손으로 재현
    const legacy = new Database(path);
    legacy.run(`CREATE TABLE logs(
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, ts_ms INTEGER NOT NULL,
      level TEXT NOT NULL, surface TEXT NOT NULL, category TEXT NOT NULL, event TEXT NOT NULL,
      session_id TEXT, trace_id TEXT, data TEXT)`);
    legacy.run(`INSERT INTO logs (ts, ts_ms, level, surface, category, event) VALUES ('2026-07-13T00:00:00.000Z', 1, 'info', 'nexus', 'boot', 'ready')`);
    legacy.close();
    const store = new LogStore(path, { instance: 'test:monad-agent' });
    const rows = store.recent(10);
    expect(rows.length).toBe(1);
    expect(rows[0]!.instance).toBe('test:monad-agent');
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('read-only open (LF7-b) — 연합 조회 불변식', () => {
  it('openReadOnly — 조회는 되고 insert 는 throw (write 0 구조 집행)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'elanous-logstore-ro-'));
    const path = join(dir, 'logs.db');
    const writer = new LogStore(path, { instance: 'test:monad-agent' });
    writer.insertBatch([{ rec: rec(), surface: 'nexus' }]);
    writer.close();
    const ro = LogStore.openReadOnly(path);
    expect(ro.readonly).toBe(true);
    expect(ro.query({}).length).toBe(1);
    expect(ro.query({})[0]!.instance).toBe('test:monad-agent');
    expect(() => ro.insertBatch([{ rec: rec(), surface: 'nexus' }])).toThrow();
    ro.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('openReadOnly — busy timeout은 이름 붙인 값으로 설정한다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'elanous-logstore-ro-timeout-'));
    const path = join(dir, 'logs.db');
    const writer = new LogStore(path);
    writer.close();
    const ro = LogStore.openReadOnly(path);
    expect((ro as unknown as { db: Database }).db.query('PRAGMA busy_timeout').get()).toEqual({ timeout: LOG_STORE_READONLY_BUSY_TIMEOUT_MS });
    ro.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('openReadOnly — 지속 잠금은 timeout 뒤에도 조회 실패로 남긴다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'elanous-logstore-ro-lock-'));
    const path = join(dir, 'logs.db');
    const seed = new Database(path);
    seed.run(`CREATE TABLE logs(
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, ts_ms INTEGER NOT NULL,
      level TEXT NOT NULL, instance TEXT NOT NULL DEFAULT '', surface TEXT NOT NULL,
      category TEXT NOT NULL, event TEXT NOT NULL, session_id TEXT, trace_id TEXT, data TEXT)`);
    seed.close();
    const lock = new Database(path);
    lock.run('BEGIN EXCLUSIVE');
    const ro = LogStore.openReadOnly(path);
    const startedAt = Date.now();
    expect(() => ro.query({})).toThrow('database is locked');
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(LOG_STORE_READONLY_BUSY_TIMEOUT_MS - 100);
    ro.close();
    lock.run('ROLLBACK');
    lock.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
