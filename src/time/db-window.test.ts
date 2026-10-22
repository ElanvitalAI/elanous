// db-window 표준 — 술어가 **실제 SQLite 에서** 옳은지, 그리고 문자열 조립이 안전한지.
//
// ⚠️ 이 파일의 요점은 "정규식이 맞나" 가 아니라 **"raw 비교였다면 틀렸을 케이스에서 맞나"** 다.
//    그래서 매 케이스마다 raw 비교와 나란히 돌려 **둘이 갈리는 것**을 보인다. 표준을 쓰지 않으면
//    무엇이 깨지는지가 테스트 안에 남아 있어야 한다(주장 아니라 증거).

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  nowTs, tsAt, within, olderThan, newestFirst, oldestFirst,
  minutesAgo, hoursAgo, daysAgo, timeKey,
} from './db-window.js';

const SECOND = 1000;
/** SQLite `datetime()` 은 **초 단위로 자른다.** 경계에서 흔들리지 않게 여유를 크게 둔다.
 *  (JS 가 시각을 읽는 시점과 SQLite 가 `datetime('now')` 를 계산하는 시점의 지연도 함께 흡수.) */
const MARGIN = 60 * SECOND;

function db(): Database {
  const d = new Database(':memory:');
  d.run(`CREATE TABLE rows(id TEXT PRIMARY KEY, ts TEXT NOT NULL)`);
  return d;
}

/** 창 밖이면서 **cutoff 와 같은 UTC 날짜**인 시각 — 결함 재현의 필수 조건.
 *  날짜가 갈리면 raw 비교도 우연히 맞아 "raw 가 틀린다" 를 보일 수 없다. */
function outsideSameDay(windowMs: number, now = Date.now()): string {
  const cutoffSec = Math.floor((now - windowMs) / SECOND) * SECOND;
  const c = new Date(cutoffSec);
  const dayFloor = Date.UTC(c.getUTCFullYear(), c.getUTCMonth(), c.getUTCDate());
  const safe = cutoffSec - MARGIN;
  return tsAt(dayFloor <= safe ? dayFloor : safe);   // 여유 확보 불가 시 날짜를 넘겨서라도 후퇴
}

describe('within — 최근 N 이내', () => {
  test('★창 밖 행을 배제한다 (raw 비교였다면 통과시켰을 케이스)', () => {
    const d = db();
    const ins = d.prepare(`INSERT INTO rows(id, ts) VALUES (?,?)`);
    ins.run('in', nowTs());
    ins.run('out', outsideSameDay(12 * 3600 * SECOND));

    const std = d.prepare(`SELECT id FROM rows WHERE ${within('ts')}`).all(hoursAgo(12)) as Array<{ id: string }>;
    const raw = d.prepare(`SELECT id FROM rows WHERE ts >= datetime('now', ?)`).all(hoursAgo(12)) as Array<{ id: string }>;

    expect(std.map((r) => r.id)).toEqual(['in']);
    // ⭐ 표준을 안 쓰면 창 밖 행이 딸려 들어온다 — 이 대비가 이 표준의 존재 이유다.
    expect(raw.map((r) => r.id)).toEqual(['in', 'out']);
    d.close();
  });

  test('ISO 저장과 SQLite 저장이 섞여 있어도 같은 판정을 준다', () => {
    const toSqlite = (iso: string) => iso.slice(0, 19).replace('T', ' ');
    const outside = outsideSameDay(12 * 3600 * SECOND);
    const d = db();
    const ins = d.prepare(`INSERT INTO rows(id, ts) VALUES (?,?)`);
    ins.run('iso-in', nowTs());
    ins.run('sql-in', toSqlite(nowTs()));
    ins.run('iso-out', outside);
    ins.run('sql-out', toSqlite(outside));

    const got = (d.prepare(`SELECT id FROM rows WHERE ${within('ts')} ORDER BY id`).all(hoursAgo(12)) as Array<{ id: string }>)
      .map((r) => r.id);
    expect(got).toEqual(['iso-in', 'sql-in']);
    d.close();
  });
});

