// MX11b — dashboard-side wiring for mouse-driven status-bar pills.
//
// Self-contained helper that dashboard.ts calls from three spots:
//   1. status-bar render     → buildStatusLine() + records pill cols
//   2. post-compose hook     → setStatusRow(row) with the 1-indexed
//                              row where the status bar landed
//   3. raw mouse chokepoint  → handleMouse(ev) returns 'consumed'
//                              when we opened a popup / routed to one
//
// Also exposes `routeKey` so the existing dispatchDashboardKey chain
// can forward keys to an active pill popup, and `renderToasts(p)` for
// the draw pipeline to paint the ToastStack on top of everything.
//
// The module owns two pieces of state:
//   - Last computed PillBound[] (refreshed every frame via
//     buildStatusLine)
//   - Currently mounted popup handle (ViewSurfaceHandle | null)
// plus a private ToastStack that feeds success feedback to the user.
//
// This file has NO dashboard imports — it takes callbacks for every
// cross-cutting concern. Unit-testable in isolation.

import chalk from 'chalk';
import { ctp, stripAnsi, visibleWidth } from '../../tui.js';
import { debug } from '../../debug/log.js';
import {
  modalMoveThreshold,
  type ModalBounds,
  type ModalSurface,
} from '../../display/modal-stack.js';
import {
  isBlockingModalInteractionSurface,
  isWorkspaceInteractionSurface,
} from '../../display/surface-interaction-policy.js';
import {
  isCaptureSessionEndMouseEventType,
  isCaptureSessionMouseEventType,
  isDiscreteClickMouseEventType,
  isPrimaryButtonClickMouseEventType,
  isSecondaryClickMouseEventType,
  type DisplayMouseEvent,
  type HitTarget,
  type KeyEvent,
} from '../../display/types.js';
import { ToastStack } from '../../ui/widgets/toast-stack.js';
import type { ViewSurfaceHandle } from '../../ui/modal-adapter.js';
import type { Printer } from '../../ui/printer.js';
import {
  createPopoverRegistrar,
  type PopoverRegistrar,
} from '../../surface/adapters/popover-wiring.js';
import type { PillBound, PillName } from '../../status/pills.js';
import { pillAtColumn } from '../../status/pills.js';
import { classifyStatusBarHit, hitTargetLabel } from '../../display/hit-target.js';
import { rectContains } from '../../display/rect.js';
import {
  createHoverTracker,
  wireHoverToContextKeys,
  type HoverTarget,
  type HoverTracker,
} from '../../ui/hover-tracker.js';
import { createHoverPresenter, type HoverPresenter } from '../../ui/hover-presenter.js';
import { resolveTooltipChromeSpec } from '../../ui/chrome/tooltip-chrome.js';
import type { ContextKeyService } from '../../input-core/context-keys.js';
import type { ThemeTokens } from '../../theme/tokens.js';
import type { WorkspaceHost } from '../../display/workspace-host.js';
import type { ConversationPopupHost } from '../../conv-dash/popup-host.js';
import {
  contextUsageSegment,
  type ConversationPopupSummary,
  hostSegment,
  sessionCwdSegment,
  conversationPopupSegment,
  gitSegment,
  modelSegment,
  elapsedSegment,
  modeSegment,
  ptyShellCountSegment,
  runningAgentsSegment,
  controllerSegment,
  shellRollupSegment,
  sshSegment,
  STATUS_SEGMENT_SEPARATOR,
  tmuxSegment,
  vwSegment,
  voiceSegment,
  type GitSegmentState,
  type ShellRollupSummary,
  type StatusBarRenderOptions,
  type VwSummary,
} from '../../status/bar.js';
import type { ActiveProviderInfo } from '../../provider-summary.js';
import { modelDisplayForRotationEntry, type RotationEntry } from '../../user-config.js';
import {
  createWdPickerRecipe,
  createShellRollupPopupRecipe,
  createModeSwitcherRecipe,
  createDockLauncherRecipe,
  createDockMenuTreeRecipe,
  createViewPickerRecipe,
  createWorkspaceDesktopShellRecipe,
  createWorkspaceRestoreRecipe,
  createConversationPopupShellRecipe,
  type PaneWindowPreset,
  type SurfaceCatalogPreset,
  type ShellRollupEntry,
  type ViewPreset,
} from '../../mouse-action-recipes.js';
import {
  buildWorkspaceDesktopModelFromHost,
} from '../../display/workspace-desktop-model.js';
import type { WorkspaceDesktopEntry } from '../../display/workspace-desktop-model.js';
import { attachSurfaceToWorkspace } from '../../display/workspace-affinity.js';

type DockItemBound =
  | { kind: 'menu'; startCol: number; endCol: number }
  | { kind: 'vw-mover-left'; enabled: boolean; startCol: number; endCol: number }
  | { kind: 'vw-mover-center'; enabled: boolean; startCol: number; endCol: number }
  | { kind: 'vw-mover-right'; enabled: boolean; startCol: number; endCol: number }
  | { kind: 'view'; startCol: number; endCol: number }
  | { kind: 'workspace-dock'; surfaceId: string; label: string; startCol: number; endCol: number };

type DockItemSeed =
  | { kind: 'menu' }
  | { kind: 'vw-mover-left'; enabled: boolean }
  | { kind: 'vw-mover-center'; enabled: boolean }
  | { kind: 'vw-mover-right'; enabled: boolean }
  | { kind: 'view' }
  | { kind: 'workspace-dock'; surfaceId: string; label: string };

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
  providerInfo: ActiveProviderInfo;
  contextUsedTokens?: number;
  tmuxLabel?: string | null;
  sshLabel?: string | null;
  host?: string | null;
  elapsedSec?: number;
  /** Running registered child agents. Omit or pass zero to hide. */
  runningAgents?: number;
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
  /** Dock area launcher targets for "Add Window". */
  getDockMenuWindowTargets?: () => PaneWindowPreset[];
  onOpenDockWindow?: (paneId: string) => void | Promise<void>;
  getDockMenuSurfaceTargets?: () => SurfaceCatalogPreset[];
  onOpenDockSurface?: (surfaceId: string) => void | Promise<void>;
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
  /** SRF-4 — return the live shell-runner handles for the rollup pill
   *  popup. Empty list is fine (popup still opens with a "no handles"
   *  toast). Omit to make the pill a no-op visual. */
  getShellRollupEntries?: () => ShellRollupEntry[];
  /** SRF-4 — user picked a handle in the rollup popup. Host runs the
   *  same decideAttach flow as `/shell attach`. */
  onShellRollupPick?: (handleId: string) => void;
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
  /** IDX-5 Phase 1 — ContextKeyService singleton. When provided, the
   *  wiring creates an internal HoverTracker, feeds it on every
   *  mouse event, and bridges hover-stable → ContextKeys
   *  (hoverTargetKind / hoverTooltip) + Tooltip auto-show.
   *  Omit for tests / headless paths that don't need hover. */
  ctx?: ContextKeyService;
  /** IDX-5 — injectable HoverTracker. Tests pass a tracker built
   *  with a fake timer to drive stable-hover deterministically; at
   *  runtime wiring creates its own via createHoverTracker(). */
  hoverTracker?: HoverTracker;
  /** Hover popup gate. The essential dashboard supplies `() => false`;
   *  omitted gates continue to show tooltips for other hosts. */
  hoverPopupsEnabled?: () => boolean;
  /** IDX-5 — override the per-pill tooltip text map. Callers can
   *  hide a tooltip by returning null. Default map covers the
   *  current pill names. */
  pillTooltipText?: (name: PillName) => string | null;
  /** IDX-5 Phase 2 — right-click-on-pill handler. The wiring hands
   *  the pill name + 0-indexed terminal coordinates of the click so
   *  the host can call `registry.showMenu(handleForPill(name), pos)`.
   *  Omit and right-clicks on pills fall through to the default modal
   *  forward branch (pre-Phase-2 behaviour). */
  onPillRightClick?: (name: PillName, pos: { x: number; y: number }) => void;
  /** IDX-F5d Phase 2 (2026-04-22) — pane-body hover dispatcher. When
   *  provided, the wiring auto-subscribes to its internal HoverTracker
   *  and translates pane-body hover-enter / -leave / -over / -stable
   *  events into `widgetHost.dispatchHover(paneId, widgetEv)` calls.
   *
   *  Dashboard wires this to `widgetHost.dispatchHover.bind(widgetHost)`.
   *  Headless / test harnesses omit it; tracker still fires for tests
   *  that subscribe directly.
   *
   *  Shape: the wiring emits a widget-level `WidgetHoverEvent` (from
   *  widget-types.ts) — consumer must keep the type import since
   *  dashboard-mouse-wiring deliberately doesn't import widget-types
   *  to preserve its layering (mouse wiring is lower than widget
   *  host). We use a structural type to avoid the import. */
  dispatchHoverToWidget?: (
    paneId: string,
    event:
      | { kind: 'hover-enter'; hit: unknown }
      | { kind: 'hover-leave'; hit: unknown }
      | { kind: 'hover-over'; hit: unknown; row: number; col: number }
      | { kind: 'hover-stable'; hit: unknown },
  ) => void;
  /** P1 Bundle C — dashboard-level pane hover observer. Lets the host
   *  surface pane-body hover metadata (HUD, status-bar, analytics)
   *  without reaching into the internal HoverTracker directly. */
  onPaneHoverEvent?: (
    event:
      | { kind: 'hover-enter'; target: HoverTarget }
      | { kind: 'hover-leave'; target: HoverTarget }
      | { kind: 'hover-over'; target: HoverTarget; x: number; y: number }
      | { kind: 'hover-stable'; target: HoverTarget },
  ) => void;
  /** IDX-6 round-2 — live theme accessor. When provided, the
   *  auto-mounted Tooltip surface resolves its muted prefix from the
   *  current theme. Evaluated lazily per tooltip so /theme switch
   *  during a session reflows the next tooltip correctly. */
  getTheme?: () => ThemeTokens | null | undefined;
  /** Disable dashboard hover hint popups/context-key hover copy
   *  wholesale. Keeps mouse hover passive while preserving click
   *  routing. */
  suppressHoverHints?: boolean;
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
   *  pill popups (wd picker · mode switcher · shell rollup · …)
   *  register as `{kind:'popover'}` alongside the existing modal-tier
   *  registration, letting LLM `GetUIState({kind:'popover'})` /
   *  `ObserveSurface({kind:'popover'})` tools distinguish transient
   *  anchored UI from dialogs. Optional — when omitted the wiring
   *  creates its own singleton-backed registrar (production default). */
  popoverRegistrar?: PopoverRegistrar;
}

