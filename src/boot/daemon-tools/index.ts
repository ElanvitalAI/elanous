// MVP M1.5 A.2 — daemon tool surface registry.
//
// Single entry the daemon-runtime imports. `toolSurface(kind)`
// returns the active tool catalog + a name-routing dispatcher.
// 'none' → empty (current default behavior). 'readonly' → Read +
// Grep + WebSearch. 'webterm' → readonly + WT-L-1 web-terminal tools
// (List · Snapshot · Input) so a PWA-only `elanous serve` agent can
// drive web terminals without booting the dashboard TUI.

import type { LLMToolSpec } from '../../llm.js';
import { recordToolCatalog } from '../../dashboard/tool-catalog-observability.js';
import {
  buildBrowserNavigateTool,
  buildBrowserReadTool,
  dispatchBrowserNavigate,
  dispatchBrowserRead,
} from '../../tool-runtime/browser-runtime.js';
import { askUserQuestionRuntime } from '../../tool-runtime/ask-user-question-runtime.js';
import { dispatchToolByName, listToolRuntimes } from '../../tool-runtime/registry.js';
import { ACP_SESSION_RUNTIMES } from '../../tool-runtime/acp-session-runtime.js';
import { ClaudeSubscriptionNotAllowedError } from '../../policy/claude-subscription-guard.js';
import { toWireToolName } from '../../tool-runtime/mcp-wire-name.js';
import type { ToolRuntime } from '../../tool-runtime/types.js';

import { buildEditTool, dispatchEdit } from './edit.js';
import { buildWriteTool, dispatchWrite } from './write.js';
import { buildGrepTool, dispatchGrep } from './grep.js';
import { buildReadTool, dispatchRead } from './read.js';
import {
  buildMarkStepDoneTool,
  buildPlanTool,
  dispatchMarkStepDone,
  dispatchPlan,
} from './plan.js';
import {
  ToolSafetyError,
  type DaemonToolDispatchCtx,
  type DaemonToolSurface,
  type DaemonToolSurfaceKind,
} from './types.js';
import { buildWebSearchTool, dispatchWebSearch } from './web-search.js';
import {
  WEB_TERMINAL_TOOL_NAMES,
  buildWebTerminalSpecs,
  dispatchWebTerminalTool,
} from './web-terminal.js';
// self-terminal-react M1 (2026-07-11) — expose the PtyShell* family
// (codex unified_exec analog: spawn own PTY, poll/send/kill) to the
// webterm surface so headless surfaces (telegram · self) can drive
// REPLs / dev-servers / watchers in an autonomous ReAct loop. Same
// `--tools webterm` opt-in gate as WebTerminal*.
import {
  PTY_SHELL_TOOL_NAMES,
  buildPtyShellSpecs,
  dispatchPtyShellTool,
} from './pty-shell.js';
// chat-friction-free PR-2 (2026-05-13) — expose Bash to the daemon
// webterm surface so PWA chat can run shell commands directly. The
// builder + dispatcher already exist for the skill surface; we
// re-use them with the daemon's tool-cwd. `dispatchBash` has its
// own timeout cap (600s) + output truncation (200KB) + sandbox
// hooks, so the daemon-side risk model matches what skills already
// run with.
import { buildBashTool, dispatchBash } from '../../skills/tools/index.js';
import { buildDelegateAgentTool, dispatchDelegateAgent } from './delegate-agent.js';
// self-build(2026-07-20) — ACP/데몬 서피스에 SelfImplement 노출(acpx·codex 등 외부 에이전트가 elanous
// self-implement 를 goal-loop+앵커+gate 로 구동). CLI/내부 툴과 같은 코어. PR-open 은 fail-closed.
import {
  SELF_IMPLEMENT_TOOL_NAMES,
  buildSelfImplementDaemonSpec,
  dispatchSelfImplement,
} from './self-implement.js';
// ⭐ 소환기(F2 · RFC-observability-driven-tool-selection · 2026-07-26) —
//   tier-flip 이 deferred 를 만들면 ToolSearch 를 active 에 **주입**하므로, 이 서피스는
//   그 이름을 **라우팅**해야 한다. 주입만 하고 라우팅이 없으면 모델이 ToolSearch 를
//   부르는 순간 "unknown tool" 이라 주입 전보다 악화된다 — 둘은 함께 착지한다.
//   서피스 spec 을 넘기는 게 핵심: 데몬 툴(SelfImplement 등)은 tool-runtime
//   레지스트리에 등록되지 않아 전역 조회만으로는 영원히 "no matches" 였다.
import { isToolSearchCall, routeToolSearch } from '../../skills/tools/tool-search-route.js';
// dev-harness front door(2026-07-20) — 스테이지드 하니스(P→E→R→D) 노출. self-build 처럼 자식 spawn(⑩ 상한 게이트).
import { buildRunDevHarnessTool, dispatchRunDevHarness, isDevHarnessModelSurfaceEnabled } from '../../skills/tools/dev-harness.js';
import { buildSolveMissionTool, dispatchSolveMission } from '../../skills/tools/solve-mission.js';
// ⑩ 재귀 depth cap(액자 방지) — 상한 도달 시 자식-spawn 툴(SelfImplement·delegate) 제외+거부.
import { nestCapReached, nestInfo } from '../../agent/nest-depth.js';
import { debug } from '../../debug/log.js';
// L2 코어 앱 도구(schedule_manage·memory_recall·… — 도메인 무관·전 서피스 공용). 단일
// 출처(core-tools.ts)에서 상속. PWA/iOS/Android/discord/TUI 챗도 예약·기억 조회/관리.

