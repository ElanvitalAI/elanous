// ── Autopilot Scheduler Engine (엔진 실배선 1 · 2026-07-09) ────────────────
//
// 대표 지시: triage→엔진 실배선. 첫 엔진 = scheduler(가장 구체적·apm_id 태깅
// 경로 AL2 준비됨). 오토파일럿이 골에서 스케줄을 추론(지능)하고, 명시적 command
// 와 함께 cron 을 생성하며 apm_id 계보를 자동 연결한다.
//
// 안전 경계(오토파일럿 disarmed·HITL 원칙 준수):
//   · command 자동생성 안 함 — 임의 명령 실행 위험. command 는 호출측이 명시(HITL).
//   · cron 생성은 schedule_manage(단일 창구·자동 백업·cd/bun/로그 강제) 경유만.
//   · 스케줄 추론(NL→cron)만 자동 — 실행 아님(안전). 추론 실패 시 호출측이 cron 명시.

import { tierModel } from '../llm/model-defaults.js';
import { openAutopilotMissionsDb, getMission, setMissionSpec, listMissions, type MissionRow } from './mission-registry.js';
import { missionLifecycleGate } from './mission-lifecycle-gate.js';
import { debug } from '../debug/log.js';
import { elanousStateRoot } from './state-paths.js';
import { dispatchScheduleManage } from '../domains/schedule-manage-tool.js';
import { loadMaterializeMandate, evaluateMaterializeMandate, type MaterializeMandate } from './materialize-mandate.js';
import { TaskStore } from '../task-orchestrator/store.js';
import { createTask, TASK_DEFAULTS } from '../task-orchestrator/types.js';
import { COORDINATOR_OBSERVE_COMMAND, COORDINATOR_OBSERVE_CRON } from './coordinator-mission.js';
import { proposalDraftPath } from './build/build-target.js';
import { getDomainPack } from './domain/registry.js';
import { hashGoal, filesScopeSha } from './mission-grounding-cache.js';
import {
  decideBaselineReuse, formatBaselineSection, loadBaselineFingerprint, saveBaselineFingerprint,
  type DecompBaseline, type BaselineArcView, type BaselinePhaseView,
} from './mission-decompose-baseline.js';
import { executeApprovedMission } from './mission-executor.js';
import { deliverMissionPhases, type CourierDeps } from './track-courier.js';
import { getUserConfig } from '../user-config.js';
import type { DecomposeCallable } from '../task-orchestrator/generator.js';
import type { ProposedTask } from '../task-orchestrator/generator-schema.js';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, openSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { getElanousConfigDir } from '../elanous-config-dir.js';

/** task 미션 1회 집행 — scripts/run-mission.ts <id> 를 detached 로 spawn(디스패처 불요).
 *  데몬 이벤트루프 무차단·결과는 run-mission 이 sendOutbound 로 발송. fail-soft(스크립트 없으면 no-op).
 *  export — rerunMission(mission-lifecycle) 등이 동일 spawn 을 재사용(단일 출처). */
/** ★ 미션별 영속 실행 로그 경로(대표 2026-07-13·PLAN O3) — 공유 휘발 /tmp 대신 미션별
 *  durable 경로. spawn(리다이렉트)과 run-mission(evidenceRefs)이 같은 경로를 쓰도록 단일 출처. */
export function missionRunLogPath(missionId: string): string {
  const safe = (missionId || 'unknown').replace(/[^\w.-]/g, '_').slice(0, 80);
  return join(elanousStateRoot(), 'conatus/missions', safe, 'run.log');
}

export function defaultSpawnRunMission(missionId: string): boolean {
  if (process.env.NODE_ENV === 'test') return false; // 테스트 격리 — 실 detached spawn 방지(재개 안 됨).
  const candidates = [
    join(process.cwd(), 'scripts/run-mission.ts'),
    join(import.meta.dir, '../../scripts/run-mission.ts'),
  ];
  const script = candidates.find((p) => existsSync(p));
  if (!script) return false;
  // stdio 를 미션별 로그파일로(PLAN O3) — 이전엔 공유 /tmp/run-mission.log(휘발·미션 섞임·비쿼리).
  // 이제 ~/.elanous/conatus/missions/<id>/run.log 로 미션별 영속(진단 evidenceRefs 가 가리킴).
  let stdio: 'ignore' | ['ignore', number, number] = 'ignore';
  try {
    const logPath = missionRunLogPath(missionId);
    mkdirSync(dirname(logPath), { recursive: true });
    const fd = openSync(logPath, 'a');
    stdio = ['ignore', fd, fd];
  } catch { /* fail-soft */ }
  // ★ 인스턴스 스코프 전파(ISO·2026-07-19 조율자 인프라 후속) — config-dir 는 setElanousConfigDir
  // in-process override 라 env 로 상속 안 됨(config-dir-unify: env 미러 제거). 형제 경로
  // se-mission-prepare(mission-prepare-spawn.ts:56)처럼 argv 로 재전달해야 자식 run-mission 이
  // 데몬과 같은 config(게이트·예산)/tasks.db(격리 테스트면 .elanous-test)를 읽는다. 미전파 시 자식이
  // 항상 ~/.elanous/config.json 을 읽어 "데몬 시작 후 config 변경이 미반영"(재시작 필요) — tiny 예산이
  // 안 먹힌 근본. 자식이 첫 줄에서 --config-dir 을 strip(applyConfigDirFlagFromArgv) → argv[2]=missionId 유지.
  try {
    const child = spawn(process.execPath, [script, '--config-dir', getElanousConfigDir(), missionId], { detached: true, stdio });
    // ★ detached child 실패(ENOENT 등)는 비동기 error 이벤트 — 부모가 unref 후 곧 exit 하므로 완벽 관측은
    //   불가(fire-and-forget 설계·데몬 무차단). best-effort 로 error 를 관측(자기인지·재개 실패 흔적).
    child.on('error', (e) => { try { debug.log('mission.exec.split-resume', 'respawn-child-error', { missionId, error: e instanceof Error ? e.message.slice(0, 120) : String(e) }, { level: 'error' }); } catch { /* fail-soft */ } });
    child.unref();
    return true; // spawn 동기 호출 성공(child 실행 결과는 detached 라 새 프로세스 run.log/락으로 드러남).
  } catch (e) {
    // 동기 spawn 실패(드묾·실행파일/권한) — false 반환해 호출자가 respawn-failed 관측(정지 탐지).
    try { debug.log('mission.exec.split-resume', 'respawn-spawn-failed', { missionId, error: e instanceof Error ? e.message.slice(0, 120) : String(e) }, { level: 'error' }); } catch { /* fail-soft */ }
    return false;
  }
}

/** 골 텍스트 → cron 식 추론(휴리스틱·순수). 못 찾으면 null(HITL 이 cron 명시). */
export function inferCronSchedule(goal: string): { cron: string; label: string } | null {
  const g = goal.toLowerCase();
  // 시각 추출(N시·N:MM·오전/오후) — 없으면 아침=8, 저녁=20 기본.
  const hourMatch = g.match(/(\d{1,2})\s*시/) ?? g.match(/\b(\d{1,2}):(\d{2})\b/);
  let hour = hourMatch ? Number.parseInt(hourMatch[1]!, 10) : NaN;
  const minute = hourMatch && hourMatch[2] ? Number.parseInt(hourMatch[2], 10) : 0;
  if (/오후|pm\b/.test(g) && hour < 12) hour += 12;
  if (/저녁|밤|evening|night/.test(g) && Number.isNaN(hour)) hour = 20;
  if (/새벽|dawn|이른\s*아침/.test(g) && Number.isNaN(hour)) hour = 5; // "새벽" 미인식 시 요일분기 기본 9시로 잘못 fallback 하던 갭(2026-07-12)
  if (/아침|morning|오전/.test(g) && Number.isNaN(hour)) hour = 8;

  const dow: Record<string, number> = { 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6, 일: 0 };
  // 매분·매시간.
  if (/매분|every minute|매 분/.test(g)) return { cron: '* * * * *', label: '매분' };
  if (/매시간|매 시간|hourly|every hour/.test(g)) return { cron: `${Number.isFinite(minute) ? minute : 0} * * * *`, label: '매시간' };
  // 요일 지정(매주 X요일 / 평일 / 주말).
  const dowKey = Object.keys(dow).find(k => new RegExp(`매주\\s*${k}|${k}요일`).test(g));
  if (dowKey) {
    const h = Number.isFinite(hour) ? hour : 9;
    return { cron: `${minute} ${h} * * ${dow[dowKey]}`, label: `매주 ${dowKey}요일 ${h}시` };
  }
  if (/평일/.test(g)) {
    const h = Number.isFinite(hour) ? hour : 8;
    return { cron: `${minute} ${h} * * 1-5`, label: `평일 ${h}시` };
  }
  if (/매주|weekly/.test(g)) {
    const h = Number.isFinite(hour) ? hour : 9;
    return { cron: `${minute} ${h} * * 1`, label: `매주 월요일 ${h}시` };
  }
  // 매일(명시 or 아침/저녁/시각 단서).
  if (/매일|daily|every day|아침|저녁|밤|morning|오전|오후/.test(g) || Number.isFinite(hour)) {
    const h = Number.isFinite(hour) ? hour : 8;
    return { cron: `${minute} ${h} * * *`, label: `매일 ${h}시` };
  }
  return null;
}

export interface MaterializeInput {
  missionId: string;
  command: string;       // HITL 명시(자동생성 안 함)
  cron?: string;         // 미지정 시 goal 에서 추론
}
export interface MaterializeResult {
  ok: boolean;
  error?: string;
  cron?: string;
  inferred?: boolean;    // cron 을 추론했나
  created?: unknown;     // schedule_manage 결과
}

