// Dashboard slash command handlers · migrated cases from the inline
// switch in dashboard/index.ts. Sub-phase tracking:
//
//   B-3.c.2       — /term /terminal — second half of the third B-3
//                   cluster. The biggest single case (681 LOC inline ·
//                   23 subcommands across 6 host-local subsystems —
//                   sessionRegistry · terminalMatrix · vwRegistry ·
//                   broadcastBus · channelBus + session-picker modal
//                   lifecycle). All 6 subsystems threaded as opaque
//                   structural types under `termSlash` ctx bundle.
//                   Modal lifecycle (createSessionPickerModal +
//                   attachSurfaceToWorkspace + display.pushModal +
//                   agentSearchModal/Handle mutation) wrapped behind
//                   one `openSessionPicker()` ctx method — handler
//                   doesn't see the modal plumbing. The inline
//                   `openSession` closure (terminalModalRouter.set +
//                   detach-on-close + draw) wrapped behind ctx
//                   `openSession(session)`.
//                   Static-imported in this module:
//                   resolveTerminalMoveDestination from
//                   '../../terminal-matrix/mobility.js' ·
//                   loadPersistedSessions from
//                   '../../terminal/session-persistence.js' ·
//                   dispatchTerminalModalObserve from
//                   '../../skills/tools/terminal-modal.js' (the same
//                   capture path the LLM-side TerminalModalObserve
//                   tool uses · /term snapshot delegates to it).
//                   slashRuntime type imported as
//                   `DashboardTermSlashRuntime` (factory output type)
//                   to avoid duplicating ~40 line-formatter signatures.
//   B-3.c.1       — /local /ll · /shell /sh — first half of the third
//                   B-3 cluster (term/shell/local · 922 LOC). Per
//                   HANDOFF risk note "/term at 644 LOC may warrant
//                   its own PR" — split the cluster: /local + /shell
//                   first (278 LOC · medium-tier-sized), /term in a
//                   B-3.c.2 follow-up (644 LOC · 6+ host-local
//                   subsystems · sessionRegistry · terminalMatrix ·
//                   broadcastBus · channelBus · createSessionPicker
//                   Modal · agentSearchModal mutation).
//                   /local has no ctx bundle — all deps are static-
//                   importable (resolveLocalEndpoints + runLocalLLM
//                   Compat hoisted from dynamic to static) plus
//                   existing chatLines / chatScrollOffset / config
//                   helpers. /shell adds a `shellSlash` ctx bundle
//                   for shellSlashRuntime line formatters +
//                   openRollupPopup + 2 vw-registry helpers
//                   (switchTo + resolveVwIdByLabel · used by attach
//                   routing). getShellRegistry +
//                   renderHandleStatusChip + decideAttach hoisted
//                   to static imports.
//   B-3.b         — /session /sess · /telegram /tg — second B-3 cluster
//                   (handoff/transport — 616 LOC). Both cases share
//                   host-local binding state (attachedSessionId +
//                   attachedChatId), so getter/setter pairs sit at the
//                   top level (not inside a per-case bundle). /session
//                   gets a `sessionSlash` bundle for daemon-attach
//                   config + ACP swap; /telegram has no extra ctx
//                   bundle (uses top-level + static-imported helpers).
//                   Static-imported helpers: 9 from session/index.js
//                   (listSessions / resolveSessionId / historyFromSession
//                   / detachTelegramBinding / setActiveSessionId /
//                   createSession / appendMessage / attachTelegramBinding
//                   / listBoundSessions) · 2 from telegram-lock.js
//                   (safeReadLock + defaultLockPath) · userConfigPath
//                   from user-config.js · dirname from node:path ·
//                   renderReplayPreviewLines from ../replay-preview.js ·
//                   3 from ../acp-boot.js (deriveDaemonHttpBase +
//                   fetchDaemonSessionList + fetchDaemonSessionHistory).
//                   TelegramBot loaded via dynamic import (only needed
//                   for send + attach-nudge paths). Top-level
//                   `subtext` color func added to ctx (used by /session
//                   list daemon-row label + binding tag).
//   B-3.a         — /log · /debug · /prompt /prompts — opens Phase B-3
//                   (big-tier · 4 dep-clusters per HANDOFF). 3 ctx
//                   bundles introduced (logSlash + debugSlash +
//                   promptSlash) since each case touches a distinct
//                   showDashboard-local domain (log-pane state vs
//                   debug-log buffer + window/workbench/companion
//                   handles vs prompt-bank store + DetailViewer).
//                   Static-imported helpers: resolveDashboardChatMain
//                   LogCommand + dashboardLogHelpLines + the four
//                   resolveDashboardLog*Action fns + stripAnsi (for
//                   /log) · debug + resolveDebugCompanionTargets (for
//                   /debug) · getPromptBankStore + buildPromptInjection
//                   + inspectActiveProvider (for /prompt). The four
//                   prompt-runtime closures (promptRuntimeState +
//                   setPromptBankRuntimeConfig + describePromptBank
//                   RuntimeConfig + parseOnOffArg) close over showDash
//                   board-local refs so they thread through ctx.
//   B-1.a (#1452) — registry shape + 3 pilot cases (quit · clear · help)
//   B-1.b (#1455) — 6 tiny standalone cases (fork · ctoggle · dashboard ·
//                   sync · voice-chat · skill-reload)
//   B-1.c         — 8 small standalone cases (cache · attach-pin · attach-
//                   unpin · attach-clear · rebind · perf · pty-list/ptys ·
//                   sweep-tool-results)
//   B-1.d         — 9 deferred skill-tool slashes that share an identical
//                   fire-and-forget dynamic-import shape (budget/b · route
//                   · agent-room · showroom · lane · relay · reply ·
//                   capture · inject · llm). Migrated through a shared
//                   `runDeferredSkillToolSlash` helper to keep net code
//                   add minimal at this tier.
//   B-1.e         — 4 tiny standalone toggles / state-mutation cases
//                   (pause · chat · qc · auto-tts/autotts/tts). Mixed dep
//                   patterns: static import (armSessionQuickControl ·
//                   handleAutoTtsSlash) · dynamic import (turn-checkpoint
//                   for /pause) · context threading (autoTtsRef).
//   B-1.f         — 3 companion-popup cases (clipboard/clip/cb · memo/
//                   note/me · detail/report/dv). All share the
//                   companionPopupHost + companionSlashRuntime deps.
//                   Bundled into a single `companion` ctx field instead
//                   of 15 separate fields to keep the ctx surface lean.
//   B-1.g         — 3 sub-runtime delegation cases (signals/signal ·
//                   browser-cdp/bcdp · widget/widgets/w). Each case
//                   delegates sub-command branches to a slash-runtime
//                   factory output (controlSignal · browserCdp ·
//                   widgetHost). The runtimes are showDashboard-local,
//                   so they're threaded via ctx as opaque shapes.
//   B-2.z         — /setup — onboarding wizard launcher (inline /
//                   popup / reset / help). resolveDashboardChatMain
//                   SetupCommand + dashboardSetupHelpLines +
//                   DASHBOARD_SETUP_STEPS + resetOnboardingMarker
//                   are all pure module-level static imports.
//                   Threads `setup` ctx with two thin host actions:
//                   `launchPopup(cmd)` (TerminalPopup.shell) and
//                   `openInlineFlow(target)` (createDashboardInline
//                   SetupFlow + many display deps).
//   B-2.y         — /plugin · /plugins — pluginHost lifecycle (list /
//                   activate / deactivate / reload). Threads `plugin`
//                   ctx bundle. The original case had a `/p` alias
//                   that collided with /provider's `/p` (B-2.s);
//                   /provider claimed /p via earlier registry
//                   registration, leaving plugin's /p dead. Dropped
//                   here as the collision is now permanent.
//                   Special case: `activate sync` calls enterSyncMode
//                   and exits the input loop — modeled with
//                   setExitInputLoop(true).
//   B-2.x         — /skill-triggers · /triggers + /run-skill · /rs ·
//                   /run — bundled skill-router slashes. listSkillNames,
//                   describeSkill, getSkillIndex are static-imported.
//                   `runSkillByName` is showDashboard-local; threaded
//                   via `skill` ctx bundle (also holds the two
//                   slashRuntime line helpers).
//   B-2.w         — /conv — embodied-conversation popup mgmt (list /
//                   layout / focus / open). Four host-local actions
//                   (listLiveSessions, setLayoutMode, focusPopup,
//                   openModal) threaded via `conv` ctx bundle.
//   B-2.u         — /git — read-only inspection (status / branch /
//                   log / diff / remote). All deps are pure module-
//                   level helpers (getSessionCwd · getGitStatusView ·
//                   refreshGitDirty · listBranches) — static-imported
//                   in this module. spawnSync loaded inline via
//                   dynamic import. **No new ctx field.**
//   B-2.t         — /compact — summarise + reset chat.history. The
//                   compact/* helpers and renderCompactBoundary are
//                   dynamic-imported in the handler body. The chat
//                   history is host-local mutable state; threaded
//                   via `compact` ctx as a getter that returns the
//                   mutable array (so the handler can call .length=0
//                   and push system + tail back).
//   B-2.s         — /provider · /p — provider rotation list / next /
//                   use / reset. rotation helpers + listProviders are
//                   pure module-level static imports. Threads `provider`
//                   ctx (just the slashRuntime line helpers).
//   B-2.r         — /theme — preset list / switch / use / reset /
//                   preview / export. Theme helpers static-imported
//                   (resolveDashboardChatMainThemeCommand,
//                   DEFAULT_THEME_TOKENS, listThemes, getTheme,
//                   setActivePresetInConfig). Plugin theme
//                   contributions + currentThemeTokens snapshot +
//                   requestDashboardRender threaded via `theme` ctx.
//   B-2.q         — /sim · /simulator — declarative simulation cockpit
//                   (open / web / list / run). simSlashRuntime line
//                   helpers + host-local actions (openWebCockpit,
//                   listScenarios, runById, resolveAlias)
//                   threaded via `sim` ctx bundle.
//   B-2.o         — /intake — intake-plane review picker / modal /
//                   refresh fire-and-forget. Many host-local deps
//                   (display coordinator, theme tokens, workspace
//                   owner, scratch snapshot reader, dynamic intake
//                   imports) all wrapped behind one ctx method
//                   `intake.runSlash(args)`.
//   B-2.n         — /turn-slider · /turnslider · /tslider — text-mode
//                   UndoTurn time-travel slider. Reuses the `undo`
//                   ctx bundle from B-2.g (refreshGitDirty + bold);
//                   no new ctx field needed. undo-turn helpers loaded
//                   via dynamic import.
//   B-2.m         — /claude · /codex · /gemini — agent-CLI launchers.
//                   Three names share the same body but differ in the
//                   `brand` arg passed to TerminalPopup.agent(...). The
//                   registry doesn't carry the matched name to the
//                   handler, so we register each name separately and
//                   pass the brand literal at registration time.
//                   Threads new `agentLauncher` ctx (1 method).
//   B-2.l         — /agents · /agent · /ag — agents companion / view
//                   open + popup management. agentsSlashRuntime line
//                   helpers + showDashboard-local view registry +
//                   companionPopupHost (already used by B-1.f) +
//                   `agentsViewDismissed` mutable state. Threads new
//                   `agents` ctx bundle separately from `companion`
//                   because the view-registry side is /agents-only.
//   B-2.k         — /tablet — manual override + status reporter for
//                   tablet (compact-tight) mode. Reads viewport
//                   compact level / product compact mode + the
//                   `tabletModeManual` mutable host state; flips it
//                   via setter; on `browser-preview` opens the modal
//                   and exits the input loop. Threads `tablet` ctx
//                   bundle (4 methods).
//   B-2.j         — /playground — declarative scenario harness for
//                   widget/dialog/picker/theme stress tests. The
//                   command handler factory + harness factory have
//                   many host-local dependencies (display coordinator,
//                   context key service, scenario editor opener);
//                   wrapped behind a single `playground.runCommand`
//                   ctx method that returns the captured output lines.
//   B-2.i         — /delta · /diffs — source-delta browser popup.
//                   Reuses dashboardDeltaHelpLines + resolveDashboard
//                   ChatMainDeltaCommand from chat-main-delta-command
//                   (now static-imported here too). The popup opener
//                   itself (`openSourceDeltaBrowserPopup`) is show
//                   Dashboard-local; threaded as `delta.openBrowser
//                   Popup`. Sets exitInputLoop on a successful open.
//   B-2.g         — /undo — snapshot ring restore/list/clear/toggle.
//                   undo-turn helpers loaded via dynamic import. The
//                   only host-local dep is `refreshGitDirty` over the
//                   session cwd, wrapped behind a single ctx method.
//                   Threads new `undo` ctx bundle (1 method).
//   B-2.e         — /history · /hist · /inputs — input history viewer
//                   (list / find / show / clear / path).
//                   Threads new `inputHistory` ctx bundle.
//   B-2.d         — /api-allow · /api — host allowlist mgmt for api_call.
//                   Static-imports addAllowed/removeAllowed/listAllowed/
//                   hostOf/rateLimitStatus from tool-hints/api-allowlist.
//   B-2.c         — 3 cases · /resume + /research + /branch:
//                     /resume + /research share `inputSeed` ctx (prefill
//                       editor with checkpoint or research output)
//                     /branch — git worktree mgmt · dynamic imports only
//   B-2.b         — 2 dynamic-import-only cases (no new ctx):
//                     /plan — plan-mode start/done/show/status
//                     /code-edit · /ce — code-edit policy mgmt
//   B-2.a         — first medium-tier round (40-50 LOC bodies):
//                     /audit — control-audit-log tail viewer (input or all)
//                     /substrate-stats · /sst — paint-cache + overlay +
//                                f8-shadow + generation-bump telemetry.
//                                Threads `substrateStats` ctx field.
//                     /wd — session working directory get/set/reset.
//                                Dynamic-imports session/working-dir
//                                helpers; no new ctx field.
//   B-1.i         — 2 cases:
//                     /handoff — agent handoff dispatch (fire-and-forget
//                                async dispatch with arg parsing)
//                     /reasoning · /r · /think — provider reasoning level
//                                cycler. Static-imports REASONING_CYCLE
//                                etc. from llm; threads
//                                refreshReasoningHudSegment via ctx.
//   B-1.h         — 5 session/context cases:
//                     /control · /dm · /default — chat-mode posture toggle
//                     /surface — preferred input-mode surface picker
//                     /preview · /pv — docked preview source/binding
//                     /context · /ctx — attachment registry mgmt
//                     /paste — clipboard image attach (note: /paste's `v`
//                              alias was dead in the original switch
//                              because /view's `v` matched first; dropped)
//                   Pre-existing typo at original line 18990 fixed
//                   (`cmd` → `cmdLower` semantics) by using the matched
//                   command name passed via the registry.
//
// `DashboardSlashContext` grows linearly as cases migrate. Each handler
// only references the fields it needs; the dashboard side wires every
// field at the dispatch call site so closures stay live.
//
// Return type is the string literal `'quit'` (matches DashboardAction in
// `../index.ts`) instead of importing the type — keeps this module free
// of circular dependency on dashboard/index.ts.

import { renderTuiNow, tuiNowSlash } from '../../context-bus/context-now-surfaces.js';
import { contextNowInWorker } from '../../context-bus/context-now.js';
import { handleTuiChatPersona, type TuiChatPersonaSelection } from './chat-persona.js';
import { createWishCard } from '../../intake-plane/wish-card.js';
import { CardStore } from '../../task-cards/card-store.js';
import type { ContextNowDeps } from '../../context-bus/context-now.js';
import { runRebindCommand } from '../../input-core/index.js';
// B4 (TUI half) — /design reuses the CLI's own resolution so the three
// surfaces (CLI, PWA panel, this) cannot answer differently.
import { resolveRepositoryDesignCheck } from '../../cli/repo-cli.js';
import { renderDesignCheckLines, type DesignCheckTone } from '../../design/design-check-render.js';
import { handleDesignPick } from './design-pick.js';
import { createDecideSlashHandler } from './decide-slash.js';
import { startSeatBootConversation } from '../seat-boot-preamble.js';
import { markSeatConversationStarted, recordSeatSessionEnd } from '../seat-local-instructions.js';
import type { DecisionLedger } from '../../decisions/decision-ledger.js';
import { listDesignDirections, parseDeclaredDirection } from '../../design/design-directions.js';
import {
  dashboardDeltaHelpLines,
  resolveDashboardChatMainDeltaCommand,
} from '../input/chat-main-delta-command.js';
import { resolveDashboardChatMainThemeCommand } from '../input/chat-main-theme-command.js';
import {
  DASHBOARD_SETUP_STEPS,
  dashboardSetupHelpLines,
  resolveDashboardChatMainSetupCommand,
} from '../input/chat-main-setup-command.js';
import { resetOnboardingMarker } from '../../onboarding.js';
import { DEFAULT_THEME_TOKENS } from '../../theme/tokens.js';
import { setActivePresetInConfig } from '../render/theme-resolver.js';
import { getTheme, listThemes } from '../../themes/index.js';
import {
  getUserConfig, reloadUserConfig, saveUserConfig,
  rotateNextProvider, jumpToRotationEntry, rotationEntryLabel,
  currentRotationIndex,
} from '../../user-config.js';
import { listProviders } from '../../llm.js';
import { enabledModels, loadCatalog } from '../../intelligence-map/model-catalog.js';
import { selfOrchestrateRuntime } from '../../self-dev/self-orchestrate-runtime.js';
import type { ToolRuntime } from '../../tool-runtime/types.js';
import { getSessionCwd } from '../../session/working-dir.js';
import { listSkillNames, describeSkill } from '../../skills/runner.js';
import {
  REASONING_CYCLE,
  effectiveReasoningLevel,
  nextReasoningLevel,
  reasoningLevelLabel,
} from '../../llm.js';
import type { ReasoningLevel } from '../../user-config.js';
import {
  armSessionQuickControl,
  enterSessionControlMode,
  exitSessionControlMode,
  isSessionControlActive,
  parseSessionControlSlash,
  parseSessionSurfaceSlash,
  resolveSessionSurfaceStatus,
  setSessionPreferredSurface,
  buildSessionSurfaceStatusLines,
} from '../../session-runtime/index.js';
import { handleAutoTtsSlash } from '../auto-tts/auto-tts-host-boot.js';
import { defaultControlSignalObserver } from '../../input/control-signal-observer.js';
import {
  addAllowed,
  hostOf,
  listAllowed,
  rateLimitStatus,
  removeAllowed,
} from '../../tool-hints/api-allowlist.js';
import { inputHistoryDbPath, inputHistoryJsonPath } from '../../input-history.js';
import { termSize, stripAnsi } from '../../tui.js';
import { SLASH_COMMANDS } from '../../chat/index.js';
import { buildEssentialHelpLines } from './help-from-registry.js';
import { HUMAN_MODEL_WORDS, MODEL_CODE_NAMES, humanWordForModel, modelChangeLine, modelOverviewLines, modelScopeLine, modelSwitchScope, parseModelSlashArgs, resolveModelChoice } from './model-choices.js';
import type { FoldMode } from '../../log-entry.js';
import { resolveDashboardChatMainLogCommand } from '../input/chat-main-log-command.js';
import {
  dashboardLogHelpLines,
  resolveDashboardLogFilterAction,
  resolveDashboardLogFoldAction,
  resolveDashboardLogSearchAction,
  resolveDashboardLogSizeAction,
  resolveDashboardLogTurnAction,
} from '../input/chat-main-log-actions.js';
import { debug } from '../../debug/log.js';
import { observeSessionStart } from '../../session/session-start.js';
import { resolveDebugCompanionTargets } from '../../window/debug-window-consumers.js';
import { getPromptBankStore, buildPromptInjection } from '../../prompt-bank/index.js';
import { inspectActiveProvider } from '../../provider-summary.js';
import { currentRouteDecision, formatRouteDecisionSummary, resolveRouteDecision, sessionModelPin, setSessionModelPin } from '../../llm/route-decision.js';
import {
  listSessions as sessionListSessions,
  resolveSessionId as sessionResolveId,
  historyFromSession as sessionHistoryFromId,
  detachTelegramBinding as sessionDetachTelegram,
  setActiveSessionId as sessionSetActiveId,
  createSession as sessionCreate,
  appendMessage as sessionAppendMessage,
  attachTelegramBinding as sessionAttachTelegram,
  listBoundSessions as sessionListBound,
} from '../../session/index.js';
import { safeReadLock as telegramSafeReadLock, defaultLockPath as telegramDefaultLockPath } from '../../telegram-lock.js';
import { userConfigPath as userConfigPathFn } from '../../user-config.js';
import { dirname as pathDirname, relative } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import type { SurfaceUx } from '../../agent/surface-ux/types.js';
import type { AskUserQuestionRequest } from '../../ask-user-question/types.js';
import { DASHBOARD_CLARIFICATION_REQUEST } from '../../esc-abort-gate.js';
import type { GoalDocumentClarification } from '../../self-implement/goal-author-clarification.js';
import { renderReplayPreviewLines } from '../replay-preview.js';
import {
  deriveDaemonHttpBase,
  fetchDaemonSessionList,
  fetchDaemonSessionHistory,
} from '../acp-boot.js';
import { resolveLocalEndpoints, runLocalLLMCompat } from '../../local-llm-test.js';
// TUI-SLASH-SPLIT-TERM(D4b) — /term·/terminal 은 src/tui/slash/term.ts 로 이사(그 구현의 정적 import 도 함께 갔다).
import { registerTermSlash, type TermSlashHost } from '../../tui/slash/term.js';
// 옛 입구 re-export shim 은 slash-runtime/index.ts 한 곳뿐(RFC A5 · /mission 과 같은 꼴).
import { SlashCommandRegistry } from './registry.js';
import { createLoopScheduler, type LoopScheduler } from '../loop-scheduler.js';
import { registerShellSlash } from './shell-slash.js';
export { registerShellSlash } from './shell-slash.js';
import { registerMissionSlash } from '../../tui/slash/mission.js';
// TUI-SLASH-SPLIT-MISSION(D4b) — /mission 은 src/tui/slash/mission.ts 로 이사. 옛 입구 re-export shim 은 slash-runtime/index.ts 한 곳뿐(RFC A5).
import { cronSecondDueAt, filterLoopRows, formatLoopsTable, localLoopRows, type LoopsTableRow } from './loops-table.js';
import { loopCronVerdict } from '../../loops/verdict.js';
import { checklistBoardSlash } from '../../release-loop/checklist-board.js';
import type { Checklist } from '../../release-loop/checklist.js';
import { executeImmediateDashboardSlash } from '../input/slash-executor.js';
import {
  buildContextSlashCommand,
  buildCostSlashCommand,
  buildMemorySlashCommand,
} from '../../context-display/index.js';
import {
  formatInspectOutput,
  formatSessionList,
  inspectArchive,
  listArchiveSessions,
  runCompactSlash,
  type CompactProvider,
} from '../../compact/index.js';
import type { LLMMessage } from '../../llm.js';
import type { ChatMessage } from '../../chat/index.js';
import type { LogTurnSeparatorMode } from '../log-turn-separator-mode.js';

// Module-level singletons — descriptors are pure, factories cheap. The
// existing /context attachment-manager registered at L1090 owns the
// `context` / `ctx` names, so we wire the token-display surface as
// /tokens (alias `tk`) below and reuse this descriptor's render() only.
const CONTEXT_SLASH_DESCRIPTOR = buildContextSlashCommand();
const COST_SLASH_DESCRIPTOR = buildCostSlashCommand();
const MEMORY_SLASH_DESCRIPTOR = buildMemorySlashCommand();

export interface DashboardSlashContext {
  // Chat surface refs / mutators
  chatLines: string[];
  /** Same status-line producer the agent immediate executor uses. Absent in tests → empty. */
  getStatusLines?: () => string[];
  /** Existing TUI structured-question capability. Absent means /ask keeps
   * the self-dev noninteractive deferred-clarification contract. */
  surfaceUx?: Pick<SurfaceUx, 'question'>;
  /** Optional wish-card store for isolated slash dispatch tests. */
  wishCardStore?: CardStore;
  attachmentRowMap: { clear(): void };
  pushDebugLine(line: string): void;
  pushChatLine(line: string): void;
  setChatScrollOffset(value: number): void;

  // Loop control (B-1.b · `sync` case sets exit then breaks switch — the
  // dispatcher checks this flag after handler return and breaks the
  // outer input loop instead of issuing `continue;`)
  setExitInputLoop(value: boolean): void;

  // Color funcs (subset of `C.*` from ../tui)
  muted(text: string): string;
  accent(text: string): string;
  highlight(text: string): string;
  text(text: string): string;
  error(text: string): string;
  success(text: string): string;
  warning(text: string): string;
  info(text: string): string;
  /** B-3.b — used by /session list daemon-rows label + binding-tag color. */
  subtext(text: string): string;

  // ICONS subset
  iconsSync: string;

  // TUI lifecycle / help
  closeTui(): void;
  /** Exit-only lifecycle hook: dashboard uses this to leave a session-resume notice. */
  exitTui?(): void;
  showHelp(scope: string): Promise<void>;
  showHelpModal?(options: { title: string; lines: readonly string[] }): void;

  // Log search / filter
  clearLogSearch(): void;
  clearLogFilter(): void;

  // B-1.b additions
  forkAttachedSessionFromChatHistory(): Promise<void>;
  toggleSessionControlMode(state: unknown): { posture: 'general' | 'control' };
  resolveSessionInputModeFromChatMode(opts: { chatModeState: unknown }): unknown;
  inputCoreSetMode(mode: unknown): unknown;
  chatModeStateRef: { value: unknown };
  getChatOnlyMode(): boolean;
  setChatOnlyLayout(value: boolean, opts: { announce: boolean }): void;
  enterSyncMode(): void;
  handleVoiceChatSlash(state: unknown, args: string[]): Promise<string>;
  voiceChatStateRef: { value: unknown };
  reloadSkillIndex(): number;

  // B-1.c additions
  blockStore: {
    getLatest(target: string): { id: string } | undefined;
    pin(target: string, id: string): boolean;
    unpin(target: string, id: string): boolean;
    pinned(target: string): { id: string }[];
  };
  blockAttach: {
    clearSession(target: string): number;
    count(): number;
    clear(): void;
  };

  // B-1.d additions — the deferred skill-tool slashes are fire-and-forget
  // (the original switch bodies spawned an IIFE then called `draw()` to
  // repaint after the async result lands). Threading `draw` through ctx
  // preserves that behavior verbatim; without it the user wouldn't see
  // the result lines until the next input-loop redraw.
  draw(): void;

  /** /child reads one current harness-child screen without writing to it. */
  childScreen?: {
    runId(): string;
    list(): readonly { id: string; kind: string; runId: string; alive: boolean; manifestDbPath: string }[];
    snapshot(id: string, manifestDbPath: string): Promise<{ exitCode: number; message: string }>;
    show(opts: { title: string; lines: readonly string[] }): void;
  };

  // B-1.e additions — auto-tts state is showDashboard-local (built in
  // the input-loop scope), so we thread the controller + providerId
  // through ctx as opaque shapes. `handleAutoTtsSlash` is statically
  // imported in this module since the function itself is module-level.
  autoTtsRef: {
    controller: Parameters<typeof handleAutoTtsSlash>[0];
    providerId: Parameters<typeof handleAutoTtsSlash>[1];
  };

  // B-1.g additions — signals and widget delegation runtimes are
  // showDashboard-local, so they are threaded via ctx as opaque shapes.
  controlSignalSlashRuntime: {
    usageLines(): readonly string[];
    statusLines(): readonly string[];
    clearLine(): string;
    latestLines(filter: unknown): readonly string[];
    listLines(limit: unknown, filter: unknown): readonly string[];
    emitLines(args: readonly string[]): readonly string[];
    parseFilterTokens(tokens: readonly string[]): { filter: unknown; limit: unknown };
  };
  browserCdpSlashRuntime: {
    usageLines(): readonly string[];
    statusLines(): readonly string[];
    smokeLines(): Promise<readonly string[]>;
    stopLines(): readonly string[];
  };
  widgetHost: {
    available(): readonly { source: 'builtin' | 'user' | 'plugin'; def: { type: string; description: string } }[];
    discover(): Promise<unknown>;
    instanceCount(): number;
    /** Wave P4a-3 — read-only access for slash commands that need to
     *  surface a widget's current state (e.g. /bg dumps the
     *  'wd-background-tasks' rows). The full WidgetHost has more
     *  surface; we only expose what the slash needs. */
    get(id: string): { state: unknown } | null;
  };
  /** Wave P4b-1 — adapter that opens a widget-host instance as a
   *  modal-stack popup. Optional so test harnesses without modal
   *  wiring still satisfy the slash contract; production callers
   *  always provide it.
   *
   *  Wave P4b-2 — `open` now returns a disposer when the popup
   *  mounted, or null when wiring was missing. Dashboard host uses
   *  the disposer to enforce ephemeral lifecycle (close on plan
   *  inactive / no background tasks). */
  widgetModalPopup?: {
    open(spec: { widgetInstanceId: string; modalType: string; title: string }): { dispose(): void } | null;
  };
  /** Essential dashboard prints /bg rows into chat instead of opening a popup. */
  backgroundTasksTextOnly?: boolean;

  // B-1.h additions
  // - /preview · /pv: previewSlashRuntime is showDashboard-local (built
  //   per-instance), threaded as opaque ref + the few helpers and the
  //   docked preview state subset that the case body reads.
  // - /context · /ctx: renderContextList is showDashboard-local; the
  //   ctx*/contextRegistry helpers are static-import inside the handler
  //   body. Threaded as the local helper only.
  // - /paste: thinking handle, clipboard attach, nextInitial mutator.
  preview: {
    slashRuntime: {
      resolve(arg: string):
        | { kind: 'source'; source: unknown }
        | { kind: 'binding'; binding: unknown }
        | { kind: 'status' }
        | { kind: 'invalid' };
      statusLine(sourceMode: unknown, binding: unknown): string;
      usageLine(): string;
    };
    setDockedSource(source: unknown): void;
    setDockedBinding(binding: unknown): void;
    refreshWorkingDirPreview(opts: { force: boolean }): void;
    resolveBindingMode(snapshot: unknown): unknown;
    dockedSnapshotRef: { value: { sourceMode: unknown } & Record<string, unknown> };
  };
  contextSlash: {
    renderContextList(): string[];
    contextRegistry: unknown;
  };
  pasteSlash: {
    startThinking(opts: { chatLines: string[]; onFrame: () => void; message: string }): {
      stop(opts: { status: 'completed' | 'failed'; errorText?: string }): void;
    };
    attachClipboardImage(): Promise<string | null>;
    setNextInitial(token: string): void;
  };
  /** TUI 부활 S-a — /resume 세션 픽커. openPicker 는 dashboard 의
   *  openSessionResumePicker (createSearchModal 기반 · 선택 시
   *  `/session load <id>` 합성 submit). */
  sessionResume: {
    openPicker(): void;
  };
  /** TUI 부활 S-b — /fork 타임트래블 (acp/session-fork.ts 엔진 소비).
   *  timetravel(n) 은 n번째(1-based) user 턴 직전 절단 fork + attach
   *  전환을 수행하고 잘린 turn 텍스트를 반환(입력창 prefill 용). */
  sessionFork: {
    openPicker(): void;
    timetravel(n: number): Promise<{ forkedId: string; turn: number; removedUserText: string } | null>;
  };
  /** TUI 부활 C-b-2 PR① — /mission new 준비(ready) 워처. dashboard 가
   *  mission-tui-watch 폴링 + 준비완료 시 페이즈 보드 인라인 + HITL 픽커를
   *  배선(startMissionReadyWatch). revise 재분해 후 재시작에도 쓰인다. */
  missionTui: {
    startReadyWatch(missionId: string): void;
    /** PR ② — approve 후 실행 워처(페이즈 전이 chat line + footer 진행바 + 종결 리포트). */
    startRunWatch(missionId: string): void;
  };

  // B-1.i additions
  refreshReasoningHudSegment(): void;

  // B-2.g additions — /undo. The undo-turn helpers are dynamic-
  // imported in the handler body. Only `refreshGitDirty` over the
  // session cwd is host-local; wrapped behind a single ctx method.
  undo: {
    refreshGitDirty(): void;
    bold(text: string): string;
  };

