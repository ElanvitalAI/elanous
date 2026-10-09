// Tier 2 · across-turn goal-execution loop (2026-07-19 goal-exec 아크).
//
// `runCoreTurn` 은 ONE within-turn 툴 루프(모델이 툴 호출을 멈추고 최종 텍스트를
// 뱉으면 종료)다. 그게 "끝"이라고 믿고 턴을 닫으면 codex 가 (조기) 완료 선언하는
// 순간 목표가 미완인 채로 멈춘다 — 대표가 겪은 "끝까지 물고 늘어지지 못함"의 근원.
//
// `runGoalLoop` 은 그 위를 감싸는 write-once 코어: runCoreTurn 을 **반복 호출**하며
// 매 across-turn 마다 (1) 목표가 증거 기준으로 실제 완료됐는지 게이트하고 (2) 미완이면
// continuation 프롬프트를 재주입해 다음 턴을 자동 시작한다. maxIterations / no-progress
// 로 폭주를 막고, HITL 은 caller 가 stopReason 을 보고 처리(이 모듈은 headless — dashboard/
// chat/tui/display import 금지, headless-core-guard 테스트가 구조적으로 강제).
//
// 이식 출처(참조): ref/codex `codex-rs/ext/goal` continuation.md(목표는 턴을 넘어
// 생존·성공을 축소 재정의 말 것·증거로 완료 감사) + oh-my-codex `ralph`(완료 약속 없으면
// 계속) + codex-plugin-cc(정지 전 completeness contract). 이 언어가 codex 가 tune 된
// 계약이라, 하니스가 이를 제공하면 모델이 tune 된 대로 물고 늘어진다.
//
// ── Tier 2 정제 (2026-07-19 follow-up) ──
// 완료 신호를 **구조화 tool call(`update_goal`)** 로 승격했다. 텍스트 마커는 spoofable
// (dogfood 에서 산문 부분매칭으로 오완료·2026-07-19)이라, 이제 완료의 유일한 authoritative
// 신호는 `update_goal(status="complete", evidence=…)` 도구 호출이다. tool schema 가
// terminal status 를 enum 으로 제약하고 evidence 를 required 로 강제(evidence-audit).
// 기존 텍스트 마커는 **deprecated fallback** — 마커만 나오면 완료로 인정하지 않고 read-back
// 게이트(ralph)로 "update_goal 로 확정하라"를 재주입한다(2회 무응답 → HITL 승격). 그리고
// 오버플로 컨텍스트에 continuation 을 무작정 재주입하지 않도록 context-pressure bail 을 둔다.

import { extractRecentUserText, runCoreTurn } from './run-core-turn.js';
import type { CoreTurnContext, CoreTurnResult, CoreTurnStopReason } from './types.js';
import { getToolLoopPhaseRejectedTools } from '../llm.js';
import type { LLMMessage, ContentBlock, LLMToolSpec } from '../llm.js';
import type { LLMUsage } from '../prompt-cache/types.js';
import { debug } from '../debug/log.js';
import { publishGoalLifecycle } from '../goals/loop.js';
import { boundReadableText } from '../self-implement/orchestrator.js';
import { changedFiles } from '../self-implement/seams.js';
import { getHarnessRunId, getHarnessSpace } from '../harness/harness-space.js';
import { CONTROL_INBOX_DIR_ENV, drainControlInbox, drainSoftStopControlInbox, enqueueControlMemo, type ControlInboxDrain, type ControlMemoPayload } from '../harness/control-inbox.js';
import { enqueuePendingUserInput } from '../session/pending-input.js';
import { getCurrentPtyId } from '../agent/pty-identity.js';
import { attachLifecycleBridge } from '../signal/lifecycle-bridge.js';
import { getChannelBus } from '../terminal-matrix/index.js';
import type { ChannelBus } from '../terminal-matrix/channel-bus.js';
import { startChildLivenessHeartbeat } from './child-liveness-heartbeat.js';

export {
  CHILD_LIVENESS_HEARTBEAT_ENV,
  CHILD_LIVENESS_HEARTBEAT_FILE,
  DEFAULT_CHILD_LIVENESS_HEARTBEAT_MS,
  mergeChildLivenessHeartbeat,
  readChildLivenessHeartbeatAt,
  resolveChildLivenessHeartbeatPath,
  startChildLivenessHeartbeat,
} from './child-liveness-heartbeat.js';

interface ProcessLifecycleBridge {
  readonly runId: string;
  readonly ptyId: string;
  readonly detach: () => void;
}

let processLifecycleBridge: ProcessLifecycleBridge | null = null;
let lifecycleBridgeExitHookInstalled = false;

export const GOAL_LOOP_FINAL_TEXT_EXCERPT_MAX_CHARS = 2_000;

function detachProcessLifecycleBridge(): void {
  const bridge = processLifecycleBridge;
  if (!bridge) return;
  processLifecycleBridge = null;
  try {
    bridge.detach();
  } catch (error) {
    debug.log('signal', 'lifecycle.bridge-detach-failed', {
      runId: bridge.runId,
      ptyId: bridge.ptyId,
      error: error instanceof Error ? error.message : String(error),
    }, { level: 'warn' });
  }
}

function installLifecycleBridgeExitHook(): void {
  if (lifecycleBridgeExitHookInstalled) return;
  lifecycleBridgeExitHookInstalled = true;
  process.once('exit', detachProcessLifecycleBridge);
}

function ensureProcessLifecycleBridge(
  bus: ChannelBus,
  attach: (bus: ChannelBus, runId: string) => () => void,
): void {
  const runId = getHarnessRunId();
  const ptyId = getCurrentPtyId();
  if (!runId || !ptyId) {
    debug.log('signal', 'lifecycle.bridge.skip-no-identity', {
      missing: [!runId && 'runId', !ptyId && 'ptyId'].filter(Boolean),
    });
    return;
  }
  if (processLifecycleBridge) return;

  try {
    const detach = attach(bus, runId);
    processLifecycleBridge = { runId, ptyId, detach };
    installLifecycleBridgeExitHook();
    debug.log('signal', 'lifecycle.bridge-attached', { runId, ptyId });
  } catch (error) {
    debug.log('signal', 'lifecycle.bridge-attach-failed', {
      runId, ptyId, error: error instanceof Error ? error.message : String(error),
    }, { level: 'warn' });
  }
}

/** Test seam — releases the process-owned subscription between isolated tests. */
export function resetGoalLoopLifecycleBridgeForTesting(): void {
  detachProcessLifecycleBridge();
}

/** @deprecated 완료의 authoritative 신호는 `update_goal(complete)` 도구다. 이 마커는
 *  텍스트 fallback 으로만 감지되며 단독으로 완료를 확정하지 않는다(read-back 게이트). */
export const GOAL_COMPLETE_MARKER = 'GOAL-COMPLETE';

/** @deprecated blocked 도 `update_goal(blocked)` 가 authoritative. 이 마커는 fallback. */
export const GOAL_BLOCKED_MARKER = 'GOAL-BLOCKED';

