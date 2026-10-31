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
import {
  isResearchToolAllowed,
  RESEARCH_DOCUMENT_WRITE_TOOLS,
  requestsResearchDocumentWrite,
  RESEARCH_TOOL_ALLOWLIST,
  RESEARCH_TURN_DEEP_BUDGET_MS,
  RESEARCH_TURN_DEADLINE_STOP_ERROR,
  RESEARCH_TURN_FIRST_REPLY_BUDGET_MS,
  RESEARCH_TURN_MAX_TOOL_TURNS,
} from './research-policy.js';
import type {
  CoreTurnContext,
  CoreTurnResult,
  CoreTurnStopReason,
} from './types.js';

const CORE_TURN_TOOL_RESULT_INLINE_LIMIT_BYTES = 50 * 1024;

// A deep, non-research prompt gets the same-call Bloom frame, but should not
// silently grow into multi-source research just because the model can reach
// generic skill/search tools. Explicit research turns and explicit named-skill
// requests keep the normal tool surface.
const DEEP_NON_RESEARCH_SEARCH_TOOLS = new Set([
  'skill_exec', 'elanous_skills_list', 'websearch', 'web_search', 'omnisearch', 'omni_search', 'webfetch', 'web_fetch',
]);

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
function requestedInstalledSkillName(text: string | undefined, installedSkillNames: readonly string[]): string | undefined {
  if (!text) return undefined;
  return installedSkillNames
    .filter((name) => name.includes('-'))
    .sort((a, b) => b.length - a.length)
    .find((name) => {
      const parts = name.trim().split(/[-\s]+/).filter(Boolean);
      if (parts.length < 2 || !parts.every((part) => /^[a-z0-9]+$/i.test(part))) return false;
      const slug = parts.join('[\\s-]*');
      return new RegExp('(?:^|[^\\p{L}\\p{N}])' + slug + '(?=$|[^a-z0-9])\\s*(?:으로|로)(?=[^\\n!?]{0,120}(?:찾아|조사|정리))', 'iu').test(text);
    });
}

export function requestsNamedSkill(text: string | undefined, installedSkillNames: readonly string[] = []): boolean {
  if (!text) return false;
  const requestedInstalledSkill = installedSkillNames
    .filter((name) => name.includes('-'))
    .sort((a, b) => b.length - a.length)
    .some((name) => {
      const parts = name.trim().split(/[-\s]+/).filter(Boolean);
      if (parts.length < 2 || !parts.every((part) => /^[a-z0-9]+$/i.test(part))) return false;
      const slug = parts.join('[\\s-]*');
      return new RegExp('(?:^|[^\\p{L}\\p{N}])' + slug + '(?=$|[^a-z0-9])\\s*(?:으로|로)(?=[^\\n!?]{0,120}(?:찾아|조사|정리))', 'iu').test(text);
    });
  if (requestedInstalledSkill) return true;
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
  timers?: { setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>; clearTimeout(handle: ReturnType<typeof setTimeout>): void };
  firstReplyBudgetMs?: number;
  researchWallClockBudgetMs?: number;
  runResearch?: (request: string, signal: AbortSignal, admitToolCall?: (name: string) => boolean) => Promise<{ ok: boolean; output: string; error?: string }>;
}