  // B-2.i additions — /delta · /diffs source-delta browser popup.
  // The popup opener is showDashboard-local; threaded as
  // `delta.openBrowserPopup`.
  delta: {
    openBrowserPopup(scope: 'latest' | 'recent', limit?: number, browserMode?: 'all' | 'files' | 'turns'): Promise<boolean>;
  };

  // B-2.j additions — /playground scenario harness. The command
  // handler + harness factories have many host-local deps (display
  // coordinator, context key service, scenario editor opener), all
  // wrapped behind a single `runCommand` ctx method that returns
  // the lines written by the handler.
  playground: {
    runCommand(args: readonly string[]): Promise<readonly string[]>;
  };

  // B-2.z additions — /setup wizard launcher. The popup-launch and
  // inline-flow paths are wrapped behind two ctx methods that
  // encapsulate the host-local TerminalPopup + display + theme deps.
  setup: {
    /** Spawn the setup wizard inside the dashboard's terminal popup.
     *  Returns true when the popup was created, false on spawn fail. */
    launchPopup(cmd: string): boolean;
    /** Run the in-dashboard inline setup flow for the resolved target. */
    openInlineFlow(target: unknown): void;
  };

  // B-2.y additions — /plugin · /plugins lifecycle. `pluginHost` is
  // showDashboard-local. `enterSyncMode` and `exitSyncMode` are also
  // host-local (sync plugin gets a richer wiring than the generic
  // activate/deactivate path). `refreshDashboardViewsFromPlugins`
  // and the actions-bridge wiring are host-side; threaded as one
  // ctx method that runs after activate.
  plugin: {
    /** Host-local pluginHost ref (opaque structural type). */
    host: {
      list(): readonly {
        source: 'builtin' | 'user';
        plugin: { name: string; version: string; description: string };
      }[];
      isActive(name: string): boolean;
      active(): { name: string; state?: unknown } | null;
      activate(name: string): Promise<void>;
      deactivate(): Promise<void>;
      reload(name: string): Promise<void>;
    };
    /** Refresh views + wire the minimal actions bridge after activate. */
    onAfterActivate(): void;
    enterSyncMode(): Promise<void>;
    exitSyncMode(): Promise<void>;
    /** Color helpers needed beyond the standard ctx set. */
    bold(text: string): string;
  };

  // B-2.x additions — /skill-triggers + /run-skill bundle. Both
  // slashRuntime line helpers + `runByName` host-local action are
  // bundled under one `skill` ctx field since they're domain-coherent.
  skill: {
    triggersSlashRuntime: {
      usageLines(): readonly string[];
      summaryLines(items: readonly {
        name: string;
        explicitCount: number;
        extractedCount: number;
        triggerSource: unknown;
      }[]): readonly string[];
      missingSkillLine(target: string): string;
      detailLines(item: {
        name: string;
        triggerSource: unknown;
        triggers: readonly string[];
        extractedTriggers: readonly string[];
        autoTrigger: unknown;
      }): readonly string[];
    };
    runSlashRuntime: {
      helpLines(skillDescriptions: readonly string[], totalCount: number): readonly string[];
    };
    /** Returns false if the skill name didn't match a registered skill. */
    runByName(name: string, args: string): Promise<boolean>;
  };

  // B-2.w additions — /conv embodied-conversation popup mgmt.
  conv: {
    listLiveSessions(): readonly {
      session: {
        id: string;
        state(): { title?: string };
        launchSpec: { brand: string };
      };
      paneId?: string | null;
      windowId?: string | number | null | undefined;
    }[];
    setLayoutMode(mode: 'cascade' | 'tile' | 'stack'): void;
    /** Returns the session id that received focus, or null when none was eligible. */
    focusPopup(direction: -1 | 1): Promise<string | null>;
    /** Returns false if the session id is unknown. */
    openModal(sessionId: string): Promise<boolean>;
  };

  // B-2.t additions — /compact summarise + history reset. The host
  // owns chat.history; the slash-runtime layer needs to read it for
  // the compact algorithm and clear+repopulate it for reset. Returns
  // the mutable array as `unknown[]` — the handler casts back to
  // `LLMMessage[]` for the compact helpers (same shape the original
  // case used via `as unknown as LLMMessage[]`).
  compact: {
    getHistory(): { role: string; [k: string]: unknown }[];
  };

  // B-2.s additions — /provider · /p rotation switcher. Most logic
  // is in the pure rotation helpers (rotateNextProvider /
  // jumpToRotationEntry / currentRotationIndex / rotationEntryLabel)
  // already statically imported. Only the slashRuntime line helpers
  // remain showDashboard-local.
  provider: {
    slashRuntime: {
      rotationEmptyLine(): string;
      rotatedLine(label: string, provider: string, model: string | undefined): string;
      useUsageLine(): string;
      noRotationMatchLine(needle: string): string;
      switchedLine(label: string, provider: string, model: string | undefined): string;
      resetEmptyLine(): string;
      resetLine(label: string): string;
      overviewLines(
        rotation: readonly { label: string; provider: string; model: string; current: boolean }[],
        providers: readonly { available: boolean; name: string; model: string | undefined }[],
        catalogModelIds?: ReadonlySet<string>,
      ): readonly string[];
    };
    /** 2026-05-05 — open the visual model picker programmatically.
     *  Mirrors the popup that USED to fire on status-bar pill click
     *  (which is now a direct cycle). Returns true when the picker
     *  was opened, false when no rotation entries exist (caller
     *  shows the empty-pool hint). Host implementation lives in
     *  showDashboard so the runtime stays UI-agnostic. */
    openPicker(): boolean;
  };

  // B-2.r additions — /theme runtime mutation. Most helpers
  // (resolveDashboardChatMainThemeCommand, DEFAULT_THEME_TOKENS,
  // listThemes, getTheme, setActivePresetInConfig) are static-
  // imported in this module. Plugin contributions + token snapshot
  // + render trigger come via ctx.
  theme: {
    pluginContributions(): readonly { id: string; label: string }[];
    currentTokens(): unknown;
    requestRender(): void;
  };

  // B-2.q additions — /sim · /simulator simulation cockpit.
  sim: {
    slashRuntime: {
      usageLines(): readonly string[];
      openedLine(id: string | number): string;
      openedWebLine(path: string): string;
      listLines(scenarios: readonly unknown[]): readonly string[];
      unknownScenarioLine(input: string): string;
      runHeading(scenarioId: string): string;
    };
    openWebCockpit(): Promise<{ path: string }>;
    listScenarios(): readonly unknown[];
    runById(scenarioId: string): Promise<{ status: string; lines: readonly string[] }>;
    /** Normalize a raw user-provided alias to a registered scenario id, or null. */
    resolveScenarioId(raw: string): string | null;
  };

  // B-2.o additions — /intake review picker / modal / refresh.
  // Whole IIFE wrapped behind one ctx method.
  intake: {
    runSlash(args: readonly string[]): Promise<void>;
  };

  // B-2.m additions — /claude · /codex · /gemini launchers. Wraps
  // `TerminalPopup.agent(brand).cwd(getSessionCwd()).args(args).open()`
  // behind one ctx method.
  agentLauncher: {
    open(brand: 'claude-code' | 'codex' | 'gemini', args: readonly string[]): void;
  };

  // B-2.l additions — /agents popup + view-open helpers. Separate
  // bundle from `companion` because the view-registry open path is
  // /agents-specific, while companion only covers popup actions for
  // the clipboard / memo / detail keys.
  agents: {
    slashRuntime: {
      viewOpenedLine(): string;
      viewUnavailableLine(): string;
      popupLine(open: boolean): string;
      popupPromotedLine(): string;
      popupUsageLine(): string;
      usageLine(): string;
    };
    /** Returns false if the agents view definition isn't registered. */
    openView(): boolean;
    setDismissed(value: boolean): void;
    popup: {
      open(): void;
      close(): void;
      /** Toggle and return the resulting open state. */
      toggle(): boolean;
      promote(): void;
    };
  };

  // B-2.k additions — /tablet status + manual override.
  tablet: {
    getState(): {
      manual: boolean | null;
      effective: boolean;
      level: string;
      compactMode: string;
    };
    setManual(value: boolean | null): void;
    requestRender(): void;
    openBrowserPreviewModal(): void;
  };

  // B-2.e additions — /history viewer.
  inputHistory: {
    store: {
      list(limit: number): readonly { id: number; text: string; createdAt: string; kind: string; cwd?: string | null; activeView?: string | null; focusedPane?: string | null; metadata?: unknown }[];
      search(opts: { query?: string; limit: number }): readonly { id: number; text: string; createdAt: string; kind: string; cwd?: string | null; activeView?: string | null; focusedPane?: string | null; metadata?: unknown }[];
      clear(): void;
      kind: string;
    };
    refresh(): void;
    openDetailViewer(title: string, lines: string[]): void;
  };

  // B-2.c additions — /resume + /research both prefill the input
  // editor with a seed string + flip the focus transition to plain
  // input mode. Bundled into one ctx field since both cases use the
  // identical pair of helpers.
  inputSeed: {
    appendBlock(seed: string): void;
    setPendingPlainInput(): void;
  };

  // B-2.a additions
  // /sst — operator-on-demand observability for paint/overlay/f8/bumps.
  substrateStats: {
    paintCacheStats(): { hits: number; misses: number; size: number };
    overlayWriteStats(): { skipped: number; written: number };
    generationStats(): readonly { id: string; bumps: number; lastBumpAt: number }[];
    f8ShadowStats(): { mode: boolean; divergences: number };
  };

  // B-1.f additions — three companion-popup cases (clipboard · memo ·
  // detail) share the `companionPopupHost` + `companionSlashRuntime`
  // dependencies. Bundling into a single `companion` field keeps the
  // ctx surface from blowing up with 15 separate function refs.
  companion: {
    popupHost: {
      isOpen(key: 'clipboard' | 'memo' | 'detail'): boolean;
    };
    setPopupOpen(key: 'detail', next: boolean): void;
    openClipboard(): Promise<void>;
    closeClipboard(): void;
    openMemo(): void;
    cancelMemo(): void;
    commitMemo(): void;
    closeDetail(): void;
    clearDetailViewer(): void;
    clearClipHistory(): void;
    notifyClipboardCleared(): void;
    notifyClipboardToggled(open: boolean): void;
    slashRuntime: {
      openedLine(name: string): string;
      closedLine(name: string): string;
      toggledLine(name: string, open: boolean): string;
      usageLine(name: string): string;
      detailClearedLine(): string;
    };
  };

  // Slash wire-up — /compact mutates chatHistory in-place (auto-compact-
  // runtime uses the same pattern). /tokens reads the active model id to
  // size the context window. `getProvider()` is threaded so tests can
  // inject a fake provider (Layer 3 fires unconditionally when a
  // provider is set, so a real one would call the LLM API).
  compactSlash: {
    chatHistory: ChatMessage[];
    activeModelId(): string | undefined;
    sessionId(): string | undefined;
    getProvider(): CompactProvider;
  };

  // B-3.a additions — /log pane control. Most state (filter / search /
  // freeze / turn-separator / height-bias / fold-mode / chat-only mode)
  // is showDashboard-local. Static helpers (resolveDashboardChatMainLog
  // Command + dashboardLogHelpLines + resolveDashboardLog*Action fns +
  // stripAnsi) are static-imported in this module; only host-local state
  // readers / mutators land in ctx.
  logSlash: {
    pushDebugBlank(): void;
    // Height bias (positive shifts log pane taller, negative shorter).
    getLogHeightBias(): number;
    setLogHeightBias(value: number): void;
    /** Recompute pane heights after a bias change. */
    recomputePaneHeight(): void;
    // Filter
    getLogFilterQuery(): string;
    applyLogFilter(query: string): void;
    // Search
    getLogSearchResultsCount(): number;
    /** First match's lineIdx, or null if no matches. */
    firstSearchResultLineIdx(): number | null;
    applyLogSearch(query: string): void;
    scrollToSearchLineIdx(lineIdx: number): void;
    openLogSearchModal(): void;
    // Freeze
    isLogFreezeEnabled(): boolean;
    /** Frozen tail line index, or null when freeze is inactive. */
    getLogFrozenTailIndex(): number | null;
    /** Current chatLines length — used to compute queued-line count. */
    chatLinesLength(): number;
    // Turn separator
    getLogTurnSeparatorMode(): LogTurnSeparatorMode;
    setLogTurnSeparatorMode(mode: LogTurnSeparatorMode): void;
    pushTurnSeparator(): void;
    // Fold mode
    getLogFoldMode(): FoldMode;
    setLogFoldMode(mode: FoldMode): void;
    /** #19 — put every static fold in one state; returns how many changed. */
    setAllFolds?(expanded: boolean): number;
    // Solo (chat-only) toggle — flips chatOnlyMode + manages HUD mode segment.
    /** Returns the new chatOnlyMode value after toggle. */
    toggleSolo(): boolean;
    copyEntireLog(): Promise<void>;
    returnFocusToInput(): void;
  };

  // B-3.a additions — /debug runtime tracer controls. The `debug`
  // module itself (debug-log.ts) is static-imported in this module;
  // ctx covers only the showDashboard-local debug-log buffer +
  // window/workbench/companion handles + view-registry switch.
  // Static-imported here: resolveDebugCompanionTargets +
  // DebugWorkbenchPane type from window/debug-window-consumers.
  debugSlash: {
    // Debug-log buffer + filter (separate from chat-line filter).
    getDebugLines(): string[];
    setDebugScrollOffset(value: number): void;
    getDebugLogFilterQuery(): string;
    applyDebugLogFilter(query: string): void;
    clearDebugLogFilter(): void;
    // Tool-call subscription gate (P5.2).
    ensureToolCallSubscription(): void;
    // /debug view (registry-based view switch).
    /** Returns false when the debug view is disabled in the registry. */
    openDebugView(): boolean;
    // /debug window (PaneMultiModal — separate from workbench).
    openDebugWindow(): void;
    closeDebugWindow(): void;
    /** Returns the new open state after toggle. */
    toggleDebugWindow(): boolean;
    // /debug workbench (the quad popup).
    openDebugWorkbenchModal(): void;
    closeDebugWorkbenchModal(): void;
    /** Returns the new open state after toggle. */
    toggleDebugWorkbenchModal(): boolean;
    // /debug popup — companion popups for individual debug panes
    // (events / detail / stack / prompts). Targets are
    // resolved by static-imported resolveDebugCompanionTargets.
    setCompanionTargetsOpen(targets: readonly string[], next: boolean): void;
    /** Returns the new open state for the targets after toggle. */
    toggleCompanionTargets(targets: readonly string[]): boolean;
    promoteCompanion(target: string): void;
  };

  // B-3.a additions — /prompt + /prompts inspection / config. Most
  // helpers (getPromptBankStore + buildPromptInjection +
  // inspectActiveProvider) are static-imported in this module. The
  // four showDashboard-local closures (promptRuntimeState +
  // setPromptBankRuntimeConfig + describePromptBankRuntimeConfig +
  // parseOnOffArg) thread through ctx because they close over
  // host-local config / paneState / pluginHost refs.
  promptSlash: {
    /** Snapshot the runtime state used to rank prompt fragments. */
    runtimeState(intents: string[]): unknown;
    /** Update the prompt-bank runtime config slice in user-config. */
    setRuntimeConfig(patch: Record<string, unknown>): {
      enabled: boolean;
      dashboardTurns: boolean;
      skillRuns: boolean;
      record: boolean;
      budgetTokens: number;
      limit: number;
    };
    /** Format the current promptBank runtime config as a one-line summary. */
    describeRuntimeConfig(): string;
    /** Parse on / off / toggle / 1 / 0 / enable / disable / true / false. */
    parseOnOffArg(raw: string | undefined, current: boolean): boolean | null;
    /** Active plugin name (used in the inject metadata). */
    activePluginName(): string | undefined;
    /** Open the detail viewer with the supplied lines. */
    openDetailViewer(title: string, lines: string[]): void;
  };

  // B-3.b additions — /session and /telegram cluster.
  // Both cases share host-local binding state (attachedSessionId +
  // attachedChatId · `let` vars in showDashboard scope), so the
  // getter/setter pairs sit at the top level for direct access.
  // /session-specific deps (daemon-attach config + ACP swap) live
  // under sessionSlash. /telegram has no extra ctx — uses the four
  // top-level pair + static-imported helpers in this module.
  /** Currently-attached session id (TUI's pointer to a JSONL on disk). */
  getAttachedSessionId(): string | null;
  setAttachedSessionId(id: string | null): void;
  chatPersona?: { sessionId(): string; selection: TuiChatPersonaSelection; newConversation?(): void };
  /** Telegram chat id paired with the attached session, when handed off. */
  getAttachedChatId(): number | null;
  setAttachedChatId(id: number | null): void;
  /** Optional report delivery seam for slash dispatch tests; production uses the real config and sender. */
  telegramReport?: {
    getConfig(): ReturnType<typeof getUserConfig>;
    send: (cfg: ReturnType<typeof getUserConfig>, text: string) => Promise<boolean>;
  };

  /** Test seam for the local read-only loop and cron registry. */
  loopsLocalRows?: (now: Date) => LoopsTableRow[];
  /** Test seam for the read-only release checklist. */
  checklistRead?: (version: string) => Checklist;

  sessionSlash: {
    /** opts.remote — when the dashboard is attached to a remote daemon. */
    remoteDaemon(): { url: string; token: string | undefined } | null;
    /** Swap ACP session id via the existing connection (no restart). */
    acpSwapTo(sessionId: string, cwd: string): Promise<void>;
    /** TUI-H8 ② — `/session new` 때 백엔드(ACP) 세션도 새로 받는다. 새 id 를 돌려준다(없으면 종전처럼 TUI 기록만 비움). */
    acpRenew?(cwd: string): Promise<string>;
  };

  // B-3.c.2 additions — /term /terminal. The biggest single case
  // (681 LOC inline) — touches sessionRegistry · terminalMatrix ·
  // virtualWindows.registry (subset) · broadcastBus · channelBus +
  // wraps a session-picker-modal lifecycle (createSessionPickerModal
  // + display.pushModal + agentSearchModal/Handle mutation) behind
  // one openSessionPicker ctx method. terminalModalRouter + the
  // four module-level helpers (resolveTerminalMoveDestination +
  // loadPersistedSessions + dispatchTerminalModalObserve +
  // renderHandleStatusChip) are static-imported.
  termSlash: TermSlashHost;

  /** `/ad` — 광고 파이프라인. ⛔ 운반(그리기·승인 카드)은 index.ts 가 쥐고, 여기는 «부르기»만 한다. */
  ad: {
    run(args: readonly string[]): Promise<void>;
  };

  // B-3.c.1 additions — /shell list/kill/attach/rollup. /local has no
  // bundle (all deps are static-imported helpers + existing ctx
  // chatLines / chatScrollOffset / color funcs / config helpers).
  shellSlash: {
    /** Host-local slash-runtime line formatters (showDashboard-built). */
    slashRuntime: {
      helpLines(): readonly string[];
      emptyListLine(showSettled: boolean): string;
      listHeaderLine(count: number, showSettled: boolean): string;
      listEntryLine(opts: {
        idTail: string;
        chip: string;
        mode: string;
        label: string | null;
      }): string;
      killUsageLine(): string;
      attachUsageLine(): string;
      noHandleMatchesLine(needle: string): string;
      ambiguousHeaderLine(needle: string): string;
      ambiguousEntryLine(opts: { id: string }): string;
      killedLine(id: string): string;
      killFailedLine(message: string): string;
      attachedLine(windowId: number, label: string, mode: string): string;
      bgAttachWarningLine(status: string): string;
      bgAttachHintLine(): string;
      noWindowAttachWarningLine(reason: string): string;
      noWindowAttachHintLine(): string;
      genericAttachWarningLine(reason: string): string;
      unknownSubcommandLine(sub: string): string;
    };
    /** Open the shell-rollup popup (the same surface as the 🐚 pill). */
    openRollupPopup(): Promise<void>;
    /** Switch the foreground virtual window to the given id. */
    virtualWindowsSwitchTo(windowId: number): void;
    /** Resolve a virtual-window id by spawn-title (used by /shell attach). */
    resolveVwIdByLabel(label: string): number | null;
  };

  // TUI-LOOP-COMMAND — /loop <간격> <프롬프트> idle-gated 루프 스케줄러
  // (src/dashboard/loop-scheduler.ts · 판정: idle 발사 1 · busy 미룸 · stop 0).
  // 스케줄러 인스턴스와 idle/busy 신호는 showDashboard 로컬 상태라
  // chatModeStateRef / voiceChatStateRef 선례대로 ctx 로 스레드한다.
  // Optional — 배선 없는 격리 dispatch 시험은 /loop 가 «배선 없음» 줄로
  // 답하는 것이 규약(던지지 않는다).
  loopCommand?: {
    /** 대시보드가 쉬고 있는가(스트리밍 턴이 없는가) — 쉬는 동안만 발사한다. */
    isIdle(): boolean;
    /** 프롬프트를 대시보드의 평소 채팅 입력 경로로 낸다. */
    submitPrompt(prompt: string): void;
    /** 실행 중 스케줄러를 쥐는 호스트 로컬 ref(멈추면 null). */
    schedulerRef: { current: LoopScheduler | null };
  };
}

// B-1.d shared shape — every migrated case loads a `executeXxxSlash`
// from a skill-tool module and renders its `{ ok, logLines }` result
// (or "no result" when the executor returns nullish). All 9 cases use
// the same shape, so a single helper covers them.
export type SkillToolSlashResult = {
  ok: boolean;
  logLines: readonly string[];
} | null | undefined;

export type SkillToolSlashExecutor = (
  req: { name: string; args: string[] },
) => Promise<SkillToolSlashResult>;

