// ── LogStore — 통합 로그 패브릭 LF0 적재 백본 (2026-07-13) ──────────────────
//
// 문제: 로그가 6종 싱크(파일 트레일·ring·auth-trace·debug-tap JSONL·tab
// stdout·ops_events.db)로 파편화돼 "전 서피스를 한 번에 조회/tail" 하는 면이
// 없다. adb logcat 급 크로스서피스 관측(레벨·서피스·컴포넌트 필터)을 위해
// 단일 조회 스토어를 신설한다. 설계: 내부 문서 `PLAN-unified-log-fabric-2026-07-13` §LF0.
//
// 원칙:
//   • 파일 트레일이 항상 1순위 — 본 스토어는 조회면. 스토어 실패가 로깅
//     자체를 절대 막지 않는다(fail-soft · ops-log.ts 패턴).
//   • 게이트 의미론 보존 — StoreSink 는 debug.registerSink() 확장점으로
//     꽂혀 FileSink 와 같은 조건의 이벤트만 받는다(trail 기본값에서
//     hot-path 비용 불변).
//   • 자기참조 금지 — 로그 평면 자신의 카테고리(`logs.*`)는 스토어에
//     재진입하지 않는다(debug-bridge acp.* 46k fanout 사건 교훈).
//   • 스키마는 ECS-호환 필드 지향 — 후일 외부 ELK export 무마찰.
//     severity 는 SCHEME(이벤트 접미사) → `level` 컬럼으로 물질화.

import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { elanousStateRoot } from '../../autopilot/state-paths.js';
import { dirname, join } from 'node:path';

import { LOG_LEVEL_ORDER, type LogLevel, type LogRecord } from './record.js';
import type { LogSink } from './sink.js';
import { setInstanceName, resolveInstanceName } from '../../instance-identity.js';
import * as nestDepth from '../../agent/nest-depth.js';
import { debug } from '../../debug/log.js';

/** 스토어 경로 — `ELANOUS_STATE_DIR` 존중(격리 테스트/`nexus run --test` 의
 *  기존 knob 그대로), 기본 `~/.elanous/logs/logs.db`. lazy 함수 — env 를
 *  임포트 시점이 아니라 호출 시점에 읽는다(telegram-test 등이 부팅 전 세팅). */
export function logsDbPath(): string {
  return join(elanousStateRoot(), 'logs', 'logs.db');
}

// ── 인스턴스 identity (LF7-a · 2026-07-13) ───────────────────────────
//
// 멀티 엘라누스(prod 1 + 폴더별 test N) 운영에서 "이 로그를 누가 남겼나"를
// 레코드에 박제한다. 스토어가 state dir 로 물리 격리돼 있어도, 연합 조회
// (elanous logs --all · PWA 인스턴스 셀렉터)와 로그 공유 시 출처가 필요.
//
// 이름 유도(우선순위):
//   1. setLogInstanceName() — 데몬 부팅이 config(logs.instanceName) 값을
//      주입(user-config 순환 의존 회피 — 본 모듈은 config 를 읽지 않는다).
//   2. ELANOUS_STATE_DIR 미설정 → 'prod'
//   3. state dir 이름이 '.elanous-test' → `test:<부모 폴더명>` (repo 이름)
//   4. 그 외 → `test:<state dir 이름>` (예: telegram-test)

// 인스턴스명 유도는 세션 저장소와 공유한다(같은 격리 경계 = 같은 이름·연합 정합).
// 로직/오버라이드 상태는 `../../instance-identity.ts` 로 일원화(중복 제거) — 아래는
// 로그 도메인 이름을 유지하는 얇은 위임(호출처 무변경).

/** 데몬/러너 부팅 1회 — config 의 logs.instanceName 을 주입. 빈 문자열 무시. */
export function setLogInstanceName(name: string | undefined): void {
  setInstanceName(name);
}

export function resolveLogInstanceName(): string {
  return resolveInstanceName();
}

// ── severity — 명시 채널(opts.level) 이 유일 공급원 (OH10 PR-b2 · 2026-07-24) ──
//
// 이전엔 이벤트/카테고리 접미사(`.error`/`.timeout`/`.done` …)로 severity 를
// 유추했으나, 그 규약은 코드와 어긋나고(예: `.return`/`.miss` 누락) "명시가
// 아니라 문자열 관행에 severity 를 싣는다" 는 취약성이 있었다. OH10 수술에서
// `debug.log(cat, ev, data?, { level })` 명시 채널을 신설(PR-a)하고 error/warn
// 사이트를 전수 명시 전환(PR-b1)한 뒤, 본 PR-b2 에서 접미사 유도를 삭제한다.
// 이제 severity 공급원은 **명시 `rec.level` only**, 미명시는 `debug`.
// info 접미사(boot/ready/done 등)는 명시 대상이 아니어서 debug 로 강등되나
// 이는 PLAN 의도(정보손실 아님 — 중요 신호는 B축에서 error/warn 로 승격됨).

export function deriveLogLevel(rec: Pick<LogRecord, 'event' | 'level' | 'category'>): LogLevel {
  return rec.level ?? 'debug';
}

export interface LogStoreRetention {
  /** 보존 일수. 0 이하 = age 정리 안 함. 기본 7. */
  maxAgeDays: number;
  /** DB 상한(MB). 초과 시 오래된 행부터 삭제. 0 이하 = 크기 정리 안 함. 기본 500. */
  maxDbMb: number;
}

export const LOG_RETENTION_DEFAULTS: LogStoreRetention = { maxAgeDays: 7, maxDbMb: 500 };

/** 스토어 OOM 백스톱 — 정책 상한이 아니다. 정책은 각 경계(HTTP·툴)가 갖는다. */
export const STORE_SAFETY_MAX = 100_000;

