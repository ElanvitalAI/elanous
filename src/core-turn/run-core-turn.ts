// UI-Core arc Phase U3b Step 1 — runCoreTurn.
//
// Thin, dashboard-free wrapper over `streamLLMWithTools`. The point
// of landing this *before* Step 2 (ACP server runTurn wiring) and
// Step 3 (dashboard caller refactor) is to give both sides a single
// entry point with a stable shape, so the follow-on refactors become
// substitution exercises rather than simultaneous designs.
//
// Intentionally NOT included here:
//   - approval policy / plan-gate / esc-abort wiring — those are
//     dashboard-owned state. The dashboard will pass an abort signal
//     it already controls and inject tool results (or errors) through
//     `dispatchTool`. Moving the state machine into core-turn is a
//     future phase, not U3b Step 1.
//   - message building (`buildMessagesWithContext`, plan-mode system
//     messages) — callers assemble `messages` themselves. Core-turn
//     treats the array as opaque.
//   - provider caching / prompt-cache telemetry — exposed by
//     `streamLLMWithTools` directly; when a UI needs those it calls
//     the lower layer. Core-turn is for the 80% path, not every
//     observability hook.

import { isAuthRejectionError, streamLLMWithTools } from '../llm.js';
import { drainPendingUserInput } from '../session/pending-input.js';
import type { StreamWithToolsHandlers } from '../llm.js';
import { debug, redactSecretText, withAmbientSessionScope } from '../debug/log.js';
import { applyDeferredTools } from '../session-runtime/tier-flip.js';
import { resolveSessionSurfaceProfile } from '../session-runtime/index.js';
import type {
  CoreTurnContext,
  CoreTurnResult,
  CoreTurnStopReason,
} from './types.js';

/** Classify an error thrown out of `streamLLMWithTools` into the
 *  Core-turn stop-reason set. Abort wins over everything else;
 *  credential rejection (`isAuthRejectionError`) is distinct from a
 *  generic `'error'` so hosts can prompt re-auth instead of treating
 *  it as a code/provider bug. 403 stays `'error'` — that predicate
 *  already treats it as a policy denial, not a credential problem. */
function classifyStopReason(
  err: unknown,
  signal: AbortSignal,
): CoreTurnStopReason {
  if (signal.aborted) return 'aborted';
  if (err instanceof Error && /abort/i.test(err.message)) return 'aborted';
  if (isAuthRejectionError(err)) return 'auth_rejected';
  return 'error';
}

/** P3 웜-preload 입력 — 가장 최근 user 메시지의 텍스트를 뽑는다(intent
 *  시그널 소스). content 가 string 이면 그대로, ContentBlock[] 이면 text
 *  블록들을 이어붙인다. user 메시지가 없으면 undefined. */
export function extractRecentUserText(
  messages: readonly CoreTurnContext['messages'][number][],
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    const text = m.content
      .filter((b): b is { type: 'text'; text: string } =>
        (b as { type?: string }).type === 'text' && typeof (b as { text?: string }).text === 'string')
      .map((b) => b.text)
      .join('\n');
    return text.length > 0 ? text : undefined;
  }
  return undefined;
}

/** Surface selection only accepts the dispatch-forwarded human prompt.
 * Unlike deferred preload, it must not reinterpret later machine-authored
 * user messages appended by the goal loop. */
function selectSurfaceUserText(ctx: CoreTurnContext): string | undefined {
  return ctx.userText;
}

