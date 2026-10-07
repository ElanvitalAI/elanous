// ── 스케줄 레지스트리 (2026-07-07 · S0) ────────────────────────────────
//
// 대표 지시: elanous가 자기 예약(크론)을 알아야 한다. 27개 crontab 잡이 실제
// 스케줄링을 전담하는데 elanous는 프로그램적으로 인지하지 못함(= "그림자
// 스케줄러"). 이는 메모리 갭과 대칭(prospective memory) — 스케줄러도 기억의
// 한 부류. 메모리 트랙 surface_events.db와 peer 구조(더블트랙).
//
// S0 = crontab을 레지스트리에 인벤토리(읽기). 실행 엔진 신설 안 함(레거시
// 스케줄러 2026-05-11 은퇴 교훈) — crontab/workflow-runtime가 실행 담당,
// 여기는 인지·관리 레이어. 상세 = 내부 문서 `PLAN-scheduler-registry-2026-07-07`.

import { Database } from 'bun:sqlite';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { prevScheduledFire } from './cron-match.js';
import { debug } from '../debug/log.js';
import { listSources } from '../intake-plane/intake-sources.js';
import { getUserConfig } from '../user-config.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { deriveScheduleName, ensureScheduleRunsSchema, recordScheduleRun } from './schedule-runs.js';

/** 스케줄 레지스트리 DB 정본 경로 — state-dir 존중(lazy · Phase B). prod(ELANOUS_STATE_DIR
 *  미설정)=`~/.elanous/schedules.db`(무변경) · 격리 test 인스턴스=자기 루트(빈 시작). 종전
 *  homedir 하드코딩은 test 데몬의 미션 materialize/cancel 이 prod 크론을 건드리던 근본. */
export function schedulesDbPath(): string {
  return join(elanousStateRoot(), 'schedules.db');
}

/** 도메인 무관 카테고리 (§타입 일반화 — Conatus 전용 탈피). */
export type ScheduleCategory = 'ingest' | 'monitor' | 'report' | 'alert' | 'digest' | 'qna' | 'maintenance';

export interface ScheduleRow {
  id: string;              // 안정 해시(raw 라인) — 재인벤토리 멱등
  name: string;            // 사람용(스크립트 basename)
  source: string;          // crontab | workflow-runtime | discovery | ...
  cron: string | null;     // cron 식
  interval_ms: number | null;
  command: string | null;
  category: ScheduleCategory;
  domain: string | null;   // finance | <future>
  enabled: number;
  disabled_reason?: string | null; // vanished (inventory) | manual (explicit off) | null
  last_seen: string | null;
  last_run: string | null;
  note: string | null;
  managed_by: string;      // elanous | manual
  raw: string | null;      // 원본 crontab 라인(inspect용)
  /** 실행 주체(S2): crontab(시스템 cron 발화) | elanous(데몬 러너 발화). */
  run_via: string;
  // ── 실행 결과 추적(P1 관측성) — markResult 가 갱신 ──
  last_status?: string | null;      // ok | error
  last_exit?: number | null;        // exit code
  last_duration_ms?: number | null; // 소요(ms)
  last_via?: string | null;         // tick | catchup | manual
  last_error?: string | null;       // 에러 요약
  // ── 오토파일럿 계보(AL2) ──
  autopilot_id?: string | null;     // 이 크론을 만든 미션(apm_id)
}

export function openSchedulesDb(path: string = schedulesDbPath()): Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.run('PRAGMA busy_timeout = 2000');
  const schemaObjects = db.prepare(`SELECT name FROM sqlite_master WHERE name IN ('schedule_registry', 'idx_sched_cat', 'schedule_runs', 'idx_schedule_runs_schedule_fired')`).all() as Array<{ name: string }>;
  const schemaNames = new Set(schemaObjects.map(({ name }) => name));
  if (!schemaNames.has('schedule_registry')) {
    db.run(`CREATE TABLE IF NOT EXISTS schedule_registry(
      id TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL,
      cron TEXT, interval_ms INT, command TEXT,
      category TEXT NOT NULL, domain TEXT,
      enabled INT DEFAULT 1, disabled_reason TEXT, last_seen TEXT, last_run TEXT,
      note TEXT, managed_by TEXT DEFAULT 'manual', raw TEXT,
      run_via TEXT DEFAULT 'crontab',
      last_status TEXT, last_exit INT, last_duration_ms INT,
      last_via TEXT, last_error TEXT
    )`);
  }
  if (!schemaNames.has('idx_sched_cat')) db.run(`CREATE INDEX IF NOT EXISTS idx_sched_cat ON schedule_registry(category)`);
  // 마이그레이션 — 기존 DB에 없는 컬럼 추가(S2 run_via + 실행관측성 P1).
  const cols = (db.prepare(`PRAGMA table_info(schedule_registry)`).all() as Array<{ name: string }>).map(c => c.name);
  if (!cols.includes('run_via')) db.run(`ALTER TABLE schedule_registry ADD COLUMN run_via TEXT DEFAULT 'crontab'`);
  if (!cols.includes('disabled_reason')) db.run(`ALTER TABLE schedule_registry ADD COLUMN disabled_reason TEXT`);
  // 실행 결과 추적(P1) — "발화만 기록"에서 "성공/실패·소요·경로까지" 확장.
  if (!cols.includes('last_status')) db.run(`ALTER TABLE schedule_registry ADD COLUMN last_status TEXT`);
  if (!cols.includes('last_exit')) db.run(`ALTER TABLE schedule_registry ADD COLUMN last_exit INT`);
  if (!cols.includes('last_duration_ms')) db.run(`ALTER TABLE schedule_registry ADD COLUMN last_duration_ms INT`);
  if (!cols.includes('last_via')) db.run(`ALTER TABLE schedule_registry ADD COLUMN last_via TEXT`);
  if (!cols.includes('last_error')) db.run(`ALTER TABLE schedule_registry ADD COLUMN last_error TEXT`);
  // 오토파일럿 계보(AL2) — 이 크론을 만든 미션(apm_id). null=오토파일럿 산물 아님.
  if (!cols.includes('autopilot_id')) db.run(`ALTER TABLE schedule_registry ADD COLUMN autopilot_id TEXT`);
  // 다시 열 때는 DDL 을 안 돌린다(기존 규칙) — 이력 표·색인이 이미 있으면 건너뛴다.
  if (!schemaNames.has('schedule_runs') || !schemaNames.has('idx_schedule_runs_schedule_fired')) ensureScheduleRunsSchema(db);
  return db;
}

