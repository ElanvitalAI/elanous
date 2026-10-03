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

import type { LLMMessage, LLMToolSpec, ContentBlock } from '../llm.js';
import { debug } from '../debug/log.js';
import {
  runCoreTurn,
  runGoalLoop,
  type CoreTurnContext,
  type CoreTurnDispatchTool,
} from '../core-turn/index.js';
import { getUserConfig } from '../user-config.js';
import { getModelFamily } from '../models/prompts.js';
import { resolveModelContextWindow } from '../models/context-window.js';
import type { AcpServerOptions, AcpTurnContext } from './server.js';
import { acpToolDenialResult } from './tool-approval.js';
import { readOriginSessionMeta } from './origin-session-meta.js';
import { isFactQuestion } from './fact-question.js';

const FACT_QUESTION_INSTRUCTION = '사실·최신 정보 질문이다. WebSearch 를 1~2회 쓰고 검색 결과(제목·스니펫·URL)로 답하라. 출처 링크를 붙여라. 셸·브라우저·파일 도구는 검색 결과로 부족할 때만. 도구 예산에 닿으면 지금까지 근거로 답하고 끝에 «더 찾아볼까요?»를 붙여라.';

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
      const tools = await Promise.resolve(
        deps.getTools({
          sessionId: turnCtx.sessionId,
          userText: turnCtx.userText,
        }),
      );
      const modelOverride = deps.resolveModel?.({ sessionId: turnCtx.sessionId, userText: turnCtx.userText });
      const factQuestion = isFactQuestion(turnCtx.userText);
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
      // Tier 2 arming(config-gated·2026-07-19 goal-exec → 아크4 전-family) — llm.goalLoop.enabled
      // 면 across-turn goal loop(runGoalLoop)로 감싸 목표 완료(update_goal 증거게이트)까지 지속·
      // continuation 재주입. **family 무관**(runGoalLoop 프롬프트·update_goal 툴 전부 provider-generic·
      // 백스톱=max-iter·spin·blocked-3strike·context-pressure). 그 외엔 단일 turn(runCoreTurn).
      // 하드코딩 기본 ON 아님 — config 로 아밍(안전). turnFamily 는 관측용으로만 유지.
      const goalLoopCfg = getUserConfig().llm.goalLoop;
      const turnModel = modelOverride ?? getUserConfig().llm.model;
      const turnFamily = getModelFamily(turnModel);
      const armGoalLoop = goalLoopCfg?.enabled === true;
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
      const runTurnDispatch = (c: CoreTurnContext): Promise<unknown> =>
        armGoalLoop
          ? runGoalLoop(c, {
              ...(goalLoopCfg?.maxIterations !== undefined ? { maxIterations: goalLoopCfg.maxIterations } : {}),
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
      await runTurnDispatch({
        sessionId: turnCtx.sessionId,
        ...(originSessionId ? { originSessionId } : {}),
        ...(turnCtx.userText ? { userText: turnCtx.userText } : {}),
        messages: turnMessages,
        tools,
        dispatchTool,
        signal: ctrl.signal,
        ...(modelOverride !== undefined ? { modelOverride } : {}),
        ...(maxToolTurns !== undefined ? { maxToolTurns } : {}),
        ...((!factQuestion || explicitMaxToolTurns !== undefined) && deps.budgetGrant !== undefined ? { budgetGrant: deps.budgetGrant } : {}),
        callbacks: {
          onText: (delta) => {
            // Fire-and-forget: ACP `push` is async but the core-turn
            // contract is synchronous onText. Chunks are delivered in
            // order because `sessionUpdate` is serialized per-
            // connection on the ACP SDK side.
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
          onToolCall: (call) => {
            if (!factQuestion || maxToolTurns === undefined || maxToolTurns <= 0) {
              toolCallCount += 1;
              toolKinds.add(call.name);
              observeToolBudget();
            }
            void turnCtx.pushToolCall(call);
          },
          onToolResult: (call) => { void turnCtx.pushToolResult(call); },
          onUsage: (usage) => { void turnCtx.pushUsage(usage); },
          // Codex Responses API reasoning summary stream. Currently
          // surfaced via forensic only (debug.log) — acts as the
          // "did the model actually emit reasoning?" verification
          // signal before we wire the dashboard UI in a fast-follow.
          // The forensic line carries the streamed delta and the
          // running summary index so a single grep gives the
          // reasoning trace in order. summary_part_added marks the
          // paragraph boundary; summary_delta is the text within.
          onReasoning: (event) => {
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
            const synthesisAlreadyStreamed =
              visibleFinalText !== null
              && visibleFinalText.length > 0
              && streamedTextSum.endsWith(visibleFinalText);
            const needsReSurface =
              visibleFinalText !== null
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
              });
            }
            if (originalFinalStreamed) {
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