export type { DaemonToolSurfaceKind, DaemonToolSurface, DaemonToolDispatchCtx } from './types.js';
export { ToolSafetyError } from './types.js';
export {
  buildReadTool, dispatchRead, READ_MAX_BYTES, type ReadArgs, type ReadResult,
} from './read.js';
export {
  buildGrepTool, dispatchGrep, GREP_TIMEOUT_MS, GREP_MAX_RESULTS,
  type GrepArgs, type GrepMatch, type GrepResult,
} from './grep.js';
export {
  buildWebSearchTool, dispatchWebSearch,
  type DaemonWebSearchArgs, type DaemonWebSearchResult,
} from './web-search.js';
export {
  WEB_TERMINAL_TOOL_NAMES,
  buildWebTerminalSpecs,
  dispatchWebTerminalTool,
} from './web-terminal.js';
export {
  buildPlanTool, buildMarkStepDoneTool, dispatchPlan, dispatchMarkStepDone,
  type PlanArgs, type PlanResult, type PlanStep, type PlanStepStatus,
  type MarkStepDoneArgs, type MarkStepDoneResult,
} from './plan.js';
export {
  buildEditTool, dispatchEdit, EDIT_MAX_BYTES,
  type EditArgs, type EditResult, type EditSpec,
} from './edit.js';
export {
  buildWriteTool, dispatchWrite, WRITE_MAX_BYTES,
  type WriteArgs, type WriteResult,
} from './write.js';

const READONLY_TOOL_NAMES = new Set([
  'Read',
  'Grep',
  'WebSearch',
  // Opportunistic followup §6.2 #4 (2026-05-13) — Plan + MarkStepDone
  // are read-only by nature (no fs / network / pty side effects). They
  // emit a `agent.plan` envelope and update an in-memory ledger only,
  // so they ride alongside the existing read-only triple instead of
  // forcing a new surface kind.
  'Plan',
  'MarkStepDone',
]);

function writeDispatchCtx(ctx: DaemonToolDispatchCtx): DaemonToolDispatchCtx {
  const cwd = ctx.resolveWriteCwd?.() ?? ctx.cwd;
  return cwd === ctx.cwd ? ctx : { ...ctx, cwd };
}

/** MCP proxy runtimes declare both `mcp` and `tui`; native tui runtimes
 * remain owned by their existing surface assemblers. */
export type McpJoinReason = 'joined' | 'registry-empty' | 'no-mcp-runtimes' | 'all-static';

