// ── Autopilot Mission Trace (AL3 · 2026-07-09) ────────────────────────────
//
// 대표 지시: "tool 로 내용 조회가 가능해야." 미션(apm_id)이 만든 파생물을 흩어진
// store 에서 fan-in 조인 → 미션 트리 + 각 live 상태 + 롤업. 제자리 태깅(AL2)의
// 수확: 크론=schedule_registry.autopilot_id · 태스크=tox_tasks.goal_slug/
// generated_by · 자율행동=surface_events.refs.autopilotId. 각 store 의 native
// 상태(P1-P3 scheduleHealth·TOX status·autonomy)를 그대로 읽는다.
//
// 순수 매퍼/롤업(테스트) + fail-soft 라이브 페처(각 store 없으면 빈 배열).

import { Database } from 'bun:sqlite';
import {
  openSchedulesDb, listSchedules, scheduleHealth, type ScheduleRow,
} from '../domains/schedule-registry.js';
import { openAutopilotMissionsDb, getMission, getChildMissionIds, type MissionRow } from './mission-registry.js';
import { latestMissionRouteDecision } from './mission-route-decision.js';
import { TaskStore } from '../task-orchestrator/store.js';
import type { RouteDecision } from '../llm/route-decision.js';
import { formatDateTime } from '../time/format.js';
import { conatusPath } from '../domains/conatus-data-dir.js';

export type DerivedKind = 'cron' | 'task' | 'action' | 'mission';
export type DerivedStatus = 'ok' | 'stale' | 'error' | 'active' | 'done' | 'pending';

export interface DerivedJob {
  kind: DerivedKind;
  id: string;
  name: string;
  status: DerivedStatus;
  detail?: string;      // cron 식·last_run·task status 등 사람용 한 줄
}

export interface MissionRollup {
  total: number; ok: number; stale: number; error: number; active: number; pending: number;
}

export interface MissionTrace {
  mission: MissionRow | null;
  derived: DerivedJob[];
  rollup: MissionRollup;
  routeDecision: RouteDecision | null;
}

// ── 순수 매퍼 ──────────────────────────────────────────────────────────

/** 크론 행 → 파생 상태(P1-P3 실행추적 해석). stale > error > ok. */
export function cronToDerived(row: ScheduleRow, isStale: boolean): DerivedJob {
  let status: DerivedStatus;
  if (isStale) status = 'stale';
  else if (row.last_status === 'error') status = 'error';
  else if (row.last_run) status = 'ok';
  else status = 'pending';
  const detail = [row.cron, row.last_run ? `last ${formatDateTime(row.last_run)}` : '미실행']
    .filter(Boolean).join(' · ');
  return { kind: 'cron', id: row.id, name: row.name, status, detail };
}

/** TOX task status → 파생 상태. done→done · running→active · failed/blocked→error · 그외→pending. */
export function taskStatusToDerived(status: string): DerivedStatus {
  const s = status.toLowerCase();
  if (s === 'done' || s === 'completed') return 'done';
  if (s === 'running' || s === 'in_progress' || s === 'active') return 'active';
  if (s === 'failed' || s === 'error' || s === 'blocked') return 'error';
  return 'pending';
}

/** 하위 미션(coordinator child) status → 파생 상태. done→done·running→active·
 *  failed→error·armed/proposed/disarmed→pending. */
export function missionStatusToDerived(status: string): DerivedStatus {
  const s = status.toLowerCase();
  if (s === 'done' || s === 'completed') return 'done';
  if (s === 'running' || s === 'active') return 'active';
  if (s === 'failed' || s === 'error') return 'error';
  return 'pending';
}

/** 파생물 롤업 집계(순수). */
export function rollupDerived(derived: DerivedJob[]): MissionRollup {
  const r: MissionRollup = { total: derived.length, ok: 0, stale: 0, error: 0, active: 0, pending: 0 };
  for (const d of derived) {
    if (d.status === 'stale') r.stale++;
    else if (d.status === 'error') r.error++;
    else if (d.status === 'active') r.active++;
    else if (d.status === 'ok' || d.status === 'done') r.ok++;
    else r.pending++;
  }
  return r;
}

// ── 라이브 페처 (fail-soft) ───────────────────────────────────────────

export interface TracePaths { schedulesDb?: string; tasksDb?: string; surfaceEventsDb?: string }

/** 크론 행 목록 → 파생물(순수 · 행→DerivedJob 매핑의 «단일 소유»).
 *  ⛔ 목록 화면(`/v1/missions` 카드)도 이 함수를 쓴다 — 크론 매핑을 두 번
 *  쓰면 「트레이스는 stale 인데 카드는 ok」 갈림이 생긴다.
 *  `staleIds` 는 `scheduleHealth(rows).stale` 로 «한 번» 구해 넣는다. */
