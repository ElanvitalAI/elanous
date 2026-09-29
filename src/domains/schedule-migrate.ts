// Mission Fabric 통합 U3c — schedule_registry 예약잡 → fabric Task+Schedule Trigger 이관.
//
// 내부 문서 `DECISION-u3-u4-cron-convergence-2026-07-09` (B안·schedule-runner 은퇴).
//
// 두 기능:
//  1. migrateJobToTrigger — 예약잡 1건을 Task(cron surface)+Schedule Trigger 로 이관
//     (Task 생성·데몬 등록·run_via='trigger'·crontab 라인 제거). 되먹임=U3b 브릿지.
//  2. registerScheduledToxTasks — 부팅 재등록 sweep. discoverWorkflows 는 YAML 만 스캔해
//     in-memory tox-task 를 모르므로, 데몬 부팅 때 TaskStore 의 scheduleText 달린
//     비-terminal task 를 재등록해야 이관잡이 재시작 후에도 발화한다.
//
// 레이어링: domains → task-orchestrator(하위 fabric) import OK. 데몬 참조·crontab
// 제거는 주입(테스트 가능·nexus 가 실핸들 배선).

import type { Database } from 'bun:sqlite';
import { debug } from '../debug/log.js';
import type { WorkflowEntry } from '../workflow-runtime/types.js';
import type { TaskStore } from '../task-orchestrator/store.js';
import { taskToWorkflowEntry } from '../task-orchestrator/task-to-workflow.js';
import { isTerminalStatus } from '../task-orchestrator/types.js';
import { listSchedules, markResult, type ScheduleRow } from './schedule-registry.js';
import { defaultCatchupEligible, type SpawnOutcome } from './schedule-runner.js';
import { prevScheduledFire } from './cron-match.js';
import { scheduleJobToTask } from './schedule-to-task.js';

/** Disabled schedules must not be re-registered just because their run_via is trigger. */
export function scheduledRunViaById(rows: readonly ScheduleRow[]): Map<string, string | null> {
  return new Map(rows.map(row => [row.id, row.enabled ? row.run_via : null]));
}

/**
 * 부팅 재등록 — TaskStore 의 scheduleText 달린 비-terminal task 를 workflow 데몬에
 * Schedule Trigger 로 등록. 이관잡(U3c)이 데몬 재시작 후에도 발화하도록 보완.
 * registerWorkflow 실패(중복 등)는 skip 카운트(부팅을 막지 않음).
 */
export function registerScheduledToxTasks(
  store: TaskStore,
  registerWorkflow: (entry: WorkflowEntry) => void,
  /** 레지스트리의 그 잡이 지금 무엇으로 도나(`run_via`). Disabled 잡은 null 로 전달한다. 주면 `trigger` 가 아닌 잡의 파생 task 는 등록하지 않는다.
   *  🩸 2026-09-27: `schedule release` 뒤 남은 파생 task 가 재시작마다 트리거로 다시 등록돼 crontab ⊕ 트리거 두 번 돌 뻔했다. */
  runViaOf?: (jobId: string) => string | null,
): { registered: number; skipped: number; skippedNotTrigger: number } {
  let registered = 0;
  let skipped = 0;
  let skippedNotTrigger = 0;
  for (const task of store.listTasks()) {
    if (!task.scheduleText) continue;
    if (isTerminalStatus(task.status)) { skipped++; continue; }
    if (task.schedulerJobId && runViaOf) {
      const runVia = runViaOf(task.schedulerJobId);
      if (runVia !== 'trigger') {
        skippedNotTrigger++;
        debug.log('schedule.migrate', 'boot-register-skipped', { taskId: task.id, jobId: task.schedulerJobId, runVia });
        continue;
      }
    }
    try {
      registerWorkflow(taskToWorkflowEntry(task, task.scheduleText));
      registered++;
    } catch {
      skipped++;
    }
  }
  return { registered, skipped, skippedNotTrigger };
}

export interface MigrateJobDeps {
  scheduleDb: Database;
  store: TaskStore;
  /** 데몬 live 등록. 없으면(=CLI·데몬 미가동) 부팅 sweep 에 위임(best-effort). */
  registerWorkflow?: (entry: WorkflowEntry) => void;
  /** crontab 라인 제거(이중발화 방지). 주입 없으면 생략(raw 없는 잡). */
  removeCrontabLine?: (raw: string) => void;
  now?: () => Date;
}

export interface MigrateResult {
  taskId: string;
  workflowName: string;
  registered: boolean;   // 데몬에 live 등록됐나(false=부팅 sweep 대기)
  crontabRemoved: boolean;
}

/**
 * schedule_registry 예약잡 → fabric Task(cron surface)+Schedule Trigger 이관(B안).
 * 멱등 아님 — 이미 'trigger' 면 throw(재이관 방지). release/revert 는 setRunVia 로.
 */
