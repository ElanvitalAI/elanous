import type { LLMToolSpec } from '../../llm/tool-spec.js';
// SolveMission — 기존 코딩 미션을 선택한 실행기로 solve 하는 front door LLM 툴 (P3 · 2026-07-21)
//
// DESIGN-cross-surface-autonomy-membrane §8 Rank1 · §10 P3 (D 북극성 교점). 대표가 지정한 **기존**
// 미션 id 를 읽어(getMission·read-only) P→E→R→D 하니스로 자율해결. 진행/승인이 이 서피스(telegram 등)로.
//
//   dispatch: (subprocess 위임) → getMission(read-only) → defaultSeams → solveMissionViaHarness(막·autoDrive)
//
// ★★ 미션 DB 방화벽 (제1원칙·[[feedback_signal_wiring_via_mission]]):
//   **읽기전용** — openAutopilotMissionsDb→getMission→close 만. 상태전이/생성/삭제 write 0.
//   solveMissionViaHarness 는 store 를 아예 안 받아 구조적으로 DB 쓰기 불가. 미션 생성/승인/상태전이는
//   대표(HITL) 전용 — 이 툴은 **실행-UX 만**. LLM 이 이 툴로 미션을 신설/완료처리할 수 없다.
//
// ★ #24 격리: RunDevHarness 와 동형으로 데몬 서피스(ctx 존재)면 subprocess 위임(detached-hitl IPC 재사용·
//   `_detachedKind='solve-mission'`)해 데몬 이벤트루프를 격리. 하니스 동기 op(implement)가 데몬을 안 굶김.
//
// 배선 = RunDevHarness(#4812) 복제 — 4곳(이 파일 · native-tool-catalog · daemon-tools · monad-agent-turn).

import { tierModel } from '../../llm/model-defaults.js';

import type { DaemonToolDispatchCtx } from '../../boot/daemon-tools/types.js';
import { surfaceUxFromDispatchCtx } from '../../agent/surface-ux/build.js';
import { resolveAutoDrive } from './dev-harness.js';
import { debug } from '../../debug/log.js';
import type { MissionRow } from '../../autopilot/mission-registry.js';
import type { SolveMissionExecutor } from '../../harness/mission-harness.js';

export function buildSolveMissionTool(): LLMToolSpec {
  return {
    name: 'SolveMission',
    description:
      'Autonomously SOLVE an EXISTING coding mission in an isolated git worktree, then open a DRAFT pull request. ' +
      'The executor is self-implement. Reads the mission by id (read-only — never creates, approves, or changes mission ' +
      'status; those stay human-gated). Only coding-domain missions are solvable; others are refused. Use when the user ' +
      'names an existing mission to develop/resolve (e.g. "이 미션 하니스로 풀어줘", "mission <id> 자율해결", ' +
      '"저 미션 구현해줘"). auto_drive: "safe" (default) / "off" / "on". Coding + gate autonomous; PR-open is a ' +
      'fail-closed human gate. Long-running (minutes).',
    parameters: {
      type: 'object',
      properties: {
        mission_id: { type: 'string', description: 'The id of the EXISTING mission to solve (read via getMission; never created here).' },
        auto_drive: { type: 'string', enum: ['off', 'safe', 'on'], description: 'Autonomy level (default "safe"). "off"=every gate to operator; "safe"=low-risk auto, PR-open to operator; "on"=fully autonomous (PR-open still fail-closed).' },
        executor: { type: 'string', enum: ['self-implement'], description: 'Execution path: "self-implement" is the default when omitted.' },
        base: { type: 'string', description: 'Base branch to worktree from (default: repo default).' },
      },
      required: ['mission_id'],
      additionalProperties: false,
    },
  };
}

/** 테스트/대체 주입. deps 존재 시 subprocess 위임을 건너뛰고 인프로세스 실행(격리 테스트). */
export interface SolveMissionDeps {
  /** 미션 read(기본 openAutopilotMissionsDb+getMission·read-only). 테스트가 row/null 직접 주입. */
  readMission?: (id: string) => MissionRow | null;
  /** solve 구동(기본 solveMissionViaHarness). 테스트가 fake 주입 → subprocess/LLM 불요. */
  solve?: (input: { mission: MissionRow; autoDrive: 'off' | 'safe' | 'on'; executor?: SolveMissionExecutor; base?: string }) => Promise<{ output: string }>;
}