/** ⛔⭐ 「0」을 한 값으로 두지 않는다 — 셋은 완전히 다른 진단이다.
 *
 *   registry-empty   아무것도 등록 안 됨 — 배선이 죽었거나 아직 부팅 중이다
 *   no-mcp-runtimes  툴은 있는데 MCP 를 선언한 것이 없다 — 상대 서버가 안 붙었다
 *   all-static       MCP 런타임이 있는데 전부 정적 목록과 이름이 겹친다
 *
 *  📏 이 저장소는 2026-08-20 하루에 「못 쟀다」를 「없다」로 읽어 «네 번» 물렸다
 *  (codex 회전 · AskUserQuestion · surface-ux · 이 축). 그래서 이름을 붙인다. */
export function mcpJoinReason(
  counts: { tuiCount: number; mcpCount: number; joinedCount: number },
): McpJoinReason {
  if (counts.joinedCount > 0) return 'joined';
  if (counts.tuiCount === 0) return 'registry-empty';
  if (counts.mcpCount === 0) return 'no-mcp-runtimes';
  return 'all-static';
}

function daemonMcpRuntimes(staticNames: ReadonlySet<string>): ToolRuntime[] {
  const tuiRuntimes = listToolRuntimes('tui');
  const mcpRuntimes = tuiRuntimes.filter((runtime) => runtime.surfaces?.includes('mcp'));
  const runtimes = mcpRuntimes.filter((runtime) => !staticNames.has(runtime.spec.name));
  const reason = mcpJoinReason({
    tuiCount: tuiRuntimes.length, mcpCount: mcpRuntimes.length, joinedCount: runtimes.length,
  });
  debug.log('capability.resolve', 'daemon-mcp-runtimes', {
    runtimeCount: runtimes.length,
    reason,
    tuiRuntimeCount: tuiRuntimes.length,
    mcpRuntimeCount: mcpRuntimes.length,
    runtimeNames: runtimes.map((runtime) => runtime.spec.name),
  });
  return runtimes;
}

/** ⛔⭐⭐⭐ MCP 런타임은 «부팅 뒤에» 등록된다.
 *
 *  📏 실측(2026-08-20): 데몬이 기동 16초 시점에 이 목록을 «한 번» 계산하고
 *  (`daemon-mcp-runtimes count=0` ×8), 상대 서버는 **그 뒤에** 붙었다
 *  (`mcp-client connected: higgsfield (73 tools)`). 요청은 부팅 목록을 그대로 쓰므로
 *  ***붙은 서버의 툴이 대화에서 영영 안 보였다.***
 *
 *  ⇒ 그래서 목록을 «만들 때»가 아니라 ***«읽을 때»*** 레지스트리를 본다.
 *  📌 레퍼런스 둘이 같은 결론이다 — codex 는 스냅샷을 generation 으로 발행하고,
 *     grok-build 는 `notifications/tools/list_changed` 로 무효화한다.
 *     둘 다 목록을 부팅에 «굳히지» 않는다. */
function liveMcpSpecs(staticSpecs: readonly LLMToolSpec[]): {
  specs: () => LLMToolSpec[];
  registryNameOf: (wireName: string) => string | null;
} {
  const staticNames = new Set(staticSpecs.map((spec) => spec.name));
  return {
    specs: () => [...staticSpecs, ...daemonMcpRuntimes(staticNames).map(deferredMcpSpec)],
    /** 전선 이름을 받아 레지스트리 이름으로 되돌린다. 못 찾으면 null — 이 표면의 툴이 아니다. */
    registryNameOf: (wireName) => {
      if (staticNames.has(wireName)) return null;
      const hit = daemonMcpRuntimes(staticNames)
        .find((runtime) => toWireToolName(runtime.spec.name) === wireName);
      return hit ? hit.spec.name : null;
    },
  };
}