/** IDX-5 Phase 1 — default pill tooltip map. Explained to the user:
 *  what the pill IS, what clicking IT DOES. Terse (single line)
 *  because Tooltip widget paints as `▕ text` — no wrap. */
const DEFAULT_PILL_TOOLTIPS: Readonly<Record<PillName, string>> = {
  workingDir: 'Working directory — click to switch to a recent cwd',
  model: 'Active model — click to pick from rotation',
  mode: 'Operating mode — click to switch (general / sync / control)',
  shellRollup: 'Shell handles — click to attach or inspect',
  virtualWindow: 'Virtual window — click to open window picker',
  workspaceDock: 'Parked windows — click to inspect docked or dormant entries',
  conversationPopup: 'Conversation popups — click to focus or restore',
  acpSending: 'ACP sticky send — click to inspect in-flight ACP surface state',
};

function dockKindIcon(kind: WorkspaceDesktopEntry['kind']): string {
  switch (kind) {
    case 'popup': return '◫';
    case 'dialog': return '◇';
    case 'terminal': return '▣';
    case 'pane': return '▤';
    case 'authored': return '✎';
    default: return '◫';
  }
}

function dockAccent(surfaceId: string, theme?: ThemeTokens): string {
  const palette = theme
    ? [theme.colors.info, theme.colors.highlight, theme.colors.accent, theme.colors.success, theme.colors.warning]
    : ['#89b4fa', '#f5c2e7', '#fab387', '#a6e3a1', '#f9e2af'];
  let hash = 0;
  for (let i = 0; i < surfaceId.length; i++) hash = ((hash << 5) - hash) + surfaceId.charCodeAt(i);
  return palette[Math.abs(hash) % palette.length]!;
}

function middleTruncateLabel(label: string, maxWidth: number): string {
  const plain = stripAnsi(label);
  if (visibleWidth(plain) <= maxWidth) return label;
  if (maxWidth <= 1) return '…';
  return `${plain.slice(0, Math.max(1, maxWidth - 1))}…`;
}

function appendDockSegment(
  parts: string[],
  items: DockItemBound[],
  colRef: { value: number },
  termCols: number,
  render: string,
  item: DockItemSeed,
  joinTight = false,
): void {
  const width = visibleWidth(stripAnsi(render));
  const nextWidth = (parts.length > 0 && !joinTight ? 1 : 0) + width;
  if (colRef.value + nextWidth > termCols) return;
  if (parts.length > 0 && !joinTight) colRef.value += 1;
  const startCol = colRef.value;
  const endCol = startCol + width;
  items.push({ ...item, startCol, endCol } as DockItemBound);
  colRef.value = endCol;
  parts.push(render);
}

function appendDockGroup(
  parts: string[],
  items: DockItemBound[],
  colRef: { value: number },
  termCols: number,
  render: string,
  group: Array<{ item: DockItemSeed | null; width: number }>,
): void {
  const width = visibleWidth(stripAnsi(render));
  const nextWidth = (parts.length > 0 ? 1 : 0) + width;
  if (colRef.value + nextWidth > termCols) return;
  if (parts.length > 0) colRef.value += 1;
  let cursor = colRef.value;
  for (const entry of group) {
    const startCol = cursor;
    const endCol = startCol + entry.width;
    if (entry.item) items.push({ ...entry.item, startCol, endCol } as DockItemBound);
    cursor = endCol;
  }
  colRef.value += width;
  parts.push(render);
}

function repeatPad(width: number): string {
  return width > 0 ? ' '.repeat(width) : '';
}

function appendDockDivider(
  parts: string[],
  colRef: { value: number },
  termCols: number,
  render: string,
): void {
  const width = visibleWidth(stripAnsi(render));
  const nextWidth = (parts.length > 0 ? 1 : 0) + width;
  if (colRef.value + nextWidth > termCols) return;
  if (parts.length > 0) colRef.value += 1;
  colRef.value += width;
  parts.push(render);
}

/** IDX-5 Phase 1 — compute the HoverTarget for a mouse position over
 *  the status-bar row. `statusRow` and `row` are 1-indexed (matches
 *  DisplayMouseEvent.row). Returns null for anything outside the
 *  status bar, including the neighbouring row. Exported for tests. */
export function pillHoverTarget(
  pills: readonly PillBound[],
  statusRow: number | null,
  row: number,
  col: number,
  tooltipFor: (name: PillName) => string | null = (n) => DEFAULT_PILL_TOOLTIPS[n] ?? null,
): HoverTarget | null {
  if (statusRow === null) return null;
  // Accept status row exact or one-above — matches the click tolerance
  // (see openPillPopup's nearStatusRow rule). Avoids flicker when the
  // visual top edge of a pill cell emits row-1.
  if (row !== statusRow && row !== statusRow - 1) return null;
  const col0 = col - 1;
  const hit = pillAtColumn(pills, col0);
  if (!hit) return null;
  const tt = tooltipFor(hit.name);
  return {
    id: `pill:${hit.name}`,
    kind: 'status-bar-pill',
    tooltipText: tt ?? undefined,
  };
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
  /** F6 / S1.D — resolve the tooltip text that would appear if the
   *  pointer hovered over the given hit. Reads the wiring's existing
   *  `pillTooltipText` resolver for `pill` kinds; returns null for
   *  every other kind (no provider registered yet). Used by the
   *  GetHoverTooltip LLM tool runtime so an LLM can ask "what does
   *  the model pill say?" without needing to first synthesise a hover. */
  getTooltipFor(target: HitTarget): string | null;
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
  /** IDX-5 Phase 1 — release hover-tracker timer + tooltip presenter.
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
    hoverActiveTooltipId: string | null;
  };
}

type PopupMouseRoutingResult =
  | 'consumed'
  | 'dismissed-consumed'
  | 'dismissed-passthrough';

interface PopupAuthority {
  mount(handle: ViewSurfaceHandle, kindTag: string, ownerWorkspaceId?: string): void;
  close(): void;
  hasActivePopup(): boolean;
  routeKey(key: KeyEvent): 'consumed' | 'passthrough';
  routeMouse(ev: DisplayMouseEvent): PopupMouseRoutingResult | null;
  snapshotId(): string | null;
}

function createPopupAuthority(deps: {
  pushModalSurface: DashboardMouseWiringDeps['pushModalSurface'];
  redraw: DashboardMouseWiringDeps['redraw'];
  requestRender?: DashboardMouseWiringDeps['requestRender'];
  popoverRegistrar: PopoverRegistrar;
}): PopupAuthority {
  let activePopup: ViewSurfaceHandle | null = null;
  let activePopupDispose: (() => void) | null = null;
  let activePopupId: string | null = null;

  const close = (): void => {
    if (activePopupId) {
      try { deps.popoverRegistrar.unregister(activePopupId); } catch { /* ignore */ }
      activePopupId = null;
    }
    if (activePopup) {
      activePopup.dispose();
      activePopup = null;
    }
    if (activePopupDispose) {
      try { activePopupDispose(); } catch { /* ignore */ }
      activePopupDispose = null;
    }
  };

  return {
    mount(handle, kindTag, ownerWorkspaceId) {
      close();
      activePopup = handle;
      handle.surface.onKey = (ev: KeyEvent) => handle.handleKey(ev);
      handle.surface.tier = 'popup';
      attachSurfaceToWorkspace(handle.surface, ownerWorkspaceId);
      activePopupDispose = deps.pushModalSurface(handle.surface).dispose;
      activePopupId = deps.popoverRegistrar.register(kindTag, { kindTag: `pill-${kindTag}` });
    },
    close,
    hasActivePopup() {
      return activePopup !== null;
    },
    routeKey(key) {
      if (!activePopup) return 'passthrough';
      const before = activePopup;
      const result = activePopup.handleKey(key);
      if (result === 'consumed' && activePopup === before) {
        (deps.requestRender ?? deps.redraw)();
      }
      return result;
    },
    routeMouse(ev) {
      if (!activePopup) return null;
      const before = activePopup;
      const res = activePopup.handleMouse(ev);
      const isDiscreteOutsideClick =
        res === 'passthrough'
        && isDiscreteClickMouseEventType(ev.type);
      if (res === 'consumed' && activePopup === before) {
        (deps.requestRender ?? deps.redraw)();
      }
      if (!isDiscreteOutsideClick) return 'consumed';
      close();
      return isSecondaryClickMouseEventType(ev.type)
        ? 'dismissed-passthrough'
        : 'dismissed-consumed';
    },
    snapshotId() {
      return activePopup ? activePopup.surface.id : null;
    },
  };
}

