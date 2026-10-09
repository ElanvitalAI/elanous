// ── 운영 상태 조회/집계 (Ops Observability P1 · 2026-07-10) ─────────────────
//
// P0(ops-log)가 심은 상태 전이를 읽어 "지금 무엇이 어떤 상태로 도나"를 단일 출처로
// 집계한다. tool·CLI·PWA·셀프교정 크론이 전부 이 함수들을 재사용(중복 집계 방지).
//
// - opsSnapshot: 미션/태스크/루프/오케스트레이션/스케줄 현재 상태 스냅샷.
// - opsHealth:   이상 판정(순수·scheduleHealth 패턴) — stale 미션·blocked 태스크·
//                errored 루프·오케스트레이터 크론 미발화. 셀프교정(P3)의 입력.
// - opsTimeline: ops_events 최근순 통합 타임라인.
//
// 거버넌스: READ-ONLY. 각 섹션 fail-soft(한 소스 실패가 전체 스냅샷을 막지 않음).
// 새 저장소·실행엔진 없음 — 기존 스토어(ops_events·tasks.db·schedules.db·mandate) 조합.

import { openOpsEventsDb, queryOpsEvents, type OpsEventRow, type OpsEntityType, type OpsEventKind } from './ops-log.js';
import { TaskStore } from '../task-orchestrator/store.js';
import { listMissions, getMission, openAutopilotMissionsDb } from '../autopilot/mission-registry.js';
import { traceAutopilotMission } from '../autopilot/mission-trace.js';
import { listPhases } from '../autopilot/mission-adjust.js';
import { parseDiagnosisNote } from '../autopilot/mission-phase-diagnosis.js';
import { prUrlFromNotes, critiqueFromNotes } from '../autopilot/mission-multiphase-executor.js';
import { missionRunLogPath } from '../autopilot/mission-engine.js';
import { proposalDraftPath } from '../autopilot/build/build-target.js';
import { readFileSync, existsSync } from 'node:fs';
import { openSchedulesDb, inventoryCrontab, listSchedules, installedCronRoot, repoRoot, scheduleHealth, type ScheduleHealth, type ScheduleRow } from './schedule-registry.js';
import { loadMandate, type TradeMandate } from './trade-mandate.js';
import { debug, redactSecretText } from '../debug/log.js';
import { LogStore, logsDbPath, type LogStoreRow } from '../mss/logging/log-store.js';
import { detectRepeatedFailures, explainFailure } from './repeated-failure.js';
import { listLoops, loopRecentRuns, type LoopRun } from '../loops/registry.js';

/** 예약 레지스트리 조회 관측 — 실패가 0으로 접히지 않게 남기는 창구. */
export const OPS_STATUS_LOG_CATEGORY = 'ops.status';
export const OPS_SCHEDULES_LOOKUP_FAILED_EVENT = 'schedules.lookup-failed';

/** 예약 레지스트리 행 조회 seam — 미지정 시 실 레지스트리 reader. */
export type ListScheduleRows = () => ScheduleRow[];

/** Graph-loop health input — run history is newest first. */
export type GraphLoopRuns = () => Array<{
  id: string;
  enabled: boolean;
  runs: Array<Pick<LoopRun, 'at' | 'status' | 'failedNodes'>>;
}>;

/** Bounded window per loop: a streak whose oldest read run is already >24h old is flagged; a longer
 * all-failed history than this window can only under-report (never over-report) the streak length. */
export const GRAPH_LOOP_HEALTH_RUN_WINDOW = 50;

function defaultGraphLoopRuns(): ReturnType<GraphLoopRuns> {
  const out: ReturnType<GraphLoopRuns> = [];
  for (const loop of listLoops().filter(entry => entry.enabled)) {
    // One unreadable run history must not hide the other loops.
    try { out.push({ id: loop.id, enabled: loop.enabled, runs: loopRecentRuns(loop.id, {}, GRAPH_LOOP_HEALTH_RUN_WINDOW) }); }
    catch (err) {
      debug.log('ops.health', 'graph-loop-failure-skipped', { loop: loop.id, reason: redactSecretText(err instanceof Error ? err.message : String(err)) });
    }
  }
  return out;
}

