// ── elanous self agent turn — the shared messenger-surface brain (M4a) ──
//
// PLAN-multi-surface-pty-shell M4a: the tool-enabled elanous self turn
// that telegram proved (T1/A0 tools + finance pack + delegate_code_agent
// + the M1 terminal layer) generalized to a SURFACE-flavored factory.
// Telegram and Discord consume the same assembly; per-surface deltas
// stay at the seams the runTurn opts already carry:
//   - `opts.tgChat` (telegram only) → active-delegation arming; absent
//     on discord until M4b ports the interweaving stack.
//   - `surface` → cross-surface memory label (recordInboundTurn).
//   - HITL confirm/question/fileSink channels are passed per turn by
//     the hosting bot (telegram chat / discord channel flavors).
//
// History note: extracted verbatim from src/telegram-agent.ts
// (2026-07-12); that module remains as a thin compat shim.

import { existsSync } from 'node:fs';
import type { UserConfig } from '../user-config.js';
import { runTurn } from '../session/chat.js';
import type { SessionSource } from '../session/index.js';
import { buildContinuationAgentTools } from '../dispatch/continuation-turn-runner.js';
import { buildTerminalCapableTurn } from './terminal-surface.js';
// ★ turn 조립기 통일 Phase 1(2026-07-22) — 자율tool 5종(delegate·SelfImplement·RelayShell·RunDevHarness·
//   SolveMission) 의 spec 조립 + per-turn dispatch 배선을 autonomous-tools.ts 로 추출(서피스-무관).
import { buildAutonomousToolSpecs, dispatchAutonomousTool, isAutonomousTool, delegateBackendToSlashKey } from './autonomous-tools.js';
import { isToolSearchCall, routeToolSearch } from '../skills/tools/tool-search-route.js';
import { financeEnabled, financeAgentSystemPrompt, marketClock } from '../domains/finance.js';
import { buildFinanceTools } from '../domains/finance-tools.js';
import { surfaceEventsDbPath, openSurfaceEventsDb, recentSentDigest, recordInboundTurn } from '../domains/surface-events.js';
import { elanousSelfAccessPrompt, elanousSelfAmbientParts } from './self-ambient.js';
import { localRefGroundingAmbient } from './ref-grounding.js';
import { resolveRouteDecision } from '../llm/route-decision.js';
import { explicitTurnTier } from '../model-tier/turn-tier.js';
import type { RouteDecision } from '../llm/route-decision.js';
import { debug } from '../debug/log.js';
import { setEventLoopActivity } from '../debug/event-loop-watchdog.js';
import { effectiveReasoningLevel } from '../llm.js';
import { executionFooter } from '../telegram-exec-footer.js';
import { setActiveDelegation, delegationChatKey } from '../acp/active-delegation.js';

// delegateBackendToSlashKey — autonomous-tools.ts 로 이관(Phase 1·재사용). import 한 로컬 바인딩을
// compat 위해 재노출(telegram-agent.ts 가 이 모듈 경유 재노출).
export { delegateBackendToSlashKey };

// elanousSelfAccessPrompt/자기인지 ambient 3종 — self-ambient.ts 로 추출(P3 · 2026-07-13).
// TUI 채팅 preamble(dashboard/turn-preamble)과 단일 출처 공유(표면 패리티).

/** Block 5 — 최근 발송 ambient 주입(반문 예방). 매 턴 fresh · fail-soft ·
 *  발송 없으면 ''. 데몬 에이전트는 memory.ts를 안 받으므로 이게 자기 발송 인지원. */
function recentSentContext(): string {
  try {
    if (!existsSync(surfaceEventsDbPath())) return '';
    const db = openSurfaceEventsDb();
    try { return recentSentDigest(db); } finally { db.close(); }
  } catch { return ''; }
}

/** Build the tool-enabled elanous self runTurn for a messenger surface:
 *  the full agent tool surface (Read/Grep/Glob/ListDir/Edit/Write +
 *  Bash + PtyShell + search), plus — when the finance domain pack is
 *  enabled (A0) — the analyst orientation + resource map + first-class
 *  finance tools. Drop-in for the hosting bot's `runTurnImpl`. */
