// src/autopilot/tool-registry.ts
//
// ROADMAP-elanous-builtin-autopilot-cascade §MB-2 (+ MB-6 + MB-11 + MB-13 polish).
//
// elanous-builtin autopilot 의 tool surface 추출. ACP backend 는 binary
// 내장 tool catalog (vendor 결정) 을 사용했지만, elanous-builtin path 는
// `src/tool-runtime/` 의 in-process registry 를 직접 활용 — elanous 가
// permission · 정의 변경 · 새 tool 추가를 native 통제.
//
// MB-14 expanded surface = 16 essentials:
//   File IO:
//   - Bash               (shell 실행 · terminal agency 시 G2 forwarder 통해 user pty redirect)
//   - Read / Edit / Write
//   Plan / HITL:
//   - update_plan        (LLM-driven plan revision · D1.4a 의 agent.plan 갱신)
//   - ask_user_question  (HITL 차단점 · M-track AskUserQuestion fabric)
//   Research:
//   - WebFetch           (URL → markdown)
//   - WebSearch          (provider-backed · Grok live-search 등)
//   Git workflow (MB-13):
//   - GitCommit          (local commit · sign / co-author 자동 포함)
//   - FindRepo           (omni-crawl markdown / WebFetch body 에서 GitHub repo 추출)
//   - SyncRepo           (~/source/ref/<owner>/<repo> 에 sparse clone · pull)
//   - RefConsult         (사용자 own ref 디렉토리에서 read · summarize)
//   - ToolSearch         (deferred tool catalog 의 lazy hydrate)
//   Web terminal (MB-14):
//   - WebTerminalSnapshot   (ANSI text snapshot · vim/tmux 등 fullscreen TUI 는 ANSI 불충분)
//   - WebTerminalInput      (terminal 에 byte 직접 inject · driver 의 forwarder 와 별 명시 path)
//   - WebTerminalScreenshot (PNG render · cursor · color · box-drawing 정확 — vision LLM 정합)
//
// 후속 cascade 의 확장 후보:
//   - open_pull_request · merge_pull_request (publish boundary — 별 cascade)
//   - worktree (filesystem layout 변경)
//   - browserNavigateRuntime · browserReadRuntime (Chrome CDP 의 deep
//     navigation · WebFetch 의 lite path 가 충분 시 skip)
//
// dispatch 는 `dispatchToolByName` 으로 위임 — guardian + verifier
// hook 그대로 적용. autopilot 의 surface 값은 `'tui'` 로 wire
// (in-process · 사용자 관찰 가능 · approval flow 와 호환).
//
// 본 helper 가 모르는 정책 (terminal agency forwarder · risky pattern
// gate) 은 `AutopilotLoopDriver` 의 onUpdate seam (G2/G3/G4) 가 backend-
// agnostic 으로 처리 — 본 helper 는 surface 만 책임.

import type { CoreTurnDispatchTool } from '../core-turn/types.js';
import type { LLMToolSpec } from '../llm.js';
import { debug } from '../debug/log.js';
import { dispatchToolByName } from '../tool-runtime/registry.js';
import { bashRuntime } from '../tool-runtime/bash-runtime.js';
import {
  readRuntime,
  editRuntime,
  writeRuntime,
} from '../tool-runtime/code-edit-runtimes.js';
import { updatePlanRuntime } from '../tool-runtime/update-plan-runtime.js';
import { askUserQuestionRuntime } from '../tool-runtime/ask-user-question-runtime.js';
import { buildWebFetchTool, dispatchWebFetch } from '../skills/tools/webfetch.js';
import { buildWebSearchTool, dispatchWebSearch } from '../skills/tools/web-search.js';
import { gitCommitRuntime } from '../tool-runtime/git-commit-runtime.js';
import { findRepoRuntime } from '../tool-runtime/find-repo-runtime.js';
import { syncRepoRuntime } from '../tool-runtime/sync-repo-runtime.js';
import { refConsultRuntime } from '../tool-runtime/ref-consult-runtime.js';
import { toolSearchRuntime } from '../tool-runtime/tool-search-runtime.js';
import {
  webTerminalSnapshotRuntime,
  webTerminalInputRuntime,
} from '../tool-runtime/web-terminal-runtimes.js';
import { webTerminalScreenshotRuntime } from '../tool-runtime/web-terminal-screenshot.js';
// MB — native STRUCTURED SEARCH on the mission surface (Grep/Glob/ListDir).
// Direct-dispatch (SEARCH_TOOL_DISPATCHERS below) mirroring the web tools, so
// the mission tool loop can search structurally instead of burning turns on
// `Bash grep` (which the exploration-budget accounting does not count). Kept
// inside this file to avoid the shared ToolRuntime registry (tool-runtime/
// index.ts has pre-existing tsc errors that would trip touch-clean).
import { buildGrepTool, dispatchGrep } from '../skills/tools/grep.js';
import { buildGlobTool, dispatchGlob } from '../skills/tools/glob.js';
import { buildListDirTool, dispatchListDir } from '../skills/tools/list-dir.js';
// Active 자기인지(제1원칙) — 미션 agent 가 실행 중 자기 상태를 **능동 조회**.
// 그간 미션은 자기 로그/기억/ops 를 직접 못 물어봤다(passive 주입만). READ-ONLY
// 자기관측 4종을 코어툴에서 골라 노출(SEARCH_TOOL_DISPATCHERS 와 동형 직접
// dispatch). mutating 코어툴(schedule_manage·session-delete·mission_decide)은
// 제외 — 미션 실행 중 자기 상태 '변경'은 부적절, '관측'만.
import { SELF_COGNITION_RUNTIMES, SELF_COGNITION_TOOL_NAMES } from '../tool-runtime/self-cognition-runtimes.js';
import type { ToolRuntime, ToolRuntimeContext } from '../tool-runtime/types.js';