/**
 * ⭐ 페이지 커서가 가리키는 행이 이 스토어에 없다 — **조용히 한 쪽을 더 내주지 않는다.**
 * 커서가 딴 인스턴스의 id 이거나(연합), 보존 정리로 사라진 행이면 어떤 결과도 정직하지 않다.
 */
/** Read-only federation waits briefly for a concurrent writer before surfacing an unreadable store. */
export const LOG_STORE_READONLY_BUSY_TIMEOUT_MS = 2_000;
const LOG_STORE_WRITE_BUSY_TIMEOUT_MS = 5_000;
const LOG_STORE_OPEN_RETRY_DELAYS_MS = [100, 200, 400, 800, 1600] as const;
const sqliteOpenWait = new Int32Array(new SharedArrayBuffer(4));
let pendingBusyOpenLosses: Array<{ path: string; loss: { store: 'logs'; op: 'open'; waitedMs: number } }> = [];

function sqliteBusy(error: unknown): boolean {
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database is busy/i.test(String(error));
}

export class LogCursorNotFoundError extends Error {
  constructor(public readonly beforeId: number) {
    super(`page cursor row ${beforeId} not found in this store`);
    this.name = 'LogCursorNotFoundError';
  }
}

export interface LogQuery {
  /** 이 레벨 이상만 (LOG_LEVEL_ORDER 기준). */
  minLevel?: LogLevel;
  /** instance 정확 일치(복수 OR) — 연합 조회에서 출처 필터. */
  instances?: string[];
  /** surface 정확 일치(복수 OR). */
  surfaces?: string[];
  /** category prefix 매치(복수 OR) — 'voice' 는 voice.* 전부. */
  categories?: string[];
  /** category 정확 일치(복수 OR) — 자식 category 는 제외. */
  exactCategories?: string[];
  /** event 정확 일치(복수 OR). */
  events?: string[];
  /** event/data/category LIKE 부분 일치. */
  grep?: string;
  sessionId?: string;
  /** Trace ownership: explicit row projectId takes precedence over session ownership. */
  projectId?: string;
  projectSessionIds?: readonly string[];
  sinceMs?: number;
  untilMs?: number;
  /** 증분 커서 — id > afterId 를 오름차순으로(SSE 드레인). */
  afterId?: number;
  /**
   * ⭐ **역방향 페이지 커서** — `id < beforeId` 를 최근순으로. 다음 **더 오래된** 한 쪽을 준다.
   *
   * ⛔ 왜 필요한가(2026-07-29 실측): `--limit` 상한이 1000 이고 정렬이 최근순이라
   *   **`--since` 를 아무리 넓혀도 최근 1000건만** 온다. `frame-stall` 전수 조회가
   *   12h·24h·…·168h 어느 창을 걸어도 **정확히 1000행**을 냈고, 그걸 *"7일치"* 로 읽어
   *   **두 트랙이 같은 오독**을 했다. 창을 넓히는 것으로는 과거로 못 간다.
   * ⛔⭐ **`id` 단독으로 자르지 않는다**(2026-07-29 라이브 실측이 초판을 반증했다).
   *   정렬이 `ts_ms DESC, id DESC` 인데 커서만 `id` 면 **정렬 키와 커서 키가 다르다**.
   *   id 는 삽입 순서라 ts 와 어긋날 수 있어(비동기 flush) 두 순서가 갈리는 경계에서
   *   **행이 조용히 유실**됐다 — 전수 70건 vs 페이징 60건. ⇒ 앵커 행의 `ts_ms` 를 찾아
   *   `(ts_ms, id)` **복합 커서**로 자르고, id 는 **같은 밀리초의 tie-break** 로만 쓴다.
   */
  beforeId?: number;
  /** 기본 100 · 상한은 `STORE_SAFETY_MAX`(OOM 백스톱). 정책 상한은 각 경계가 갖는다. */
  limit?: number;
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export interface LogStoreDataKeyQuery {
  exactCategories: readonly string[];
  runIds?: readonly string[];
  sessionIds?: readonly string[];
  correlationIds?: readonly string[];
}

export interface LogStoreRunChainRows {
  rows: readonly LogStoreRow[];
  unreadableRunIds: readonly string[];
}

export interface LogStoreRow {
  id: number;
  ts: string;
  ts_ms: number;
  level: string;
  instance: string;
  host_id?: string;
  surface: string;
  category: string;
  event: string;
  session_id: string | null;
  trace_id: string | null;
  data: string | null;
}

/** SQLite 적재 스토어. WAL — 데몬(nexus)·TUI 등 복수 프로세스가 같은
 *  파일에 append 해도 안전. 조회 API(LF1)가 이 위에 앉는다. */
export class LogStore {
  private db: Database;
  readonly path: string;
  /** insert 시 각 행에 박제되는 출처 이름. 조회 전용 open 에는 무의미. */
  readonly instance: string;
  /** read-only open (LF7-b 연합 조회) — 스키마 생성/마이그레이션/insert 불가. */
  readonly readonly: boolean;

  /** 타 인스턴스 스토어의 연합 조회용 read-only open — "연합은 read-only 로만"
   *  불변식의 구조적 집행(마이그레이션 포함 어떤 write 도 발생 불가). */
  static openReadOnly(path: string): LogStore {
    return new LogStore(path, { readonly: true });
  }