/** 잡 실행 주체 전환(adopt=elanous / release=crontab). */
export function setRunVia(db: Database, id: string, runVia: 'crontab' | 'elanous' | 'trigger'): void {
  db.run(`UPDATE schedule_registry SET run_via = ? WHERE id = ?`, [runVia, id]);
}

/** elanous 데몬이 실행 책임을 지는 run_via — schedule-runner('elanous')·workflow
 *  Schedule Trigger('trigger'·Mission Fabric 통합 U3). crontab/daemon 은 제외.
 *  헬스 추적·이중발화 판정의 단일 술어. */
export function isElanousManagedRunVia(runVia: string): boolean {
  return runVia === 'elanous' || runVia === 'trigger';
}

/** 사람용 설명(note) 설정 — "이게 무슨 스케줄인지". inventory 파생값이 아니라
 *  사용자 설정이므로 crontab 재스캔 시 보존(inventoryCrontab 의 ON CONFLICT 가
 *  note 를 안 건드림). PWA/CLI/tool 공용 창구는 dispatchScheduleManage(action=note). */
export function setNote(db: Database, id: string, note: string): void {
  db.run(`UPDATE schedule_registry SET note = ? WHERE id = ?`, [note, id]);
}

/** 오토파일럿 계보 연결(AL2) — 이 크론을 만든 미션(apm_id) 스탬프. inventoryCrontab
 *  ON CONFLICT 가 autopilot_id 를 안 건드리므로 재스캔에도 보존(note 와 동일 정책). */
export function setScheduleMission(db: Database, id: string, autopilotId: string): void {
  db.run(`UPDATE schedule_registry SET autopilot_id = ? WHERE id = ?`, [autopilotId, id]);
}

/** registry 에서 잡 제거 — crontab delete 정합용. inventoryCrontab 은 스캔 upsert 만 하므로
 *  (DELETE 없음·스캔미러), crontab 에서 지운 잡을 내부 기억에서도 명시 제거해야 정합. */
export function deleteScheduleRow(db: Database, id: string): void {
  db.run(`DELETE FROM schedule_registry WHERE id = ?`, [id]);
}

/** 발화 기록 — 러너가 잡 실행 시 last_run 갱신(S3 메모리 루프). */
export function markRun(db: Database, id: string, now = new Date().toISOString()): void {
  db.run(`UPDATE schedule_registry SET last_run = ? WHERE id = ?`, [now, id]);
}

/** 실행 결과 기록(P1 실행관측성) — 발화 시각 + 성공/실패·exit·소요·경로·에러.
 *  markRun 상위호환: 발화만이 아니라 "어떻게 끝났나"까지 남겨 미실행/실패를
 *  가시화. via='tick'(node-cron 정시) | 'catchup'(놓침 자기회복) | 'manual'. */
export interface RunResult {
  at?: string;                     // 발화 시각(ISO) — 미지정 시 now
  status: 'ok' | 'error';          // exit 0 = ok, 그 외 error
  exit?: number | null;            // 프로세스 exit code
  durationMs?: number | null;      // 소요(ms)
  via?: string;                    // tick | catchup | manual
  error?: string | null;           // 에러 요약(있으면)
  runId?: string | null;           // 외부 실행과의 상관관계
}
/** 직전 실행 상태 조회(자기기억 이상 온셋 dedup 용·데몬 경로). 없으면 null. */
export function getLastStatus(db: Database, id: string): string | null {
  const row = db.query(`SELECT last_status FROM schedule_registry WHERE id = ?`).get(id) as { last_status?: string | null } | undefined;
  return row?.last_status ?? null;
}

export function markResult(db: Database, id: string, r: RunResult): void {
  const at = r.at ?? new Date().toISOString();
  const via = r.via ?? 'tick';
  db.run(
    `UPDATE schedule_registry SET last_run=?, last_status=?, last_exit=?,
       last_duration_ms=?, last_via=?, last_error=? WHERE id=?`,
    [at, r.status, r.exit ?? null,
     r.durationMs ?? null, via, r.error ?? null, id],
  );
  const row = db.query(`SELECT name FROM schedule_registry WHERE id = ?`).get(id) as { name: string } | null;
  if (!row) return;
  try {
    recordScheduleRun(db, id, {
      at, status: r.status, exit: r.exit ?? null,
      durationMs: r.durationMs ?? null, via, runId: r.runId ?? process.env.ELANOUS_RUN_ID ?? null,
    });
  } catch (error) {
    debug.log('schedule.registry', 'run-history-write-failed', { id, error: String(error) });
  }
}

// ── 스케줄 헬스(P2 관측성) — "무엇이 밀렸나/실패했나" 순수 판정 ──────────
// stale = elanous 발화 잡인데 '직전 예정 시각'이 지났음에도 그 이후 실행 기록이
// 없음(= 유실). catch-up sweep 이 정상 동작하면 stale 은 곧 해소되므로, 남아
// 있는 stale 은 진짜 문제(catch-up 제외된 매매류·grace 초과·러너 정지 등).

export interface JobHealth {
  id: string; name: string; cron: string;
  lastRun: string | null; lastStatus: string | null;
  overdueMs: number;            // 직전 예정 이후 경과(ms)
}
export interface ScheduleHealth {
  elanousTotal: number;                 // 결과를 남길 수 있는 헬스 대상 잡 수
  excludedRunVia: number;             // 관리 실행 방식 대상 밖이라 제외된 잡 수
  excludedUnwrappedCrontab: number;   // 관측 래퍼 없는 crontab 잡이라 제외된 수
  excludedDisabled: number;           // 비활성화되어 제외된 잡 수
  excludedMissingCron: number;  // cron 식 부재로 제외된 잡 수
  errored: JobHealth[];         // 마지막 실행이 error
  stale: JobHealth[];           // 예정 지났는데 미실행(유실)
  noncanonical: JobHealth[];    // 등록 raw가 buildCronLine 정규형과 다름
  unmeasured: JobHealth[];      // repo/bun 부재로 정규형을 비교하지 못함
  generatedAt: string;
}

