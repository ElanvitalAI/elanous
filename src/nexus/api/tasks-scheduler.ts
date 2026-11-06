// NEXUS T5.G — task board APIs lift.
//
// `/v1/tasks` · `/v1/tasks/:id` previously lived only in
// `src/boot/daemon-public-server.ts`. After T5.F made the daemon-
// public-server tab default-OFF (`elanous nexus` is the SSoT), the PWA —
// which now points at NEXUS baseUrl — hit a 404 on the task board
// endpoints because they were never lifted.
//
// dry-run data is persisted to `~/.elanous/tasks/tasks.db` (env:
// `ELANOUS_TASKS_DB`) and the store is a process singleton, so this
// lift is zero-migration: NEXUS dispatches into the same `TaskStore`
// the daemon-public-server uses.
//
// Surface-unification v2.2 V2.2-6 v2 (2026-05-11) — companion scheduler
// list / detail endpoints retired together with the dashboard scheduler
// view. The `getSchedulerStore()` linkup → `linkedSchedulerJob` field is
// dropped from task detail; PWA `apps/pwa/src/lib/scheduler-api.ts` is
// retired alongside.

import { TaskStore } from '../../task-orchestrator/store.js';
import type {
  Task,
  TaskExecution,
  TaskStatus,
} from '../../task-orchestrator/types.js';
import { isTerminalStatus } from '../../task-orchestrator/types.js';
import type { MissionArc } from '../../task-orchestrator/mission.js';
import { resolveArcs, arcForPhase } from '../../autopilot/mission-arc.js';
import { latestBuildForPhase } from '../../autopilot/se-build-registry.js';
import { jsonResponse } from './json-response.js';
import { checkAuth, type MetaApiOpts } from './meta-api.js';

interface TaskBoardCard {
  id: string;
  title: string;
  status: TaskStatus;
  priority: Task['priority'];
  surfaceKind: Task['surface']['kind'];
  goalSlug?: string;
  featureName?: string;
  scheduleText?: string;
  schedulerJobId?: string;
  createdAt: number;
  updatedAt: number;
  attempt: number;
  maxRetries: number;
  notesTail: string[];
  acceptanceCount: number;
  lastExecutionStatus?: TaskExecution['status'];
  /** Cascade-zyu Z0 (2026-05-12) — Showroom anchor surface. When set,
   *  the PWA task card renders an "Open in showroom" affordance that
   *  jumps to `/showroom?session=<id>`. */
  showroomSessionId?: string;
  // ── 미션/아크 연관(2026-07-14) — 이 태스크가 미션 페이즈면 어느 미션·아크·페이즈인지.
  //    "미션이 빌드한 것 = 태스크" 통합 가시성. goalSlug=apm_* subagent 태스크에만 채워짐.
  /** 미션 페이즈면 그 미션 제목. */
  missionTitle?: string;
  /** 이 페이즈가 속한 아크 id(멀티아크 미션만). */
  arcId?: string;
  /** 아크 이름(예: "관측 계약"). */
  arcName?: string;
  /** 아크 순번(0-based). */
  arcIndex?: number;
  /** 아크 내 페이즈 순번(1-based). */
  phaseIndexInArc?: number;
  /** 아크 내 총 페이즈 수 — "2/3" 표시용. */
  arcTotalPhases?: number;
  /** 아크 상태(pending/active/verifying/done/failed) — 배리어·통합검증 가시화. */
  arcStatus?: string;
  /** 빌드 중(running) 페이즈의 실 SE 빌드 정보(2026-07-14) — 지금 무슨 빌드가 도는지. */
  build?: { buildId: string; backend: string; status: string; attemptSeq: number; maxTurns?: number };
}

/** 미션 컨텍스트 — 미션 id → 제목 + 아크. N+1 방지(1회 로드). */
type MissionCtx = Map<string, { title: string; arcs: readonly MissionArc[] }>;

/** 미션 컨텍스트 1회 로드 — 미션 id → {제목, 아크}. 모든 미션을 훑어 map 구성(N+1 방지). */
function buildMissionCtx(store: TaskStore): MissionCtx {
  const ctx: MissionCtx = new Map();
  try {
    for (const m of store.listMissions()) {
      ctx.set(m.id, { title: m.title, arcs: m.autopilot?.arcs ?? [] });
    }
  } catch { /* fail-soft — 미션 컨텍스트 없이 진행 */ }
  return ctx;
}