/** 조회 seam(테스트) — 미지정 시 실 스토어. */
export interface OpsStatusOpts {
  now?: Date;
  opsDbPath?: string;
  missionStore?: TaskStore;
  schedulesDbPath?: string;
  /** 예약 레지스트리 조회 seam(테스트). 미지정 시 기존 레지스트리 reader. */
  listScheduleRows?: ListScheduleRows;
  mandate?: TradeMandate | null;
  /** 플랜 초안 아티팩트 경로 resolver(테스트 seam). 기본 proposalDraftPath. */
  planDraftFor?: (missionId: string) => string;
  /** Health-only log reader seam; the default reads the current instance's last ten minutes read-only. */
  recentLogs?: () => LogStoreRow[];
  /** Health-only graph-loop registry reader; injection avoids the real state directory. */
  graphLoopRuns?: GraphLoopRuns;
}

export interface CountByStatus { [status: string]: number }

export interface MissionSnapshot {
  total: number;
  byStatus: CountByStatus;
  /** 진행 중(running)·대기(proposed·armed) 미션 요약. disposition=사람용 처분 라벨
   *  (승인대기 HITL vs 실행중) — "proposed=멈춤" 오해 방지(대표 지적 2026-07-10). */
  active: Array<{ id: string; goal: string; status: string; source: string; disposition: string }>;
}

export interface TaskSnapshot {
  total: number;
  byStatus: CountByStatus;
  /** ★ 두 플레인 구분(대표 지적) — 아래 3개로 "backlog=멈춤" 오해를 해소한다:
   *  scheduleBacked = 스케줄 플레인에서 실행되는 태스크(크론 jobRef 보유·backlog 여도 실제로 돎).
   *  recentlyActive = 그 중 최근 6h 내 스케줄 발화(살아있음 증거).
   *  dispatchPending = 크론 아닌 backlog(진짜 TOX 디스패치 대기 후보). */
  scheduleBacked: number;
  recentlyActive: number;
  dispatchPending: number;
  /** 막힌 태스크(blocked) — 의존성/재시도 사유. */
  blocked: Array<{ id: string; title: string; missionId?: string; note?: string }>;
  /** 진짜 디스패치 대기(크론 아닌 backlog) 샘플. */
  dispatchable: Array<{ id: string; title: string; missionId?: string }>;
}

export interface LoopSnapshot {
  /** 계약 루프별 최근 사이클(ops_events entity_type='loop'). */
  loops: Array<{ id: string; lastEvent: string; lastState: string | null; at: string; detail?: Record<string, unknown> }>;
  armed: boolean;
  live: boolean;
  executionMode: string;
  paperSources: string[];
}

export interface OrchestrationSnapshot {
  /** 최근 오케스트레이션 이벤트(alloc·cycle_end). */
  recent: Array<{ event: string; state: string | null; at: string; detail?: Record<string, unknown> }>;
}

/** 스케줄 헬스의 기존 이상 지표와 제외 사유를 함께 보존하는 ops 스냅샷 표면. */
export interface OpsScheduleSnapshot extends ScheduleHealth {
  excludedRunVia: number;
  excludedUnwrappedCrontab: number;
  excludedDisabled: number;
  excludedMissingCron: number;
}

export interface OpsSnapshot {
  missions: MissionSnapshot;
  tasks: TaskSnapshot;
  loops: LoopSnapshot;
  orchestration: OrchestrationSnapshot;
  schedules: OpsScheduleSnapshot | null;
  generatedAt: string;
}

function tally(items: string[]): CountByStatus {
  const out: CountByStatus = {};
  for (const s of items) out[s] = (out[s] ?? 0) + 1;
  return out;
}

/** 생산 기본 조회 — 기존 openSchedulesDb/listSchedules 경로.
 *  명시 주입 경로가 부재하면 파일을 만들지 않고 throw → 조회 실패(schedules=null).
 *  기본 경로(미주입)는 종전대로 open. */
