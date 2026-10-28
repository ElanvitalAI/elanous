// ── 자율tool 조립기 — turn 조립기 통일 Phase 1 (2026-07-22) ──
//
// 메신저 서피스(telegram/discord)가 노출하던 무거운 자율툴 5종의 spec 조립 + per-turn
// dispatch 배선을 makeElanousAgentRunTurn 인라인에서 이 헬퍼로 추출한다. 종전 telegram 이 ~120줄
// 인라인으로 굴리던 것(delegate_code_agent · SelfImplement · RelayShellPrompt · RunDevHarness ·
// SolveMission)을 단일 출처로 — daemon-tools 가 부분 중복(delegate·SelfImplement)하던 것도 이후
// 이 헬퍼로 수렴 가능. 공통 앱 tool 단일화(Phase 0 buildSharedAppTools)의 자율tool 대응편.
//
// 골든룰(turn 조립기 통일) — 추출 전후 spec 이름배열 diff=0. buildAutonomousToolSpecs() 의 이름
// 배열이 종전 인라인 `[delegateSpec, …(nest? []: [SelfImplement, RunDevHarness, SolveMission])]`
// 과 정확히 일치(autonomous-tools.test 스냅샷 가드). dispatch 배선(HITL 채널·wrapAutonomousTool·
// nest-cap)은 서피스-무관 ctx 로만 파라미터화 — 서피스 고유(delegate 아밍·footer 추적)는 onDelegated
// 콜백으로 위임(tgChat/dcChannel 정체성은 서피스가 소유).

import { buildDelegateAgentTool, dispatchDelegateAgent } from '../boot/daemon-tools/delegate-agent.js';
import { buildSelfImplementDaemonSpec, dispatchSelfImplement, dispatchSelfImplementManaged } from '../boot/daemon-tools/self-implement.js';
// ⛔ 잎 모듈에서 받는다 — 순환 import TDZ 를 «구조적으로» 없앤 자리(`self-implement-names.ts` 머리말).
import { SELF_IMPLEMENT_TOOL_NAMES } from '../boot/daemon-tools/self-implement-names.js';
import { dispatchRelayShellPrompt } from '../skills/tools/relay-shell.js';
import { dispatchRunDevHarness, buildRunDevHarnessTool, isDevHarnessModelSurfaceEnabled } from '../skills/tools/dev-harness.js';
import { dispatchSolveMission, buildSolveMissionTool } from '../skills/tools/solve-mission.js';
import { nestCapReached } from './nest-depth.js';
import { wrapAutonomousTool } from './surface-ux/wrap.js';
import type { LLMToolSpec } from '../llm.js';
import type { ConfirmChannel } from '../hitl/confirm.js';
import type { QuestionChannel } from '../hitl/question.js';
import type { FileSink } from '../channel/file-sink.js';
import type { FeedbackEnvelope } from '../feedback/envelope.js';

/** Map a `delegate_code_agent` backend to the slash key active-delegation
 *  (and runAcpViaSlash) expect. Returns null for backends with no slash
 *  continuation path. (Moved here from monad-agent-turn for reuse; that
 *  module re-exports for compat.) */
export function delegateBackendToSlashKey(backend: string): string | null {
  const b = backend.toLowerCase();
  if (b.startsWith('claude')) return 'claude';
  if (b.startsWith('codex') || b === 'cas' || b === 'cx') return 'codex';
  if (b.startsWith('gemini') || b === 'gem') return 'gemini';
  return null; // grok etc. have no slash-continue path — leave to the brain
}

/** 자율tool dispatch 가 라우팅하는 툴 이름들(delegate + SelfImplement 별칭 + relay/harness/mission).
 *  spec 이름배열(buildAutonomousToolSpecs)과 별개 — dispatch 는 self_implement 별칭도 받는다. */
export const DEV_REQUEST_HARNESS_TOOL_NAMES: readonly string[] = [
  // ⛔ 복붙하지 않는다 — 잎 모듈이 SSOT 다. (자식이 TDZ 를 만나 이 둘을 문자열로 «복제»했었다.
  //    근본은 순환이었고 `self-implement-names.ts` 로 끊었으므로 다시 편다.)
  ...SELF_IMPLEMENT_TOOL_NAMES,
  'RunDevHarness',
  'SolveMission',
];

export const AUTONOMOUS_TOOL_NAMES: readonly string[] = [
  'delegate_code_agent',
  ...DEV_REQUEST_HARNESS_TOOL_NAMES,
  'RelayShellPrompt',
];

const AUTONOMOUS_TOOL_NAME_SET = new Set<string>(AUTONOMOUS_TOOL_NAMES);

