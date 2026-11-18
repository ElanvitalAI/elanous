import type { LLMToolSpec } from '../llm/tool-spec.js';
// ── Session-aware chat helper ──
//
// Glue between the session store (Phase 4), the LLM provider resolver
// (Phase 2), and the token-budget trimmer (Phase 5). One function —
// runTurn — takes a user message, a session id, and a user-config,
// assembles the full conversation from the session JSONL, trims to
// fit the token budget, streams the LLM response, and persists both
// sides of the turn.
//
// This is the entry point the telegram daemon (Phase 6) and the
// non-TUI CLI subcommands (Phase 7) use. The existing dashboard chat
// path is untouched — wiring that in is follow-up work the user can
// approve separately (lots of UI surface; one bug = broken dashboard).

import { randomUUID } from 'node:crypto';
import {
  createSession, appendMessage, loadSession,
  type SessionMeta, type SerializedMessage, type CreateSessionOpts,
} from './index.js';
import { debug } from '../debug/log.js';
import { createRequestSizeGuard, formatRequestSizeStatus, type RequestSizeGuard } from './request-size-guard.js';
import type { InputSourceKind } from '../input/input-source-kind.js';
import { getProviderForConfigAsync, streamLLM, streamLLMWithTools, resolveDefaultOutputTokens, type LLMMessage, type LLMOpts, type LLMProvider, type ContentBlock } from '../llm.js';
import type { LLMProviderName, UserConfig } from '../user-config/types.js';
import {
  estimateMessagesTokens, estimateTokens, trimToBudget, budget, formatBudget,
  DEFAULT_TOKEN_BUDGET,
} from '../tokens.js';
import { buildMemoryInjection, buildMemoryInjectionLLM, recordMemoryTurnUsage } from '../memory.js';
import { getUserConfig } from '../user-config/reader.js';
import { budgetModel } from '../llm/model-defaults.js';
import { explicitTurnTier } from '../model-tier/turn-tier.js';
import { lookupLlmTierSpec } from '../model-tier/llm-tier-map.js';
import { isSimpleQuestionFastRoute } from '../model-tier/simple-question-fast-route.js';
import { recordTurn } from '../status/metrics.js';
import { createMeasuredTurnUsage, type MeasuredTurnUsage } from './turn-usage.js';
import { resolveTurnCompactTrigger, trimKeepingAnchorAndLatestTurn } from './long-session-compact.js';
import { compactSessionHistory } from './compact-session.js';
import { CHAT_DEFAULTS } from '../user-config/chat.js';
import type { CompactProvider } from '../compact/provider.js';
import {
  buildTerminalCapableTurn,
  isTerminalCapableTurn,
  PTY_BUDGET_GRANT,
} from '../agent/terminal-surface.js';

// ⭐ substrate 통합(PLAN-unified-autonomous-agent-substrate-2026-07-20) — goal-loop 아밍 시
// chat 툴루프를 canonical 엔진(runGoalLoop→runCoreTurn→streamLLMWithTools)으로 라우팅.
// ACP bridge(core-turn-bridge.ts)·dashboard(runGoalLoopHook)와 동일 엔진 재사용(재발명 제거).
import { runCoreTurn } from '../core-turn/run-core-turn.js';
import { drainPendingUserInput } from './pending-input.js';
import { runGoalLoop } from '../core-turn/run-goal-loop.js';
import { coreAdvisorForGoalLoop } from '../core-turn/core-advisor-wiring.js';
import { assertTurnNotSilentFailure } from './turn-silent-failure.js';
import type { CoreTurnCallbacks, CoreTurnContext, CoreTurnDispatchTool } from '../core-turn/types.js';
import { resolveSeatTurnCapForRole, seatRegistryRuntime } from '../core-turn/seat-turn-cap.js';
import { readSeatRuntime } from '../core-turn/seat-registry-runtime.js';
import { postSeatCapResumeNotice } from '../core-turn/seat-cap-resume-notice.js';
import { classifyTuiChatIntent } from '../core-turn/short-question.js';
import { composeChildContext, type ChildContextProfile } from '../self-implement/child-context-composition.js';
import { getHarnessSpace } from '../harness/harness-space.js';
import { isResearchAgentIntent } from '../tool-hints/signals.js';
import {
  buildSessionRuntimeTurnSystemMessages,
  createSessionPostureState,
  resolveSessionTurnProfileWithHistory,
} from '../session-runtime/index.js';