/**
 * Execute one agent turn against the configured LLM provider using
 * the tool catalog and dispatcher the caller injected. Returns when
 * either the model stops asking for tools, the tool-loop cap is hit,
 * or the abort signal fires.
 *
 * This function is intentionally tiny: every fancy behaviour (empty-
 * turn retry, Agent batch ticks, prompt-cache telemetry, doom-loop
 * gating) is owned by `streamLLMWithTools` and inherited here for
 * free. What core-turn adds is (1) a stable shape for the hosting
 * surface's callbacks and (2) a mapped stop reason so the ACP server
 * can translate directly to `PromptResponse.stopReason` without
 * re-interpreting thrown errors.
 *
 * Failure modes:
 *   - Abort via `ctx.signal` → resolves `{ stopReason: 'aborted' }`.
 *     Any partially accumulated assistant text is still returned on
 *     `finalText` so renderers can freeze the last visible state.
 *   - Auth rejection (`isAuthRejectionError`) → resolves
 *     `{ stopReason: 'auth_rejected' }` so hosts can tell re-auth from
 *     a bug without mutating or rethrowing the provider error.
 *   - Unhandled throw → re-throws the original error unmodified
 *     (classified `'error'`). Callers still get a stack trace.
 */
export interface RunCoreTurnOptions {
  now?: () => number;
}

