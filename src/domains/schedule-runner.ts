// ── 스케줄 러너 (2026-07-07 · S2 / 2026-07-09 · P1 관측성+자기회복) ─────
//
// 대표 지시: "실제 크론잡이 스케줄러로 돌아갈 수 있도록." 시스템 crontab 대신
// elanous 데몬이 잡을 발화. 새 외부 엔진 신설 아님 — workflow-runtime가 이미 쓰는
// node-cron을 데몬 내에서 재사용(레거시 스케줄러 은퇴 교훈 준수).
//
// 안전 설계:
//   · opt-in: run_via='elanous' 잡만 발화. 나머지는 crontab이 계속 실행.
//   · 더블파이어 방지: 라이브 crontab에 같은 command가 있으면 SKIP(경고).
//   · 오버랩 가드: 이전 실행이 안 끝났으면 다음 tick 스킵.
//   · reconcile 루프: 레지스트리 변화(adopt/release)를 주기 반영(재시작 불요).
//
// P1(2026-07-09) — "돌았는지 모른다" 문제 해결:
//   · 실행 결과 기록: last_run 만이 아니라 exit code·소요·성공/실패·경로까지
//     markResult 로 남김(관측성). spawnJob 이 exit code 를 버리던 갭 수리.
//   · catch-up 자기회복: node-cron 은 놓친 tick 을 버린다(재시작·이벤트루프
//     블로킹 → 일간 잡 최대 24h 유실). 1분 sweep 이 "예정 시각이 지났는데
//     last_run 이 그보다 오래됐으면 지금 1회 발화"로 유실 복구. grace window
//     이내만·매매(place_order)류는 stale 발화 위험으로 제외.

import { requirePosixShellCommand } from '../platform/default-shell.js';
import cron from 'node-cron';
import { spawn } from 'node:child_process';
import type { Database } from 'bun:sqlite';
import { openSchedulesDb, listSchedules, readCrontab, parseCronLine, scriptName, getLastStatus, type ScheduleRow } from './schedule-registry.js';
import { recordScheduledExecution } from './schedule-observability.js';
import { prevScheduledFire } from './cron-match.js';
import { resolveTimeZone } from '../time/format.js';
import '../user-config.js'; // Register the saved timezone before selecting the firing and catch-up clock.
import { debug } from '../debug/log.js';

interface CronTaskLike { stop(): void }
type ScheduleFn = (expr: string, cb: () => void) => CronTaskLike;
export interface SpawnOutcome { code: number; ms: number; error?: string }
type SpawnJob = (command: string) => Promise<SpawnOutcome>;

export interface ScheduleRunnerHandle {
  stop(): void;
  reload(): void;
  active(): string[];
  /** 테스트/온디맨드 — 특정 잡 즉시 발화. */
  triggerNow(id: string): Promise<void>;
  /** 테스트/온디맨드 — catch-up sweep 1회 수동 실행. */
  sweepNow(): void;
}

export interface RunnerOpts {
  db?: Database;
  reconcileMs?: number;              // 레지스트리 재조정 주기(기본 5분)
  sweepMs?: number;                  // catch-up sweep 주기(기본 1분)
  catchupGraceMs?: number;           // 놓친 발화 복구 상한(기본 6h) — 초과분은 skip
  schedule?: ScheduleFn;             // 테스트 seam(기본 node-cron)
  spawnJob?: SpawnJob;               // 테스트 seam(기본 sh -c spawn)
  crontabText?: () => string;        // 테스트 seam(기본 readCrontab)
  now?: () => string;                // 발화 시각(ISO) seam
  nowDate?: () => Date;              // catch-up 판정용 현재시각 seam
  catchupEligible?: (j: ScheduleRow) => boolean; // catch-up 대상 여부 seam
  /** 발화·catch-up 판정 시간대(IANA). 생략 시 `resolveTimeZone()`.
   *  테스트가 실행 머신 TZ 에 의존하지 않게 하는 seam이자 운영 override. */
  timeZone?: string;
}

