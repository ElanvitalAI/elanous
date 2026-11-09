import type { LLMToolSpec } from '../llm/tool-spec.js';
// ── §5-③ Phase C2b: continuation turn runner ──
//
// Adapts the CLI agent turn (chat.ts runTurn + the Read/Grep/Glob/
// ListDir/Edit/Write + Bash surface) into the simple
// `(prompt) => Promise<{text}>` the ContinuationScheduler drives. One
// dedicated background session + one tool surface are built once and
// reused across the goal's continuation turns.
//
// Only constructed by the daemon when `dispatch.enabled` is set — the
// scheduler that calls this is default-off. See docs §5-③.

import { runTurn, ensureCliSession } from '../session/chat.js';
import { getProviderForConfig } from '../llm.js';
import type { UserConfig } from '../user-config/types.js';
import { compactSessionHistory } from '../session/compact-session.js';
import { buildTerminalCapableTurn } from '../agent/terminal-surface.js';
import { debug } from '../debug/log.js';
import { getSessionCwd } from '../session/working-dir.js';
import type { ContinuationTurnResult } from './continuation-bridge.js';

/** Agent tool surface — mirrors `elanous agent` so continuation turns can
 *  make real file/shell progress toward the goal's termination.
 *  Replicates the CLI's buildCliAgentTools (kept in sync deliberately;
 *  importing index.ts here would pull the whole CLI graph). */
