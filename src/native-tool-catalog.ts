// Native tool catalog metadata.
//
// This is the first catalog layer shared by skill-runner and future plugin-host
// tool discovery. Dispatchers still live in their focused modules for now; this
// file records the common metadata needed for prompt injection, permission
// policy, tool search, and parallel execution planning.

import type { VerifierSpec } from './verifier/types.js';
import type { GuardianSpec } from './guardian/types.js';
import { ptyAvailable } from './pty-shell/registry.js';
import { krFlowAvailable } from './skills/tools/kr-flow.js';
import { SELF_COGNITION_MCP_CATALOG_ENTRIES } from './tool-runtime/self-cognition-runtimes.js';

export type { NativeToolHost } from './tool-surface.js';
import type { NativeToolHost } from './tool-surface.js';

export type NativeToolSafety =
  | 'read-only'
  | 'mutating'
  | 'network'
  | 'process'
  | 'agent'
  | 'permission'
  | 'debug';

/** 툴의 «행동 종류». ⛔ 이것은 카탈로그 분류 체계가 «아니다» — 시스템 프롬프트가 툴 «이름»을
 *  하드코딩하지 않고 「이 종류의 툴이 있나」로 절을 켜고 끄기 위한 «어휘»다(xAI grok-build 의
 *  ToolKind 계약을 이 저장소 어휘로 옮긴 것 · PLAN-grok-native-structure-absorption-2026-08-14).
 *
 *  ⭐ 그래서 집합이 «일부러» 좁다. 여기 없는 축(UI 상태·레이아웃·정책 조회·도메인 스킬·미디어
 *  ·세션 관측 등)의 툴은 ***`other` 가 정답이다*** — 미분류가 아니라 «그 절과 무관하다»는 뜻이다.
 *  ⛔ 「194개를 전부 의미 있게 나눠라」로 읽지 마라. 그렇게 읽으면 이 좁은 집합으로는 원리상
 *     표현할 수 없는 것을 요구하게 된다(2026-08-14 에 그 요구로 런 하나가 죽었다).
 *
 *  🩹 넓히려면 «프롬프트 절이 먼저» 생겨야 한다 — 절이 없는 종류를 더하면 그 값은 아무도 안 읽는다. */
export type NativeToolKind =
  | 'read'
  | 'edit'
  | 'write'
  | 'list-dir'
  | 'search'
  | 'execute'
  | 'web'
  | 'delegate'
  // ⭐ `plan`·`ask-user` 는 레퍼런스 대조로 «추가»됐다(2026-08-14).
  //   grok-build 의 프롬프트는 툴을 이름이 아니라 종류로 참조하는데
  //   (`${{ tools.by_kind.plan }}` = *"Managing task lists and tracking progress"* ·
  //    `${{ tools.by_kind.ask_user }}`), 우리 어휘엔 그 두 칸이 «없어서»
  //   해당 툴들이 `other` 로 떨어져 있었다 — 종류로 참조할 방법이 원리상 없었다.
  //   ⛔ 같은 형태의 결손이 같은 날 사고를 냈다: 툴 루프 페이즈 가드가
  //   `Plan`/`MarkStepDone` 을 몰라 거부했다(`#9062` 인시던트 · `#9066` 수리).
  //   ⚠️ plan-mode 진입/이탈(`enter_plan_mode`·`exit_plan_mode`)은 여기 넣지 «않는다» —
  //   레퍼런스도 그 둘은 종류가 아니라 «이름»으로 부른다(모드 전환이지 진행 추적이 아니다).
  | 'plan'
  | 'ask-user'
  | 'other';

/** Model capability tier used to gate tool exposure. T1 = strongest (Opus/Sonnet-4.x),
 *  T2 = mid (Haiku-4.x / GPT-5 / Grok-4), T3 = smaller. Gate filter may hide higher-cost
 *  meta-tools (e.g. `set_tool_hint`) from T3 to avoid spending tokens on reasoning
 *  the model can't leverage. Interpretation lives in `src/tool-hints/gate.ts` (P4). */
export type NativeToolTier = 'T1' | 'T2' | 'T3';

/** Registration-time capability probe. Result is cached in-process; gate consults
 *  it when filtering the catalog each turn. */
export type ProbeSpec =
  | { kind: 'env'; env: string; ttlMs?: number; onFail?: ProbeFailMode }
  | { kind: 'cli'; cli: { cmd: string; args?: string[]; timeoutMs?: number }; ttlMs?: number; onFail?: ProbeFailMode }
  | { kind: 'http'; http: { url: string; method?: 'GET' | 'HEAD'; timeoutMs?: number }; ttlMs?: number; onFail?: ProbeFailMode }
  | { kind: 'custom'; custom: () => boolean | Promise<boolean>; ttlMs?: number; onFail?: ProbeFailMode };

export type ProbeFailMode = 'hide' | 'disable' | 'warn';

export interface NativeToolCatalogEntry {
  id: string;
  kind: NativeToolKind;
  aliases: string[];
  displayName: string;
  description: string;
  promptSummary: string;
  host: NativeToolHost[];
  safety: NativeToolSafety[];
  supportsParallel: boolean;
  defaultEnabled: boolean;
  requires?: string[];
  /** When true, the skill-discipline prompt names this tool as
   *  "prefer this over composing shell equivalents". Typical for
   *  structured read/edit/search/fetch tools where a dedicated
   *  dispatcher is cleaner than `Bash cat` / `Bash grep`. Set
   *  false (or omit) for: the Bash tool itself, the Agent tool,
   *  and anything whose value is execution not convenience. */
  cleanerFitThanShell?: boolean;
  /** Registration-time capability check. If probe fails, tool is
   *  filtered out of the gate-returned catalog according to onFail
   *  (default 'hide'). env probes run at startup; cli/http/custom
   *  probes run on first catalog draw, cached with ttlMs (default
   *  300_000 for cli/http, Infinity for env). */
  probe?: ProbeSpec;
  /** Signal keys (from `src/tool-hints/signals.ts`) that influence
   *  this tool's visibility or boost in the gate. Informational —
   *  the actual rules live in gate.ts; this field documents the
   *  coupling so auditing "what signals matter for X" is greppable. */
  hintKeys?: string[];
  /** Minimum model tier required for this tool to appear. Weak
   *  models pay tokens per listed tool, so meta/less-essential
   *  tools can set minTier to 'T1' or 'T2' to stay hidden on T3. */
  minTier?: NativeToolTier;
  /** Arc D — post-call verifier. When set, dispatchToolByName runs
   *  the matching builtin after `rt.run()` returns and prepends
   *  `verifierIssues` to the result so the LLM can self-recover on
   *  the next turn. Auto-disabled after 3 consecutive turns with the
   *  same issue code (R-D1 guard, see `src/verifier/hook.ts`). */
  verifier?: VerifierSpec;
  /** Arc H — intent scope for tool count discipline. Filters this
   *  tool out of the gate-returned catalog when
   *  `HARNESS_TOOL_DISCIPLINE_ENABLED=1` and the scope is not active
   *  this turn. `'coding'` is always active (default lane);
   *  `'browse'|'viz'|'capture'|'ops'` require an intent regex match
   *  in `src/tool-hints/signals.ts`. `'always'` is never filtered;
   *  untagged entries default to `'always'` (pre-Arc-H behavior
   *  preserved). See `src/tool-hints/gate.ts` Step 2.5. */
  intentScope?: import('./tool-hints/types.js').ToolIntentScope;
  /** Arc B — pre-call guardian spec. When set and
   *  `HARNESS_GUARDIAN_ENABLED=1`, dispatchToolByName runs the policy
   *  before `rt.run()`. `deny` returns `{ok:false, error:"guardian:
   *  <reason>"}` — data, never exceptions. Scope-cut (coding-first):
   *  2 active kinds (`plugin-capability`, `trust-store`) + 2 forward-
   *  compat slots (`hitl-delivery`, `mutating-default`). Untagged
   *  entries default to undefined (guardian skipped). See
   *  `src/guardian/check.ts` and `내부 문서 `PLAN-harness-arc-b-guardian``. */
  guardian?: GuardianSpec;
  /** Coding Pipeline P1 — Deferred Tools primitive.
   *  When `alwaysLoad !== false` (default treated as always-load for
   *  backward compat), system prompt renders the tool's FULL LLMToolSpec.
   *  When `alwaysLoad === false` and `shouldDefer === true`, only the
   *  tool's name + short summary is exposed in the prompt; the LLM must
   *  invoke `ToolSearch({query:"select:<name>"})` to fetch the full
   *  schema mid-conversation. Mirrors claude-code-fork's
   *  `src/Tool.ts` `shouldDefer`/`alwaysLoad` fields.
   *
   *  Transition strategy: MVP ships the primitive; existing entries
   *  remain implicitly always-load so nothing regresses. A follow-up PR
   *  flips the default and marks ~30 specialised tools as deferred to
   *  slim the base system prompt. */
  alwaysLoad?: boolean;
  /** Coding Pipeline P1 — pair with `alwaysLoad`. See `alwaysLoad` doc
   *  for the full contract. Default undefined (treated as not-deferred). */
  shouldDefer?: boolean;
  /** Coding Pipeline P1 — when false, the tool is hidden from
   *  `ToolSearch` keyword/`select:` queries even if deferred. Use for
   *  safety-sensitive tools whose schema should never appear mid-turn.
   *  Default undefined → treated as true (searchable). */
  toolSearchable?: boolean;
}