  constructor(path: string = logsDbPath(), opts: { instance?: string; readonly?: boolean } = {}) {
    this.path = path;
    this.instance = opts.instance ?? resolveLogInstanceName();
    this.readonly = opts.readonly === true;
    if (this.readonly) {
      // 존재하는 DB 를 열기만 — 스키마 생성/ALTER/backfill 전부 스킵.
      // 구 스키마(instance 컬럼 없음)여도 SELECT * 는 동작(컬럼 부재 시
      // row.instance 는 undefined — 소비자가 fallback).
      this.db = new Database(path, { readonly: true });
      this.db.run(`PRAGMA busy_timeout = ${LOG_STORE_READONLY_BUSY_TIMEOUT_MS}`);
      return;
    }
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const openedAt = Date.now();
    for (let attempt = 0; ; attempt++) {
      let db: Database | undefined;
      try {
        db = new Database(path);
        db.run(`PRAGMA busy_timeout = ${LOG_STORE_WRITE_BUSY_TIMEOUT_MS}`);
        this.db = db;
        this.initializeWriter();
        break;
      } catch (error) {
        db?.close();
        if (!sqliteBusy(error)) throw error;
        if (attempt >= LOG_STORE_OPEN_RETRY_DELAYS_MS.length) {
          const loss = { store: 'logs' as const, op: 'open' as const, waitedMs: Date.now() - openedAt };
          pendingBusyOpenLosses.push({ path, loss });
          try { process.stderr.write(`[store.sqlite] busy-lost ${JSON.stringify(loss)}\n`); } catch { /* diagnostics must not block callers */ }
          throw error;
        }
        Atomics.wait(sqliteOpenWait, 0, 0, LOG_STORE_OPEN_RETRY_DELAYS_MS[attempt]);
      }
    }
    for (const item of pendingBusyOpenLosses.filter((entry) => entry.path === path)) {
      try {
        this.insertBatch([{ rec: { ts: new Date().toISOString(), category: 'store.sqlite', event: 'busy-lost', data: item.loss }, surface: 'nexus' }]);
        debug.log('store.sqlite', 'busy-lost', item.loss);
        pendingBusyOpenLosses.splice(pendingBusyOpenLosses.indexOf(item), 1);
      } catch { /* retain the observation for the next writable connection */ }
    }
  }

  private initializeWriter(): void {
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run(`CREATE TABLE IF NOT EXISTS logs(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      ts_ms INTEGER NOT NULL,
      level TEXT NOT NULL,
      instance TEXT NOT NULL DEFAULT '',
      host_id TEXT NOT NULL DEFAULT '',
      surface TEXT NOT NULL,
      category TEXT NOT NULL,
      event TEXT NOT NULL,
      session_id TEXT,
      trace_id TEXT,
      data TEXT
    )`);
    // LF7-a 마이그레이션 — 기존 DB 에 instance 컬럼 추가. 이 스토어는 인스턴스당
    // 1개(state dir 격리)이므로 구행은 전부 자기 이름으로 backfill (ALTER 직후 1회).
    const cols = this.db.query("PRAGMA table_info(logs)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'instance')) {
      this.db.run("ALTER TABLE logs ADD COLUMN instance TEXT NOT NULL DEFAULT ''");
      this.db.run('UPDATE logs SET instance = ?', [this.instance]);
    }
    if (!cols.some((c) => c.name === 'host_id')) {
      this.db.run("ALTER TABLE logs ADD COLUMN host_id TEXT NOT NULL DEFAULT ''");
    }
    this.db.run('CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts_ms)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level, ts_ms)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_logs_surface ON logs(surface, ts_ms)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_logs_category ON logs(category, ts_ms)');
  }

