import { afterEach, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { formatSchedule, getSchedule, listSchedules, setSchedule, dueReleaseCutEvents, emitDueReleaseCutEvents } from './release-schedule.js';
import { runGraph } from '../graph-runner/runner.js';
import { runUnattendedRelease } from '../../scripts/release-loop/unattended-release.js';
import { graphScheduleEntries } from '../workflow-runtime/triggers/registry.js';
import { parse as yaml } from 'yaml';

let dir = '';
function setup() { dir = mkdtempSync(join(tmpdir(), 'release-schedule-')); setElanousConfigDir(dir); }
afterEach(() => { resetElanousConfigDir(); if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });

test('판별 UTC 저장 · KST 표시 · 순서 · 이력의 from/to 및 관측', () => {
  setup();
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    const first = setSchedule('0.2.10', { cutAt: '2026-10-03T08:00+09:00', landBy: '2026-10-03T06:30+09:00' }, 'OP');
    expect(first).toMatchObject({ version: '0.2.10', cutAt: '2026-10-02T23:00:00.000Z', landBy: '2026-10-02T21:30:00.000Z', updatedBy: 'OP' });
    expect(formatSchedule(first)).toBe('0.2.10 컷 10-03(토) 08:00 KST · 착지 마감 06:30');
    expect(formatSchedule({ ...first, landBy: '2026-10-01T21:30:00.000Z' })).toBe('0.2.10 컷 10-03(토) 08:00 KST · 착지 마감 10-02(금) 06:30 KST');
    expect(getSchedule('0.2.10')).toEqual(first);
    const second = setSchedule('0.2.10', { cutAt: '2026-10-03T09:00+09:00', landBy: '2026-10-03T07:00+09:00' }, 'TC');
    expect(listSchedules()).toEqual([second]);
    const db = new Database(join(dir, 'release/features.sqlite'));
    try {
      expect(db.query('SELECT feature_id, field, "from", "to", by FROM events WHERE version = ? ORDER BY seq').all('0.2.10')).toEqual([
        { feature_id: '@version', field: 'cut_at', from: 'null', to: '"2026-10-02T23:00:00.000Z"', by: 'OP' },
        { feature_id: '@version', field: 'land_by', from: 'null', to: '"2026-10-02T21:30:00.000Z"', by: 'OP' },
        { feature_id: '@version', field: 'cut_at', from: '"2026-10-02T23:00:00.000Z"', to: '"2026-10-03T00:00:00.000Z"', by: 'TC' },
        { feature_id: '@version', field: 'land_by', from: '"2026-10-02T21:30:00.000Z"', to: '"2026-10-02T22:00:00.000Z"', by: 'TC' },
      ]);
      expect(db.query('SELECT version, cut_at, land_by, updated_by FROM release_schedules').all()).toEqual([
        { version: '0.2.10', cut_at: second.cutAt, land_by: second.landBy, updated_by: 'TC' },
      ]);
      setSchedule('0.2.10', { cutAt: '2026-10-03T09:00+09:00' }, 'TC');
      expect(db.query('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 4 });
    } finally { db.close(); }
    expect(log).toHaveBeenCalledWith('release.schedule', 'set', { version: '0.2.10', cutAt: first.cutAt, landBy: first.landBy });
    expect(log).toHaveBeenCalledWith('release.schedule', 'read', { version: '0.2.10', cutAt: first.cutAt, landBy: first.landBy });
  } finally { log.mockRestore(); }
});

test('시각은 오프셋 포함 ISO 만 · 잘못된 날짜나 비어 있는 첫 컷 거부', () => {
  setup();
  for (const value of ['2026-10-03T08:00', '2026-10-03 08:00', '2026-10-03T08:00+24:00', '2026-02-30T08:00+09:00']) {
    expect(() => setSchedule('0.2.10', { cutAt: value }, 'OP')).toThrow();
  }
  expect(() => setSchedule('0.2.10', { landBy: '2026-10-03T06:30+09:00' }, 'OP')).toThrow('--cut-at');
  expect(getSchedule('0.2.10')).toBeNull();
});

test('옛 피처 DB 는 기존 칸·이벤트 보존한 채 판 표만 추가한다', () => {
  setup();
  mkdirSync(join(dir, 'release'));
  const db = new Database(join(dir, 'release/features.sqlite'));
  db.exec(`CREATE TABLE features (id TEXT PRIMARY KEY, title TEXT NOT NULL, owner TEXT, kind TEXT, created_at TEXT NOT NULL);
    CREATE TABLE assignments (feature_id TEXT NOT NULL REFERENCES features(id), version TEXT NOT NULL, status TEXT NOT NULL, disposition TEXT, evidence TEXT, title_override TEXT, owner TEXT, kind TEXT, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL, PRIMARY KEY(feature_id, version));
    CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, by TEXT NOT NULL, feature_id TEXT NOT NULL, version TEXT NOT NULL, field TEXT NOT NULL, "from" TEXT, "to" TEXT, released TEXT NOT NULL, dev TEXT NOT NULL);
    CREATE TABLE evidence (feature_id TEXT NOT NULL, version TEXT NOT NULL, ref TEXT NOT NULL, at TEXT NOT NULL, by TEXT NOT NULL);
    CREATE TABLE imported_versions (version TEXT PRIMARY KEY, json_hash TEXT, imported_at TEXT);
    INSERT INTO features VALUES ('K1', '보존', NULL, NULL, '2026-10-01T00:00:00Z');`);
  db.close();
  expect(listSchedules()).toEqual([]);
  const row = setSchedule('0.2.11', { cutAt: '2026-10-04T08:00+09:00' }, 'OP');
  expect(row.landBy).toBeNull();
  const migrated = new Database(join(dir, 'release/features.sqlite'));
  expect(migrated.query('SELECT title FROM features WHERE id = ?').get('K1')).toEqual({ title: '보존' });
  expect(migrated.query('SELECT name FROM sqlite_master WHERE name = ?').get('release_schedules')).toEqual({ name: 'release_schedules' });
  migrated.close();
});

test('컷 일정 사건이 구독한 그래프를 손 명령 없이 한 번 시작한다', async () => {
  setup();
  mkdirSync(join(dir, 'release', '0.2.9'), { recursive: true });
  writeFileSync(join(dir, 'release', '0.2.9', 'release.json'), JSON.stringify({ version: '0.2.9', publishedAt: '2026-10-01T00:00:00Z' }));
  const cutAt = '2026-10-03T08:00+09:00';
  setSchedule('0.2.10', { cutAt }, 'OP');
  const graphFile = join(dir, 'release-event.yaml');
  writeFileSync(join(dir, 'recipes.yaml'), '{}\n');
  writeFileSync(graphFile, `graph_id: release-loop
loop:
  trigger:
    events: [manual, release.cut.due]
version: 1
entry_node: done
terminal_nodes: [done]
nodes:
  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }
edges: []
`);
  expect(dueReleaseCutEvents('2026-10-02T22:59:59Z', dir)).toEqual([]);
  const now = '2026-10-02T23:00:01Z';
  const started: string[] = [];
  const emit = async (event: { type: string; id: string; version: string }) => {
    const fired = await runUnattendedRelease({ version: event.version,
      triggerEvent: event as { id: string; type: 'release.cut.due'; version: string; cutAt: string; at: string } }, {
      ledgerRoot: dir, config: { gatePodPool: 'test-pool' },
      checklist: () => ({ ok: true, red: [], undecided: [], blocked: [] }),
      graph: (_path, options) => runGraph(graphFile, options),
    });
    expect(fired.state?.status).toBe('done');
    started.push(fired.state!.runId);
  };
  const first = await emitDueReleaseCutEvents(now, emit, dir);
  expect(first).toMatchObject([{ type: 'release.cut.due', version: '0.2.10' }]);
  expect(started).toHaveLength(1);
  expect(await emitDueReleaseCutEvents(now, emit, dir)).toEqual([]);
  expect(readdirSync(join(dir, 'graph-runs', 'release-loop')).filter(name => name.endsWith('.json'))).toHaveLength(1);
  const run = JSON.parse(readFileSync(join(dir, 'graph-runs', 'release-loop', `${started[0]}.json`), 'utf8'));
  expect(run.input.triggerEvent.id).toBe(first[0]!.id);
  const claims = join(dir, 'release', 'cut-events');
  const claim = join(claims, readdirSync(claims)[0]!);
  writeFileSync(claim, JSON.stringify({ status: 'pending', pid: 999999 }));
  expect(await emitDueReleaseCutEvents(now, emit, dir)).toEqual([]);
  expect(JSON.parse(readFileSync(claim, 'utf8'))).toMatchObject({ status: 'emitted', recovered: true });
  expect(started).toHaveLength(1);
});

test('실제 릴리스 그래프는 컷 사건과 스케줄러 tick을 모두 선언한다', () => {
  const graph = yaml(readFileSync(join(import.meta.dir, '../../graphs/release/release-loop.yaml'), 'utf8')) as {
    loop: { trigger: { events: string[] } } };
  expect(graph.loop.trigger.events).toContain('release.cut.due');
  expect(graphScheduleEntries(graph)).toMatchObject([{
    workflowName: 'graph:release-loop', trigger: { type: 'cron', cron: '* * * * *' },
  }]);
});
