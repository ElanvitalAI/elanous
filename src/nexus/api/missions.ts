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
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
}

export function summarise(mission: Mission, tasks: readonly Task[]): MissionCardWire {
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
    const cards = missions.map((m) =>
      summarise(m, store.listTasksForMission(m.id)),
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