function isCronRunWrappedCommand(command: string | null): boolean {
  return /(?:^|(?:&&|\|\||;)\s*)(?:\S*\/)?bun\s+(?:\S*\/)?cron-run\.ts(?:\s|$)/.test(command ?? '');
}

/** rows 에서 스케줄 헬스 판정(순수). staleWindowMs=직전 예정 탐색 상한(기본 26h). */
export function scheduleHealth(
  rows: ScheduleRow[],
  opts: { now?: Date; staleWindowMs?: number; repo?: string; bun?: string; alsoCanonicalRepos?: readonly string[] } = {},
): ScheduleHealth {
  const now = opts.now ?? new Date();
  const staleWindowMs = opts.staleWindowMs ?? 26 * 3600_000;
  const errored: JobHealth[] = [];
  const stale: JobHealth[] = [];
  const noncanonical: JobHealth[] = [];
  const unmeasured: JobHealth[] = [];
  const canMeasureCanonicality = opts.repo !== undefined && opts.bun !== undefined;
  let elanousTotal = 0;
  let excludedRunVia = 0;
  let excludedUnwrappedCrontab = 0;
  let excludedDisabled = 0;
  let excludedMissingCron = 0;
  for (const r of rows) {
    // U3(Mission Fabric): 'trigger'(workflow Schedule Trigger 이관잡)도 elanous
    // 관리 실행이므로 헬스 추적(발화는 데몬, 결과는 브릿지가 markResult via='trigger').
    const wrappedCrontab = r.run_via === 'crontab' && isCronRunWrappedCommand(r.command);
    if (!isElanousManagedRunVia(r.run_via) && !wrappedCrontab) {
      if (r.run_via === 'crontab') excludedUnwrappedCrontab++;
      else excludedRunVia++;
      continue;
    }
    if (!r.enabled) {
      excludedDisabled++;
      continue;
    }
    if (!r.cron) {
      excludedMissingCron++;
      continue;
    }
    elanousTotal++;
    const cron = r.cron;
    const healthJob = { id: r.id, name: r.name, cron: r.cron, lastRun: r.last_run ?? null,
      lastStatus: r.last_status ?? null, overdueMs: 0 };
    if (!canMeasureCanonicality || !r.command || !r.raw) {
      unmeasured.push(healthJob);
    } else if (![opts.repo, ...(opts.alsoCanonicalRepos ?? [])].some((repo) => r.raw === buildCronLine(cron, r.command!, { repo, bun: opts.bun }))) {
      noncanonical.push(healthJob);
    }
    const prev = prevScheduledFire(r.cron, now, staleWindowMs);
    const lr = r.last_run ? Date.parse(r.last_run) : NaN;
    if (prev && (!Number.isFinite(lr) || lr < prev.getTime())) {
      stale.push({ ...healthJob, overdueMs: now.getTime() - prev.getTime() });
    }
    if (r.last_status === 'error') {
      errored.push({ ...healthJob, lastStatus: 'error' });
    }
  }
  return {
    elanousTotal, excludedRunVia, excludedUnwrappedCrontab, excludedDisabled, excludedMissingCron,
    errored, stale, noncanonical, unmeasured, generatedAt: now.toISOString(),
  };
}

// ── crontab 파싱 ──

/** cron 5필드(min hour dom mon dow) + 나머지=command 분리. 주석/빈줄 → null. */
export function parseCronLine(line: string): { cron: string; command: string } | null {
  const t = line.trim();
  if (!t || t.startsWith('#')) return null;
  const parts = t.split(/\s+/);
  if (parts.length < 6) return null;            // 최소 5필드 + 커맨드
  const cron = parts.slice(0, 5).join(' ');
  const command = parts.slice(5).join(' ');
  // cron 필드 검증(숫자/*/,-/ 만) — env 지정줄(FOO=bar) 등 배제
  if (!/^[\d*,\-/]+$/.test(parts[0]!)) return null;
  return { cron, command };
}

/** 순수: 주석 처리된(=사람이 꺼둔) cron 줄 파싱. `# <cron 5필드> <command>` 를 한 겹 벗긴다.
 *  ⛔ 활성 줄·설명 주석(`# 조율 채널 감시`)은 null — cron 5필드 검증을 parseCronLine 이 그대로 한다.
 *  ⭐ 왜 필요한가: 꺼둔 잡은 「사라진 것」이 아니라 「있는데 꺼진 것」이고, 이 갈래가 없으면
 *    레지스트리의 enabled 를 «내리는 경로»가 아예 없다(2026-08-19 실측: 꺼둔 잡 셋이 목록에
 *    enabled=1 로 남아 「도는 중」으로 보였다). */