/** 기본 실행 — sh -c로 커맨드 spawn(데몬 env 상속: PATH·bun 가용). 완료 대기.
 *  P1: exit code·소요를 캡처(버리지 않음 — 성공/실패 가시화의 근거). */
export const defaultSpawnJob: SpawnJob = (command) => new Promise((resolve) => {
  const start = Date.now();
  let shell: string;
  try { shell = requirePosixShellCommand('/bin/sh'); }
  catch (e) {
    resolve({ code: -1, ms: Date.now() - start, error: (e as Error).message });
    return;
  }
  const child = spawn(shell, ['-c', command], { stdio: 'ignore', detached: false });
  child.on('exit', (code) => resolve({ code: code ?? -1, ms: Date.now() - start }));
  child.on('error', (e) => resolve({ code: -1, ms: Date.now() - start, error: String((e as Error)?.message ?? e) }));
});

/** 매매 실행류는 catch-up 제외 — 오래된 국면으로 뒤늦게 주문 나가면 위험.
 *  (정시 tick 은 그대로 발화 · 마켓클럭+mandate 게이트가 별도 보호.) */
export function defaultCatchupEligible(j: ScheduleRow): boolean {
  const hay = `${j.name} ${j.command ?? ''}`.toLowerCase();
  return !/trade-autonomous|place_order|trade-cycle|trade_cycle/.test(hay);
}

/** 라이브 crontab의 command 집합(더블파이어 가드용). */
function crontabCommands(text: string): Set<string> {
  const s = new Set<string>();
  for (const line of text.split('\n')) {
    const p = parseCronLine(line);
    if (p) s.add(p.command);
  }
  return s;
}