/** ⛔⭐⭐⭐ 프로바이더는 툴 이름에 «점»을 허용하지 않는다 — 계약의 집은 `tool-runtime/mcp-wire-name.ts` 다.
 *
 *  📏 실측(2026-08-21 · 실물): 레지스트리 이름 `higgsfield.balance` 를 그대로 실었더니
 *  ***`Codex API 400: Invalid 'tools[69].name': ... pattern '^[a-zA-Z0-9_-]+$'`*** 로
 *  **턴 전체가 죽었다**(사람 화면엔 `error: Internal error` 만 떴다).
 *  ⛔ 그래서 「목록에 넣기」만으로는 부족하다 — «전선에 실을 수 있는 이름»이어야 한다.
 *
 *  ⇒ 레퍼런스 둘이 같은 답이다: grok-build 는 `MCP_TOOL_NAME_DELIMITER = "__"` 로 정규화하고
 *    codex 는 접두 자체를 기능 플래그로 다룬다. 우리도 `__` 를 쓴다 — 그 패턴을 통과한다.
 *  ⛔ 레지스트리 이름(점)은 «그대로 둔다». 바꾸는 것은 «바깥에 보이는 이름»뿐이고,
 *    디스패치 때 되돌린다. */
export { MCP_WIRE_DELIMITER, toWireToolName } from '../../tool-runtime/mcp-wire-name.js';

function deferredMcpSpec(runtime: ToolRuntime): LLMToolSpec {
  return {
    ...runtime.spec,
    name: toWireToolName(runtime.spec.name),
    alwaysLoad: false,
    shouldDefer: true,
  } as LLMToolSpec;
}

function dispatchDaemonMcpRuntime(
  name: string,
  args: Record<string, unknown>,
  ctx: DaemonToolDispatchCtx,
): Promise<unknown> {
  return dispatchToolByName(name, args, {
    surface: 'tui',
    signal: ctx.signal,
    ...(ctx.requestOrigin ? { requestOrigin: ctx.requestOrigin } : {}),
    ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    ...(ctx.toolCallId ? { toolCallId: ctx.toolCallId } : {}),
    ...(ctx.emitFeedback ? { emitFeedback: ctx.emitFeedback } : {}),
  });
}

/** Build the active tool surface for a given activation kind.
 *  Caller (`daemon-runtime.createDaemonRunTurn`) wires `specs` into
 *  `getTools` and `dispatch` into `dispatchTool`. */