/** scheduler 미션 → 실제 cron 생성(apm_id 스탬프·schedule_manage 경유). command 필수(HITL). */
export async function materializeSchedulerMission(input: MaterializeInput): Promise<MaterializeResult> {
  const command = input.command?.trim();
  if (!command) return { ok: false, error: 'command 필수(오토파일럿은 명령을 자동생성하지 않음·HITL).' };

  const mdb = openAutopilotMissionsDb();
  let goal = '';
  try {
    const m = getMission(mdb, input.missionId);
    if (!m) { mdb.close(); return { ok: false, error: `미션 없음: ${input.missionId}` }; }
    goal = m.goal;
  } finally { /* mdb 는 아래에서 상태 갱신에 재사용 */ }

  let cron = input.cron?.trim();
  let inferred = false;
  if (!cron) {
    const guess = inferCronSchedule(goal);
    if (!guess) { debug.log('mission.engine.schedule', 'infer-failed', { goal: goal.slice(0, 120) }, { level: 'error' }); mdb.close(); return { ok: false, error: '스케줄 추론 실패 — cron 을 명시해주세요(예: "0 8 * * *").' }; }
    cron = guess.cron; inferred = true;
    debug.log('mission.engine.schedule', 'inferred', { cron, goal: goal.slice(0, 80) });
  }

  // schedule_manage 단일 창구로 생성 + apm_id 계보 스탬프(AL2 경로).
  const created = await dispatchScheduleManage({ action: 'create', cron, command, autopilotId: input.missionId });
  try { missionLifecycleGate(mdb, input.missionId, 'running', 'materialize-cron'); } finally { mdb.close(); }
  return { ok: true, cron, inferred, created };
}

// ── task 엔진 → TOX ──────────────────────────────────────────────────────
// task 미션 → TOX 태스크(backlog·자동실행 아님). goal_slug=apm_id 로 계보 연결
// (AL3 trace 가 tox_tasks.goal_slug/generated_by 로 fan-in). 안전: status=backlog
// 라 자동 집행 안 됨(추적용 백로그 · 실행은 TOX 큐/HITL).

export interface MaterializeTaskInput { missionId: string; prompt?: string }
export interface MaterializeTaskResult { ok: boolean; error?: string; taskId?: string }

export function materializeTaskMission(input: MaterializeTaskInput): MaterializeTaskResult {
  const mdb = openAutopilotMissionsDb();
  try {
    const m = getMission(mdb, input.missionId);
    if (!m) return { ok: false, error: `미션 없음: ${input.missionId}` };
    const prompt = input.prompt?.trim() || m.goal;
    const store = new TaskStore();
    try {
      const task = createTask({
        title: m.goal.slice(0, TASK_DEFAULTS.titleMaxLen), // SSOT 한도(80) 참조 — 120 드리프트로 인한 Task.title>80 throw 근절
        description: prompt,
        surface: { kind: 'subagent', definitionName: 'general-purpose', prompt },
        goalSlug: m.id,                       // 계보: apm_id
        generatedBy: { kind: 'user', actorId: 'autopilot' },
        status: 'backlog',                    // 자동실행 아님(추적용 백로그)
      });
      store.saveTask(task);
      missionLifecycleGate(mdb, input.missionId, 'running', 'materialize-task');
      return { ok: true, taskId: task.id };
    } finally { store.close(); }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 120) : String(e) };
  } finally { mdb.close(); }
}

// ── 엔진 dispatcher — execution model 로 라우팅 ─────────────────────────────
export interface MaterializeMissionResult {
  ok: boolean; error?: string; engine?: string;
  cron?: string; inferred?: boolean; created?: unknown; taskId?: string;
}

/** 미션의 execution_model 에 따라 적절한 엔진으로 materialize. */
export async function materializeMission(
  input: { missionId: string; command?: string; cron?: string; prompt?: string },
): Promise<MaterializeMissionResult> {
  const mdb = openAutopilotMissionsDb();
  let model: string | null = null;
  try { const m = getMission(mdb, input.missionId); model = m?.execution_model ?? null; if (!m) return { ok: false, error: `미션 없음: ${input.missionId}` }; }
  finally { mdb.close(); }

  if (model === 'scheduler') {
    const r = await materializeSchedulerMission({ missionId: input.missionId, command: input.command ?? '', ...(input.cron ? { cron: input.cron } : {}) });
    return { ...r, engine: 'schedule_manage' };
  }
  if (model === 'task') {
    const r = materializeTaskMission({ missionId: input.missionId, ...(input.prompt ? { prompt: input.prompt } : {}) });
    return { ...r, engine: 'tox' };
  }
  if (model === 'monitor-trigger' || model === 'goal-loop') {
    // 외부/도메인 결합 seam(monitor=firecrawl URL·goal-loop=dig arming/finance) — 전용 설계 필요.
    return { ok: false, engine: model === 'goal-loop' ? 'dig' : 'monitor',
      error: `'${model}' 엔진은 전용 seam 배선 전(monitor=외부 firecrawl URL·goal-loop=dig arming/finance 결합). 후속 배선.` };
  }
  if (model === 'coordinator') {
    // C3 실배선 — 조율 미션 → 포트폴리오 오케스트레이터 관측 크론(READ-ONLY·dry·집행 0)을
    // schedule_manage(apm_id 계보 스탬프) 경유 등록. 하위 계약 미션은 createCoordinatorMission
    // 이 이미 자식으로 연결(fan-in). 실 크론 등록은 materialize-mandate arming 게이트 뒤.
    const r = await materializeSchedulerMission({
      missionId: input.missionId, command: COORDINATOR_OBSERVE_COMMAND, cron: COORDINATOR_OBSERVE_CRON,
    });
    return { ...r, engine: 'orchestrator' };
  }
  return { ok: false, engine: model ?? 'unknown',
    error: `'${model}' 은 지속 잡을 만들지 않는 실행모델(single-shot/fanout/hybrid/hitl-delegate).` };
}

// ── V4 자동 분해 + HITL 승인 (2026-07-09) ─────────────────────────────────
// 대표 지시: 텔레그램 발화→미션→**자동 분해 생성 후 HITL 승인**. 미션 생성 즉시
// 골을 backlog subagent 태스크로 구체화(실행 안 함·안전)하고 미션은 proposed 유지
// (승인 대기). 승인 시 태스크 ready(집행)·미션 running. 거절은 cancelMission.
// 안전: subagent 태스크 status=backlog(자동집행 X)·shell command 미생성·미션 상태
// 유지(승인 전 실행 0). scheduler 는 골에서 cron 추론을 추천으로 첨부(실 반복 배선은
// 승인 후 후속). 설계: 내부 문서 `DESIGN-intent-narrow-waist-2026-07-09` §3(V4).

export interface AutoDecomposeResult { ok: boolean; taskId?: string; inferredCron?: string; note?: string; error?: string }

/** 미션 자동 분해 — 골을 backlog subagent 태스크로 구체화(실행 안 함). 미션 proposed 유지.
 *  중복 방지(이미 태스크 있으면 skip). scheduler 면 cron 추론을 spec+설명에 추천 첨부. */
export function autoDecomposeMission(missionId: string, deps: { store?: TaskStore } = {}): AutoDecomposeResult {
  const store = deps.store ?? new TaskStore();
  const owns = !deps.store;
  try {
    const m = getMission(store, missionId);
    if (!m) return { ok: false, error: `미션 없음: ${missionId}` };
    const existing = store.listTasks({ goalSlug: m.id });
    if (existing.length > 0) return { ok: true, taskId: existing[0]!.id, note: '이미 분해됨' };

    const inferred = m.execution_model === 'scheduler' ? inferCronSchedule(m.goal) : null;
    const desc = inferred
      ? `${m.goal}\n\n[추천 스케줄] ${inferred.label} (${inferred.cron}) — 승인 시 반복 배선(후속)`
      : m.goal;
    const task = createTask({
      title: m.goal.slice(0, TASK_DEFAULTS.titleMaxLen), // SSOT 한도(80) 참조 — 긴 골을 title 로 넣어 Task.title>80 throw 하던 근본(단일페이즈 dogfood 크래시)
      description: desc,
      surface: { kind: 'subagent', definitionName: 'general-purpose', prompt: m.goal },
      goalSlug: m.id,                       // 계보: apm_id
      generatedBy: { kind: 'user', actorId: 'autopilot' },
      status: 'backlog',                    // 자동실행 아님 — HITL 승인 대기
    });
    store.saveTask(task);
    if (inferred) setMissionSpec(store, m.id, { prompt: m.goal, cron: inferred.cron });
    return { ok: true, taskId: task.id, ...(inferred ? { inferredCron: inferred.cron } : {}) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 150) : String(e) };
  } finally {
    if (owns) store.close();
  }
}

// ── 크기적응 멀티페이즈 분해 (ref 리서치 2026-07-11) ──────────────────────────
// claude/codex/gemini/grok 공통 원리: 목표의 객관적 복잡도로 분해 여부를 게이팅한다
// (작으면 직접 실행·오버헤드 회피, 크면 멀티페이즈 분해). elanous 는 재료가 이미 있다
// (heuristicTriage tier + TaskGenerator.decompose). 여기서 배선한다:
//   · 작은(light) 미션 → autoDecomposeMission(단일 subagent 태스크·빠름).
//   · 큰(heavy) 미션 → decomposeMissionToPhases(TaskGenerator 로 N 페이즈·dependsOn).
// ★ HITL: 분해 결과는 backlog(실행 X) + 플랜 초안 아티팩트(proposalDraftPath·#3697 노출)
//   로 남겨 대표가 "이렇게 나눠 처리할까요?"를 검토·승인한 뒤 실행한다. heavy 는 human-intent
//   라도 자동 실행 안 함(submitIntent carve-out).

/** 크기 게이트 — heavy tier 면 멀티페이즈 분해 대상. (Codex "단일스텝 plan 금지"와
 *  정합: decompose 가 1태스크만 내면 실제로는 small 이라 폴백.) */
export function shouldPhaseDecompose(m: Pick<MissionRow, 'tier'>): boolean {
  return m.tier === 'heavy';
}