export function createDashboardMouseWiring(deps: DashboardMouseWiringDeps): DashboardMouseWiring {
  const toastStack = new ToastStack({
    placement: 'top-right',
    maxVisible: 3,
    getTheme: deps.getTheme,
  });
  let pills: PillBound[] = [];
  let dockItems: DockItemBound[] = [];
  let dockMoverSession:
    | {
        anchorCol: number;
        anchorRow: number;
      }
    | null = null;
  let statusRow: number | null = null;
  let dockRow: number | null = null;
  let modalMoveSession: {
    modalId: string;
    anchorRow: number;
    anchorCol: number;
    originBounds: ModalBounds;
    moved: boolean;
  } | null = null;
  let modalResizeSession: {
    modalId: string;
    handle: 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se';
    anchorRow: number;
    anchorCol: number;
    originBounds: ModalBounds;
    moved: boolean;
  } | null = null;
  let modalResizeHover:
    | {
        modalId: string;
        hint: 'nw' | 'ne' | 'sw' | 'se';
        timer: unknown | null;
        visible: boolean;
      }
    | null = null;
  const popoverRegistrar: PopoverRegistrar =
    deps.popoverRegistrar ?? createPopoverRegistrar();
  const schedule = deps.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearSchedule = deps.clearSchedule ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const popupAuthority = createPopupAuthority({
    pushModalSurface: deps.pushModalSurface,
    redraw: deps.redraw,
    requestRender: deps.requestRender,
    popoverRegistrar,
  });

  // IDX-5 Phase 1 — hover tracker + tooltip presenter. Both are
  // optional: when neither `ctx` nor `hoverTracker` is supplied the
  // wiring behaves exactly as pre-IDX-5 (no extra state, no timers,
  // no subscriptions). When a tracker is present we bridge to
  // ContextKeys (if ctx given) and auto-show a Tooltip surface on
  // stable-hover targets with tooltipText.
  const hoverHintsEnabled = deps.suppressHoverHints !== true;
  const currentPopupWorkspaceId = (): string => {
    const top = deps.getTopModalSurface?.() ?? null;
    return top && isWorkspaceInteractionSurface(top)
      ? top.id
      : 'dashboard-main';
  };
  const hoverTracker: HoverTracker | null =
    hoverHintsEnabled
      ? (deps.hoverTracker ?? (deps.ctx ? createHoverTracker() : null))
      : null;
  const tooltipFor: (name: PillName) => string | null =
    hoverHintsEnabled
      ? (deps.pillTooltipText ?? ((n) => DEFAULT_PILL_TOOLTIPS[n] ?? null))
      : (() => null);
  let disposeHoverCtxBridge: (() => void) | null = null;
  let hoverPresenter: HoverPresenter | null = null;
  if (hoverTracker && deps.ctx) {
    try {
      disposeHoverCtxBridge = wireHoverToContextKeys(hoverTracker, deps.ctx);
    } catch {
      // Bridge failure must never break boot — ctx updates can be
      // debugged out-of-band.
    }
  }
  if (hoverTracker) {
    try {
      hoverPresenter = createHoverPresenter(hoverTracker, {
        termSize: deps.termSize,
        pushSurface: deps.pushModalSurface,
        redraw: deps.redraw,
        getTheme: deps.getTheme,
        getChromeSpec: () => resolveTooltipChromeSpec({ title: 'Hint' }),
        enabled: deps.hoverPopupsEnabled,
      });
    } catch {
      /* presenter failure is non-fatal; hover keys still update */
    }
  }
  // IDX-F5d Phase 2 — bridge pane-body hover events to widget.onHover
  // via the host-provided dispatcher. Subscribe only when BOTH the
  // tracker and the dispatcher are present; subscription is released
  // in `dispose()`.
  let disposeHoverWidgetBridge: (() => void) | null = null;
  if (hoverTracker && deps.dispatchHoverToWidget) {
    try {
      const dispatch = deps.dispatchHoverToWidget;
      disposeHoverWidgetBridge = hoverTracker.subscribe((ev) => {
        const t = ev.target;
        if (t.kind !== 'pane-body' || !t.paneId || !t.hit) return;
        if (ev.kind === 'hover-over') {
          dispatch(t.paneId, { kind: ev.kind, hit: t.hit, row: ev.y, col: ev.x });
        } else {
          dispatch(t.paneId, { kind: ev.kind, hit: t.hit });
        }
      });
    } catch {
      /* bridge failure non-fatal — pane-body widgets just won't see hover */
    }
  }
  let disposePaneHoverBridge: (() => void) | null = null;
  if (hoverTracker && deps.onPaneHoverEvent) {
    try {
      const onPaneHoverEvent = deps.onPaneHoverEvent;
      disposePaneHoverBridge = hoverTracker.subscribe((ev) => {
        if (ev.target.kind !== 'pane-body' || !ev.target.paneId) return;
        onPaneHoverEvent(ev);
      });
    } catch {
      /* bridge failure non-fatal — pane hover HUD remains absent */
    }
  }

  const buildStatusLine = (input: DashboardStatusInput): string => {
    // 2026-05-05 — narrow-width gate. modelSegment honours
    // `compact: true` to truncate model id at the first parameter-size
    // marker (e.g. qwen3.6-35b-a3b-ud-mlx → qwen3.6-35b). Threshold
    // 100 cols matches typical "narrow terminal vs comfortable wide
    // terminal" boundary; everything above stays full-width.
    const { cols } = deps.termSize();
    const opts: StatusBarRenderOptions = { theme: input.theme, compact: cols < 100 };
    const segments: Array<{ name: PillName | null; render: string }> = [
      { name: 'workingDir', render: sessionCwdSegment(input.swd, opts) },
      { name: null,         render: gitSegment(input.swd, input.gitState ?? undefined, opts) },
      { name: 'model',      render: modelSegment(input.providerInfo, opts) },
    ];
    const runningAgentsRender = runningAgentsSegment(input.runningAgents ?? 0, opts);
    if (runningAgentsRender) segments.push({ name: null, render: runningAgentsRender });
    const controllerRender = controllerSegment(input.controller, opts);
    if (controllerRender) segments.push({ name: null, render: controllerRender });
    // A1 — mode pill between model and elapsed. `'general'` yields
    // empty render so the pill disappears by default; only sync /
    // control get painted. Name 'mode' is always set so click still
    // has a target once the segment is visible.
    const modeRender = modeSegment(input.mode ?? 'general', opts);
    if (modeRender) segments.push({ name: 'mode', render: modeRender });
    if (typeof input.contextUsedTokens === 'number') {
      segments.push({ name: null, render: contextUsageSegment(input.contextUsedTokens, opts) });
    }
    if (input.host) {
      segments.push({ name: null, render: hostSegment(input.host, opts) });
    }
    if (input.tmuxLabel) {
      segments.push({ name: null, render: tmuxSegment(input.tmuxLabel, opts) });
    } else if (input.sshLabel) {
      segments.push({ name: null, render: sshSegment(input.sshLabel, opts) });
    }
    if (typeof input.elapsedSec === 'number') {
      segments.push({ name: null, render: elapsedSegment(input.elapsedSec, opts) });
    }
    const shellCount = input.shellCount ?? 0;
    if (shellCount > 0) {
      segments.push({ name: null, render: ptyShellCountSegment(shellCount, opts) });
    }
    if (input.shellRollup) {
      const render = shellRollupSegment(input.shellRollup, opts);
      // SRF-4 — tag rollup as a pill so clicks route to the handle popup.
      if (render) segments.push({ name: 'shellRollup', render });
    }
    // VW-U1 — virtual-window pill sits to the right of shell-count so
    // the eye lands on "session identity (wd+git+model)" first, then
    // on "runtime activity (shells, vw)". vwSegment itself decides to
    // render '' when there's only one window + one pane.
    const vwRender = vwSegment(input.vw ?? null, opts);
    if (vwRender) {
      segments.push({ name: 'virtualWindow', render: vwRender });
    }
    if (deps.conversationPopupHost) {
      const render = conversationPopupSegment(input.conversationPopups ?? null, opts);
      if (render) {
        segments.push({ name: 'conversationPopup', render });
      }
    }
    // PR-S1V.4-wiring — voice indicator. Sits at the right edge of the
    // pill row so it never displaces session identity (cwd/git/model)
    // when the user toggles voice mode mid-session. voiceSegment hides
    // itself when label is null/empty.
    const voiceRender = voiceSegment(input.voiceLabel, opts);
    if (voiceRender) {
      segments.push({ name: null, render: voiceRender });
    }

    // Compute column positions as segments concatenate with the same
    // separator string the renderer uses. `visibleWidth` counts cells
    // (wide-char aware), so the pill bounds stay correct.
    const nextPills: PillBound[] = [];
    const parts: string[] = [];
    let col = 0;
    const sepW = visibleWidth(stripAnsi(STATUS_SEGMENT_SEPARATOR));
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      if (i > 0) col += sepW;
      const width = visibleWidth(stripAnsi(seg.render));
      if (seg.name) nextPills.push({ name: seg.name, startCol: col, endCol: col + width });
      col += width;
      parts.push(seg.render);
    }
    pills = nextPills;
    return parts.join(STATUS_SEGMENT_SEPARATOR);
  };

  const setStatusRow = (row: number | null): void => {
    statusRow = row;
  };
  const setDockRow = (row: number | null): void => {
    dockRow = row;
  };
  let lastDockChromeDebugKey = '';

  const buildDockLine = (): string => {
    dockItems = [];
    const desktop = deps.workspaceHost
      ? buildWorkspaceDesktopModelFromHost(deps.workspaceHost, 'dashboard-main')
      : null;
    const entries = desktop?.dockEntries ?? [];
    const windows = deps.getVirtualWindows?.() ?? [];
    const views = deps.getDashboardViews?.() ?? [];
    const { cols: termCols } = deps.termSize();
    const theme = deps.getTheme?.() ?? undefined;
    const parts: string[] = [];
    const col = { value: 0 };
    const divider = chalk.hex(theme?.colors.muted ?? '#6c7086')('│');
    const appendDivider = () => appendDockDivider(parts, col, termCols, divider);

    appendDockSegment(
      parts,
      dockItems,
      col,
      termCols,
      chalk.hex(theme?.colors.info ?? '#89b4fa').bold('≡ Menu'),
      { kind: 'menu' },
    );

    const mover = deps.getVirtualWindowMover?.();
    if (mover && windows.length > 0) {
      const moverMuted = theme?.colors.muted ?? '#6c7086';
      const moverAccent = theme?.colors.info ?? '#89b4fa';
      const moverDrag = theme?.colors.highlight ?? '#f5c2e7';
      // 원래 theme.widget.border 를 읽었으나 ThemeWidgetTokens 에 border 토큰이
      // 없어 런타임 항상 fallback 이었다. behavior-preserving 리터럴 유지(selected
      // 는 선택 하이라이트라 shell bg 로 부적절). 테마화는 별도 UI 변경으로.
      const moverShellBg = '#303446';
      const moverPad = termCols >= 180 && windows.length <= 2
        ? 4
        : termCols >= 140 && windows.length <= 3
          ? 2
          : 0;
      const centerPad = 1;
      const leftRender = ` ${repeatPad(moverPad)}${mover.leftLabel}${repeatPad(moverPad)} `;
      const centerRender = ` ${repeatPad(centerPad)}🖥️${repeatPad(centerPad)} `;
      const rightRender = ` ${repeatPad(moverPad)}${mover.rightLabel}${repeatPad(moverPad)} `;
      appendDivider();
      const leftStyled = mover.canMoveLeft
        ? chalk.hex(moverAccent).bold(leftRender)
        : chalk.hex(moverMuted)(leftRender);
      const centerStyled = chalk.hex(moverDrag).bold(centerRender);
      const rightStyled = mover.canMoveRight
        ? chalk.hex(moverAccent).bold(rightRender)
        : chalk.hex(moverMuted)(rightRender);
      const moverRender = chalk.bgHex(moverShellBg)(`${leftStyled}${centerStyled}${rightStyled}`);
      appendDockGroup(
        parts,
        dockItems,
        col,
        termCols,
        moverRender,
        [
          {
            item: { kind: 'vw-mover-left', enabled: mover.canMoveLeft },
            width: visibleWidth(stripAnsi(leftRender)),
          },
          {
            item: { kind: 'vw-mover-center', enabled: true },
            width: visibleWidth(stripAnsi(centerRender)),
          },
          {
            item: { kind: 'vw-mover-right', enabled: mover.canMoveRight },
            width: visibleWidth(stripAnsi(rightRender)),
          },
        ],
      );
    }

    const activeView = views.find((view) => view.active) ?? views[0];
    if (activeView) {
      const label = middleTruncateLabel(activeView.label, termCols >= 120 ? 20 : 14);
      appendDivider();
      appendDockSegment(
        parts,
        dockItems,
        col,
        termCols,
        `${chalk.hex(theme?.colors.muted ?? '#6c7086')('View')} ${chalk.hex(theme?.colors.highlight ?? '#f5c2e7').bold(label)}`,
        { kind: 'view' },
      );
    }

    for (const entry of entries) {
      const accent = dockAccent(entry.surfaceId, theme);
      const icon = chalk.hex(accent)(dockKindIcon(entry.kind));
      const budget = termCols >= 140 ? 18 : termCols >= 100 ? 14 : 10;
      const label = middleTruncateLabel(entry.label, budget);
      const render = `${icon} ${chalk.hex(accent).bold(label)}`;
      appendDivider();
      appendDockSegment(parts, dockItems, col, termCols, render, {
        kind: 'workspace-dock',
        surfaceId: entry.surfaceId,
        label: entry.label,
      });
    }
    if (debug.enabled) {
      const key = JSON.stringify({
        cols: termCols,
        mover: mover
          ? {
            canMoveLeft: mover.canMoveLeft,
            canMoveRight: mover.canMoveRight,
            leftLabel: mover.leftLabel,
            rightLabel: mover.rightLabel,
          }
          : null,
        items: dockItems.map((item) => item.kind),
      });
      if (key !== lastDockChromeDebugKey) {
        lastDockChromeDebugKey = key;
        debug.log('dashboard.dock.chrome', 'compose', {
          cols: termCols,
          mover,
          items: dockItems.map((item) => item.kind),
        });
      }
    }
    return parts.join(' ');
  };

  // IDX-6 Phase 5 adoption — build the ModalShadowSpec for pill
  // popups from the caller's theme accessor. Returns undefined
  // when the accessor is absent OR the env opt-out is set, which
  // keeps the pre-adoption paint path intact for tests / users who
  // prefer the flatter look.
  const pillPopupShadow = () => {
    if (process.env.ELANOUS_MODAL_SHADOW === 'off') return undefined;
    const theme = deps.getTheme?.();
    return theme ? { theme } : undefined;
  };

  const popupPlacementFromDockHit = (
    hit: DockItemBound,
    anchorRow: number,
  ): import('../../status/popups.js').PopupPlacement => {
    const { rows: termRows, cols: termCols } = deps.termSize();
    return {
      anchorStartCol: hit.startCol,
      anchorEndCol: hit.endCol,
      statusRow: anchorRow,
      termCols,
      termRows,
    };
  };

  const openDockLauncherPopup = (
    placement: import('../../status/popups.js').PopupPlacement,
  ): boolean => {
    const panes = deps.getDockMenuWindowTargets?.() ?? [];
    const surfaces = deps.getDockMenuSurfaceTargets?.() ?? [];
    const canOpenWindow = panes.length > 0 && !!deps.onOpenDockWindow;
    const canOpenSurface = surfaces.length > 0 && !!deps.onOpenDockSurface;
    // Empty catalogs still consume the dock-row click: the parent
    // launcher (`recipe:dock-launcher`) paints Chat only / Exit even
    // when no window/surface targets are published. The tree recipe
    // is reserved for hosts that actually have a submenu catalog.
    if (!canOpenWindow && !canOpenSurface) {
      const handle = createDockLauncherRecipe({
        placement,
        onPick: async (action) => {
          if (action === 'chat-only') await deps.onToggleChatOnly?.();
          if (action === 'exit-program') await deps.onExitProgram?.();
          closePopup();
        },
        onCancel: () => closePopup(),
        theme: deps.getTheme?.() ?? undefined,
        shadow: undefined,
      });
      popupAuthority.mount(handle, 'dockLauncher', currentPopupWorkspaceId());
      return true;
    }
    const handle = createDockMenuTreeRecipe({
      placement,
      windowPanes: panes,
      surfaces,
      onOpenWindow: async (paneId) => {
        await deps.onOpenDockWindow?.(paneId);
        deps.redraw();
        closePopup();
      },
      onOpenSurface: async (surfaceId) => {
        await deps.onOpenDockSurface?.(surfaceId);
        deps.redraw();
        closePopup();
      },
      onToggleChatOnly: async () => {
        await deps.onToggleChatOnly?.();
        closePopup();
      },
      onExitProgram: async () => {
        await deps.onExitProgram?.();
        closePopup();
      },
      onCancel: () => closePopup(),
      theme: deps.getTheme?.() ?? undefined,
      // Bottom-anchored dock popup should not project a shadow into the
      // fixed dock row; keep the menu slab itself but skip the extra
      // shadow band here.
      shadow: undefined,
    });
    popupAuthority.mount(handle, 'dockLauncher', currentPopupWorkspaceId());
    return true;
  };

  const openDockViewPicker = (
    placement: import('../../status/popups.js').PopupPlacement,
  ): boolean => {
    const presets = (deps.getDashboardViews?.() ?? []).map((view) => ({
      id: view.id,
      label: view.id.startsWith('action:')
        ? view.label
        : view.active ? `● ${view.label}` : `○ ${view.label}`,
    }));
    if (presets.length === 0 || !deps.onApplyDashboardView) return false;
    const handle = createViewPickerRecipe({
      presets,
      placement,
      onApply: async (viewId) => {
        await deps.onApplyDashboardView?.(viewId);
        closePopup();
      },
      onCancel: () => closePopup(),
      theme: deps.getTheme?.() ?? undefined,
      shadow: pillPopupShadow(),
    });
    popupAuthority.mount(handle, 'dockView', currentPopupWorkspaceId());
    return true;
  };

  const openWorkspaceDockPopup = (
    placement: {
      anchorStartCol: number;
      anchorEndCol: number;
      statusRow: number;
      termCols: number;
      termRows: number;
    },
  ): boolean => {
    if (!deps.workspaceHost || !deps.onWorkspaceRestore) return false;
    const desktop = buildWorkspaceDesktopModelFromHost(deps.workspaceHost, 'dashboard-main');
    const dockEntries = desktop?.dockEntries ?? [];
    const dormantEntries = desktop?.dormantEntries ?? [];
    if (!desktop || (dockEntries.length === 0 && dormantEntries.length === 0)) return false;
    const handle = createWorkspaceDesktopShellRecipe({
      workspaceLabel: desktop.label,
      layoutMode: desktop.layoutMode,
      liveEntries: desktop.liveEntries.map((entry) => ({
        surfaceId: entry.surfaceId,
        label: entry.label,
        kind: entry.kind,
        focused: entry.focused,
      })),
      dockEntries: dockEntries.map((entry) => ({
        surfaceId: entry.surfaceId,
        label: `${entry.label}  docked · restore`,
        kind: entry.kind,
        focused: entry.focused,
      })),
      dormantEntries: dormantEntries.map((entry) => ({
        surfaceId: entry.surfaceId,
        label: `${entry.label}  dormant · restore`,
        kind: entry.kind,
        focused: entry.focused,
      })),
      placement,
      onRestore: async (surfaceId) => {
        await deps.onWorkspaceRestore?.(surfaceId);
        closePopup();
      },
      onCancel: () => closePopup(),
      toasts: toastStack,
      theme: deps.getTheme?.() ?? undefined,
      shadow: pillPopupShadow(),
    });
    popupAuthority.mount(handle, 'workspaceDock', currentPopupWorkspaceId());
    return true;
  };

  const openPillPopup = (pill: PillBound, opts: { reverseCycle?: boolean } = {}): void => {
    closePopup();
    if (statusRow === null) {
      // P0-2 — previously a silent early return. Surface the failure
      // so the user sees WHY the click did nothing, and trace for
      // post-mortem when the status-bar layout stops publishing its
      // row.
      if (debug.enabled) {
        debug.log('mouse.pill', 'openPillPopup:statusRow-null', {
          pill: pill.name,
        });
      }
      toastStack.push({
        text: `pill-click (${pill.name}) — status row unknown, click again after next redraw`,
        kind: 'warning',
      });
      deps.redraw();
      return;
    }
    const { rows: termRows, cols: termCols } = deps.termSize();
    const placement = {
      anchorStartCol: pill.startCol,
      anchorEndCol: pill.endCol,
      statusRow,
      termCols,
      termRows,
    };

    let handle: ViewSurfaceHandle | null = null;
    const minimizePopup = (surfaceId: string, label: string): void => {
      if (deps.workspaceHost) {
        deps.workspaceHost.upsertMember('dashboard-main', {
          surfaceId,
          kind: 'popup',
          label,
          order: 260,
        });
        deps.workspaceHost.minimizeMember('dashboard-main', surfaceId, { docked: true });
      }
      closePopup();
      deps.redraw();
    };
    if (pill.name === 'model') {
      // 2026-05-05 (UX): pill click now CYCLES to the next rotation
      // entry directly instead of opening a picker popup. User feedback:
      //   "차라리 status bar에 모델을 클릭할때마다 순환으로 도는 것이
      //    트리거 되도록 해주세요. picker가 뜨는 것은 그럼 없애는게
      //    어떨까요?"
      // The picker popup was clearing too much screen real estate
      // (input bar → status dock) for what's normally a one-step
      // action. Click = cycle (most common path); for visual selection
      // power users can run `/provider pick` to open the picker
      // explicitly. Right-click context menu (other pills) is
      // unaffected.
      const entries = deps.getRotation();
      const fallbackEntry = deps.getCurrentModelEntry?.() ?? null;
      const ring = entries.length > 0
        ? entries
        : fallbackEntry ? [fallbackEntry] : [];
      if (ring.length === 0) {
        toastStack.push({
          text: 'No model rotation configured · /setup → Detect all from env',
          kind: 'warning',
        });
        deps.redraw();
        return;
      }
      // Find current entry to compute next. Match by (provider, model)
      // tuple — if the active config doesn't sit on any rotation entry
      // (manual override), start the cycle at index 0.
      // 2026-05-05 — Ctrl+클릭 = 역방향 cycle (사용자 요청). caller 가
      // ev.ctrl 을 reverseCycle 로 전달.
      const reverse = !!opts.reverseCycle;
      const current = fallbackEntry;
      let nextIdx = 0;
      if (current) {
        const cIdx = ring.findIndex((e) =>
          e.provider === current.provider
          && (e.model ?? null) === (current.model ?? null),
        );
        if (cIdx < 0) {
          nextIdx = 0;
        } else {
          const step = reverse ? -1 : 1;
          nextIdx = (cIdx + step + ring.length) % ring.length;
        }
      }
      const nextEntry = ring[nextIdx]!;
      void Promise.resolve(deps.setActiveModel(nextEntry)).then(() => {
        const modelName = modelDisplayForRotationEntry(nextEntry);
        const arrow = reverse ? '◂' : '▸';
        toastStack.push({
          text: `${arrow} ${modelName || nextEntry.provider}  (${nextEntry.provider})`,
          kind: 'success',
        });
        deps.redraw();
      });
      return;
    } else if (pill.name === 'virtualWindow' || pill.name === 'workspaceDock') {
      // VW-U1 — delegate to host. No anchored SelectView: host opens
      // the existing centered window-picker modal via openWindowPicker.
      if (deps.onWindowPillClick) {
        try { deps.onWindowPillClick(); } catch { /* host error; swallow */ }
      } else if (deps.workspaceHost && deps.onWorkspaceRestore) {
        if (openWorkspaceDockPopup(placement)) {
          return;
        }
        const desktop = buildWorkspaceDesktopModelFromHost(deps.workspaceHost, 'dashboard-main');
        const dockEntries = desktop?.dockEntries ?? [];
        if (dockEntries.length > 0) {
          handle = createWorkspaceRestoreRecipe({
            entries: dockEntries.map((entry) => ({
              surfaceId: entry.surfaceId,
              label: entry.label,
              kind: entry.kind,
              docked: entry.docked,
            })),
            placement,
            onRestore: async (surfaceId) => {
              await deps.onWorkspaceRestore?.(surfaceId);
              deps.redraw();
              closePopup();
            },
            onCancel: () => closePopup(),
            toasts: toastStack,
            theme: deps.getTheme?.() ?? undefined,
            shadow: pillPopupShadow(),
          });
          popupAuthority.mount(handle, pill.name, currentPopupWorkspaceId());
          return;
        }
      }
      popupAuthority.close();
      return;
    } else if (pill.name === 'mode') {
      // A1 — anchored popup listing the three operating modes with
      // the current one highlighted. Picking a row delegates to the
      // host-owned onModeSwitch, which combines ModeManager.setMode
      // with the matching enterSyncMode / enterControlMode / exit
      // helper. Empty onModeSwitch is a no-op (useful in tests).
      const active = deps.getActiveMode?.() ?? 'general';
      handle = createModeSwitcherRecipe({
        active,
        placement,
        onSwitch: async next => {
          try {
            await deps.onModeSwitch?.(next);
          } catch { /* host error; swallow */ }
          deps.redraw();
          closePopup();
        },
        onCancel: () => closePopup(),
        toasts: toastStack,
        theme: deps.getTheme?.() ?? undefined,
        shadow: pillPopupShadow(),
        onMinimize: () => minimizePopup('recipe:mode', 'Switch mode'),
      });
    } else if (pill.name === 'shellRollup') {
      // SRF-4 — anchored popup listing live shell-runner handles.
      const entries = deps.getShellRollupEntries?.() ?? [];
      if (entries.length === 0) {
        toastStack.push({ text: 'No shell handles — RunShell(mode:"vw") spawns one', kind: 'info' });
        deps.redraw();
        return;
      }
      handle = createShellRollupPopupRecipe({
        entries,
        placement,
        onPick: (id) => {
          try { deps.onShellRollupPick?.(id); } catch { /* isolate */ }
          closePopup();
          deps.redraw();
        },
        onCancel: () => closePopup(),
        toasts: toastStack,
        theme: deps.getTheme?.() ?? undefined,
        shadow: pillPopupShadow(),
        onMinimize: () => minimizePopup('recipe:shell-rollup', 'Shells'),
      });
    } else if (pill.name === 'workingDir') {
      const paths = deps.getRecentWds();
      if (paths.length === 0) {
        toastStack.push({ text: 'No recent working directories', kind: 'warning' });
        deps.redraw();
        return;
      }
      handle = createWdPickerRecipe({
        recentPaths: paths,
        placement,
        onSwitch: async p => {
          await deps.setSessionWd(p);
          deps.redraw();
          closePopup();
        },
        onCancel: () => closePopup(),
        toasts: toastStack,
        theme: deps.getTheme?.() ?? undefined,
        shadow: pillPopupShadow(),
        onMinimize: () => minimizePopup('recipe:wd', 'Switch working directory'),
      });
    } else if (pill.name === 'conversationPopup') {
      const snapshot = deps.conversationPopupHost?.snapshot();
      if (!snapshot || (snapshot.live.length === 0 && snapshot.minimized.length === 0)) {
        toastStack.push({ text: 'No conversation popups', kind: 'info' });
        deps.redraw();
        return;
      }
      handle = createConversationPopupShellRecipe({
        layoutMode: snapshot.layoutMode,
        liveEntries: snapshot.live.map((entry) => ({
          sessionId: entry.sessionId,
          label: entry.title,
          brand: entry.brand,
          focused: entry.sessionId === snapshot.focusedSessionId,
        })),
        minimizedEntries: snapshot.minimized.map((entry) => ({
          sessionId: entry.sessionId,
          label: entry.title,
          brand: entry.brand,
        })),
        placement,
        onPick: async (sessionId) => {
          await deps.onConversationPopupPick?.(sessionId);
          deps.redraw();
          closePopup();
        },
        onCancel: () => closePopup(),
        toasts: toastStack,
        theme: deps.getTheme?.() ?? undefined,
        shadow: pillPopupShadow(),
      });
    }
    if (!handle) return;
    popupAuthority.mount(handle, pill.name, currentPopupWorkspaceId());
  };

  const closePopup = (): void => {
    popupAuthority.close();
  };

  const dockMoverDragThreshold = (): number => 3;

  const modalResizeMinWidth = (): number => 16;
  const modalResizeMinHeight = (): number => 4;
  const modalResizeHoverDelay = (): number => 500;

  const modalResizeHandleAt = (
    bounds: ModalBounds,
    row: number,
    col: number,
  ): 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se' | null => {
    const top = row === bounds.row;
    const bottom = row === bounds.row + bounds.height - 1;
    const left = col === bounds.col;
    const right = col === bounds.col + bounds.width - 1;
    if (top && left) return 'nw';
    if (top && right) return 'ne';
    if (bottom && left) return 'sw';
    if (bottom && right) return 'se';
    if (top) return 'n';
    if (bottom) return 's';
    if (left) return 'w';
    if (right) return 'e';
    return null;
  };

  const modalResizeCornerHintAt = (
    bounds: ModalBounds,
    row: number,
    col: number,
  ): 'nw' | 'ne' | 'sw' | 'se' | null => {
    const hint = modalResizeHandleAt(bounds, row, col);
    return hint === 'nw' || hint === 'ne' || hint === 'sw' || hint === 'se'
      ? hint
      : null;
  };

  const clearModalResizeHover = (): void => {
    if (!modalResizeHover) return;
    if (modalResizeHover.timer !== null) {
      try { clearSchedule(modalResizeHover.timer); } catch { /* ignore */ }
    }
    const activeSurface = deps.getTopModalSurface?.() ?? null;
    const shouldRedraw =
      modalResizeHover.visible
      && !!activeSurface
      && activeSurface.id === modalResizeHover.modalId
      && activeSurface.resizeHandleHint === modalResizeHover.hint;
    if (shouldRedraw) activeSurface.resizeHandleHint = null;
    modalResizeHover = null;
    if (shouldRedraw) deps.redraw();
  };

  const armModalResizeHover = (
    modal: ModalSurface,
    hint: 'nw' | 'ne' | 'sw' | 'se',
  ): void => {
    if (modalResizeHover?.modalId === modal.id && modalResizeHover.hint === hint) return;
    clearModalResizeHover();
    const session = {
      modalId: modal.id,
      hint,
      timer: null as unknown | null,
      visible: false,
    };
    session.timer = schedule(() => {
      if (modalResizeHover !== session) return;
      const activeSurface = deps.getTopModalSurface?.() ?? null;
      if (!activeSurface || activeSurface.id !== modal.id) {
        modalResizeHover = null;
        return;
      }
      activeSurface.resizeHandleHint = hint;
      session.timer = null;
      session.visible = true;
      deps.redraw();
    }, modalResizeHoverDelay());
    modalResizeHover = session;
  };

  const projectResizedModalBounds = (
    handle: NonNullable<typeof modalResizeSession>['handle'],
    origin: ModalBounds,
    row: number,
    col: number,
  ): ModalBounds => {
    const viewport = deps.termSize();
    const minWidth = modalResizeMinWidth();
    const minHeight = modalResizeMinHeight();
    const right = origin.col + origin.width - 1;
    const bottom = origin.row + origin.height - 1;
    let left = origin.col;
    let top = origin.row;
    let nextRight = right;
    let nextBottom = bottom;
    if (handle.includes('w')) {
      left = Math.min(Math.max(1, col), right - minWidth + 1);
    }
    if (handle.includes('e')) {
      nextRight = Math.max(origin.col + minWidth - 1, Math.min(viewport.cols, right + (col - (origin.col + origin.width - 1))));
    }
    if (handle.includes('n')) {
      top = Math.min(Math.max(1, row), bottom - minHeight + 1);
    }
    if (handle.includes('s')) {
      nextBottom = Math.max(origin.row + minHeight - 1, Math.min(viewport.rows, bottom + (row - (origin.row + origin.height - 1))));
    }
    if (!handle.includes('w') && !handle.includes('e')) {
      left = origin.col;
      nextRight = right;
    }
    if (!handle.includes('n') && !handle.includes('s')) {
      top = origin.row;
      nextBottom = bottom;
    }
    return {
      row: top,
      col: left,
      width: Math.max(minWidth, nextRight - left + 1),
      height: Math.max(minHeight, nextBottom - top + 1),
    };
  };

  const feedHover = (ev: DisplayMouseEvent): void => {
    if (!hoverTracker) return;
    // Feed on every event we can observe. Motion is the primary
    // signal; click / release / drag also give us coordinates so
    // stable-hover can fire even in 1002 mode (no pure motion).
    // `scroll-up/down` rarely move the pointer, but updating anyway
    // is safe — equality-based change detection inside the tracker
    // makes repeat calls cheap.
    //
    // Priority:
    //   1. Pill hover (pre-existing — has tooltip copy)
    //   2. Pane-body hit with optional widget refinement (F5d Phase 2)
    //   3. null — pointer is off every known region (clear current)
    const pill = pillHoverTarget(pills, statusRow, ev.row, ev.col, tooltipFor);
    if (pill) {
      hoverTracker.update({ x: ev.col, y: ev.row }, pill);
      return;
    }
    // IDX-F5d Phase 2 — pane-body hover feed. Builds the HoverTarget
    // from the already-classified `ev.hitTarget` (must have been set
    // by the classification block that ran before us — see handleMouse
    // below). Only pane-body flows through here today; pane-title /
    // pane-nav-tab can follow the same pattern if a future consumer
    // needs them (tooltip on tab, focus-preview on title, …).
    const h = ev.hitTarget;
    if (h && h.kind === 'pane-body') {
      const itemTag = h.hit?.kind === 'list-row' ? `:${h.hit.itemIndex}`
        : h.hit?.kind === 'table-cell' ? `:${h.hit.row}-${h.hit.col}`
        : h.hit?.kind === 'text-char' ? `:${h.hit.line}-${h.hit.col}`
        : h.hit?.kind === 'conversation-message' ? `:${h.hit.messageId}`
        : '';
      hoverTracker.update(
        { x: ev.col, y: ev.row },
        {
          id: `pane-body:${h.paneId}${itemTag}`,
          kind: 'pane-body',
          paneId: h.paneId,
          hit: h.hit,
        },
      );
      return;
    }
    // Pointer is off every tracked region — emit leave + clear.
    hoverTracker.update(null, null);
  };

  const preflightHitTarget = (ev: DisplayMouseEvent): HitTarget | undefined => {
    const modal = deps.getTopModalSurface?.() ?? null;
    const blockingModal = deps.getTopBlockingModalSurface?.() ?? null;
    const modalLocksBackground = isBlockingModalInteractionSurface(blockingModal);

    if (ev.hitTarget !== undefined) return ev.hitTarget;

    const sb = !modalLocksBackground
      ? classifyStatusBarHit(pills, statusRow, ev.row, ev.col)
      : null;
    if (sb) {
      ev.hitTarget = sb;
      return ev.hitTarget;
    }
    if (!modalLocksBackground && deps.getInputHitTarget) {
      try {
        const inp = deps.getInputHitTarget(ev.row, ev.col);
        if (inp) {
          ev.hitTarget = inp;
          return ev.hitTarget;
        }
      } catch { /* isolate host failures */ }
    }
    if (deps.getModalHitTarget) {
      try {
        const modalHit = deps.getModalHitTarget(ev.row, ev.col);
        if (modalHit) {
          ev.hitTarget = modalHit;
          return ev.hitTarget;
        }
      } catch { /* isolate host failures */ }
    }
    if (!modalLocksBackground && deps.getPaneHitTarget) {
      try {
        const pane = deps.getPaneHitTarget(ev.row, ev.col);
        if (pane) {
          ev.hitTarget = pane;
          return ev.hitTarget;
        }
      } catch { /* isolate host failures */ }
    }
    return ev.hitTarget;
  };

  // IDX-5 Phase 3 — classify a click's hit region and push to
  // ContextKeys.lastClickHitKind. Pure — pill map + status row lookup,
  // plus the optional pane-region delegate (B-4) for clicks outside
  // the status bar. Left-click, double-click, right-click are click-
  // ish events that update the key; drag / release / scroll do not
  // (those fire on every motion tick and would thrash the key).
  //
  // F5b — when `ev.hitTarget` is already attached (by handleMouse's
  // earlier classification step), derive the string label directly
  // from it; avoids re-running pill + pane lookups. The resulting
  // string must stay within the `'status-bar-pill' | 'pane-body'
  // | 'pane-title' | 'pane-nav'` inventory that existing when-clauses
  // and tests expect.
  const hitTargetToLastClickKind = (t: HitTarget | undefined): string | null => {
    if (!t) return null;
    switch (t.kind) {
      case 'pill':            return 'status-bar-pill';
      case 'pane-nav-tab':    return 'pane-nav';
      case 'pane-title':      return 'pane-title';
      case 'pane-body':       return 'pane-body';
      case 'vw-pane-title':   return 'pane-title';
      case 'vw-pane-body':    return 'pane-body';
      case 'modal-body':      return 'modal-body';
      case 'modal-title':     return 'modal-title';
      case 'modal-button':    return 'modal-button';
      case 'status-bar':      return null; // bare status-row click doesn't map to a pane kind
      case 'input':
        // DS-3a preflight · legacy `lastClickKind` inventory has no
        // 'input' slot so we return null here. Note the asymmetry with
        // A-7a `hitTargetKind` (via mouse-context-publisher) which DOES
        // project 'input' → consumers of the new context-keys path
        // see `hitTargetKind == 'input'` while legacy `lastClickKind`
        // stays null. New bindings should prefer A-7a's `hitTargetKind`
        // or the matcherCascade specific/generic tiers (`click:input.<id>`
        // / `click:input`) over the legacy lastClickKind path.
        return null;
    }
  };
  const classifyClickHit = (ev: DisplayMouseEvent): string | null => {
    if (ev.hitTarget) {
      const fromHit = hitTargetToLastClickKind(ev.hitTarget);
      if (fromHit) return fromHit;
    }
    if (statusRow !== null) {
      const isNearStatusRow = ev.row === statusRow || ev.row === statusRow - 1;
      if (isNearStatusRow) {
        const hit = pillAtColumn(pills, ev.col - 1);
        if (hit) return 'status-bar-pill';
      }
    }
    // B-4 — delegate pane-region lookup to the host, which has access
    // to the live layout tree + grid zone + pane-nav row. Undefined
    // delegate (e.g. in tests) leaves the value at null.
    if (deps.getPaneRegionKind) {
      try {
        return deps.getPaneRegionKind(ev.row, ev.col);
      } catch {
        return null;
      }
    }
    return null;
  };

  const publishLastClick = (ev: DisplayMouseEvent): void => {
    if (!deps.ctx) return;
    if (!isDiscreteClickMouseEventType(ev.type)) return;
    const kind = classifyClickHit(ev);
    try {
      deps.ctx.update({ lastClickHitKind: kind });
    } catch { /* swallow — never block mouse routing on a ctx update */ }
  };

  const handleMouse = (ev: DisplayMouseEvent): boolean => {
    // Q6 (Phase 4 mouse-wiring · 2026-05-03) — drag-to-front on
    // left-click. Run BEFORE the rest of handleMouse reads
    // getTopModalSurface(), so a successful raise + focus transfer
    // takes effect for this same dispatch (the now-raised popup
    // becomes the top modal and receives the click via the standard
    // path). Right-click / drag / motion / etc. NEVER raise — only
    // discrete click intent. Skip during active drag/resize sessions
    // to avoid stealing focus mid-gesture.
    if (
      ev.type === 'click'
      && !modalResizeSession
      && !modalMoveSession
      && !dockMoverSession
      && deps.tryRaiseModalAtPoint
    ) {
      try {
        deps.tryRaiseModalAtPoint(ev.row, ev.col);
        // Return value is informational only; we always continue
        // dispatch so the click ALSO lands on the raised popup.
      } catch { /* isolate host failures */ }
    }
    const modal = deps.getTopModalSurface?.() ?? null;
    const blockingModal = deps.getTopBlockingModalSurface?.() ?? null;
    const modalHitBounds = modal ? (modal.interactiveBounds ?? modal.bounds) : null;
    const modalLocksBackground = isBlockingModalInteractionSurface(blockingModal);
    const blockingModalHitBounds = blockingModal
      ? (blockingModal.interactiveBounds ?? blockingModal.bounds)
      : null;
    const alwaysForwardToModal = isCaptureSessionMouseEventType(ev.type)
      || ev.type === 'scroll-up' || ev.type === 'scroll-down';
    const insideBlockingModal = modalHitBounds
      ? rectContains(modalHitBounds, ev.row, ev.col)
      : false;

    if (!modal || modalResizeSession || modalMoveSession) {
      clearModalResizeHover();
    } else if (ev.type === 'motion') {
      const hoverBounds = modalHitBounds ?? modal.bounds;
      const hoverHint = rectContains(hoverBounds, ev.row, ev.col)
        ? modalResizeCornerHintAt(hoverBounds, ev.row, ev.col)
        : null;
      if (hoverHint) armModalResizeHover(modal, hoverHint);
      else clearModalResizeHover();
    } else if (ev.type !== 'click') {
      clearModalResizeHover();
    } else {
      const hoverBounds = modalHitBounds ?? modal.bounds;
      const stickyHint = rectContains(hoverBounds, ev.row, ev.col)
        ? modalResizeCornerHintAt(hoverBounds, ev.row, ev.col)
        : null;
      if (stickyHint !== modal.resizeHandleHint) clearModalResizeHover();
    }

    if (modalResizeSession && isCaptureSessionMouseEventType(ev.type)) {
      const activeSurface = deps.getTopModalSurface?.() ?? null;
      if (!activeSurface || activeSurface.id !== modalResizeSession.modalId) {
        modalResizeSession = null;
        return true;
      }
      const dx = Math.abs(ev.row - modalResizeSession.anchorRow);
      const dy = Math.abs(ev.col - modalResizeSession.anchorCol);
      if (!modalResizeSession.moved && dx + dy < modalMoveThreshold()) {
        if (isCaptureSessionEndMouseEventType(ev.type)) modalResizeSession = null;
        return true;
      }
      modalResizeSession.moved = true;
      const nextBounds = projectResizedModalBounds(
        modalResizeSession.handle,
        modalResizeSession.originBounds,
        ev.row,
        ev.col,
      );
      deps.updateModalBounds?.(modalResizeSession.modalId, nextBounds);
      if (isCaptureSessionEndMouseEventType(ev.type)) modalResizeSession = null;
      deps.redraw();
      return true;
    }
    if (modalMoveSession && isCaptureSessionMouseEventType(ev.type)) {
      const activeSurface = deps.getTopModalSurface?.() ?? null;
      if (!activeSurface || activeSurface.id !== modalMoveSession.modalId) {
        modalMoveSession = null;
        return true;
      }
      const dx = Math.abs(ev.row - modalMoveSession.anchorRow);
      const dy = Math.abs(ev.col - modalMoveSession.anchorCol);
      if (!modalMoveSession.moved && dx + dy < modalMoveThreshold()) {
        if (isCaptureSessionEndMouseEventType(ev.type)) modalMoveSession = null;
        return true;
      }
      modalMoveSession.moved = true;
      const nextBounds: ModalBounds = {
        row: modalMoveSession.originBounds.row + (ev.row - modalMoveSession.anchorRow),
        col: modalMoveSession.originBounds.col + (ev.col - modalMoveSession.anchorCol),
        width: modalMoveSession.originBounds.width,
        height: modalMoveSession.originBounds.height,
      };
      deps.updateModalBounds?.(modalMoveSession.modalId, nextBounds);
      if (isCaptureSessionEndMouseEventType(ev.type)) modalMoveSession = null;
      deps.redraw();
      return true;
    }
    if (dockMoverSession && isCaptureSessionMouseEventType(ev.type)) {
      const delta = ev.col - dockMoverSession.anchorCol;
      if (isCaptureSessionEndMouseEventType(ev.type)) {
        dockMoverSession = null;
        return true;
      }
      if (Math.abs(delta) < dockMoverDragThreshold()) return true;
      dockMoverSession = null;
      void deps.onMoveVirtualWindow?.(delta < 0 ? 'left' : 'right');
      deps.redraw();
      return true;
    }
    // IDX-F5a/b — structured hit classification. Attach before any
    // downstream branch reads `ev.hitTarget`: modal.onMouse forwards
    // benefit from knowing whether the click landed on a pill /
    // status row / pane body / modal body without re-deriving, and
    // F6 SendMouseEvent will read this from its synthetic event path.
    //
    // Order: status-bar pill / status-bar classifier first (wins when
    // the click is on the status row), then pane classifier (F5b —
    // pane-nav-tab / pane-title / pane-body when host provides
    // `getPaneHitTarget`), then modal-body synthesis happens inside
    // the modal-forward branch below because that path is where we
    // know the top modal surface. Mutation of `ev` is OK — event is
    // single-use and owned by us within handleMouse.
    //
    // IDX-F5d Phase 2 (2026-04-22) — classification moved AHEAD of
    // `feedHover` so pane-body hover events carry the widget
    // refinement (hit.itemIndex for lists, etc.) the tracker needs
    // to fire enter/leave on row change.
    preflightHitTarget(ev);
    // IDX-5 / F5d Phase 2 — feed the hover tracker AFTER hitTarget
    // classification so pane-body targets (with describeHit refinement)
    // can flow through. No-op when hover wiring is disabled.
    feedHover(ev);
    // DS-2b (2026-04-21) — drag session chokepoint. When an active
    // drag is underway, the adapter consumes drag/release events
    // and short-circuits the legacy mouse chain. Non-progressing
    // events (click/scroll/right-click/motion) return false and
    // fall through to existing handlers. PR #319 DS-2a landed the
    // adapter itself (`src/display/drag-dispatch.ts`); this hook
    // is its sole integration point in the wider event chain.
    if (deps.dragDispatch?.(ev)) {
      return true;
    }
    // IDX-5 Phase 3 — publish lastClickHitKind for click-like events.
    // Must run AFTER hitTarget attachment so the classifier can read
    // the rich HitTarget and derive the legacy string label directly
    // (avoids duplicating pill + pane lookups).
    publishLastClick(ev);
    // Motion usually exists only to feed hover, but active modals may
    // opt into hover-driven focus/affordance updates (e.g. debug
    // workbench focus zones, resize handles). Forward motion when the
    // pointer is inside the active modal's interactive bounds.
    if (ev.type === 'motion') {
      if (modal && (modal.onMouse || deps.routeModalMouse) && insideBlockingModal) {
        const consumed = deps.routeModalMouse
          ? deps.routeModalMouse(modal, ev)
          : !!modal.onMouse?.(ev);
        if (consumed) return true;
      }
      return false;
    }
    // M1 — end-to-end diagnostic trace. Every click / right-click
    // records entry state + exit branch so post-hoc analysis of
    // log/debug-*.log can pinpoint where a click was swallowed. Scroll
    // / drag / release excluded to avoid flooding the buffer on wheel
    // usage.
    const trace = debug.enabled
      && (ev.type === 'click' || ev.type === 'right-click');
    const wheelTrace = debug.enabled
      && (ev.type === 'scroll-up' || ev.type === 'scroll-down');
    if (trace) {
      debug.log('mouse.pill', 'handleMouse:enter', {
        type: ev.type, row: ev.row, col: ev.col,
        statusRow, pillsCount: pills.length,
        pills: pills.map(p => ({ name: p.name, startCol: p.startCol, endCol: p.endCol })),
        hasActivePopup: popupAuthority.hasActivePopup(),
        hitTarget: hitTargetLabel(ev.hitTarget),
      });
    }
    if (wheelTrace) {
      debug.log('mouse.wheel', 'handleMouse:enter', {
        type: ev.type,
        row: ev.row,
        col: ev.col,
        statusRow,
        hasActivePopup: popupAuthority.hasActivePopup(),
        hitTarget: hitTargetLabel(ev.hitTarget),
      });
    }
    // Active popup takes priority. Right-click outside is the one
    // passthrough case so a context menu can open after dismiss.
    const popupRes = popupAuthority.routeMouse(ev);
    if (popupRes) {
      if (trace && popupRes !== 'consumed') {
        debug.log('mouse.pill', 'handleMouse:popup-passthrough-close', {
          row: ev.row, col: ev.col, eventType: ev.type, popupRes,
        });
      } else if (trace) {
        debug.log('mouse.pill', 'handleMouse:popup-consume', {
          row: ev.row, col: ev.col, result: popupRes,
        });
      }
      if (wheelTrace) {
        debug.log('mouse.wheel', 'handleMouse:popup-route', {
          row: ev.row,
          col: ev.col,
          eventType: ev.type,
          popupRes,
        });
      }
      if (popupRes !== 'dismissed-passthrough') return true;
    }
    const nearDockRow = dockRow !== null && ev.row === dockRow;
    if (isPrimaryButtonClickMouseEventType(ev.type) && nearDockRow) {
      const dockAnchorRow = dockRow;
      const hit = dockItems.find(item => {
        const col0 = ev.col - 1;
        return col0 >= item.startCol && col0 < item.endCol;
      });
      if (hit && dockAnchorRow !== null) {
        const placement = popupPlacementFromDockHit(hit, dockAnchorRow);
        if (hit.kind === 'menu') return openDockLauncherPopup(placement);
        if (hit.kind === 'vw-mover-left') {
          if (!hit.enabled) return true;
          void deps.onMoveVirtualWindow?.('left');
          deps.redraw();
          return true;
        }
        if (hit.kind === 'vw-mover-center') {
          if (deps.onWindowPillClick) {
            try { deps.onWindowPillClick(); } catch { /* ignore */ }
            deps.redraw();
          }
          return true;
        }
        if (hit.kind === 'vw-mover-right') {
          if (!hit.enabled) return true;
          void deps.onMoveVirtualWindow?.('right');
          deps.redraw();
          return true;
        }
        if (hit.kind === 'view') return openDockViewPicker(placement);
        if (hit.kind === 'workspace-dock' && deps.onWorkspaceRestore && openWorkspaceDockPopup(placement)) {
          return true;
        }
      }
    }
    // No popup: check for status-bar pill click first. P0-2 — accept
    // exact-row + 1-row above (covers terminals that emit the pill
    // row minus one for clicks that land on the visual top edge of
    // the status cell).
    const nearStatusRow = !modalLocksBackground && statusRow !== null
      && (ev.row === statusRow || ev.row === statusRow - 1);
    // IDX-5 Phase 2 — right-click on a pill routes to the
    // context-menu registry via host callback. Left-click keeps the
    // legacy "open picker popup" path.
    if (isSecondaryClickMouseEventType(ev.type) && nearStatusRow && deps.onPillRightClick) {
      const col0 = ev.col - 1;
      const hit = pillAtColumn(pills, col0);
      if (hit) {
        if (trace) {
          debug.log('mouse.pill', 'handleMouse:pill-right-click', {
            name: hit.name, col0, row: ev.row,
          });
        }
        try {
          deps.onPillRightClick(hit.name, { x: col0, y: ev.row - 1 });
        } catch { /* isolate host failures */ }
        return true;
      }
    }
    // CMX-2 (2026-04-22) — non-pill right-click → context-menu
    // dispatcher. Runs AFTER the pill right-click branch so pill
    // clicks keep their fast path (legacy direct handle lookup).
    // The dispatch hook looks up a MenuProvider via HitKey and
    // shows the resulting Menu; when no provider matches, returns
    // false and the event falls through to modal forwarding below.
    if (isSecondaryClickMouseEventType(ev.type) && deps.contextMenuDispatch) {
      try {
        if (deps.contextMenuDispatch(ev)) {
          if (trace) {
            debug.log('mouse.pill', 'handleMouse:context-menu-consumed', {
              row: ev.row, col: ev.col,
              hitTarget: hitTargetLabel(ev.hitTarget),
            });
          }
          return true;
        }
      } catch { /* isolate host failures */ }
    }
    if (isPrimaryButtonClickMouseEventType(ev.type) && nearStatusRow) {
      const col0 = ev.col - 1;
      const hit = pillAtColumn(pills, col0);
      if (hit) {
        if (trace) {
          debug.log('mouse.pill', 'handleMouse:pill-matched', {
            name: hit.name, startCol: hit.startCol, endCol: hit.endCol,
            col0, row: ev.row, statusRow,
          });
        }
        openPillPopup(hit, { reverseCycle: !!ev.ctrl });
        return true;
      }
      // Click landed on the status row but no pill matched. Log for
      // diagnosis: often an off-by-one in pill geometry or an
      // unexpected column value (e.g. from mouse wheel emulation).
      if (debug.enabled) {
        debug.log('mouse.pill', 'handleMouse:statusRow-hit-no-pill', {
          row: ev.row, col: ev.col, col0, statusRow,
          pillsCount: pills.length,
          pills: pills.map(p => ({ name: p.name, startCol: p.startCol, endCol: p.endCol })),
        });
      }
    }
    // VW-U3/A3 — not a pill click. If a modal surface (typically a
    // VirtualWindow) is currently foregrounded, dispatch through its
    // onMouse so pane focus (left click) / selector popup (right
    // click) / divider drag can respond. Bounds check applies to
    // click+right-click only — drag / release / scroll must reach the
    // modal even when the pointer has wandered outside its rect so
    // VW-A3 can complete a resize gesture.
    if (modal && (modal.onMouse || deps.routeModalMouse)) {
      const b = modalHitBounds ?? modal.bounds;
      // R1 — shared Rect helper replacing 4 inline copies of this
      // same bounds-check pattern scattered across the display layer.
      const inside = rectContains(b, ev.row, ev.col);
      const alwaysForward = alwaysForwardToModal;
      if (inside || alwaysForward) {
        // IDX-F5b — attach modal-body HitTarget when the click fell
        // inside the modal's bounds and no finer classification (from
        // describeHit-aware widgets in F5c) has been set yet. This
        // gives modal.onMouse handlers + F6 SendMouseEvent consumers
        // a consistent `{kind:'modal-body', modalId}` baseline they
        // can narrow further via describeHit in F5c.
        if (inside && ev.hitTarget === undefined) {
          ev.hitTarget = { kind: 'modal-body', modalId: modal.id };
        }
        if (trace) {
          debug.log('mouse.pill', 'handleMouse:modal-forward', {
            row: ev.row, col: ev.col, inside, alwaysForward,
            modalBounds: { row: b.row, col: b.col, width: b.width, height: b.height },
            backdropBounds: modal.interactiveBounds
              ? { row: modal.bounds.row, col: modal.bounds.col, width: modal.bounds.width, height: modal.bounds.height }
              : undefined,
            hitTarget: hitTargetLabel(ev.hitTarget),
          });
        }
        const consumed = deps.routeModalMouse
          ? deps.routeModalMouse(modal, ev)
          : (() => {
              try { modal.onMouse?.(ev); } catch { /* isolate */ }
              return true;
            })();
        const hintedResizeHandle =
          modal.resizeHandleHint
          && modalResizeCornerHintAt(b, ev.row, ev.col) === modal.resizeHandleHint
            ? modal.resizeHandleHint
            : null;
        const resizeHandle = ev.ctrl
          ? modalResizeHandleAt(b, ev.row, ev.col)
          : hintedResizeHandle;
        if (consumed && resizeHandle && isPrimaryButtonClickMouseEventType(ev.type) && ev.hitTarget?.kind !== 'modal-button') {
          clearModalResizeHover();
          modalResizeSession = {
            modalId: modal.id,
            handle: resizeHandle,
            anchorRow: ev.row,
            anchorCol: ev.col,
            originBounds: { ...b },
            moved: false,
          };
        } else if (consumed && ev.hitTarget?.kind === 'modal-title' && isPrimaryButtonClickMouseEventType(ev.type)) {
          clearModalResizeHover();
          modalMoveSession = {
            modalId: modal.id,
            anchorRow: ev.row,
            anchorCol: ev.col,
            originBounds: { ...modal.bounds },
            moved: false,
          };
        }
        if (consumed) deps.redraw();
        if (wheelTrace) {
          debug.log('mouse.wheel', 'handleMouse:modal-forward', {
            row: ev.row,
            col: ev.col,
            eventType: ev.type,
            inside,
            alwaysForward,
            consumed,
            modalBounds: { row: b.row, col: b.col, width: b.width, height: b.height },
            hitTarget: hitTargetLabel(ev.hitTarget),
          });
        }
        return true;
      }
      if (modalLocksBackground) {
        if (trace) {
          debug.log('mouse.pill', 'handleMouse:background-blocked-by-modal', {
            row: ev.row, col: ev.col,
            modalBounds: blockingModalHitBounds
              ? {
                  row: blockingModalHitBounds.row,
                  col: blockingModalHitBounds.col,
                  width: blockingModalHitBounds.width,
                  height: blockingModalHitBounds.height,
                }
              : undefined,
            backdropBounds: blockingModal?.interactiveBounds
              ? {
                  row: blockingModal.bounds.row,
                  col: blockingModal.bounds.col,
                  width: blockingModal.bounds.width,
                  height: blockingModal.bounds.height,
                }
              : undefined,
          });
        }
        if (wheelTrace) {
          debug.log('mouse.wheel', 'handleMouse:background-blocked-by-modal', {
            row: ev.row,
            col: ev.col,
            eventType: ev.type,
          });
        }
        return true;
      }
    }
    if (wheelTrace) {
      debug.log('mouse.wheel', 'handleMouse:dropped', {
        type: ev.type,
        row: ev.row,
        col: ev.col,
        statusRow,
      });
    }
    if (trace) {
      debug.log('mouse.pill', 'handleMouse:dropped', {
        type: ev.type, row: ev.row, col: ev.col, statusRow,
      });
    }
    return false;
  };

  const routeKey = (key: KeyEvent): 'consumed' | 'passthrough' => {
    const name = (key.name ?? '').toLowerCase();
    if (modalResizeSession && (name === 'escape' || (key.ctrl && (name === 'g' || name === 'ㅎ')))) {
      deps.updateModalBounds?.(modalResizeSession.modalId, modalResizeSession.originBounds);
      modalResizeSession = null;
      clearModalResizeHover();
      deps.redraw();
      return 'consumed';
    }
    if (modalMoveSession && (name === 'escape' || (key.ctrl && (name === 'g' || name === 'ㅎ')))) {
      deps.updateModalBounds?.(modalMoveSession.modalId, modalMoveSession.originBounds);
      modalMoveSession = null;
      clearModalResizeHover();
      deps.redraw();
      return 'consumed';
    }
    return popupAuthority.routeKey(key);
  };

  const renderToasts = (p: Printer): void => {
    toastStack.render(p);
  };

  const dispose = (): void => {
    try { hoverPresenter?.dispose(); } catch { /* isolate */ }
    hoverPresenter = null;
    try { disposeHoverCtxBridge?.(); } catch { /* isolate */ }
    disposeHoverCtxBridge = null;
    try { disposeHoverWidgetBridge?.(); } catch { /* isolate */ }
    disposeHoverWidgetBridge = null;
    try { disposePaneHoverBridge?.(); } catch { /* isolate */ }
    disposePaneHoverBridge = null;
    clearModalResizeHover();
    // hoverTracker.dispose clears its own subscribers + timer. If
    // the tracker was passed in by the caller we still dispose it —
    // the caller constructed it for this wiring's lifetime.
    try { hoverTracker?.dispose(); } catch { /* isolate */ }
    closePopup();
  };

  return {
    buildStatusLine,
    buildDockLine,
    setStatusRow,
    setDockRow,
    handleMouse,
    preflightHitTarget,
    getTooltipFor(target: HitTarget): string | null {
      // S1.D — pill tooltip lookup is the only resolver wired today.
      // Future kinds (modal-button label, vw-pane-title, etc.) plug
      // in here without changing the runtime contract.
      if (target.kind === 'pill') return tooltipFor(target.name) ?? null;
      return null;
    },
    routeKey,
    renderToasts,
    hasActivePopup: () => popupAuthority.hasActivePopup(),
    closePopup,
    toasts: () => toastStack,
    dispose,
    _snapshot: () => ({
      pills,
      dockItems,
      statusRow,
      dockRow,
      popupId: popupAuthority.snapshotId(),
      modalMoveSession,
      modalResizeSession,
      dockMoverSession,
      hoverActiveTooltipId: hoverPresenter ? hoverPresenter._activeSurfaceId() : null,
    }),
  };
}
