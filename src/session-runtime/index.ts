import { buildGitSnapshot } from '../git-fs/index.js';
import { debug } from '../debug/log.js';
import { getUserConfig } from '../user-config.js';
import { resolve } from 'node:path';
import type { ModelFamily } from '../models/prompts.js';
import type { InputSourceKind, InputSourceRef } from '../input/input-source-kind.js';
import { getSessionCwd } from '../session/working-dir.js';
import {
  armQuickControlOnce,
  consumeQuickControlOnce,
  createChatModeState,
  enterControlMode,
  exitControlMode,
  isControlMode,
  parseControlSlash,
  setPreferredSurface,
  toggleControlMode,
  type ChatModeState,
  type ControlSlashOutcome,
  type EnterModeOpts,
} from './posture.js';
import type { LLMMessage, LLMToolSpec } from '../llm.js';
import type { LLMToolDef } from '../plugins/core/types.js';
import type { ToolRunResult, ToolRuntime } from '../tool-runtime/types.js';
import { findNativeTool, isNativeToolModelExposed } from '../native-tool-catalog.js';
import { hasAstGrep } from '../skills/tools/ast-grep.js';
import { buildOmniSearchTool, omniSearchAvailable } from '../skills/tools/omni-search.js';
import { buildWebSearchTool } from '../skills/tools/web-search.js';
import { buildWebFetchTool } from '../skills/tools/webfetch.js';
import { buildSelfImplementDaemonSpec } from '../boot/daemon-tools/self-implement.js';
import { buildSelfOrchestrateSpec } from '../self-dev/self-orchestrate-runtime.js';
import { buildRunDevHarnessTool, isDevHarnessModelSurfaceEnabled } from '../skills/tools/dev-harness.js';
import { buildReadTool, dispatchRead } from '../skills/tools/read.js';
import { buildGrepTool, dispatchGrep } from '../skills/tools/grep.js';
import { buildGlobTool, dispatchGlob } from '../skills/tools/glob.js';
import { buildListDirTool, dispatchListDir } from '../skills/tools/list-dir.js';
import { buildEditTool, dispatchEdit } from '../skills/tools/edit.js';
import { buildWriteTool, dispatchWrite } from '../skills/tools/write.js';
import { buildAgentTool, dispatchAgent } from '../skills/tools/agent.js';
import { buildAgentListTool, dispatchAgentList } from '../agent/agent-list-tool.js';
import { buildAgentOutputTool, dispatchAgentOutput } from '../agent/agent-output-tool.js';
import { buildAgentStopTool, dispatchAgentStop } from '../agent/agent-stop-tool.js';
import { buildAgentReplyTool, dispatchAgentReply } from '../skills/tools/agent-reply.js';
import { dispatchAutonomousTool, isAutonomousTool } from '../agent/autonomous-tools.js';
import type { PathPolicy } from '../agent/path-policy.js';
import type { FeedbackEnvelope } from '../feedback/envelope.js';
import {
  probeLanguageBinary,
  resolveLanguageByName,
  type LspLanguageName,
} from '../skills/tools/lsp/server-registry.js';
import { getAvailableWebSearchProviders } from '../web-search/index.js';
import {
  createSearchPlannerState,
  handleRepeatedCandidateListing,
  rememberCandidateListingResult,
  type SearchPlannerState,
} from './search-processor.js';
export { createSearchPlannerState, type SearchPlannerState } from './search-processor.js';
export {
  splitDeferredToolSpecs,
  buildDeferredToolsPromptBlock,
  type DeferredToolEntry,
  type TierSplitResult,
} from './tier-flip.js';
export {
  fetchApiWithRetry,
  ApiHttpError,
  OverloadFailoverError,
  recordLlmCallOutcome,
  type FetchApiWithRetryOpts,
} from './retry-api.js';

export type SessionDomain = 'coding' | 'research' | 'control' | 'ops' | 'docs';
export type SessionExecutionStyle = 'turn' | 'agent';
export type SessionSurfaceId =
  | 'coding/turn'
  | 'coding/agent'
  | 'research/turn'
  | 'research/agent'
  | 'control/agent'
  | 'ops-ui/agent'
  | 'ops-fleet/agent';

export interface SessionSurfaceProfile {
  id: SessionSurfaceId;
  /** Resolver branch that selected this profile for the current turn. */
  selectionReason: string;
  domain: SessionDomain;
  executionStyle: SessionExecutionStyle;
  description: string;
  baselineContexts: readonly string[];
  defaultHostFamilyIds: readonly string[];
  defaultRuntimeFamilyIds: readonly string[];
  defaultNativeFamilyIds: readonly string[];
}

export interface SessionToolFamilySummary {
  id: string;
  kind: 'host' | 'runtime' | 'native';
  description: string;
  toolNames: readonly string[];
}

export interface SessionSurfaceSummary {
  surface: SessionSurfaceProfile;
  baselineContexts: readonly string[];
  defaultFamilies: readonly SessionToolFamilySummary[];
  conditionalFamilies: readonly SessionToolFamilySummary[];
}

export interface BuildSessionSurfaceManualSectionsOpts {
  surface: SessionSurfaceProfile;
  surfaceSelectionMode?: 'auto' | 'fixed';
  preferredSurfaceId?: string | null;
}

export interface SessionTurnProfile {
  surface: SessionSurfaceProfile;
  activeIntent: string | null;
  preferredSurfaceId: SessionSurfaceId | null;
  surfaceSelectionMode: 'auto' | 'fixed';
  shouldInjectControlManual: boolean;
  inputMode: 'general' | 'control';
  inputSource: InputSourceRef | null;
  inputSourceKind: InputSourceKind | null;
}

export interface SessionModeSnapshot {
  rawMode: ChatModeState['mode'];
  activeIntent: string | null;
  isControlActive: boolean;
  preferredSurfaceId: string | null;
  surfaceSelectionMode: 'auto' | 'fixed';
  statusLabel: string;
  hudLabel: string;
}

export interface SessionSurfaceStatusSnapshot {
  mode: SessionModeSnapshot;
  currentSurfaceId: SessionSurfaceId;
  preferredSurfaceId: SessionSurfaceId | null;
  surfaceSelectionMode: 'auto' | 'fixed';
  inputMode: 'general' | 'control';
}

export type SessionSurfaceSlashOutcome =
  | { kind: 'status' }
  | { kind: 'clear' }
  | { kind: 'set'; surfaceId: SessionSurfaceId }
  | { kind: 'error'; message: string };
export type SessionPostureState = ChatModeState;
export type SessionPosture = 'general' | 'control';

export interface SessionPostureSnapshot {
  persistentPosture: SessionPosture;
  activePosture: SessionPosture;
  activeIntent: string | null;
  preferredSurfaceId: string | null;
  isQuickControlArmed: boolean;
}