  /** 배치 insert(단일 트랜잭션). 실패는 throw — fail-soft 는 호출측(StoreSink)
   *  책임(ops-log 의 recordOpsEvent/Safe 분업 동형). */
  insertBatch(rows: Array<{ rec: LogRecord; surface: string }>): void {
    if (rows.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO logs (ts, ts_ms, level, instance, host_id, surface, category, event, session_id, trace_id, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertAll = this.db.transaction((batch: Array<{ rec: LogRecord; surface: string }>) => {
      for (const { rec, surface } of batch) {
        const tsMs = Date.parse(rec.ts);
        stmt.run(
          rec.ts,
          Number.isFinite(tsMs) ? tsMs : Date.now(),
          deriveLogLevel(rec),
          this.instance,
          rec.data && typeof rec.data === 'object' && !Array.isArray(rec.data)
            && typeof (rec.data as Record<string, unknown>).hostId === 'string'
            ? (rec.data as Record<string, string>).hostId
            : process.env.ELANOUS_HOST_ID ?? '',
          surface,
          rec.category,
          rec.event,
          (rec as { session_id?: string }).session_id ?? null,
          rec.trace_id ?? null,
          rec.data !== undefined ? JSON.stringify(rec.data) : null,
        );
      }
    });
    const startedAt = Date.now();
    try {
      insertAll(rows);
    } catch (error) {
      if (sqliteBusy(error)) {
        const loss = { store: 'logs', op: 'insertBatch', waitedMs: Date.now() - startedAt };
        try { process.stderr.write(`[store.sqlite] busy-lost ${JSON.stringify(loss)}\n`); } catch { /* diagnostics must not block callers */ }
        debug.log('store.sqlite', 'busy-lost', loss);
      }
      throw error;
    }
  }

  /** 보존정책 집행 — age 초과 삭제 + 크기 상한(오래된 행부터). 부팅 시 1회 +
   *  주기 호출(등록 헬퍼가 스케줄). fail-soft 는 호출측. */
  enforceRetention(policy: LogStoreRetention = LOG_RETENTION_DEFAULTS): { deletedByAge: number; deletedBySize: number } {
    let deletedByAge = 0;
    let deletedBySize = 0;
    if (policy.maxAgeDays > 0) {
      const cutoff = Date.now() - policy.maxAgeDays * 86_400_000;
      const r = this.db.run('DELETE FROM logs WHERE ts_ms < ?', [cutoff]);
      deletedByAge = Number(r.changes ?? 0);
    }
    if (policy.maxDbMb > 0) {
      const pageCount = (this.db.query('PRAGMA page_count').get() as { page_count: number }).page_count;
      const pageSize = (this.db.query('PRAGMA page_size').get() as { page_size: number }).page_size;
      const sizeMb = (pageCount * pageSize) / (1024 * 1024);
      if (sizeMb > policy.maxDbMb) {
        // 초과분 비율만큼 오래된 행 삭제(대략 — 정밀 계산보다 반복 수렴 선호).
        const total = (this.db.query('SELECT COUNT(*) AS c FROM logs').get() as { c: number }).c;
        const dropCount = Math.max(1, Math.floor(total * Math.min(0.5, 1 - policy.maxDbMb / sizeMb)));
        const r = this.db.run(
          'DELETE FROM logs WHERE id IN (SELECT id FROM logs ORDER BY ts_ms ASC LIMIT ?)',
          [dropCount],
        );
        deletedBySize = Number(r.changes ?? 0);
      }
    }
    return { deletedByAge, deletedBySize };
  }

  /**
   * ⛔⭐⭐⭐ **이 스토어에 «실제로 뜬» 카테고리와 그 수**(2026-08-19 · `OBS-T122`).
   *
   * 🚨 왜 필요한가 — 소스에는 `debug.log('<category>', …)` 자리가 ***1,055개*** 있는데,
   *   그중 «한 번도 안 뜬» 것이 몇인지 물을 표면이 ***없었다***. 그래서 `F12`(만들어졌는데 안 닿는다)를
   *   ***매번 한 카테고리씩 손으로*** 확인했다(오늘만 대여섯 번).
   * ⭐ `--explain` 은 «큐레이션된 축»(2개)만 보여 준다 — 그건 다른 질문이다.
   * ⛔ 읽기 전용이다. 그리고 «없는 것»은 여기 안 나온다 — 그것이 이 함수의 «쓸모»다(차집합을 낸다).
   */
  categoryCounts(q: Pick<LogQuery, 'sinceMs' | 'untilMs'> = {}): Array<{ category: string; count: number }> {
    const { clause, params } = this.buildWhere(q);
    return this.db
      .query(`SELECT category, COUNT(*) AS count FROM logs ${clause} GROUP BY category ORDER BY count DESC`)
      .all(...(params as never[])) as Array<{ category: string; count: number }>;
  }

  /** LF1 조회의 최소 씨앗 — 최근 N행(내림차순). 본격 필터 API 는 query(). */
  recent(limit: number = 100): LogStoreRow[] {
    return this.db
      .query('SELECT * FROM logs ORDER BY ts_ms DESC, id DESC LIMIT ?')
      .all(Math.max(1, limit)) as LogStoreRow[];
  }

  private buildWhere(q: Omit<LogQuery, 'limit'>): { clause: string; params: unknown[] } {
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.minLevel) {
      const min = LOG_LEVEL_ORDER[q.minLevel];
      const allowed = (Object.keys(LOG_LEVEL_ORDER) as LogLevel[]).filter((l) => LOG_LEVEL_ORDER[l] >= min);
      where.push(`level IN (${allowed.map(() => '?').join(',')})`);
      params.push(...allowed);
    }
    if (q.instances?.length) {
      where.push(`instance IN (${q.instances.map(() => '?').join(',')})`);
      params.push(...q.instances);
    }
    if (q.surfaces?.length) {
      where.push(`surface IN (${q.surfaces.map(() => '?').join(',')})`);
      params.push(...q.surfaces);
    }
    if (q.categories?.length) {
      where.push(`(${q.categories.map(() => "category LIKE ? ESCAPE '\\'").join(' OR ')})`);
      params.push(...q.categories.map((c) => `${escapeLike(c)}%`));
    }
    if (q.exactCategories?.length) {
      where.push(`category IN (${q.exactCategories.map(() => '?').join(',')})`);
      params.push(...q.exactCategories);
    }
    if (q.events?.length) {
      where.push(`event IN (${q.events.map(() => '?').join(',')})`);
      params.push(...q.events);
    }
    if (q.grep) {
      const needle = `%${escapeLike(q.grep)}%`;
      where.push(`(event LIKE ? ESCAPE '\\' OR data LIKE ? ESCAPE '\\' OR category LIKE ? ESCAPE '\\')`);
      params.push(needle, needle, needle);
    }
    if (q.sessionId) { where.push('session_id = ?'); params.push(q.sessionId); }
    if (q.projectId !== undefined) {
      const sessionIds = [...new Set(q.projectSessionIds ?? [])];
      // An explicit project tag wins, even if the row's session belongs to another project.
      // Guard JSON extraction so malformed and absent payloads cannot match by accident.
      const tagged = "CASE WHEN json_valid(data) THEN json_extract(data, '$.projectId') ELSE NULL END";
      const session = "CASE WHEN json_valid(data) THEN json_extract(data, '$.sessionId') ELSE NULL END";
      const untagged = "CASE WHEN json_valid(data) THEN json_type(data, '$.projectId') IS NULL ELSE 1 END";
      where.push(`(${tagged} = ? OR (${untagged} AND (${sessionIds.length
        ? `session_id IN (${sessionIds.map(() => '?').join(',')}) OR ${session} IN (${sessionIds.map(() => '?').join(',')})`
        : '0'})))`);
      params.push(q.projectId, ...sessionIds, ...sessionIds);
    }
    if (q.sinceMs !== undefined) { where.push('ts_ms >= ?'); params.push(q.sinceMs); }
    if (q.untilMs !== undefined) { where.push('ts_ms <= ?'); params.push(q.untilMs); }
    if (q.afterId !== undefined) { where.push('id > ?'); params.push(q.afterId); }
    if (q.beforeId !== undefined) {
      // ⛔⭐ 커서는 **정렬 키와 같은 튜플**이어야 한다(2026-07-29 라이브 실측).
      //   초판은 `id < beforeId` 단독이었는데 정렬은 `ts_ms DESC, id DESC` 다. id 는 **삽입 순서**라
      //   ts(이벤트 시각) 와 어긋나므로(비동기 flush·배치 적재) 두 순서가 갈리는 지점에서
      //   **행이 조용히 유실**된다 — 같은 창 전수 70건 vs 페이징 60건(**14% 유실**).
      //   ⇒ `(ts_ms, id)` 복합 커서로 자른다. id 는 같은 밀리초의 tie-break 로만 쓴다.
      const anchor = this.db.query('SELECT ts_ms FROM logs WHERE id = ?').get(q.beforeId) as { ts_ms: number } | undefined;
      if (!anchor) {
        // ⛔ 없는 앵커로 조용히 한 쪽을 더 내주면 **부재와 미지가 같은 값**이 된다.
        throw new LogCursorNotFoundError(q.beforeId);
      }
      where.push('(ts_ms < ? OR (ts_ms = ? AND id < ?))');
      params.push(anchor.ts_ms, anchor.ts_ms, q.beforeId);
    }
    return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
  }

  /** 필터 조회 (LF1) — adb logcat 의 서버 반쪽. afterId 지정 시 증분
   *  오름차순(SSE tail 드레인용), 아니면 최근순 내림차순. */
  query(q: LogQuery = {}): LogStoreRow[] {
    const { clause, params } = this.buildWhere(q);
    const order = q.afterId !== undefined ? 'ORDER BY id ASC' : 'ORDER BY ts_ms DESC, id DESC';
    // ⛔⭐ 여기 상한은 **API 정책이 아니라 OOM 백스톱**이다(2026-07-29 재배치).
    //   초판은 1000 이었는데 그것은 HTTP 응답 보호 값이고, 스토어는 **CLI 로컬 직독**도 서빙한다.
    //   ⇒ HTTP 상한은 `log-fabric.ts` 로 옮겼고 여기는 **터무니없는 값만** 막는다.
    const limit = Math.min(Math.max(1, q.limit ?? 100), STORE_SAFETY_MAX);
    return this.db
      .query(`SELECT * FROM logs ${clause} ${order} LIMIT ?`)
      .all(...(params as never[]), limit) as LogStoreRow[];
  }

  /** 제한·페이지 커서 없이 필터 전체를 한 SQL 읽기로 반환한다. 로컬 관측 조인 전용이며 스키마나 색인을 바꾸지 않는다. */
  queryAll(q: Omit<LogQuery, 'limit' | 'afterId' | 'beforeId'> = {}): LogStoreRow[] {
    const { clause, params } = this.buildWhere(q);
    return this.db
      .query(`SELECT * FROM logs ${clause} ORDER BY ts_ms DESC, id DESC`)
      .all(...(params as never[])) as LogStoreRow[];
  }

  /** JSON payload의 정확한 runId/sessionId/correlationId 집합만 읽는 제한 조인용 API. 스키마·색인·행은 바꾸지 않는다. */
  queryByDataKeys(q: LogStoreDataKeyQuery): LogStoreRow[] {
    const runIds = [...new Set(q.runIds ?? [])];
    const sessionIds = [...new Set(q.sessionIds ?? [])];
    const correlationIds = [...new Set(q.correlationIds ?? [])];
    if (q.exactCategories.length === 0 || (runIds.length === 0 && sessionIds.length === 0 && correlationIds.length === 0)) return [];
    const keyClauses: string[] = [];
    const params: unknown[] = [...q.exactCategories];
    if (runIds.length > 0) {
      keyClauses.push(`json_extract(data, '$.runId') IN (${runIds.map(() => '?').join(',')})`);
      params.push(...runIds);
    }
    if (sessionIds.length > 0) {
      keyClauses.push(`json_extract(data, '$.sessionId') IN (${sessionIds.map(() => '?').join(',')})`);
      params.push(...sessionIds);
    }
    if (correlationIds.length > 0) {
      keyClauses.push(`json_extract(data, '$.correlationId') IN (${correlationIds.map(() => '?').join(',')})`);
      params.push(...correlationIds);
    }
    return this.db
      .query(`SELECT * FROM logs WHERE category IN (${q.exactCategories.map(() => '?').join(',')}) AND (${keyClauses.join(' OR ')}) ORDER BY ts_ms DESC, id DESC`)
      .all(...(params as never[])) as LogStoreRow[];
  }

  /** Run-chain 조인용 제한 배치 읽기: runId 행과 그 행이 가리키는 dispatch session 행만 읽는다. */
  queryRunChainRows(runIds: readonly string[]): LogStoreRunChainRows {
    const directRows = this.queryByDataKeys({
      exactCategories: ['dev-pipeline', 'self-implement', 'daemon-tools.self-implement'],
      runIds,
    });
    const sessionIds = directRows
      .filter((row) => row.category === 'dev-pipeline' && row.event === 'plan')
      .flatMap((row) => {
        try {
          const data = row.data ? JSON.parse(row.data) as Record<string, unknown> : null;
          return typeof data?.originSession === 'string' && data.originSession.length > 0 ? [data.originSession] : [];
        } catch { return []; }
      });
    const dispatchRows = this.queryByDataKeys({
      exactCategories: ['daemon-tools.self-implement'],
      sessionIds,
    });
    return { rows: [...directRows, ...dispatchRows], unreadableRunIds: [] };
  }

  /** 주어진 필터에 일치하는 전체 행 수. 조회 결과 상한과 무관한 read-only 관측용이다. */
  countMatching(q: Omit<LogQuery, 'limit'> = {}): number {
    const { clause, params } = this.buildWhere(q);
    return (this.db.query(`SELECT COUNT(*) AS count FROM logs ${clause}`).get(...(params as never[])) as { count: number }).count;
  }

  /** 시간창 안에 저장된 정확 카테고리 — read-side 분류/설명용이며 스키마·행을 바꾸지 않는다. */
  categories(q: Pick<LogQuery, 'sinceMs' | 'untilMs'> = {}): string[] {
    const where: string[] = [];
    const params: number[] = [];
    if (q.sinceMs !== undefined) { where.push('ts_ms >= ?'); params.push(q.sinceMs); }
    if (q.untilMs !== undefined) { where.push('ts_ms <= ?'); params.push(q.untilMs); }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    return this.db.query(`SELECT DISTINCT category FROM logs ${clause} ORDER BY category`).all(...params)
      .map((row) => (row as { category: string }).category);
  }

  /**
   * 필터 안에 저장된 정확 이벤트 이름 — 0건 안내용 read-side.
   * 소스를 훑지 않고 이미 찍힌 행만 모은다. 스키마·행을 바꾸지 않는다.
   * `events` 필터는 받지 않는다(그 축이 0건인 이유이므로 후보 수집에서 뺀다).
   */
  events(q: Omit<LogQuery, 'events' | 'limit' | 'afterId' | 'beforeId'> = {}): string[] {
    const { clause, params } = this.buildWhere(q);
    return this.db
      .query(`SELECT DISTINCT event FROM logs ${clause} ORDER BY event LIMIT 5000`)
      .all(...(params as never[]))
      .map((row) => (row as { event: string }).event);
  }

  /** 필터 칩 데이터 (LF4) — distinct surface + 상위 컴포넌트(카테고리 첫
   *  세그먼트) 카운트. 하드코딩 목록 금지 원칙(디버그 페인 백로그)의 데이터 해소. */
  facets(sinceMs?: number): {
    instances: Array<{ instance: string; count: number }>;
    surfaces: Array<{ surface: string; count: number }>;
    components: Array<{ component: string; count: number }>;
    levels: Array<{ level: string; count: number }>;
  } {
    const where = sinceMs !== undefined ? 'WHERE ts_ms >= ?' : '';
    const params = sinceMs !== undefined ? [sinceMs] : [];
    const instances = this.db
      .query(`SELECT instance, COUNT(*) AS count FROM logs ${where} GROUP BY instance ORDER BY count DESC`)
      .all(...(params as never[])) as Array<{ instance: string; count: number }>;
    const surfaces = this.db
      .query(`SELECT surface, COUNT(*) AS count FROM logs ${where} GROUP BY surface ORDER BY count DESC`)
      .all(...(params as never[])) as Array<{ surface: string; count: number }>;
    // 컴포넌트 = category 첫 세그먼트 — SQLite substr/instr 로 절단.
    const components = this.db
      .query(`SELECT CASE WHEN instr(category,'.')>0 THEN substr(category,1,instr(category,'.')-1) ELSE category END AS component,
              COUNT(*) AS count FROM logs ${where} GROUP BY component ORDER BY count DESC LIMIT 40`)
      .all(...(params as never[])) as Array<{ component: string; count: number }>;
    const levels = this.db
      .query(`SELECT level, COUNT(*) AS count FROM logs ${where} GROUP BY level ORDER BY count DESC`)
      .all(...(params as never[])) as Array<{ level: string; count: number }>;
    return { instances, surfaces, components, levels };
  }

  /** 분당 버킷 히스토그램 (LF4) — 총 count + error 이상 count. */
  histogram(opts: { sinceMs: number; bucketMs?: number } & Pick<LogQuery, 'surfaces' | 'minLevel'>): Array<{ bucket: number; count: number; errors: number }> {
    const bucketMs = Math.max(10_000, opts.bucketMs ?? 60_000);
    const where: string[] = ['ts_ms >= ?'];
    const params: unknown[] = [opts.sinceMs];
    if (opts.surfaces && opts.surfaces.length > 0) {
      where.push(`surface IN (${opts.surfaces.map(() => '?').join(',')})`);
      params.push(...opts.surfaces);
    }
    return this.db
      .query(`SELECT (ts_ms/${bucketMs})*${bucketMs} AS bucket,
              COUNT(*) AS count,
              SUM(CASE WHEN level IN ('error','critical') THEN 1 ELSE 0 END) AS errors
              FROM logs WHERE ${where.join(' AND ')} GROUP BY bucket ORDER BY bucket ASC`)
      .all(...(params as never[])) as Array<{ bucket: number; count: number; errors: number }>;
  }

  /** Aggregate all measured runs in the query window before applying a run-count bound. Read-only. */
  aggregateRuns(q: LogQuery, runLimit: number): Array<{ runId: string; parentRunId: string | null; firstTs: string; lastTs: string; rows: number }> {
    const { clause, params } = this.buildWhere(q);
    const valid = clause ? `${clause} AND json_valid(data)` : 'WHERE json_valid(data)';
    return this.db.query(`
      WITH measured AS (
        SELECT id, ts, ts_ms,
          COALESCE(NULLIF(json_extract(data, '$.runId'), ''), NULLIF(json_extract(data, '$.run_id'), '')) AS runId,
          NULLIF(json_extract(data, '$.parentRunId'), '') AS parentRunId
        FROM logs ${valid}
      ), ranked AS (
        SELECT runId, parentRunId, ts, ts_ms,
          ROW_NUMBER() OVER (PARTITION BY runId ORDER BY ts_ms ASC, id ASC) AS firstRow,
          ROW_NUMBER() OVER (PARTITION BY runId ORDER BY ts_ms DESC, id DESC) AS lastRow
        FROM measured WHERE typeof(runId) = 'text' AND runId <> ''
      )
      SELECT runId, MAX(parentRunId) AS parentRunId,
        MAX(CASE WHEN firstRow = 1 THEN ts END) AS firstTs,
        MAX(CASE WHEN lastRow = 1 THEN ts END) AS lastTs, COUNT(*) AS rows
      FROM ranked GROUP BY runId ORDER BY MAX(ts_ms) DESC LIMIT ?
    `).all(...(params as never[]), Math.min(Math.max(1, runLimit), STORE_SAFETY_MAX)) as Array<{
      runId: string; parentRunId: string | null; firstTs: string; lastTs: string; rows: number;
    }>;
  }

  /** Trace run lens filters before the bounded page, so old runs are not hidden by newer unrelated logs. */
  queryTraceRun(runId: string, q: LogQuery): LogStoreRow[] {
    const { clause, params } = this.buildWhere(q);
    const predicate = `CASE WHEN json_valid(data) THEN
      (json_extract(data, '$.runId') = ? OR json_extract(data, '$.run_id') = ?) ELSE 0 END`;
    const where = clause ? `${clause} AND (${predicate})` : `WHERE (${predicate})`;
    return this.db.query(`SELECT * FROM logs ${where} ORDER BY ts_ms DESC, id DESC LIMIT ?`)
      .all(...(params as never[]), runId, runId, Math.min(Math.max(1, q.limit ?? 100), STORE_SAFETY_MAX)) as LogStoreRow[];
  }

  /** Trace evidence resolves one local row ID without scanning a bounded recent page. */
  getById(id: number): LogStoreRow | null {
    return this.db.query('SELECT * FROM logs WHERE id = ?').get(id) as LogStoreRow | null;
  }

  /** 현재 최대 id — SSE 스트림의 시작 커서. 빈 스토어 = 0. */
  maxId(): number {
    const r = this.db.query('SELECT MAX(id) AS m FROM logs').get() as { m: number | null };
    return r.m ?? 0;
  }

  count(): number {
    return (this.db.query('SELECT COUNT(*) AS c FROM logs').get() as { c: number }).c;
  }

  close(): void {
    try { this.db.close(); } catch { /* noop */ }
  }
}

// ── 기본 스토어 싱글톤 ────────────────────────────────────────────────
//
// 테스트 격리: NODE_ENV=test 에서는 null — 유닛 테스트가 계측 지점을 밟아도
// 실 DB 를 오염시키지 않는다(ops-log recordOpsEventSafe 동형). 테스트는
// `new LogStore(':memory:')` 로 직접 검증.

let defaultStore: LogStore | null = null;
let defaultStoreUnavailableReported = false;

function reportDefaultStoreUnavailable(reason: 'disabled-for-test' | 'open-failed'): void {
  if (defaultStoreUnavailableReported || process.env.MSS_LOG_STORE_DIAGNOSTICS === '0') return;
  defaultStoreUnavailableReported = true;
  const detail = reason === 'disabled-for-test'
    ? 'disabled because NODE_ENV=test'
    : 'could not be opened; continuing without the log store';
  if (reason === 'disabled-for-test') {
    debug.log('mss.log-store', 'default log store unavailable', { detail });
    return;
  }
  try { process.stderr.write(`[mss] default log store unavailable: ${detail}\n`); } catch { /* diagnostics must not affect callers */ }
}

export function getDefaultLogStore(): LogStore | null {
  if (process.env.NODE_ENV === 'test') {
    reportDefaultStoreUnavailable('disabled-for-test');
    return null;
  }
  if (defaultStore) return defaultStore;
  try {
    defaultStore = new LogStore();
    return defaultStore;
  } catch {
    reportDefaultStoreUnavailable('open-failed');
    return null; // 디스크 불가 등 — 파일 트레일은 살아있으므로 포기
  }
}

export function _resetDefaultLogStoreForTest(): void {
  try { defaultStore?.close(); } catch { /* noop */ }
  defaultStore = null;
  defaultStoreUnavailableReported = false;
  pendingBusyOpenLosses = [];
}

// ── StoreSink — debug.registerSink() 로 꽂히는 배치 싱크 ─────────────────

export interface StoreSinkOpts {
  /** flush 주기(ms). 기본 200 — FileSink(100ms)보다 느슨(조회면은 sub-초면 충분). */
  flushIntervalMs?: number;
  /** 건수 임계 — 초과 시 setImmediate 로 detach flush(핫 틱 비블록). 기본 64. */
  flushBatchSize?: number;
  /** 버퍼 하드캡 — flush 실패 누적 시 오래된 것부터 드롭(메모리 가드). 기본 2048. */
  bufferCap?: number;
  /** Register beforeExit / SIGINT / SIGTERM flush hooks lazily on first
   *  emit. Default true; tests/isolated fixtures can pass false. */
  installExitHandlers?: boolean;
}

/** StoreSink가 버린 레코드의 누적 관측값. 스토어에 쓰지 않아 자기참조하지 않는다. */
export interface StoreSinkDropCounts {
  total: number;
  flushFailure: number;
  bufferCap: number;
}

export class StoreSink implements LogSink {
  readonly name = 'store';
  private buf: Array<{ rec: LogRecord; surface: string }> = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private exitHandlersInstalled = false;
  private onBeforeExit: (() => void) | null = null;
  private onSigInt: (() => void) | null = null;
  private onSigTerm: (() => void) | null = null;
  private readonly flushIntervalMs: number;
  private readonly flushBatchSize: number;
  private readonly bufferCap: number;
  private readonly installExit: boolean;
  private readonly dropCounts: StoreSinkDropCounts = { total: 0, flushFailure: 0, bufferCap: 0 };