function defaultListScheduleRows(opts: OpsStatusOpts): ScheduleRow[] {
  if (opts.schedulesDbPath && !existsSync(opts.schedulesDbPath)) {
    throw new Error(`schedules registry missing: ${opts.schedulesDbPath}`);
  }
  const db = openSchedulesDb(opts.schedulesDbPath);
  try {
    if (!opts.schedulesDbPath) { try { inventoryCrontab(db); } catch { /* keep going */ } }
    return listSchedules(db);
  } finally { db.close(); }
}

function readScheduleRows(opts: OpsStatusOpts): ScheduleRow[] {
  return (opts.listScheduleRows ?? (() => defaultListScheduleRows(opts)))();
}

function logSchedulesLookupFailed(err: unknown): void {
  try {
    debug.log(OPS_STATUS_LOG_CATEGORY, OPS_SCHEDULES_LOOKUP_FAILED_EVENT, {
      error: err instanceof Error ? err.message : String(err),
    }, { level: 'warn' });
  } catch { /* logging must not break the snapshot */ }
}

function parseRefs(row: OpsEventRow): Record<string, unknown> | undefined {
  if (!row.refs) return undefined;
  try { return JSON.parse(row.refs) as Record<string, unknown>; } catch { return undefined; }
}

/** 현재 동작 상태 스냅샷 — 각 섹션 fail-soft. */
export function opsSnapshot(opts: OpsStatusOpts = {}): OpsSnapshot {
  const now = opts.now ?? new Date();
  const generatedAt = now.toISOString();

  // ── 스케줄 rows 선로드(태스크 플레인 교차참조 + 헬스 공용) ──
  //  ⚠️ read-only 보장: openSchedulesDb 는 mkdir+CREATE TABLE 로 부재 파일을 생성한다(write 부작용).
  //  명시 주입 경로가 부재하면 open 자체를 skip(throw) 해 fleet 의 부재 인스턴스에 빈 db 를 만들지 않는다.
  //  그 실패는 [] 로 접지 않고 schedules=null 로 보존한다.
  //  기본 경로(미주입·단일 prod)는 파일 실존이라 종전대로 open(무회귀).
  //  조회 실패는 빈 목록과 구별한다 — 실패면 schedRows=null(헬스 null) + lookup-failed 로그.
  //  진짜 빈 레지스트리는 [] 를 헬스에 넘겨 elanousTotal=0 이 된다.
  let schedRows: ScheduleRow[] | null = [];
  let schedulesLookupFailed = false;
  try {
    schedRows = readScheduleRows(opts);
  } catch (err) {
    schedulesLookupFailed = true;
    schedRows = null;
    logSchedulesLookupFailed(err);
  }
  const schedById = new Map<string, ScheduleRow>((schedRows ?? []).map((r) => [r.id, r]));
  const recentMs = 6 * 3600_000;
  const firedRecently = (id: string | undefined): boolean => {
    if (!id) return false;
    const r = schedById.get(id);
    const lr = r?.last_run ? Date.parse(r.last_run) : NaN;
    return Number.isFinite(lr) && now.getTime() - lr < recentMs;
  };

  // ── 미션 ──
  let missions: MissionSnapshot = { total: 0, byStatus: {}, active: [] };
  try {
    const store = opts.missionStore ?? new TaskStore();
    const rows = listMissions(store, { limit: 500 });
    const active = rows
      .filter((m) => ['proposed', 'building', 'armed', 'running'].includes(m.status))
      .slice(0, 20)
      .map((m) => ({ id: m.id, goal: m.goal.slice(0, 100), status: m.status, source: m.source, disposition: missionDisposition(m.status, m.source) }));
    missions = { total: rows.length, byStatus: tally(rows.map((m) => m.status)), active };
    if (!opts.missionStore) store.close?.();
  } catch { /* fail-soft */ }

  // ── 태스크 (두 플레인 구분) ──
  let tasks: TaskSnapshot = { total: 0, byStatus: {}, scheduleBacked: 0, recentlyActive: 0, dispatchPending: 0, blocked: [], dispatchable: [] };
  try {
    const store = opts.missionStore ?? new TaskStore();
    const all = store.listTasks();
    // 스케줄-백드 판정 — generatedBy.kind='cron'(jobRef) 또는 scheduleText 보유.
    const cronRefOf = (t: { generatedBy?: { kind?: string; jobRef?: string }; schedulerJobId?: string; scheduleText?: string }): string | undefined =>
      (t.generatedBy?.kind === 'cron' ? (t.generatedBy.jobRef ?? t.schedulerJobId) : undefined) ?? (t.scheduleText ? t.schedulerJobId : undefined);
    const isSchedBacked = (t: { generatedBy?: { kind?: string }; scheduleText?: string }): boolean =>
      t.generatedBy?.kind === 'cron' || !!t.scheduleText;
    const backed = all.filter(isSchedBacked);
    const recentlyActive = backed.filter((t) => firedRecently(cronRefOf(t))).length;
    const pending = all.filter((t) => t.status === 'backlog' && !isSchedBacked(t));
    const blocked = all
      .filter((t) => t.status === 'blocked')
      .slice(0, 20)
      .map((t) => ({
        id: t.id, title: t.title.slice(0, 100),
        ...(t.missionId ? { missionId: t.missionId } : {}),
        ...(t.notes?.length ? { note: t.notes[t.notes.length - 1]!.slice(0, 120) } : {}),
      }));
    const dispatchable = pending.slice(0, 20).map((t) => ({
      id: t.id, title: t.title.slice(0, 100), ...(t.missionId ? { missionId: t.missionId } : {}),
    }));
    tasks = {
      total: all.length, byStatus: tally(all.map((t) => t.status)),
      scheduleBacked: backed.length, recentlyActive, dispatchPending: pending.length,
      blocked, dispatchable,
    };
    if (!opts.missionStore) store.close?.();
  } catch { /* fail-soft */ }

  // ── 루프 + 오케스트레이션 (ops_events) ──
  //  mandate(무장/모드)는 ops_events 와 무관하므로 항상 반영. loop/orchestration 이벤트 rows 는
  //  ops_events.db 를 열어야 하는데, openOpsEventsDb 도 mkdir+CREATE TABLE 로 부재 파일을 생성한다
  //  (write 부작용). 명시 주입 opsDbPath 가 부재하면 open skip → read-only 보장(빈 db 미생성),
  //  이벤트 rows 는 빈 채로 mandate 만 채운다. 기본 경로(미주입·단일 prod)는 실존이라 종전대로 open.
  const mandate = opts.mandate !== undefined ? opts.mandate : safeMandate();
  let loops: LoopSnapshot = {
    loops: [],
    armed: mandate?.armed ?? false,
    live: mandate?.live ?? false,
    executionMode: mandate?.executionMode ?? 'per-cycle',
    paperSources: mandate?.paperSources ?? [],
  };
  let orchestration: OrchestrationSnapshot = { recent: [] };
  if (!(opts.opsDbPath && !existsSync(opts.opsDbPath))) {
    try {
      const db = openOpsEventsDb(opts.opsDbPath);
      try {
        // 루프 — entity 별 최신 1건.
        const loopRows = queryOpsEvents(db, { entityType: 'loop', sinceHours: 72, limit: 200 });
        const latestByLoop = new Map<string, OpsEventRow>();
        for (const r of loopRows) if (!latestByLoop.has(r.entity_id)) latestByLoop.set(r.entity_id, r);
        loops.loops = [...latestByLoop.values()].map((r) => ({
          id: r.entity_id, lastEvent: r.event, lastState: r.to_state, at: r.ts, detail: parseRefs(r),
        }));
        // 오케스트레이션 — 최근순.
        const orchRows = queryOpsEvents(db, { entityType: 'orchestration', sinceHours: 72, limit: 10 });
        orchestration = {
          recent: orchRows.map((r) => ({ event: r.event, state: r.to_state, at: r.ts, detail: parseRefs(r) })),
        };
      } finally { db.close(); }
    } catch { /* fail-soft */ }
  }

  // ── 스케줄 헬스 (선로드한 schedRows 재사용) ──
  //  조회 실패는 0으로 접지 않는다 — schedules=null 이 「못 셌다」이고, 빈 배열 헬스가 「진짜 0」이다.
  let schedules: OpsScheduleSnapshot | null = null;
  if (!schedulesLookupFailed && schedRows) {
    try {
      // Inventoried rows feed the pure health population with the current runtime context.
      const installed = installedCronRoot();
      schedules = scheduleHealth(schedRows, { now, repo: repoRoot(), bun: process.execPath, ...(installed ? { alsoCanonicalRepos: [installed] } : {}) });
    } catch { /* fail-soft */ }
  }

  return { missions, tasks, loops, orchestration, schedules, generatedAt };
}