export function cronRowsToDerived(
  rows: readonly ScheduleRow[],
  staleIds: ReadonlySet<string>,
): DerivedJob[] {
  return rows.map(r => cronToDerived(r, staleIds.has(r.id)));
}

/** 크론 파생물 — schedule_registry.autopilot_id = apmId + scheduleHealth 상태. */
function fetchCronDerived(apmId: string, schedulesDb?: string): DerivedJob[] {
  try {
    const db = openSchedulesDb(schedulesDb);
    try {
      const rows = listSchedules(db);
      const staleIds = new Set(scheduleHealth(rows).stale.map(s => s.id));
      return cronRowsToDerived(rows.filter(r => r.autopilot_id === apmId), staleIds);
    } finally { db.close(); }
  } catch { return []; }
}

/** 태스크 파생물 — tox_tasks.goal_slug = apmId OR generated_by_json 에 apmId 포함. */
function fetchTaskDerived(apmId: string, tasksDb: string): DerivedJob[] {
  try {
    const db = new Database(tasksDb, { readonly: true });
    try {
      const rows = db.prepare(
        `SELECT id, title, status FROM tox_tasks
          WHERE goal_slug = ? OR (generated_by_json IS NOT NULL AND generated_by_json LIKE ?)`,
      ).all(apmId, `%${apmId}%`) as Array<{ id: string; title: string; status: string }>;
      return rows.map(t => ({
        kind: 'task' as const, id: t.id, name: t.title,
        status: taskStatusToDerived(t.status), detail: `task · ${t.status}`,
      }));
    } finally { db.close(); }
  } catch { return []; }
}

/** 자율행동 파생물 — surface_events.refs 에 apmId 포함(kind=autonomy). */
function fetchActionDerived(apmId: string, surfaceEventsDb: string): DerivedJob[] {
  try {
    const db = new Database(surfaceEventsDb, { readonly: true });
    try {
      const rows = db.prepare(
        `SELECT id, summary, ts FROM events
          WHERE refs IS NOT NULL AND refs LIKE ? ORDER BY ts DESC LIMIT 50`,
      ).all(`%${apmId}%`) as Array<{ id: string; summary: string; ts: string }>;
      return rows.map(a => ({
        kind: 'action' as const, id: a.id, name: (a.summary ?? '').slice(0, 80),
        status: 'done' as DerivedStatus, // `a.ts?.slice(...)` 와 동치 — falsy 처리 변경 아님(빈 문자열도 종전처럼 미표시).
        detail: a.ts ? formatDateTime(a.ts) : undefined,
      }));
    } finally { db.close(); }
  } catch { return []; }
}

/** 하위 미션 파생물(coordinator 계층) — childMissionIds fan-in. fail-soft. */
function fetchChildMissionDerived(apmId: string): DerivedJob[] {
  try {
    const db = openAutopilotMissionsDb();
    try {
      return getChildMissionIds(db, apmId).map(childId => {
        const child = getMission(db, childId);
        return {
          kind: 'mission' as const, id: childId,
          name: child?.goal?.slice(0, 80) ?? childId,
          status: child ? missionStatusToDerived(child.status) : 'pending',
          detail: `하위 미션 · ${child?.status ?? '없음'}${child?.execution_model ? ` · ${child.execution_model}` : ''}`,
        };
      });
    } finally { db.close(); }
  } catch { return []; }
}

/** 미션 fan-in 트레이스(라이브). 각 store 는 fail-soft(없으면 빈 배열). */
export function traceAutopilotMission(apmId: string, paths: TracePaths = {}): MissionTrace {
  const tasksDb = paths.tasksDb ?? `${homeDir()}/.elanous/tasks/tasks.db`;
  const surfaceDb = paths.surfaceEventsDb ?? conatusPath('surface_events.db');
  let mission: MissionRow | null = null;
  try {
    const mdb = openAutopilotMissionsDb();
    try { mission = getMission(mdb, apmId); } finally { mdb.close(); }
  } catch { mission = null; }
  const derived = [
    ...fetchCronDerived(apmId, paths.schedulesDb),
    ...fetchTaskDerived(apmId, tasksDb),
    ...fetchActionDerived(apmId, surfaceDb),
    ...fetchChildMissionDerived(apmId),
  ];
  let routeDecision: RouteDecision | null = null;
  try {
    const store = new TaskStore({ path: tasksDb });
    try { routeDecision = latestMissionRouteDecision(apmId, { store }); } finally { store.close(); }
  } catch { /* trace stays fail-soft */ }
  return { mission, derived, rollup: rollupDerived(derived), routeDecision };
}

function homeDir(): string {
  // 지연 import 회피 — process.env.HOME 우선(데몬 env 상속).
  return process.env.HOME ?? '';
}