export interface RunTurnOpts {
  userConfig: UserConfig;
  sessionId: string;
  userText: string;
  /** Stable per-turn identity shared with surface MessageBlock raw references. */
  surfaceRunId?: string;
  /** System prompt applied only if the session has none. */
  systemPrompt?: string;
  /** Token budget (rough); defaults to DEFAULT_TOKEN_BUDGET. */
  maxTokens?: number;
  /** Summarizer for turn-start compaction (test seam for the external LLM). Default = getDefaultCompactProvider(). */
  compactProvider?: CompactProvider;
  /** Per-call LLM opts (model override, temperature, etc.). */
  llmOpts?: LLMOpts;
  /** Optional callback for each streamed text delta — telegram uses this to
   *  accumulate; CLI uses it to render live. */
  onDelta?: (delta: string) => void;
  /** Replace a provisional streamed answer after a grounded TUI synthesis completes. */
  onReplaceText?: (fullText: string) => void;
  /** Optional transient stream recovery status for the originating UI. */
  onStatusLine?: (line: string) => void;
  /** TUI-only narration callbacks; other surfaces can omit them. */
  onGoalInterim?: (text: string, iteration: number) => void;
  onReasoning?: (event: Parameters<NonNullable<CoreTurnCallbacks['onReasoning']>>[0]) => void;
  /** Optional provider override — for tests. */
  provider?: LLMProvider;
  /** Originating utterance surface. Omit only when the caller cannot
   *  identify its surface; emitted intent records then use `unknown`. */
  utteranceSurface?: import('../user-intent/types.js').UserIntentSurface;
  /** CHAT-TOOLS-ENTRY-VIA-CORE-TURN — run this tool turn through the single core turn (runCoreTurn: research
   *  route · grounding-first) instead of the direct tool loop. Set by `chat --tools` / `elanous agent`. A structural
   *  caller flag, not a sentence classifier (R-SIG). Ignored when the turn has no tools. */
  coreTurn?: boolean;
  /** Observation only (core-turn path): the research question-plan model call settled. */
  onResearchPlanSettled?: (info: { outcome: string; elapsedMs: number }) => void;
  /** MSG-SOURCE-HIERARCHY: who sent this turn's text (persisted on the user message; absent = human). */
  from?: import('./index.js').MessageSource;
  /** Multimodal image blocks to prepend before the user text (e.g.
   *  photos received via Telegram). When non-empty, the LLMMessage
   *  content is sent as ContentBlock[] instead of a plain string, and
   *  the session JSONL records a text summary ("[photo]") alongside
   *  the raw user text. Images stay out of JSONL — persisting base64
   *  per turn would bloat the transcript unmanageably. */
  userImages?: ContentBlock[];
  /** Step 2 of platform-evolution arc — channel-side normalized
   *  attachments (photos / voice / documents). Used by the
   *  daemon-bridge runTurnImpl path: the bridge folds them into the
   *  ACP PromptRequest's ContentBlock[] via buildAcpPrompt and
   *  forwards to the daemon, where vision/audio-capable models get
   *  the image data inline and others see placeholder text (D15
   *  fallback). The legacy in-process runTurn ignores this field —
   *  it consumes `userImages` instead and inlines voice/document
   *  summaries via the bot's `inlineText` path. */
  userAttachments?: import('../acp/content-blocks.js').NormalizedAttachment[];
  /** Disable the memory-injection step (tests, or when running a
   *  skill turn that already carries its own context). */
  skipMemoryInjection?: boolean;
  /** Memory injection token budget. Default 1500. */
  memoryBudgetTokens?: number;
  /** Tool catalog to expose for THIS turn. When provided + non-empty,
   *  runTurn routes through `streamLLMWithTools` (multi-turn loop
   *  with tool dispatch); otherwise the legacy `provider.streamChat`
   *  text-only path is used. Existing callers (telegram, discord,
   *  scheduler) leave this undefined and keep their text-only
   *  behavior — only the CLI agent path opts in. */
  tools?: LLMToolSpec[];
  /** Async dispatcher invoked when the LLM emits a tool_use block.
   *  Required when `tools` is non-empty. Returns a JSON-serializable
   *  result that gets fed back as the matching tool_result. Errors
   *  should be returned as `{error: '...'}` rather than thrown so
   *  the loop can continue. */
  dispatchTool?: CoreTurnDispatchTool;
  /** Optional notification when a tool_call is about to fire — CLI
   *  uses this to print the tool-name banner so the operator sees
   *  what the LLM is doing live. */
  onToolCall?: (call: { id: string; name: string; args: Record<string, unknown> }) => void;
  /** Optional notification when the resolved tool result lands —
   *  CLI uses this to print a short truncated preview. */
  onToolResult?: (call: { id: string; name: string; result: unknown }) => void;
  /** Surface-scoped HITL confirm channel bound to the triggering chat
   *  (Telegram sets this). `runTurn` itself ignores it — surface
   *  runTurnImpls (e.g. `makeTelegramAgentRunTurn`) read it to route a
   *  delegated coding agent's approval prompts back to the originating
   *  chat via `delegate_code_agent`. */
  hitlConfirmChannel?: import('../hitl/confirm.js').ConfirmChannel;
  /** Verified by the hosting bot from the inbound user id against its server-side owner allowlist. */
  verifiedOwner?: { id: string };
  /** Paired multi-option question channel (Telegram sets this). Surface
   *  runTurnImpls thread it into `delegate_code_agent` so a delegated
   *  agent's structured questions render as option buttons in the
   *  originating chat. */
  hitlQuestionChannel?: import('../hitl/question.js').QuestionChannel;
  /** P1.4 · surface file spill bound to the triggering chat (Telegram
   *  sets this). Surface runTurnImpls thread it into `delegate_code_agent`
   *  so a delegated agent's overflowing tool bodies (big diffs/stdout)
   *  spill as file attachments into the originating chat instead of being
   *  clipped at the aggregate cap. */
  hitlFileSink?: import('../channel/file-sink.js').FileSink;
  /** Surface-scoped mid-turn 진행 carrier — 트리거 챗에 바인딩(Telegram 이 message streamer 로 세팅).
   *  Surface runTurnImpls 가 무거운 자율툴(RunDevHarness)의 P→E→R→D 페이즈 진행을 이 챗의 edit-in-place
   *  카드로 흘린다(M-UX 능동 전달자·task#22 part2-A). `runTurn` 코어는 무시 — 서피스가 라우팅. */
  emitFeedback?: (env: import('../feedback/envelope.js').FeedbackEnvelope) => void;
  /** Per-turn abort signal (Telegram sets this from a `/cancel`-aware
   *  controller). Surface runTurnImpls forward it into
   *  `delegate_code_agent`'s ctx so an in-flight NL delegation can be
   *  cancelled (closes the ACP session) instead of leaking a wedged
   *  sub-process. `runTurn` itself ignores it. */
  signal?: AbortSignal;
  /** Triggering chat identity (Telegram sets this). Surface runTurnImpls use
   *  it to arm active delegation after a brain-initiated `delegate_code_agent`
   *  so plain NL follow-ups continue that ACP backend (A — NL delegate joins
   *  the continuous coding session instead of a fresh ephemeral one each
   *  time). `runTurn` itself ignores it. */
  tgChat?: { botId?: string; chatId: number; threadId?: number };
  /** M4b — discord channel identity, same role as `tgChat`: lets a
   *  brain-initiated `delegate_code_agent` arm active delegation so NL
   *  follow-ups continue that backend. `runTurn` itself ignores it. */
  dcChannel?: { channelId: string };
  /** Durable mission correlation for a turn executed by run-mission. Surface
   * adapters use it only when delegating through ACP; normal chat has none. */
  missionContext?: { missionId: string; phaseId: string; onOverload?: (info: { turn: number; consecutiveFailures: number; reason: string }) => void };
  /** ⭐ substrate 통합 — goal-loop 아밍(명시). true 면 tool-loop 을 `runGoalLoop` 으로
   *  감싸 목표 완료(GOAL-COMPLETE 증거게이트)까지 across-turn 반복 자기수정한다. config
   *  `llm.goalLoop.enabled` 로도 아밍(ACP bridge 와 동일 SSOT). `tools` 비어있으면 무효
   *  (goal-loop 은 tool-loop 위에서만 의미). 미아밍이면 기존 single-turn 경로 그대로. */
  goalLoop?: boolean;
  /** goal-loop 반복 상한 override. 생략 시 config `llm.goalLoop.maxIterations`. */
  goalLoopMaxIterations?: number;
}

export interface RunTurnResult {
  text: string;
  finishReason?: string;
  meta: SessionMeta;
  usedTokens: number;
  /** Provider-reported tokens for this invocation only; absent fields are unavailable. */
  measuredUsage?: MeasuredTurnUsage;
  droppedMessages: number;
  provider: string;
  model: string;
  /** IDs of memories that were injected into this turn's system
   *  prompt. Empty when the store is empty or the user text didn't
   *  match any entries. */
  memoryIds: string[];
  /** True only when the armed goal loop accepted completion evidence. */
  goalComplete?: boolean;
  /** Terminal reason from the armed goal loop, used by the TUI to explain a seat cap. */
  goalStopReason?: string;
}

export interface CreateRunTurnSessionOpts extends Partial<CreateSessionOpts> {
  sourceKind?: InputSourceKind;
}

/** Convert stored session messages → LLM wire messages. System and tool
 *  entries are passed through as text-only; multi-part content blocks
 *  stored in `toolResult` are collapsed into string form for simplicity. */
export function toLLM(messages: SerializedMessage[], systemPrompt?: string): LLMMessage[] {
  const out: LLMMessage[] = [];
  // OP-LONG-SESSION-COMPACT (D2) — the turn's system prompt is never dropped. A stored head row only
  // stands in for it when it IS that prompt (identical text, no duplicate). The old
  // `messages.some(role === 'system')` dropped the prompt as soon as the session compactor wrote its
  // summary row (a system row), i.e. right after the first compaction.
  const head = messages.find(m => m.role !== 'tool' && m.goalInterim !== true);
  const storedPrompt = head?.role === 'system' && head.content === systemPrompt;
  if (systemPrompt && !storedPrompt) out.push({ role: 'system', content: systemPrompt });
  for (const m of messages) {
    // 'tool' = durable tool-telemetry (추적성·audit-only). Excluded from replay
    // so persisted tool rounds don't pollute the next turn's conversation context.
    if (m.role === 'tool' || m.goalInterim === true) continue;
    const role: LLMMessage['role'] =
      m.role === 'user' ? 'user'
      : m.role === 'assistant' ? 'assistant'
      : m.role === 'system' ? 'system'
      : 'user';
    out.push({ role, content: m.content });
  }
  return out;
}