/** 미션 status → 사람용 처분 라벨. proposed 는 "멈춤"이 아니라 "승인/무장 대기(HITL)"임을 명시. */
function missionDisposition(status: string, source: string): string {
  switch (status) {
    case 'proposed': return source === 'discovery' ? '승인대기 (발굴 제안·HITL)' : '승인대기 (HITL)';
    case 'building': return '빌드 중 (조율자 분해·구현)';
    case 'armed': return '무장 (실행 대기)';
    case 'running': return '실행 중';
    case 'done': return '완료';
    case 'failed': return '실패';
    case 'disarmed': return '해제됨';
    default: return status;
  }
}

function safeMandate(): TradeMandate | null {
  try { return loadMandate(); } catch { return null; }
}

export interface OpsAnomaly {
  kind: 'blocked_task' | 'errored_loop' | 'orchestrator_stale' | 'schedule_stale' | 'schedule_error' | 'repeated_failure';
  entity: string;
  detail: string;
  since?: string;
}

export interface OpsHealthReport {
  healthy: boolean;
  anomalies: OpsAnomaly[];
  generatedAt: string;
}

/** Newest rows first, bounded: the health check must not load an unbounded 10-minute window into memory (review must-fix). */
export const REPEATED_FAILURE_SCAN_LIMIT = 20_000;
export function readRecentFailureLogs(store: Pick<LogStore, 'query'>, nowMs: number, limit = REPEATED_FAILURE_SCAN_LIMIT): LogStoreRow[] {
  const rows = store.query({ sinceMs: nowMs - 10 * 60_000, limit });
  if (rows.length >= limit) debug.log('ops.health', 'repeated-failure-scan-capped', { limit });
  return rows;
}