export async function runCoreTurn(
  ctx: CoreTurnContext,
  options: RunCoreTurnOptions = {},
): Promise<CoreTurnResult> {
  const now = options.now ?? Date.now;
  // ⭐⭐⭐ 스코프를 열기 **전에** 간선을 남긴다 — 열고 나서 찍으면 그 행마저 코어 세션으로 귀속돼
  //   ***채팅 세션 조회에 안 걸리고, 이 수리가 고치려는 결함을 그대로 반복한다***(원장 `MEAS-S14`).
  //   ⚠️ 세션 값은 바꾸지 않는다. 없던 **간선**만 는다.
  if (ctx.originSessionId && ctx.originSessionId !== ctx.sessionId) {
    // ⛔⭐⭐⭐ **부모 스코프 안에서** 찍는다 — 그래야 행의 `session_id` 가 부모(채팅 세션)가 되고
    //   `--session <채팅>` 조회에 걸린다. ⚠️ 라이브가 잡은 결함: 이 자리엔 ambient 부모가 **없어서**
    //   그냥 찍으면 `session_id=null` 이 되고, ***간선은 있는데 부모로 조회하면 안 보인다***
    //   (단위 테스트는 통과했다 — 이 축의 판정은 라이브다).
    withAmbientSessionScope(ctx.originSessionId, () => {
      debug.log('session.link', 'core-turn', { parentSessionId: ctx.originSessionId, childSessionId: ctx.sessionId });
    });
  }
  return withAmbientSessionScope(ctx.sessionId, async () => {
    if (ctx.signal.aborted) {
      return { stopReason: 'aborted', finalText: '' };
    }

    let accumulatedText = '';
    let dispatchCount = 0;

    const handlers: StreamWithToolsHandlers = {
    onText: (delta, full) => {
      accumulatedText = full;
      ctx.callbacks?.onText?.(delta, full);
    },
    ...(ctx.callbacks?.onFinalAnswerSupplement
      ? { onFinalAnswerSupplement: (info: { answer: string; supplement: string; finalText: string }) => ctx.callbacks?.onFinalAnswerSupplement?.(info) }
      : {}),
    // This async boundary deliberately returns the dispatcher's fulfilled value
    // or rejection, not its Promise object identity, so completion is recorded.
    dispatchTool: async (name, args, c) => {
      dispatchCount += 1;
      const currentDispatchCount = dispatchCount;
      const startedAt = now();
      try {
        debug.log('core.turn', 'dispatch', {
          sessionId: ctx.sessionId,
          tool: name,
          dispatchCount: currentDispatchCount,
          hasAbortSignal: Boolean(ctx.signal),
          signalAlreadyAborted: ctx.signal.aborted,
          signalSource: c ? 'parent-turn' : 'core-turn-created',
        });
      } catch {
        // Observability must not prevent the selected tool from dispatching.
      }

      let success = false;
      try {
        const result = await ctx.dispatchTool(
          name,
          args,
          // Image-pipeline followup #1 (2026-05-05) — forward sessionId so
          // the dispatcher can auto-inject into session-keyed tool calls
          // (WebTerminal* etc.) when the LLM didn't supply one. `c` may
          // be undefined for legacy provider paths that didn't pass per-
          // call ctx; synthesize a minimal envelope with the sessionId
          // alone in that case.
          // C4 — thread the TURN's abort signal alongside so dispatchers
          // can cancel in-flight tool work (and kill non-detached PTYs)
          // when session/cancel fires mid-turn.
          c
            ? { ...c, sessionId: ctx.sessionId, signal: ctx.signal, ...(ctx.userText ? { userText: ctx.userText } : {}) }
            : { callId: '', sessionId: ctx.sessionId, signal: ctx.signal, ...(ctx.userText ? { userText: ctx.userText } : {}) },
        );
        success = true;
        return result;
      } finally {
        try {
          debug.log('core.turn', 'dispatch-done', {
            sessionId: ctx.sessionId,
            tool: name,
            dispatchCount: currentDispatchCount,
            durationMs: now() - startedAt,
            success,
          });
        } catch {
          // Observability must not prevent the tool result or error from propagating.
        }
      }
    },
  };
    handlers.onToolCall = (call) => {
      debug.log('capability.resolve', 'tool-selected', {
        sessionId: ctx.sessionId,
        callId: call.id,
        tool: call.name,
      });
      ctx.callbacks?.onToolCall?.(call);
    };
  // ⛔⭐ 모든 턴 러너가 지나는 «길목». 2026-08-21: 발신자 넷에 계측을 심었는데 전부 0이라
  //   「누가 콜백을 «받기는» 하나」부터 본다. ⛔ 「안 불렸다」와 「애초에 안 걸렸다」는 다른 값이다.
  debug.log('core.turn', 'callbacks-wired', {
    sessionId: ctx.sessionId,
    onToolResult: Boolean(ctx.callbacks?.onToolResult),
    onToolCall: Boolean(ctx.callbacks?.onToolCall),
    onTurnComplete: Boolean(ctx.callbacks?.onTurnComplete),
  });
  if (ctx.callbacks?.onToolResult) {
    handlers.onToolResult = (call) => ctx.callbacks!.onToolResult!(call);
  }
  if (ctx.callbacks?.onUsage) {
    handlers.onUsage = (usage) => ctx.callbacks!.onUsage!(usage);
  }
  if (ctx.callbacks?.onTurnComplete) {
    handlers.onTurnComplete = (msgs) => ctx.callbacks!.onTurnComplete!(msgs);
  }
  if (ctx.callbacks?.onReasoning) {
    handlers.onReasoning = (event) => ctx.callbacks!.onReasoning!(event);
  }

  // ROADMAP-agent-surface-deferred-tools-2026-05-13 Wave 2 W2.4/W2.5/W2.9 —
  // split the tool catalog into (active full-schema | deferred
  // name-only) and append the deferred announce block to the system
  // message. The provider sees a leaner tools array; the LLM still
  // knows the deferred tools exist and can hydrate via ToolSearch.
  //
  // Opt-out (W2.9): user-config `tools.deferred.mode === 'off'` ships
  // every spec to the provider (pre-Wave-2 behaviour). Reads are
  // best-effort — a missing/unreadable user-config falls back to
  // default ('always'). Avoids a hard dependency on disk state from
  // a hot path: a corrupted config must not wedge the LLM loop.
  let deferredEnabled = true;
  try {
    const { getUserConfig } = await import('../user-config.js');
    deferredEnabled = getUserConfig().tools?.deferred?.mode !== 'off';
  } catch { /* fall back to default = enabled */ }
  // P3 웜 intent-preload — 이번 턴 userText 를 넘겨 도메인/스코프 시그널이
  // 있으면 그 스코프의 deferred 툴을 active 로 선주입(ToolSearch 왕복 0).
  const recentUserText = extractRecentUserText(ctx.messages);
  const surfaceUserText = selectSurfaceUserText(ctx);
  const surface = resolveSessionSurfaceProfile({ userText: surfaceUserText });
  const { messages, tools, stats } = applyDeferredTools(
    ctx.messages,
    ctx.tools,
    { enabled: deferredEnabled, ...(recentUserText ? { userText: recentUserText } : {}) },
  );
  if (debug.enabled) {
    debug.log('llm.request', 'tools-tier', {
      sessionId: ctx.sessionId,
      totalSpecs: ctx.tools.length,
      activeCount: stats.activeCount,
      deferredCount: stats.deferredCount,
      warmPreloaded: stats.warmPreloaded,
      injected: stats.injected,
      mode: deferredEnabled ? 'always' : 'off',
    });
  }
  debug.log('capability.resolve', 'tier-split', {
    sessionId: ctx.sessionId,
    surfaceId: surface.id,
    surfaceSelectionReason: surface.selectionReason,
    activeCount: stats.activeCount,
    deferredCount: stats.deferredCount,
    immediateCount: stats.activeCount,
    immediate: tools.map((tool) => tool.name),
    warmPreloaded: stats.warmPreloaded,
    deferred: stats.deferredNames,
    unhydratable: stats.unhydratableNames,
  }, { compact: { arrayMax: Number.MAX_SAFE_INTEGER } });
  if (stats.unhydratableCount > 0) {
    debug.log('capability.resolve', 'unhydratable-capabilities', {
      sessionId: ctx.sessionId,
      unhydratableCount: stats.unhydratableCount,
      unhydratable: stats.unhydratableNames,
    }, { level: 'warn' });
  }

  try {
    const finalText = await streamLLMWithTools(
      messages,
      handlers,
      {
        tools,
        signal: ctx.signal,
        ...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {}),
        ...(ctx.maxToolTurns !== undefined ? { maxTurns: ctx.maxToolTurns } : {}),
        ...(ctx.modelOverride !== undefined ? { model: ctx.modelOverride } : {}),
        ...(ctx.callbacks?.onResolvedProvider !== undefined ? { onResolvedProvider: ctx.callbacks.onResolvedProvider } : {}),
        ...(ctx.budgetGrant !== undefined ? { budgetGrant: ctx.budgetGrant } : {}),
        ...(ctx.terminalToolNames !== undefined ? { terminalToolNames: ctx.terminalToolNames } : {}),
        ...(ctx.terminalPriorAnswerVisible !== undefined ? { terminalPriorAnswerVisible: ctx.terminalPriorAnswerVisible } : {}),
        // ⭐⭐⭐ `B3`(2026-08-19 · 대표 지시 ②) — 도는 턴 «안»으로 들어오는 사용자 발화의 배수구.
        //   ⛔ 종전엔 스트리밍 중 친 발화가 ***턴이 끝난 뒤***에야 나갔다.
        //   ⭐ 이제 «다음 모델 요청을 만들기 직전»(루프 경계)에 이력으로 들어가고,
        //     문면이 「기존 작업을 마저 끝내라」를 같이 준다(`chat/interjection.ts`).
        ...(ctx.sessionId !== undefined
          ? { drainPendingUserInput: () => drainPendingUserInput(ctx.sessionId!) }
          : {}),
      },
    );
    try {
      debug.log('core.turn', 'dispatch-summary', {
        sessionId: ctx.sessionId,
        dispatchCount,
      });
    } catch {
      // Observability must not prevent a completed turn from returning.
    }
    return {
      stopReason: ctx.signal.aborted ? 'aborted' : 'end_turn',
      finalText,
    };
    } catch (err) {
      const stopReason = classifyStopReason(err, ctx.signal);
      if (stopReason === 'aborted') {
        return { stopReason, finalText: accumulatedText };
      }
      if (stopReason === 'auth_rejected') {
        return {
          stopReason,
          finalText: accumulatedText,
          errorMessage: redactSecretText(err instanceof Error ? err.message : String(err)),
        };
      }
      throw err;
    }
  });
}
