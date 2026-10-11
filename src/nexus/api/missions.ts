/**
 * `GET /v1/missions` + `GET /v1/missions/:id` — Mission entity surface
 * (M4-3 · 2026-05-12).
 *
 * Mission is a Phase 1 / I6 citizen (TOX_SCHEMA_VERSION=2) — intake-
 * plane's `register_all` groups tasks into mission rows, but until
 * this endpoint shipped there was no read-side surface. M4-3 closes
 * the loop:
 *
 *   GET /v1/missions          → all missions + per-mission task / wf
 *                               summary (Mission ↔ workflow folder).
 *   GET /v1/missions/:id      → single mission + full task rows +
 *                               workflowId per task.
 *
 * Mission ↔ workflow mapping is derived from the existing schema
 * (mission.taskIds → task → task.workflowId) so no new column is
 * needed. The endpoint joins in-process and returns a flat shape the
 * PWA / CLI consume without a second fetch.
 *
 * Query params (list):
 *   status=<MissionStatus>   filter by status (active / planning / ...)
 *   goalSlug=<slug>          filter by goal binding
 *   projectId=<id>          filter by project association
 *
 * Cross-ref:
 *   src/task-orchestrator/store.ts (listMissions · getMission ·
 *     listTasksForMission)
 *   src/task-orchestrator/mission.ts (Mission · MissionStatus types)
 */
import { TaskStore } from '../../task-orchestrator/store.js';
import {
  MISSION_STATUSES,
  type Mission,
  type MissionAutopilot,
  type MissionStatus,
} from '../../task-orchestrator/mission.js';
import type { Task } from '../../task-orchestrator/types.js';
import {
  openSchedulesDb,
  listSchedules,
  scheduleHealth,
} from '../../domains/schedule-registry.js';
import {
  cronRowsToDerived,
  rollupDerived,
  taskStatusToDerived,
  type DerivedJob,
  type MissionRollup,
} from '../../autopilot/mission-trace.js';

import { checkAuth, type MetaApiOpts } from './meta-api.js';
import { jsonResponse } from './http-server.js';

function isMissionStatus(v: unknown): v is MissionStatus {
  return typeof v === 'string'
    && (MISSION_STATUSES as readonly string[]).includes(v);
}

/** Compact card for the list endpoint. Each card carries the per-
 *  mission task counts + surface mix so the PWA lane can render
 *  without bouncing back for per-task data. */
export interface MissionCardWire {
  id: string;
  title: string;
  description: string | null;
  status: MissionStatus;
  priority: Mission['priority'];
  goalSlug: string | null;
  projectId?: string;
  taskCount: number;
  /** Counts so the PWA mission lane shows progress at a glance. */
  taskStatusCounts: Record<string, number>;
  /** Surface kind distribution — Mission ↔ workflow folder UX shows
   *  which surfaces a mission is wired to (llm-direct, skill, cron,
   *  ...). The Phase 1 intake decompose defaults to 'llm-direct' for
   *  every task; richer surface kinds appear once the user upgrades
   *  individual tasks via the PWA editor. */
  surfaceKindCounts: Record<string, number>;
  /** PFC Layer2 자율 메타 (Mission Fabric 통합 U1). null = 사람이 만든 일반
   *  Mission. 자율 Mission 이면 실행모델·apm 상태·계보 키를 담아 통합 Missions
   *  표면이 autopilot 여부와 lineage 를 한눈에 렌더한다. */
  autopilot: MissionAutopilot | null;
  /** 파생 작업 롤업(태스크 + 크론). ⛔ **결손 수리(MISSIONS-STALE-MARK · 2026-10-11)**:
   *  이 칸이 없어 PWA 미션 카드의 `RollupChips` 는 항상 `undefined` 를 받아
   *  «아무것도» 안 그렸다 — 그래서 «파생 0»과 «파생 미측정»을 화면이 «구분 못 했다».
   *  카드는 목록 엔드포인트만 보므로(미션별 `traceAutopilotMission` 을 안 부름)
   *  여기서 «이미 로드한 태스크» ⊕ «요청당 한 번 읽은 schedule_registry」로
   *  계산한다. 자율행동(surface_events)·자식 미션은 상세 트레이스
   *  (`ops_status action=mission`)의 몫으로 남는다(목록에서 N× 무거운 조인 금지).
   *  매핑은 `rollupDerived`·`taskStatusToDerived`·`cronRowsToDerived` — «단일 소유»라
   *  트레이스와 갈림이 없다. `total: 0` = «파생이 정말 0». */
  derived: MissionRollup;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
}

/** 태스크 행 → 파생물(순수). 트레이스의 `fetchTaskDerived` 와 같은 상태 매핑
 *  (`taskStatusToDerived`)을 쓴다 — «두 가지 상태 어휘»를 만들지 않는다. */
export function taskRowsToDerived(tasks: readonly Task[]): DerivedJob[] {
  return tasks.map((t) => ({
    kind: 'task',
    id: t.id,
    name: t.title,
    status: taskStatusToDerived(t.status),
  }));
}