/** 목표 종결(완료/차단)을 구조적으로 선언하는 도구 이름. 루프가 매 turn `ctx.tools` 에
 *  주입하고, 모델이 이걸 호출하면 그 결과로 across-turn 을 종료한다. dispatch 는 루프가
 *  가로채 benign ack 를 돌려준다(실 dispatcher 로 새지 않음). */
export const UPDATE_GOAL_TOOL_NAME = 'update_goal';

/** 목표 종결 선언 도구 스펙. status enum + evidence required 로 완료를 증거-게이트한다
 *  (ref codex ext/goal `tool.rs` update_goal — terminal status 를 schema 로 제약). */
export function buildUpdateGoalToolSpec(): LLMToolSpec {
  return {
    name: UPDATE_GOAL_TOOL_NAME,
    description:
      '목표 실행의 종결 상태를 구조적으로 선언한다. 목표가 실제로 완전히 끝났고 현재 상태' +
      '(파일·명령 출력·테스트 결과·PR·런타임 동작)에서 증거로 확인됐을 때만 status="complete" 로 ' +
      '호출하고 그 증거를 evidence 에 구체적으로 적는다. 같은 장애가 반복되고 대안도 없어 진짜로 ' +
      '막혔을 때만 status="blocked" 로 호출한다. 의도·부분진전·이전 작업 기억·그럴듯한 답은 완료 ' +
      '증거가 아니다. 예산 소진/그만두고 싶음을 이유로 complete 하지 마라. 완료도 차단도 아니면 이 ' +
      '도구를 호출하지 말고 다음 최고가치 스텝을 바로 실행하라. 완료 신호는 이 도구 호출뿐이다.',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['complete', 'blocked'],
          description: 'complete=모든 요구사항이 증거로 충족 · blocked=같은 장애 반복으로 막힘(대안 없음)',
        },
        evidence: {
          type: 'string',
          description:
            '현재 상태에서 실제로 확인한 증거(파일 경로·명령 출력·테스트 결과·PR·런타임 동작). ' +
            'complete 에는 필수 — 비우면 완료로 인정하지 않는다. blocked 면 무엇이 왜 막혔는지.',
        },
        reason: {
          type: 'string',
          description: '보조 설명(선택). blocked 의 시도한 대안 등.',
        },
      },
      required: ['status', 'evidence'],
      additionalProperties: false,
    },
  };
}

/** 목표 실행 계약 — 첫 turn 앞에 leading system 메시지로 주입. codex 자체 prompt.md /
 *  ext-goal continuation.md 의 지속·anti-shrink·증거완료 언어 이식. ASCII + 한국어. */
export const GOAL_SYSTEM_PREAMBLE = [
  '[goal execution contract]',
  '- 이 목표는 여러 턴에 걸쳐 지속된다. 한 턴이 끝난다고 목표를 지금 맞출 수 있는 크기로 축소하지 마라.',
  '- 더 쉽거나 안전하거나 테스트를 통과하기 쉬운 좁은 해법으로 대체하지 마라. 원래 목표를 끝까지 관철하라.',
  '- 완료는 증거로 판정한다. 모든 요구사항/산출물/검증에 대해 실제 현재 상태에서 증거를 확인하라. 불확실하거나 간접적인 증거는 미달성으로 보고 계속하라.',
  `- 목표가 실제로 완전히 끝났고 증거로 확인됐을 때만 ${UPDATE_GOAL_TOOL_NAME} 도구를 status="complete" 로 호출하고 evidence 에 그 증거를 적어 종료하라. 완료 신호는 이 도구 호출뿐이다(텍스트 문장이 아니다).`,
  '- 아직 할 일이 남았으면 멈추거나 허락을 구하지 말고 다음 최고가치 스텝을 바로 실행하라.',
].join('\n');

/** 미완 판정 시 재주입하는 continuation 프롬프트(user turn). */
export const GOAL_CONTINUATION_PROMPT = [
  '[continue]',
  '아직 목표가 완료로 증명되지 않았다. 완료를 미리 선언하지 말고, 현재 상태 대비 실제로 검증하라:',
  '남은 요구사항을 식별하고, 다음 최고가치 스텝을 지금 도구로 실행하라.',
  '이미 사용자에게 한 답을 다시 쓰지 마라 — 새 사실이 없으면 텍스트 없이 update_goal 만 호출하라.',
  // evidence-audit(ref codex ext/goal continuation.md:41,51) — 스푸핑·조기완료 차단.
  '완료 증거로 의도/부분진전/이전 작업 기억/그럴듯한 답을 쓰지 마라. 현재 상태(파일·명령출력·테스트결과·PR·런타임 동작)를 실제로 확인한 증거만 인정한다.',
  '예산이 곧 소진된다거나 그만두고 싶다는 이유로 완료를 선언하지 마라.',
  `진짜로 진행이 막혔고(같은 장애가 반복) 대안도 없을 때만 ${UPDATE_GOAL_TOOL_NAME} 도구를 status="blocked" 로 호출하고 무엇이 왜 막혔는지 evidence 에 적어라. 단지 어렵거나 느리거나 불확실하다는 이유로는 쓰지 마라.`,
  `모든 요구사항이 증거로 충족됐다면, ${UPDATE_GOAL_TOOL_NAME} 도구를 status="complete" + evidence 로 호출해 종료하라.`,
].join('\n');

/** 감독 메모 블록의 머리말 — 자식이 「이것은 부모가 보낸 것」임을 «구별»하게 한다. */
const SUPERVISOR_MEMO_HEADER = '[감독 메모 — 부모가 보냄. 지금 계획을 대체하지 말고 함께 반영하라]';

/** read-back 게이트 — 텍스트로만 완료를 주장(마커·산문)했을 때 재주입. 완료의 유일한
 *  authoritative 신호가 구조화 도구임을 다시 요구(ralph 재검증). */
export const GOAL_READBACK_PROMPT = [
  '[finalize]',
  `완료를 텍스트로만 말했다. 텍스트 문장은 완료 신호가 아니다 — 완료가 사실이면 ${UPDATE_GOAL_TOOL_NAME} 도구를 status="complete" 로 호출하고 evidence 에 현재 상태에서 실제로 확인한 증거(파일·명령출력·테스트·PR)를 적어라.`,
  '아직 미충족 항목이 있으면 완료를 주장하지 말고 다음 스텝을 지금 실행하라.',
  '이미 사용자에게 한 답을 다시 쓰지 마라 — 새 사실이 없으면 텍스트 없이 update_goal 만 호출하라.',
].join('\n');

/** evidence 누락 complete 재주입 — update_goal(complete) 를 호출했으나 evidence 가 비었을 때. */
export const GOAL_EVIDENCE_REQUIRED_PROMPT = [
  '[evidence required]',
  `${UPDATE_GOAL_TOOL_NAME}(status="complete") 를 호출했지만 evidence 가 비어 있어 완료로 인정하지 않는다.`,
  '현재 상태(파일·명령출력·테스트결과·PR)에서 실제로 확인한 증거를 evidence 에 채워 다시 호출하거나, 미충족 항목을 마저 실행하라.',
].join('\n');