export function startScheduleRunner(opts: RunnerOpts = {}): ScheduleRunnerHandle {
  const db = opts.db ?? openSchedulesDb();
  const ownDb = !opts.db;
  // 2026-07-24 — 발화 시간대를 **명시**한다. 종전엔 node-cron 에 옵션을 안 넘겨
  // 프로세스 주변 TZ 에 의존했고, catch-up(cron-match)도 로컬 게터를 썼다. 둘 다
  // 로컬이라 우연히 일치했을 뿐, launchd 데몬은 `TZ` 를 물려받지 못하므로(실측:
  // 데몬에 TZ env 없음) 환경이 바뀌면 모든 잡이 **조용히** 밀린다 —
  // `TZ=UTC` 면 `45 7 * * *` 이 KST 16:45 에 발화한다.
  //
  // ⚠️ 발화와 catch-up 이 **같은 값**을 써야 한다. 어긋나면 catch-up 이 이미 발화한
  // 잡을 다시 쏘거나(중복) 놓친 잡을 못 잡는다. 그래서 여기서 한 번 해석해 양쪽에
  // 넘긴다. 계약: src/time/format.ts
  const timeZone = opts.timeZone ?? resolveTimeZone().timeZone;
  const scheduleFn: ScheduleFn = opts.schedule
    ?? ((expr, cb) => cron.schedule(expr, cb, { timezone: timeZone }) as unknown as CronTaskLike);
  const spawnJob = opts.spawnJob ?? defaultSpawnJob;
  const crontabText = opts.crontabText ?? readCrontab;
  const now = opts.now ?? (() => new Date().toISOString());
  const nowDate = opts.nowDate ?? (() => new Date());
  const catchupGraceMs = opts.catchupGraceMs ?? 6 * 3600_000;
  const catchupEligible = opts.catchupEligible ?? defaultCatchupEligible;

  const tasks = new Map<string, { task: CronTaskLike; command: string; running: boolean }>();

  const fire = async (id: string, via = 'tick'): Promise<void> => {
    const entry = tasks.get(id);
    if (!entry || entry.running) return; // 오버랩 가드
    entry.running = true;
    const at = now();
    // 3계층 관측(RFC·크론 관측성 통일) — markResult(②)만이 아니라 logs.db(①)·자기기억 이상(③)까지.
    const name = scriptName(entry.command);
    const prevStatus = getLastStatus(db, id);
    try {
      const res = await spawnJob(entry.command);
      recordScheduledExecution(name, {
        at, status: res.code === 0 ? 'ok' : 'error',
        exit: res.code, durationMs: res.ms, via,
        error: res.error ?? (res.code === 0 ? null : `exit ${res.code}`),
      }, { db, id, prevStatus });
    } catch (e) {
      recordScheduledExecution(name, { at, status: 'error', exit: -1, durationMs: 0, via, error: String((e as Error)?.message ?? e) }, { db, id, prevStatus });
    } finally {
      entry.running = false;
    }
  };

  const reconcile = (): void => {
    const inCrontab = crontabCommands(crontabText());
    const desired = listSchedules(db).filter(j =>
      j.run_via === 'elanous' && j.enabled && j.cron && cron.validate(j.cron) &&
      j.command && !inCrontab.has(j.command)); // crontab에도 있으면 더블파이어 → 스킵
    const wanted = new Set(desired.map(j => j.id));
    // 사라진/해제된 잡 중지
    for (const [id, e] of [...tasks]) {
      if (!wanted.has(id)) { e.task.stop(); tasks.delete(id); }
    }
    // 신규 잡 스케줄
    for (const j of desired) {
      if (!tasks.has(j.id)) {
        const task = scheduleFn(j.cron!, () => { void fire(j.id, 'tick'); });
        tasks.set(j.id, { task, command: j.command!, running: false });
      }
    }
  };

  // ── catch-up sweep — node-cron 이 놓친 발화를 last_run 기준으로 복구 ──
  const sweep = (): void => {
    const nd = nowDate();
    const rows = listSchedules(db);
    const byId = new Map(rows.map(r => [r.id, r]));
    for (const id of tasks.keys()) {
      const j = byId.get(id);
      if (!j || !j.cron || !catchupEligible(j)) continue;
      // 발화(node-cron)와 **동일한** timeZone 으로 판정 — 어긋나면 중복/누락 발화.
      const prev = prevScheduledFire(j.cron, nd, catchupGraceMs, { timeZone });
      if (!prev) continue; // grace 이내 예정 없음(= 최근 미예정 or 너무 오래됨)
      // 현재 tick window(90s) 안이면 node-cron 이 처리 → 건드리지 않음(더블파이어 방지)
      if (nd.getTime() - prev.getTime() < 90_000) continue;
      const lr = j.last_run ? Date.parse(j.last_run) : 0;
      if (Number.isFinite(lr) && lr >= prev.getTime()) continue; // 이미 실행됨
      void fire(id, 'catchup');
    }
  };

  // 해석된 발화 시간대를 부팅 시 1회 관측 — 이 값은 선언되지 않으면 환경에 따라
  // 조용히 바뀌고, 바뀌면 모든 잡이 밀린다. 사후에 "그때 어느 TZ 였나"를 물을 수
  // 있어야 한다(제1원칙). ambient 와 다르면 그것 자체가 신호다.
  {
    const ambient = Intl.DateTimeFormat().resolvedOptions().timeZone;
    debug.log('schedule.runner', 'timezone-resolved', {
      timeZone,
      ambient,
      matchesAmbient: timeZone === ambient,
      envTz: process.env.TZ ?? null,
      explicit: opts.timeZone != null,
    });
  }

  reconcile();
  sweep(); // 부팅 즉시 유실분 복구
  const iv = setInterval(reconcile, opts.reconcileMs ?? 300_000);
  const sv = setInterval(sweep, opts.sweepMs ?? 60_000);
  for (const t of [iv, sv]) {
    if (typeof (t as { unref?: () => void }).unref === 'function') (t as { unref: () => void }).unref();
  }

  return {
    stop() {
      clearInterval(iv);
      clearInterval(sv);
      for (const e of tasks.values()) e.task.stop();
      tasks.clear();
      if (ownDb) db.close();
    },
    reload: reconcile,
    active: () => [...tasks.keys()],
    triggerNow: (id) => fire(id, 'manual'),
    sweepNow: sweep,
  };
}