/** 미션 실행 중 능동 자기조회 — READ-ONLY 자기관측 4종.
 *  self_recall(elanous 구현 이력)·logs_query(자기 로그)·ops_status(운영 상태)·
 *  memory_recall(크로스서피스 기억). 코어툴 dispatch 재사용. */
const selfCognitionRuntimeByName = new Map(
  SELF_COGNITION_RUNTIMES.map(runtime => [runtime.id, runtime]),
);

/** MB-11 — autopilot path 에서 추가 wire 한 web tools. ToolRuntime 으로
 *  포팅 안 됐기에 직접 dispatch 함수 호출. dispatchToolByName 의 guardian
 *  /verifier hook 우회 — autopilot 의 boundary 책임 (driver 의 risky-pattern
 *  + URL allowlist 가 향후 polish 시 추가 가능). */
const WEB_TOOL_DISPATCHERS: Record<
  string,
  (args: Record<string, unknown>, ctx: { signal?: AbortSignal }) => Promise<unknown>
> = {
  WebFetch: (args, ctx) => dispatchWebFetch(args, ctx),
  WebSearch: (args, ctx) => dispatchWebSearch(args, ctx),
};

/** Native structured-search tools direct-dispatched on the mission surface
 *  (same bypass rationale as WEB_TOOL_DISPATCHERS). Dispatchers take `(args)`
 *  only. Keys MUST match each builder's `spec.name` (Grep/Glob/ListDir). */
const SEARCH_TOOL_DISPATCHERS: Record<
  string,
  (args: Record<string, unknown>) => Promise<unknown>
> = {
  Grep: (args) => dispatchGrep(args),
  Glob: (args) => dispatchGlob(args),
  ListDir: (args) => dispatchListDir(args),
};

export interface AutopilotToolRegistryOptions {
  /** Surface forwarded to `dispatchToolByName`. autopilot defaults to
   *  `'tui'` — in-process + user observable. Override only for
   *  tests / replay harnesses. */
  surface?: ToolRuntimeContext['surface'];
  /** Forwarded to dispatched runtimes via `ToolRuntimeContext.sessionId`
   *  so session-scoped registries (preview-tap-registry · kgs) resolve
   *  the right scope. */
  sessionId?: string;
  /** Optional FeedbackEnvelope sink. Mirrors `ToolRuntimeContext.emitFeedback`
   *  so progressive cards (bash tail · edit diff) reach PWA / iOS sinks
   *  when autopilot runs alongside a chat surface. */
  emitFeedback?: ToolRuntimeContext['emitFeedback'];
  /** AbortSignal forwarded to the runtimes' streaming side effects
   *  (bash output tail, fetch) so cancel propagates through. */
  signal?: AbortSignal;
}

/**
 * Returns the curated autopilot tool surface for the elanous-builtin
 * path — both the `LLMToolSpec[]` advertised to the model and the
 * `dispatchTool` callback `runCoreTurn` invokes when the model picks
 * one.
 *
 * Tool surface is intentionally narrow (no intent-based filtering á la
 * `buildSessionRuntimeToolSpecs`) so mission behavior is reproducible
 * across the same prompt across runs.
 */