export function migrateJobToTrigger(deps: MigrateJobDeps, jobId: string): MigrateResult {
  const job = listSchedules(deps.scheduleDb).find((r) => r.id === jobId);
  if (!job) throw new Error(`schedule job 없음: ${jobId}`);
  if (job.run_via === 'trigger') throw new Error(`이미 trigger 로 이관됨: ${jobId}`);
  if (!job.command) throw new Error(`command 없는 잡은 이관 불가: ${jobId}`);

  const now = deps.now?.();
  const task = scheduleJobToTask(job, now ? { now: now.getTime() } : undefined);
  deps.store.saveTask(task);

  const entry = taskToWorkflowEntry(task, task.scheduleText!);
  let registered = false;
  if (deps.registerWorkflow) {
    deps.registerWorkflow(entry); // 실패 시 throw → 호출자에 전파(이관 롤백 판단)
    registered = true;
  }

  deps.scheduleDb.run(`UPDATE schedule_registry SET source = 'trigger', enabled = 1, disabled_reason = NULL, run_via = 'trigger' WHERE id = ?`, [jobId]);

  let crontabRemoved = false;
  if (job.raw && deps.removeCrontabLine) {
    deps.removeCrontabLine(job.raw);
    crontabRemoved = true;
  }

  return { taskId: task.id, workflowName: entry.definition.name, registered, crontabRemoved };
}

// ── U4b — 이관잡(run_via='trigger') catch-up 자기회복 ────────────────────────
// workflow Schedule Trigger(node-cron)는 놓친 발화를 복구하지 않는다. schedule-runner
// 가 elanous 잡에 제공하던 catch-up 자기회복(랩탑 슬립/데몬 다운으로 놓친 일간 잡 복구)을
// 이관잡에도 보존한다. 정시 발화는 Schedule Trigger 데몬이, 놓친 발화 복구만 이 sweep 이.
// 복구는 schedule-runner 와 동일하게 command 직접 spawn(BashNode 도 결국 /bin/bash -c
// command)·markResult(via='catchup'). 매매류는 defaultCatchupEligible 이 제외.

/** schedulerJobId 로 이관 tox task 찾기(없으면 null). CRUD 가 trigger 잡의
 *  파생 Task 를 관리하려면 필요(schedule_registry.id ↔ tox_tasks.scheduler_job_id). */
export function findScheduledTaskId(store: TaskStore, jobId: string): string | null {
  for (const t of store.listTasks()) {
    if (t.schedulerJobId === jobId) return t.id;
  }
  return null;
}

/**
 * 이관(trigger) 잡 삭제 — 파생 tox task 제거(부팅 sweep 재등록 방지) + registry 행 삭제.
 * 데몬에 live 등록된 Schedule Trigger 는 unregister API 부재로 재시작해야 발화 정지
 * (task 삭제됐으니 재시작 후 boot sweep 이 재등록 안 함 = 소멸).
 */
export function deleteTriggerJob(
  store: TaskStore,
  jobId: string,
): { taskDeleted: boolean } {
  const taskId = findScheduledTaskId(store, jobId);
  const taskDeleted = taskId ? store.deleteTask(taskId) : false;
  return { taskDeleted };
}

export interface CatchUpTriggerDeps {
  spawn: (command: string) => Promise<SpawnOutcome>;
  now?: () => Date;
  graceMs?: number;                              // 놓친 발화 복구 상한(기본 6h)
  eligible?: (j: ScheduleRow) => boolean;        // catch-up 대상(기본 매매 제외)
}

/**
 * run_via='trigger' 잡의 놓친 발화를 last_run 기준으로 1회 복구.
 * 부팅 직후 + 주기적(데몬 wake) 호출. schedule-runner sweep 로직을 trigger 잡에 이식.
 */
export async function catchUpTriggerJobs(
  db: Database,
  deps: CatchUpTriggerDeps,
): Promise<{ recovered: string[] }> {
  const now = (deps.now ?? (() => new Date()))();
  const grace = deps.graceMs ?? 6 * 3600_000;
  const eligible = deps.eligible ?? defaultCatchupEligible;
  const recovered: string[] = [];
  for (const j of listSchedules(db)) {
    if (j.run_via !== 'trigger' || !j.enabled || !j.cron || !j.command) continue;
    if (!eligible(j)) continue;
    const prev = prevScheduledFire(j.cron, now, grace);
    if (!prev) continue;
    // 현재 tick window(90s)는 Schedule Trigger 가 정시 발화 → 건드리지 않음(더블파이어 방지).
    if (now.getTime() - prev.getTime() < 90_000) continue;
    const lr = j.last_run ? Date.parse(j.last_run) : 0;
    if (Number.isFinite(lr) && lr >= prev.getTime()) continue; // 이미 실행됨
    const res = await deps.spawn(j.command);
    markResult(db, j.id, {
      at: now.toISOString(),
      status: res.code === 0 ? 'ok' : 'error',
      exit: res.code,
      durationMs: res.ms,
      via: 'catchup',
      error: res.code === 0 ? undefined : (res.error ?? `catchup exit ${res.code}`),
    });
    recovered.push(j.id);
  }
  return { recovered };
}