/** evidence-mismatch 반려 재주입 (OH8 후속 PR-2) — update_goal(complete) 를 호출했으나 그 턴까지의
 *  마지막 `run_tests` 결과가 ok=false(fail>0 또는 미매칭 필터)일 때. 모델이 evidence 텍스트에 무엇을
 *  적었든 실제 툴 출력(spoofable 하지 않은 구조체)의 ok 를 반증으로 쓴다. 구체 수치(fail·unmatched)를
 *  주입해 테스트를 통과시키거나 완료 주장을 철회하도록 유도. `{n}` 은 채워질 자리표시 없이 런타임 조립. */
export function buildEvidenceMismatchPrompt(fail: number, unmatchedFilters: readonly string[]): string {
  const unmatched = unmatchedFilters.length > 0 ? `[${unmatchedFilters.join(', ')}]` : '(none)';
  return [
    '[evidence mismatch]',
    `${UPDATE_GOAL_TOOL_NAME}(status="complete") 를 호출했지만 마지막 run_tests 결과가 실패/미매칭이다 ` +
      `(fail=${fail}, unmatched=${unmatched}). 완료 증거와 실제 테스트 결과가 어긋난다 — 완료로 인정하지 않는다.`,
    '테스트를 실제로 통과시키거나(fail=0 · 모든 필터 매칭), 완료 주장을 철회하고 남은 작업을 마저 실행하라.',
    '통과한 run_tests 없이 complete 를 다시 주장하지 마라.',
  ].join('\n');
}

/** Same-turn followup-guard rejections contradict a completion claim. */
export function buildRejectedToolCompletionPrompt(rejectedTools: readonly string[]): string {
  return [
    '[tool call rejected]',
    `${UPDATE_GOAL_TOOL_NAME}(status="complete") 를 호출했지만 이 turn 에 ${rejectedTools.join(', ')} 도구 호출이 거부되어 실행되지 않았다. 완료 증거와 실제 도구 결과가 어긋난다 — 완료로 인정하지 않는다.`,
    '거부된 작업을 실제로 다시 실행하거나 완료 주장을 철회하고 남은 작업을 마저 실행하라.',
  ].join('\n');
}

export interface GoalLoopOptions {
  /** 목표 문구(관측·프레이밍용). 생략 시 마지막 user 메시지에서 추출. */
  objective?: string;
  /** across-turn 최대 반복. 폭주 방지 하드캡. 기본 8. (ralph max_iterations 류) */
  maxIterations?: number;
  /** 연속 무진전(동일 tool 시그니처 반복) 허용 횟수 → 초과 시 no_progress 종료로 caller 가
   *  HITL 표면화. 기본 2. spin 방지 레일(ref lazycodex RESUME_CAP). */
  noProgressLimit?: number;
  /** goal preamble 주입 여부. 기본 true. 이미 caller 가 목표 계약을 넣었으면 false. */
  injectPreamble?: boolean;
  /** context-pressure bail — 모델 컨텍스트 윈도우(토큰). 재주입 직전 관측된 input 토큰이
   *  이 값 * ratio 를 넘으면 오버플로 윈도우에 continuation 을 밀어넣지 않고 context_pressure
   *  로 종료해 caller 가 compact 후 재개하게 한다(ref ext/goal anti-spin: overflow 재주입 금지).
   *  0/미지정 = bail 비활성(윈도우 미상). bridge 가 resolveModelContextWindow 로 주입. */
  contextTokenLimit?: number;
  /** context-pressure 임계 비율. 기본 0.85(elanous chat.autoCompact triggerRatio 정합). */
  contextPressureRatio?: number;
  /** 테스트 seam — runCoreTurn 주입(모듈 mock 오염 회피). 기본 = 실제 runCoreTurn. */
  runTurn?: (ctx: CoreTurnContext) => Promise<CoreTurnResult>;
  /** Test seam — process-owned lifecycle bridge attach. */
  attachLifecycleBridge?: (bus: ChannelBus, runId: string) => () => void;
  /** Test seam — snapshot the child worktree at successful completion. */
  changedFiles?: (cwd: string) => string[];
  /** Test seam — drain external soft-control at iteration entry. */
  drainControlInbox?: (spaceId: string) => ControlInboxDrain;
  /** Test seam — consume only an external stop latch after each tool result. */
  drainSoftStopControlInbox?: (spaceId: string) => ControlInboxDrain;
  /** Test seam — restore a memo consumed by a racing full drain when stop wins. */
  enqueueControlMemo?: (spaceId: string, memo: string | ControlMemoPayload) => void;
  /** Test seam — running harness/TUI space id. */
  controlSpaceId?: string | null;
  /** Test seam — file-backed child liveness heartbeat. Default starts the workspace-file writer. */
  startLivenessHeartbeat?: typeof startChildLivenessHeartbeat;
}

export type GoalLoopStopReason =
  | CoreTurnStopReason        // aborted | error | end_turn | max_turns (마지막 turn 것)
  | 'goal_complete'           // update_goal(complete)+evidence 로 완료 선언
  | 'soft_stop'               // 외부 inbox stop — 현재 iteration 완료 후 다음 iteration 미진입
  | 'max_iterations'          // 반복 하드캡 도달
  | 'no_progress'             // 연속 무진전 → HITL 필요
  | 'context_pressure';       // 컨텍스트 오버플로 임박 → compact 후 재개 필요

export interface GoalLoopResult {
  finalText: string;
  iterations: number;
  stopReason: GoalLoopStopReason;
  /** 목표가 증거 기준 완료로 선언됐는지(update_goal(complete)+evidence 감지). */
  goalComplete: boolean;
}

/** 완료 마커 감지(deprecated fallback) — 마커가 산문 안에 우연히 포함(예: "상수 값은
 *  GOAL-COMPLETE 이다")돼도 오완료하지 않도록 **단독 줄**로만 인정한다. 이제 이 신호는
 *  완료를 확정하지 않고 read-back 게이트로만 쓴다. */
function hasCompletionMarker(text: string): boolean {
  return text.split('\n').some((line) => line.trim() === GOAL_COMPLETE_MARKER);
}

/** blocked 마커 감지(deprecated fallback) — 단독 줄만 인정(완료 마커와 동형). */
function hasBlockedMarker(text: string): boolean {
  return text.split('\n').some((line) => line.trim() === GOAL_BLOCKED_MARKER);
}

/** 이 turn 의 새 메시지에서 **거부된** 도구 호출 이름을 모은다(중복 제거).
 *  판정 근거는 툴루프 가드의 canonical 거부 스텁 하나이며, 문자열은 `src/llm.ts` 가 소유한다
 *  (`getToolLoopPhaseRejectedTools`) — 여기서 접두사를 다시 하드코딩하지 않는다. */