export function makeElanousAgentRunTurn(cfg: UserConfig, surface: SessionSource, runTurnImpl: typeof runTurn = runTurn): typeof runTurn {
  if (surface !== 'telegram' && surface !== 'discord') {
    throw new Error(`Unsupported elanous agent session source: ${surface}`);
  }
  const finance = financeEnabled(cfg);
  // ★ turn 조립기 통일 Phase 4b(2026-07-22·대표 결정) — telegram/discord 는 원격 입력 서피스라 fs-tool
  //   (Read/Edit/Write)에 strict 정책 주입: cwd-앵커 + credential deny-list(.ssh/.env/*.pem…). 종전엔
  //   native 무가드라 원격 메신저가 자격증명 열람 가능하던 갭을 닫는다. 로컬 CLI 는 permissive 유지.
  const cont = buildContinuationAgentTools({ pathPolicy: 'strict' });
  const fin = finance ? buildFinanceTools() : null;
  // Finance tools first so they surface prominently; dispatch routes by
  // name (finance_* → finance dispatch, everything else → agent tools).
  const baseSpecs = fin ? [...fin.specs, ...cont.specs] : cont.specs;
  // 자율tool 5종(delegate_code_agent · SelfImplement · RunDevHarness · SolveMission — RelayShell 은
  // dispatch-only 별칭) — spec 조립을 autonomous-tools 헬퍼로(Phase 1). delegate 는 NL 요청("Claude로
  // 구현해줘")을 ACP 로 큰 코딩작업 위임, 무거운 3종은 ⑩nest-cap 초과 시 제외. spec 이름배열은 종전
  // 인라인과 diff=0(autonomous-tools.test 스냅샷 가드). 승인/진행/spill 은 per-turn HITL 채널로 dispatch
  // 클로저(아래)가 막을 통과시킨다.
  const specs = [...baseSpecs, ...buildAutonomousToolSpecs()];
  const baseDispatch = fin
    ? async (name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> =>
        (fin.names.has(name) ? fin.dispatch(name, args) : cont.dispatch(name, args, signal))
    : cont.dispatch;
  return async (opts) => {
    // #24 — 이벤트루프 stall 시 범인 턴 특정. 턴 진입을 activity 로 마킹(surface+objective digest).
    //   무한루프가 이 턴에서 나면 watchdog stall 로그의 lastActivity 가 이 라벨을 가리킨다. 리셋 불필요
    //   (다음 턴이 덮어씀·heartbeat ts 는 신선 유지라 완료 턴이 false-alarm 안 냄).
    setEventLoopActivity(`turn:${surface}:${(opts.userText ?? '').replace(/\s+/g, ' ').trim().slice(0, 48)}`);
    // Mission-aware model selection (light reuse of existing infra).
    //
    // ⭐⭐ POLICY (2026-09-23 rev · 대표) — ***티어로만 고른다. 모델 이름은 여기 없다.***
    //   deep(plan · review) → `best` tier · 그 외(build/quick/research/vision) → `better` tier.
    //   실제 모델은 `llm-tier-map` 의 `openai-codex` 사다리가 정한다(현재 gpt-6-sol · high/medium).
    //
    // 🩸 왜 이렇게 됐나 — 종전 문면(2026-07-11)은 «모델 이름으로» 정책을 설명했다:
    //   *"sol 은 과잉조사라 느리고 terra 가 codex sweet spot"*. 그 문장은 로직이 아니라 «근거»였는데
    //   ***사다리가 GPT-6 으로 옮겨간 뒤 근거만 늙어 남았다*** — 코드는 맞고 설명이 틀린 상태.
    //   ⇒ 근거를 「그때 그 모델이 왜」가 아니라 ***「어느 티어인가」***로 적는다. 티어는 안 늙는다.
    //
    // ⭐ 코딩 레인이 `balanced`(low) 가 아니라 `better`(medium) 인 이유:
    //   ⑴ 대표 2026-09-23 *"전체 기본값을 gpt6 sol medium"*
    //   ⑵ 커뮤니티 실측 — agentic coding 이 medium 에서 정점(test pass rate · review score),
    //      high 이상은 과잉설계·scope creep 신고 급증 ⇒ deep 에만 둔다.
    //
    // ⚠️ 터미널/REPL 구동 턴은 라우터가 research/quick 으로 분류한다(build 아님) — 그래서
    //   「build 만 코딩 티어」로 좁히면 그 턴들이 느린 칸에 갇힌다(2026-07-11 실측). 지금처럼
    //   「deep 이 아니면 코딩 티어」가 그 구멍을 막는다.
    //
    // ⛔ 호출자가 모델을 핀했으면 «건드리지 않는다». 실패는 fail-soft — config 기본을 유지한다.
    let llmOpts = opts.llmOpts;
    let routeDecision: RouteDecision | undefined;
    const explicitTier = opts.llmOpts?.model ? undefined : explicitTurnTier(cfg, opts.sessionId);
    if (cfg.llm.provider === 'openai-codex' && explicitTier) {
      llmOpts = { ...(llmOpts ?? {}), model: explicitTier.model };
      debug.log('llm.route-decision', 'self-turn', {
        surface, provider: cfg.llm.provider, model: explicitTier.model, skipped: 'explicit-tier',
      });
    } else if (cfg.llm.provider === 'openai-codex') {
      try {
        const decision = resolveRouteDecision({
          provider: cfg.llm.provider,
          configuredModel: cfg.llm.model,
          text: opts.userText,
          explicitModel: llmOpts?.model,
          routePolicy: cfg.llm.routePolicy,
        });
        routeDecision = decision;
        debug.log('llm.route-decision', 'self-turn', {
          surface,
          provider: decision.provider,
          model: decision.model,
          mission: decision.mission,
          source: decision.source,
          overridden: decision.model !== cfg.llm.model,
        });
        const target = decision.model;
        if (target && target !== cfg.llm.model) {
          llmOpts = { ...(opts.llmOpts ?? {}), model: target };
        }
      } catch { /* keep the config default */ }
    }
    // Per-turn dispatch: route delegate_code_agent through the surface
    // HITL channel bound to THIS chat (opts.hitlConfirmChannel), so the
    // delegated agent's permission/question prompts return to the user
    // who triggered the mission. Absent channel ⇒ dispatchDelegateAgent
    // auto-approves (unattended), matching the daemon path.
    const surfaceChannels = opts.hitlConfirmChannel ? [opts.hitlConfirmChannel] : undefined;
    const surfaceQuestionChannels = opts.hitlQuestionChannel ? [opts.hitlQuestionChannel] : undefined;
    const surfaceFileSink = opts.hitlFileSink;
    // Track whether the turn handed off to an ACP delegate — the footer then
    // reads acp-<backend> instead of self·<model>.
    let delegatedBackend: string | undefined;
    const dispatch = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
      // ⭐ 소환기(F2 · 2026-07-26) — 이 서피스도 SelfImplement/RunDevHarness/
      //   SolveMission 을 defer 하므로 tier-flip 이 ToolSearch 를 주입한다.
      //   라우팅이 없으면 모델이 소환을 시도하는 순간 "unknown tool" 이다.
      //   `specs` = 이 턴이 실제로 dispatch 할 수 있는 전부(권위적 allowlist).
      if (isToolSearchCall(name)) return routeToolSearch(args, specs, { surface });
      // 자율tool 5종은 서피스-무관 헬퍼(dispatchAutonomousTool)로 위임 — HITL 채널·wrapAutonomousTool·
      // nest-cap 배선을 단일 출처로(Phase 1). 서피스 고유(delegate 아밍·footer delegatedBackend 추적)는
      // onDelegated 콜백으로 여기서 처리(tgChat/dcChannel 정체성은 이 서피스가 소유).
      if (isAutonomousTool(name)) {
        return dispatchAutonomousTool(name, args, {
          cwd: process.cwd(),
          // Forward the turn's abort signal (from a /cancel-aware controller) so
          // an in-flight delegation can be cancelled; inert signal otherwise.
          signal: opts.signal ?? new AbortController().signal,
          ...(surfaceChannels ? { surfaceHitlChannels: surfaceChannels } : {}),
          ...(surfaceQuestionChannels ? { surfaceQuestionChannels } : {}),
          ...(surfaceFileSink ? { surfaceFileSink } : {}),
          ...(opts.emitFeedback ? { emitFeedback: opts.emitFeedback } : {}),
          ...(opts.userText ? { userText: opts.userText } : {}),
          ...(opts.missionContext ? { missionContext: { missionId: opts.missionContext.missionId, phaseId: opts.missionContext.phaseId } } : {}),
          // A — a brain-initiated delegate joins the continuous coding session:
          // track delegatedBackend for the footer AND arm active delegation so
          // plain NL follow-ups continue THIS backend (keyed by telegram tgChat /
          // discord dcChannel) instead of a fresh ephemeral session each time.
          onDelegated: (backend, failed) => {
            delegatedBackend = backend;
            const slashKey = delegateBackendToSlashKey(backend);
            if (!failed && slashKey && opts.tgChat) {
              setActiveDelegation(delegationChatKey(opts.tgChat.botId, opts.tgChat.chatId, opts.tgChat.threadId), slashKey);
            } else if (!failed && slashKey && opts.dcChannel) {
              setActiveDelegation(delegationChatKey('dc', opts.dcChannel.channelId), slashKey);
            }
          },
        });
      }
      // Thread the turn's abort signal so a long in-flight Bash is killed by
      // `/cancel` (dispatchBash SIGTERMs its child on abort).
      return baseDispatch(name, args, opts.signal);
    };
    // Both the market clock AND the resource map are recomputed FRESH per
    // turn: the clock so the agent knows the current time/sessions, and the
    // resource map so edits to ~/.elanous/finance-resources.md take effect
    // WITHOUT a daemon restart (hot-reload). Finance-gated.
    const parts = [
      finance ? marketClock() : '',
      finance ? financeAgentSystemPrompt() : '',
      finance ? recentSentContext() : '', // Block 5 — 최근 발송 ambient 인지(반문 예방)
      elanousSelfAccessPrompt(), // 자기접근 규율 — 소스/수정/ACP위임/세션/웹검증 도구 실제 사용(코어 상시)
      // P4/P0.3/Ops P3 — 자기인지 ambient 3종(최근 구현·자율행동·이상). TUI preamble 과
      // 단일 출처(self-ambient.ts) 공유 — 표면 패리티(P3 · 2026-07-13).
      ...elanousSelfAmbientParts(opts.userText),
      localRefGroundingAmbient(opts.userText), // 로컬 ~/source/ref canonical 그라운딩(웹 우회 방지)
      opts.systemPrompt ?? '',
    ].filter(Boolean);
    // Fold the four terminal adapters (budgetGrant · cancel→PTY ·
    // _imageFile→sendImage · mission discipline) onto this turn — shared
    // layer, single source (PLAN-multi-surface-pty-shell M1).
    const terminal = buildTerminalCapableTurn({
      specs,
      dispatch,
      systemPromptParts: parts,
      ...(llmOpts !== undefined ? { llmOpts } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(surfaceFileSink ? { fileSink: surfaceFileSink } : {}),
    });
    llmOpts = terminal.llmOpts;
    let currentMessage = '';
    let sawToolCall = false;
    return runTurnImpl({
      ...opts,
      onDelta: (delta) => {
        currentMessage += delta;
        opts.onDelta?.(delta);
      },
      onToolCall: (call) => {
        currentMessage = '';
        sawToolCall = true;
        opts.onToolCall?.(call);
      },
      llmOpts,
      systemPrompt: terminal.systemPromptParts.join('\n\n'),
      tools: terminal.specs,
      dispatchTool: terminal.dispatch,
    }).then((result) => {
      // /cancel self-awareness — when the turn was aborted mid-run (user hit
      // `/cancel`), the tool loop returns with little/no final text. Substitute
      // a CLEAR cancellation marker so (a) the user gets an ack, and (b) it is
      // the text recorded to cross-surface memory (recordInboundTurn) — so the
      // NEXT turn's memory_recall knows the task was CANCELLED, not silently
      // dropped or still running. Only turnAbort (=/cancel) aborts this signal.
      const wasAborted = opts.signal?.aborted === true;
      const answer = sawToolCall ? currentMessage.trim() : result.text;
      const responseText = wasAborted
        ? (answer?.trim()
            ? `${answer}\n\n⏹️ 이 작업은 /cancel 로 취소되었습니다 (실행 중이던 Bash/PTY 종료됨).`
            : '⏹️ 작업이 /cancel 로 취소되었습니다. 실행 중이던 Bash/PTY 를 종료했습니다.')
        : answer;
      // Block 3 — 대화 턴을 크로스서피스 기억에 기록(질의+응답·direction=inbound).
      // fail-soft·비동기(대화 지연 없음). 이후 memory_recall 이 과거 대화도 회상.
      try { recordInboundTurn({ surface, userText: opts.userText, responseText, sessionId: opts.sessionId }); } catch { /* noop */ }
      // Execution footer — engine · model · effort. Self shows the model it
      // ran on + the resolved reasoning effort (both meaningful indices). A NL
      // delegate handoff stays acp-<backend> (backend model unknown here).
      const selfModel = llmOpts?.model ?? cfg.llm.model;
      const footer = delegatedBackend
        ? executionFooter({ delegatedBackend })
        : executionFooter({
          model: selfModel,
          effort: effectiveReasoningLevel(cfg.llm, cfg.llm.provider, selfModel),
          ...(routeDecision ? { source: routeDecision.source } : {}),
          });
      return { ...result, text: responseText ? `${responseText}\n\n${footer}` : footer };
    });
  };
}