export interface PhaseDecomposeResult {
  ok: boolean; phaseCount: number; taskIds: string[]; planPath?: string; note?: string; error?: string;
}

/** heavy 미션을 정식 TaskGenerator.decompose() 로 N 페이즈(backlog·dependsOn)로 분해하고
 *  플랜 초안(HITL 검토용)을 기록한다. callable 주입(테스트/재사용). 실행은 안 함(승인 후). */
export interface DecomposeCrashContext {
  model: string; effort: string; objectiveChars: number;
  groundingChars: number; researchChars: number; reviseChars: number; maxTasks: number;
}

export interface DecomposeCrashRecord extends DecomposeCrashContext {
  ts: string; missionId: string;
  errorName: string; code: string | null; message: string;
  validationErrors: unknown; rawTextChars: number | null; rawTextHead: string | null;
  stack: string | null;
}

/** 재분해 크래시 진단 레코드(순수) — DecomposeError 가 담은 rawText(실제 LLM 응답)·
 *  validationErrors·code 를 호출 컨텍스트와 함께 보존한다. rawTextChars=0 이면 빈 응답
 *  (토큰/스트리밍 소진 신호), >0 인데 validationErrors 있으면 스키마 위반. 이 구분이
 *  §5.3 근본조사의 핵심(기존 catch 는 e.message.slice(120)만 남겨 이걸 못 봤다). */
export function buildDecomposeCrashRecord(
  missionId: string,
  e: unknown,
  ctx: DecomposeCrashContext,
  nowIso: string,
): DecomposeCrashRecord {
  const de = e as Partial<{ code: string; validationErrors: unknown; rawText: string }> & Partial<Error>;
  return {
    ts: nowIso,
    missionId,
    ...ctx,
    errorName: e instanceof Error ? e.name : typeof e,
    code: de?.code ?? null,
    message: e instanceof Error ? e.message : String(e),
    validationErrors: de?.validationErrors ?? null,
    rawTextChars: typeof de?.rawText === 'string' ? de.rawText.length : null,
    rawTextHead: typeof de?.rawText === 'string' ? de.rawText.slice(0, 1500) : null,
    stack: e instanceof Error ? (e.stack?.slice(0, 1200) ?? null) : null,
  };
}

/** 재분해 크래시 근본조사(대표 2026-07-13·§5.3) — 위 레코드를 durable 로그에 남긴다.
 *  다음 크래시를 1회에 진단 가능하게. fail-soft(로깅 실패가 재분해 흐름을 막지 않음). */