export function toolSurface(kind: DaemonToolSurfaceKind, cfg?: import('../../user-config.js').UserConfig): DaemonToolSurface {
  if (kind === 'none') {
    const specs: LLMToolSpec[] = [];
    recordToolCatalog(null, 'daemon-tools', toolSurface, specs);
    return {
      kind: 'none',
      specs,
      async dispatch(name: string): Promise<unknown> {
        throw new ToolSafetyError(
          'unavailable',
          `daemon tool surface is 'none' — cannot dispatch '${name}'`,
        );
      },
    };
  }

  // Readonly base shared by 'readonly' and 'webterm'.
  const readonlySpecs: LLMToolSpec[] = [
    buildReadTool(),
    buildGrepTool(),
    buildWebSearchTool(),
    buildPlanTool(),
    buildMarkStepDoneTool(),
  ];

  if (kind === 'readonly') {
    recordToolCatalog(null, 'daemon-tools', toolSurface, readonlySpecs);
    return {
      kind: 'readonly',
      specs: readonlySpecs,
      async dispatch(
        name: string,
        args: Record<string, unknown>,
        ctx: DaemonToolDispatchCtx,
      ): Promise<unknown> {
        // Each dispatchX validates its required fields and throws a
        // ToolSafetyError on bad shape, so the cast is the type system
        // formality rather than the safety boundary.
        switch (name) {
          case 'Read':
            return dispatchRead(args as unknown as Parameters<typeof dispatchRead>[0], ctx);
          case 'Grep':
            return dispatchGrep(args as unknown as Parameters<typeof dispatchGrep>[0], ctx);
          case 'WebSearch':
            return dispatchWebSearch(args as unknown as Parameters<typeof dispatchWebSearch>[0], ctx);
          case 'Plan':
            return dispatchPlan(args as unknown as Parameters<typeof dispatchPlan>[0], ctx);
          case 'MarkStepDone':
            return dispatchMarkStepDone(args as unknown as Parameters<typeof dispatchMarkStepDone>[0], ctx);
          default:
            throw new ToolSafetyError(
              'unavailable',
              `daemon readonly surface does not know tool '${name}' (allowed: Read, Grep, WebSearch, Plan, MarkStepDone)`,
            );
        }
      },
    };
  }

  // 'chat' — readonly + Edit + Bash. **Default surface** (2026-05-13 ·
  // chat-only friction-free). Baseline for PWA / iOS / TUI chat
  // clients — LLM can read files (Read · Grep), edit files (Edit),
  // and execute shell commands (Bash) against the daemon's tool-cwd.
  // No PTY / WebTerminal* dependency — the entire surface is
  // request-response. Interactive workflows (vim · REPL · watchers)
  // require explicit `webterm` opt-in.
  // ★ turn 조립기 통일 Phase 0(2026-07-22) — L2 core + L3 finance(gated) 공통 조립을 buildSharedAppTools
  //   단일 헬퍼로(CLI/telegram 과 동일 출처). 종전 core/finance 분리 조립 통일(specs 순서 보존·무회귀).
  //   cfg 미전달 호출처(daemon-runtime·nexus)는 캐시된 getUserConfig fallback(fail-soft·cache-hit 0).
  let financeCfg = cfg;
  if (!financeCfg) { try { financeCfg = (require('../../user-config.js') as typeof import('../../user-config.js')).getUserConfig(); } catch { /* fail-soft */ } }
  const shared = (require('../../agent/shared-app-tools.js') as typeof import('../../agent/shared-app-tools.js')).buildSharedAppTools(financeCfg);
  // ⑩ nest-cap — 이 프로세스가 이미 상한 깊이면 자식-spawn 툴을 카탈로그에서 제외(액자 폭주 차단).
  // 깊이는 프로세스 부팅 시 env 로 고정되므로 여기서 1회 평가로 충분.
  const capped = nestCapReached();
  if (capped) debug.log('substrate.nest', 'surface-capped', nestInfo(), { level: 'warn' });
  const chatSpecs: LLMToolSpec[] = [
    ...readonlySpecs,
    buildEditTool(),
    buildWriteTool(),
    buildBashTool(),
    ...(capped ? [] : [buildDelegateAgentTool()]), // spawn 툴 — 상한 도달 시 제외
    // 🆕 SelfImplement (2026-09-07 · 대표) — PWA·안드로이드·iOS 챗에서도 부를 수 있다.
    //   ⭐ 왜 여기로 내려왔나: 이 툴은 «헤드리스 자식»을 띄운다 — ***부르는 쪽에 PTY 가 필요 없다.***
    //      webterm 에만 있던 것은 능력의 제약이 아니라 «문이 없던 것»이었다
    //      (webterm 의 다른 배틀쉽 셋과 달리 이 툴은 WebTerminal* 에 의존하지 않는다).
    //   ⛔ 안전 장치는 형제들과 «같은 조건»으로 건다 — nest-cap(액자 폭주 차단).
    //      ⊕ PR open 은 그대로 fail-closed HITL 이다(approver 미주입 시 절대 안 열린다).
    ...(capped ? [] : [buildSelfImplementDaemonSpec()]),
    // 🆕 AskUserQuestion (2026-09-08) — ⛔ `#16003` 이 챗에 SelfImplement 를 열었는데
    //    ***자식이 「물을」 도구는 «안 열었다».*** 그래서 챗에서 띄운 구현이 막히면
    //    사람에게 되물을 길이 없이 멈춘다.
    //   📏 그 결손이 수로도 보였다 — `ask-user-question.dispatch` 가 30일에 «4행»이었다(`OBS-T419`).
    //   ⭐ 재발명하지 않는다: `askUserQuestionRuntime` 이 spec ⊕ dispatch 를 한 묶음으로 «이미» 갖고 있고,
    //      ACP 브릿지 → SSE 채널 순의 사다리도 그 안에서 이미 돈다(`#16031`).
    askUserQuestionRuntime.spec,
    ...ACP_SESSION_RUNTIMES.map((runtime) => runtime.spec),
    ...shared.specs, // L2 core + L3 finance(gated) — buildSharedAppTools 단일 출처(전 서피스 공용)
  ];

  /** Shared dispatcher for chat-surface tools. Reused by 'chat' AND
   *  'webterm' so the routing stays in one place. */
  const dispatchChatTool = async (
    name: string,
    args: Record<string, unknown>,
    ctx: DaemonToolDispatchCtx,
  ): Promise<unknown> => {
    if (READONLY_TOOL_NAMES.has(name)) {
      switch (name) {
        case 'Read':
          return dispatchRead(args as unknown as Parameters<typeof dispatchRead>[0], ctx);
        case 'Grep':
          return dispatchGrep(args as unknown as Parameters<typeof dispatchGrep>[0], ctx);
        case 'WebSearch':
          return dispatchWebSearch(args as unknown as Parameters<typeof dispatchWebSearch>[0], ctx);
        case 'Plan':
          return dispatchPlan(args as unknown as Parameters<typeof dispatchPlan>[0], ctx);
        case 'MarkStepDone':
          return dispatchMarkStepDone(args as unknown as Parameters<typeof dispatchMarkStepDone>[0], ctx);
      }
    }
    if (name === 'Edit') {
      return dispatchEdit(args as unknown as Parameters<typeof dispatchEdit>[0], writeDispatchCtx(ctx));
    }
    if (name === 'Write') {
      return dispatchWrite(args as unknown as Parameters<typeof dispatchWrite>[0], writeDispatchCtx(ctx));
    }
    if (name === 'delegate_code_agent') {
      if (nestCapReached()) {
        debug.log('substrate.nest', 'spawn-refused', { tool: name, ...nestInfo() }, { level: 'warn' });
        return { error: `nest-cap: 재귀 상한(${nestInfo().max}중) 도달 — delegate_code_agent 비활성(액자 폭주 방지)` };
      }
      return dispatchDelegateAgent(args, ctx);
    }
    const acpRuntime = ACP_SESSION_RUNTIMES.find((runtime) => runtime.spec.name === name);
    if (acpRuntime) {
      try {
        return await acpRuntime.run(args, {
          surface: 'tui',
          ...(ctx.requestOrigin ? { requestOrigin: ctx.requestOrigin } : {}),
        });
      } catch (error) {
        if (error instanceof ClaudeSubscriptionNotAllowedError) return { error: error.message };
        throw error;
      }
    }
    if (shared.names.has(name)) {
      return shared.dispatch(name, args); // L2 core + L3 finance(gated) — buildSharedAppTools 단일 dispatch
    }
    if (name === 'Bash') {
      // PLAN-ios-rich-dev-feedback-hydrate M3 (2026-05-13) — pass
      // sessionId + emitFeedback so dispatchBash emits tool.progress
      // envelopes (start/delta/end · 80ms coalescing). iOS chat
      // ToolProgressCardView 가 stream label + lines preview + exit
      // code 시각화.
      return dispatchBash(args, {
        cwd: writeDispatchCtx(ctx).cwd,
        signal: ctx.signal,
        ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
        ...(ctx.emitFeedback ? { emitFeedback: ctx.emitFeedback } : {}),
        ...(ctx.toolCallId ? { toolCallId: ctx.toolCallId } : {}),
      });
    }
    return null;
  };

  const chatLive = liveMcpSpecs(chatSpecs);

  if (kind === 'chat') {
    recordToolCatalog(null, 'daemon-tools', toolSurface, chatLive.specs());
    return {
      kind: 'chat',
      // ⛔ getter 다 — 배열로 굳히면 부팅 뒤 붙는 서버가 영영 안 보인다(위 liveMcpSpecs 주석).
      get specs() { return chatLive.specs(); },
      async dispatch(
        name: string,
        args: Record<string, unknown>,
        ctx: DaemonToolDispatchCtx,
      ): Promise<unknown> {
        if (isToolSearchCall(name)) return routeToolSearch(args, chatLive.specs(), { surface: 'daemon-chat' });
        const chatRegistryName = chatLive.registryNameOf(name);
        if (chatRegistryName) return dispatchDaemonMcpRuntime(chatRegistryName, args, ctx);
        const result = await dispatchChatTool(name, args, ctx);
        if (result !== null) return result;
        // 🆕 SelfImplement — spec 을 실었으면 dispatch 도 «같은 자리»에 있어야 한다.
        //   ⛔ 스펙만 싣고 여기를 빼면 모델이 툴을 «보고 부르는데» 표면이 모른다고 던진다
        //      — 오늘 이 저장소에서 여러 번 나온 「만들었다 ≠ 흐른다」 꼴이다.
        // 🆕 AskUserQuestion — ⭐ `sessionId` 를 «반드시» 넘긴다.
        //   ⛔ 없으면 ACP 브릿지가 `AskBridgeUnavailable('no sessionId')` 로 즉시 죽고,
        //      그러면 이 표면의 사람에게는 물음이 «영영 안 간다».
        if (name === askUserQuestionRuntime.spec.name || name === 'AskUserQuestion') {
          return (await askUserQuestionRuntime.run(args, {
            surface: 'chat',
            ...(ctx.sessionId === undefined ? {} : { sessionId: ctx.sessionId }),
            signal: ctx.signal,
          } as never)).output;
        }
        if ((SELF_IMPLEMENT_TOOL_NAMES as readonly string[]).includes(name)) {
          if (nestCapReached()) {
            debug.log('substrate.nest', 'spawn-refused', { tool: name, ...nestInfo() }, { level: 'warn' });
            return { error: `nest-cap: 재귀 상한(${nestInfo().max}중) 도달 — SelfImplement 비활성(액자 폭주 방지)` };
          }
          return dispatchSelfImplement(args, ctx);
        }
        throw new ToolSafetyError(
          'unavailable',
          `daemon chat surface does not know tool '${name}' (allowed: Read, Grep, WebSearch, Plan, MarkStepDone, Edit, Bash, SelfImplement, AskUserQuestion). For interactive PTY tools, opt-in to '--tools webterm'.`,
        );
      },
    };
  }

  // 'webterm' — chat surface + WebTerminal* triple + LiveCameraFrame.
  // Operator opts in explicitly via `--tools webterm` because
  // WebTerminalInput sends raw bytes to a PTY — heavier risk surface
  // than the request-response 'chat' baseline.
  const webtermStaticSpecs: LLMToolSpec[] = [
    ...chatSpecs,
    // Browser tools are static daemon routes; MCP joining below remains only
    // for dynamically connected proxy tools.
    buildBrowserNavigateTool(),
    buildBrowserReadTool(),
    // ⛔ SelfImplement 는 «여기서 다시 싣지 않는다» — 위 `...chatSpecs` 가 이미 담고 있다
    //   (2026-09-07 챗 표면으로 내려왔다). 🩸 두 번 실으면 «같은 이름이 카탈로그에 둘»이 되고,
    //   이 저장소는 그 꼴로 비-codex 프로바이더가 400 을 내는 것을 이미 겪었다.
    //   ⇒ 시험 `챗과 webterm 이 «같은» SelfImplement 를 본다` 가 이 중복을 문다.
    ...(capped || !isDevHarnessModelSurfaceEnabled() ? [] : [buildRunDevHarnessTool()]), // dev-harness front door(P→E→R→D·⑩ 상한/모델 표면 off 시 제외)
    ...(capped ? [] : [buildSolveMissionTool()]),         // 기존 미션 read-only solve(P3·⑩ 상한 시 제외)
    ...buildWebTerminalSpecs(),
    ...buildPtyShellSpecs(),
  ];
  const webtermLive = liveMcpSpecs(webtermStaticSpecs);

  recordToolCatalog(null, 'daemon-tools', toolSurface, webtermLive.specs());
  return {
    kind: 'webterm',
    // ⛔ getter — chat 과 같은 이유.
    get specs() { return webtermLive.specs(); },
    async dispatch(
      name: string,
      args: Record<string, unknown>,
      ctx: DaemonToolDispatchCtx,
    ): Promise<unknown> {
      // ⭐ 소환기 먼저 — webterm 이 defer 하는 배틀쉽(SelfImplement·RunDevHarness·
      //   SolveMission)의 스키마를 하이드레이트할 유일한 경로.
      if (isToolSearchCall(name)) return routeToolSearch(args, webtermLive.specs(), { surface: 'daemon-webterm' });
      const webtermRegistryName = webtermLive.registryNameOf(name);
      if (webtermRegistryName) return dispatchDaemonMcpRuntime(webtermRegistryName, args, ctx);
      if (name === 'BrowserNavigate') {
        return dispatchBrowserNavigate(args as unknown as Parameters<typeof dispatchBrowserNavigate>[0]);
      }
      if (name === 'BrowserRead') {
        return dispatchBrowserRead(args as Parameters<typeof dispatchBrowserRead>[0]);
      }
      // Reuse the chat-surface dispatcher for the readonly + Edit + Bash
      // subset; webterm only adds the WebTerminal* triple on top.
      const chatResult = await dispatchChatTool(name, args, ctx);
      if (chatResult !== null) return chatResult;
      // 🆕 AskUserQuestion — ⭐ `#16056` 이 spec 을 chatSpecs 에 실었고 webterm 은
      //    `...chatSpecs` 로 그걸 «본다». ⛔ 그런데 dispatch 갈래는 chat 쪽에만 있어
      //    모델이 부르면 `daemon webterm surface does not know tool 'AskUserQuestion'`
      //    으로 거절됐다(2026-09-08 실측). SelfImplement 가 이미 두 dispatcher 에
      //    각각 갈래를 두는 모양을 그대로 따른다 — 런타임은 복제하지 않는다.
      // ⭐ `sessionId` 를 «반드시» 넘긴다. 없으면 ACP 브릿지가 즉시 죽는다.
      if (name === askUserQuestionRuntime.spec.name || name === 'AskUserQuestion') {
        return (await askUserQuestionRuntime.run(args, {
          surface: 'webterm',
          ...(ctx.sessionId === undefined ? {} : { sessionId: ctx.sessionId }),
          signal: ctx.signal,
        } as never)).output;
      }
      if ((SELF_IMPLEMENT_TOOL_NAMES as readonly string[]).includes(name)) {
        if (nestCapReached()) {
          debug.log('substrate.nest', 'spawn-refused', { tool: name, ...nestInfo() }, { level: 'warn' });
          return { error: `nest-cap: 재귀 상한(${nestInfo().max}중) 도달 — SelfImplement 비활성(액자 폭주 방지)` };
        }
        return dispatchSelfImplement(args, ctx);
      }
      if (name === 'RunDevHarness') {
        if (nestCapReached()) {
          debug.log('substrate.nest', 'spawn-refused', { tool: name, ...nestInfo() }, { level: 'warn' });
          return { error: `nest-cap: 재귀 상한(${nestInfo().max}중) 도달 — RunDevHarness 비활성(액자 폭주 방지)` };
        }
        // ★ #24 A — subprocess 위임(auto_drive on·데몬 이벤트루프 격리)은 dispatchRunDevHarness 내부에서
        //   판정한다(두 caller: 여기 + monad-agent-turn 직접호출 모두 커버·재귀 가드 ELANOUS_HARNESS_DETACHED).
        return dispatchRunDevHarness(args, ctx);
      }
      if (name === 'SolveMission') {
        if (nestCapReached()) {
          debug.log('substrate.nest', 'spawn-refused', { tool: name, ...nestInfo() }, { level: 'warn' });
          return { error: `nest-cap: 재귀 상한(${nestInfo().max}중) 도달 — SolveMission 비활성(액자 폭주 방지)` };
        }
        // subprocess 위임(#24 격리)은 dispatchSolveMission 내부 판정(RunDevHarness 동형).
        return dispatchSolveMission(args, ctx);
      }
      if ((WEB_TERMINAL_TOOL_NAMES as readonly string[]).includes(name)) {
        return dispatchWebTerminalTool(name, args, ctx);
      }
      if ((PTY_SHELL_TOOL_NAMES as readonly string[]).includes(name)) {
        return dispatchPtyShellTool(name, args, ctx);
      }
      throw new ToolSafetyError(
        'unavailable',
        `daemon webterm surface does not know tool '${name}' (allowed: Read, Grep, WebSearch, Plan, MarkStepDone, Edit, Bash, SelfImplement, AskUserQuestion, ${WEB_TERMINAL_TOOL_NAMES.join(', ')}, ${PTY_SHELL_TOOL_NAMES.join(', ')})`,
      );
    },
  };
}
