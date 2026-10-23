// UI-Core arc Phase U3b Step 2 — ACP server ↔ runCoreTurn bridge.
//
// Turns an AcpTurnContext (the minimal per-prompt shape the ACP
// server handler sees) into a runCoreTurn invocation. Production
// boot injects the returned handler via `AcpServerOptions.runTurn`;
// the echo stub in `runAcpServer` stays in place as the no-DI
// fallback so the current smoke path keeps working while the richer
// wiring lands piecewise.
//
// What the bridge owns:
//   - Abort bridging. ACP exposes cancellation via a polled flag
//     (`AcpTurnContext.isAborted()`), but `streamLLMWithTools`
//     expects an `AbortSignal`. This module polls the flag on a
//     short interval and flips an AbortController so cancellation
//     feels responsive without needing a protocol-level push.
//   - Callback routing. `onText` deltas flow to `push()` so the
//     parent ACP client sees streaming text. Tool events and
//     turn-complete messages are forwarded to caller-supplied hooks
//     for history persistence.
//
// What the bridge deliberately does NOT own:
//   - Message assembly. Callers inject `getMessages` so the
//     messenger bot, the dashboard, or the web port can each
//     assemble history the way they already do. A default helper
//     (`defaultAcpMessagesSeed`) ships for ports that have no
//     persistence layer yet.
//   - Tool catalog / dispatch. The bridge is LLM-provider-agnostic
//     but NOT tool-set-agnostic — different hosts expose different
//     tool surfaces. Callers inject both sides.
//
// Where this file lives: `src/acp/` keeps the bridge on the ACP-
// side of the fabric, where tests can pull it alongside
// `server.ts` without crossing into dashboard territory. The
// headless-core guard test asserts the bridge stays TUI-free so
// Core really can run headless.

import { nextTurnFallbackProvider, resolveDefaultProvider, type LLMMessage, type LLMProvider, type LLMToolSpec, type ContentBlock } from '../llm.js';
import { readAutohealProviderFallback } from '../self-health/autoheal.js';
import { debug, redactSecretText } from '../debug/log.js';
import { CoreTurnAuthRejectedError } from '../core-turn/auth-rejected-notice.js';
import {
  runCoreTurn,
  runGoalLoop,
  type CoreTurnContext,
  type CoreTurnDispatchTool,
} from '../core-turn/index.js';
import { stripGoalRepeatReadbackPreface } from '../core-turn/run-goal-loop.js';
import { parseSeatTurnCapConfig, resolveSeatTurnCap } from '../core-turn/seat-turn-cap.js';
import { getUserConfig } from '../user-config.js';
import { getModelFamily } from '../models/prompts.js';
import { resolveModelContextWindow } from '../models/context-window.js';
import type { AcpServerOptions, AcpTurnContext } from './server.js';
import { acpToolDenialResult } from './tool-approval.js';
import { readOriginSessionMeta } from './origin-session-meta.js';
import { isFactQuestion } from './fact-question.js';
import { classifyTuiChatIntent, formatTuiRouteLine, isSeatOpsDirective, type TuiChatRoute } from '../core-turn/short-question.js';
import { HARNESS_ROLE_ENV } from '../harness/harness-space.js';
import { createReasoningThoughtBuffer } from './reasoning-thought-buffer.js';

const FACT_QUESTION_INSTRUCTION = '사실·최신 정보 질문이다. WebSearch 를 1~2회 쓰고 검색 결과(제목·스니펫·URL)로 답하라. 출처 링크를 붙여라. 셸·브라우저·파일 도구는 검색 결과로 부족할 때만. 도구 예산에 닿으면 지금까지 근거로 답하고 끝에 «더 찾아볼까요?»를 붙여라.';

// 읽기·분석 keeps every tool (it reads files and state) and only leaves the goal loop.
type QuickTuiRoute = Exclude<TuiChatRoute, '코딩·구현' | '읽기·분석'>;

// An allowlist, not a denylist: a new repository writer cannot slip into a quick turn.
// memory_recall is read-only and on every quick route: the self-access discipline (agent/self-ambient.ts) tells
// every turn to recall before judging, so a route without it asked for a tool it could not call (TUI-SEAT-MEMORY-SCOPE).
const QUICK_TOOLS: Record<QuickTuiRoute, readonly string[]> = {
  '조회': ['decisions_pending', 'ops_seats', 'ops_status', 'release_status', 'logs_query', 'context_now', 'memory_recall', 'Read'],
  '설정 변경': ['DashboardConfigGet', 'DashboardConfigSet', 'LlmListAvailableModels', 'prompt_getRuntimeConfig', 'prompt_setRuntimeConfig', 'view_getConfig', 'view_applyRuntimeConfig', 'view_saveConfig', 'memory_recall'],
  // MsgList is a read-only ledger listing (never acks); MsgPost · MsgAck · RunShell · Bash stay out (TUI-QUICK-ROUTE-EXPLICIT-CMD).
  '조사': ['WebSearch', 'OmniSearch', 'Grep', 'Glob', 'Read', 'fact_check', 'memory_recall', 'MsgList', 'Agent'],
  // ScheduleWakeup (H5) wakes this TUI in-process; schedule_manage is OS cron — both belong to «상시 일».
  '상시 일': ['schedule_manage', 'schedule_list', 'schedule_create', 'schedule_update', 'ScheduleWakeup', 'session_manage', 'ops_status', 'memory_recall'],
};