function logDecomposeCrash(missionId: string, e: unknown, ctx: DecomposeCrashContext): void {
  if (process.env.NODE_ENV === 'test') return; // 테스트 격리 — 실 FS 미기록.
  try {
    const rec = buildDecomposeCrashRecord(missionId, e, ctx, new Date().toISOString());
    const path = join(elanousStateRoot(), 'conatus/decompose_crash.log');
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(rec)}\n`);
  } catch { /* fail-soft */ }
}

export async function decomposeMissionToPhases(
  missionId: string,
  deps: { store?: TaskStore; callable?: DecomposeCallable; maxTasks?: number; arcHint?: number; researchContext?: string; codebaseContext?: string; reviseContext?: string; coevolutionContext?: string; decomposeModel?: string; decomposeEffort?: DecomposeEffort;
    // ★ 증분 재분해(대표 2026-07-21·opt-in) — baseline 재사용/무효화 신호(전부 호출측 se-mission-prepare 조립).
    incrementalBaseline?: boolean; redesign?: boolean; fresh?: boolean; groundingFiles?: readonly string[];
    // ★ R2(RFC-driven·opt-in) — 승인된 RFC 에서 결정론 추출한 페이즈(작업항목=페이즈). 있으면 LLM decompose
    //   를 우회하고 이 목록을 그대로 창작·아크분류·영속(sizing 소동 근원 제거). RFC-plan-as-rfc-generation §6.
    presetTasks?: ProposedTask[] } = {},
): Promise<PhaseDecomposeResult> {
  const store = deps.store ?? new TaskStore();
  const owns = !deps.store;
  try {
    const m = getMission(store, missionId);
    if (!m) return { ok: false, phaseCount: 0, taskIds: [], error: `미션 없음: ${missionId}` };

    // ★ 트랜잭셔널 재분해(대표 지시 2026-07-12·#6) — reviseContext(정정)면 옛 페이즈를 지금 지우지
    //   않는다. LLM decompose 가 성공(tasks 확보)한 뒤에만 지운다(아래). decompose 크래시/0-task 면
    //   옛 페이즈를 보존해 "미션이 텅 비는" 사고를 막는다(dogfood: 재분해 크래시로 미션 empty).
    //   정정 아닌데 이미 분해됨(backlog>1)이면 idempotent skip.
    const existing = store.listTasks({ goalSlug: m.id });
    const existingBacklog = existing.filter((t) => t.status === 'backlog');
    if (!deps.reviseContext && existingBacklog.length > 1) {
      return { ok: true, phaseCount: existing.length, taskIds: existing.map((t) => t.id), note: '이미 분해됨' };
    }

    // ★ 부분 수술 재분해(대표 2026-07-22 "기존 히스토리 존중·부분 수술·맥락 존중 스마트 로직") — revise 시
    //   done 페이즈를 보존한다. 종전엔 done/running 포함 **전체 subagent 삭제**(clean reset)라 완료·검증된
    //   작업이 처음부터 재실행됐다(라이브 81b18c: 골분해 재진행 시 done 5개가 전부 재시작). 이제 done 을
    //   유지하고, 재분해 objective 에 "이미 완료됨(재구현 금지·이후만 계획)"을 주입해 남은 작업만 분해(부분
    //   수술)하며, 새 페이즈를 done tail 뒤로 체인해 실행이 done 이후부터 이어지게 한다.
    const donePhases = existing.filter((t) => t.surface.kind === 'subagent' && t.status === 'done').sort((a, b) => a.createdAt - b.createdAt);
    const preserveDone = !!deps.reviseContext && donePhases.length > 0;

    // ★ 증분 재분해 baseline(대표 2026-07-21·opt-in·기본 OFF) — 재분해(revise) 시 이전 분해 전체(아크 +
    //   페이즈 + preflightVerdict)를 baseline 으로 objective 에 주입해 sol 이 전체 재생성 대신 증분 수정하게
    //   한다(reasoning·시간 단축). ★ invalidate 최우선: decideBaselineReuse 가 엄격 조건(revise·골 동일·
    //   grounded 파일 SHA 동일·redesign/fresh 아님·이전 분해 존재)에서만 재사용, 하나라도 어긋나면 폐기(전체
    //   재분해). stale baseline 재사용은 mirage 답습을 낳으므로 절대 놓치지 않는다. 관측=제1원칙(reuse/invalidate 이유).
    let baselineSection = '';
    if (deps.incrementalBaseline && deps.reviseContext) {
      const prevPhases = existing.filter((t) => t.surface.kind === 'subagent').sort((a, b) => a.createdAt - b.createdAt);
      const missionRec = store.getMission(m.id);
      const prevArcs = missionRec?.autopilot?.arcs ?? [];
      const titleById = new Map(prevPhases.map((t) => [t.id, t.title]));
      const arcViews: BaselineArcView[] = prevArcs.map((a) => ({
        name: a.name,
        ...(a.intent ? { intent: a.intent } : {}),
        phaseTitles: a.phaseIds.map((pid) => titleById.get(pid) ?? '').filter(Boolean),
        ...(a.preflightVerdict ? { verdict: a.preflightVerdict.verdict, reason: a.preflightVerdict.reason, action: a.preflightVerdict.action } : {}),
      }));
      const phaseViews: BaselinePhaseView[] = prevPhases.map((t) => ({ title: t.title, acceptance: t.acceptance?.criteria ? [...t.acceptance.criteria] : [] }));
      const baseline: DecompBaseline = { arcs: arcViews, phases: phaseViews, phaseCount: prevPhases.length };
      const decision = decideBaselineReuse({
        enabled: true,
        hasReviseContext: true,
        redesign: deps.redesign === true,
        fresh: deps.fresh === true,
        baselinePhaseCount: prevPhases.length,
        fingerprint: loadBaselineFingerprint(m.id),
        currentGoalHash: hashGoal(m.goal),
        currentGroundingFilesSha: filesScopeSha(deps.groundingFiles ?? []),
      });
      if (decision.reuse) {
        baselineSection = formatBaselineSection(baseline);
        try { debug.log('mission.build.decompose', 'baseline-reuse', { missionId, reason: decision.reason, phases: prevPhases.length, arcs: arcViews.length, flagged: arcViews.filter((a) => a.verdict && a.verdict !== 'founded').length }); } catch { /* fail-soft */ }
      } else {
        try { debug.log('mission.build.decompose', 'baseline-invalidate', { missionId, reason: decision.reason, phases: prevPhases.length }); } catch { /* fail-soft */ }
      }
    }

    // callable: 주입 없으면 기본 provider(streamLLM) 로 구성(lazy import — hot path 회피).
    //   ★ 스트림 관측 — 실 provider 콜(주입 callable 없음)일 때만 미션별 스트림 파일 초기화(재분해마다 새로).
    if (!deps.callable) {
      try { const { startDecomposeStream } = await import('./mission-decompose-stream.js'); startDecomposeStream(missionId, { model: deps.decomposeModel || DECOMPOSE_MODEL }); }
      catch { /* fail-soft */ }
    }
    const callable = deps.callable ?? await defaultDecomposeCallable(deps.decomposeModel, missionId, deps.decomposeEffort);
    const { TaskGenerator } = await import('../task-orchestrator/generator.js');
    const gen = new TaskGenerator({ callable });
    // 도메인팩이 분해 성격을 공급(coding=구현·investment=관측→집행·business=조사·합성).
    // 도메인 미상(pre-D1 미션)은 coding 폴백 — 이 fabric 은 역사적으로 코딩(회귀0).
    const pack = getDomainPack(m.domain ?? 'coding');
    const objective = [
      pack.decompose.objectivePreamble(m.goal),
      // ★ 대표 정정 지시(2026-07-12) — 재분해 시 최우선 반영(HITL 프리셋/직접입력 코멘트).
      ...(deps.reviseContext ? ['', '★★ 대표 정정 지시(반드시 최우선 반영):', deps.reviseContext.slice(0, 600), ''] : []),
      // ★ 부분 수술(대표 2026-07-22) — 이미 완료된 페이즈를 주입해 재분해가 그 작업을 다시 계획하지 않게 한다.
      //   "전체 재분해→done 재실행" 대신 남은 미완 작업만 분해(히스토리 존중). 재사용/스킵은 실행 시 no-op 게이트가 처리.
      ...(preserveDone ? ['', '★ 이미 완료·검증된 페이즈(재계획·재구현 금지 — 이 작업들 이후의 남은 미완 작업만 분해하라):',
        ...donePhases.map((t, i) => `  ${i + 1}. ${t.title}`),
        '위 완료 페이즈를 다시 만들지 말고, 미션 골에서 아직 안 된 부분만 이어서 계획하라(부분 수술·기존 히스토리 존중).', ''] : []),
      // ★ 증분 재분해 baseline(대표 2026-07-21) — 정정 지시 바로 뒤에 이전 분해 전체를 두어 "이 baseline 을
      //   이 정정대로 증분 수정"을 명확히 한다. 재사용 판정 통과 시에만 채워짐(decideBaselineReuse·엄격 무효화).
      ...(baselineSection ? ['', baselineSection, ''] : []),
      // ★ 내부 grounding(대표 2026-07-12) — 골 관련 기존 코드/문서 맵을 먼저 fold. 환각 파일명·
      //   중복 구현 방지(새로 만들지 말고 재사용·확장). 외부조사보다 앞에 둬 실제 코드 기준 우선.
      ...(deps.codebaseContext ? ['', deps.codebaseContext.slice(0, 2500), ''] : []),
      // 외부조사 보강(omni-crawl)을 fold — 플랜을 더 풍부하게(대표 지시 2026-07-11).
      ...(deps.researchContext ? ['', '외부조사 보강(반영할 것):', deps.researchContext.slice(0, 2000), ''] : []),
      // ★ E5-b 미션 간 공진화 회상(대표 2026-07-18) — 연관 미션(같은 코드영역/계보)이 구현에서 겪은
      //   이탈 교훈을 이번 분해에 미리 반영(단일 미션 공진화의 미션-간 상위 스케일). 없으면 무영향.
      ...(deps.coevolutionContext ? ['', deps.coevolutionContext.slice(0, 1200), ''] : []),
      '이 미션을 실행 가능한 멀티페이즈 태스크로 분해하라. 각 태스크는 검증 가능한 acceptance',
      '(자연어 criteria + 가능하면 결정론 check)를 가지고, dependsOn 으로 페이즈 순서를 표현한다.',
      // ★ 페이즈 설계 원칙(대표 2026-07-12) — 과부하 페이즈(조사+문서저작+검증 뭉침)가 실행 예산을
      //   소진해 FAIL 하던 근본 갭 정정. domain 무관 공통 가드레일.
      '★ 페이즈 설계 원칙(반드시 준수):',
      '- 단일 책임: 한 페이즈는 한 종류 작업만 담아라(조사 / 구현 / 문서작성 / 검증 중 하나). 조사와 문서저작과 검증을 한 페이즈에 섞지 마라.',
      '- 완주 가능 크기: 각 acceptance 는 criteria 3~5개 이내, 한 번의 에이전트 실행으로 끝낼 수 있는 범위여야 한다. "모든 코드/문서를 완전히 조사/작성" 같은 무한 범위 금지 — 구체적·한정적으로(예: "핵심 export 5개와 스키마 1개 식별").',
      '- 부가 산출물 분리: 설계 문서 저작·롤백 계획·feature flag·마이그레이션 표 등은 조사/구현 페이즈에 몰지 말고 별도 페이즈로 분리하거나 생략하라.',
      '- 분할 신호: 한 acceptance 에 동사가 여러 개(조사하고+작성하고+검증하고)면 그 페이즈를 둘 이상으로 나눠라.',
      // ★ 검증 페이즈 압축 + HITL 금지 + 명확 문구(대표 2026-07-22) — 무인 자율 완주를 막는 페이즈를 창조 단계에서 차단.
      '- 검증 페이즈 압축: 검증은 **자동화 가능한 것(bun test)만** 별도 페이즈로. 자동 게이트로 충분하면 별도 검증 페이즈를 만들지 말고 구현 페이즈 acceptance 에 흡수하라. 회귀검증·통합테스트가 같은 대상이면 하나로 합쳐라(중복 금지).',
      '- HITL 금지 페이즈 금지: "승인을 요청하라 / 대표 확인 / 명시적 승인 / 검토 요청" 처럼 사람 개입이 필수라 자율 에이전트가 코드로 완주할 수 없는 페이즈는 만들지 마라. 자율 집행 가능한 작업만 페이즈로 담아라(승인은 미션 승인 게이트가 담당·페이즈 아님).',
      '- 명확·구분되는 문구: 각 페이즈 제목·설명은 **구체 산출물과 완료 계약을 명확히 선언**하라(모호/일반/잘린 문장 금지). 형제 페이즈와 역할이 한눈에 구분돼야 한다(예: "조사"·"배선"·"검증"이 제목에서 분명). 이 명확성이 분류(implementation/operational)와 완주의 전제다.',
      '- 필요한 것만: 미션 골 달성에 실제로 필요한 최소 페이즈만. 형식적 중간 확인·중복 대조·불필요한 문서화 페이즈를 넣지 마라.',
      // ★ 조사 페이즈 압축 — grounding(내부/외부 조사) 재료가 이미 있으면 재조사 페이즈 금지(대표 2026-07-22).
      ...((deps.codebaseContext || deps.researchContext) ? [
        '- 조사 페이즈 압축(grounding 활용): 위에 내부 소스 조사·외부 조사(grounding)가 **이미 제공**됐다. 그 재료로 충분한 조사·파악·대조·추적은 **별도 페이즈로 만들지 마라** — 구현 페이즈가 이 재료를 직접 활용해 바로 구현한다. 조사 페이즈는 grounding 에 정말 없는(신규 미탐색) 영역에만 최소로. historian 이 공급한 재료 위에서 재조사 없이 구현으로 직행하라.',
      ] : []),
      // 도메인별 분해 가이드(coding=파일/재사용/불변코어·investment=관측→집행 순서 등).
      ...(pack.decompose.phaseShapeHint ? [pack.decompose.phaseShapeHint] : []),
    ].join('\n');
    let result: Awaited<ReturnType<typeof gen.decompose>> | undefined;
    // ★ R2 — presetTasks(RFC 결정론 추출)면 LLM decompose 우회. 없으면 종전 경로(무회귀).
    if (!deps.presetTasks?.length) {
    try {
      // ★ 플랜 경량+정합(대표 2026-07-19) — arcHint 는 분해 페이즈 수를 부풀리지 않는다.
      //   종전(B0 축①·2026-07-18): arcHint 를 constraints.arcCount 로 넘겨 maxTasks 를 arcCount×5 로
      //   끌어올려 5아크→20~25페이즈를 강제 → 무거운 플랜. 대표 지시로 철회: 페이즈 수는 골 복잡도에
      //   맡겨 가볍게 유지하고(기본 캡 8), 아크는 분해 **후** classifyArcs 가 이 경량 페이즈 집합을
      //   사후 그룹핑한다(arcHint = 아래 아크 분류의 그룹핑 신호로만 소비·페이즈 수와 디커플).
      const decomposeMaxTasks = deps.maxTasks ?? 8;
      result = await gen.decompose({
        objective,
        context: { goalSlug: m.id },
        constraints: { maxTasks: decomposeMaxTasks },
        goalKind: pack.decompose.goalKind,
        depth: 0,
      });
    } catch (e) {
      // ★ decompose 크래시 시 옛 페이즈 보존(대표 2026-07-12·#6) — 아직 안 지웠으므로 미션 무손상.
      // ★ 근본조사(§5.3·2026-07-13) — rawText/validationErrors/code+컨텍스트를 durable 로그에 남겨
      //   원인(빈 응답 vs 스키마위반 vs 네트워크)을 다음 크래시에 1회 규명 가능하게.
      logDecomposeCrash(missionId, e, {
        model: DECOMPOSE_MODEL,
        effort: DECOMPOSE_EFFORT,
        objectiveChars: objective.length,
        groundingChars: deps.codebaseContext?.length ?? 0,
        researchChars: deps.researchContext?.length ?? 0,
        reviseChars: deps.reviseContext?.length ?? 0,
        maxTasks: deps.maxTasks ?? 8,
      });
      // ★ 관측 파리티(대표 2026-07-17) — code/validationErrors 를 logs.db 에도 구조화 남긴다. 종전엔
      //   error 요약(200자)만 가서 `elanous logs --category mission.engine.decompose` 로 "왜 스키마 위반?"을
      //   못 봤다(decompose_crash.log 파일에만·관측 툴 미도달). 이제 검증 에러가 관측 툴로 즉시 조회되고,
      //   전문(rawTextHead·LLM 원문)은 crashLog 포인터로 안내. duck-typing(DecomposeError.code/validationErrors).
      const de = e as Partial<{ code: string; validationErrors: unknown; rawText: string }>;
      debug.log('mission.engine.decompose', 'failed', {
        missionId,
        error: e instanceof Error ? e.message.slice(0, 200) : String(e),
        ...(typeof de?.code === 'string' ? { code: de.code } : {}),
        ...(Array.isArray(de?.validationErrors) ? { validationErrors: (de.validationErrors as unknown[]).slice(0, 6) } : {}),
        ...(typeof de?.rawText === 'string' ? { rawTextChars: de.rawText.length } : {}),
        crashLog: 'conatus/decompose_crash.log', // 전문(rawTextHead·컨텍스트) 위치 포인터
      }, { level: 'error' });
      return { ok: false, phaseCount: 0, taskIds: [], error: `분해 실패(옛 페이즈 보존): ${e instanceof Error ? e.message.slice(0, 120) : String(e)}` };
    }
    }
    // presetTasks(RFC) 우선 — 없으면 LLM 결과. presetTasks 면 sizing 소동 근원(LLM 크기추정) 우회.
    const tasks = deps.presetTasks?.length ? deps.presetTasks : result!.proposal.tasks;
    if (deps.presetTasks?.length) { try { debug.log('mission.engine.decompose', 'preset-rfc', { missionId, tasks: tasks.length }); } catch { /* fail-soft */ } }
    // ★ P2(통합 sizing 2026-07-22) — 분해 산출을 SSOT gradePhaseCompletability 로 사전 채점(관측 우선·제1원칙).
    //   "처음부터 완주 가능 크기"로 잘랐는지 자기인지 → `elanous logs --category mission.engine.sizing`. 텍스트만
    //   (files/est 미지)이라 base 는 corroboration(concerns≥3+acceptance≥6/제목결합)일 때만 too_large →
    //   2026-07-19 오탐 회귀 없음. 관측만(behavior 무변경) — 분해↔실행 크기 통합의 사전예측 렌즈.
    try {
      const { gradePhaseCompletability } = await import('./mission-phase-granularity.js');
      const grades = tasks.map((t) => gradePhaseCompletability({
        id: `p${t.index}`, title: t.title, prompt: t.description ?? '', acceptance: t.acceptance?.criteria ?? [],
      }));
      const oversize = grades.filter((g) => g.verdict === 'too_large');
      const avg = grades.length ? grades.reduce((a, g) => a + g.completabilityScore, 0) / grades.length : 1;
      debug.log('mission.engine.sizing', 'decompose-graded', {
        missionId, phases: tasks.length, oversize: oversize.length,
        avgCompletability: Number(avg.toFixed(2)),
        ...(oversize.length ? { oversizeTitles: oversize.map((g) => g.phaseTitle.slice(0, 40)).slice(0, 5) } : {}),
      });
    } catch { /* fail-soft — 관측 실패가 분해를 막지 않음 */ }
    // Codex 원칙: 1태스크면 small. ★ 정정(revise)이면 단일 폴백 대신 옛 페이즈 보존(#6) — 멀티페이즈
    //   정정이 단일로 퇴화하며 옛 것을 잃지 않게. 정정 아니면 기존 autoDecompose 폴백(신규 미션).
    // ★ 근본(2026-07-22 dogfood) — presetTasks(RFC 결정론 추출)는 1개여도 **의도된 유효 단일페이즈**다.
    //   degenerate(≤1) autoDecompose 폴백은 LLM 분해가 붕괴했을 때만 유효 — preset 이면 우회하지 말고
    //   아래 createTask 로 그대로 생성한다(단일페이즈 RFC 미션이 골-as-title autoDecompose 로 새 throw 하던 근본).
    if (tasks.length <= 1 && !deps.presetTasks?.length) {
      // ★ 버그 수복(2026-07-19 dogfood) — "옛 페이즈 보존"은 실제로 보존할 옛 subagent 페이즈가 있을
      //   때만 유효하다. 신규 미션에 --comment(reviseContext)로 분해 시 ≤1 로 붕괴하면, 옛 페이즈가 0인데도
      //   이 분기를 타 0 페이즈로 침묵 종료(실행 불가)했다. 보존할 게 없으면(신규) 단일 폴백으로 → 최소
      //   1 페이즈(실행 가능). 단일 페이즈 미션은 정상이다(리지드 거부는 옛 것 손실 방지가 목적).
      const existingPhases = existing.filter((t) => t.surface.kind === 'subagent');
      if (deps.reviseContext && existingPhases.length > 0) {
        return { ok: false, phaseCount: 0, taskIds: [], error: '재분해 결과 단일(≤1) — 정정 반영 불충분, 옛 페이즈 보존' };
      }
      const single = autoDecomposeMission(m.id, { store });
      return { ok: single.ok, phaseCount: single.ok ? 1 : 0, taskIds: single.taskId ? [single.taskId] : [], note: 'small(단일 태스크)', ...(single.error ? { error: single.error } : {}) };
    }

    // ★ 성공 확인(tasks>=2) 후에만 옛 페이즈 삭제(트랜잭셔널·#6) — reviseContext: 전체 subagent
    //   (done/running 포함·clean reset) / 아니면: backlog(autoDecompose 단일분) 정리. 그 뒤 새로 생성.
    const toDelete = deps.reviseContext
      ? existing.filter((t) => t.surface.kind === 'subagent' && t.status !== 'done') // ★ 부분 수술 — done 보존(재실행 방지)
      : existing.filter((t) => t.status === 'backlog');
    for (const t of toDelete) store.deleteTask?.(t.id);

    // index → taskId 매핑으로 dependsOn(indices)을 실 task id 로 변환하며 순서대로 생성.
    // ★ createdAt 를 페이즈마다 엄격 증가(baseNow + i)시켜 **생성순서를 불변 필드에 고정**한다.
    //   같은 ms 타이 시 saveTask(INSERT OR REPLACE)가 rowid 를 바꿔 listTasks 순서가 흔들려
    //   위상정렬 tiebreak 가 불안정(mission-adjust flaky)이던 근본원인 제거.
    const idxToId = new Map<number, string>();
    const taskIds: string[] = [];
    const baseNow = Date.now(); // done 페이즈보다 뒤(생성순서 = 실행순서) — 새 페이즈가 done tail 뒤로 정렬
    // ★ 부분 수술 체인(대표 2026-07-22) — done 보존 시, 루트 새 페이즈(선행 없음)를 마지막 done 뒤로 체인해
    //   실행이 done 이후부터 이어지게 한다(처음부터 재시작 방지). done 없으면 종전대로(루트=ready).
    const lastDoneId = preserveDone ? donePhases[donePhases.length - 1]!.id : null;
    let phaseSeq = 0;
    for (const t of tasks) {
      const mapped = (t.dependsOn ?? [])
        .map((i) => idxToId.get(i))
        .filter((v): v is string => Boolean(v));
      const dependsOn = mapped.length === 0 && lastDoneId ? [lastDoneId] : mapped;
      const prompt = [
        `[페이즈 ${t.index}] ${t.title}`,
        t.description ?? '',
        t.acceptance?.criteria?.length ? `\n검증(acceptance):\n- ${t.acceptance.criteria.join('\n- ')}` : '',
      ].filter(Boolean).join('\n');
      const created = createTask({
        title: t.title.slice(0, TASK_DEFAULTS.titleMaxLen), // SSOT 한도(80) 참조 — preset/LLM title 81~120 이 검증서 throw 하던 드리프트 제거
        description: prompt.slice(0, 4000),
        surface: { kind: 'subagent', definitionName: 'general-purpose', prompt },
        goalSlug: m.id,
        dependsOn,
        ...(t.acceptance ? { acceptance: t.acceptance } : {}),
        generatedBy: { kind: 'user', actorId: 'autopilot-phase' },
        status: 'backlog',                    // ★ HITL — 승인 전 실행 0.
        ...(t.priority ? { priority: t.priority } : {}),
      }, { allowUncheckedUrgent: true, now: baseNow + phaseSeq });
      store.saveTask(created);
      idxToId.set(t.index, created.id);
      taskIds.push(created.id);
      phaseSeq += 1;
    }

    // ★ 아크 분류 게이트(RFC 아크·A2.5·2026-07-14) — 페이즈들을 아크(응집 서브골)로 자동 그룹핑.
    //   보수적(페이즈<5·불확실=single·flat 유지·회귀 0). multi 면 arcs 를 미션에 저장 → A2 배리어+
    //   통합 acceptance 가 작동한다. fail-soft(분류 실패가 분해를 막지 않음).
    try {
      const { classifyArcs } = await import('./mission-arc-classify.js');
      const phasesForArc = taskIds.map((id) => {
        const t = store.getTask(id);
        return { id, title: t?.title ?? '', ...(t?.description ? { description: t.description } : {}) };
      });
      // #4498 3A — 대표 확정 arcHint 를 넘겨, LLM 그룹핑 실패/부재 시에도 arcHint 존중 결정론 파생.
      const arcHintForClassify = deps.arcHint && deps.arcHint >= 2 ? deps.arcHint : undefined;
      // ★ 세부 스테이지 관측(대표 2026-07-21·블랙박스 해소) — sol-done→memory-record 사이 arc.classify/
      //   preflight 는 각 sol 콜(20~60s) 완료 시에만 개별 로그를 내, 그 사이가 무신호로 보인다(관측 사각).
      //   stage enter/done 을 mission.build.arc 로 남겨 "지금 어느 세부 단계인지"를 조회 가능하게(개별 결과는
      //   여전히 mission.arc.classify·mission.arc.preflight 가 낸다). `elanous logs --category mission.build.arc`.
      try { debug.log('mission.build.arc', 'classify-enter', { missionId: m.id, phases: phasesForArc.length, arcHint: arcHintForClassify ?? null }); } catch { /* fail-soft */ }
      const cls = await classifyArcs({ goal: m.goal, phases: phasesForArc, ...(arcHintForClassify ? { arcHint: arcHintForClassify } : {}) });
      try { debug.log('mission.build.arc', 'classify-done', { missionId: m.id, arcModel: cls.arcModel, arcs: cls.arcs.length }); } catch { /* fail-soft */ }
      // ★ Device 2 (PLAN-anti-infinite-phase-split 2026-07-23) — 설계단계 아크붕괴 감지. 확정 arcHint 대비
      //   실제 페이즈 수가 붕괴(멀티아크가 flat 으로 뭉개짐·라이브 e4f97b 5아크→7페이즈)면 관측+권고로
      //   표면화한다. 붕괴 방치 = 과대 페이즈 → 실행 split 팽창의 근원(이 세션의 무한분할 출발점). soft
      //   (관측·권고·조율자/HITL 소비)이라 2026-07-19 오탐 회귀 없음 — 하드 자동재분해는 대표 arcHint
      //   soft/hard 결정 대기(project_archint_soft_vs_hard_enforcement). 관측갭 충전 = mission.decompose.
      try {
        const { gradeArcConformance } = await import('./mission-phase-granularity.js');
        const conf = arcHintForClassify ? gradeArcConformance(tasks.length, arcHintForClassify) : null;
        if (conf) {
          debug.log('mission.decompose', conf.conforms ? 'arc-conformance-ok' : 'arc-conformance-collapse', {
            missionId: m.id, phaseCount: conf.phaseCount, arcHint: conf.arcHint,
            expectedMin: conf.expectedMin, expectedMax: conf.expectedMax, conforms: conf.conforms, note: conf.note.slice(0, 160),
          });
          if (!conf.conforms) console.log(`[decompose] ⚠️ 아크붕괴 의심(설계단계) — ${conf.note}`);
        }
      } catch { /* fail-soft — 관측 실패가 분해를 막지 않음 */ }
      if (cls.arcModel === 'multi' && cls.arcs.length >= 2) {
        // ★ A7-L2 grounded pre-flight(RFC §14b·2026-07-14) — 허상 아크(잘못된 파일·없는 전제·과대)를
        //   정의 시점에 grounded 판정해 아크에 verdict 부착 → HITL 승인 게이트에 표면화(과계층화 방지).
        //   fail-soft — 판정 실패/애매는 founded(자동 차단 안 함·사람이 최종 결정).
        let arcsToSave = cls.arcs;
        try {
          const { preflightArcs } = await import('./mission-arc-preflight.js');
          try { debug.log('mission.build.arc', 'preflight-enter', { missionId: m.id, arcs: cls.arcs.length }); } catch { /* fail-soft */ }
          const verdicts = await preflightArcs(cls.arcs, phasesForArc);
          arcsToSave = cls.arcs.map((a, i) => (verdicts[i] ? { ...a, preflightVerdict: verdicts[i] } : a));
          const flagged = verdicts.filter((v) => v.verdict !== 'founded');
          // ★ 제1원칙(대표 2026-07-21) — flagged 집계를 logs.db 로 승격. 종전 console.log 은 run.log(prepare
          //   트레일)에만 남아 `elanous logs` 조회 불가(= 관측 안 한 것). 개별 verdict+reason 은 mission.arc.preflight
          //   가, 집계(몇/몇·verdict→action)는 여기서 남긴다. prepare-log tail 용 console.log 는 병행 유지.
          try { debug.log('mission.build.arc', 'preflight-done', { missionId: m.id, flagged: flagged.length, of: verdicts.length, verdicts: flagged.map((v) => `${v.verdict}→${v.action}`) }); } catch { /* fail-soft */ }
          if (flagged.length) console.log(`[arc-preflight] ⚠️ 허상/과대 의심 아크 ${flagged.length}/${verdicts.length}건 — HITL 검토 권장(${flagged.map((v) => `${v.verdict}→${v.action}`).join(', ')})`);
        } catch { /* fail-soft — preflight 실패는 분류 결과 그대로 */ }
        // ★ G2(B1 결합·2026-07-15) — 첫 분해 시점에 아크별 예산 자동 산정(멤버 페이즈 견적 합).
        //   아크 구조 확정 = 예산 확정. 이후 insert-arc/split 이 재산정(델타 HITL·B2).
        try {
          const { withArcCosts } = await import('./mission-arc-budget.js');
          const costById = new Map(phasesForArc.map((p) => [p.id, store.getTask(p.id)?.estimateUsd]));
          arcsToSave = withArcCosts(arcsToSave, costById);
        } catch { /* fail-soft — 예산 미산정이어도 아크 구조는 저장 */ }
        const fresh = store.getMission(m.id); // Mission(autopilot 포함) — registry MissionRow 아님.
        if (fresh) {
          // #4498 3A coherence — arcs 에 근거 arcHint(version) 스탬프. 재분해에서 arcHint 갱신되면
          //   옛 아크그룹은 stale(supersede) — 관측으로 전이를 남긴다(제1원칙·MESI S→I).
          const prevArcHint = fresh.autopilot?.arcsArcHint;
          if (prevArcHint !== undefined && arcHintForClassify !== undefined && prevArcHint !== arcHintForClassify) {
            debug.log('mission.arc.classify', 'superseded', { missionId: m.id, from: prevArcHint, to: arcHintForClassify, arcs: arcsToSave.length });
          }
          store.saveMission({ ...fresh, autopilot: {
            ...(fresh.autopilot ?? { origin: 'manual' as const }), arcModel: 'multi', arcs: arcsToSave,
            ...(arcHintForClassify ? { arcsArcHint: arcHintForClassify } : {}),
          } });
          // #4498 3report(축B) — 분해 근거를 미션 워킹메모리에 각인 → 재분해가 이전 판단을 능동회상.
          //   사용자 표시/첨부(UX)는 3B(대표 UX 통합안) 소관 — 여기는 자기인지 각인만. fail-soft.
          try {
            const { decompositionReportDigest } = await import('./mission-decompose-report.js');
            const { coordinatorRecordMemory } = await import('./pipeline/coordinator-memory.js');
            const phaseTitles = Object.fromEntries(phasesForArc.map((p) => [p.id, p.title]));
            const digest = decompositionReportDigest({ goal: m.goal, arcs: arcsToSave, phaseTitles, ...(arcHintForClassify ? { arcHint: arcHintForClassify } : {}) });
            // ★ mirage 진단 → 구현 컨텍스트 carry(대표 지시 2026-07-21) — preflightVerdict!=='founded' 아크의
            //   reason(진단)을 `[premise:<verdict>]` 팩트로 build:context decisions 에 append. 종전엔 이 진단이
            //   카드/리포트/maturity 카운트에만 소비돼, 정작 구현하는 SE 페이즈는 "잘못된 전제"를 바로잡을 근거를
            //   못 받았다. formatWorkingMemoryForPrompt 가 이 접두사를 "아크 전제 교정" 섹션으로 렌더 → 구현 SE 가
            //   "이 아크의 전제 X 는 실제 코드상 틀렸다 → 올바른 대상으로 바로잡아 구현" 을 받는다. skillFacts/codeFacts
            //   와 동일한 typed-decision 배선(무회귀·append 만). descope 는 advisory 유지(아크 실삭제 안 함).
            const premiseFacts = arcsToSave
              .filter((a) => a.preflightVerdict && a.preflightVerdict.verdict !== 'founded' && a.preflightVerdict.reason)
              .map((a) => `[premise:${a.preflightVerdict!.verdict}] 아크 "${a.name}": ${a.preflightVerdict!.reason}`);
            coordinatorRecordMemory(m.id, {
              phaseId: 'decompose', phaseTitle: '분해 설계', kind: 'investigation', summary: digest,
              reusables: [], decisions: [...arcsToSave.map((a) => `아크 ${a.name}: ${a.phaseIds.length}페이즈`).slice(0, 8), ...premiseFacts],
              artifacts: [], provenance: 'decision',
            });
            if (premiseFacts.length) { try { debug.log('mission.arc.preflight', 'carry', { missionId: m.id, premises: premiseFacts.length }); } catch { /* fail-soft */ } }
          } catch { /* fail-soft — 각인 실패는 분해에 무영향 */ }
        }
      }
    } catch { /* fail-soft — 아크 없이 flat 진행 */ }

    // ★ 증분 재분해 지문 저장(opt-in·2026-07-21) — 이번 분해가 근거한 골 해시 + grounded 파일 스코프 SHA 를
    //   남겨 다음 재분해의 무효화 비교(골 변경/파일 변경 → baseline 폐기)를 가능케 한다. fail-soft·flag-OFF 무동작.
    if (deps.incrementalBaseline) {
      try {
        saveBaselineFingerprint(m.id, { goalHash: hashGoal(m.goal), groundingFilesSha: filesScopeSha(deps.groundingFiles ?? []), at: new Date().toISOString() });
      } catch { /* fail-soft */ }
    }

    // 플랜 초안(HITL 검토 아티팩트) 기록 — ops-status planDraft(#3697)가 노출.
    const planPath = writePhasePlanDraft(m, tasks, result?.proposal.rationale ?? 'RFC 결정론 추출 (LLM decompose 우회·작업항목=페이즈)', result?.estimatedTotalUsd ?? 0);
    return { ok: true, phaseCount: taskIds.length, taskIds, ...(planPath ? { planPath } : {}) };
  } catch (e) {
    return { ok: false, phaseCount: 0, taskIds: [], error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  } finally {
    if (owns) store.close();
  }
}

// ★ 미션 분해 = 코딩이 아니라 리즈닝(계획·의존성 분석·리스크 평가·페이즈 설계·대표 지시
//   2026-07-11). 튜닝 발견(terra=코딩·sol=심층추론)에 따라 분해는 sol + 높은 effort 를 쓴다.
//   기본 sol/high(리즈닝 sweet spot·max 는 비용·latency 급증). env 로 sweet-spot 실험 가능:
//   ELANOUS_DECOMPOSE_MODEL·ELANOUS_DECOMPOSE_EFFORT(minimal|low|medium|high|xhigh|max).
export const DECOMPOSE_MODEL = process.env.ELANOUS_DECOMPOSE_MODEL || tierModel('best');
export type DecomposeEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const DECOMPOSE_EFFORT = (process.env.ELANOUS_DECOMPOSE_EFFORT || 'high') as DecomposeEffort;
/** heavy tier 기본 decompose effort(대표 2026-07-21·#4846 병목 힘빼기) — 종전 'high'.
 *  초기 sol reasoning high→medium 이 라이브 빌드 병목의 60-80%(3.7분 실측·단일 chokepoint). effort 는
 *  분해 페이즈 수가 아니라 reasoning 깊이만 낮춘다 — 분할 신호·단일책임 가드레일(objective)·캡 8 은 불변
 *  이라 페이즈 응집도/개수는 구조적으로 유지(무회귀). 롤백/실측 seam: ELANOUS_DECOMPOSE_HEAVY_EFFORT=high
 *  로 세팅하면 코드 변경 없이 종전 동작 재현(라이브 before/after A/B). call-time read(env override 와 동일). */
export const DECOMPOSE_HEAVY_EFFORT_DEFAULT: DecomposeEffort = 'medium';
/** ★ tier 기반 decompose effort(대표 2026-07-19 도입·2026-07-21 병목 힘빼기) — heavy=medium·light=medium.
 *  env(ELANOUS_DECOMPOSE_EFFORT) 있으면 전 tier 최우선(실험 override). heavy 만 별도로 되돌릴 땐
 *  ELANOUS_DECOMPOSE_HEAVY_EFFORT seam(=high 로 종전 재현). 호출측(se-mission-prepare)이 m.tier 로 호출해
 *  deps.decomposeEffort 로 전달. effort 선택을 관측(제1원칙·before/after 실측)에 남긴다. */
export function resolveDecomposeEffort(tier?: string | null): DecomposeEffort {
  const env = process.env.ELANOUS_DECOMPOSE_EFFORT;
  const heavyEffort = (process.env.ELANOUS_DECOMPOSE_HEAVY_EFFORT || DECOMPOSE_HEAVY_EFFORT_DEFAULT) as DecomposeEffort;
  const effort: DecomposeEffort = env
    ? (env as DecomposeEffort)
    : tier === 'heavy' ? heavyEffort : 'medium';
  const source = env ? 'env-override' : tier === 'heavy' ? 'heavy-tier' : 'default';
  try { debug.log('mission.decompose', 'effort-resolved', { tier: tier ?? null, effort, source }); } catch { /* fail-soft — 관측 실패는 분해에 무영향 */ }
  return effort;
}
/** Opus 폴백 분해 모델(HITL 승인 시·유료) — Codex 분해가 transient 재시도 후에도 실패할 때. */
export const DECOMPOSE_OPUS_MODEL = process.env.ELANOUS_DECOMPOSE_OPUS_MODEL || 'claude-opus-4-8';

/** 일시적(재시도 가치 있는) LLM 오류 — 5xx(520 Cloudflare 등)·429·네트워크. 스키마위반/빈응답은 제외
 *  (재시도해도 같음). Codex API 520 같은 게이트웨이 오류에 2분 재시도를 붙이는 판정. 순수. */
const TRANSIENT_LLM_RE = /\b(5\d\d|429)\b|502|503|504|520|522|524|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang|fetch failed|network error|Cloudflare|gateway|temporarily unavailable|overloaded/i;
export function isTransientLlmError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e ?? '');
  return TRANSIENT_LLM_RE.test(msg);
}

/** transient 재시도 파라미터 — 대표 설계(2026-07-15): 임시 Codex 실패는 2분 후 1회 재시도. */
const DECOMPOSE_RETRY_DELAY_MS = Number(process.env.ELANOUS_DECOMPOSE_RETRY_MS || 120_000); // 2분
const DECOMPOSE_RETRIES = Number(process.env.ELANOUS_DECOMPOSE_RETRIES ?? 1);

/**
 * transient(재시도 가치 있는) 오류에만 지연 후 재시도하는 래퍼. 비-transient(스키마위반·빈응답 등)는 즉시
 * throw(재시도 무의미). 순수·주입(sleep/isTransient 테스트) — 2분 지연/LLM mock 없이 로직 검증. `label`
 * 은 관측 태그. retries 소진 시 마지막 오류 rethrow.
 */
export async function withTransientRetry<T>(
  fn: () => Promise<T>,
  opts: { retries?: number; delayMs?: number; label?: string; sleep?: (ms: number) => Promise<void>; isTransient?: (e: unknown) => boolean } = {},
): Promise<T> {
  const retries = opts.retries ?? DECOMPOSE_RETRIES;
  const delayMs = opts.delayMs ?? DECOMPOSE_RETRY_DELAY_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const transient = opts.isTransient ?? isTransientLlmError;
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); }
    catch (e) {
      if (attempt >= retries || !transient(e)) throw e;
      debug.log('mission.decompose', 'transient-retry', {
        label: opts.label ?? 'decompose', attempt: attempt + 1, of: retries, delayMs,
        err: (e instanceof Error ? e.message : String(e)).slice(0, 140),
      });
      await sleep(delayMs);
    }
  }
}

/** 기본 decompose callable — sol + high effort(리즈닝). streamLLM lazy import. modelOverride=Opus 폴백.
 *  ★ transient(520 등) 오류엔 2분 후 재시도(대표 2026-07-15) — 스키마위반/빈응답은 즉시 throw(무의미). */
export async function defaultDecomposeCallable(modelOverride?: string, missionId?: string, effortOverride?: DecomposeEffort): Promise<DecomposeCallable> {
  const model = modelOverride || DECOMPOSE_MODEL;
  const { streamLLM, resolveDefaultProvider } = await import('../llm.js');
  const provider = resolveDefaultProvider(model);
  // ★ 분해 스트리밍 관측(대표 2026-07-17) — sol 출력 증분을 미션별 임시 파일에 실시간 append 해
  //   "분해 중 뭘 쓰는지"를 진행 중에도 `elanous autopilot decompose-stream` 로 조회 가능하게(블랙박스 해소).
  const { appendDecomposeStream } = missionId ? await import('./mission-decompose-stream.js') : { appendDecomposeStream: undefined };
  return async ({ prompt, signal }) => withTransientRetry(async () => {
    // ★ 관측 하트비트(대표 2026-07-21·"왜 분해가 오래 걸리나") — sol high reasoning 은 delta 없이 수분 걸려
    //   shape→decompose 사이가 관측 사각(logs.db 무신호·stuck vs slow 구분 불가)이었다. sol-start/20s heartbeat/
    //   sol-done 을 logs.db 로 → `elanous logs --category mission.build.decompose`. unref 로 종료 무방해.
    const startedAt = Date.now();
    let streamChars = 0;
    try { debug.log('mission.build.decompose', 'sol-start', { missionId, model, effort: effortOverride ?? DECOMPOSE_EFFORT }); } catch { /* fail-soft */ }
    const beat = setInterval(() => {
      try { debug.log('mission.build.decompose', 'heartbeat', { missionId, elapsedMs: Date.now() - startedAt, streamChars }); } catch { /* fail-soft */ }
    }, 20000);
    (beat as { unref?: () => void }).unref?.();
    try {
      const text = await streamLLM([{ role: 'user', content: prompt }],
        (delta: string) => { streamChars += delta.length; if (missionId && appendDecomposeStream) appendDecomposeStream(missionId, delta); }, {
        model,
        reasoningEffort: effortOverride ?? DECOMPOSE_EFFORT,
        ...(provider ? { provider } : {}),
        ...(signal ? { signal } : {}),
      });
      try { debug.log('mission.build.decompose', 'sol-done', { missionId, chars: text.length, elapsedMs: Date.now() - startedAt }); } catch { /* fail-soft */ }
      return { text, modelId: model };
    } finally { clearInterval(beat); }
  }, { label: `decompose:${model}` });
}

/** 멀티페이즈 플랜을 사람이 검토할 md 초안으로 기록(HITL). 실패는 fail-soft(null). */
function writePhasePlanDraft(
  m: MissionRow,
  tasks: ReadonlyArray<{ index: number; title: string; description?: string; dependsOn?: readonly number[]; priority?: string; acceptance?: { criteria?: readonly string[] } }>,
  rationale: string,
  estUsd: number,
): string | null {
  if (process.env.NODE_ENV === 'test') return null; // 테스트 격리 — 실 FS(플랜 초안) 미기록.
  try {
    const path = proposalDraftPath(m.id);
    mkdirSync(dirname(path), { recursive: true });
    const lines = [
      `# 미션 멀티페이즈 플랜 (HITL 검토) — ${m.id}`,
      '', `> 골: ${m.goal}`, `> 페이즈 ${tasks.length}개 · 예상 $${estUsd.toFixed(2)} · 승인 전 실행 0(backlog).`,
      '', `## 분해 근거`, rationale, '', `## 페이즈`,
    ];
    for (const t of tasks) {
      const deps = t.dependsOn?.length ? ` ←의존[${t.dependsOn.join(',')}]` : ' (독립)';
      lines.push(`### [${t.index}] ${t.title}${deps} · ${t.priority ?? 'medium'}`);
      if (t.description) lines.push(t.description);
      if (t.acceptance?.criteria?.length) lines.push('', '검증:', ...t.acceptance.criteria.map((c) => `- ${c}`));
      lines.push('');
    }
    lines.push('---', '이 플랜대로 나눠 처리할까요? 과도하면 페이즈를 **trim/defer**(일부만 진행) 하거나 교정 후 승인하세요. 승인 시 선택한 페이즈가 dependsOn 순서로 실행됩니다.');
    writeFileSync(path, lines.join('\n'));
    return path;
  } catch { return null; }
}

