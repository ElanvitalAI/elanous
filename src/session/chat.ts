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

import {
  createSession, appendMessage, loadSession,
  type SessionMeta, type SerializedMessage, type CreateSessionOpts,
} from './index.js';
import { debug } from '../debug/log.js';
import type { InputSourceKind } from '../input/input-source-kind.js';
import {
  getProviderForConfig, streamLLMWithTools, type LLMMessage, type LLMOpts, type LLMProvider,
  type LLMToolSpec, type ContentBlock,
} from '../llm.js';
import type { UserConfig } from '../user-config.js';
import {
  estimateMessagesTokens, estimateTokens, trimToBudget, budget, formatBudget,
  DEFAULT_TOKEN_BUDGET,
} from '../tokens.js';
import { buildMemoryInjection, buildMemoryInjectionLLM } from '../memory.js';
import { getUserConfig } from '../user-config.js';
import { budgetModel } from '../llm/model-defaults.js';
import { explicitTurnTier } from '../model-tier/turn-tier.js';
import { recordTurn } from '../status/metrics.js';
import {
  buildTerminalCapableTurn,
  isTerminalCapableTurn,
  PTY_BUDGET_GRANT,
} from '../agent/terminal-surface.js';

// ⭐ substrate 통합(PLAN-unified-autonomous-agent-substrate-2026-07-20) — goal-loop 아밍 시
// chat 툴루프를 canonical 엔진(runGoalLoop→runCoreTurn→streamLLMWithTools)으로 라우팅.
// ACP bridge(core-turn-bridge.ts)·dashboard(runGoalLoopHook)와 동일 엔진 재사용(재발명 제거).
import { runGoalLoop, type CoreTurnContext, type CoreTurnDispatchTool } from '../core-turn/index.js';

export interface RunTurnOpts {
  userConfig: UserConfig;
  sessionId: string;
  userText: string;
  /** System prompt applied only if the session has none. */
  systemPrompt?: string;
  /** Token budget (rough); defaults to DEFAULT_TOKEN_BUDGET. */
  maxTokens?: number;
  /** Per-call LLM opts (model override, temperature, etc.). */
  llmOpts?: LLMOpts;
  /** Optional callback for each streamed text delta — telegram uses this to
   *  accumulate; CLI uses it to render live. */
  onDelta?: (delta: string) => void;
  /** Optional provider override — for tests. */
  provider?: LLMProvider;
  /** Originating utterance surface. Omit only when the caller cannot
   *  identify its surface; emitted intent records then use `unknown`. */
  utteranceSurface?: import('../user-intent/types.js').UserIntentSurface;
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
  meta: SessionMeta;
  usedTokens: number;
  droppedMessages: number;
  provider: string;
  model: string;
  /** IDs of memories that were injected into this turn's system
   *  prompt. Empty when the store is empty or the user text didn't
   *  match any entries. */
  memoryIds: string[];
}

export interface CreateRunTurnSessionOpts extends Partial<CreateSessionOpts> {
  sourceKind?: InputSourceKind;
}

/** Convert stored session messages → LLM wire messages. System and tool
 *  entries are passed through as text-only; multi-part content blocks
 *  stored in `toolResult` are collapsed into string form for simplicity. */