export function toolsForTuiRoute(tools: readonly LLMToolSpec[], route: QuickTuiRoute): LLMToolSpec[] {
  const preferred = QUICK_TOOLS[route];
  return preferred.flatMap((name) => tools.filter((tool) => tool.name === name));
}

export interface CoreTurnBridgeDeps {
  /** Build the seed message list for this ACP prompt. Implementations
   *  typically concatenate per-session history with
   *  `{ role: 'user', content: userText }` and prepend a system
   *  message. */
  getMessages: (ctx: {
    sessionId: string;
    userText: string;
    /** Step 2 of platform-evolution arc — full inbound ACP
     *  ContentBlock[] preserved verbatim from the PromptRequest.
     *  daemon-runtime's getMessages uses this to keep image / file
     *  blocks intact when persisting the user message; legacy
     *  text-only handlers can ignore (use `userText`). Optional
     *  for backward compat with tests / non-ACP callers (e.g.
     *  defaultAcpMessagesSeed). When omitted, the handler should
     *  derive content from `userText` only. */
    promptBlocks?: import('@agentclientprotocol/sdk').ContentBlock[];
    /** Optional ACP `_meta` blob from the inbound PromptRequest.
     *  Source-aware runtimes can use this to preserve channel/input
     *  provenance without coupling the bridge to a single surface. */
    promptMeta?: Readonly<Record<string, unknown>>;
  }) => LLMMessage[] | Promise<LLMMessage[]>;
  /** Tool catalog for this turn. Return `[]` for text-only and the
   *  loop will take `streamLLMWithTools`'s no-tool fallback path.
   *
   *  Phase 5a — ctx carries `userText` alongside `sessionId` so the
   *  dashboard's `buildSessionRuntimeToolSpecs` (which selects tool
   *  families from user-text intent) can run via this getter without
   *  having to stash the prompt on the side. `getMessages` already
   *  receives `userText`; passing it here keeps the two contracts
   *  symmetric. */
  getTools: (ctx: {
    sessionId: string;
    userText: string;
  }) => LLMToolSpec[] | Promise<LLMToolSpec[]>;
  /** Tool dispatcher. Never invoked when `getTools` returns `[]`. */
  dispatchTool: CoreTurnDispatchTool;
  /** Optional: persist the turn's accumulated assistant + tool blocks
   *  back into the host's history store. Mirrors
   *  `CoreTurnCallbacks.onTurnComplete`. */
  onTurnComplete?: (ctx: {
    sessionId: string;
    newMessages: LLMMessage[];
  }) => void | Promise<void>;
  /** Optional: per-turn model override. Omit to defer to the
   *  provider's default resolution (same as `streamLLMWithTools`). */
  resolveModel?: (ctx: { sessionId: string; userText: string }) => string | undefined;
  /** Optional: per-turn max tool-loop turns. */
  resolveMaxToolTurns?: (ctx: { sessionId: string }) => number | undefined;
  /** Optional: conditional tool-loop budget extension, forwarded to
   *  `runCoreTurn` (PLAN-multi-surface-pty-shell M3). Daemon hosts set
   *  this when their tool surface exposes the PtyShell family so
   *  driving a headless terminal earns extra rounds. */
  budgetGrant?: import('../llm.js').LLMOpts['budgetGrant'];
  /** Optional: override the abort-poll interval. Tests flatten this
   *  to 1ms so they don't spend real wall clock waiting for the
   *  flag to propagate. */
  abortPollMs?: number;
  /** Only the in-process dashboard session opts into TUI routing; daemon ACP stays unchanged. */
  tuiRouting?: boolean;
  /** TUI-H1-SEAT-GOALLOOP — the seat this TUI works for (`detectSeatTui`), read per turn. null/absent = a human
   *  conversation TUI (routing unchanged). A seat TUI sends operational directives to the goal loop. */
  resolveSeat?: () => string | null;
}

/** Default abort-poll cadence. 50ms = 20 Hz: responsive without
 *  pegging the event loop. */
export const DEFAULT_BRIDGE_ABORT_POLL_MS = 50;

/** PCH-2b — ask the ACP client before a write/shell tool runs. A denied,
 *  cancelled or timed-out tool is not run; the LLM gets a «not run» result. */
export function acpApprovalGatedDispatch(
  turnCtx: AcpTurnContext,
  dispatchTool: CoreTurnDispatchTool,
  signal: AbortSignal,
): CoreTurnDispatchTool {
  const approveTool = turnCtx.approveTool;
  if (!approveTool) return dispatchTool;
  return async (name, args, dispatchCtx) => {
    if (signal.aborted || turnCtx.isAborted()) return acpToolDenialResult(name, 'cancelled');
    const approval = await approveTool({
      toolCallId: dispatchCtx?.callId ?? `${name}-${Date.now().toString(36)}`,
      toolName: name,
      toolArgs: args,
    });
    if (!approval.allowed) return acpToolDenialResult(name, approval.reason);
    if (signal.aborted || turnCtx.isAborted()) return acpToolDenialResult(name, 'cancelled');
    return dispatchTool(name, args, dispatchCtx);
  };
}