// Exported for direct unit-testing — registration sites below all go
// through this single helper, so testing the helper covers the shape
// once and the per-case tests can stay smoke-shallow.
export function runDeferredSkillToolSlash(
  cmdName: string,
  loadExecutor: () => Promise<SkillToolSlashExecutor>,
  args: string[],
  ctx: DashboardSlashContext,
): void {
  // Fire-and-forget: the input loop continues without awaiting. The
  // explicit `ctx.draw()` at the end repaints once the result lands.
  (async () => {
    try {
      const exec = await loadExecutor();
      const r = await exec({ name: cmdName, args });
      if (!r) {
        ctx.chatLines.push(ctx.muted(`  /${cmdName}: no result`));
      } else {
        const prefix = r.ok ? ctx.muted : ctx.warning;
        for (const line of r.logLines) ctx.chatLines.push(prefix(`  ${line}`));
      }
    } catch (err) {
      ctx.chatLines.push(
        ctx.error(`  /${cmdName} failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    }
    ctx.setChatScrollOffset(-1);
    ctx.draw();
  })().catch(() => {});
}

export type DashboardSlashReturn = 'quit';

type SelfOrchestrateSlashRuntime = Pick<ToolRuntime<Record<string, unknown>, { output: string }>, 'run'>;
let selfOrchestrateSlashRuntime: SelfOrchestrateSlashRuntime = selfOrchestrateRuntime;

/**
 * Converts the line-oriented self-dev clarification seam into the existing
 * structured SurfaceUx question contract. A missing, cancelled, or failed
 * surface answer becomes an empty line, which preserves clarification's
 * existing "unanswered → deferred" behavior without exposing answer text to
 * the observation payload emitted by SurfaceUx.
 */
export async function readDashboardAskClarification(
  clarification: GoalDocumentClarification,
  surfaceUx: Pick<SurfaceUx, 'question'> | undefined,
  notify?: (line: string) => void,
): Promise<string> {
  if (!surfaceUx) return '';
  const request: AskUserQuestionRequest = {
    questions: [{
      id: clarification.questionId,
      header: 'Clarify goal',
      question: clarification.question,
      options: clarification.options.map((option) => ({
        label: option.label,
        description: option.description,
      })),
      includeOther: clarification.includeOther,
    }],
  };
  Object.defineProperty(request, DASHBOARD_CLARIFICATION_REQUEST, { value: true });
  try {
    const pending = surfaceUx.question(request);
    const id = clarification.questionId;
    notify?.('하니스가 묻는다 — 창에서 고르거나 Esc 로 답 없이 진행');
    const result = await pending;
    if (!result || result.cancelled) return '';
    const answer = result.answers[id];
    const selectedLabel = Array.isArray(answer) ? answer[0] : answer;
    const optionIndex = clarification.options.findIndex((option) => option.label === selectedLabel);
    if (optionIndex >= 0) return String(optionIndex);
    const other = clarification.includeOther ? result.otherText?.[id]?.trim() : '';
    return other || '';
  } catch {
    return '';
  }
}

/** Test seam for verifying the literal /dev payload reaches the runtime front door. */
export function _setSelfOrchestrateSlashRuntimeForTesting(runtime: SelfOrchestrateSlashRuntime | null): void {
  selfOrchestrateSlashRuntime = runtime ?? selfOrchestrateRuntime;
}

/**
 * Intentional differences measured from buildDashboardSlashRegistry at this landing.
 * All dashboard runtime names, including internal names, remain observable; adding a
 * new difference requires deliberately updating this baseline after review.
 */
export const DASHBOARD_SLASH_CATALOG_BASELINE = {
  registeredOnly: [
    'ag', 'agent', 'agents', 'attach-clear', 'attach-pin', 'attach-unpin',
    'bg', 'cb', 'ce', 'child', 'clip', 'clipboard',
    'code-edit', 'compact', 'compress', 'cost', 'detail', 'dv',
    'harness-llm', 'intake', 'loop', 'me', 'memo',
    'note', 'pause', 'plan-board', 'preview', 'pv', 'report',
    'sh', 'shell', 'signal', 'signals', 'skill-reload',
    'skills-reload', 'spend', 'squeeze',
    'tk', 'tokens',
    'undo', 'w', 'wd',
  ],
  listedOnly: [
    'acp', 'rsh', 'sr',
  ],
} as const;


/** B5 — `/design` 이 방향 절을 읽기 위한 최소 파일 읽기.
 *
 *  ⛔ 읽기 실패를 던지지 않는다. `resolveRepositoryDesignCheck` 이 «이미» 문서를
 *  읽었고 그 결과가 `ok` 라는 것은 문서가 읽힌다는 뜻이다. 여기서 다시 읽는 것은
 *  방향 절 «본문»이 필요해서이고, 그 사이에 파일이 사라지는 경우는
 *  「방향 선언이 없다」와 같은 화면으로 떨어뜨리는 편이 맞다 — 규칙집 판정을
 *  방향 때문에 «잃지» 않는다. */
function readDesignDocumentForDirections(documentPath: string): string {
  try {
    return require('node:fs').readFileSync(documentPath, 'utf8') as string;
  } catch {
    return '';
  }
}

function emitReplyToChat(ctx: Pick<DashboardSlashContext, 'pushChatLine'>, line: string): void {
  ctx.pushChatLine(line);
}

async function fetchLoopsDaemonJson<T>(url: string, headers: Record<string, string>): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(url, { headers, signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json() as T;
      })(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error('request timed out'));
        }, 1_000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/** TUI-LOOP-COMMAND — /loop <간격> 파서. `30s` · `5m` · `1h` · 맨숫자=분. 1초 미만은 거부한다. */
function parseLoopInterval(raw: string): { intervalMs: number; label: string } | null {
  const match = /^(\d+)(s|sec|초|m|min|분|h|시간)?$/i.exec(raw.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = (match[2] ?? 'm').toLowerCase();
  const intervalMs = unit === 's' || unit === 'sec' || unit === '초' ? amount * 1_000
    : unit === 'h' || unit === '시간' ? amount * 3_600_000
    : amount * 60_000;
  if (intervalMs < 1_000) return null;
  const label = unit === 's' || unit === 'sec' || unit === '초' ? `${amount}초`
    : unit === 'h' || unit === '시간' ? `${amount}시간`
    : `${amount}분`;
  return { intervalMs, label };
}

export function buildDashboardSlashRegistry(nowDeps?: ContextNowDeps, decideLedger?: DecisionLedger): SlashCommandRegistry<DashboardSlashContext, DashboardSlashReturn> {
  const registry = new SlashCommandRegistry<DashboardSlashContext, DashboardSlashReturn>();
  const decide = createDecideSlashHandler(decideLedger);
  registry.register(['decide', 'dec'], (args, ctx) => {
    // showDashboard in src/dashboard/index.ts dispatches into this registry.
    for (const line of decide(args).split('\n')) ctx.pushChatLine(line);
    ctx.setChatScrollOffset(-1);
  });

  registry.register(['now'], async (args, ctx) => {
    const lines = nowDeps ? tuiNowSlash(args, nowDeps)
      : renderTuiNow(await contextNowInWorker({ topic: args.join(' ').trim() }));
    for (const line of lines) ctx.pushChatLine(line);
  });

  registry.register('loops', async (args, ctx) => {
    if (args.length > 1) {
      ctx.pushChatLine(ctx.warning('  usage: /loops [owner]'));
      return;
    }
    const now = new Date(Date.now());
    let rows: LoopsTableRow[] = [];
    const remote = ctx.sessionSlash.remoteDaemon();
    if (remote) {
      const base = deriveDaemonHttpBase(remote.url);
      if (base) {
        try {
          const headers: Record<string, string> = remote.token ? { authorization: `Bearer ${remote.token}` } : {};
          const body = await fetchLoopsDaemonJson<{ schedules?: Array<{ name: string; domain?: string | null; runVia?: string | null;
            source: string; cron?: string | null; state: string; lastRun?: { at: string; status: string | null; exit: number | null } | null;
            intervalMs?: number | null }> }>(`${base}/v1/schedules?includeOff=1`, headers);
          rows = (body.schedules ?? []).map(schedule => ({
            layer: 'daemon cron', name: schedule.name, owner: schedule.domain ?? '—', mode: schedule.runVia ?? schedule.source,
            lastRun: schedule.lastRun?.at ?? null,
            verdict: loopCronVerdict({ enabled: schedule.state !== 'off', lastRunAt: schedule.lastRun?.at ?? null,
              lastStatus: schedule.lastRun?.exit != null && schedule.lastRun.exit !== 0 ? 'failed' : schedule.lastRun?.status ?? null,
              intervalMs: schedule.intervalMs ?? null,
              secondDueAt: cronSecondDueAt(schedule.cron ?? null, schedule.lastRun?.at ?? null) }, now.getTime()),
          }));
        } catch (err) {
          ctx.pushChatLine(ctx.warning(`  daemon cron unavailable: ${err instanceof Error ? err.message : String(err)}`));
        }
        try {
          const headers: Record<string, string> = remote.token ? { authorization: `Bearer ${remote.token}` } : {};
          const body = await fetchLoopsDaemonJson<{ loops?: { loops?: Array<{
            name: string; label: string; armed: boolean | null; category?: string;
            last: { at: string; status: string } | null;
          }> } | null }>(`${base}/v1/dashboard/loops`, headers);
          // dashboardLoops returns LoopStatus (no owner field). Its category is
          // exec/reflect, not an owner; keep ownership unknown rather than
          // attributing every daemon loop to a guessed domain.
          rows.push(...(body.loops?.loops ?? []).map(loop => ({
            layer: 'daemon loop', name: loop.label || loop.name, owner: '—', mode: loop.category ?? 'loop',
            lastRun: loop.last?.at ?? null,
            verdict: loopCronVerdict({ enabled: loop.armed !== false, lastRunAt: loop.last?.at ?? null,
              lastStatus: loop.last?.status ?? null, intervalMs: null }, now.getTime()),
          })));
        } catch (err) {
          ctx.pushChatLine(ctx.warning(`  daemon loops unavailable: ${err instanceof Error ? err.message : String(err)}`));
        }
      }
    }
    try { rows.push(...(ctx.loopsLocalRows ?? localLoopRows)(now)); }
    catch (err) { ctx.pushChatLine(ctx.warning(`  local loops unavailable: ${err instanceof Error ? err.message : String(err)}`)); }
    const filtered = filterLoopRows(rows, args[0]);
    for (const line of formatLoopsTable(filtered, text => ctx.error(text))) ctx.pushChatLine(`  ${line}`);
    if (!filtered.length) ctx.pushChatLine(ctx.muted('  No loops or cron jobs found.'));
    ctx.setChatScrollOffset(-1);
  });

  // ── TUI-LOOP-COMMAND ───────────────────────────────────────────────
  // /loop <간격> <프롬프트> · 쉬는 동안만 발사 — L6 · PR #27482.
  // 판정: idle 발사 1 · busy 미룸 · stop 0 — 판정선은
  // src/dashboard/loop-scheduler.test.ts 가 증명하고, 이 핸들러는
  // 그 스케줄러를 이 세션의 ctx 번들로 구동한다(start on /loop ·
  // stop on /loop stop 또는 세션 끝 — 세션 끝 정지선은 /session
  // new|clear 쪽에 같은 칸의 stop 조건으로 있다).
  registry.register('loop', (args, ctx) => {
    const loop = ctx.loopCommand;
    if (!loop) {
      ctx.pushChatLine(ctx.muted('  /loop: 이 화면에는 루프 스케줄러 배선이 없다'));
      ctx.setChatScrollOffset(-1);
      return;
    }
    const sub = (args[0] ?? '').trim().toLowerCase();
    if (args.length === 0 || sub === 'help') {
      ctx.pushChatLine(ctx.muted('  usage: /loop <간격> <프롬프트> · /loop stop'));
      ctx.pushChatLine(ctx.muted('    간격: 30s · 5m · 1h · 맨숫자=분 — 대시보드가 쉬는 동안만 프롬프트를 발사한다'));
      ctx.setChatScrollOffset(-1);
      return;
    }
    if (sub === 'stop') {
      const current = loop.schedulerRef.current;
      if (current?.isRunning()) {
        current.stop();
        loop.schedulerRef.current = null;
        ctx.pushChatLine(ctx.success('  ⏹ /loop 정지 — 더 이상 발사하지 않는다'));
      } else {
        ctx.pushChatLine(ctx.muted('  /loop: 실행 중인 루프가 없다'));
      }
      ctx.setChatScrollOffset(-1);
      return;
    }
    const parsed = parseLoopInterval(args[0] ?? '');
    const prompt = args.slice(1).join(' ').trim();
    if (!parsed || !prompt) {
      ctx.pushChatLine(ctx.warning('  usage: /loop <간격> <프롬프트> · /loop stop'));
      ctx.setChatScrollOffset(-1);
      return;
    }
    // 다시 /loop 를 치면 이전 루프를 멈추고 새 간격으로 갈아탄다.
    loop.schedulerRef.current?.stop();
    const scheduler = createLoopScheduler({
      intervalMs: parsed.intervalMs,
      isIdle: loop.isIdle,
      fire: () => {
        try { loop.submitPrompt(prompt); }
        catch (err) {
          ctx.pushChatLine(ctx.error(`  /loop 발사 실패: ${err instanceof Error ? err.message : String(err)}`));
        }
      },
    });
    scheduler.start();
    loop.schedulerRef.current = scheduler;
    ctx.pushChatLine(ctx.success(`  🔁 /loop 시작 — ${parsed.label} 간격 · 쉬는 동안만 "${prompt}"`));
    ctx.pushChatLine(ctx.muted('  멈추기: /loop stop'));
    ctx.setChatScrollOffset(-1);
  });

  registry.register('board', (args, ctx) => {
    for (const line of checklistBoardSlash(args, ctx.checklistRead).split('\n')) ctx.pushChatLine(line);
    ctx.setChatScrollOffset(-1);
  });

  registry.register('wish', (args, ctx) => {
    const text = args.join(' ').trim();
    if (!text) {
      ctx.pushChatLine(ctx.warning('  usage: /wish <소원 한 줄>'));
      ctx.setChatScrollOffset(-1);
      return;
    }
    let store: CardStore | undefined;
    try {
      store = ctx.wishCardStore ?? new CardStore();
      const card = createWishCard({ text, source: 'tui', ref: crypto.randomUUID() }, store);
      ctx.pushChatLine(ctx.success(`  소원 카드로 남겼습니다 — ${card.title}`));
    } catch (err) {
      ctx.pushChatLine(ctx.error(`  소원 카드 등록 실패 — ${err instanceof Error ? err.message : String(err)}`));
    } finally {
      if (!ctx.wishCardStore) store?.close();
    }
    ctx.setChatScrollOffset(-1);
  });

  // ── B-1.a pilot ────────────────────────────────────────────────────
  registry.register(['quit', 'q', 'exit'], (_args, ctx) => {
    (ctx.exitTui ?? ctx.closeTui)();
    return { return: 'quit' };
  });

  registry.register(['clear', 'cls'], (_args, ctx) => {
    ctx.chatLines.length = 0;
    ctx.attachmentRowMap.clear();
    ctx.clearLogSearch();
    ctx.clearLogFilter();
    ctx.pushDebugLine(ctx.muted('Chat log cleared'));
    ctx.chatLines.push(ctx.muted('Chat log cleared'));
    ctx.setChatScrollOffset(-1);
  });

  registry.register(['help', '?'], (_args, ctx) => {
    const { cols, rows } = termSize();
    // The transient modal paints only height - 2 content rows and does not scroll.
    // The builder adds columns to fit that budget; only when it still overflows, use the scrollable chat log.
    const minHeight = Math.min(6, Math.max(3, rows - 2));
    const modalContentRows = Math.max(minHeight, Math.min(rows - 4, Math.floor(rows * 0.7))) - 2;
    const lines = buildEssentialHelpLines({
      names: registry.names(),
      descriptions: SLASH_COMMANDS,
      width: Math.max(1, Math.floor(cols * 0.7) - 2),
      maxRows: modalContentRows,
    });
    if (ctx.showHelpModal && lines.length <= modalContentRows) {
      ctx.showHelpModal({ title: 'Dashboard help', lines });
    } else {
      if (ctx.showHelpModal) ctx.chatLines.push('Dashboard help — scroll the chat log with PgUp / PgDn');
      ctx.chatLines.push(...lines);
      ctx.setChatScrollOffset(-1);
    }
  });

  registry.register('persona', async (args, ctx) => {
    if (!ctx.chatPersona) {
      ctx.pushChatLine(ctx.warning('  페르소나를 사용할 수 없습니다'));
    } else {
      const text = await handleTuiChatPersona(args, ctx.chatPersona.sessionId(), ctx.chatPersona.selection);
      for (const line of text.split('\n')) ctx.pushChatLine(ctx.muted(`  ${line}`));
    }
    ctx.setChatScrollOffset(-1);
  });

  registry.register('directive', async (args, ctx) => {
    try {
      const { addDirective } = await import('../../steward/directive.js');
      const result = await addDirective(args.join(' '), { source: 'tui' });
      ctx.pushChatLine(`${result.issue}: ${result.status}`);
    } catch {
      ctx.pushChatLine('지시 등록 실패 — Linear 연결과 자격을 확인하세요.');
    }
  });

  // ── B-1.b ─────────────────────────────────────────────────────────
  // /fork — 현 시점 전체 복사 분기 (codex `/fork`=ForkCurrentSession 동형 ·
  // 컨셉 정렬 2026-07-12: 대표 지적으로 ref 실물 검증 후 원복). 타임트래블
  // 되감기는 /rewind (codex Esc-Esc backtrack 계보). 단 패브릭 컨벤션
  // `before:N`(tg `/fork before:N` · dc `!fork before:N` — 세션 패브릭 S3)
  // 은 크로스서피스 근육기억을 위해 TUI 에서도 수용 — /rewind N 과 동일
  // 경로로 위임.
  registry.register('fork', async (args, ctx) => {
    const beforeTok = args.find((a) => /^before:\d+$/i.test(a.trim()));
    if (beforeTok) {
      const n = Number.parseInt(beforeTok.split(':')[1]!, 10);
      const res = await ctx.sessionFork.timetravel(n);
      if (res && res.removedUserText.trim()) {
        ctx.pasteSlash.setNextInitial(res.removedUserText);
        ctx.chatLines.push(ctx.muted('    잘린 turn 의 메시지가 입력창에 prefill — 고쳐서 다시 보내세요'));
      }
      ctx.setChatScrollOffset(-1);
      return;
    }
    await ctx.forkAttachedSessionFromChatHistory();
    ctx.setChatScrollOffset(-1);
  });

  // /rewind — 과거 user 턴으로 되감기 (codex backtrack · claude-code
  // Esc-Esc 계보 · acp/session-fork.ts 엔진 소비). ref 들과 달리 같은
  // 세션을 파괴적으로 되감지 않고 **원본 보존 + 새 세션 분기**(비파괴).
  // 무인자 → user 턴 픽커(시각 선택이 기본 UX — ref 동형 · 숫자 입력은
  // 요구하지 않음) · `<n>` 은 파워유저 숏컷. 선택된 턴 텍스트는 입력창
  // prefill(고쳐 재전송).
  registry.register('rewind', async (args, ctx) => {
    const raw = (args[0] ?? '').trim();
    if (!raw) {
      ctx.sessionFork.openPicker();
      return;
    }
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0 || String(n) !== raw) {
      ctx.chatLines.push(ctx.warning('  usage: /rewind [n]  — 무인자 = 픽커(권장) · n = 1-based user turn'));
      ctx.setChatScrollOffset(-1);
      return;
    }
    const res = await ctx.sessionFork.timetravel(n);
    if (res && res.removedUserText.trim()) {
      ctx.pasteSlash.setNextInitial(res.removedUserText);
      ctx.chatLines.push(ctx.muted('    잘린 turn 의 메시지가 입력창에 prefill — 고쳐서 다시 보내세요'));
    }
    ctx.setChatScrollOffset(-1);
  });

  // ⭐ /harness-llm — 역할별 LLM 을 «이 세션»에 정한다(RFC-role-scoped-llm-selection-2026-08-18 §4e).
  //   ⛔ config 파일을 쓰지 않는다: 이 축의 계약은 「한 번 정하고 아래로는 인자로만」이고,
  //   전역 파일을 대화 중에 고치면 «누가 언제 바꿨는지»가 사라진다(그것이 이 RFC 가 환경변수를 거부한 이유다).
  //   영구 설정은 config 의 `roleLlm` 로 둔다 — 사다리 ②층이라 여기 세션 값(①층)이 이긴다.
  registry.register('harness-llm', async (args, ctx) => {
    const { parseRoleLlmFlags, formatRoleLlmSpec } = await import('../../llm/role-llm-cli.js');
    const {
      MODEL_ROLES, resolveRoleLlm, getLaunchRoleLlmOverrides, setLaunchRoleLlmOverrides, clearLaunchRoleLlmOverrides,
    } = await import('../../user-config.js');

    const sub = (args[0] ?? '').trim().toLowerCase();

    if (sub === 'reset') {
      clearLaunchRoleLlmOverrides();
      ctx.pushChatLine(ctx.info('  역할별 LLM 세션 설정을 지웠습니다 — config·기본 사다리로 돌아갑니다'));
      ctx.setChatScrollOffset(-1);
      return;
    }

    // 인자가 없으면 «지금 무엇이 쓰이는지»를 출처와 함께 보여준다 — 값 옆에 출처를 두는 것이 이 축의 계약.
    if (args.length === 0) {
      const active = getLaunchRoleLlmOverrides();
      ctx.pushChatLine(ctx.info('  역할별 LLM — 지금 해석되는 값 (source 가 「어디서 왔나」다)'));
      for (const role of MODEL_ROLES) {
        const r = resolveRoleLlm(role);
        ctx.pushChatLine(ctx.text(`    ${role.padEnd(10)} ${r.provider}${r.tier ? '/' + r.tier : ''}  →  ${r.model}  [${r.source}]`));
      }
      if (active) ctx.pushChatLine(ctx.muted(`    세션 설정: ${MODEL_ROLES.filter((x) => active[x]).map((x) => formatRoleLlmSpec(x, active[x])).join(' | ') || '(없음)'}`));
      ctx.pushChatLine(ctx.muted('    설정: /harness-llm <role>=<provider>[/<tier>] …   해제: /harness-llm reset'));
      ctx.setChatScrollOffset(-1);
      return;
    }

    // ⛔ 모르는 값은 «삼키지 않는다» — CLI 와 «같은» 파서를 쓴다(문법이 갈리면 그것이 다음 사고다).
    const parsed = parseRoleLlmFlags(args);
    if (!parsed.ok) {
      ctx.pushChatLine(ctx.error(`  /harness-llm: ${parsed.message}`));
      ctx.setChatScrollOffset(-1);
      return;
    }
    setLaunchRoleLlmOverrides(parsed.overrides, { allowReplace: true, origin: 'slash:/harness-llm' });
    ctx.pushChatLine(ctx.info('  역할별 LLM 을 이 세션에 적용했습니다'));
    for (const role of MODEL_ROLES) {
      if (!parsed.overrides[role]) continue;
      const r = resolveRoleLlm(role);
      ctx.pushChatLine(ctx.text(`    ${role.padEnd(10)} ${r.provider}${r.tier ? '/' + r.tier : ''}  →  ${r.model}  [${r.source}]`));
    }
    ctx.setChatScrollOffset(-1);
  });


  registry.register(['dashboard', 'dash'], (_args, ctx) => {
    // Explicit exit back to 3-pane layout — no-op if already there, so
    // users can muscle-memory this.
    if (ctx.getChatOnlyMode()) {
      ctx.setChatOnlyLayout(false, { announce: true });
    }
  });

  registry.register(['sync', 's'], (_args, ctx) => {
    ctx.enterSyncMode();
    ctx.chatLines.push(ctx.highlight(`${ctx.iconsSync} Sync mode — select targets, Enter to sync, Esc to cancel`));
    ctx.setChatScrollOffset(-1);
    ctx.setExitInputLoop(true);
  });

  registry.register(['voice-chat', 'vc'], async (args, ctx) => {
    // Phase 4 — continuous voice conversation mode. Subcommands: start
    // (default) / stop / status.
    const status = await ctx.handleVoiceChatSlash(ctx.voiceChatStateRef.value, args);
    ctx.chatLines.push('');
    ctx.chatLines.push(ctx.accent(`❯ /voice-chat ${args.join(' ').trim() || 'start'}`));
    ctx.chatLines.push(ctx.muted(`  ${status}`));
    ctx.setChatScrollOffset(-1);
  });

  registry.register(['skill-reload', 'skills-reload'], (_args, ctx) => {
    // Force the router cache to re-scan ~/.claude/skills. Useful after
    // the user edits triggers in a SKILL.md frontmatter and wants the
    // hint to pick it up without restarting the dashboard.
    const n = ctx.reloadSkillIndex();
    ctx.chatLines.push(ctx.muted(`[skills] index rebuilt — ${n} skill${n !== 1 ? 's' : ''} loaded`));
    ctx.setChatScrollOffset(-1);
  });

  // ── B-1.c ─────────────────────────────────────────────────────────
  registry.register('attach-pin', (args, ctx) => {
    // BL-E3 — bookmark a session's latest block so it survives ring rotation.
    const target = args[0]?.trim();
    if (!target) {
      ctx.pushDebugLine(ctx.warning('  usage: /attach-pin <sessionId>'));
      ctx.setChatScrollOffset(-1);
      return;
    }
    const latest = ctx.blockStore.getLatest(target);
    if (!latest) {
      ctx.pushDebugLine(ctx.muted(`  no block captured yet for ${target}.`));
    } else if (ctx.blockStore.pin(target, latest.id)) {
      ctx.pushDebugLine(ctx.info(`  📌 pinned ${latest.id} from ${target} — protected from ring rotation.`));
    } else {
      ctx.pushDebugLine(ctx.muted(`  ${latest.id} is already pinned.`));
    }
    ctx.setChatScrollOffset(-1);
  });

  registry.register('attach-unpin', (args, ctx) => {
    const target = args[0]?.trim();
    const id = args[1]?.trim();
    if (!target) {
      ctx.pushDebugLine(ctx.warning('  usage: /attach-unpin <sessionId> [blockId]'));
      ctx.setChatScrollOffset(-1);
      return;
    }
    if (id) {
      ctx.pushDebugLine(ctx.blockStore.unpin(target, id)
        ? ctx.info(`  ${id} unpinned from ${target}.`)
        : ctx.muted(`  ${id} not found or not pinned on ${target}.`));
    } else {
      const pins = ctx.blockStore.pinned(target);
      if (pins.length === 0) {
        ctx.pushDebugLine(ctx.muted(`  no pinned blocks on ${target}.`));
      } else {
        let unpinned = 0;
        for (const b of pins) if (ctx.blockStore.unpin(target, b.id)) unpinned++;
        ctx.pushDebugLine(ctx.info(`  unpinned ${unpinned} block${unpinned > 1 ? 's' : ''} on ${target}.`));
      }
    }
    ctx.setChatScrollOffset(-1);
  });

  registry.register('attach-clear', (args, ctx) => {
    // BL-E2 — explicit detach for queued attachments. Esc cannot be wired
    // cleanly into the chat input loop (internal to readline), so a slash
    // command is the most reliable cross-cutting detach.
    const target = args[0]?.trim();
    if (target && target.length > 0) {
      const dropped = ctx.blockAttach.clearSession(target);
      ctx.pushDebugLine(dropped > 0
        ? ctx.muted(`📎 detached ${dropped} attachment${dropped > 1 ? 's' : ''} from ${target}.`)
        : ctx.muted(`📎 no attachments queued for ${target}.`));
    } else {
      const before = ctx.blockAttach.count();
      ctx.blockAttach.clear();
      ctx.pushDebugLine(ctx.muted(before > 0
        ? `📎 all ${before} attachment${before > 1 ? 's' : ''} detached.`
        : '📎 no attachments to detach.'));
    }
    ctx.setChatScrollOffset(-1);
  });

  registry.register('rebind', (args, ctx) => {
    // R3 + R7 — runtime binding management. Touches only the runtime
    // layer; user-config file is not modified.
    const outcome = runRebindCommand(args);
    for (const ln of outcome.lines) {
      const painted =
        ln.tone === 'error'   ? ctx.error(ln.text)
      : ln.tone === 'warn'    ? ctx.warning(ln.text)
      : ln.tone === 'success' ? ctx.success(ln.text)
      : ln.tone === 'muted'   ? ctx.muted(ln.text)
      :                         ctx.text(ln.text);
      ctx.chatLines.push(painted);
    }
    ctx.setChatScrollOffset(-1);
  });




  // ── B-1.d ─────────────────────────────────────────────────────────
  // 9 deferred skill-tool slashes. All share the fire-and-forget
  // dynamic-import shape covered by `runDeferredSkillToolSlash`. The
  // distinct module paths and exporter names are the only per-case
  // variation.

  // /remaining — 명령(`elanous usage`)이 내는 구조화 산출을 그대로 읽는다. 화면 계산 없음.
  registry.register('remaining', (args, ctx) => {
    runDeferredSkillToolSlash(
      'remaining',
      async () => (await import('../../skills/tools/usage-slash.js')).executeUsageSlash,
      args,
      ctx,
    );
  });


  // `agent-room` and `showroom` go to the same module but pass distinct
  // names through to the executor. Two registrations keep the alias
  // disambiguation explicit (registry handlers don't know which name
  // matched, so we can't share a single registration).
  registry.register('agent-room', (args, ctx) => {
    runDeferredSkillToolSlash(
      'agent-room',
      async () => (await import('../../skills/tools/agent-room-slash.js')).executeAgentRoomSlash,
      args,
      ctx,
    );
  });

  registry.register('showroom', (args, ctx) => {
    runDeferredSkillToolSlash(
      'showroom',
      async () => (await import('../../skills/tools/agent-room-slash.js')).executeAgentRoomSlash,
      args,
      ctx,
    );
  });

  registry.register('lane', (args, ctx) => {
    runDeferredSkillToolSlash(
      'lane',
      async () => (await import('../../showroom/handoff-slash.js')).executeHandoffSlash,
      args,
      ctx,
    );
  });

  registry.register('relay', (args, ctx) => {
    runDeferredSkillToolSlash(
      'relay',
      async () => (await import('../../showroom/relay-macro.js')).executeRelaySlash,
      args,
      ctx,
    );
  });

  registry.register('reply', (args, ctx) => {
    runDeferredSkillToolSlash(
      'reply',
      async () => (await import('../../skills/tools/agent-reply-slash.js')).executeAgentReplySlash,
      args,
      ctx,
    );
  });

  registry.register('capture', (args, ctx) => {
    runDeferredSkillToolSlash(
      'capture',
      async () => (await import('../../skills/tools/capture-source-slash.js')).executeCaptureSourceSlash,
      args,
      ctx,
    );
  });

  registry.register('inject', (args, ctx) => {
    runDeferredSkillToolSlash(
      'inject',
      async () => (await import('../../skills/tools/capture-inject-slash.js')).executeCaptureInjectSlash,
      args,
      ctx,
    );
  });


  // ── B-1.e ─────────────────────────────────────────────────────────
  // 4 tiny standalone toggles / state-mutation cases. Each is small and
  // unrelated to the others; bundled because each is < 20 LOC and they
  // share the "tiny" tier.

  registry.register('bg', async (_args, ctx) => {
    if (!ctx.backgroundTasksTextOnly) {
      let handle: { dispose(): void } | null | undefined;
      try {
        handle = ctx.widgetModalPopup?.open({
          widgetInstanceId: 'wd-background-tasks', modalType: 'background-tasks-popup', title: 'Background tasks',
        });
      } catch (err) {
        if (!(err instanceof Error) || !err.message.includes("no modal type registered as 'background-tasks-popup'")) throw err;
        debug.log('dashboard.slash', 'modal-type-missing', { type: 'background-tasks-popup' });
        ctx.pushChatLine(ctx.warning('  배경 작업 창을 열 수 없습니다'));
        ctx.setChatScrollOffset(-1);
        return;
      }
      if (handle) {
        ctx.setChatScrollOffset(-1);
        return;
      }
    }
    type Row = {
      id: string; source: string; label: string; status: string;
      detail?: string; elapsedMs?: number;
    };
    const inst = ctx.widgetHost.get('wd-background-tasks');
    const rows = (inst?.state as { rows?: Row[] } | undefined)?.rows ?? [];
    if (rows.length === 0) {
      ctx.pushChatLine(ctx.muted('  /bg: no active background tasks.'));
    } else {
      ctx.pushChatLine(ctx.muted(`  /bg: ${rows.length} active background task${rows.length === 1 ? '' : 's'}`));
      for (const r of rows) {
        const elapsed = typeof r.elapsedMs === 'number' && r.elapsedMs > 0
          ? `${Math.floor(r.elapsedMs / 1000)}s`
          : '';
        const tail = [r.detail, elapsed].filter(Boolean).join(' · ');
        const tailPart = tail ? `  ${tail}` : '';
        ctx.pushChatLine(`  ${r.source} · ${r.status} · ${r.label}${tailPart}`);
      }
    }
    ctx.setChatScrollOffset(-1);
  });

  registry.register('plan-board', (_args, ctx) => {
    // Wave P4b-1 — open the live plan-board widget as a modal popup.
    // The widget already mirrors `subscribePlanUpdate` (wired in
    // P3a) so the modal reflects the current PlanState live.
    const handle = ctx.widgetModalPopup?.open?.({
      widgetInstanceId: 'wd-plan-board',
      modalType: 'plan-board-popup',
      title: 'Plan board',
    });
    if (!handle) {
      ctx.pushDebugLine(ctx.muted('  /plan-board: popup host not wired.'));
      ctx.setChatScrollOffset(-1);
    }
  });

  registry.register('pause', async (_args, ctx) => {
    // Phase 1.1 (PLAN §4.1) — request a mid-turn pause. Sets a process-
    // singleton flag the next streamLLMWithTools dispatch round consumes;
    // the running turn (if any) ends gracefully with a "[paused]
    // checkpoint saved..." final answer that the user can resume via
    // `/resume`. The dynamic import keeps turn-checkpoint lazy-loaded.
    const { requestPause, isPauseRequested } = await import('../../turn-checkpoint/index.js');
    if (isPauseRequested()) {
      const line = ctx.muted('  /pause: already queued — the next decision-boundary tool call will halt the turn.');
      ctx.pushDebugLine(line);
      ctx.chatLines.push(line);
    } else {
      requestPause();
      const line = ctx.success('  /pause: queued. The next decision-boundary tool call (Edit/Write/Bash/Agent) will checkpoint and end the turn.');
      ctx.pushDebugLine(line);
      ctx.chatLines.push(line);
      const resumeHint = ctx.muted('  Resume the captured state with /resume-turn (most recent) or /resume-turn <turn-suffix>.');
      ctx.pushDebugLine(resumeHint);
      ctx.chatLines.push(resumeHint);
    }
    ctx.setChatScrollOffset(-1);
  });

  registry.register('chat', (_args, ctx) => {
    // Toggle LLM-only layout. Entering hides the 3-pane grid so the log
    // + input feel like a dedicated chat REPL; running /chat again (or
    // /dashboard) restores. Equivalent to the original
    // `toggleChatOnlyLayout({announce: true})` showDashboard-local
    // closure — which is just `setChatOnlyLayout(!chatOnlyMode, opts)`.
    ctx.setChatOnlyLayout(!ctx.getChatOnlyMode(), { announce: true });
  });

  registry.register('qc', (args, ctx) => {
    // Phase α1 — Quick-control arming. Arms the one-shot flag so the
    // NEXT turn is treated as control mode; the flag auto-clears at
    // turn end. Intent (args.join) is stamped so the control manual
    // shows it.
    const intent = args.join(' ').trim();
    armSessionQuickControl(
      ctx.chatModeStateRef.value as Parameters<typeof armSessionQuickControl>[0],
      intent || undefined,
    );
    ctx.chatLines.push(ctx.accent('⚡ quick-control armed') + ctx.muted(
      ' — your next message runs in control mode, then back to chat.',
    ));
    if (intent) ctx.chatLines.push(ctx.muted(`  intent: ${intent}`));
    ctx.setChatScrollOffset(-1);
  });

  registry.register(['auto-tts', 'autotts', 'tts'], (args, ctx) => {
    // Phase 2 — toggle auto-TTS for chat responses. Subcommands: on /
    // off / toggle / status (default). `handleAutoTtsSlash` returns the
    // status string for surfacing.
    const status = handleAutoTtsSlash(
      ctx.autoTtsRef.controller,
      ctx.autoTtsRef.providerId,
      args,
    );
    ctx.chatLines.push('');
    ctx.chatLines.push(ctx.accent(`❯ /auto-tts ${args.join(' ').trim() || 'status'}`));
    ctx.chatLines.push(ctx.muted(`  ${status}`));
    ctx.setChatScrollOffset(-1);
  });

  // ── B-1.f ─────────────────────────────────────────────────────────
  // 3 companion-popup cases. clipboard / memo / detail share both the
  // popupHost (open-state ledger) and the slashRuntime (line builders).
  // The handler bodies are sub-command routers — open / close / toggle
  // / clear with mostly identical shape but with case-specific
  // companion-side helpers (e.g. clipboard's history clear, memo's
  // commit). Captured via `ctx.companion`.

  registry.register(['clipboard', 'clip', 'cb'], async (args, ctx) => {
    const sub = (args[0] ?? 'open').toLowerCase();
    const c = ctx.companion;
    if (sub === 'open' || sub === 'show') {
      await c.openClipboard();
      ctx.chatLines.push(c.slashRuntime.openedLine('clipboard'));
      ctx.setChatScrollOffset(-1);
      return;
    }
    if (sub === 'close' || sub === 'hide') {
      c.closeClipboard();
      ctx.chatLines.push(c.slashRuntime.closedLine('clipboard'));
      ctx.setChatScrollOffset(-1);
      return;
    }
    if (sub === 'toggle' || sub === 't') {
      const next = !c.popupHost.isOpen('clipboard');
      if (next) await c.openClipboard();
      else c.closeClipboard();
      c.notifyClipboardToggled(next);
      return;
    }
    if (sub === 'clear' || sub === 'cls') {
      c.clearClipHistory();
      c.notifyClipboardCleared();
      return;
    }
    ctx.chatLines.push(c.slashRuntime.usageLine('clipboard'));
    ctx.setChatScrollOffset(-1);
  });

  registry.register(['memo', 'note', 'me'], (args, ctx) => {
    const sub = (args[0] ?? 'open').toLowerCase();
    const c = ctx.companion;
    if (sub === 'open' || sub === 'show') {
      c.openMemo();
      ctx.chatLines.push(c.slashRuntime.openedLine('memo'));
      ctx.setChatScrollOffset(-1);
      return;
    }
    if (sub === 'close' || sub === 'hide' || sub === 'cancel') {
      c.cancelMemo();
      ctx.setChatScrollOffset(-1);
      return;
    }
    if (sub === 'toggle' || sub === 't') {
      const next = !c.popupHost.isOpen('memo');
      if (next) {
        c.openMemo();
        ctx.chatLines.push(c.slashRuntime.openedLine('memo'));
      } else {
        c.cancelMemo();
      }
      ctx.setChatScrollOffset(-1);
      return;
    }
    if (sub === 'save' || sub === 'commit') {
      c.commitMemo();
      ctx.setChatScrollOffset(-1);
      return;
    }
    ctx.chatLines.push(c.slashRuntime.usageLine('memo'));
    ctx.setChatScrollOffset(-1);
  });

  // ── B-1.g ─────────────────────────────────────────────────────────
  // 3 sub-runtime delegation cases. Each routes sub-commands to a
  // slashRuntime factory output (controlSignal / browserCdp / widgetHost).
  // The slashRuntimes are bound to deps inside showDashboard, so we
  // thread their public APIs through ctx.

  registry.register(['signals', 'signal'], (args, ctx) => {
    const sub = (args[0] || 'status').toLowerCase();
    const rt = ctx.controlSignalSlashRuntime;
    ctx.chatLines.push('');
    ctx.chatLines.push(ctx.accent(`❯ /signals ${args.join(' ').trim() || 'status'}`));
    if (sub === 'help') {
      for (const line of rt.usageLines()) ctx.chatLines.push(line);
    } else if (sub === 'status') {
      for (const line of rt.statusLines()) ctx.chatLines.push(line);
    } else if (sub === 'clear') {
      defaultControlSignalObserver().clear();
      ctx.chatLines.push(rt.clearLine());
    } else if (sub === 'latest') {
      const parsed = rt.parseFilterTokens(args.slice(1));
      for (const line of rt.latestLines(parsed.filter)) ctx.chatLines.push(line);
    } else if (sub === 'list' || sub === 'ls') {
      const parsed = rt.parseFilterTokens(args.slice(1));
      for (const line of rt.listLines(parsed.limit, parsed.filter)) ctx.chatLines.push(line);
    } else if (sub === 'emit') {
      for (const line of rt.emitLines(args.slice(1))) ctx.chatLines.push(line);
    } else {
      for (const line of rt.usageLines()) ctx.chatLines.push(line);
    }
    ctx.setChatScrollOffset(-1);
  });


  registry.register(['widget', 'widgets', 'w'], async (args, ctx) => {
    const sub = (args[0] || 'list').toLowerCase();
    const host = ctx.widgetHost;
    ctx.chatLines.push('');
    ctx.chatLines.push(ctx.accent(`❯ /widget ${sub}${args.slice(1).length ? ' ' + args.slice(1).join(' ') : ''}`));
    try {
      if (sub === 'list' || sub === 'ls') {
        const items = host.available();
        if (items.length === 0) {
          ctx.chatLines.push(ctx.muted('  (no widgets found — drop one in ~/.claude/widgets/<name>/widget.ts)'));
        } else {
          for (const it of items) {
            const src = it.source === 'builtin' ? ctx.muted('[built-in]') : ctx.info('[user]');
            // The original used `C.bold` but ctx doesn't expose `bold`;
            // we substitute `accent` (visually similar) since handlers
            // module's color contract is the published ctx subset.
            ctx.chatLines.push(`  ▢ ${ctx.accent(it.def.type)} ${src}  ${ctx.muted(it.def.description)}`);
          }
        }
      } else if (sub === 'reload' || sub === 'r') {
        await host.discover();
        ctx.chatLines.push(ctx.success(`  reloaded — ${host.available().length} widget type(s) discovered`));
      } else if (sub === 'instances' || sub === 'i') {
        const count = host.instanceCount();
        ctx.chatLines.push(`  ${count} widget instance(s) alive`);
      } else {
        ctx.chatLines.push(ctx.warning(`  unknown subcommand: ${sub} (try list|reload|instances)`));
      }
    } catch (err: unknown) {
      ctx.chatLines.push(ctx.error(`  error: ${err instanceof Error ? err.message : String(err)}`));
    }
    ctx.setChatScrollOffset(-1);
  });

  // ── B-1.h ─────────────────────────────────────────────────────────
  // Session/context cluster. Reuses ctx fields already wired (chatModeStateRef,
  // inputCoreSetMode, resolveSessionInputModeFromChatMode); session-runtime
  // helpers are statically imported.

  // /control · /dm · /default — chat-mode posture toggle. The original
  // case body referenced `cmd` (a typo for `cmdLower`) at line 18990 of
  // dashboard/index.ts; that bug was masked because the case is rarely
  // hit before the alias-checking branches. Registry handlers don't
  // receive the matched name, so we register each alias separately and
  // hard-code the source name — fixes the typo by construction.
  for (const sourceName of ['control', 'default'] as const) {
    registry.register(sourceName, (args, ctx) => {
      const outcome = parseSessionControlSlash(
        sourceName,
        args,
        isSessionControlActive(
          ctx.chatModeStateRef.value as Parameters<typeof isSessionControlActive>[0],
        ),
      );
      const chatModeState = ctx.chatModeStateRef.value as Parameters<typeof exitSessionControlMode>[0];
      if (outcome.kind === 'exit') {
        if (!outcome.alreadyDefault) {
          exitSessionControlMode(chatModeState);
          void ctx.inputCoreSetMode(ctx.resolveSessionInputModeFromChatMode({ chatModeState }));
          ctx.chatLines.push(ctx.muted(outcome.source === 'control'
            ? '-- exit control mode — back to chat --'
            : '-- back to default chat mode --'));
          ctx.setChatScrollOffset(-1);
        } else if (outcome.source === 'control') {
          ctx.chatLines.push(ctx.muted('  (already in default chat mode)'));
          ctx.setChatScrollOffset(-1);
        }
        return;
      }
      enterSessionControlMode(chatModeState, { intent: outcome.intent });
      void ctx.inputCoreSetMode(ctx.resolveSessionInputModeFromChatMode({ chatModeState }));
      ctx.chatLines.push(ctx.error('-- CONTROL MODE —') + ctx.text(
        ' every message is a dashboard command. /control off to exit.',
      ));
      if (outcome.intent) ctx.chatLines.push(ctx.muted(`  intent: ${outcome.intent}`));
      ctx.setChatScrollOffset(-1);
    });
  }

  registry.register('surface', (args, ctx) => {
    const outcome = parseSessionSurfaceSlash(args);
    const chatModeState = ctx.chatModeStateRef.value as Parameters<typeof setSessionPreferredSurface>[0];
    if (outcome.kind === 'status') {
      const surfaceStatus = resolveSessionSurfaceStatus({ chatModeState });
      for (const line of buildSessionSurfaceStatusLines(surfaceStatus)) {
        ctx.chatLines.push(ctx.muted(`  ${line}`));
      }
      ctx.setChatScrollOffset(-1);
      return;
    }
    if (outcome.kind === 'clear') {
      setSessionPreferredSurface(chatModeState, null);
      void ctx.inputCoreSetMode(ctx.resolveSessionInputModeFromChatMode({ chatModeState }));
      ctx.chatLines.push(ctx.muted('  preferred surface cleared — back to auto resolution'));
      ctx.setChatScrollOffset(-1);
      return;
    }
    if (outcome.kind === 'error') {
      ctx.chatLines.push(ctx.warning(`  ${outcome.message}`));
      ctx.setChatScrollOffset(-1);
      return;
    }
    setSessionPreferredSurface(chatModeState, outcome.surfaceId);
    void ctx.inputCoreSetMode(ctx.resolveSessionInputModeFromChatMode({ chatModeState }));
    ctx.chatLines.push(ctx.muted(`  preferred surface: ${outcome.surfaceId}`));
    ctx.setChatScrollOffset(-1);
  });

  registry.register(['preview', 'pv'], (args, ctx) => {
    const p = ctx.preview;
    const action = p.slashRuntime.resolve(args[0] ?? '');
    if (action.kind === 'source') {
      p.setDockedSource(action.source);
    } else if (action.kind === 'binding') {
      p.setDockedBinding(action.binding);
    } else if (action.kind === 'status') {
      ctx.chatLines.push(p.slashRuntime.statusLine(
        p.dockedSnapshotRef.value.sourceMode,
        p.resolveBindingMode(p.dockedSnapshotRef.value),
      ));
      ctx.setChatScrollOffset(-1);
      return;
    } else {
      ctx.chatLines.push(p.slashRuntime.usageLine());
      ctx.setChatScrollOffset(-1);
      return;
    }
    p.refreshWorkingDirPreview({ force: true });
    ctx.chatLines.push(p.slashRuntime.statusLine(
      p.dockedSnapshotRef.value.sourceMode,
      p.resolveBindingMode(p.dockedSnapshotRef.value),
    ));
    ctx.setChatScrollOffset(-1);
  });

  registry.register(['context', 'ctx'], async (args, ctx) => {
    // contextRegistry is showDashboard-local (threaded via ctx); the
    // helpers are statically imported.
    const subCmd = args[0]?.toLowerCase();
    if (!subCmd) {
      const lines = ctx.contextSlash.renderContextList();
      ctx.chatLines.push(...(lines.length > 0 ? lines : [ctx.muted('  /context: (없음)')]));
      ctx.setChatScrollOffset(-1);
      return;
    }
    const {
      clearAll: ctxClearAll, clearLarge: ctxClearLarge,
      dropAttachment: ctxDrop, DEFAULT_LARGE_THRESHOLD_BYTES,
    } = await import('../../context.js');
    const fmtBytes = (n: number): string => {
      if (n < 1024) return `${n} B`;
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
      return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    };
    const reg = ctx.contextSlash.contextRegistry as Parameters<typeof ctxClearLarge>[0];
    if (subCmd === 'clear') {
      const mode2 = args[1]?.toLowerCase();
      if (mode2 === 'big') {
        const removed = ctxClearLarge(reg);
        ctx.chatLines.push(ctx.info(`Cleared ${removed} attachments over ${fmtBytes(DEFAULT_LARGE_THRESHOLD_BYTES)}`));
      } else {
        const removed = ctxClearAll(reg);
        ctx.chatLines.push(ctx.info(`Cleared ${removed} attachments`));
      }
    } else if (subCmd === 'drop') {
      const id = Number.parseInt(args[1] ?? '', 10);
      if (Number.isNaN(id)) {
        ctx.chatLines.push(ctx.warning('Usage: /context drop <id>'));
      } else {
        const ok = ctxDrop(reg, id);
        ctx.chatLines.push(ok ? ctx.info(`Dropped attachment #${id}`) : ctx.warning(`No attachment #${id}`));
      }
    } else {
      ctx.chatLines.push(ctx.warning(`Unknown subcommand: /context ${subCmd}`));
      ctx.chatLines.push(ctx.muted('Usage: /context | /context clear [big] | /context drop <id>'));
    }
    ctx.setChatScrollOffset(-1);
  });

  // /paste — only the canonical name. The legacy `v` alias was dead in
  // the original switch (the earlier `case 'view': case 'v'` matched
  // first), so we don't register it here.
  registry.register('paste', async (_args, ctx) => {
    ctx.chatLines.push('');
    ctx.chatLines.push(ctx.accent('❯ /paste'));
    const pasteThinking = ctx.pasteSlash.startThinking({
      chatLines: ctx.chatLines,
      onFrame: () => { ctx.setChatScrollOffset(-1); ctx.draw(); },
      message: 'Reading clipboard',
    });
    let token: string | null = null;
    let pasteStatus: 'completed' | 'failed' = 'completed';
    let pasteErr: string | undefined;
    try {
      token = await ctx.pasteSlash.attachClipboardImage();
    } catch (err: unknown) {
      pasteStatus = 'failed';
      pasteErr = err instanceof Error ? err.message : String(err);
    } finally {
      pasteThinking.stop({ status: pasteStatus, errorText: pasteErr });
    }
    if (token) {
      ctx.chatLines.push(ctx.muted(`  ╰─ Reference it in your next question; the token is pre-filled.`));
      ctx.pasteSlash.setNextInitial(token);
    }
    ctx.setChatScrollOffset(-1);
  });

  // /resume — TUI 부활 S-a: 세션 픽커 (codex 패리티). 인자 없으면
  // 필터형 모달 픽커 오픈 · `<prefix>` 지정 시 기존 `/session load`
  // 파이프라인에 그대로 위임 (registry 재진입 · return 의미 보존).
  registry.register('resume', async (args, ctx) => {
    const prefix = (args[0] ?? '').trim();
    if (prefix) {
      const out = await registry.dispatch('session', ['load', prefix], ctx);
      if (out.kind === 'return') return { return: out.value };
      return;
    }
    ctx.sessionResume.openPicker();
  });

  // /mission — TUI 부활 C-a: autopilot 미션 레지스트리의 TUI 표면.
  // `elanous autopilot` CLI 와 동일한 단일 창구(dispatchAutopilotMissions)
  // 소비 — 엔진/레지스트리 무변. 스코프 = 읽기(list/trace) + 승인(arm).
  // materialize/cancel 같은 무거운 변경은 CLI/skill 로 안내(오조작 방지).
  registry.register('harness', async (args, ctx) => {
    const sub = args[0]?.toLowerCase();
    const usage = (line: string): void => {
      ctx.pushChatLine(ctx.warning(`  usage: ${line}`));
      ctx.setChatScrollOffset(-1);
    };
    const launchDev = (goal: string, decompose: boolean): void => {
      ctx.pushChatLine(ctx.text(`  self-dev 시작: ${goal.slice(0, 80)}`));
      ctx.pushChatLine(ctx.muted('    분해 → 격리 worktree 구현 → gate (수 분 소요)'));
      ctx.setChatScrollOffset(-1);
      void (async () => {
        try {
          const res = await selfOrchestrateSlashRuntime.run({ goals: [goal], decompose }, { surface: 'tui' });
          for (const line of res.output.split('\n')) ctx.pushChatLine(ctx.text(`  ${line}`));
        } catch (e) {
          ctx.pushChatLine(ctx.error(`  self-dev 실패: ${(e as Error).message}`));
        }
        ctx.setChatScrollOffset(-1);
        ctx.draw();
      })();
    };
    if (sub === 'implement') {
      ctx.pushChatLine(ctx.muted('  /harness implement has moved to /harness ask <무엇을 왜 고칠지 한 문장>'));
      ctx.setChatScrollOffset(-1);
      return;
    }
    if (sub === 'dev') {
      const goal = args.slice(1).join(' ').replace(/^["'“]|["'”]$/g, '').trim();
      if (!goal) return usage('/harness dev <무엇을 왜 고칠지 한 문장>');
      launchDev(goal, true);
      return;
    }
    if (sub === 'plan' || sub === 'goal') {
      const value = args.slice(1).join(' ').trim();
      if (!value) return usage(`/harness ${sub} <${sub === 'plan' ? 'goal' : 'goal-file'}>`);
      ctx.pushChatLine(ctx.text(`  ${sub === 'plan' ? 'staged plan' : 'goal document'} 시작: ${value.slice(0, 80)}`));
      ctx.setChatScrollOffset(-1);
      void (async () => {
        try {
          const [{ buildDevCliSpec }, { runDevPipeline }, { lookupEntrance }] = await Promise.all([
            import('../../self-dev/dev-cli.js'),
            import('../../self-dev/dev-pipeline.js'),
            import('../../self-dev/entrance-registry.js'),
          ]);
          const entrance = lookupEntrance('tui-slash-dev').id;
          const spec = sub === 'plan'
            ? buildDevCliSpec({ text: value }, { kind: 'self' }, { plan: true }, undefined, entrance)
            : buildDevCliSpec({ file: value }, { kind: 'self' }, {}, undefined, entrance);
          const result = await runDevPipeline(spec);
          ctx.pushChatLine(ctx.text(`  ${JSON.stringify(result)}`));
        } catch (e) {
          ctx.pushChatLine(ctx.error(`  ${sub} 실패: ${(e as Error).message}`));
        }
        ctx.setChatScrollOffset(-1);
        ctx.draw();
      })();
      return;
    }
    if (sub === 'runs') {
      if (args.length !== 1) return usage('/harness runs');
      const { queryRunningRuns, renderRunningRuns } = await import('../../self-implement/running-runs.js');
      const result = queryRunningRuns({ includeTest: false, caller: 'dashboard' });
      // Keep the TUI transcript readable while preserving the renderer's full summary.
      const visibleRunLimit = 8;
      const renderedLines = renderRunningRuns(result).split('\n');
      const runLines = renderedLines.filter((line) => line.startsWith('runId='));
      const summaryLines = renderedLines.filter((line) => !line.startsWith('runId='));
      for (const line of summaryLines) ctx.pushChatLine(ctx.text(`  ${line}`));
      for (const line of runLines.slice(0, visibleRunLimit)) ctx.pushChatLine(ctx.text(`  ${line}`));
      if (runLines.length > visibleRunLimit) {
        ctx.pushChatLine(ctx.warning(`  runs truncated: showing ${visibleRunLimit} of ${runLines.length} total assessments`));
      }
      ctx.setChatScrollOffset(-1);
      return;
    }
    if (sub === 'stop' || sub === 'memo') {
      const [spaceId, ...message] = args.slice(1);
      if (!spaceId || (sub === 'memo' && !message.join(' ').trim())) {
        return usage(sub === 'stop' ? '/harness stop <space-id>' : '/harness memo <space-id> <note>');
      }
      const { listHarnessScreens } = await import('../../harness/harness-screen.js');
      const screens = listHarnessScreens();
      if (!screens.some((screen) => screen.spaceId === spaceId)) {
        const candidates = screens.map((screen) => screen.spaceId).join(', ') || 'none';
        ctx.pushChatLine(ctx.warning(`  unknown harness space: ${spaceId}; available: ${candidates}`));
        ctx.setChatScrollOffset(-1);
        return;
      }
      const { enqueueControlMemo, enqueueSoftStop } = await import('../../harness/control-inbox.js');
      if (sub === 'stop') {
        enqueueSoftStop(spaceId);
        ctx.pushChatLine(ctx.text(`  stop sent: ${spaceId}`));
      } else {
        enqueueControlMemo(spaceId, { version: 1, kind: 'supervisor-note', urgency: 'normal', body: message.join(' ').trim() });
        ctx.pushChatLine(ctx.text(`  supervisor note sent: ${spaceId}`));
      }
      ctx.setChatScrollOffset(-1);
      return;
    }
    if (sub === 'ask') {
      const say = args.slice(1).join(' ').replace(/^["'“]|["'”]$/g, '').trim();
      ctx.chatLines.push('');
      ctx.chatLines.push(ctx.accent('❯ /harness ask'));
      if (!say) {
        ctx.chatLines.push(ctx.warning('  usage: /harness ask <무엇을 왜 고칠지 한 문장>'));
        ctx.chatLines.push(ctx.warning('  ⛔ 첫 줄에 「대상 경로: <파일> · <파일>」 을 주면 저작 «전」에 충돌을 본다'));
        ctx.setChatScrollOffset(-1);
        return;
      }
      launchAsk(say);
      return;
    }
    const goal = args.join(' ').replace(/^["'“]|["'”]$/g, '').trim();
    if (!goal) {
      usage('/harness <무엇을 왜 고칠지 한 문장>');
      return;
    }
    launchAsk(goal);
    return;

    function launchAsk(say: string): void {
      void (async () => {
        try {
          const [{ runAskLaunchFlow }, askIo, { prepareAskLaunch }, { debug }, { TUI_SLASH_ASK_ENTRANCE }] = await Promise.all([
            import('../../self-dev/ask-launch-flow.js'),
            import('../../self-dev/ask-launch-io.js'),
            import('../../self-dev/launch-preflight.js'),
            import('../../debug/log.js'),
            import('../../self-dev/entrance-registry.js'),
          ]);
          const prep = prepareAskLaunch({ kind: 'say', value: say }, {});
          const rows = await askIo.readAskPreflightLogRows();
          ctx.chatLines.push(ctx.accent('  ⑴ 저작 — self author (수 분 걸린다 · 그 동안 화면은 조용하다)'));
          ctx.setChatScrollOffset(-1);
      const result = await runAskLaunchFlow({
        entrance: TUI_SLASH_ASK_ENTRANCE,
        inputSource: 'say',
        askText: say,
        liveRunWindowMinutes: prep.liveRunWindowMinutes,
        recentChangeWindowDays: prep.recentChangeWindowDays,
        forceRequested: false,
        decomposeBeforeLaunch: true,
      }, {
        print: (line) => { for (const part of line.split('\n')) ctx.chatLines.push(`  ${part}`); },
        log: (event, data, level) => debug.log('dev-pipeline', event, { ...data, surface: 'tui-slash' }, { level }),
        readLine: async () => '',
        readClarification: (clarification) => readDashboardAskClarification(clarification, ctx.surfaceUx, (line) => {
          ctx.pushChatLine(line);
          ctx.setChatScrollOffset(-1);
          ctx.draw();
        }),
        readFile: (file) => readFileSync(file, 'utf8'),
        writeFile: (file, data) => writeFileSync(file, data, 'utf8'),
        cwd: () => process.cwd(),
        now: () => Date.now(),
        isInteractive: () => ctx.surfaceUx !== undefined,
        selfResolveClarification: (await import('../../self-implement/goal-author-clarification.js')).defaultGoalAuthorSelfResolve,
        writeGoalDocument: (await import('../../self-implement/goal-document-write.js')).writeGoalDocumentAtomic,
        buildPreflightDeps: askIo.buildAskPreflightDeps,
        priorBlockSamples: () => askIo.priorBlockSamplesFrom(rows),
        recentAuthoringSamples: () => askIo.recentAuthoringSamplesFrom(rows),
        authorGoal: async (authorArgs, options) => {
          const { runGoalAuthorCli } = await import('../../self-implement/goal-author-cli.js');
          return runGoalAuthorCli([...authorArgs], {
            ...options,
            onProgress: (phase: 'ground' | 'enhance' | 'assemble' | 'lint', event: 'start' | 'end') => {
              if (event !== 'start') return;
              ctx.chatLines.push(`[goal-author] ${phase} started`);
              ctx.setChatScrollOffset(-1);
              ctx.draw();
            },
          } as never);
        },
        relativeToCwd: (file) => relative(process.cwd(), file),
      });
      if (result.kind === 'launch') {
        ctx.chatLines.push(ctx.accent(`  ✅ 전제 검사 통과 — 골: ${result.goalFile}`));
        const { resolveObserveOnlyDecision } = await import('../../self-implement/observe-only.js');
        if (resolveObserveOnlyDecision().enabled) {
          ctx.chatLines.push(ctx.muted('  관측 전용이라 런을 발사하지 않았습니다 · 코드도 안 바꿨습니다'));
          ctx.chatLines.push(ctx.muted('     조회: elanous logs --category self-implement --since 10m'));
          return;
        }
        // ⭐ 런을 «띄운다» — detached 라 이 TUI 를 닫아도 런은 산다.
        //   ⛔ spawn 을 여기서 새로 쓰지 않는다 — `launchDevGoalFileDetached` «한 자리»가 인자·env 를 갖는다.
        //   ⛔ 그리고 「띄웠다」와 「끝났다」는 다른 값이다 — 이 표면은 «띄운 것»까지만 말한다.
        try {
          const { launchDevGoalFileDetached } = await import('../../self-implement/seams.js');
          await launchDevGoalFileDetached({ goalFile: result.goalFile });
          ctx.chatLines.push(ctx.accent('  🚀 런을 띄웠다(백그라운드) — 이 화면을 닫아도 계속 돈다'));
          ctx.chatLines.push(ctx.muted('     관측: elanous logs --category self-implement --since 10m'));
        } catch (spawnError) {
          // ⛔ 조용히 「띄운 척」하지 않는다 — 못 띄웠으면 명령을 준다.
          ctx.chatLines.push(ctx.error(`  ✗ 런 기동 실패: ${spawnError instanceof Error ? spawnError.message : String(spawnError)}`));
          ctx.chatLines.push(ctx.warning(`  ▶ 손으로: bun bin/elanous.mjs dev --file ${result.goalFile}`));
        }
      } else if (result.kind === 'stopped-before-authoring') {
        ctx.chatLines.push(ctx.error('  ⛔ 저작 «전» 예비 검사에서 막혔다 — 위 이름을 확인하라'));
      } else {
        ctx.chatLines.push(ctx.error(`  ⛔ 전제 검사에서 막혔다 — 골은 남아 있다: ${result.goalFile}`));
      }
        } catch (error) {
          ctx.chatLines.push(ctx.error(`  ✗ /ask 실패: ${error instanceof Error ? error.message : String(error)}`));
        } finally {
          ctx.setChatScrollOffset(-1);
          ctx.draw();
        }
      })();
    }
  });

  registerMissionSlash(registry);

  // ── B-1.i ─────────────────────────────────────────────────────────

  // ── B-3.d ─────────────────────────────────────────────────────────

  // ⛔⭐ 형제들이 «전부» 이 레지스트리로 옮겨 왔다(index.ts 의 옛 switch 위 주석이 그 이력이다).
  //    🩸 `/ad` 를 그 «비워 가는» switch 에 꽂았다가 여기로 옮겼다 — 새 명령은 처음부터 여기다.
  registry.register('ad', async (args, ctx) => {
    await ctx.ad.run(args);
    ctx.setChatScrollOffset(-1);
  });

  // ── B-3.c.2 ───────────────────────────────────────────────────────

  registerTermSlash(registry);

  // ── B-3.c.1 ───────────────────────────────────────────────────────

  registry.register(['local', 'll'], async (args, ctx) => {
    // Local LLM slash handler — mirrors `elanous local <sub>` but stays
    // inside the dashboard. Subcommands:
    //   /local               — status + hint
    //   /local status        — same as /local
    //   /local ping          — GET /v1/models on configured endpoint
    //   /local models        — list models served
    //   /local test          — full compat matrix (fail-visible)
    //   /local use           — activate provider=local in user-config
    //
    // No new ctx fields — the only host-local refs are chatLines /
    // chatScrollOffset (already in ctx) + getUserConfig / saveUserConfig
    // / reloadUserConfig (already module-level static imports).
    // resolveLocalEndpoints + runLocalLLMCompat hoisted from dynamic to
    // static imports here.
    const loSub = (args[0] ?? '').toLowerCase();
    const cfgNow = getUserConfig();
    const curUrl = cfgNow.llm.baseUrl ?? process.env['LOCAL_LLM_URL'] ?? '';
    const curModel = cfgNow.llm.model ?? process.env['LOCAL_LLM_MODEL'] ?? '';

    if (!loSub || loSub === 'status') {
      ctx.chatLines.push('');
      ctx.chatLines.push(ctx.accent('❯ /local  (OpenAI-compatible endpoint)'));
      ctx.chatLines.push(`  provider : ${cfgNow.llm.provider === 'local' ? ctx.success('local (active)') : ctx.muted(cfgNow.llm.provider)}`);
      ctx.chatLines.push(`  baseUrl  : ${curUrl ? ctx.text(curUrl) : ctx.warning('(unset)')}`);
      ctx.chatLines.push(`  model    : ${curModel ? ctx.text(curModel) : ctx.warning('(unset)')}`);
      ctx.chatLines.push(ctx.muted('  subcommands: /local ping | models | test | use'));
      ctx.setChatScrollOffset(-1);
      return;
    }

    if (loSub === 'use') {
      // Switch provider to local without touching baseUrl/model (leave
      // them alone so the user doesn't lose a working config just by
      // running /local use). Requires both fields present — otherwise
      // getProviderForConfig will throw on the first turn.
      if (!curUrl || !curModel) {
        ctx.chatLines.push(ctx.warning('  Cannot activate — `baseUrl` or `model` is unset.'));
        ctx.chatLines.push(ctx.muted('  Run `elanous local setup --url … --model …` first.'));
        ctx.setChatScrollOffset(-1);
        return;
      }
      const nextCfg = { ...cfgNow, llm: { ...cfgNow.llm, provider: 'local' as const } };
      saveUserConfig(nextCfg);
      reloadUserConfig();
      ctx.chatLines.push(ctx.success(`  ✓ provider → local  (${curModel} @ ${curUrl})`));
      ctx.setChatScrollOffset(-1);
      return;
    }

    if (loSub === 'ping') {
      if (!curUrl) {
        ctx.chatLines.push(ctx.warning('  No baseUrl configured. `elanous local setup --url …` first.'));
        ctx.setChatScrollOffset(-1);
        return;
      }
      const { models } = resolveLocalEndpoints(curUrl);
      const t0 = Date.now();
      try {
        const res = await fetch(models, { signal: AbortSignal.timeout(10_000) });
        const ms = Date.now() - t0;
        if (!res.ok) {
          ctx.chatLines.push(ctx.error(`  ✗ HTTP ${res.status} (${ms}ms)`));
        } else {
          const body = await res.json() as { data?: unknown[] };
          const n = Array.isArray(body.data) ? body.data.length : 0;
          ctx.chatLines.push(ctx.success(`  ✓ ${models} → ${n} model(s), ${ms}ms`));
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.chatLines.push(ctx.error(`  ✗ ${msg}`));
      }
      ctx.setChatScrollOffset(-1);
      return;
    }

    if (loSub === 'models') {
      if (!curUrl) {
        ctx.chatLines.push(ctx.warning('  No baseUrl configured.'));
        ctx.setChatScrollOffset(-1);
        return;
      }
      const { models } = resolveLocalEndpoints(curUrl);
      try {
        const res = await fetch(models, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) {
          ctx.chatLines.push(ctx.error(`  HTTP ${res.status}`));
        } else {
          const body = await res.json() as { data?: Array<{ id: string }> };
          const list = Array.isArray(body.data) ? body.data : [];
          ctx.chatLines.push(ctx.accent(`  ${list.length} model(s)`));
          for (const m of list.slice(0, 20)) {
            const active = m.id === curModel ? ctx.success('▸ ') : '  ';
            ctx.chatLines.push(`${active}${m.id}`);
          }
          if (list.length > 20) ctx.chatLines.push(ctx.muted(`  … and ${list.length - 20} more`));
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.chatLines.push(ctx.error(`  ${msg}`));
      }
      ctx.setChatScrollOffset(-1);
      return;
    }

    if (loSub === 'test') {
      if (!curUrl || !curModel) {
        ctx.chatLines.push(ctx.warning('  Need baseUrl + model. `elanous local setup …` first.'));
        ctx.setChatScrollOffset(-1);
        return;
      }
      ctx.chatLines.push(ctx.muted(`  running compat matrix against ${curUrl} …`));
      // Flush these lines before the long probe starts so the user
      // sees something while tests run.
      ctx.setChatScrollOffset(-1);
      try {
        const summary = await runLocalLLMCompat({
          baseUrl: curUrl,
          model: curModel,
          timeoutMs: 60_000,
          onProgress: (r) => {
            const glyph = r.status === 'pass' ? ctx.success('✓')
                        : r.status === 'fail' ? ctx.error('✗')
                        : ctx.muted('·');
            const ms = r.ms > 0 ? `${r.ms}ms`.padStart(6) : '      ';
            ctx.chatLines.push(`  ${glyph} ${r.label.padEnd(24)}  ${ms}  ${ctx.muted(r.detail ?? '')}`);
          },
        });
        const { pass, fail, skip } = summary.counts;
        const line = `total ${summary.results.length}  pass=${pass}  fail=${fail}  skip=${skip}  (${summary.totalMs}ms)`;
        ctx.chatLines.push(fail > 0 ? ctx.warning('  ' + line) : ctx.success('  ' + line));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.chatLines.push(ctx.error(`  ${msg}`));
      }
      ctx.setChatScrollOffset(-1);
      return;
    }

    ctx.chatLines.push(ctx.warning(`  unknown /local subcommand: ${loSub}`));
    ctx.chatLines.push(ctx.muted('  try: /local [status] | ping | models | test | use'));
    ctx.setChatScrollOffset(-1);
  });


  registerShellSlash(registry);

  // ── B-3.b ─────────────────────────────────────────────────────────

  registry.register(['session', 'sess'], async (args, ctx) => {
    // Session resume — the laptop half of the handoff cycle. After a
    // mobile Telegram turn appended to the attached session's JSONL,
    // the TUI needs a way to pull that transcript back into its
    // in-memory chat.history so the next turn has full cross-device
    // context.
    //
    // Subcommands:
    //   /session list            recent sessions + binding markers
    //   /session load <prefix>   replace chat.history w/ session JSONL
    //   /session sync            reload currently-attached session
    //   /session new             clear chat.history + detach (if any)
    //   /session fork            copy current transcript into a new id
    //
    // Originally inline; the session/index.js + acp-boot.js + replay-
    // preview.js helpers are now static-imported in this module.
    // Host-local refs (attachedSessionId / attachedChatId mutable +
    // opts.remote ref + dashboardAcpSession.swapTo)
    // are threaded via ctx.sessionSlash + the four top-level
    // get/setAttached* fields.
    const seSub = (args[0] ?? 'list').toLowerCase();
    const remote = ctx.sessionSlash.remoteDaemon();

    if (seSub === 'list' || seSub === 'ls') {
      const limit = args[1] ? Math.max(1, Math.min(50, Number(args[1]) || 10)) : 10;
      const rows = sessionListSessions({ limit });
      // Tier 1 daemon merge — when attached to a remote daemon w/ a
      // derivable HTTP base, fetch the daemon's session list too so
      // the user sees web/PWA/other-client sessions alongside their
      // local TUI ones. Read-only · best-effort (silent on REST fail).
      let daemonRows: { id: string; msgCount: number; lastTurnAt: string }[] = [];
      if (remote) {
        const httpBase = deriveDaemonHttpBase(remote.url);
        if (httpBase) {
          const fetched = await fetchDaemonSessionList(httpBase, remote.token);
          if (fetched) daemonRows = fetched;
        }
      }
      const attached = ctx.getAttachedSessionId();
      ctx.chatLines.push('');
      ctx.chatLines.push(ctx.accent(`❯ /session list  (TUI ${rows.length}${daemonRows.length > 0 ? ` · daemon ${daemonRows.length}` : ''})`));
      if (rows.length === 0 && daemonRows.length === 0) {
        ctx.chatLines.push(ctx.muted('  (no sessions yet)'));
      } else {
        for (const m of rows) {
          const isAttached = m.id === attached;
          const marker = isAttached ? ctx.success('▸') : ' ';
          const binds: string[] = [];
          if (m.bindings?.cli) binds.push('cli');
          if (m.bindings?.telegram) binds.push(`tg:${m.bindings.telegram.chatId}`);
          if (m.bindings?.discord) binds.push(`dc:${m.bindings.discord.channelId}`);
          const bindStr = binds.length > 0 ? ctx.subtext(`[${binds.join(' ')}]`) : '';
          const ts = m.updatedAt.slice(5, 16).replace('T', ' ');
          const title = (m.title || '(no title)').slice(0, 48);
          ctx.chatLines.push(`  ${marker} ${ctx.text(m.id.slice(0, 8))}  ${ctx.muted(ts)}  ${ctx.muted(`${m.messageCount}t`.padStart(4))}  ${bindStr.padEnd(10)}  ${title}`);
        }
      }
      if (daemonRows.length > 0) {
        ctx.chatLines.push(ctx.subtext('  ── daemon ──'));
        for (const d of daemonRows.slice(0, limit)) {
          const ts = d.lastTurnAt.slice(5, 16).replace('T', ' ');
          const tag = ctx.subtext('[daemon]');
          ctx.chatLines.push(`    ${ctx.text(d.id)}  ${ctx.muted(ts)}  ${ctx.muted(`${d.msgCount}t`.padStart(4))}  ${tag}`);
        }
        ctx.chatLines.push(ctx.muted('  daemon resume: restart with `--resume <id>` or ELANOUS_RESUME_SESSION=<id>'));
      } else {
        ctx.chatLines.push(ctx.muted('  /session load <prefix> to resume'));
      }
      ctx.setChatScrollOffset(-1);
      return;
    }

    if (seSub === 'load' || seSub === 'resume') {
      const prefix = args[1];
      if (!prefix) {
        ctx.chatLines.push(ctx.warning('  usage: /session load <id-prefix>'));
        ctx.setChatScrollOffset(-1);
        return;
      }
      let resolvedId: string | null = null;
      let resolveErr: string | null = null;
      try {
        resolvedId = sessionResolveId(prefix);
      } catch (err: unknown) {
        resolveErr = err instanceof Error ? err.message : String(err);
      }
      // Critical-junction debug log — `/resume` failures were opaque
      // without this. Records the prefix, the local TUI session-store
      // result, and whether the dashboard is attached to a daemon
      // (so future log dives can correlate "no match" with "session
      // lives in daemon storage, not TUI storage" without re-running).
      if (debug.enabled) {
        debug.log('chat.session.load.resolve', resolvedId ?? '(none)', {
          prefix,
          resolved: resolvedId,
          error: resolveErr,
          attachedSessionId: ctx.getAttachedSessionId(),
          daemon: remote ? `remote:${remote.url}` : 'in-process',
        });
      }
      if (resolveErr) {
        ctx.chatLines.push(ctx.error(`  ${resolveErr}`));
        ctx.setChatScrollOffset(-1);
        return;
      }
      if (!resolvedId) {
        // BACKLOG #2 — mid-flight swap to a daemon-side session. The
        // prefix didn't resolve in the TUI store, but if we're
        // attached to a remote daemon its `/v1/sessions` listing
        // might know it. On match, swap the active ACP session via
        // the existing connection (no restart) and replay history
        // into chat.history — same shape as the boot-time
        // `ELANOUS_RESUME_SESSION` path.
        if (remote) {
          const httpBase = deriveDaemonHttpBase(remote.url);
          if (httpBase) {
            const daemonList = await fetchDaemonSessionList(httpBase, remote.token);
            const match = daemonList?.find(
              (s) => s.id === prefix || s.id.startsWith(prefix),
            );
            if (debug.enabled) {
              debug.log('chat.session.load.daemon-match', match?.id ?? '(none)', {
                prefix,
                daemonCandidates: daemonList?.length ?? 0,
                matched: match?.id ?? null,
              });
            }
            if (match) {
              // Try swap first; fetch history only on success so a
              // rejected loadSession doesn't wipe chat.history.
              let swapErr: string | null = null;
              try {
                await ctx.sessionSlash.acpSwapTo(match.id, getSessionCwd());
              } catch (err: unknown) {
                swapErr = err instanceof Error ? err.message : String(err);
              }
              if (swapErr) {
                ctx.chatLines.push(ctx.error(`  ✗ daemon resume failed: ${swapErr}`));
                ctx.chatLines.push(ctx.muted(`    keeping current session; try /session list for valid ids.`));
                ctx.setChatScrollOffset(-1);
                return;
              }
              // Swap succeeded — replay history if the daemon exposes
              // it via REST; an empty history just leaves chat.history
              // as-is (no destructive wipe on miss).
              const past = await fetchDaemonSessionHistory(httpBase, match.id, remote.token);
              const chatHistory = ctx.compactSlash.chatHistory;
              if (past && past.length > 0) {
                const sysFromDash = chatHistory.find((m) => m.role === 'system');
                chatHistory.length = 0;
                if (sysFromDash) chatHistory.push(sysFromDash);
                for (const m of past) {
                  if (m.role === 'system' && sysFromDash && m.content === sysFromDash.content) continue;
                  chatHistory.push(m as ChatMessage);
                }
              }
              ctx.setAttachedSessionId(match.id);
              try { sessionSetActiveId(match.id); } catch { /* best-effort */ }
              ctx.chatLines.push('');
              ctx.chatLines.push(ctx.success(`  ✓ swapped to daemon session ${match.id}`));
              if (past && past.length > 0) {
                ctx.chatLines.push(ctx.muted(`    ${past.length} turn${past.length === 1 ? '' : 's'} restored. Preview of last 5:`));
                const swapPreviewWidth = Math.max(40, termSize().cols - 8);
                const swapPreviewWrap = getUserConfig().chat.rendering.wrap;
                const swapPreviewLines = renderReplayPreviewLines(past, {
                  maxWidth: swapPreviewWidth,
                  wrapOpts: swapPreviewWrap,
                });
                for (const line of swapPreviewLines) ctx.chatLines.push(line);
              } else {
                ctx.chatLines.push(ctx.muted(`    history not available over REST — next turn continues this conversation.`));
              }
              ctx.chatLines.push(ctx.muted(`    Next turn continues this conversation.`));
              ctx.setChatScrollOffset(-1);
              return;
            }
          }
        }
        ctx.chatLines.push(ctx.warning(`  No session matches prefix "${prefix}"`));
        if (remote) {
          const daemonNote = `remote daemon ${remote.url}`;
          ctx.chatLines.push(ctx.muted(`    note: TUI's /session store is local-only.`));
          ctx.chatLines.push(ctx.muted(`    sessions minted by web/PWA or other clients live on the ${daemonNote},`));
          ctx.chatLines.push(ctx.muted(`    not in TUI storage — full daemon-side resume is a follow-up.`));
        } else {
          ctx.chatLines.push(ctx.muted(`    try /session list to see known sessions.`));
        }
        ctx.setChatScrollOffset(-1);
        return;
      }
      const loaded = sessionHistoryFromId(resolvedId);
      if (!loaded) {
        ctx.chatLines.push(ctx.error(`  Failed to load session ${resolvedId.slice(0, 8)}`));
        ctx.setChatScrollOffset(-1);
        return;
      }
      // Replace in-memory history (preserve the system prompt the
      // dashboard was constructed with — the loaded session's system
      // messages go on TOP of the existing ones so the TUI's stock
      // prompt stays as the base).
      const chatHistory = ctx.compactSlash.chatHistory;
      const sysFromDash = chatHistory.find(m => m.role === 'system');
      chatHistory.length = 0;
      if (sysFromDash) chatHistory.push(sysFromDash);
      for (const h of loaded.history) {
        if (h.role === 'system' && sysFromDash && h.content === sysFromDash.content) continue;
        chatHistory.push(h);
      }
      // Also mark as "the session I'm now attached to" for future
      // /session sync calls. This does NOT touch telegram bindings —
      // that's what /telegram attach is for.
      ctx.setAttachedSessionId(resolvedId);
      // Mirror to the persistent active-session marker so Telegram-
      // side /attach (no-arg) picks up the same session automatically.
      try { sessionSetActiveId(resolvedId); } catch { /* best-effort */ }
      ctx.chatLines.push('');
      ctx.chatLines.push(ctx.success(`  ✓ loaded session ${resolvedId.slice(0, 8)}  (${loaded.meta.title || '(no title)'})`));
      ctx.chatLines.push(ctx.muted(`    ${loaded.history.length} turns restored. Preview of last 5:`));
      const loadPreviewWidth = Math.max(40, termSize().cols - 8);
      const loadPreviewWrap = getUserConfig().chat.rendering.wrap;
      const loadPreviewLines = renderReplayPreviewLines(loaded.history, {
        maxWidth: loadPreviewWidth,
        wrapOpts: loadPreviewWrap,
      });
      for (const line of loadPreviewLines) ctx.chatLines.push(line);
      ctx.chatLines.push(ctx.muted(`    Next turn continues this conversation.`));
      ctx.setChatScrollOffset(-1);
      return;
    }

    if (seSub === 'sync' || seSub === 'refresh') {
      const attached = ctx.getAttachedSessionId();
      if (!attached) {
        ctx.chatLines.push(ctx.warning('  No session attached. Run /session load <prefix> or /telegram attach first.'));
        ctx.setChatScrollOffset(-1);
        return;
      }
      const loaded = sessionHistoryFromId(attached);
      if (!loaded) {
        ctx.chatLines.push(ctx.error(`  Session ${attached.slice(0, 8)} not found — clearing attachment.`));
        ctx.setAttachedSessionId(null);
        ctx.setAttachedChatId(null);
        ctx.setChatScrollOffset(-1);
        return;
      }
      const chatHistory = ctx.compactSlash.chatHistory;
      const prevLen = chatHistory.filter(m => m.role !== 'system').length;
      const sysFromDash = chatHistory.find(m => m.role === 'system');

      // Tier 1 Phase 3 양방향 sync — when attached to a remote daemon,
      // also fetch the daemon's view of this session via REST. PWA /
      // Telegram turns that bypassed the TUI's local jsonl (the
      // typical handoff case) live on the daemon side only; without
      // this fetch /session sync would miss them. When the daemon's
      // history is longer than the local one we adopt it as
      // authoritative for the in-memory chat.history.
      let daemonHist: typeof loaded.history | null = null;
      if (remote) {
        const httpBase = deriveDaemonHttpBase(remote.url);
        if (httpBase) {
          const fetched = await fetchDaemonSessionHistory(httpBase, attached, remote.token);
          if (fetched && fetched.length > loaded.history.length) {
            // Coerce LLMMessage shape to the dashboard's history type.
            // ts/turn_id fields are added on local-side appendMessage
            // paths; daemon's jsonl carries plain LLMMessage so we
            // synth missing metadata.
            daemonHist = fetched.map((m) => ({
              role: m.role,
              content: typeof m.content === 'string' ? m.content : '',
            })) as unknown as typeof loaded.history;
          }
        }
      }
      const sourceHist = daemonHist ?? loaded.history;

      chatHistory.length = 0;
      if (sysFromDash) chatHistory.push(sysFromDash);
      for (const h of sourceHist) {
        if (h.role === 'system' && sysFromDash && h.content === sysFromDash.content) continue;
        chatHistory.push(h);
      }
      const newLen = sourceHist.filter((h) => h.role !== 'system').length;
      const delta = newLen - prevLen;
      const sourceLabel = daemonHist ? 'daemon' : 'mobile';
      ctx.chatLines.push(delta > 0
        ? ctx.success(`  ✓ synced — ${delta} new turn${delta > 1 ? 's' : ''} from ${sourceLabel}`)
        : ctx.muted(`  ✓ synced — already up to date (${newLen} turns)`));
      ctx.setChatScrollOffset(-1);
      return;
    }

    if (seSub === 'new' || seSub === 'clear') {
      // 🪪 L2-lite — 비우기 «전»에 이 대화의 «지난 세션»을 자리 로컬 지시에 남긴다(실패해도 진행).
      try {
        recordSeatSessionEnd(seSub === 'new' ? 'session-new' : 'session-clear');
      } catch { /* 기록이 새 대화를 막지 않는다 */ }
      // TUI-LOOP-COMMAND — 세션이 끝나면 이 세션의 /loop 도 같이 멈춘다
      // (칸 경계: stop on /loop stop or session end · /session 의 나머지
      // 동작은 그대로다).
      const endedLoop = ctx.loopCommand?.schedulerRef.current;
      if (endedLoop?.isRunning()) {
        endedLoop.stop();
        ctx.loopCommand!.schedulerRef.current = null;
      }
      if (seSub === 'new') {
        try {
          const { suggestProjectForFolder } = await import('../../project/project-store.js');
          const project = suggestProjectForFolder(process.cwd());
          if (project) ctx.chatLines.push(ctx.muted(`  Project suggestion: ${project.name} (${project.id})`));
        } catch { /* suggestions must not interrupt a new conversation */ }
      }
      // Clear the in-memory history and detach if attached. Doesn't
      // delete any session files — those stay on disk for
      // /session list to enumerate.
      const attached = ctx.getAttachedSessionId();
      if (attached) {
        try { sessionDetachTelegram(attached); } catch { /* ignore */ }
      }
      const prev = attached;
      ctx.setAttachedSessionId(null);
      ctx.setAttachedChatId(null);
      ctx.chatPersona?.newConversation?.();
      const chatHistory = ctx.compactSlash.chatHistory;
      const sysFromDash = chatHistory.find(m => m.role === 'system');
      chatHistory.length = 0;
      if (sysFromDash) chatHistory.push(sysFromDash);
      ctx.chatLines.push(ctx.success(prev
        ? `  ✓ cleared history + detached ${prev.slice(0, 8)}`
        : `  ✓ cleared history`));
      // 🪪 L1 — 새 대화 = 새 자리 부트 카드.
      //   ⛔ 정적 import · 동기 호출 — history 를 비운 «같은 틱»에 카드 캐시를 비운다(비동기 대기 틈에 새 턴이 옛 카드를 읽지 않게).
      //   ⛔ 아래 ACP renew(await) «앞»에 둔다 — 그 대기 틈도 같은 틈이다(HARD #2 회귀 · #28520).
      try {
        startSeatBootConversation({ reason: seSub === 'new' ? 'session-new' : 'session-clear' });
        markSeatConversationStarted();
      } catch { /* 부트 카드가 새 대화를 막지 않는다 */ }
      // TUI-H8 ② — 백엔드(ACP) 세션도 새로(종전엔 sessionId 가 그대로라 서버 쪽 세션 상태가 이어졌다 · #69).
      if (seSub === 'new' && ctx.sessionSlash.acpRenew) {
        try {
          const renewed = await ctx.sessionSlash.acpRenew(getSessionCwd());
          ctx.chatLines.push(ctx.muted(`    new backend session: ${renewed}`));
          observeSessionStart({ surface: 'tui', origin: 'new', reason: 'session-new', sessionId: renewed });
        } catch (error) {
          // 실패해도 TUI 기록은 이미 비웠다 — 다음 턴은 옛 백엔드 세션으로 간다는 것을 보이고 남긴다.
          ctx.chatLines.push(ctx.warning(`  ⚠ backend session renew failed: ${error instanceof Error ? error.message : String(error)}`));
          try { debug.log('session', 'renew-failed', { surface: 'tui', error: String(error) }); } catch { /* best-effort */ }
        }
      }
      ctx.setChatScrollOffset(-1);
      return;
    }

    if (seSub === 'fork') {
      await ctx.forkAttachedSessionFromChatHistory();
      ctx.setChatScrollOffset(-1);
      return;
    }

    ctx.chatLines.push(ctx.warning(`  unknown /session subcommand: ${seSub}`));
    ctx.chatLines.push(ctx.muted('  try: /session list | load <prefix> | sync | new | fork'));
    ctx.setChatScrollOffset(-1);
  });

  registry.register(['telegram', 'tg'], async (args, ctx) => {
    // Telegram bot controls inside the TUI. Delegates the heavy lifting
    // (pair wizard, actual daemon) to the CLI via child_process so we
    // don't rebuild that flow here — the slash command's job is
    // discoverability + quick status checks without quitting the
    // dashboard.
    //
    // Static-imported helpers: telegramSafeReadLock +
    // telegramDefaultLockPath + userConfigPathFn + pathDirname (for
    // lock path resolution). TelegramBot loaded via dynamic import
    // since it's only needed for send + attach-nudge.
    const tgSub = (args[0] ?? '').toLowerCase();
    const lockPath = telegramDefaultLockPath(pathDirname(userConfigPathFn()));

    if (!tgSub || tgSub === 'status') {
      const cfg = getUserConfig();
      const lock = telegramSafeReadLock(lockPath);
      const attached = ctx.getAttachedSessionId();
      const attachedChat = ctx.getAttachedChatId();
      ctx.chatLines.push(ctx.accent('Telegram status'));
      ctx.chatLines.push(`  enabled      ${cfg.telegram.enabled ? ctx.success('yes') : ctx.muted('no')}`);
      ctx.chatLines.push(`  tokenSet     ${cfg.telegram.botToken ? ctx.success('yes') : ctx.warning('no')}`);
      ctx.chatLines.push(`  allowedUsers ${cfg.telegram.allowedUsers.join(', ') || ctx.muted('(none)')}`);
      ctx.chatLines.push(`  homeChannel  ${cfg.telegram.homeChannel ?? ctx.muted('(none)')}  ${ctx.muted('(Q&A)')}`);
      ctx.chatLines.push(`  reportChannel ${cfg.telegram.reportChannel
        ? `${cfg.telegram.reportChannel.chatId}${cfg.telegram.reportChannel.botToken ? ctx.muted(' (own bot)') : ctx.muted(' (main bot)')}`
        : ctx.muted('(none)')}`);
      if (lock) {
        ctx.chatLines.push(`  ${ctx.success('● running')}   pid=${lock.pid} (${lock.label ?? '?'}) since ${lock.startedAt}`);
      } else {
        ctx.chatLines.push(`  ${ctx.muted('○ idle')}      no daemon running`);
      }
      ctx.chatLines.push(`  handoff      ${attached
        ? ctx.success(`▸ session ${attached.slice(0, 8)} → chat ${attachedChat}`)
        : ctx.muted('(not attached)')}`);
      ctx.chatLines.push(ctx.muted('  /telegram pair | send <chat> <text> | report <text> | pause | stop'));
      ctx.chatLines.push(ctx.muted('  /telegram attach [chatId] | detach | sessions   (handoff to mobile)'));
      ctx.chatLines.push(ctx.muted('  (start the daemon with `elanous telegram on` from a shell — the dashboard doesn\'t host it)'));
      ctx.setChatScrollOffset(-1);
      return;
    }

    if (tgSub === 'attach') {
      // Take a snapshot of the current in-memory chat.history,
      // persist it as a fresh session JSONL, and bind that session
      // to the target Telegram chat (default: the configured
      // homeChannel). From this point on every completed turn
      // mirrors to the JSONL — so the mobile client sees full
      // context on first reply.
      const cfgA = getUserConfig();
      const explicitChat = args[1] ? Number(args[1]) : undefined;
      const chatTarget = explicitChat ?? cfgA.telegram.homeChannel;
      if (!chatTarget || !Number.isFinite(chatTarget)) {
        ctx.chatLines.push(ctx.warning('  No target chat — pass /telegram attach <chatId> or set telegram.homeChannel first.'));
        ctx.setChatScrollOffset(-1);
        return;
      }
      const attached = ctx.getAttachedSessionId();
      if (attached) {
        ctx.chatLines.push(ctx.warning(`  Already attached to session ${attached.slice(0, 8)} → chat ${ctx.getAttachedChatId()}. /telegram detach first.`));
        ctx.setChatScrollOffset(-1);
        return;
      }
      try {
        const chatHistory = ctx.compactSlash.chatHistory;
        // Title: first user line (or fallback) truncated.
        const firstUser = chatHistory.find(m => m.role === 'user');
        const title = firstUser && typeof firstUser.content === 'string'
          ? firstUser.content.replace(/\s+/g, ' ').slice(0, 60)
          : '(handoff)';
        const active = inspectActiveProvider();
        const meta = sessionCreate({
          source: 'cli',
          provider: active.provider,
          model: active.model,
          title,
        });
        // Snapshot in-memory history into the JSONL so the first
        // Telegram reply has full context to respond to.
        const nowTs = new Date().toISOString();
        for (const m of chatHistory) {
          if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'system') continue;
          const content = typeof m.content === 'string' ? m.content : '';
          if (!content) continue;
          sessionAppendMessage(meta.id, { role: m.role, content, ts: nowTs });
        }
        sessionAttachTelegram(meta.id, chatTarget);
        if (ctx.chatPersona) {
          const selected = ctx.chatPersona.selection.get(ctx.chatPersona.sessionId());
          if (selected) ctx.chatPersona.selection.set(meta.id, selected);
        }
        ctx.setAttachedSessionId(meta.id);
        ctx.setAttachedChatId(chatTarget);
        ctx.chatLines.push(ctx.success(`  ✓ attached session ${meta.id.slice(0, 8)} → chat ${chatTarget}  (${chatHistory.length} turns mirrored)`));
        ctx.chatLines.push(ctx.muted(`    New Telegram messages to that chat will continue this conversation.`));
        // Nudge Telegram side so the user knows handoff is live.
        if (cfgA.telegram.botToken) {
          try {
            const { TelegramBot: _TB } = await import('../../telegram.js');
            const bot = new _TB({ token: cfgA.telegram.botToken, allowedUsers: [], onMessage: async () => undefined });
            await bot.sendMessage(
              chatTarget,
              `🤝 **Handoff from laptop**\n_Session \`${meta.id.slice(0, 8)}\` (${title})_\nReply here to continue where the desktop left off.`,
              { markdown: true },
            );
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            ctx.chatLines.push(ctx.warning(`    (nudge failed: ${msg})`));
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.chatLines.push(ctx.error(`  attach failed: ${msg}`));
      }
      ctx.setChatScrollOffset(-1);
      return;
    }

    if (tgSub === 'detach') {
      const attached = ctx.getAttachedSessionId();
      if (!attached) {
        ctx.chatLines.push(ctx.muted('  Not attached — nothing to detach.'));
        ctx.setChatScrollOffset(-1);
        return;
      }
      try {
        sessionDetachTelegram(attached);
        const id = attached;
        const chatTarget = ctx.getAttachedChatId();
        ctx.setAttachedSessionId(null);
        ctx.setAttachedChatId(null);
        ctx.chatLines.push(ctx.success(`  ✓ detached session ${id.slice(0, 8)} from chat ${chatTarget}`));
        ctx.chatLines.push(ctx.muted(`    Future TUI turns stop mirroring. Next Telegram message to chat ${chatTarget} starts a fresh session.`));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.chatLines.push(ctx.error(`  detach failed: ${msg}`));
      }
      ctx.setChatScrollOffset(-1);
      return;
    }

    if (tgSub === 'sessions') {
      const bound = sessionListBound({ channel: 'telegram' });
      const attached = ctx.getAttachedSessionId();
      ctx.chatLines.push('');
      ctx.chatLines.push(ctx.accent('Telegram-attached sessions'));
      if (bound.length === 0) {
        ctx.chatLines.push(ctx.muted('  (none)'));
      } else {
        for (const m of bound) {
          const marker = m.id === attached ? ctx.success('▸') : ' ';
          const chatId = m.bindings?.telegram?.chatId;
          const title = m.title || '(no title)';
          ctx.chatLines.push(`  ${marker} ${ctx.text(m.id.slice(0, 8))}  chat ${chatId}  ${ctx.muted(`${m.messageCount} msgs`)}  ${ctx.subtext(title.slice(0, 40))}`);
        }
      }
      ctx.setChatScrollOffset(-1);
      return;
    }

    if (tgSub === 'pause') {
      // Symmetric counterpart to the CLI's `elanous telegram on`: flip
      // `enabled` off in user-config AND signal the daemon so the
      // next `elanous telegram run` also bails, not just the live one.
      // Keeping the token on file so unpause is a single config edit
      // (or re-run of `/telegram pair`).
      const cfg = getUserConfig();
      const lock0 = telegramSafeReadLock(lockPath);
      if (!cfg.telegram.enabled && !lock0) {
        ctx.chatLines.push(ctx.muted('  Already paused (enabled=false, no daemon running).'));
        ctx.setChatScrollOffset(-1);
        return;
      }
      try {
        if (cfg.telegram.enabled) {
          cfg.telegram.enabled = false;
          saveUserConfig(cfg);
          ctx.chatLines.push(ctx.success('  ✓ telegram.enabled = false (saved to user-config)'));
        }
        const lock = telegramSafeReadLock(lockPath);
        if (lock) {
          try {
            process.kill(lock.pid, 'SIGINT');
            ctx.chatLines.push(ctx.success(`  ✓ sent SIGINT to pid ${lock.pid} (${lock.label ?? '?'})`));
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            ctx.chatLines.push(ctx.warning(`  Could not signal pid ${lock.pid}: ${msg}`));
          }
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        ctx.chatLines.push(ctx.error(`  pause failed: ${msg}`));
      }
      ctx.setChatScrollOffset(-1);
      return;
    }

    if (tgSub === 'pair' || tgSub === 'setup') {
      ctx.chatLines.push(ctx.warning('  Pairing is interactive — please run `elanous telegram pair` in a separate terminal.'));
      ctx.chatLines.push(ctx.muted('  (The dashboard\'s textInput can\'t host the multi-line wizard cleanly.)'));
      ctx.setChatScrollOffset(-1);
      return;
    }

    if (tgSub === 'send') {
      const chat = Number(args[1] ?? '');
      const msg = args.slice(2).join(' ');
      if (!Number.isFinite(chat) || !msg) {
        ctx.chatLines.push(ctx.warning('  usage: /telegram send <chatId> <message…>'));
        ctx.setChatScrollOffset(-1);
        return;
      }
      const cfg = getUserConfig();
      if (!cfg.telegram.botToken) {
        ctx.chatLines.push(ctx.warning('  No bot token — run `/telegram pair` first.'));
        ctx.setChatScrollOffset(-1);
        return;
      }
      try {
        const { TelegramBot: _TB } = await import('../../telegram.js');
        const bot = new _TB({ token: cfg.telegram.botToken, allowedUsers: [], onMessage: async () => undefined });
        await bot.sendMessage(chat, msg);
        ctx.chatLines.push(ctx.success(`  ✓ sent to chat ${chat}`));
      } catch (e: unknown) {
        const m = e instanceof Error ? e.message : String(e);
        ctx.chatLines.push(ctx.error(`  send failed: ${m}`));
      }
      ctx.setChatScrollOffset(-1);
      return;
    }

    if (tgSub === 'report') {
      const msg = args.slice(1).join(' ');
      if (!msg) {
        ctx.chatLines.push(ctx.warning('  usage: /telegram report <message…>   (→ report channel)'));
        ctx.setChatScrollOffset(-1);
        return;
      }
      const cfg = ctx.telegramReport?.getConfig() ?? getUserConfig();
      const { resolveReportTarget, sendTelegramReport } = await import('../../telegram-report.js');
      const target = resolveReportTarget(cfg);
      if (!target) {
        ctx.chatLines.push(ctx.warning('  No report channel — set telegram.reportChannel.chatId (+ optional botToken) in config.'));
        ctx.setChatScrollOffset(-1);
        return;
      }
      try {
        await (ctx.telegramReport?.send ?? sendTelegramReport)(cfg, msg);
        ctx.chatLines.push(ctx.success(`  ✓ report sent to chat ${target.chatId}`));
      } catch (e: unknown) {
        const m = e instanceof Error ? e.message : String(e);
        ctx.chatLines.push(ctx.error(`  report failed: ${m}`));
      }
      ctx.setChatScrollOffset(-1);
      return;
    }

    if (tgSub === 'stop') {
      const lock = telegramSafeReadLock(lockPath);
      if (!lock) {
        ctx.chatLines.push(ctx.muted('  No daemon appears to be running.'));
      } else {
        try {
          process.kill(lock.pid, 'SIGINT');
          ctx.chatLines.push(ctx.success(`  ✓ sent SIGINT to pid ${lock.pid}`));
        } catch (e: unknown) {
          const m = e instanceof Error ? e.message : String(e);
          ctx.chatLines.push(ctx.error(`  Could not signal pid ${lock.pid}: ${m}`));
        }
      }
      ctx.setChatScrollOffset(-1);
      return;
    }

    ctx.chatLines.push(ctx.warning(`  unknown /telegram subcommand: ${tgSub}`));
    ctx.chatLines.push(ctx.muted('  try: /telegram [status] | pair | send <chat> <text> | pause | stop'));
    ctx.setChatScrollOffset(-1);
  });

  // ── B-3.a ─────────────────────────────────────────────────────────

  registry.register('log', async (args, ctx) => {
    // Log pane control. Routes through resolveDashboardChatMainLog
    // Command + resolveDashboardLog*Action helpers (all static-imported
    // above). Host-local state — heightBias / filter / search / freeze /
    // turnSeparator / foldMode / chatOnly — comes via ctx.logSlash.
    // Replies go to the chat buffer the person is looking at — never the
    // debug buffer, which the default layout does not draw.
    const logCommand = resolveDashboardChatMainLogCommand(args);
    if (debug.enabled) {
      debug.log('slash.log.handler', 'enter', {
        argsCount: args.length,
        args0: args[0] ?? null,
        kind: logCommand.kind,
        // unknown branch carries subcommand
        unknownSub: logCommand.kind === 'unknown' ? logCommand.subcommand : null,
      });
    }
    if (logCommand.kind === 'help') {
      const lines = dashboardLogHelpLines();
      for (const [index, line] of lines.entries()) {
        if (line === '') {
          emitReplyToChat(ctx, '');
        } else if (index === 0) {
          emitReplyToChat(ctx, ctx.accent(line));
        } else {
          emitReplyToChat(ctx, ctx.muted(line));
        }
      }
      ctx.setChatScrollOffset(-1);
      return;
    }
    if (logCommand.kind === 'size') {
      const action = resolveDashboardLogSizeAction(logCommand.delta, ctx.logSlash.getLogHeightBias());
      if (action.kind === 'invalid') {
        emitReplyToChat(ctx, ctx.warning(action.message));
      } else {
        ctx.logSlash.setLogHeightBias(action.nextBias);
        ctx.logSlash.recomputePaneHeight();
        emitReplyToChat(ctx, ctx.muted(action.message));
      }
      ctx.setChatScrollOffset(-1);
      return;
    }
    if (logCommand.kind === 'copy-all') {
      await ctx.logSlash.copyEntireLog();
      return;
    }
    if (logCommand.kind === 'return-to-input') {
      ctx.logSlash.returnFocusToInput();
      return;
    }
    if (logCommand.kind === 'clear') {
      ctx.chatLines.length = 0;
      ctx.attachmentRowMap.clear();
      ctx.clearLogSearch();
      ctx.clearLogFilter();
      emitReplyToChat(ctx, ctx.muted('Log cleared.'));
      ctx.setChatScrollOffset(-1);
      return;
    }
    if (logCommand.kind === 'filter') {
      const q = logCommand.query;
      const currentQuery = ctx.logSlash.getLogFilterQuery();
      const activeCount = ctx.chatLines.filter(
        line => stripAnsi(line).toLowerCase().includes((q || currentQuery).toLowerCase()),
      ).length;
      const action = resolveDashboardLogFilterAction(q, currentQuery, activeCount);
      if (action.kind === 'clear') {
        ctx.clearLogFilter();
        emitReplyToChat(ctx, ctx.muted(action.message));
      } else if (action.kind === 'show-status') {
        emitReplyToChat(ctx, ctx.muted(action.message));
      } else {
        ctx.logSlash.applyLogFilter(q);
        emitReplyToChat(ctx, ctx.muted(action.message));
        ctx.setChatScrollOffset(-1);
      }
      return;
    }
    if (logCommand.kind === 'search') {
      const q = logCommand.query;
      const action = resolveDashboardLogSearchAction(q);
      if (action.kind === 'clear') {
        ctx.clearLogSearch();
        emitReplyToChat(ctx, ctx.muted(action.message));
      } else if (action.kind === 'open-modal') {
        ctx.logSlash.openLogSearchModal();
      } else {
        ctx.logSlash.applyLogSearch(action.query);
        const count = ctx.logSlash.getLogSearchResultsCount();
        if (count === 0) {
          emitReplyToChat(ctx, ctx.muted(`  no matches for "${action.query}"`));
        } else {
          emitReplyToChat(ctx, ctx.muted(
            `  ${count} match${count === 1 ? '' : 'es'} for "${action.query}" — n / N to cycle, Esc to clear`,
          ));
          // Jump to the first one.
          const firstIdx = ctx.logSlash.firstSearchResultLineIdx();
          if (firstIdx !== null) ctx.logSlash.scrollToSearchLineIdx(firstIdx);
        }
      }
      // Original case had `chatScrollOffset = chatScrollOffset` no-op
      // — preserved here as no setChatScrollOffset call (intentional).
      return;
    }
    if (logCommand.kind === 'freeze') {
      if (!ctx.logSlash.isLogFreezeEnabled()) {
        emitReplyToChat(ctx, ctx.muted('  scroll-freeze DISABLED (ELANOUS_LOG_PAUSE_ON_SCROLL=0).'));
      } else {
        const frozenIdx = ctx.logSlash.getLogFrozenTailIndex();
        if (frozenIdx === null) {
          emitReplyToChat(ctx, ctx.muted('  scroll-freeze inactive — log tail is live.'));
        } else {
          const queued = Math.max(0, ctx.logSlash.chatLinesLength() - frozenIdx);
          emitReplyToChat(ctx, ctx.muted(`  scroll-freeze active — ${queued} line${queued === 1 ? '' : 's'} queued. Press G to resume.`));
        }
      }
      ctx.setChatScrollOffset(-1);
      return;
    }
    if (logCommand.kind === 'solo') {
      const next = ctx.logSlash.toggleSolo();
      const message = next
        ? '  log solo ON — chat-only layout active.'
        : '  log solo OFF — dashboard layout restored.';
      emitReplyToChat(ctx, ctx.muted(message));
      if (debug.enabled) {
        debug.log('slash.log.solo', next ? 'on' : 'off', {
          newChatOnlyMode: next,
        });
      }
      ctx.setChatScrollOffset(-1);
      return;
    }
    if (logCommand.kind === 'fold-all') {
      if (!ctx.logSlash.setAllFolds) {
        // A host without a fold controller cannot know whether anything is folded — say so, not «nothing».
        debug.log('log.fold', 'slash-set-all', { expanded: logCommand.expanded, changed: null, reason: 'no-fold-controller' });
        emitReplyToChat(ctx, ctx.warning('  fold controls are not available in this view'));
        ctx.setChatScrollOffset(-1);
        return;
      }
      const changed = ctx.logSlash.setAllFolds(logCommand.expanded);
      debug.log('log.fold', 'slash-set-all', { expanded: logCommand.expanded, changed });
      emitReplyToChat(ctx, ctx.muted(changed > 0
        ? `  ${logCommand.expanded ? 'unfolded' : 'folded'} ${changed} block${changed === 1 ? '' : 's'}`
        : `  (nothing to ${logCommand.expanded ? 'unfold' : 'fold'})`));
      ctx.setChatScrollOffset(-1);
      return;
    }
    if (logCommand.kind === 'fold') {
      const action = resolveDashboardLogFoldAction(logCommand.mode, ctx.logSlash.getLogFoldMode());
      if (action.kind === 'set-mode') {
        ctx.logSlash.setLogFoldMode(action.mode);
        emitReplyToChat(ctx, ctx.muted(action.message));
        ctx.setChatScrollOffset(-1);
        return;
      }
      emitReplyToChat(ctx, ctx.warning(action.message));
      emitReplyToChat(ctx, ctx.muted(action.usage));
      ctx.setChatScrollOffset(-1);
      return;
    }
    if (logCommand.kind === 'turn') {
      const action = resolveDashboardLogTurnAction(logCommand.arg, ctx.logSlash.getLogTurnSeparatorMode());
      if (action.kind === 'emit-now') {
        const prev = ctx.logSlash.getLogTurnSeparatorMode();
        ctx.logSlash.setLogTurnSeparatorMode(action.nextModeWhileEmitting);
        ctx.logSlash.pushTurnSeparator();
        ctx.logSlash.setLogTurnSeparatorMode(prev);
        ctx.setChatScrollOffset(-1);
        return;
      }
      if (action.kind === 'set-mode') {
        ctx.logSlash.setLogTurnSeparatorMode(action.mode);
        emitReplyToChat(ctx, ctx.muted(action.message));
        ctx.setChatScrollOffset(-1);
        return;
      }
      emitReplyToChat(ctx, ctx.muted(action.message));
      emitReplyToChat(ctx, ctx.muted(action.usage));
      ctx.setChatScrollOffset(-1);
      return;
    }
    emitReplyToChat(ctx, ctx.warning(`  Unknown /log subcommand: ${logCommand.subcommand}. Try /log help.`));
    ctx.setChatScrollOffset(-1);
  });

  registry.register('debug', async (args, ctx) => {
    // Runtime tracer controls. The `debug` module (debug-log.ts) is a
    // module-level singleton (static-imported above), so only the
    // host-local debug-log buffer + window/workbench/companion handles
    // + view-registry switch live behind ctx.debugSlash. Behavior
    // preserved verbatim from the inline case.
    const sub = (args[0] || 'status').toLowerCase();
    const logDebugControl = (event: string, extra?: Record<string, unknown>): void => {
      debug.log('debug.control', event, {
        ...debug.status(),
        ...(extra ?? {}),
      });
    };
    if (sub === 'on') {
      // Both chat + file sinks ON. Diag is a no-op once mirror is up
      // (mirror already opens the gate), but clear it so debug.level()
      // reports 'normal' unambiguously.
      debug.setFileEnabled(true);
      debug.setDiagEnabled(false);
      debug.enable();
      logDebugControl('on');
      emitReplyToChat(ctx, ctx.success('  debug ON — mirror + file'));
      emitReplyToChat(ctx, ctx.muted(`  file: ${debug.path()}`));
    } else if (sub === 'off') {
      logDebugControl('off:before');
      debug.disable();
      debug.setFileEnabled(false);
      debug.setDiagEnabled(false);
      debug.setVerboseEnabled(false);
      emitReplyToChat(ctx, ctx.muted('  debug OFF — every gate closed (ring buffer still captures)'));
    } else if (sub === 'toggle' || sub === 't') {
      const now = debug.toggle();
      emitReplyToChat(ctx,
        now ? ctx.success(`  debug mirror ON — events stream into chat`)
            : ctx.muted('  debug mirror OFF (file capture unaffected)'),
      );
    } else if (sub === 'mirror') {
      const mode = (args[1] || '').toLowerCase();
      if (mode === 'on') { debug.setMirror(true); emitReplyToChat(ctx, ctx.muted('  debug mirror: ON (lines stream into chat)')); }
      else if (mode === 'off') { debug.setMirror(false); emitReplyToChat(ctx, ctx.muted('  debug mirror: OFF (file only)')); }
      else emitReplyToChat(ctx, ctx.warning(`  usage: /debug mirror on|off  — currently ${debug.isMirrorEnabled() ? 'ON' : 'OFF'}`));
      if (mode === 'on' || mode === 'off') logDebugControl(`mirror:${mode}`);
    } else if (sub === 'file') {
      const mode = (args[1] || '').toLowerCase();
      if (mode === 'on') { debug.setFileEnabled(true); logDebugControl('file:on'); emitReplyToChat(ctx, ctx.muted(`  debug file: ON — ${debug.path()}`)); }
      else if (mode === 'off') { logDebugControl('file:off:before'); debug.setFileEnabled(false); emitReplyToChat(ctx, ctx.muted('  debug file: OFF (ring buffer still captures for /debug tail)')); }
      else {
        // Bare `/debug file` — quiet trail. Mirror off, file on, diag
        // off. Forensic trail without chat spam or hot-path flood.
        debug.setMirror(false);
        debug.setFileEnabled(true);
        debug.setDiagEnabled(false);
        logDebugControl('file:trail');
        emitReplyToChat(ctx, ctx.success('  debug file-only (trail) — mirror OFF, file ON, diag OFF'));
        emitReplyToChat(ctx, ctx.muted(`  file: ${debug.path()}`));
      }
    } else if (sub === 'diag' || sub === 'd') {
      const mode = (args[1] || '').toLowerCase();
      if (mode === 'on') {
        debug.setDiagEnabled(true);
        logDebugControl('diag:on');
        emitReplyToChat(ctx, ctx.warning('  debug diag: ON — hot-path gate open, mirror unchanged'));
      } else if (mode === 'off') {
        logDebugControl('diag:off:before');
        debug.setDiagEnabled(false);
        emitReplyToChat(ctx, ctx.muted('  debug diag: OFF — hot-path gate closed'));
      } else {
        // Bare `/debug diag` — loud trail. Mirror off, file on, diag on.
        debug.setMirror(false);
        debug.setFileEnabled(true);
        debug.setDiagEnabled(true);
        logDebugControl('diag');
        emitReplyToChat(ctx, ctx.success('  debug diag — mirror OFF, file ON, diag ON (loud trail)'));
        emitReplyToChat(ctx, ctx.muted(`  file: ${debug.path()}`));
      }
    } else if (sub === 'verbose' || sub === 'v') {
      const mode = (args[1] || 'toggle').toLowerCase();
      if (mode === 'on') { debug.setVerboseEnabled(true); logDebugControl('verbose:on'); emitReplyToChat(ctx, ctx.warning('  debug verbose: ON — raw LLM bodies in log (large files)')); }
      else if (mode === 'off') { logDebugControl('verbose:off:before'); debug.setVerboseEnabled(false); emitReplyToChat(ctx, ctx.muted('  debug verbose: OFF — payloads compacted (default)')); }
      else if (mode === 'toggle' || mode === 't') {
        debug.setVerboseEnabled(!debug.isVerboseEnabled());
        logDebugControl(`verbose:${debug.isVerboseEnabled() ? 'on' : 'off'}`);
        emitReplyToChat(ctx, debug.isVerboseEnabled()
          ? ctx.warning('  debug verbose: ON — raw LLM bodies in log (large files)')
          : ctx.muted('  debug verbose: OFF — payloads compacted (default)'));
      } else {
        emitReplyToChat(ctx, ctx.warning(`  usage: /debug verbose on|off|toggle  — currently ${debug.isVerboseEnabled() ? 'ON' : 'OFF'}`));
      }
    } else if (sub === 'level') {
      const mode = (args[1] || '').toLowerCase();
      if (mode === 'off' || mode === 'trail' || mode === 'diag' || mode === 'normal' || mode === 'detail' || mode === 'verbose' || mode === 'keytrace') {
        debug.setLevel(mode);
        logDebugControl(`level:${mode}`);
        emitReplyToChat(ctx, ctx.muted(`  debug level: ${debug.level()}`));
        // P5.2: tool-call subscription tracks the debug level.
        ctx.debugSlash.ensureToolCallSubscription();
      } else {
        emitReplyToChat(ctx, ctx.warning(`  usage: /debug level off|trail|diag|normal|detail|keytrace  — currently ${debug.level()}`));
      }
    } else if (sub === 'render' || sub === 'r') {
      // OH9 — 렌더 로그 무음 스위치. 진단 레벨(diag/keytrace)과 직교 —
      // diag 켜둔 채 렌더 카테고리만 끈다. render on = 발화(비억제).
      const mode = (args[1] || '').toLowerCase();
      const persist = async (render: boolean): Promise<void> => {
        try {
          const m = await import('../../mss/logging/scoped-level.js');
          m.persistScopedRenderLogs(render);
        } catch { /* 영속 실패해도 라이브 적용은 유효 */ }
      };
      if (mode === 'on') {
        debug.setRenderSuppressed(false); logDebugControl('render:on'); void persist(true);
        emitReplyToChat(ctx, ctx.success('  debug render: ON — 렌더 카테고리 발화(레벨과 직교)'));
      } else if (mode === 'off') {
        debug.setRenderSuppressed(true); logDebugControl('render:off'); void persist(false);
        emitReplyToChat(ctx, ctx.muted('  debug render: OFF — 렌더 로그 무음(diag/keytrace 는 그대로)'));
      } else {
        emitReplyToChat(ctx, ctx.warning(`  usage: /debug render on|off  — currently ${debug.isRenderSuppressed() ? 'OFF(억제)' : 'ON(발화)'}`));
      }
    } else if (sub === 'keytrace' || sub === 'kt') {
      const mode = (args[1] || 'toggle').toLowerCase();
      if (mode === 'on') { debug.setKeyTraceEnabled(true); logDebugControl('keytrace:on'); emitReplyToChat(ctx, ctx.warning('  debug keytrace: ON — every key dispatch step → key.trace.*')); }
      else if (mode === 'off') { debug.setKeyTraceEnabled(false); logDebugControl('keytrace:off'); emitReplyToChat(ctx, ctx.muted('  debug keytrace: OFF')); }
      else if (mode === 'toggle' || mode === 't') {
        debug.setKeyTraceEnabled(!debug.isKeyTraceEnabled());
        logDebugControl(`keytrace:${debug.isKeyTraceEnabled() ? 'on' : 'off'}`);
        emitReplyToChat(ctx, debug.isKeyTraceEnabled()
          ? ctx.warning('  debug keytrace: ON — every key dispatch step → key.trace.*')
          : ctx.muted('  debug keytrace: OFF'));
      } else {
        emitReplyToChat(ctx, ctx.warning(`  usage: /debug keytrace on|off|toggle  — currently ${debug.isKeyTraceEnabled() ? 'ON' : 'OFF'}`));
      }
    } else if (sub === 'view') {
      const opened = ctx.debugSlash.openDebugView();
      if (opened) {
        ctx.pushDebugLine(ctx.muted('  debug view opened'));
      } else {
        ctx.pushDebugLine(ctx.warning('  debug view is disabled'));
      }
    } else if (sub === 'window' || sub === 'chatlog') {
      const mode = (args[1] ?? 'toggle').toLowerCase();
      if (mode === 'open' || mode === 'show') {
        ctx.debugSlash.openDebugWindow();
        ctx.pushDebugLine(ctx.muted('  debug window opened'));
      } else if (mode === 'close' || mode === 'hide') {
        ctx.debugSlash.closeDebugWindow();
        ctx.pushDebugLine(ctx.muted('  debug window closed'));
      } else if (mode === 'toggle' || mode === 't') {
        const opened = ctx.debugSlash.toggleDebugWindow();
        ctx.pushDebugLine(ctx.muted(`  debug window ${opened ? 'opened' : 'closed'}`));
      } else {
        ctx.pushDebugLine(ctx.warning('  usage: /debug window [open|close|toggle]'));
      }
    } else if (sub === 'popup' || sub === 'companion') {
      const maybeMode = (args[1] ?? '').toLowerCase();
      const directMode = maybeMode === 'open' || maybeMode === 'show' || maybeMode === 'close'
        || maybeMode === 'hide' || maybeMode === 'toggle' || maybeMode === 't';
      const targetArg = directMode ? 'events' : (args[1] ?? 'events');
      const targets = resolveDebugCompanionTargets(targetArg);
      const mode = (directMode ? args[1] : args[2] ?? 'toggle').toLowerCase();
      if (targets.length === 0) {
        ctx.pushDebugLine(ctx.warning('  usage: /debug popup [events|detail|stack|prompts|all] [open|close|toggle|promote]'));
      } else if (mode === 'open' || mode === 'show') {
        ctx.debugSlash.setCompanionTargetsOpen(targets, true);
        ctx.pushDebugLine(ctx.muted(`  debug companion ${targetArg} opened`));
      } else if (mode === 'close' || mode === 'hide') {
        ctx.debugSlash.setCompanionTargetsOpen(targets, false);
        ctx.pushDebugLine(ctx.muted(`  debug companion ${targetArg} closed`));
      } else if (mode === 'toggle' || mode === 't') {
        const opened = ctx.debugSlash.toggleCompanionTargets(targets);
        ctx.pushDebugLine(ctx.muted(`  debug companion ${targetArg} ${opened ? 'opened' : 'closed'}`));
      } else if (mode === 'promote' || mode === 'foreground') {
        const target = targets[0]!;
        ctx.debugSlash.promoteCompanion(target);
        ctx.pushDebugLine(ctx.muted(`  debug companion ${targetArg} promoted to foreground workbench`));
      } else {
        ctx.pushDebugLine(ctx.warning('  usage: /debug popup [events|detail|stack|prompts|all] [open|close|toggle|promote]'));
      }
    } else if (sub === 'workbench' || sub === 'quad') {
      const mode = (args[1] ?? 'toggle').toLowerCase();
      if (mode === 'open' || mode === 'show') {
        ctx.debugSlash.openDebugWorkbenchModal();
        ctx.pushDebugLine(ctx.muted('  debug workbench opened'));
      } else if (mode === 'close' || mode === 'hide') {
        ctx.debugSlash.closeDebugWorkbenchModal();
        ctx.pushDebugLine(ctx.muted('  debug workbench closed'));
      } else if (mode === 'toggle' || mode === 't') {
        const opened = ctx.debugSlash.toggleDebugWorkbenchModal();
        ctx.pushDebugLine(ctx.muted(`  debug workbench ${opened ? 'opened' : 'closed'}`));
      } else {
        ctx.pushDebugLine(ctx.warning('  usage: /debug workbench [open|close|toggle]'));
      }
    } else if (sub === 'trace') {
      // Phase 1.3 (PLAN §4.3) — dump the most recent turn-checkpoint.
      const { loadMostRecent, loadLatest, formatDebugTrace } =
        await import('../../turn-checkpoint/index.js');
      const target = (args[1] || '').trim();
      const cp = target ? loadLatest(target) : loadMostRecent();
      const lines = formatDebugTrace(cp);
      for (const line of lines) {
        if (line.startsWith('── ')) ctx.pushDebugLine(ctx.undo.bold(line));
        else if (line.startsWith('/debug trace')) ctx.pushDebugLine(ctx.accent(line));
        else if (line.includes('⚠')) ctx.pushDebugLine(ctx.warning(line));
        else if (line.includes('✓')) ctx.pushDebugLine(ctx.success(line));
        else ctx.pushDebugLine(ctx.muted(line));
      }
      logDebugControl('trace', { hadCheckpoint: cp !== null, target: target || null });
    } else if (sub === 'tail') {
      const n = Math.max(1, Math.min(200, Number.parseInt(args[1] ?? '30', 10) || 30));
      const lines = debug.tail(n);
      ctx.pushDebugLine(ctx.undo.bold(`  debug tail — ${lines.length} most-recent events`));
      for (const l of lines) ctx.pushDebugLine('  ' + ctx.muted(l));
      if (lines.length === 0) {
        ctx.pushDebugLine(ctx.muted('  (empty — no events captured yet; trigger some activity)'));
      }
    } else if (sub === 'filter') {
      const q = args.slice(1).join(' ').trim();
      if (!q || q === 'clear' || q === 'off') {
        if (q === 'clear' || q === 'off') {
          ctx.debugSlash.clearDebugLogFilter();
          ctx.pushDebugLine(ctx.muted('  debug log filter cleared.'));
        } else {
          const currentQ = ctx.debugSlash.getDebugLogFilterQuery();
          const debugLines = ctx.debugSlash.getDebugLines();
          const activeCount = currentQ
            ? debugLines.filter(line => stripAnsi(line).toLowerCase().includes(currentQ.toLowerCase())).length
            : 0;
          ctx.pushDebugLine(ctx.muted(
            currentQ
              ? `  current debug log filter: "${currentQ}" (${activeCount} rows)`
              : '  debug log filter inactive.',
          ));
        }
      } else {
        ctx.debugSlash.applyDebugLogFilter(q);
        const debugLines = ctx.debugSlash.getDebugLines();
        const matchCount = debugLines.filter(line => stripAnsi(line).toLowerCase().includes(q.toLowerCase())).length;
        ctx.pushDebugLine(ctx.muted(
          `  debug log filter "${q}" → ${matchCount} visible row${matchCount === 1 ? '' : 's'}`,
        ));
        ctx.debugSlash.setDebugScrollOffset(-1);
      }
    } else if (sub === 'clear') {
      debug.clear();
      ctx.debugSlash.clearDebugLogFilter();
      ctx.pushDebugLine(ctx.muted('  debug log cleared (ring buffer + file truncated)'));
    } else if (sub === 'path') {
      ctx.pushDebugLine(ctx.muted(`  debug log path: ${debug.path()}`));
    } else {
      const output = (line: string): void => { ctx.pushDebugLine(line); ctx.chatLines.push(line); };
      output(ctx.undo.bold(
        `  debug:  file=${debug.isFileEnabled() ? ctx.success('ON') : ctx.muted('OFF')}  ` +
        `mirror=${debug.isMirrorEnabled() ? ctx.success('ON') : ctx.muted('OFF')}  ` +
        `diag=${debug.isDiagEnabled() ? ctx.warning('ON') : ctx.muted('OFF')}  ` +
        `verbose=${debug.isVerboseEnabled() ? ctx.warning('ON') : ctx.muted('OFF')}  ` +
        `level=${debug.level()}`,
      ));
      output(ctx.muted(`  log: ${debug.path()}`));
      output(ctx.muted('  quick: /debug on (mirror+file)  /debug off  /debug file (quiet trail)  /debug diag (loud trail)'));
      output(ctx.muted('  fine:  /debug mirror on|off  /debug file on|off  /debug diag on|off  /debug verbose on|off  /debug level off|trail|diag|normal|detail'));
      output(ctx.muted('  log view: /debug filter [query|clear]  /debug tail [N]  /debug clear  /debug trace [<turn-suffix>]'));
      output(ctx.muted('  surfaces: /debug window [open|close|toggle]  /debug popup [events|detail|stack|prompts|all] [open|close|toggle]  /debug workbench [open|close|toggle]'));
      output(ctx.muted('  misc:  /debug toggle | tail [N] | clear | path | view | status'));
    }
    ctx.setChatScrollOffset(-1);
  });

  registry.register(['prompt', 'prompts'], (args, ctx) => {
    // Prompt-bank inspection / config. getPromptBankStore +
    // buildPromptInjection + inspectActiveProvider are static-imported
    // above. The four host-local closures (runtimeState +
    // setRuntimeConfig + describeRuntimeConfig + parseOnOffArg) close
    // over showDashboard-local refs (paneStateSnapshot + pluginHost
    // + provider + user-config) so they thread through ctx. The
    // detail-viewer is also host-side; threaded as
    // openDetailViewer(title, lines).
    const sub = (args[0] || 'list').toLowerCase();
    const store = getPromptBankStore();
    try {
      if (sub === 'list' || sub === 'ls') {
        const items = store.search({ enabled: undefined, limit: Math.max(1, Math.min(100, Number.parseInt(args[1] ?? '30', 10) || 30)) });
        ctx.chatLines.push(ctx.undo.bold(`  prompt fragments — ${items.length}`));
        for (const item of items) {
          const enabled = item.enabled ? ctx.success('on') : ctx.muted('off');
          ctx.chatLines.push(ctx.muted(`  ${enabled} ${item.id} slot=${item.targetSlot} scope=${item.scope} owner=${item.owner} priority=${item.priority}`));
        }
      } else if (sub === 'search' || sub === 'find') {
        const query = args.slice(1).join(' ').trim();
        if (!query) {
          ctx.chatLines.push(ctx.warning('  usage: /prompt search <query>'));
        } else {
          const items = store.search({ query, limit: 30 });
          ctx.chatLines.push(ctx.undo.bold(`  prompt search "${query}" — ${items.length}`));
          for (const item of items) {
            ctx.chatLines.push(ctx.muted(`  ${item.enabled ? 'on ' : 'off'} ${item.id} ${item.name} [${item.tags.join(',') || '-'}]`));
          }
        }
      } else if (sub === 'show') {
        const id = args[1];
        const item = id ? store.get(id) : null;
        if (!item) {
          ctx.chatLines.push(ctx.warning('  usage: /prompt show <id>'));
        } else {
          ctx.promptSlash.openDetailViewer(`Prompt ${item.id}`, [
            `# ${item.name}`,
            '',
            `id: ${item.id}`,
            `enabled: ${item.enabled}`,
            `scope: ${item.scope}`,
            `owner: ${item.owner}`,
            `kind: ${item.kind}`,
            `targetSlot: ${item.targetSlot}`,
            `priority: ${item.priority}`,
            `tags: ${item.tags.join(', ') || '-'}`,
            '',
            '## Content',
            '',
            item.content,
            '',
            '## Triggers',
            '',
            JSON.stringify(item.triggers, null, 2),
            '',
            '## Constraints',
            '',
            JSON.stringify(item.constraints, null, 2),
          ]);
          ctx.chatLines.push(ctx.muted(`  prompt ${item.id} opened in detail viewer`));
        }
      } else if (sub === 'enable' || sub === 'disable') {
        const id = args[1];
        if (!id) {
          ctx.chatLines.push(ctx.warning(`  usage: /prompt ${sub} <id>`));
        } else {
          const item = store.setEnabled(id, sub === 'enable');
          ctx.chatLines.push(ctx.success(`  ${item.id}: ${item.enabled ? 'enabled' : 'disabled'}`));
        }
      } else if (sub === 'config' || sub === 'cfg') {
        const key = (args[1] || 'status').toLowerCase();
        const value = args[2];
        const current = getUserConfig().dashboard.promptBank;
        let next = current;
        if (key === 'status' || key === 'show') {
          // no-op; render below
        } else if (key === 'on' || key === 'off' || key === 'toggle') {
          next = ctx.promptSlash.setRuntimeConfig({ enabled: ctx.promptSlash.parseOnOffArg(key, current.enabled) ?? current.enabled });
        } else if (key === 'dashboard' || key === 'dashboardturns' || key === 'turns') {
          const parsed = ctx.promptSlash.parseOnOffArg(value, current.dashboardTurns);
          if (parsed === null) {
            ctx.chatLines.push(ctx.warning('  usage: /prompt config dashboard on|off|toggle'));
          } else {
            next = ctx.promptSlash.setRuntimeConfig({ dashboardTurns: parsed });
          }
        } else if (key === 'skills' || key === 'skillruns' || key === 'skill') {
          const parsed = ctx.promptSlash.parseOnOffArg(value, current.skillRuns);
          if (parsed === null) {
            ctx.chatLines.push(ctx.warning('  usage: /prompt config skills on|off|toggle'));
          } else {
            next = ctx.promptSlash.setRuntimeConfig({ skillRuns: parsed });
          }
        } else if (key === 'record') {
          const parsed = ctx.promptSlash.parseOnOffArg(value, current.record);
          if (parsed === null) {
            ctx.chatLines.push(ctx.warning('  usage: /prompt config record on|off|toggle'));
          } else {
            next = ctx.promptSlash.setRuntimeConfig({ record: parsed });
          }
        } else if (key === 'budget' || key === 'budgettokens') {
          const parsed = Number.parseInt(value ?? '', 10);
          if (!Number.isFinite(parsed)) {
            ctx.chatLines.push(ctx.warning('  usage: /prompt config budget <100..20000>'));
          } else {
            next = ctx.promptSlash.setRuntimeConfig({ budgetTokens: parsed });
          }
        } else if (key === 'limit') {
          const parsed = Number.parseInt(value ?? '', 10);
          if (!Number.isFinite(parsed)) {
            ctx.chatLines.push(ctx.warning('  usage: /prompt config limit <1..100>'));
          } else {
            next = ctx.promptSlash.setRuntimeConfig({ limit: parsed });
          }
        } else {
          ctx.chatLines.push(ctx.warning('  usage: /prompt config [status|on|off|toggle|dashboard on|off|skills on|off|record on|off|budget N|limit N]'));
        }
        ctx.chatLines.push(ctx.undo.bold('  prompt runtime config'));
        ctx.chatLines.push(ctx.muted(`  ${ctx.promptSlash.describeRuntimeConfig()}`));
        if (next.enabled && !next.dashboardTurns && !next.skillRuns) {
          ctx.chatLines.push(ctx.warning('  enabled is on, but dashboardTurns and skillRuns are both off'));
        }
      } else if (sub === 'select') {
        const intents = args.slice(1).filter(Boolean);
        const injection = buildPromptInjection({
          store,
          state: ctx.promptSlash.runtimeState(intents) as Parameters<typeof buildPromptInjection>[0]['state'],
          options: { record: false },
        });
        ctx.chatLines.push(ctx.undo.bold(`  prompt selection — selected=${injection.selection.selected.length} rejected=${injection.selection.rejected.length} tokens=${injection.tokenEstimate}`));
        for (const item of injection.selection.selected) {
          ctx.chatLines.push(ctx.success(`  + ${item.id} slot=${item.targetSlot} priority=${item.priority}`));
        }
        for (const item of injection.selection.rejected.slice(0, 12)) {
          ctx.chatLines.push(ctx.muted(`  - ${item.id} ${item.reason}`));
        }
      } else if (sub === 'inject') {
        const intents = args.slice(1).filter(Boolean);
        const provider = inspectActiveProvider();
        const injectOptions: Parameters<typeof buildPromptInjection>[0]['options'] = {
          metadata: { source: 'slash:/prompt inject' },
        };
        if (provider.model !== undefined) injectOptions.model = provider.model;
        const activePlugin = ctx.promptSlash.activePluginName();
        if (activePlugin !== undefined) injectOptions.activePlugin = activePlugin;
        const injection = buildPromptInjection({
          store,
          state: ctx.promptSlash.runtimeState(intents) as Parameters<typeof buildPromptInjection>[0]['state'],
          options: injectOptions,
        });
        ctx.promptSlash.openDetailViewer(`Prompt Injection ${injection.log?.id ?? ''}`.trim(), [
          `selected: ${injection.selection.selected.map(p => p.id).join(', ') || '-'}`,
          `rejected: ${injection.selection.rejected.length}`,
          `tokens: ${injection.tokenEstimate}`,
          '',
          ...Object.entries(injection.slots).flatMap(([slot, text]) => [
            `## ${slot}`,
            '',
            text ?? '',
            '',
          ]),
        ]);
        ctx.chatLines.push(ctx.muted(`  prompt injection built${injection.log ? ` log=${injection.log.id}` : ''}`));
      } else if (sub === 'explain') {
        const id = args[1];
        const log = id ? store.getInjectionLog(id) : store.listInjectionLogs(1)[0];
        if (!log) {
          ctx.chatLines.push(ctx.muted('  no prompt injection logs yet'));
        } else {
          ctx.promptSlash.openDetailViewer(`Prompt Injection Log ${log.id}`, [
            `id: ${log.id}`,
            `createdAt: ${log.createdAt}`,
            `sessionId: ${log.sessionId ?? '-'}`,
            `turnId: ${log.turnId ?? '-'}`,
            `model: ${log.model ?? '-'}`,
            `activeView: ${log.activeView ?? '-'}`,
            `activePlugin: ${log.activePlugin ?? '-'}`,
            `tokenEstimate: ${log.tokenEstimate}`,
            `selected: ${log.selectedFragmentIds.join(', ') || '-'}`,
            '',
            '## Rejected',
            '',
            JSON.stringify(log.rejected, null, 2),
            '',
            '## Slots',
            '',
            JSON.stringify(log.slots, null, 2),
            '',
            '## Metadata',
            '',
            JSON.stringify(log.metadata, null, 2),
          ]);
          ctx.chatLines.push(ctx.muted(`  prompt injection log ${log.id} opened in detail viewer`));
        }
      } else {
        ctx.chatLines.push(ctx.warning('  usage: /prompt list|show <id>|search <query>|select [intent...]|inject [intent...]|explain [logId]|enable <id>|disable <id>|config'));
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.chatLines.push(ctx.error(`  error: ${msg}`));
    }
    ctx.setChatScrollOffset(-1);
  });

  // ── B-2.z ─────────────────────────────────────────────────────────

  registry.register('setup', (args, ctx) => {
    const setupCommand = resolveDashboardChatMainSetupCommand(args);
    const launchSetupPopup = (step?: string): void => {
      const cmd = step ? `elanous setup ${step}` : 'elanous setup';
      ctx.chatLines.push(ctx.accent(`❯ /setup${step ? ` ${step}` : ''} — popup terminal`));
      ctx.chatLines.push(ctx.muted(`  launching ${cmd} in popup …`));
      ctx.chatLines.push(ctx.muted('  (Esc to close popup when done — config persists on save)'));
      ctx.setChatScrollOffset(-1);
      const ok = ctx.setup.launchPopup(cmd);
      if (!ok) {
        ctx.chatLines.push(ctx.warning(`  ! popup spawn failed — fall back to: ${cmd}`));
        ctx.setChatScrollOffset(-1);
      }
    };
    if (setupCommand.kind === 'reset') {
      try {
        resetOnboardingMarker();
        ctx.chatLines.push(ctx.success('  ✓ onboarding marker reset.'));
        ctx.chatLines.push(ctx.muted('  next `elanous` boot will launch the setup wizard automatically.'));
        ctx.chatLines.push(ctx.muted('  or run `/setup` to launch inline now.'));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.chatLines.push(ctx.warning(`  ! reset failed: ${msg}`));
      }
    } else if (setupCommand.kind === 'help') {
      for (const [index, line] of dashboardSetupHelpLines().entries()) {
        if (line === '') {
          ctx.chatLines.push('');
        } else if (index === 0 || line === '  개별 step:') {
          ctx.chatLines.push(ctx.accent(line));
        } else if (line.startsWith('  · `')) {
          ctx.chatLines.push(ctx.info(line));
        } else {
          ctx.chatLines.push(ctx.muted(line));
        }
      }
    } else if (setupCommand.kind === 'inline') {
      ctx.setup.openInlineFlow(setupCommand.target);
    } else if (setupCommand.kind === 'launch') {
      launchSetupPopup(setupCommand.step);
    } else {
      ctx.chatLines.push(ctx.warning(`  unknown /setup subcommand: ${setupCommand.subcommand}`));
      ctx.chatLines.push(ctx.muted('  try: /setup | /setup help | /setup reset | /setup <step>'));
      ctx.chatLines.push(ctx.muted(`  valid steps: ${DASHBOARD_SETUP_STEPS.join(' | ')}`));
    }
    ctx.setChatScrollOffset(-1);
  });

  // ── B-2.y ─────────────────────────────────────────────────────────

  registry.register(['plugin', 'plugins'], async (args, ctx) => {
    // Note: original case had a /p alias too, but it always collided
    // with /provider's /p. After B-2.s registered /p for provider, the
    // collision is permanent — /p now goes to provider. /plugin and
    // /plugins remain.
    const sub = (args[0] || 'list').toLowerCase();
    ctx.chatLines.push('');
    ctx.chatLines.push(ctx.accent(`❯ /plugin ${sub}${args.slice(1).length ? ' ' + args.slice(1).join(' ') : ''}`));
    try {
      if (sub === 'list' || sub === 'ls') {
        const items = ctx.plugin.host.list();
        if (items.length === 0) {
          ctx.chatLines.push(ctx.muted('  (no plugins found — drop one in ~/.claude/plugins/<name>/plugin.ts)'));
        } else {
          for (const it of items) {
            const marker = ctx.plugin.host.isActive(it.plugin.name) ? ctx.success('●') : ctx.muted('○');
            const src = it.source === 'builtin' ? ctx.muted('[built-in]') : ctx.info('[user]');
            ctx.chatLines.push(`  ${marker} ${ctx.plugin.bold(it.plugin.name)} ${ctx.muted('v' + it.plugin.version)} ${src}  ${ctx.muted(it.plugin.description)}`);
          }
        }
      } else if (sub === 'activate' || sub === 'a') {
        const name = args[1];
        if (!name) {
          ctx.chatLines.push(ctx.warning('  usage: /plugin activate <name>'));
        } else if (name === 'sync') {
          // sync plugin also drives dashboard mode — route through helper
          // and WAIT for activation to complete before exiting the input
          // loop so the next draw already reflects the sync layout.
          await ctx.plugin.enterSyncMode();
          ctx.chatLines.push(ctx.success('  activated: sync'));
          ctx.setExitInputLoop(true);
        } else {
          await ctx.plugin.host.activate(name);
          ctx.plugin.onAfterActivate();
          ctx.chatLines.push(ctx.success(`  activated: ${name}`));
        }
      } else if (sub === 'deactivate' || sub === 'd' || sub === 'off') {
        const active = ctx.plugin.host.active();
        if (!active) {
          ctx.chatLines.push(ctx.muted('  (no active plugin)'));
        } else if (active.name === 'sync') {
          await ctx.plugin.exitSyncMode();
          ctx.chatLines.push(ctx.success('  deactivated: sync'));
        } else {
          await ctx.plugin.host.deactivate();
          ctx.plugin.onAfterActivate();
          ctx.chatLines.push(ctx.success(`  deactivated: ${active.name}`));
        }
      } else if (sub === 'reload' || sub === 'r') {
        const name = args[1] || ctx.plugin.host.active()?.name;
        if (!name) {
          ctx.chatLines.push(ctx.warning('  usage: /plugin reload <name>'));
        } else {
          await ctx.plugin.host.reload(name);
          ctx.plugin.onAfterActivate();
          ctx.chatLines.push(ctx.success(`  reloaded: ${name}`));
        }
      } else {
        ctx.chatLines.push(ctx.warning(`  unknown subcommand: ${sub} (try list|activate|deactivate|reload)`));
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.chatLines.push(ctx.error(`  error: ${msg}`));
    }
    ctx.setChatScrollOffset(-1);
  });

  // ── B-2.x ─────────────────────────────────────────────────────────


  registry.register(['run-skill', 'rs', 'run'], async (args, ctx) => {
    const skillArg = args[0];
    const skillArgs = args.slice(1).join(' ');

    // No arg → list available skills
    if (!skillArg) {
      const available = listSkillNames();
      ctx.chatLines.push(
        ...ctx.skill.runSlashRuntime.helpLines(
          available.map((name) => describeSkill(name)),
          available.length,
        ),
      );
      ctx.setChatScrollOffset(-1);
      return;
    }

    await ctx.skill.runByName(skillArg, skillArgs);
    // Stay in input mode after skill execution.
  });

  // ── B-2.w ─────────────────────────────────────────────────────────

  registry.register('conv', (args, ctx) => {
    const sub = (args[0] ?? '').toLowerCase();
    if (sub === 'list' || sub === 'ls' || sub === '') {
      const sessions = ctx.conv.listLiveSessions();
      if (sessions.length === 0) {
        ctx.chatLines.push(ctx.muted('  no live embodied sessions'));
      } else {
        ctx.chatLines.push(ctx.info(`  live sessions (${sessions.length})`));
        for (const entry of sessions) {
          const state = entry.session.state();
          const title = state.title?.trim() || entry.session.launchSpec.brand;
          const pane = entry.paneId ? ` · pane:${entry.paneId}` : '';
          const win = entry.windowId !== undefined && entry.windowId !== null ? ` · win:${entry.windowId}` : '';
          ctx.chatLines.push(ctx.muted(`    • ${entry.session.id} · ${title}${pane}${win}`));
        }
      }
      ctx.setChatScrollOffset(-1);
      ctx.draw();
      return;
    }
    if (sub === 'layout') {
      const nextMode = (args[1] ?? '').toLowerCase();
      if (nextMode !== 'cascade' && nextMode !== 'tile' && nextMode !== 'stack') {
        ctx.chatLines.push(ctx.error('  /conv layout <cascade|tile|stack>'));
        ctx.setChatScrollOffset(-1);
        ctx.draw();
        return;
      }
      ctx.conv.setLayoutMode(nextMode);
      ctx.chatLines.push(ctx.success(`  ✓ conversation layout → ${nextMode}`));
      ctx.setChatScrollOffset(-1);
      ctx.draw();
      return;
    }
    if (sub === 'focus') {
      const dir = (args[1] ?? 'next').toLowerCase();
      if (dir !== 'next' && dir !== 'prev') {
        ctx.chatLines.push(ctx.error('  /conv focus <next|prev>'));
        ctx.setChatScrollOffset(-1);
        ctx.draw();
        return;
      }
      (async () => {
        const focused = await ctx.conv.focusPopup(dir === 'prev' ? -1 : 1);
        if (focused) {
          ctx.chatLines.push(ctx.success(`  ✓ conversation focus → ${focused}`));
        } else {
          ctx.chatLines.push(ctx.muted('  no live conversation popup to focus'));
        }
        ctx.setChatScrollOffset(-1);
        ctx.draw();
      })().catch(() => {});
      return;
    }
    if (sub === 'open') {
      const sessionId = args[1];
      if (!sessionId) {
        ctx.chatLines.push(ctx.error('  /conv open <session-id>'));
        ctx.setChatScrollOffset(-1);
        ctx.draw();
        return;
      }
      (async () => {
        try {
          const opened = await ctx.conv.openModal(sessionId);
          if (opened) {
            ctx.chatLines.push(ctx.success(`  ✓ conversation opened for ${sessionId}`));
          } else {
            ctx.chatLines.push(ctx.error(`  /conv open failed: unknown session ${sessionId}`));
          }
        } catch (err) {
          ctx.chatLines.push(ctx.error(`  /conv open failed: ${err instanceof Error ? err.message : String(err)}`));
        }
        ctx.setChatScrollOffset(-1);
        ctx.draw();
      })().catch(() => {});
      return;
    }
    ctx.chatLines.push(ctx.error('  /conv list|ls'));
    ctx.chatLines.push(ctx.error('  /conv layout <cascade|tile|stack>'));
    ctx.chatLines.push(ctx.error('  /conv focus <next|prev>'));
    ctx.chatLines.push(ctx.error('  /conv open <session-id>'));
    ctx.setChatScrollOffset(-1);
    ctx.draw();
  });


  // ── B-2.s ─────────────────────────────────────────────────────────

  registry.register(['provider', 'p'], (args, ctx) => {
    // /provider              — list available providers + rotation
    // /provider next         — advance rotation one step
    // /provider use <needle> — jump to a rotation entry by label/provider/model
    // /provider reset        — jump back to the first rotation entry
    // /provider list         — rotation list only
    const sub = (args[0] ?? '').toLowerCase();
    const needle = args[1] ?? '';

    if (sub === 'next' || sub === 'rotate' || sub === 'n') {
      const { cfg: nextCfg, entry } = rotateNextProvider(getUserConfig());
      if (!entry) {
        ctx.chatLines.push(ctx.provider.slashRuntime.rotationEmptyLine());
      } else {
        saveUserConfig(nextCfg);
        reloadUserConfig();
        ctx.chatLines.push(ctx.provider.slashRuntime.rotatedLine(
          rotationEntryLabel(entry),
          entry.provider,
          entry.model,
        ));
      }
      ctx.setChatScrollOffset(-1);
      return;
    }

    if (sub === 'use' || sub === 'jump' || sub === 'u') {
      if (!needle) {
        ctx.chatLines.push(ctx.provider.slashRuntime.useUsageLine());
        ctx.setChatScrollOffset(-1);
        return;
      }
      const { cfg: nextCfg, entry } = jumpToRotationEntry(getUserConfig(), needle);
      if (!entry) {
        ctx.chatLines.push(ctx.provider.slashRuntime.noRotationMatchLine(needle));
      } else {
        saveUserConfig(nextCfg);
        reloadUserConfig();
        ctx.chatLines.push(ctx.provider.slashRuntime.switchedLine(
          rotationEntryLabel(entry),
          entry.provider,
          entry.model,
        ));
      }
      ctx.setChatScrollOffset(-1);
      return;
    }

    if (sub === 'reset') {
      const cfg = getUserConfig();
      const rot = cfg.llm.rotation;
      if (!rot || rot.length === 0) {
        ctx.chatLines.push(ctx.provider.slashRuntime.resetEmptyLine());
      } else {
        const { cfg: nextCfg, entry } = jumpToRotationEntry(cfg, rotationEntryLabel(rot[0]!));
        if (entry) {
          saveUserConfig(nextCfg);
          reloadUserConfig();
          ctx.chatLines.push(ctx.provider.slashRuntime.resetLine(rotationEntryLabel(entry)));
        }
      }
      ctx.setChatScrollOffset(-1);
      return;
    }

    // /provider pick — open the visual model picker popup.
    // 2026-05-05 — added after the status-bar pill click was changed
    // from "open picker" to "cycle next" (direct rotation). Slash
    // command is the explicit affordance for users who want visual
    // selection (e.g. jump from index 1 to index 4 without 3 cycles).
    // `pick` is the canonical name; `picker` and `menu` aliases keep
    // muscle memory flexible.
    if (sub === 'pick' || sub === 'picker' || sub === 'menu') {
      const opened = ctx.provider.openPicker();
      if (!opened) {
        ctx.chatLines.push(ctx.provider.slashRuntime.rotationEmptyLine());
        ctx.setChatScrollOffset(-1);
      }
      return;
    }

    // Essential-first route inspection. No rich popup is required: the
    // current executed decision is visible after a turn, while `route <text>`
    // previews an unpinned request without changing provider/model state.
    if (sub === 'route') {
      const cfg = getUserConfig();
      const previewPin = sessionModelPin('dashboard', cfg.llm.provider);
      const text = args.slice(1).join(' ').trim();
      const decision = text
        ? resolveRouteDecision({ provider: cfg.llm.provider, configuredModel: inspectActiveProvider().model, text, routePolicy: cfg.llm.routePolicy, ...(previewPin ? { explicitModel: previewPin.model } : {}) })
        : currentRouteDecision('dashboard');
      ctx.chatLines.push(ctx.accent(`❯ /provider route${text ? '' : ' (current)'}`));
      if (!decision) ctx.chatLines.push(ctx.muted('  아직 이 세션에서 실행된 route가 없습니다. `/provider route <요청>`으로 미리보기 합니다.'));
      else ctx.chatLines.push(ctx.text(`  ${formatRouteDecisionSummary(decision)}`));
      ctx.setChatScrollOffset(-1);
      return;
    }

    // Default (/provider, /provider list) — list providers + rotation.
    // Rotation list shown first when configured so the user sees the
    // ordered cycle.
    const cfgNow = getUserConfig();
    const rot = cfgNow.llm.rotation;
    const curIdx = rot && rot.length > 0 ? currentRotationIndex(cfgNow) : -1;
    let catalogModelIds: Set<string> | undefined;
    try {
      const loaded = loadCatalog();
      if (loaded.source !== 'fallback') {
        catalogModelIds = new Set(enabledModels(loaded.catalog).map((model) => model.id));
      }
    } catch { /* catalog unreadable: no stale-model verdict */ }
    ctx.chatLines.push(...ctx.provider.slashRuntime.overviewLines(
      (rot ?? []).map((entry, index) => ({
        label: rotationEntryLabel(entry),
        provider: entry.provider,
        model: entry.model ?? '(provider default)',
        current: index === curIdx,
      })),
      listProviders().map((provider) => ({
        available: provider.available,
        name: provider.name,
        model: provider.model,
      })),
      catalogModelIds,
    ));
    const currentRoute = currentRouteDecision('dashboard');
    if (currentRoute) ctx.chatLines.push(ctx.muted(`  current route: ${formatRouteDecisionSummary(currentRoute)}`));
    else ctx.chatLines.push(ctx.muted('  route: Codex-first decisions appear after the first turn · preview: /provider route <요청>'));
    ctx.setChatScrollOffset(-1);
  });

  // ── B-2.r ─────────────────────────────────────────────────────────

  registry.register('theme', (args, ctx) => {
    const themeCommand = resolveDashboardChatMainThemeCommand(args);
    const raw = getUserConfig().dashboard.theme;
    const active = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).active ?? null
      : null;
    const pushThemeLine = (line: string) => {
      ctx.chatLines.push(line);
      ctx.pushDebugLine(line);
    };
    if (themeCommand.kind === 'list') {
      pushThemeLine(ctx.accent('❯ /theme list'));
      pushThemeLine(`${!active || active === 'default' ? ctx.success('*') : ' '} default  ${DEFAULT_THEME_TOKENS.name}`);
      // FU G — registered preset themes from src/themes/
      for (const preset of listThemes()) {
        const marker = active === preset.name ? ctx.success('*') : ' ';
        const tags: string[] = [];
        if (preset.isDark) tags.push('dark');
        if (preset.isPastel) tags.push('pastel');
        const tagSuffix = tags.length > 0 ? ` [${tags.join(', ')}]` : '';
        pushThemeLine(`${marker} ${preset.name}${tagSuffix}  (preset)`);
      }
      for (const item of ctx.theme.pluginContributions()) {
        pushThemeLine(`${active === item.id ? ctx.success('*') : ' '} ${item.id}  ${item.label}`);
      }
    } else if (themeCommand.kind === 'switch') {
      // FU G — preset switch. Writes user-config + triggers redraw;
      // the preset is picked up on the next currentThemeTokens() call
      // via resolveActiveTheme.
      const name = themeCommand.name;
      if (!name) {
        pushThemeLine(ctx.warning('  usage: /theme switch <preset>'));
        pushThemeLine(ctx.muted('  try: /theme list to see presets.'));
      } else if (!getTheme(name)) {
        pushThemeLine(ctx.warning(`  theme '${name}' is not a registered preset.`));
        pushThemeLine(ctx.muted('  try: /theme list to see available presets.'));
      } else {
        const cfg = getUserConfig();
        cfg.dashboard.theme = setActivePresetInConfig(cfg.dashboard.theme, name) as never;
        saveUserConfig(cfg);
        pushThemeLine(ctx.success(`  theme switched to preset: ${name}`));
        ctx.theme.requestRender();
      }
    } else if (themeCommand.kind === 'use') {
      const id = themeCommand.id;
      if (!id) {
        pushThemeLine(ctx.warning('  usage: /theme use <default|plugin:id.theme>'));
      } else {
        const cfg = getUserConfig();
        cfg.dashboard.theme = { ...(cfg.dashboard.theme as object ?? {}), active: id } as never;
        saveUserConfig(cfg);
        pushThemeLine(ctx.success(`  theme active: ${id}`));
        ctx.theme.requestRender();
      }
    } else if (themeCommand.kind === 'reset') {
      // FU G — clear the active theme back to default.
      const cfg = getUserConfig();
      cfg.dashboard.theme = setActivePresetInConfig(cfg.dashboard.theme, 'default') as never;
      saveUserConfig(cfg);
      pushThemeLine(ctx.success(`  theme reset to default (${DEFAULT_THEME_TOKENS.name}).`));
      ctx.theme.requestRender();
    } else if (themeCommand.kind === 'preview') {
      pushThemeLine(ctx.accent(`❯ /theme ${themeCommand.mode}`));
      for (const line of JSON.stringify(ctx.theme.currentTokens(), null, 2).split('\n')) {
        pushThemeLine(ctx.muted(`  ${line}`));
      }
    } else {
      pushThemeLine(ctx.warning(`  unknown /theme subcommand: ${themeCommand.subcommand}`));
      pushThemeLine(ctx.muted('  try: /theme list | switch <preset> | use <id> | reset | preview | export'));
    }
    ctx.setChatScrollOffset(-1);
  });

  // ── B-2.q ─────────────────────────────────────────────────────────


  // ── B-2.p ─────────────────────────────────────────────────────────

  // ── B-2.o ─────────────────────────────────────────────────────────

  registry.register('intake', (args, ctx) => {
    // Fire-and-forget — the runtime side opens modals / pickers as
    // appropriate. The slash-runtime layer just kicks off the flow
    // and the input loop continues.
    void ctx.intake.runSlash(args);
  });

  // ── B-2.n ─────────────────────────────────────────────────────────


  // ── B-2.m ─────────────────────────────────────────────────────────

  // Single chained call — the helper owns binary validation, error
  // UX, toast, lifecycle hooks, and every keybinding shared with the
  // plain shell popup.
  registry.register('claude', (args, ctx) => {
    ctx.agentLauncher.open('claude-code', args);
  });
  registry.register('codex', (args, ctx) => {
    ctx.agentLauncher.open('codex', args);
  });
  registry.register('gemini', (args, ctx) => {
    ctx.agentLauncher.open('gemini', args);
  });

  // ── B-2.l ─────────────────────────────────────────────────────────

  registry.register(['agents', 'agent', 'ag'], (args, ctx) => {
    const sub = (args[0] ?? 'open').toLowerCase();
    if (sub === 'open' || sub === 'show' || sub === 'view') {
      const ok = ctx.agents.openView();
      ctx.chatLines.push(ok
        ? ctx.agents.slashRuntime.viewOpenedLine()
        : ctx.agents.slashRuntime.viewUnavailableLine());
      ctx.setChatScrollOffset(-1);
      return;
    }
    if (sub === 'popup' || sub === 'companion') {
      const mode = (args[1] ?? 'toggle').toLowerCase();
      if (mode === 'open' || mode === 'show') {
        ctx.agents.setDismissed(false);
        ctx.agents.popup.open();
        ctx.chatLines.push(ctx.agents.slashRuntime.popupLine(true));
      } else if (mode === 'close' || mode === 'hide') {
        ctx.agents.setDismissed(true);
        ctx.agents.popup.close();
        ctx.chatLines.push(ctx.agents.slashRuntime.popupLine(false));
      } else if (mode === 'toggle' || mode === 't') {
        const opened = ctx.agents.popup.toggle();
        ctx.agents.setDismissed(!opened);
        ctx.chatLines.push(ctx.agents.slashRuntime.popupLine(opened));
      } else if (mode === 'promote' || mode === 'foreground') {
        ctx.agents.setDismissed(false);
        ctx.agents.popup.promote();
        ctx.chatLines.push(ctx.agents.slashRuntime.popupPromotedLine());
      } else {
        ctx.chatLines.push(ctx.agents.slashRuntime.popupUsageLine());
      }
      ctx.setChatScrollOffset(-1);
      return;
    }
    ctx.chatLines.push(ctx.agents.slashRuntime.usageLine());
    ctx.setChatScrollOffset(-1);
  });

  // ── B-2.k ─────────────────────────────────────────────────────────

  registry.register('tablet', (args, ctx) => {
    // Phase T-1 — manual tablet mode override.
    //   /tablet              → status (auto | on | off + viewport
    //                          compact level + product compact mode)
    //   /tablet on           → force ON even on wide terminals
    //   /tablet off          → force OFF even on compact-tight
    //   /tablet toggle       → flip ON ↔ OFF (leaving auto if currently auto)
    //   /tablet auto         → clear the manual override, revert to viewport-driven
    //   /tablet browser-preview|bp → open the Browser+Preview modal directly
    const sub = (args[0] || 'status').toLowerCase();
    const before = ctx.tablet.getState();
    if (sub === 'status' || sub === '' || sub === 'show') {
      const stateLine = before.manual === null
        ? ctx.muted(`auto  (viewport=${before.level}; compact=${before.compactMode} ⇒ ${before.effective ? 'ON' : 'off'})`)
        : before.manual
          ? ctx.success(`on  (viewport=${before.level}; compact=${before.compactMode}; auto would be ${before.compactMode === 'compact-tight' ? 'ON' : 'off'})`)
          : ctx.warning(`off  (viewport=${before.level}; compact=${before.compactMode}; auto would be ${before.compactMode === 'compact-tight' ? 'ON' : 'off'})`);
      ctx.pushDebugLine(ctx.undo.bold(`  /tablet: ${stateLine}`));
      ctx.pushDebugLine(ctx.muted('  subcommands: on | off | toggle | auto | status | browser-preview'));
    } else if (sub === 'on') {
      ctx.tablet.setManual(true);
      ctx.pushDebugLine(ctx.success('  ✓ tablet mode ON (log + input; others via Ctrl+M <pane>)'));
      ctx.tablet.requestRender();
    } else if (sub === 'off') {
      ctx.tablet.setManual(false);
      ctx.pushDebugLine(ctx.warning('  ✓ tablet mode OFF (manual override); use /tablet auto to revert to viewport-driven'));
      ctx.tablet.requestRender();
    } else if (sub === 'toggle') {
      ctx.tablet.setManual(!before.effective);
      ctx.pushDebugLine(ctx.success(`  ✓ tablet mode ${!before.effective ? 'ON' : 'OFF'}`));
      ctx.tablet.requestRender();
    } else if (sub === 'auto') {
      ctx.tablet.setManual(null);
      const after = ctx.tablet.getState();
      ctx.pushDebugLine(ctx.success(`  ✓ tablet mode auto (viewport=${after.level}; compact=${after.compactMode} ⇒ ${after.effective ? 'ON' : 'off'})`));
      ctx.tablet.requestRender();
    } else if (sub === 'browser-preview' || sub === 'bp') {
      ctx.tablet.openBrowserPreviewModal();
      ctx.pushDebugLine(ctx.muted('  opened Browser + Preview modal'));
      ctx.tablet.requestRender();
      ctx.setExitInputLoop(true);
      ctx.setChatScrollOffset(-1);
      return;
    } else {
      ctx.pushDebugLine(ctx.warning(`  /tablet: unknown subcommand "${sub}" — try on | off | toggle | auto | status | browser-preview`));
    }
    ctx.setChatScrollOffset(-1);
  });

  // ── B-2.j ─────────────────────────────────────────────────────────


  // ── B-2.i ─────────────────────────────────────────────────────────

  registry.register(['delta', 'diffs'], async (args, ctx) => {
    const deltaCommand = resolveDashboardChatMainDeltaCommand(args);
    if (deltaCommand.kind === 'help') {
      const diffCfg = getUserConfig().chat.rendering.diff;
      for (const [index, line] of dashboardDeltaHelpLines(
        diffCfg.turnBrowserHistory,
        diffCfg.turnBrowserMode,
      ).entries()) {
        if (line === '') {
          ctx.pushDebugLine('');
        } else if (index === 0) {
          ctx.pushDebugLine(ctx.accent(line));
        } else {
          ctx.pushDebugLine(ctx.muted(line));
        }
      }
      ctx.setChatScrollOffset(-1);
      return;
    }
    if (deltaCommand.kind === 'open') {
      const opened = await ctx.delta.openBrowserPopup(
        deltaCommand.scope,
        deltaCommand.limit,
        deltaCommand.browserMode,
      );
      ctx.setChatScrollOffset(-1);
      if (opened) {
        ctx.setExitInputLoop(true);
      }
      return;
    }
    ctx.pushDebugLine(ctx.warning(`  Unknown /delta subcommand: ${deltaCommand.subcommand}. Try /delta help.`));
    ctx.setChatScrollOffset(-1);
  });

  // ── B-2.h ─────────────────────────────────────────────────────────

  // ── B-2.g ─────────────────────────────────────────────────────────

  registry.register('undo', async (args, ctx) => {
    // UT3 — /undo mirrors UndoTurn at the slash surface.
    //   /undo          → restore the most recent snapshot
    //   /undo list     → show ring buffer contents
    //   /undo <id>     → restore a specific snapshot + drop later ones
    //   /undo clear    → empty the ring (orphan commits remain
    //                    in .git/objects until `git gc`)
    //   /undo off|on   → toggle snapshotting for the session
    const {
      listSnapshots, findSnapshotById, peekSnapshot,
      dropFromSnapshot, restoreSnapshot, clearSnapshots,
      setUndoDisabled, isUndoDisabled,
    } = await import('../../undo-turn/index.js');
    const sub = (args[0] || '').toLowerCase();
    if (sub === 'list' || sub === 'ls') {
      const snaps = listSnapshots();
      const output = (line: string): void => { ctx.pushDebugLine(line); ctx.chatLines.push(line); };
      if (snaps.length === 0) {
        output(ctx.muted('  /undo: no snapshots yet'));
      } else {
        output(ctx.undo.bold(`  undo history — ${snaps.length} snapshot${snaps.length === 1 ? '' : 's'} (newest last)`));
        for (const s of snaps) {
          const ageSec = Math.round((Date.now() - s.capturedAt) / 1000);
          const desc = s.description ? ` · ${s.description.slice(0, 60)}` : '';
          output(ctx.muted(`  ${s.id}  ${s.sha.slice(0, 7)}  ${ageSec}s ago${desc}`));
        }
      }
    } else if (sub === 'clear') {
      const n = clearSnapshots();
      ctx.pushDebugLine(ctx.muted(`  /undo: cleared ${n} snapshot${n === 1 ? '' : 's'} from ring (orphan commits stay in .git/objects until git gc)`));
    } else if (sub === 'off') {
      setUndoDisabled(true);
      ctx.pushDebugLine(ctx.warning('  /undo: snapshotting DISABLED for this session (flip back with /undo on)'));
    } else if (sub === 'on') {
      setUndoDisabled(false);
      ctx.pushDebugLine(ctx.success('  /undo: snapshotting enabled'));
    } else if (sub === 'status' || sub === 'state') {
      const snaps = listSnapshots();
      ctx.pushDebugLine(ctx.undo.bold(`  undo: ${isUndoDisabled() ? ctx.warning('disabled') : ctx.success('enabled')} · ${snaps.length} snapshot${snaps.length === 1 ? '' : 's'}`));
    } else {
      // Default: restore the most recent (or a specific id)
      const target = sub ? findSnapshotById(sub) : peekSnapshot();
      if (!target) {
        ctx.pushDebugLine(ctx.warning(sub
          ? `  /undo: no snapshot matches "${sub}" — try /undo list`
          : '  /undo: no snapshots available — nothing to undo'));
      } else {
        const r = restoreSnapshot(target);
        if (r.ok) {
          const dropped = dropFromSnapshot(target.id);
          ctx.pushDebugLine(ctx.success(`  ✓ undone ${target.id} (${target.sha.slice(0, 7)}) — ${r.summary}; dropped ${dropped} from ring`));
          try { ctx.undo.refreshGitDirty(); } catch { /* noop */ }
        } else {
          ctx.pushDebugLine(ctx.error(`  /undo: ${r.error ?? 'restore failed'}`));
        }
      }
    }
    ctx.setChatScrollOffset(-1);
  });

  // ── B-2.f ─────────────────────────────────────────────────────────

  // ── B-2.e ─────────────────────────────────────────────────────────

  registry.register(['history', 'hist', 'inputs'], (args, ctx) => {
    const sub = (args[0] || 'list').toLowerCase();
    try {
      if (sub === 'list' || sub === 'ls') {
        const limit = Math.max(1, Math.min(100, Number.parseInt(args[1] ?? '30', 10) || 30));
        const entries = ctx.inputHistory.store.list(limit);
        ctx.chatLines.push(ctx.accent(`  input history — ${entries.length} (${ctx.inputHistory.store.kind})`));
        for (const entry of entries.slice(0, 20)) {
          const text = entry.text.replace(/\s+/g, ' ').slice(0, 110);
          ctx.chatLines.push(ctx.muted(`  #${entry.id} ${entry.createdAt.slice(5, 19).replace('T', ' ')} ${entry.kind}  ${text}`));
        }
        if (entries.length > 20) ctx.chatLines.push(ctx.muted(`  … ${entries.length - 20} more`));
      } else if (sub === 'find' || sub === 'search') {
        const query = args.slice(1).join(' ').trim();
        if (!query) {
          ctx.chatLines.push(ctx.warning('  usage: /history find <query>'));
        } else {
          const entries = ctx.inputHistory.store.search({ query, limit: 50 });
          ctx.chatLines.push(ctx.accent(`  input history find "${query}" — ${entries.length}`));
          for (const entry of entries.slice(0, 20)) {
            const text = entry.text.replace(/\s+/g, ' ').slice(0, 110);
            ctx.chatLines.push(ctx.muted(`  #${entry.id} ${entry.createdAt.slice(5, 19).replace('T', ' ')} ${entry.kind}  ${text}`));
          }
          if (entries.length > 20) ctx.chatLines.push(ctx.muted(`  … ${entries.length - 20} more`));
        }
      } else if (sub === 'show') {
        const id = Number.parseInt(args[1] ?? '', 10);
        const entry = Number.isFinite(id)
          ? ctx.inputHistory.store.search({ limit: 500 }).find(item => item.id === id)
          : null;
        if (!entry) {
          ctx.chatLines.push(ctx.warning('  usage: /history show <id>'));
        } else {
          ctx.inputHistory.openDetailViewer(`Input History #${entry.id}`, [
            `# Input History #${entry.id}`,
            '',
            `createdAt: ${entry.createdAt}`,
            `kind: ${entry.kind}`,
            `cwd: ${entry.cwd ?? '-'}`,
            `activeView: ${entry.activeView ?? '-'}`,
            `focusedPane: ${entry.focusedPane ?? '-'}`,
            '',
            '## Text',
            '',
            entry.text,
            '',
            '## Metadata',
            '',
            JSON.stringify(entry.metadata, null, 2),
          ]);
          ctx.chatLines.push(ctx.muted(`  input history #${entry.id} opened in detail viewer`));
        }
      } else if (sub === 'clear') {
        ctx.inputHistory.store.clear();
        ctx.inputHistory.refresh();
        ctx.chatLines.push(ctx.muted('  input history cleared'));
      } else if (sub === 'path') {
        ctx.chatLines.push(ctx.muted(`  input history store: ${ctx.inputHistory.store.kind}`));
        ctx.chatLines.push(ctx.muted(`  sqlite: ${inputHistoryDbPath()}`));
        ctx.chatLines.push(ctx.muted(`  json fallback: ${inputHistoryJsonPath()}`));
      } else {
        ctx.chatLines.push(ctx.warning('  usage: /history list [N]|find <query>|show <id>|clear|path'));
      }
    } catch (err: unknown) {
      ctx.chatLines.push(ctx.error(`  error: ${err instanceof Error ? err.message : String(err)}`));
    }
    ctx.setChatScrollOffset(-1);
  });

  // ── B-2.d ─────────────────────────────────────────────────────────

  registry.register(['api-allow', 'api'], (args, ctx) => {
    // P13: api_call host allowlist. Empty by default; persists to
    // ~/.config/monad-agent/api-allow.json unless --session is passed.
    const sub = (args[0] || 'list').toLowerCase();
    if (sub === 'add') {
      const target = args[1];
      if (!target) {
        ctx.pushDebugLine(ctx.warning('  usage: /api-allow add <host-or-url> [reason] [--session]'));
      } else {
        const sessionOnly = args.includes('--session');
        const reasonParts = args.slice(2).filter(a => a !== '--session');
        const reason = reasonParts.length > 0 ? reasonParts.join(' ') : undefined;
        const host = hostOf(target);
        if (!host) {
          ctx.pushDebugLine(ctx.warning(`  invalid host or url: '${target}'`));
        } else {
          const entry = addAllowed(target, { ...(reason !== undefined ? { reason } : {}), sessionOnly });
          if (!entry) {
            ctx.pushDebugLine(ctx.warning(`  could not add '${target}'`));
          } else {
            const scope = sessionOnly ? 'session-only' : 'persistent';
            ctx.pushDebugLine(ctx.success(`  api-allow: ${entry.host} (${scope})${reason ? ` — ${reason}` : ''}`));
          }
        }
      }
    } else if (sub === 'remove' || sub === 'rm') {
      const target = args[1];
      if (!target) {
        ctx.pushDebugLine(ctx.warning('  usage: /api-allow remove <host>'));
      } else {
        const ok = removeAllowed(target);
        ctx.pushDebugLine(ok ? ctx.success(`  api-allow: removed '${hostOf(target)}'`) : ctx.warning(`  no entry for '${target}'`));
      }
    } else if (sub === 'list') {
      const entries = listAllowed();
      const output = (line: string): void => { ctx.pushDebugLine(line); ctx.chatLines.push(line); };
      if (entries.length === 0) {
        output(ctx.muted('  api-allow: empty (api_call will refuse every URL)'));
        output(ctx.muted('  add a host with /api-allow add <host>'));
      } else {
        output(ctx.muted(`  api-allow: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`));
        for (const e of entries) {
          const reason = e.reason ? ` — ${e.reason}` : '';
          const ageMin = Math.round((Date.now() - e.addedAt) / 60_000);
          output(ctx.muted(`    ${e.host.padEnd(28)} added ${ageMin}m ago${reason}`));
          const status = rateLimitStatus(`https://${e.host}/`);
          output(ctx.muted(`      rate budget — host:${status.hostRemaining} global:${status.globalRemaining}`));
        }
      }
    } else if (sub === 'clear') {
      const entries = listAllowed();
      let removed = 0;
      for (const e of entries) if (removeAllowed(e.host)) removed++;
      ctx.pushDebugLine(ctx.success(`  api-allow: cleared ${removed} entr${removed === 1 ? 'y' : 'ies'}`));
    } else {
      ctx.pushDebugLine(ctx.warning('  usage: /api-allow add|remove|list|clear'));
    }
    ctx.setChatScrollOffset(-1);
  });

  // ── B-2.c ─────────────────────────────────────────────────────────

  // TUI 부활 S-a — '/resume' 은 세션 픽커(카탈로그의 원 의도)로 복원.
  // turn-checkpoint resume 은 '/resume-turn' 으로 이동 (/pause 의 짝).
  registry.register('resume-turn', async (args, ctx) => {
    // Phase 1.1 — load most recent checkpoint and prefill input.
    const {
      loadLatest, loadMostRecent, listCheckpointTurns, formatResumeSeed,
    } = await import('../../turn-checkpoint/index.js');
    const sub = (args[0] || '').trim();
    if (sub === 'list' || sub === 'ls') {
      const turns = listCheckpointTurns();
      const output = (line: string): void => { ctx.pushDebugLine(line); ctx.chatLines.push(line); };
      if (turns.length === 0) {
        output(ctx.muted('  /resume: no checkpoints on disk yet — invoke /pause mid-turn or run a decision-boundary tool first.'));
      } else {
        output(ctx.accent(`  resume — ${turns.length} checkpointed turn${turns.length === 1 ? '' : 's'} (newest first)`));
        for (const turn of turns.slice(0, 10)) {
          output(ctx.muted(`  ${turn}`));
        }
        if (turns.length > 10) {
          output(ctx.muted(`  …${turns.length - 10} more`));
        }
      }
      ctx.setChatScrollOffset(-1);
      return;
    }
    const cp = sub ? loadLatest(sub) : loadMostRecent();
    if (!cp) {
      ctx.pushDebugLine(ctx.warning(sub
        ? `  /resume: no checkpoint matches "${sub}" — try /resume list`
        : '  /resume: no checkpoints available — invoke /pause mid-turn first or wait for a decision-boundary tool to run.'));
    } else {
      const seed = formatResumeSeed(cp);
      ctx.pushDebugLine(ctx.success(
        `  ✓ /resume loaded ${cp.turnUri.slice(-12)} #${cp.toolIndex} (${cp.decision.kind}) — seed prefilled into the input editor.`,
      ));
      ctx.inputSeed.appendBlock(seed);
      ctx.inputSeed.setPendingPlainInput();
    }
    ctx.setChatScrollOffset(-1);
  });

  registry.register('research', async (args, ctx) => {
    // Phase 1.4 — invoke external research skill + prefill editor.
    const sub = (args[0] || '').trim();
    if (sub === 'list' || sub === 'ls') {
      const { getRecentResults } = await import('../../research-bridge/index.js');
      const recent = getRecentResults(10);
      if (recent.length === 0) {
        ctx.pushDebugLine(ctx.muted('  /research: no results yet — try `/research <topic>`'));
      } else {
        ctx.pushDebugLine(ctx.accent(`  /research — ${recent.length} recent result${recent.length === 1 ? '' : 's'} (newest first)`));
        for (const r of recent) {
          const status = r.ok ? '✓' : '⚠';
          ctx.pushDebugLine(ctx.muted(`  ${status} ${r.skill}: "${r.topic.slice(0, 60)}" — ${(r.durationMs / 1000).toFixed(1)}s`));
        }
      }
      ctx.setChatScrollOffset(-1);
      return;
    }
    let skillOverride: string | undefined;
    let topicArgs = [...args];
    if (topicArgs[0] === '--skill' && topicArgs[1]) {
      skillOverride = topicArgs[1];
      topicArgs = topicArgs.slice(2);
    }
    const topic = topicArgs.join(' ').trim();
    if (!topic) {
      ctx.pushDebugLine(ctx.warning('  /research: usage: /research <topic>  |  /research --skill <name> <topic>  |  /research list'));
      ctx.setChatScrollOffset(-1);
      return;
    }
    const { invokeResearch, formatResearchSummary, formatResearchPrefill } =
      await import('../../research-bridge/index.js');
    ctx.pushDebugLine(ctx.muted(`  /research: invoking ${skillOverride || 'omni-crawl'}: "${topic.slice(0, 60)}"…`));
    ctx.draw();
    const result = await invokeResearch(topic, {
      ...(skillOverride ? { skill: skillOverride } : {}),
    });
    ctx.pushDebugLine(result.ok ? ctx.success('  ' + formatResearchSummary(result)) : ctx.warning('  ' + formatResearchSummary(result)));
    if (result.ok) {
      const seed = formatResearchPrefill(result);
      ctx.inputSeed.appendBlock(seed);
      ctx.inputSeed.setPendingPlainInput();
      ctx.pushDebugLine(ctx.muted('  → prefilled into input editor — type your follow-up question and Enter.'));
    }
    ctx.setChatScrollOffset(-1);
  });


  // ── B-2.b ─────────────────────────────────────────────────────────

  registry.register('plan', async (args, ctx) => {
    const { getPlanModeState, dispatchEnterPlanMode, dispatchExitPlanMode } = await import('../../plan-mode/index.js');
    const sub = (args[0] || 'status').toLowerCase();
    if (sub === 'status' || sub === '') {
      const s = getPlanModeState();
      const output = (line: string): void => { ctx.pushDebugLine(line); ctx.chatLines.push(line); };
      if (s.active) {
        output(ctx.accent(`  plan mode: ${ctx.success('ACTIVE')}  (session ${s.sessionId}, phase ${s.phase})`));
        output(ctx.muted(`  plan file: ${s.planFilePath}`));
      } else {
        output(ctx.muted('  plan mode: inactive — /plan start [title] to enter'));
      }
    } else if (sub === 'start') {
      const title = args.slice(1).join(' ').trim();
      const r = await dispatchEnterPlanMode(title ? { initialTitle: title } : {});
      for (const line of r.output.split('\n')) ctx.pushDebugLine(ctx.muted(`  ${line}`));
    } else if (sub === 'done' || sub === 'exit') {
      const r = await dispatchExitPlanMode({});
      for (const line of r.output.split('\n')) ctx.pushDebugLine(ctx.muted(`  ${line}`));
    } else if (sub === 'show') {
      const s = getPlanModeState();
      if (!s.active) {
        ctx.pushDebugLine(ctx.warning('  plan mode is not active'));
      } else {
        try {
          const fs = await import('fs');
          const body = fs.readFileSync(s.planFilePath, 'utf-8');
          for (const line of body.split('\n').slice(0, 60)) ctx.pushDebugLine(`  ${line}`);
        } catch {
          ctx.pushDebugLine(ctx.warning(`  could not read ${s.planFilePath}`));
        }
      }
    } else {
      ctx.pushDebugLine(ctx.warning('  usage: /plan [status | start [title] | done | show]'));
    }
    ctx.setChatScrollOffset(-1);
  });

  registry.register(['code-edit', 'ce'], async (args, ctx) => {
    // CE4 — policy control for LLM-driven Edit/Write.
    const { getPolicy, setPolicy, resetPolicyToDefault } = await import('../../code-edit/index.js');
    const sub = (args[0] || 'status').toLowerCase();
    if (sub === 'policy') {
      const mode = (args[1] || '').toLowerCase();
      if (mode === 'unsupervised' || mode === 'auto') {
        setPolicy({ mode: 'unsupervised' });
        ctx.pushDebugLine(ctx.warning('  code-edit policy: UNSUPERVISED — every Edit/Write applies without asking.'));
      } else if (mode === 'ask-edit' || mode === 'ask') {
        setPolicy({ mode: 'ask-edit' });
        ctx.pushDebugLine(ctx.muted('  code-edit policy: ask-edit — every Edit/Write prompts.'));
      } else if (mode === 'ask-all') {
        setPolicy({ mode: 'ask-all' });
        ctx.pushDebugLine(ctx.muted('  code-edit policy: ask-all — every mutating tool prompts.'));
      } else if (mode === 'trusted-dirs' || mode === 'trusted') {
        const dirs = args.slice(2).filter(Boolean);
        setPolicy({ mode: 'trusted-dirs', trustedDirs: dirs });
        ctx.pushDebugLine(ctx.muted(`  code-edit policy: trusted-dirs (${dirs.length} dir${dirs.length === 1 ? '' : 's'})`));
      } else {
        ctx.pushDebugLine(ctx.warning('  usage: /code-edit policy <unsupervised|ask-edit|ask-all|trusted-dirs [path …]>'));
      }
    } else if (sub === 'reset') {
      resetPolicyToDefault();
      ctx.pushDebugLine(ctx.muted('  code-edit policy reset to default (ask-edit)'));
    } else {
      const p = getPolicy();
      const line = ctx.muted(`  code-edit policy: ${p.mode}${p.mode === 'trusted-dirs' && p.trustedDirs ? ` (${p.trustedDirs.length} dirs)` : ''}`);
      ctx.pushDebugLine(line);
      ctx.chatLines.push(line);
    }
    ctx.setChatScrollOffset(-1);
  });

  // ── B-2.a (medium-tier first round) ──────────────────────────────



  registry.register('wd', async (args, ctx) => {
    // WD8 — session working directory control.
    const {
      getSessionWorkingDir, setSessionCwd, initSessionWorkingDir, getSessionCwd,
    } = await import('../../session/working-dir.js');
    const sub = (args[0] || 'show').toLowerCase();
    if (args.length === 0 || sub === 'show' || sub === 'status') {
      const s = getSessionWorkingDir();
      const ageSec = Math.round((Date.now() - s.setAt) / 1000);
      const location = ctx.accent(`  session working dir: ${s.cwd}`);
      const origin = ctx.muted(`  origin: ${s.origin}  ·  set ${ageSec}s ago`);
      ctx.pushDebugLine(location);
      ctx.pushDebugLine(origin);
      ctx.chatLines.push(location, origin);
    } else if (sub === 'reset') {
      const restored = initSessionWorkingDir(process.cwd());
      ctx.pushDebugLine(ctx.success(`  ✓ working dir reset to boot cwd → ${restored.cwd}`));
    } else {
      const raw = args.join(' ').trim();
      try {
        const { resolve } = await import('node:path');
        const home = process.env.HOME ?? '';
        const expanded = raw === '~' || raw === '~/'
          ? home
          : raw.startsWith('~/') ? home + raw.slice(1)
          : raw;
        const abs = resolve(getSessionCwd(), expanded);
        setSessionCwd(abs, 'slash');
        ctx.pushDebugLine(ctx.success(`  ✓ working dir → ${abs}`));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.pushDebugLine(ctx.warning(`  /wd: ${msg}`));
      }
    }
    ctx.setChatScrollOffset(-1);
  });

  registry.register('handoff', (args, ctx) => {
    const fromId = args[0];
    const toBrand = args[1];
    if (!fromId || !toBrand) {
      ctx.chatLines.push(ctx.error('  /handoff <from_session_id> <to_brand> [--channels r,p,m] [--prompt "prefix"]'));
      ctx.chatLines.push(ctx.muted('    brands: codex · claude · claude-code · gemini · elanous'));
      ctx.setChatScrollOffset(-1);
      ctx.draw();
      return;
    }
    let channels: string[] | undefined;
    let prefixPrompt: string | undefined;
    for (let i = 2; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--channels' && args[i + 1]) {
        channels = args[i + 1]!.split(',').map((s) => s.trim()).filter(Boolean);
        i++;
      } else if (arg === '--prompt' && args[i + 1]) {
        prefixPrompt = args[i + 1];
        i++;
      }
    }
    (async () => {
      try {
        const { dispatchAgentHandoff } = await import('../../skills/tools/agent-handoff.js');
        const r = await dispatchAgentHandoff({
          from_session_id: fromId,
          to_brand: toBrand,
          ...(channels !== undefined ? { context_channels: channels } : {}),
          ...(prefixPrompt !== undefined ? { context_prompt: prefixPrompt } : {}),
        });
        ctx.chatLines.push(ctx.success(`  ✓ handoff ${r.from_session_id} → ${r.to_session_id}`));
        ctx.chatLines.push(ctx.muted(`    • ${r.context_bytes}B context · ${r.included_channels.length > 0 ? `channels=${r.included_channels.join(',')}` : 'raw-snapshot'} · edge=${r.edge_kind}`));
      } catch (err) {
        ctx.chatLines.push(ctx.error(`  /handoff failed: ${err instanceof Error ? err.message : String(err)}`));
      }
      ctx.setChatScrollOffset(-1);
      ctx.draw();
    })().catch(() => {});
  });

  registry.register(['reasoning', 'r', 'think'], (args, ctx) => {
    // Cycler: /reasoning → cycles off→low→medium→high→xhigh→off; explicit
    // /reasoning <level> sets directly. Mirrors HUD pill click.
    const sub = (args[0] ?? '').toLowerCase();
    const curCfg = getUserConfig();
    const cur = effectiveReasoningLevel(curCfg.llm, curCfg.llm.provider, curCfg.llm.model);
    let next: ReasoningLevel | null = null;
    if (!sub) {
      next = nextReasoningLevel(cur);
    } else if ((REASONING_CYCLE as readonly string[]).includes(sub)) {
      next = sub as ReasoningLevel;
    } else {
      ctx.chatLines.push(ctx.muted(`/reasoning: invalid level "${sub}". usage: /reasoning [off|low|medium|high|xhigh]`));
    }
    if (next !== null) {
      const hadOverride = curCfg.llm.codexReasoning !== undefined;
      const nextLLM = { ...curCfg.llm, reasoningLevel: next, codexReasoning: undefined };
      saveUserConfig({ ...curCfg, llm: nextLLM });
      reloadUserConfig();
      ctx.refreshReasoningHudSegment();
      ctx.chatLines.push(`reasoning: ${reasoningLevelLabel(cur)} → ${reasoningLevelLabel(next)}`);
      if (hadOverride) {
        ctx.chatLines.push(ctx.muted('  └─ cleared advanced codexReasoning override (re-add manually if needed)'));
      }
    }
    ctx.setChatScrollOffset(-1);
  });

  registry.register(['model', 'm'], (args, ctx) => {
    // /model            — 지금 모델(사람 낱말) + 고르기
    // /model 빠름|보통|깊음 — 지금 provider 의 budget·better·best 티어 (model-choices.ts)
    // /model <코드명>    — codex·terra·sol·luna·opus·sonnet·grok (그대로 동작)
    // /model <x> --global — 설정 파일(전역)에 저장 · /model reset — 세션 핀 해제
    // ⭐ 기본은 «이 세션» 핀이다(TUI-MODEL-SESSION-SCOPE · 10-14): config 의 llm.model 만 바꾸면 codex 티어 정책이
    //   그것을 무시해 실제 턴은 그대로 sol 이었다(OPT 21:33). 핀은 다음 턴 explicitModel 로 들어가 정책을 이긴다.
    // effort(low/med/high)는 /reasoning. NL 미지원(대표 OK·slash-only).
    const { arg, global } = parseModelSlashArgs(args);
    const curCfg = getUserConfig();
    const curProvider = curCfg.llm.provider;
    const pin = sessionModelPin('dashboard', curProvider);
    const curModel = pin?.model ?? curCfg.llm.model;
    const curReasoning = effectiveReasoningLevel(curCfg.llm, curProvider, curModel);
    if (!arg) {
      const [, codes] = modelOverviewLines(curProvider, curModel, curReasoning);
      // A model outside the 빠름/보통/깊음 map (codename or custom) says so explicitly instead of dropping the tier slot.
      const tierName = humanWordForModel(curProvider, curModel, curReasoning) ?? '단계 밖';
      ctx.chatLines.push(`지금: ${curModel?.trim() || '기본 모델'} (${tierName} · 생각 ${curReasoning}${pin ? ' · 이 세션 핀' : ''}) · 고르기: /model ${HUMAN_MODEL_WORDS.join(' | ')}`);
      ctx.chatLines.push(ctx.muted(codes));
      ctx.setChatScrollOffset(-1);
      return;
    }
    if (arg === 'reset') {
      setSessionModelPin('dashboard', null);
      debug.log('llm.model-choice', 'session-pin-cleared', { hadPin: pin !== null, configModel: curCfg.llm.model ?? null }, { level: 'info' });
      ctx.chatLines.push(ctx.muted(`/model reset: 세션 핀 ${pin ? `해제 (${pin.model})` : '없음'} — 다음 턴은 설정·정책대로`));
      ctx.setChatScrollOffset(-1);
      return;
    }
    const resolution = resolveModelChoice(arg, curProvider);
    if (resolution.kind === 'needs-provider') {
      debug.log('llm.model-choice', 'human-word-needs-provider', { word: resolution.word, provider: curProvider });
      ctx.chatLines.push(ctx.muted(`/model ${resolution.word}: provider 가 auto 라 고를 사다리가 없다 — /provider 로 먼저 하나를 고르거나 코드명(${MODEL_CODE_NAMES.join('/')})을 쓴다.`));
      ctx.setChatScrollOffset(-1);
      return;
    }
    if (resolution.kind === 'unknown') {
      ctx.chatLines.push(ctx.muted(`/model: "${arg}" 를 모른다. ${HUMAN_MODEL_WORDS.join(' | ')} 또는 ${MODEL_CODE_NAMES.join('/')}.`));
      ctx.setChatScrollOffset(-1);
      return;
    }
    const { target } = resolution;
    const scope = modelSwitchScope(target.provider, curProvider, global);
    if (scope === 'needs-global') {
      ctx.chatLines.push(ctx.muted(`/model ${arg}: provider 가 ${curProvider} → ${target.provider} 로 바뀌는 선택은 세션 핀이 안 된다 — /model ${arg} --global 로 설정에 저장한다.`));
      ctx.setChatScrollOffset(-1);
      return;
    }
    // A human word picks a whole tier (model ⊕ reasoning, like /reasoning it clears the codex override);
    // a code name changes the model only. Reasoning has no per-turn override, so only --global sets it.
    const tierReasoning = resolution.kind === 'human' ? resolution.reasoningLevel : undefined;
    if (scope === 'global') {
      saveUserConfig({
        ...curCfg,
        llm: {
          ...curCfg.llm,
          provider: target.provider,
          model: target.model,
          ...(tierReasoning ? { reasoningLevel: tierReasoning, codexReasoning: undefined } : {}),
        },
      });
      reloadUserConfig();
      if (tierReasoning) ctx.refreshReasoningHudSegment();
    }
    // --global 도 이 세션은 핀으로 «즉시» 반영한다 — config 만 쓰면 codex 티어 정책이 configuredModel 을
    //   무시해 다음 턴에 안 먹는다(1R 리뷰 mf). 다른 세션은 그 세션의 routePolicy 를 따른다.
    setSessionModelPin('dashboard', { provider: target.provider, model: target.model });
    // 감사 한 줄 — 종전 범주 `dashboard.model` 은 렌더 접두(`dashboard`)라 기본 음소거돼 로그 스토어에 0회였다
    //   (src/mss/logging/render-categories.ts). 판정 이벤트는 렌더 밖 범주에 둔다.
    debug.log('llm.model-choice', 'switch', {
      scope,
      via: resolution.kind,
      choice: resolution.kind === 'human' ? resolution.tier : resolution.name,
      from: { provider: curProvider, model: curModel ?? null, pinned: pin !== null },
      to: target,
      reasoning: scope === 'global' ? (tierReasoning ?? null) : null,
      configWritten: scope === 'global',
    }, { level: 'info' });
    // 세션 범위는 생각 깊이를 안 바꾼다 — 모델 줄에 티어의 깊이를 «바뀐 값»처럼 쓰지 않고, 남는 깊이를 말한다
    //   (2R 리뷰 — 한 응답 안의 «생각 medium» 과 «생각 깊이는 그대로 high» 모순).
    if (scope === 'session' && resolution.kind === 'human') {
      const { reasoningLevel: _tierReasoning, ...modelOnly } = resolution;
      ctx.chatLines.push(`${modelChangeLine({ provider: curProvider, model: curModel, reasoning: curReasoning }, modelOnly)} · 생각 ${curReasoning} 그대로`);
    } else {
      ctx.chatLines.push(modelChangeLine({ provider: curProvider, model: curModel, reasoning: curReasoning }, resolution));
    }
    ctx.chatLines.push(ctx.muted(modelScopeLine(scope, scope === 'session' && tierReasoning ? { tier: tierReasoning, current: curReasoning } : undefined)));
    ctx.setChatScrollOffset(-1);
  });

  registry.register(['detail', 'report', 'dv'], (args, ctx) => {
    const sub = (args[0] ?? 'open').toLowerCase();
    const c = ctx.companion;
    if (sub === 'open' || sub === 'show') {
      c.setPopupOpen('detail', true);
      ctx.chatLines.push(c.slashRuntime.openedLine('detail'));
      ctx.setChatScrollOffset(-1);
      return;
    }
    if (sub === 'close' || sub === 'hide') {
      c.closeDetail();
      ctx.chatLines.push(c.slashRuntime.closedLine('detail'));
      ctx.setChatScrollOffset(-1);
      return;
    }
    if (sub === 'toggle' || sub === 't') {
      const next = !c.popupHost.isOpen('detail');
      c.setPopupOpen('detail', next);
      ctx.chatLines.push(c.slashRuntime.toggledLine('detail', next));
      ctx.setChatScrollOffset(-1);
      return;
    }
    if (sub === 'clear' || sub === 'cls') {
      c.clearDetailViewer();
      ctx.chatLines.push(c.slashRuntime.detailClearedLine());
      ctx.setChatScrollOffset(-1);
      return;
    }
    ctx.chatLines.push(c.slashRuntime.usageLine('detail'));
    ctx.setChatScrollOffset(-1);
  });

  // ── Slash wire-up · context-display + compact ──────────────────────
  //
  // HANDOFF (2026-05-04) §5.1. The factories' canonical `name: 'context'`
  // collides with the attachment-manager /context registered above
  // (L1090 — `contextSlash` ctx field). We register the token-display
  // surface as /tokens (alias `tk`) and leave attachment /context
  // untouched.

  registry.register(['tokens', 'tk'], (_args, ctx) => {
    const text = CONTEXT_SLASH_DESCRIPTOR.render({
      activeModelId: ctx.compactSlash.activeModelId(),
    });
    for (const line of text.split('\n')) ctx.chatLines.push(line);
    ctx.setChatScrollOffset(-1);
  });

  registry.register(['compact', 'compress', 'squeeze'], async (args, ctx) => {
    // PR3 §5.3 — `--inspect` subcommand routes to the archive replay
    // viewer instead of running the pipeline. Accepts both forms:
    //   /compact --inspect              → inspect current sessionId
    //   /compact --inspect <session>    → inspect a specific session
    //   /compact --inspect list         → enumerate all archive files
    const first = args[0]?.toLowerCase();
    if (first === '--inspect' || first === 'inspect') {
      const sub = args[1]?.toLowerCase();
      if (sub === 'list' || sub === 'ls') {
        const list = listArchiveSessions();
        for (const line of formatSessionList(list).split('\n')) ctx.chatLines.push(line);
      } else {
        const sessionId = args[1] ?? ctx.compactSlash.sessionId() ?? 'default';
        const result = inspectArchive(sessionId);
        for (const line of formatInspectOutput(result, { sessionId }).split('\n')) {
          ctx.chatLines.push(line);
        }
      }
      ctx.setChatScrollOffset(-1);
      return;
    }

    const messages = ctx.compactSlash.chatHistory as unknown as LLMMessage[];
    const result = await runCompactSlash({
      messages,
      provider: ctx.compactSlash.getProvider(),
      activeModelId: ctx.compactSlash.activeModelId(),
      sessionId: ctx.compactSlash.sessionId(),
      summaryHint: args.join(' ').trim() || undefined,
    });
    if (
      result.savedTokens > 0 ||
      result.pipeline.diagnostics.layer3SummaryApplied
    ) {
      const next = result.messages as unknown as ChatMessage[];
      ctx.compactSlash.chatHistory.length = 0;
      for (const m of next) ctx.compactSlash.chatHistory.push(m);
    }
    for (const line of result.statusLines) ctx.chatLines.push(line);
    ctx.setChatScrollOffset(-1);
  });

  // /export — 이 대화 전사를 마크다운 파일로 (PLAN 1-D). exportSessionTranscript
  // 순수함수 공유(elanous session export CLI 와 동형). 라이브 chat.history 우선,
  // 없으면 세션 디스크. 인자 = 대상 경로(공백 포함 가능·홈 밖 거부).
  registry.register('export', async (args, ctx) => {
    const to = args.join(' ').trim();
    // ChatMessage(content: string|ContentBlock[]) → 평탄 {role,content}. 텍스트
    // 블록만 추출(tool_use/tool_result/image 는 전사에서 제외).
    const history = ctx.compactSlash.chatHistory
      .filter(m => m.role === 'user' || m.role === 'assistant' || m.role === 'system')
      .map(m => ({
        role: m.role as 'user' | 'assistant' | 'system',
        content: typeof m.content === 'string'
          ? m.content
          : (m.content as Array<{ type?: string; text?: string }>)
              .filter(b => b?.type === 'text' && typeof b.text === 'string')
              .map(b => b.text).join('\n'),
      }));
    try {
      const { exportSessionTranscript } = await import('../../session/export-transcript.js');
      const r = exportSessionTranscript({
        history,
        ...(ctx.compactSlash.sessionId() ? { sessionId: ctx.compactSlash.sessionId()! } : {}),
        ...(to ? { to } : {}),
      });
      ctx.chatLines.push(ctx.info(`  전사 내보냄 → ${r.path}  (${r.messages} 메시지 · ${r.lines} 줄)`));
    } catch (e) {
      ctx.chatLines.push(ctx.warning(`  /export 실패: ${e instanceof Error ? e.message : String(e)}`));
    }
    ctx.setChatScrollOffset(-1);
  });

  registry.register(['child'], async (_args, ctx) => {
    const childScreen = ctx.childScreen;
    if (!childScreen) {
      ctx.chatLines.push(ctx.warning('  /child 화면 관측을 사용할 수 없습니다.'));
      ctx.setChatScrollOffset(-1);
      return;
    }
    const runId = childScreen.runId();
    const candidates = childScreen.list().filter((row) => row.runId === runId && row.kind === 'self' && row.id.startsWith('self_'));
    const live = candidates.filter((row) => row.alive);
    if (live.length > 1) {
      childScreen.show({
        title: 'Harness child screen',
        lines: [`실행 ${runId}에 살아 있는 자식이 여럿입니다:`, ...live.map((row) => `  ${row.id}`)],
      });
      return;
    }
    if (live.length === 0) {
      childScreen.show({
        title: 'Harness child screen',
        lines: candidates.length > 0
          ? [`실행 ${runId}의 일치 자식은 모두 끝났습니다.`, ...candidates.map((row) => `  ${row.id} (ended)`)]
          : [`실행 ${runId}에서 self_ 자식 터미널을 찾지 못했습니다.`, '확인한 조건: runId + kind=self + self_ 식별자'],
      });
      return;
    }
    const target = live[0]!;
    try {
      const captured = await childScreen.snapshot(target.id, target.manifestDbPath);
      if (captured.exitCode !== 0) {
        childScreen.show({ title: 'Harness child screen', lines: [`${target.id} 화면을 읽지 못했습니다.`, captured.message] });
        return;
      }
      if (captured.message === '') {
        childScreen.show({ title: `Harness child · ${target.id}`, lines: ['화면 캡처가 비어 있습니다.'] });
        return;
      }
      const lines = captured.message.split('\n');
      const maxLines = 40;
      childScreen.show({
        title: `Harness child · ${target.id}`,
        lines: lines.length > maxLines ? [...lines.slice(0, maxLines), `… 화면 ${lines.length - maxLines}줄이 잘렸습니다.`] : lines,
      });
    } catch (error) {
      childScreen.show({ title: 'Harness child screen', lines: [`${target.id} 화면 읽기에 실패했습니다.`, error instanceof Error ? error.message : String(error)] });
    }
  }, { immediateDuringStream: true });


  // ── B4 (TUI half) — /design shows the craft-rulebook verdict ─────────
  // The same verdict `elanous repo design-check` prints and the PWA
  // `/design-check` panel renders, resolved through the SAME
  // `resolveRepositoryDesignCheck` so the three surfaces cannot drift.
  //
  // ⛔ Output goes to `chatLines`, not `pushDebugLine`. A verdict about this
  //    repository is something the operator ASKED for; routing it to the debug
  //    pane is the "slash output only reaches a hidden pane" problem this
  //    track has on its backlog, and there is no reason to inherit it here.
  registry.register(['design', 'design-check'], (args, ctx) => {
    if (args[0] === 'pick') {
      handleDesignPick(args.slice(1), ctx);
      return;
    }
    const tone: Record<DesignCheckTone, (t: string) => string> = {
      heading: ctx.highlight,
      ok: ctx.success,
      bad: ctx.error,
      muted: ctx.muted,
      plain: ctx.text,
    };
    // `--declared` narrows to what the document claims; the default also lists
    // rulebooks elanous ships but the document has not declared, which is the
    // question the CLI cannot answer.
    const declaredOnly = args.some((a) => a === '--declared' || a === 'declared');
    let lines;
    try {
      const outcome = resolveRepositoryDesignCheck(undefined);
      // B5 — 방향은 여기서 «한 번» 도출해 렌더러에 넘긴다. 렌더러가 스스로
      // THEME_REGISTRY 를 읽으면 그 파일이 정본의 두 번째 독자가 된다.
      const available = listDesignDirections();
      const declaration = outcome.ok
        ? parseDeclaredDirection(readDesignDocumentForDirections(outcome.documentPath), available)
        : { declared: null, unavailable: null };
      lines = renderDesignCheckLines(outcome, {
        ...(declaredOnly ? { includeUndeclared: false } : {}),
        directions: {
          declared: declaration.declared,
          unavailable: declaration.unavailable,
          available: available.map((d) => ({ id: d.id, mood: d.mood })),
        },
      });
    } catch (err) {
      // Resolution reads the filesystem. A throw here is not a verdict — say
      // so by name rather than rendering an empty (and therefore reassuring)
      // rulebook list.
      ctx.chatLines.push(ctx.error(`Design check failed: ${err instanceof Error ? err.message : String(err)}`));
      ctx.setChatScrollOffset(-1);
      return;
    }
    for (const line of lines) ctx.chatLines.push(tone[line.tone](line.text));
    ctx.setChatScrollOffset(-1);
  });

  registry.register(['cost', 'spend'], (_args, ctx) => {
    const text = COST_SLASH_DESCRIPTOR.render();
    for (const line of text.split('\n')) ctx.chatLines.push(line);
    ctx.setChatScrollOffset(-1);
  });

  registry.register(['memory', 'mem'], (args, ctx) => {
    const sub = args[0]?.toLowerCase();
    const text = MEMORY_SLASH_DESCRIPTOR.render({
      sub,
      arg: args[1],
    });
    for (const line of text.split('\n')) ctx.chatLines.push(line);
    ctx.setChatScrollOffset(-1);
  });

  // Human surface reuses the agent immediate executor — does not recompute.
  registry.register(['status', 'st'], (args, ctx) => {
    const result = executeImmediateDashboardSlash(
      { name: 'status', args },
      { getStatusLines: ctx.getStatusLines ?? (() => []) },
    );
    if (!result) {
      ctx.chatLines.push(ctx.warning('  /status 는 인자 없이 · 자세히는 /status --debug'));
      ctx.setChatScrollOffset(-1);
      return;
    }
    for (const line of result.logLines ?? []) ctx.chatLines.push(line);
    ctx.setChatScrollOffset(-1);
  });

  return registry;
}