/** 이상 판정(순수 집계) — 셀프교정(P3)의 입력. scheduleHealth 패턴 미러. */
export function opsHealth(opts: OpsStatusOpts = {}): OpsHealthReport {
  const snap = opsSnapshot(opts);
  const anomalies: OpsAnomaly[] = [];

  // 막힌 태스크 — 병목.
  for (const t of snap.tasks.blocked) {
    anomalies.push({ kind: 'blocked_task', entity: t.id, detail: `blocked: ${t.title}${t.note ? ` (${t.note})` : ''}` });
  }

  // errored 루프 — 최근 사이클이 실패로 끝남.
  for (const l of snap.loops.loops) {
    if (l.lastState === 'failed' || l.lastState === 'error') {
      anomalies.push({ kind: 'errored_loop', entity: l.id, detail: `last cycle ${l.lastState}`, since: l.at });
    }
  }

  // 스케줄 헬스 — stale(미발화)·errored. 오케스트레이터 크론은 별 kind 로 승격.
  //   grace 10분 — 분 경계 오탐(overdue ~0m: 방금 발화했거나 곧 발화·last_run 미갱신)이
  //   셀프교정 크론의 헛알림을 쏘지 않도록 실제 유실만 잡는다(대표 지적 2026-07-10).
  const STALE_GRACE_MS = 10 * 60_000;
  if (snap.schedules) {
    for (const s of snap.schedules.stale) {
      if (s.overdueMs < STALE_GRACE_MS) continue; // 경계 오탐 skip
      const orch = /orchestrator|trade/i.test(s.name);
      anomalies.push({
        kind: orch ? 'orchestrator_stale' : 'schedule_stale',
        entity: s.name, detail: `예정 지났는데 미실행(overdue ${Math.round(s.overdueMs / 60000)}m)`,
        ...(s.lastRun ? { since: s.lastRun } : {}),
      });
    }
    for (const e of snap.schedules.errored) {
      anomalies.push({ kind: 'schedule_error', entity: e.name, detail: `마지막 실행 error`, ...(e.lastRun ? { since: e.lastRun } : {}) });
    }
  }

  // Graph-run history is independent of ops_events loops and of log-store failures.
  try {
    const loops = (opts.graphLoopRuns ?? defaultGraphLoopRuns)();
    const nowMs = (opts.now ?? new Date()).getTime();
    let flagged = 0;
    for (const loop of loops) {
      if (!loop.enabled) continue;
      const runs = [...loop.runs].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
      const failures = [] as typeof runs;
      for (const run of runs) {
        if (run.status !== 'failed') break;
        failures.push(run);
      }
      const first = failures.at(-1);
      if (failures.length < 2 || !first || !Number.isFinite(Date.parse(first.at)) || nowMs - Date.parse(first.at) <= 24 * 3600_000) continue;
      anomalies.push({
        kind: 'repeated_failure', entity: `loop:${loop.id}`,
        detail: `그래프 루프 ${loop.id} 연속 실패 ${failures.length}회 · ${first.at} 부터 · 마지막 실패 노드 ${failures[0]!.failedNodes.join(', ')}`,
        since: first.at,
      });
      flagged++;
    }
    debug.log('ops.health', 'graph-loop-failure', { loops: loops.length, flagged });
  } catch (err) {
    debug.log('ops.health', 'graph-loop-failure-skipped', { reason: redactSecretText(err instanceof Error ? err.message : String(err)) });
  }

  // Independent log check: an unreadable log store must not hide task/loop/schedule anomalies.
  try {
    const recentLogs = opts.recentLogs ?? (() => {
      const path = logsDbPath();
      if (!existsSync(path)) return [];
      const store = LogStore.openReadOnly(path);
      try { return readRecentFailureLogs(store, (opts.now ?? new Date()).getTime()); }
      finally { store.close(); }
    });
    const groups = detectRepeatedFailures(recentLogs());
    for (const group of groups) {
      anomalies.push({
        kind: 'repeated_failure', entity: redactSecretText(group.key),
        detail: redactSecretText(explainFailure(group)), since: group.firstTs,
      });
    }
    debug.log('ops.health', 'repeated-failure', { groups: groups.length, topCount: groups[0]?.count ?? 0 });
  } catch (err) {
    debug.log('ops.health', 'repeated-failure-skipped', { reason: redactSecretText(err instanceof Error ? err.message : String(err)) });
  }

  return { healthy: anomalies.length === 0, anomalies, generatedAt: snap.generatedAt };
}