type ResearchTimer = ReturnType<typeof setTimeout>;

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
  const timers = options.timers ?? {
    setTimeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
    clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
  };
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
    let enforceResearchToolAllowlist = false;
    let enforceResearchDocumentWrite = false;
    const isAllowedResearchTool = (name: string): boolean => isResearchToolAllowed(name)
      || (enforceResearchDocumentWrite && (RESEARCH_DOCUMENT_WRITE_TOOLS as readonly string[]).includes(name));
    let enforceResearchToolBudget = false;
    let researchToolCallCount = 0;
    let researchStopReason: string | undefined;
    const loggedResearchStops = new Set<string>();
    const logResearchStop = (reason: string, extra: Record<string, unknown> = {}): void => {
      if (loggedResearchStops.has(reason)) return;
      loggedResearchStops.add(reason);
      debug.log('research.stop', 'stopped', { sessionId: ctx.sessionId, reason, ...extra });
    };
    const admitResearchToolCall = (name: string): boolean => {
      if (!enforceResearchToolBudget) return true;
      if (researchToolCallCount >= RESEARCH_TURN_MAX_TOOL_TURNS) {
        // A prior denied tool is observable, but it must not mask the hard
        // budget stop that requires tool-free synthesis. A wall-clock stop is
        // already terminal and keeps its more specific reason.
        if (researchStopReason !== 'wall-clock-budget') researchStopReason = 'tool-budget';
        logResearchStop('tool-budget', { stage: 'tool-dispatch', tool: name, count: researchToolCallCount, limit: RESEARCH_TURN_MAX_TOOL_TURNS });
        return false;
      }
      researchToolCallCount += 1;
      return true;
    };
    const constrainResearchToolArgs = (name: string, args: Record<string, unknown>): Record<string, unknown> => {
      if (!enforceResearchToolAllowlist || name !== 'Agent' || !args || typeof args !== 'object' || Array.isArray(args)) return args;
      const raw = args;
      const rawFilter = raw.tool_filter && typeof raw.tool_filter === 'object' && !Array.isArray(raw.tool_filter)
        ? raw.tool_filter as { deny?: unknown }
        : {};
      const deny = Array.isArray(rawFilter.deny) ? rawFilter.deny.filter((tool): tool is string => typeof tool === 'string') : [];
      return {
        ...raw,
        subagent_type: typeof raw.subagent_type === 'string' && raw.subagent_type.trim()
          ? raw.subagent_type
          : 'general-purpose',
        run_in_background: false,
        wait_for_slot: false,
        max_turns: typeof raw.max_turns === 'number' && Number.isFinite(raw.max_turns)
          ? Math.max(1, Math.min(RESEARCH_TURN_MAX_TOOL_TURNS, Math.floor(raw.max_turns)))
          : RESEARCH_TURN_MAX_TOOL_TURNS,
        tool_filter: {
          allow: ['Read', 'WebFetch'],
          deny: [...new Set([...deny, 'Bash', 'Edit', 'Grep'])],
        },
      };
    };

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
        let result: unknown;
        if (enforceResearchToolAllowlist && !isAllowedResearchTool(name)) {
          researchStopReason ??= 'tool-not-allowed';
          logResearchStop('tool-not-allowed', { stage: 'tool-dispatch', tool: name, allowedTools: [...RESEARCH_TOOL_ALLOWLIST, ...(enforceResearchDocumentWrite ? ['Edit', 'Write'] : [])] });
          debug.log('core.turn', 'research-tool-denied', {
            sessionId: ctx.sessionId,
            tool: name,
            dispatchCount: currentDispatchCount,
          }, { level: 'warn' });
          result = { error: enforceResearchDocumentWrite
            ? 'This research turn may use research tools and Edit/Write only for the explicitly requested document.'
            : 'This research turn may only use the research tool allowlist.' };
        } else if (enforceResearchToolAllowlist && !admitResearchToolCall(name)) {
          debug.log('core.turn', 'research-tool-budget-reached', {
            sessionId: ctx.sessionId, tool: name, count: researchToolCallCount,
            maxToolTurns: RESEARCH_TURN_MAX_TOOL_TURNS,
          }, { level: 'warn' });
          result = { error: 'Research tool budget reached. Answer with the evidence collected so far.' };
        } else {
          result = await ctx.dispatchTool(
            name,
            constrainResearchToolArgs(name, args),
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
        }
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
  const { selectDeepBloom } = await import('./deep-turn-bloom.js');
  const deepBloomDecision = selectDeepBloom(surfaceUserText, {
    researchIntent: researchTurn,
    reasoningEffort: ctx.reasoningEffort,
  });
  const { messages, tools: tieredTools, stats } = applyDeferredTools(
    ctx.messages,
    ctx.tools,
    { enabled: deferredEnabled, ...(recentUserText ? { userText: recentUserText } : {}) },
  );
  // Preserve the pre-routing contract: a named skill only skips the research
  // prepass when skill_exec is actually active after the normal tier split.
  let explicitSkillToolRequest = requestsNamedSkill(surfaceUserText)
    && tieredTools.some((tool) => tool.name === 'skill_exec');
  if (!explicitSkillToolRequest && researchTurn && surfaceUserText?.trim()
    && tieredTools.some((tool) => tool.name === 'skill_exec')) {
    // Korean named-skill requests need the installed index to recognize the
    // skill slug before the research allowlist filters the normal tool loop.
    const { getSkillIndex } = await import('../skills/index.js');
    explicitSkillToolRequest = requestsNamedSkill(surfaceUserText, getSkillIndex().map(({ name }) => name));
  }
  const constrainDeepNonResearchTools = deepBloomDecision.apply && !researchTurn;
  // ToolSearch routes against the surface's full live pool, so hiding a tool
  // from the model alone is insufficient. Remove the summoner from the
  // model-visible tiered set while retaining original split stats/messages.
  const bloomFilteredTools = constrainDeepNonResearchTools
    ? tieredTools.filter((tool) => {
      const name = tool.name.toLowerCase();
      return name === 'skill_exec' && explicitSkillToolRequest
        ? true
        : name !== 'toolsearch' && !DEEP_NON_RESEARCH_SEARCH_TOOLS.has(name);
    })
    : tieredTools;
  if (constrainDeepNonResearchTools) {
    const suppressed = tieredTools.filter((tool) => !bloomFilteredTools.includes(tool)).map((tool) => tool.name);
    debug.log('research.turn', 'deep-bloom-search-tools-suppressed', {
      sessionId: ctx.sessionId, reason: deepBloomDecision.reason, suppressed,
      explicitSkillToolRequest,
    });
  }
  enforceResearchToolBudget = researchTurn;
  enforceResearchToolAllowlist = researchTurn && !explicitSkillToolRequest;
  enforceResearchDocumentWrite = enforceResearchToolAllowlist && requestsResearchDocumentWrite(surfaceUserText);
  const tools = enforceResearchToolAllowlist
    ? bloomFilteredTools.filter((tool) => isAllowedResearchTool(tool.name))
    : bloomFilteredTools;
  const maxToolTurns = researchTurn
    ? Math.min(ctx.maxToolTurns ?? RESEARCH_TURN_MAX_TOOL_TURNS, RESEARCH_TURN_MAX_TOOL_TURNS)
    : ctx.maxToolTurns;
  if (researchTurn && !messages.some((message) =>
    message.role === 'system' && typeof message.content === 'string'
      && message.content.startsWith('Current local date:'))
  ) {
    messages.unshift(buildResearchDateSystemMessage());
  }
  if (researchTurn) {
    messages.unshift({
      role: 'system',
      content: [
        '<research-answer-guidance>',
        '작은 후속 작업은 추가 질문 없이 현재 턴에서 먼저 처리한다.',
        '답은 결론(무엇을 찾았고 무엇을 해 두었는지)을 먼저 말하고, 근거를 짧게 덧붙인다.',
        '비용·외부 노출·되돌리기 어려움이 큰 다음 단계만 그 하나를 확인한다. 그 밖에는 묻지 않는다.',
        '다음 할 일 목록을 형식으로 요구하지 않는다.',
        '본문은 질문이 요구한 범위만 답하고, 가정 나열과 반복 설명을 줄인다.',
        '근거는 출처 링크로 짧게 붙인다.',
        '질문에 필요한 만큼 읽기 좋게 설명하며, 고정 줄 수나 글자 수로 자르지 않는다.',
        '</research-answer-guidance>',
      ].join('\n'),
    });
  }
  if (deepBloomDecision.apply) {
    const { buildDeepBloomInstruction } = await import('./deep-turn-bloom.js');
    const instruction = await buildDeepBloomInstruction(surfaceUserText ?? '', deepBloomDecision.reason);
    messages.unshift({ role: 'system', content: instruction.prompt! });
    debug.log('research.turn', 'deep-bloom-applied', {
      sessionId: ctx.sessionId, levels: instruction.levels, trigger: instruction.reason,
      questionCount: instruction.questionCount, stage: researchTurn ? 'first-answer' : 'answer',
      exemplarDomain: instruction.exemplarDomain,
      exemplarLevels: instruction.exemplarLevels,
    });
  } else if (!deepBloomDecision.apply) {
    debug.log('research.turn', 'deep-bloom-skipped', {
      sessionId: ctx.sessionId, reason: deepBloomDecision.reason,
    });
  }
    let researchResultPromise: Promise<{ ok: boolean; output: string; error?: string } | null> | undefined;
    let requestedSkillName: string | undefined;
    if (researchTurn && surfaceUserText?.trim() && explicitSkillToolRequest) {
      // Resolve a display name only for the research opening plan; ordinary
      // turns and unrequested research keep the core startup lean.
      const { getSkillIndex } = await import('../skills/index.js');
      const skillNames = getSkillIndex().map(({ name }) => name);
      requestedSkillName = requestedInstalledSkillName(surfaceUserText, skillNames);
    }
    if (researchTurn && surfaceUserText?.trim()) {
      const plan = (requestedSkillName ?? '검색 도구') + '로 요청한 주제의 근거를 찾습니다.\n질문 범위에 맞춰 결론과 근거를 정리합니다.';
      try { ctx.callbacks?.onStatus?.(plan); } catch { /* UI feedback is fail-soft. */ }
    }
    if (researchTurn && surfaceUserText?.trim() && !explicitSkillToolRequest) {
      turnStartedAt = now();
      researchStartedAt = turnStartedAt;
      debug.log('research.turn', 'tui-research-started', {
        sessionId: ctx.sessionId,
        sinceTurnStartMs: researchStartedAt - turnStartedAt,
      });
      // The opening plan was already emitted above. Do not add a generic
      // answer-first status that contradicts that plan; stream the provisional
      // answer while evidence collection runs, then reconcile in the second pass.
      const researchController = new AbortController();
      const abortResearchFromParent = (): void => {
        if (researchStopReason !== 'wall-clock-budget') researchStopReason = 'parent-abort';
        researchController.abort(ctx.signal.reason);
      };
      if (ctx.signal.aborted) abortResearchFromParent();
      else ctx.signal.addEventListener('abort', abortResearchFromParent, { once: true });
      const researchWallClockBudgetMs = options.researchWallClockBudgetMs ?? RESEARCH_TURN_DEEP_BUDGET_MS;
      let researchDeadlineTimer: ResearchTimer | undefined;
      if (!researchController.signal.aborted) {
        researchDeadlineTimer = timers.setTimeout(() => {
          if (researchController.signal.aborted) return;
          researchStopReason = 'wall-clock-budget';
          logResearchStop('wall-clock-budget', {
            stage: 'research-prepass',
            elapsedMs: researchStartedAt === undefined ? undefined : now() - researchStartedAt,
            limitMs: researchWallClockBudgetMs,
          });
          researchController.abort(new Error('Research wall-clock budget reached'));
        }, researchWallClockBudgetMs);
      }
      researchResultPromise = (async () => {
        try {
          const work = (options.runResearch ?? (async (request, signal, admitToolCall) => {
            // Keep the Bloom/skill pipeline out of ordinary and packaged TUI startup graphs.
            const { researchTurnForGrounding, runResearchQuestionLadder } = await import('../auto-research/research-turn.js');
            return researchTurnForGrounding(await runResearchQuestionLadder(request, {
              signal, admitToolCall, allowPartialOnAbort: true, allowOutputSkill: false,
            }));
          }))(surfaceUserText, researchController.signal, admitResearchToolCall);
          const result = await work;
          if (researchController.signal.aborted && !researchStopReason) researchStopReason = ctx.signal.aborted ? 'parent-abort' : 'research-aborted';
          if (researchStopReason) logResearchStop(researchStopReason, {
            stage: 'research-prepass',
            elapsedMs: researchStartedAt === undefined ? undefined : now() - researchStartedAt,
          });
          logResearchStop(result.ok ? 'evidence-complete' : 'evidence-incomplete', {
            stage: 'research-prepass', outputChars: result.output.length,
          });
          debug.log('research.turn', 'tui-research-completed', {
            sessionId: ctx.sessionId,
            ok: result.ok,
            outputChars: result.output.length,
            fallbackReason: result.error,
            elapsedMs: researchStartedAt === undefined ? undefined : now() - researchStartedAt,
          });
          return result;
        } catch (error) {
          logResearchStop('research-error', { stage: 'research-prepass', error: error instanceof Error ? error.message : String(error) });
          debug.log('research.turn', 'tui-research-fallback', {
            sessionId: ctx.sessionId,
            reason: error instanceof Error ? error.message : String(error),
            elapsedMs: researchStartedAt === undefined ? undefined : now() - researchStartedAt,
          }, { level: 'warn' });
          return null;
        } finally {
          if (researchDeadlineTimer !== undefined) timers.clearTimeout(researchDeadlineTimer);
          ctx.signal.removeEventListener('abort', abortResearchFromParent);
        }
      })();
    }
    const streamOptions = (turnTools: typeof tools, signal: AbortSignal = ctx.signal) => ({
      tools: turnTools,
      researchTurn,
      ...(explicitSkillToolRequest ? { toolChoice: { name: 'skill_exec' } } : {}),
      signal,
      ...(ctx.requestSizeGuard ? { requestSizeGuard: ctx.requestSizeGuard } : {}),
      ...(ctx.reasoningEffort !== undefined ? { reasoningEffort: ctx.reasoningEffort } : {}),
      toolResultInlineLimitBytes: CORE_TURN_TOOL_RESULT_INLINE_LIMIT_BYTES,
      ...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {}),
      ...(maxToolTurns !== undefined ? { maxTurns: maxToolTurns } : {}),
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
      immediateCount: tools.length,
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
      let firstPassTimedOut = false;
      const firstPassHandlers: StreamWithToolsHandlers = researchResultPromise
        ? {
          ...handlers,
          onText: (delta, full) => { if (!firstPassTimedOut) handlers.onText?.(delta, full); },
          onTurnComplete: (newMessages) => { if (!firstPassTimedOut) provisionalTurnMessages = newMessages; },
        }
        : handlers;
      const firstPassMessages = researchResultPromise
        ? [...messages, {
          role: 'system' as const,
          content: 'This is a provisional first response while source evidence is being gathered. Answer concisely from available context, mark uncertainty, and do not claim current facts are verified. A later evidence-reconciliation phase can use tools; do not claim a requested tool or skill is unavailable in this provisional response.',
        }]
        : messages;
      const firstPassStartedAt = researchResultPromise ? now() : undefined;
      if (researchResultPromise && firstPassStartedAt !== undefined) {
        const firstPassController = new AbortController();
        const abortFirstPassFromParent = (): void => firstPassController.abort(ctx.signal.reason);
        if (ctx.signal.aborted) abortFirstPassFromParent();
        else ctx.signal.addEventListener('abort', abortFirstPassFromParent, { once: true });
        const firstReplyBudgetMs = options.firstReplyBudgetMs ?? RESEARCH_TURN_FIRST_REPLY_BUDGET_MS;
        let firstReplyTimer: ResearchTimer | undefined;
        const deadline = new Promise<{ timedOut: true }>(resolve => {
          firstReplyTimer = timers.setTimeout(() => resolve({ timedOut: true }), firstReplyBudgetMs);
        });
        try {
          const firstPass = streamLLMWithTools(firstPassMessages, firstPassHandlers, streamOptions([], firstPassController.signal))
            .then(text => ({ timedOut: false as const, text }));
          const outcome = await Promise.race([firstPass, deadline]);
          if (outcome.timedOut) {
            firstPassTimedOut = true;
            firstPassController.abort(new Error('First answer budget reached'));
            logResearchStop('first-reply-budget', { stage: 'first-response', limitMs: firstReplyBudgetMs, elapsedMs: now() - firstPassStartedAt });
            const partial = accumulatedText.trim();
            finalText = partial || '질문을 확인하고 있습니다. 근거를 조사한 뒤 제한 시간 안에 답을 정리하겠습니다.';
            if (!partial) handlers.onText?.(finalText, finalText);
            provisionalTurnMessages = [{ role: 'assistant', content: finalText, phase: 'final_answer' }];
          } else {
            finalText = outcome.text;
          }
        } finally {
          if (firstReplyTimer !== undefined) timers.clearTimeout(firstReplyTimer);
          ctx.signal.removeEventListener('abort', abortFirstPassFromParent);
        }
      } else {
        finalText = await streamLLMWithTools(firstPassMessages, firstPassHandlers, streamOptions(tools));
      }
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
        const forcedSynthesis = researchStopReason === 'wall-clock-budget' || researchStopReason === 'tool-budget';
        const hasUsableResearch = Boolean(result?.output.trim())
          && (result?.ok === true || result?.error === RESEARCH_TURN_DEADLINE_STOP_ERROR);
        if (forcedSynthesis) {
          logResearchStop('forced-synthesis', { stage: 'synthesis', trigger: researchStopReason, toolCalls: researchToolCallCount });
          try { ctx.callbacks?.onStatus?.('조사 한도에 도달해 확인된 근거만으로 답을 정리합니다.'); } catch { /* UI feedback is fail-soft. */ }
        }
        if (hasUsableResearch && result && !ctx.signal.aborted) {
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
            { role: 'system', content: forcedSynthesis
              ? 'The research budget has ended. Synthesize now using only the partial evidence above. State uncertainty and gaps clearly. Do not call tools or continue research.'
              : 'Revise the answer above using this research evidence. Correct any unsupported or contradicted claims, preserve uncertainty, and answer in natural prose. Do not output JSON or a tool transcript. If the evidence does not materially change the answer, state the answer directly.' },
          );
          const synthesisTools = forcedSynthesis ? [] : tools.filter(tool => !['WebSearch', 'OmniSearch'].includes(tool.name));
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
            logResearchStop('synthesis-complete', { stage: 'synthesis', outputChars: finalText.length });
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
        } else if (forcedSynthesis || tools.some(tool => !['WebSearch', 'OmniSearch'].includes(tool.name))) {
          try { ctx.callbacks?.onStatus?.(forcedSynthesis ? '조사 한도에 도달해 첫 답변을 근거 없이 확장하지 않고 마무리합니다.' : '근거 검색은 실패해 사용할 수 있는 도구로 답변을 마무리합니다.'); } catch { /* UI feedback is fail-soft. */ }
          const provisionalText = finalText;
          const staged = createStagedHandlers(handlers);
          messages.push(
            { role: 'assistant', content: provisionalText.trim() },
            ...(result?.output.trim() ? [{ role: 'system' as const, content: `<partial-research>\n${result.output.trim()}\n</partial-research>` }] : []),
            { role: 'system', content: forcedSynthesis
              ? 'The research budget has ended. Synthesize now without tools. Use any partial evidence above and clearly state uncertainty; do not continue research.'
              : 'Research evidence was unavailable. Continue answering the user using available non-search tools as needed. Do not invoke web search.' },
          );
          const fallbackTools = forcedSynthesis ? [] : tools.filter(tool => !['WebSearch', 'OmniSearch'].includes(tool.name));
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