  constructor(
    private readonly store: LogStore,
    private readonly surface: string,
    opts: StoreSinkOpts = {},
  ) {
    this.flushIntervalMs = opts.flushIntervalMs ?? 200;
    this.flushBatchSize = opts.flushBatchSize ?? 64;
    this.bufferCap = opts.bufferCap ?? 2048;
    this.installExit = opts.installExitHandlers ?? true;
  }

  emit(rec: LogRecord): void {
    // 자기참조 가드 — 로그 평면 자신의 이벤트는 스토어 재진입 금지.
    if (rec.category.startsWith('logs.')) return;
    this.buf.push({ rec, surface: this.surface });
    if (this.buf.length > this.bufferCap) {
      const dropped = this.buf.length - this.bufferCap;
      this.buf.splice(0, dropped);
      this.recordDrop('bufferCap', dropped);
    }
    if (this.installExit) this.installExitHandlersOnce();
    if (this.buf.length >= this.flushBatchSize) {
      // 핫 틱 비블록 — insert 는 다음 매크로태스크로(FileSink detach 동형).
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      setImmediate(() => this.flush());
      return;
    }
    if (this.timer === null) {
      this.timer = setTimeout(() => this.flush(), this.flushIntervalMs);
      (this.timer as unknown as { unref?: () => void }).unref?.();
    }
  }

  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.buf.length === 0) return;
    const batch = this.buf;
    this.buf = [];
    try {
      this.store.insertBatch(batch);
    } catch {
      /* fail-soft — 파일 트레일이 진실원. 배치는 버린다(재시도 루프 금지 —
         디스크 장애 시 무한 적체 방지). */
      this.recordDrop('flushFailure', batch.length);
    }
  }