export function buildContinuationAgentTools(opts?: {
  /** ★ turn 조립기 통일 Phase 4b(2026-07-22) — fs-tool 경로 보안 정책. 원격 메신저(telegram/discord)가
   *  'strict'(cwd-앵커+credential deny-list)를 주입. 미지정=permissive(현행·자율 스케줄러 등). */
  pathPolicy?: import('../agent/path-policy.js').PathPolicy;
}): {
  specs: LLMToolSpec[];
  dispatch: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
} {
  const specs: LLMToolSpec[] = [];
  // Handlers accept the per-turn abort signal so a `/cancel` can kill an
  // in-flight tool (e.g. a long Bash) — dispatchBash SIGTERMs its child when
  // the signal aborts. Most tools ignore the signal (fast/request-response).
  const dispatchByName = new Map<string, (args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>>();
  const sr = require('../session-runtime/index.js') as typeof import('../session-runtime/index.js');
  // ★ turn 조립기 통일 Phase 2(2026-07-22) — native 코딩코어 조립을 buildCodingCoreNativeSpecs 단일
  //   출처로(CLI buildCliAgentTools 와 공유). 종전 "kept in sync deliberately" 수동 복제 제거.
  const codingCore = require('../agent/coding-core-tools.js') as typeof import('../agent/coding-core-tools.js');
  for (const spec of codingCore.buildCodingCoreNativeSpecs()) specs.push(spec);
  const bashMod = require('../skills/tools/index.js') as typeof import('../skills/tools/index.js');
  specs.push(bashMod.buildBashTool());
  // ★ walker Bash cwd 격리(대표 2026-07-21·boundary Bash 우회 근본) — 종전 process.cwd()(부팅트리)
  //   하드코딩이 setSessionCwd(worktree) 를 무시해 walker Bash 쓰기(echo/tee/sed -i > docs/…)가 부팅
  //   트리를 오염시켰다(apply.ts boundary 는 Write/Edit 만 검사·Bash 우회·라이브 617097 내부 문서 `*` 오염).
  //   getSessionCwd() 로 정렬 = bash-runtime.ts:56 이 이미 쓰는 규율. worktree OFF 시 lazy-init 이
  //   process.cwd() 반환 → 무회귀.
  dispatchByName.set('Bash', async (args, signal) => bashMod.dispatchBash(args, { cwd: getSessionCwd(), ...(signal ? { signal } : {}) }));
  // PtyShell* — interactive PTY (codex unified_exec analog): spawn REPLs /
  // dev-servers / watchers and drive them turn-by-turn, where Bash's
  // one-shot model is wrong. This is the headless self-terminal-ReAct
  // substrate reaching the telegram + continuation agent surface. Bun-
  // native PTY backend (pty-shell/bun-native-pty.ts) makes it work under
  // the bun daemon, where node-pty's onData is dark. Autonomous surface
  // auto-approves the spawn (no HITL babysitting — matches the delegation
  // philosophy). Gated on PTY availability so it never advertises a tool
  // that can't run.
  const registryMod = require('../pty-shell/registry.js') as typeof import('../pty-shell/registry.js');
  if (registryMod.ptyAvailable()) {
    const ptyShellMod = require('../boot/daemon-tools/pty-shell.js') as typeof import('../boot/daemon-tools/pty-shell.js');
    for (const spec of ptyShellMod.buildPtyShellSpecs()) specs.push(spec);
    for (const name of ptyShellMod.PTY_SHELL_TOOL_NAMES) {
      dispatchByName.set(name, async (args) => ptyShellMod.dispatchPtyShellTool(name, args));
    }
  }
  // L2 코어 앱 도구(schedule_manage·memory_recall·… — 도메인 무관·전 서피스 공용). finance
  // 팩과 독립. 단일 출처(core-tools.ts)에서 상속(대표 지시: 코어는 서피스 무관 노출).
  const coreMod = require('../domains/core-tools.js') as typeof import('../domains/core-tools.js');
  const core = coreMod.buildCoreTools();
  for (const s of core.specs) specs.push(s);
  for (const name of core.names) dispatchByName.set(name, async (args) => core.dispatch(name, args));
  // WebSearch — added UNCONDITIONALLY (not intent-gated). The dynamic native
  // resolver gates web-search on hasWebSearchIntent(userText), but this surface
  // is built once with an EMPTY userText, so the gate never opens and the tool
  // silently vanished — the finance/telegram agent could recognise a data gap
  // ("최근 실적 미반영?") yet had no WebSearch to chain, so it stopped and asked.
  // The finance + continuation agents routinely need to verify facts / fill
  // missing data, so expose it whenever a provider is available (Tavily
  // first — cheap+fast; Grok Agent-Tools·Firecrawl fallback — see src/web-search/).
  const wsMod = require('../skills/tools/web-search.js') as typeof import('../skills/tools/web-search.js');
  const webRegistry = require('../web-search/index.js') as typeof import('../web-search/index.js');
  if (webRegistry.getAvailableWebSearchProviders().length >= 1 && !specs.some(s => s.name === 'WebSearch')) {
    specs.push(wsMod.buildWebSearchTool());
    const runWebSearch = async (args: Record<string, unknown>): Promise<unknown> => wsMod.dispatchWebSearch(args);
    dispatchByName.set('WebSearch', runWebSearch);
    dispatchByName.set('web_search', runWebSearch); // alias — models sometimes emit snake_case
  }
  const plannerState = sr.createSearchPlannerState({ maxAutoNarrowCandidates: 2 });
  const dispatch = async (name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> => {
    try {
      const direct = dispatchByName.get(name);
      if (direct) return await direct(args, signal);
      return await sr.dispatchSessionRuntimeTool(name, args, {
        signal,
        userText: '',
        modelFamily: undefined,
        searchPlannerState: plannerState,
        turnIndex: undefined,
        ptyDashboardOn: false,
        getToolRuntime: () => undefined,
        dispatchToolRuntime: async (n: string) => ({ error: `runtime tool unavailable: ${n}` }),
        dispatchPluginTool: async (n: string) => ({ ok: false as const, error: `plugin tool unavailable: ${n}` }),
        ...(opts?.pathPolicy ? { pathPolicy: opts.pathPolicy } : {}), // Phase 4b — 서피스 트러스트 정책 전파
      });
    } catch (err) {
      return { error: `dispatch failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  };
  return { specs, dispatch };
}

/** Build the runTurn the ContinuationScheduler drives. Creates one
 *  background session + tool surface, reused across the goal's turns. */
export function makeContinuationRunTurn(
  cfg: UserConfig,
): (prompt: string, signal?: AbortSignal) => Promise<ContinuationTurnResult> {
  const session = ensureCliSession(cfg);
  const { specs, dispatch } = buildContinuationAgentTools();
  // Resolve the active model once (drives context-window inference for
  // the compaction threshold). Matches runTurn's resolution order.
  const modelId = cfg.llm?.model ?? getProviderForConfig(cfg).defaultModel;
  const autoCompact = cfg.chat?.autoCompact;
  // `signal` (PLAN-multi-surface-pty-shell M3): optional per-turn abort —
  // schedulers that gain a cancel affordance pass it and get the same
  // semantics as telegram /cancel (Bash SIGTERM via dispatch signal +
  // non-detached PTY kill via the terminal helper). Legacy callers
  // (opportunity-analysis, existing scheduler) omit it — unchanged.
  return async (prompt: string, signal?: AbortSignal): Promise<ContinuationTurnResult> => {
    // §5-⑤ pre-turn auto-compaction — before each autonomous turn,
    // compress the grown session transcript in place when it exceeds
    // the token ratio, so a long unattended run doesn't reload an
    // ever-growing history each turn (codex run_auto_compact pattern).
    // Gated by chat.autoCompact (default on); best-effort — a
    // compaction failure must never break the turn.
    if (autoCompact?.enabled) {
      try {
        const r = await compactSessionHistory(session.id, { modelId, config: autoCompact });
        if (r.fired) {
          debug.log('dispatch.continuation.compact', 'fired', {
            before: r.before, after: r.after, ratio: Number(r.ratio.toFixed(3)),
            layer3: r.layer3Applied, retries: r.overflowRetries,
          });
        }
      } catch (err) {
        debug.log('dispatch.continuation.compact', 'error', {
          message: err instanceof Error ? err.message : String(err),
        }, { level: 'error' });
      }
    }
    // PLAN-multi-surface-pty-shell M3 — fold the shared terminal
    // adapters onto the autonomous turn: budgetGrant (terminal-driving
    // rounds), mission discipline, `_imageFile`→inline image (vision
    // LLMs see the captured frame; there is no chat sink here), and —
    // when the caller passed a signal — abort→PTY kill.
    const terminal = buildTerminalCapableTurn({
      specs,
      dispatch: (name, args) => dispatch(name, args, signal),
      systemPromptParts: [],
      inlineImages: true,
      ...(signal ? { signal } : {}),
    });
    const res = await runTurn({
      userConfig: cfg,
      sessionId: session.id,
      userText: prompt,
      tools: terminal.specs,
      dispatchTool: terminal.dispatch,
      llmOpts: terminal.llmOpts,
      systemPrompt: terminal.systemPromptParts.join('\n\n'),
      ...(signal ? { signal } : {}),
    });
    return { text: res.text, usedTokens: res.usedTokens };
  };
}