export interface SessionRuntimeDispatchDeps {
  signal?: AbortSignal;
  /** Current LLM tool call, for correlating a foreground harness stop target with the TUI call. */
  toolCallId?: string;
  userText?: string;
  modelFamily?: ModelFamily;
  /** Parent Agent capability context for an inline runtime fallback. */
  agentHostTools?: LLMToolSpec[];
  agentDispatchTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  buildChildToolCatalog?: (cwd: string) => {
    specs: LLMToolSpec[];
    dispatch: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    workingDirectory: string;
  };
  searchPlannerState?: SearchPlannerState;
  /** CC (2026-04-25) — forwarded from the LLM router's dispatch ctx
   *  (`turnIndex`). Lets the planner allow same-turn parallel fan-out
   *  while still blocking cross-turn broad-search repeats. */
  turnIndex?: number;
  ptyDashboardOn?: boolean;
  // Surface-unification v2.2 V2.2-5 Part 2 (2026-05-11) — scheduler tool
  // dispatch deps (isSchedulerTool / dispatchSchedulerTool) retired.
  // scheduler-retirement R1 의 LLM tool unwire 후 모두 no-op stub 였고
  // 본 PR 에서 정식 폐기.
  getToolRuntime(name: string): ToolRuntime<Record<string, unknown>, ToolRunResult> | undefined;
  dispatchToolRuntime(name: string, args: Record<string, unknown>, toolCallId?: string): Promise<unknown>;
  dispatchPluginTool(name: string, args: Record<string, unknown>): Promise<
    { ok: true; result: unknown } | { ok: false; error: string }
  >;
  dispatchNativeTool?(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  /** Optional test seam; production dispatch uses the established autonomous-tools helper. */
  dispatchAutonomousTool?(name: string, args: Record<string, unknown>, ctx: {
    cwd: string;
    signal: AbortSignal;
    userText?: string;
    emitFeedback?: (envelope: FeedbackEnvelope) => void;
  }): Promise<unknown>;
  /** Parent-surface feedback carrier for autonomous-tool progress envelopes. */
  emitFeedback?: (envelope: FeedbackEnvelope) => void;
  /** ★ turn 조립기 통일 Phase 4b(2026-07-22) — fs-tool(Read/Edit/Write) 경로 보안 정책. 서피스
   *  트러스트별로 주입: 로컬 CLI=미지정(permissive) · 원격 메신저(telegram/discord)=strict(cwd-앵커+
   *  credential deny-list). 미지정 시 각 tool 이 permissive 로 폴백(현행 무변경). */
  pathPolicy?: PathPolicy;
}

interface SessionToolFamilyRule {
  id: string;
  description: string;
  names: readonly string[];
  match(text: string): boolean;
  isAvailable?(toolName: string): boolean;
}

const SESSION_TOOL_FAMILY_RULES: SessionToolFamilyRule[] = [
  {
    id: 'structural-search',
    description: 'Structural code search for syntax-aware pattern matching.',
    names: ['ast_grep_search'],
    match: (text) => hasAny(text, [
      'ast-grep',
      'ast_grep',
      'syntax',
      'structural search',
      'structural grep',
      'syntax-aware',
      'ast pattern',
      '구조 검색',
      '구문 검색',
      'ast 검색',
    ]),
    isAvailable: () => hasAstGrep(),
  },
  {
    id: 'code-intel',
    description: 'Semantic code intelligence for definitions, references, and symbols.',
    names: ['Lsp'],
    match: (text) => hasExplicitLspIntent(text),
    isAvailable: () => isLspAvailable(),
  },
  {
    id: 'ui-inspect',
    description: 'Read-only Elanous UI and pane/view inspection.',
    names: ['view_getConfig', 'pane_getState'],
    match: (text) => hasAny(text, [
      'view state',
      'pane state',
      'layout state',
      'current layout',
      'current pane',
      '현재 상태',
      '레이아웃 상태',
      'pane 상태',
      'view 상태',
    ]),
  },
  {
    id: 'ui-mutate',
    description: 'Mutating Elanous UI and pane/view layout control.',
    names: [
      'view_setActive',
      'view_applyRuntimeConfig',
      'view_saveConfig',
      'view_resetConfig',
      'pane_close',
      'pane_open',
      'pane_openModal',
      'pane_setOmitOrder',
    ],
    match: (text) => hasAny(text, [
      'set active view',
      'apply layout',
      'save layout',
      'reset layout',
      'open pane',
      'close pane',
      'open modal',
      'omit order',
      '활성 뷰',
      '레이아웃 적용',
      '레이아웃 저장',
      '레이아웃 리셋',
      'pane 열어',
      'pane 닫아',
      '모달 열어',
      'omit order',
    ]),
  },
  {
    id: 'ui-control',
    description: 'Elanous UI and pane/view layout control.',
    names: [
      'view_getConfig',
      'view_setActive',
      'view_applyRuntimeConfig',
      'view_saveConfig',
      'view_resetConfig',
      'pane_getState',
      'pane_close',
      'pane_open',
      'pane_openModal',
      'pane_setOmitOrder',
    ],
    match: (text) => hasAny(text, [
      'view',
      'pane',
      'layout',
      'dashboard',
      'modal',
      'split',
      'omit order',
      '뷰',
      '패널',
      '레이아웃',
      '모달',
      '분할',
    ]),
  },
  {
    id: 'prompt-ops',
    description: 'Prompt-bank and injection runtime control.',
    names: [
      'prompt_search',
      'prompt_get',
      'prompt_create',
      'prompt_update',
      'prompt_delete',
      'prompt_setEnabled',
      'prompt_getRuntimeConfig',
      'prompt_setRuntimeConfig',
      'prompt_selectForState',
      'prompt_injectOnce',
      'prompt_explainInjection',
    ],
    match: (text) => hasAny(text, [
      'prompt bank',
      'prompt',
      'system prompt',
      'injection',
      '프롬프트',
      '주입',
    ]),
  },
  {
    // ★ self-ops (P3 · 2026-07-13) — elanous 자기 상황판단 3박자의 '툴' 축. 텔레그램/데몬챗이
    //   무조건 싣는 L2 코어(core-tools.ts CORE_TOOL_SPECS)를 TUI 채팅에도 — 미션 진단
    //   ("P2 왜 실패?")·자율 시스템 관측·기억 회상이 표면 무관하게 성립. 이름은 core-tools 와
    //   계약(문자열 안정) — session-runtime 이 domains 를 import 하지 않도록 하드코딩.
    id: 'self-ops',
    description: 'Elanous self-awareness and autonomous-system observability (missions, ops, memory, sessions, schedules).',
    names: [
      'ops_status',
      'autopilot_missions',
      'self_recall',
      'memory_recall',
      'session_manage',
      'schedule_manage',
      'fact_check',
      'se_build', // SE 격리 빌드 관측(B2 · #3990) — 빌드 안 뭐 하나·로그 tail·worktree diff
    ],
    match: (text) => hasAny(text, [
      'mission', 'ops', 'autopilot', 'recall', 'schedule', 'cron', 'build',
      '미션', '페이즈', '자율', '오토파일럿', '스케줄', '크론', '진단', '빌드',
      '왜 실패', '기억', '회상', '알림', '이상 없', '뭐 돌', '뭐 하는 중',
    ]),
  },
  {
    id: 'release-read',
    description: 'Read-only release status, features, cells, schedules, and current operations.',
    names: ['release_status', 'context_now'],
    match: (text) => hasAny(text, [
      'release', 'version', 'checklist', '발행', '버전', '릴리스', '피처',
      '체크리스트', '칸', '컷', '일정', '판올림', '다음 판', '이번 판', '운영 상태',
    ]),
  },
  {
    id: 'runtime-debug',
    description: 'Runtime inspection, traces, and input/debug history.',
    names: [
      'debug_getState',
      'debug_getCallStack',
      'debug_getAgentState',
      'debug_getLastLlm',
      'input_history_search',
      'input_history_list',
      'debug_setLevel',
      'debug_openView',
      'debug_selectEvent',
    ],
    match: (text) => hasAny(text, [
      'debug',
      'trace',
      'call stack',
      'event log',
      'llm request',
      'history',
      'input history',
      '디버그',
      '트레이스',
      '콜스택',
      '이벤트 로그',
      '입력 히스토리',
    ]),
  },
];

const TOOL_NAME_TO_FAMILY = new Map<string, SessionToolFamilyRule>(
  SESSION_TOOL_FAMILY_RULES.flatMap(rule => rule.names.map(name => [name, rule] as const)),
);

/** Names belonging to the runtime-debug family — used by the
 *  exposeFullLlmTools=false post-filter to know which tools to drop. */
const RUNTIME_DEBUG_FAMILY_NAMES: ReadonlySet<string> = new Set(
  SESSION_TOOL_FAMILY_RULES.find(r => r.id === 'runtime-debug')?.names ?? [],
);

/** Read-only inspection tools kept alive when minimal mode is on.
 *  Roughly half of the 9-entry runtime-debug family — picked by
 *  chatlog-triage value and gated to read-only-and-safe operations.
 *  Excluded by design (LLM-mutating or UI-stealing):
 *    debug_setLevel    — would let the LLM crank logs to keytrace,
 *                        flooding the file sink during a triage.
 *    debug_openView    — server-side cousin of the user-pressed
 *                        Ctrl+digit shortcut that already annoyed
 *                        the user (incident 2026-05-04).
 *    debug_selectEvent — UI-cursor mutation; steals focus from the
 *                        human reviewer.
 *    input_history_list — redundant with input_history_search.
 *  Leaves the LLM with enough surface to triage chatlogs without
 *  the surface area that lets it disrupt the live session. */
const RUNTIME_DEBUG_MINIMAL_KEEP: ReadonlySet<string> = new Set([
  'debug_getLastLlm',     // last request/response pair
  'debug_getState',       // event-buffer + stats dump
  'debug_getCallStack',   // call-path triage
  'debug_getAgentState',  // sub-agent queue inspection
  'input_history_search', // self-lookup of prior user inputs
]);

/** Drop runtime-debug tools (except the single essential one) when
 *  the user has set debug.exposeFullLlmTools=false. Other host tool
 *  families pass through untouched. Called at the tail of every host
 *  tool resolver so the gate applies uniformly across surfaces. */
function applyDebugMinimalFilter<T extends { name: string }>(tools: T[]): T[] {
  if (getUserConfig().debug.exposeFullLlmTools !== false) return tools;
  return tools.filter(t => {
    if (!RUNTIME_DEBUG_FAMILY_NAMES.has(t.name)) return true;
    return RUNTIME_DEBUG_MINIMAL_KEEP.has(t.name);
  });
}

interface SessionNativeToolRule {
  id: string;
  description: string;
  build(): LLMToolSpec;
  match(text: string): boolean;
  isAvailable?(toolName: string): boolean;
  dispatch?(
    args: Record<string, unknown>,
    signal?: AbortSignal,
    opts?: {
      pathPolicy?: PathPolicy;
      agentHostTools?: LLMToolSpec[];
      agentDispatchTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
      buildChildToolCatalog?: (cwd: string) => {
        specs: LLMToolSpec[];
        dispatch: (name: string, args: Record<string, unknown>) => Promise<unknown>;
        workingDirectory: string;
      };
    },
  ): Promise<unknown>;
  /** ⛔ Opt-IN to the ToolRuntime registry path instead of `dispatch` above.
   *
   *  Must stay opt-in, never a blanket "runtime wins if one exists" rule.
   *  `getToolRuntime` resolves aliases through the native catalog, so
   *  `Read`/`Edit`/`Write` DO resolve to the `read`/`edit`/`write` runtimes —
   *  a blanket preference silently routes them around `dispatch`, and with it
   *  around the `pathPolicy` argument that carries the Phase-4b surface-trust
   *  policy (remote messengers = strict: credential deny-list + cwd anchor).
   *  That is a security regression, not a refactor.
   *
   *  Set this only where the runtime path supplies context the rule signature
   *  cannot: the Agent family needs `ctx.agentHostTools` / `ctx.agentDispatchTool`
   *  so a sub-agent can call the parent's tools. */
  preferRuntime?: boolean;
}

interface SessionRuntimeToolFamilyRule {
  id: string;
  description: string;
  names: readonly string[];
  match(text: string): boolean;
}

const SESSION_NATIVE_TOOL_RULES: SessionNativeToolRule[] = [
  {
    id: 'code-read',
    description: 'Read a file from disk for coding and source analysis.',
    build: () => buildReadTool(),
    match: () => false,
    // ★ Phase 4b — 서피스 트러스트 정책 전파(원격 메신저=strict → credential deny-list·cwd-앵커).
    dispatch: async (args, _signal, opts) => await dispatchRead(args, { pathPolicy: opts?.pathPolicy }),
  },
  {
    id: 'code-grep',
    description: 'Search source text and symbols by pattern.',
    build: () => buildGrepTool(),
    match: () => false,
    // ★ Phase 4b PR3 — strict 시 검색 루트 검증 + 자격증명 파일 exclude(원격 메신저 우회 차단).
    dispatch: async (args, _signal, opts) => await dispatchGrep(args, { pathPolicy: opts?.pathPolicy }),
  },
  {
    id: 'code-glob',
    description: 'Find files by path pattern.',
    build: () => buildGlobTool(),
    match: () => false,
    dispatch: async (args) => await dispatchGlob(args),
  },
  {
    id: 'code-list-dir',
    description: 'List directory entries with metadata.',
    build: () => buildListDirTool(),
    match: () => false,
    dispatch: async (args) => await dispatchListDir(args),
  },
  {
    id: 'code-edit',
    description: 'Edit an existing file via exact-string replacement.',
    build: () => buildEditTool(),
    match: () => false,
    dispatch: async (args, _signal, opts) => await dispatchEdit(args, { pathPolicy: opts?.pathPolicy }),
  },
  {
    id: 'code-write',
    description: 'Create or overwrite a file.',
    build: () => buildWriteTool(),
    match: () => false,
    dispatch: async (args, _signal, opts) => await dispatchWrite(args, { pathPolicy: opts?.pathPolicy }),
  },
  {
    id: 'agent',
    description: 'Delegate focused work to a sub-agent in its own context window.',
    build: () => buildAgentTool(),
    match: () => false,
    dispatch: async (args, signal, opts) => await dispatchAgent(args, {
      signal,
      hostTools: opts?.agentHostTools,
      dispatchTool: opts?.agentDispatchTool,
      buildChildToolCatalog: opts?.buildChildToolCatalog,
    }),
    preferRuntime: true,
  },
  {
    id: 'agent-output',
    description: 'Retrieve the result of a background sub-agent task.',
    build: () => buildAgentOutputTool(),
    match: () => false,
    dispatch: async (args) => await dispatchAgentOutput(args),
    preferRuntime: true,
  },
  {
    id: 'agent-reply',
    description: 'Send a message to a live sub-agent session and collect its reply.',
    build: () => buildAgentReplyTool(),
    match: () => false,
    dispatch: async (args) => await dispatchAgentReply(args),
    preferRuntime: true,
  },
  {
    id: 'agent-stop',
    description: 'Cancel a running background sub-agent task.',
    build: () => buildAgentStopTool(),
    match: () => false,
    dispatch: async (args) => await dispatchAgentStop(args),
    preferRuntime: true,
  },
  {
    id: 'agent-list',
    description: 'List registered sub-agent definitions.',
    build: () => buildAgentListTool(),
    match: () => false,
    dispatch: async (args) => await dispatchAgentList(args),
    preferRuntime: true,
  },
  {
    id: 'self-implement',
    description: 'Implement a repository change autonomously in an isolated worktree.',
    build: () => buildSelfImplementDaemonSpec(),
    match: () => false,
  },
  {
    id: 'self-orchestrate',
    description: 'Develop multiple repository changes in parallel isolated worktrees.',
    build: () => buildSelfOrchestrateSpec(),
    match: () => false,
  },
  {
    id: 'dev-harness',
    description: 'Full staged development harness for isolated worktree implementation and review.',
    build: () => buildRunDevHarnessTool(),
    match: shouldExposeDevHarnessSessionTool,
  },
  {
    id: 'web-search',
    description: 'External web lookup for latest facts, verification, and official sources.',
    build: () => buildWebSearchTool(),
    // EXPOSURE(노출) — provider 명 포함 broad. surface flip 은 안 함(그건
    // resolveSessionSurfaceProfile 이 narrow hasWebSearchIntent 로 판단).
    match: (text) => hasWebSearchExposureIntent(text),
    isAvailable: () => getAvailableWebSearchProviders().length >= 1,
    dispatch: async (args, signal) => {
      const { dispatchWebSearch } = await import('../skills/tools/web-search.js');
      return await dispatchWebSearch(args, { signal });
    },
  },
  {
    id: 'deep-research',
    description: 'Multi-source research and triangulation across external signals.',
    build: () => buildOmniSearchTool(),
    match: (text) => hasResearchSearchIntent(text),
    isAvailable: () => omniSearchAvailable(),
    dispatch: async (args) => {
      const { dispatchOmniSearch } = await import('../skills/tools/omni-search.js');
      return await dispatchOmniSearch(args);
    },
  },
  {
    id: 'web-fetch',
    description: 'Read a concrete URL or page body directly.',
    build: () => buildWebFetchTool(),
    match: (text) => hasWebFetchIntent(text),
    dispatch: async (args, signal) => {
      const { dispatchWebFetch } = await import('../skills/tools/webfetch.js');
      return await dispatchWebFetch(args, { signal });
    },
  },
];

let nativeToolDispatchRules: Map<string, SessionNativeToolRule> | undefined;

function getNativeToolDispatchRules(): Map<string, SessionNativeToolRule> {
  return nativeToolDispatchRules ??= new Map<string, SessionNativeToolRule>(
    SESSION_NATIVE_TOOL_RULES.map(rule => [rule.build().name, rule] as const),
  );
}

const HOST_TOOL_FAMILY_RULE_MAP = new Map<string, SessionToolFamilyRule>(
  SESSION_TOOL_FAMILY_RULES.map(rule => [rule.id, rule] as const),
);

function isCodeGroundingModelSurfaceEnabled(): boolean {
  const config = getUserConfig();
  const configured = (config.raw.tools as Record<string, unknown> | undefined)?.nativeStructure;
  const source = configured
    && typeof configured === 'object'
    && typeof (configured as Record<string, unknown>).enabled === 'boolean'
    ? 'config'
    : 'default';
  const enabled = config.tools.nativeStructure.enabled === true;
  debug.log('tools.surface', 'code-grounding-exposure', { enabled, source });
  return enabled;
}

const SESSION_RUNTIME_TOOL_FAMILY_RULES: SessionRuntimeToolFamilyRule[] = [
  {
    id: 'fleet-core',
    description: 'Core fleet messaging and ACP session oversight runtimes.',
    names: [
      'send_message',
      'announce_completion',
      'acp_session_list',
      'acp_session_status',
    ],
    match: () => false,
  },
  {
    id: 'fleet-team',
    description: 'Team creation and deletion for fleet coordination.',
    names: ['team_create', 'team_delete'],
    match: () => false,
  },
  {
    id: 'fleet-budget',
    description: 'Budget inspection and limit management for fleet usage.',
    names: ['budget_status', 'budget_history', 'budget_forecast', 'budget_set_limit'],
    match: () => false,
  },
  {
    id: 'fleet-policy',
    description: 'Policy routing and explanation for fleet decisions.',
    names: ['policy_decide', 'policy_explain'],
    match: () => false,
  },
  {
    id: 'fleet-agent-room',
    description: 'Agent-room composition and lifecycle for multi-agent fleet work.',
    names: ['agent_room_compose', 'agent_room_list', 'agent_room_close'],
    match: () => false,
  },
  {
    id: 'fleet-llm',
    description: 'Local-LLM fleet inventory and install management.',
    names: ['llm_list_nodes', 'llm_list_available_models', 'llm_request_install'],
    match: () => false,
  },
  {
    id: 'fleet-acp',
    description: 'ACP session lifecycle and subagent orchestration for the fleet.',
    names: [
      'acp_session_create',
      'acp_session_send',
      'acp_session_close',
      'acp_session_resume',
      'acp_session_spawn_sub',
      'acp_session_start_background',
      'acp_session_cancel',
      'acp_session_join',
    ],
    match: () => false,
  },
  // Shell execution — one-shot Bash (test/git/gh/launchctl) and RunShell
  // (longer vw-pane shell). Essential-mode coding surfaces need these to
  // be a real coding agent (codex/claude-code parity): edit→test→commit→
  // PR→reboot all need a shell. Registered runtimes (bashRuntime /
  // runShellRuntime) so exposure just needs the surface to list the
  // family; dispatch is not config-gated (only PTY is, at the resolver).
  {
    id: 'bash',
    // NOTE: `names` are runtime IDs (keyed by ToolRuntime.id in the
    // resolver), not spec names — bashRuntime.id='bash' (spec 'Bash').
    description: 'One-shot shell command execution (Bash) — run tests, git, gh, build, launchctl.',
    names: ['bash'],
    match: () => false,
  },
  {
    id: 'run-shell',
    description: 'Longer-running shell in a managed pane (RunShell) — builds, servers, watch tasks.',
    names: ['run_shell'],
    match: () => false,
  },
  {
    // OH8 follow-up (PR-1) — multi-filter run_tests. A coding agent that
    // passes multiple test filters needs to know each one actually ran;
    // `bun test` substring filters silently absorb typos (exit 0). names =
    // runtime ID (runTestsRuntime.id = 'run_tests').
    id: 'run-tests',
    description: 'Multi-filter test runner (run_tests) — reports unmatchedFilters so a 0-match typo filter cannot false-pass.',
    names: ['run_tests'],
    match: () => false,
  },
  {
    id: 'elanous_skills_list',
    description: 'List installed Elanous skills by their exact executable name.',
    names: ['elanous_skills_list'],
    match: () => false,
  },
  {
    id: 'skill_exec',
    description: 'Execute one explicitly named allowlisted Elanous skill.',
    names: ['skill_exec'],
    match: () => false,
  },
  {
    // ⭐ 코드 탐색 1급화(S 트랙) — 카탈로그 등록만으로는 TUI 에 오지 않는다.
    //
    //  `native-tool-catalog` 의 `surface: ['skill','dashboard','plugin']` 은 skill 러너 경로가
    //  읽는 필드이고, TUI 세션 카탈로그의 게이트는 이 family 표다. 같은 구조를 오늘 두 번
    //  겪었다 — `Agent` 도 카탈로그엔 있는데 TUI 엔 없었고(#5916), `PersistentGrounding` 도
    //  등록 후 라이브 census 가 33 그대로였다(34 가 아니라).
    //
    //  runtime 은 이미 등록돼 있어(tool-runtime/index.ts) spec·dispatch 를 새로 만들지 않는다 —
    //  이름만 이 표에 올린다. names = runtime ID.
    //  ⛔ 읽기 전용 · supportsParallel 이라 위임 자식에게 줘도 안전하다(S 트랙 확인).
    id: 'code-grounding',
    description: 'Persistent code grounding (PersistentGrounding) — keeps searching until the goal is covered instead of a single shot.',
    names: ['persistent_grounding'],
    // This family is selected only from coding profiles' default family IDs.
    // Keeping dynamic scanning disabled prevents the opt-in from leaking to other surfaces.
    match: () => false,
  },
  {
    // 대화형 PTY (codex unified_exec 대응) — REPL·dev server·watcher 를 진짜
    // PTY 로 헤드리스 스폰 후 poll/send/kill 로 턴별 구동. Bash 의 one-shot 이
    // 맞지 않는 shape. 노출은 이 family 로, dispatch 는 shell.allowDashboardPty
    // (ptyDashboardOn) 게이트(1778) — 그래서 config 도 함께 켠다. auto-approve
    // (HITL 없음)라 자율 코딩 에이전트에 적합. names = runtime ID.
    id: 'pty-shell',
    description: 'Interactive PTY shell (PtyShellStart/Poll/Send/Kill/List) — REPL, dev server, watcher; codex unified_exec parity.',
    names: ['pty_shell_start', 'pty_shell_poll', 'pty_shell_send', 'pty_shell_kill', 'pty_shell_list'],
    match: () => false,
  },
];

const RUNTIME_TOOL_FAMILY_RULE_MAP = new Map<string, SessionRuntimeToolFamilyRule>(
  SESSION_RUNTIME_TOOL_FAMILY_RULES.map(rule => [rule.id, rule] as const),
);

const NATIVE_TOOL_FAMILY_RULE_MAP = new Map<string, SessionNativeToolRule>(
  SESSION_NATIVE_TOOL_RULES.map(rule => [rule.id, rule] as const),
);

interface SurfaceAwarePolicy {
  hostFamilyMatchers?: Partial<Record<string, (text: string) => boolean>>;
  runtimeFamilyMatchers?: Partial<Record<string, (text: string) => boolean>>;
  nativeFamilyMatchers?: Partial<Record<string, (text: string) => boolean>>;
}

const SESSION_SURFACE_PROFILES: Record<SessionSurfaceId, Omit<SessionSurfaceProfile, 'selectionReason'>> = {
  'coding/turn': {
    id: 'coding/turn',
    domain: 'coding',
    executionStyle: 'turn',
    description: 'Turn-local coding assistance.',
    baselineContexts: ['git'],
    defaultHostFamilyIds: ['self-ops'],
    // Shell execution — essential-mode coding agent (codex/claude-code
    // parity): edit→test→commit→PR→reboot all need a shell.
    defaultRuntimeFamilyIds: ['bash', 'run-shell', 'pty-shell', 'run-tests', 'elanous_skills_list', 'skill_exec', 'code-grounding'],
    defaultNativeFamilyIds: [
      'code-read',
      'code-grep',
      'code-glob',
      'code-list-dir',
      'code-edit',
      'code-write',
      'agent',
      'agent-output',
      'agent-reply',
      'agent-stop',
      'agent-list',
    ],
  },
  'coding/agent': {
    id: 'coding/agent',
    domain: 'coding',
    executionStyle: 'agent',
    description: 'Goal-owning coding execution.',
    baselineContexts: ['git'],
    defaultHostFamilyIds: ['code-intel', 'self-ops'],
    // Shell execution — a goal-owning coding agent must run what it builds.
    defaultRuntimeFamilyIds: ['bash', 'run-shell', 'pty-shell', 'run-tests', 'elanous_skills_list', 'skill_exec', 'code-grounding'],
    defaultNativeFamilyIds: [
      'code-read',
      'code-grep',
      'code-glob',
      'code-list-dir',
      'code-edit',
      'code-write',
      'agent',
      'agent-output',
      'agent-reply',
      'agent-stop',
      'agent-list',
    ],
  },
  'research/turn': {
    id: 'research/turn',
    domain: 'research',
    executionStyle: 'turn',
    description: 'Turn-local external lookup and verification.',
    baselineContexts: ['external-world-guidance'],
    defaultHostFamilyIds: ['self-ops'],
    defaultRuntimeFamilyIds: [],
    // Read-only file inspection tools (code-read/grep/glob/list-dir)
    // are added so the LLM can cross-check external findings against
    // local source — incident 2026-05-04 — research/turn user asked
    // "open the latest debug file and analyze" but only web-search was
    // exposed, forcing the LLM to refuse. code-edit/code-write stay
    // out — research surface should not mutate the workspace.
    defaultNativeFamilyIds: ['code-read', 'code-grep', 'code-glob', 'code-list-dir', 'web-search'],
  },
  'research/agent': {
    id: 'research/agent',
    domain: 'research',
    executionStyle: 'agent',
    description: 'Goal-owning research and triangulation.',
    baselineContexts: ['external-world-guidance'],
    defaultHostFamilyIds: ['self-ops'],
    defaultRuntimeFamilyIds: [],
    defaultNativeFamilyIds: ['web-search'],
  },
  'control/agent': {
    id: 'control/agent',
    domain: 'control',
    executionStyle: 'agent',
    description: 'Operator posture for elanous runtime control.',
    baselineContexts: ['git', 'operator-state'],
    defaultHostFamilyIds: ['ui-inspect', 'self-ops'],
    defaultRuntimeFamilyIds: [],
    defaultNativeFamilyIds: [],
  },
  'ops-ui/agent': {
    id: 'ops-ui/agent',
    domain: 'ops',
    executionStyle: 'agent',
    description: 'Operational posture for local Elanous UI and runtime oversight.',
    baselineContexts: ['git', 'ops-state'],
    defaultHostFamilyIds: ['ui-inspect', 'self-ops'],
    defaultRuntimeFamilyIds: [],
    defaultNativeFamilyIds: [],
  },
  'ops-fleet/agent': {
    id: 'ops-fleet/agent',
    domain: 'ops',
    executionStyle: 'agent',
    description: 'Operational posture for fleet and remote-node oversight.',
    baselineContexts: ['git', 'ops-state'],
    defaultHostFamilyIds: ['self-ops'],
    defaultRuntimeFamilyIds: ['fleet-core'],
    defaultNativeFamilyIds: [],
  },
};

const SURFACE_AWARE_POLICIES: Partial<Record<SessionSurfaceId, SurfaceAwarePolicy>> = {
  'coding/agent': {
    hostFamilyMatchers: {
      'code-intel': hasCodingAgentCodeExplorationIntent,
      'structural-search': hasCodingAgentStructuralSearchIntent,
    },
    nativeFamilyMatchers: {
      'dev-harness': shouldExposeDevHarnessSessionTool,
    },
  },
  'research/agent': {
    nativeFamilyMatchers: {
      'web-fetch': hasResearchAgentFetchIntent,
    },
  },
  'control/agent': {
    hostFamilyMatchers: {
      'ui-mutate': hasControlMutationIntent,
      'prompt-ops': hasControlPromptIntent,
      'runtime-debug': hasControlDebugIntent,
    },
  },
  'ops-ui/agent': {
    hostFamilyMatchers: {
      'ui-mutate': hasOpsUiMutationIntent,
      'prompt-ops': hasOpsUiPromptIntent,
      'runtime-debug': hasOpsUiDebugIntent,
    },
  },
  'ops-fleet/agent': {
    runtimeFamilyMatchers: {
      'fleet-team': hasOpsFleetTeamIntent,
      'fleet-budget': hasOpsFleetBudgetIntent,
      'fleet-policy': hasOpsFleetPolicyIntent,
      'fleet-agent-room': hasOpsFleetAgentRoomIntent,
      'fleet-llm': hasOpsFleetLlmIntent,
      'fleet-acp': hasOpsFleetAcpIntent,
    },
    nativeFamilyMatchers: {
      'web-search': hasOpsFleetOperationalLookupIntent,
    },
  },
};

function normalizeSessionSurfaceId(value: string | null | undefined): SessionSurfaceId | null {
  if (!value) return null;
  if (value === 'coding/chat') return 'coding/turn';
  if (value === 'research/chat') return 'research/turn';
  if (value === 'ops/agent') return 'ops-ui/agent';
  return Object.prototype.hasOwnProperty.call(SESSION_SURFACE_PROFILES, value)
    ? value as SessionSurfaceId
    : null;
}

function isSessionSurfaceId(value: string | null | undefined): value is SessionSurfaceId {
  return normalizeSessionSurfaceId(value) !== null;
}

export function buildSessionRuntimeSystemMessages(opts: {
  cwd: string;
}): LLMMessage[] {
  const snapshot = buildGitSnapshot(opts.cwd);
  return snapshot
    ? [{ role: 'system', content: `## Git Snapshot\n\n${snapshot}` }]
    : [];
}

export function buildSessionRuntimeTurnSystemMessages(
  turnProfile: SessionTurnProfile,
  userText?: string,
): LLMMessage[] {
  const lines = [
    '## Session Surface',
    '',
    `Current surface: ${turnProfile.surface.id}`,
    `Surface selection: ${turnProfile.surfaceSelectionMode}`,
  ];
  if (turnProfile.inputSourceKind) {
    lines.push(`Input source kind: ${turnProfile.inputSourceKind}`);
  }
  if (turnProfile.preferredSurfaceId) {
    lines.push(`Preferred surface: ${turnProfile.preferredSurfaceId}`);
  }
  const messages: LLMMessage[] = [{ role: 'system', content: lines.join('\n') }];
  const guidance = buildSurfaceOperationalGuidance(turnProfile.surface);
  if (guidance) {
    messages.push({ role: 'system', content: guidance });
  }
  const scopedGuidance = buildTurnScopedExplorationGuidance(userText);
  if (scopedGuidance) {
    messages.push({ role: 'system', content: scopedGuidance });
  }
  return messages;
}

function buildTurnScopedExplorationGuidance(userText?: string): string | null {
  if (isScopedAnalysisRequest(userText)) {
    return [
      '## Scoped Exploration Guidance',
      '',
      'This turn looks like subsystem or structural analysis.',
      'Do NOT start with broad project-root exploration such as `ListDir(.)`, `Glob("**/*")`, or root-wide `Grep(... in .)`.',
      'Infer likely subsystem keywords from the user request, then start with one narrow Glob/Grep scoped to matching directories or filenames.',
      'Prefer: identify 3-6 candidate files, Read those files, then synthesize.',
      'Avoid repeated root-wide Grep/Glob/ListDir calls unless the user explicitly asked for whole-repo inventory.',
    ].join('\n');
  }
  return null;
}

export function isScopedAnalysisRequest(userText?: string): boolean {
  const text = String(userText ?? '').toLowerCase();
  if (!text.trim()) return false;
  const looksLikeSubsystemAnalysis = hasAny(text, [
    'analyze',
    'analysis',
    'architecture',
    'structure',
    'flow',
    'entry point',
    'subsystem',
    'component',
    '관련 소스',
    '구조 분석',
    '아키텍처',
    '흐름',
    '엔트리 포인트',
    '서브시스템',
    '컴포넌트',
  ]);
  const looksLikeRuntimeOrDebugAnalysis = hasAny(text, [
    'debug',
    'debugging',
    'logger',
    'logging',
    'loglevel',
    'trace',
    'verbose',
    'diagnostic',
    'diagnostics',
    'runtime',
    'state',
    '디버그',
    '로깅',
    '로그',
    '트레이스',
    '진단',
    '런타임',
    '상태',
  ]);
  // Fix W (2026-04-25): project-evaluation requests like "이 프로젝트
  // 현재 코딩 에이전트 구현 정도 평가해주세요" used to miss the gate
  // → scopedAnalysis=false → narrowing logic disabled → codex stalled
  // in search-loop. Adding the evaluation/status vocabulary unlocks
  // the auto-narrow → inspect-synthesis-armed path, which feeds the
  // codex-immediate-stop fallback (much richer than the bare exploration
  // notice). Reference:
  // 내부 문서 `RESEARCH-codex-reread-pathology-2refs-2026-04-25` fix W.
  const looksLikeProjectEvaluation = hasAny(text, [
    'evaluate',
    'evaluation',
    'assessment',
    'assess',
    'audit',
    'maturity',
    'readiness',
    'health check',
    'review the project',
    '평가',
    '평가해',
    '현황',
    '현재 구현',
    '구현 정도',
    '구현 상태',
    '진척',
    '진척도',
    '성숙도',
    '진단해',
  ]);
  return looksLikeSubsystemAnalysis || looksLikeRuntimeOrDebugAnalysis || looksLikeProjectEvaluation;
}

function isDebugFocusedAnalysisRequest(userText?: string): boolean {
  const text = String(userText ?? '').toLowerCase();
  if (!text.trim()) return false;
  return hasAny(text, [
    'debug',
    'debug-focused',
    'debugging',
    'logger',
    'logging',
    'loglevel',
    'trace',
    'verbose',
    'diagnostic',
    'dashboard',
    '디버그',
    '디버깅',
    '로깅',
    '로그',
    '트레이스',
    '진단',
    '대시보드',
  ]);
}

function isProjectRootishPath(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed === '.' || trimmed === './') return true;
  const normalized = resolve(trimmed);
  return normalized === process.cwd();
}