  /** 누적 유실 관측값의 복사본. 로그 스토어에 쓰지 않아 자기참조하지 않는다. */
  get dropped(): StoreSinkDropCounts { return { ...this.dropCounts }; }

  get pending(): number { return this.buf.length; }

  /** Flush the buffer and drop only this sink's exit/signal listeners. */
  close(): void {
    this.flush();
    this.removeExitHandlers();
  }

  private recordDrop(reason: Exclude<keyof StoreSinkDropCounts, 'total'>, count: number): void {
    this.dropCounts.total += count;
    this.dropCounts[reason] += count;
  }

  private installExitHandlersOnce(): void {
    if (this.exitHandlersInstalled) return;
    this.exitHandlersInstalled = true;
    const onExit = (): void => { this.flush(); };
    this.onBeforeExit = onExit;
    process.once('beforeExit', onExit);
    // Remove only this sink's listener. Re-raise only when nobody else is
    // listening so the default terminate action is restored; remaining
    // handlers already run in the current dispatch (re-raising would run
    // them a second time). `removeAllListeners` would wipe them.
    const install = (signal: 'SIGINT' | 'SIGTERM'): void => {
      const onSig = (): void => {
        onExit();
        process.removeListener(signal, onSig);
        if (signal === 'SIGINT') this.onSigInt = null;
        else this.onSigTerm = null;
        if (process.listenerCount(signal) === 0) {
          process.kill(process.pid, signal);
        }
      };
      if (signal === 'SIGINT') this.onSigInt = onSig;
      else this.onSigTerm = onSig;
      process.on(signal, onSig);
    };
    install('SIGINT');
    install('SIGTERM');
  }

