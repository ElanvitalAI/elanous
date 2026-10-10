import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

import { debug } from '../../debug/log.js';
import { buildUserConfig } from '../../user-config.js';
import { listLoops } from '../../loops/registry.js';
import { LogStore } from './log-store.js';
import { runHorizonWatchTick, type HorizonSample } from './horizon-watch.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const hour = 3_600_000;
const at = Date.parse('2026-10-09T12:00:00.000Z');

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'log-horizon-watch-'));
  dirs.push(dir);
  const db = join(dir, 'logs.db');
  const stateDir = join(dir, 'state', 'log-horizon');
  const store = new LogStore(db);
  const put = (tsMs: number, category = 'fixture', event = 'row') => store.insertBatch([{
    rec: { ts: new Date(tsMs).toISOString(), category, event }, surface: 'nexus',
  }]);
  const tick = (now: number) => runHorizonWatchTick({ db }, { now: () => now, stateDir });
  const samples = () => readFileSync(join(stateDir, 'samples.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as HorizonSample);
  return { dir, db, stateDir, store, put, tick, samples };
}

function removeOldest(db: string, oldest: number) {
  const sqlite = new Database(db);
  try { sqlite.run('DELETE FROM logs WHERE ts_ms = ?', [oldest]); }
  finally { sqlite.close(); }
}

test('an unrecorded deletion advances the horizon and warns exactly once without watcher writes to logs.db', () => {
  const f = fixture();
  try {
    f.put(at - 3 * hour);
    f.put(at - hour);
    const observations: Array<{ level?: string; data: unknown }> = [];
    const original = debug.log;
    debug.log = ((category, event, data, options) => {
      if (category === 'log-store.horizon' && event === 'sample') observations.push({ level: options?.level, data });
    }) as typeof debug.log;
    try {
      const before = readFileSync(f.db);
      expect(f.tick(at)).toMatchObject({ outcome: 'ok', attribution: 'first-sample', oldestTsMs: at - 3 * hour, spanHours: 3 });
      expect(readFileSync(f.db)).toEqual(before);
      removeOldest(f.db, at - 3 * hour);
      const afterDeletion = readFileSync(f.db);
      expect(f.tick(at + hour)).toMatchObject({ outcome: 'ok', attribution: 'unattributed-loss', advancedMs: 2 * hour, deletedEvents: 0 });
      expect(readFileSync(f.db)).toEqual(afterDeletion);
    } finally { debug.log = original; }
    expect(f.samples().map(s => s.attribution)).toEqual(['first-sample', 'unattributed-loss']);
    expect(observations.filter(o => o.level === 'warn')).toHaveLength(1);
    expect(observations[1]?.data).toMatchObject({ advancedMs: 2 * hour, deletedEvents: 0, attribution: 'unattributed-loss' });
    const reader = LogStore.openReadOnly(f.db);
    try { expect(reader.queryAll({ exactCategories: ['log-store.horizon'] })).toHaveLength(0); }
    finally { reader.close(); }
  } finally { f.store.close(); }
});

test('a deleted retention event attributes the jump; unchanged and backward horizons are none', () => {
  const f = fixture();
  try {
    f.put(at - 3 * hour);
    f.put(at - hour);
    expect(f.tick(at).attribution).toBe('first-sample');
    expect(f.tick(at + hour / 4)).toMatchObject({ attribution: 'none', advancedMs: 0 });
    removeOldest(f.db, at - 3 * hour);
    f.put(at + hour / 2, 'log-store.retention', 'deleted');
    expect(f.tick(at + hour)).toMatchObject({ attribution: 'attributed', advancedMs: 2 * hour, deletedEvents: 1 });
    f.put(at - 4 * hour);
    expect(f.tick(at + 2 * hour)).toMatchObject({ attribution: 'none', advancedMs: 0 });
  } finally { f.store.close(); }
});

test('the tick clock is read after the horizon, so a retention pass just before the read is attributed', () => {
  const f = fixture();
  try {
    f.put(at - 3 * hour);
    f.put(at - hour);
    expect(f.tick(at).attribution).toBe('first-sample');
    let horizonRead = false;
    // Retention deletes and records `deleted` at at+hour, immediately before the horizon read.
    const result = runHorizonWatchTick({ db: f.db }, {
      stateDir: f.stateDir,
      now: () => horizonRead ? at + hour : at + hour - 60_000,
      openStore: (path) => {
        const reader = LogStore.openReadOnly(path);
        return {
          horizon: () => {
            removeOldest(f.db, at - 3 * hour);
            f.put(at + hour, 'log-store.retention', 'deleted');
            horizonRead = true;
            return reader.horizon();
          },
          queryAll: reader.queryAll.bind(reader), close: () => reader.close(),
        };
      },
    });
    expect(result).toMatchObject({ atMs: at + hour, attribution: 'attributed', advancedMs: 2 * hour, deletedEvents: 1 });
  } finally { f.store.close(); }
});

test('a deleted event is credited to one tick only, so a later unrecorded jump is still a loss', () => {
  const f = fixture();
  try {
    f.put(at - 3 * hour);
    f.put(at - 2 * hour);
    f.put(at - hour);
    expect(f.tick(at).attribution).toBe('first-sample');
    removeOldest(f.db, at - 3 * hour);
    f.put(at + hour, 'log-store.retention', 'deleted');
    expect(f.tick(at + hour)).toMatchObject({ attribution: 'attributed', deletedEvents: 1 });
    removeOldest(f.db, at - 2 * hour);
    expect(f.tick(at + 2 * hour)).toMatchObject({ attribution: 'unattributed-loss', advancedMs: hour, deletedEvents: 0 });
  } finally { f.store.close(); }
});

test('empty horizon is not unreadable; read failures are recorded as unreadable and fail', () => {
  const f = fixture();
  try {
    expect(f.tick(at)).toMatchObject({ outcome: 'ok', status: 'empty', oldestTsMs: null, spanHours: null });
    const result = runHorizonWatchTick({ db: f.db }, { now: () => at + hour, stateDir: f.stateDir,
      openStore: (path) => {
        const reader = LogStore.openReadOnly(path);
        return { horizon: () => { throw new Error('broken horizon'); }, queryAll: reader.queryAll.bind(reader), close: () => reader.close() };
      } });
    expect(result).toMatchObject({ outcome: 'fail', status: 'unreadable', oldestTsMs: null });
    expect(f.samples().at(-1)?.status).toBe('unreadable');
  } finally { f.store.close(); }
});

test('a failed first read does not masquerade as a first sample', () => {
  const f = fixture();
  try {
    f.put(at - hour);
    const failure = runHorizonWatchTick({ db: f.db }, { now: () => at, stateDir: f.stateDir,
      openStore: () => { throw new Error('unavailable'); } });
    expect(failure).toMatchObject({ outcome: 'fail', status: 'unreadable', attribution: 'none' });
    expect(f.tick(at + hour)).toMatchObject({ outcome: 'ok', status: 'present', attribution: 'first-sample' });
  } finally { f.store.close(); }
}, 60_000);

test('recovery compares with the last readable horizon across unreadable ticks and queries deletion events from it', () => {
  const f = fixture();
  try {
    f.put(at - 3 * hour);
    f.put(at - hour);
    expect(f.tick(at).attribution).toBe('first-sample');
    const broken = runHorizonWatchTick({ db: f.db }, { now: () => at + hour / 2, stateDir: f.stateDir,
      openStore: (path) => {
        const reader = LogStore.openReadOnly(path);
        return { horizon: () => { throw new Error('broken horizon'); }, queryAll: reader.queryAll.bind(reader), close: () => reader.close() };
      } });
    expect(broken).toMatchObject({ outcome: 'fail', status: 'unreadable', attribution: 'none' });
    removeOldest(f.db, at - 3 * hour);
    expect(f.tick(at + hour)).toMatchObject({ outcome: 'ok', attribution: 'unattributed-loss', advancedMs: 2 * hour, deletedEvents: 0 });
    expect(f.samples().map(s => s.status)).toEqual(['present', 'unreadable', 'present']);
  } finally { f.store.close(); }
}, 60_000);

test('recovery includes deleted events logged before an unreadable tick', () => {
  const f = fixture();
  try {
    f.put(at - 3 * hour);
    f.put(at - hour);
    expect(f.tick(at).attribution).toBe('first-sample');
    removeOldest(f.db, at - 3 * hour);
    f.put(at + hour / 4, 'log-store.retention', 'deleted');
    const broken = runHorizonWatchTick({ db: f.db }, { now: () => at + hour / 2, stateDir: f.stateDir,
      openStore: (path) => {
        const reader = LogStore.openReadOnly(path);
        return { horizon: () => { throw new Error('broken horizon'); }, queryAll: reader.queryAll.bind(reader), close: () => reader.close() };
      } });
    expect(broken).toMatchObject({ outcome: 'fail', status: 'unreadable', attribution: 'none' });
    expect(f.tick(at + hour)).toMatchObject({ outcome: 'ok', attribution: 'attributed', advancedMs: 2 * hour, deletedEvents: 1 });
  } finally { f.store.close(); }
}, 60_000);

test('unreadable streak records exactly the latest 500 distinct ticks and retains the baseline separately', () => {
  const f = fixture();
  try {
    f.put(at - 3 * hour);
    f.put(at - hour);
    expect(f.tick(at).attribution).toBe('first-sample');
    const recordedAtMs = [at];
    const original = debug.log;
    debug.log = (() => {}) as typeof debug.log;
    try {
      for (let i = 1; i <= 501; i++) {
        const tickAt = at + i * 1_000;
        recordedAtMs.push(tickAt);
        const failure = runHorizonWatchTick({ db: f.db }, { now: () => tickAt, stateDir: f.stateDir,
          openStore: () => { throw new Error('unavailable'); } });
        expect(failure).toMatchObject({ outcome: 'fail', status: 'unreadable', attribution: 'none' });
      }
    } finally { debug.log = original; }
    expect(f.samples()).toHaveLength(500);
    expect(f.samples().map(s => s.atMs)).toEqual(recordedAtMs.slice(-500));
    expect(f.samples().every(s => s.status === 'unreadable')).toBe(true);
    expect(JSON.parse(readFileSync(join(f.stateDir, 'last-readable.json'), 'utf8'))).toMatchObject({ status: 'present', atMs: at });
    removeOldest(f.db, at - 3 * hour);
    expect(f.tick(at + hour)).toMatchObject({ attribution: 'unattributed-loss', advancedMs: 2 * hour, deletedEvents: 0 });
  } finally { f.store.close(); }
}, 60_000);

test('sample state retains only the last 500 complete JSONL lines', () => {
  const f = fixture();
  try {
    expect(f.tick(at).outcome).toBe('ok');
    const file = join(f.stateDir, 'samples.jsonl');
    const first = readFileSync(file, 'utf8').trim();
    writeFileSync(file, Array.from({ length: 500 }, (_, i) => JSON.stringify({ ...JSON.parse(first), atMs: at + i })).join('\n') + '\n');
    expect(f.tick(at + 500).outcome).toBe('ok');
    expect(f.samples()).toHaveLength(500);
    expect(f.samples()[0]?.atMs).toBe(at + 1);
    expect(f.samples().at(-1)?.atMs).toBe(at + 500);
  } finally { f.store.close(); }
});

test('CLI missing --db returns a single fail JSON line and saves an unreadable sample in isolated state', async () => {
  const f = fixture();
  f.store.close();
  const state = join(f.dir, 'state', 'log-horizon');
  const child = Bun.spawn(['bun', join(import.meta.dir, 'horizon-watch.ts'), '--json', '--db', join(f.dir, 'absent.db'), '--state', state], {
    env: { ...process.env, NODE_ENV: 'production', ELANOUS_STATE_DIR: join(f.dir, 'isolated-instance'), ELANOUS_CONFIG_DIR: join(f.dir, 'isolated-config') },
    stdout: 'pipe', stderr: 'pipe',
  });
  const timeout = setTimeout(() => child.kill(), 60_000);
  try {
    const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    expect(code).toBe(1);
    expect(stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(stdout)).toMatchObject({ outcome: 'fail', status: 'unreadable' });
    expect(f.samples().at(-1)?.status).toBe('unreadable');
  } finally { clearTimeout(timeout); }
}, 60_000);

test('concurrent CLI ticks retain both records while trimming to the latest 500 lines', async () => {
  const f = fixture();
  f.put(at - hour);
  f.store.close();
  const file = join(f.stateDir, 'samples.jsonl');
  f.tick(at);
  const initial = JSON.parse(readFileSync(file, 'utf8')) as HorizonSample;
  writeFileSync(file, Array.from({ length: 499 }, (_, i) => JSON.stringify({ ...initial, atMs: at + i })).join('\n') + '\n');
  const cli = join(import.meta.dir, 'horizon-watch.ts');
  const env = { ...process.env, NODE_ENV: 'production', ELANOUS_STATE_DIR: join(f.dir, 'isolated-instance'), ELANOUS_CONFIG_DIR: join(f.dir, 'isolated-config') };
  const children = Array.from({ length: 2 }, () => Bun.spawn(['bun', cli, '--json', '--db', f.db, '--state', f.stateDir], { env, stdout: 'pipe', stderr: 'pipe' }));
  const timeout = setTimeout(() => children.forEach(child => child.kill()), 60_000);
  try {
    const results = await Promise.all(children.map(async child => ({ code: await child.exited, output: JSON.parse(await new Response(child.stdout).text()) })));
    expect(results.every(result => result.code === 0 && result.output.outcome === 'ok')).toBe(true);
    expect(f.samples()).toHaveLength(500);
    expect(f.samples().filter(sample => sample.atMs > at + 498)).toHaveLength(2);
    expect(f.samples()[0]?.atMs).toBe(at + 1);
  } finally { clearTimeout(timeout); }
}, 60_000);

test('CLI refuses success but still records the sample when standalone sink registration returns false', async () => {
  const f = fixture();
  f.store.close();
  const child = Bun.spawn(['bun', join(import.meta.dir, 'horizon-watch.ts'), '--json', '--db', f.db, '--state', f.stateDir], {
    env: { ...process.env, NODE_ENV: 'test', ELANOUS_STATE_DIR: join(f.dir, 'isolated-instance'), ELANOUS_CONFIG_DIR: join(f.dir, 'isolated-config') },
    stdout: 'pipe', stderr: 'pipe',
  });
  const timeout = setTimeout(() => child.kill(), 60_000);
  try {
    const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    expect(code).toBe(1);
    expect(stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(stdout)).toMatchObject({ outcome: 'fail', reason: 'log-sink-registration-failed', status: 'empty' });
    expect(f.samples().at(-1)?.status).toBe('empty');
  } finally { clearTimeout(timeout); }
}, 60_000);

test('repository loop inventory reaches the hourly TC graph without enabling it', () => {
  const f = fixture();
  try {
    const configFile = join(f.dir, 'config.json');
    writeFileSync(configFile, '{}');
    const root = resolve(import.meta.dir, '../../..');
    const loop = listLoops({ root, stateRoot: f.stateDir, schedules: [], config: buildUserConfig(configFile) })
      .find(entry => entry.id === 'log-horizon-watch');
    expect(loop).toMatchObject({ id: 'log-horizon-watch', owner: 'TC', trigger: { cron: '23 * * * *', events: ['manual'] }, enabled: false });
    const graph = parseYaml(readFileSync(join(root, 'graphs/log-horizon/log-horizon-watch.yaml'), 'utf8'));
    const recipes = parseYaml(readFileSync(join(root, 'graphs/log-horizon/recipes.yaml'), 'utf8'));
    expect(graph).toMatchObject({ graph_id: 'log-horizon-watch', entry_node: 'sample', terminal_nodes: ['done', 'failed'],
      nodes: expect.arrayContaining([{ node_id: 'sample', kind: 'agent', recipe: 'cmd:log-horizon-sample', max_visits: 1 }]),
      edges: [{ from: 'sample', on: 'outcome', map: { ok: 'done', fail: 'failed', error: 'failed' } }] });
    expect(recipes['log-horizon-sample']).toEqual({
      command: 'bun "$ELANOUS_GRAPH_DIR/../../src/mss/logging/horizon-watch.ts" --json', timeout_ms: 120000,
    });
  } finally { f.store.close(); }
});