export interface OpsTimelineOpts extends OpsStatusOpts {
  entityType?: OpsEntityType;
  event?: OpsEventKind;
  sinceHours?: number;
  limit?: number;
}

export interface OpsTimelineEntry {
  ts: string; entityType: string; entityId: string; event: string;
  fromState: string | null; toState: string | null;
  rationale: string | null; actor: string | null;
  refs?: Record<string, unknown>;
}

/** ops_events 최근순 통합 타임라인(entity/event 필터). READ-ONLY·fail-soft. */
export function opsTimeline(opts: OpsTimelineOpts = {}): OpsTimelineEntry[] {
  try {
    const db = openOpsEventsDb(opts.opsDbPath);
    try {
      const rows = queryOpsEvents(db, {
        ...(opts.entityType ? { entityType: opts.entityType } : {}),
        ...(opts.event ? { event: opts.event } : {}),
        sinceHours: opts.sinceHours ?? 48,
        limit: opts.limit ?? 40,
      });
      return rows.map((r) => ({
        ts: r.ts, entityType: r.entity_type, entityId: r.entity_id, event: r.event,
        fromState: r.from_state, toState: r.to_state, rationale: r.rationale, actor: r.actor,
        ...(parseRefs(r) ? { refs: parseRefs(r) } : {}),
      }));
    } finally { db.close(); }
  } catch { return []; }
}