/** 사용자 답에서 뺀 검증 보충을 로그에 남길 때 한 조각의 글자 수 — 로그 저장의 문자열 상한
 *  (`compactForLog` stringMax 256)보다 작아야 조각이 저장 중에 안 잘린다(리뷰 r4). */
const FINAL_SUPPLEMENT_LOG_CHUNK = 240;

/** Extract the trailing assistant message text from runCoreTurn's
 *  `newMessages` array. emitTurnComplete (src/llm.ts:3835) appends
 *  `{role:'assistant', content:[{type:'text', text:finalAssistantText}]}`
 *  for the final synthesis (W5-E/F/G + normal completion).
 *
 *  Returns the joined text content of the LAST assistant message, or
 *  null if none exists / has no text content. */
export function extractLastAssistantText(messages: readonly LLMMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== 'assistant') continue;
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
      const parts: string[] = [];
      for (const block of msg.content) {
        if (block && typeof block === 'object' && (block as ContentBlock).type === 'text') {
          const text = (block as Extract<ContentBlock, { type: 'text' }>).text;
          if (typeof text === 'string') parts.push(text);
        }
      }
      if (parts.length > 0) return parts.join('');
    }
    return null;
  }
  return null;
}

/** Compose a `runTurn` handler compatible with
 *  `AcpServerOptions.runTurn`. The returned function runs a single
 *  core turn per ACP prompt and resolves once the turn finishes —
 *  mirrors how the server's echo stub resolves after the round-trip. */