describe('olderThan — 휘발 대상', () => {
  test('★보존기간을 넘긴 행이 실제로 걸린다 (raw 는 반대 방향으로 샌다)', () => {
    const d = db();
    const ins = d.prepare(`INSERT INTO rows(id, ts) VALUES (?,?)`);
    ins.run('keep', nowTs());
    ins.run('drop', outsideSameDay(24 * 3600 * SECOND));

    const std = d.prepare(`SELECT id FROM rows WHERE ${olderThan('ts')}`).all(daysAgo(1)) as Array<{ id: string }>;
    const raw = d.prepare(`SELECT id FROM rows WHERE ts < datetime('now', ?)`).all(daysAgo(1)) as Array<{ id: string }>;

    expect(std.map((r) => r.id)).toEqual(['drop']);
    // raw 는 `'T' > ' '` 때문에 `<` 가 거짓이 되어 **덜 지운다**.
    expect(raw).toEqual([]);
    d.close();
  });
});

describe('newestFirst / oldestFirst — 정렬도 정규화 대상', () => {
  test('★혼합 저장에서 최신순이 뒤집히지 않는다', () => {
    // 📏 10-22 0.2.35 gate r2: Date.now() 를 쓰면 UTC 자정 직후 30분 안에는 «30분 전» 이 전날 날짜가 되어
    //   raw 문자열 정렬도 날짜 앞자리로 정해진다 — 단언 raw=['older','newest'] 가 시계에 따라 깨진다(ⓒ 시계 의존).
    //   이 시험이 보증하는 것(같은 날짜에서 저장 형식이 raw 정렬을 뒤집는다 ⊕ newestFirst 는 정규화한다)은 정오 UTC 로 고정해 잰다.
    const now = Date.UTC(2026, 9, 22, 12, 0, 0);
    const toSqlite = (iso: string) => iso.slice(0, 19).replace('T', ' ');
    const d = db();
    const ins = d.prepare(`INSERT INTO rows(id, ts) VALUES (?,?)`);
    // 진짜 최신을 SQLite 형식으로, 더 과거를 ISO 형식으로 — raw 정렬이면 뒤집힌다.
    ins.run('newest', toSqlite(tsAt(now - 60 * SECOND)));
    ins.run('older', tsAt(now - 30 * 60 * SECOND));

    const std = (d.prepare(`SELECT id FROM rows ORDER BY ${newestFirst('ts')}`).all() as Array<{ id: string }>).map((r) => r.id);
    const raw = (d.prepare(`SELECT id FROM rows ORDER BY ts DESC`).all() as Array<{ id: string }>).map((r) => r.id);

    expect(std).toEqual(['newest', 'older']);
    expect(raw).toEqual(['older', 'newest']);   // ⭐ raw 는 저장 형식이 정렬을 정한다
    d.close();
  });

  test('oldestFirst 는 그 역순', () => {
    const now = Date.now();
    const d = db();
    const ins = d.prepare(`INSERT INTO rows(id, ts) VALUES (?,?)`);
    ins.run('a', tsAt(now - 60 * SECOND));
    ins.run('b', tsAt(now - 30 * 60 * SECOND));
    const got = (d.prepare(`SELECT id FROM rows ORDER BY ${oldestFirst('ts')}`).all() as Array<{ id: string }>).map((r) => r.id);
    expect(got).toEqual(['b', 'a']);
    d.close();
  });
});

describe('modifier 빌더', () => {
  test('SQLite modifier 문자열을 만든다', () => {
    expect([minutesAgo(90), hoursAgo(12), daysAgo(90)]).toEqual(['-90 minutes', '-12 hours', '-90 days']);
  });

  test('소수는 정수로 반올림한다 — SQLite 가 소수 modifier 를 안 받는다', () => {
    expect([minutesAgo(1.4), hoursAgo(2.6), daysAgo(0.5)]).toEqual(['-1 minutes', '-3 hours', '-1 days']);
  });

  test('실제로 SQLite 가 파싱한다', () => {
    const d = db();
    for (const m of [minutesAgo(90), hoursAgo(12), daysAgo(90)]) {
      const r = d.prepare(`SELECT datetime('now', ?) AS t`).get(m) as { t: string | null };
      expect({ m, ok: typeof r.t === 'string' }).toEqual({ m, ok: true });
    }
    d.close();
  });
});

