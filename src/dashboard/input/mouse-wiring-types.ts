import type { ModalBounds, ModalSurface } from '../../display/modal-stack.js';
import type { DisplayMouseEvent, HitTarget, KeyEvent } from '../../display/types.js';
import type { ToastStack } from '../../ui/widgets/toast-stack.js';
import type { Printer } from '../../ui/printer.js';
import type { PopoverRegistrar } from '../../surface/adapters/popover-wiring.js';
import type { PillBound, PillName } from '../../status/pills.js';
import type { ThemeTokens } from '../../theme/tokens.js';
import type { WorkspaceHost } from '../../display/workspace-host.js';
import type { ConversationPopupHost } from '../../conv-dash/popup-host.js';
import type { ConversationPopupSummary, GitSegmentState, RunningBuildState, ShellRollupSummary, BackgroundJobsSummary, VwSummary } from '../../status/bar.js';
import type { StatusProviderInfo } from '../../status/status-provider-info.js';
import type { RotationEntry } from '../../user-config/types.js';
import type { ViewPreset } from '../../mouse-action-recipes.js';

export type DockItemBound =
  | { kind: 'menu'; startCol: number; endCol: number }
  | { kind: 'vw-mover-left'; enabled: boolean; startCol: number; endCol: number }
  | { kind: 'vw-mover-center'; enabled: boolean; startCol: number; endCol: number }
  | { kind: 'vw-mover-right'; enabled: boolean; startCol: number; endCol: number }
  | { kind: 'view'; startCol: number; endCol: number }
  | { kind: 'workspace-dock'; surfaceId: string; label: string; startCol: number; endCol: number };

export type DashboardInputHitTarget = { kind: 'input'; inputId: string };

export type DashboardModalHitTarget =
  | { kind: 'modal-body'; modalId: string; itemIndex?: number }
  | { kind: 'modal-title'; modalId: string }
  | { kind: 'modal-button'; modalId: string; buttonId: string };

export type DashboardPaneHitTarget = Extract<
  HitTarget,
  { kind: 'pane-body' | 'pane-title' | 'pane-nav-tab' }
>;

export type DashboardMousePreflightInputClassifier = (
  row: number,
  col: number,
) => DashboardInputHitTarget | null;

export type DashboardMousePreflightModalClassifier = (
  row: number,
  col: number,
) => DashboardModalHitTarget | null;

export type DashboardMousePreflightPaneClassifier = (
  row: number,
  col: number,
) => DashboardPaneHitTarget | null;

export interface DashboardStatusInput {
  swd: string;
  gitState?: GitSegmentState | string | null;
  providerInfo: StatusProviderInfo;
  contextUsedTokens?: number;
  tmuxLabel?: string | null;
  sshLabel?: string | null;
  host?: string | null;
  elapsedSec?: number;
  /** Running registered child agents. Omit or pass zero to hide. */
  runningAgents?: number;
  /** TUI-BG-JOB-VISIBILITY (#71) — turn-outliving shell jobs. Rendered as
   *  `⧗ 백그라운드 N` after the agents/controller pills. Omit or 0 to hide. */
  backgroundJobs?: BackgroundJobsSummary | null;
  /** External controller identity. Omit to hide. */
  controller?: string;
  shellCount?: number;
  /** SP-B — shell-runner rollup (running + bg counts). Rendered as
   *  `🐚 N▶ M⏸` next to the `⚡ N shells` pill. Omit to hide. */
  shellRollup?: ShellRollupSummary;
  /** VW-U1 — foreground virtual-window summary (null → segment hidden). */
  vw?: VwSummary | null;
  /** A1 — current input-core operating mode. 'general' renders as ''
   *  (no pill); 'sync' / 'control' render a ◆-prefixed flat segment
   *  between workingDir and model. Omit → treated as 'general'. */
  mode?: 'general' | 'sync' | 'control';
  conversationPopups?: ConversationPopupSummary | null;
  /** PR-S1V.4-wiring (2026-04-29) — voice mode indicator label. The
   *  dashboard subscribes to `voiceInputHost.onIndicatorChange` and
   *  passes the latest label through here; null/empty means the voice
   *  segment is hidden (idle). */
  voiceLabel?: string | null;
  /** The code this TUI process booted with. Present → a `▶ 실행` pill
   *  follows the git pill, which is then labelled `트리`. Omit to hide. */
  runningBuild?: RunningBuildState | null;
  theme?: ThemeTokens;
}