/** 이 이름이 자율tool dispatch 대상인가(그 외는 서피스의 baseDispatch). */
export function isAutonomousTool(name: string): boolean {
  return AUTONOMOUS_TOOL_NAME_SET.has(name);
}

/** 메신저 서피스가 노출하는 자율tool spec 5종. 종전 telegram 인라인 조립과 동일 순서·nest-cap 규율:
 *  delegate 는 항상, 무거운 spawn 3종(SelfImplement/RunDevHarness/SolveMission)은 액자 상한 초과 시 제외. */
export function buildAutonomousToolSpecs(): LLMToolSpec[] {
  return [
    buildDelegateAgentTool(),
    ...(nestCapReached() ? [] : [
      buildSelfImplementDaemonSpec(),
      ...(isDevHarnessModelSurfaceEnabled() ? [buildRunDevHarnessTool()] : []),
      buildSolveMissionTool(),
    ]),
  ];
}

/** 서피스가 매 턴 실어주는 자율tool dispatch ctx. 채널/시그널/피드백은 서피스-무관 배선이고,
 *  delegate 아밍·footer 추적 같은 서피스 고유는 onDelegated 콜백으로 서피스가 처리한다. */
export interface AutonomousToolTurnCtx {
  cwd: string;
  signal: AbortSignal;
  /** Core-turn identity used to make a managed SelfImplement admission retry-safe. */
  sessionId?: string;
  toolCallId?: string;
  surfaceHitlChannels?: ConfirmChannel[];
  surfaceQuestionChannels?: QuestionChannel[];
  surfaceFileSink?: FileSink;
  emitFeedback?: (env: FeedbackEnvelope) => void;
  /** #24 auto_drive 추론(RunDevHarness) + SolveMission 원본 텍스트. */
  userText?: string;
  /** 테스트에서 전역 mock 없이 SelfImplement 디스패치 컨텍스트를 관측하는 per-call seam. */
  selfImplementDispatch?: typeof dispatchSelfImplement;
  /** 미션 페이즈 실행 시 delegate 로 상관관계 전달(missionId/phaseId). */
  missionContext?: { missionId: string; phaseId: string };
  /** delegate_code_agent 위임 직후 서피스 훅 — footer 의 delegatedBackend 추적 + active-delegation
   *  아밍(tgChat/dcChannel 정체성은 서피스가 소유). failed=결과에 error 있음(아밍 스킵). */
  onDelegated?: (backend: string, failed: boolean) => void;
}

/** 자율tool 1건을 서피스-무관 배선으로 dispatch. delegate 는 HITL 채널+미션상관 전달 후 onDelegated
 *  훅, 나머지 무거운 3종은 wrapAutonomousTool(nest-cap+start-ack+spill) 경유, RelayShell 은 채널만
 *  실어 직접 dispatch(래핑 없음 — 종전 telegram 과 동형). 비-자율tool 이름은 호출 금지(호출처가
 *  isAutonomousTool 로 선분기). */