describe('식별자 가드 — 문자열 조립이라 형태를 강제한다', () => {
  test('테이블 접두 컬럼은 허용', () => {
    expect(within('e.ts')).toBe(`datetime(e.ts) >= datetime('now', ?)`);
    expect(newestFirst('e.ts')).toBe('datetime(e.ts) DESC');
  });

  test('★식별자가 아니면 던진다 — 주입 통로를 막는다', () => {
    for (const bad of ["ts) OR 1=1 --", 'ts; DROP TABLE rows', 'ts ', '', '1ts', 'a.b.c']) {
      expect(() => within(bad)).toThrow();
      expect(() => olderThan(bad)).toThrow();
      expect(() => newestFirst(bad)).toThrow();
      expect(() => oldestFirst(bad)).toThrow();
    }
  });
});

describe('nowTs / tsAt — 저장 표준', () => {
  test('ISO-8601 UTC 형식이다', () => {
    expect(nowTs()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(tsAt(0)).toBe('1970-01-01T00:00:00.000Z');
  });

  test('SQLite 가 파싱할 수 있는 값이다', () => {
    const d = db();
    const r = d.prepare(`SELECT datetime(?) AS t`).get(nowTs()) as { t: string | null };
    expect(typeof r.t).toBe('string');
    d.close();
  });
});

describe('timeKey — 극값 선택은 초 절단이 치명적이다', () => {
  test('★같은 초 안의 두 행을 구분한다 (datetime 은 못 한다)', () => {
    const base = Date.UTC(2026, 6, 27, 3, 0, 0);
    const early = tsAt(base + 100), late = tsAt(base + 900);   // 같은 초, 밀리초만 다름
    const d = db();
    const ins = d.prepare(`INSERT INTO rows(id, ts) VALUES (?,?)`);
    ins.run('early', early);
    ins.run('late', late);

    // `datetime()` 축: 둘이 같은 값이 되어 **두 행 다** 최신으로 매칭된다
    const byDatetime = (d.prepare(
      `SELECT id FROM rows WHERE datetime(ts) = (SELECT MAX(datetime(ts)) FROM rows)`,
    ).all() as Array<{ id: string }>).map((r) => r.id).sort();
    expect(byDatetime).toEqual(['early', 'late']);

    // `timeKey()` 축: 정확히 한 행
    const byKey = (d.prepare(
      `SELECT id FROM rows WHERE ${timeKey('ts')} = (SELECT MAX(${timeKey('ts')}) FROM rows)`,
    ).all() as Array<{ id: string }>).map((r) => r.id);
    expect(byKey).toEqual(['late']);
    d.close();
  });

  test('ISO·SQLite 두 형식을 모두 파싱한다', () => {
    const d = db();
    const iso = tsAt(Date.UTC(2026, 6, 27, 3, 0, 0));
    const sql = iso.slice(0, 19).replace('T', ' ');
    const r = d.prepare(`SELECT ${timeKey('a')} ja, ${timeKey('b')} jb FROM (SELECT ? AS a, ? AS b)`).get(iso, sql) as { ja: number; jb: number };
    expect({ iso: typeof r.ja, sql: typeof r.jb, same: r.ja === r.jb }).toEqual({ iso: 'number', sql: 'number', same: true });
    d.close();
  });

  test('식별자 가드가 걸린다', () => {
    expect(() => timeKey('ts; DROP TABLE rows')).toThrow();
    expect(timeKey('e.ts')).toBe('julianday(e.ts)');
  });
});