export interface DashboardMouseWiringDeps {
  /** Live terminal geometry. */
  termSize: () => { rows: number; cols: number };
  /** MR-2 — injectable scheduler for stable resize-handle hover.
   *  Tests pass a fake timer; runtime defaults to setTimeout. */
  schedule?: (fn: () => void, ms: number) => unknown;
  clearSchedule?: (handle: unknown) => void;
  /** DS-2b (2026-04-21) — optional drag-dispatch hook. When an
   *  active drag session is underway, `dragDispatch` consumes the
   *  event (returns true) and `handleMouse` short-circuits before
   *  the existing mouse chain. Called AFTER hitTarget attachment so
   *  the translation layer inside `dragDispatch` has a classified
   *  hit available. Omit to disable drag routing entirely (pure
   *  transparent passthrough · legacy mouse behavior preserved). */
  dragDispatch?: (ev: DisplayMouseEvent) => boolean;
  /** CMX-2 (2026-04-22) — optional context-menu dispatch hook.
   *  Called on `right-click` events AFTER the status-bar pill
   *  right-click branch (pills keep their existing direct path
   *  through `onPillRightClick`). When a `MenuProviderRegistry`
   *  returns a Menu for the hit, this hook shows the menu and
   *  returns `true` (consumed). For unprovidered hits it returns
   *  `false` so modal forwarding / pane handlers still run.
   *  Omit to disable pane/input right-click context menus entirely
   *  (pill path unaffected · backward-compat). */
  contextMenuDispatch?: (ev: DisplayMouseEvent) => boolean;
  /** Current rotation entries for the model picker. */
  getRotation: () => RotationEntry[];
  /** Fallback current active model entry when no explicit rotation is
   *  configured. Lets the model pill still open a picker shell with at
   *  least the active provider/model visible. */
  getCurrentModelEntry?: () => RotationEntry | null;
  /** Apply a picked rotation entry. Can be async. */
  setActiveModel: (entry: RotationEntry) => void | Promise<void>;
  /** Recent cwds for the wd picker (most-recent first, de-duped by caller). */
  getRecentWds: () => string[];
  /** Switch to a picked wd. Can be async. */
  setSessionWd: (path: string) => void | Promise<void>;
  onToggleChatOnly?: () => void | Promise<void>;
  onExitProgram?: () => void | Promise<void>;
  /** Dashboard views exposed through the dock area picker. */
  getDashboardViews?: () => Array<ViewPreset & { active?: boolean }>;
  onApplyDashboardView?: (viewId: string) => void | Promise<void>;
  /** Virtual window strip for the dock area. */
  getVirtualWindows?: () => Array<{ id: number; label: string; active?: boolean }>;
  onSwitchVirtualWindow?: (windowId: number) => void | Promise<void>;
  getVirtualWindowMover?: () => {
    canMoveLeft: boolean;
    canMoveRight: boolean;
    leftLabel: string;
    rightLabel: string;
  };
  onMoveVirtualWindow?: (direction: 'left' | 'right') => void | Promise<boolean>;
  /** Push a modal surface onto the display coordinator — returns a
   *  dispose handle that removes the surface when called. */
  pushModalSurface: (surface: ModalSurface) => { dispose: () => void };
  /** Request a redraw after state changes. */
  redraw: () => void;
  /** Request a coordinator-backed dashboard render so overlay surfaces
   *  repaint alongside the base frame. */
  requestRender?: () => void;
  /** VW-U1 — callback when the 🪟 vw pill is clicked. Typical host
   *  behaviour is `openWindowPicker()`. When omitted the pill is still
   *  painted, just not clickable. */
  onWindowPillClick?: () => void;
  /** U6 Bundle B — optional restore handler for docked workspace
   *  members. When `onWindowPillClick` is absent and the dashboard
   *  workspace contains docked entries, the wiring opens an anchored
   *  restore popup and delegates the picked `surfaceId` here. */
  onWorkspaceRestore?: (surfaceId: string) => void | Promise<void>;
  /** VW-U3 — access the currently-foreground modal surface (typically
   *  a VirtualWindow). When mouse clicks land inside the modal's bounds
   *  we dispatch through surface.onMouse so the VW can focus the
   *  clicked pane. Optional — callers that don't use modals can skip
   *  this. */
  getTopModalSurface?: () => ModalSurface | null;
  /** W4 Bundle A — topmost blocking modal, ignoring passive companion
   *  windows that still render above it. Used for background demotion
   *  checks so a passive popup cannot accidentally re-enable status /
   *  input clicks behind an underlying foreground window. */
  getTopBlockingModalSurface?: () => ModalSurface | null;
  /** M2 — optional coordinator-owned modal mouse route. When
   *  provided, modal forwarding uses this instead of calling
   *  `modal.onMouse` directly so consumed/refresh actions mark the
   *  modal dirty and schedule repaint under the same authority as
   *  onKey routing. */
  routeModalMouse?: (surface: ModalSurface, ev: DisplayMouseEvent) => boolean;
  updateModalBounds?: (id: string, bounds: ModalBounds) => boolean;
  /** Q6 mouse-wiring integration (Phase 4 · 2026-05-03) — drag-to-
   *  front on click. Called on left-click events BEFORE the rest of
   *  handleMouse. When provided, mouseWiring delegates the "is the
   *  click on a backgrounded popup that should come forward?" check
   *  to the host. Returns the raised surface id when a raise
   *  happened (so caller can log / instrument); null otherwise.
   *
   *  Wired in dashboard to `coord.tryRaiseModalAtPoint` — coord
   *  owns paintStack + tier policy + raiseInTier mechanics. The
   *  raise mutates paintStack + transfers focus in the SAME tick,
   *  so subsequent `getTopModalSurface()` reads return the raised
   *  popup and the click dispatches to it normally. */
  tryRaiseModalAtPoint?: (row: number, col: number) => string | null;
  /** A1 — callback when the ◆ mode pill is clicked. Host should open a
   *  quick mode switcher and delegate to setMode + the matching
   *  enterSyncMode / enterControlMode / exit helper. Empty list is OK
   *  — popup still renders with current-mode highlighted. */
  onModeSwitch?: (next: 'general' | 'sync' | 'control') => void | Promise<void>;
  /** A1 — current active mode, read fresh when the pill popup opens
   *  (so the user sees the correct selection highlighted). */
  getActiveMode?: () => 'general' | 'sync' | 'control';
  /** IDX-5 Phase 2 — right-click-on-pill handler. The wiring hands
   *  the pill name + 0-indexed terminal coordinates of the click so
   *  the host can call `registry.showMenu(handleForPill(name), pos)`.
   *  Omit and right-clicks on pills fall through to the default modal
   *  forward branch (pre-Phase-2 behaviour). */
  onPillRightClick?: (name: PillName, pos: { x: number; y: number }) => void;
  /** IDX-6 round-2 — live theme accessor for popup chrome. */
  getTheme?: () => ThemeTokens | null | undefined;
  workspaceHost?: WorkspaceHost;
  conversationPopupHost?: ConversationPopupHost;
  onConversationPopupPick?: (sessionId: string) => void | Promise<void>;
  /** IDX-5 Phase 3 B-4 — classify a click outside the status-bar
   *  pill region into broader pane areas. Host (dashboard) provides
   *  this because mouseWiring doesn't know about the pane layout /
   *  grid zone / pane-nav row. Returning null for unclassified
   *  positions (divider, hud, whitespace) is expected.
   *
   *  Result values flow into `ContextKeys.lastClickHitKind`, giving
   *  when-clauses and LLM introspection a coarse description of
   *  what the user just clicked: a pane-title row, a pane body, a
   *  pane-nav tab, or nothing recognizable. Evaluated only when the
   *  click missed a status-bar pill, so the pill result still wins
   *  when both geometries overlap.
   *
   *  F5b supersedes this with `getPaneHitTarget` for structured
   *  HitTarget attachment; this callback remains for the string-level
   *  `lastClickHitKind` contract that existing when-clauses rely on
   *  (`'status-bar-pill' | 'pane-body' | 'pane-title' | 'pane-nav'`).
   *  Hosts may provide only `getPaneHitTarget` — the wiring derives
   *  the legacy string from it automatically when this is omitted. */
  getPaneRegionKind?: (row: number, col: number) => 'pane-body' | 'pane-title' | 'pane-nav' | null;
  /** IDX-F5b — structured pane hit classification. Returns the full
   *  `HitTarget` (pane-nav-tab / pane-title / pane-body with paneId
   *  and optional widgetInstanceId) for clicks outside the status-bar
   *  pill region. Host (dashboard.ts) owns this because it has
   *  access to the live layout tree + grid zone + pane-nav hit areas.
   *  Null means no pane region under the cursor. Evaluated only when
   *  the click missed the status-bar classifier. Modal forwarding
   *  still runs when this is null and the click is inside a modal's
   *  bounds — modal-body synthesis happens separately. */
  getPaneHitTarget?: DashboardMousePreflightPaneClassifier;
  /** DS-3a preflight — text-input widget hit classifier. When the
   *  click lands on the chat composer (or any dashboard-hosted
   *  textInput widget), host returns `{kind:'input', inputId}` where
   *  `inputId` matches the SurfaceRegistry address
   *  (`dashboard.ts:12010` defines `'chat-main'`). Null means no
   *  text-input widget under the cursor.
   *
   *  Order: evaluated AFTER status-bar classification but BEFORE
   *  `getPaneHitTarget` — chat input is a fixed-position row beneath
   *  the status bar, and pane hit may otherwise shadow its region.
   *  Modal forwarding still wins when a modal covers the input row.
   *  Optional — omitting disables classification (backward compat:
   *  pre-DS-3a behavior). */
  getInputHitTarget?: DashboardMousePreflightInputClassifier;
  /** CMX-3f (2026-04-22) — optional modal hit classifier. Runs during
   *  the preflight cascade (after status bar + input, before pane) so
   *  right-click context-menu dispatch sees `{kind:'modal-body'|
   *  'modal-button', modalId, …}` instead of whatever's under the
   *  modal. Fixes an order bug where the existing `modal-body` hit
   *  attachment inside modal forwarding (line ~808) fires AFTER
   *  `contextMenuDispatch` (line ~763), leaving CMX-1's modal-body
   *  / modal-button HitKey providers effectively unreachable.
   *
   *  Callers synthesize from `getTopModalSurface().bounds` + optional
   *  `describeHit` to produce coarse modal-body OR fine modal-button
   *  targets. Return null when no modal is present or the cursor is
   *  outside its bounds.
   *
   *  Optional — omitting preserves pre-fix behaviour (modal hits
   *  only classified inside modal forwarding · too late for CMX
   *  dispatch). */
  getModalHitTarget?: DashboardMousePreflightModalClassifier;
  /** Bundle A · A2 — SurfaceRegistry popover registrar. Injected so
   *  pill popups (wd picker · mode switcher · …)
   *  register as `{kind:'popover'}` alongside the existing modal-tier
   *  registration, letting LLM `GetUIState({kind:'popover'})` /
   *  `ObserveSurface({kind:'popover'})` tools distinguish transient
   *  anchored UI from dialogs. Optional — when omitted the wiring
   *  creates its own singleton-backed registrar (production default). */
  popoverRegistrar?: PopoverRegistrar;
}