export async function dispatchSolveMission(
  rawArgs: Record<string, unknown>,
  ctx?: DaemonToolDispatchCtx,
  deps?: SolveMissionDeps,
): Promise<{ output: string }> {
  const missionId = typeof rawArgs.mission_id === 'string' ? rawArgs.mission_id.trim() : '';
  if (!missionId) throw new Error('SolveMission: mission_id required');
  const autoDrive = resolveAutoDrive(rawArgs, ctx?.userText);
  if (rawArgs.executor === 'staged') throw new Error('SolveMission: executor staged is retired');
  const executor: SolveMissionExecutor | undefined = rawArgs.executor === 'self-implement'
    ? rawArgs.executor
    : undefined;

  // ★ #24 격리 — 데몬 서피스(ctx)면 subprocess 위임(RunDevHarness 동형). off/safe HITL 은 detached-hitl
  //   IPC 로 릴레이(A1 재사용). `_detachedKind='solve-mission'` 로 자식이 이 dispatch 를 인프로세스 실행.
  //   재귀 가드: 위임된 subprocess(ELANOUS_HARNESS_DETACHED)·테스트 주입(deps)·ctx 없는 CLI 는 인프로세스.
  if (ctx && !deps && !process.env.ELANOUS_HARNESS_DETACHED) {
    const { dispatchRunDevHarnessDetached } = await import('../../harness/dispatch-detached.js');
    const relayUx = surfaceUxFromDispatchCtx(ctx);
    debug.log('harness.frontdoor', 'solve-mission-delegate-detached', { missionId, autoDrive, surface: relayUx.surface, interactive: relayUx.interactive });
    const detachedArgs = { ...rawArgs, mission_id: missionId, auto_drive: autoDrive, _detachedKind: 'solve-mission' };
    return dispatchRunDevHarnessDetached(detachedArgs, {
      onProgress: (msg) => { try { relayUx.progress(msg, { phase: 'delta' }); } catch { /* fail-soft */ } },
      hitlRelay: relayUx,
    });
  }

  // ── in-process(자식 subprocess 또는 테스트) — 미션 read-only → solve ──
  const base = typeof rawArgs.base === 'string' && rawArgs.base.trim() ? rawArgs.base.trim() : undefined;

  // 미션 read (read-only·store 열면 반드시 close). 테스트는 deps.readMission 주입.
  let mission: MissionRow | null;
  if (deps?.readMission) {
    mission = deps.readMission(missionId);
  } else {
    const { openAutopilotMissionsDb, getMission } = await import('../../autopilot/mission-registry.js');
    const store = openAutopilotMissionsDb();
    try { mission = getMission(store, missionId); } finally { store.close(); }
  }
  if (!mission) {
    debug.log('harness.frontdoor', 'solve-mission-not-found', { missionId });
    return { output: `SolveMission ⚠️ 미션 '${missionId}' 을 찾을 수 없음(read-only 조회). id 를 확인하세요.` };
  }

  // 테스트 주입 solve(구독).
  if (deps?.solve) {
    return deps.solve({ mission, autoDrive, ...(executor ? { executor } : {}), ...(base ? { base } : {}) });
  }

  const ux = surfaceUxFromDispatchCtx(ctx ?? {});
  debug.log('harness.frontdoor', 'solve-mission-dispatch', {
    missionId, domain: mission.domain ?? 'coding', autoDrive, surface: ux.surface, interactive: ux.interactive,
  });
  try {
    const { setEventLoopActivity } = await import('../../debug/event-loop-watchdog.js');
    setEventLoopActivity(`harness:solve-mission:${missionId}`);
  } catch { /* fail-soft */ }

  // seam 구성 — dev-harness 와 동일(configDir/stateDir 격리·'self' 타깃=targetOptions 없음).
  const { defaultSeams } = await import('../../self-implement/seams.js');
  const { childInstanceScope } = await import('../../instance/child-scope.js');
  const childScope = childInstanceScope();
  const seams = defaultSeams({
    ...childScope,
    ...(ctx?.signal ? { signal: ctx.signal } : {}),
  });

  // LLM 리뷰어(critique·rework 자동수정) — dev-harness 와 동일 엔진. fail-soft.
  const { streamLLM } = await import('../../llm.js');
  const reviewModel = process.env.ELANOUS_PR_REVIEW_MODEL || tierModel('better');
  const llmReview = (prompt: string): Promise<string> =>
    streamLLM([{ role: 'user', content: prompt }], () => {}, { model: reviewModel, reasoningEffort: 'medium' });

  const { solveMissionViaHarness, isSolveRefusal } = await import('../../harness/mission-harness.js');
  const result = await solveMissionViaHarness({ mission, seams, ux, autoDrive, llmReview, ...(executor ? { executor } : {}), ...(base ? { base } : {}) });

  if (isSolveRefusal(result)) {
    return { output: `SolveMission ⚠️ 거부: ${result.detail}` };
  }
  const ref = result.deployRef ?? '';
  const head = `🧩 미션 '${missionId}' solve — ${result.terminal}${result.ok ? '' : ' (미완)'}`;
  const tail = ref ? `\n${ref}` : (result.detail ? `\n${result.detail}` : '');
  debug.log('harness.frontdoor', 'solve-mission-done', { missionId, terminal: result.terminal, ok: result.ok, rounds: result.rounds });
  return { output: `${head}${tail}` };
}