export interface ApproveMissionResult { ok: boolean; activated: number; scheduledCron?: string; note?: string; error?: string }

/** schedule_manage create 의 주입 seam(테스트가 실 crontab 안 건드리게). */
export type CreateScheduleFn = (args: Record<string, unknown>) => Promise<unknown>;

/** HITL 승인 — 실행 허가(대표 명시 액션). 승인 전엔 backlog 라 아무것도 안 돎.
 *  · scheduler 미션(V5): 추론/저장된 cron 으로 실 반복 예약 배선(schedule_manage
 *    create·command=scripts/run-mission.ts <id>·autopilot_id 스탬프). preview 태스크
 *    삭제. 미션 running. → 매 주기 run-mission 이 골을 에이전트로 실행·발송.
 *  · task/기타: backlog 태스크 ready 승격(1회 집행). */
/** task 미션 1회 집행 seam — run-mission.ts <id> 를 detached one-shot 실행(디스패처 불요).
 *  테스트는 no-op 주입. 기본은 실 spawn. */
export type SpawnRunFn = (missionId: string) => void;

export async function approveMission(
  missionId: string,
  deps: { store?: TaskStore; now?: number; createSchedule?: CreateScheduleFn; spawnRun?: SpawnRunFn; courier?: Omit<CourierDeps, 'store' | 'now'> } = {},
): Promise<ApproveMissionResult> {
  const store = deps.store ?? new TaskStore();
  const owns = !deps.store;
  const now = deps.now ?? Date.now();
  const notifyCourier = () => {
    try {
      const config = deps.courier?.config ?? getUserConfig().autopilot?.trackCourier;
      if (config?.enabled === true) {
        void deliverMissionPhases(missionId, { ...deps.courier, config, store, now });
      }
    } catch (e) {
      try { debug.log('autopilot.track-courier', 'post-failed', { missionId, error: e instanceof Error ? e.message : String(e) }); } catch { /* fail-soft */ }
    }
  };
  try {
    const m = getMission(store, missionId);
    if (!m) return { ok: false, activated: 0, error: `미션 없음: ${missionId}` };

    // ── scheduler → 실 반복 예약 배선(V5) ──
    if (m.execution_model === 'scheduler') {
      let cron: string | undefined;
      try { cron = m.materialize_spec ? (JSON.parse(m.materialize_spec).cron as string | undefined) : undefined; } catch { /* spec 손상 무시 */ }
      if (!cron) cron = inferCronSchedule(m.goal)?.cron;
      if (!cron) { debug.log('mission.engine.materialize', 'schedule-infer-failed', { missionId, goal: m.goal.slice(0, 100) }, { level: 'error' }); return { ok: false, activated: 0, error: '스케줄 추론 실패 — cron 을 명시해주세요(예: "0 8 * * *").' }; }

      const command = `scripts/run-mission.ts ${missionId}`;
      const createSchedule = deps.createSchedule ?? ((args) => dispatchScheduleManage(args));
      const res = (await createSchedule({ action: 'create', cron, command, autopilotId: missionId })) as { error?: string } | undefined;
      if (res && typeof res === 'object' && 'error' in res && res.error) {
        debug.log('mission.engine.materialize', 'schedule-create-failed', { missionId, cron, error: res.error.slice(0, 200) }, { level: 'error' });
        return { ok: false, activated: 0, error: `예약 생성 실패: ${res.error}` };
      }
      debug.log('mission.engine.materialize', 'scheduler-activated', { missionId, cron });
      // preview backlog 태스크는 대표용 미리보기였으니 정리(실 아티팩트=cron).
      for (const t of store.listTasks({ goalSlug: m.id }).filter((t) => t.status === 'backlog')) {
        store.deleteTask(t.id);
      }
      missionLifecycleGate(store, m.id, 'running', 'approve', new Date(now));
      return { ok: true, activated: 1, scheduledCron: cron };
    }

    // ── task/기타 → backlog 태스크 1회 집행 ──
    //   backlog 이 없으면(발굴 미션 등 자동분해 미실행분) 승인 시점에 lazy 분해 후 집행.
    //   대표 지적(2026-07-10): discovery 미션은 intent-gate 를 안 거쳐 backlog 이 없어 승인 실패했음.
    let backlog = store.listTasks({ goalSlug: m.id }).filter((t) => t.status === 'backlog');
    if (backlog.length === 0) {
      const dec = autoDecomposeMission(m.id, { store });
      if (!dec.ok) { debug.log('mission.engine.materialize', 'auto-decompose-failed', { missionId: m.id, error: (dec.error ?? '').slice(0, 200) }, { level: 'error' }); return { ok: false, activated: 0, error: `자동 분해 실패: ${dec.error ?? '알 수 없음'}` }; }
      backlog = store.listTasks({ goalSlug: m.id }).filter((t) => t.status === 'backlog');
      if (backlog.length === 0) { debug.log('mission.engine.materialize', 'no-backlog-after-decompose', { missionId: m.id }); return { ok: false, activated: 0, error: '분해 후에도 backlog 태스크 없음.' }; }
    }
    // ── 멀티페이즈(>1) → 도메인 executor 로 dependsOn 존중 스테이징(D6) + 실집행 ──
    //   root 만 ready·나머지 blocked(선행 done 시 cascade). executeApprovedMission 은 스테이징만.
    if (backlog.length > 1) {
      const r = await executeApprovedMission(m.id, { store, now });
      missionLifecycleGate(store, m.id, 'running', 'approve', new Date(now));
      // ★ 폐루프(2026-07-12) — run-mission 은 페이즈 인식(dependsOn walk·VERDICT 判定)이라
      //   스테이징된 페이즈를 실집행한다. HITL 승인이 곧 실행 게이트.
      //   ★ 투자 도메인 통째 차단 제거(대표 2026-07-13) — 실전 매매 없는 신호/구현/조사 미션까지
      //   승인 후 막히던 문제. 이제 모든 도메인 승인=실행. 실제 매매 집행은 하위 trade-mandate
      //   (armed/live)가 게이트하므로 미션 실행해도 실매매 오집행 불가(도메인 통째 dry 는 과잉 이중).
      try { (deps.spawnRun ?? defaultSpawnRunMission)(m.id); } catch { /* fail-soft — 스테이징 유지 */ }
      if (r.ok) notifyCourier();
      return { ok: r.ok, activated: r.activated, ...(r.note ? { note: r.note } : {}) };
    }
    // ── 단일 페이즈 → 기존 동작 유지(ready + run-mission one-shot) ──
    let activated = 0;
    for (const t of backlog) {
      store.saveTask({ ...t, status: 'ready', updatedAt: now });
      activated += 1;
    }
    missionLifecycleGate(store, m.id, 'running', 'approve', new Date(now));
    // ★ 실집행 — ready 만으론 안 돎(활성 디스패처 부재·대표 지적 2026-07-10). run-mission.ts 를
    //   detached one-shot 실행해 골을 에이전트 턴으로 즉시 수행·발송(scheduler 의 1회판).
    try { (deps.spawnRun ?? defaultSpawnRunMission)(m.id); } catch { /* fail-soft — ready 로 남음 */ }
    notifyCourier();
    return { ok: true, activated };
  } catch (e) {
    return { ok: false, activated: 0, error: e instanceof Error ? e.message.slice(0, 150) : String(e) };
  } finally {
    if (owns) store.close();
  }
}