function findRejectedToolCalls(newMessages: readonly LLMMessage[]): string[] {
  const rejected = new Set<string>();
  for (const message of newMessages) {
    if (typeof message.content === 'string') continue;
    for (const block of message.content) {
      if (block.type !== 'tool_result') continue;
      const contents = typeof block.content === 'string'
        ? [block.content]
        : block.content.filter((item) => item.type === 'text').map((item) => item.text);
      for (const content of contents) {
        for (const name of getToolLoopPhaseRejectedTools(content) ?? []) rejected.add(name);
      }
    }
  }
  return [...rejected];
}

/** 이 turn 의 새 메시지에서 마지막 `update_goal` 도구 호출을 찾아 구조화 종결 상태를
 *  반환한다. status 가 enum 밖이면 무시(null). evidence/reason 은 문자열만 수용. */
function findGoalUpdate(
  newMessages: readonly LLMMessage[],
): { status: 'complete' | 'blocked'; evidence: string; reason?: string } | null {
  let found: { status: 'complete' | 'blocked'; evidence: string; reason?: string } | null = null;
  for (const m of newMessages) {
    if (typeof m.content === 'string') continue;
    for (const b of m.content as ContentBlock[]) {
      const bb = b as { type?: string; name?: string; input?: Record<string, unknown> };
      if (bb.type !== 'tool_use' || bb.name !== UPDATE_GOAL_TOOL_NAME) continue;
      const inp = bb.input ?? {};
      const status = inp.status === 'complete' ? 'complete' : inp.status === 'blocked' ? 'blocked' : null;
      if (!status) continue;
      found = {
        status,
        evidence: typeof inp.evidence === 'string' ? inp.evidence : '',
        ...(typeof inp.reason === 'string' ? { reason: inp.reason } : {}),
      };
    }
  }
  return found;
}

/** 이 턴의 도구 호출 시그니처(이름+args). 직전 턴과 동일하면 spin(무진전)으로 본다.
 *  ref lazycodex rail#5(ledger movement) 근사 — 관측 가능한 새 활동이 없으면 재주입해도 헛돈다.
 *  update_goal 은 종결 신호라 시그니처에서 제외(완료/차단 선언은 spin 이 아니다). */
function toolCallSignature(newMessages: readonly LLMMessage[]): string {
  const calls: string[] = [];
  for (const m of newMessages) {
    if (typeof m.content === 'string') continue;
    for (const b of m.content as ContentBlock[]) {
      const bb = b as { type?: string; name?: string; input?: unknown };
      if (bb.type === 'tool_use' && bb.name !== UPDATE_GOAL_TOOL_NAME) {
        calls.push(`${bb.name}:${JSON.stringify(bb.input ?? {})}`);
      }
    }
  }
  return calls.join('|');
}

/** 이 across-turn 이 실제 "진전"을 냈는지 — 도구를 호출했으면(tool_use) 진전으로 본다.
 *  순수 텍스트만 나온 턴은 진전 없음(모델이 답만 하고 멈춤). update_goal 도 도구 활동으로 본다. */
function hadToolActivity(newMessages: readonly LLMMessage[]): boolean {
  for (const m of newMessages) {
    if (typeof m.content === 'string') continue;
    for (const b of m.content as ContentBlock[]) {
      if ((b as { type?: string }).type === 'tool_use') return true;
    }
  }
  return false;
}

function extractObjective(messages: readonly LLMMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content.slice(0, 200);
    const text = (m.content as ContentBlock[])
      .filter((b): b is { type: 'text'; text: string } =>
        (b as { type?: string }).type === 'text' && typeof (b as { text?: string }).text === 'string')
      .map((b) => b.text).join(' ');
    if (text) return text.slice(0, 200);
  }
  return '(objective unknown)';
}

/**
 * across-turn 목표 실행 루프. `runCoreTurn` 을 목표 완료(증거 게이트)까지 반복한다.
 *
 * 종료 조건:
 *   - goal_complete   : update_goal(complete)+evidence → 목표 달성(authoritative).
 *   - max_iterations  : 반복 하드캡 도달(미완이지만 예산 소진).
 *   - no_progress     : 연속 무진전 / update_goal(blocked) 3연속 / read-back 2회 무응답(caller→HITL).
 *   - context_pressure: 컨텍스트 오버플로 임박(caller 가 compact 후 재개).
 *   - aborted/error   : 마지막 runCoreTurn 이 취소/에러.
 *   - end_turn(순수 텍스트·도구 없음): 모델이 도구 없이 답만 함 = 목표성 작업 아님
 *     (일상 대화). 재주입 없이 그대로 수용(불필요한 루프 방지).
 *
 * 관측: 매 반복 `goal.loop` 카테고리(iteration/verdict/toolActivity) — 제1원칙.
 */