export interface OpsMissionDetail {
  mission: {
    id: string; goal: string; status: string; source: string; disposition: string;
    executionModel: string | null; tier: string | null; engine: string | null;
    rationale: string | null; materializeSpec: string | null;
    createdAt: string; updatedAt: string;
  } | null;
  /** 파생물(관련 크론/태스크/자율행동/하위미션) — traceAutopilotMission fan-in. */
  derived: Array<{ kind: string; id: string; name: string; status: string; detail?: string }>;
  rollup: { total: number; ok: number; stale: number; error: number; active: number; pending: number };
  /** 이 미션의 상태 전이 이력(ops_events entity_type='mission'). */
  transitions: OpsTimelineEntry[];
  /** ★ 페이즈별 상태 + 저장된 진단(P1 · 2026-07-13) — task.notes 의 [DIAGNOSIS]/[SE-PR]/
   *  [CRITIQUE] 를 읽는다(재합성 없음·표면 무관 동일 진단). "P2 왜 실패?"의 1콜 답. */
  phases: OpsMissionPhase[];
  /** 미션별 영속 실행 로그 경로(O3) — 상세 증거는 이 파일(tail). */
  runLogPath: string | null;
  /** 멀티페이즈 플랜 초안(승인 전 검토·V1). 아티팩트 부재 시 null. */
  planDraft: string | null;
  note: string;
}

export interface OpsMissionPhase {
  index: number; id: string; title: string; status: string;
  failClass?: string;
  /** 저장된 진단([DIAGNOSIS] note) — narrative/rootCause/권장 힐/신뢰도. 실패 페이즈만. */
  diagnosis?: { narrative: string; rootCause: string; heal: string; confidence: string };
  prUrl?: string;
  critiqueVerdict?: string;
}

/** 미션 1건 상세(apm_id) — 미션 내용 + 관련 태스크/스케줄/자율행동 fan-in + 상태 전이 이력.
 *  traceAutopilotMission(계보 fan-in) + ops_events(전이) 조합. READ-ONLY·fail-soft. */