export function getAutopilotToolRegistry(
  opts: AutopilotToolRegistryOptions = {},
): { tools: LLMToolSpec[]; dispatchTool: CoreTurnDispatchTool } {
  const surface = opts.surface ?? 'tui';
  const runtimes = [
    bashRuntime,
    readRuntime,
    editRuntime,
    writeRuntime,
    updatePlanRuntime,
    askUserQuestionRuntime,
    // MB-13 — git workflow + research helpers.
    gitCommitRuntime,
    findRepoRuntime,
    syncRepoRuntime,
    refConsultRuntime,
    toolSearchRuntime,
    // MB-14 — web-terminal tools. terminal agency mode 의 LLM 이 명시
    // snapshot · screenshot · input 가능. driver 의 auto-screenshot (G3)
    // 은 매 forward 후만 트리거 — 본 tool 으로 사용자 입력 외 시점도 query.
    webTerminalSnapshotRuntime(),
    webTerminalInputRuntime(),
    webTerminalScreenshotRuntime() as unknown as ToolRuntime,
  ] as const;
  // MB-11 — web tools 는 ToolRuntime 으로 포팅 안 됐기에 spec 직접 build.
  const tools: LLMToolSpec[] = [
    ...runtimes.map((rt) => rt.spec),
    buildWebFetchTool(),
    buildWebSearchTool(),
    buildGrepTool(),
    buildGlobTool(),
    buildListDirTool(),
    // Active 자기인지 — self_recall·logs_query·ops_status·memory_recall.
    ...SELF_COGNITION_RUNTIMES.map(runtime => runtime.spec),
  ];

  const dispatchTool: CoreTurnDispatchTool = async (name, args, ctx) => {
    // 관측 always-on (제1원칙 — 자율 미션 로직엔 관측 필수·관측성 스스로 증가).
    // 미션이 실제 호출한 tool 은 **tool-set 최적성 판단·누락/사각 발견의 유일
    // 근거**다(2026-07-17 검토: debug.enabled 게이트라 프로덕션 autopilot.tool
    // 0건 → 근거 없이 최적화 불가였음). toolName 만 always-on(sink live 시
    // logs.db 기록·PII 없음). argKeys/callId 등 축상세는 diag 게이트.
    debug.log('autopilot.tool', 'dispatch', { toolName: name });
    if (debug.enabled) {
      debug.log('autopilot.tool', 'dispatch.detail', {
        toolName: name,
        argKeys: Object.keys(args ?? {}),
        callId: ctx?.callId ?? null,
        turnIndex: ctx?.turnIndex ?? null,
      });
    }
    // MB-11 — web tools 직접 dispatch (guardian/verifier 우회). 다른 tool
    // 은 registry 경유.
    const webDispatch = WEB_TOOL_DISPATCHERS[name];
    if (webDispatch) {
      return webDispatch(args, {
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      });
    }
    const searchDispatch = SEARCH_TOOL_DISPATCHERS[name];
    if (searchDispatch) return searchDispatch(args);
    // Active 자기인지 — READ-ONLY 자기관측 코어툴 직접 dispatch(코어툴 재사용).
    const selfCognitionRuntime = selfCognitionRuntimeByName.get(name);
    if (selfCognitionRuntime) {
      return selfCognitionRuntime.run(args, { surface });
    }
    const runtimeCtx: ToolRuntimeContext = {
      surface,
      // L1 self-dev — autopilot 미션 실행기는 헤드리스 자율 코딩 컨텍스트다
      // (터미널 응답자 없음). 코딩툴(PtyShell) 승인이 필요할 때 응답자 부재로
      // 120s hang → reject 로 루프가 깨지지 않게 fail-OPEN(진행). PtyShell 만
      // 이 플래그를 읽으므로 coding-tool 스코프이며, 매매/금융 HITL 경로는
      // 이 dispatch 를 타지 않아 fail-CLOSED 불변. 관측=logs.db hitl.fail-open.
      failOpen: true,
      ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
      ...(opts.emitFeedback !== undefined ? { emitFeedback: opts.emitFeedback } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...(ctx?.callId !== undefined ? { toolCallId: ctx.callId } : {}),
    };
    return dispatchToolByName(name, args, runtimeCtx);
  };

  return { tools, dispatchTool };
}

/**
 * Stable tool **names** the autopilot surface exposes (matches each
 * runtime's `spec.name`). Tests + downstream MB-3 wire assert against
 * this list without re-enumerating the `LLMToolSpec[]` shape.
 *
 * MB-6 expanded 4 → 6: + `update_plan` + `ask_user_question`.
 * MB-11 expanded 6 → 8: + `WebFetch` + `WebSearch` (research path).
 * MB-13 expanded 8 → 13: + `GitCommit` · `FindRepo` · `SyncRepo` ·
 *   `RefConsult` · `ToolSearch` (git workflow + research helpers).
 * MB-14 expanded 13 → 16: + `WebTerminalSnapshot` · `WebTerminalInput` ·
 *   `WebTerminalScreenshot` (terminal agency 의 LLM-driven 명시 query).
 * Keep alphabetical so additions are obvious in diffs.
 */
export const AUTOPILOT_TOOL_IDS = [
  'AskUserQuestion',
  'Bash',
  'Edit',
  'FindRepo',
  'GitCommit',
  'Glob',
  'Grep',
  'ListDir',
  'Read',
  'RefConsult',
  'SyncRepo',
  'ToolSearch',
  'WebFetch',
  'WebSearch',
  'WebTerminalInput',
  'WebTerminalScreenshot',
  'WebTerminalSnapshot',
  'Write',
  'update_plan',
  // ★ #4475 미션 Active 자기관측 4종(제1원칙 self-cognition) — getAutopilotToolRegistry 가 surface.
  //   상수/테스트 미갱신으로 드리프트(AUTOPILOT_TOOL_IDS matches 실패)였던 것을 정합화.
  'logs_query',
  'memory_recall',
  'ops_status',
  'self_recall',
  // CTX2 #23185 — 맥락 한 문(READ-ONLY 자기관측 원장에 더해졌다).
  'context_now',
] as const;