function toLLM(messages: SerializedMessage[], systemPrompt?: string): LLMMessage[] {
  const out: LLMMessage[] = [];
  const hasSystem = messages.some(m => m.role === 'system');
  if (systemPrompt && !hasSystem) out.push({ role: 'system', content: systemPrompt });
  for (const m of messages) {
    // 'tool' = durable tool-telemetry (추적성·audit-only). Excluded from replay
    // so persisted tool rounds don't pollute the next turn's conversation context.
    if (m.role === 'tool') continue;
    const role: LLMMessage['role'] =
      m.role === 'user' ? 'user'
      : m.role === 'assistant' ? 'assistant'
      : m.role === 'system' ? 'system'
      : 'user';
    out.push({ role, content: m.content });
  }
  return out;
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

/** Run one conversational turn, persisting both sides to the session
 *  JSONL. Never throws on LLM failure — reraises with context. */
export async function runTurn(opts: RunTurnOpts): Promise<RunTurnResult> {
  const loaded = loadSession(opts.sessionId);
  if (!loaded) throw new Error(`session not found: ${opts.sessionId}`);
  const { meta, messages } = loaded;

  // Memory injection: build the block once per turn, folded into the
  // system prompt. Never fails loud — if the store isn't set up, we
  // just skip and continue.
  let memoryIds: string[] = [];
  let effectiveSystemPrompt = opts.systemPrompt;
  if (!opts.skipMemoryInjection) {
    try {
      // LLM-judge recall(2026-07-19 · 기본 ON·대표 지시) — 키워드 대신 luna 의미판정으로 관련
      // 기억 선택(WSD). 끄려면 config llm.memoryJudge.enabled:false. judge 실패 시 내부 키워드
      // fallback(fail-soft)이라 항상 켜도 안전. low-context/후보없음이면 LLM 콜 안 함.
      const memCfg = getUserConfig().llm.memoryJudge;
      const budget = opts.memoryBudgetTokens ?? 1500;
      const inj = memCfg?.enabled !== false
        ? await buildMemoryInjectionLLM(opts.userText, { maxTokens: budget, model: memCfg?.model || budgetModel() })
        : buildMemoryInjection(opts.userText, { maxTokens: budget });
      if (inj.block) {
        memoryIds = inj.injectedIds;
        effectiveSystemPrompt = effectiveSystemPrompt
          ? `${effectiveSystemPrompt}\n\n${inj.block}`
          : inj.block;
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
            effectiveSystemPrompt = effectiveSystemPrompt ? `${effectiveSystemPrompt}\n\n${block}` : block;
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
    if (obs) {
      effectiveSystemPrompt = effectiveSystemPrompt
        ? `${effectiveSystemPrompt}\n\n${obs}`
        : obs;
    }
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
  };
  appendMessage(opts.sessionId, userMsg);

  // 2) Assemble, trim, call. When images are attached for THIS turn,
  //    swap the string content of the latest user message for
  //    ContentBlock[] so the provider adapter sends them multimodally.
  const assembleTurnMessages = (systemPrompt?: string): { kept: LLMMessage[]; dropped: number; used: number } => {
    const wire = toLLM([...messages, userMsg], systemPrompt);
    if (opts.userImages && opts.userImages.length > 0) {
      const last = wire[wire.length - 1];
      if (last && last.role === 'user') {
        const blocks: ContentBlock[] = [
          ...opts.userImages,
          { type: 'text', text: opts.userText },
        ];
        wire[wire.length - 1] = { role: 'user', content: blocks };
      }
    }
    return trimToBudget(wire, opts.maxTokens ?? DEFAULT_TOKEN_BUDGET);
  };

  const explicitTier = opts.llmOpts?.model ? undefined : explicitTurnTier(opts.userConfig, opts.sessionId);
  const llmOpts = explicitTier ? {
    ...(opts.llmOpts ?? {}), model: explicitTier.model,
    ...(explicitTier.reasoningEffort && !opts.llmOpts?.reasoningEffort ? { reasoningEffort: explicitTier.reasoningEffort } : {}),
  } : opts.llmOpts;
  if (explicitTier) {
    debug.log('llm.tier', 'turn-tier-applied', {
      sessionId: opts.sessionId, tier: explicitTier.tier, source: explicitTier.source, model: explicitTier.model,
      reasoningEffort: llmOpts?.reasoningEffort ?? null,
    });
  }
  const provider = opts.provider ?? getProviderForConfig(opts.userConfig, llmOpts?.model);
  let kept: LLMMessage[] = [];
  let dropped = 0;
  let used = 0;
  const turnStartedAt = Date.now();
  let text = '';
  // Branch — tool-loop path when caller supplies a non-empty tool
  // catalog (CLI agent surface), legacy text-only stream otherwise
  // (telegram, discord, scheduler, etc — all unchanged).
  if (opts.tools && opts.tools.length > 0) {
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
    ({ kept, dropped, used } = assembleTurnMessages(effectiveSystemPrompt));
    // Durable tool telemetry (추적성) — pair each call's args (onToolCall) with its
    // result (onToolResult) and persist a role:'tool' message so later "어떤 도구
    // 호출했나" queries get the REAL trace, not a confabulated one. Audit-only
    // (toLLM excludes it from replay). Persistence is fail-soft — never break the turn.
    const toolCallArgs = new Map<string, unknown>();
    // ⭐ substrate 통합 — goal-loop 아밍 시 canonical 엔진(runGoalLoop→runCoreTurn→
    // streamLLMWithTools)으로 라우팅. 미아밍이면 아래 기존 single-turn 경로 그대로(회귀 0).
    const goalLoopCfg = opts.userConfig.llm.goalLoop;
    const armGoalLoop = opts.goalLoop === true || goalLoopCfg?.enabled === true;
    if (armGoalLoop) {
      const coreCtx: CoreTurnContext = {
        sessionId: opts.sessionId,
        // ⭐ 이 턴의 «사람 문장» 운반자. 없으면 표면 판정이 늘 기본값으로 떨어진다
        //   (골 루프가 라운드 사이에 기계 문장을 밀어 넣기 때문 — run-goal-loop.ts 진입 주석).
        userText: opts.userText,
        messages: kept,
        tools: turnTools,
        dispatchTool: async (name, args, ctx) => dispatchTool(name, args, ctx),
        signal: opts.signal ?? new AbortController().signal,
        callbacks: {
          onText: (delta) => { opts.onDelta?.(delta); },
          onToolCall: (call) => { toolCallArgs.set(call.id, call.args); opts.onToolCall?.(call); },
          onToolResult: (call) => {
            try {
              appendMessage(opts.sessionId, buildToolTraceMessage(call.name, toolCallArgs.get(call.id), call.result));
            } catch { /* telemetry persistence must not break the turn */ }
            opts.onToolResult?.(call);
          },
        },
        ...(turnLlmOpts?.model ? { modelOverride: turnLlmOpts.model } : {}),
        ...(turnLlmOpts?.budgetGrant ? { budgetGrant: turnLlmOpts.budgetGrant } : {}),
      };
      const maxIterations = opts.goalLoopMaxIterations ?? goalLoopCfg?.maxIterations;
      const gl = await runGoalLoop(coreCtx, maxIterations !== undefined ? { maxIterations } : {});
      text = gl.finalText;
    } else {
    text = await streamLLMWithTools(
      kept,
      {
        onText: (delta /*, full */) => {
          opts.onDelta?.(delta);
        },
        dispatchTool: async (name, args, ctx) => dispatchTool(name, args, ctx),
        onToolCall: (call) => { toolCallArgs.set(call.id, call.args); opts.onToolCall?.(call); },
        onToolResult: (call) => {
          try {
            appendMessage(opts.sessionId, buildToolTraceMessage(call.name, toolCallArgs.get(call.id), call.result));
          } catch { /* telemetry persistence must not break the turn */ }
          opts.onToolResult?.(call);
        },
      },
      {
        ...(turnLlmOpts ?? {}),
        tools: turnTools,
        provider,
        // ★ /cancel 범용화(대표 2026-07-12) — per-turn abort signal 을 tool 루프·llm 호출에 전파.
        //   이게 없으면 /cancel(turnAborters.abort)이 진행 중 tool 반복(grep 폭주 등)을 못 멈춘다.
        ...(opts.signal ? { signal: opts.signal } : {}),
        // ★ C1(문맥관리 트랙) — 미션 walker 압축 관측(mission.walker.compact)에 미션 좌표를 실어줌.
        //   missionContext 있을 때만(미션 페이즈 실행) threading — 일반 채팅은 무영향.
        ...(opts.missionContext ? { missionContext: opts.missionContext } : {}),
      },
    );
    }
  } else {
    ({ kept, dropped, used } = assembleTurnMessages(effectiveSystemPrompt));
    const plainOpts = opts.signal ? { ...(llmOpts ?? {}), signal: opts.signal } : (llmOpts ?? {});
    const stream = provider.streamChat
      ? provider.streamChat(kept, plainOpts)
      : wrapTextOnly(provider.chat(kept, plainOpts));
    for await (const ev of stream) {
      if (ev.type === 'text' && ev.delta) {
        text += ev.delta;
        opts.onDelta?.(ev.delta);
      }
      // tool_call events are ignored in this helper — session-chat is
      // for straight conversational turns. Skill execution uses the
      // skill-runner path with its own tool loop.
    }
  }
  const turnSeconds = (Date.now() - turnStartedAt) / 1000;

  // 3) Persist assistant response.
  const asstTs = new Date().toISOString();
  const asstMsg: SerializedMessage = {
    role: 'assistant',
    content: text,
    ts: asstTs,
    tokenEstimate: estimateTokens(text),
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

  return {
    text,
    meta: updatedMeta,
    usedTokens: used,
    droppedMessages: dropped,
    provider: provider.name,
    model: resolvedModel,
    memoryIds,
  };
}

/** Helper to normalize a `chat()` string-generator into the unified
 *  stream-event shape used by streamChat. */
async function* wrapTextOnly(
  gen: AsyncGenerator<string, void, unknown>,
): AsyncGenerator<{ type: 'text'; delta: string }, void, unknown> {
  for await (const s of gen) yield { type: 'text', delta: s };
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