export function opsMissionDetail(id: string, opts: OpsStatusOpts = {}): OpsMissionDetail {
  let mission: OpsMissionDetail['mission'] = null;
  let derived: OpsMissionDetail['derived'] = [];
  let rollup: OpsMissionDetail['rollup'] = { total: 0, ok: 0, stale: 0, error: 0, active: 0, pending: 0 };
  try {
    const trace = traceAutopilotMission(id, {
      ...(opts.schedulesDbPath ? { schedulesDb: opts.schedulesDbPath } : {}),
    });
    const m = trace.mission;
    if (m) {
      mission = {
        id: m.id, goal: m.goal, status: m.status, source: m.source,
        disposition: missionDisposition(m.status, m.source),
        executionModel: m.execution_model, tier: m.tier, engine: m.engine,
        rationale: m.rationale, materializeSpec: m.materialize_spec ?? null,
        createdAt: m.created_at, updatedAt: m.updated_at,
      };
    }
    derived = trace.derived.map((d) => ({ kind: d.kind, id: d.id, name: d.name, status: d.status, ...(d.detail ? { detail: d.detail } : {}) }));
    rollup = trace.rollup;
  } catch { /* fail-soft */ }
  const transitions = opsTimeline({ ...(opts.opsDbPath ? { opsDbPath: opts.opsDbPath } : {}), entityType: 'mission', sinceHours: 24 * 30, limit: 20 })
    .filter((e) => e.entityId === id);
  // ★ 페이즈별 상태 + 저장 진단(P1) — notes 가 SoT(run-mission 이 영속·여기선 읽기만). fail-soft.
  let phases: OpsMissionPhase[] = [];
  try {
    const store = opts.missionStore ?? openAutopilotMissionsDb();
    try {
      if (!mission) {
        // trace 는 기본 DB 를 열므로 seam(missionStore) 미션은 못 본다 — 폴백 해석(테스트/격리).
        const m = getMission(store, id);
        if (m) {
          mission = {
            id: m.id, goal: m.goal, status: m.status, source: m.source,
            disposition: missionDisposition(m.status, m.source),
            executionModel: m.execution_model, tier: m.tier, engine: m.engine,
            rationale: m.rationale, materializeSpec: m.materialize_spec ?? null,
            createdAt: m.created_at, updatedAt: m.updated_at,
          };
        }
      }
      const notesById = new Map(store.listTasks({ goalSlug: id }).map((t) => [t.id, t.notes]));
      phases = listPhases(store, id).map((p): OpsMissionPhase => {
        const notes = notesById.get(p.id) ?? [];
        const diag = parseDiagnosisNote(notes);
        const prUrl = prUrlFromNotes(notes);
        const cq = critiqueFromNotes(notes);
        return {
          index: p.index, id: p.id, title: p.title, status: p.status,
          ...(diag?.failClass ? { failClass: diag.failClass } : {}),
          ...(diag ? { diagnosis: { narrative: diag.narrative, rootCause: diag.rootCause, heal: diag.heal, confidence: diag.confidence } } : {}),
          ...(prUrl ? { prUrl } : {}),
          ...(cq.verdict ? { critiqueVerdict: cq.verdict } : {}),
        };
      });
    } finally { if (!opts.missionStore) store.close(); }
  } catch { /* fail-soft */ }
  const runLogPath = mission ? missionRunLogPath(id) : null;
  // V1 — 멀티페이즈 플랜 초안 노출(승인 전 검토). 대표가 goal 만 보고 승인하던 갭 해소.
  let planDraft: string | null = null;
  try {
    const p = (opts.planDraftFor ?? proposalDraftPath)(id);
    if (existsSync(p)) planDraft = readFileSync(p, 'utf-8');
  } catch { /* fail-soft */ }
  const diagnosed = phases.filter((p) => p.diagnosis).length;
  const note = mission
    ? `미션 상세 + 페이즈 ${phases.length}건${diagnosed ? `(진단 ${diagnosed})` : ''} + 파생물 ${derived.length}건(크론/태스크/자율행동) + 전이 ${transitions.length}건${planDraft ? ' + 플랜 초안' : ''}. 처분: ${mission.disposition}.${diagnosed ? ' 실패 페이즈의 diagnosis 에 근본원인+권장 힐(저장 진단).' : ''}`
    : `미션 ${id} 없음(id 확인: elanous ops status 또는 autopilot list).`;
  return { mission, derived, rollup, transitions, phases, runLogPath, planDraft, note };
}

/** ambient 자각용 1-2줄 요약(빈 문자열=이상 없음) — telegram systemPrompt 에 주입해
 *  elanous 가 대화 중 자기 자율 시스템의 이상을 자각한다(recentAutonomyContext 의 자매).
 *  fail-soft. 정상이면 노이즈 없이 빈 문자열. */
export function opsHealthContext(opts: OpsStatusOpts = {}): string {
  try {
    const h = opsHealth(opts);
    if (h.healthy) return '';
    const lines = h.anomalies.slice(0, 5).map((a) => `- [${a.kind}] ${a.entity}: ${a.detail}`);
    const more = h.anomalies.length > 5 ? `\n  (외 ${h.anomalies.length - 5}건 · ops_status action:health)` : '';
    return `운영 상태 경보 (내 자율 시스템 이상 ${h.anomalies.length}건 · 개입은 대표 결정 HITL):\n${lines.join('\n')}${more}`;
  } catch { return ''; }
}