function isBroadRootGlobPattern(pattern: unknown): boolean {
  if (typeof pattern !== 'string') return false;
  const trimmed = pattern.trim();
  if (!trimmed) return false;
  return (
    trimmed === '**/*'
    || trimmed.startsWith('**/*.')
    || trimmed.startsWith('**/*{')
    || trimmed.startsWith('**/*')
  );
}

function isBroadRootGrep(args: Record<string, unknown>): boolean {
  if (!isProjectRootishPath(args.path ?? '.')) return false;
  const mode = typeof args.output_mode === 'string' ? args.output_mode.trim() : '';
  if (mode && mode !== 'files_with_matches') return false;
  const glob = typeof args.glob === 'string' ? args.glob.trim() : '';
  if (!glob) return true;
  if (glob === '*') return true;
  if (glob.startsWith('*.{')) return true;
  if (glob.startsWith('**/*')) return true;
  if (glob.includes('**/*')) return true;
  if (glob.includes('/**/')) return true;
  return false;
}

function buildScopedExplorationBlockMessage(name: string): string {
  return [
    'RUNTIME BLOCKED — broad project-root exploration is disabled for this structural-analysis turn.',
    `\`${name}\` was too wide for the current request.`,
    'Start with one narrower Glob/Grep, then Read a few candidate files and synthesize.',
  ].join(' ');
}

