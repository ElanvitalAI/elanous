import { test, expect, describe, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFrameMemoryConsumer } from '../capture/frame-memory.js';
import { recordExternalEvent } from '../context-bus/external-events.js';
import { listCoordEvents } from '../context-bus/coord-events.js';
import { readCondenseEventsIn } from '../context-bus/long-term-memory.js';
import { contextDayTimeline } from '../context-bus/context-day.js';
import { debug } from '../debug/log.js';
import { resetStrayMergeAttempts } from './memory-db-path.js';
import { _resetDefaultLogStoreForTest, getDefaultLogStore, registerLogStoreSink } from '../mss/logging/log-store.js';
import { injectUtterance, recordSelfEvent } from './self-awareness.js';
import {
  openSurfaceEventsDb, recordEvent, recordInboundTurn, queryEvents, importanceByKind, ftsQuery, recallEvents, recentSentDigest, categoryOfKind, pruneStaleEvents,
  stabilityDays, classifyTier, applyMemoryDecay, querySurfaceUtterances, countSurfaceUtterancesByOrigin, classifySurfaceUtteranceOrigin, SURFACE_SIGNAL_RETENTION_DAYS,
} from './surface-events.js';

const db = () => openSurfaceEventsDb(':memory:');

test('three real low-signal producers write signal rows and zero recallable memories', () => {
  const d = db();
  try {
    let tick = 0;
    const frames = createFrameMemoryConsumer({ record: input => { recordSelfEvent(d, input); }, now: () => ++tick * 10_000 });
    for (let i = 0; i < 40; i++) frames.observe({ surfaceId: 'pane-1', instance: 'test-1', frameAt: i, text: `frame ${i}` });
    for (let i = 0; i < 40; i++) recordExternalEvent({ origin: 'harness-child', kind: 'exit', summary: `child ${i} exit`, source: `elanous://child/${i}` }, { db: d });
    for (let i = 0; i < 40; i++) injectUtterance({ origin: 'claude-code', text: `utterance ${i}` }, d);
    expect((d.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n).toBe(0);
    expect((d.prepare('SELECT COUNT(*) AS n FROM signals').get() as { n: number }).n).toBe(120);
    expect(queryEvents(d, { query: 'frame' })).toEqual([]);
    expect(recallEvents(d, { query: 'utterance', bump: false })).toEqual([]);
  } finally { d.close(); }
});

test('one accepted signal emits one payload-free effect row for logs.db', () => {
  const d = db();
  const effects: Array<{ category: string; event: string; data: unknown }> = [];
  const log = spyOn(debug, 'log').mockImplementation((category, event, data) => { effects.push({ category, event, data }); });
  try {
    const id = recordEvent(d, { surface: 'ext:tui-observe', direction: 'inbound', kind: 'frame', text: 'FAKE-FRAME-PRIVATE', summary: 'frame' });
    expect(effects).toEqual([{ category: 'memory.signal', event: 'routed', data: { id, surface: 'ext:tui-observe', kind: 'frame' } }]);
    expect(JSON.stringify(effects)).not.toContain('FAKE-FRAME-PRIVATE');
    expect((d.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n).toBe(0);
  } finally { log.mockRestore(); d.close(); }
});

test('one signal cycle reaches exactly one logs.db effect row in an isolated state root', () => {
  const root = mkdtempSync(join(tmpdir(), 'surface-signal-logs-'));
  const saved = { state: process.env.ELANOUS_STATE_DIR, node: process.env.NODE_ENV };
  process.env.ELANOUS_STATE_DIR = root;
  process.env.NODE_ENV = 'production';
  _resetDefaultLogStoreForTest();
  const off = registerLogStoreSink(sink => debug.registerSink(sink), 'test');
  const d = db();
  try {
    expect(off).toBeFunction();
    recordEvent(d, { surface: 'ext:tui-observe', direction: 'inbound', kind: 'frame', text: 'FAKE-PRIVATE-FRAME', summary: 'frame' });
    debug.flush();
    const rows = getDefaultLogStore()?.query({ exactCategories: ['memory.signal'] }) ?? [];
    expect(rows.map(row => row.event)).toEqual(['routed']);
    expect(JSON.stringify(rows)).not.toContain('FAKE-PRIVATE-FRAME');
  } finally {
    d.close(); off?.(); _resetDefaultLogStoreForTest();
    if (saved.state === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = saved.state;
    if (saved.node === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved.node;
    rmSync(root, { recursive: true, force: true });
  }
});

test('20,001 low-signal inputs in one day add zero memory rows', () => {
  const d = db();
  try {
    const inputs = [
      { surface: 'ext:tui-observe', kind: 'frame' },
      { surface: 'context:external', kind: 'exit' },
      { surface: 'ext:claude-code', kind: 'utterance' },
    ];
    for (let i = 0; i < 20_001; i++) {
      const input = inputs[i % inputs.length]!;
      recordEvent(d, { ...input, direction: 'inbound', text: `fake signal ${i}`, ts: '2026-11-21T00:00:00Z' });
    }
    expect((d.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n).toBe(0);
    expect((d.prepare('SELECT COUNT(*) AS n FROM signals').get() as { n: number }).n).toBe(20_001);
  } finally { d.close(); }
}, 30_000);

test('signal retention follows the seven-day logs default without pruning memory', () => {
  const d = db();
  try {
    expect(SURFACE_SIGNAL_RETENTION_DAYS).toBe(7);
    recordEvent(d, { surface: 'ext:tui-observe', direction: 'inbound', kind: 'frame', text: 'old frame', ts: '2026-11-10T00:00:00Z' });
    recordEvent(d, { surface: 'ext:tui-observe', direction: 'inbound', kind: 'frame', text: 'recent frame', ts: '2026-11-20T00:00:00Z' });
    recordEvent(d, { surface: 'telegram', direction: 'inbound', kind: 'qna', text: 'old but durable memory', ts: '2026-11-10T00:00:00Z' });
    expect(pruneStaleEvents(d, { nowExpr: '2026-11-21T00:00:00Z' })).toBe(0);
    expect(d.prepare('SELECT text FROM signals').all()).toEqual([{ text: 'recent frame' }]);
    expect(queryEvents(d, { query: 'durable' })).toHaveLength(1);
  } finally { d.close(); }
});

test('existing low-signal memory rows move once with ids preserved and FTS removed', () => {
  const root = mkdtempSync(join(tmpdir(), 'surface-signals-migrate-'));
  const path = join(root, 'surface_events.db');
  try {
    const old = openSurfaceEventsDb(path);
    old.run('DELETE FROM signal_migrations');
    for (const [id, surface, kind] of [['f', 'ext:tui-observe', 'frame'], ['e', 'context:external', 'exit'], ['u', 'ext:claude-code', 'utterance']]) {
      old.run('INSERT INTO events(id,ts,surface,direction,kind,text,summary) VALUES (?,?,?,?,?,?,?)', [id, '2026-11-21T00:00:00Z', surface, 'inbound', kind, `${id} unique-low-signal`, `${id} unique-low-signal`]);
      old.run('INSERT INTO events_fts(id,search_text) VALUES (?,?)', [id, `${id} unique-low-signal`]);
    }
    recordEvent(old, { surface: 'telegram', direction: 'inbound', kind: 'qna', text: 'normal question' });
    old.close();
    for (let i = 0; i < 2; i++) {
      const upgraded = openSurfaceEventsDb(path);
      expect((upgraded.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n).toBe(1);
      expect((upgraded.prepare('SELECT COUNT(*) AS n FROM signals').get() as { n: number }).n).toBe(3);
      expect(upgraded.prepare('SELECT id FROM signals ORDER BY id').all()).toEqual([{ id: 'e' }, { id: 'f' }, { id: 'u' }]);
      expect(queryEvents(upgraded, { query: 'unique-low-signal' })).toEqual([]);
      expect(queryEvents(upgraded, { query: 'normal' })).toHaveLength(1);
      upgraded.close();
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('external exit remains in the coordination journal but cannot enter long-term condensation', () => {
  const root = mkdtempSync(join(tmpdir(), 'surface-signals-journal-'));
  const path = join(root, 'surface_events.db');
  try {
    const d = openSurfaceEventsDb(path);
    recordExternalEvent({ origin: 'harness-child', kind: 'exit', summary: 'low signal exit', source: 'elanous://child/exit', at: '2026-11-21T01:00:00Z' }, { db: d });
    recordEvent(d, { surface: 'coord:channel', direction: 'outbound', kind: '보고', text: 'durable report', summary: 'durable report', refs: JSON.stringify({ seat: 'TC', url: 'https://example.test/report' }), ts: '2026-11-21T01:01:00Z' });
    expect(listCoordEvents({ since: '2026-11-21T00:00:00Z' }, { db: d }).map(row => row.kind)).toEqual(['exit', '보고']);
    d.close();
    expect(readCondenseEventsIn(root, '2026-11-21T00:00:00Z', { path }).events.map(row => row.summary)).toEqual(['durable report']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('read-only coordination readers accept a pre-upgrade database without signals table', () => {
  const root = mkdtempSync(join(tmpdir(), 'surface-signals-legacy-'));
  const path = join(root, 'surface_events.db');
  try {
    const d = openSurfaceEventsDb(path);
    recordEvent(d, { surface: 'coord:channel', direction: 'outbound', kind: '보고', text: 'legacy report', summary: 'legacy report', refs: JSON.stringify({ seat: 'TC', recipients: [], all: false, url: 'https://example.test/legacy' }), ts: '2026-11-21T01:00:00Z' });
    d.run('DROP TABLE signals');
    d.close();
    const legacy = new Database(path, { readonly: true });
    try { expect(listCoordEvents({ since: '2026-11-21T00:00:00Z' }, { db: legacy }).map(row => row.summary)).toEqual(['legacy report']); }
    finally { legacy.close(); }
    expect(contextDayTimeline('24h', { now: () => new Date('2026-11-21T02:00:00Z'), dbPath: path }).events.map(row => row.summary)).toEqual(['legacy report']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('read-only utterance query accepts an old database without signals table', () => {
  const root = mkdtempSync(join(tmpdir(), 'surface-signals-readonly-'));
  const path = join(root, 'old.db');
  try {
    const old = new Database(path);
    old.run(`CREATE TABLE events(id TEXT, ts TEXT, surface TEXT, direction TEXT, kind TEXT,
      session_id TEXT, thread_id TEXT, text TEXT, summary TEXT, importance INT, tags TEXT,
      refs TEXT, recall_count INT, consolidated INT, category TEXT, domain TEXT, tier TEXT)`);
    old.run("INSERT INTO events(id,ts,surface,direction,kind,text,category,domain) VALUES ('old-human','2026-11-21T01:00:00Z','cli','inbound','utterance','old human','qna','elanous')");
    old.close();
    const readonly = new Database(path, { readonly: true });
    try {
      expect(querySurfaceUtterances(readonly, { from: '2026-11-21T00:00:00Z', to: '2026-11-22T00:00:00Z' }).map(row => row.text)).toEqual(['old human']);
    } finally { readonly.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('utterance UNION maps metadata by name across an older physical column order', () => {
  const root = mkdtempSync(join(tmpdir(), 'surface-signals-order-'));
  const path = join(root, 'old.db');
  try {
    const old = new Database(path);
    old.run(`CREATE TABLE events(id TEXT, ts TEXT, surface TEXT, direction TEXT, kind TEXT,
      session_id TEXT, thread_id TEXT, text TEXT, summary TEXT, importance INT, tags TEXT,
      refs TEXT, recall_count INT, consolidated INT, category TEXT, domain TEXT, tier TEXT)`);
    old.run(`CREATE TABLE signals(id TEXT, ts TEXT, surface TEXT, direction TEXT, kind TEXT,
      session_id TEXT, thread_id TEXT, text TEXT, summary TEXT, importance INT, tags TEXT,
      refs TEXT, category TEXT, domain TEXT)`);
    old.run("INSERT INTO events(id,ts,surface,direction,kind,text,category,domain,recall_count,consolidated) VALUES ('memory','2026-11-21T01:00:00Z','cli','inbound','utterance','memory body','memory-cat','memory-dom',3,1)");
    old.run("INSERT INTO signals(id,ts,surface,direction,kind,text,category,domain) VALUES ('signal','2026-11-21T01:00:00Z','ext:claude-code','inbound','utterance','signal body','cat','dom')");
    old.close();
    const readonly = new Database(path, { readonly: true });
    try {
      const rows = querySurfaceUtterances(readonly, { from: '2026-11-21T00:00:00Z', to: '2026-11-22T00:00:00Z' });
      expect(rows.find(row => row.id === 'signal')).toMatchObject({
        id: 'signal', category: 'cat', domain: 'dom', recall_count: 0, consolidated: 0,
      });
      expect(rows.find(row => row.id === 'memory')).toMatchObject({
        id: 'memory', category: 'memory-cat', domain: 'memory-dom', recall_count: 3, consolidated: 1,
      });
    } finally { readonly.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a low-signal row merged from stray after the first upgrade still moves to signals', () => {
  const root = mkdtempSync(join(tmpdir(), 'surface-signals-late-stray-'));
  const strayPath = join(root, 'stray', 'surface_events.db');
  const saved = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = root;
  resetStrayMergeAttempts(name => name === 'surface_events.db' ? strayPath : undefined);
  try {
    const seed = openSurfaceEventsDb(strayPath);
    recordEvent(seed, { surface: 'outbound', direction: 'outbound', kind: 'alert', text: 'seed' });
    seed.close();
    const first = openSurfaceEventsDb();
    first.close();
    const late = openSurfaceEventsDb(strayPath);
    late.run("INSERT INTO events(id,ts,surface,direction,kind,text,summary) VALUES ('late-exit','2026-11-21T01:00:00Z','context:external','outbound','exit','late signal','late signal')");
    late.run("INSERT INTO events_fts(id,search_text) VALUES ('late-exit','late signal')");
    late.close();
    resetStrayMergeAttempts(name => name === 'surface_events.db' ? strayPath : undefined);
    const reopened = openSurfaceEventsDb();
    try {
      expect(reopened.prepare("SELECT id FROM signals WHERE id='late-exit'").all()).toEqual([{ id: 'late-exit' }]);
      expect(reopened.prepare("SELECT id FROM events WHERE id='late-exit'").all()).toEqual([]);
      expect(reopened.prepare("SELECT id FROM events_fts WHERE id='late-exit'").all()).toEqual([]);
    } finally { reopened.close(); }
  } finally {
    resetStrayMergeAttempts();
    if (saved === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = saved;
    rmSync(root, { recursive: true, force: true });
  }
});

test('a fresh process reclassifies late stray signals and retries a failed migration', () => {
  const root = mkdtempSync(join(tmpdir(), 'surface-signals-restart-'));
  const home = join(root, 'home');
  const strayPath = join(home, '.elanous', 'surface_events.db');
  const canonicalPath = join(home, '.elanous', 'memory', 'surface_events.db');
  const moduleUrl = pathToFileURL(join(import.meta.dir, 'surface-events.ts')).href;
  const externalModuleUrl = pathToFileURL(join(import.meta.dir, '../context-bus/external-events.ts')).href;
  const childCode = `import { openSurfaceEventsDb, pruneStaleEvents } from ${JSON.stringify(moduleUrl)};
    import { recordExternalEvent } from ${JSON.stringify(externalModuleUrl)};
    const db = openSurfaceEventsDb();
    if (process.env.PROBE_REDELIVER === '1') pruneStaleEvents(db, { nowExpr: '2026-11-21T12:00:00Z' });
    const replayedId = process.env.PROBE_REDELIVER === '1'
      ? recordExternalEvent({ origin: 'release-graph', kind: 'exit', summary: 'late receipt',
          source: 'elanous://release/late', delivery: { eventId: 'late-event', subscriberId: 'context-bus' } }, { db })
      : undefined;
    const rows = {
      events: db.prepare('SELECT id FROM events ORDER BY id').all(),
      signals: db.prepare('SELECT id FROM signals ORDER BY id').all(),
      fts: db.prepare('SELECT id FROM events_fts ORDER BY id').all(),
      ...(replayedId ? { replayedId } : {}),
    };
    db.close();
    console.log(JSON.stringify(rows));`;
  const { ELANOUS_STATE_DIR: _stateDir, ...parentEnv } = process.env;
  const runFreshProcess = (replay = false) => spawnSync(process.execPath, ['-e', childCode], {
      cwd: join(import.meta.dir, '../..'), env: { ...parentEnv, HOME: home, ...(replay ? { PROBE_REDELIVER: '1' } : {}) }, encoding: 'utf8', timeout: 10_000,
    });
  const openInFreshProcess = (replay = false) => {
    const child = runFreshProcess(replay);
    expect(child.status).toBe(0);
    return JSON.parse(child.stdout.trim()) as { events: Array<{ id: string }>; signals: Array<{ id: string }>; fts: Array<{ id: string }>; replayedId?: string };
  };
  try {
    mkdirSync(join(home, '.elanous'), { recursive: true });
    const stray = new Database(strayPath);
    stray.run('CREATE TABLE events(id TEXT PRIMARY KEY, ts TEXT, surface TEXT, direction TEXT, kind TEXT, text TEXT, summary TEXT, refs TEXT)');
    stray.run('CREATE VIRTUAL TABLE events_fts USING fts5(id UNINDEXED, search_text)');
    stray.run("INSERT INTO events(id,ts,surface,direction,kind,text) VALUES ('early-memory','2026-11-21T01:00:00Z','cli','inbound','utterance','early')");
    stray.run("INSERT INTO events_fts(id,search_text) VALUES ('early-memory','early')");
    stray.close();
    expect(openInFreshProcess()).toEqual({ events: [{ id: 'early-memory' }], signals: [], fts: [{ id: 'early-memory' }] });

    const late = new Database(strayPath);
    late.run("INSERT INTO events(id,ts,surface,direction,kind,text) VALUES ('late-signal','2026-11-21T01:01:00Z','context:external','outbound','exit','late signal')");
    late.run("INSERT INTO events_fts(id,search_text) VALUES ('late-signal','late signal')");
    late.run("INSERT INTO events(id,ts,surface,direction,kind,text) VALUES ('late-memory','2026-11-21T01:02:00Z','cli','inbound','utterance','late memory')");
    late.run("INSERT INTO events_fts(id,search_text) VALUES ('late-memory','late memory')");
    late.close();
    expect(openInFreshProcess()).toEqual({
      events: [{ id: 'early-memory' }, { id: 'late-memory' }],
      signals: [{ id: 'late-signal' }],
      fts: [{ id: 'early-memory' }, { id: 'late-memory' }],
    });

    const failedStray = new Database(strayPath);
    failedStray.run("INSERT INTO events(id,ts,surface,direction,kind,text) VALUES ('retry-signal','2026-11-21T01:03:00Z','context:external','outbound','exit','retry signal')");
    failedStray.run("INSERT INTO events_fts(id,search_text) VALUES ('retry-signal','retry signal')");
    failedStray.close();
    const canonical = new Database(canonicalPath);
    canonical.run("CREATE TRIGGER fail_signal BEFORE INSERT ON signals BEGIN SELECT RAISE(ABORT, 'injected signal failure'); END");
    canonical.close();
    expect(runFreshProcess().status).not.toBe(0);
    const recover = new Database(canonicalPath);
    recover.run('DROP TRIGGER fail_signal');
    recover.close();
    expect(openInFreshProcess()).toEqual({
      events: [{ id: 'early-memory' }, { id: 'late-memory' }],
      signals: [{ id: 'late-signal' }, { id: 'retry-signal' }],
      fts: [{ id: 'early-memory' }, { id: 'late-memory' }],
    });

    const receiptStray = new Database(strayPath);
    receiptStray.run(`INSERT INTO events(id,ts,surface,direction,kind,text,refs)
      VALUES (?,?,?,?,?,?,?)`, ['late-receipt', '2026-11-01T01:04:00Z', 'context:external', 'outbound', 'exit',
      'late receipt', JSON.stringify({ origin: 'release-graph', eventId: 'late-event', subscriberId: 'context-bus' })]);
    receiptStray.run("INSERT INTO events_fts(id,search_text) VALUES ('late-receipt','late receipt')");
    receiptStray.close();
    expect(openInFreshProcess(true)).toEqual({
      events: [{ id: 'early-memory' }, { id: 'late-memory' }],
      signals: [{ id: 'late-signal' }, { id: 'retry-signal' }],
      fts: [{ id: 'early-memory' }, { id: 'late-memory' }],
      replayedId: 'late-receipt',
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a merged non-exit external event retries receipt backfill after a later transaction failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'surface-receipt-retry-'));
  const home = join(root, 'home');
  const strayPath = join(home, '.elanous', 'surface_events.db');
  const canonicalPath = join(home, '.elanous', 'memory', 'surface_events.db');
  const moduleUrl = pathToFileURL(join(import.meta.dir, 'surface-events.ts')).href;
  const externalModuleUrl = pathToFileURL(join(import.meta.dir, '../context-bus/external-events.ts')).href;
  const childCode = `import { openSurfaceEventsDb } from ${JSON.stringify(moduleUrl)};
    import { recordExternalEvent } from ${JSON.stringify(externalModuleUrl)};
    const db = openSurfaceEventsDb();
    const id = process.env.PROBE_REPLAY === '1'
      ? recordExternalEvent({ origin: 'release-graph', kind: 'finished', summary: 'late finished',
          source: 'elanous://release/finished', delivery: { eventId: 'late-finished-event', subscriberId: 'context-bus' } }, { db })
      : undefined;
    db.close();
    console.log(JSON.stringify({ id }));`;
  const { ELANOUS_STATE_DIR: _stateDir, ...parentEnv } = process.env;
  const run = (replay = false) => spawnSync(process.execPath, ['-e', childCode], {
    cwd: join(import.meta.dir, '../..'), env: { ...parentEnv, HOME: home, ...(replay ? { PROBE_REPLAY: '1' } : {}) },
    encoding: 'utf8', timeout: 10_000,
  });
  try {
    const seed = run();
    expect(seed.status).toBe(0);
    const seeded = new Database(canonicalPath);
    expect(seeded.prepare("SELECT version FROM signal_migrations WHERE version=1").get()).toBeTruthy();
    expect(seeded.prepare("SELECT 1 FROM sqlite_master WHERE name='external_delivery_receipts'").get()).toBeTruthy();
    seeded.close();

    mkdirSync(join(home, '.elanous'), { recursive: true });
    const stray = new Database(strayPath);
    stray.run('CREATE TABLE events(id TEXT PRIMARY KEY, ts TEXT, surface TEXT, direction TEXT, kind TEXT, text TEXT, refs TEXT)');
    stray.run('CREATE VIRTUAL TABLE events_fts USING fts5(id UNINDEXED, search_text)');
    stray.run(`INSERT INTO events(id,ts,surface,direction,kind,text,refs) VALUES (?,?,?,?,?,?,?)`,
      ['late-finished', '2026-11-01T01:05:00Z', 'context:external', 'outbound', 'finished', 'late finished',
        JSON.stringify({ origin: 'release-graph', eventId: 'late-finished-event', subscriberId: 'context-bus' })]);
    stray.run("INSERT INTO events_fts(id,search_text) VALUES ('late-finished','late finished')");
    stray.close();

    const failReceipt = new Database(canonicalPath);
    failReceipt.run(`CREATE TRIGGER fail_finished_receipt BEFORE INSERT ON external_delivery_receipts
      WHEN NEW.event_id='late-finished-event' BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END`);
    failReceipt.close();
    expect(run().status).not.toBe(0);
    const afterFailure = new Database(canonicalPath);
    expect(afterFailure.prepare("SELECT id FROM events WHERE id='late-finished'").all()).toEqual([{ id: 'late-finished' }]);
    expect(afterFailure.prepare("SELECT surface_event_id FROM external_delivery_receipts WHERE event_id='late-finished-event'").all()).toEqual([]);
    afterFailure.run('DROP TRIGGER fail_finished_receipt');
    afterFailure.close();

    const replay = run(true);
    expect(replay.status).toBe(0);
    expect(JSON.parse(replay.stdout.trim())).toEqual({ id: 'late-finished' });
    const recovered = new Database(canonicalPath);
    expect(recovered.prepare("SELECT id FROM events WHERE id='late-finished'").all()).toEqual([{ id: 'late-finished' }]);
    expect(recovered.prepare("SELECT surface_event_id FROM external_delivery_receipts WHERE event_id='late-finished-event'").all())
      .toEqual([{ surface_event_id: 'late-finished' }]);
    recovered.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

describe('importanceByKind — kind 룰', () => {
  test('alert/watch-zone = 7', () => {
    expect(importanceByKind('alert')).toBe(7);
    expect(importanceByKind('watch-zone')).toBe(7);
  });
  test('digest/report = 4, qna = 3, 기본 = 5', () => {
    expect(importanceByKind('digest')).toBe(4);
    expect(importanceByKind('qna')).toBe(3);
    expect(importanceByKind(undefined)).toBe(5);
    expect(importanceByKind('별종')).toBe(5);
  });
});

describe('recordEvent + queryEvents', () => {
  test('기록 후 최근순 조회', () => {
    const d = db();
    recordEvent(d, { surface: 'outbound', direction: 'outbound', kind: 'alert', text: '첫 알림', ts: '2026-07-07T01:00:00Z' });
    recordEvent(d, { surface: 'outbound', direction: 'outbound', kind: 'alert', text: '둘째 알림', ts: '2026-07-07T02:00:00Z' });
    const rows = queryEvents(d, {});
    expect(rows.length).toBe(2);
    expect(rows[0]!.text).toBe('둘째 알림'); // 최근순
  });

  test('importance 미지정 시 kind 룰 적용 · summary 자동', () => {
    const d = db();
    recordEvent(d, { surface: 'outbound', direction: 'outbound', kind: 'digest', text: 'x'.repeat(500) });
    const r = queryEvents(d, {})[0]!;
    expect(r.importance).toBe(4);
    expect(r.summary!.length).toBe(200); // text 앞 200
    expect(r.recall_count).toBe(0);
    expect(r.consolidated).toBe(0);
  });

  test('명시 importance/summary/tags 보존', () => {
    const d = db();
    recordEvent(d, { surface: 'watch-cron', direction: 'outbound', kind: 'watch-zone', text: 't', importance: 9, summary: '요약', tags: 'semis' });
    const r = queryEvents(d, {})[0]!;
    expect(r.importance).toBe(9);
    expect(r.summary).toBe('요약');
    expect(r.tags).toBe('semis');
  });
});

describe('필터', () => {
  const seed = () => {
    const d = db();
    recordEvent(d, { surface: 'outbound', direction: 'outbound', kind: 'alert', text: 'a' });
    recordEvent(d, { surface: 'telegram', direction: 'inbound', kind: 'qna', text: 'b' });
    recordEvent(d, { surface: 'outbound', direction: 'outbound', kind: 'digest', text: 'c' });
    return d;
  };
  test('surface/direction/kind 필터', () => {
    const d = seed();
    expect(queryEvents(d, { surface: 'telegram' }).length).toBe(1);
    expect(queryEvents(d, { direction: 'outbound' }).length).toBe(2);
    expect(queryEvents(d, { kind: 'digest' }).length).toBe(1);
  });
  test('limit', () => {
    const d = seed();
    expect(queryEvents(d, { limit: 1 }).length).toBe(1);
  });
});

describe('FTS5 회상 — 대표 반문 시나리오', () => {
  test('한국어 수급 알림을 키워드로 회상', () => {
    const d = db();
    recordEvent(d, { surface: 'watch-cron', direction: 'outbound', kind: 'watch-zone',
      text: '삼성전자 외국인 순매수 전환 감지 — 10분 델타 +120억' });
    recordEvent(d, { surface: 'outbound', direction: 'outbound', kind: 'alert',
      text: 'KORU 재진입 밴드 진입' });
    const hit = queryEvents(d, { query: '외국인 순매수' });
    expect(hit.length).toBe(1);
    expect(hit[0]!.text).toContain('삼성전자');
  });

  test('매치 없으면 빈 결과', () => {
    const d = db();
    recordEvent(d, { surface: 'outbound', direction: 'outbound', kind: 'alert', text: '삼성 알림' });
    expect(queryEvents(d, { query: '유가 원유' }).length).toBe(0);
  });

  test('특수문자 질의도 구문오류 없이 처리', () => {
    const d = db();
    recordEvent(d, { surface: 'outbound', direction: 'outbound', kind: 'alert', text: '테스트 알림' });
    expect(() => queryEvents(d, { query: '"삼성" (수급) * ^' })).not.toThrow();
  });
});

describe('ftsQuery 정규화', () => {
  test('토큰 prefix(*) OR · 특수문자 제거', () => {
    expect(ftsQuery('삼성 수급')).toBe('"삼성"* OR "수급"*');
    expect(ftsQuery('a*b^c')).not.toContain('^'); // 위험 특수문자 제거(prefix * 는 허용)
  });
  test('짧은 ASCII 토큰은 exact(prefix 금지) — "ref" 오차용 차단(2026-07-19)', () => {
    // "ref"(<4) → exact "ref" (reference/refactor 로 안 샘). CJK·긴 ASCII 는 prefix 유지.
    expect(ftsQuery('git ref')).toBe('"git" OR "ref"');
    expect(ftsQuery('reference 문서')).toBe('"reference"* OR "문서"*'); // 긴 ASCII prefix
    expect(ftsQuery('삼성 ref')).toBe('"삼성"* OR "ref"'); // 한글 prefix + 짧은 ASCII exact 혼합
  });
  test('prefix 매칭 — "삼성"이 복합어 "삼성전자"를 회상', () => {
    const d = db();
    recordEvent(d, { surface: 'watch-cron', direction: 'outbound', kind: 'watch-zone', text: '삼성전자 외국인 순매수 전환 감지' });
    expect(queryEvents(d, { query: '삼성 수급 어때' }).length).toBe(1); // 삼성*→삼성전자
  });
});

describe('recallEvents — 스코어 회상 (P2)', () => {
  const NOW = Date.parse('2026-07-07T12:00:00Z');
  const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3.6e6).toISOString();

  test('query 회상 — 관련 알림만, 스코어 부여', () => {
    const d = db();
    recordEvent(d, { surface: 'watch-cron', direction: 'outbound', kind: 'watch-zone', text: '삼성전자 외국인 순매수 전환 감지', ts: at(2) });
    recordEvent(d, { surface: 'outbound', direction: 'outbound', kind: 'alert', text: 'KORU 재진입 밴드', ts: at(1) });
    const hits = recallEvents(d, { query: '삼성 외국인 수급', nowMs: NOW });
    expect(hits.length).toBe(1);
    expect(hits[0]!.text).toContain('삼성');
    expect(hits[0]!.score).toBeGreaterThan(0);
  });

  test('최근성 — 같은 kind면 최신이 상위', () => {
    const d = db();
    recordEvent(d, { surface: 'outbound', direction: 'outbound', kind: 'alert', text: '오래된 알림', ts: at(100) });
    recordEvent(d, { surface: 'outbound', direction: 'outbound', kind: 'alert', text: '최근 알림', ts: at(1) });
    const hits = recallEvents(d, { nowMs: NOW });
    expect(hits[0]!.text).toBe('최근 알림');
  });

  test('현저성 — 같은 시각이면 importance 높은 것 상위', () => {
    const d = db();
    recordEvent(d, { surface: 'outbound', direction: 'outbound', kind: 'digest', text: '다이제스트', ts: at(3), importance: 4 });
    recordEvent(d, { surface: 'outbound', direction: 'outbound', kind: 'alert', text: '긴급 알림', ts: at(3), importance: 9 });
    const hits = recallEvents(d, { nowMs: NOW });
    expect(hits[0]!.text).toBe('긴급 알림');
  });

  test('sinceHours 기간 밖은 제외', () => {
    const d = db();
    recordEvent(d, { surface: 'outbound', direction: 'outbound', kind: 'alert', text: '기간밖', ts: at(200) });
    recordEvent(d, { surface: 'outbound', direction: 'outbound', kind: 'alert', text: '기간안', ts: at(2) });
    const hits = recallEvents(d, { sinceHours: 24, nowMs: NOW });
    expect(hits.length).toBe(1);
    expect(hits[0]!.text).toBe('기간안');
  });

  test('발송 없으면 빈 배열', () => {
    expect(recallEvents(db(), { query: '아무거나', nowMs: NOW })).toEqual([]);
  });

  test('P4.2 미엘린 — 회상 시 recall_count 증분(bump 기본)', () => {
    const d = db();
    recordEvent(d, { surface: 'outbound', direction: 'outbound', kind: 'alert', text: '삼성 알림', ts: at(2) });
    recallEvents(d, { query: '삼성', nowMs: NOW });                 // bump 기본
    const row = queryEvents(d, { query: '삼성' })[0];
    expect(row!.recall_count).toBe(1);
    recallEvents(d, { query: '삼성', nowMs: NOW });                 // 또 회상 → 2
    expect(queryEvents(d, { query: '삼성' })[0]!.recall_count).toBe(2);
  });

  test('P4.2 bump:false → recall_count 불변(read-only 회상)', () => {
    const d = db();
    recordEvent(d, { surface: 'outbound', direction: 'outbound', kind: 'alert', text: '삼성 알림', ts: at(2) });
    recallEvents(d, { query: '삼성', nowMs: NOW, bump: false });
    expect(queryEvents(d, { query: '삼성' })[0]!.recall_count).toBe(0);
  });

  test('P4.2 미엘린 가중 — 같은 조건이면 자주 회상된 것 상위', () => {
    const d = db();
    recordEvent(d, { surface: 'outbound', direction: 'outbound', kind: 'alert', text: '자주 회상 알림', ts: at(3), importance: 5 });
    recordEvent(d, { surface: 'outbound', direction: 'outbound', kind: 'alert', text: '안 회상 알림', ts: at(3), importance: 5 });
    // '자주 회상 알림'만 여러 번 회상 → recall_count↑
    for (let i = 0; i < 5; i++) recallEvents(d, { query: '자주', nowMs: NOW });
    const hits = recallEvents(d, { nowMs: NOW, bump: false });
    expect(hits[0]!.text).toBe('자주 회상 알림');   // 미엘린 강화로 상위
  });
});

describe('pruneStaleEvents — P4.3 retention/망각', () => {
  const NOW = Date.parse('2026-07-07T12:00:00Z');
  const daysAgo = (n: number) => new Date(NOW - n * 86400_000).toISOString();

  test('오래되고·비중요·비회상만 삭제 · 미엘린/중요/최근 보존', () => {
    const d = db();
    recordEvent(d, { surface: 'outbound', direction: 'outbound', kind: 'qna', text: '낡은 잡담', ts: daysAgo(120), importance: 2 });        // 삭제 대상
    recordEvent(d, { surface: 'outbound', direction: 'outbound', kind: 'alert', text: '낡지만 중요', ts: daysAgo(120), importance: 8 });     // 보존(중요)
    recordEvent(d, { surface: 'outbound', direction: 'outbound', kind: 'qna', text: '낡지만 회상됨', ts: daysAgo(120), importance: 2 });     // 보존(미엘린)
    recordEvent(d, { surface: 'outbound', direction: 'outbound', kind: 'qna', text: '최근 잡담', ts: daysAgo(3), importance: 2 });            // 보존(최근)
    recallEvents(d, { query: '회상됨', nowMs: NOW, sinceHours: 200 * 24 });   // 신선할 때 회상됐다 가정 → recall_count 보유
    const pruned = pruneStaleEvents(d, { nowExpr: new Date(NOW).toISOString() });
    expect(pruned).toBe(1);
    const remain = queryEvents(d, { limit: 10 }).map(r => r.text);
    expect(remain).toContain('낡지만 중요');
    expect(remain).toContain('낡지만 회상됨');
    expect(remain).toContain('최근 잡담');
    expect(remain).not.toContain('낡은 잡담');
  });

  test('삭제 시 FTS 동기(orphan 없음)', () => {
    const d = db();
    recordEvent(d, { surface: 'outbound', direction: 'outbound', kind: 'qna', text: '삭제될 반도체 잡담', ts: daysAgo(200), importance: 1 });
    pruneStaleEvents(d, { nowExpr: new Date(NOW).toISOString() });
    expect(queryEvents(d, { query: '반도체' }).length).toBe(0);   // FTS 에서도 사라짐
  });
});

describe('recentSentDigest — ambient 주입 (Block 5)', () => {
  test('최근 유의 발송만 요약(저중요/오래된/inbound 제외)', () => {
    const d = db();
    recordEvent(d, { surface: 'watch-cron', direction: 'outbound', kind: 'watch-zone', text: '삼성 외국인 순매수 전환', importance: 7 });
    recordEvent(d, { surface: 'telegram', direction: 'outbound', kind: 'qna', text: '잡담 응답', importance: 3 }); // 저중요 제외
    recordEvent(d, { surface: 'telegram', direction: 'inbound', kind: 'qna', text: '질문', importance: 7 }); // inbound 제외
    const digest = recentSentDigest(d);
    expect(digest).toContain('삼성 외국인 순매수');
    expect(digest).not.toContain('잡담');
    expect(digest).not.toContain('질문');
    expect(digest).toContain('memory_recall'); // 오리엔테이션 힌트
  });
  test('발송 없으면 빈 문자열(주입 스킵)', () => {
    expect(recentSentDigest(db())).toBe('');
  });
  test('sinceHours 밖 제외', () => {
    const d = db();
    recordEvent(d, { surface: 'x', direction: 'outbound', kind: 'alert', text: '오래된', importance: 8, ts: new Date(Date.now() - 100 * 3.6e6).toISOString() });
    expect(recentSentDigest(d, { sinceHours: 24 })).toBe('');
  });
});

describe('GEN — 도메인무관 taxonomy (category×domain)', () => {
  test('categoryOfKind — 스케줄러와 공유 taxonomy', () => {
    expect(categoryOfKind('watch-zone')).toBe('monitor');
    expect(categoryOfKind('breaking')).toBe('monitor');
    expect(categoryOfKind('digest')).toBe('digest');
    expect(categoryOfKind('report')).toBe('report');
    expect(categoryOfKind('qna')).toBe('qna');
    expect(categoryOfKind('alert')).toBe('alert');
    expect(categoryOfKind(undefined)).toBe('alert');
  });
  test('recordEvent — category 추론 + domain 기본 general(코어 중립·finance 가정 금지)', () => {
    const d = db();
    recordEvent(d, { surface: 'watch-cron', direction: 'outbound', kind: 'watch-zone', text: '삼성 수급 전환' });
    const r = queryEvents(d, {})[0]!;
    expect(r.category).toBe('monitor');
    expect(r.domain).toBe('general'); // 옵션 라벨 정책 — 미지정=중립 general(격리 필요분만 명시 라벨)
  });
  test('recordEvent — 명시 category/domain 보존(비-Conatus 도메인)', () => {
    const d = db();
    recordEvent(d, { surface: 'cli', direction: 'outbound', kind: 'alert', text: '배포 완료', category: 'maintenance', domain: 'ops' });
    const r = queryEvents(d, {})[0]!;
    expect(r.category).toBe('maintenance');
    expect(r.domain).toBe('ops');
  });
  test('category/domain 필터 — queryEvents & recallEvents', () => {
    const d = db();
    recordEvent(d, { surface: 'x', direction: 'outbound', kind: 'watch-zone', text: '수급 모니터', domain: 'finance' });
    recordEvent(d, { surface: 'x', direction: 'outbound', kind: 'alert', text: '배포', category: 'maintenance', domain: 'ops' });
    expect(queryEvents(d, { category: 'monitor' }).length).toBe(1);
    expect(queryEvents(d, { domain: 'ops' }).length).toBe(1);
    expect(recallEvents(d, { domain: 'finance' }).length).toBe(1);
  });
});

describe('recordInboundTurn — 인바운드 대화 턴 기록(Block 3)', () => {
  test('Q&A 를 direction=inbound·kind=qna 로 기록(회상 anchor=질의)', () => {
    const d = db();
    const id = recordInboundTurn({ surface: 'telegram', userText: '삼성 수급 어때?', responseText: '외국인 순매수 전환입니다.', sessionId: 's1', db: d });
    expect(id).toBeTruthy();
    const rows = queryEvents(d, { direction: 'inbound' });
    expect(rows.length).toBe(1);
    expect(rows[0]!.kind).toBe('qna');
    expect(rows[0]!.surface).toBe('telegram');
    expect(rows[0]!.summary).toBe('삼성 수급 어때?');       // 질의가 요약(회상 anchor)
    expect(rows[0]!.text).toContain('Q: 삼성 수급 어때?');
    expect(rows[0]!.text).toContain('A: 외국인 순매수');
    expect(rows[0]!.importance).toBe(3);                    // qna 저현저
    d.close();
  });

  test('빈 질의 → 기록 스킵(null)', () => {
    const d = db();
    expect(recordInboundTurn({ surface: 'telegram', userText: '   ', db: d })).toBeNull();
    expect(queryEvents(d, { direction: 'inbound' }).length).toBe(0);
    d.close();
  });

  test('응답 없어도 질의만 기록 + FTS 회상 가능', () => {
    const d = db();
    recordInboundTurn({ surface: 'pwa', userText: 'KORU 재진입 언제', db: d });
    const hits = recallEvents(d, { query: 'KORU 재진입', direction: 'inbound' });
    expect(hits.length).toBe(1);
    d.close();
  });
});

describe('M1 graded decay — stability 곡선(미엘린 반영)', () => {
  test('stabilityDays — importance·recall_count 로 늘어난다(미엘린)', () => {
    const low = stabilityDays(3, 0);     // 7 + 9 + 0 = 16
    const mid = stabilityDays(5, 0);     // 7 + 15 + 0 = 22
    const myelinated = stabilityDays(5, 10); // 7 + 15 + ~44 = ~66
    expect(mid).toBeGreaterThan(low);                 // 중요할수록 오래
    expect(myelinated).toBeGreaterThan(mid);          // 자주 회상할수록 오래(미엘린)
    expect(myelinated).toBeGreaterThan(60);
  });

  test('classifyTier — hot(≤stability) · warm(≤2×) · cold(초과)', () => {
    expect(classifyTier(10, 20)).toBe('hot');
    expect(classifyTier(20, 20)).toBe('hot');   // 경계 포함
    expect(classifyTier(30, 20)).toBe('warm');
    expect(classifyTier(40, 20)).toBe('warm');  // 2× 경계
    expect(classifyTier(41, 20)).toBe('cold');
  });

  test('applyMemoryDecay — 나이든 저현저는 cold, 미엘린은 hot 유지(삭제 없음)', () => {
    const d = db();
    const old = (days: number) => new Date(Date.now() - days * 8.64e7).toISOString();
    // 저현저·오래됨·비회상 → cold (stability~16, 100일)
    recordEvent(d, { surface: 'x', direction: 'outbound', kind: 'digest', text: '낡은 저현저', importance: 3, ts: old(100) });
    // 고현저·자주회상 → 100일이어도 hot 유지(stability 큼)
    const idHot = recordEvent(d, { surface: 'x', direction: 'outbound', kind: 'alert', text: '중요 자주회상', importance: 9, ts: old(50) });
    d.prepare(`UPDATE events SET recall_count = 12 WHERE id = ?`).run(idHot);

    const r = applyMemoryDecay(d);
    expect(r.cold).toBe(1);                           // 낡은 저현저 강등
    expect(r.hot).toBe(1);                            // 미엘린 보존
    // 삭제 안 됨 — 둘 다 남아있다(강등만).
    expect(queryEvents(d, {}).length).toBe(2);
    d.close();
  });

  test('recallEvents — cold 기억은 기본 회상 제외(흐려짐)·includeCold 로 복원', () => {
    const d = db();
    const old = (days: number) => new Date(Date.now() - days * 8.64e7).toISOString();
    recordEvent(d, { surface: 'x', direction: 'outbound', kind: 'digest', text: '삼성 낡은 발송', importance: 3, ts: old(200) });
    applyMemoryDecay(d);                              // → cold
    // 기본: cold 제외 → 회상 0 (sinceHours 넉넉히)
    expect(recallEvents(d, { query: '삼성', sinceHours: 24 * 365, bump: false }).length).toBe(0);
    // includeCold: cold 도 후보 → 회상 1
    expect(recallEvents(d, { query: '삼성', sinceHours: 24 * 365, includeCold: true, bump: false }).length).toBe(1);
    d.close();
  });
});

// ── wire 가드 (feedback_dep_inject_seam_must_be_wired · source_level_grep) ──
describe('배선 가드', () => {
  test('데몬 수렴점(/v1/outbound)이 원장을 기록한다 (P0.5 — ALL outbound 포착)', () => {
    const src = readFileSync(join(import.meta.dir, '../nexus/api/outbound-report.ts'), 'utf-8');
    expect(src).toContain("from '../../domains/surface-events.js'");
    expect(src).toContain('recordOutboundEvent(text, kind)');   // delivered 후 호출
    expect(src).toContain('recordEvent(db, {');
  });
  test('sendOutbound 은 직접폴백(direct)만 클라 기록 — 데몬경유 중복 금지', () => {
    const src = readFileSync(join(import.meta.dir, 'outbound-alert.ts'), 'utf-8');
    const body = src.slice(src.indexOf('export function sendOutbound'));
    expect(body).toContain("path === 'direct'");        // 데몬경유는 기록 안 함
    expect(body).toContain('recordOutbound(text, kind)'); // 폴백/보류만 기록
    expect(src).toContain("from './surface-events.js'");
  });
  test('memory_recall 이 L2 코어 도구(core-tools)로 등록·라우팅되고 finance 팩엔 없다', () => {
    const core = readFileSync(join(import.meta.dir, 'core-tools.ts'), 'utf-8');
    expect(core).toContain("name: 'memory_recall'");   // L2 spec
    expect(core).toContain('recallEvents(mdb,');         // L2 dispatch
    expect(core).toContain('schedule_manage');               // schedule_manage 도 L2
    const fin = readFileSync(join(import.meta.dir, 'finance-tools.ts'), 'utf-8');
    expect(fin).not.toContain("name: 'memory_recall'");  // finance 팩에서 이관 제거(강결합 해소)
  });
  test('finance 오리엔테이션이 memory_recall 회상을 지시한다', () => {
    const src = readFileSync(join(import.meta.dir, 'finance.ts'), 'utf-8');
    expect(src).toContain('memory_recall');
  });
  // ⚠️ M4a(2026-07-12): telegram-agent 의 assembly(Block 3/5 배선 포함)는
  //   src/agent/monad-agent-turn.ts 로 verbatim 이관되고 surface 로 일반화(telegram|discord)됨.
  //   telegram-agent.ts 는 이제 thin flavor shim → 배선 가드는 canonical 위치를 겨눈다.
  test('monad-agent-turn이 최근 발송(recentSentContext)을 systemPrompt에 주입한다 (Block 5)', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'agent', 'monad-agent-turn.ts'), 'utf-8');
    expect(src).toContain('recentSentContext()');
    expect(src).toContain('recentSentDigest');
    // parts 배열(주입 지점)에 포함되는지
    expect(src.slice(src.indexOf('const parts'))).toContain('recentSentContext()');
  });
  test('monad-agent-turn이 대화 턴(recordInboundTurn)을 runTurn 후 기록한다 (Block 3)', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'agent', 'monad-agent-turn.ts'), 'utf-8');
    expect(src).toContain('recordInboundTurn({');
    expect(src).toContain('surface, userText: opts.userText'); // surface 파라미터로 일반화(M4a)
    expect(src).toContain('result.text'); // runTurn 결과에서 응답(responseText) 추출
  });
});

// ── 발화 원천(origin) 구분 — human 0 을 사람 표본으로 오인하지 않는다 ──
describe('utterance origin — human / test-fixture / external CLI agent', () => {
  const interval = { from: '2026-10-12T00:00:00Z', to: '2026-10-13T00:00:00Z' };
  const at = () => '2026-10-12T01:00:00Z';

  test('origin filter separates 0 human sources from 48 test fixtures and external CLI agent rows', () => {
    const d = db();
    try {
      // 시험 fixture 48건은 사람이 말하는 것과 «같은» cli 서피스에 기록된다 — 원천 구분이 없으면 사람 48로 읽힌다.
      for (let i = 0; i < 48; i += 1) {
        recordInboundTurn({ surface: 'cli', userText: `fixture ${i} 동기화 상태 알려 줘`, responseText: 'A', origin: 'test-fixture', now: at, db: d });
      }
      recordInboundTurn({ surface: 'ext:claude-code', userText: 'external agent one', origin: 'claude-code', now: at, db: d });
      recordInboundTurn({ surface: 'ext:codex', userText: 'external agent two', origin: 'codex', now: at, db: d });

      // 기본 조회(origin 미지정)는 종전과 같이 창 안의 모든 발화를 돌려준다 — 보존 계약.
      expect(querySurfaceUtterances(d, interval)).toHaveLength(50);
      expect(querySurfaceUtterances(d, { ...interval, surface: 'cli' })).toHaveLength(48);

      // ⭐ 원천 0 — 사람 표본이 아니다. 시험 fixture 48 · 외부 CLI agent 2 로 «명시» 구분된다.
      expect(querySurfaceUtterances(d, { ...interval, origin: 'human' })).toEqual([]);
      expect(querySurfaceUtterances(d, { ...interval, origin: 'test-fixture' })).toHaveLength(48);
      expect(querySurfaceUtterances(d, { ...interval, origin: 'external-cli-agent' })).toHaveLength(2);
      expect(querySurfaceUtterances(d, { ...interval, origin: ['human', 'external-cli-agent'] })).toHaveLength(2);
      expect(querySurfaceUtterances(d, { ...interval, origin: 'human' })).not.toContainEqual(
        expect.objectContaining({ surface: 'cli' }),
      );

      const counts = countSurfaceUtterancesByOrigin(d, interval);
      expect(counts).toEqual({ human: 0, testFixture: 48, externalCliAgent: 2, elanousSelf: 0, unknown: 0, total: 50 });
      expect(countSurfaceUtterancesByOrigin(d, { ...interval, surface: 'ext:codex' })).toEqual(
        { human: 0, testFixture: 0, externalCliAgent: 1, elanousSelf: 0, unknown: 0, total: 1 },
      );

      // 운영 DB 행 삭제 0 · 회상 카운터 무접촉(read-only 계측).
      expect(d.query('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 50 });
      expect(d.query('SELECT COUNT(*) AS n FROM events WHERE recall_count != 0').get()).toEqual({ n: 0 });
    } finally { d.close(); }
  });

  test('classifier names every source explicitly instead of defaulting prose surfaces to human', () => {
    const d = db();
    try {
      const fixture = recordInboundTurn({ surface: 'cli', userText: 'fixture prompt', origin: 'test-fixture', now: at, db: d })!;
      const external = recordInboundTurn({ surface: 'cli', userText: 'claude prompt', origin: 'claude-code', now: at, db: d })!;
      const selfRun = recordInboundTurn({ surface: 'cli', userText: 'self prompt', now: at, db: d })!;
      const human = recordInboundTurn({ surface: 'cli', userText: 'human prompt', origin: 'human', now: at, db: d })!;
      const rows = new Map(querySurfaceUtterances(d, interval).map((row) => [row.id, row]));
      expect(classifySurfaceUtteranceOrigin(rows.get(fixture)!)).toBe('test-fixture');
      expect(classifySurfaceUtteranceOrigin(rows.get(external)!)).toBe('external-cli-agent');
      expect(classifySurfaceUtteranceOrigin(rows.get(selfRun)!)).toBe('elanous-self');
      expect(classifySurfaceUtteranceOrigin(rows.get(human)!)).toBe('human');
      // 원천 표기가 하나도 없는 옛 행은 사람으로 단정하지 않는다.
      expect(classifySurfaceUtteranceOrigin({ ...rows.get(human)!, surface: 'unknown-surface', refs: null, tags: null, kind: 'utterance' })).toBe('unknown');
    } finally { d.close(); }
  });
});