/** 태스크의 미션/아크 연관 해석 — goalSlug 가 미션 id 면 제목+아크(멀티아크만) 필드 산출. */
function resolveMissionArcFields(task: Task, ctx: MissionCtx | undefined): Partial<TaskBoardCard> {
  const missionId = task.goalSlug;
  if (!missionId || !ctx) return {};
  const m = ctx.get(missionId);
  if (!m) return {};
  const fields: Partial<TaskBoardCard> = { missionTitle: m.title };
  // 명시 아크가 있을 때만 아크 필드(flat=암묵1아크는 표시 안 함 — 노이즈 방지).
  if (m.arcs.length > 0) {
    const arc = arcForPhase(resolveArcs(m.arcs, [task.id]), task.id);
    if (arc && arc.arcId !== 'arc_default_0') {
      const idx = m.arcs.findIndex((a) => a.arcId === arc.arcId);
      fields.arcId = arc.arcId;
      fields.arcName = arc.name;
      fields.arcIndex = idx >= 0 ? idx : undefined;
      fields.phaseIndexInArc = arc.phaseIds.indexOf(task.id) + 1;
      fields.arcTotalPhases = arc.phaseIds.length;
      fields.arcStatus = arc.status;
    }
  }
  return fields;
}

function summarizeTask(
  task: Task,
  lastExecution: TaskExecution | null,
  missionCtx?: MissionCtx,
): TaskBoardCard {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    surfaceKind: task.surface.kind,
    goalSlug: task.goalSlug,
    featureName: task.featureName,
    scheduleText: task.scheduleText,
    schedulerJobId: task.schedulerJobId,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    attempt: task.attempt,
    maxRetries: task.maxRetries,
    notesTail: task.notes.slice(-3),
    acceptanceCount: task.acceptance?.criteria.length ?? 0,
    lastExecutionStatus: lastExecution?.status,
    showroomSessionId: task.showroomSessionId,
    ...resolveMissionArcFields(task, missionCtx),
    ...resolveBuildField(task),
  };
}

/** running 페이즈의 실 SE 빌드 정보(지금 도는 빌드) — running 태스크에만 조회(경량). */
function resolveBuildField(task: Task): Partial<TaskBoardCard> {
  if (task.status !== 'running') return {};
  try {
    const b = latestBuildForPhase(task.id);
    if (!b) return {};
    return { build: { buildId: b.buildId, backend: b.backend, status: b.status, attemptSeq: b.attemptSeq, ...(b.maxTurns ? { maxTurns: b.maxTurns } : {}) } };
  } catch { return {}; }
}

function countBy<T extends string>(items: readonly T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[item] = (out[item] ?? 0) + 1;
  return out;
}

export function handleTasksList(req: Request, opts: MetaApiOpts): Response {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  const store = new TaskStore();
  try {
    const tasks = store.listTasks();
    const missionCtx = buildMissionCtx(store); // 미션/아크 연관 1회 로드.
    const cards = tasks.map((task) =>
      summarizeTask(
        task,
        task.lastExecutionId ? store.getExecution(task.lastExecutionId) : null,
        missionCtx,
      ),
    );
    const open = tasks.filter((task) => !isTerminalStatus(task.status)).length;
    const terminal = tasks.length - open;
    return jsonResponse({
      summary: {
        total: tasks.length,
        open,
        terminal,
        // Surface-unification v2.2 V2.2-6 v2 — `linkedScheduler` summary
        // count retired (was the number of tasks with a non-null
        // `schedulerJobId` pointing at the legacy scheduler store).
        byStatus: countBy(tasks.map((task) => task.status)),
        byPriority: countBy(tasks.map((task) => task.priority)),
      },
      tasks: cards,
    }, 200);
  } finally {
    store.close();
  }
}

export function handleTaskDetail(
  req: Request,
  taskId: string,
  opts: MetaApiOpts,
): Response {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  const store = new TaskStore();
  try {
    const task = store.getTask(taskId);
    if (!task) return jsonResponse({ error: 'not_found' }, 404);
    const executions = store.listExecutions(taskId, 12);
    const events = store.listEvents({ taskId, limit: 40 });
    // Surface-unification v2.2 V2.2-6 v2 — `linkedSchedulerJob` field
    // retired (was the joined ScheduledJob from the legacy scheduler
    // store · workflow scheduleTrigger 가 흡수).
    return jsonResponse({
      task,
      executions,
      events,
    }, 200);
  } finally {
    store.close();
  }
}