function extractRecursiveSubtreePrefix(value: unknown): { path: string; rest: string } | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^([A-Za-z0-9._/-]+)\/\*\*\/(.+)$/);
  if (!match) return null;
  const prefix = match[1]?.replace(/^\.\/+/, '').replace(/\/+$/, '') ?? '';
  const rest = match[2]?.trim() ?? '';
  if (!prefix || !rest) return null;
  if (prefix.includes('*') || prefix.includes('{') || prefix.includes('}')) return null;
  return { path: prefix, rest: `**/${rest}` };
}

const DEBUG_STRUCTURAL_GLOB = '{debug/**,display/debug-*.ts,window/debug-*.ts,dashboard/**/*debug*.ts,dashboard/**/*trace*.ts,**/debug-*.ts,**/call-stack.ts,**/log.ts}';

function looksLikeBroadSourceTreeGlob(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return (
    trimmed === '**/*.{ts,tsx}'
    || trimmed === '**/*.{ts,tsx,js,jsx}'
    || trimmed === '**/*.{ts,tsx,js,mjs,cjs}'
    || trimmed === '**/*.{ts,tsx,js,jsx,mjs,cjs}'
    || trimmed === '**/*.ts'
    || trimmed === '**/*.tsx'
  );
}

function maybeRewriteScopedRecursiveSearchArgs(
  name: string,
  args: Record<string, unknown>,
  userText?: string,
): Record<string, unknown> {
  if (!isScopedAnalysisRequest(userText)) return args;
  const debugFocused = isDebugFocusedAnalysisRequest(userText);
  const currentPath = typeof args.path === 'string' ? args.path.trim() : '.';
  if (!isProjectRootishPath(args.path ?? '.')) return args;
  if (debugFocused && (name === 'Grep' || name === 'Glob')) {
    const currentGlob = name === 'Grep'
      ? (typeof args.glob === 'string' ? args.glob.trim() : '')
      : (typeof args.pattern === 'string' ? args.pattern.trim() : '');
    const subtree = extractRecursiveSubtreePrefix(currentGlob);
    const normalizedPath = subtree?.path ?? (currentPath === '.' ? 'src' : currentPath);
    const normalizedGlob = subtree?.rest ?? currentGlob;
    if (normalizedPath === 'src' && looksLikeBroadSourceTreeGlob(normalizedGlob)) {
      return {
        ...args,
        path: 'src',
        ...(name === 'Grep'
          ? { glob: DEBUG_STRUCTURAL_GLOB }
          : { pattern: DEBUG_STRUCTURAL_GLOB }),
      };
    }
  }
  if (name === 'Grep') {
    const narrowed = extractRecursiveSubtreePrefix(args.glob);
    if (narrowed) {
      return {
        ...args,
        path: narrowed.path,
        glob: narrowed.rest,
      };
    }
  }
  if (name === 'Glob') {
    const narrowed = extractRecursiveSubtreePrefix(args.pattern);
    if (narrowed) {
      return {
        ...args,
        path: narrowed.path,
        pattern: narrowed.rest,
      };
    }
  }
  return args;
}

function maybeBlockBroadProjectRootExploration(
  name: string,
  args: Record<string, unknown>,
  userText?: string,
): string | null {
  if (!isScopedAnalysisRequest(userText)) return null;
  if (name === 'ListDir' && isProjectRootishPath(args.path ?? '.')) {
    return buildScopedExplorationBlockMessage(name);
  }
  if (name === 'Glob' && isProjectRootishPath(args.path ?? '.') && isBroadRootGlobPattern(args.pattern)) {
    return buildScopedExplorationBlockMessage(name);
  }
  if (name === 'Grep' && isBroadRootGrep(args)) {
    return buildScopedExplorationBlockMessage(name);
  }
  return null;
}

function buildSurfaceOperationalGuidance(surface: SessionSurfaceProfile): string | null {
  switch (surface.id) {
    case 'coding/agent':
      return [
        '## Surface Guidance',
        '',
        'You are in `coding/agent`.',
        'Bias toward goal-owning implementation work: inspect the codebase, keep code-intel ready by default, bring in structural search when the task turns pattern-heavy, and verify changes before answering.',
        'Prefer repo-local evidence over web lookup unless the task explicitly needs current external facts.',
      ].join('\n');
    case 'research/agent':
      return [
        '## Surface Guidance',
        '',
        'You are in `research/agent`.',
        'Bias toward multi-source external investigation: use WebSearch, WebFetch, and OmniSearch before concluding.',
        'WebSearch is provider-backed and may route through Grok live-search or Firecrawl; OmniSearch is the wider parallel path when you want triangulation across providers.',
        'Prefer cited, current, cross-checked findings over repo-local assumptions when the question reaches beyond the workspace.',
      ].join('\n');
    case 'research/turn':
      return [
        '## Surface Guidance',
        '',
        'You are in `research/turn`.',
        'Handle the current turn as a lightweight external lookup. Prefer quick verification and concise sourced answers over deep autonomous exploration.',
        'Keep WebSearch ready by default. It is provider-backed and may use Grok live-search or Firecrawl; use WebFetch for full page bodies and OmniSearch when the user asks for deeper cross-provider research.',
      ].join('\n');
    case 'control/agent':
      return [
        '## Surface Guidance',
        '',
        'You are in `control/agent`.',
        'Bias toward operator actions on the Elanous runtime itself: inspect state first, then use control tools and report the resulting state change clearly.',
      ].join('\n');
    case 'ops-ui/agent':
      return [
        '## Surface Guidance',
        '',
        'You are in `ops-ui/agent`.',
        'Bias toward local operational oversight: inspect Elanous runtime, window, pane, prompt, and debug state first, then use operator tools to explain health, drift, and next actions.',
      ].join('\n');
    case 'ops-fleet/agent':
      return [
        '## Surface Guidance',
        '',
        'You are in `ops-fleet/agent`.',
        'Bias toward fleet oversight: inspect remote-node, team, policy, budget, and external operational signals before concluding.',
        'When the request points to incidents, status pages, or external operational references, use web lookup to pull current outside signals explicitly.',
      ].join('\n');
    default:
      return null;
  }
}

export function createSessionPostureState(): SessionPostureState {
  return createChatModeState();
}

export function enterSessionControlMode(
  state: SessionPostureState,
  opts: EnterModeOpts = {},
): SessionPostureState {
  return enterControlMode(state, opts);
}

export function exitSessionControlMode(
  state: SessionPostureState,
  opts: EnterModeOpts = {},
): SessionPostureState {
  return exitControlMode(state, opts);
}

export function isSessionControlActive(state: SessionPostureState): boolean {
  return isControlMode(state);
}

export function armSessionQuickControl(
  state: SessionPostureState,
  intent?: string,
): SessionPostureState {
  return armQuickControlOnce(state, intent);
}

export function consumeSessionQuickControl(state: SessionPostureState): boolean {
  return consumeQuickControlOnce(state);
}

export function toggleSessionControlMode(
  state: SessionPostureState,
  opts: EnterModeOpts = {},
): SessionPostureState {
  return toggleControlMode(state, opts);
}

export function parseSessionControlSlash(
  command: 'control' | 'dm' | 'default',
  args: string[],
  currentlyControl: boolean,
): ControlSlashOutcome {
  return parseControlSlash(command, args, currentlyControl);
}

export function setSessionPreferredSurface(
  state: SessionPostureState,
  preferredSurfaceId: string | null,
): SessionPostureState {
  return setPreferredSurface(state, normalizeSessionSurfaceId(preferredSurfaceId) ?? preferredSurfaceId);
}

export function parseSessionSurfaceSlash(args: readonly string[]): SessionSurfaceSlashOutcome {
  const raw = String(args[0] ?? '').toLowerCase();
  if (!raw || raw === 'status') return { kind: 'status' };
  if (raw === 'clear' || raw === 'auto') return { kind: 'clear' };
  const surfaceMap: Record<string, SessionSurfaceId> = {
    'coding-turn': 'coding/turn',
    'coding-chat': 'coding/turn',
    'coding/turn': 'coding/turn',
    'coding/chat': 'coding/turn',
    'coding-agent': 'coding/agent',
    'research-turn': 'research/turn',
    'research-chat': 'research/turn',
    'research/turn': 'research/turn',
    'research/chat': 'research/turn',
    'research-agent': 'research/agent',
    'control-agent': 'control/agent',
    'ops-ui-agent': 'ops-ui/agent',
    'ops-fleet-agent': 'ops-fleet/agent',
    'ops-agent': 'ops-ui/agent',
  };
  const surfaceId = surfaceMap[raw];
  if (!surfaceId) {
    return {
      kind: 'error',
      message: 'usage: /surface coding-agent|coding-chat|research-agent|research-chat|control-agent|ops-ui-agent|ops-fleet-agent|ops-agent|clear|status',
    };
  }
  return { kind: 'set', surfaceId };
}

export function resolveSessionPostureSnapshot(state: SessionPostureState): SessionPostureSnapshot {
  const persistentPosture: SessionPosture = state.posture === 'control' ? 'control' : 'general';
  const activePosture: SessionPosture = isControlMode(state) ? 'control' : 'general';
  return {
    persistentPosture,
    activePosture,
    activeIntent: state.intent?.trim() || null,
    preferredSurfaceId:
      normalizeSessionSurfaceId(state.preferredSurfaceId)
      ?? state.preferredSurfaceId?.trim()
      ?? null,
    isQuickControlArmed: state.quickControlOnce === true,
  };
}

export function summarizeSessionSurface(surface: SessionSurfaceProfile): SessionSurfaceSummary {
  const defaultFamilies: SessionToolFamilySummary[] = [];
  const conditionalFamilies: SessionToolFamilySummary[] = [];
  const seenConditional = new Set<string>();
  for (const familyId of surface.defaultHostFamilyIds) {
    const rule = HOST_TOOL_FAMILY_RULE_MAP.get(familyId);
    if (!rule) continue;
    defaultFamilies.push({
      id: rule.id,
      kind: 'host',
      description: rule.description,
      toolNames: rule.names,
    });
  }
  for (const familyId of surface.defaultRuntimeFamilyIds) {
    const rule = RUNTIME_TOOL_FAMILY_RULE_MAP.get(familyId);
    if (!rule) continue;
    defaultFamilies.push({
      id: rule.id,
      kind: 'runtime',
      description: rule.description,
      toolNames: rule.names,
    });
  }
  for (const familyId of surface.defaultNativeFamilyIds) {
    const rule = NATIVE_TOOL_FAMILY_RULE_MAP.get(familyId);
    if (!rule) continue;
    defaultFamilies.push({
      id: rule.id,
      kind: 'native',
      description: rule.description,
      toolNames: [rule.build().name],
    });
  }
  const conditional = SURFACE_AWARE_POLICIES[surface.id];
  for (const familyId of Object.keys(conditional?.hostFamilyMatchers ?? {})) {
    const rule = HOST_TOOL_FAMILY_RULE_MAP.get(familyId);
    if (!rule || seenConditional.has(`host:${familyId}`)) continue;
    seenConditional.add(`host:${familyId}`);
    conditionalFamilies.push({
      id: rule.id,
      kind: 'host',
      description: rule.description,
      toolNames: rule.names,
    });
  }
  for (const familyId of Object.keys(conditional?.runtimeFamilyMatchers ?? {})) {
    const rule = RUNTIME_TOOL_FAMILY_RULE_MAP.get(familyId);
    if (!rule || seenConditional.has(`runtime:${familyId}`)) continue;
    seenConditional.add(`runtime:${familyId}`);
    conditionalFamilies.push({
      id: rule.id,
      kind: 'runtime',
      description: rule.description,
      toolNames: rule.names,
    });
  }
  for (const familyId of Object.keys(conditional?.nativeFamilyMatchers ?? {})) {
    const rule = NATIVE_TOOL_FAMILY_RULE_MAP.get(familyId);
    if (!rule || seenConditional.has(`native:${familyId}`)) continue;
    seenConditional.add(`native:${familyId}`);
    conditionalFamilies.push({
      id: rule.id,
      kind: 'native',
      description: rule.description,
      toolNames: [rule.build().name],
    });
  }
  return {
    surface,
    baselineContexts: surface.baselineContexts,
    defaultFamilies,
    conditionalFamilies,
  };
}