/** 요청당 «한 번» schedule_registry 를 읽어 apmId 별 크론 파생물을 나눠 담는다.
 *  ⛔ 미션별로 DB 를 열면 목록 N건 = N× 열기 — 그래서 한 번 읽고 in-process 분배.
 *  fail-soft: 레지스트리가 없으면 빈 Map(derived 는 태스크만 집계). */
export function loadCronDerivedByMission(): Map<string, DerivedJob[]> {
  const out = new Map<string, DerivedJob[]>();
  try {
    const db = openSchedulesDb();
    try {
      const rows = listSchedules(db);
      const staleIds = new Set(scheduleHealth(rows).stale.map((s) => s.id));
      const rowsByMission = new Map<string, typeof rows>();
      for (const row of rows) {
        const apmId = row.autopilot_id;
        if (!apmId) continue;
        const bucket = rowsByMission.get(apmId);
        if (bucket) bucket.push(row);
        else rowsByMission.set(apmId, [row]);
      }
      for (const [apmId, missionRows] of rowsByMission) {
        out.set(apmId, cronRowsToDerived(missionRows, staleIds));
      }
    } finally { db.close(); }
  } catch { /* fail-soft */ }
  return out;
}

export function summarise(
  mission: Mission,
  tasks: readonly Task[],
  crons: readonly DerivedJob[] = [],
): MissionCardWire {
  const taskStatusCounts: Record<string, number> = {};
  const surfaceKindCounts: Record<string, number> = {};
  for (const t of tasks) {
    taskStatusCounts[t.status] = (taskStatusCounts[t.status] ?? 0) + 1;
    surfaceKindCounts[t.surface.kind] = (surfaceKindCounts[t.surface.kind] ?? 0) + 1;
  }
  return {
    id: mission.id,
    title: mission.title,
    description: mission.description ?? null,
    status: mission.status,
    priority: mission.priority,
    goalSlug: mission.goalSlug ?? null,
    ...(mission.projectId !== undefined ? { projectId: mission.projectId } : {}),
    taskCount: tasks.length,
    taskStatusCounts,
    surfaceKindCounts,
    autopilot: mission.autopilot ?? null,
    derived: rollupDerived([...taskRowsToDerived(tasks), ...crons]),
    createdAt: mission.createdAt,
    updatedAt: mission.updatedAt,
    closedAt: mission.closedAt ?? null,
  };
}

export function handleMissionsList(
  req: Request,
  opts: MetaApiOpts,
): Response {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  const url = new URL(req.url);
  const statusParam = url.searchParams.get('status');
  const goalSlug = url.searchParams.get('goalSlug') ?? undefined;
  const projectId = url.searchParams.get('projectId') ?? undefined;
  const filter: { status?: MissionStatus; goalSlug?: string; projectId?: string } = {};
  if (statusParam && isMissionStatus(statusParam)) filter.status = statusParam;
  if (goalSlug) filter.goalSlug = goalSlug;
  if (projectId !== undefined) filter.projectId = projectId;

  const store = new TaskStore();
  try {
    const missions = store.listMissions(filter);
    // 크론 레지스트리는 «요청당 한 번»만 읽고 apmId 로 분배(미션별 DB 열기 금지).
    const cronsByMission = loadCronDerivedByMission();
    const cards = missions.map((m) =>
      summarise(
        m,
        store.listTasksForMission(m.id),
        // schedule_registry.autopilot_id 는 계보 키(apmId)다 — TOX 미션 id 와 다를 수 있다.
        cronsByMission.get(m.autopilot?.apmId ?? m.id) ?? cronsByMission.get(m.id) ?? [],
      ),
    );
    return jsonResponse({
      total: cards.length,
      missions: cards,
    }, 200);
  } finally {
    store.close();
  }
}

export function handleMissionDetail(
  req: Request,
  missionId: string,
  opts: MetaApiOpts,
): Response {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  const store = new TaskStore();
  try {
    const mission = store.getMission(missionId);
    if (!mission) return jsonResponse({ error: 'not_found' }, 404);
    const tasks = store.listTasksForMission(mission.id);
    // Same two roll-ups as the list endpoint (taskStatusCounts +
    // surfaceKindCounts) so PWA detail views never need a second
    // pass to compute the lane progress / surface mix.
    const taskStatusCounts: Record<string, number> = {};
    const surfaceKindCounts: Record<string, number> = {};
    for (const t of tasks) {
      taskStatusCounts[t.status] = (taskStatusCounts[t.status] ?? 0) + 1;
      surfaceKindCounts[t.surface.kind] = (surfaceKindCounts[t.surface.kind] ?? 0) + 1;
    }
    return jsonResponse({
      mission,
      tasks,
      taskStatusCounts,
      surfaceKindCounts,
    }, 200);
  } finally {
    store.close();
  }
}
