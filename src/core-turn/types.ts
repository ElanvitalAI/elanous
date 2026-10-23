// UI-Core arc Phase U3b Step 1 — core-turn types.
//
// `runCoreTurn` (run-core-turn.ts) is the dashboard-independent entry
// point that wraps `streamLLMWithTools`. It's the primitive both the
// current dashboard and the ACP server (Phase U3b Step 2) will
// ultimately route through, so 3-client ports (Web/iPhone/iPad) stop
// reimplementing turn loops per transport.
//
// The types here deliberately mirror a small subset of
// `StreamWithToolsHandlers` from src/llm.ts — enough for a headless
// host to drive a turn and receive the events a renderer cares about,
// without leaking `llm.ts` internals (usage telemetry, agent batch
// lifecycle, empty-turn retry state). Dashboards that need those
// fields still call `streamLLMWithTools` directly for now; U3b Step 3
// folds dashboard onto `runCoreTurn` once the core event set is
// proven sufficient.

import type { LLMMessage, LLMOpts, LLMProvider, LLMToolSpec } from '../llm.js';
import type { LLMUsage } from '../prompt-cache/types.js';

/** Stop reasons exposed by `runCoreTurn`. Mirrors the ACP
 *  `PromptResponse.stopReason` value set so callers wiring to the ACP
 *  server path can forward the value without a translation layer.
 *  `auth_rejected` is a core-turn distinction (re-auth vs bug) on top
 *  of that set — it is not an ACP wire value. */
export type CoreTurnStopReason =
  | 'end_turn'
  | 'max_turns'
  | 'aborted'
  | 'auth_rejected'
  | 'error';

export interface CoreToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface CoreToolResult {
  id: string;
  name: string;
  result: unknown;
}

/** Dispatcher contract — invoked by the turn loop when the model asks
 *  to call a tool. Mirrors `StreamWithToolsHandlers.dispatchTool`
 *  exactly so existing dashboard dispatchers can be passed through
 *  unchanged. */
export type CoreTurnDispatchTool = (
  name: string,
  args: Record<string, unknown>,
  ctx?: {
    callId: string;
    /** CC (2026-04-25) — current tool-loop turn index (0-based). Lets
     *  the session-runtime planner distinguish same-turn parallel fan-
     *  out from cross-turn repeats. Optional — older callers that don't
     *  forward this field fall back to pre-CC block semantics. */
    turnIndex?: number;
    /** Image-pipeline followup #1 (2026-05-05) — current ACP sessionId
     *  for this turn. `runCoreTurn` forwards `CoreTurnContext.sessionId`
     *  here so dispatchers that route to session-keyed registries
     *  (preview-tap-registry, kgs scope, …) can resolve the right
     *  scope without the LLM having to thread the id through tool
     *  args. Optional for backward compat — older dispatchers that
     *  don't read it ignore the field. */
    sessionId?: string;
    /** Original human prompt for this turn. Optional so non-chat and
     *  legacy dispatchers retain their existing call shape. */
    userText?: string;
    /** C4 (2026-07-12) — the TURN's abort signal. `runCoreTurn` forwards
     *  `CoreTurnContext.signal` here so dispatchers can thread real
     *  cancellation into tool runtimes (daemon path: session/cancel →
     *  bridge poll → this signal → tool abort + non-detached PTY kill).
     *  Optional for backward compat — older dispatchers ignore it. */
    signal?: AbortSignal;
  },
) => Promise<unknown>;

/** Events the hosting surface (dashboard chat pane, ACP push pipe,
 *  future web/iphone client) cares about. All optional. */
export interface CoreTurnCallbacks {
  /** Actual provider and model selected for this turn, including fallback attempts. */
  onResolvedProvider?(provider: string, model: string): void;
  /** Streaming text delta — `full` is the accumulated text across the
   *  entire turn (not just the current round). */
  onText?(delta: string, full: string): void;
  /** The final answer came back enriched with a runtime verification
   *  supplement — forwarded from `StreamWithToolsHandlers.onFinalAnswerSupplement`. */
  onFinalAnswerSupplement?(info: { answer: string; supplement: string; finalText: string }): void;
  /** Fires just before a tool call is dispatched. */
  onToolCall?(call: CoreToolCall): void;
  /** Fires once the tool call resolves. */
  onToolResult?(call: CoreToolResult): void;
  /** P2-bridge-ext — per-request usage telemetry. Forwarded from
   *  `StreamWithToolsHandlers.onUsage`; fires for every LLM response
   *  (Anthropic emits 2 per turn; OpenAI 1). Headless hosts that want
   *  token-count / cost metrics consume this without needing to call
   *  `streamLLMWithTools` directly. */
  onUsage?(usage: LLMUsage): void;
  /** Delivers the messages the turn loop ACCUMULATED beyond `messages`
   *  — assistant text + tool_use blocks plus matching tool_result
   *  blocks. Mirrors `StreamWithToolsHandlers.onTurnComplete`; callers
   *  persist this into their history store so the next user turn
   *  sees real tool evidence rather than a string summary. */
  onTurnComplete?(newMessages: LLMMessage[]): void;
  /** Codex Responses API reasoning summary stream (gpt-5 family).
   *  `summary_part_added` marks a paragraph break between successive
   *  parts; `summary_delta` carries the streamed text. Only fires when
   *  user-config.llm.codexReasoning.summary is set — hosts that don't
   *  render reasoning omit this. Mirrors
   *  `StreamWithToolsHandlers.onReasoning`. */
  onReasoning?(event:
    | { kind: 'summary_part_added'; summaryIndex?: number }
    | { kind: 'summary_delta'; delta: string; summaryIndex?: number }
  ): void;
}