// ── 자율 arming — 승인(spec 보유) 미션의 게이트된 자동 materialize ───────────
// 대표 승인 = spec(command/cron/prompt) 명시 + status=armed. arming.materialize ON
// 이면 armed 미션을 자동 실행. command 자동생성은 여전히 금지(spec 은 HITL 명시분).
// 기본 off(fail-closed) — 켜기 전엔 실제 자동 실행 0.

export interface ArmMissionResult { ok: boolean; error?: string }

/** HITL 승인 — materialize spec 저장 + status=armed(자동 실행 후보로 등록). */
export function armMission(missionId: string, spec: { command?: string; cron?: string; prompt?: string }): ArmMissionResult {
  const mdb = openAutopilotMissionsDb();
  try {
    const m = getMission(mdb, missionId);
    if (!m) return { ok: false, error: `미션 없음: ${missionId}` };
    setMissionSpec(mdb, missionId, spec);
    missionLifecycleGate(mdb, missionId, 'armed', 'arm');
    return { ok: true };
  } finally { mdb.close(); }
}

export interface AutoMaterializeResult {
  armed: boolean;                 // mandate.armed 게이트 상태
  materialized: number;           // 성공 건수
  skipped: number;                // mandate 범위 밖으로 건너뜀
  results: Array<{ id: string; ok: boolean; engine?: string; error?: string; skipped?: string }>;
}

