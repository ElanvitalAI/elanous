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
import { isResearchAgentIntent } from '../tool-hints/signals.js';
import { buildResearchDateSystemMessage, resolveSessionSurfaceProfile } from '../session-runtime/index.js';
import type {
  CoreTurnContext,
  CoreTurnResult,
  CoreTurnStopReason,
} from './types.js';

const CORE_TURN_TOOL_RESULT_INLINE_LIMIT_BYTES = 50 * 1024;

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

/** An explicit named-skill request must reach the normal tool loop before
 *  the research turn's text-only provisional answer. That provisional pass
 *  has no tools by design and otherwise tells the user the requested skill
 *  cannot be invoked, even when the skill router already resolved it. */
function requestsNamedSkill(text: string | undefined): boolean {
  if (!text) return false;
  const action = '(?:use|invoke|run|call|execute|launch|trigger|apply|start)';
  return new RegExp(`\\b${action}\\s+(?:(?:the|a|an)\\s+)?skill\\s+(?:named|called)\\s+['"“‘]([a-z0-9][a-z0-9 _-]{1,60}?)['"”’](?=$|[\\s.,;!?])`, 'i').test(text)
    || new RegExp(`\\b${action}\\s+(?:the\\s+)?['"“‘]([a-z0-9][a-z0-9 _-]{1,60}?)['"”’](?=$|[\\s.,;!?])`, 'i').test(text)
    || new RegExp(`\\b${action}\\s+(?:the\\s+)?([a-z0-9][a-z0-9-]{1,40})\\s+skill\\b`, 'i').test(text)
    || /스킬\s+(?:이름(?:은|이)?\s*)?['"“‘「]([\p{L}\p{N}][\p{L}\p{N}\p{M}_ -]{1,60}?)['"”’」]\s*(?:을|를)?\s*(?:사용|호출|실행)/iu.test(text)
    || /['"“‘「]([\p{L}\p{N}][\p{L}\p{N}\p{M}_ -]{1,60}?)['"”’」]\s*스킬?\s*(?:을|를)?\s*(?:사용|호출|실행)/iu.test(text)
    || /([\p{L}\p{N}_-]{2,60})\s+스킬\s*(?:을|를)?\s*(?:사용|호출|실행)/iu.test(text);
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
  runResearch?: (request: string, signal: AbortSignal) => Promise<{ ok: boolean; output: string; error?: string }>;
}

type AbortRace<T> = { aborted: true } | { aborted: false; value: T };

function settleBeforeAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<AbortRace<T>> {
  if (signal.aborted) return Promise.resolve({ aborted: true });
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      resolve({ aborted: true });
    };
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      value => { signal.removeEventListener('abort', onAbort); resolve({ aborted: false, value }); },
      error => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

type TurnCompletion = Parameters<NonNullable<StreamWithToolsHandlers['onTurnComplete']>>[0];

function createStagedHandlers(handlers: StreamWithToolsHandlers) {
  let text = '';
  let completion: TurnCompletion | undefined;
  return {
    handlers: {
      ...handlers,
      onText: (_delta: string, full: string) => { text = full; },
      onTurnComplete: (messages: TurnCompletion) => { completion = messages; },
    } satisfies StreamWithToolsHandlers,
    text: () => text,
    completion: () => completion,
  };
}

function commitCompletion(
  messages: TurnCompletion | undefined,
  handlers: StreamWithToolsHandlers,
  setFinalPhaseAnswer: (value: boolean) => void,
): void {
  if (!messages) return;
  const lastAssistant = [...messages].reverse().find(message => message.role === 'assistant');
  setFinalPhaseAnswer(lastAssistant?.phase === 'final_answer');
  handlers.onTurnComplete?.(messages);
}

function commitProvisionalTurn(
  messages: TurnCompletion | undefined,
  handlers: StreamWithToolsHandlers,
  setFinalPhaseAnswer: (value: boolean) => void,
): void {
  commitCompletion(messages, handlers, setFinalPhaseAnswer);
}

function commitStagedTurn(
  messages: TurnCompletion | undefined,
  handlers: StreamWithToolsHandlers,
  text: string,
  replaceVisibleText: boolean,
  setFinalPhaseAnswer: (value: boolean) => void,
  onReplaceText?: (fullText: string) => void,
): void {
  commitCompletion(messages, handlers, setFinalPhaseAnswer);
  if (replaceVisibleText && text) onReplaceText?.(text);
}

export async function runCoreTurn(
  ctx: CoreTurnContext,
  options: RunCoreTurnOptions = {},
): Promise<CoreTurnResult> {
  const now = options.now ?? Date.now;
  let turnStartedAt: number | undefined;
  let researchStartedAt: number | undefined;
  let researchFirstTokenRecorded = false;
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
    let finalPhaseAnswer = false;

    const handlers: StreamWithToolsHandlers = {
    onText: (delta, full) => {
      accumulatedText = full;
      if (researchStartedAt !== undefined && !researchFirstTokenRecorded && delta.length > 0) {
        researchFirstTokenRecorded = true;
        debug.log('research.turn', 'first-token', {
          sessionId: ctx.sessionId,
          sinceTurnStartMs: turnStartedAt === undefined ? undefined : now() - turnStartedAt,
          sinceResearchStartMs: now() - researchStartedAt,
          outputChars: full.length,
        });
      }
      ctx.callbacks?.onText?.(delta, full);
    },
    ...(ctx.callbacks?.onStatus ? { onStatus: (line: string) => ctx.callbacks?.onStatus?.(line) } : {}),
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
    handlers.onTurnComplete = (msgs) => {
      const lastAssistant = [...msgs].reverse().find((message) => message.role === 'assistant');
      finalPhaseAnswer = lastAssistant?.phase === 'final_answer';
      ctx.callbacks!.onTurnComplete!(msgs);
    };
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
  const surface = ctx.surfaceProfile ?? resolveSessionSurfaceProfile({ userText: surfaceUserText });
  // Use the shared #31663 research-intent verdict. Surface labels are a
  // presentation/routing result and may remain `chat` for a research turn.
  const researchTurn = isResearchAgentIntent(surfaceUserText);
  const { messages, tools, stats } = applyDeferredTools(
    ctx.messages,
    ctx.tools,
    { enabled: deferredEnabled, ...(recentUserText ? { userText: recentUserText } : {}) },
  );
  if (researchTurn && !messages.some((message) =>
    message.role === 'system' && typeof message.content === 'string'
      && message.content.startsWith('Current local date:'))
  ) {
    messages.unshift(buildResearchDateSystemMessage());
  }
    let researchResultPromise: Promise<{ ok: boolean; output: string; error?: string } | null> | undefined;
    const explicitSkillToolRequest = requestsNamedSkill(surfaceUserText)
      && tools.some((tool) => tool.name === 'skill_exec');
    if (researchTurn && surfaceUserText?.trim() && !explicitSkillToolRequest) {
      turnStartedAt = now();
      researchStartedAt = turnStartedAt;
      debug.log('research.turn', 'tui-research-started', {
        sessionId: ctx.sessionId,
        sinceTurnStartMs: researchStartedAt - turnStartedAt,
      });
      // Start evidence collection beside the first answer. The user gets an
      // immediate, visible status and an initial answer while research runs;
      // a second text-only synthesis then reconciles that answer with evidence.
      try { ctx.callbacks?.onStatus?.('먼저 답변을 시작하고 근거를 확인합니다.'); } catch { /* UI feedback is fail-soft. */ }
      researchResultPromise = (async () => {
        try {
          const result = await (options.runResearch ?? (async (request, signal) => {
            // Keep the Bloom/skill pipeline out of ordinary and packaged TUI startup graphs.
            const { researchTurnForGrounding, runResearchQuestionLadder } = await import('../auto-research/research-turn.js');
            return researchTurnForGrounding(await runResearchQuestionLadder(request, { signal }));
          }))(surfaceUserText, ctx.signal);
          debug.log('research.turn', 'tui-research-completed', {
            sessionId: ctx.sessionId,
            ok: result.ok,
            outputChars: result.output.length,
            fallbackReason: result.error,
            elapsedMs: researchStartedAt === undefined ? undefined : now() - researchStartedAt,
          });
          return result;
        } catch (error) {
          debug.log('research.turn', 'tui-research-fallback', {
            sessionId: ctx.sessionId,
            reason: error instanceof Error ? error.message : String(error),
            elapsedMs: researchStartedAt === undefined ? undefined : now() - researchStartedAt,
          }, { level: 'warn' });
          return null;
        }
      })();
    }
    const streamOptions = (turnTools: typeof tools) => ({
      tools: turnTools,
      researchTurn,
      signal: ctx.signal,
      ...(ctx.requestSizeGuard ? { requestSizeGuard: ctx.requestSizeGuard } : {}),
      toolResultInlineLimitBytes: CORE_TURN_TOOL_RESULT_INLINE_LIMIT_BYTES,
      ...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {}),
      ...(ctx.maxToolTurns !== undefined ? { maxTurns: ctx.maxToolTurns } : {}),
      ...(ctx.initialProvider !== undefined
        ? { initialProvider: ctx.initialProvider, ...(ctx.skipProviders ? { skipProviders: ctx.skipProviders } : {}) }
        : ctx.modelOverride !== undefined ? { model: ctx.modelOverride } : {}),
      ...(ctx.callbacks?.onResolvedProvider !== undefined ? { onResolvedProvider: ctx.callbacks.onResolvedProvider } : {}),
      ...(ctx.budgetGrant !== undefined ? { budgetGrant: ctx.budgetGrant } : {}),
      ...(ctx.terminalToolNames !== undefined ? { terminalToolNames: ctx.terminalToolNames } : {}),
      ...(ctx.terminalPriorAnswerVisible !== undefined ? { terminalPriorAnswerVisible: ctx.terminalPriorAnswerVisible } : {}),
      ...(ctx.terminalCompletionAccepted !== undefined ? { terminalCompletionAccepted: ctx.terminalCompletionAccepted } : {}),
      ...(ctx.sessionId !== undefined ? { drainPendingUserInput: () => drainPendingUserInput(ctx.sessionId!) } : {}),
    });

    let finalText = '';
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
    debug.log('capability.resolve', 'tool-tier-split', {
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
      let provisionalTurnMessages: Parameters<NonNullable<StreamWithToolsHandlers['onTurnComplete']>>[0] | undefined;
      const firstPassHandlers: StreamWithToolsHandlers = researchResultPromise && handlers.onTurnComplete
        ? { ...handlers, onTurnComplete: (newMessages) => { provisionalTurnMessages = newMessages; } }
        : handlers;
      const firstPassMessages = researchResultPromise
        ? [...messages, {
          role: 'system' as const,
          content: 'This is a provisional first response while source evidence is being gathered. Answer concisely from available context, mark uncertainty, and do not claim current facts are verified. A later evidence-reconciliation phase can use tools; do not claim a requested tool or skill is unavailable in this provisional response.',
        }]
        : messages;
      const firstPassStartedAt = researchResultPromise ? now() : undefined;
      finalText = await streamLLMWithTools(firstPassMessages, firstPassHandlers, streamOptions(researchResultPromise ? [] : tools));
      if (researchResultPromise && firstPassStartedAt !== undefined) {
        debug.log('research.turn', 'first-pass-answer-ready', {
          sessionId: ctx.sessionId,
          durationMs: now() - firstPassStartedAt,
          sinceTurnStartMs: turnStartedAt === undefined ? undefined : now() - turnStartedAt,
          sinceResearchStartMs: researchStartedAt === undefined ? undefined : now() - researchStartedAt,
          outputChars: finalText.length,
        });
      }
      if (researchResultPromise) {
        const racedResearch = await settleBeforeAbort(researchResultPromise, ctx.signal);
        if (racedResearch.aborted) {
          commitProvisionalTurn(provisionalTurnMessages, handlers, value => { finalPhaseAnswer = value; });
          return { stopReason: 'aborted', finalText };
        }
        const result = racedResearch.value;
        if (ctx.signal.aborted) {
          commitProvisionalTurn(provisionalTurnMessages, handlers, value => { finalPhaseAnswer = value; });
          return { stopReason: 'aborted', finalText };
        }
        if (result?.ok && result.output.trim() && !ctx.signal.aborted) {
          try { ctx.callbacks?.onStatus?.('근거를 반영해 답변을 보강합니다.'); } catch { /* UI feedback is fail-soft. */ }
          const synthesisStartedAt = now();
          debug.log('research.turn', 'synthesis-started', {
            sessionId: ctx.sessionId,
            sinceTurnStartMs: turnStartedAt === undefined ? undefined : synthesisStartedAt - turnStartedAt,
            researchElapsedMs: researchStartedAt === undefined ? undefined : synthesisStartedAt - researchStartedAt,
          });
          const provisionalText = finalText;
          accumulatedText = provisionalText;
          const staged = createStagedHandlers(handlers);
          messages.push(
            { role: 'assistant', content: provisionalText.trim() },
            { role: 'system', content: `<bloom-research>\n${result.output.trim()}\n</bloom-research>` },
            { role: 'system', content: 'Revise the answer above using this research evidence. Correct any unsupported or contradicted claims, preserve uncertainty, and answer in natural prose. Do not output JSON or a tool transcript. If the evidence does not materially change the answer, state the answer directly.' },
          );
          const synthesisTools = tools.filter(tool => !['WebSearch', 'OmniSearch'].includes(tool.name));
          try {
            const synthesizedText = await streamLLMWithTools(messages, staged.handlers, streamOptions(synthesisTools));
            if (ctx.signal.aborted) {
              commitProvisionalTurn(provisionalTurnMessages, handlers, value => { finalPhaseAnswer = value; });
              return { stopReason: 'aborted', finalText: provisionalText };
            }
            finalText = synthesizedText || staged.text() || provisionalText;
            accumulatedText = finalText;
            debug.log('research.turn', 'synthesis-completed', {
              sessionId: ctx.sessionId,
              elapsedMs: now() - synthesisStartedAt,
              sinceTurnStartMs: turnStartedAt === undefined ? undefined : now() - turnStartedAt,
              outputChars: finalText.length,
            });
            if (staged.completion()) {
              commitStagedTurn(staged.completion(), handlers, finalText, finalText !== provisionalText,
                value => { finalPhaseAnswer = value; }, ctx.callbacks?.onReplaceText);
            } else {
              commitProvisionalTurn(provisionalTurnMessages, handlers, value => { finalPhaseAnswer = value; });
            }
          } catch (error) {
            commitProvisionalTurn(provisionalTurnMessages, handlers, value => { finalPhaseAnswer = value; });
            const stopReason = classifyStopReason(error, ctx.signal);
            if (stopReason === 'aborted') return { stopReason, finalText: provisionalText };
            if (stopReason === 'auth_rejected') {
              return {
                stopReason,
                finalText: provisionalText,
                errorMessage: redactSecretText(error instanceof Error ? error.message : String(error)),
              };
            }
            try { ctx.callbacks?.onStatus?.('근거 반영에 실패해 첫 답변을 유지합니다.'); } catch { /* UI feedback is fail-soft. */ }
            return { stopReason: 'end_turn', finalText: provisionalText, ...(handlers.onTurnComplete ? { finalPhaseAnswer } : {}) };
          }
        } else if (tools.some(tool => !['WebSearch', 'OmniSearch'].includes(tool.name))) {
          try { ctx.callbacks?.onStatus?.('근거 검색은 실패해 사용할 수 있는 도구로 답변을 마무리합니다.'); } catch { /* UI feedback is fail-soft. */ }
          const provisionalText = finalText;
          const staged = createStagedHandlers(handlers);
          messages.push(
            { role: 'assistant', content: provisionalText.trim() },
            { role: 'system', content: 'Research evidence was unavailable. Continue answering the user using available non-search tools as needed. Do not invoke web search.' },
          );
          const fallbackTools = tools.filter(tool => !['WebSearch', 'OmniSearch'].includes(tool.name));
          try {
            const fallbackText = await streamLLMWithTools(messages, staged.handlers, streamOptions(fallbackTools));
            if (ctx.signal.aborted) {
              commitProvisionalTurn(provisionalTurnMessages, handlers, value => { finalPhaseAnswer = value; });
              return { stopReason: 'aborted', finalText: provisionalText };
            }
            finalText = fallbackText || staged.text() || provisionalText;
            accumulatedText = finalText;
            if (staged.completion()) {
              commitStagedTurn(staged.completion(), handlers, finalText, finalText !== provisionalText,
                value => { finalPhaseAnswer = value; }, ctx.callbacks?.onReplaceText);
            } else {
              commitProvisionalTurn(provisionalTurnMessages, handlers, value => { finalPhaseAnswer = value; });
            }
          } catch (error) {
            commitProvisionalTurn(provisionalTurnMessages, handlers, value => { finalPhaseAnswer = value; });
            const stopReason = classifyStopReason(error, ctx.signal);
            if (stopReason === 'aborted') return { stopReason, finalText: provisionalText };
            if (stopReason === 'auth_rejected') {
              return {
                stopReason,
                finalText: provisionalText,
                errorMessage: redactSecretText(error instanceof Error ? error.message : String(error)),
              };
            }
            try { ctx.callbacks?.onStatus?.('도구 fallback이 실패해 첫 답변을 유지합니다.'); } catch { /* UI feedback is fail-soft. */ }
            return { stopReason: 'end_turn', finalText: provisionalText, ...(handlers.onTurnComplete ? { finalPhaseAnswer } : {}) };
          }
        } else if (provisionalTurnMessages && ctx.callbacks?.onTurnComplete) {
          const lastAssistant = [...provisionalTurnMessages].reverse().find(message => message.role === 'assistant');
          finalPhaseAnswer = lastAssistant?.phase === 'final_answer';
          ctx.callbacks.onTurnComplete(provisionalTurnMessages);
        }
      }
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
        ...(ctx.callbacks?.onTurnComplete ? { finalPhaseAnswer } : {}),
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