  private removeExitHandlers(): void {
    if (this.onBeforeExit) {
      process.removeListener('beforeExit', this.onBeforeExit);
      this.onBeforeExit = null;
    }
    if (this.onSigInt) {
      process.removeListener('SIGINT', this.onSigInt);
      this.onSigInt = null;
    }
    if (this.onSigTerm) {
      process.removeListener('SIGTERM', this.onSigTerm);
      this.onSigTerm = null;
    }
    this.exitHandlersInstalled = false;
  }
}

/** 부팅 1줄 등록 헬퍼 — 데몬/TUI/러너가 자기 surface 를 선언하고 스토어
 *  싱크를 단다. retention 은 호출측이 config 에서 읽어 전달(user-config
 *  순환 의존 회피). 반환 = unregister(테스트용) 또는 null(store 불가). */
export function registerLogStoreSink(
  registerSink: (sink: LogSink) => () => void,
  surface: string,
  retention: LogStoreRetention = LOG_RETENTION_DEFAULTS,
): (() => void) | null {
  const store = getDefaultLogStore();
  if (!store) return null;
  const sink = new StoreSink(store, surface, { installExitHandlers: true });
  const off = registerSink(sink);
  try { nestDepth.observeNestAtBoot(); } catch { /* fail-soft — 관측 실패가 싱크 등록을 막지 않는다. */ }
  // 보존정책 — 부팅 직후 1회(디퍼) + 6시간 주기. 실패는 조용히.
  const runRetention = (): void => {
    try { store.enforceRetention(retention); } catch { /* fail-soft */ }
  };
  setImmediate(runRetention);
  const h = setInterval(runRetention, 6 * 3600 * 1000);
  (h as unknown as { unref?: () => void }).unref?.();
  return () => {
    clearInterval(h);
    sink.close();
    off();
  };
}