export function resolveSessionSurfaceProfile(opts: {
  userText?: string;
  /** Accepts persisted legacy IDs at this resolver boundary and emits a canonical profile. */
  preferredSurfaceId?: string;
  controlMode?: boolean;
} = {}): SessionSurfaceProfile {
  const decision = (id: SessionSurfaceId, reason: string): SessionSurfaceProfile => {
    if (debug.enabled) {
      debug.log('llm.tool-exposure', 'surface.resolve', {
        resolved: id,
        reason,
        preferredSurfaceId: opts.preferredSurfaceId ?? null,
        controlMode: opts.controlMode === true,
        userTextChars: (opts.userText ?? '').length,
        userTextPreview: (opts.userText ?? '').slice(0, 120),
      });
    }
    return { ...SESSION_SURFACE_PROFILES[id], selectionReason: reason };
  };
  const preferredSurfaceId = normalizeSessionSurfaceId(opts.preferredSurfaceId);
  if (preferredSurfaceId) return decision(preferredSurfaceId, 'preferred-surface-id');
  if (opts.controlMode) return decision('control/agent', 'control-mode');
  const text = String(opts.userText ?? '').toLowerCase();
  if (hasOpsFleetIntent(text)) return decision('ops-fleet/agent', 'ops-fleet-intent');
  if (hasOpsUiIntent(text)) return decision('ops-ui/agent', 'ops-ui-intent');
  if (hasResearchSearchIntent(text)) return decision('research/agent', 'research-search-intent');
  if (hasWebSearchIntent(text) || hasWebFetchIntent(text)) return decision('research/turn', 'web-search-or-fetch-intent');
  if (hasDevHarnessIntent(text)) return decision('coding/agent', 'dev-harness-intent');
  return decision('coding/turn', 'fallback-default');
}

export function resolveSessionSurfaceFromChatMode(opts: {
  userText?: string;
  chatModeState: ChatModeState;
  preferredSurfaceId?: SessionSurfaceId;
}): SessionSurfaceProfile {
  const posture = resolveSessionPostureSnapshot(opts.chatModeState);
  const preferredSurfaceId =
    normalizeSessionSurfaceId(opts.preferredSurfaceId)
    ?? normalizeSessionSurfaceId(posture.preferredSurfaceId)
    ?? undefined;
  return resolveSessionSurfaceProfile({
    userText: opts.userText,
    preferredSurfaceId,
    controlMode: posture.activePosture === 'control',
  });
}

export function resolveSessionInputModeFromChatMode(opts: {
  userText?: string;
  chatModeState: ChatModeState;
  preferredSurfaceId?: SessionSurfaceId;
}): 'general' | 'control' {
  return resolveSessionInputMode(resolveSessionSurfaceFromChatMode(opts));
}

export function resolveSessionModeSnapshot(chatModeState: ChatModeState): SessionModeSnapshot {
  const posture = resolveSessionPostureSnapshot(chatModeState);
  const isControlActive = posture.activePosture === 'control';
  const preferredSurfaceId = posture.preferredSurfaceId;
  const surfaceSelectionMode = preferredSurfaceId ? 'fixed' : 'auto';
  const surfaceStatus = preferredSurfaceId ? `surface=fixed:${preferredSurfaceId}` : 'surface=auto';
  const surfaceHud = preferredSurfaceId ? `fixed:${preferredSurfaceId}` : 'auto';
  return {
    rawMode: chatModeState.mode,
    activeIntent: posture.activeIntent,
    isControlActive,
    preferredSurfaceId,
    surfaceSelectionMode,
    statusLabel: isControlActive
      ? `control${posture.activeIntent ? ` (${posture.activeIntent})` : ''} · ${surfaceStatus}`
      : `general · ${surfaceStatus}`,
    hudLabel: isControlActive
      ? `CONTROL${posture.activeIntent ? ` · ${posture.activeIntent}` : ''} · ${surfaceHud}`
      : `GENERAL · ${surfaceHud}`,
  };
}

export function isControlSessionSurface(surface: SessionSurfaceProfile): boolean {
  return surface.domain === 'control' && surface.executionStyle === 'agent';
}

export function resolveSessionInputMode(surface: SessionSurfaceProfile): 'general' | 'control' {
  return isControlSessionSurface(surface) ? 'control' : 'general';
}

export function resolveSessionTurnProfile(opts: {
  userText?: string;
  chatModeState: ChatModeState;
  preferredSurfaceId?: SessionSurfaceId;
  inputSource?: InputSourceRef | null;
}): SessionTurnProfile {
  const surface = resolveSessionSurfaceFromChatMode(opts);
  const posture = resolveSessionPostureSnapshot(opts.chatModeState);
  const preferredSurfaceId = normalizeSessionSurfaceId(opts.preferredSurfaceId)
    ?? normalizeSessionSurfaceId(posture.preferredSurfaceId);
  const inputSource = opts.inputSource ?? null;
  return {
    surface,
    activeIntent: posture.activeIntent,
    preferredSurfaceId: preferredSurfaceId ?? null,
    surfaceSelectionMode: preferredSurfaceId ? 'fixed' : 'auto',
    shouldInjectControlManual: isControlSessionSurface(surface),
    inputMode: resolveSessionInputMode(surface),
    inputSource,
    inputSourceKind: inputSource?.kind ?? null,
  };
}

export function resolveSessionSurfaceStatus(opts: {
  userText?: string;
  chatModeState: ChatModeState;
  preferredSurfaceId?: SessionSurfaceId;
}): SessionSurfaceStatusSnapshot {
  const mode = resolveSessionModeSnapshot(opts.chatModeState);
  const turn = resolveSessionTurnProfile(opts);
  return {
    mode,
    currentSurfaceId: turn.surface.id,
    preferredSurfaceId: turn.preferredSurfaceId,
    surfaceSelectionMode: turn.surfaceSelectionMode,
    inputMode: turn.inputMode,
  };
}

export function buildSessionSurfaceStatusLines(
  snapshot: SessionSurfaceStatusSnapshot,
): string[] {
  return [
    `current surface: ${snapshot.currentSurfaceId}`,
    `surface selection: ${snapshot.surfaceSelectionMode}`,
    `preferred surface: ${snapshot.preferredSurfaceId ?? '(auto)'}`,
    `input mode: ${snapshot.inputMode}`,
  ];
}

export function buildSessionDashboardStatusLines(
  snapshot: SessionSurfaceStatusSnapshot,
): string[] {
  return [
    `surface: ${snapshot.currentSurfaceId} (${snapshot.surfaceSelectionMode})`,
    `mode: ${snapshot.mode.statusLabel}`,
  ];
}