export function parseDisabledCronLine(line: string): { cron: string; command: string } | null {
  const t = line.trim();
  if (!t.startsWith('#')) return null;
  return parseCronLine(t.replace(/^#+\s*/, ''));
}

/** 순수: crontab 항목의 content-hash id(cron+실효 command). 활성 줄과 그 줄을 주석 처리한 줄이
 *  «같은 id» 를 갖는다 — 그래서 켜고 끄는 동안 이력(last_run·note·계보)이 이어진다. */
export function cronEntryId(cron: string, effectiveCommand: string): string {
  return createHash('sha1').update(cron + '|' + effectiveCommand).digest('hex').slice(0, 12);
}

/** ★ 관측성 래퍼 unwrap (RFC-scheduler-execution-observability·2026-07-15) — crontab 라인이
 *  `bun scripts/cron-run.ts --schedule-id <id> scripts/X.ts --a` 로 래핑돼도 id/name 파생은 안쪽 실제 target 기준으로.
 *  래퍼와 그 id 인자만 제거 → 래핑 전 원본과 동일 문자열 → id(sha1) 불변·마이그레이션 0.
 *  순수·멱등(비래핑 라인은 그대로 반환). */
export function unwrapCronCommand(command: string): string {
  const shell = command.replace(/(?:\S*\/)?bun\s+(?:\S*\/)?cron-run\.ts\s+(?:--schedule-id\s+\S+\s+)?--shell\s+/, '');
  if (shell !== command) return shell;
  return command.replace(/(?:[^\s]*\/)?cron-run\.ts\s+(?:--schedule-id\s+\S+\s+)?/, '');
}

/** crontab 라인을 관측성 래퍼로 감싼다(P3) — `bun scripts/X.ts` → `bun scripts/cron-run.ts --schedule-id <id> scripts/X.ts`.
 *  bun .ts 잡만(.sh 는 bun 미실행·skip). 이미 래핑됐거나 cron-run 자신이면 그대로. 순수·멱등. */
export function wrapCronLine(line: string): string {
  if (/cron-run\.ts/.test(line)) return line;                 // 이미 래핑
  const parsed = parseCronLine(line);
  if (!parsed) return line;
  const id = cronEntryId(parsed.cron, parsed.command);
  // bun 직후의 target(상대 scripts/X.ts 또는 절대 .../scripts/X.ts) 앞에 래퍼 삽입. cron-run 자신 제외.
  return line.replace(/(\bbun\s+)(\S*scripts\/(?!cron-run\b)[\w.-]+\.ts)/, (_match, bun: string, target: string) =>
    `${bun}scripts/cron-run.ts --schedule-id ${id} ${target}`);
}

/** 셸 해석기가 명시된 .sh 발화만 래핑한다. 원래 해석기 토큰과 인자를 그대로 보존한다. */
export function wrapShellCronLine(line: string, opts: { bun: string; cronRun: string }): string {
  if (/cron-run\.ts/.test(line)) return line;
  const parsed = parseCronLine(line);
  if (!parsed) return line;
  const id = cronEntryId(parsed.cron, parsed.command);
  return line.replace(/^(\s*\S+(?:\s+\S+){4}\s+(?:cd\s+\S+\s+&&\s+)?)((?:\S*\/)?(?:bash|zsh|sh))(?=\s+\S+\.sh(?:\s|$))/, (_match, prefix: string, interpreter: string) =>
    `${prefix}${opts.bun} ${opts.cronRun} --schedule-id ${id} --shell ${interpreter}`);
}

/** wrapCronLine / wrapShellCronLine 역 — 래퍼와 id 인자 제거(가역). 비래핑 라인은 그대로. */
export function unwrapCronLine(line: string): string {
  const shell = line.replace(/(?:\S*\/)?bun\s+(?:\S*\/)?cron-run\.ts\s+(?:--schedule-id\s+\S+\s+)?--shell\s+/, '');
  if (shell !== line) return shell;
  return line.replace(/(\bbun\s+)(?:\S*\/)?cron-run\.ts\s+(?:--schedule-id\s+\S+\s+)?/, '$1');
}

/** ★ 삭제 안전 가드(2026-07-15) — 대상 행의 crontab 라인(raw)을 다른 활성 행이 공유하나? 순수.
 *  공유하면 그 라인을 지우면 안 됨(팬텀/중복 삭제가 실잡 라인을 깨는 사고 방지). raw 빈값=false. */
export function sharesCrontabLine(rows: readonly { id: string; raw?: string | null }[], targetId: string, raw: string | null | undefined): boolean {
  const t = (raw ?? '').trim();
  return !!t && rows.some(r => r.id !== targetId && (r.raw ?? '').trim() === t);
}

/** 스크립트 basename 추출 (scripts/foo.ts|sh → foo). 없으면 커맨드 첫 토큰. 래퍼는 unwrap 후 파생. */
export function scriptName(command: string): string {
  const c = unwrapCronCommand(command);
  const noCd = c.replace(/^cd\s+\S+\s*&&\s*/, '');
  const shellTarget = noCd.match(/^(?:\S*\/)?(?:bash|zsh|sh)\s+(\S+\.sh)(?=\s|$)/);
  if (shellTarget) return shellTarget[1]!.split('/').pop()!.replace(/\.sh$/, '');
  const m = c.match(/scripts\/([\w.-]+?)\.(?:ts|sh|mjs|js)\b/);
  if (m) return m[1]!;
  const tokens = noCd.split(/\s+/);
  // bun/node 런처면 다음 토큰(실 스크립트)을 이름 원천으로 — `bun bin/elanous.mjs` → elanous.mjs(bun 아님).
  let head = tokens[0] ?? c;
  if (/(^|\/)(bun|node)$/.test(head) && tokens[1]) head = tokens[1];
  return head.split('/').pop() ?? c;
}

/** 커맨드 → 도메인무관 카테고리 추론(best-effort · 편집 가능). 순서 유의
 *  (digest가 monitor보다 먼저 — breaking-digest vs x-breaking). */
export function inferCategory(command: string): ScheduleCategory {
  const c = command.toLowerCase();
  if (/ingest|collect-|backfill|kr-investor|13f/.test(c)) return 'ingest';
  if (/digest/.test(c)) return 'digest';
  if (/monitor|breaking|watch|dart-disclosure/.test(c)) return 'monitor';
  if (/report|pulse|weekly-alpha|attractiveness|morning|dig-runner/.test(c)) return 'report';
  if (/alert|reentry|capstone/.test(c)) return 'alert';
  if (/flush|snapshot|prune|cleanup/.test(c)) return 'maintenance';
  return 'maintenance';
}

/** 현재 crontab 원문 반환(없으면 ''). */
export function readCrontab(): string {
  // ⛔ stderr 를 물려받지 않는다 — 크론이 없는 기계에서 「no crontab for <user>」가 TUI 화면 한가운데 찍혔다
  //   (2026-09-26 베어 Ubuntu 26.04 실측 · UX 17). 크론 없음은 정상이라 빈 문자열이다.
  // env 명시 — bun 은 env 없이 부르면 «기동 시» PATH 로 찾는다(시험이 PATH 앞에 둔 가짜 crontab 을 지나쳐 실물을 연다).
  try { return execFileSync('crontab', ['-l'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], env: process.env }); }
  catch { return ''; } // no crontab for user
}

/** crontab → 레지스트리 upsert. 사용자 설정(note·domain override·managed_by)은
 *  보존, 인벤토리 파생값(cron·command·category·last_seen)만 갱신. 신규 건수 반환.
 *  vanished = 이번 본문에 활성/주석으로 안 나온 crontab-origin 행을 끈 수(행은 삭제하지 않음). */
export function inventoryCrontab(db: Database, opts: { crontab?: string; now?: string } = {}): { total: number; added: number; disabled: number; vanished: number } {
  const text = opts.crontab ?? readCrontab();
  const now = opts.now ?? new Date().toISOString();
  const existing = new Map((db.prepare(`SELECT id, name, command, source, run_via FROM schedule_registry`).all() as Array<{
    id: string; name: string; command: string | null; source: string; run_via: string;
  }>).map(r => [r.id, r]));
  let total = 0, added = 0, disabled = 0, vanished = 0;
  const seenIds = new Set<string>();
  for (const line of text.split('\n')) {
    const parsed = parseCronLine(line);
    if (!parsed) {
      // ⭐⭐ 주석 처리된(=사람이 꺼둔) 잡 — 「사라진 것」이 아니라 「있는데 꺼진 것」이다.
      //   ⛔ 종전엔 이 갈래가 없어 enabled 를 «내리는 경로»가 존재하지 않았다: upsert 는 항상
      //     enabled=1 로 덮고, 주석 줄은 parseCronLine 이 null 을 내 아예 안 봤다.
      //     ⇒ 사람이 crontab 에서 꺼도 레지스트리는 영영 enabled=1 (2026-08-19 실측: 셋).
      //   ⛔ 새로 «추가»하지는 않는다 — prune 하지 않는 계약(아래 reindexCrontabEntry 주석)의 대칭.
      //     등록된 적 없는 주석 잡까지 만들면 목록이 「돌지도 않는 것」으로 불어난다.
      const off = parseDisabledCronLine(line);
      if (!off) continue;
      const offId = cronEntryId(off.cron, unwrapCronCommand(off.command));
      if (existing.get(offId)?.source !== 'crontab' || existing.get(offId)?.run_via === 'trigger') continue;
      seenIds.add(offId);
      db.run(`UPDATE schedule_registry SET enabled = 0, disabled_reason = 'manual', last_seen = ? WHERE id = ?`, [now, offId]);
      disabled++;
      continue;
    }
    total++;
    // ★ unwrap-aware 파생(RFC 2026-07-15) — 관측성 래퍼로 감싸도 id/name/category 는 안쪽 target 기준
    //   → 래핑 전후 id(sha1) 동일·last_run/계보/adopt 승계·마이그레이션 0. command/raw 는 실제 라인 보존.
    const eff = unwrapCronCommand(parsed.command);
    const id = cronEntryId(parsed.cron, eff);
    const prior = existing.get(id);
    const name = prior && prior.command === parsed.command ? prior.name : deriveScheduleName(eff);
    const category = inferCategory(eff);
    seenIds.add(id);
    // A lingering crontab line after migration is not a request to override the
    // trigger's state (including an explicit disable). Keep the migrated row intact.
    if (prior?.run_via === 'trigger') continue;
    if (!prior) added++;
    db.run(
      `INSERT INTO schedule_registry (id, name, source, cron, command, category, domain, enabled, last_seen, managed_by, raw)
       VALUES (?, ?, 'crontab', ?, ?, ?, 'finance', 1, ?, 'manual', ?)
       ON CONFLICT(id) DO UPDATE SET
         name=excluded.name, cron=excluded.cron, command=excluded.command,
         category=excluded.category, enabled=1, disabled_reason=NULL, last_seen=excluded.last_seen, raw=excluded.raw`,
      [id, name, parsed.cron, parsed.command, category, now, line.trim()],
    );
  }
  // Only repair rows with recorded inventory provenance. Legacy disabled rows have
  // no disable reason; last_via='trigger' alone cannot distinguish manual disable.
  const repair = db.prepare(`SELECT id FROM schedule_registry WHERE source = 'crontab'
    AND run_via = 'trigger' AND enabled = 0 AND last_via = 'trigger'
    AND disabled_reason = 'vanished'`).all() as Array<{ id: string }>;
  for (const { id } of repair) {
    db.run(`UPDATE schedule_registry SET source = 'trigger', enabled = 1, disabled_reason = NULL WHERE id = ?`, [id]);
    debug.log('schedule.registry', 'trigger-row-repaired', { id });
  }
  // ⭐ 줄이 통째로 지워진 crontab-origin 행 — 주석도 활성도 아니니 루프가 안 본다.
  //   ⛔ 행을 지우지 않는다(prune 계약). 끄기만 한다.
  //   ⛔ source='crontab' 만 — inventoryInternalSchedules 가 넣는 내부 행은 crontab 에
  //     「원래 없는」 것이라 끄면 안 된다. source 가 출처 칸(run_via 는 실행 주체).
  //   ⛔ 빈 문자열은 읽기 실패와 같다 — 「전부 사라졌다」로 읽으면 한 번의 실패가 전 스케줄을 끈다.
  if (text !== '') {
    const missing = db.prepare(
      `SELECT id FROM schedule_registry WHERE source = 'crontab' AND enabled = 1 AND run_via != 'trigger'`,
    ).all() as Array<{ id: string }>;
    for (const row of missing) {
      if (seenIds.has(row.id)) continue;
      db.run(`UPDATE schedule_registry SET enabled = 0, disabled_reason = 'vanished' WHERE id = ?`, [row.id]);
      vanished++;
    }
  }
  return { total, added, disabled, vanished };
}

/** cron 식 변경은 content-hash id(cron+command)를 바꾸므로, update 후 옛 id 는 더 이상
 *  crontab 라인과 매칭되지 않아 registry 에 **고아**로 남는다(inventoryCrontab 은 upsert-only·
 *  사라진 라인을 prune 하지 않는다 — 주석 처리된 disabled 잡을 지우지 않기 위한 의도). 이 헬퍼는
 *  옛 id 의 이력/사용자 필드(last_run·note·domain·managed_by·run_via·autopilot_id)를 새 id 로
 *  이관하고 옛 행을 제거해 registry↔crontab 정합을 회복한다. **update 경로 전용**(전역 prune 아님).
 *  이관 성공 시 true. oldId===newId 또는 어느 한쪽 행이 없으면 no-op(false). */
export function reindexCrontabEntry(db: Database, oldId: string, newId: string): boolean {
  if (!oldId || !newId || oldId === newId) return false;
  const old = db.prepare(
    `SELECT last_run, note, domain, managed_by, run_via, autopilot_id FROM schedule_registry WHERE id = ?`,
  ).get(oldId) as
    | { last_run: string | null; note: string | null; domain: string | null; managed_by: string | null; run_via: string | null; autopilot_id: string | null }
    | undefined;
  const fresh = db.prepare(`SELECT id FROM schedule_registry WHERE id = ?`).get(newId);
  if (!old || !fresh) return false;
  // COALESCE(옛값, 새행값) — 옛 행의 사용자 override/이력이 있으면 우선 보존, 없으면 인벤토리 기본 유지.
  db.run(
    `UPDATE schedule_registry SET
       last_run = COALESCE(?, last_run),
       note = COALESCE(?, note),
       domain = COALESCE(?, domain),
       managed_by = COALESCE(?, managed_by),
       run_via = COALESCE(?, run_via),
       autopilot_id = COALESCE(?, autopilot_id)
     WHERE id = ?`,
    [old.last_run, old.note, old.domain, old.managed_by, old.run_via, old.autopilot_id, newId],
  );
  db.run(`DELETE FROM schedule_registry WHERE id = ?`, [oldId]);
  return true;
}

// ── 내부 스케줄 인벤토리 (B2 · 2026-07-07) — 통합 뷰 ────────────────────
// crontab 외에 elanous 데몬이 자체 발화하는 내부 스케줄(daily-reflection·discovery·
// workflow-runtime 트리거)도 같은 레지스트리에 편입 → "전체 스케줄 한 화면".
// run_via='daemon'(데몬 자체 발화) — 내 schedule-runner(run_via='elanous')와 구분,
// 러너가 오발화하지 않음. source로 출처 구분.

export interface InventoryInternalOpts {
  now?: string;
  reflectionHour?: number;
  discoveryIntervalMs?: number;
  /** 테스트 seam — workflow-runtime schedule 트리거 주입(미지정 시 discoverWorkflows). */
  workflowSchedules?: Array<{ workflowName: string; nodeId: string; cron?: string | null; intervalMs?: number | null }>;
  /** Test seams for the installed instance; production reads the active config and instance root. */
  watchRoot?: string;
  watchEnabled?: boolean;
}

/** 데몬 내부 스케줄을 레지스트리에 upsert(멱등·고정 id). 등록 수 반환. */
export function inventoryInternalSchedules(db: Database, opts: InventoryInternalOpts = {}): { count: number } {
  const now = opts.now ?? new Date().toISOString();
  let count = 0;
  // internal 스케줄은 코드가 소유(사용자 override 대상 아님) → ON CONFLICT 에서
  // domain 도 코드 기본값으로 갱신(daily-reflection=finance 재분류가 기존 row 에도
  // 반영되게). crontab 잡의 domain override 보존과는 다른 정책.
  const upsert = (id: string, name: string, source: string, cron: string | null, intervalMs: number | null, command: string, category: ScheduleCategory, domain: string) => {
    db.run(
      `INSERT INTO schedule_registry (id, name, source, cron, interval_ms, command, category, domain, enabled, last_seen, managed_by, run_via)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'daemon', 'daemon')
       ON CONFLICT(id) DO UPDATE SET cron=excluded.cron, interval_ms=excluded.interval_ms, command=excluded.command, domain=excluded.domain, last_seen=excluded.last_seen`,
      [id, name, source, cron, intervalMs, command, category, domain, now],
    );
    count++;
  };
  // daily-reflection (항상 가동 · 기본 21:00) — elanous 자체 활동 회고(오늘 노트/OCR/
  // 세션 요약·PWA /reflection) 스냅샷 푸시. 투자 무관 → elanous(core). Conatus 투자
  // 회고(retro loop = retro-aggregate/report/rebalance)와는 별개.
  const hour = opts.reflectionHour ?? (Number.isFinite(Number.parseInt(process.env.ELANOUS_REFLECTION_HOUR ?? '', 10)) ? Number.parseInt(process.env.ELANOUS_REFLECTION_HOUR!, 10) : 21);
  upsert('internal:daily-reflection', 'daily-reflection', 'daily-reflection', `0 ${hour} * * *`, null, 'daemon: elanous 활동 회고(노트/OCR/세션) 스냅샷 푸시', 'report', 'elanous');
  // WATCH-DEFAULT — fail-soft: a broken sources file or config must not stop the other internal rows.
  let watchSources: ReturnType<typeof listSources> = [];
  try {
    const watchEnabled = opts.watchEnabled ?? (getUserConfig().watch?.enabled !== false);
    watchSources = watchEnabled ? listSources({ seat: 'user' }, opts.watchRoot ?? effectiveInstanceRoot()) : [];
  } catch (error) {
    debug.log('watch.default', 'failed', { stage: 'inventory', reason: error instanceof Error ? error.message : String(error) });
  }
  if (watchSources.length > 0) {
    upsert('internal:watch-collect', 'watch-collect', 'watch-default', '0 7 * * *', null,
      'intake source run-due --seat user', 'ingest', 'elanous');
    upsert('internal:watch-brief', 'watch-brief', 'watch-default', '30 8 * * *', null,
      'intake digest --seat user --telegram', 'digest', 'elanous');
    debug.log('watch.default', 'scheduled', { topics: watchSources.length, items: 0, sent: false });
  } else {
    db.run("DELETE FROM schedule_registry WHERE id IN ('internal:watch-collect', 'internal:watch-brief') AND source = 'watch-default'");
  }
  // discovery (env 설정 시에만 가동) — 코어 인프라 → elanous.
  const dm = opts.discoveryIntervalMs ?? Number.parseInt(process.env.ELANOUS_DISCOVERY_CRON_INTERVAL_MS ?? '', 10);
  if (Number.isFinite(dm) && dm > 0) {
    upsert('internal:discovery', 'discovery', 'discovery', null, dm, 'daemon: registry discovery refresh', 'ingest', 'elanous');
  }
  // workflow-runtime schedule 트리거 편입 — 워크플로 YAML의 scheduleTrigger 노드.
  // 현재 0개(test-delivery-pushcut 무트리거)이나 존재 시 자동 편입. fail-soft.
  let wfSchedules = opts.workflowSchedules;
  if (!wfSchedules) {
    try {
      const disc = require('../workflow-runtime/discovery.js') as typeof import('../workflow-runtime/discovery.js');
      const reg = require('../workflow-runtime/triggers/registry.js') as typeof import('../workflow-runtime/triggers/registry.js');
      const { schedules } = reg.buildTriggerRegistry(disc.discoverWorkflows());
      wfSchedules = schedules.map(s => ({
        workflowName: s.workflowName, nodeId: s.nodeId,
        cron: s.trigger.type === 'cron' ? (s.trigger.cron ?? null) : null,
        intervalMs: s.trigger.type === 'interval' ? (s.trigger.interval ?? null) : null,
      }));
    } catch { wfSchedules = []; /* workflow-runtime 미가용 */ }
  }
  for (const w of wfSchedules) {
    upsert(`internal:wf:${w.workflowName}:${w.nodeId}`, w.workflowName, 'workflow-runtime',
      w.cron ?? null, w.intervalMs ?? null, `workflow: ${w.workflowName}#${w.nodeId}`, 'maintenance', 'elanous');
  }
  return { count };
}

export interface ListOpts { category?: ScheduleCategory; domain?: string; source?: string }

/** 레지스트리 조회 — 카테고리/도메인/소스 필터. */
export function listSchedules(db: Database, opts: ListOpts = {}): ScheduleRow[] {
  const where: string[] = [];
  const params: string[] = [];
  if (opts.category) { where.push('category = ?'); params.push(opts.category); }
  if (opts.domain) { where.push('domain = ?'); params.push(opts.domain); }
  if (opts.source) { where.push('source = ?'); params.push(opts.source); }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  return db.prepare(`SELECT * FROM schedule_registry ${clause} ORDER BY category, name`).all(...params) as ScheduleRow[];
}

/** 드리프트 감지 — 마지막 인벤토리(now) 이후 last_seen이 갱신 안 된 crontab 행
 *  = crontab에서 사라짐(수동 삭제). staleBefore 이전 last_seen인 crontab 소스 행. */
export function driftedSchedules(db: Database, staleBefore: string): ScheduleRow[] {
  return db.prepare(
    `SELECT * FROM schedule_registry WHERE source='crontab' AND (last_seen IS NULL OR last_seen < ?) ORDER BY name`,
  ).all(staleBefore) as ScheduleRow[];
}

// ── crontab 쓰기 (S1 · schedule_manage) — 순수 변환 + 임퓨어 적용 분리 ─────────
// 안전 원칙: ① 항상 백업 ② elanous .ts 스크립트는 `cd <repo> &&` 강제(상대경로
// 즉사 방지 · feedback_crontab_line_cd_repo_required) ③ 로그 리다이렉트 ④ 파괴적
// 작업은 확인. 실행 엔진 신설 아님 — 시스템 crontab을 안전하게 CRUD.

import { writeFileSync } from 'node:fs';

/** elanous repo 루트(이 파일 = src/domains/…). */
export function repoRoot(): string {
  return cronRepoRoot(join(import.meta.dir, '..', '..'));
}

/**
 * 설치본의 고정 경로(`<prefix>/current/node_modules/elanous`) — 있으면. R3(09-24)에서 체크아웃이 필요 없는 크론을
 * 여기로 옮긴다 ⇒ 건강 검사는 이 `cd` 도 정규로 본다(`scheduleHealth` 의 `alsoCanonicalRepos`).
 */
export function installedCronRoot(
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync,
  home: string = homedir(),
): string | null {
  const prefix = env.ELANOUS_INSTALL_PREFIX?.trim() || join(env.XDG_DATA_HOME?.trim() || join(home, '.local', 'share'), 'elanous');
  const root = join(prefix, 'current', 'node_modules', 'elanous');
  return exists(root) ? root : null;
}

/**
 * 크론 `cd` 대상. 🩸 2026-09-24: 전역 `elanous`·데몬이 설치본으로 옮긴 뒤 `import.meta.dir` 는 판 폴더
 * (`~/.local/share/elanous/versions/<판>/node_modules/elanous`)로 풀린다 — 그 경로를 크론에 박으면
 * 야간 정리(#20214)가 그 판을 지우는 날 크론이 조용히 죽는다.
 * ⇒ 설치본이면 설정 `ops.cronRepoRoot` 우선, 없으면 고정 경로 `current`.
 * 설치본이 아니면(체크아웃) 그대로.
 */
export function cronRepoRoot(
  codeRoot: string,
  deps: { exists?: (p: string) => boolean; configuredRoot?: () => string | undefined } = {},
): string {
  const exists = deps.exists ?? existsSync;
  const m = /^(.*)\/versions\/[^/]+\/node_modules\/elanous\/?$/.exec(codeRoot.replace(/\\/g, '/'));
  if (!m || hasGitAbove(codeRoot, exists)) return codeRoot;
  const configured = (deps.configuredRoot ?? (() => {
    try {
      const { getUserConfig } = require('../user-config.js') as typeof import('../user-config.js');
      return getUserConfig().ops?.cronRepoRoot;
    } catch { return undefined; }
  }))()?.trim();
  return configured || `${m[1]}/current/node_modules/elanous`;
}

function hasGitAbove(dir: string, exists: (p: string) => boolean): boolean {
  let d = dir;
  for (let i = 0; i < 30; i++) {
    if (exists(join(d, '.git'))) return true;
    const parent = join(d, '..');
    if (parent === d) return false;
    d = parent;
  }
  return false;
}

// 셸 명령의 **선두 진입점**(옵션 `cd <path> &&` 뒤)만 대상으로 앵커한다 — 임의 `&&`/`;` 경계를 훑으면
//   인용 문자열 내부의 `; elanous`/`&& elanous` 를 셸 경계로 오인해 문자열을 변조한다(리뷰 #5342 실버그).
//   cron 진입점은 `elanous …` 또는 `[cd <repo> &&] <bun> bin/elanous.mjs …` 선두 형태뿐이라 선두 앵커로 충분·안전.
const LEADING_ELANOUS_ENTRYPOINT = /^(\s*(?:cd\s+\S+\s+&&\s+)?)(?:(?:\S*\/)?bun\s+bin\/elanous\.mjs|elanous)(?=\s|$)/;

/** 셸 명령 **선두**의 elanous 진입형(bare `elanous` · `<bun경로> bin/elanous.mjs`)을 현재 Bun 절대 진입점으로 통일한다.
 *  선두(옵션 `cd … &&` 뒤)에만 앵커 — 인용 문자열/후속 인자 내부는 무접촉. */
function normalizeCronElanousEntrypoint(command: string, bun: string): string {
  return command.replace(LEADING_ELANOUS_ENTRYPOINT, (_m, prefix: string) => `${prefix}${bun} bin/elanous.mjs`);
}

/** cron + 스크립트 → 안전한 crontab 라인 조립. repo-cwd 필요 명령(scripts·bin/elanous.mjs·전역 elanous)은
 *  cd+로그 강제. cron 은 home 에서 발화하므로 repo 상대경로·elanous 의 git 컨텍스트가 깨진다(무음 실패). */
export function buildCronLine(
  cron: string, command: string,
  opts: { repo?: string; bun?: string; logName?: string } = {},
): string {
  const repo = opts.repo ?? repoRoot(); // default cron cwd → cronRepoRoot → ops.cronRepoRoot or installed current
  const bun = opts.bun ?? process.execPath; // 데몬은 bun 하에서 구동
  const cmd = command.trim();
  // cron의 기본 PATH에는 ~/.bun/bin이 없을 수 있다. 직접 실행과 cd/세미콜론 뒤의
  // elanous CLI를 모두 Bun 절대경로로 고정해 PATH에 의존하지 않는다.
  const runnableCmd = normalizeCronElanousEntrypoint(cmd, bun);
  // ★ repo-cwd 필요(2026-07-23·운영 리포트 무음실패 근본수정) — 이미 완성형(cd …)만 제외하고,
  //   repo-상대 스크립트(scripts/*.ts|mjs|js|sh·bin/elanous.mjs) + elanous CLI도 cd 강제.
  const alreadyCd = /^cd\s/.test(runnableCmd);
  const startsWithAbsoluteNonElanousCommand = /^\//.test(cmd)
    && !LEADING_ELANOUS_ENTRYPOINT.test(cmd)
    && !/^\S*\/bun\s/.test(cmd);
  const isRepoScript = /(^|\s)(scripts\/(?:(?!\.\.(?:\/|$))[\w.-]+\/)*(?!\.\.(?:\s|$))[\w.-]+\.(ts|mjs|js|sh)|bin\/elanous\.mjs)(\s|$)/.test(runnableCmd);
  const needsRepoCwd = !alreadyCd && !startsWithAbsoluteNonElanousCommand && isRepoScript;
  let full = runnableCmd;
  if (needsRepoCwd) {
    const needsBun = /^(?:scripts\/(?:(?!\.\.(?:\/|$))[\w.-]+\/)*(?!\.\.(?:\s|$))[\w.-]+\.(?:ts|mjs|js)|bin\/elanous\.mjs)(?:\s|$)/.test(runnableCmd);
    const withBun = needsBun ? `${bun} ${runnableCmd}` : runnableCmd;
    full = `cd ${repo} && ${withBun}`;
  }
  if (!/>>?\s*\/\S+/.test(full)) {
    const name = opts.logName ?? scriptName(cmd);
    full += ` >> /tmp/${name}.log 2>&1`;
  }
  return `${cron.trim()} ${full}`;
}

/** 순수: 라인 추가(정확 중복 방지). */
export function addLineToCrontab(current: string, line: string): string {
  const lines = current.replace(/\n+$/, '').split('\n');
  if (lines.some(l => l.trim() === line.trim())) return current.replace(/\n*$/, '\n');
  lines.push(line.trim());
  return lines.filter((l, i) => l !== '' || i < lines.length).join('\n').replace(/\n*$/, '\n');
}

/** 순수: raw 라인 제거(주석 처리된 변형도 포함). */
export function removeLineFromCrontab(current: string, rawLine: string): string {
  const target = rawLine.trim();
  return current.split('\n')
    .filter(l => l.trim() !== target && l.trim() !== `# ${target}` && l.trim() !== `#${target}`)
    .join('\n').replace(/\n*$/, '\n');
}

/** 순수: raw 라인 활성/비활성(주석 토글). */
export function setLineEnabled(current: string, rawLine: string, enabled: boolean): string {
  const target = rawLine.trim();
  return current.split('\n').map(l => {
    const t = l.trim();
    if (enabled && (t === `# ${target}` || t === `#${target}`)) return target;
    if (!enabled && t === target) return `# ${target}`;
    return l;
  }).join('\n').replace(/\n*$/, '\n');
}

/** 임퓨어: 백업 후 crontab 교체. 백업 경로 반환. */
export function applyCrontab(text: string, opts: { backupDir?: string; now?: string } = {}): string {
  const dir = opts.backupDir ?? join(elanousStateRoot(), 'backups');
  mkdirSync(dir, { recursive: true });
  const stamp = (opts.now ?? new Date().toISOString()).replace(/[:.]/g, '-');
  const backup = join(dir, `crontab-cronmanage-${stamp}.bak`);
  try { writeFileSync(backup, readCrontab()); } catch { /* 최초엔 빈 crontab */ }
  execFileSync('crontab', ['-'], { input: text.replace(/\n*$/, '\n'), encoding: 'utf-8', env: process.env });
  return backup;
}