/** Fully self-contained input to `runCoreTurn`. A module in
 *  `src/core-turn/` never imports from dashboard / chat / tui /
 *  display — the headless guard test enforces this structurally. */
export interface CoreTurnContext {
  /** Identifier for the hosting session. Piped through for future
   *  correlation; the turn logic does not branch on it. */
  sessionId: string;
  /**
   * ⭐ 이 턴을 **연 쪽**의 세션(예: TUI 채팅 세션). `sessionId` 와 다를 때만 의미가 있다.
   *
   * ⛔ 왜 필요한가(실측 2026-08-02 · 원장 `MEAS-S14`): `runCoreTurn` 은 `sessionId`(코어/ACP 세션)로
   * ambient 스코프를 열고, 그 뒤 모든 로그(`capability.resolve/tool-selected` 포함)가 그 세션으로 찍힌다.
   * 그런데 채팅 세션 스코프는 **여기까지 살아 오지 않는다**(계측으로 확인: `runCoreTurn` 진입 시 부모 `null`).
   * ⇒ ***채팅 세션으로 「그 턴에 무슨 툴을 썼나」를 물으면 위임 턴이 통째로 사라진다.***
   *
   * ⇒ ambient 에 기대지 않고 **명시로** 받는다. 값을 바꾸지 않고 **간선만** 남긴다.
   */
  originSessionId?: string;
  /** Original human prompt for this turn, forwarded to tool dispatch. */
  userText?: string;
  /** Full prompt (system + history + current user blocks). */
  messages: LLMMessage[];
  /** Tool catalog the model may call this turn. Empty array means
   *  "text-only" — the loop delegates to plain `streamLLM`. */
  tools: LLMToolSpec[];
  /** Tool dispatcher. */
  dispatchTool: CoreTurnDispatchTool;
  /** Abort signal — forwarded to `streamLLMWithTools`. */
  signal: AbortSignal;
  /** Optional renderer / persistence hooks. */
  callbacks?: CoreTurnCallbacks;
  /** Override for the tool-loop turn cap (`streamLLMWithTools`
   *  `maxTurns`). Omit for the default chat budget. */
  maxToolTurns?: number;
  /** Conditional tool-loop budget extension — forwarded verbatim to
   *  `streamLLMWithTools` (`LLMOpts.budgetGrant`). Lets a surface keep
   *  the tight default cap while granting extra rounds only while
   *  named tools (e.g. the PtyShell family driving a headless coding
   *  agent) are actually being dispatched. Absent ⇒ no extension. */
  budgetGrant?: LLMOpts['budgetGrant'];
  /** TUI-GOAL-LOOP-FRICTION — 종결 신호 도구 이름. `streamLLMWithTools` 의 `terminalToolNames` 로 그대로 간다
   *  (예산 거부 면제 · 신호뿐인 턴 ⊕ 답 = 마감). goal loop 가 `update_goal` 을 넣는다. */
  terminalToolNames?: LLMOpts['terminalToolNames'];
  /** TUI-H1-GOALLOOP-EMPTY-TAIL — 이 턴 «앞»에 사람에게 답을 이미 보였다. `streamLLMWithTools` 의
   *  `terminalPriorAnswerVisible` 로 그대로 간다(종결 신호 뒤 빈 턴 = 경고 없이 빈 답). goal loop 가 넣는다. */
  terminalPriorAnswerVisible?: LLMOpts['terminalPriorAnswerVisible'];
  /** Optional model override (forwarded to `streamLLMWithTools`). */
  modelOverride?: string;
  /** TUI-400-AUTOHEAL-FALLBACK — 이 턴을 이 공급자부터 연다(`streamLLMWithTools` `initialProvider` · 폴백은 허용).
   *  주면 `modelOverride` 는 보내지 않는다(앞 공급자 모델 이름을 옮기지 않는다). */
  initialProvider?: LLMProvider;
  /** 이 턴 폴백 후보에서 뺄 공급자(`streamLLMWithTools` `skipProviders`). */
  skipProviders?: readonly string[];
}

export interface CoreTurnResult {
  stopReason: CoreTurnStopReason;
  finalText: string;
  /** `auth_rejected` 일 때만 — 공급자 오류 원문(비밀값 가림). 호스트가 처방 줄에 원문을 붙인다. */
  errorMessage?: string;
}