export const nativeToolCatalog: NativeToolCatalogEntry[] = [
  ...SELF_COGNITION_MCP_CATALOG_ENTRIES,
  {
    id: 'bash',
    kind: 'execute',
    aliases: ['Bash', 'shell'],
    displayName: 'Bash',
    description: 'Run shell commands such as python3, node, tsx, bun, git, and project scripts.',
    promptSummary: '`Bash` (run shell commands - python3, node, tsx, bun, etc.)',
    // tui(=essential TUI) 노출 (2026-07-17): essential 은 codex/claude-code
    // 급 코딩 에이전트라 raw Bash(shell 해석·HEREDOC·pipe)가 필요. tui-surface
    // dispatch 는 sandbox='auto'(sandbox-exec 래핑) + approval-cache + audit-log 로
    // 완화(bash-runtime.ts ctx.surface==='tui'). RunShell(argv)과 병행 노출.
    host: ['skill', 'tui'],
    safety: ['process', 'mutating'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'coding',
  },
  {
    id: 'run_shell',
    kind: 'execute',
    aliases: ['RunShell', 'run_shell', 'exec_argv'],
    displayName: 'RunShell',
    description: 'Execute an argv-style command without shell interpretation. Approval cache + audit log. Prefer over Bash when command shape is known.',
    promptSummary: '`RunShell` (argv exec, no shell parsing, approval cache, audit trail in ~/.monad-agent/audit/)',
    host: ['skill', 'tui'],
    safety: ['process', 'mutating'],
    // Mutating tools run serially by catalog contract — matches Bash.
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'coding',
  },
  // NT-C1b-2 (session nt) — ShellRunner auxiliary tools. Read-only
  // over the shell-runner registry; safe to parallelise.
  {
    id: 'shell_list',
    kind: 'other',
    aliases: ['ShellList', 'shell_list'],
    displayName: 'ShellList',
    description: 'List shell-runner handles (running / backgrounded / completed). Useful before ShellPoll / ShellKill.',
    promptSummary: '`ShellList` (enumerate shell-runner commands by status/mode filter)',
    host: ['skill', 'tui'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'coding',
  },
  {
    id: 'shell_poll',
    kind: 'other',
    aliases: ['ShellPoll', 'shell_poll'],
    displayName: 'ShellPoll',
    description: 'Read current state of a shell-runner handle by id (for backgrounded / auto-bg commands).',
    promptSummary: '`ShellPoll` (status + exit code of a shell-runner handle; non-blocking)',
    host: ['skill', 'tui'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'coding',
  },
  {
    id: 'shell_kill',
    kind: 'execute',
    aliases: ['ShellKill', 'shell_kill'],
    displayName: 'ShellKill',
    description: 'Send SIGTERM (default) or SIGKILL to a running shell-runner handle by id.',
    promptSummary: '`ShellKill` (terminate shell-runner handle; optional SIGKILL)',
    host: ['skill', 'tui'],
    safety: ['process'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'coding',
  },
  {
    id: 'elanous_hold',
    kind: 'execute',
    aliases: ['ElanousHold', 'elanous_hold'],
    displayName: 'ElanousHold',
    description: 'Spawn a detached bare Elanous TUI held open for human control.',
    promptSummary: '`ElanousHold` (spawn a detached held Elanous TUI)',
    host: ['skill', 'tui', 'mcp'],
    safety: ['process'],
    supportsParallel: false,
    defaultEnabled: true,
  },
  {
    id: 'pty_control',
    kind: 'execute',
    aliases: ['PtyControl', 'pty_control'],
    displayName: 'PtyControl',
    description: 'Control a registered PTY through its owning process.',
    promptSummary: '`PtyControl` (inspect, control, resize, or terminate a registered PTY)',
    host: ['skill', 'tui', 'mcp'],
    safety: ['process'],
    supportsParallel: false,
    defaultEnabled: true,
  },
  // Capture arc — pane substrate ↔ LLM bridge (Phase 2 partial).
  // Screenshot returns PNG when format='png' so vision-capable models
  // (Claude / GPT-4V / Gemini) read pane layout visually — tmux/htop/
  // btop graphs that ANSI strip would destroy. InspectPane is the
  // lightweight "what's in this pane" probe before deciding to capture.
  {
    id: 'capture_screenshot',
    kind: 'other',
    aliases: ['Screenshot', 'capture_screenshot'],
    displayName: 'Screenshot',
    description: 'Capture a pane as text / ansi / svg / png / asciicast. PNG enables visual LLM inspection for TUI apps.',
    promptSummary: '`Screenshot` (capture pane as text/ansi/svg/png/asciicast — png for visual LLM inspection)',
    host: ['skill', 'tui', 'mcp'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'capture',
    cleanerFitThanShell: true,
  },
  {
    id: 'capture_inspect_pane',
    kind: 'other',
    aliases: ['InspectPane', 'capture_inspect_pane'],
    displayName: 'InspectPane',
    description: 'Describe a pane without capturing content — title, summary, kind, supportedTaps, chords, tools.',
    promptSummary: '`InspectPane` (pane title/summary/kind/taps/chords/tools — read-only metadata)',
    host: ['skill', 'tui', 'mcp'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'capture',
  },
  // VW layout arc — save / load / preset. SaveLayout writes to disk
  // atomically; LoadLayout + ApplyLayoutPreset return a restore plan
  // (spec + missing/tabs/floats) WITHOUT mutating the running VW.
  // Live reconstruction (pane spawn + mount) lands in a follow-up.
  {
    id: 'layout_save',
    kind: 'other',
    aliases: ['SaveLayout', 'layout_save'],
    displayName: 'SaveLayout',
    description: 'Save current VW layout to ~/.elanous/layouts/<slug>.layout.json (atomic).',
    promptSummary: '`SaveLayout` (persist current VW layout to ~/.elanous/layouts/)',
    host: ['skill', 'tui', 'mcp'],
    safety: ['mutating'],  // writes to disk
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'ops-ui',
  },
  {
    id: 'layout_load',
    kind: 'other',
    aliases: ['LoadLayout', 'layout_load'],
    displayName: 'LoadLayout',
    description: 'List saved layouts + built-in presets, or plan-restore a specific slug against a VW. Plan-only, no mutation.',
    promptSummary: '`LoadLayout` (enumerate saved layouts + presets, or plan restore for a slug)',
    host: ['skill', 'tui', 'mcp'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'ops-ui',
  },
  {
    id: 'layout_apply_preset',
    kind: 'other',
    aliases: ['ApplyLayoutPreset', 'layout_apply_preset'],
    displayName: 'ApplyLayoutPreset',
    description: 'Build a named preset (one-pane/two-pane-split/four-pane-kanban) + plan restore. Plan-only, no mutation.',
    promptSummary: '`ApplyLayoutPreset` (build preset spec + plan restore — plan only)',
    host: ['skill', 'tui', 'mcp'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'ops-ui',
  },
  {
    id: 'dashboard_state',
    kind: 'other',
    aliases: ['GetDashboardState', 'dashboard_state'],
    displayName: 'GetDashboardState',
    description: 'Return the current monad-agent dashboard state — PTY shells, terminal sessions, workspace cwd and exposed tools.',
    promptSummary: '`GetDashboardState` (snapshot: PTYs, terminal sessions, workspace, exposed tools — read-only)',
    host: ['skill', 'tui', 'mcp'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'ops-ui',
  },
  {
    id: 'agent_list',
    kind: 'other',
    aliases: ['AgentList', 'agent_list'],
    displayName: 'AgentList',
    description: 'Return the current agent-definition registry — every subagent_type available to the Agent tool, with source layer (builtin / plugin-builtin / user / project), model, permission mode, tool allowlist, and description.',
    promptSummary: '`AgentList` (introspect subagent_type catalog before calling Agent — read-only)',
    host: ['skill', 'tui', 'mcp'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'ops-fleet',
  },
  // ROADMAP-agent-surface-deferred-tools Wave 1 · W1.1 — retrieve the
  // result of a background AgentTask. Pairs with Agent(run_in_background=true).
  {
    id: 'agent_output',
    kind: 'other',
    aliases: ['AgentOutput', 'agent_output'],
    displayName: 'AgentOutput',
    description: 'Retrieve the final result of a background AgentTask by id. Blocks (up to timeoutMs) when block=true, else returns immediately with retrievalStatus=not_ready if the task is still running.',
    promptSummary: '`AgentOutput(taskId, block?, timeoutMs?)` (collect background Agent result · read-only)',
    host: ['skill', 'tui', 'mcp'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'ops-fleet',
  },
  // ROADMAP-agent-surface-deferred-tools Wave 1 · W1.2 — send abort
  // signal to a live AgentTask. Distinct from TOX TaskKill (persistent
  // TOX task target) — AgentStop targets ephemeral in-process spawns.
  {
    id: 'agent_stop',
    kind: 'other',
    aliases: ['AgentStop', 'agent_stop'],
    displayName: 'AgentStop',
    description: 'Send abort signal to a live background AgentTask by id. Returns immediately after dispatch; task state flips to aborted shortly after as the runner unwinds. Use AgentOutput(block:true) afterwards if you need to confirm terminal state.',
    promptSummary: '`AgentStop(taskId, reason?)` (cancel a background Agent · NOT TOX TaskKill)',
    host: ['skill', 'tui', 'mcp'],
    safety: ['mutating'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'ops-fleet',
  },
  // PFC-S1 P4: team-mailbox LLM tools. Group subagent spawns and
  // exchange messages between them via ~/.elanous/team-mailbox/.
  {
    id: 'team_create',
    kind: 'other',
    aliases: ['TeamCreate', 'team_create'],
    displayName: 'TeamCreate',
    description: 'Create a team directory under ~/.elanous/team-mailbox so subsequent SendMessage calls can group related Agent spawns. Idempotent — re-creating an existing team extends the member list.',
    promptSummary: '`TeamCreate(name, members?)` (group subagent spawns so they can exchange SendMessage)',
    host: ['skill', 'tui', 'mcp'],
    safety: ['mutating'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'ops-fleet',
  },
  {
    id: 'team_delete',
    kind: 'other',
    aliases: ['TeamDelete', 'team_delete'],
    displayName: 'TeamDelete',
    description: 'Remove a team directory + all its mailboxes. Destructive — message history is lost. Safe on missing teams (returns deleted:false).',
    promptSummary: '`TeamDelete(name)` (destructive — wipes team + all its mailboxes)',
    host: ['skill', 'tui', 'mcp'],
    safety: ['mutating'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'ops-fleet',
  },
  {
    id: 'send_message',
    kind: 'other',
    aliases: ['SendMessage', 'send_message'],
    displayName: 'SendMessage',
    description: 'Send a message to another agent (or "user") via the team mailbox. The recipient sees it on their next activation. Sender is derived from invocation context — you do not pass `from`.',
    promptSummary: '`SendMessage(to, body, team_name?, subject?, reply_to?)` (agent-to-agent mailbox message)',
    host: ['skill', 'tui', 'mcp'],
    safety: ['mutating'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'ops-fleet',
    // ROADMAP Wave 2 classification tightening — used only inside
    // multi-agent flows; hydrate via ToolSearch when needed.
    alwaysLoad: false,
    shouldDefer: true,
  },
  // Input-policy tools — Phase 6 of the unified-input plan.
  // SetInputMode is mutating but side-effect is tiny (context tag +
  // onEnter/onExit). GetInputPolicy is read-only. SetInputBinding is
  // mutating + reserved-guarded + audit-logged.
  {
    id: 'set_input_mode',
    kind: 'other',
    aliases: ['SetInputMode', 'set_input_mode'],
    displayName: 'SetInputMode',
    description: 'Switch the monad-agent operating mode: general | sync | control. Same-mode calls are no-ops; onEnter failures leave the prior mode active.',
    promptSummary: '`SetInputMode(mode)` (switch operating mode — general|sync|control)',
    host: ['skill', 'tui', 'mcp'],
    safety: ['mutating'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'ops-ui',
  },
  {
    id: 'get_input_policy',
    kind: 'other',
    aliases: ['GetInputPolicy', 'get_input_policy'],
    displayName: 'GetInputPolicy',
    description: 'Return the current input policy snapshot: active mode, full binding table (default/user-config/runtime layers), context stack, reserved keys/actions, action catalog.',
    promptSummary: '`GetInputPolicy` (active mode + bindings + context stack + reserved set + action catalog)',
    host: ['skill', 'tui', 'mcp'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'ops-ui',
  },
  {
    id: 'set_input_binding',
    kind: 'other',
    aliases: ['SetInputBinding', 'set_input_binding'],
    displayName: 'SetInputBinding',
    description: 'Add or replace a runtime keybinding. Empty `keys` array clears the runtime override. Reserved keys (ctrl+c/escape/enter/ctrl+q/ctrl+d) and reserved action IDs (app.interrupt/app.quit/modal.cancel/modal.submit) are rejected. Audit-logged to control-*.ndjson.',
    promptSummary: '`SetInputBinding(actionId, keys, context?)` (runtime rebind; reserved-guarded; audited)',
    host: ['skill', 'tui', 'mcp'],
    safety: ['mutating'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'ops-ui',
    // ROADMAP Wave 2 classification tightening — keybinding tweaks
    // are explicit user requests; rare from autonomous chat.
    alwaysLoad: false,
    shouldDefer: true,
  },
  // Context pull tools — Phase C. Read-only and parallel-safe.
  {
    id: 'context_workspace',
    kind: 'other',
    aliases: ['ContextWorkspace'],
    displayName: 'ContextWorkspace',
    description: 'Workspace cwd + platform + remote host + sandbox availability.',
    promptSummary: '`ContextWorkspace` (cwd, platform, remote host, sandbox capability)',
    host: ['skill', 'tui', 'mcp'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'ops-ui',
  },
  {
    id: 'context_ptys_list',
    kind: 'other',
    aliases: ['ContextPtysList'],
    displayName: 'ContextPtysList',
    description: 'List live PTY shells (addr/cmd/status/ageSec).',
    promptSummary: '`ContextPtysList` (background PTY shells)',
    host: ['skill', 'tui', 'mcp'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'ops-ui',
  },
  {
    id: 'context_pty_detail',
    kind: 'other',
    aliases: ['ContextPtyDetail'],
    displayName: 'ContextPtyDetail',
    description: 'Detail one PTY (cmd/workdir/exit + tail).',
    promptSummary: '`ContextPtyDetail` (addr, tailBytes -> full pty + output tail)',
    host: ['skill', 'tui', 'mcp'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'ops-ui',
  },
  {
    id: 'context_sessions_list',
    kind: 'other',
    aliases: ['ContextSessionsList'],
    displayName: 'ContextSessionsList',
    description: 'List terminal-modal sessions (coding agents + shells).',
    promptSummary: '`ContextSessionsList` (interactive terminal modals)',
    host: ['skill', 'tui', 'mcp'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'ops-ui',
  },
  {
    id: 'context_widgets_list',
    kind: 'other',
    aliases: ['ContextWidgetsList'],
    displayName: 'ContextWidgetsList',
    description: 'List currently-mounted widgets.',
    promptSummary: '`ContextWidgetsList` (mounted plugin widgets)',
    host: ['skill', 'tui', 'mcp'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'ops-ui',
  },
  {
    id: 'context_plugins_list',
    kind: 'other',
    aliases: ['ContextPluginsList'],
    displayName: 'ContextPluginsList',
    description: 'List active plugins.',
    promptSummary: '`ContextPluginsList` (active plugins)',
    host: ['skill', 'tui', 'mcp'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'ops-ui',
  },
  {
    id: 'context_tools_list',
    kind: 'other',
    aliases: ['ContextToolsList'],
    displayName: 'ContextToolsList',
    description: 'List native tools in the catalog (optionally filtered by host).',
    promptSummary: '`ContextToolsList` (what tools exist; filter by host)',
    host: ['skill', 'tui', 'mcp'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'ops-ui',
  },
  // PLAN-codex-app-server-hermes-parity §5 Phase H1·5a (2026-05-16) —
  // codex app-server callback surface. `elanous_*` tools are exposed
  // ONLY to the 'mcp' surface so they don't clutter the elanous TUI /
  // dashboard tool lists. The codex client spawns the elanous-tools MCP
  // server and discovers them via tools/list.
  {
    id: 'skill_exec',
    kind: 'execute',
    aliases: ['SkillExec', 'skill_exec'],
    displayName: 'SkillExec',
    description: 'Execute one explicitly named allowlisted skill with the supplied task. If you do not know the exact skill name, call elanous_skills_list first. Does not infer a skill name.',
    promptSummary: '`SkillExec(skill, task)` (execute an explicitly named allowlisted skill; call elanous_skills_list first when its exact name is unknown)',
    host: ['skill', 'tui', 'mcp'],
    safety: ['process'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'coding',
  },
  {
    id: 'elanous_skills_list',
    kind: 'other',
    aliases: ['ElanousSkillsList'],
    displayName: 'ElanousSkillsList',
    description: 'Enumerate installed elanous skills (~/.elanous/skills/* + SKILL.md first line). Read-only.',
    promptSummary: '`elanous_skills_list` (list installed skill names before skill_exec when the exact name is unknown)',
    host: ['skill', 'tui', 'mcp'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'ops-ui',
  },
  {
    id: 'elanous_obsidian_search',
    kind: 'search',
    aliases: ['ElanousObsidianSearch'],
    displayName: 'ElanousObsidianSearch',
    description: 'Ripgrep search over the Obsidian vault (markdown files). Returns {path, snippet, lineNumber}. Read-only · MCP callback only.',
    promptSummary: '`elanous_obsidian_search` (codex MCP callback · rg over Obsidian vault)',
    host: ['mcp'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'coding',
  },
  {
    id: 'elanous_obsidian_info',
    kind: 'other',
    aliases: ['ElanousObsidianInfo'],
    displayName: 'ElanousObsidianInfo',
    description: 'Report Obsidian vault availability + absolute path + resolution source. Read-only · MCP callback only.',
    promptSummary: '`elanous_obsidian_info` (codex MCP callback · vault discovery)',
    host: ['mcp'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'ops-ui',
  },
  {
    id: 'elanous_asana_workspaces',
    kind: 'other', aliases: ['ElanousAsanaWorkspaces'], displayName: 'ElanousAsanaWorkspaces',
    description: 'List Asana workspaces for the current user. MCP only.',
    promptSummary: '`elanous_asana_workspaces` (Asana workspace discovery)',
    host: ['mcp'], safety: ['read-only', 'network'], supportsParallel: true, defaultEnabled: true,
  },
  {
    id: 'elanous_asana_list_tasks',
    kind: 'other', aliases: ['ElanousAsanaListTasks'], displayName: 'ElanousAsanaListTasks',
    description: 'List and filter Asana project tasks across all pages. MCP only.',
    promptSummary: '`elanous_asana_list_tasks` (Asana project task listing)',
    host: ['mcp'], safety: ['read-only', 'network'], supportsParallel: true, defaultEnabled: true,
  },
  {
    id: 'elanous_asana_create_task',
    kind: 'other', aliases: ['ElanousAsanaCreateTask'], displayName: 'ElanousAsanaCreateTask',
    description: 'Create an Asana project task with optional Priority. MCP only.',
    promptSummary: '`elanous_asana_create_task` (create Asana task)',
    host: ['mcp'], safety: ['mutating', 'network'], supportsParallel: false, defaultEnabled: true,
  },
  {
    id: 'elanous_asana_comment',
    kind: 'other', aliases: ['ElanousAsanaComment'], displayName: 'ElanousAsanaComment',
    description: 'Comment on an Asana task. MCP only.',
    promptSummary: '`elanous_asana_comment` (comment on Asana task)',
    host: ['mcp'], safety: ['mutating', 'network'], supportsParallel: false, defaultEnabled: true,
  },
  {
    id: 'elanous_asana_complete',
    kind: 'other', aliases: ['ElanousAsanaComplete'], displayName: 'ElanousAsanaComplete',
    description: 'Complete or reopen an Asana task. MCP only.',
    promptSummary: '`elanous_asana_complete` (set Asana task completion)',
    host: ['mcp'], safety: ['mutating', 'network'], supportsParallel: false, defaultEnabled: true,
  },
  {
    id: 'elanous_fs_list',
    kind: 'list-dir',
    aliases: ['ElanousFsList'],
    displayName: 'ElanousFsList',
    description: 'List entries under a directory clamped to either the daemon cwd or the Obsidian vault. Read-only · MCP callback only.',
    promptSummary: '`elanous_fs_list` (codex MCP callback · cwd/obsidian directory enumeration)',
    host: ['mcp'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'coding',
  },
  {
    id: 'elanous_fs_read',
    kind: 'read',
    aliases: ['ElanousFsRead'],
    displayName: 'ElanousFsRead',
    description: 'Read a single file clamped to either the daemon cwd or the Obsidian vault. Text mimes → content (utf8); binary → bytes (base64). 256KB cap · 8MB ceiling. Read-only · MCP callback only.',
    promptSummary: '`elanous_fs_read` (codex MCP callback · single-file read · text/binary branch)',
    host: ['mcp'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'coding',
  },
  {
    id: 'elanous_showroom_broadcast',
    kind: 'other',
    aliases: ['ElanousShowroomBroadcast'],
    displayName: 'ElanousShowroomBroadcast',
    description: 'Fan one prompt out to multiple LLM backends (claude · gemini · grok default) in parallel and return per-backend responses. Multi-LLM second-opinion inside a codex turn. MCP callback only.',
    promptSummary: '`elanous_showroom_broadcast` (codex MCP callback · multi-LLM fanout · synthesis)',
    host: ['mcp'],
    safety: ['process'],
    // Spawns N ACP subprocess agents — serial-by-name within a single
    // dispatch is fine (Promise.all), but parallel external invocations
    // would multiply subprocess pressure.
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'coding',
  },
  {
    id: 'elanous_task_submit',
    kind: 'other',
    aliases: ['ElanousTaskSubmit'],
    displayName: 'ElanousTaskSubmit',
    description: 'Hand a task to elanous from another agent (plugin). Queued in TOX via POST /v1/tasks as provider agent-plugin · waits for approval. MCP only.',
    promptSummary: '`elanous_task_submit` (plugin MCP · queue a task for elanous · approval-gated)',
    host: ['mcp'],
    safety: ['network', 'mutating'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'coding',
  },
  {
    id: 'elanous_autopilot_launch',
    kind: 'other',
    aliases: ['ElanousAutopilotLaunch'],
    displayName: 'ElanousAutopilotLaunch',
    description: 'Run a elanous autopilot mission to completion (sync MVP · strict caps: 1 iter / 120s default). Spawns an ACP agent, drives the loop, returns aggregated text + termination. MCP callback only.',
    promptSummary: '`elanous_autopilot_launch` (codex MCP callback · autopilot loop · sync)',
    host: ['mcp'],
    safety: ['process', 'mutating'],
    // Spawns ACP agent + may execute tool calls (file edits, shell
    // runs) — serialise within a single codex turn.
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'coding',
  },
  {
    id: 'context_events_tail',
    kind: 'other',
    aliases: ['ContextEventsTail'],
    displayName: 'ContextEventsTail',
    description: 'Tail recent element events (create/update/delete/output/exit), filterable.',
    promptSummary: '`ContextEventsTail` (sinceTs/kinds/types/addr -> recent element events)',
    host: ['skill', 'tui', 'mcp'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'ops-ui',
  },
  // Control tools — exposed on skill + dashboard only (not mcp).
  {
    id: 'control_tool_toggle',
    kind: 'other',
    aliases: ['ControlToolToggle'],
    displayName: 'ControlToolToggle',
    description: 'Turn a native tool on/off for this session.',
    promptSummary: '`ControlToolToggle` (toolId, enabled) — self-modify catalog',
    host: ['skill', 'tui'],
    safety: ['permission'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'ops-ui',
  },
  {
    id: 'control_prompt_append',
    kind: 'other',
    aliases: ['ControlPromptAppend'],
    displayName: 'ControlPromptAppend',
    description: 'Append a hint to the next or every turn system prompt.',
    promptSummary: '`ControlPromptAppend` (text, scope: turn|session) — self-modify prompt',
    host: ['skill', 'tui'],
    safety: ['permission'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'ops-ui',
  },
  {
    id: 'control_prompt_clear',
    kind: 'other',
    aliases: ['ControlPromptClear'],
    displayName: 'ControlPromptClear',
    description: 'Clear prompt hints (optionally by scope).',
    promptSummary: '`ControlPromptClear` (scope?: turn|session) — drop pending hints',
    host: ['skill', 'tui'],
    safety: ['permission'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'ops-ui',
  },
  {
    id: 'context_bootstrap',
    kind: 'other',
    aliases: ['ContextBootstrap'],
    displayName: 'ContextBootstrap',
    description: 'One-shot warmup (workspace + ptys + sessions + tools).',
    promptSummary: '`ContextBootstrap` (single call warmup: workspace+ptys+sessions+tools)',
    host: ['skill', 'tui', 'mcp'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'ops-ui',
  },
  {
    id: 'read',
    kind: 'read',
    aliases: ['Read', 'read_file'],
    displayName: 'Read',
    description: 'Read a file. Populates the read-state so subsequent Edit/Write on this file can run. Optional offset+limit for large files (partial reads block Edit).',
    promptSummary: '`Read` (file contents; required before Edit/Write — read-before-edit invariant)',
    host: ['skill', 'tui'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'coding',
    cleanerFitThanShell: true,
  },
  {
    id: 'edit',
    kind: 'edit',
    aliases: ['Edit', 'edit_file', 'FileEdit', 'file_edit'],
    displayName: 'Edit',
    description: 'Exact-string replacements in a file (batchable). Requires a prior Read of the target; fails on ambiguous matches unless replace_all is passed.',
    promptSummary: '`Edit` (exact-string replace; requires prior Read; batchable; replace_all for ambiguous matches)',
    host: ['skill', 'tui'],
    safety: ['mutating'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'coding',
    cleanerFitThanShell: true,
    // Arc G — opt-in tsc baseline check after each Edit. Default
    // disabled (HARNESS_CODE_FEEDBACK_ENABLED=1 to opt in).
    verifier: { kind: 'code-feedback' },
  },
  {
    id: 'write',
    kind: 'write',
    aliases: ['Write', 'file_write', 'FileWrite'],
    displayName: 'Write',
    description: 'Create a new file or fully overwrite an existing one. For existing files the Read-before-Write invariant still applies. Prefer Edit for partial changes.',
    promptSummary: '`Write` (full-content write; creates or overwrites; prior Read required for existing files)',
    host: ['skill', 'tui'],
    safety: ['mutating'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'coding',
    cleanerFitThanShell: true,
    // Arc G — opt-in tsc baseline check after each Write. Default
    // disabled (HARNESS_CODE_FEEDBACK_ENABLED=1 to opt in).
    verifier: { kind: 'code-feedback' },
  },
  {
    id: 'ask_user_question',
    kind: 'ask-user',
    aliases: ['AskUserQuestion', 'ask_user_question'],
    displayName: 'AskUserQuestion',
    description: 'Ask the user 1–3 structured multiple-choice questions to clarify requirements that cannot be resolved by reading the code. Surfaces include: dashboard (full modal), skill (via host-installed resolver). When neither is available, the tool returns a structured "not-available" error — pick a sensible default and note the assumption.',
    promptSummary: '`AskUserQuestion` (1–3 multi-choice; dashboard+skill via resolver hook; structured error when host has no surface)',
    // 🆕 'chat' (2026-09-08) — 챗에서 띄운 SelfImplement 가 막히면 사람에게 «되물을» 길이 있어야 한다.
    //   ⛔ `#16003` 이 SelfImplement 만 열고 이 짝을 안 열어서, 챗 자식은 물을 도구가 없었다.
    //   ⭐ 사다리는 이미 있다 — ACP 브릿지 → SSE 채널(`#16031`) → 부재 사유 관측.
    host: ['skill', 'tui', 'chat'],
    safety: ['permission'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'coding',
  },
  {
    id: 'update_plan',
    kind: 'plan',
    aliases: ['update_plan', 'UpdatePlan'],
    displayName: 'UpdatePlan',
    description: 'Progress checklist for multi-step tasks. Pending/InProgress/Completed with a single in_progress invariant.',
    promptSummary: '`update_plan` (checklist for 3+ step tasks; one in_progress at a time; update after each step, never batch)',
    host: ['skill', 'tui'],
    safety: ['debug'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'coding',
  },
  {
    id: 'enter_plan_mode',
    kind: 'other',
    aliases: ['EnterPlanMode', 'enter_plan_mode'],
    displayName: 'EnterPlanMode',
    description: 'Enter read-only plan mode. Only the plan file is writable; use Read/Grep + AskUserQuestion + Edit(plan file) to draft a decision-complete plan, then ExitPlanMode.',
    promptSummary: '`EnterPlanMode` (flips to read-only planning phase; only the plan file is writable; use for non-trivial asks)',
    host: ['tui'],
    safety: ['permission'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'coding',
  },
  {
    id: 'exit_plan_mode',
    kind: 'other',
    aliases: ['ExitPlanMode', 'exit_plan_mode'],
    displayName: 'ExitPlanMode',
    description: 'Exit plan mode via a user modal with 3 choices: implement now, save & handoff to a new session, or cancel.',
    promptSummary: '`ExitPlanMode` (user picks: implement now / save+new session / cancel; call when plan is decision-complete)',
    host: ['tui'],
    safety: ['permission'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'coding',
  },
  {
    id: 'set_working_dir',
    kind: 'other',
    aliases: ['SetWorkingDir', 'set_working_dir'],
    displayName: 'SetWorkingDir',
    description: 'Promote a directory to the session working directory (SWD). Every subsequent Read/Edit/Write/Shell/Grep/Glob resolves relative paths against this root, and new shells spawn here. Use when the user references "switch to /another/project" or when multi-repo navigation is needed.',
    promptSummary: '`SetWorkingDir` (switch active project root; affects all tool cwd defaults; stays within HOME)',
    host: ['tui'],
    safety: ['permission'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'coding',
  },
  {
    id: 'enter_worktree',
    kind: 'other',
    aliases: ['EnterWorktree', 'enter_worktree'],
    displayName: 'EnterWorktree',
    description: 'Create a new git worktree + branch (isolated working copy) and promote it to the session working directory. Use when starting a new feature / fix so edits stay off the main checkout and a parallel shell can keep running the primary branch. Creates <repo>.worktrees/<slug>; auto-switches SWD to the new path.',
    promptSummary: '`EnterWorktree` (new git worktree + branch; SWD auto-flips; pair with ExitWorktree when done)',
    host: ['tui'],
    safety: ['permission'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'coding',
    // ROADMAP Wave 2 classification tightening — worktree creation is
    // a session boot decision, not a per-turn op.
    alwaysLoad: false,
    shouldDefer: true,
  },
  {
    id: 'exit_worktree',
    kind: 'other',
    aliases: ['ExitWorktree', 'exit_worktree'],
    displayName: 'ExitWorktree',
    description: 'Reverse the most recent EnterWorktree — restore SWD to the previous working directory. Worktree dir stays on disk unless prune:true is passed (and the branch is NEVER deleted). Use when a feature is complete / paused and you want the main-branch flow back.',
    promptSummary: '`ExitWorktree` (restore SWD; worktree stays unless prune:true; branch kept either way)',
    host: ['tui'],
    safety: ['permission'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'coding',
  },
  {
    // self-implement P2 (2026-07-19) — elanous 가 자연어를 인식해 자율 구현→draft PR 하는
    // 네이티브 툴. 첫 턴부터 전체 스키마를 노출한다.
    // 상시 가용(defaultEnabled·별도 아밍 없음). PR open 은 fail-closed HITL(approver 미주입 시
    // 절대 안 열림). agent(자식 elanous spawn)+process+mutating+permission.
    id: 'self_implement',
    kind: 'delegate',
    aliases: ['SelfImplement', 'self_implement'],
    displayName: 'SelfImplement',
    description: 'Autonomously implement a single requested feature, fix, or small coding task end-to-end. Forks the session, creates an isolated git worktree, drives a headless elanous coding agent to write code + tests, and runs the integrity gate (bun test/build). Choose this whenever the user asks elanous itself to build, implement, or fix one thing — a PR request is NOT required (e.g. "이 기능 구현해줘", "이 버그 고쳐줘", "이 작은 수정 해줘"). After coding and the gate, a DRAFT pull request may be pushed and opened only after HITL approval; PR-open is a fail-closed human gate. Long-running (minutes).',
    promptSummary: '`SelfImplement` (autonomous feature→worktree→gate→draft-PR; PR-open HITL-gated; minutes-long)',
    // 🆕 'chat' (2026-09-07 · 대표) — PWA·안드로이드·iOS 챗에서도 부를 수 있다.
    //   ⭐ 이 툴은 «헤드리스 자식»을 띄운다 — ***부르는 쪽에 PTY 가 필요 없다.***
    //      그래서 webterm 에만 두던 것은 능력의 제약이 아니라 «문이 없던 것»이었다.
    //   ⛔ 안전 장치는 그대로다: nest-cap(액자 폭주 차단) ⊕ PR open 은 fail-closed HITL.
    host: ['skill', 'tui', 'mcp', 'chat'],
    safety: ['agent', 'process', 'mutating', 'permission'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'coding',
    alwaysLoad: true,
    shouldDefer: false,
  },
  {
    // D(front door · 2026-07-21) — 병렬 self-dev 오케스트레이터 자연어 트리거. SelfImplement(단일)의
    // 병렬판. 안전 기본=worktree-only(auto_merge 명시 opt-in). coordinator↔executor 세포 role.
    id: 'self_orchestrate',
    kind: 'delegate',
    aliases: ['SelfOrchestrate', 'self_orchestrate'],
    displayName: 'SelfOrchestrate',
    description: 'Autonomously develop MULTIPLE features/fixes IN PARALLEL — each goal runs as its own isolated git-worktree self-implement subprocess (coordinator↔executor cell roles), concurrency-capped. By DEFAULT worktree-only (inspect before promote); auto_merge=true merges review-clean goals to main (outward-facing opt-in). Use when the user wants several things built at once (e.g. "이것들 병렬로 구현해줘", "여러 개 동시에 개발해줘", "이 목록 다 만들어줘"). For a SINGLE feature use SelfImplement. Long-running (minutes).',
    promptSummary: '`SelfOrchestrate` (N goals → parallel isolated-worktree self-implement; worktree-only default · auto_merge opt-in; minutes-long)',
    host: ['skill', 'tui'],
    safety: ['agent', 'process', 'mutating', 'permission'],
    supportsParallel: false,
    // ⛔⭐⭐⭐ 은퇴 (대표 2026-08-19: "self 오케스트레이터는 이제 내리고 self implement 만 남겨주세요. 그게 통합 방향입니다.")
    //
    //   ⭐ **왜 안전한가 — 능력이 «이미» self_implement 에 흡수돼 있다**(2026-08-19 실측):
    //     · 스펙 선언:  goals · decompose · concurrency · fabric_decompose · arcHint · target_paths · auto_merge
    //     · 배선:      self-implement-runtime.ts:467 이 goals 경로에서 orchestrateSelfDev 를 «직접» 부른다
    //     ⇒ 📌 툴은 하나가 되고 능력은 «옵션»으로 남는다(대표 2026-08-06: "능력은 「갈래」가 아니라 「스위치」다").
    //
    //   📏 실측 근거(30일 · chat.tool-call · ⚠️ limitReached ⇒ 하한):
    //     SelfImplement 17 · SelfOrchestrate ***0*** · SolveMission ***0***
    //   ⛔ 그러나 그 「0」을 «은퇴 근거로 바로 쓰지 않았다» — shouldDefer: true 라 모델이 «찾아야» 보였으므로
    //     「안 쓴다」인지 「못 쓴다」인지 갈리지 않았다. 대표 이 방향을 정해 은퇴하되,
    //     그 물음은 «사라지지 않고 형태만 바뀐다»: 「지웠는데 복합이 잘 도나?」를 ***사후에*** 묻는다.
    //
    //   🔄 **되돌리기 = 이 한 줄을 true 로.** 사후 판정에서 복합이 안 돌면 즉시 복구한다(🅣 권고).
    defaultEnabled: false,
    intentScope: 'coding',
    alwaysLoad: false,
    shouldDefer: true,
  },
  {
    id: 'run_dev_harness',
    kind: 'other',
    aliases: ['RunDevHarness', 'run_dev_harness'],
    displayName: 'RunDevHarness',
    description: 'Develop a requested feature, fix, or small coding task end-to-end through the FULL staged harness — Planner → Executor → Reviewer → Deployer — in an isolated git worktree. Unlike SelfImplement (single implement+gate pass), this runs the explicit P→E→R→D pipeline with review rounds and a divergence cap. Choose it whenever the user asks for the harness or its planner/executor/reviewer stages — a PR request is NOT required (e.g. "하니스로 이 버그 고쳐줘", "P→E→R→D로 이 작은 수정 해줘", "플래너부터 리뷰기까지 돌려서 구현해줘"). Currently targets elanous itself. auto_drive: safe (default) / off / on. After coding and the gate, a DRAFT pull request may be pushed and opened only after HITL approval; PR-open is a fail-closed human gate. Long-running (minutes).',
    promptSummary: '`RunDevHarness` (하니스/harness 로 개발·구현·수정 — full P→E→R→D staged pipeline: planner→executor→reviewer→deployer → worktree → gate → draft-PR. Prefer over SelfImplement whenever the user names the harness or any of its stages, even for a small fix; PR-open HITL-gated; minutes-long)',
    host: ['skill', 'tui'],
    safety: ['agent', 'process', 'mutating', 'permission'],
    supportsParallel: false,
    // ⭐⭐⭐ 2026-08-11 73차 — 모델 표면으로 «되돌린다»(대표 *"run dev harness 를 본격 동작이 되도록"*).
    //
    //   ⛔ `#7476`(2026-08-07)이 내린 사유 셋을 전수·라이브로 다시 재서 «전부» 해소·반증했다:
    //     ⑴ *"런 원장에 종결행을 남기지 않고"* → ❌ **거짓**. 배선 `#7399` 가 끄기보다 «10시간 앞»이고
    //        prod 런 3/3 정상. 「실패」로 셌던 둘은 ***다른 우주(test)***였다(원장은 state-dir 스코프).
    //        ⊕ 이제 `harness.membrane terminal-ledger {outcome, ledgerDirectory}` 가 말한다(`#8283`·`#8291`).
    //     ⑵ *"부모 스트림에 진행을 전달하지 못하며"* → ✅ 참이었고 **닫혔다**(`#8277`·`#8288`).
    //        8분 3초 «0줄» → plan·execute·review·deploy 전 구간이 부모 stdout 으로 온다.
    //     ⑶ *"실패해도 정리되지 않는"* → ❌ **「차이」가 아니다**. `self implement` 도 실패 시 worktree 를
    //        보존하고 그것은 명시 정책이다(`self-implement-runtime.ts` *"worktree 보존(검사용)"*).
    //   📏 능력도 문제가 아니었다 — 실 objective 가 ***8분 3초에 완주하고 PR 을 열었다***(`#8273`).
    //   🚨 끄고 있던 대가: 사람이 「하니스로 구현해줘」라고 ***다섯 번*** 말했고 다섯 번 다 SelfImplement 로 갔다.
    //      모델이 «안 고른» 게 아니라 ***고를 수 없었다***.
    //   ⭐ 그리고 지금이 지난 5일 중 «가장 안전한» 시점이다 — `published` 가 `changes:0` 에 성공을 주던
    //      거짓 성공(5/5)을 막는 `nonCodeVerified` 관문이 `#8074`(08-11 04:40)에 섰다.
    //
    //   ⛔⭐ **끄는 것은 «두 줄»이었다** — `defaultEnabled:false` 「그리고」 `toolSearchable:false`.
    //     `isNativeToolModelExposed` 가 `defaultEnabled && !(alwaysLoad===false && shouldDefer===false
    //     && toolSearchable===false)` 라, ***`defaultEnabled` 만 켜면 여전히 «노출 안 된다»***(실측: essential 22 그대로).
    //     ⇒ 📌 켜는 것도 두 줄이다. 하나만 바꾸면 «형태만» 착지하고 실행 경로엔 없다.
    //   ⛔ `alwaysLoad` 는 켜지 «않는다»(끄기 전엔 true 였다) — 첫 턴부터 전체 스키마를 싣는 비용을 안 준다.
    //     ***`defaultEnabled`(고를 수 있나)와 `alwaysLoad`(항상 실리나)는 다른 축이다.***
    //   📄 근거 전문 = 내부 문서 `FINDING-dev-harness-is-not-dead-it-is-switched-off-2026-08-11`
    //
    //   ⛔⭐⭐⭐ **⚠️ 여기까지는 2026-08-11 의 「켜자」 논증이고, 그 «뒤»에 뒤집혔다 — 값이 정답이다.**
    //     📏 `90a80c223` (`#8515`) *"대표 P4 — 모델 표면에서 RunDevHarness 를 «한 스위치»로 내린다
    //        (CLI 는 대조군으로 남는다)"* 가 `defaultEnabled: true → false` 로 되돌렸다.
    //     📏 실측(2026-08-23): 서피스 전수 chat 50툴 · webterm 68툴 · cli 6툴 —
    //        ***`RunDevHarness` 는 셋 어디에도 «없다»***.
    //     ⇒ 🔑 그러므로 위 문단들을 «지시»로 읽지 마라. **이력이다.**
    //        ⛔ 특히 *"끄고 있던 대가 … 다섯 번 다 SelfImplement 로 갔다"* 는 «그 시점»의 관측이고,
    //          지금은 ***SelfImplement 로 가는 것이 «의도»다***.
    //     📌 이 주석을 «안 지우는» 이유: 다시 켜자는 논의가 나오면 그때 필요한 근거가 여기 있다.
    //        ⊕ 켜려면 여전히 «두 줄»이다(`defaultEnabled` ⊕ `toolSearchable`) — 그 함정은 아직 유효하다.
    defaultEnabled: false,
    intentScope: 'coding',
    alwaysLoad: false,
    shouldDefer: true,
  },
  {
    id: 'solve_mission',
    kind: 'other',
    aliases: ['SolveMission', 'solve_mission'],
    displayName: 'SolveMission',
    description: 'Autonomously SOLVE an EXISTING coding mission in an isolated git worktree, then open a DRAFT pull request. The default executor is self-implement; choose executor: "staged" explicitly for the Planner → Executor → Reviewer → Deployer harness. Reads the mission by id (read-only — never creates, approves, or changes mission status; those stay human-gated). Only coding-domain missions are solvable. Use when the user names an existing mission to develop/resolve (e.g. "이 미션 하니스로 풀어줘", "mission <id> 자율해결"). auto_drive: safe (default) / off / on. Coding + gate autonomous; PR-open is a fail-closed human gate. Long-running (minutes).',
    promptSummary: '`SolveMission` (read an EXISTING coding mission by id → self-implement default; executor: staged explicitly selects the P→E→R→D harness → draft-PR; read-only on mission store; PR-open HITL-gated; minutes-long)',
    host: ['skill', 'tui'],
    safety: ['agent', 'process', 'mutating', 'permission'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'coding',
    alwaysLoad: false,
    shouldDefer: true,
  },
  {
    id: 'undo_turn',
    kind: 'other',
    aliases: ['UndoTurn', 'undo_turn'],
    displayName: 'UndoTurn',
    description: 'Restore the working tree to the ghost-commit snapshot taken at the start of a recent turn. A snapshot is automatically captured on each turn\'s first Edit/Write; this tool rolls back to that state. Overwrites current working tree; preserves staged index; deletes new untracked files added since the snapshot. Use when the user asks to undo / revert / roll back the last turn\'s changes.',
    promptSummary: '`UndoTurn` (restore working tree to a recent turn\'s ghost-commit; destructive — user sees approval modal)',
    host: ['tui'],
    safety: ['permission'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'coding',
  },
  {
    id: 'grep',
    kind: 'search',
    aliases: ['Grep', 'grep_search'],
    displayName: 'Grep',
    description: 'Ripgrep-backed text search with files_with_matches, content, and count output modes.',
    promptSummary: '`Grep` (ripgrep-backed content search with files_with_matches / content / count modes + head_limit bounds)',
    host: ['skill'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'coding',
    requires: ['rg'],
    cleanerFitThanShell: true,
  },
  {
    id: 'glob',
    kind: 'search',
    aliases: ['Glob', 'files_glob'],
    displayName: 'Glob',
    description: 'Find files by glob pattern (`**/*.ts`, `src/**/*.test.{ts,tsx}`). Paths only, no content scan. Respects .gitignore.',
    promptSummary: '`Glob` (file-path discovery by glob pattern — cheaper than Grep when only filenames are needed)',
    host: ['skill'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'coding',
    requires: ['rg'],
    cleanerFitThanShell: true,
  },
  {
    id: 'list_dir',
    kind: 'list-dir',
    aliases: ['ListDir', 'list_dir'],
    displayName: 'ListDir',
    description: 'List one directory — names, kinds (file/dir/symlink), sizes, and mtimes. Non-recursive.',
    promptSummary: '`ListDir` (structured directory listing with kind/size/mtime — cheaper than Bash ls)',
    host: ['skill'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'coding',
    cleanerFitThanShell: true,
  },
  {
    id: 'ast_grep',
    kind: 'search',
    aliases: ['AstGrep', 'ast_grep_search'],
    displayName: 'AstGrep',
    description: 'Structural code search using ast-grep patterns or inline YAML rules.',
    promptSummary: '`AstGrep` (ast-grep structural code search for syntax-aware patterns/rules)',
    host: ['skill', 'tui'],
    safety: ['read-only', 'process'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'coding',
    requires: ['ast-grep or sg'],
    cleanerFitThanShell: true,
  },
  {
    id: 'goal_author',
    kind: 'other',
    aliases: ['GoalAuthor', 'goal_author'],
    displayName: 'GoalAuthor',
    description: 'Author one grounded goal document with the PROBLEM, WHAT TO BUILD, RULES, ACCEPTANCE CRITERIA, REQUIRED EVIDENCE, TRACED PATHS, SCOPE BOUNDARY, 불변식, and 판정 신호 contract. It creates only the goal document and does not modify repository code or start implementation.',
    promptSummary: '`GoalAuthor(ask, cwd?)` (use when creating a goal document; do not hand-write it — grounded nine-section goal document only; no code changes or implementation; authoring takes 1–3 minutes, so allow at least 300 seconds)',
    host: ['skill', 'tui'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'coding',
    cleanerFitThanShell: true,
  },
  {
    id: 'persistent_grounding',
    kind: 'delegate',
    aliases: ['PersistentGrounding', 'persistent_grounding'],
    displayName: 'PersistentGrounding',
    description: 'Bounded read-only repository grounding loop that searches and reads code until verified implementation candidates are found.',
    promptSummary: '`PersistentGrounding(goal, cwd?)` (bounded Grep/Glob/ListDir/AstGrep/Read repository discovery loop)',
    host: ['skill', 'tui'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'coding',
    cleanerFitThanShell: true,
  },
  {
    id: 'web_fetch',
    kind: 'web',
    aliases: ['WebFetch', 'web_fetch'],
    displayName: 'WebFetch',
    description: 'Fetch a URL and return text or markdown-converted HTML.',
    promptSummary: '`WebFetch` (fetch a URL, return text or markdown-converted HTML)',
    host: ['skill'],
    safety: ['network', 'read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'coding',
    cleanerFitThanShell: true,
  },
  {
    id: 'web_search',
    kind: 'web',
    aliases: ['WebSearch', 'web_search'],
    displayName: 'WebSearch',
    description: 'Search the public web via a configured provider (Grok live-search / Firecrawl / MCP / custom).',
    promptSummary: '`WebSearch` (provider-backed web search — Grok live-search by default; pair with WebFetch for full bodies)',
    host: ['skill'],
    safety: ['network', 'read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'coding',
    cleanerFitThanShell: true,
  },
  {
    id: 'agent',
    kind: 'delegate',
    aliases: ['Agent', 'spawn_agent'],
    displayName: 'Agent',
    description:
      "Spawn a sub-agent in its own context window. Use when (a) the work would dump heavy tool output you don't want in your own history " +
      "(long file reads, deep search), (b) you want N independent workers in parallel (call Agent N times in the same turn), or (c) the user " +
      "asked for long-running async exploration — pass run_in_background=true and the spawn returns immediately with a taskId. Pair with " +
      "AgentOutput(taskId, block?) to collect the result, AgentStop(taskId, cascade?) to cancel. ROADMAP Wave 1 surface; see also Wave 3 cascade.",
    promptSummary: '`Agent(description, prompt, subagent_type?, run_in_background?, isolation?, team_name?)` (sub-agent · pair w/ AgentOutput / AgentStop)',
    host: ['skill', 'tui', 'mcp'],
    safety: ['agent'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'coding',
  },
  {
    id: 'pty_shell_start',
    kind: 'execute',
    aliases: ['PtyShellStart', 'pty_shell_start'],
    displayName: 'PtyShellStart',
    description: 'Spawn a long-running process under a PTY (REPL, dev server, watch). Returns process_id for use with PtyShellPoll/Send/Kill. Max 8 concurrent. Auto-killed on skill return unless detach:true. Dashboard scope requires shell.allowDashboardPty=true + HITL approval.',
    promptSummary: '`PtyShellStart` (spawn long-running process under a PTY — pair with PtyShellPoll/Send/Kill)',
    host: ['skill', 'tui'],
    safety: ['process'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'coding',
    probe: {
      kind: 'custom',
      custom: ptyAvailable,
      onFail: 'hide',
      ttlMs: 300_000,
    },
  },
  {
    id: 'pty_shell_poll',
    kind: 'other',
    aliases: ['PtyShellPoll', 'pty_shell_poll'],
    displayName: 'PtyShellPoll',
    description: 'Read newly accumulated stdout/stderr from a PTY process. Bounded by yield_time_ms + max_bytes.',
    promptSummary: '`PtyShellPoll` (read PTY shell output since last poll)',
    host: ['skill', 'tui'],
    safety: ['process', 'read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'coding',
    probe: {
      kind: 'custom',
      custom: ptyAvailable,
      onFail: 'hide',
      ttlMs: 300_000,
    },
  },
  {
    id: 'pty_shell_send',
    kind: 'execute',
    aliases: ['PtyShellSend', 'pty_shell_send'],
    displayName: 'PtyShellSend',
    description: 'Write characters to a PTY process\'s stdin (REPL input, signal keys like ^C as "\\u0003"). Returns output that arrives within yield_time_ms.',
    promptSummary: '`PtyShellSend` (write to PTY stdin — REPL input, signal keys)',
    host: ['skill', 'tui'],
    safety: ['process'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'coding',
    probe: {
      kind: 'custom',
      custom: ptyAvailable,
      onFail: 'hide',
      ttlMs: 300_000,
    },
  },
  {
    id: 'pty_shell_kill',
    kind: 'execute',
    aliases: ['PtyShellKill', 'pty_shell_kill'],
    displayName: 'PtyShellKill',
    description: 'Terminate a PTY process. Default SIGTERM; pass signal:"SIGKILL" to force.',
    promptSummary: '`PtyShellKill` (terminate PTY shell, returns final snapshot)',
    host: ['skill', 'tui'],
    safety: ['process'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'coding',
    probe: {
      kind: 'custom',
      custom: ptyAvailable,
      onFail: 'hide',
      ttlMs: 300_000,
    },
  },
  {
    id: 'pty_shell_list',
    kind: 'other',
    aliases: ['PtyShellList', 'pty_shell_list'],
    displayName: 'PtyShellList',
    description: 'List active PTY processes with id, state (running/exited), detach flag, age, and command. Read-only; safe at any surface. Pair with Kill/Send when you don\'t already have the process_id.',
    promptSummary: '`PtyShellList` (enumerate active PTY shells — id, state, age, cmd)',
    host: ['skill', 'tui', 'mcp'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'coding',
    probe: {
      kind: 'custom',
      custom: ptyAvailable,
      onFail: 'hide',
      ttlMs: 300_000,
    },
  },
  {
    id: 'pty_shell_snapshot',
    kind: 'other',
    aliases: ['PtyShellSnapshot', 'pty_shell_snapshot'],
    displayName: 'PtyShellSnapshot',
    description: 'Render the CURRENT screen of a PTY process as text (live terminal grid, cursor position included) — for full-screen TUIs (vim · htop · less · pagers) where PtyShellPoll\'s raw byte delta is unreadable.',
    promptSummary: '`PtyShellSnapshot` (render live terminal grid — for full-screen TUIs vim/htop)',
    host: ['skill', 'tui', 'mcp'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'coding',
    probe: {
      kind: 'custom',
      custom: ptyAvailable,
      onFail: 'hide',
      ttlMs: 300_000,
    },
  },
  {
    id: 'pty_shell_resize',
    kind: 'other',
    aliases: ['PtyShellResize', 'pty_shell_resize'],
    displayName: 'PtyShellResize',
    description: 'Resize a PTY process to cols × rows (sends SIGWINCH so full-screen TUIs re-layout). Default spawn is 80×24.',
    promptSummary: '`PtyShellResize` (resize PTY cols×rows — SIGWINCH for TUI re-layout)',
    host: ['skill', 'tui'],
    safety: ['process'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'coding',
    probe: {
      kind: 'custom',
      custom: ptyAvailable,
      onFail: 'hide',
      ttlMs: 300_000,
    },
  },
  {
    id: 'pty_shell_screenshot',
    kind: 'other',
    aliases: ['PtyShellScreenshot', 'pty_shell_screenshot'],
    displayName: 'PtyShellScreenshot',
    description: 'Render the CURRENT screen of a PTY process as a PNG image and attach it to the reply (on image-capable surfaces like Telegram). Use when the user asks to SEE/show/capture the screen, or when a picture conveys a full-screen TUI/colored layout better than text. For reading content, prefer PtyShellSnapshot (text).',
    promptSummary: '`PtyShellScreenshot` (render live screen as PNG image — attach on Telegram etc.)',
    host: ['skill', 'tui', 'mcp'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'coding',
    probe: {
      kind: 'custom',
      custom: ptyAvailable,
      onFail: 'hide',
      ttlMs: 300_000,
    },
  },
  {
    id: 'spawn_coding_agent_headless',
    kind: 'delegate',
    aliases: ['SpawnCodingAgentHeadless', 'spawn_coding_agent_headless'],
    displayName: 'SpawnCodingAgentHeadless',
    description: 'Spawn claude-code or codex under a PTY (no dashboard/VW) and drive its live terminal with the PtyShell tools (Snapshot/Send/Screenshot/Kill). For observing/steering a sub coding-agent from a headless surface (Telegram). For fire-and-forget structured delegation prefer delegate_code_agent (ACP).',
    promptSummary: '`SpawnCodingAgentHeadless` (spawn claude/codex under PTY — drive via PtyShell*)',
    host: ['skill', 'tui'],
    safety: ['process'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'coding',
    probe: {
      kind: 'custom',
      custom: ptyAvailable,
      onFail: 'hide',
      ttlMs: 300_000,
    },
  },
  {
    id: 'drive_coding_agent_headless',
    kind: 'delegate',
    aliases: ['DriveCodingAgentHeadless', 'drive_coding_agent_headless'],
    displayName: 'DriveCodingAgentHeadless',
    description: 'Spawn claude-code or codex, send it a task prompt, wait until it finishes, and return its final screen — all in ONE tool call (does the spawn→wait→send→wait→capture loop internally, so it does not burn the per-turn tool budget with manual round-trips). For "run this coding task and give me the result". For interactive observe/steer use SpawnCodingAgentHeadless. Bounded by timeout_ms.',
    promptSummary: '`DriveCodingAgentHeadless` (run codex/claude on a task end-to-end in ONE call — no budget burn)',
    host: ['skill', 'tui'],
    safety: ['process'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'coding',
    probe: {
      kind: 'custom',
      custom: ptyAvailable,
      onFail: 'hide',
      ttlMs: 300_000,
    },
  },
  {
    id: 'relay_shell_prompt',
    kind: 'other',
    aliases: ['RelayShellPrompt', 'relay_shell_prompt'],
    displayName: 'RelayShellPrompt',
    description: 'Relay a prompt from inside a PTY shell (codex "Apply patch? (y/n)", aider menu) to the human operator, then inject their answer back into the shell. Use ONLY when the shell asks something that needs the operator\'s decision — for answers you already know, use PtyShellSend. Provide `options` for a multiple-choice menu (surfaces as buttons); omit for a yes/no confirm.',
    promptSummary: '`RelayShellPrompt` (surface a shell prompt to the operator → inject their answer back)',
    host: ['skill', 'tui'],
    safety: ['process'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'coding',
    probe: {
      kind: 'custom',
      custom: ptyAvailable,
      onFail: 'hide',
      ttlMs: 300_000,
    },
  },
  // ── BI-P5: browser (CDP) + iPhone (Pushcut) + HITL ──
  {
    id: 'browser_open',
    kind: 'web',
    aliases: ['BrowserOpen', 'browser_open'],
    displayName: 'BrowserOpen',
    description: 'Spawn a Chrome session via CDP. Returns session_id for BrowserNavigate/Screenshot/Close.',
    promptSummary: '`BrowserOpen` (spawn CDP-controlled Chrome)',
    host: ['skill'],
    safety: ['process'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'browse',
  },
  {
    id: 'browser_screenshot',
    kind: 'web',
    aliases: ['BrowserScreenshot', 'browser_screenshot'],
    displayName: 'BrowserScreenshot',
    description: 'Capture PNG screenshot of a browser session; saves to /tmp/elanous-screenshot-*.',
    promptSummary: '`BrowserScreenshot` (PNG capture of CDP session)',
    host: ['skill'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'browse',
  },
  {
    id: 'browser_close',
    kind: 'web',
    aliases: ['BrowserClose', 'browser_close'],
    displayName: 'BrowserClose',
    description: 'Close a browser session + kill Chrome.',
    promptSummary: '`BrowserClose` (dispose CDP session)',
    host: ['skill'],
    safety: ['process'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'browse',
  },
  {
    id: 'iphone_notify',
    kind: 'other',
    aliases: ['IPhoneNotify', 'iphone_notify'],
    displayName: 'IPhoneNotify',
    description: 'Trigger a Pushcut notification on the user\'s iPhone (requires ~/.config/monad-agent/pushcut.json).',
    promptSummary: '`IPhoneNotify` (Pushcut iOS notification)',
    host: ['skill'],
    safety: ['network'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'ops-fleet',
  },
  {
    id: 'iphone_open_url',
    kind: 'other',
    aliases: ['IPhoneOpenUrl', 'iphone_open_url'],
    displayName: 'IPhoneOpenUrl',
    description: 'Open a URL in iPhone Safari via Pushcut execute(openUrl).',
    promptSummary: '`IPhoneOpenUrl` (Safari URL open on iPhone)',
    host: ['skill'],
    safety: ['network'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'ops-fleet',
  },
  {
    id: 'iphone_agent_result',
    kind: 'other',
    aliases: ['IPhoneAgentResult', 'iphone_agent_result'],
    displayName: 'IPhoneAgentResult',
    description: 'Send an "agent done" notification with title/summary/URL to iPhone.',
    promptSummary: '`IPhoneAgentResult` ("agent done" rich notification)',
    host: ['skill'],
    safety: ['network'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'ops-fleet',
  },
  {
    id: 'iphone_confirm',
    kind: 'other',
    aliases: ['IPhoneConfirm', 'iphone_confirm'],
    displayName: 'IPhoneConfirm',
    description: 'Ask a Y/N question via Pushcut only. Returns null when round-trip not wired.',
    promptSummary: '`IPhoneConfirm` (Pushcut-only Y/N)',
    host: ['skill'],
    safety: ['network'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'ops-fleet',
    minTier: 'T2',
  },
  {
    id: 'hitl_confirm',
    kind: 'other',
    aliases: ['HitlConfirm', 'hitl_confirm'],
    displayName: 'HitlConfirm',
    description: 'Race Y/N across every wired channel (telegram/discord/pushcut/terminal). First answer wins.',
    promptSummary: '`HitlConfirm` (unified human-in-the-loop Y/N)',
    host: ['skill'],
    safety: ['network'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'ops-fleet',
    minTier: 'T2',
  },
  // ── VW-P9: virtual windows + pane tree + broadcast ──
  {
    id: 'window_list',
    kind: 'other',
    aliases: ['WindowList', 'window_list'],
    displayName: 'WindowList',
    description: 'Enumerate virtual windows (id, title, fg/bg, pane count).',
    promptSummary: '`WindowList` (enumerate virtual windows)',
    host: ['skill'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'ops-ui',
  },
  {
    id: 'window_create',
    kind: 'other',
    aliases: ['WindowCreate', 'window_create'],
    displayName: 'WindowCreate',
    description: 'Create a new virtual window with a content spec (terminal/markdown/scratch/llm-chat).',
    promptSummary: '`WindowCreate` (spawn a new virtual window)',
    host: ['skill'],
    safety: ['process'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'ops-ui',
  },
  {
    id: 'window_switch',
    kind: 'other',
    aliases: ['WindowSwitch', 'window_switch'],
    displayName: 'WindowSwitch',
    description: 'Bring a virtual window to foreground.',
    promptSummary: '`WindowSwitch` (foreground a virtual window)',
    host: ['skill'],
    safety: ['process'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'ops-ui',
  },
  {
    id: 'window_close',
    kind: 'other',
    aliases: ['WindowClose', 'window_close'],
    displayName: 'WindowClose',
    description: 'Close a virtual window + all its panes.',
    promptSummary: '`WindowClose` (close virtual window)',
    host: ['skill'],
    safety: ['mutating', 'process'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'ops-ui',
    minTier: 'T2',
  },
  {
    id: 'pane_list',
    kind: 'other',
    aliases: ['PaneList', 'pane_list'],
    displayName: 'PaneList',
    description: 'List panes of a window (or all).',
    promptSummary: '`PaneList` (enumerate panes)',
    host: ['skill'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'ops-ui',
  },
  {
    id: 'pane_split',
    kind: 'other',
    aliases: ['PaneSplit', 'pane_split'],
    displayName: 'PaneSplit',
    description: 'Split a pane horizontally/vertically with new content.',
    promptSummary: '`PaneSplit` (split pane — tmux style)',
    host: ['skill'],
    safety: ['process'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'ops-ui',
  },
  {
    id: 'pane_focus',
    kind: 'other',
    aliases: ['PaneFocus', 'pane_focus'],
    displayName: 'PaneFocus',
    description: 'Focus a pane (by addr) or move focus directionally.',
    promptSummary: '`PaneFocus` (move focus)',
    host: ['skill'],
    safety: ['process'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'ops-ui',
  },
  {
    id: 'pane_close',
    kind: 'other',
    aliases: ['PaneClose', 'pane_close'],
    displayName: 'PaneClose',
    description: 'Close a pane; window auto-collapses.',
    promptSummary: '`PaneClose` (close pane)',
    host: ['skill'],
    safety: ['mutating', 'process'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'ops-ui',
    minTier: 'T2',
  },
  {
    id: 'pane_capture',
    kind: 'other',
    aliases: ['PaneCapture', 'pane_capture'],
    displayName: 'PaneCapture',
    description: 'Snapshot a pane (text/ocr/auto).',
    promptSummary: '`PaneCapture` (snapshot pane, OCR fallback)',
    host: ['skill'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'capture',
  },
  {
    id: 'pane_inject',
    kind: 'other',
    aliases: ['PaneInject', 'pane_inject'],
    displayName: 'PaneInject',
    description: 'Write bytes/key into a pane (PTY stdin / chat submit / scratch replace).',
    promptSummary: '`PaneInject` (write to pane)',
    host: ['skill'],
    safety: ['mutating', 'process'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'capture',
    minTier: 'T2',
  },
  {
    id: 'vw_broadcast',
    kind: 'other',
    aliases: ['BroadcastPanes', 'vw_broadcast'],
    displayName: 'BroadcastPanes',
    description: 'Fan-out identical bytes to multiple panes — LLM benchmark + group input.',
    promptSummary: '`BroadcastPanes` (write same bytes to N panes)',
    host: ['skill'],
    safety: ['mutating', 'process'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'ops-ui',
    minTier: 'T2',
  },
  {
    id: 'vw_subscribe',
    kind: 'other',
    aliases: ['VWSubscribe', 'vw_subscribe'],
    displayName: 'VWSubscribe',
    description: 'Register a temporary event subscription. Returns subscription_id for VWCollect.',
    promptSummary: '`VWSubscribe` (observe virtual-window events)',
    host: ['skill'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'ops-ui',
    minTier: 'T2',
  },
  {
    id: 'vw_collect',
    kind: 'other',
    aliases: ['VWCollect', 'vw_collect'],
    displayName: 'VWCollect',
    description: 'Drain events buffered by a VWSubscribe subscription.',
    promptSummary: '`VWCollect` (drain subscription buffer)',
    host: ['skill'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'ops-ui',
    minTier: 'T2',
  },
  {
    id: 'vw_unsubscribe',
    kind: 'other',
    aliases: ['VWUnsubscribe', 'vw_unsubscribe'],
    displayName: 'VWUnsubscribe',
    description: 'Cancel a VWSubscribe subscription.',
    promptSummary: '`VWUnsubscribe` (cancel subscription)',
    host: ['skill'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'ops-ui',
    minTier: 'T2',
  },
  // ── P12: terminal modal context exchange ──
  {
    id: 'terminal_modal_list',
    kind: 'other',
    aliases: ['TerminalModalList', 'terminal_modal_list'],
    displayName: 'TerminalModalList',
    description: 'List active terminal modal sessions (fg/bg/exited) with id, state, kind, attention level, cwd, title.',
    promptSummary: '`TerminalModalList` (enumerate live PTY modals — id, state, attention)',
    host: ['skill', 'tui'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'ops-ui',
    hintKeys: ['hasActivePtyModal'],
    probe: {
      kind: 'custom',
      custom: ptyAvailable,
      onFail: 'hide',
      ttlMs: 300_000,
    },
  },
  {
    id: 'terminal_modal_observe',
    kind: 'other',
    aliases: ['TerminalModalObserve', 'terminal_modal_observe'],
    displayName: 'TerminalModalObserve',
    description: 'Snapshot the current screen of a terminal modal session. Non-destructive; live PTY keeps running. Pair with List to discover sessions.',
    promptSummary: '`TerminalModalObserve` (snapshot a PTY modal\'s current grid — read claude-code/codex output)',
    host: ['skill', 'tui'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'ops-ui',
    hintKeys: ['hasActivePtyModal', 'hasSessionAttention'],
    probe: {
      kind: 'custom',
      custom: ptyAvailable,
      onFail: 'hide',
      ttlMs: 300_000,
    },
  },
  // NT-C3 (session nt, 2026-04-18): `terminal_modal_spawn` removed.
  // Use `RunShell` with mode='vw' (session-nt default) for all new
  // PTY spawning. The remaining terminal_modal_{list,observe,focus,
  // detach,kill} tools operate on existing sessions only.
  {
    id: 'terminal_modal_focus',
    kind: 'other',
    aliases: ['TerminalModalFocus', 'terminal_modal_focus'],
    displayName: 'TerminalModalFocus',
    description: 'Attach a background session to foreground. Previous foreground auto-detaches.',
    promptSummary: '`TerminalModalFocus` (bring bg session to fg — rewraps existing PTY)',
    host: ['skill', 'tui'],
    safety: ['process'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'ops-ui',
    minTier: 'T2',
    hintKeys: ['backgroundedPtyCount'],
    probe: {
      kind: 'custom',
      custom: ptyAvailable,
      onFail: 'hide',
      ttlMs: 300_000,
    },
  },
  {
    id: 'terminal_modal_detach',
    kind: 'other',
    aliases: ['TerminalModalDetach', 'terminal_modal_detach'],
    displayName: 'TerminalModalDetach',
    description: 'Send foreground session to background. PTY stays alive for re-attach.',
    promptSummary: '`TerminalModalDetach` (send fg to bg; PTY survives)',
    host: ['skill', 'tui'],
    safety: ['process'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'ops-ui',
    hintKeys: ['hasActivePtyModal'],
    probe: {
      kind: 'custom',
      custom: ptyAvailable,
      onFail: 'hide',
      ttlMs: 300_000,
    },
  },
  {
    id: 'terminal_modal_inject',
    kind: 'other',
    aliases: ['TerminalModalInject', 'terminal_modal_inject'],
    displayName: 'TerminalModalInject',
    description: 'Write bytes or named key to a session\'s PTY stdin. Mutating; requires user approval.',
    promptSummary: '`TerminalModalInject` (write bytes/key to PTY stdin — approval-gated)',
    host: ['skill', 'tui'],
    safety: ['mutating', 'process'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'ops-ui',
    minTier: 'T2',
    hintKeys: ['hasActivePtyModal', 'foregroundSessionKind'],
    probe: {
      kind: 'custom',
      custom: ptyAvailable,
      onFail: 'hide',
      ttlMs: 300_000,
    },
  },
  {
    id: 'terminal_modal_kill',
    kind: 'other',
    aliases: ['TerminalModalKill', 'terminal_modal_kill'],
    displayName: 'TerminalModalKill',
    description: 'Stop a session\'s PTY and remove the modal. Irreversible.',
    promptSummary: '`TerminalModalKill` (terminate PTY + drop session)',
    host: ['skill', 'tui'],
    safety: ['mutating', 'process'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'ops-ui',
    minTier: 'T2',
    probe: {
      kind: 'custom',
      custom: ptyAvailable,
      onFail: 'hide',
      ttlMs: 300_000,
    },
  },
  // ── T8a: Terminal Matrix (session e) ──
  // These live alongside terminal_modal_* above. Prefer matrix
  // variants when you need character / transport / placement /
  // broadcast-group awareness; modal variants are still the right
  // call for simple "spawn a PTY running <cmd> in a modal" flows
  // because they carry the approval-modal plumbing for inject.
  {
    id: 'terminal_matrix_list',
    kind: 'other',
    alwaysLoad: false,
    shouldDefer: true,
    aliases: ['TerminalMatrixList', 'terminal_matrix_list'],
    displayName: 'TerminalMatrixList',
    description: 'List terminals in the unified matrix with optional filters (transport, character, placement, group). Returns id, character, transport, placement, groups, readOnly, exit.',
    promptSummary: '`TerminalMatrixList` (enumerate unified matrix — filter by transport/character/placement/group)',
    host: ['skill', 'tui'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'ops-ui',
    minTier: 'T2',
    probe: {
      kind: 'custom',
      custom: ptyAvailable,
      onFail: 'hide',
      ttlMs: 300_000,
    },
  },
  {
    id: 'terminal_matrix_spawn',
    kind: 'other',
    alwaysLoad: false,
    shouldDefer: true,
    aliases: ['TerminalMatrixSpawn', 'terminal_matrix_spawn'],
    displayName: 'TerminalMatrixSpawn',
    description: 'Spawn a matrix terminal with full options (character, transport, initial groups, readOnly). For simple local modals keep TerminalModalSpawn.',
    promptSummary: '`TerminalMatrixSpawn` (PTY with character/transport/groups/readOnly — e.g. tailscale+claude-code)',
    host: ['skill', 'tui'],
    safety: ['process'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'ops-ui',
    minTier: 'T2',
    probe: {
      kind: 'custom',
      custom: ptyAvailable,
      onFail: 'hide',
      ttlMs: 300_000,
    },
  },
  {
    id: 'terminal_matrix_move',
    kind: 'other',
    alwaysLoad: false,
    shouldDefer: true,
    aliases: ['TerminalMatrixMove', 'terminal_matrix_move'],
    displayName: 'TerminalMatrixMove',
    description: 'Move a terminal between placements (background, preview, modal, vw:<w>/<s>) without respawning the PTY.',
    promptSummary: '`TerminalMatrixMove` (swap placement — bg/preview/modal/vw — PTY survives)',
    host: ['skill', 'tui'],
    safety: ['process'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'ops-ui',
    minTier: 'T2',
    probe: {
      kind: 'custom',
      custom: ptyAvailable,
      onFail: 'hide',
      ttlMs: 300_000,
    },
  },
  {
    id: 'terminal_broadcast_send',
    kind: 'other',
    alwaysLoad: false,
    shouldDefer: true,
    aliases: ['TerminalBroadcastSend', 'terminal_broadcast_send'],
    displayName: 'TerminalBroadcastSend',
    description: 'Broadcast bytes to every alive, non-readonly member of a named broadcast group. tmux synchronize-panes style.',
    promptSummary: '`TerminalBroadcastSend` (fan-out keys to a group — sync-panes)',
    host: ['skill', 'tui'],
    safety: ['mutating', 'process'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'ops-ui',
    minTier: 'T2',
    probe: {
      kind: 'custom',
      custom: ptyAvailable,
      onFail: 'hide',
      ttlMs: 300_000,
    },
  },
  {
    id: 'terminal_matrix_group_join',
    kind: 'other',
    alwaysLoad: false,
    shouldDefer: true,
    aliases: ['TerminalMatrixGroupJoin', 'terminal_matrix_group_join'],
    displayName: 'TerminalMatrixGroupJoin',
    description: 'Add a terminal to a broadcast group so TerminalBroadcastSend reaches it.',
    promptSummary: '`TerminalMatrixGroupJoin` (tag terminal with a broadcast group)',
    host: ['skill', 'tui'],
    safety: ['mutating'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'ops-ui',
    minTier: 'T2',
    probe: {
      kind: 'custom',
      custom: ptyAvailable,
      onFail: 'hide',
      ttlMs: 300_000,
    },
  },
  {
    id: 'terminal_matrix_group_leave',
    kind: 'other',
    alwaysLoad: false,
    shouldDefer: true,
    aliases: ['TerminalMatrixGroupLeave', 'terminal_matrix_group_leave'],
    displayName: 'TerminalMatrixGroupLeave',
    description: 'Remove a terminal from a broadcast group.',
    promptSummary: '`TerminalMatrixGroupLeave` (untag terminal from group)',
    host: ['skill', 'tui'],
    safety: ['mutating'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'ops-ui',
    minTier: 'T2',
    probe: {
      kind: 'custom',
      custom: ptyAvailable,
      onFail: 'hide',
      ttlMs: 300_000,
    },
  },
  {
    id: 'terminal_channel_publish',
    kind: 'other',
    alwaysLoad: false,
    shouldDefer: true,
    aliases: ['TerminalChannelPublish', 'terminal_channel_publish'],
    displayName: 'TerminalChannelPublish',
    description: 'Publish a structured message on the terminal IPC channel bus. Subscribers (terminals, UI, LLM tools) receive the payload.',
    promptSummary: '`TerminalChannelPublish` (IPC pubsub — <domain>:<topic> messages)',
    host: ['skill', 'tui'],
    safety: ['mutating'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'ops-ui',
    minTier: 'T2',
    probe: {
      kind: 'custom',
      custom: ptyAvailable,
      onFail: 'hide',
      ttlMs: 300_000,
    },
  },
  {
    id: 'terminal_readonly_set',
    kind: 'other',
    alwaysLoad: false,
    shouldDefer: true,
    aliases: ['TerminalReadonlySet', 'terminal_readonly_set'],
    displayName: 'TerminalReadonlySet',
    description: 'Toggle or set a terminal\'s read-only flag. Read-only terminals accept no writes (matrix.writeTo + broadcasts drop them).',
    promptSummary: '`TerminalReadonlySet` (lock terminal into spectator mode)',
    host: ['skill', 'tui'],
    safety: ['mutating'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'ops-ui',
    minTier: 'T2',
    probe: {
      kind: 'custom',
      custom: ptyAvailable,
      onFail: 'hide',
      ttlMs: 300_000,
    },
  },
  {
    id: 'terminal_recharacter',
    kind: 'other',
    alwaysLoad: false,
    shouldDefer: true,
    aliases: ['TerminalRecharacter', 'terminal_recharacter'],
    displayName: 'TerminalRecharacter',
    description: 'Swap a terminal\'s character + optionally exec the new binary inside the same PTY. shell | claude | codex | custom:<name>.',
    promptSummary: '`TerminalRecharacter` (swap shell → claude-code/codex in-place — preserves scrollback)',
    host: ['skill', 'tui'],
    safety: ['mutating', 'process'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'ops-ui',
    minTier: 'T2',
    probe: {
      kind: 'custom',
      custom: ptyAvailable,
      onFail: 'hide',
      ttlMs: 300_000,
    },
  },
  {
    id: 'terminal_pipe_to_channel',
    kind: 'other',
    alwaysLoad: false,
    shouldDefer: true,
    aliases: ['TerminalPipeToChannel', 'terminal_pipe_to_channel'],
    displayName: 'TerminalPipeToChannel',
    description: 'Publish a terminal\'s stdout chunks onto the ChannelBus (raw or line-mode). Returns pipe_id. Enables cross-terminal pipelines without side processes.',
    promptSummary: '`TerminalPipeToChannel` (PTY stdout → channel — pair with ChannelTail for A→B pipelines)',
    host: ['skill', 'tui'],
    safety: ['mutating'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'ops-ui',
    minTier: 'T2',
    probe: {
      kind: 'custom',
      custom: ptyAvailable,
      onFail: 'hide',
      ttlMs: 300_000,
    },
  },
  {
    id: 'terminal_unpipe_from_channel',
    kind: 'other',
    alwaysLoad: false,
    shouldDefer: true,
    aliases: ['TerminalUnpipeFromChannel', 'terminal_unpipe_from_channel'],
    displayName: 'TerminalUnpipeFromChannel',
    description: 'Detach a pipe created with TerminalPipeToChannel. Flushes partial line in line-mode.',
    promptSummary: '`TerminalUnpipeFromChannel` (stop stdout → channel pipe)',
    host: ['skill', 'tui'],
    safety: ['mutating'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'ops-ui',
    minTier: 'T2',
    probe: {
      kind: 'custom',
      custom: ptyAvailable,
      onFail: 'hide',
      ttlMs: 300_000,
    },
  },
  {
    id: 'terminal_pipe_list',
    kind: 'other',
    alwaysLoad: false,
    shouldDefer: true,
    aliases: ['TerminalPipeList', 'terminal_pipe_list'],
    displayName: 'TerminalPipeList',
    description: 'Enumerate every active stdout → channel pipe. Returns pipe_id, terminal_id, channel, line_mode.',
    promptSummary: '`TerminalPipeList` (audit active stdout → channel pipes)',
    host: ['skill', 'tui'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'ops-ui',
    minTier: 'T2',
    probe: {
      kind: 'custom',
      custom: ptyAvailable,
      onFail: 'hide',
      ttlMs: 300_000,
    },
  },
  {
    id: 'kr_flow_snapshot',
    kind: 'other',
    aliases: ['KrFlowSnapshot', 'kr_flow_snapshot', 'kr_flow'],
    displayName: 'KrFlowSnapshot',
    description: 'Korean stock investor-flow snapshot via 한국투자증권 API. Wraps kr-flow skill\'s Python CLI. Per-stock (6-digit symbol): foreign-net / investor / price / ohlcv / short-sale. Market-wide (no symbol): market-flow (KSP|KSQ) / frgn-institution / krx-market / krx-kosdaq / krx-etf. (Telegram/finance surface: prefer the finance_kr_flow tool.)',
    promptSummary: '`KrFlowSnapshot` (Korean 외국인/기관 수급 — per-stock:foreign-net|investor|price|ohlcv|short-sale + symbol · market:market-flow|frgn-institution|krx-*)',
    host: ['skill'],
    safety: ['network', 'process', 'read-only'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'ops-fleet',
    cleanerFitThanShell: true,
    probe: {
      // Consistent with dispatch: krFlowAvailable() accepts creds from the
      // process env OR the skill's own .env (the daemon carries neither, so a
      // process-env-only probe would keep this permanently hidden = dead weight).
      kind: 'custom',
      custom: () => krFlowAvailable(),
      onFail: 'hide',
      ttlMs: Infinity,
    },
  },
  {
    id: 'market_quote',
    kind: 'other',
    aliases: ['MarketQuote', 'market_quote', 'quote'],
    displayName: 'MarketQuote',
    description: 'Single-symbol price quote via EODHD (preferred) or FinancialDatasets.ai (fallback). Returns price/change/volume/asOf. For historical / fundamentals / multi-symbol use the omni-market skill.',
    promptSummary: '`MarketQuote` (single-symbol price quote — EODHD/FDS, returns price+change+volume)',
    host: ['skill'],
    safety: ['network', 'read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'viz',
    cleanerFitThanShell: true,
    probe: {
      kind: 'custom',
      custom: () => !!(process.env.EODHD_API_KEY || process.env.FDS_API_KEY),
      onFail: 'hide',
      ttlMs: Infinity,
    },
  },
  {
    id: 'omni_search',
    kind: 'other',
    aliases: ['OmniSearch', 'omni_search'],
    displayName: 'OmniSearch',
    description: 'Multi-provider web search — runs Grok + Firecrawl (any registered provider) in parallel and merges hits. Wider coverage than WebSearch (cascade) for research-intent queries. Probe-gated: requires ≥2 available providers.',
    promptSummary: '`OmniSearch` (parallel multi-provider search — wider coverage than WebSearch; merges results)',
    host: ['skill'],
    safety: ['network', 'read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'browse',
    cleanerFitThanShell: true,
    hintKeys: ['intentResearch'],
  },
  {
    id: 'api_call',
    kind: 'other',
    aliases: ['ApiCall', 'api_call', 'http_call', 'fetch_json'],
    displayName: 'ApiCall',
    description: 'Invoke an HTTP JSON API and return parsed body for branching. Host must be allowlisted via /api-allow (empty by default). Rate-limited 30/min/host + 200/min global. Use for GitHub/internal APIs/status endpoints where the LLM branches on the return value.',
    promptSummary: '`ApiCall` (HTTP JSON call — method/url/headers/body, returns parsed JSON for branching; requires /api-allow)',
    host: ['skill'],
    safety: ['network'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'browse',
    cleanerFitThanShell: true,
    hintKeys: ['recentNetworkError'],
    // ROADMAP Wave 2 classification tightening — already intent-gated
    // to 'browse'; hydrate via ToolSearch when the LLM reaches into
    // HTTP territory.
    alwaysLoad: false,
    shouldDefer: true,
  },
  {
    id: 'mermaid_render',
    kind: 'other',
    aliases: ['MermaidRender', 'mermaid_render', 'render_mermaid', 'mermaid'],
    displayName: 'MermaidRender',
    description: 'Render mermaid flowchart source as a terminal-displayable diagram. Supports flowchart LR/RL/TB/BT with labeled boxes and directed arrows. Unicode by default, ASCII fallback via format:"ascii".',
    promptSummary: '`MermaidRender` (render mermaid source — flowchart/sequence/class — as a TUI diagram)',
    host: ['skill'],
    safety: ['read-only', 'process'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'viz',
    cleanerFitThanShell: true,
    // Probe: npm package 'mermaidtui' must be resolvable. Uses the
    // `custom` kind so the check is synchronous at probe time (matches
    // probe.ts custom-kind semantics — runs once, WeakMap-cached).
    probe: {
      kind: 'custom',
      custom: () => {
        try { require.resolve('mermaidtui'); return true; } catch { return false; }
      },
      onFail: 'hide',
      ttlMs: 300_000,
    },
    hintKeys: ['intentDiagram'],
  },
  {
    id: 'mermaid_syntax',
    kind: 'other',
    aliases: ['MermaidSyntax', 'mermaid_syntax', 'mermaid_template'],
    displayName: 'MermaidSyntax',
    description: 'Return a known-good Mermaid template + syntax notes for one of the 9 diagram kinds. Call before producing mermaid source so the render compiles on the first try.',
    promptSummary: '`MermaidSyntax` (domain: flowchart|sequence|class|state|er|gantt|mindmap|timeline|pie — template + parser gotchas)',
    host: ['skill'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'viz',
    hintKeys: ['intentDiagram'],
  },
  {
    id: 'youtube_transcript',
    kind: 'other',
    aliases: ['YoutubeTranscript', 'youtube_transcript', 'yt_transcript'],
    displayName: 'YoutubeTranscript',
    description: 'Fetch a YouTube video\'s transcript via Supadata (caption API). Returns text + timestamped segments. For full summarization/study-notes use the youtube-master skill.',
    promptSummary: '`YoutubeTranscript` (url, lang? — fetch video captions via Supadata; skill escalation path for STT fallback)',
    host: ['skill'],
    safety: ['network'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'browse',
    cleanerFitThanShell: true,
    // Probe-gated on SUPADATA_API_KEY so the tool hides when the
    // user hasn't configured the caption API.
    probe: {
      kind: 'custom',
      custom: () => !!process.env['SUPADATA_API_KEY'],
      onFail: 'hide',
      ttlMs: 300_000,
    },
  },
  {
    id: 'dashboard_config_get',
    kind: 'other',
    aliases: ['DashboardConfigGet', 'dashboard_config_get'],
    displayName: 'DashboardConfigGet',
    description: 'Read one of the curated dashboard config keys (chatOnlyMode, theme.active, input.maxLines, preview.source, workingDir.showHidden, workingDir.sortMode). Returns value + type metadata.',
    promptSummary: '`DashboardConfigGet` (key — read a curated dashboard config value)',
    host: ['skill'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'ops-ui',
  },
  {
    id: 'dashboard_config_set',
    kind: 'other',
    aliases: ['DashboardConfigSet', 'dashboard_config_set'],
    displayName: 'DashboardConfigSet',
    description: 'Write one of the curated dashboard config keys (mutating). Validated against the key type + range + enum; requires user approval.',
    promptSummary: '`DashboardConfigSet` (key, value — mutating; requires approval)',
    host: ['skill'],
    safety: ['mutating'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'ops-ui',
    minTier: 'T2',
  },
  {
    id: 'spawn_coding_agent_in_vw',
    kind: 'other',
    aliases: ['SpawnCodingAgentInVW', 'spawn_coding_agent_in_vw'],
    displayName: 'SpawnCodingAgentInVW',
    description: 'One-call spawn of claude-code or codex inside a new virtual window with a terminal pane. Returns window_id + pane_id. Fails cleanly when the binary is missing.',
    promptSummary: '`SpawnCodingAgentInVW` (brand: claude-code|codex, cwd?, extra_args? — fresh VW + terminal pane running the agent)',
    host: ['skill'],
    safety: ['process'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'ops-ui',
  },
  {
    id: 'dashboard_widget_list',
    kind: 'other',
    aliases: ['DashboardWidgetList', 'dashboard_widget_list'],
    displayName: 'DashboardWidgetList',
    description: 'Enumerate live widget instances on the current dashboard view (id + type + focus state).',
    promptSummary: '`DashboardWidgetList` — enumerate live widgets',
    host: ['skill'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'ops-ui',
  },
  {
    id: 'dashboard_widget_toggle',
    kind: 'other',
    aliases: ['DashboardWidgetToggle', 'dashboard_widget_toggle'],
    displayName: 'DashboardWidgetToggle',
    description: 'Toggle a widget\'s focused flag by id. Non-destructive.',
    promptSummary: '`DashboardWidgetToggle` (id — flip focused flag)',
    host: ['skill'],
    safety: ['process'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'ops-ui',
  },
  {
    id: 'dashboard_pane_focus',
    kind: 'other',
    aliases: ['DashboardPaneFocus', 'dashboard_pane_focus'],
    displayName: 'DashboardPaneFocus',
    description: 'Focus a dashboard pane by name (browser, preview, log, scratch, obsidian, input).',
    promptSummary: '`DashboardPaneFocus` (name — move dashboard focus)',
    host: ['skill'],
    safety: ['process'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'ops-ui',
  },
  {
    // HT1 — view-switch from skill/dashboard chat. Numeric ids 1..6
    // + shortcut '7' (Widget Playground) + labels like "agents" or
    // "playground" all accepted. Non-destructive UI shift.
    id: 'dashboard_view_switch',
    kind: 'other',
    aliases: ['DashboardViewSwitch', 'dashboard_view_switch'],
    displayName: 'DashboardViewSwitch',
    description: 'Switch dashboard to another view by id, label, or shortcut. Useful for scripted walkthroughs (e.g. V7 playground) without keyboard access.',
    promptSummary: '`DashboardViewSwitch` (view — id/label/shortcut e.g. "7" or "playground")',
    host: ['skill'],
    safety: ['process'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'ops-ui',
  },
  {
    // HT2 — programmatic key injection at a widget instance. Enables
    // automated smoke tests of the playground widget via tool call.
    id: 'dashboard_widget_invoke',
    kind: 'other',
    aliases: ['DashboardWidgetInvoke', 'dashboard_widget_invoke'],
    displayName: 'DashboardWidgetInvoke',
    description: 'Send a synthetic KeyEvent { name, ctrl?, shift?, alt? } to a widget instance (e.g. wd-playground). Returns handled flag + post-invoke state snapshot. T2+ — this can mutate widget state.',
    promptSummary: '`DashboardWidgetInvoke` (id, key, ctrl?, shift?, alt? — synthetic keystroke + state snapshot)',
    host: ['skill'],
    safety: ['mutating', 'process'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'ops-ui',
    minTier: 'T2',
  },
  {
    id: 'dashboard_slash_execute',
    kind: 'other',
    aliases: ['DashboardSlashExecute', 'dashboard_slash'],
    displayName: 'DashboardSlashExecute',
    description: 'Queue a slash command into the dashboard input prompt from control mode. Only a curated allow-list is callable; blocked slashes (quit, debug, etc.) require user keystrokes. User confirms with Enter.',
    promptSummary: '`DashboardSlashExecute` (name, args[] — queue a dashboard slash into the input prompt)',
    host: ['skill'],
    safety: ['process'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'ops-ui',
  },
  {
    id: 'set_tool_hint',
    kind: 'other',
    aliases: ['SetToolHint', 'set_tool_hint'],
    displayName: 'SetToolHint',
    description: 'Register a turn- or session-scoped hint that nudges which native tools the gate exposes next. Kinds: prefer/avoid/enable/disable/boost/param-default. Not available on weaker models.',
    promptSummary: '`SetToolHint` (kind:prefer|avoid|enable|disable|param-default, tool, scope:turn|session, reason? — steer upcoming tool selection)',
    host: ['skill'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'coding',
    // Meta-tool — only worth exposing to models that can reason about
    // their own tool use. T3 / local models should stay focused.
    minTier: 'T2',
  },
  // ── TOX-3 (task-orchestrator) — 8 LLM tools ──
  {
    id: 'task_create',
    kind: 'other',
    aliases: ['TaskCreate', 'task_create'],
    displayName: 'TaskCreate',
    description:
      "Create a single TOX task and add it to the orchestrator graph. Use for the FIRST task in a 1-2 step ask, or to queue isolated follow-ups. " +
      "For multi-step objectives (3+ logical phases or work that crosses files/domains), prefer TaskDecompose — it produces a plan you can review " +
      "before committing. Always call TaskList before creating to avoid duplicates. Mark status='in_progress' when you start a task, 'completed' " +
      "when done; after 3 consecutive 'completed' transitions a verification reminder fires (see W4.3 in ROADMAP).",
    promptSummary: '`TaskCreate` (title, surface, goalSlug?, dependsOn?, priority? — add one task · TaskList first to avoid dupes)',
    host: ['skill', 'tui'],
    safety: ['mutating'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'coding',
  },
  {
    id: 'task_decompose',
    kind: 'other',
    aliases: ['TaskDecompose', 'task_decompose'],
    displayName: 'TaskDecompose',
    description:
      "Decompose an objective into 3–7 proposed TOX tasks. PREFER THIS over hand-writing TaskCreate calls when: (a) the user request is multi-step " +
      "(3+ logical phases), (b) the scope is ambiguous and a plan-then-execute split helps, (c) the work crosses files/domains/surfaces, or " +
      "(d) the user explicitly asked for a plan. Returns applyToken + approval flags — follow with TaskDecomposeApply once the plan looks right. " +
      "Output stays a proposal until applied, so cheap to revise.",
    promptSummary: '`TaskDecompose` (objective, goalSlug?, maxTasks?, preferredSurfaces?, budgetUsdRemaining? — plan-first for 3+ step / ambiguous / cross-cutting work)',
    host: ['skill', 'tui'],
    safety: ['agent'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'coding',
  },
  {
    id: 'task_decompose_apply',
    kind: 'other',
    aliases: ['TaskDecomposeApply', 'task_decompose_apply'],
    displayName: 'TaskDecomposeApply',
    description:
      'Commit a previously-proposed TaskDecompose result to the graph. Use force:true when the proposal required approval and the user has agreed.',
    promptSummary: '`TaskDecomposeApply` (applyToken, force? — commit proposal)',
    host: ['skill', 'tui'],
    safety: ['mutating'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'coding',
  },
  {
    id: 'task_list',
    kind: 'other',
    aliases: ['TaskList', 'task_list'],
    displayName: 'TaskList',
    description:
      'List TOX tasks filtered by status / goalSlug / surface. Summaries for discovery + follow-up TaskGet calls.',
    promptSummary: '`TaskList` (status?, goalSlug?, surface?, limit? — task summaries)',
    host: ['skill', 'tui', 'mcp'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'coding',
  },
  {
    id: 'task_get',
    kind: 'other',
    aliases: ['TaskGet', 'task_get'],
    displayName: 'TaskGet',
    description:
      'Fetch a TOX task by id with full detail (status, surface, deps, recent notes).',
    promptSummary: '`TaskGet` (taskId — full task detail)',
    host: ['skill', 'tui', 'mcp'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'coding',
  },
  {
    id: 'task_update',
    kind: 'other',
    aliases: ['TaskUpdate', 'task_update'],
    displayName: 'TaskUpdate',
    description:
      'Update a TOX task in place — status / priority / notes / appendNote. Invalid status transitions surface as error output (no throw).',
    promptSummary: '`TaskUpdate` (taskId, patch:{status?, priority?, appendNote?} — partial update)',
    host: ['skill', 'tui'],
    safety: ['mutating'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'coding',
  },
  {
    id: 'task_dispatch',
    kind: 'other',
    aliases: ['TaskDispatch', 'task_dispatch'],
    displayName: 'TaskDispatch',
    description:
      'Trigger a single dispatch tick — promote ready tasks and hand each to its surface adapter (respecting concurrency caps).',
    promptSummary: '`TaskDispatch` (promote? — run dispatcher.tick)',
    host: ['skill', 'tui'],
    safety: ['process', 'mutating'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'coding',
  },
  {
    id: 'task_kill',
    kind: 'other',
    aliases: ['TaskKill', 'task_kill'],
    displayName: 'TaskKill',
    description:
      'Cancel a TOX task. With cascade:true, cancel all downstream dependents. Running tasks receive AbortSignal; terminal tasks are skipped.',
    promptSummary: '`TaskKill` (taskId, cascade? — cancel task(s))',
    host: ['skill', 'tui'],
    safety: ['mutating', 'process'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'coding',
  },
  // ── AXON P1 — ACP dual-role session tools ──────────────────────
  // Let the LLM drive an external ACP agent (claude-code / codex /
  // gemini) as a sub-conversation. The session id returned by
  // AcpSessionCreate flows through AcpSessionSend and AcpSessionClose
  // — namespaced `acp-cli:<brand>:<id>` so debug / sidebar tools can
  // tell client-side sessions from server-side ones that an external
  // IDE opens against us.
  {
    id: 'acp_session_create',
    kind: 'other',
    alwaysLoad: false,
    shouldDefer: true,
    aliases: ['AcpSessionCreate', 'acp_session_create'],
    displayName: 'AcpSessionCreate',
    description: "Start an ACP client session against an external coding agent. Brands: 'claude' / 'cc' (claude-code-acp) · 'codex' / 'cx' / 'cas' (codex app-server · canonical) · 'gemini' / 'gm'. Returns a namespaced sessionId for AcpSessionSend / AcpSessionClose.",
    promptSummary: '`AcpSessionCreate` (brand, cwd? — spawn/reuse an external ACP agent session)',
    host: ['skill', 'tui'],
    safety: ['process', 'mutating'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'ops-fleet',
  },
  {
    id: 'acp_session_send',
    kind: 'other',
    alwaysLoad: false,
    shouldDefer: true,
    aliases: ['AcpSessionSend', 'acp_session_send'],
    displayName: 'AcpSessionSend',
    description: 'Send a text prompt to an existing ACP client session and await the turn. Returns concatenated output + stopReason + lastSeenAt.',
    promptSummary: '`AcpSessionSend` (sessionId, message, maxOutputChars? — drive an external ACP agent turn)',
    host: ['skill', 'tui'],
    safety: ['process', 'mutating'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'ops-fleet',
  },
  {
    id: 'acp_session_close',
    kind: 'other',
    alwaysLoad: false,
    shouldDefer: true,
    aliases: ['AcpSessionClose', 'acp_session_close'],
    displayName: 'AcpSessionClose',
    description: 'Cancel (if mid-turn) and drop an ACP client session record. Underlying subprocess stays alive for other sessions of the same brand+cwd.',
    promptSummary: '`AcpSessionClose` (sessionId — end an external ACP agent session)',
    host: ['skill', 'tui'],
    safety: ['process'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'ops-fleet',
  },
  // ── H2 #5 — session persistence read surface ──────────────────
  // Lists + resumes sessions persisted by the turn-end auto-persist
  // hook (follow-up #1). Resume is capability-gated on the peer's
  // `loadSession: true` (pinned claude/codex/gemini ACP shims today
  // advertise false; codex-app-server resumes via thread/resume RPC).
  {
    id: 'acp_session_list',
    kind: 'other',
    alwaysLoad: false,
    shouldDefer: true,
    aliases: ['AcpSessionList', 'acp_session_list'],
    displayName: 'AcpSessionList',
    description: 'List ACP client sessions persisted to disk (~/.config/elanous/acp-sessions/). Optional brand filter. Returns [{ sessionId, backendSessionId, backendId, cwd, createdAt, lastSeenAt, origin? }].',
    promptSummary: '`AcpSessionList` (brand? — list persisted ACP sessions for resume)',
    host: ['skill', 'tui'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'ops-fleet',
  },
  {
    id: 'acp_session_resume',
    kind: 'other',
    alwaysLoad: false,
    shouldDefer: true,
    aliases: ['AcpSessionResume', 'acp_session_resume'],
    displayName: 'AcpSessionResume',
    description: 'Resume a persisted ACP session — loads its on-disk snapshot + calls the peer loadSession RPC. Throws AcpLoadSessionUnsupportedError when the peer advertises loadSession:false (pinned claude/codex/gemini ACP shims today; codex-app-server resumes via thread/resume RPC).',
    promptSummary: '`AcpSessionResume` (sessionId — restore + reactivate a persisted session)',
    host: ['skill', 'tui'],
    safety: ['process', 'mutating'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'ops-fleet',
  },
  // ── H3 #7 — subagent spawning (one-shot fire-and-forget) ──────
  {
    id: 'acp_session_spawn_sub',
    kind: 'other',
    alwaysLoad: false,
    shouldDefer: true,
    aliases: ['AcpSessionSpawnSub', 'acp_session_spawn_sub'],
    displayName: 'AcpSessionSpawnSub',
    description: 'One-shot: spawn a subagent ACP session linked to parentSessionId, send initialMessage, await the turn, tear the child down. Returns { sessionId, chainDepth, output, stopReason, truncated }. Throws ReentrancyError when chain depth would reach HOP_CAP (default 3).',
    promptSummary: '`AcpSessionSpawnSub` (parentSessionId, brand, initialMessage, maxOutputChars?, cwd? — delegate a subtask to a nested ACP session)',
    host: ['skill', 'tui'],
    safety: ['process', 'mutating'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'ops-fleet',
  },
  // ── Plan/Execute Bridge P4-B — bundled plan-then-execute helper ──
  // Composes two AcpSessionSpawnSub calls (plan-mode + execute-mode)
  // under the same parent. Plan output is automatically prepended to
  // the execute prompt as context. Pass `executeBrand` for cross-model
  // patterns (Codex plans, Claude executes).
  {
    id: 'acp_plan_then_execute',
    kind: 'other',
    alwaysLoad: false,
    shouldDefer: true,
    aliases: ['AcpPlanThenExecute', 'acp_plan_then_execute'],
    displayName: 'AcpPlanThenExecute',
    description: 'Plan/Execute Bridge: bundle "plan, then execute" into one tool call. Phase 1 spawns a sub-agent in plan mode (prompt-prefixed read-only guard) and sends planPrompt. Phase 2 spawns another sub-agent in execute mode and sends the plan output + executePrompt as combined context. Set executeBrand different from brand to use one model for planning and another for execution (e.g. Codex plans, Claude executes). Returns both plan and execute outputs.',
    promptSummary: '`AcpPlanThenExecute` (parentSessionId, brand, planPrompt, executePrompt, executeBrand? — plan-then-execute one call)',
    host: ['skill', 'tui'],
    safety: ['process', 'mutating'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'ops-fleet',
  },
  // ── H3 #6 — background agent (Warp Oz cloud-agent parity) ─────
  // Start returns immediately with a backgroundId. Status polls the
  // 5-state lifecycle (running · waiting_for_confirmation · completed
  // · failed · cancelled). Cancel aborts mid-turn. Join retrieves
  // fullOutput + optional promoteToVW spawn.
  {
    id: 'acp_session_start_background',
    kind: 'other',
    // ROADMAP Wave 2 classification tightening — flipped shouldDefer
    // to true (was false). Long description (~1.8K chars) earns the
    // biggest single saving; LLM hydrates via ToolSearch when the
    // user explicitly asks for background execution.
    alwaysLoad: false,
    shouldDefer: true,
    aliases: ['AcpSessionStartBackground', 'acp_session_start_background'],
    displayName: 'AcpSessionStartBackground',
    description: 'Run a task in the background NOW — the canonical tool for natural-language requests like "background로 돌려줘", "run X in background", "비동기로 실행", "do this async", or "kick off Y in the background". Returns { backgroundId, clientSessionId, state:"running", ...} immediately so the chat is not blocked; the turn keeps running async. Prefer this — NOT `scheduler_create` / `task_register_from_text` — whenever the user wants work to start IMMEDIATELY rather than at a scheduled future time or recurring cadence. Use AcpSessionStatus to poll, AcpSessionCancel to abort, AcpSessionJoin to retrieve final output. iPhone push fires on approval-pending + completion (when Pushcut configured). Accepts parentSessionId for H3 #7 subagent linkage.',
    promptSummary: '`AcpSessionStartBackground` (brand, initialMessage, cwd?, origin?, parentSessionId? — start a long-running background turn)',
    host: ['skill', 'tui'],
    safety: ['process', 'mutating'],
    // Mutates BackgroundManager state (creates a new record) · serialize
    // to match `acp_session_create`'s pattern · parallel planner will
    // queue instead of fanning out.
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'ops-fleet',
  },
  {
    id: 'acp_session_status',
    kind: 'other',
    alwaysLoad: false,
    shouldDefer: true,
    aliases: ['AcpSessionStatus', 'acp_session_status'],
    displayName: 'AcpSessionStatus',
    description: 'Read the current state of a background ACP session. Returns { state, backendId, startedAt, lastSeenAt, endedAt?, stopReason?, error?, outputPreview (~2KB cap) }. For the full output after completion, use AcpSessionJoin.',
    promptSummary: '`AcpSessionStatus` (backgroundId — poll a background session state + preview)',
    host: ['skill', 'tui'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'ops-fleet',
  },
  {
    id: 'acp_session_cancel',
    kind: 'other',
    alwaysLoad: false,
    shouldDefer: true,
    aliases: ['AcpSessionCancel', 'acp_session_cancel'],
    displayName: 'AcpSessionCancel',
    description: 'Cancel an in-flight background ACP turn. Idempotent — returns cancelled:false when the session is already terminal. The cancelled snapshot remains retrievable via AcpSessionStatus / AcpSessionJoin.',
    promptSummary: '`AcpSessionCancel` (backgroundId — abort a running background session)',
    host: ['skill', 'tui'],
    // Targets a specific backgroundId · distinct ids don't race. Drop
    // 'mutating' tag to match `acp_session_close` (same pattern — per-
    // target cancel signal) · keep supportsParallel: true.
    safety: ['process'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'ops-fleet',
  },
  {
    id: 'acp_session_join',
    kind: 'other',
    alwaysLoad: false,
    shouldDefer: true,
    aliases: ['AcpSessionJoin', 'acp_session_join'],
    displayName: 'AcpSessionJoin',
    description: 'Retrieve the full collected output of a background ACP session. When still running returns partial output; when terminal returns complete output + stopReason. Pass promoteToVW:true to spawn a live Virtual Window pane backed by this BG (alive sessions only).',
    promptSummary: '`AcpSessionJoin` (backgroundId, promoteToVW? — collect full output; optionally open a live VW pane)',
    host: ['skill', 'tui'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'ops-fleet',
  },
  // ── AXON P5 — explicit termination signal ─────────────────────
  // LLM-facing equivalent of "I'm done". The 7-factor termination
  // detector reads this as factor 7 (announce-completion) and
  // respects it even when structural factors disagree (AnnounceCompletion
  // escape hatch). Loop runners and TOX feedback-loop should pipe the
  // detector's verdict through and exit on shouldTerminate=true.
  {
    id: 'announce_completion',
    kind: 'other',
    alwaysLoad: false,
    shouldDefer: true,
    aliases: ['AnnounceCompletion', 'announce_completion'],
    displayName: 'AnnounceCompletion',
    description: 'Explicit end-of-turn signal. Record summary + outcome so the termination detector can respect your decision even when structural factors are still amber.',
    promptSummary: '`AnnounceCompletion` (summary, outcome:success|partial|failed, nextSteps? — explicit "I am done")',
    host: ['skill', 'tui'],
    safety: ['read-only'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'ops-fleet',
  },

  // OH8 follow-up (PR-1) — multi-filter test tool. `bun test` is a
  // substring filter: a typo filter matches 0 files but still exits 0
  // ("33 pass / exit 0" false-pass). run_tests spawns each filter
  // individually and returns `unmatchedFilters` so a filter that ran
  // nothing can't masquerade as a pass. Deferred (schema via ToolSearch).
  {
    id: 'run_tests',
    kind: 'execute',
    alwaysLoad: false,
    shouldDefer: true,
    aliases: ['RunTests', 'run_tests'],
    displayName: 'run_tests',
    description: 'Run one or more test filters and report which matched NO files. `bun test` uses substring filters, so a typo/no-match filter exits 0 silently — this tool spawns each filter individually and returns unmatchedFilters + pass/fail. ok = fail===0 AND pass>0 AND unmatchedFilters empty. Prefer over `Bash bun test <a> <b>` when passing multiple filters.',
    promptSummary: '`run_tests` (filters[] — per-filter bun test; reports unmatchedFilters so a 0-match typo filter cannot false-pass)',
    host: ['skill', 'tui'],
    safety: ['process', 'read-only'],
    supportsParallel: false,
    defaultEnabled: true,
    cleanerFitThanShell: true,
    intentScope: 'coding',
  },

  // BCO Phase D4 — Browser Context Organ entry points. Both are
  // shouldDefer=true so their schemas surface only via ToolSearch.
  // Provide Chrome via ELANOUS_CHROME_BIN or ensure Google Chrome /
  // Chromium is installed; otherwise the runtime returns a polite
  // "Chrome unavailable" message and does not crash.
  {
    id: 'browser_navigate',
    kind: 'web',
    alwaysLoad: false,
    aliases: ['BrowserNavigate', 'browser_navigate'],
    displayName: 'BrowserNavigate',
    description: 'Navigate the Elanous Browser Context Organ (persistent headless Chrome) to a URL. Returns final URL, title, load time. Pair with BrowserRead.',
    promptSummary: '`BrowserNavigate` (open URL in persistent headless Chrome · waitForLoad)',
    host: ['skill', 'tui'],
    safety: ['network', 'read-only'],
    supportsParallel: false,
    defaultEnabled: true,
    shouldDefer: true,
    intentScope: 'browse',
  },
  {
    id: 'browser_read',
    kind: 'web',
    alwaysLoad: false,
    aliases: ['BrowserRead', 'browser_read'],
    displayName: 'BrowserRead',
    description: 'Read the currently loaded page (text / html / screenshot). Optional CSS selector narrows the scope. Pair with BrowserNavigate.',
    promptSummary: '`BrowserRead` (extract text/html/screenshot from current BCO page · optional selector)',
    host: ['skill', 'tui'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    shouldDefer: true,
    intentScope: 'browse',
  },

  // Coding Pipeline P5 — Ref repo sync cycle (FindRepo / SyncRepo /
  // RefConsult). All three are shouldDefer=true: their schemas surface
  // only via ToolSearch so the base prompt stays lean for agents
  // that don't need external-repo discovery.
  {
    id: 'find_repo',
    kind: 'other',
    alwaysLoad: false,
    aliases: ['FindRepo', 'find_repo'],
    displayName: 'FindRepo',
    description: 'Extract GitHub / GitLab / Bitbucket repository URLs from a blob of text (omni-crawl / WebFetch) and rank them. Pure; no network.',
    promptSummary: '`FindRepo` (extract+rank repo URLs from text · pure)',
    host: ['skill', 'tui'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    shouldDefer: true,
    intentScope: 'browse',
  },
  {
    id: 'sync_repo',
    kind: 'other',
    alwaysLoad: false,
    aliases: ['SyncRepo', 'sync_repo'],
    displayName: 'SyncRepo',
    description: 'Clone or fetch a host-allowlisted repo into ~/.cache/elanous-refs. Shallow, partial, sparse by default. 24h stale window; mode="update" forces refresh.',
    promptSummary: '`SyncRepo` (cache a GitHub/GitLab/Bitbucket repo locally · shallow/partial/sparse · 24h stale)',
    host: ['skill', 'tui'],
    safety: ['network', 'mutating'],
    supportsParallel: false,
    defaultEnabled: true,
    shouldDefer: true,
    intentScope: 'browse',
  },
  {
    id: 'ref_consult',
    kind: 'other',
    alwaysLoad: false,
    aliases: ['RefConsult', 'ref_consult'],
    displayName: 'RefConsult',
    description: 'Grep or read inside a repo previously SyncRepo-cloned into ~/.cache/elanous-refs. Fast; reuses cache.',
    promptSummary: '`RefConsult` (grep/read inside a cached ref repo · fast · no network)',
    host: ['skill', 'tui'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    shouldDefer: true,
    intentScope: 'browse',
  },

  // Coding Pipeline P5 hygiene (followup H) — RefsGC. Garbage-collect
  // ~/.cache/elanous-refs by TTL + size cap. Deferred — rarely needed
  // mid-coding; user invokes when disk pressure shows up.
  {
    id: 'refs_gc',
    kind: 'other',
    aliases: ['RefsGC', 'refs_gc'],
    displayName: 'RefsGC',
    description: 'Garbage-collect the SyncRepo cache at ~/.cache/elanous-refs. TTL pass (default 30 days) + size-cap pass (default 5GB, LRU). Pass dryRun:true to preview. Returns scanned/retained/evicted counts and bytes freed.',
    promptSummary: '`RefsGC` (prune ~/.cache/elanous-refs · TTL + LRU size cap · dryRun preview)',
    host: ['skill', 'tui'],
    safety: ['mutating'],
    supportsParallel: false,
    defaultEnabled: true,
    alwaysLoad: false,
    shouldDefer: true,
    intentScope: 'browse',
  },

  // Coding Pipeline P4 — Git tools. Structured wrappers around
  // `git commit` and `gh pr create` that enforce the invariants raw
  // Bash lets the LLM violate (git add -A, .env files, HEREDOC body
  // escape, title length). Both are mutating/network; sequential.
  {
    id: 'git_commit',
    kind: 'other',
    aliases: ['GitCommit', 'git_commit'],
    displayName: 'GitCommit',
    description: 'Stage specific files and create a new git commit. Enforces listed files only (no `git add -A`), auto-rejects .env/credentials, auto-appends Co-Authored-By trailer.',
    promptSummary: '`GitCommit` (safe git commit · specific files · auto Co-Authored-By trailer · hooks enforced)',
    host: ['skill', 'tui'],
    safety: ['mutating'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'coding',
    // ROADMAP Wave 2 classification tightening — commits happen at
    // task boundaries, not every turn; hydrate on demand.
    alwaysLoad: false,
    shouldDefer: true,
  },
  {
    id: 'open_pull_request',
    kind: 'other',
    aliases: ['OpenPullRequest', 'open_pull_request'],
    displayName: 'OpenPullRequest',
    description: 'Open a pull request via `gh pr create`, body streamed via stdin. Refuses to push protected branches. Clamps title length.',
    promptSummary: '`OpenPullRequest` (gh pr create wrapper · body via stdin · protected branch guard)',
    host: ['skill', 'tui'],
    safety: ['network', 'mutating'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'coding',
  },

  // Coding Pipeline P4 followup — MergePullRequest. Closes the
  // GitCommit → OpenPullRequest → MergePullRequest workflow without
  // raw `gh pr merge` Bash. `--admin` is double-gated (arg + env var).
  {
    id: 'merge_pull_request',
    kind: 'other',
    aliases: ['MergePullRequest', 'merge_pull_request'],
    displayName: 'MergePullRequest',
    description: 'Merge a PR via `gh pr merge`. Strategy is required (squash | merge | rebase). Optional deleteBranch, auto (--auto, wait for checks), admin (--admin, double-gated by ELANOUS_GH_ALLOW_ADMIN=1).',
    promptSummary: '`MergePullRequest` (gh pr merge wrapper · explicit strategy · admin double-gated)',
    host: ['skill', 'tui'],
    safety: ['network', 'mutating'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'coding',
    // ROADMAP Wave 2 classification tightening — destructive merge
    // ops are user-explicit; hydrate when requested.
    alwaysLoad: false,
    shouldDefer: true,
  },

  // Coding Pipeline P1 — ToolSearch primitive. Returns the full schema
  // (LLMToolSpec) for deferred tools on demand so the base system
  // prompt can stay lean. Pattern adapted from claude-code-fork's
  // `src/tools/ToolSearchTool/ToolSearchTool.ts`. alwaysLoad=true so
  // the LLM always has a path to discover deferred tools.
  {
    id: 'tool_search',
    kind: 'other',
    aliases: ['ToolSearch', 'tool_search'],
    displayName: 'ToolSearch',
    description: 'Fetch full JSONSchema definitions for deferred tools so they can be called. Use `select:<name>[,<name>...]` for direct selection, or keyword text for a ranked fuzzy search. Returns one `<functions>{...}</functions>` block per match — the same encoding as the base tool list, so once loaded the tool is callable exactly like any pre-loaded tool.',
    promptSummary: '`ToolSearch` (fetch deferred tool schemas · `select:Foo,Bar` or keyword search · up to max_results)',
    host: ['skill', 'tui'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    alwaysLoad: true,
    toolSearchable: false,
    intentScope: 'always',
  },

  // Presentation P5c — LLM scenario tools (registered by
  // registerScenarioRuntimes · src/tool-runtime/scenario-runtimes.ts).
  // Adding catalog entries here lets the LLM call them by PascalCase
  // alias (e.g. `RunScenario`) via dispatchToolByName — the canonical
  // id path (`ui_run_scenario`) was already usable pre-entry.
  {
    id: 'ui_list_scenarios',
    kind: 'other',
    aliases: ['ListScenarios', 'ui_list_scenarios'],
    displayName: 'ListScenarios',
    description: 'Enumerate every loaded Presentation scenario (id + title + description + meta). Read-only · no side effects. Optional `tags` array filters to scenarios whose meta.tags contains every listed tag.',
    promptSummary: '`ListScenarios` (enumerate loaded scenarios · optional tags filter)',
    host: ['skill', 'tui', 'mcp'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'ops-ui',
  },
  {
    id: 'ui_run_scenario',
    kind: 'other',
    aliases: ['RunScenario', 'ui_run_scenario'],
    displayName: 'RunScenario',
    description: 'Materialize a Presentation scenario by id. When the host wired an onMount callback the widgets are mounted; otherwise returns a summary dry-run. `lax: true` (default) returns partial widgets + errors; `lax: false` requires a clean decode.',
    promptSummary: '`RunScenario` (materialize + mount a scenario by id · dry-run when host unmounted)',
    host: ['skill', 'tui', 'mcp'],
    safety: ['mutating'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'ops-ui',
  },
  {
    id: 'ui_get_scenario_schema',
    kind: 'other',
    aliases: ['GetScenarioSchema', 'ui_get_scenario_schema'],
    displayName: 'GetScenarioSchema',
    description: 'Return a scenario definition + the set of widget types it references. Read-only · use before editing a scenario YAML to understand its shape.',
    promptSummary: '`GetScenarioSchema` (inspect scenario def + widget types before editing)',
    host: ['skill', 'tui', 'mcp'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'ops-ui',
  },
  {
    id: 'ui_validate_scenario_yaml',
    kind: 'other',
    aliases: ['ValidateScenarioYaml', 'ui_validate_scenario_yaml'],
    displayName: 'ValidateScenarioYaml',
    description: 'Parse inline YAML as a scenario + run it through the decode pipeline in lax mode. Returns `{ok, widgetCount, errors}` — use in an edit-then-validate loop before writing the YAML to disk.',
    promptSummary: '`ValidateScenarioYaml` (lint inline scenario YAML before save)',
    host: ['skill', 'tui', 'mcp'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'ops-ui',
  },
  // ── H5 Phase 2 · embodied-agent TTY observability ───────────────
  // Three tools operate over the in-memory ring buffer populated by
  // SnapshotPtyState captures. Require H5 P2 bootstrap wiring to be
  // active (dashboard calls `initTtySnapshotTools(lookup)` at startup).
  {
    id: 'snapshot_pty_state',
    kind: 'other',
    aliases: ['SnapshotPtyState', 'snapshot_pty_state'],
    displayName: 'SnapshotPtyState',
    description: 'Capture the current PTY screen of an embodied agent session (by session_id or pane_id) into the in-memory snapshot ring. Returns a snapshot id for later List/Compare calls.',
    promptSummary: '`SnapshotPtyState` (capture PTY screen to ring buffer for later diff)',
    host: ['skill'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'capture',
    minTier: 'T2',
  },
  {
    id: 'list_pty_snapshots',
    kind: 'other',
    aliases: ['ListPtySnapshots', 'list_pty_snapshots'],
    displayName: 'ListPtySnapshots',
    description: 'List recent PTY snapshots for an embodied agent session, newest first. Pair with SnapshotPtyState and ComparePtySnapshots for before/after analysis.',
    promptSummary: '`ListPtySnapshots` (list recent PTY snapshots for a session)',
    host: ['skill'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'capture',
    minTier: 'T2',
  },
  {
    id: 'compare_pty_snapshots',
    kind: 'other',
    aliases: ['ComparePtySnapshots', 'compare_pty_snapshots'],
    displayName: 'ComparePtySnapshots',
    description: 'Line-diff two PTY snapshots by id. Returns {added, removed, sameLines}. Use to answer "what changed between capture A and B?" over an embodied PTY session.',
    promptSummary: '`ComparePtySnapshots` (line-diff two PTY snapshots)',
    host: ['skill'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'capture',
    minTier: 'T2',
  },
  // ── H5 Phase 3 · cross-agent handoff ────────────────────────────
  // Snapshot-based context transfer from one embodied agent to a
  // new one (possibly of a different brand). Requires H5 P3
  // bootstrap wiring (`initAgentHandoffTool(lookup)`).
  {
    id: 'agent_handoff',
    kind: 'delegate',
    aliases: ['AgentHandoff', 'agent_handoff'],
    displayName: 'AgentHandoff',
    description: 'Hand off context from one embodied agent session to a new one, possibly of a different brand (codex → claude, claude → gemini, etc). Source session keeps running; target is launched with the source\'s snapshot (optionally filtered by channel tags like "reasoning" / "plan") as its initial prompt. Returns the new session id and records a handoff edge in the agent graph.',
    promptSummary: '`AgentHandoff` (snapshot → new agent prompt · cross-brand context transfer)',
    host: ['skill'],
    safety: ['agent', 'process'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'ops-fleet',
    minTier: 'T2',
  },
  // ── H6 P1 · Multi-agent budget tracker ──────────────────────────
  // Four LLM tools backed by src/budget/* + src/skill-tool-budget.ts.
  // Read-only except BudgetSetLimit (writes user-config JSON).
  // T1 gate — every routing-aware agent benefits from budget visibility.
  {
    id: 'budget_status',
    kind: 'other',
    alwaysLoad: false,
    shouldDefer: true,
    aliases: ['BudgetStatus', 'budget_status'],
    displayName: 'BudgetStatus',
    description: 'Current per-brand/per-window usage snapshot from the local elanous budget tracker. Cheap read (in-process store); pass `refresh: true` to force a fresh fetch across registered providers (~1-3s).',
    promptSummary: '`BudgetStatus` (local cumulative usage per brand × window; refresh=true for live fetch)',
    host: ['skill', 'tui'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'ops-fleet',
    minTier: 'T1',
  },
  {
    id: 'budget_history',
    kind: 'other',
    alwaysLoad: false,
    shouldDefer: true,
    aliases: ['BudgetHistory', 'budget_history'],
    displayName: 'BudgetHistory',
    description: 'Daily-rolled-up token/cost history for one brand over the last `days` days (default 7, max 56). Sourced from the SQLite turn_log populated by the log-scan recorder.',
    promptSummary: '`BudgetHistory` (per-day token rollup from the local budget history store)',
    host: ['skill', 'tui'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'ops-fleet',
    minTier: 'T1',
  },
  {
    id: 'budget_forecast',
    kind: 'other',
    alwaysLoad: false,
    shouldDefer: true,
    aliases: ['BudgetForecast', 'budget_forecast'],
    displayName: 'BudgetForecast',
    description: 'Pace-based projection for each active window: currentUsedPercent · expectedUsedPercent · ETA to 100% · recommendation (safe <80% / warn 80-95% / throttle ≥95%).',
    promptSummary: '`BudgetForecast` (current pace → ETA + safe/warn/throttle recommendation)',
    host: ['skill', 'tui'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'ops-fleet',
    minTier: 'T1',
  },
  // ── H6 P3 · Budget-aware policy router (Bundle 1 · recommend-only) ──
  // Two read tools: PolicyDecide (decision + alternatives) · PolicyExplain
  // (step-by-step trace). Decision is advisory · callers may still ignore.
  // T1 gate so every agent can benefit from budget-aware routing hints.
  // Named `Policy*` to avoid collision with PFC-S5 `RouteToModel`
  // (`src/intelligence-map/tools/route-to-model.ts`), which is a
  // catalog-driven cost recommender — different schema, different purpose.
  {
    id: 'policy_decide',
    kind: 'other',
    alwaysLoad: false,
    shouldDefer: true,
    aliases: ['PolicyDecide', 'policy_decide'],
    displayName: 'PolicyDecide',
    description: 'Ask the H6 P3 policy router which (brand, model) fits a task. Returns a decision + alternatives + reason chain produced by the budget-aware rule pipeline (session-lock · per-turn · budget-throttle HITL · budget-warn redirect · capability-filter · persistent-default · cloud-first). `requiresConfirmation: true` means the caller MUST gate launch on user approval (budget throttle ≥95%). Bundle 1 is recommend-only; callers decide whether to honor the suggestion. Distinct from `RouteToModel` (PFC-S5 intelligence-map cost recommender) — prefer this when you need budget-window + override-aware routing.',
    promptSummary: '`PolicyDecide` (budget + capability + override aware brand/model pick · v1 recommend-only)',
    host: ['skill', 'tui'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'ops-fleet',
    minTier: 'T1',
  },
  {
    id: 'policy_explain',
    kind: 'other',
    alwaysLoad: false,
    shouldDefer: true,
    aliases: ['PolicyExplain', 'policy_explain'],
    displayName: 'PolicyExplain',
    description: 'Return the step-by-step rule trace of the last (or a fresh) PolicyDecide decision. Every rule that ran + its result (prefer / filter / flag-confirm / pass / reject-all) + reason, so the LLM and the user can see why a brand was picked.',
    promptSummary: '`PolicyExplain` (rule-by-rule trace of the latest policy-router decision)',
    host: ['skill', 'tui'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'ops-fleet',
    minTier: 'T1',
  },
  {
    id: 'budget_set_limit',
    kind: 'other',
    alwaysLoad: false,
    shouldDefer: true,
    aliases: ['BudgetSetLimit', 'budget_set_limit'],
    displayName: 'BudgetSetLimit',
    description: 'Write a user-config limit for (brand, window, model?). Quota in percent (0-100) or Infinity for unlimited. Persists to ~/.config/elanous/budget/limits.json; effective limit resolution = user-config → brand-default.',
    promptSummary: '`BudgetSetLimit` (persist a user quota override for brand × window × model)',
    host: ['skill', 'tui'],
    safety: ['mutating'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'ops-fleet',
    minTier: 'T1',
  },
  // ── H6 P4 · VW Agent Room (Bundle 1 · slash + LLM tool) ──
  // Three tools: Compose (build room · spawns N agents · layout)  ·
  // List (read-only snapshot) · Close (dispose · idempotent). Compose
  // output embeds a `budgetAdvisory` — warn threshold 70% · caller
  // should AskUserQuestion before proceeding when warning is set.
  // T2 gate: N-agent concurrent spawn is non-trivial resource.
  {
    id: 'agent_room_compose',
    kind: 'other',
    alwaysLoad: false,
    shouldDefer: true,
    aliases: ['AgentRoomCompose', 'agent_room_compose'],
    displayName: 'AgentRoomCompose',
    description: 'Create a VW agent room with N panes (preset = two-split/three-split/four-quad), each running a different brand agent. Members[i].brandRef: literal brand (codex/claude/gemini/elanous), alias (cxn/cas/clc/gem/mac), "lll:<model>" (H6 P2 local-llm), or "auto" (policy router). Output metadata includes `budgetAdvisory` — surface `warning` via AskUserQuestion when present (session usage ≥70% and N-agent turn cost ~Nx).',
    promptSummary: '`AgentRoomCompose` (multi-agent VW room · N-pane layout · auto-routing)',
    host: ['skill', 'tui'],
    safety: ['mutating'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'ops-fleet',
    minTier: 'T2',
  },
  {
    id: 'agent_room_list',
    kind: 'other',
    alwaysLoad: false,
    shouldDefer: true,
    aliases: ['AgentRoomList', 'agent_room_list'],
    displayName: 'AgentRoomList',
    description: 'List live agent rooms with their member sessions. Read-only. Use before AgentRoomClose to discover room ids.',
    promptSummary: '`AgentRoomList` (enumerate live multi-agent VW rooms)',
    host: ['skill', 'tui'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'ops-fleet',
    minTier: 'T1',
  },
  {
    id: 'agent_room_close',
    kind: 'other',
    alwaysLoad: false,
    shouldDefer: true,
    aliases: ['AgentRoomClose', 'agent_room_close'],
    displayName: 'AgentRoomClose',
    description: 'Close an agent room — dispose all member agents and close the VW. Idempotent: second call on the same id returns `closed: false` without error.',
    promptSummary: '`AgentRoomClose` (dispose an agent room + all member sessions)',
    host: ['skill', 'tui'],
    safety: ['mutating'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'ops-fleet',
    minTier: 'T2',
  },
  // ── H6 P5 · AgentReply (Bundle 1) ──
  // Complements AgentHandoff: talks to an ALREADY-LIVE session and
  // captures the reply. Timeouts return partial content + warning
  // (NOT an error). Cycle depth cap = 8 via inbound 'reply' edges.
  {
    id: 'agent_reply',
    kind: 'delegate',
    alwaysLoad: false,
    shouldDefer: true,
    aliases: ['AgentReply', 'agent_reply'],
    displayName: 'AgentReply',
    description: 'Send a message to a live embodied session (identify via AgentRoomList or /acp-vw output) and capture the reply. Complements AgentHandoff (new-session launcher). Blocks until the target idles (`idleMs`, default 2000) or `timeoutMs` (default 30000) fires — timeouts are NOT errors · `warnings: ["timeout-truncated"]` returns partial content. Default channel filter = ["message"] · pass empty array for all channels. Cycle depth cap = 8 across inbound reply edges prevents runaway loops.',
    promptSummary: '`AgentReply` (send + capture message to a live embodied session · cycle-depth-capped)',
    host: ['skill', 'tui'],
    safety: ['mutating'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'ops-fleet',
    minTier: 'T2',
  },
  // ── H6 P6 · Capture source registry (Bundle 1) ──
  // Thin discovery + dispatch layer over existing capture (Screenshot /
  // SnapshotPtyState / browser-cdp). List enumerates 3 source types ·
  // Snapshot dispatches to the right provider by `<type>:<native>` id.
  {
    id: 'list_capture_sources',
    kind: 'other',
    alwaysLoad: false,
    shouldDefer: true,
    aliases: ['ListCaptureSources', 'list_capture_sources'],
    displayName: 'ListCaptureSources',
    description: 'Enumerate every capture source currently observable (VW panes · live agent sessions · browser CDP pages). Use FIRST to discover valid `sourceId`s before calling SnapshotSource. Returns `{id, type, label, summary, formats}` descriptors + `countByType` aggregate. Read-only · safe to call repeatedly · supports parallel.',
    promptSummary: '`ListCaptureSources` (discover VW pane / agent session / browser CDP source ids)',
    host: ['skill', 'tui'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'capture',
    minTier: 'T1',
  },
  {
    id: 'snapshot_source',
    kind: 'other',
    alwaysLoad: false,
    shouldDefer: true,
    aliases: ['SnapshotSource', 'snapshot_source'],
    displayName: 'SnapshotSource',
    description: 'Capture a specific source (discovered via ListCaptureSources) as text/ansi/png/svg/asciicast. `sourceId` format = `<type>:<native>`. Warnings surface non-fatal degradations (`observer-missing` · `source-empty` · `historical-not-supported`). Read-only · supports parallel calls on different ids.',
    promptSummary: '`SnapshotSource` (snapshot a discovered source · text/ansi/png/...)',
    host: ['skill', 'tui'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'capture',
    minTier: 'T1',
  },
  // ── H6 P2 · Local LLM Manager (Bundle 1) ──
  // Read-only inventory over the Tailscale fleet: which nodes are
  // reachable, which runtimes (Bundle 1 = LM Studio only), which
  // models are on each node. Consumers use the model spec
  // `local-llm:<nodeId>:<modelId>` to route outer-LLM turns.
  {
    id: 'llm_list_nodes',
    kind: 'other',
    alwaysLoad: false,
    shouldDefer: true,
    aliases: ['LlmListNodes', 'llm_list_nodes'],
    displayName: 'LlmListNodes',
    description: 'Enumerate local-LLM nodes in the Tailscale fleet (elanous host + ssh-configured peers) with per-node reachability + installed runtimes (Bundle 1 = LM Studio only). Read-only · 5 min staleness cache · pass `refresh:true` to force a probe. Use FIRST before LlmListAvailableModels or local-llm:<node>:<model> routing.',
    promptSummary: '`LlmListNodes` (Tailscale fleet · LM Studio reachability)',
    host: ['skill', 'tui'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'ops-fleet',
    minTier: 'T1',
  },
  {
    id: 'llm_list_available_models',
    kind: 'other',
    alwaysLoad: false,
    shouldDefer: true,
    aliases: ['LlmListAvailableModels', 'llm_list_available_models'],
    displayName: 'LlmListAvailableModels',
    description: 'List model weights discoverable on local-LLM nodes (Bundle 1 = LM Studio · Bundle 2 C1 = + Ollama). Returns `{id, nodeId, runtime, label, sizeBytes?, format?, loaded?}`. Pass `{id}` as the model spec `local-llm:<nodeId>:<id>` to streamLLM / elanous outer LLM. Optional `node` filter. Read-only · 5 min cache.',
    promptSummary: '`LlmListAvailableModels` (discover model weights per node)',
    host: ['skill', 'tui'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
    intentScope: 'ops-fleet',
    minTier: 'T1',
  },
  // ── H6 P2 · Local LLM install (Bundle 2 B) ──
  // Single T2 mutating tool · HITL-gated download via `lms get` or
  // `ollama pull`. Disk precheck when `estimatedSizeBytes` is provided.
  // Boot/shutdown are NOT separate tools (PLAN D24) — chat/run auto-load
  // and PTY dispose cover the lifecycle.
  {
    id: 'llm_request_install',
    kind: 'other',
    alwaysLoad: false,
    shouldDefer: true,
    aliases: ['LlmRequestInstall', 'llm_request_install'],
    displayName: 'LlmRequestInstall',
    description: 'Download a local LLM model onto a node (LM Studio via `lms get` · Ollama via `ollama pull`). Blocks behind a HITL confirmation (Telegram/Discord/Pushcut/terminal race) + optional disk-space precheck. Args `{nodeId, runtime, modelName, estimatedSizeBytes?}`. On success, manager inventory auto-refreshes. Typical install 5–30 min; default timeout 30 min. Surface the returned metadata to show progress + outcome.',
    promptSummary: '`LlmRequestInstall` (HITL-gated model download · lms get / ollama pull)',
    host: ['skill', 'tui'],
    safety: ['mutating', 'process', 'network'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'ops-fleet',
    minTier: 'T2',
  },
  // ── H6 P7 · InjectCaptureToContext (Bundle 1) ──
  // Consumes the P6 registry on the source side and findLiveSessionById
  // on the target side. Every call goes through a HITL binary approver
  // (requestConfirmation: Telegram/Discord/Pushcut/terminal race). Non-
  // revocable v1 — once approved + sent, bytes are in the target PTY
  // buffer. Approver denial/timeout is NOT an error (informational).
  {
    id: 'inject_capture_to_context',
    kind: 'other',
    alwaysLoad: false,
    shouldDefer: true,
    aliases: ['InjectCaptureToContext', 'inject_capture_to_context'],
    displayName: 'InjectCaptureToContext',
    description: 'Inject a capture-source snapshot (from H6 P6 ListCaptureSources) into a live embodied session\'s next prompt. `as` mode wraps the body: `user-message` (raw) · `system-note` ([Context]…[/Context]) · `attached-block` (XML-ish · recommended default). Every call goes through a HITL binary approver; denial/timeout returns `warnings: ["approver-denied"|"approver-timeout"]` WITHOUT `isError` so the LLM can adapt. System errors (source-missing/target-missing/target-dead/send-failed) DO set `isError`. Non-revocable v1 — once sent, bytes are in the target PTY buffer. Every attempt logged to control-audit with `action: "capture_inject"`.',
    promptSummary: '`InjectCaptureToContext` (HITL-gated · snapshot → target.send() with 3 wrapping modes)',
    host: ['skill', 'tui'],
    safety: ['mutating'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'capture',
    minTier: 'T2',
  },
  // ── Showroom v2 · LaneHandoff ──
  // Cross-lane handoff inside the most recent showroom — wraps the
  // /handoff slash, reuses HITL approver and audit pipeline, adds
  // lane-aware audit detail (fromLane/toLane/role/brand). Targets
  // ACP and PTY transports identically (D6 widening · 2026-04-28).
  {
    id: 'lane_handoff',
    kind: 'other',
    alwaysLoad: false,
    shouldDefer: true,
    aliases: ['LaneHandoff', 'lane_handoff'],
    displayName: 'LaneHandoff',
    description: 'Handoff context from one showroom lane to another (cross-LLM relay). Targets the most recently-spawned `/showroom` room; pass `roomId` to override. `fromLane` / `toLane` accept pane index (0-based int), role hint (plan/build/exec/review/reflect), or brand name (claude/codex/gemini/elanous/local-llm/alias). HITL binary approver gates every call · denial/timeout returns ok=false WITHOUT `isError`. System errors (no live room, target-dead) DO set `isError`. `reason` recorded in audit detail.',
    promptSummary: '`LaneHandoff` (HITL-gated · cross-lane context relay inside /showroom rooms)',
    host: ['skill', 'tui'],
    safety: ['mutating'],
    supportsParallel: false,
    defaultEnabled: true,
    intentScope: 'capture',
    minTier: 'T2',
  },
];

// Register every native-tool entry in the global ElementRegistry so
// `tool:<id>` addresses resolve uniformly (Phase A — LLM may later
// flip `defaultEnabled` via control.tool.toggle). The handle carries
// only kind+id; the catalog entry remains the source of truth for
// metadata.
//
// Performed in module-eval so any importer sees tool addresses; the
// dynamic-import guard skips wiring when the element-registry module
// isn't ready yet (e.g. bundling tests), preserving catalog usability.
(() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const erm = require('./element-registry/index.js');
    const reg = erm.getGlobalElementRegistry();
    for (const tool of nativeToolCatalog) {
      reg.register('tool', tool.id, { kind: 'tool', id: tool.id });
      erm.publishElementEvent?.('tool', tool.id, 'create', {
        host: tool.host,
        safety: tool.safety,
      });
    }
  } catch {
    // element-registry not available in this bundle; catalog still works.
  }
})();

/** Whether a catalog entry may be included in an essential model profile.
 *  Deferred tools remain eligible because tier-flip owns their later schema split;
 *  only an explicitly disabled, non-deferred, non-searchable front door is hidden. */
export function isNativeToolModelExposed(entry: NativeToolCatalogEntry): boolean {
  return entry.defaultEnabled
    && !(entry.alwaysLoad === false && entry.shouldDefer === false && entry.toolSearchable === false);
}

export function listNativeToolsForHost(host: NativeToolHost): NativeToolCatalogEntry[] {
  return nativeToolCatalog.filter(tool => tool.defaultEnabled && (tool.host.includes('all') || tool.host.includes(host)));
}

export function findNativeTool(nameOrAlias: string): NativeToolCatalogEntry | undefined {
  return nativeToolCatalog.find(tool => tool.id === nameOrAlias || tool.aliases.includes(nameOrAlias));
}

export function listNativeToolDisplayNamesByKind(
  catalog: readonly NativeToolCatalogEntry[],
): Partial<Record<Exclude<NativeToolKind, 'other'>, string[]>> {
  const namesByKind: Partial<Record<Exclude<NativeToolKind, 'other'>, string[]>> = {};
  for (const tool of catalog) {
    if (tool.kind === 'other') continue;
    (namesByKind[tool.kind] ??= []).push(tool.displayName);
  }
  return namesByKind;
}

export function buildNativeToolPromptSummary(
  host: NativeToolHost,
  /** P5: gate-filtered catalog override. When supplied, the summary is
   *  built from this list instead of the default surface lookup — lets
   *  probe failures and hint overrides actually change what the LLM
   *  sees listed. When omitted, falls back to the surface-default list
   *  (legacy behavior; no breaking change). */
  catalog?: NativeToolCatalogEntry[],
): string {
  const source = catalog ?? listNativeToolsForHost(host);
  return source.map(tool => tool.promptSummary).join(', ');
}