export async function runGoalLoop(
  ctx: CoreTurnContext,
  opts: GoalLoopOptions = {},
): Promise<GoalLoopResult> {
  const maxIterations = opts.maxIterations ?? 8;
  const objective = opts.objective ?? extractObjective(ctx.messages);
  const runTurn = opts.runTurn ?? runCoreTurn;
  const snapshotChangedFiles = opts.changedFiles ?? changedFiles;
  const contextTokenLimit = opts.contextTokenLimit ?? 0;
  const contextPressureRatio = opts.contextPressureRatio ?? 0.85;
  const controlSpaceId = opts.controlSpaceId === undefined ? getHarnessSpace()?.id || null : opts.controlSpaceId;
  const explicitControlInboxDir = process.env[CONTROL_INBOX_DIR_ENV]?.trim() || undefined;
  const drainControl = opts.drainControlInbox ?? ((spaceId: string) => drainControlInbox(spaceId, { explicitInboxDir: explicitControlInboxDir }));
  const drainSoftStop = opts.drainSoftStopControlInbox ?? ((spaceId: string) => drainSoftStopControlInbox(spaceId, { explicitInboxDir: explicitControlInboxDir }));
  const restoreControlMemo = opts.enqueueControlMemo ?? ((spaceId: string, memo: string | ControlMemoPayload) => enqueueControlMemo(spaceId, memo, { explicitInboxDir: explicitControlInboxDir }));

  // ⭐ 표면 판정 입력은 «루프 진입 시 한 번» 정하고 아래로는 인자로만 내려간다.
  //   ⛔ 왜: 이 루프는 라운드 사이에 «기계가 쓴» user 메시지를 여섯 자리에서 밀어 넣는다
  //     (증거요구·계속진행·리드백·재시도 둘). runCoreTurn 이 매 라운드 「마지막 user 메시지」를
  //     다시 읽으면 2라운드부터 그 «기계 문장»으로 표면이 갈린다.
  //   ✅ 진입 시점의 messages 에는 아직 그 기계 문장이 «없다» ⇒ 여기서 뽑은 값이 이 턴의 사람 문장이다.
  //   ⛔ 고정 prefix 사전으로 「기계 문장인지」를 판별하지 «않는다» — 미등록·변형 프롬프트를 오판하기 때문이다.
  const surfaceUserText = ctx.userText ?? extractRecentUserText(ctx.messages);
  const harnessRunId = getHarnessRunId();
  const runAttribution = harnessRunId ? { runId: harnessRunId } : {};

  // 목표 계약 주입(첫 turn 앞). caller 가 이미 넣었으면 injectPreamble:false.
  const messages: LLMMessage[] = [...ctx.messages];
  if (opts.injectPreamble !== false) {
    messages.unshift({ role: 'system', content: GOAL_SYSTEM_PREAMBLE });
  }

  // 종결 선언 도구를 모델 catalog 에 주입. dispatch 는 루프가 가로채 benign ack 를 준다.
  const updateGoalSpec = buildUpdateGoalToolSpec();
  const tools: LLMToolSpec[] = [...ctx.tools, updateGoalSpec];

  const noProgressLimit = opts.noProgressLimit ?? 2;
  let iterations = 0;
  let noProgress = 0;
  let blockedStreak = 0;
  let readbackStreak = 0;
  let evidenceMismatchRetried = 0;
  let rejectedToolCompletionRetried = 0;
  let lastSig = '';
  let lastInputTokens = 0;
  // OH8 후속 PR-2 — 가장 최근에 관측된 `run_tests` 결과(구조체). complete 주장의 반증으로 쓴다.
  // 리셋 판단: iteration 경계에서 리셋하지 않고 "가장 최근 run_tests"를 last-wins 로 유지한다.
  //   근거(오완료 방지): 모델이 이전 턴에 테스트 실패를 보고도 이번 턴에 test 재실행 없이 complete 만
  //   주장하는 케이스에서, 리셋하면 last=null 이 되어 반려가 미발동한다 → 거짓완료 통과. 반면
  //   유지하면 마지막 실패를 기억해 반려한다. 완료를 통과시키려면 모델이 complete 하는 턴에서 test 를
  //   재실행해 ok=true 로 갱신(last-wins)해야 하므로, "그 턴의 마지막 run_tests가 ok" 의미도 보존된다.
  //   ※ 객체 홀더: onToolResult 클로저에서 변이하므로 let narrowing 대신 property 타입으로 읽는다.
  const runTests: { last: { ok: boolean; fail: number; unmatchedFilters: string[]; pass: number } | null } = { last: null };
  let lastResult: CoreTurnResult = { stopReason: 'end_turn', finalText: '' };

  debug.log('goal.loop', 'start', {
    sessionId: ctx.sessionId, ...runAttribution, objective, maxIterations, noProgressLimit,
    contextTokenLimit, contextPressureRatio,
  }, { level: 'info' });
  const bus = getChannelBus();
  ensureProcessLifecycleBridge(bus, opts.attachLifecycleBridge ?? attachLifecycleBridge);
  publishGoalLifecycle(bus, 'started');
  // File-backed liveness starts before the first model/tool wait so a quiet child
  // still speaks on a fixed interval. Detach on every return and throw path.
  const stopLivenessHeartbeat = (opts.startLivenessHeartbeat ?? startChildLivenessHeartbeat)();
  let terminalPublished = false;
  const finish = (
    result: GoalLoopResult,
    completePayload?: { summary: string; changedFiles: readonly string[] },
  ): GoalLoopResult => {
    if (terminalPublished) return result;
    terminalPublished = true;
    try {
      if (result.goalComplete) {
        publishGoalLifecycle(bus, 'complete', completePayload ?? {
          summary: `Goal loop completed without an evidence-backed lifecycle summary (stopReason: ${result.stopReason}).`,
          changedFiles: [],
        });
      } else {
        publishGoalLifecycle(bus, 'failed', result.stopReason);
      }
    } catch (error) {
      debug.log('goal.loop', 'terminal-lifecycle-publish-failed', {
        sessionId: ctx.sessionId, ...runAttribution,
        iterations,
        stopReason: result.stopReason,
        goalComplete: result.goalComplete,
        error: error instanceof Error ? error.message : String(error),
      }, { level: 'warn' });
    }
    return result;
  };

  try {
  while (iterations < maxIterations) {
    // ⭐ 외부 soft-stop 은 **다음 iteration 진입 직전**에 본다(리뷰 must-fix · 2026-07-30).
    //    ⛔ turn 직후에 두면 같은 iteration 의 결과 판정(goal_complete·blocked·error·
    //    context_pressure…)을 전부 건너뛰고 `goalComplete:false` 로 덮어 버린다 — 골이 완료된
    //    iteration 에서 stop 을 만나면 완료가 사라졌다. 계약은 *"현재 iteration 을 마친 뒤 종료"*
    //    이므로 판정은 아래 본문이 다 하고, stop 은 **재진입만** 막는다.
    //    ⊕ 첫 진입에서도 본다 — 사용자가 미리 걸어 둔 stop 이면 turn 을 쓰지 않고 끝내는 것이 맞다.
    if (controlSpaceId) {
      // sessionId가 없으면 메모 레코드는 다음 세션이 배달할 수 있게 그대로 둔다.
      // stop latch만 별도로 소비해 기존 soft-stop 계약은 유지한다.
      const stopControl = drainSoftStop(controlSpaceId);
      const peekedMemoEntries: NonNullable<ControlInboxDrain['peekedMemoEntries']> = stopControl.peekedMemoEntries
        ?? stopControl.peekedMemos?.map((body) => ({ body })) ?? [];
      const orderedPeekedMemoEntries = [
        ...peekedMemoEntries.filter((entry) => entry.structured?.urgency === 'urgent'),
        ...peekedMemoEntries.filter((entry) => entry.structured?.urgency !== 'urgent'),
      ];
      const peekedControlMemos = orderedPeekedMemoEntries.map((entry) => entry.body);
      const peekedReceivedCount = stopControl.peekedReceivedCount;
      const peekedUrgentCount = stopControl.peekedUrgentCount;
      const peekedMalformedFallbackCount = stopControl.peekedMalformedFallbackCount;
      if (stopControl.stop) {
        if (peekedControlMemos.length > 0) {
          debug.log('goal.loop', 'soft-stop-with-control-memo', {
            sessionId: ctx.sessionId, ...runAttribution, iterations, spaceId: controlSpaceId,
            drained: stopControl.count,
            memoCount: peekedControlMemos.length,
            memos: peekedControlMemos,
            ...(peekedReceivedCount === undefined ? {} : { receivedCount: peekedReceivedCount }),
            ...(peekedUrgentCount === undefined ? {} : { urgentCount: peekedUrgentCount }),
            ...(peekedMalformedFallbackCount === undefined ? {} : { malformedFallbackCount: peekedMalformedFallbackCount }),
          }, { level: 'warn' });
        }
        debug.log('goal.loop', 'soft-stop', {
          sessionId: ctx.sessionId, ...runAttribution, iterations, spaceId: controlSpaceId, drained: stopControl.count,
        }, { level: 'info' });
        return finish({ finalText: lastResult.finalText, iterations, stopReason: 'soft_stop', goalComplete: false });
      }
      const control = ctx.sessionId ? drainControl(controlSpaceId) : stopControl;
      const deliveredMemoEntries: NonNullable<ControlInboxDrain['memoEntries']> = control.memoEntries
        ?? control.memos?.map((body) => ({ body })) ?? [];
      const orderedDeliveredMemoEntries = [
        ...deliveredMemoEntries.filter((entry) => entry.structured?.urgency === 'urgent'),
        ...deliveredMemoEntries.filter((entry) => entry.structured?.urgency !== 'urgent'),
      ];
      const controlMemos = orderedDeliveredMemoEntries.map((entry) => entry.body);
      const receivedCount = control.receivedCount;
      const urgentCount = control.urgentCount;
      const malformedFallbackCount = control.malformedFallbackCount;
      if (control.stop) {
        for (const entry of orderedDeliveredMemoEntries) {
          restoreControlMemo(controlSpaceId, entry.structured ?? entry.body);
        }
        if (controlMemos.length > 0) {
          debug.log('goal.loop', 'soft-stop-with-control-memo', {
            sessionId: ctx.sessionId, ...runAttribution, iterations, spaceId: controlSpaceId,
            drained: control.count,
            memoCount: controlMemos.length,
            memos: controlMemos,
            ...(receivedCount === undefined ? {} : { receivedCount }),
            ...(urgentCount === undefined ? {} : { urgentCount }),
            ...(malformedFallbackCount === undefined ? {} : { malformedFallbackCount }),
            restored: true,
          }, { level: 'warn' });
        }
        debug.log('goal.loop', 'soft-stop', {
          sessionId: ctx.sessionId, ...runAttribution, iterations, spaceId: controlSpaceId, drained: control.count,
        }, { level: 'info' });
        return finish({ finalText: lastResult.finalText, iterations, stopReason: 'soft_stop', goalComplete: false });
      }
      // ⭐ 감독 메모는 이어가기 문구 뒤에만 덧붙여 계획을 대체하지 않는다.
      if (controlMemos.length > 0) {
        const memoBlock = `${SUPERVISOR_MEMO_HEADER}\n${controlMemos.map((memo) => `- ${memo}`).join('\n')}`;
        const tail = messages[messages.length - 1];
        if (tail !== undefined && tail.role === 'user' && typeof tail.content === 'string') {
          tail.content = `${tail.content}\n\n${memoBlock}`;
        } else {
          messages.push({ role: 'user', content: memoBlock });
        }
        debug.log('goal.loop', 'control-memo', {
          sessionId: ctx.sessionId, ...runAttribution, iterations, spaceId: controlSpaceId,
          memoCount: controlMemos.length,
          ...(receivedCount === undefined ? {} : { receivedCount }),
          ...(urgentCount === undefined ? {} : { urgentCount }),
          ...(malformedFallbackCount === undefined ? {} : { malformedFallbackCount }),
          appended: tail !== undefined && tail.role === 'user',
        }, { level: 'info' });
      }
    }
    iterations += 1;

    // 이 turn 이 누적한 메시지(assistant 텍스트 + tool_use/result)를 회수해 다음
    // 반복의 history 로 이어붙인다. caller 의 onTurnComplete/onUsage 도 계속 통지.
    let turnNewMessages: LLMMessage[] = [];
    let dispatchCount = 0;
    let iterInputTokens = 0;
    let iterOutputTokens = 0;
    let iterCacheReadTokens = 0;
    let iterUsageCalls = 0;
    let iterUsageMissing = 0;
    let postToolSoftStop = false;
    const turnAbortController = new AbortController();
    const abortForCaller = () => turnAbortController.abort(ctx.signal.reason);
    if (ctx.signal.aborted) abortForCaller();
    else ctx.signal.addEventListener('abort', abortForCaller, { once: true });
    const abortTurnForSoftStop = () => {
      postToolSoftStop = true;
      turnAbortController.abort();
    };
    const turnCtx: CoreTurnContext = {
      ...ctx,
      messages,
      tools,
      signal: turnAbortController.signal,
      // 진입 시 한 번 정한 사람 문장을 매 라운드에 그대로 내린다(위 주석 참조).
      ...(surfaceUserText !== undefined ? { userText: surfaceUserText } : {}),
      // update_goal 은 종결 신호 — 실 dispatcher 로 새지 않게 가로채 ack 만 돌려준다.
      dispatchTool: (name, args, dctx) => {
        dispatchCount += 1;
        try {
          debug.log('goal.loop', 'dispatch', {
            sessionId: ctx.sessionId, ...runAttribution,
            iteration: iterations,
            tool: name,
            dispatchCount,
          }, { level: 'debug' });
        } catch {
          // Observability must not prevent the selected tool from dispatching.
        }
        if (name === UPDATE_GOAL_TOOL_NAME) {
          return Promise.resolve({ ok: true, recorded: (args as { status?: unknown }).status ?? null });
        }
        return ctx.dispatchTool(name, args, dctx);
      },
      callbacks: {
        ...ctx.callbacks,
        // OH8 후속 PR-2 — run_tests 결과를 캡처(last-wins). 텍스트 파싱이 아니라 구조체 ok 를 본다.
        onToolResult: (call) => {
          if (call.name === 'run_tests' && call.result && typeof call.result === 'object') {
            const r = call.result as Partial<{ ok: boolean; fail: number; unmatchedFilters: string[]; pass: number }>;
            if (typeof r.ok === 'boolean') {
              runTests.last = {
                ok: r.ok,
                fail: typeof r.fail === 'number' ? r.fail : 0,
                unmatchedFilters: Array.isArray(r.unmatchedFilters) ? r.unmatchedFilters : [],
                pass: typeof r.pass === 'number' ? r.pass : 0,
              };
            }
          }
          ctx.callbacks?.onToolResult?.(call); // ⚠️ 기존 콜백 체이닝(끊지 말 것).
          if (controlSpaceId && ctx.sessionId) {
            // Consume only the stop latch first: a concurrent memo stays queued for the next turn.
            if (drainSoftStop(controlSpaceId).stop) {
              debug.log('goal.loop', 'soft-stop-after-tool-result', {
                sessionId: ctx.sessionId, ...runAttribution, iterations, spaceId: controlSpaceId,
              }, { level: 'info' });
              abortTurnForSoftStop();
            } else {
              const control = drainControl(controlSpaceId);
              const controlMemos = control.memos ?? [];
              if (controlMemos.length > 0) {
                for (const memo of controlMemos) enqueuePendingUserInput(ctx.sessionId, memo);
                debug.log('goal.loop', 'control-memo-after-tool-result', {
                  sessionId: ctx.sessionId, ...runAttribution, iterations, spaceId: controlSpaceId,
                  memoCount: controlMemos.length,
                }, { level: 'info' });
              }
            }
          } else if (controlSpaceId && drainSoftStop(controlSpaceId).stop) {
            debug.log('goal.loop', 'soft-stop-after-tool-result', {
              sessionId: ctx.sessionId, ...runAttribution, iterations, spaceId: controlSpaceId,
            }, { level: 'info' });
            abortTurnForSoftStop();
          }
        },
        onTurnComplete: (msgs) => {
          turnNewMessages = msgs;
          ctx.callbacks?.onTurnComplete?.(msgs);
        },
        onUsage: (usage: LLMUsage) => {
          iterUsageCalls += 1;
          const inputTokens = usage.inputTokens;
          const outputTokens = usage.outputTokens;
          const cacheReadInputTokens = usage.cacheReadInputTokens;
          if (typeof inputTokens === 'number') iterInputTokens += inputTokens;
          if (typeof outputTokens === 'number') iterOutputTokens += outputTokens;
          if (typeof cacheReadInputTokens === 'number') iterCacheReadTokens += cacheReadInputTokens;
          if (
            typeof inputTokens !== 'number'
            || typeof outputTokens !== 'number'
            || typeof cacheReadInputTokens !== 'number'
          ) iterUsageMissing += 1;
          // input 토큰 = 프롬프트 점유(컨텍스트 occupancy proxy). 턴당 여러 번 발화 —
          // 최대값을 유지해 context-pressure 판정에 쓴다.
          if (typeof inputTokens === 'number' && inputTokens > lastInputTokens) {
            lastInputTokens = inputTokens;
          }
          ctx.callbacks?.onUsage?.(usage);
        },
      },
    };

    const previousFinalText = lastResult.finalText;
    try {
      lastResult = await runTurn(turnCtx);
    } finally {
      ctx.signal.removeEventListener('abort', abortForCaller);
    }
    messages.push(...turnNewMessages);

    const goalUpdate = findGoalUpdate(turnNewMessages);
    const rejectedTools = findRejectedToolCalls(turnNewMessages);
    const toolActivity = hadToolActivity(turnNewMessages);
    const markerComplete = hasCompletionMarker(lastResult.finalText);
    const markerBlocked = hasBlockedMarker(lastResult.finalText);

    const finalTextExcerpt = boundReadableText(lastResult.finalText, GOAL_LOOP_FINAL_TEXT_EXCERPT_MAX_CHARS);
    debug.log('goal.loop', 'iteration', {
      sessionId: ctx.sessionId, ...runAttribution, iteration: iterations,
      stopReason: lastResult.stopReason, toolActivity, dispatchCount,
      goalUpdate: goalUpdate?.status ?? null, rejectedTools, markerComplete, markerBlocked,
      lastInputTokens, iterInputTokens, iterOutputTokens, iterCacheReadTokens, iterUsageCalls, iterUsageMissing,
      finalChars: lastResult.finalText.length,
      finalTextExcerpt: finalTextExcerpt.text, finalTextExcerptTruncated: finalTextExcerpt.truncated,
    }, { level: 'debug' });

    // ① authoritative 완료 — update_goal(complete) + 비지 않은 evidence.
    if (goalUpdate?.status === 'complete') {
      if (goalUpdate.evidence.trim().length > 0) {
        // ①-a evidence 대조(OH8 후속 PR-2) — 마지막 run_tests 가 ok=false 면 완료 주장 반증.
        //   coding scope 자동: run_tests 는 coding agent 만 노출되므로 매매/비코딩 루프엔
        //   lastRunTests=null → 검사 스킵 → 반려 미발동(매매 fail-closed 불변 자연 보존).
        const rt = runTests.last;
        if (rt && !rt.ok && evidenceMismatchRetried < 1) {
          evidenceMismatchRetried += 1;
          debug.log('goal.loop', 'complete-rejected-evidence-mismatch', {
            sessionId: ctx.sessionId, ...runAttribution, iterations,
            fail: rt.fail, unmatched: rt.unmatchedFilters, pass: rt.pass,
          }, { level: 'warn' });
          blockedStreak = 0;
          readbackStreak = 0;
          messages.push({
            role: 'user',
            content: buildEvidenceMismatchPrompt(rt.fail, rt.unmatchedFilters),
          });
          continue;
        }
        // ①-b 재시도 후에도 불일치 → fail-open: 통과시키되 관측에 기록(코딩툴 fail-open 계약·
        //   feedback_hitl_fail_open_coding_scope_2026_07_17). 절대 hard-block 금지.
        if (rt && !rt.ok) {
          debug.log('goal.loop', 'complete-evidence-mismatch-failopen', {
            sessionId: ctx.sessionId, ...runAttribution, iterations,
            fail: rt.fail, unmatched: rt.unmatchedFilters, pass: rt.pass,
          }, { level: 'warn' });
        }
        // ①-c same-turn rejected tool call — canonical guard stubs are structural proof that
        // a claimed action did not run. Keep its retry budget independent from test evidence.
        if (rejectedTools.length > 0 && rejectedToolCompletionRetried < 1) {
          rejectedToolCompletionRetried += 1;
          debug.log('goal.loop', 'complete-rejected-tool-call', {
            sessionId: ctx.sessionId, ...runAttribution, iterations, rejectedTools,
          }, { level: 'warn' });
          blockedStreak = 0;
          readbackStreak = 0;
          messages.push({
            role: 'user',
            content: buildRejectedToolCompletionPrompt(rejectedTools),
          });
          continue;
        }
        // ①-d retry exhausted → fail-open for coding tool guards, recorded for observability.
        if (rejectedTools.length > 0) {
          debug.log('goal.loop', 'complete-rejected-tool-call-failopen', {
            sessionId: ctx.sessionId, ...runAttribution, iterations, rejectedTools,
          }, { level: 'warn' });
        }
        let completionChangedFiles: string[] = [];
        let completionSummary = goalUpdate.evidence;
        try {
          completionChangedFiles = snapshotChangedFiles(process.cwd());
        } catch (error) {
          const snapshotFailure = error instanceof Error ? error.message : String(error);
          debug.log('goal.loop', 'complete-lifecycle-snapshot-failed', {
            sessionId: ctx.sessionId, ...runAttribution,
            iterations,
            error: snapshotFailure,
          }, { level: 'warn' });
          completionSummary = `${goalUpdate.evidence}\n\nChanged-files snapshot failed: ${snapshotFailure}`;
        }
        // `runTests` is declared inside this runGoalLoop invocation, so its captured result only
        // lives for this call. A child can normally run tests and declare completion on different
        // turns; no current-turn comparison result does not mean that the whole run executed no tests.
        const evidenceCheck = rt === null
          ? 'skipped-no-current-turn-run-tests'
          : rt.ok
            ? 'matched'
            : 'mismatch-failopen';
        debug.log('goal.loop', 'complete', {
          sessionId: ctx.sessionId, ...runAttribution, iterations, via: 'update_goal', evidenceCheck,
        }, { level: 'info' });
        const normalizeAnswer = (text: string) => text.trim().replace(/\s+/g, ' ');
        const previousAnswer = normalizeAnswer(previousFinalText);
        const completionAnswer = normalizeAnswer(lastResult.finalText);
        const previousAt = previousAnswer ? completionAnswer.indexOf(previousAnswer) : -1;
        const prefix = previousAt >= 0 ? completionAnswer.slice(0, previousAt).trim() : '';
        const suffix = previousAt >= 0 ? completionAnswer.slice(previousAt + previousAnswer.length).trim() : '';
        // Only a readback preface is non-factual; a new sentence before the old answer
        // (including one joined by a colon) must survive just like a new suffix.
        const readbackPreface = /^(?:확인 결과|(?:방금\s+)?다시\s+확인(?:했습니다|했지만|해보니|해 보니|해봤지만|해 봤지만|했으나|했는데))[\s:：,.!?。！？-]*$/u;
        const hasNewFact = (prefix.length > 0 && !readbackPreface.test(prefix)) || /\p{L}|\p{N}/u.test(suffix);
        const duplicateAnswer = previousAnswer.length > 0 && (
          completionAnswer.length === 0 || (previousAt >= 0 && !hasNewFact)
        );
        if (duplicateAnswer) {
          debug.log('goal.loop', 'complete-duplicate-answer-suppressed', {
            sessionId: ctx.sessionId, ...runAttribution, iterations, chars: lastResult.finalText.length,
          });
        }
        return finish(
          { finalText: duplicateAnswer ? previousFinalText : lastResult.finalText, iterations, stopReason: 'goal_complete', goalComplete: true },
          { summary: completionSummary, changedFiles: completionChangedFiles },
        );
      }
    }

    // A post-tool stop follows only an accepted authoritative completion. Incomplete updates,
    // deprecated markers, and read-back retries must not bypass the stop latch.
    if (postToolSoftStop) {
      return finish({ finalText: lastResult.finalText, iterations, stopReason: 'soft_stop', goalComplete: false });
    }

    // 취소/에러 → 즉시 종료. (OH10 계측 공백 신설 — 종전엔 debug.log 가 아예 없어
    // 취소·에러로 죽은 루프가 직전 iteration 뒤 침묵으로만 추론됐다.)
    if (lastResult.stopReason === 'aborted' || lastResult.stopReason === 'error' || lastResult.stopReason === 'auth_rejected') {
      debug.log('goal.loop', lastResult.stopReason, {
        sessionId: ctx.sessionId, ...runAttribution, iterations, stopReason: lastResult.stopReason,
        finalChars: lastResult.finalText.length,
      }, { level: 'error' });
      return finish({ finalText: lastResult.finalText, iterations, stopReason: lastResult.stopReason, goalComplete: false });
    }

    // Evidence-less completion is not authoritative; only retry after stop and terminal outcomes
    // from this same turn have received priority.
    if (goalUpdate?.status === 'complete') {
      debug.log('goal.loop', 'complete-rejected-no-evidence', { sessionId: ctx.sessionId, ...runAttribution, iterations }, { level: 'warn' });
      blockedStreak = 0;
      readbackStreak = 0;
      messages.push({ role: 'user', content: GOAL_EVIDENCE_REQUIRED_PROMPT });
      continue;
    }

    // ② blocked(구조화 or 마커) — 3연속(hysteresis)일 때만 수용(조기 give-up 방지).
    if (goalUpdate?.status === 'blocked' || markerBlocked) {
      blockedStreak += 1;
      const via = goalUpdate?.status === 'blocked' ? 'update_goal' : 'marker';
      debug.log('goal.loop', 'blocked-signal', { sessionId: ctx.sessionId, ...runAttribution, iteration: iterations, blockedStreak, via }, { level: 'debug' });
      if (blockedStreak >= 3) {
        debug.log('goal.loop', 'blocked-accepted', { sessionId: ctx.sessionId, ...runAttribution, iterations }, { level: 'warn' });
        return finish({ finalText: lastResult.finalText, iterations, stopReason: 'no_progress', goalComplete: false });
      }
      messages.push({ role: 'user', content: GOAL_CONTINUATION_PROMPT });
      continue;
    }
    blockedStreak = 0;

    // ③ deprecated 텍스트 마커로만 완료 주장 → read-back 게이트(ralph). 마커는 spoofable 이라
    //    단독으로 완료를 확정하지 않고 update_goal 로 재확정을 요구한다. 2회 무응답 → HITL 승격.
    if (markerComplete) {
      readbackStreak += 1;
      debug.log('goal.loop', 'marker-readback', { sessionId: ctx.sessionId, ...runAttribution, iteration: iterations, readbackStreak }, { level: 'debug' });
      if (readbackStreak >= 2) {
        debug.log('goal.loop', 'marker-readback-exhausted', { sessionId: ctx.sessionId, ...runAttribution, iterations }, { level: 'warn' });
        return finish({ finalText: lastResult.finalText, iterations, stopReason: 'no_progress', goalComplete: false });
      }
      messages.push({ role: 'user', content: GOAL_READBACK_PROMPT });
      continue;
    }
    readbackStreak = 0;

    // ④ 순수 텍스트(도구 없음)로 끝났고 종결 신호도 없음 = 일상 답변(목표성 작업 아님).
    //    재주입하지 않고 그대로 수용해 trivial chat 을 이중 루프하지 않는다.
    if (!toolActivity) {
      debug.log('goal.loop', 'text-only-accept', { sessionId: ctx.sessionId, ...runAttribution, iterations }, { level: 'info' });
      return finish({ finalText: lastResult.finalText, iterations, stopReason: lastResult.stopReason, goalComplete: false });
    }

    // ⑤ context-pressure bail — 오버플로 임박 윈도우엔 continuation 을 재주입하지 않고
    //    종료해 caller 가 compact 후 재개(무작정 재주입 시 프롬프트 truncation·품질 붕괴).
    if (contextTokenLimit > 0 && lastInputTokens >= contextTokenLimit * contextPressureRatio) {
      debug.log('goal.loop', 'context-pressure-bail', {
        sessionId: ctx.sessionId, ...runAttribution, iterations, lastInputTokens, contextTokenLimit, contextPressureRatio,
      }, { level: 'warn' });
      return finish({ finalText: lastResult.finalText, iterations, stopReason: 'context_pressure', goalComplete: false });
    }

    // ⑥ spin 감지(ref lazycodex rail#5) — 직전 턴과 동일 tool 시그니처가 반복되면 무진전.
    const sig = toolCallSignature(turnNewMessages);
    if (sig !== '' && sig === lastSig) {
      noProgress += 1;
      debug.log('goal.loop', 'no-progress-tick', { sessionId: ctx.sessionId, ...runAttribution, iteration: iterations, noProgress }, { level: 'debug' });
      if (noProgress >= noProgressLimit) {
        debug.log('goal.loop', 'no-progress-stop', { sessionId: ctx.sessionId, ...runAttribution, iterations }, { level: 'warn' });
        return finish({ finalText: lastResult.finalText, iterations, stopReason: 'no_progress', goalComplete: false });
      }
    } else {
      noProgress = 0;
    }
    lastSig = sig;

    // ⑦ 도구를 썼지만 완료 신호가 없음 = 진행 중 → continuation 재주입 후 다음 반복.
    messages.push({ role: 'user', content: GOAL_CONTINUATION_PROMPT });
  }

  debug.log('goal.loop', 'max-iterations', { sessionId: ctx.sessionId, ...runAttribution, iterations }, { level: 'warn' });
  return finish({ finalText: lastResult.finalText, iterations, stopReason: 'max_iterations', goalComplete: false });
  } finally {
    stopLivenessHeartbeat();
  }
}
