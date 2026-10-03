import { afterEach, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { formatSchedule, getSchedule, listSchedules, setSchedule } from './release-schedule.js';

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