/** mandate.armed ON 이면 armed+spec 미션 중 mandate 범위 내를 자동 materialize.
 *  off/범위 밖 = 건너뜀. 범위(models·commandSources·maxActiveJobs)는 대표 1회 승인. */
export async function autoMaterializeArmed(deps: { mandatePath?: string; mandate?: MaterializeMandate } = {}): Promise<AutoMaterializeResult> {
  const mandate = deps.mandate ?? loadMaterializeMandate(deps.mandatePath);
  if (!mandate.armed) return { armed: false, materialized: 0, skipped: 0, results: [] };
  const mdb = openAutopilotMissionsDb();
  const candidates = listMissions(mdb, { status: 'armed' }).filter(m => m.materialize_spec);
  // 현재 자율 활성 잡 수(running) — mandate 상한 판정 기준.
  let activeCount = listMissions(mdb, { status: 'running' }).length;
  mdb.close();
  const results: AutoMaterializeResult['results'] = [];
  for (const m of candidates) {
    let spec: { command?: string; cron?: string; prompt?: string };
    try { spec = JSON.parse(m.materialize_spec!); } catch { results.push({ id: m.id, ok: false, error: 'spec 손상' }); continue; }
    const gate = evaluateMaterializeMandate(mandate, { executionModel: m.execution_model, command: spec.command, activeCount });
    if (!gate.allowed) { results.push({ id: m.id, ok: false, skipped: gate.reason }); continue; }
    const r = await materializeMission({ missionId: m.id, ...spec });
    results.push({ id: m.id, ok: r.ok, engine: r.engine, ...(r.error ? { error: r.error } : {}) });
    if (r.ok) activeCount++; // 상한 카운트 반영
  }
  return {
    armed: true,
    materialized: results.filter(r => r.ok).length,
    skipped: results.filter(r => r.skipped).length,
    results,
  };
}