export interface DashboardMouseWiring {
  /** Call from the dashboard status area render function. Returns the
   *  ANSI string for that row (same content as the legacy
   *  buildStatusLine), and caches pill bounds as a side effect. */
  buildStatusLine(input: DashboardStatusInput): string;
  /** Bottom dock area. Renders the launcher button, current view
   *  selector, horizontal virtual-window strip, then any docked
   *  workspace entries, while caching click bounds for each section. */
  buildDockLine(): string;
  /** Call after composeVertical to record where the status area
   *  row ended up. Pass `composed.zoneRows.get('status')?.start`
   *  — 1-indexed terminal row, or null when the zone is absent. */
  setStatusRow(row: number | null): void;
  setDockRow(row: number | null): void;
  /** Wire into the raw mouse chokepoint. Returns true when the wiring
   *  consumed the event (pill popup opened, or an active popup
   *  processed it). */
  handleMouse(ev: DisplayMouseEvent): boolean;
  /** Apply the same preflight hit classification used by
   *  `handleMouse()`, without running the rest of the mouse-routing
   *  chain. This keeps input-core and drag consumers aligned on the
   *  same `ev.hitTarget` snapshot for a given frame. */
  preflightHitTarget(ev: DisplayMouseEvent): HitTarget | undefined;
  /** Wire into dispatchDashboardKey — returns 'consumed' when an
   *  active popup processed the key, 'passthrough' otherwise. */
  routeKey(key: KeyEvent): 'consumed' | 'passthrough';
  /** Paint the ToastStack — call near the end of the draw pipeline
   *  with a Printer sized to the full viewport. */
  renderToasts(p: Printer): void;
  /** True when a pill popup is currently mounted. */
  hasActivePopup(): boolean;
  /** Programmatic close of the active popup (e.g. on Esc from elsewhere). */
  closePopup(): void;
  /** Access to the ToastStack singleton — dashboard can push manual
   *  toasts (non-pill actions) if desired. */
  toasts(): ToastStack;
  /** IDX-5 Phase 1 — release the hover-tracker timer.
   *  Idempotent. Dashboard calls this at shutdown so the internal
   *  setTimeout + listener set don't keep the process alive. */
  dispose(): void;
  /** For tests. */
  _snapshot(): {
    pills: readonly PillBound[];
    dockItems: readonly DockItemBound[];
    statusRow: number | null;
    dockRow: number | null;
    popupId: string | null;
    modalMoveSession: {
      modalId: string;
      anchorRow: number;
      anchorCol: number;
      originBounds: ModalBounds;
      moved: boolean;
    } | null;
    modalResizeSession: {
      modalId: string;
      handle: 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se';
      anchorRow: number;
      anchorCol: number;
      originBounds: ModalBounds;
      moved: boolean;
    } | null;
    dockMoverSession: {
      anchorCol: number;
      anchorRow: number;
    } | null;
  };
}