export function bridgeCoreTurnToAcp(
  deps: CoreTurnBridgeDeps,
): NonNullable<AcpServerOptions['runTurn']> {
  const pollMs = deps.abortPollMs ?? DEFAULT_BRIDGE_ABORT_POLL_MS;
  // TUI-400-AUTOHEAL-FALLBACK ② — 앞 턴이 «실제로» 마지막에 부른 공급자(턴 안 폴백이 넘겼으면 넘어간 쪽).
  //   ② 의 제외 목록에 기본 공급자와 함께 넣는다 — 방금 400 을 낸 쪽을 다시 고르지 않게(r2 리뷰).
  let lastResolvedProvider: string | null = null;
  return async (turnCtx: AcpTurnContext): Promise<void> => {
    const ctrl = new AbortController();
    const poll = setInterval(() => {
      if (turnCtx.isAborted() && !ctrl.signal.aborted) ctrl.abort();
    }, pollMs);
    // Ensure the poll timer never keeps a headless host alive past
    // turn completion. Node's unref() is a no-op on Bun's timers
    // but the runtime accepts it.
    (poll as unknown as { unref?: () => void }).unref?.();

    try {
      const messages = await Promise.resolve(
        deps.getMessages({
          sessionId: turnCtx.sessionId,
          userText: turnCtx.userText,
          promptBlocks: turnCtx.promptBlocks,
          promptMeta: turnCtx.promptMeta,
        }),
      );
      const availableTools = await Promise.resolve(
        deps.getTools({
          sessionId: turnCtx.sessionId,
          userText: turnCtx.userText,
        }),
      );
      // Only a goal-driven harness child (explicit executor role — dev-harness · self-implement surfaces) keeps every
      // turn on the goal loop. A human TUI inside a harness space (one-word `dev --elanous`, `--hold`) is routed (UX 10-07).
      const harness = process.env[HARNESS_ROLE_ENV]?.trim() === 'executor';
      // seatKnown=false: no resolver (or it threw) — routed as a human TUI, but the log keeps «unknown», not «not a seat».
      let seat: string | null = null;
      let seatKnown = false;
      if (deps.tuiRouting && !harness && deps.resolveSeat) {
        try { seat = deps.resolveSeat(); seatKnown = true; }
        catch (error) { debug.log('chat.route', 'seat-unresolved', { error: String(error) }, { level: 'warn' }); }
      }
      const route = deps.tuiRouting && !harness
        ? classifyTuiChatIntent(turnCtx.userText, {
            hasAttachments: turnCtx.promptBlocks?.some((block) => block.type !== 'text') ?? false,
            seat: seat !== null,
          })
        : { route: '코딩·구현' as const, reason: harness ? 'harness' : 'legacy', goalLoop: true };
      const tools = !route.goalLoop && route.route !== '코딩·구현' && route.route !== '읽기·분석'
        ? toolsForTuiRoute(availableTools, route.route) // bridgeCoreTurnToAcp applies route allowlists here.
        : availableTools;
      if (deps.tuiRouting) {
        debug.log('chat.route', 'decided', { route: route.route, reason: route.reason, goalLoop: route.goalLoop, seat, seatKnown });
        // Only a quick route is announced: a coding turn's transcript stays exactly as before (preservation).
        // Awaited so the route line precedes the answer; a failed write is observed, not fatal to the turn.
        if (!route.goalLoop) {
          try { await turnCtx.push(formatTuiRouteLine(route.route)); }
          catch (error) { debug.log('chat.route', 'push-failed', { route: route.route, error: String(error) }); }
        }
      }
      const modelOverride = deps.resolveModel?.({ sessionId: turnCtx.sessionId, userText: turnCtx.userText });
      // TUI-400-AUTOHEAL-FALLBACK ② — TUI 가 «이 턴은 다음 공급자로» 를 실어 보냈다(같은 턴이 400 을 두 번 받은 뒤).
      //   ⛔ 고르는 것은 서버다 — 클라이언트는 표지만 싣고, 공급자는 이 프로세스의 `llm.fallbackChain` 해석으로 정한다.
      //   ⛔ in-process TUI(tuiRouting) 만 — 데몬 ACP 는 종전 그대로.
      let autohealProvider: { initialProvider: LLMProvider; skipProviders: readonly string[] } | null = null;
      const autohealStep2 = deps.tuiRouting === true && readAutohealProviderFallback(turnCtx.promptMeta);
      // ② 표지가 없는 프롬프트(새 턴 · ① 재시도)는 «그 턴» 의 시도다 — 앞 턴이 폴백으로 넘긴 공급자를 들고 오지 않는다(r3 리뷰).
      if (!autohealStep2) lastResolvedProvider = null;
      if (autohealStep2) {
        try {
          const failed = [...new Set([resolveDefaultProvider(modelOverride).name, ...(lastResolvedProvider ? [lastResolvedProvider] : [])])];
          const next = nextTurnFallbackProvider(failed);
          debug.log('self-health.autoheal', next ? 'provider-fallback-applied' : 'provider-fallback-none', {
            sessionId: turnCtx.sessionId, from: failed[0], skipped: failed, to: next?.name ?? null,
          }, { level: 'warn' });
          if (next) autohealProvider = { initialProvider: next, skipProviders: failed };
        } catch (error) {
          debug.log('self-health.autoheal', 'provider-fallback-none', { sessionId: turnCtx.sessionId, error: String(error) }, { level: 'warn' });
        }
      }
      // Tier 2 arming(config-gated·2026-07-19 goal-exec → 아크4 전-family) — llm.goalLoop.enabled
      // 면 across-turn goal loop(runGoalLoop)로 감싸 목표 완료(update_goal 증거게이트)까지 지속·
      // continuation 재주입. **family 무관**(runGoalLoop 프롬프트·update_goal 툴 전부 provider-generic·
      // 백스톱=max-iter·spin·blocked-3strike·context-pressure). 그 외엔 단일 turn(runCoreTurn).
      // 하드코딩 기본 ON 아님 — config 로 아밍(안전).
      const goalLoopCfg = getUserConfig().llm.goalLoop;
      const armGoalLoop = goalLoopCfg?.enabled === true && route.goalLoop;
      // 인지(TUI-H1-SEAT-GOALLOOP) — 자리 TUI 의 운영 지시가 그래도 단일 턴이면(예: llm.goalLoop 꺼짐) 경고로 남긴다.
      // 빠른 짧은 물음(short-*)은 자리에서도 «의도적» 단일 턴이라 경고에서 뺀다(«다음 행이 뭐야?»).
      if (deps.tuiRouting && seat !== null && !armGoalLoop && !route.reason.startsWith('short-')
        && isSeatOpsDirective(turnCtx.userText)) {
        try {
          debug.log('chat.route', 'seat-ops-single-turn', {
            seat, route: route.route, reason: route.reason, goalLoop: route.goalLoop,
            goalLoopEnabled: goalLoopCfg?.enabled === true,
          }, { level: 'warn' });
        } catch { /* observation cannot interrupt a turn */ }
      }
      // 사실 질문 예산은 «단일 턴» 전용이다 — goal loop 와 겹치면 예산을 다 쓴 뒤에도 루프가 계속 재촉해
      // 매 continuation 이 «Tool budget reached» 로 거부되고, 모델은 그것을 도구 장애로 읽어 blocked 를 남긴다
      // (10-14 13:48 운영 TUI OP: route short-question·goalLoop ⊕ factQuestion → 소진 뒤 헛호출 7회).
      const factShaped = isFactQuestion(turnCtx.userText);
      const factQuestion = factShaped && !armGoalLoop;
      if (factShaped && armGoalLoop) {
        try { debug.log('chat.turn', 'fact-budget-skipped', { reason: 'goal-loop-armed', route: route.route }); }
        catch { /* observation cannot interrupt a turn */ }
      }
      const explicitMaxToolTurns = deps.resolveMaxToolTurns?.({ sessionId: turnCtx.sessionId });
      const maxToolTurns = explicitMaxToolTurns ?? (factQuestion ? getUserConfig().chat.factQuestion.maxToolTurns : undefined);
      const turnMessages: LLMMessage[] = factQuestion
        ? [{ role: 'system', content: FACT_QUESTION_INSTRUCTION }, ...messages]
        : messages;
      let toolCallCount = 0;
      const toolKinds = new Set<string>();
      const observeToolBudget = () => {
        try {
          debug.log('chat.turn', 'tool-budget', {
            factQuestion, maxToolTurns: maxToolTurns ?? null,
            count: toolCallCount, kinds: [...toolKinds],
          });
        } catch { /* observation cannot interrupt a turn */ }
      };
      observeToolBudget();

      // 2026-05-03 PM++ — Track streamed text so onTurnComplete can
      // detect runtime-injected synthesis (W5-E/W5-F/W5-G) and surface
      // it as ACP messages. Pre-fix: synthesis was generated by
      // tryForceSynthesisPass at the llm.ts terminal, emitted as
      // `handlers.onText('', synthesizedText)`, propagated here as
      // `delta=''` (synthesizedText lost to ACP). The dashboard never
      // saw the substantive answer — only the streamed narration.
      let streamedTextSum = '';
      // 런타임이 최종 답 꼬리에 붙인 검증 보충(변경 파일·검증 최신성·루프 마감 상태 — goal loop 내부 판정).
      // 사용자 답에서는 빼고 로그로 보낸다(TUI 결함 #25). 코어 턴이 끝날 때마다(goal loop 반복 경계) 비운다.
      let finalSupplement: { answer: string; supplement: string; finalText: string } | null = null;
      // turnFamily 는 관측용으로만 유지(goal loop 아밍 판정은 위 사실 질문 판정 앞에서 한다).
      const turnModel = modelOverride ?? getUserConfig().llm.model;
      let resolvedRoute: { provider: string; model: string } | null = null;
      const turnFamily = getModelFamily(turnModel);
      if (armGoalLoop) {
        // 관측 — 어느 family/모델에서 across-turn goal-loop 가 아밍됐나(전-family 개방 검증).
        debug.log('goal.loop', 'arm', { family: turnFamily, model: turnModel });
      }
      // context-pressure bail(Tier2 정제) — 모델 윈도우를 주입해 오버플로 임박 시 continuation
      // 무작정 재주입 대신 context_pressure 로 종료(caller 가 compact 후 재개). 윈도우 미상이면 0(비활성).
      const resolvedCtxWindow = resolveModelContextWindow(turnModel);
      const goalCtxWindow = resolvedCtxWindow ?? 0;
      if (resolvedCtxWindow === null) {
        debug.log('acp.turn', 'context-pressure-bail-disabled', {
          model: turnModel,
          safeguard: 'context-pressure-bail',
        });
      }
      // TUI-SEAT-TURN-CAP — 자리 판정으로 goal loop 에 온 턴만 core 턴 상한·«할 일 0» 판정을 받는다(사람 TUI·하니스 자식 0).
      const seatTurnCap = armGoalLoop && seat !== null && route.reason.startsWith('seat-')
        ? { seat, ...resolveSeatTurnCap(parseSeatTurnCapConfig(getUserConfig().chat?.seatTurnCap)) }
        : undefined;
      const runTurnDispatch = (c: CoreTurnContext): Promise<unknown> =>
        armGoalLoop
          ? runGoalLoop(c, {
              ...(goalLoopCfg?.maxIterations !== undefined ? { maxIterations: goalLoopCfg.maxIterations } : {}),
              // #29 처방 — 자리 판정으로 goal loop 에 «되돌아온» 턴만 빈 evidence 완료를 답으로 받는다.
              ...(route.reason.startsWith('seat-') ? { lenientCompletionEvidence: true } : {}),
              ...(seatTurnCap !== undefined ? { seatTurnCap } : {}),
              ...(goalCtxWindow > 0 ? { contextTokenLimit: goalCtxWindow } : {}),
            })
          : runCoreTurn(c);
      // ⭐⭐⭐ 클라이언트가 실어 보낸 **연 쪽 세션**을 코어 턴에 넘긴다 — ACP 경계를 넘는 유일한 길.
      //   ⛔ 없으면 `runCoreTurn` 이 자기 세션으로 스코프를 열고 그 턴의 툴 로그가
      //      채팅 세션 조회에서 사라진다(원장 `MEAS-S14`). 값은 **간선에만** 쓰인다.
      const originSessionId = readOriginSessionMeta(turnCtx.promptMeta);
      let dispatchToolName = '';
      try {
        dispatchToolName = deps.dispatchTool?.name ?? '';
      } catch {
        // A dispatcher can reject name inspection; retain the empty-name observation.
      }
      try {
        debug.log('acp.turn', 'dispatch-ready', {
          hasUserText: turnCtx.userText.length > 0,
          userTextLength: turnCtx.userText.length,
          hasDispatchTool: deps.dispatchTool !== undefined,
          forwardsDispatchTool: deps.dispatchTool !== undefined,
          dispatchToolName,
          toolCount: tools.length,
        });
      } catch {
        // Observability must not prevent the turn from reaching its dispatcher.
      }
      const approvedDispatch = acpApprovalGatedDispatch(turnCtx, deps.dispatchTool, ctrl.signal);
      const dispatchTool: CoreTurnDispatchTool = factQuestion && maxToolTurns !== undefined && maxToolTurns > 0
        ? async (name, args, dispatchCtx) => {
            if (toolCallCount >= maxToolTurns) {
              return { error: 'Tool budget reached. Answer using the evidence already collected.' };
            }
            toolCallCount += 1;
            toolKinds.add(name);
            observeToolBudget();
            return approvedDispatch(name, args, dispatchCtx);
          }
        : approvedDispatch;
      // TUI-TURN-NARRATION 조각 2 — 추론 요약을 «문단» 단위로 모아 ACP `agent_thought_chunk`
      //   (`_meta.reasoning: true`)로 보낸다. 대시보드가 흐린 💭 한 줄로 그린다(`acp-chat.ts`).
      //   ⛔ 전에는 debug.log 로만 남아 화면엔 «무엇을 하는지»가 0줄이었다(결함 #87).
      const reasoningThoughts = createReasoningThoughtBuffer((text) => {
        debug.log('llm.reasoning', 'thought-emitted', { sessionId: turnCtx.sessionId, chars: text.length });
        void turnCtx.pushSessionUpdate(
          { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } },
          { reasoning: true },
        );
      });
      const buildCoreTurnContext = (): CoreTurnContext => ({
        sessionId: turnCtx.sessionId,
        ...(originSessionId ? { originSessionId } : {}),
        ...(turnCtx.userText ? { userText: turnCtx.userText } : {}),
        messages: turnMessages,
        tools,
        dispatchTool,
        signal: ctrl.signal,
        ...(modelOverride !== undefined ? { modelOverride } : {}),
        ...(autohealProvider ?? {}),
        ...(maxToolTurns !== undefined ? { maxToolTurns } : {}),
        ...((!factQuestion || explicitMaxToolTurns !== undefined) && deps.budgetGrant !== undefined ? { budgetGrant: deps.budgetGrant } : {}),
        callbacks: {
          onText: (delta, full) => {
            // ⛔ 검증 보충이 붙은 최종 답의 재방출(`onText('', 답+보충)`)은 흘리지 않는다 — 빈 청크를 TUI 는
            //   «확정(commit)»으로 읽어 이미 그린 답을 굳히고, 아래 onTurnComplete 재표면화가 같은 답을
            //   «한 번 더» 그렸다(TUI 결함 #25 · 10-14 18:36 OPT). 답 표시는 onTurnComplete 가 정한다.
            if (delta === '' && finalSupplement !== null && full === finalSupplement.finalText) return;
            // Fire-and-forget: ACP `push` is async but the core-turn
            // contract is synchronous onText. Chunks are delivered in
            // order because `sessionUpdate` is serialized per-
            // connection on the ACP SDK side.
            if (delta.length > 0) reasoningThoughts.flush();
            streamedTextSum += delta;
            void turnCtx.push(delta);
          },
          // P2-bridge-ext — forward tool + usage events as ACP
          // sessionUpdate notifications so extension-aware clients
          // (dashboard as ACP client / future web / iphone) can
          // render the same turn UX the direct streamLLMWithTools
          // callers see today. Fire-and-forget for the same reason
          // onText is: callbacks are synchronous, `turnCtx.push*` is
          // async, ordering is preserved by the SDK.
          onFinalAnswerSupplement: (info) => { finalSupplement = info; },
          onToolCall: (call) => {
            if (!factQuestion || maxToolTurns === undefined || maxToolTurns <= 0) {
              toolCallCount += 1;
              toolKinds.add(call.name);
              observeToolBudget();
            }
            reasoningThoughts.flush();
            void turnCtx.pushToolCall(call);
          },
          onToolResult: (call) => { void turnCtx.pushToolResult(call); },
          // 실제로 응답한 공급자·모델을 기억한다 — 폴백 체인이 넘기면(예 codex → grok) 턴 모델(turnModel)과 달라진다.
          //   streamLLMWithTools 가 스트림을 (다시) 열 때마다 부른다 → 사용량 직전 값 = 그 사용량을 낸 쪽.
          onResolvedProvider: (provider, model) => { resolvedRoute = { provider, model }; lastResolvedProvider = provider; },
          // 턴 모델(라우팅 결과)을 실어 보낸다 — 대시보드 턴 지표가 설정 모델로 ctx·단가를 잡지 않게.
          //   ⭐ 폴백이면 «넘어간» 모델·공급자를 싣는다(TUI-MODEL-BADGE-ACTUAL · 완료 배지가 읽는다 · 상태줄·/model 은 후속 TUI-MODEL-BADGE-SOURCE).
          onUsage: (usage) => {
            void turnCtx.pushUsage({
              ...usage,
              model: usage.model ?? resolvedRoute?.model ?? turnModel,
              ...(resolvedRoute ? { routeProvider: resolvedRoute.provider } : {}),
            });
          },
          // Codex Responses API reasoning summary stream. Surfaced to the
          // dashboard as `agent_thought_chunk` via `reasoningThoughts`
          // (TUI-TURN-NARRATION 조각 2) ⊕ the forensic debug.log below.
          // The forensic line carries the streamed delta and the
          // running summary index so a single grep gives the
          // reasoning trace in order. summary_part_added marks the
          // paragraph boundary; summary_delta is the text within.
          onReasoning: (event) => {
            reasoningThoughts.onEvent(event);
            if (debug.enabled) {
              if (event.kind === 'summary_delta') {
                debug.log('llm.reasoning', 'codex.summary.delta', {
                  summaryIndex: event.summaryIndex ?? null,
                  deltaLen: event.delta.length,
                  preview: event.delta.slice(0, 120),
                });
              } else {
                debug.log('llm.reasoning', 'codex.summary.part_added', {
                  summaryIndex: event.summaryIndex ?? null,
                });
              }
            }
          },
          onTurnComplete: async (newMessages) => {
            reasoningThoughts.flush();
            // Surface runtime-injected synthesis to ACP. emitTurnComplete
            // pushes the final assistant text (which may be the W5-E/F/G
            // force-synthesis output) into history. Compare to what was
            // streamed; if final wasn't streamed at the tail (W5-E/F/G
            // returned a string but didn't emit progressive deltas — the
            // pre-streaming legacy path), emit clear + replace so the
            // dashboard surfaces it. When final IS the tail of streamed
            // deltas (PR #1423 progressive streaming path), skip re-emit
            // — the display already has the substantive answer and a
            // re-emit would cause the "displayed then deleted then
            // re-displayed" flicker the user reported.
            const finalAssistantText = extractLastAssistantText(newMessages);
            const budgetReached = factQuestion && maxToolTurns !== undefined
              && maxToolTurns > 0 && toolCallCount >= maxToolTurns;
            const followup = '더 찾아볼까요?';
            const needsFollowup = budgetReached && finalAssistantText !== null
              && finalAssistantText.trim().length > 0
              && !finalAssistantText.trimEnd().endsWith(followup);
            let lastAssistantIndex = -1;
            for (let i = newMessages.length - 1; i >= 0; i--) {
              if (newMessages[i]?.role === 'assistant') { lastAssistantIndex = i; break; }
            }
            const followupSuffix = `\n${followup}`;
            const completedMessages: LLMMessage[] = needsFollowup
              ? newMessages.map((message, index) => {
                if (index !== lastAssistantIndex) return message;
                if (typeof message.content === 'string') {
                  return { ...message, content: message.content + followupSuffix };
                }
                if (Array.isArray(message.content)) {
                  let lastTextIndex = -1;
                  for (let blockIndex = message.content.length - 1; blockIndex >= 0; blockIndex--) {
                    if (message.content[blockIndex]?.type === 'text') { lastTextIndex = blockIndex; break; }
                  }
                  if (lastTextIndex >= 0) {
                    return { ...message, content: message.content.map((block, blockIndex) =>
                      blockIndex === lastTextIndex && block.type === 'text'
                        ? { ...block, text: block.text + followupSuffix }
                        : block) };
                  }
                }
                return message;
              })
              : newMessages;
            const visibleFinalText = needsFollowup ? extractLastAssistantText(completedMessages) : finalAssistantText;
            const originalFinalStreamed = needsFollowup && finalAssistantText !== null
              && streamedTextSum.endsWith(finalAssistantText);
            // TUI-GOAL-REPEAT-ANSWER — 골 루프가 «인사 + 같은 답» 재방출을 화면에서 가리면(원장은 그대로)
            // 브리지의 스트림 합계에는 그 답이 없다. 그대로 보면 «마지막 답을 못 그렸다»고 재표면화로 다시
            // 그린다 — 이전 답이 이미 화면에 있는데도. 인사를 뗀 답 부분이 스트림 꼬리에 있으면 «그렸다»로
            // 본다(골 루프 경로에서만 — 다른 경로의 판정은 그대로).
            const goalRepeatStrippedFinalText = armGoalLoop && visibleFinalText !== null
              ? stripGoalRepeatReadbackPreface(visibleFinalText)
              : visibleFinalText;
            const synthesisAlreadyStreamed =
              visibleFinalText !== null
              && visibleFinalText.length > 0
              && (streamedTextSum.endsWith(visibleFinalText)
                || (goalRepeatStrippedFinalText !== null && goalRepeatStrippedFinalText.length > 0
                  && streamedTextSum.endsWith(goalRepeatStrippedFinalText)));
            // ⭐ 최종 답 = 모델 답 ⊕ 런타임 검증 보충이면 사용자에겐 «모델 답»만 보인다 — 보충은 로그로(#25).
            //   대화 이력(completedMessages)엔 그대로 남아 다음 턴 맥락은 바뀌지 않는다.
            const supplement = finalSupplement !== null && finalAssistantText === finalSupplement.finalText
              ? finalSupplement
              : null;
            finalSupplement = null;
            const needsReSurface =
              supplement === null
              && visibleFinalText !== null
              && visibleFinalText !== streamedTextSum
              && !synthesisAlreadyStreamed
              && !originalFinalStreamed;
            if (debug.enabled && visibleFinalText !== null) {
              debug.log('llm.synthesis-surface', 'acp-bridge.surface-final-text', {
                streamedChars: streamedTextSum.length,
                finalChars: visibleFinalText.length,
                delta: visibleFinalText.length - streamedTextSum.length,
                startsWithStreamed: streamedTextSum.length > 0
                  && visibleFinalText.startsWith(streamedTextSum),
                endsWithStreamedTail: synthesisAlreadyStreamed,
                needsReSurface,
                supplementChars: supplement?.supplement.length ?? 0,
              });
            }
            if (supplement !== null) {
              // TUI-GOAL-REPEAT-ANSWER — 위와 같은 이유: 인사를 뗀 답 부분이 스트림 꼬리에 있으면 그렸다(골 루프만).
              const answerStreamed = supplement.answer.length > 0
                && (streamedTextSum.trimEnd().endsWith(supplement.answer)
                  || (armGoalLoop
                    && streamedTextSum.trimEnd().endsWith(stripGoalRepeatReadbackPreface(supplement.answer))));
              try {
                // 보충 «전체»를 남긴다 — 한 행이 저장 전에 잘리지 않게 조각(part/parts)으로 나눈다(리뷰 r3·r4).
                const redacted = redactSecretText(supplement.supplement);
                const parts = Math.max(1, Math.ceil(redacted.length / FINAL_SUPPLEMENT_LOG_CHUNK));
                for (let part = 0; part < parts; part += 1) {
                  debug.log('acp.turn', 'final-supplement-withheld', {
                    sessionId: turnCtx.sessionId,
                    answerChars: supplement.answer.length,
                    answerStreamed,
                    supplementChars: supplement.supplement.length,
                    part: part + 1,
                    parts,
                    supplement: redacted.slice(part * FINAL_SUPPLEMENT_LOG_CHUNK, (part + 1) * FINAL_SUPPLEMENT_LOG_CHUNK),
                  });
                }
              } catch { /* observation cannot interrupt a turn */ }
              if (!answerStreamed && supplement.answer.length > 0) {
                void turnCtx.push('');
                void turnCtx.push(needsFollowup ? `${supplement.answer}${followupSuffix}` : supplement.answer);
              } else if (needsFollowup) {
                void turnCtx.push(followupSuffix);
              }
            } else if (originalFinalStreamed) {
              void turnCtx.push(followupSuffix);
            } else if (needsReSurface) {
              // Emit a clear-then-replace pair so clients that follow
              // the empty-chunk-as-clear convention (dashboard plain
              // chat) reset their per-round buffer before receiving
              // the substantive answer. The empty signal does nothing
              // for clients that just append (web / iphone — they
              // would only have the new finalAssistantText delta to
              // work with anyway).
              void turnCtx.push('');
              void turnCtx.push(visibleFinalText!);
            }
            if (deps.onTurnComplete) {
              await deps.onTurnComplete({
                sessionId: turnCtx.sessionId,
                newMessages: completedMessages,
              });
            }
          },
        },
      });
      // TUI-SPEECH-STYLE-DAEMON — 자동 수복 1회: 하위 단계가 aborted(수렴 실패)로 끝나면 실패 범위만
      // 좁혀 같은 시드로 «정확히 1회» 다시 돈다. 사용자 중단(isAborted)은 수복 대상이 아니며, 원래
      // 완료 경계(onTurnComplete 1회 지속 · 최종 답 표면화)는 복구된 시도가 그대로 이어받는다.
      let attempt = 0;
      let dispatchResult: unknown;
      let stopReason: unknown;
      for (;;) {
        attempt += 1;
        // 오류·취소로 끝나 onTurnComplete 가 안 불려도 마지막 추론 문단을 내보낸다(#28964 리뷰 FU-1 · 빈 버퍼면 무동작).
        dispatchResult = await runTurnDispatch(buildCoreTurnContext()).finally(() => reasoningThoughts.flush());
        stopReason = (dispatchResult as { stopReason?: unknown } | null | undefined)?.stopReason;
        const userCancelled = ctrl.signal.aborted || turnCtx.isAborted();
        if (stopReason !== 'aborted' || userCancelled || attempt >= 2) break;
        // 첫 시도의 잔류 스트림·보충은 폐기한다 — 복구 시도의 완료 경계가 폐기물로 오염되지 않게.
        streamedTextSum = '';
        finalSupplement = null;
        try {
          debug.log('acp.turn', 'autoheal-retry', { sessionId: turnCtx.sessionId, attempt: attempt + 1 });
        } catch { /* observation cannot interrupt a turn */ }
      }
      // ⭐ 인증 거절은 코어 턴이 «던지지 않고» 돌려준다 — 여기서 안 읽으면 서버는 end_turn 을 내고
      //   TUI 엔 «✔ 완료»만 남는다(TUI 결함 #22). 던져서 실패 경로(prompt-failed · 오류 줄)로 보낸다.
      if (stopReason === 'auth_rejected') {
        const rawError = (dispatchResult as { errorMessage?: unknown }).errorMessage;
        const error = new CoreTurnAuthRejectedError(typeof rawError === 'string' ? rawError : undefined);
        try {
          debug.log('acp.turn', 'auth-rejected', {
            sessionId: turnCtx.sessionId,
            model: turnModel,
            goalLoop: armGoalLoop,
            error: error.rawMessage.slice(0, 300),
          }, { level: 'warn' });
        } catch { /* observation cannot interrupt a turn */ }
        throw error;
      }
    } finally {
      clearInterval(poll);
    }
  };
}

/** Default message seed: single-shot `user` block with no history
 *  and no system prompt. Useful for 3-client ports that haven't
 *  plumbed persistence yet; production boot swaps this for a builder
 *  that pulls from the session history store. */
export const defaultAcpMessagesSeed: CoreTurnBridgeDeps['getMessages'] = ({
  userText,
}) => [{ role: 'user', content: userText }];