/** O4 prompt-cache prefix — insert this turn's volatile context as one `cacheVolatile` system
 *  message immediately BEFORE the current (last) user message. Exported for tests.
 *
 *  Trade-off: request N is [...history, V_n, U_n] and request N+1 is
 *  [...history, U_n, A_n, V_n+1, U_n+1]. Their common byte prefix ends right before V_n, so every
 *  turn but the last is cache-reusable, while the per-turn context stays next to the request it
 *  belongs to (the spec'd position). Putting V after U_n would extend the shared prefix by one user
 *  message but leave the volatile context as the final instruction-like message, after the request. */
export function withTurnVolatileContext(wire: LLMMessage[], blocks: readonly string[]): LLMMessage[] {
  const text = blocks.filter(block => block.trim().length > 0).join('\n\n');
  if (!text) return wire;
  const at = wire.length > 0 && wire[wire.length - 1]!.role === 'user' ? wire.length - 1 : wire.length;
  return [...wire.slice(0, at), { role: 'system', content: text, cacheVolatile: true }, ...wire.slice(at)];
}

/** Truncate any value to a bounded string for durable tool-telemetry storage —
 *  tool results (e.g. finance_kr_flow markdown) can be huge; cap to avoid session
 *  JSONL bloat. Pure. */
export function truncateForPersist(value: unknown, maxChars: number): string {
  let s: string;
  try { s = typeof value === 'string' ? value : JSON.stringify(value); }
  catch { s = String(value); }
  if (s.length <= maxChars) return s;
  return `${s.slice(0, maxChars)}… (+${s.length - maxChars} chars)`;
}

/** Build a durable `role:'tool'` telemetry message (추적성). Audit-only — excluded
 *  from conversation replay (toLLM) and from content search (session excludes tool
 *  role). Args/result truncated. So "어떤 도구 호출했나"가 confabulation 이 아닌
 *  실제 기록으로 남는다. */
export function buildToolTraceMessage(name: string, args: unknown, result: unknown): SerializedMessage {
  const resultStr = truncateForPersist(result, 2000);
  return {
    role: 'tool',
    content: `⚙️ ${name}`,
    ts: new Date().toISOString(),
    toolName: name,
    toolArgs: truncateForPersist(args, 1000),
    toolResult: resultStr,
    tokenEstimate: estimateTokens(resultStr),
  };
}

/** Cross-message reflection substrate. `role:'tool'` rows are excluded from
 *  replay (toLLM) to avoid dragging every historical tool round into context —
 *  but that means a FOLLOW-UP turn can't see what the PREVIOUS turn's tools
 *  returned (e.g. a build error the brain must now correct). This surfaces only
 *  the MOST RECENT turn's tool observations — the tool rows after the last
 *  `user` message in history — as one compact, hard-bounded digest. So
 *  "run build → see error (msg 1) → 고쳐줘 (msg 2)" keeps the terminal result
 *  in context. Pure. Returns null when there's nothing recent to surface.
 *
 *  Bounded on purpose (last turn only · few rows · truncated) so it can't
 *  reintroduce the pollution the exclusion was meant to prevent; trimToBudget
 *  runs after this as a second clamp. */
export function buildRecentToolObservations(
  messages: SerializedMessage[],
  opts: { maxRows?: number; perRowChars?: number; totalChars?: number } = {},
): string | null {
  const maxRows = opts.maxRows ?? 8;
  const perRowChars = opts.perRowChars ?? 600;
  const totalChars = opts.totalChars ?? 3000;

  // Tool rows belonging to the most recent turn = those after the last `user`.
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') { lastUserIdx = i; break; }
  }
  const tail = messages.slice(lastUserIdx + 1).filter(m => m.role === 'tool');
  if (tail.length === 0) return null;

  const asStr = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v));

  const rows: string[] = [];
  for (const m of tail.slice(-maxRows)) {
    const name = m.toolName ?? 'tool';
    // A short arg hint (command / file_path) if the persisted args carry one.
    let hint = '';
    const argsStr = asStr(m.toolArgs);
    if (argsStr) {
      try {
        const a = JSON.parse(argsStr) as Record<string, unknown>;
        const v = a.command ?? a.file_path ?? a.path ?? a.query ?? a.pattern;
        if (typeof v === 'string') hint = ` · ${v.slice(0, 120)}`;
      } catch { /* args weren't JSON — skip the hint */ }
    }
    const result = asStr(m.toolResult).replace(/\s+/g, ' ').trim().slice(0, perRowChars);
    rows.push(`⚙️ ${name}${hint} → ${result || '(no output)'}`);
  }
  if (rows.length === 0) return null;

  const body = rows.join('\n').slice(0, totalChars);
  return `[직전 턴에 네가 실행한 도구와 결과 (참고용 컨텍스트) — 이어서 교정·판단할 때 근거로 삼되, 사용자가 이 원문을 봤다고 가정하지 말 것]\n${body}`;
}

/** CHILD-CONTEXT-BUDGET — 세션별 첫 goal-loop 턴 계측 1회 플래그(모듈 인메모리 —
 * 원장·세션 저장소 형식은 무변경). 키: runTurn sessionId. */
const childContextComposedSessions = new Set<string>();

/**
 * TURN-FIELD-BUG-2 (OP #90723 · RES wake-miss 11-18): a TUI session resumed after a restart still carries its old person
 * inputs — and an interrupted turn («[사용자가 이 턴을 중단했습니다]») — at the end of the history; the new process's
 * first turn took them as unfinished orders and redid them (JUD-B «상태줄 261117_2055·dev 확인» on every restart · busy
 * seats ran the cut-off work for 3 min+ while new mail waited 180s). The first turn of a session in a process with prior
 * person input gets this boundary line.
 */
export const RESUME_BOUNDARY_BLOCK = [
  '## Resumed session boundary',
  'This session was resumed after a restart. Everything said above this point — earlier requests and any turn that was',
  'interrupted — is already finished or superseded: do not redo it or continue it on your own. Act on the current message;',
  'continue earlier work only if the current message asks for it.',
].join('\n');
const resumeBoundaryShownSessions = new Set<string>();

/** True once per session per process, and only when the loaded history already holds a person input. */
export function takeResumeBoundary(sessionId: string, priorUserTurns: number): boolean {
  if (resumeBoundaryShownSessions.has(sessionId)) return false;
  resumeBoundaryShownSessions.add(sessionId);
  return priorUserTurns > 0;
}

/** Run one conversational turn, persisting both sides to the session
 *  JSONL. Never throws on LLM failure — reraises with context. */