export async function dispatchAutonomousTool(
  name: string,
  args: Record<string, unknown>,
  ctx: AutonomousToolTurnCtx,
): Promise<unknown> {
  const surfaceChannels = ctx.surfaceHitlChannels;
  const surfaceQuestionChannels = ctx.surfaceQuestionChannels;
  const surfaceFileSink = ctx.surfaceFileSink;

  if (name === 'delegate_code_agent') {
    const backend = typeof args.backend === 'string' ? args.backend.trim() : '';
    const result = await dispatchDelegateAgent({
      ...args,
      ...(ctx.missionContext ? { missionId: ctx.missionContext.missionId, phaseId: ctx.missionContext.phaseId } : {}),
    }, {
      cwd: ctx.cwd,
      // Forward the turn's abort signal so an in-flight delegation can be
      // cancelled; the surface always passes a real (or inert) signal.
      signal: ctx.signal,
      ...(surfaceChannels ? { surfaceHitlChannels: surfaceChannels } : {}),
      ...(surfaceQuestionChannels ? { surfaceQuestionChannels } : {}),
      ...(surfaceFileSink ? { surfaceFileSink } : {}),
    });
    // A — brain-initiated delegate joins the continuous coding session: hand the
    // backend + failure state back to the surface so it can arm active-delegation
    // (keyed by tgChat/dcChannel) and track delegatedBackend for the footer.
    const failed = !!(result && typeof result === 'object' && 'error' in result);
    if (backend) ctx.onDelegated?.(backend, failed);
    return result;
  }

  // SelfImplement(elanous self-build): 승인(approvePr)·진행·spill 을 막(SurfaceUx)으로 — per-turn
  // HITL 채널을 ctx 로 넘겨 dispatchSelfImplement 가 surfaceUxFromDispatchCtx 로 소비.
  // PR-open 승인은 ①operator 사전승인(config `tools.selfImplement.autoOpenPr`·기본 ON) →
  // ②아니면 ux.confirm(채널 없으면 fail-closed). 병합은 별도 게이트로 남는다.
  // wrapAutonomousTool = nest-cap+start-ack+spill.
  if ((SELF_IMPLEMENT_TOOL_NAMES as readonly string[]).includes(name)) {
    const hctx = {
      cwd: ctx.cwd,
      signal: ctx.signal,
      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
      ...(ctx.toolCallId ? { toolCallId: ctx.toolCallId } : {}),
      ...(ctx.userText ? { userText: ctx.userText } : {}),
      ...(surfaceChannels ? { surfaceHitlChannels: surfaceChannels } : {}),
      ...(surfaceQuestionChannels ? { surfaceQuestionChannels } : {}),
      ...(surfaceFileSink ? { surfaceFileSink } : {}),
      ...(ctx.emitFeedback ? { emitFeedback: ctx.emitFeedback } : {}), // start-ack/진행 push
    };
    const dispatch = ctx.selfImplementDispatch;
    return wrapAutonomousTool(
      {
        toolNames: SELF_IMPLEMENT_TOOL_NAMES as readonly string[],
        label: 'SelfImplement',
        run: () => dispatch
          ? dispatch(args, hctx as Parameters<typeof dispatchSelfImplement>[1])
          : dispatchSelfImplementManaged(args, hctx as Parameters<typeof dispatchSelfImplementManaged>[1]),
      },
      args,
      hctx,
    );
  }

  // 셸 relay 라운드트립 — 셸 안 codex/aider 프롬프트를 이 서피스의 HITL 채널로 표면화. baseDispatch
  // 경로는 ctx 를 안 넘겨 relay 가 채널 0 → fail-closed 였다. 여기서 per-turn 채널을 ctx 로 실어준다.
  // (SelfImplement 와 달리 wrapAutonomousTool 로 감싸지 않음 — 종전 telegram 동형.)
  if (name === 'RelayShellPrompt') {
    return dispatchRelayShellPrompt(args, {
      cwd: ctx.cwd,
      signal: ctx.signal,
      ...(surfaceChannels ? { surfaceHitlChannels: surfaceChannels } : {}),
      ...(surfaceQuestionChannels ? { surfaceQuestionChannels } : {}),
      ...(surfaceFileSink ? { surfaceFileSink } : {}),
    });
  }

  // dev-harness front door(P→E→R→D): objective 를 스테이지드 하니스로 자율개발 → gate → draft PR.
  // wrapAutonomousTool 경유(nest-cap+start-ack+spill). userText 로 auto_drive on 추론(detached 위임).
  if (name === 'RunDevHarness') {
    const hctx = {
      cwd: ctx.cwd,
      signal: ctx.signal,
      ...(ctx.userText ? { userText: ctx.userText } : {}),
      ...(surfaceChannels ? { surfaceHitlChannels: surfaceChannels } : {}),
      ...(surfaceQuestionChannels ? { surfaceQuestionChannels } : {}),
      ...(surfaceFileSink ? { surfaceFileSink } : {}),
      ...(ctx.emitFeedback ? { emitFeedback: ctx.emitFeedback } : {}),
    };
    return wrapAutonomousTool(
      {
        toolNames: ['RunDevHarness'],
        label: 'RunDevHarness',
        run: () => dispatchRunDevHarness(args, hctx as Parameters<typeof dispatchRunDevHarness>[1]),
      },
      args,
      hctx,
    );
  }

  // SolveMission(P3): 기존 코딩 미션을 하니스로 read-only solve. RunDevHarness 동형. 미션 DB 무접촉.
  if (name === 'SolveMission') {
    const hctx = {
      cwd: ctx.cwd,
      signal: ctx.signal,
      ...(ctx.userText ? { userText: ctx.userText } : {}),
      ...(surfaceChannels ? { surfaceHitlChannels: surfaceChannels } : {}),
      ...(surfaceQuestionChannels ? { surfaceQuestionChannels } : {}),
      ...(surfaceFileSink ? { surfaceFileSink } : {}),
      ...(ctx.emitFeedback ? { emitFeedback: ctx.emitFeedback } : {}),
    };
    return wrapAutonomousTool(
      {
        toolNames: ['SolveMission'],
        label: 'SolveMission',
        run: () => dispatchSolveMission(args, hctx as Parameters<typeof dispatchSolveMission>[1]),
      },
      args,
      hctx,
    );
  }

  throw new Error(`dispatchAutonomousTool: '${name}' 은 자율tool 이 아님 (isAutonomousTool 로 선분기 필요)`);
}