export function buildSessionSurfaceManualSections(
  opts: BuildSessionSurfaceManualSectionsOpts,
): string[] {
  const surfaceSummary = summarizeSessionSurface(opts.surface);
  const sections: string[] = [];
  sections.push('## Surface posture');
  sections.push(`- description: ${surfaceSummary.surface.description}`);
  if (opts.surfaceSelectionMode) {
    sections.push(`- selection mode: ${opts.surfaceSelectionMode}`);
  }
  if (opts.preferredSurfaceId) {
    sections.push(`- preferred surface: \`${opts.preferredSurfaceId}\``);
  }
  if (surfaceSummary.baselineContexts.length > 0) {
    sections.push(`- baseline contexts: ${surfaceSummary.baselineContexts.map(ctx => `\`${ctx}\``).join(', ')}`);
  }
  if (surfaceSummary.defaultFamilies.length > 0) {
    sections.push(`- default families: ${surfaceSummary.defaultFamilies.map(family => `\`${family.id}\``).join(', ')}`);
  } else {
    sections.push('- default families: none');
  }
  if (surfaceSummary.conditionalFamilies.length > 0) {
    sections.push(`- conditional families: ${surfaceSummary.conditionalFamilies.map(family => `\`${family.id}\``).join(', ')}`);
  } else {
    sections.push('- conditional families: none');
  }
  sections.push('');

  if (surfaceSummary.defaultFamilies.length > 0) {
    sections.push(`## Surface families (${surfaceSummary.defaultFamilies.length})`);
    sections.push(
      'These families define the operator posture for the current surface before any extra intent-based tools are opened.',
    );
    sections.push('');
    for (const family of surfaceSummary.defaultFamilies) {
      sections.push(`- **${family.id}** [${family.kind}] — ${family.description}`);
      sections.push(`  Tools: ${family.toolNames.map(name => `\`${name}\``).join(', ')}`);
    }
    sections.push('');
  }

  if (surfaceSummary.conditionalFamilies.length > 0) {
    sections.push(`## Conditional families (${surfaceSummary.conditionalFamilies.length})`);
    sections.push(
      'These families are not open by default. They become callable only when the current turn shows matching intent for this surface.',
    );
    sections.push('');
    for (const family of surfaceSummary.conditionalFamilies) {
      sections.push(`- **${family.id}** [${family.kind}] — ${family.description}`);
      sections.push(`  Tools: ${family.toolNames.map(name => `\`${name}\``).join(', ')}`);
    }
    sections.push('');
  }

  return sections;
}
export function resolveDynamicSessionHostTools(opts: {
  userText: string;
  hostTools: readonly LLMToolDef[];
  toolAvailability?: Readonly<Record<string, boolean>>;
  defaultFamilyIds?: readonly string[];
  surfaceId?: SessionSurfaceId;
}): LLMToolDef[] {
  const text = opts.userText.toLowerCase();
  const available = new Map(opts.hostTools.map(tool => [tool.name, tool] as const));
  const selected = new Set<string>();

  for (const familyId of opts.defaultFamilyIds ?? []) {
    for (const rule of SESSION_TOOL_FAMILY_RULES) {
      if (rule.id !== familyId) continue;
      for (const name of rule.names) {
        if (available.has(name)) selected.add(name);
      }
    }
  }

  for (const tool of opts.hostTools) {
    if (mentionsTool(text, tool.name)) selected.add(tool.name);
  }
  for (const rule of SESSION_TOOL_FAMILY_RULES) {
    const surfaceMatch = matchesSurfaceAwareFamilyIntent(rule.id, text, opts.surfaceId);
    if (!rule.match(text) && !surfaceMatch) continue;
    for (const name of rule.names) {
      if (available.has(name)) selected.add(name);
    }
  }

  return applyDebugMinimalFilter(
    [...selected]
      .filter(name => isToolAvailable(name, opts.toolAvailability))
      .map(name => available.get(name))
      .filter((tool): tool is LLMToolDef => !!tool),
  );
}

const ESSENTIAL_NATIVE_RULE_IDS = [
  'code-read', 'code-grep', 'code-glob', 'code-list-dir', 'code-edit', 'code-write',
  // Keep dev-harness in the assembly candidate set so the catalog policy below is the single model-exposure authority.
  'agent', 'agent-output', 'agent-reply', 'agent-stop', 'agent-list', 'self-implement', 'self-orchestrate', 'dev-harness',
] as const;
const ESSENTIAL_HOST_FAMILY_IDS = ['self-ops', 'release-read'] as const;
const ESSENTIAL_RUNTIME_FAMILY_IDS = ['bash', 'run-shell', 'pty-shell', 'run-tests', 'elanous_skills_list', 'skill_exec', 'code-grounding'] as const;
const ESSENTIAL_OPTIONAL_TOOL_NAMES = [
  'GetDashboardState',
  'TerminalModalList', 'TerminalModalObserve', 'TerminalModalFocus', 'TerminalModalDetach', 'TerminalModalKill',
] as const;

function buildEssentialSessionRuntimeToolSpecs(opts: {
  hostTools: readonly LLMToolDef[];
  runtimeTools: readonly ToolRuntime<Record<string, unknown>, ToolRunResult>[];
  optionalTools: readonly LLMToolSpec[];
  toolAvailability?: Readonly<Record<string, boolean>>;
}): LLMToolSpec[] {
  const nativeSpecs = ESSENTIAL_NATIVE_RULE_IDS.flatMap(id => {
    const rule = NATIVE_TOOL_FAMILY_RULE_MAP.get(id);
    if (!rule) return [];
    const spec = rule.build();
    // Essential schemas honor catalog explicit-only policy so a hidden front door cannot be re-exposed here.
    const catalogEntry = findNativeTool(spec.name);
    return (!catalogEntry || isNativeToolModelExposed(catalogEntry))
      && isNativeToolAvailable(spec.name, rule, opts.toolAvailability)
      ? [spec]
      : [];
  });
  const hostByName = new Map(opts.hostTools.map(tool => [tool.name, tool] as const));
  const hostSpecs = ESSENTIAL_HOST_FAMILY_IDS.flatMap(id => {
    const rule = HOST_TOOL_FAMILY_RULE_MAP.get(id);
    return rule
      ? rule.names
        .filter(name => isToolAvailable(name, opts.toolAvailability))
        .map(name => hostByName.get(name))
        .filter((tool): tool is LLMToolDef => !!tool)
        .map(toSpec)
      : [];
  });
  const runtimeById = new Map(opts.runtimeTools.map(tool => [tool.id, tool] as const));
  const runtimeSpecs = ESSENTIAL_RUNTIME_FAMILY_IDS.flatMap(id => {
    const rule = RUNTIME_TOOL_FAMILY_RULE_MAP.get(id);
    return rule
      ? rule.names
        .map(name => runtimeById.get(name))
        .filter((tool): tool is ToolRuntime<Record<string, unknown>, ToolRunResult> => !!tool)
        .filter(tool => isToolAvailable(tool.spec.name, opts.toolAvailability))
        .map(tool => tool.spec)
      : [];
  });
  const optionalByName = new Map(opts.optionalTools.map(tool => [tool.name, tool] as const));
  const optionalSpecs = ESSENTIAL_OPTIONAL_TOOL_NAMES
    .map(name => optionalByName.get(name))
    .filter((tool): tool is LLMToolSpec => !!tool)
    .filter(tool => isToolAvailable(tool.name, opts.toolAvailability));
  return [...nativeSpecs, ...hostSpecs, ...runtimeSpecs, ...optionalSpecs];
}

export function buildSessionRuntimeToolSpecs(opts: {
  userText: string;
  hostTools: readonly LLMToolDef[];
  runtimeTools?: readonly ToolRuntime<Record<string, unknown>, ToolRunResult>[];
  pluginTools?: readonly LLMToolDef[];
  schedulerTools?: readonly LLMToolSpec[];
  optionalTools?: readonly LLMToolSpec[];
  toolAvailability?: Readonly<Record<string, boolean>>;
  surface?: SessionSurfaceProfile;
  preferredSurfaceId?: SessionSurfaceId;
  controlMode?: boolean;
  /** TUI --rich preserves the legacy userText-driven surface catalog. */
  rich?: boolean;
}): LLMToolSpec[] {
  const surface = opts.surface ?? resolveSessionSurfaceProfile({
    userText: opts.userText,
    preferredSurfaceId: opts.preferredSurfaceId,
    controlMode: opts.controlMode,
  });
  const dynamicHostTools = resolveDynamicSessionHostTools({
    userText: opts.userText,
    hostTools: opts.hostTools,
    toolAvailability: opts.toolAvailability,
    defaultFamilyIds: surface.defaultHostFamilyIds,
    surfaceId: surface.id,
  });
  const dynamicRuntimeTools = resolveDynamicSessionRuntimeToolSpecs({
    userText: opts.userText,
    runtimeTools: opts.runtimeTools ?? [],
    defaultFamilyIds: surface.defaultRuntimeFamilyIds,
    surfaceId: surface.id,
  });
  const dynamicNativeTools = resolveDynamicSessionNativeToolSpecs({
    userText: opts.userText,
    toolAvailability: opts.toolAvailability,
    defaultFamilyIds: surface.defaultNativeFamilyIds,
    surfaceId: surface.id,
  });
  const hostSpecs = dynamicHostTools.map(toSpec);
  const pluginSpecs = (opts.pluginTools ?? []).map(toSpec);
  const schedulerSpecs = opts.schedulerTools ?? [];
  const optionalSpecs = opts.optionalTools ?? [];
  // Native tools (Read/Bash/Grep/Edit/Write/...) come first so the
  // catalog's leading slots are stable across surfaces. research/turn
  // for example overrides hostSpecs with debug_*/input_history_*; if
  // those landed in front of native, the LLM mis-recognizes its own
  // toolset (incident 2026-05-04 — Opus replied "no file tools in this
  // session" while Bash was actually exposed at position 7+).
  const finalSpecs: LLMToolSpec[] = opts.rich === false
    ? buildEssentialSessionRuntimeToolSpecs({
        hostTools: opts.hostTools,
        runtimeTools: opts.runtimeTools ?? [],
        optionalTools: opts.optionalTools ?? [],
        toolAvailability: opts.toolAvailability,
      })
    : [
        ...dynamicNativeTools,
        ...hostSpecs,
        ...dynamicRuntimeTools,
        ...pluginSpecs,
        ...schedulerSpecs,
        ...optionalSpecs,
      ];
  // Forensic — final tool list returned to streamLLMWithTools. Lets
  // us diff TUI vs JSON-test (`elanous repro`) tool exposure when codex
  // behavior diverges. Counts AND names so we can spot per-source
  // contributions.
  //
  // ⭐ always-on — "어느 서피스 프로필로 조립됐나" 는 멤버십 질문의 절반이다.
  //
  //  `tool-catalog-assembled` 은 "무엇이 후보였나" 에 답하지만 "왜 그 목록인가" 에는
  //  답하지 못한다. 프로필이 userText 로 갈리므로(호출처가 surface 를 안 주면 여기서
  //  결정된다) 같은 서피스에서도 문장에 따라 다른 카탈로그가 나온다 — 실측: 같은 TUI 가
  //  28개와 33개를 냈다. 프로필 id 없이 그 차이를 보면 능력 회귀로 오독한다.
  //
  //  아래 llm.tool-exposure 와 달리 diag 게이트를 두지 않는다. 페이로드는 스칼라 4개 +
  //  family id 배열 1개다 — ⚠️ "스칼라뿐" 이 아니다(리뷰 정정). 실측 크기는 프로필당
  //  5~11개 짧은 식별자이고 스펙·프롬프트·툴 이름 전체는 담지 않는다. 그래서 always-on
  //  으로 감당 가능하다고 판단했다. llm.tool-exposure 를 diag 로 둔 이유는 그쪽이 매턴
  //  '툴 이름 전체 배열'이라 부담이 다르기 때문이다.
  //  ⇒ 운영에서 로그량을 한 번 관찰할 것: 감당 못 하면 nativeFamilyIds 만 diag 로 내린다
  //     (surfaceId 는 남겨야 이 이벤트의 존재 이유가 유지된다).
  debug.log('capability.resolve', 'surface-profile-resolved', {
    surfaceId: surface.id,
    // 호출처가 명시했나, 아니면 userText 로 추론됐나 — 배선 위치를 정할 때 이 구분이
    // 결정적이다(명시면 호출처를, 추론이면 규칙을 고쳐야 한다).
    explicitSurface: !!opts.surface,
    preferredSurfaceId: opts.preferredSurfaceId ?? null,
    nativeFamilyIds: surface.defaultNativeFamilyIds ?? [],
    toolCount: finalSpecs.length,
  });
  // diag-gated (분석 레벨) 유지 — 매턴 detail 이라 always-on 이면 노이즈 독.
  // 노출 tool 셋을 보려면 `/debug diag` 후 elanous logs --category llm.tool-
  // exposure. always-on 은 이상탐지(surface tool 0개·core 누락) 전용 — 루틴
  // per-turn 노출은 diag. (2026-07-17 규율: over-log 되돌림·runtime.resolve 는 유지.)
  if (debug.enabled) {
    debug.log('llm.tool-exposure', 'session-runtime-tool-specs.return', {
      total: finalSpecs.length,
      counts: {
        host: hostSpecs.length,
        runtime: dynamicRuntimeTools.length,
        native: dynamicNativeTools.length,
        plugin: pluginSpecs.length,
        scheduler: schedulerSpecs.length,
        optional: optionalSpecs.length,
      },
      names: finalSpecs.map(s => s.name),
      surfaceId: surface.id,
      userTextChars: opts.userText.length,
    });
  }
  return finalSpecs;
}

function resolveDynamicSessionRuntimeToolSpecs(opts: {
  userText: string;
  runtimeTools: readonly ToolRuntime<Record<string, unknown>, ToolRunResult>[];
  defaultFamilyIds?: readonly string[];
  surfaceId?: SessionSurfaceId;
}): LLMToolSpec[] {
  const text = opts.userText.toLowerCase();
  const available = new Map(opts.runtimeTools.map(tool => [tool.id, tool] as const));
  const selected = new Set<string>();

  // Pass 0 — T1 world-I/O substrate (RFC §3 · P2 상시화). Shell/PTY
  // execution is domain-independent substrate: a coding agent needs to
  // run what it builds on EVERY surface (research cross-check, ops
  // triage, control), not only the coding surfaces. Mirrors the native
  // 6-core Pass-0. Subject to availability — a surface that doesn't wire
  // the shell runtimes (`available.has` false) simply skips them, so no
  // phantom tools appear. Trade/financial dispatch is unaffected: these
  // are exposure only; execution safety stays in bash sandbox / PtyShell
  // approval (shell.allowDashboardPty) gates.
  for (const familyId of CORE_RUNTIME_FAMILY_IDS) {
    const rule = RUNTIME_TOOL_FAMILY_RULE_MAP.get(familyId);
    if (!rule) continue;
    for (const name of rule.names) {
      if (available.has(name)) selected.add(name);
    }
  }

  for (const familyId of opts.defaultFamilyIds ?? []) {
    const rule = RUNTIME_TOOL_FAMILY_RULE_MAP.get(familyId);
    if (!rule) continue;
    // code-grounding belongs to coding defaults but remains opt-in to avoid carrying its spec on every coding turn.
    // Its rule intentionally never dynamically matches: only coding profiles list it as a default family.
    if (rule.id === 'code-grounding' && !isCodeGroundingModelSurfaceEnabled()) continue;
    for (const name of rule.names) {
      if (available.has(name)) selected.add(name);
    }
  }

  for (const tool of opts.runtimeTools) {
    if (mentionsTool(text, tool.id) || mentionsTool(text, tool.spec.name)) {
      selected.add(tool.id);
    }
  }

  for (const rule of SESSION_RUNTIME_TOOL_FAMILY_RULES) {
    const surfaceMatch = matchesSurfaceAwareRuntimeIntent(rule.id, text, opts.surfaceId);
    if (!rule.match(text) && !surfaceMatch) continue;
    for (const name of rule.names) {
      if (available.has(name)) selected.add(name);
    }
  }

  const specs = [...selected]
    .map(name => available.get(name))
    .filter((tool): tool is ToolRuntime<Record<string, unknown>, ToolRunResult> => !!tool)
    .map(tool => tool.spec);
  // 관측 보강(2026-07-17) — native.resolve 미러. runtime 축(Bash·RunShell 등)이
  // 어느 surface/family 로 노출됐는지 elanous logs --category llm.tool-exposure 로
  // 조회 가능하게. runtime 축 로깅이 없어 "Bash 노출됐나" 를 로그로 못 봤던 갭.
  if (debug.enabled) {
    debug.log('llm.tool-exposure', 'runtime.resolve', {
      surfaceId: opts.surfaceId ?? null,
      defaultFamilyIds: [...(opts.defaultFamilyIds ?? [])],
      availableCount: available.size,
      selectedNames: specs.map(s => s.name),
    });
  }
  return specs;
}

/** Six core file-IO tools that survive on EVERY surface regardless
 *  of the surface's `defaultNativeFamilyIds`. User-stated invariant
 *  (2026-05-04): "the 6 core tools must stay alive even in basic
 *  mode." Their family IDs are merged ahead of the surface defaults
 *  so they always land in the catalog (subject to availability).
 *
 *  Ordering matches the historical coding/turn surface order so the
 *  catalog's first slot stays predictable when surfaces share the
 *  same six entries. */
const CORE_NATIVE_FAMILY_IDS: readonly string[] = [
  'code-read',
  'code-grep',
  'code-glob',
  'code-list-dir',
  'code-edit',
  'code-write',
];

/** T1 world-I/O substrate on the RUNTIME axis (RFC §3 · P2 상시화) —
 *  shell + interactive PTY execution that survives on EVERY surface,
 *  regardless of the surface's `defaultRuntimeFamilyIds`. Domain-
 *  independent: a coding agent must run what it builds on the research /
 *  control / ops surfaces too, not only the coding surfaces. The
 *  symmetric counterpart to `CORE_NATIVE_FAMILY_IDS`. Availability-gated
 *  (a surface that doesn't wire these runtimes just skips them). */
const CORE_RUNTIME_FAMILY_IDS: readonly string[] = [
  'bash',
  'run-shell',
  'pty-shell',
];

export function resolveDynamicSessionNativeToolSpecs(opts: {
  userText: string;
  toolAvailability?: Readonly<Record<string, boolean>>;
  defaultFamilyIds?: readonly string[];
  surfaceId?: SessionSurfaceId;
}): LLMToolSpec[] {
  const text = opts.userText.toLowerCase();
  const selected: LLMToolSpec[] = [];
  const seen = new Set<string>();
  // Forensic — record every reason a tool was kept or dropped so we
  // can reconstruct "why is Bash not in the catalog" from the log
  // alone (incident 2026-05-04: research/turn surface mounted only
  // 1 native tool while the user expected file-read access).
  const decisions: Array<{ familyId: string; toolName: string | null; verdict: 'kept-core' | 'kept-default' | 'kept-keyword' | 'kept-surface' | 'dropped-duplicate' | 'dropped-unavailable' | 'dropped-no-match' }> = [];
  // Pass 0 — CORE family IDs always come first.
  for (const familyId of CORE_NATIVE_FAMILY_IDS) {
    for (const rule of SESSION_NATIVE_TOOL_RULES) {
      if (rule.id !== familyId) continue;
      const spec = rule.build();
      if (seen.has(spec.name)) {
        decisions.push({ familyId, toolName: spec.name, verdict: 'dropped-duplicate' });
        continue;
      }
      if (!isNativeToolAvailable(spec.name, rule, opts.toolAvailability)) {
        decisions.push({ familyId, toolName: spec.name, verdict: 'dropped-unavailable' });
        continue;
      }
      seen.add(spec.name);
      selected.push(spec);
      decisions.push({ familyId, toolName: spec.name, verdict: 'kept-core' });
    }
  }
  for (const familyId of opts.defaultFamilyIds ?? []) {
    for (const rule of SESSION_NATIVE_TOOL_RULES) {
      if (rule.id !== familyId) continue;
      const spec = rule.build();
      if (seen.has(spec.name)) {
        decisions.push({ familyId, toolName: spec.name, verdict: 'dropped-duplicate' });
        continue;
      }
      if (!isNativeToolAvailable(spec.name, rule, opts.toolAvailability)) {
        decisions.push({ familyId, toolName: spec.name, verdict: 'dropped-unavailable' });
        continue;
      }
      seen.add(spec.name);
      selected.push(spec);
      decisions.push({ familyId, toolName: spec.name, verdict: 'kept-default' });
    }
  }
  for (const rule of SESSION_NATIVE_TOOL_RULES) {
    const surfaceMatch = matchesSurfaceAwareNativeIntent(rule.id, text, opts.surfaceId);
    const keywordMatch = rule.match(text);
    if (!keywordMatch && !surfaceMatch) {
      decisions.push({ familyId: rule.id, toolName: null, verdict: 'dropped-no-match' });
      continue;
    }
    const spec = rule.build();
    if (seen.has(spec.name)) {
      decisions.push({ familyId: rule.id, toolName: spec.name, verdict: 'dropped-duplicate' });
      continue;
    }
    if (!isNativeToolAvailable(spec.name, rule, opts.toolAvailability)) {
      decisions.push({ familyId: rule.id, toolName: spec.name, verdict: 'dropped-unavailable' });
      continue;
    }
    seen.add(spec.name);
    selected.push(spec);
    decisions.push({ familyId: rule.id, toolName: spec.name, verdict: keywordMatch ? 'kept-keyword' : 'kept-surface' });
  }
  if (debug.enabled) {
    debug.log('llm.tool-exposure', 'native.resolve', {
      surfaceId: opts.surfaceId ?? null,
      defaultFamilyIds: [...(opts.defaultFamilyIds ?? [])],
      selectedNames: selected.map(s => s.name),
      decisions,
    });
  }
  return selected;
}

export async function dispatchSessionRuntimeTool(
  name: string,
  args: Record<string, unknown>,
  deps: SessionRuntimeDispatchDeps,
): Promise<unknown> {
  // Fix W-bis (2026-04-25): codex family always enables scoped-analysis
  // mode regardless of userText vocabulary. Rationale (see docs/RESEARCH-
  // codex-reread-pathology-2refs-2026-04-25.md): codex's search-heavy
  // pattern means narrowing is ALWAYS valuable for it; the keyword
  // dictionary (isScopedAnalysisRequest) is brittle to paraphrasing
  // (Korean/English/etc.) and adding keywords reactively is a losing
  // game. Claude family is unaffected — it self-regulates well and the
  // dictionary stays as opt-in for explicit analysis prompts.
  const scopedAnalysis =
    isScopedAnalysisRequest(deps.userText) || deps.modelFamily === 'codex';
  const normalizedArgs = maybeRewriteScopedRecursiveSearchArgs(name, args, deps.userText);
  // 제1원칙 관측 — 인터랙티브(TUI/messenger/REPL) 소스수집 계측. 데몬 경로(daemon-tools)와
  // 별개·중복없음(데몬은 이 함수를 안 씀). 같은 kind 어휘(read/grep/glob/web/shell).
  // RunShell/Bash 는 curl/wget/URL 이면 web(로컬 canonical 우회 판별). fail-open.
  try {
    const a = normalizedArgs as Record<string, unknown>;
    if (name === 'Read') debug.log('agent.source', 'read', { path: a.file_path });
    else if (name === 'Grep') debug.log('agent.source', 'grep', { pattern: a.pattern, path: a.path });
    else if (name === 'Glob') debug.log('agent.source', 'glob', { pattern: a.pattern });
    else if (name === 'WebSearch') debug.log('agent.source', 'web', { query: a.query });
    else if (name === 'WebFetch') debug.log('agent.source', 'web', { url: a.url });
    else if (name === 'Bash' || name === 'RunShell') {
      const cmd = Array.isArray(a.command) ? (a.command as string[]).join(' ') : String(a.command ?? '');
      debug.log('agent.source', /\b(curl|wget)\b|https?:\/\//i.test(cmd) ? 'web' : 'shell', { command: cmd.slice(0, 300) });
    }
  } catch { /* fail-open */ }
  const broadSearchBlock = maybeBlockBroadProjectRootExploration(name, normalizedArgs, deps.userText);
  if (broadSearchBlock) return broadSearchBlock;
  const repeatedListing = handleRepeatedCandidateListing(
    name,
    normalizedArgs,
    scopedAnalysis,
    deps.modelFamily,
    deps.searchPlannerState,
    deps.turnIndex,
  );
  if (repeatedListing.kind === 'block') return repeatedListing.message;
  if (repeatedListing.kind === 'auto-read') {
    const resolvedFilePath = repeatedListing.filePath.startsWith('/')
      ? repeatedListing.filePath
      : resolve(getSessionCwd(), repeatedListing.filePath);
    const readResult = await dispatchRead({ file_path: resolvedFilePath }, { pathPolicy: deps.pathPolicy });
    return {
      ...readResult,
      output:
        `[AUTO-NARROWED] Repeated candidate-listing search converted into ` +
        `Read(file_path=${JSON.stringify(resolvedFilePath)}).\n\n${readResult.output}`,
    };
  }
  // Surface-unification v2.2 V2.2-5 Part 2 (2026-05-11) — scheduler tool
  // dispatch branch retired. scheduler-retirement R1 의 stub 이 항상 false
  // 반환했으므로 branch 자체 dead code 였음.

  const nativeRule = getNativeToolDispatchRules().get(name);
  if (nativeRule && isAutonomousTool(name)) {
    const dispatch = deps.dispatchAutonomousTool ?? dispatchAutonomousTool;
    let feedbackEnvelopeCount = 0;
    const emitFeedback = deps.emitFeedback
      ? (envelope: FeedbackEnvelope) => {
          feedbackEnvelopeCount += 1;
          deps.emitFeedback?.(envelope);
        }
      : undefined;
    const result = await dispatch(name, normalizedArgs, {
      cwd: getSessionCwd(),
      signal: deps.signal ?? new AbortController().signal,
      // ⛔⭐ 「안 넘김」(undefined)과 「말했는데 어휘가 없음」('')은 «다른 값»이다 —
      //   harnessMentionState 가 `undefined → 'absent'` · `'' → 'not-matched'` 로 가른다.
      //   truthiness 로 접으면 그 둘이 같아진다. ⚠️ 이 줄은 이 PR 이 낸 회귀가 «아니고»
      //   main 에도 같은 형태로 있었다 — 무인 리뷰가 짚어 «여기서» 고친다.
      ...(deps.userText !== undefined ? { userText: deps.userText } : {}),
      ...(emitFeedback ? { emitFeedback } : {}),
    });
    // ⛔ 관측이 «성공한 디스패치를 실패로 바꾸지 않는다» — 이 로그가 던지면 자율툴이 이미
    //   끝났는데도 호출 전체가 reject 된다(무인 리뷰 R4 must-fix ① · 정확한 지적).
    //   ⭐ 값 자체는 부재(carrier 없음)와 미지(0건)를 다른 값으로 남긴다.
    try {
      debug.log('session-runtime.autonomous-feedback', 'dispatch-complete', {
        toolName: name,
        feedbackCarrier: emitFeedback ? 'provided' : 'absent',
        feedbackEnvelopeCount: emitFeedback ? feedbackEnvelopeCount : 'unobservable',
      });
    } catch {
      // Observability must not turn a completed autonomous dispatch into a rejection.
    }
    rememberCandidateListingResult(name, normalizedArgs, result, scopedAnalysis, deps.searchPlannerState);
    return result;
  }
  // ⛔ opt-in only — see `SessionNativeToolRule.preferRuntime`. Without the
  //    flag check this also captures Read/Edit/Write (their aliases resolve to
  //    registered runtimes) and drops `pathPolicy` on the floor.
  const nativeRuntime = nativeRule?.preferRuntime ? deps.getToolRuntime(name) : undefined;
  if (nativeRuntime) {
    const result = await deps.dispatchToolRuntime(name, normalizedArgs, deps.toolCallId);
    rememberCandidateListingResult(name, normalizedArgs, result, scopedAnalysis, deps.searchPlannerState);
    return result;
  }
  if (nativeRule?.dispatch) {
    let result: unknown;
    if (deps.dispatchNativeTool) {
      result = await deps.dispatchNativeTool(name, normalizedArgs, deps.signal);
    } else {
      if (nativeRule.id === 'agent' && !deps.agentHostTools?.length) {
        try {
          debug.log('session-runtime.dispatch', 'agent-runtime-fallback-no-tools', {
            toolName: name,
            runtimeAvailable: false,
            hostToolCount: 0,
          }, { level: 'warn' });
        } catch {
          // Observability must not prevent the inline fallback dispatch.
        }
      }
      result = await nativeRule.dispatch(normalizedArgs, deps.signal, {
        pathPolicy: deps.pathPolicy,
        agentHostTools: deps.agentHostTools,
        agentDispatchTool: deps.agentDispatchTool,
        buildChildToolCatalog: deps.buildChildToolCatalog,
      });
    }
    rememberCandidateListingResult(name, normalizedArgs, result, scopedAnalysis, deps.searchPlannerState);
    return result;
  }

  const rt = deps.getToolRuntime(name);
  if (rt) {
    const isPtyTool = name.startsWith('PtyShell') || name.startsWith('pty_shell');
    if (!isPtyTool || deps.ptyDashboardOn) {
      const result = await deps.dispatchToolRuntime(name, normalizedArgs, deps.toolCallId);
      rememberCandidateListingResult(name, normalizedArgs, result, scopedAnalysis, deps.searchPlannerState);
      return result;
    }
  }

  const res = await deps.dispatchPluginTool(name, normalizedArgs);
  if (!res.ok) return { error: res.error };
  rememberCandidateListingResult(name, normalizedArgs, res.result, scopedAnalysis, deps.searchPlannerState);
  return res.result;
}

function toSpec(tool: LLMToolDef): LLMToolSpec {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}

function mentionsTool(text: string, toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  if (text.includes(normalized)) return true;
  const humanized = normalized.replace(/[_]/g, ' ');
  return humanized !== normalized && text.includes(humanized);
}

function hasAny(text: string, needles: readonly string[]): boolean {
  return needles.some(needle => text.includes(needle));
}

function matchesIntentLexicon(text: string, lexicon: readonly string[]): boolean {
  return hasAny(text, lexicon);
}

const UI_MUTATION_INTENT_TERMS = [
  'open pane',
  'close pane',
  'open modal',
  'apply layout',
  'save layout',
  'reset layout',
  'set active view',
  'pane 열어',
  'pane 닫아',
  '모달 열어',
  '레이아웃 적용',
  '레이아웃 저장',
  '레이아웃 리셋',
  '활성 뷰',
] as const;

const PROMPT_INTENT_TERMS = [
  'system prompt',
  'prompt runtime',
  'injection',
  '프롬프트',
  '주입',
] as const;

const DEBUG_INTENT_TERMS = [
  'debug',
  'trace',
  'call stack',
  'event log',
  'history',
  'diagnose',
  '디버그',
  '트레이스',
  '콜스택',
  '이벤트 로그',
  '진단',
] as const;

const OPS_FLEET_BASE_INTENT_TERMS = [
  'iphone',
  'ipad',
  'budget',
  'budgets',
  'policy',
  'policies',
  'llm node',
  'llm fleet',
  'fleet',
  'acp session',
  'agent room',
  'agent handoff',
  'team create',
  'team delete',
  'send message',
  'notify me',
  'notify phone',
  '아이폰',
  '아이패드',
  '예산',
  '정책',
  '함대',
  '알림 보내',
  '폰으로',
  '휴대폰',
  '팀 생성',
  '팀 삭제',
] as const;

const EXPLICIT_LSP_INTENT_TERMS = [
  'lsp',
  'language server',
  'code intelligence',
  'semantic search',
  'symbol lookup',
  'workspace symbol',
  'go to definition',
  'find references',
  'definition',
  'find definition',
  'go to implementation',
  'implementation',
  'references',
  'find usages',
  'usages',
  'call path',
  'call hierarchy',
  'symbol',
  'hover info',
  'hover information',
  '정의로 이동',
  '참조 찾기',
  '정의',
  '구현',
  '참조',
  '사용처',
  '호출 경로',
  '호출 계층',
  '심볼',
  '심볼 조회',
  '워크스페이스 심볼',
  '코드 인텔리전스',
  '언어 서버',
  '시맨틱 검색',
  'lsp로',
] as const;

const CODING_AGENT_EXPLORATION_INTENT_TERMS = [
  'definition',
  'find definition',
  'references',
  'find references',
  'implementation',
  'call hierarchy',
  'call path',
  'symbol',
  'workspace symbol',
  '정의',
  '참조',
  '구현',
  '호출 경로',
  '호출 계층',
  '사용처',
  '심볼',
] as const;

const STRUCTURAL_SEARCH_INTENT_TERMS = [
  'pattern',
  'patterns',
  'structure',
  'structural',
  'syntax form',
  'syntax tree',
  'match this shape',
  'imports pattern',
  'call shape',
  'code shape',
  '패턴',
  '구조',
  '구문 형태',
  '호출 형태',
  '이런 형태',
  '이런 구조',
] as const;

const RESEARCH_FETCH_INTENT_TERMS = [
  'read the page',
  'read this page',
  'page body',
  'full page',
  'document body',
  'fetch the article',
  'read the article',
  'read the document',
  '페이지 읽어',
  '페이지 본문',
  '문서 본문',
  '아티클 읽어',
  '기사 읽어',
  '본문 읽어',
] as const;

const OPS_FLEET_LOOKUP_INTENT_TERMS = [
  'status page',
  'incident',
  'outage',
  'service health',
  'runbook',
  'release note',
  'release notes',
  '운영 현황',
  '장애 현황',
  '상태 페이지',
  '서비스 상태',
  '런북',
  '릴리즈 노트',
] as const;

const OPS_FLEET_TEAM_INTENT_TERMS = [
  'team create',
  'team delete',
  'team',
  '팀 생성',
  '팀 삭제',
  '팀',
] as const;

const OPS_FLEET_BUDGET_INTENT_TERMS = [
  'budget',
  'budgets',
  'cost limit',
  'usage limit',
  '예산',
  '비용 제한',
  '사용량 제한',
] as const;

const OPS_FLEET_POLICY_INTENT_TERMS = [
  'policy',
  'policies',
  'route decision',
  'router decision',
  '정책',
  '정책 결정',
  '라우팅 결정',
] as const;

const OPS_FLEET_AGENT_ROOM_INTENT_TERMS = [
  'agent room',
  'agent rooms',
  'multi agent',
  'multi-agent',
  'agent handoff',
  '에이전트 룸',
  '멀티 에이전트',
  '에이전트 핸드오프',
] as const;

const OPS_FLEET_LLM_INTENT_TERMS = [
  'llm node',
  'llm nodes',
  'llm fleet',
  'local llm',
  'local-llm',
  'lm studio',
  'ollama',
  'model install',
  '모델 설치',
  'llm 노드',
  '로컬 llm',
  '올라마',
] as const;

const OPS_FLEET_ACP_INTENT_TERMS = [
  'acp session',
  'acp',
  'background agent',
  'subagent',
  'join session',
  'resume session',
  'acp 세션',
  '백그라운드 에이전트',
  '서브에이전트',
  '세션 합류',
  '세션 재개',
] as const;

const OPS_UI_INTENT_TERMS = [
  'windows',
  'window',
  'panes',
  'pane',
  'splits',
  'split',
  'dashboard',
  'terminal matrix',
  'terminal modal',
  'layout',
  'virtual window',
  'virtual windows',
  'widget',
  'widgets',
  'context pane',
  'context window',
  '창',
  '패널',
  '분할',
  '대시보드',
  '터미널 매트릭스',
  '터미널 모달',
  '레이아웃',
  '가상 창',
  '버추얼 윈도우',
  '위젯',
  '컨텍스트',
] as const;

const DEV_HARNESS_INTENT_TERMS = [
  // RunDevHarness tool description forms — keep session exposure aligned.
  '하니스로 개발',
  '하니스:',
  '하니스로 구현해줘',
  '하니스 구현',
  // ⛔⭐ 영어는 «구»여야 한다 — 맨 낱말 `harness` 를 물면 「the test harness failed」·
  //   「a wiring harness for the car」처럼 «스치기만 한» 문장이 전부 이 툴을 연다.
  //   📏 2026-09-11 실측: 맨 낱말이던 판에서 그럴듯한 다섯 문장이 ***5/5 오탐***이었다.
  'use the harness to',
  'self dev',
  // Existing session-runtime forms.
  '개발 하니스로',
  '하니스로 구현',
  '하니스로 골 제출',
  'develop with the harness',
  'implement with the harness',
  'submit a goal with the harness',
] as const;

const WEB_SEARCH_INTENT_TERMS = [
  'web search',
  'search the web',
  'look up',
  'latest',
  'recent',
  'today',
  'news',
  'verify online',
  'search online',
  'official docs',
  'official documentation',
  'source link',
  'current status',
  'current info',
  'current version',
  'current release',
  '웹에서',
  '검색해',
  '찾아봐',
  '최신',
  '최근',
  '뉴스',
  '출처',
  '공식 문서',
  '공식 자료',
  '웹 검색',
  '현재 상황',
  '현재 정보',
  '현재 버전',
  '현재 릴리즈',
  '외부 검색',
  '외부 자료',
] as const;

// ── web-search EXPOSURE-only 어휘 (surface flip 안 함) ────────────────
// 근본 수복(2026-07-17): web-search intent 는 두 효과를 갖는다 — (1) native
// WebSearch tool 노출(Pass-2, surface-독립) (2) surface 를 research/turn 으로
// flip(resolveSessionSurfaceProfile). 위 WEB_SEARCH_INTENT_TERMS 는 둘 다
// 유발한다. AI provider 명(그록/gpt/claude 등)은 이 LLM 레포에서 코딩/설정
// 대화에 상시 등장하는 substring 이라, surface flip 을 유발하면 코딩 요청을
// 오라우팅한다. 그래서 provider 명은 **노출만** 하고 flip 은 안 하게 분리:
// exposure = INTENT_TERMS ∪ PROVIDER_TERMS, flip = INTENT_TERMS 만.
// → "gpt 로 이 에러 찾아봐" = coding surface 유지 + WebSearch 노출(대표 원안
// 전부 안전 수용). generic "gpt 모델 설정 바꿔줘" = WebSearch 노출되나 model
// 이 안 부르면 무해(tool 1개), surface 는 coding 불변.
const WEB_SEARCH_PROVIDER_TERMS = [
  '그록',
  'grok',
  '제미나이',
  'gemini',
  'gpt',
  '클로드',
  'claude',
] as const;

const DEEP_RESEARCH_INTENT_TERMS = [
  'research',
  'deep research',
  'triangulate',
  'compare sources',
  'multiple sources',
  'community reaction',
  'reddit reaction',
  'x reaction',
  'trend',
  'sentiment',
  '여러 소스',
  '깊게 조사',
  '리서치',
  '반응',
  '트렌드',
  '여론',
  '비교 조사',
  '교차검증',
] as const;

const WEB_FETCH_INTENT_TERMS = [
  'http://',
  'https://',
  'fetch url',
  'fetch this page',
  'read this page',
  'open this url',
  'extract this url',
  'fetch content',
  'page content',
  '본문 가져와',
  '페이지 읽어',
  '이 url',
  '이 링크',
  '웹페이지 본문',
  'url 읽어',
] as const;

const CONTROL_MUTATION_INTENT_TERMS = [
  'control',
  'operator action',
  '제어',
  '운영 작업',
  ...UI_MUTATION_INTENT_TERMS,
] as const;

const OPS_UI_PROMPT_INTENT_TERMS = [
  'prompt bank',
  ...PROMPT_INTENT_TERMS,
  '프롬프트 런타임',
] as const;

const CONTROL_PROMPT_INTENT_TERMS = [
  'control prompt',
  ...PROMPT_INTENT_TERMS,
  '프롬프트 런타임',
  '시스템 프롬프트',
] as const;

const OPS_UI_DEBUG_INTENT_TERMS = [
  ...DEBUG_INTENT_TERMS,
  'why is this stuck',
  '왜 막혔',
] as const;

const CONTROL_DEBUG_INTENT_TERMS = [
  ...DEBUG_INTENT_TERMS,
  '히스토리',
] as const;

function hasExplicitLspIntent(text: string): boolean {
  return matchesIntentLexicon(text, EXPLICIT_LSP_INTENT_TERMS);
}

function hasCodingAgentCodeExplorationIntent(text: string): boolean {
  return matchesIntentLexicon(text, CODING_AGENT_EXPLORATION_INTENT_TERMS);
}

function hasCodingAgentStructuralSearchIntent(text: string): boolean {
  return matchesIntentLexicon(text, STRUCTURAL_SEARCH_INTENT_TERMS);
}

function hasResearchAgentFetchIntent(text: string): boolean {
  return matchesIntentLexicon(text, RESEARCH_FETCH_INTENT_TERMS);
}

function hasOpsFleetOperationalLookupIntent(text: string): boolean {
  return matchesIntentLexicon(text, OPS_FLEET_LOOKUP_INTENT_TERMS);
}

function hasOpsFleetIntent(text: string): boolean {
  return matchesIntentLexicon(text, OPS_FLEET_BASE_INTENT_TERMS);
}

function hasDevHarnessIntent(text: string): boolean {
  return hasAny(text, DEV_HARNESS_INTENT_TERMS);
}

export function shouldExposeDevHarnessSessionTool(text: string): boolean {
  return isDevHarnessModelSurfaceEnabled() && hasDevHarnessIntent(text);
}

function hasOpsFleetTeamIntent(text: string): boolean {
  return matchesIntentLexicon(text, OPS_FLEET_TEAM_INTENT_TERMS);
}

function hasOpsUiMutationIntent(text: string): boolean {
  return matchesIntentLexicon(text, UI_MUTATION_INTENT_TERMS);
}

function hasControlMutationIntent(text: string): boolean {
  return matchesIntentLexicon(text, CONTROL_MUTATION_INTENT_TERMS);
}

function hasOpsUiPromptIntent(text: string): boolean {
  return matchesIntentLexicon(text, OPS_UI_PROMPT_INTENT_TERMS);
}

function hasControlPromptIntent(text: string): boolean {
  return matchesIntentLexicon(text, CONTROL_PROMPT_INTENT_TERMS);
}

function hasOpsUiDebugIntent(text: string): boolean {
  return matchesIntentLexicon(text, OPS_UI_DEBUG_INTENT_TERMS);
}

function hasControlDebugIntent(text: string): boolean {
  return matchesIntentLexicon(text, CONTROL_DEBUG_INTENT_TERMS);
}
function hasOpsFleetBudgetIntent(text: string): boolean {
  return matchesIntentLexicon(text, OPS_FLEET_BUDGET_INTENT_TERMS);
}

function hasOpsFleetPolicyIntent(text: string): boolean {
  return matchesIntentLexicon(text, OPS_FLEET_POLICY_INTENT_TERMS);
}

function hasOpsFleetAgentRoomIntent(text: string): boolean {
  return matchesIntentLexicon(text, OPS_FLEET_AGENT_ROOM_INTENT_TERMS);
}

function hasOpsFleetLlmIntent(text: string): boolean {
  return matchesIntentLexicon(text, OPS_FLEET_LLM_INTENT_TERMS);
}

function hasOpsFleetAcpIntent(text: string): boolean {
  return matchesIntentLexicon(text, OPS_FLEET_ACP_INTENT_TERMS);
}

function hasOpsUiIntent(text: string): boolean {
  return matchesIntentLexicon(text, OPS_UI_INTENT_TERMS);
}

function matchesSurfaceAwareFamilyIntent(
  familyId: string,
  text: string,
  surfaceId?: SessionSurfaceId,
): boolean {
  if (!surfaceId) return false;
  return SURFACE_AWARE_POLICIES[surfaceId]?.hostFamilyMatchers?.[familyId]?.(text) ?? false;
}

function matchesSurfaceAwareNativeIntent(
  familyId: string,
  text: string,
  surfaceId?: SessionSurfaceId,
): boolean {
  if (!surfaceId) return false;
  return SURFACE_AWARE_POLICIES[surfaceId]?.nativeFamilyMatchers?.[familyId]?.(text) ?? false;
}

function matchesSurfaceAwareRuntimeIntent(
  familyId: string,
  text: string,
  surfaceId?: SessionSurfaceId,
): boolean {
  if (!surfaceId) return false;
  return SURFACE_AWARE_POLICIES[surfaceId]?.runtimeFamilyMatchers?.[familyId]?.(text) ?? false;
}

function isToolAvailable(
  name: string,
  overrides?: Readonly<Record<string, boolean>>,
): boolean {
  if (Object.prototype.hasOwnProperty.call(overrides ?? {}, name)) {
    return overrides?.[name] === true;
  }
  const family = TOOL_NAME_TO_FAMILY.get(name);
  if (family?.isAvailable) return family.isAvailable(name);
  return true;
}

function isNativeToolAvailable(
  name: string,
  rule: SessionNativeToolRule,
  overrides?: Readonly<Record<string, boolean>>,
): boolean {
  if (Object.prototype.hasOwnProperty.call(overrides ?? {}, name)) {
    return overrides?.[name] === true;
  }
  if (rule.isAvailable) return rule.isAvailable(name);
  return true;
}

function isLspAvailable(): boolean {
  const languages: LspLanguageName[] = ['typescript', 'python', 'rust'];
  for (const language of languages) {
    const entry = resolveLanguageByName(language);
    if (!entry) continue;
    if (probeLanguageBinary(entry)) return true;
  }
  return false;
}

/** SURFACE-flip intent — strong web/research phrasing that justifies
 *  switching the session to the research/turn surface. Narrow on purpose:
 *  provider names live in the exposure-only set so they never flip a
 *  coding turn. Used by `resolveSessionSurfaceProfile`. */
function hasWebSearchIntent(text: string): boolean {
  return matchesIntentLexicon(text, WEB_SEARCH_INTENT_TERMS);
}

/** EXPOSURE intent — should the WebSearch tool be OPEN this turn (Pass-2,
 *  surface-independent)? Broader than the surface set: it also fires on
 *  AI provider names (그록/gpt/claude/…) so an explicit "gpt 로 찾아봐"
 *  opens WebSearch WITHOUT flipping the coding surface. Used by the
 *  native web-search rule's `match`. */
function hasWebSearchExposureIntent(text: string): boolean {
  return hasWebSearchIntent(text)
    || matchesIntentLexicon(text, WEB_SEARCH_PROVIDER_TERMS);
}

function hasResearchSearchIntent(text: string): boolean {
  return matchesIntentLexicon(text, DEEP_RESEARCH_INTENT_TERMS);
}

function hasWebFetchIntent(text: string): boolean {
  return matchesIntentLexicon(text, WEB_FETCH_INTENT_TERMS);
}