export async function runTurn(opts: RunTurnOpts): Promise<RunTurnResult> {
  const measuredUsage = createMeasuredTurnUsage();
  const onUsage = (usage: Parameters<NonNullable<LLMOpts['onUsage']>>[0]): void => {
    measuredUsage.accept(usage);
    try { opts.llmOpts?.onUsage?.(usage); } catch { /* observer cannot break a turn */ }
  };
  const loaded = loadSession(opts.sessionId);
  if (!loaded) throw new Error(`session not found: ${opts.sessionId}`);
  const { meta } = loaded;
  let messages = loaded.messages;
  const explicitTier = opts.llmOpts?.model ? undefined : explicitTurnTier(opts.userConfig, opts.sessionId);
  const priorUserTurns = messages.filter(message => message.role === 'user').length;
  const simpleQuestionFastRouteCandidate = meta.source === 'tui'
    && !opts.llmOpts?.model && !opts.llmOpts?.reasoningEffort && !explicitTier
    && isSimpleQuestionFastRoute({
      text: opts.userText,
      priorUserTurns,
      hasAttachments: (opts.userImages?.length ?? 0) > 0 || (opts.userAttachments?.length ?? 0) > 0,
    });
  const fastRouteProvider = simpleQuestionFastRouteCandidate
    ? opts.provider ?? await getProviderForConfigAsync(opts.userConfig)
    : undefined;
  const fastRouteTier = fastRouteProvider && fastRouteProvider.name !== 'auto'
    ? lookupLlmTierSpec(fastRouteProvider.name as LLMProviderName, 'budget')
    : undefined;
  const simpleQuestionFastRoute = fastRouteTier !== undefined;

  // Memory injection: build the block once per turn, folded into the
  // system prompt. Never fails loud — if the store isn't set up, we
  // just skip and continue.
  let memoryIds: string[] = [];
  let effectiveSystemPrompt = opts.systemPrompt;
  // ⭐ O4 prompt-cache prefix — per-turn context (memory recall · self-log recall with timestamps ·
  //   last turn's tool digest · per-utterance reconciliation) changes every turn. Folding it into the
  //   leading system prompt rewrote the very first message of every request, so no provider could
  //   reuse the cached prefix (system prompt + history). It now travels as ONE `cacheVolatile` system
  //   message placed right before the current user message (withTurnVolatileContext): everything
  //   before it is a byte prefix of the next turn's request.
  const turnVolatileBlocks: string[] = [];
  if (meta.source === 'tui' && takeResumeBoundary(opts.sessionId, priorUserTurns)) {
    turnVolatileBlocks.push(RESUME_BOUNDARY_BLOCK);
    try { debug.log('session', 'resume-boundary', { sessionId: opts.sessionId, priorUserTurns }); } catch { /* observability is fail-open */ }
  }
  // The Next TUI runs through this shared session adapter rather than the classic dashboard
  // preamble. Give research turns the same verified-reconciliation instruction on this path.
  if (meta.source === 'tui' && !effectiveSystemPrompt?.includes('## Proactive Reconciliation')) {
    const priorUserTexts = messages
      .filter(message => message.role === 'user' && typeof message.content === 'string')
      .map(message => String(message.content));
    const turnProfile = resolveSessionTurnProfileWithHistory({
      userText: opts.userText,
      priorUserTexts,
      chatModeState: createSessionPostureState(),
    });
    const reconciliation = buildSessionRuntimeTurnSystemMessages(turnProfile, opts.userText)
      .filter(message => String(message.content).includes('## Proactive Reconciliation'));
    if (reconciliation.length > 0) {
      turnVolatileBlocks.push(reconciliation.map(message => String(message.content)).join('\n\n'));
    }
  }
  if (!opts.skipMemoryInjection && !simpleQuestionFastRoute) {
    try {
      // LLM-judge recall(2026-07-19 · 기본 ON·대표 지시) — 키워드 대신 luna 의미판정으로 관련
      // 기억 선택(WSD). 끄려면 config llm.memoryJudge.enabled:false. judge 실패 시 내부 키워드
      // fallback(fail-soft)이라 항상 켜도 안전. low-context/후보없음이면 LLM 콜 안 함.
      const memCfg = getUserConfig().llm.memoryJudge;
      const budget = opts.memoryBudgetTokens ?? 1500;
      const inj = memCfg?.enabled !== false
        ? await buildMemoryInjectionLLM(opts.userText, { maxTokens: budget, model: memCfg?.model || budgetModel() })
        : buildMemoryInjection(opts.userText, { maxTokens: budget });
      // MEMORY-TRIAGE-NO-LLM ③ 생산자 — 주입 «시도»마다 한 줄(빈 주입 포함 · `no-activity` 와 «활동했는데 안 쓰임»을 가른다).
      // 실패는 원장이 사건 ⊕ 구멍 표식으로 남긴다.
      try { recordMemoryTurnUsage(opts.userText, inj); } catch { /* 원장 실패가 턴을 막지 않는다 */ }
      if (inj.block) {
        memoryIds = inj.injectedIds;
        debug.log('chat.memory-layer', 'injected', { session: opts.sessionId, ids: inj.injectedIds, tokens: inj.tokens });
        turnVolatileBlocks.push(inj.block);
      }
      // 크로스 회상(2026-07-19) — 파일메모리(①·큐레이션) 옆에 self-log(②·surface_events) 관련
      // top-K 를 같은 턴에 함께 주입(한 쿼리로 두 시스템). query-adaptive rerank(relevance 우선)·
      // bump:false(read-only·myelin 미오염)·소예산 3건·fail-soft. 끄려면 llm.memoryJudge.crossRecall:false.
      if (memCfg?.crossRecall !== false) {
        try {
          const { openSurfaceEventsDb, recallEvents } = await import('../domains/surface-events.js');
          const db = openSurfaceEventsDb();
          const evs = recallEvents(db, { query: opts.userText, limit: 3, bump: false });
          db.close();
          if (evs.length > 0) {
            const block = '## 최근 관련 활동 (self-log)\n\n' +
              evs.map(e => `- [${(e.ts || '').slice(0, 16)}·${e.surface}] ${(e.summary || e.text || '').replace(/\s+/g, ' ').slice(0, 160)}`).join('\n');
            turnVolatileBlocks.push(block);
          }
        } catch { /* self-log 크로스 회상 best-effort */ }
      }
    } catch { /* swallow — memory is a nice-to-have, not load-bearing */ }
  }

  // Cross-message reflection: surface the PREVIOUS turn's tool observations
  // (excluded from raw replay) so a follow-up message can correct on top of
  // what the last turn's tools returned. Bounded + fail-soft.
  try {
    const obs = buildRecentToolObservations(messages);
    if (obs) turnVolatileBlocks.push(obs);
  } catch { /* reflection digest is best-effort — never break the turn */ }

  // Cascade-zyu U1 — capture utterance intent at submission boundary.
  const utteranceSurface = opts.utteranceSurface ?? 'unknown';
  try {
    const { userIntentLogger } = await import('../user-intent/index.js');
    userIntentLogger().emit({
      surface: utteranceSurface,
      intent: {
        layer: 'utterance',
        kind: 'tui.utterance.chat_submit',
        value: opts.userText,
      },
      session_id: opts.sessionId,
    });
  } catch { /* logging must never break the chat path */ }

  // 1) Persist user message first so a crash mid-stream doesn't lose the prompt.
  const userTs = new Date().toISOString();
  const imagesCount = opts.userImages?.filter(b => b.type === 'image').length ?? 0;
  const recordedText = imagesCount > 0
    ? `[+${imagesCount} image${imagesCount > 1 ? 's' : ''}]\n${opts.userText}`
    : opts.userText;
  const userMsg: SerializedMessage = {
    role: 'user',
    content: recordedText,
    ts: userTs,
    tokenEstimate: estimateTokens(recordedText),
    ...(opts.from ? { from: opts.from } : {}),
  };
  appendMessage(opts.sessionId, userMsg);

  const provider = fastRouteProvider ?? opts.provider ?? await getProviderForConfigAsync(opts.userConfig, explicitTier?.model ?? opts.llmOpts?.model);
  const fastTier = simpleQuestionFastRoute ? fastRouteTier : undefined;
  const llmOpts = explicitTier ? {
    ...(opts.llmOpts ?? {}), model: explicitTier.model,
    ...(explicitTier.reasoningEffort && !opts.llmOpts?.reasoningEffort ? { reasoningEffort: explicitTier.reasoningEffort } : {}),
  } : fastTier ? {
    // Codex Responses rejects `minimal`; low is its least accepted effort.
    ...(opts.llmOpts ?? {}), model: fastTier.model, reasoningEffort: 'low' as const,
  } : opts.llmOpts;
  if (explicitTier) {
    debug.log('llm.tier', 'turn-tier-applied', {
      sessionId: opts.sessionId, tier: explicitTier.tier, source: explicitTier.source, model: explicitTier.model,
      reasoningEffort: llmOpts?.reasoningEffort ?? null,
    });
  }
  if (fastTier) {
    debug.log('llm.tier', 'simple-question-fast-route', {
      sessionId: opts.sessionId, model: fastTier.model, reasoningEffort: 'low', tools: 'omitted',
    }, { level: 'info' });
    effectiveSystemPrompt = 'Answer this stable factual question directly and briefly in the user’s language. If uncertain, say so; do not invent.';
    turnVolatileBlocks.length = 0;
  }
  const longAnswer = /설계|아키텍처|RFC|상세|자세히|보고서|design|architecture|detailed|comprehensive/i.test(opts.userText);
  const outputTokens = llmOpts?.maxTokens ?? resolveDefaultOutputTokens(llmOpts?.model ?? provider.defaultModel, llmOpts?.usageRole, longAnswer);
  let finishReason: string | undefined;

  // 2) Assemble, trim, call. When images are attached for THIS turn,
  //    swap the string content of the latest user message for
  //    ContentBlock[] so the provider adapter sends them multimodally.
  // The request as it is actually sent (per-turn volatile context and images attached), before any trim.
  const buildTurnWire = (systemPrompt?: string, history = messages): LLMMessage[] => {
    const wire = withTurnVolatileContext(toLLM([...history, userMsg], systemPrompt), turnVolatileBlocks);
    if (opts.userImages && opts.userImages.length > 0) {
      // The current user message is the last `user` row.
      const lastUser = wire.map(message => message.role).lastIndexOf('user');
      const last = wire[lastUser];
      if (last && last.role === 'user') {
        const blocks: ContentBlock[] = [
          ...opts.userImages,
          { type: 'text', text: opts.userText },
        ];
        wire[lastUser] = { role: 'user', content: blocks };
      }
    }
    return wire;
  };
  const turnInputCap = opts.maxTokens ?? DEFAULT_TOKEN_BUDGET;
  // ⭐ OP-LONG-SESSION-COMPACT (D1) — turn-start auto-compaction fires before the trim. The existing
  //   threshold is clamped to the input cap (long-session-compact.ts), and it is measured on the
  //   request as sent (images included). A caller with an explicit opts.maxTokens keeps its
  //   trim-only contract (no storage rewrite).
  const autoCompactCfg = opts.userConfig.chat?.autoCompact ?? CHAT_DEFAULTS.autoCompact;
  let compactedThisTurn = false;
  if (autoCompactCfg.enabled && opts.maxTokens === undefined) {
    const turnModelId = llmOpts?.model ?? provider.defaultModel;
    const trigger = resolveTurnCompactTrigger(turnModelId, autoCompactCfg, turnInputCap);
    const used = estimateMessagesTokens(buildTurnWire(effectiveSystemPrompt));
    if (trigger > 0 && used >= trigger) {
      try {
        const result = await compactSessionHistory(opts.sessionId, {
          config: autoCompactCfg,
          force: true,
          modelId: turnModelId,
          ...(opts.compactProvider ? { provider: opts.compactProvider } : {}),
        });
        debug.log('compact.session', 'turn-start', {
          sessionId: opts.sessionId, usedTokens: used, triggerTokens: trigger, fired: result.fired, reason: result.reason,
        }, { level: 'info' });
        if (result.fired) {
          compactedThisTurn = true;
          // The rewritten store holds this turn's user row (rows appended meanwhile may follow it).
          // Take that row out wherever it sits; the wire adds it back once, last.
          const stored = loadSession(opts.sessionId)?.messages ?? messages;
          let own = -1;
          for (let i = stored.length - 1; i >= 0 && own < 0; i--) {
            if (stored[i]!.role === 'user' && stored[i]!.content === userMsg.content) own = i;
          }
          messages = own >= 0 ? [...stored.slice(0, own), ...stored.slice(own + 1)] : stored;
        }
      } catch (error) {
        debug.log('compact.session', 'turn-start-error', {
          sessionId: opts.sessionId, error: error instanceof Error ? error.message : String(error),
        }, { level: 'warn' });
      }
    }
  }
  // After a compaction the request is measured again: if it is still over the cap the oldest rows go
  // first, but the system rows, the anchor and the latest user turn always stay; if even those do not
  // fit, the turn fails with ✗ before any provider call.
  const assembleTurnMessages = (systemPrompt?: string, history = messages): { kept: LLMMessage[]; dropped: number; used: number } => {
    const wire = buildTurnWire(systemPrompt, history);
    if (!compactedThisTurn) return trimToBudget(wire, turnInputCap);
    const trimmed = trimKeepingAnchorAndLatestTurn(wire, turnInputCap, estimateMessagesTokens);
    if (trimmed.overBudget) {
      debug.log('session.compact', 'over-budget', {
        sessionId: opts.sessionId, usedTokens: trimmed.used, capTokens: turnInputCap,
      }, { level: 'error' });
      const line = `✗ 문맥 예산 초과 — 압축 뒤에도 보존 항목만 ${trimmed.used.toLocaleString('en-US')} 토큰 > 상한 ${turnInputCap.toLocaleString('en-US')} · 이 턴을 멈춤`;
      opts.onStatusLine?.(line);
      throw new Error(line);
    }
    return trimmed;
  };

  const requestSizeGuard: RequestSizeGuard | undefined =
    meta.source === 'tui' && provider.name === 'openai-codex'
      ? createRequestSizeGuard({
          compactOptions: () => ({
            sessionId: opts.sessionId,
            activeModelId: llmOpts?.model ?? provider.defaultModel,
            preserveLastN: opts.userConfig.chat.autoCompact.preserveLastN,
            archiveEnabled: opts.userConfig.chat.compact.archiveEnabled,
          }),
          // The first request has only the persisted transcript plus this
          // user turn, so use the shared session compactor and rebuild from
          // the rewritten history. Later tool rounds compact their live
          // message list (shared guard) so no just-produced tool context is lost.
          compactFirstRequest: async (currentMessages) => {
            const { compactSessionHistory } = await import('./compact-session.js');
            const result = await compactSessionHistory(opts.sessionId, {
              config: opts.userConfig.chat.autoCompact,
              force: true,
              prepareOnly: true,
              modelId: llmOpts?.model ?? provider.defaultModel,
            });
            if (!result.fired || !result.preparedMessages || !result.commit) return null;
            // The prepared session includes this turn's user message. Re-add
            // the canonical message and images while constructing the candidate.
            const preparedHistory = result.preparedMessages.slice(0, -1);
            const rebuilt = assembleTurnMessages(effectiveSystemPrompt, preparedHistory).kept;
            const originalSystems = currentMessages.filter(message => message.role === 'system');
            const missingSystems = originalSystems.filter(message => !rebuilt.some(candidate => JSON.stringify(candidate) === JSON.stringify(message)));
            rebuilt.unshift(...missingSystems);
            return {
              messages: rebuilt,
              reason: `session-${result.reason}`,
              commit: () => { result.commit!(); messages = preparedHistory; },
            };
          },
          onMeasured: (measurement) => {
            opts.onStatusLine?.(formatRequestSizeStatus(measurement));
          },
        })
      : undefined;

  let kept: LLMMessage[] = [];
  let dropped = 0;
  let used = 0;
  const turnStartedAt = Date.now();
  let text = '';
  let goalComplete = false;
  let goalStopReason: string | undefined;
  let turnFailed = false;
  // OPENROUTER-CLAUDE(11-17) — 조용한 실패 판정 재료(턴 끝 assertTurnNotSilentFailure).
  let toolCallsSeen = 0;
  let turnStopReason: string | undefined;
  let turnErrorMessage: string | undefined;
  // Branch — tool-loop path when caller supplies a non-empty tool
  // catalog (CLI agent surface), legacy text-only stream otherwise
  // (telegram, discord, scheduler, etc — all unchanged).
  if (!simpleQuestionFastRoute && opts.tools && opts.tools.length > 0) {
    if (!opts.dispatchTool) {
      throw new Error('runTurn: tools provided without dispatchTool');
    }
    const rawDispatchTool = opts.dispatchTool;
    const hasPtyShellTool = opts.tools.some((tool) => PTY_BUDGET_GRANT.tools.includes(tool.name));
    const terminalBase = {
      specs: opts.tools,
      dispatch: rawDispatchTool,
      systemPromptParts: effectiveSystemPrompt ? [effectiveSystemPrompt] : [],
      ...(llmOpts ? { llmOpts } : {}),
    };
    const terminal = hasPtyShellTool
      ? isTerminalCapableTurn(terminalBase)
        ? terminalBase
        : buildTerminalCapableTurn({
            ...terminalBase,
            ...(opts.signal ? { signal: opts.signal } : {}),
          })
      : null;
    const turnTools = terminal ? terminal.specs : opts.tools;
    const dispatchTool = terminal ? terminal.dispatch : rawDispatchTool;
    if (terminal) {
      effectiveSystemPrompt = terminal.systemPromptParts.join('\n\n');
    }
    const turnLlmOpts = terminal ? terminal.llmOpts : llmOpts;
    const guardedTurnLlmOpts = requestSizeGuard
      ? { ...(turnLlmOpts ?? {}), requestSizeGuard: turnLlmOpts?.requestSizeGuard ?? requestSizeGuard }
      : turnLlmOpts;
    ({ kept, dropped, used } = assembleTurnMessages(effectiveSystemPrompt));
    // Durable tool telemetry (추적성) — pair each call's args (onToolCall) with its
    // result (onToolResult) and persist a role:'tool' message so later "어떤 도구
    // 호출했나" queries get the REAL trace, not a confabulated one. Audit-only
    // (toLLM excludes it from replay). Persistence is fail-soft — never break the turn.
    const toolCallArgs = new Map<string, unknown>();
    // ⭐ substrate 통합 — goal-loop 아밍 시 canonical 엔진(runGoalLoop→runCoreTurn→
    // streamLLMWithTools)으로 라우팅. 미아밍이면 아래 기존 single-turn 경로 그대로(회귀 0).
    const goalLoopCfg = opts.userConfig.llm.goalLoop;
    const cwdSeat = /(?:^|\/)seats\/([A-Za-z][A-Za-z0-9_-]{0,63})(?:\/|$)/u.exec(process.cwd())?.[1];
    const envSeat = process.env.COORD_ID?.trim();
    const seat = opts.utteranceSurface === 'tui' ? (cwdSeat ?? envSeat)?.toUpperCase() : undefined;
    const tuiIntent = opts.utteranceSurface === 'tui'
      ? classifyTuiChatIntent(opts.userText, { seat: seat !== undefined })
      : undefined;
    const armGoalLoop = opts.goalLoop === true || goalLoopCfg?.enabled === true || tuiIntent?.goalLoop === true;
    const armResearchTurn = turnTools.length > 0 && (opts.coreTurn === true
      || ((opts.utteranceSurface === 'tui' || opts.utteranceSurface === 'ask') && isResearchAgentIntent(opts.userText)));
    if (armGoalLoop || armResearchTurn) {
      // ⭐ CHILD-CONTEXT-BUDGET(0.2.35 칸) — 구현 자식(self-implement 공간)의 첫 goal-loop
      //    턴에서 실제 effectiveSystemPrompt·turnTools 스키마·userText(골)의 구성 바이트를
      //    composeChildContext 로 계측해 child.context-composition 사건 1회로 남긴다.
      //    관측 전용 — 프롬프트·메시지는 무변경, 계측이 턴을 깨지 않는다(fail-open).
      //    게이트: harness-space SSOT 로 구현 자식만 판별(getHarnessSpace().kind === 'self-implement')·
      //    세션 첫 goal-loop 무장 턴 1회(모듈 인메모리 플래그 — 원장·세션 저장소는 무변경).
      //    profile 은 자식 프롬프트 예산 신호(ELANOUS_PROMPT_BUDGET=lean — local 자식 스폰 시 주입)에서
      //    실측 파생한다: lean → small(32k 바이트 상한), 아니면 default(무상한).
      const isSelfImplementChild = getHarnessSpace()?.kind === 'self-implement';
      if (isSelfImplementChild && !childContextComposedSessions.has(opts.sessionId)) {
        childContextComposedSessions.add(opts.sessionId);
        const childContextProfile: ChildContextProfile
          = process.env.ELANOUS_PROMPT_BUDGET?.trim() === 'lean' ? 'small' : 'default';
        try {
          composeChildContext({
            systemPrompt: effectiveSystemPrompt,
            toolSchemas: JSON.stringify(turnTools),
            goal: opts.userText,
          }, { profile: childContextProfile });
        } catch { /* 계측은 턴을 깨지 않는다 */ }
      }
      const coreCtx: CoreTurnContext = {
        sessionId: opts.sessionId,
        ...(armResearchTurn ? { runId: randomUUID() } : {}),
        // ⭐ 이 턴의 «사람 문장» 운반자. 없으면 표면 판정이 늘 기본값으로 떨어진다
        //   (골 루프가 라운드 사이에 기계 문장을 밀어 넣기 때문 — run-goal-loop.ts 진입 주석).
        userText: opts.userText,
        messages: kept,
        tools: turnTools,
        ...(guardedTurnLlmOpts?.requestSizeGuard
          ? { requestSizeGuard: guardedTurnLlmOpts.requestSizeGuard } : {}),
        dispatchTool: async (name, args, ctx) => dispatchTool(name, args, ctx),
        signal: opts.signal ?? new AbortController().signal,
        callbacks: {
          onText: (delta) => { opts.onDelta?.(delta); },
          onReplaceText: (fullText) => { opts.onReplaceText?.(fullText); },
          onGoalInterim: (interimText, iteration) => {
            opts.onGoalInterim?.(interimText, iteration);
            appendMessage(opts.sessionId, {
              role: 'assistant', content: interimText, ts: new Date().toISOString(),
              tokenEstimate: estimateTokens(interimText), goalInterim: true,
            });
          },
          onToolCall: (call) => { toolCallsSeen += 1; toolCallArgs.set(call.id, call.args); opts.onToolCall?.(call); },
          onToolResult: (call) => {
            try {
              appendMessage(opts.sessionId, { ...buildToolTraceMessage(call.name, toolCallArgs.get(call.id), call.result), toolCallId: call.id,
                ...(opts.surfaceRunId ? { surfaceRunId: opts.surfaceRunId } : {}) });
            } catch { /* telemetry persistence must not break the turn */ }
            opts.onToolResult?.(call);
          },
          onReasoning: (event) => { opts.onReasoning?.(event); },
          ...(opts.onResearchPlanSettled ? { onResearchPlanSettled: opts.onResearchPlanSettled } : {}),
          // CHAT-TOOLS-ENTRY-VIA-CORE-TURN field parity (JUD-B TUI clause): the direct loop showed stream retry and
          // grounding status lines (Next TUI status events · message-block status); keep them on a coreTurn turn.
          ...(opts.coreTurn === true && opts.onStatusLine ? { onStatus: (line: string) => { opts.onStatusLine?.(line); } } : {}),
          onUsage,
        },
        // CHAT-TOOLS-ENTRY-VIA-CORE-TURN field parity: the direct loop ran on the provider this turn resolved from
        // opts.userConfig (a Next TUI session provider choice is a per-turn config, not the global one). Pin it as the
        // core turn's first provider; a tier model override keeps the existing modelOverride route (types.ts: the two
        // are exclusive so a provider never receives another provider's model name).
        ...(opts.coreTurn === true && !turnLlmOpts?.model ? { initialProvider: provider } : {}),
        ...(opts.coreTurn === true && turnLlmOpts?.streamIdleTimeoutMs !== undefined
          ? { streamIdleTimeoutMs: turnLlmOpts.streamIdleTimeoutMs } : {}),
        ...(turnLlmOpts?.model ? { modelOverride: turnLlmOpts.model } : {}),
        ...(turnLlmOpts?.reasoningEffort ? { reasoningEffort: turnLlmOpts.reasoningEffort } : {}),
        ...(turnLlmOpts?.budgetGrant ? { budgetGrant: turnLlmOpts.budgetGrant } : {}),
        ...(guardedTurnLlmOpts?.requestSizeGuard
          ? { requestSizeGuard: guardedTurnLlmOpts.requestSizeGuard } : {}),
      };
      const maxIterations = opts.goalLoopMaxIterations ?? goalLoopCfg?.maxIterations;
      if (armGoalLoop) {
        const cwdSeat = /(?:^|\/)seats\/([A-Za-z][A-Za-z0-9_-]{0,63})(?:\/|$)/u.exec(process.cwd())?.[1];
        const envSeat = process.env.COORD_ID?.trim();
        const seat = opts.utteranceSurface === 'tui' ? (cwdSeat ?? envSeat)?.toUpperCase() : undefined;
        const seatRuntime = seat ? seatRegistryRuntime(seat, readSeatRuntime) : undefined;
        const seatTurnCap = seat
          ? { ...resolveSeatTurnCapForRole(seatRuntime, opts.userConfig.chat.seatTurnCap), seat }
          : undefined;
        // HARNESS-ADVISOR-CHECKPOINTS — 하니스 런에서만 코어 ADVISOR(그림자 기본).
        const advisor = coreAdvisorForGoalLoop({ userText: coreCtx.userText ?? '', signal: coreCtx.signal });
        const gl = await runGoalLoop(coreCtx, {
          ...(maxIterations !== undefined ? { maxIterations } : {}),
          ...(advisor ? { advisor } : {}),
          ...(seatTurnCap ? { seatTurnCap } : {}),
          // SEAT-CAP-RESUME-NOTICE(연속 큐 미재개) — 상한 소진 마감 직전 자리 우편함에 재개 안내 1통.
          ...(seatTurnCap ? { onSeatCapExhausted: postSeatCapResumeNotice() } : {}),
        });
        text = gl.finalText;
        goalComplete = gl.goalComplete;
        goalStopReason = gl.stopReason;
        turnFailed = gl.stopReason === 'aborted' || gl.stopReason === 'error' || gl.stopReason === 'auth_rejected';
        turnStopReason = gl.stopReason;
        turnErrorMessage = gl.errorMessage;
      } else {
        const coreResult = await runCoreTurn(coreCtx);
        text = coreResult.finalText;
        // CHAT-TOOLS-ENTRY-VIA-CORE-TURN (OP REVIEW-1 #38246): the direct loop reported the provider's finish reason
        // (`length` → CLI `incomplete` · exit 1 · JSON finishReason); the core turn returns it as providerFinishReason.
        if (coreResult.providerFinishReason) {
          finishReason = coreResult.providerFinishReason;
          llmOpts?.onFinishReason?.(coreResult.providerFinishReason);
        }
        turnFailed = coreResult.stopReason === 'aborted' || coreResult.stopReason === 'error' || coreResult.stopReason === 'auth_rejected';
        turnStopReason = coreResult.stopReason;
        turnErrorMessage = coreResult.errorMessage;
        if (coreResult.stopReason === 'auth_rejected') throw new Error(coreResult.errorMessage ?? 'Authentication was rejected');
      }
    } else {
    text = await streamLLMWithTools(
      kept,
      {
        onText: (delta /*, full */) => {
          opts.onDelta?.(delta);
        },
        onStatus: (line) => { opts.onStatusLine?.(line); },
        onReasoning: (event) => { opts.onReasoning?.(event); },
        dispatchTool: async (name, args, ctx) => dispatchTool(name, args, ctx),
        onToolCall: (call) => { toolCallsSeen += 1; toolCallArgs.set(call.id, call.args); opts.onToolCall?.(call); },
        onToolResult: (call) => {
          try {
            appendMessage(opts.sessionId, { ...buildToolTraceMessage(call.name, toolCallArgs.get(call.id), call.result), toolCallId: call.id,
              ...(opts.surfaceRunId ? { surfaceRunId: opts.surfaceRunId } : {}) });
          } catch { /* telemetry persistence must not break the turn */ }
          opts.onToolResult?.(call);
        },
        onUsage,
      },
      {
        ...(guardedTurnLlmOpts ?? {}),
        maxTokens: guardedTurnLlmOpts?.maxTokens ?? outputTokens,
        // Source of the cap, not its value: a role default may continue once on length; a caller cap may not (#36714).
        maxTokensExplicit: guardedTurnLlmOpts?.maxTokensExplicit ?? guardedTurnLlmOpts?.maxTokens !== undefined,
        longAnswer,
        onFinishReason: (reason: string) => { finishReason = reason; llmOpts?.onFinishReason?.(reason); },
        tools: turnTools,
        provider,
        // The handler above is the sole observer. The fallback path invokes
        // both opts.onUsage and handlers.onUsage when both are present.
        onUsage: undefined,
        // ★ /cancel 범용화(대표 2026-07-12) — per-turn abort signal 을 tool 루프·llm 호출에 전파.
        //   이게 없으면 /cancel(turnAborters.abort)이 진행 중 tool 반복(grep 폭주 등)을 못 멈춘다.
        ...(opts.signal ? { signal: opts.signal } : {}),
        // ★ C1(문맥관리 트랙) — 미션 walker 압축 관측(mission.walker.compact)에 미션 좌표를 실어줌.
        //   missionContext 있을 때만(미션 페이즈 실행) threading — 일반 채팅은 무영향.
        ...(opts.missionContext ? { missionContext: opts.missionContext } : {}),
        // A200 ELN-MIDTURN-STEER — the plain tool turn drains this session's pending input right before
        // the next model request, the same boundary `runCoreTurn` wires (run-core-turn.ts). Without it a
        // steer typed during a Next TUI tool turn sat in the registry until the turn ended and left again
        // as a separate turn.
        drainPendingUserInput: guardedTurnLlmOpts?.drainPendingUserInput ?? (() => drainPendingUserInput(opts.sessionId)),
        // O4 — session-derived cache affinity (codex prompt_cache_key · OpenRouter sticky routing) and
        // the llm.usage row's session join. The core-turn path already threads ctx.sessionId.
        sessionId: guardedTurnLlmOpts?.sessionId ?? opts.sessionId,
      },
    );
    }
  } else {
    ({ kept, dropped, used } = assembleTurnMessages(effectiveSystemPrompt));
    const plainOpts = {
      ...(llmOpts ?? {}),
      maxTokens: outputTokens,
      maxTokensExplicit: llmOpts?.maxTokensExplicit ?? llmOpts?.maxTokens !== undefined,
      longAnswer,
      onFinishReason: (reason: string) => { finishReason = reason; llmOpts?.onFinishReason?.(reason); },
      ...(requestSizeGuard ? { requestSizeGuard: llmOpts?.requestSizeGuard ?? requestSizeGuard } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      onUsage,
      sessionId: llmOpts?.sessionId ?? opts.sessionId,
    };
    text = await streamLLM(kept, (delta) => { opts.onDelta?.(delta); }, { ...plainOpts, provider, preferExplicitProvider: true });
  }
  // OPENROUTER-CLAUDE(대표 11-17 · P0) — 공급자 실패·빈 응답을 «완료»로 넘기지 않는다(화면 ✗ ⊕ turn.* 사건).
  //   🩸 골 루프 갈래는 auth_rejected 를 turnFailed 로만 접어 1초 빈 «Turn done» 을 냈다.
  assertTurnNotSilentFailure({
    sessionId: opts.sessionId,
    provider: provider.name,
    model: llmOpts?.model ?? provider.defaultModel,
    text,
    toolCalls: toolCallsSeen,
    aborted: opts.signal?.aborted === true,
    ...(turnStopReason !== undefined ? { stopReason: turnStopReason } : {}),
    ...(turnErrorMessage !== undefined ? { errorMessage: turnErrorMessage } : {}),
  });
  const turnSeconds = (Date.now() - turnStartedAt) / 1000;

  // 3) Persist assistant response.
  const asstTs = new Date().toISOString();
  const asstMsg: SerializedMessage = {
    role: 'assistant',
    content: text,
    ts: asstTs,
    tokenEstimate: estimateTokens(text),
    replyFinal: opts.signal?.aborted !== true && !turnFailed,
  };
  const updatedMeta = appendMessage(opts.sessionId, asstMsg);

  // ⭐⭐⭐ `A3`ⓑ(2026-08-19 · 대표 관측) — 중단된 턴에는 «표식»을 남긴다.
  //   📏 실측: ***부분 출력은 이미 위에서 보존된다*** — 빠져 있던 것은 이 한 줄뿐이었다.
  //   ⭐ ref claude-code 의 이력 순서 `[user, partial-assistant, [Request interrupted by user]]`
  //     와 «같은 모양»이 된다. ⇒ 🔑 반복 인터럽트는 이 삼중항이 «쌓이는» 것이고,
  //     그래서 다음 발화 때 모델이 「어디까지 했고 몇 번 멈췄는지」를 «스스로» 종합한다(`A4`).
  //     ⛔ 종합기를 따로 만들지 않는다 — 대표 이 관측한 동작이 정확히 이 구조에서 나온다.
  if (opts.signal?.aborted) {
    try {
      const { buildTurnInterruptedMarker } = require('../chat/interjection.js') as typeof import('../chat/interjection.js');
      const marker = buildTurnInterruptedMarker();
      appendMessage(opts.sessionId, {
        role: 'user',
        content: marker,
        ts: new Date().toISOString(),
        tokenEstimate: estimateTokens(marker),
      });
      debug.log('llm.interjection', 'turn-interrupted-marker', {
        sessionId: opts.sessionId, partialChars: text.length,
      }, { level: 'info' });
    } catch { /* 표식 실패가 턴 마무리를 막지 않는다 */ }
  }

  // Record turn into the session metrics singleton so the bottom
  // status bar (CTX bar · $ · 🚀) reflects the latest numbers. Uses
  // rough estimates — providers that expose real `usage` fields can
  // override via opts.llmOpts in a later phase.
  const resolvedModel = llmOpts?.model ?? provider.defaultModel;
  recordTurn({
    model: resolvedModel,
    estimatedPromptText: [...messages, userMsg].map(m =>
      typeof m.content === 'string' ? m.content : '').join('\n'),
    estimatedOutputText: text,
    seconds: turnSeconds,
  });

  const reportedUsage = opts.signal?.aborted || turnFailed ? undefined : measuredUsage.snapshot();
  return {
    text,
    ...(finishReason ? { finishReason } : {}),
    meta: updatedMeta,
    usedTokens: used,
    ...(reportedUsage ? { measuredUsage: reportedUsage } : {}),
    droppedMessages: dropped,
    provider: provider.name,
    model: resolvedModel,
    memoryIds,
    ...(goalComplete ? { goalComplete: true } : {}),
    ...(goalStopReason ? { goalStopReason } : {}),
  };
}

// ── Higher-level helpers ─────────────────────────────────────────────

/** Get or create a cli session. Uses userConfig.llm provider/model as
 *  the stored metadata (not enforcement — each turn can override). */
export function ensureCliSession(
  userConfig: UserConfig,
  existingId?: string,
  opts: Partial<CreateSessionOpts> = {},
): SessionMeta {
  if (existingId) {
    const loaded = loadSession(existingId);
    if (loaded) return loaded.meta;
  }
  return createSession({
    source: 'cli',
    provider: userConfig.llm.provider,
    model: userConfig.llm.model ?? '',
    ...opts,
  });
}

/** Narrow helper for one-shot `runTurn()` callers that should mint a
 *  fresh session every time (scheduler, verifier, workflow step, etc).
 *  Keeps the provider/model defaults consistent while letting the
 *  caller tag a canonical sourceKind. */
export function createRunTurnSession(
  userConfig: UserConfig,
  opts: CreateRunTurnSessionOpts = {},
): SessionMeta {
  return createSession({
    source: opts.source ?? 'cli',
    sourceKind: opts.sourceKind ?? 'keyboard',
    provider: opts.provider ?? userConfig.llm.provider,
    model: opts.model ?? userConfig.llm.model ?? '',
    ...(opts.title !== undefined ? { title: opts.title } : {}),
    ...(opts.forkedFromId !== undefined ? { forkedFromId: opts.forkedFromId } : {}),
    ...(opts.tgChatId !== undefined ? { tgChatId: opts.tgChatId } : {}),
    ...(opts.tgThreadId !== undefined ? { tgThreadId: opts.tgThreadId } : {}),
  });
}

/** Summarize a session's token usage for a HUD line. */
export function sessionBudget(
  sessionId: string,
  max: number = DEFAULT_TOKEN_BUDGET,
): string {
  const loaded = loadSession(sessionId);
  if (!loaded) return '';
  const used = estimateMessagesTokens(
    loaded.messages.map(m => ({ role: m.role, content: m.content })),
  );
  return formatBudget(budget(used, max));
}
