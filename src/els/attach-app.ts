// els app view (ELS-ATTACH-VIEW stage 3): the herdr-shaped screen. Left: workspaces and their panes with status marks;
// middle: the selected pane live (colours, cursor); bottom: one status line. The terminal, the socket and the clock come in
// as `deps`, so the same logic runs under a real terminal and under tests. The app is a client: closing it (ctrl+b q)
// leaves the server and every pane as they were.

import { createSizeReassert } from './local-viewer-size.js';
import { buttonsLayout, hitButton } from './attach-buttons.js';
import { planVoice, type VoiceDoor } from './voice-control.js';
import { createVoicePopup } from './voice-popup.js';
import { createNewTabPrompt } from './new-tab-prompt.js';
import { createMoveTabPicker } from './move-tab-picker.js';
import { tabName } from './space-tabs-view.js';
import { basename, dirname } from 'node:path';
import { elsJournalPath } from './journal.js';
import { readActiveBaton } from './baton.js';
import { isServerAway, noteAfterFrame, RECONNECT_NOTE, type AttachFrame, type AttachHandlers, type Attached } from './attach-client.js';
import { createKeyRouter, type KeyAction } from './attach-keys.js';
import { AFTER_PREFIX, tileActionOf, type ShortcutContext } from './key-bindings.js';
import { composeView, emptyCoordinatorSpaces, emptyRemoteCoordinators, FIRST_RUN_HINT, NARROW_BELOW_COLS, parsePaneRows, parseRemoteRows, sidebarWidthFor, UNREACHABLE_MARK, type PaneRow } from './attach-view.js';
import { withLoopStates } from './loop-agents.js';
import { buildTabDropdown, layoutSpaceList, isActiveSeat, buildTabRow, dropdownTargets, withCommands, type DropdownTarget } from './space-tabs-view.js';
import { interpretMouse, wheelBytes, type MouseLayout, type MouseReport } from './attach-mouse.js';
import type { WheelRoute } from '../pty-shell/registry.js';
import { withNewDefaults } from './cli-args.js';
import type { ElsResult } from './core.js';
import type { ElsRequest } from './server.js';
import { closeLayer, emptyStack, focusLayer, focusTop, updateLayer, visibleLayers, type OverlayLayer, type OverlayStack } from './overlay-stack.js';
import { composeLayers, createLayerPainter, overlayMouse, type LayerRenderer } from './overlay-compose.js';
import type { KeyAnswer, OpenAnswer } from './elements/element.js';
import { openCommand, type FilesOpen } from './elements/files-view.js';
import { createPopupTerm, isPopupRow } from './popup-term-client.js';
import { POPUP_WS } from './elements/term.js';
import { resolveRect, shownIn } from './overlay-stack.js';
import { assignSlots, drawTileFrame, modelOf, parseStageFeed, spaceTile, stageHeader, stageLane, stageRibbon, tileLayout, type StageFeed, moveFocus, tileGrid, MAX_TILES, TILE_REFRESH_MS, type TileFrameInput, type TileGridSpec, type TileInput } from './tile-view.js';

/** ELS-STALE-CLIENT: the one-line hint while this client is older than the server it talks to. */
export const STALE_CLIENT_HINT = '새 빌드 있음 · q 로 나갔다 다시 els';
/** REMOTE-PANE-SIZE: a terminal drag fires many SIGWINCHes; the remote holder gets the size once it settles. */
export const REMOTE_RESIZE_DEBOUNCE_MS = 150;

/** True when the server's `ls` answer reports a different, NEWER build than this client's own (unknown = not stale). */
export function clientIsStale(own: { readonly sha: string; readonly builtAt?: number }, lsMessage: string): boolean {
  let server: { sha?: unknown; builtAt?: unknown } | undefined;
  try { server = (JSON.parse(lsMessage) as { serverBuild?: { sha?: unknown; builtAt?: unknown } }).serverBuild; } catch { return false; }
  if (!server || typeof server.sha !== 'string' || !server.sha || !own.sha || server.sha === own.sha) return false;
  return typeof server.builtAt === 'number' && typeof own.builtAt === 'number' && server.builtAt > own.builtAt;
}

export interface AttachAppDeps {
  readonly request: (request: ElsRequest) => Promise<ElsResult>;
  readonly attach: (pane: string, size: { cols: number; rows: number }, handlers: AttachHandlers) => Attached;
  readonly write: (text: string) => void;
  readonly size: () => { cols: number; rows: number };
  readonly cwd: string;
  readonly buildLabel?: string;
  /** ELS-STALE-CLIENT: this client's own build (fixed for the life of the process — a running client never updates). */
  readonly ownBuild?: { readonly sha: string; readonly builtAt?: number };
  /** Override the local active baton lookup for isolated view tests. */
  readonly actingSeat?: () => string | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly setInterval: (callback: () => void, ms: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
  readonly pollMs: number;
  /** What a chat pane runs: this install's `elanous` (the same program `eln` is). */
  readonly chatCommand: readonly string[];
  /** ELS-VOICE-CONTROL-POPUP: a cheap one-shot model call for ctrl+b : (absent = the rules read the words). */
  readonly voiceModel?: (prompt: string) => Promise<string | null>;
  /** The view's own memory (side list open or closed, the last pane) — read once at start, written when it changes. */
  readonly memory: { readonly load: () => { sidebar?: boolean; lastPane?: string; groupFolds?: Record<string, boolean>; activeOnly?: boolean }; readonly save: (state: { sidebar: boolean; lastPane?: string; groupFolds?: Record<string, boolean>; activeOnly?: boolean }) => void };
  /** `--side` / `--no-side`; absent = what was remembered, else open (els) */
  readonly sidebar?: boolean;
  /**
   * The panes of other hosts (registered els hosts and `herdr`), read-only: the federated list and the federated read.
   * They join the same left list under «⇄host …»; selecting one shows its screen (polled), typing into it is refused
   * (input goes through `els do`). Absent = a local-only view.
   */
  /** ELS-TILE-MODE: open in tile mode — every pane of `ws` (absent = the selected pane's workspace) as a live grid. */
  readonly tile?: { readonly ws?: string; readonly grid?: TileGridSpec;
    /** ALL mode (every pane of every space, space→tab order) · SPACES mode (one tile per space) · --active (working only) ·
     *  remote false = local panes only · autoPageMs = ① auto-advance pages. */
    readonly all?: boolean; readonly spaces?: boolean; readonly active?: boolean; readonly remote?: boolean; readonly autoPageMs?: number;
    /** ELS-TILE-STAGE: staged demo layout; `readFeed` returns the conductor's feed file text (JSON lines), polled with the tiles. */
    readonly stage?: { readonly readFeed?: () => string | undefined } };
  readonly now?: () => number;
  /** GOAL-ORCHESTRATION-NL: a goal run that just started in this els (its workspace + stage feed). A new key switches the
   *  window to the staged tile view of that workspace — the orchestration cascades in front of the person. */
  readonly stageWatch?: (workspaces: readonly string[]) => { readonly key: string; readonly ws: string; readonly readFeed: () => string | undefined } | undefined;
  /** SIDETAB-LOOP-AGENTS-UNDER-SPACE: loop-agent facts for the heartbeat rows (cached registry read; absent = plain rows). */
  readonly loopFacts?: import('./loop-agents.js').LoopFactsSource;
  /** ELS-ZAXIS S2: the els server's overlay stack, pushed on change (never polled). The client draws it and routes input through
   *  it but never edits its copy: a click or Esc goes back to the server as an act. Absent = no overlays (an older server, tests). */
  readonly overlays?: OverlayDeps;
  readonly remote?: { readonly list: () => Promise<ElsResult>; readonly read: (address: string) => Promise<ElsResult>;
    /** REMOTE-PANE-SIZE: set the remote pane's PTY to this viewer's pane area (the remote SIGWINCH). */
    readonly resize?: (address: string, cols: number, rows: number) => Promise<ElsResult> };
}

/** ELS-ZAXIS S2: what the app needs from the overlay owner (the els server). */
export interface OverlayDeps {
  /** Calls `onStack` with the current stack at once and with every newer stack after; `close` ends the stream. */
  readonly watch: (onStack: (stack: OverlayStack) => void) => { readonly close: () => void };
  /** Ask the server to change the stack (raise/focus on a click, close on Esc). The answer comes back through `watch`. */
  /** May answer (the server's reply, or a promise of it): a `frame` answer naming a `pane` = the new tab to move to. */
  readonly act?: (act: { readonly action: 'close' | 'raise' | 'focus' | 'update' | 'frame' | 'move' | 'resize'; readonly id: string; readonly props?: unknown; readonly frame?: 'next';
    readonly dx?: number; readonly dy?: number; readonly view?: { readonly cols: number; readonly rows: number } }) => unknown;
  /** Element renderers by kind (unknown kinds draw a framed box with their kind). */
  readonly renderers?: Readonly<Record<string, LayerRenderer>>;
  /** Element key reducers by kind: 'consumed' keeps the key, 'pass' hands it down the focus stack. */
  readonly keys?: Readonly<Record<string, (layer: OverlayLayer, bytes: string) => KeyAnswer | OpenAnswer>>;
  /** ELS-POPUP-STYLE: changes when every layer must repaint (the popup style) — part of the paint cache key. */
  readonly paintKey?: () => string;
}

export interface AttachApp {
  /** Resolves with the process exit code and an optional line for stderr when the app ends. */
  readonly done: Promise<{ code: number; message: string }>;
  readonly start: (pane?: string) => Promise<void>;
  /** Decoded key text from the terminal. */
  readonly key: (text: string) => void;
  readonly resized: () => void;
}

type Confirm = { readonly what: 'close' | 'close-workspace' | 'quit'; readonly target: string; readonly prompt: string };

export function createAttachApp(deps: AttachAppDeps): AttachApp {
  const router = createKeyRouter();
  let rows: PaneRow[] = [];                                      // this host's panes, from the owner
  let popupRows: PaneRow[] = [];                                 // ELS-POPUP-TERM: popup terminal panes (never listed, tabbed or tiled)
  let remoteRows: PaneRow[] = [];                                // other hosts' panes, from the federated list (cached)
  let remoteEmpty: ReturnType<typeof emptyRemoteCoordinators> = [];
  let lastLocal = deps.memory.load().lastPane;                    // the last LOCAL pane: a remote selection is not remembered
  let remoteBusy = false;
  let remoteStatus = '';
  let readError = '';                                            // the last remote read failure (its own status channel, apart from `note`)
  let readSeq = 0;                                               // the newest remote read; an older answer never paints over it
  let selected: string | undefined;
  let selectedEmpty: string | undefined;
  let emptyHits: readonly { readonly y: number; readonly ws: string }[] = [];
  let wrapped = false;                                           // ELS-ONE-SPACE: `w` wrapped this space's tab cycle — the next `w` steps to the next space
  let staleClient = false;                                       // ELS-STALE-CLIENT: the server runs a newer build than this client
  let lsAnswer = '';                                             // the last `els ls` answer (each pane's command → its tab emoji)
  let ceoPendingRed = 0;                                         // authoritative els owner count; never infer 👀 from queue arrival
  let ceoSideUnavailable = false;
  const remembered = deps.memory.load();
  let sidebarOpen = deps.sidebar ?? remembered.sidebar ?? true;
  // ELS-GROUP-FOLD-CONTROL · ELS-ACTIVE-ONLY-FILTER: the viewer's own fold choices and filter — kept in the view's memory (ui.json).
  const groupFolds = new Map<string, boolean>(Object.entries(remembered.groupFolds ?? {}).filter(([, folded]) => typeof folded === 'boolean'));
  let activeOnly = remembered.activeOnly === true;
  let listMarks: { heads: readonly { y: number; ws: string; folded: boolean }[]; foldAll?: { expand: { y: number; from: number; to: number }; collapse: { y: number; from: number; to: number } }; active?: { y: number; from: number; to: number } } = { heads: [] };
  let agentsGrouped = true;                                     // ELS-AGENTS-GROUPED-TOGGLE-FU (OP #134722 ②): the agents panel's order — session-only (영속화 없음, 첫 판 최소 리스크)
  let frame = '';
  let note = '';
  let confirm: Confirm | undefined;
  let movePicker: { picker: ReturnType<typeof createMoveTabPicker>; tab: string } | undefined;
  let attached: Attached | undefined;
  let generation = 0;
  let timer: unknown;
  let finished = false;
  let escapePending = '';
  let discardEscapeSuffix = false;
  let escapeTimer: ReturnType<typeof setTimeout> | undefined;
  let awaitingServer = false;                                    // D1a: ONLY a server-away end arms the re-attach — a refused/unknown-pane attach never retries
  let focusWrite: Promise<void> = Promise.resolve();
  let emptyFocusInFlight = false;
  let emptyFocusPending: string | undefined;
  let automaticCreateAttempted = false;
  let everListed = false;                                        // D1a: a server lost AFTER a good list is waited out, not the end
  let resolveDone: (result: { code: number; message: string }) => void = () => {};
  const done = new Promise<{ code: number; message: string }>((resolve) => { resolveDone = resolve; });

  const paneSize = (): { cols: number; rows: number } => {
    const { cols, rows: height } = deps.size();
    const left = sidebarWidthFor(cols, sidebarOpen);
    // ELS-ONE-SPACE: one row for the tab row over the pane whenever there is a pane to show.
    const tabRow = everyRow().length > 0 ? 1 : 0;
    return { cols: Math.max(10, cols - (left ? left + 1 : 0)), rows: Math.max(3, height - 1 - tabRow) };
  };
  // REMOTE-PANE-SIZE: the focused viewer's pane area goes to the remote holder on select and on every terminal resize,
  // debounced (a drag fires many SIGWINCHes); the same size is not sent twice for the same pane.
  let remoteSizeTimer: ReturnType<typeof setTimeout> | undefined;
  let remoteSizeSent = '';
  const pushRemoteSize = (): void => {
    if (!deps.remote?.resize) return;
    if (remoteSizeTimer) clearTimeout(remoteSizeTimer);
    remoteSizeTimer = setTimeout(() => {
      remoteSizeTimer = undefined;
      const row = current();
      if (finished || !row?.remote) return;
      const size = paneSize();
      const key = `${row.pane} ${size.cols}x${size.rows}`;
      if (key === remoteSizeSent) return;
      remoteSizeSent = key;
      void deps.remote!.resize!(row.pane, size.cols, size.rows).then((answer) => { if (answer.exitCode !== 0) remoteSizeSent = ''; }, () => { remoteSizeSent = ''; });
    }, REMOTE_RESIZE_DEBOUNCE_MS);
  };
  // ELS-PANE-HEIGHT r2: the focused view puts its pane rect back when the frames say the PTY is another size.
  const sizeReassert = createSizeReassert({ send: (size) => { const now = paneSize(); if (attached && now.cols === size.cols && now.rows === size.rows) attached.resize(size.cols, size.rows); } });
  const remember = (): void => {
    if (selected && !remoteRows.some((row) => row.pane === selected)) lastLocal = selected;
    try { deps.memory.save({ sidebar: sidebarOpen, ...(lastLocal ? { lastPane: lastLocal } : {}), ...(groupFolds.size > 0 ? { groupFolds: Object.fromEntries(groupFolds) } : {}), ...(activeOnly ? { activeOnly } : {}) }); } catch { /* the view works without its memory */ }
  };
  // SIDETAB-LOOP-AGENTS-FU: a loop tab's state = its trigger's (exception → failed/red) in the side list, tab row and tiles.
  const everyRow = (): PaneRow[] => withLoopStates([...rows, ...remoteRows], deps.loopFacts?.facts());
  // ELS-MOUSE (OP #100984): 마우스 해석용 마지막 배치 + 스크롤백 히스토리/오프셋
  // ELS-NARROW-TAB-DROPDOWN: under NARROW_BELOW_COLS the top row is «emoji tab ▾»; open, the tab list is drawn under it.
  let dropdown = false;
  let dropCursor: DropdownTarget | undefined;
  let dropHits: readonly ({ readonly y: number } & DropdownTarget)[] = [];
  const emptySpaces = () => [...emptyCoordinatorSpaces(lsAnswer, rows), ...remoteEmpty];
  const selectedEmptySpace = (): { wsId: string; name: string; remote?: string } | undefined => emptySpaces().find((space) => space.wsId === selectedEmpty);
  const localCreationTarget = () => {
    const empty = selectedEmptySpace();
    return empty ? (empty.remote ? undefined : empty.wsId) : current() && !current()!.remote ? current()!.workspace : undefined;
  };
  const narrow = (): boolean => deps.size().cols < NARROW_BELOW_COLS;
  let mouseLayout: MouseLayout = { cols: 0, rows: 0, sidebarWidth: 0, sidebar: [], tabs: [] };
  // ELS-SCROLL-MOUSE: the person's own scroll of the side list (first item) and the tab row (first tab); undefined = follow
  // the selection. A new selection drops both, so the selected item is always brought back into view.
  let listTop: number | undefined;
  let tabFirst: number | undefined;
  let listScroll: { start: number; total: number; room: number } | undefined;
  let spacesTop: number | undefined;   // ELS-SIDE-SPLIT-SCROLL: the spaces region's own offset (undefined = keep the selected space in view)
  let spacesScroll: { start: number; total: number; room: number } | undefined;
  const scrollSpaces = (to: number): void => { if (!spacesScroll) return; spacesTop = Math.max(0, Math.min(spacesScroll.total - spacesScroll.room, to)); render(); };
  let tabScroll: { first: number; count: number; more: boolean } | undefined;
  const scrollList = (to: number): void => { if (!listScroll) return; listTop = Math.max(0, Math.min(listScroll.total - listScroll.room, to)); render(); };
  const scrollTabs = (delta: number): void => { if (!tabScroll || (delta > 0 && !tabScroll.more) || (delta < 0 && tabScroll.first === 0)) return; tabFirst = Math.max(0, Math.min(tabScroll.count - 1, tabScroll.first + delta)); render(); };
  let scroll = 0;                // lines the shown frame is above the live bottom (told by the server's frame)
  let wheelPassthrough = false;
  let wheelRoute: WheelRoute = 'host';   // ELS-WHEEL-HISTORY: this frame's full wheel route (mouse report · ↑/↓ · els scrollback)   // ELS-WHEEL-SCROLLBACK (OP #136704): this frame's pane takes the wheel as bytes (alternate screen + its own mouse)
  // ELS-MOUSE-RELEASE (JUD-B #111750): a release follows its press. The press the app consumed (tab/list/⏏✕ click, wheel
  // excluded — it has no release) is answered by swallowing its release; a press that went to the pane program is answered by
  // passing its release to the pane too, wherever the pointer is let go — the pane saw the press and waits for the release.
  let pressConsumed = false;
  // ELS-POPUP-MOVE/RESIZE (대표 11-26 B2): a press on a layer's title row (or its bottom-right corner) and the release at
  // another cell = a drag. Only the SGR press/release reports the app already receives — no mouse mode is turned on.
  let layerDrag: { readonly id: string; readonly mode: 'move' | 'resize'; readonly x: number; readonly y: number } | undefined;
  const layerView = (): { cols: number; rows: number } => ({ cols: deps.size().cols, rows: deps.size().rows - 1 });
  const handleMouse = (report: MouseReport): void => {
    if (report.release) {
      const swallow = pressConsumed;
      pressConsumed = false;
      const drag = layerDrag;
      layerDrag = undefined;
      if (drag && (report.x !== drag.x || report.y !== drag.y)) deps.overlays?.act?.({ action: drag.mode, id: drag.id, dx: report.x - drag.x, dy: report.y - drag.y, view: layerView() });
      if (!swallow && attached) attached.input(report.bytes);
      return;
    }
    const wheel = (report.button & 0x40) !== 0;
    // ELS-ZAXIS S2: overlay layers are above everything but the status line — z-order hit test first. A click on a layer is the
    // layer's (asked of the server: raise + focus); outside a blocking layer it is swallowed; otherwise it falls through to
    // the tabs, the side list and the pane exactly as before. focus:'none' layers (toasts) are always clicked through.
    if (overlay.layers.length) {
      const hit = overlayMouse(overlay, { cols: mouseLayout.cols, rows: mouseLayout.rows - 1 }, report.x, report.y, overlayWs());
      // A wheel over a layer belongs to the layer: three rows up/down for the focused one, swallowed otherwise (it never
      // scrolls the pane under the popup).
      if (hit && wheel) {
        const top = focusTop(overlay, overlayWs());
        if (hit.kind === 'layer' && top.kind === 'layer' && top.layer.id === hit.layer.id) {
          if (hit.layer.kind === 'term') popupTerm.scroll((report.button & 1) ? -3 : 3);   // ELS-POPUP-TERM: its own scrollback
          else overlayKey((report.button & 1) ? '\u001b[B\u001b[B\u001b[B' : '\u001b[A\u001b[A\u001b[A');   // arrows (main: wheel = arrows)
        }
        return;
      }
      if (hit) {
        pressConsumed = true;
        if (hit.kind === 'layer') {
          baseFocus = false;
          deps.overlays?.act?.({ action: 'raise', id: hit.layer.id }); deps.overlays?.act?.({ action: 'focus', id: hit.layer.id });
          if (report.button === 0 && hit.local.y === 0) layerDrag = { id: hit.layer.id, mode: 'move', x: report.x, y: report.y };
          else if (report.button === 0 && hit.local.x === hit.box.w - 1 && hit.local.y === hit.box.h - 1) layerDrag = { id: hit.layer.id, mode: 'resize', x: report.x, y: report.y };
        }
        return;
      }
    }
    // ELS-EXIT-BG-BUTTONS: a left click on the bottom line hits ⏏ 백그라운드 / ✕ 종료 (the rest of that line does nothing).
    if (report.y === mouseLayout.rows && mouseLayout.rows > 0) {
      pressConsumed = !wheel;
      const hit = report.button === 0 ? hitButton(report.x, mouseLayout.cols) : null;
      if (hit === 'background') finish(0, '');
      else if (hit === 'quit') quitSpace();
      return;
    }
    if (narrow() && !wheel && report.button === 0 && (dropdown || (report.y === 1 && (everyRow().length > 0 || emptySpaces().length > 0)))) {
      pressConsumed = true;                                       // the list (or its top row) takes the press, so it swallows the release too
      if (dropdown) { const hit = dropHits.find((one) => one.y === report.y); dropdown = false; if (hit) { if ('pane' in hit) select(hit.pane); else selectEmpty(hit.ws); } render(); } else openDropdown();
      return;
    }
    const emptyHit = !wheel && report.button === 0 && report.x <= mouseLayout.sidebarWidth
      ? emptyHits.find((hit) => hit.y === report.y) : undefined;
    if (emptyHit) {
      pressConsumed = true;
      selectEmpty(emptyHit.ws); return;
    }
    // ELS-GROUP-FOLD-CONTROL · ELS-ACTIVE-ONLY-FILTER: the side list's own controls take a left click before any selection.
    if (!wheel && report.button === 0 && report.x <= mouseLayout.sidebarWidth) {
      const col = report.x - 1;
      const inBox = (box?: { y: number; from: number; to: number }): boolean => !!box && box.y === report.y && col >= box.from && col < box.to;
      const head = listMarks.heads.find((one) => one.y === report.y);
      if (inBox(listMarks.foldAll?.expand)) { pressConsumed = true; foldEvery(false); return; }
      if (inBox(listMarks.foldAll?.collapse)) { pressConsumed = true; foldEvery(true); return; }
      if (inBox(listMarks.active)) { pressConsumed = true; toggleActive(); return; }
      if (head) { pressConsumed = true; foldGroup(head.ws, !head.folded); return; }
    }
    const action = interpretMouse(report, mouseLayout);
    pressConsumed = !wheel && action?.kind !== 'passthrough';
    if (!action) return;
    if (action.kind === 'new-tab') { renameTarget = undefined; dropdown = false; if (!current()?.remote && !selectedEmptySpace()?.remote) newTab.openPrompt(); }
    else if (action.kind === 'select') select(action.pane);
    else if (action.kind === 'list-scroll') scrollList((listScroll?.start ?? 0) + action.delta);
    else if (action.kind === 'list-jump') scrollList(action.start);
    else if (action.kind === 'spaces-scroll') scrollSpaces((spacesScroll?.start ?? 0) + action.delta);
    else if (action.kind === 'spaces-jump') scrollSpaces(action.start);
    else if (action.kind === 'tab-scroll') scrollTabs(action.delta);
    // ELS-WHEEL-SCROLLBACK (OP #136704): a wheel over a pane that tracks its own mouse on an alternate screen belongs to
    // the pane program as bytes — the els scrollback lane is empty there, so scrolling it only eats the wheel.
    // ELS-WHEEL-HISTORY: the frame's wheel route (read from the pane's CURRENT modes) decides — the pane's own mouse
    // report at PANE coordinates, ↑/↓ for alternate scroll, else the els scrollback.
    else if (action.kind === 'scroll') {
      const route = wheelRoute !== 'host' ? wheelRoute : wheelPassthrough ? 'mouse-sgr' : 'host';
      const left = mouseLayout.sidebarWidth > 0 ? mouseLayout.sidebarWidth + 1 : 0;
      const top = everyRow().length > 0 ? 1 : 0;   // the tab row over the pane (paneSize)
      const bytes = attached ? wheelBytes(route, report.button, report.x - left, report.y - top) : null;
      if (bytes !== null && attached) attached.input(bytes); else scrollPane(action.lines);
    }
    else if (attached) attached.input(action.bytes);
    else { note = '원격 pane은 마우스 통과 불가'; render(); }
  };
  const foldGroup = (ws: string, folded: boolean): void => { groupFolds.set(ws, folded); listTop = undefined; remember(); render(); };
  const groupWsIds = (): string[] => [...new Set(everyRow().map((row) => row.wsId))];
  const foldEvery = (folded: boolean): void => { for (const ws of groupWsIds()) groupFolds.set(ws, folded); listTop = undefined; remember(); render(); };
  const toggleActive = (): void => {
    activeOnly = !activeOnly; listTop = undefined; remember();
    // The selection jumps to the nearest visible (active) entry when the filter hides it.
    const all = everyRow();
    const at = all.findIndex((row) => row.pane === selected);
    if (activeOnly && at >= 0 && !isActiveSeat(all[at]!)) {
      const near = all.map((row, index) => ({ row, d: Math.abs(index - at) })).filter((one) => isActiveSeat(one.row)).sort((a, b) => a.d - b.d)[0];
      if (near) { select(near.row.pane); return; }
    }
    render();
  };
  const openDropdown = (): void => { if (everyRow().length === 0 && emptySpaces().length === 0) return; dropdown = true; dropCursor = selectedEmpty ? { ws: selectedEmpty } : selected ? { pane: selected } : undefined; render(); };
  const dropdownKey = (bytes: string): void => {
    const order = dropdownTargets(withCommands(everyRow(), lsAnswer), emptySpaces());
    const at = Math.max(0, order.findIndex((target) => dropCursor && ('pane' in target ? 'pane' in dropCursor && target.pane === dropCursor.pane : 'ws' in dropCursor && target.ws === dropCursor.ws)));
    if (bytes === '\u001b') dropdown = false;
    else if (bytes === '\r' || bytes === '\n') { dropdown = false; if (dropCursor) { if ('pane' in dropCursor) select(dropCursor.pane); else selectEmpty(dropCursor.ws); } }
    else if (bytes === 'j' || bytes === '\u001b[B') dropCursor = order[Math.min(at + 1, order.length - 1)];
    else if (bytes === 'k' || bytes === '\u001b[A') dropCursor = order[Math.max(at - 1, 0)];
    render();
  };
  const scrollPane = (lines: number): void => {
    if (current()?.remote || !attached) { note = '이 pane 은 스크롤백을 볼 수 없음'; render(); return; }
    attached.scroll(lines);
  };
  const current = (): PaneRow | undefined => everyRow().find((row) => row.pane === selected);

  const statusText = (): string => {
    if (voice.isOpen()) return voice.line();
    // ELS-STALE-CLIENT: a client started before the last update keeps its old code (live 11-24: a 11-23 client missed the
    // wheel fix) — say so on the one line every screen keeps, until the person restarts it.
    if (staleClient && !confirm && scroll === 0) return ` ${STALE_CLIENT_HINT}${deps.buildLabel ? ` · ${deps.buildLabel}` : ''} `;
    if (confirm) return ` ${confirm.prompt} · y confirm · any other key cancels `;
    if (scroll > 0) return ` ↑ scrollback ${scroll} lines up · wheel or ctrl+b [ ] to move · type to return `;
    // 출처: seat-state/OP/orders/ELS-FIRST-RUN-UX-1119.md ③ 하단 항상 · UX #38884 — 조용할 때는 FIRST_RUN_HINT 리터럴 한 줄
    if (selectedEmpty) return `${remoteStatus ? `${remoteStatus} · ` : ''}${note || 'Empty workspace — no pane'}`;
    if (!remoteStatus && !note && !readError && !current()?.remote) return deps.buildLabel ? ` ${deps.buildLabel} · ${FIRST_RUN_HINT.trimStart()}` : FIRST_RUN_HINT;
    if (!remoteStatus && !readError && !current()?.remote) return `${note} · ${FIRST_RUN_HINT}`;
    const row = current();
    // ELS-FIRST-RUN-FU3 ①: the status line is cut to the width — the pane name without its badge, and the read error right
    // after the person's note, so what matters is what stays when a narrow terminal cuts the rest.
    const where = row ? `${row.workspace} ▸ ${row.title.replace(/(\s*\[[^\]]*\])+\s*$/, '')} · ${row.state}${row.remote ? ' · read-only' : ''}` : 'No pane — ctrl+b c for a new one';
    return ` ${note ? `${note} · ` : ''}${readError ? `${readError} · ` : ''}${remoteStatus ? `${remoteStatus} · ` : ''}${where} · q detach `;
  };
  // ELS-TYPING-LATENCY: a pane frame (every echo of a typed key) changes only the pane area. The sidebar, tab row and
  // dropdown come from the listing poll and the person's own actions — those renders recompute them; a frame render
  // reuses the last computed chrome (no listing walk, no baton file read on the typing path).
  let chrome: { cols: number; height: number; width: number; tabs: { line?: string }; overlay?: readonly string[]; sidebar: readonly string[] | null } | undefined;
  // ---- ELS-TILE-MODE: the live grid. Screens come from the server's memory (`tile-frame`), ~2 fps, single-flight; the
  // frame writer repaints only changed rows. Tile mode is read-only: arrows/hjkl move the focus, Enter zooms in.
  let tileMode = false;
  // ELS-ZAXIS S2: the last pushed overlay stack (the server is its only author) and its painter (render cache by layer).
  let overlay: OverlayStack = emptyStack();
  let overlayWatch: { close: () => void } | undefined;
  let overlayServerRev = -1;
  let baseFocus = false;                                          // A2: ctrl+b Tab gave this view's keys to the pane under the layers
  // ELS-POPUP-TERM: the popup terminal's attach stream, its renderer (the live screen) and its cursor.
  const popupTerm = createPopupTerm({
    attach: (pane, size, handlers) => deps.attach(pane, size, handlers),
    request: (request) => deps.request(request),
    render: () => { if (!finished) render(); },
    popupRows: () => popupRows,
    act: (one) => deps.overlays?.act?.(one),
    layerPane: (id) => (overlay.layers.find((one) => one.id === id)?.props as { pane?: string } | undefined)?.pane,
    create: async () => {
      const row = current();
      const input = withNewDefaults({ command: [], ws: POPUP_WS, title: 'popup' }, deps.env, row && !row.remote && row.cwd ? row.cwd : deps.cwd);
      const made = await deps.request({ op: 'new', ...input });
      if (made.exitCode !== 0) { note = made.message; return undefined; }
      const pane = (JSON.parse(made.message) as { pane?: unknown }).pane;
      await refresh(true);
      return typeof pane === 'string' ? pane : undefined;
    },
    note: (text) => { note = text; render(); },
  });
  const paintLayer = createLayerPainter({ ...(deps.overlays?.renderers ?? {}), term: (layer, size, focused) => popupTerm.render(layer, size, focused) }, deps.overlays?.paintKey);
  let tileWs = deps.tile?.ws;
  let tileGridSpec: TileGridSpec = deps.tile?.grid ?? 'auto';
  let stageLayoutSeq = 0;
  let tileFocus = 0;
  let tileTimer: unknown;
  let tileBusy = false;
  let tileArmed = false;
  const tileScreens = new Map<string, string>();
  const now = deps.now ?? Date.now;
  const tileFirstSeen = new Map<string, number>();
  let stageFeed: StageFeed | undefined;
  let stageSpot: { pane: string; until: number; key: string } | undefined;
  let stageTick = 0;
  const voteSeen: number[] = [];
  // ELS-TILE-DEMO-QUICKWINS: level (all ← spaces ← space), page, stable slots, counters clock, done flash.
  let tileLevel: 'all' | 'spaces' | 'space' = deps.tile?.spaces ? 'spaces' : deps.tile?.all ? 'all' : 'space';
  let tilePage = 0;
  let tilePageAt = 0;
  let tileSlots: (string | undefined)[] = [];
  let tileSlotKey = '';
  const tileStarted = now();
  const tileDoneAt = new Map<string, number>();
  const tileLastState = new Map<string, string>();                                 // the tick each vote (by index) first appeared
  let stageCfg: { readonly readFeed?: () => string | undefined } | undefined = deps.tile?.stage;
  let stageWatchKey: string | undefined;
  const stageView = (): Parameters<typeof drawTileFrame>[0]['stage'] => {
    if (!stageCfg) return undefined;
    const t = now();
    const panes = tileRows().map((row) => row.pane);
    for (const pane of panes) if (!tileFirstSeen.has(pane)) tileFirstSeen.set(pane, t);
    for (const pane of tileFirstSeen.keys()) if (!panes.includes(pane)) tileFirstSeen.delete(pane);
    const fresh = new Set([...tileFirstSeen].filter(([, at]) => t - at < 1_500).map(([pane]) => pane));
    const resolvePane = (ref: string | undefined): string | undefined => ref === undefined ? undefined
      : tileRows().find((row) => row.pane === ref || row.tabId === ref || row.title === ref || row.title.replace(/ \[[^\]]*\]$/, '') === ref)?.pane
        // GOAL-ORCHESTRATION-NL: «zoom risk» names a tab loosely — a unique case-insensitive title match.
        ?? (() => { const low = ref.toLowerCase(); const hits = ref.length >= 2 ? tileRows().filter((row) => row.title.toLowerCase().includes(low)) : []; return hits.length === 1 ? hits[0]!.pane : undefined; })();
    const verdict = resolvePane(stageFeed?.verdictPane);
    const spot = stageSpot && t < stageSpot.until ? resolvePane(stageSpot.pane) : undefined;
    const solo = verdict ?? spot;
    const votes = stageFeed?.votes?.length ?? 0;
    voteSeen.length = Math.min(voteSeen.length, votes);
    while (voteSeen.length < votes) voteSeen.push(stageTick);
    const lane = stageLane(stageFeed, stageTick, voteSeen.map((at) => stageTick - at), deps.size().cols);
    const tiles = tileInputs();
    const counters = stageFeed?.counters;
    const models = new Set(tiles.map((tile) => tile.model).filter(Boolean)).size;
    const header = stageHeader({ agents: counters?.agents ?? tiles.filter((tile) => !tile.hole).length, models: counters?.models ?? models,
      ...(counters?.toolCalls !== undefined ? { toolCalls: counters.toolCalls } : {}), ...(counters?.cited !== undefined ? { cited: counters.cited } : {}),
      elapsedMs: counters?.elapsedMs ?? t - tileStarted });
    for (const tile of tiles) {
      const before = tileLastState.get(tile.pane);
      if (before !== undefined && before !== 'done' && tile.state === 'done') tileDoneAt.set(tile.pane, t);
      tileLastState.set(tile.pane, tile.state);
    }
    const flashDone = new Set([...tileDoneAt].filter(([, at]) => t - at < 1_500).map(([pane]) => pane));
    const layout = tileLayout({ cols: deps.size().cols, rows: deps.size().rows, tiles, focus: 0, grid: tileGridSpec, page: tilePage, fold: true }, deps.size().rows - 3);
    const onPage = new Set(layout.visible.map((tile) => tile?.pane));
    const pageFlash = layout.pages > 1 && [...fresh].some((pane) => !onPage.has(pane));
    return { ribbon: stageRibbon(stageFeed), header, lane, fresh, flashDone, pageFlash, pulse: stageTick % 2 === 0, ...(solo ? { solo } : {}),
      ...(solo && stageFeed?.spotlightCaption ? { caption: stageFeed.spotlightCaption } : {}), ...(stageFeed?.receipt ? { receipt: stageFeed.receipt } : {}) };
  };
  const tileRows = (): PaneRow[] => {
    let all = everyRow();
    if (deps.tile?.remote === false) all = all.filter((row) => !row.remote);
    if (deps.tile?.active) all = all.filter((row) => row.state === 'working');
    if (tileLevel !== 'space') {                                  // ALL / SPACES: space → tab order (first appearance of each space)
      const order = [...new Set(all.map((row) => row.wsId))];
      return [...all].sort((a, b) => order.indexOf(a.wsId) - order.indexOf(b.wsId));
    }
    const ws = tileWs !== undefined ? all.find((row) => row.workspace === tileWs || row.wsId === tileWs)?.wsId : (current()?.wsId ?? all[0]?.wsId);
    return all.filter((row) => row.wsId === ws);
  };
  const titleOf = (row: PaneRow): string => row.title.replace(/ \[[^\]]*\]$/, '') || row.pane;
  /** SPACES: the representative pane of each space (first working, else the first). */
  const spaceGroups = (): { wsId: string; name: string; rows: PaneRow[] }[] => {
    const groups = new Map<string, { wsId: string; name: string; rows: PaneRow[] }>();
    for (const row of tileRows()) { const g = groups.get(row.wsId) ?? { wsId: row.wsId, name: row.workspace, rows: [] }; g.rows.push(row); groups.set(row.wsId, g); }
    return [...groups.values()];
  };
  const repOf = (rows: readonly PaneRow[]): PaneRow | undefined => rows.find((row) => row.state === 'working' && !row.remote) ?? rows.find((row) => !row.remote);
  const lastLine = (screen: string | undefined): string | undefined => screen?.replace(/\u001b\[[0-9;:?]*[A-Za-z]/g, '').split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('[screen')).at(-1);
  const tileInputs = (): TileInput[] => {
    if (tileLevel === 'spaces') return spaceGroups().map((g) => {
      const coordinator = g.rows.find((row) => row.role === 'coordinator' || row.spaceCoordinator);
      const rep = repOf(g.rows);
      const line = lastLine(rep ? tileScreens.get(rep.pane) : undefined);
      return spaceTile({ id: g.wsId, name: g.name, ...(coordinator ? { coordinator: titleOf(coordinator) } : {}), panes: g.rows.map((row) => ({ title: titleOf(row), state: row.state })), ...(line ? { line } : {}) });
    });
    const rows = tileRows();
    const byPane = new Map(rows.map((row) => [row.pane, row]));
    const key = `${tileLevel}|${tileWs ?? ''}`;
    if (key !== tileSlotKey) { tileSlots = []; tileSlotKey = key; }
    const { cols, rows: height } = deps.size();
    tileSlots = assignSlots(tileSlots, rows.map((row) => row.pane), (n) => { const g = tileGrid(Math.max(1, Math.min(MAX_TILES, n)), tileGridSpec, cols, height); return g.c * g.r; });
    return tileSlots.map((pane): TileInput => {
      const row = pane !== undefined ? byPane.get(pane) : undefined;
      if (!row) return { pane: `hole:${tileSlots.indexOf(pane)}`, title: '', state: 'idle', hole: true };
      const screen = tileScreens.get(row.pane);
      const model = modelOf(row.title, row.seat, row.cwd, screen?.slice(0, 2_000));
      return { pane: row.pane, title: titleOf(row), state: row.state, ...(row.seat ? { tag: row.seat } : {}),
        ...(row.remote ? { remote: true } : {}), ...(row.state === 'exited' ? { closed: true } : {}), ...(model ? { model } : {}),
        ...(tileLevel === 'all' ? { space: row.workspace } : {}), ...(screen !== undefined ? { screen } : {}) };
    });
  };
  const frameInput = (): TileFrameInput => {
    const { cols, rows: height } = deps.size();
    const tiles = tileInputs();
    const live = tiles.filter((tile) => !tile.hole).length;
    const label = tileLevel === 'all' ? 'ALL' : tileLevel === 'spaces' ? 'SPACES' : `TILE ${tileRows()[0]?.workspace ?? tileWs ?? ''}`;
    const nav = tileLevel === 'spaces' ? 'Enter open space · Esc all' : `Enter zoom${tileLevel === 'space' ? ' · Esc spaces' : ''}`;
    const status = live === 0 ? `${label} · ${tileWs && tileLevel === 'space' ? `no panes in «${tileWs}»` : 'no panes'} · waiting · ctrl+b q quit`
      : `${label} · ${live} ${tileLevel === 'spaces' ? 'spaces' : 'panes'} · arrows/hjkl focus · ${nav} · ctrl+b ? shortcuts · ctrl+b q quit${note ? ` · ${note}` : ''}`;
    const stage = stageView();
    return { cols, rows: height, tiles, focus: tileFocus, grid: tileGridSpec, status, page: tilePage, fold: stageCfg !== undefined && tileLevel !== 'spaces', ...(stage ? { stage } : {}) };
  };
  const frameLayout = (view: TileFrameInput) => tileLayout(view, view.rows - [view.stage?.ribbon, view.stage?.header, view.stage?.lane, view.stage?.receipt].filter((x) => x !== undefined).length);
  const renderTile = (): void => {
    let view = frameInput();
    const layout = frameLayout(view);
    if (layout.page !== tilePage) { tilePage = layout.page; view = { ...view, page: tilePage }; }
    if (tileFocus >= layout.visible.length) { tileFocus = Math.max(0, layout.visible.length - 1); view = { ...view, focus: tileFocus }; }
    deps.write(drawTileFrame(view, layerBoxes(view.cols, view.rows)));
  };
  const pollTiles = async (): Promise<void> => {
    if (!tileMode || tileBusy || finished) return;
    tileBusy = true;
    try {
      if (deps.tile?.autoPageMs && now() - tilePageAt >= deps.tile.autoPageMs) {   // ① auto-advance (wraps)
        const pages = frameLayout(frameInput()).pages;
        if (tilePageAt !== 0) tilePage = pages > 1 ? (tilePage + 1) % pages : 0;
        tilePageAt = now();
      }
      const shownPanes = tileLevel === 'spaces' ? new Set(spaceGroups().map((g) => repOf(g.rows)?.pane))
        : new Set(frameLayout(frameInput()).visible.map((tile) => tile?.pane));
      const wanted = tileRows().filter((row) => shownPanes.has(row.pane) && !row.remote && row.state !== 'exited');
      const keep = new Set(wanted.map((row) => row.pane));
      for (const pane of tileScreens.keys()) if (!keep.has(pane)) tileScreens.delete(pane);   // flat memory: gone panes leave
      let changed = false;
      await Promise.all(wanted.map(async (row) => {
        try {
          const answer = await deps.request({ op: 'tile-frame', pane: row.pane });
          if (answer.exitCode === 0 && tileScreens.get(row.pane) !== answer.message) { tileScreens.set(row.pane, answer.message); changed = true; }
        } catch { /* a pane gone mid-read shows its last screen until the list drops it */ }
      }));
      if (stageCfg) {
        stageTick++;
        let text: string | undefined;
        try { text = stageCfg.readFeed?.(); } catch { text = undefined; }
        const feed = parseStageFeed(text);
        if (feed?.layout && feed.layout.seq !== stageLayoutSeq) {          // GOAL-ORCHESTRATION-NL: voice/text layout
          const l = feed.layout;
          if (stageLayoutSeq !== 0 || l.seq > 0) {
            if (l.grid) tileGridSpec = l.grid;
            if (l.level && l.level !== tileLevel) { tileLevel = l.level; tileFocus = 0; tilePage = 0; tileScreens.clear(); }
            if (l.page !== undefined) {
              const pages = frameLayout(frameInput()).pages;
              tilePage = l.page === 'next' ? (tilePage + 1) % Math.max(1, pages) : l.page === 'prev' ? (tilePage + pages - 1) % Math.max(1, pages) : Math.min(l.page, Math.max(0, pages - 1));
            }
            if (l.zoom === '') stageSpot = undefined;
          }
          stageLayoutSeq = l.seq;
        }
        if (feed?.spotlightPane) {
          const key = `${feed.spotlightPane}|${feed.phase ?? ''}|${feed.spotlightMs ?? ''}`;
          if (stageSpot?.key !== key) stageSpot = { pane: feed.spotlightPane, until: now() + (feed.spotlightMs ?? 5_000), key };
        }
        stageFeed = feed;
        changed = true;                                         // the pulse and the feed repaint every tick (damage-only)
      }
      if (changed && tileMode && !finished) renderTile();
    } finally { tileBusy = false; }
  };
  const enterTile = (): void => {
    if (finished) return;
    tileMode = true;
    tileArmed = false;
    const at = tileRows().findIndex((row) => row.pane === selected);
    if (at >= 0) tileFocus = at;
    generation++; attached?.detach(); attached = undefined;   // no pane is attached while the grid shows
    if (tileTimer === undefined) tileTimer = deps.setInterval(() => { void pollTiles(); }, stageCfg ? TILE_REFRESH_MS / 2 : TILE_REFRESH_MS);
    renderTile();
    void pollTiles();
  };
  const zoomTile = (): void => {
    const picked = frameLayout(frameInput()).visible[tileFocus];
    if (tileLevel === 'spaces') {                                 // drill into that space's tab tiles
      const wsId = picked?.pane.replace(/^space:/, '');
      if (!wsId) return;
      tileLevel = 'space'; tileWs = wsId; tileFocus = 0; tilePage = 0; tileScreens.clear(); note = ''; renderTile(); void pollTiles(); return;
    }
    const row = tileRows().find((r) => r.pane === picked?.pane);
    if (!row || row.state === 'exited') { note = row ? 'pane closed' : ''; renderTile(); return; }
    tileMode = false;
    if (tileTimer !== undefined) { deps.clearInterval(tileTimer); tileTimer = undefined; }
    tileScreens.clear();
    tileWs = row.workspace;
    note = 'ctrl+b t back to tile';
    if (row.pane === selected) { selected = undefined; }
    select(row.pane);
  };
  const tileKey = (keys: string): void => {
    let text = keys;
    if (!tileArmed) {                                              // ELS-ZAXIS S2: a focused layer over the grid takes keys first
      // ELS-SHORTCUTS-POPUP: ctrl+b is never a layer's key — the prefix stays the grid's, as it is over a tab (the key
      // router arms it before any layer), so ctrl+b ? / q / ` work while a popup over the grid has the keys.
      const at = text.indexOf('\u0002');
      const head = at < 0 ? text : text.slice(0, at);
      const rest = head ? overlayKey(head) : undefined;
      if (rest !== undefined) { text = rest + (at < 0 ? '' : text.slice(at)); if (!text) return; }
    }
    let rest = text;
    while (rest) {
      if (tileArmed) {
        tileArmed = false;
        const char = rest[0]!; rest = rest.slice(1);
        const action = Object.hasOwn(AFTER_PREFIX, char) ? AFTER_PREFIX[char] : undefined;   // the one key table (key-bindings.ts)
        if (action && termAction(action)) { /* ELS-POPUP-TERM over the grid: q/Esc hide · x close · m to a tab (joins this grid) */ }
        else if (action === 'popup-term') toggleTerm();
        else if (action === 'detach') { finish(0, ''); return; }
        else if (action === 'files') openFiles();                 // ELS-FILES: over the grid too
        else if (action === 'help') toggleShortcuts();             // ELS-SHORTCUTS-POPUP: over the grid too
        // t (already tiled) and every other prefix key: nothing
        if (rest) tileKey(rest);                                  // what follows goes through the layer route again
        return;
      }
      // ELS-SHORTCUTS-POPUP: the grid's keys are rows of the one key table (key-bindings.ts · tileActionOf).
      const arrow = /^\u001b(?:\[|O)[ABCD]/.exec(rest)?.[0];
      const key = arrow ?? rest[0]!;
      rest = rest.slice(key.length);
      if (key === '\u0002') { tileArmed = true; continue; }
      const action = tileActionOf(key);
      const dir = action === 'tile-left' ? 'left' : action === 'tile-down' ? 'down' : action === 'tile-up' ? 'up' : action === 'tile-right' ? 'right' : undefined;
      if (dir) {
        const layout = frameLayout(frameInput());
        tileFocus = moveFocus(tileFocus, dir, layout.visible.length, layout.c);
        note = ''; renderTile(); continue;
      }
      if (action === 'tile-zoom') { zoomTile(); return; }
      if (action === 'tile-page-prev' || action === 'tile-page-next') {   // ① pages
        const pages = frameLayout(frameInput()).pages;
        tilePage = (tilePage + (action === 'tile-page-next' ? 1 : pages - 1)) % pages; tileFocus = 0; tilePageAt = now(); note = ''; renderTile(); void pollTiles(); continue;
      }
      if (action === 'tile-level-up' && (rest === '' || !/^[\[O]/.test(rest))) {   // a lone Esc: up one level (space → spaces → all)
        if (tileLevel === 'all') continue;
        tileLevel = tileLevel === 'space' ? 'spaces' : 'all'; tileFocus = 0; tilePage = 0; tileScreens.clear(); note = ''; renderTile(); void pollTiles(); continue;
      }
      if (key === '\u001b') { rest = rest.replace(/^[\[O][0-9;<>?]*[@-~]?/, ''); continue; }   // other escapes (mouse…) dropped
      // Every other key: tile mode is read-only.
    }
  };

  // ELS-ZAXIS S2: the workspace whose pin:'space' layers show — the tile grid's space, else the selected tab's (or empty space's).
  const overlayWs = (): string | undefined => tileMode ? tileRows()[0]?.wsId : current()?.wsId ?? selectedEmpty;
  /** ELS-OBSIDIAN-KEY (대표 11-26): ctrl+b o toggles the Obsidian popup of this view's workspace — close the one shown here,
   *  else open one owned by this workspace. Both go to the server as acts (the stack's only author). */
  const toggleObsidian = (): void => {
    const ws = overlayWs();
    const shown = visibleLayers(overlay, ws).filter((layer) => layer.kind === 'obsidian').at(-1);
    void deps.request(shown ? { op: 'overlay', action: 'close', id: shown.id } : { op: 'overlay', action: 'open', kind: 'obsidian', props: {}, ...(ws ? { ws } : {}) }).catch(() => undefined);
  };
  /** ELS-SHORTCUTS-POPUP (대표 11-28): ctrl+b ? toggles the shortcuts popup of this view's workspace — close the one shown here,
   *  else open one (one per workspace) that puts the keys of where you are first (tile grid · popup terminal · a popup). */
  const shortcutsContext = (): ShortcutContext => tileMode ? 'tile' : termFocused() ? 'popup-term' : overlayFocused() ? 'overlay' : 'normal';
  const toggleShortcuts = (): void => {
    const ws = overlayWs();
    const shown = visibleLayers(overlay, ws).filter((layer) => layer.kind === 'shortcuts').at(-1);
    if (shown) { overlay = closeLayer(overlay, shown.id); deps.overlays?.act?.({ action: 'close', id: shown.id }); render(); return; }
    const key = ws ? `ws-${ws.replace(/[^A-Za-z0-9._-]/g, '_')}`.slice(0, 64) : 'default';
    void deps.request({ op: 'overlay', action: 'open', kind: 'shortcuts', key, props: { context: shortcutsContext(), scroll: 0 }, ...(ws ? { ws } : {}) }).then((answer) => {
      if (answer.exitCode !== 0 && !finished) { note = answer.message; render(); }
    }, () => { if (!finished) { note = 'Shortcuts did not open (els server unreachable)'; render(); } });
  };
  /** ELS-POPUP-TERM: the visible term layer (if any) and its box for this view size. */
  const termLayer = (cols: number, height: number) => {
    const layer = overlay.layers.find((one) => one.kind === 'term' && shownIn(one, overlayWs()));
    return layer ? { layer, box: resolveRect(layer.rect, { cols, rows: height - 1 }) } : undefined;
  };
  const layerBoxes = (cols: number, height: number) => {
    if (!overlay.layers.length) { popupTerm.sync(undefined, undefined); return []; }
    const shownTerm = termLayer(cols, height);
    popupTerm.sync(shownTerm?.layer, shownTerm?.box);
    if (shownTerm && !(shownTerm.layer.props as { pane?: string } | undefined)?.pane) popupTerm.materialize(shownTerm.layer);
    // The paint cache keys on props: a new PTY frame must repaint the term box (local copy only — never sent).
    const stack = shownTerm ? updateLayer(overlay, shownTerm.layer.id, { props: { ...(shownTerm.layer.props as object ?? {}), frame: popupTerm.frameSeq() } }) : overlay;
    return composeLayers(stack, { cols, rows: height - 1 }, overlayWs(), paintLayer);
  };
  /** ELS-POPUP-TERM: is the popup terminal the focus owner? (then keys, Esc and ctrl-c go to its PTY) */
  const termFocused = (): boolean => { if (baseFocus || !overlay.layers.length) return false; const top = focusTop(overlay, overlayWs()); return top.kind === 'layer' && top.layer.kind === 'term'; };
  /** Where the terminal cursor goes: the PTY cursor inside the focused term box, else undefined. */
  const termCursor = (cols: number, height: number): { x: number; y: number } | undefined => {
    if (!termFocused()) return undefined;
    const shown = termLayer(cols, height);
    const at = popupTerm.cursor();
    return shown && at ? { x: shown.box.x + at.x, y: shown.box.y + at.y } : undefined;
  };
  const cursorProps = (cols: number, height: number) => { const at = termCursor(cols, height); return at ? { cursorAt: at } : overlayFocused() ? { hideCursor: true } : {}; };
  /** ctrl+b ` : show the popup terminal (reuse the live one, else a new shell) or hide it (the process keeps running). */
  const toggleTerm = (): void => {
    const shown = overlay.layers.find((one) => one.kind === 'term' && shownIn(one, overlayWs()));
    if (shown) { hideTerm(); return; }
    const live = popupRows.find((row) => row.state !== 'exited');
    void deps.request({ op: 'overlay', action: 'open', kind: 'term', props: live ? { pane: live.pane } : {} }).then((answer) => {
      if (answer.exitCode !== 0 && !finished) { note = answer.message; render(); }
    }, () => undefined);
  };
  const hideTerm = (): void => {
    const layer = overlay.layers.find((one) => one.kind === 'term');
    if (!layer) return;
    overlay = closeLayer(overlay, layer.id); deps.overlays?.act?.({ action: 'close', id: layer.id });
    note = 'Terminal hidden — ctrl+b ` brings it back'; render();
  };
  /** ctrl+b x on the popup terminal: close it — the server kills that pane's process (exact pid, through its holder). */
  const killTerm = (): void => {
    const layer = overlay.layers.find((one) => one.kind === 'term');
    const pane = (layer?.props as { pane?: string } | undefined)?.pane;
    if (layer) { overlay = closeLayer(overlay, layer.id); deps.overlays?.act?.({ action: 'close', id: layer.id }); }
    // Only that pane — never the els-popup workspace (another `els term` may be running there).
    if (pane && popupRows.some((row) => row.pane === pane)) {
      void deps.request({ op: 'close', pane, confirmed: true }).then(async (answer) => {
        note = answer.exitCode === 0 ? 'Terminal closed' : `Terminal not closed: ${answer.message}`;
        return refresh();
      }, () => { note = 'Terminal close outcome unknown'; render(); });
    }
    note = 'Closing the terminal…'; render();
  };
  /** ctrl+b m on the popup terminal: move it into this space as an ordinary tab (z > 0 → z = 0). */
  const dockTerm = (): void => {
    const layer = overlay.layers.find((one) => one.kind === 'term');
    const row = popupRows.find((one) => one.pane === (layer?.props as { pane?: string } | undefined)?.pane);
    const target = tileMode ? tileRows().find((one) => !one.remote)?.wsId : current() && !current()!.remote ? current()!.wsId : undefined;
    if (!layer || !row?.tabId || !target) { note = 'Nothing to move'; render(); return; }
    overlay = closeLayer(overlay, layer.id); deps.overlays?.act?.({ action: 'close', id: layer.id });
    void deps.request({ op: 'move-tab', tab: row.tabId, ws: target }).then(async (answer) => {
      note = answer.exitCode === 0 ? 'Terminal moved to a tab' : answer.message;
      await refresh();
      if (answer.exitCode !== 0) { render(); return; }
      if (!tileMode) { select(row.pane); return; }
      const at = frameLayout(frameInput()).visible.findIndex((one) => one?.pane === row.pane);   // over the grid: focus its tile
      if (at >= 0) tileFocus = at;
      renderTile();
    }, () => undefined);
  };
  /** The prefix actions the popup terminal takes while it has focus (true = handled). */
  const termAction = (action: KeyAction): boolean => {
    if (!termFocused()) return false;
    if (action === 'detach' || action === 'escape') { hideTerm(); return true; }   // ctrl+b q · ctrl+b Esc
    if (action === 'close') { killTerm(); return true; }
    if (action === 'move-tab') { dockTerm(); return true; }
    return false;
  };
  // A focused layer reads a lone Esc as «close me»: paste detection would hold it back as a possible paste start.
  const overlayFocused = (): boolean => !baseFocus && overlay.layers.length > 0 && focusTop(overlay, overlayWs()).kind === 'layer';
  /** ELS-SIDECHAT-EDGE A2: ctrl+b Tab — the keys go round the visible focusable layers top-down (by z), then the pane under
   *  them (this view only), then the top again. Focus never moves a layer in z (no raise); toasts (focus:'none') are skipped. */
  const cycleFocus = (): void => {
    const ring = [...visibleLayers(overlay, overlayWs()).filter((layer) => layer.focus !== 'none')].reverse();
    if (!ring.length) { note = 'ctrl+b Tab: no layer to focus'; render(); return; }
    const top = focusTop(overlay, overlayWs());
    const slots = ring.some((layer) => layer.blocking) ? ring.length : ring.length + 1;   // a blocking layer keeps the keys: no pane slot
    const at = baseFocus || top.kind !== 'layer' ? slots - 1 : ring.findIndex((layer) => layer.id === top.layer.id);
    const next = ring[(at + 1) % slots];
    if (!next) { baseFocus = true; note = 'keys → pane · ctrl+b Tab back to the layers'; render(); return; }
    baseFocus = false;
    note = '';
    overlay = focusLayer(overlay, next.id);
    deps.overlays?.act?.({ action: 'focus', id: next.id });
    render();
  };
  /** A key for the focused overlay layer: true = it took the key (nothing else sees it). Esc closes the layer (server act). */
  /** Keys for the focused overlay layer, one key at a time (a terminal read can carry «jjj» or «k\r» in one chunk). Returns
   *  undefined when no layer has focus (the normal path), else the bytes the layer passed down (''= it took them all).
   *  Esc closes the layer (server act). An update is applied to the local copy at once, so the next key in the same chunk
   *  (and the next frame) sees it; the server's push then confirms it. */
  const overlayKey = (bytes: string): string | undefined => {
    if (!overlay.layers.length || baseFocus) return undefined;
    const top = focusTop(overlay, overlayWs());
    if (top.kind !== 'layer') return undefined;
    if (top.layer.kind === 'term') { popupTerm.input(bytes); return ''; }   // ELS-POPUP-TERM: every key (Esc, ctrl-c) to the PTY
    let layer = top.layer;
    let passed = '';
    let changed = false;
    for (const key of bytes.match(/\u001b\[[0-9;?<>]*[ -\/]*[@-~]|\u001bO[@-~]|[\s\S]/gu) ?? []) {
      if (key === '\u0014') { followTab(deps.overlays?.act?.({ action: 'frame', id: layer.id, frame: 'next' })); return passed; }   // ELS-ELEMENT-HOST ctrl+t: popup → tile → tab
      const handled = deps.overlays?.keys?.[layer.kind]?.(layer, key) ?? 'pass';
      if (typeof handled === 'object' && 'open' in handled) {        // ELS-FILES: the element asks to open something elsewhere
        overlay = closeLayer(overlay, layer.id); deps.overlays?.act?.({ action: 'close', id: layer.id }); render();
        void openFromElement(handled.open);
        return passed;
      }
      // Esc closes the layer — unless the element uses it itself (an `update`: e.g. leaving the Obsidian search line) or the
      // layer holds Esc (ELS-TAKEOUT: props.holdEsc, server-set — a chooser/confirm row cancels instead).
      if (key === '\u001b' && typeof handled !== 'object' && (layer.props as { holdEsc?: unknown } | undefined)?.holdEsc !== true) { overlay = closeLayer(overlay, layer.id); deps.overlays?.act?.({ action: 'close', id: layer.id }); render(); return passed; }
      if (typeof handled === 'object') {
        // Optimistic first, then the act: a server that answers at once (its push lands inside the act) wins over the
        // local guess instead of being overwritten by it.
        const props = { ...(layer.props && typeof layer.props === 'object' ? layer.props as object : {}), ...(handled.update && typeof handled.update === 'object' ? handled.update as object : {}) };
        if (!('note' in (handled.update as object))) delete (props as { note?: unknown }).note;
        layer = { ...layer, props };
        overlay = updateLayer(overlay, layer.id, { props });
        changed = true;
        deps.overlays?.act?.({ action: 'update', id: layer.id, props: handled.update });
        layer = overlay.layers.find((one) => one.id === layer.id) ?? layer;
      // A focused `owns` layer keeps every key it does not use (ctrl-c, arrows, a paste, Korean IME text never reach the pane
      // under it; ctrl+b actions are routed before this). Only a `participates` layer hands unused keys down; a blocking
      // layer always keeps them.
      } else if (handled === 'pass' && layer.focus === 'participates' && !layer.blocking) passed += key;
    }
    if (changed) render();
    return passed;
  };
  /** ELS-ELEMENT-HOST-FU ①: the viewer that pressed ctrl+t follows its element into the new tab (other viewers stay). */
  const followTab = (answer: unknown): void => {
    void Promise.resolve(answer).then(async (reply) => {
      const result = reply as { exitCode?: unknown; message?: unknown } | undefined;
      if (!result || result.exitCode !== 0 || typeof result.message !== 'string') return;
      let pane: unknown;
      try { pane = (JSON.parse(result.message) as { frame?: unknown; pane?: unknown }).frame === 'tab' ? (JSON.parse(result.message) as { pane?: unknown }).pane : undefined; } catch { return; }
      if (typeof pane !== 'string' || finished) return;
      await refresh();
      if (finished || !everyRow().some((row) => row.pane === pane)) return;
      if (tileMode) { tileMode = false; if (tileTimer !== undefined) { deps.clearInterval(tileTimer); tileTimer = undefined; } tileScreens.clear(); }
      select(pane);
    }).catch(() => undefined);
  };
  // ELS-POPUP-MOVE/RESIZE (대표 11-26 B2): ctrl+b r on a focused layer = a mode where ←↑↓→ / hjkl move it one cell,
  // ⇧+arrows / HJKL resize it (bottom-right corner), Enter · Esc · r end the mode. Every step is one server act.
  let layerMoving: string | undefined;
  const LAYER_MOVE_NOTE = 'Move: ←↑↓→/hjkl move · ⇧←↑↓→/HJKL resize · Enter done';
  const startLayerMove = (): void => {
    const top = overlay.layers.length ? focusTop(overlay, overlayWs()) : undefined;
    if (top?.kind !== 'layer') { note = 'ctrl+b r: no focused popup to move'; render(); return; }
    layerMoving = top.layer.id; note = LAYER_MOVE_NOTE; render();
  };
  const layerMoveKeys = (bytes: string): void => {
    const id = layerMoving;
    if (!id || !overlay.layers.some((one) => one.id === id)) { layerMoving = undefined; note = ''; render(); return; }
    const delta = { move: { dx: 0, dy: 0 }, resize: { dx: 0, dy: 0 } };
    let done = false;
    for (const key of bytes.match(/\u001b\[1;2[ABCD]|\u001b\[[ABCD]|\u001bO[ABCD]|[\s\S]/gu) ?? []) {
      const arrow = /([ABCD])$/.exec(key)?.[1];
      const shifted = key.startsWith('\u001b[1;2');
      const dir = arrow && key.length > 1 ? arrow : ({ k: 'A', j: 'B', l: 'C', h: 'D', K: 'A', J: 'B', L: 'C', H: 'D' } as Record<string, string>)[key];
      if (dir) {
        const into = shifted || /^[HJKL]$/.test(key) ? delta.resize : delta.move;
        if (dir === 'A') into.dy--; else if (dir === 'B') into.dy++; else if (dir === 'C') into.dx++; else into.dx--;
      } else if (key === '\r' || key === '\n' || key === '\u001b' || key === 'r' || key === 'q') done = true;
    }
    if (delta.move.dx || delta.move.dy) deps.overlays?.act?.({ action: 'move', id, ...delta.move, view: layerView() });
    if (delta.resize.dx || delta.resize.dy) deps.overlays?.act?.({ action: 'resize', id, ...delta.resize, view: layerView() });
    if (done) { layerMoving = undefined; note = ''; render(); }
  };
  /** ELS-FILES: ctrl+b f — the file browser over the panes, rooted at the focused pane's cwd. */
  const openFiles = (): void => {
    const row = current();
    const dir = row && !row.remote && row.cwd ? row.cwd : deps.cwd;
    const ws = overlayWs();
    void deps.request({ op: 'overlay', action: 'open', kind: 'files', props: { dir }, ...(ws ? { ws } : {}) }).then((answer) => {
      if (answer.exitCode !== 0 && !finished) { note = answer.message; render(); }
    }, () => undefined);
  };
  /** ELS-FILES: what an element's `open` ask does — a pager/editor tab (argv, no shell), the same as a tile, the sidechat
   *  with the file as context, or the path typed into the pane under the popup (never sent: the person presses Enter). */
  const openFromElement = async (open: FilesOpen): Promise<void> => {
    if (finished) return;
    const row = current();
    if (open.how === 'sidechat') { await deps.request({ op: 'overlay', action: 'open', kind: 'sidechat', props: { input: '', ...(open.context ? { edit: { kind: 'type', text: open.context } } : {}) } }).catch(() => undefined); return; }
    if (open.how === 'attach') {
      if (!row || row.remote || !attached) { note = 'No local pane to attach the file to'; render(); return; }
      // ELS-FILES-SSH: a remote file goes in as a «host:path» reference (nothing is downloaded behind the person's back).
      const full = open.host ? `${open.host}:${open.path}` : open.path;
      const ref = /\s/.test(full) ? `"${full.replace(/(["\\$`])/g, '\\$1')}"` : full;
      attached.input(`\u001b[200~${ref} \u001b[201~`);
      note = `${open.title} → ${tabName(row.title)} input (Enter to send)`; render(); return;
    }
    const ws = row && !row.remote ? row.workspace : undefined;
    const made = await create(ws, { command: openCommand(open, deps.env), title: open.title });
    if (made === true && open.how === 'tile' && !tileMode) enterTile();
  };
  const render = (frameOnly = false): void => {
    if (finished) return;
    if (tileMode) { renderTile(); return; }
    const { cols, rows: height } = deps.size();
    if (frameOnly && chrome && chrome.cols === cols && chrome.height === height && !newTab.isOpen() && !movePicker) {
      const kept = chrome;
      const layers = layerBoxes(cols, height);
      deps.write(composeView({ cols, rows: height, sidebar: kept.sidebar, frame, status: statusText(), buttons: buttonsLayout(cols).text,
        ...(kept.tabs.line !== undefined ? { tabRow: kept.tabs.line } : {}), ...(kept.overlay ? { overlay: kept.overlay } : {}), ...(layers.length ? { layers } : {}), ...cursorProps(cols, height) }));
      return;
    }
    const width = sidebarWidthFor(cols, sidebarOpen);
    // ELS-ONE-SPACE (decision 11-18): left = the spaces folded (no pane lines, no headings); top = the selected space's tabs.
    const shown = withCommands(everyRow(), lsAnswer);
    if (cols >= NARROW_BELOW_COLS) dropdown = false;             // widened: back to the side list
    const empty = selectedEmptySpace();
    let tabs: ReturnType<typeof buildTabRow> = empty ? { line: ` ⭐ ${empty.name} `, tabs: [] } : buildTabRow(shown, selected, Math.max(10, cols - (width ? width + 1 : 0)), tabFirst);
    let overlay: readonly string[] | undefined;
    dropHits = [];
    if (cols < NARROW_BELOW_COLS && (shown.length > 0 || emptySpaces().length > 0)) {
      const down = buildTabDropdown(shown, selected, dropdown && dropCursor && 'pane' in dropCursor ? dropCursor.pane : undefined, cols, Math.max(1, height - 3), emptySpaces(), selectedEmpty, dropdown && dropCursor && 'ws' in dropCursor ? dropCursor.ws : undefined);
      tabs = { line: down.line, tabs: [] };
      if (dropdown) { overlay = down.list; dropHits = down.hits; }
    }
    // Read at every paint so return/expiry removes the badge on the next poll, without trusting a pane title.
    let actingSeat: string | undefined;
    try { actingSeat = deps.actingSeat ? deps.actingSeat() : readActiveBaton(dirname(elsJournalPath()), Date.now())?.acting; } catch { /* unavailable is not an active badge */ }
    const list = width ? layoutSpaceList(shown, selected, width, height - 1, deps.env.HOME, ceoSideUnavailable ? -1 : ceoPendingRed, [...emptyCoordinatorSpaces(lsAnswer, rows), ...remoteEmpty], selectedEmpty, agentsGrouped ? 'grouped' : 'status', actingSeat, listTop, groupFolds, activeOnly, spacesTop, deps.loopFacts?.facts()) : undefined;
    listMarks = { heads: list?.groupHeads ?? [], ...(list?.foldAll ? { foldAll: list.foldAll } : {}), ...(list?.activeBox ? { active: list.activeBox } : {}) };
    listScroll = list?.scroll;
    spacesScroll = list?.spacesScroll;
    tabScroll = tabs.prev || tabs.next ? { first: tabs.first ?? 0, count: tabs.count ?? 0, more: !!tabs.next } : undefined;
    emptyHits = list?.emptySpaces ?? [];
    mouseLayout = { cols, rows: height, sidebarWidth: width, sidebar: list?.spaces ?? [], ...(list?.newBox ? { sidebarNew: list.newBox } : {}), tabs: tabs.tabs, ...(tabs.plus ? { plus: tabs.plus } : {}),
      ...(list?.scroll ? { sidebarScroll: list.scroll } : {}), ...(list?.spacesScroll ? { spacesScroll: list.spacesScroll } : {}), ...(list?.agentsTop !== undefined ? { agentsTop: list.agentsTop } : {}), ...(tabs.prev ? { tabPrev: tabs.prev } : {}), ...(tabs.next ? { tabNext: tabs.next } : {}) };
    chrome = { cols, height, width, tabs, ...(overlay ? { overlay } : {}), sidebar: list ? list.lines : null };
    const layers = layerBoxes(cols, height);
    const screen = composeView({ cols, rows: height, sidebar: list ? list.lines : null, frame, status: statusText(), buttons: buttonsLayout(cols).text,
      ...(tabs.line !== undefined ? { tabRow: tabs.line } : {}), ...(overlay ? { overlay } : {}), ...(layers.length ? { layers } : {}), ...cursorProps(cols, height),
      // ELS-APP-RENDER-SINGLE-FRAME: the dialog is spliced into the same frame — one write, never a second overlay pass.
      ...(newTab.isOpen() ? { dialog: newTab.box(cols, height, width ? width + 1 : 0) } : movePicker ? { dialog: movePicker.picker.box(cols, height, width ? width + 1 : 0) } : {}) });
    deps.write(screen);
  };
  const finish = (code: number, message: string): void => {
    if (finished) return;
    finished = true;
    if (escapeTimer) clearTimeout(escapeTimer);
    escapePending = '';
    deps.clearInterval(timer);
    if (tileTimer !== undefined) { deps.clearInterval(tileTimer); tileTimer = undefined; }
    overlayWatch?.close(); overlayWatch = undefined;
    popupTerm.dispose();
    generation++;
    attached?.detach();
    resolveDone({ code, message });
  };

  /** One attach wiring for one selection generation. D1a(ELS-SERVER-RESTART-SURVIVE): a server-away end keeps the
   *  screen as it was and waits for the poll to re-attach — the view does not end while the els server restarts. */
  const wire = (mine: number): Attached => deps.attach(selected!, paneSize(), {
    onFocus: (pane, acknowledge) => {
      void refresh(true).then(listed => {
        const accepted = listed && !finished && mine === generation && rows.some(row => row.pane === pane && row.state !== 'exited');
        acknowledge(accepted);
        if (accepted) select(pane);
      }, () => acknowledge(false));
    },
    onFrame: (next: AttachFrame) => {
      if (mine !== generation) return;
      note = noteAfterFrame(note);
      awaitingServer = false;
      frame = next.screen;
      scroll = next.back;                // the server tells how far this frame is above the live bottom
      wheelPassthrough = next.wheelPassthrough === true;
      wheelRoute = next.wheelRoute ?? 'host';   // ELS-WHEEL-SCROLLBACK: the frame carries the pane's own wheel lane
      // ELS-OP-INPUT-FLICKER: a view that is not the pane's size owner never re-asserts — it letterboxes.
      if (next.sizeOwner === false) sizeReassert.reset();
      else if (Number.isInteger(next.cols) && Number.isInteger(next.rows)) sizeReassert.frame(next.pane, { cols: next.cols, rows: next.rows }, paneSize());
      render(true);
    },
    onError: (message) => { if (mine === generation) { note = message; render(); } },   // typing refused (view-only attach): said, not swallowed
    onEnd: (code, reason) => {
      if (mine !== generation) return;
      attached = undefined;
      // ELS-LAST-TAB-EXIT (OP #102044): like herdr — the last of this host's panes ending closes the view (code 0; the
      // server and every other client go on); otherwise the focus moves to the next live pane (the exited one is then
      // closed by the list's clean-up, as when the selection leaves it).
      if (reason === 'pane exited') {
        const live = (row: PaneRow): boolean => row.pane !== selected && row.state !== 'exited';
        const at = rows.findIndex((row) => row.pane === selected);
        const next = rows.slice(at + 1).find(live) ?? rows.slice(0, Math.max(at, 0)).reverse().find(live);
        if (!next) { finish(0, ''); return; }
        note = 'pane exited';
        select(next.pane);
        void refresh();
        return;
      }
      // D1a(ELS-SERVER-RESTART-SURVIVE): the server going away is not the end of the view — the screen stays, the
      // status line says so, and the next successful poll re-attaches (every attach starts with the pane's current
      // screen, so the pane comes back as it was).
      if (code !== 0 && isServerAway(reason)) { awaitingServer = true; note = RECONNECT_NOTE; render(); return; }
      // Any other end (a refusal at the door, an unknown pane, a malformed stream) is real: say why and do NOT re-attach.
      if (code !== 0) note = reason;
      void refresh();
    },
  });

  const flushEmptyFocus = (): void => {
    if (!emptyFocusPending || emptyFocusInFlight) return;
    emptyFocusInFlight = true;
    focusWrite = focusWrite.then(async () => {
      const ws = emptyFocusPending;
      if (!ws) return;
      const result = await deps.request({ op: 'focus-empty', ws });
      if (result.exitCode === 0 && emptyFocusPending === ws) emptyFocusPending = undefined;
      // A later pane selection must win over a delayed empty-space write.
      if (!finished && selected && !current()?.remote && attached) {
        generation++; attached.detach(); attached = wire(generation);
      }
    }).catch(() => {}).finally(() => { emptyFocusInFlight = false; });
  };
  const selectEmpty = (ws: string): void => {
    if (emptyCoordinatorSpaces(lsAnswer, rows).some(space => space.wsId === ws)) {
      emptyFocusPending = ws;
      flushEmptyFocus();
    }
    generation++; attached?.detach(); attached = undefined; selected = undefined; awaitingServer = false;
    selectedEmpty = ws; wrapped = false; frame = ''; scroll = 0; wheelPassthrough = false; wheelRoute = 'host'; readError = ''; note = '';
    render();
  };

  const select = (pane: string | undefined): void => {
    if (finished || (pane === selected && attached)) return;      // after the app ended nothing attaches or is remembered
    selectedEmpty = undefined;
    emptyFocusPending = undefined;
    wrapped = false;                                             // any move other than the wrap itself ends the wrap
    generation++;
    const mine = generation;
    sizeReassert.reset();
    attached?.detach();
    attached = undefined;
    selected = pane;
    listTop = undefined;
    spacesTop = undefined;
    tabFirst = undefined;
    frame = '';
    scroll = 0;
    wheelPassthrough = false;
    wheelRoute = 'host';
    readError = '';
    remember();
    if (pane && remoteRows.some((row) => row.pane === pane)) {
      pushRemoteSize();
      void showRemote(mine);                                    // read-only: a polled screen, no live attach
    } else if (pane) {
      attached = wire(mine);
    }
    render();
  };

  /** D1a(ELS-SERVER-RESTART-SURVIVE): the server answered the poll again — re-attach to the same pane without
   *  clearing the screen; the first frame of the new attach repaints the pane as it was (same child, same bytes). */
  const reattach = (): void => {
    if (finished || attached || !awaitingServer || !selected || current()?.remote) return;
    awaitingServer = false;
    generation++;
    attached = wire(generation);
  };

  /**
   * Paint the selected other-host pane: one federated read, shown as the centre screen. A stale answer — the selection moved, or
   * a newer read was started before this one came back — is dropped. A refusal AND a throw are shown the same way: a blank
   * screen and the reason in `readError`, a channel of its own so a poll never wipes a note the person is reading.
   */
  const showRemote = async (mine: number): Promise<void> => {
    const row = current();
    if (!deps.remote || !row?.remote) return;
    const request = ++readSeq;
    let answer: ElsResult;
    try { answer = await deps.remote.read(row.pane); }
    catch (error) { answer = { exitCode: 1, message: `els: ${error instanceof Error ? error.message : String(error)}` }; }
    if (finished || mine !== generation || request !== readSeq) return;
    if (answer.exitCode === 0) { frame = answer.message; readError = ''; } else { frame = ''; readError = answer.message; }
    render();
  };
  /** The other hosts' panes are gone (the list failed or threw): no stale rows, and a remote selection moves to a local pane. */
  const dropRemote = (): void => {
    const wasRemote = remoteRows.some(row => row.pane === selected);
    remoteRows = [];
    remoteEmpty = [];
    if (selectedEmpty && !emptyCoordinatorSpaces(lsAnswer, rows).some((space) => space.wsId === selectedEmpty)) { select(rows[0]?.pane); return; }
    readError = '';
    if (wasRemote && selected && !everyRow().some((row) => row.pane === selected)) select(rows.find((row) => row.state !== 'exited')?.pane ?? rows[0]?.pane);
    else render();
  };
  /** Re-read the other hosts' panes (own guard and cadence: a host that is down for 2 s must not slow the local list). */
  const refreshRemote = async (): Promise<void> => {
    if (!deps.remote || remoteBusy || finished) return;
    remoteBusy = true;
    try {
      let answer: ElsResult;
      try { answer = await deps.remote.list(); }
      catch (error) { answer = { exitCode: 1, message: `els: ${error instanceof Error ? error.message : String(error)}` }; }
      if (finished) return;
      if (answer.exitCode !== 0) { remoteStatus = '원격 목록 확인 불가'; dropRemote(); return; }
      const downHosts = new Set<string>();
      try {
        const parsed = JSON.parse(answer.message) as { hosts?: unknown };
        if (Array.isArray(parsed?.hosts)) for (const host of parsed.hosts as { name?: unknown; reach?: unknown }[]) {
          if (host && typeof host.name === 'string' && host.reach === 'down') downHosts.add(host.name);
        }
        remoteStatus = Array.isArray(parsed?.hosts) ? parsed.hosts
          .filter((host: unknown): host is { name: string; reach: string } => !!host && typeof host === 'object'
            && typeof (host as { name?: unknown }).name === 'string'
            && /^[a-zA-Z0-9._-]+$/.test((host as { name: string }).name)
            && (host as { reach?: unknown }).reach === 'down')
          .map((host: { name: string }) => `⇄${host.name} ${UNREACHABLE_MARK}`).join(' · ') : '';
      } catch { remoteStatus = '원격 목록 확인 불가'; }
      // ELS-REMOTE-MARKER: a host reported down keeps its last known panes in the list (dimmed «?»), so they do not
      // silently vanish; they are replaced as soon as the host answers again. A failed list as a whole still drops them.
      const wasRemote = remoteRows.some(row => row.pane === selected);
      const fresh = parseRemoteRows(answer.message);
      remoteEmpty = [...emptyRemoteCoordinators(answer.message, fresh), ...remoteEmpty
        .filter((space) => downHosts.has(space.remote) && !fresh.some((row) => row.wsId === space.wsId))
        .map((space) => ({ ...space, stale: true }))];
      remoteRows = [...fresh, ...remoteRows
        .filter((row) => row.remote !== undefined && downHosts.has(row.remote) && !fresh.some((next) => next.pane === row.pane))
        .map((row) => ({ ...row, stale: true }))];
      if (selectedEmpty && !remoteEmpty.some((space) => space.wsId === selectedEmpty)
        && !emptyCoordinatorSpaces(lsAnswer, rows).some((space) => space.wsId === selectedEmpty)) {
        const next = everyRow().find((row) => row.wsId === selectedEmpty)?.pane ?? rows[0]?.pane;
        select(next); return;
      }
      if (wasRemote && selected && !everyRow().some((row) => row.pane === selected)) { select(rows.find((row) => row.state !== 'exited')?.pane ?? rows[0]?.pane); return; }
      if (current()?.remote) await showRemote(generation); else render();
    } finally { remoteBusy = false; }
  };

  /** Re-read the list; keep the selection when its pane still exists, else the neighbour that took its place. */
  const refresh = async (afterCreate = false, initialPane?: string): Promise<boolean> => {
    let answer: ElsResult;
    try { answer = await deps.request({ op: 'ls' }); }
    catch (error) { if (afterCreate) return false; throw error; }
    if (finished) return false;
    if (answer.exitCode !== 0) {
      if (afterCreate) return false;
      // D1a(ELS-SERVER-RESTART-SURVIVE): a server lost after a good list is waited out — the screen stays and this
      // poll asks again; before the first good list the message goes out as it always did.
      if (everListed && isServerAway(answer.message)) { if (selected && !attached) awaitingServer = true; note = RECONNECT_NOTE; render(); return false; }
      finish(1, answer.message); return false;
    }
    everListed = true;
    if (selectedEmpty && selectedEmpty === emptyFocusPending) flushEmptyFocus();
    const before = rows;
    rows = parsePaneRows(answer.message);
    popupRows = rows.filter(isPopupRow);                         // ELS-POPUP-TERM: the reserved workspace stays out of every view
    rows = rows.filter((row) => !isPopupRow(row));
    lsAnswer = answer.message;
    staleClient = deps.ownBuild ? clientIsStale(deps.ownBuild, answer.message) : false;
    try {
      const side = (JSON.parse(answer.message) as { ceoSide?: { pendingRed?: unknown } }).ceoSide;
      ceoSideUnavailable = side !== undefined && (side as { error?: unknown }).error === 'unavailable';
      ceoPendingRed = typeof side?.pendingRed === 'number' && Number.isSafeInteger(side.pendingRed) && side.pendingRed > 0
        ? Math.min(side.pendingRed, 99) : 0;
    } catch { ceoPendingRed = 0; ceoSideUnavailable = false; }   // a listing without a CEO side is «no CEO inbox yet», not an alarm
    // ELS-FIRST-RUN-LIVE-PANE (OP #102204): an exited pane stays in the list, dimmed — it is never closed automatically.
    if (selected && (!everyRow().some((row) => row.pane === selected) || (awaitingServer && current()?.state === 'exited'))) {
      const old = before.find(row => row.pane === selected);
      const sameSpace = rows.filter(row => row.wsId === old?.wsId && row.state !== 'exited');
      const empty = emptyCoordinatorSpaces(lsAnswer, rows).find(space => space.wsId === old?.wsId);
      awaitingServer = false;
      if (empty) { selectEmpty(empty.wsId); return true; }
      const was = before.findIndex((row) => row.pane === selected);
      select((sameSpace.find(row => row.spaceCoordinator) ?? sameSpace[0] ?? rows[Math.min(Math.max(was, 0), rows.length - 1)])?.pane);
      return true;
    }
    if (selectedEmpty && ![...emptyCoordinatorSpaces(lsAnswer, rows), ...remoteEmpty].some((space) => space.wsId === selectedEmpty)) {
      const next = everyRow().find((row) => row.wsId === selectedEmpty && row.state !== 'exited');
      if (next) { select(next.pane); return true; }
      selectedEmpty = undefined;
    }
    if (!selected && !selectedEmpty && !initialPane) {
      let workspaceId: string | undefined;
      try { workspaceId = (JSON.parse(lsAnswer) as { lastFocus?: { workspaceId?: string } }).lastFocus?.workspaceId; } catch { /* legacy */ }
      const empty = emptyCoordinatorSpaces(lsAnswer, rows).find(space => space.wsId === workspaceId);
      if (empty) { selectEmpty(empty.wsId); return true; }
    }
    if (!selected && !selectedEmpty && rows.length > 0) {
      // First view (ELS-FIRST-RUN-LIVE-PANE): the live pane it was left on, else the first live one in this folder's space,
      // else any live one; nothing live (every pane exited) → a fresh $SHELL pane in this folder's space, attached.
      const live = rows.filter((row) => row.state !== 'exited');
      if (live.length === 0) {
        if (!automaticCreateAttempted) { automaticCreateAttempted = true; await create(undefined, undefined, true); }
        return true;
      }
      const folder = basename(deps.cwd) || 'els';
      let focus: { workspaceId?: string; tabId?: string; paneId?: string } | undefined;
      try { focus = (JSON.parse(lsAnswer) as { lastFocus?: typeof focus }).lastFocus; } catch { /* legacy listing */ }
      const restored = focus && live.find(row => row.wsId === focus!.workspaceId && row.tabId === focus!.tabId && row.pane === focus!.paneId);
      // A stale target stays in its original space, preferring that space's coordinator.
      const inSpace = focus && live.filter(row => row.wsId === focus!.workspaceId);
      const fallback = inSpace && (inSpace.find(row => row.spaceCoordinator) ?? inSpace[0]);
      select((live.find((row) => row.pane === initialPane) ?? restored ?? fallback
        ?? (!focus ? live.find((row) => row.pane === remembered.lastPane) : undefined)
        ?? live.find((row) => row.workspace === folder) ?? live[0]!).pane);
      return true;
    }
    if (awaitingServer && !attached && selected && !current()?.remote) reattach();   // D1a(ELS-SERVER-RESTART-SURVIVE): the server is back
    render();
    return true;
  };

  // ELS-ONE-SPACE: n/p and 1-9 move between the tabs of the selected space (herdr's tabs); w walks the same tabs further —
  // it wraps inside the space (never into the next one), and the wrap done, the next `w` steps to the next space.
  // decision 11-18 test 원문: 두 번째 w는 «wraps inside w1, never into w2», 세 번째 w가 p3(w2)에, 1탭 스페이스는 w 한 번에 다음 스페이스로.
  const nextTab = (): void => {
    const tabs = spaceTabs();
    if (tabs.length === 0) return;
    if (wrapped || tabs.length === 1) { wrapped = false; nextWorkspace(); return; }   // one tab: nothing to walk — step at once
    const at = Math.max(0, tabs.findIndex((row) => row.pane === selected));
    if (at < tabs.length - 1) select(tabs[at + 1]!.pane);
    else { select(tabs[0]!.pane); wrapped = true; }                                    // wrap to the first tab of this space
  };
  const spaceTabs = (): PaneRow[] => {
    const all = everyRow();
    const ws = current()?.wsId ?? all[0]?.wsId;
    return all.filter((row) => row.wsId === ws);
  };
  const move = (step: number): void => {
    const tabs = spaceTabs();
    if (tabs.length === 0) return;
    const at = Math.max(0, tabs.findIndex((row) => row.pane === selected));
    select(tabs[(at + step + tabs.length) % tabs.length]!.pane);
  };
  const nextWorkspace = (): void => {
    const all = everyRow();
    const targets = dropdownTargets(withCommands(all, lsAnswer), emptySpaces());
    const order: { ws: string; target: DropdownTarget }[] = [];
    for (const target of targets) {
      const ws = 'ws' in target ? target.ws : all.find((row) => row.pane === target.pane)?.wsId;
      if (ws && !order.some((entry) => entry.ws === ws)) order.push({ ws, target });
    }
    if (!order.length) return;
    const at = order.findIndex((entry) => entry.ws === (selectedEmpty ?? current()?.wsId));
    const next = order[(at + 1) % order.length]!.target;
    if ('ws' in next) selectEmpty(next.ws); else select(next.pane);
  };

  const create = async (workspace: string | undefined, what: { command: readonly string[]; title: string } = { command: [], title: '' }, automatic = false): Promise<boolean | 'unknown'> => {
    // A manual request may already have reached the server even while its result is pending or unknown.
    // Never start a separate automatic creation after it, including from a concurrent poll.
    if (!automatic) automaticCreateAttempted = true;
    // The selected local pane belongs only to its own workspace; never carry a
    // cwd across a workspace switch (or from a remote pane). Read the owner at
    // creation time rather than using the potentially stale displayed list.
    const source = current();
    const sourceGeneration = generation;
    let creationCwd = deps.cwd;
    if (workspace) {
      try {
        const latest = await deps.request({ op: 'ls' });
        if (finished) return false;
        if (sourceGeneration !== generation) { note = 'Selection changed; retry creation'; render(); return false; }
        if (latest.exitCode !== 0) { note = latest.message; render(); return false; }
        const listed = JSON.parse(latest.message) as { panes?: unknown; workspaces?: { id?: string; name?: string; rootCwd?: string }[] };
        if (!Array.isArray(listed.panes)) throw new Error('missing panes');
        const target = listed.workspaces?.find((ws) => ws.id === workspace || ws.name === workspace);
        const sameSource = source && !source.remote && (source.wsId === workspace || source.workspace === workspace);
        const fresh = sameSource ? parsePaneRows(latest.message).find((row) => row.pane === source.pane && row.wsId === source.wsId && row.state !== 'exited') : undefined;
        if (target || sameSource || selectedEmpty === workspace) creationCwd = fresh?.cwd || target?.rootCwd || deps.env.HOME || deps.cwd;
      } catch { note = 'Cannot read current pane cwd'; render(); return false; }
    }
    const input = withNewDefaults({ command: [...what.command], ...(workspace ? { ws: workspace } : {}), ...(what.title ? { title: what.title } : {}) }, deps.env, creationCwd);
    let made: ElsResult;
    try { made = await deps.request({ op: 'new', ...input }); }
    catch { note = 'Creation outcome unknown; inspect tabs before retry'; render(); return 'unknown'; }
    if (finished) return false;                                   // ctrl+b q while the server was answering: done means done
    if (made.transport?.outcome === 'unknown') { note = 'Creation outcome unknown; inspect tabs before retry'; render(); return 'unknown'; }
    if (made.exitCode !== 0) {
      if (automatic && made.transport?.outcome === 'not-sent') automaticCreateAttempted = false;
      note = made.message; render(); return false;
    }
    let pane: string;
    try { const parsed = JSON.parse(made.message) as { pane?: unknown }; if (typeof parsed.pane !== 'string' || !parsed.pane) throw new Error('missing pane'); pane = parsed.pane; }
    catch { note = 'Creation outcome unknown; inspect tabs before retry'; render(); return 'unknown'; }
    const listed = await refresh(true);
    if (finished) return false;
    if (!listed || !rows.some((row) => row.pane === pane)) {
      note = 'Creation confirmed but tab not listed; inspect tabs before retry'; render(); return 'unknown';
    }
    select(pane);
    return true;
  };
  // ELS-VOICE-CONTROL-POPUP (OP #101876): steps run as the same els requests the keys use (new · close · close-workspace ·
  // reorder) — the control door gets structure ops in its own cell (ELS-DOOR-STRUCT-OPS). Names are what the person said.
  const findTab = (name: string): PaneRow | undefined => spaceTabs().find((row) => row.pane === name || tabName(row.title) === name);
  const findSpace = (name: string): PaneRow | undefined => rows.find((row) => row.workspace === name || row.wsId === name);
  const voiceDoor: VoiceDoor = {
    async run(step) {
      const a = step.args;
      const answer = async (request: ElsRequest): Promise<{ ok: boolean; message: string }> => {
        const done = await deps.request(request);
        return { ok: done.exitCode === 0, message: done.message };
      };
      switch (step.op) {
        case 'tab.new': case 'pane.new': { const ok = await create(a.workspace ?? (current() && !current()!.remote ? current()!.workspace : undefined), { command: [], title: a.title ?? '' }); return { ok: ok === true, message: ok === true ? '' : note }; }
        case 'workspace.create': { const ok = await create(a.name ?? freshWorkspaceName()); return { ok: ok === true, message: ok === true ? '' : note }; }
        case 'tab.close': case 'pane.close': { const row = findTab(a.tab ?? a.pane ?? ''); return row && !row.remote ? answer({ op: 'close', pane: row.pane, confirmed: true }) : { ok: false, message: `${a.tab ?? a.pane} 탭 없음` }; }
        case 'workspace.close': { const row = findSpace(a.workspace ?? ''); return row ? answer({ op: 'close-workspace', ws: row.wsId, confirmed: true }) : { ok: false, message: `${a.workspace} 공간 없음` }; }
        case 'workspace.move': { const row = findSpace(a.workspace ?? ''); const before = a.before ? findSpace(a.before)?.wsId : undefined; return row ? answer({ op: 'reorder', kind: 'workspace', id: row.wsId, ...(before ? { before } : {}) }) : { ok: false, message: `${a.workspace} 공간 없음` }; }
        case 'tab.move': {
          const row = a.tab ? findTab(a.tab) : current();
          const target = [...rows.map(r => ({ wsId: r.wsId, name: r.workspace })), ...emptyCoordinatorSpaces(lsAnswer, rows)]
            .find(ws => ws.wsId === a.workspace || ws.name === a.workspace);
          if (!row || row.remote || !target) return { ok: false, message: '탭 또는 공간 없음' };
          const listed = JSON.parse(lsAnswer) as { panes?: { pane: string; tab: string }[] };
          const tab = listed.panes?.find(p => p.pane === row.pane)?.tab;
          return tab ? answer({ op: 'move-tab', tab, ws: target.wsId }) : { ok: false, message: '탭 없음' };
        }
        case 'pane.focus': { const row = findTab(a.pane ?? a.tab ?? ''); if (!row) return { ok: false, message: `${a.pane ?? a.tab} 없음` }; select(row.pane); return { ok: true, message: '' }; }
        default: return { ok: false, message: '아직 없는 동작 (ELS-DOOR-STRUCT-OPS)' };
      }
    },
  };
  const voice = createVoicePopup({
    plan: (text) => planVoice(text, { ...(deps.voiceModel ? { llm: deps.voiceModel } : {}), context: { workspaces: [...new Set(rows.map((row) => row.workspace))], tabs: spaceTabs().map((row) => tabName(row.title)), ...(current() ? { current: current()!.workspace } : {}) } }),
    door: voiceDoor,
    changed: () => { if (!voice.isOpen() && voice.lastMessage()) { note = voice.lastMessage(); void refresh(); } else render(); },
  });

  // ELS-NEW-TAB-NAME-WIDGET: the typed name goes to the `new` request's title ONLY (cleaned and capped in the prompt); never to the pane.
  let renameTarget: string | undefined;
  let unresolvedTabTarget: { workspace: string | undefined } | undefined;
  const newTab = createNewTabPrompt({
    title: () => renameTarget ? 'Rename tab' : '새 탭 이름',
    save: async (name) => {
      if (renameTarget) {
        if (!name.trim()) { note = 'Enter a tab name'; return false; }
        try {
          const answer = await deps.request({ op: 'rename', kind: 'tab', id: renameTarget, name });
          if (answer.exitCode !== 0) { note = answer.message; return false; }
          renameTarget = undefined; await refresh(); return true;
        } catch { note = 'Rename failed'; return false; }
      }
      const target = unresolvedTabTarget ?? { workspace: localCreationTarget() };
      const result = await create(target.workspace, { command: [], title: name });
      if (result === 'unknown') unresolvedTabTarget = target;
      else if (result === true) unresolvedTabTarget = undefined;
      return result;
    },
    changed: () => render(),
  });
  const freshWorkspaceName = (): string => {
    const base = basename(deps.cwd) || 'els';
    const taken = new Set([...rows.map((row) => row.workspace), ...emptyCoordinatorSpaces(lsAnswer, rows).map((space) => space.name)]);
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  };

  /** The ctrl+b keys that open things over the view (they work on an empty workspace too). true = handled. */
  const viewAction = (action: KeyAction): boolean => {
    switch (action) {
      case 'help': toggleShortcuts(); return true;               // ELS-SHORTCUTS-POPUP: every key at a glance
      case 'voice': voice.open(); return true;                   // ELS-VOICE-CONTROL-POPUP: say it to els
      case 'sidechat': { const over = current(); void deps.request({ op: 'overlay', action: 'open', kind: 'sidechat', props: over && !over.remote ? { pane: over.pane } : {} }).catch(() => undefined); return true; }   // ELS-SIDECHAT · A1: the pane under it, for ctrl+o context
      case 'obsidian': toggleObsidian(); return true;            // ELS-OBSIDIAN-KEY: open/close this workspace's Obsidian popup
      case 'cycle-focus': cycleFocus(); return true;             // ELS-SIDECHAT-EDGE A2: focus ring over the layers and the pane
      case 'memo': void deps.request({ op: 'overlay', action: 'open', kind: 'memo', props: {} }).catch(() => undefined); return true;   // ELS-MEMO: the memo pad
      case 'files': openFiles(); return true;                    // ELS-FILES: the file browser popup
      case 'popup-term': toggleTerm(); return true;              // ELS-POPUP-TERM: show / hide the popup terminal
      case 'escape': return true;                                // ctrl+b Esc: only the popup terminal reads it (termAction)
      case 'move-layer': startLayerMove(); return true;          // ELS-POPUP-MOVE/RESIZE: move · resize the focused layer
      case 'quit': quitSpace(); return true;                     // ELS-EXIT-BG-BUTTONS: ✕ Quit by key (ctrl+b q = ⏏ Background)
      default: return false;
    }
  };

  const act = (action: KeyAction, n?: number): void => {
    if (viewAction(action)) return;
    note = '';
    if (dropdown && action !== 'toggle-sidebar') dropdown = false;
    const row = current();
    if (selectedEmpty && action === 'next-workspace') { nextWorkspace(); return; }
    if (selectedEmpty && ['next', 'previous'].includes(action)) { select(everyRow()[0]?.pane); return; }
    if (selectedEmpty && !['detach', 'toggle-sidebar', 'new', 'new-chat', 'new-workspace', 'close-workspace', 'toggle-agents-order', 'expand-all', 'collapse-all', 'toggle-active', 'tile'].includes(action)) { note = '빈 작업공간에는 pane이 없습니다'; render(); return; }
    switch (action) {
      case 'detach': finish(0, ''); return;
      case 'tile': enterTile(); return;
      case 'next': move(1); return;
      case 'previous': move(-1); return;
      case 'next-workspace': nextTab(); return;
      case 'goto': { const tabs = spaceTabs(); if (n !== undefined && tabs[n - 1]) select(tabs[n - 1]!.pane); return; }
      case 'toggle-sidebar': if (narrow()) { if (dropdown) { dropdown = false; render(); } else openDropdown(); return; } sidebarOpen = !sidebarOpen; remember(); attached?.resize(paneSize().cols, paneSize().rows); pushRemoteSize(); render(); return;
      case 'toggle-agents-order': agentsGrouped = !agentsGrouped; render(); return;   // ELS-AGENTS-GROUPED-TOGGLE-FU: the panel flips, nothing else moves
      case 'new-chat': void create(localCreationTarget(), { command: deps.chatCommand, title: 'elanous' }); return;
      case 'rename-tab': if (row && !row.remote && row.tabId) { renameTarget = row.tabId; newTab.openPrompt(); } else { note = 'Select a local tab to rename'; render(); } return;
      case 'new': renameTarget = undefined; if (!row?.remote && !selectedEmptySpace()?.remote) newTab.openPrompt(); else void create(undefined); return;   // ELS-NEW-TAB-NAME-WIDGET: the name prompt first; Enter on an empty name = the default tab
      case 'new-workspace': void create(freshWorkspaceName()); return;
      case 'move-tab': {
        if (!row || row.remote) { note = 'Only local tabs can be moved'; render(); return; }
        let tab: string | undefined;
        try { tab = (JSON.parse(lsAnswer) as { panes?: { pane: string; tab: string }[] }).panes?.find(p => p.pane === row.pane)?.tab; } catch { /* stale listing */ }
        if (!tab) { note = 'Cannot identify selected tab'; render(); return; }
        const spaces = [...rows.map(r => ({ id: r.wsId, name: r.workspace })), ...emptyCoordinatorSpaces(lsAnswer, rows).map(s => ({ id: s.wsId, name: s.name }))];
        const destinations = [...new Map(spaces.filter(s => s.id !== row.wsId).map(s => [s.id, s])).values()];
        if (!destinations.length) { note = 'No other local spaces'; render(); return; }
        movePicker = { picker: createMoveTabPicker(destinations), tab }; render(); return;
      }
      case 'close': if (row?.remote) { note = `⇄${row.remote} pane 은 여기서 닫을 수 없음 (그 호스트에서)`; render(); return; } if (row) { confirm = { what: 'close', target: row.pane, prompt: `pane «${row.title}» 닫기?` }; render(); } return;
      case 'close-workspace': {
        const empty = selectedEmptySpace();
        const remote = empty?.remote ?? row?.remote;
        if (remote) { note = `⇄${remote} 작업공간은 여기서 닫을 수 없음 (그 호스트에서)`; render(); return; }
        const target = empty?.wsId ?? row?.wsId;
        if (target) { confirm = { what: 'close-workspace', target, prompt: `작업공간 «${empty?.name ?? row?.workspace}» 와 그 안의 pane 모두 닫기?` }; render(); }
        return;
      }
      case 'scroll-up': scrollPane(Math.max(1, deps.size().rows - 4)); return;
      case 'scroll-down': scrollPane(-Math.max(1, deps.size().rows - 4)); return;
      case 'list-page-up': scrollList((listScroll?.start ?? 0) - Math.max(1, (listScroll?.room ?? 1) - 1)); return;
      case 'list-page-down': scrollList((listScroll?.start ?? 0) + Math.max(1, (listScroll?.room ?? 1) - 1)); return;
      case 'list-home': scrollList(0); return;
      case 'list-end': scrollList(listScroll ? listScroll.total - listScroll.room : 0); return;
      case 'expand-all': foldEvery(false); return;
      case 'collapse-all': foldEvery(true); return;
      case 'toggle-active': toggleActive(); return;
      case 'toggle-group': { const ws = row?.wsId; if (ws) { const head = listMarks.heads.find((one) => one.ws === ws); foldGroup(ws, !(head?.folded ?? groupFolds.get(ws) ?? false)); } return; }
      case 'tabs-left': scrollTabs(-1); return;
      case 'tabs-right': scrollTabs(1); return;
    }
  };

  /** ELS-EXIT-BG-BUTTONS ✕ 종료: close this space's panes and leave the view; something running in it → ask first (y). */
  const quitSpace = (): void => {
    const row = current();
    const empty = selectedEmptySpace();
    const remote = empty?.remote ?? row?.remote;
    if (remote) { note = `⇄${remote} space cannot be closed here — use ⏏ Background to leave`; render(); return; }
    const target = empty?.wsId ?? row?.wsId;
    if (!target) { finish(0, ''); return; }
    const running = rows.filter((one) => one.wsId === target && (one.state === 'working' || one.state === 'blocked')).length;
    if (running > 0) { confirm = { what: 'quit', target, prompt: `⚠ ${running} running — quit?` }; render(); return; }
    void deps.request({ op: 'close-workspace', ws: target, confirmed: true }).then(() => finish(0, ''));
  };

  const settle = async (pending: Confirm): Promise<void> => {
    if (pending.what === 'quit') { await deps.request({ op: 'close-workspace', ws: pending.target, confirmed: true }); finish(0, ''); return; }
    const answer = await deps.request(pending.what === 'close' ? { op: 'close', pane: pending.target, confirmed: true } : { op: 'close-workspace', ws: pending.target, confirmed: true });
    if (finished) return;
    if (answer.exitCode !== 0) note = answer.message;
    await refresh();
  };

  let wasSavingAtInput = false;
  const routeInput = (text: string): void => {
      if (finished) return;
      if (wasSavingAtInput && !newTab.isSaving()) router.resetPrefix();
      router.feed(text, () => newTab.isOpen() && !newTab.isSaving(), (event) => {
        if (finished) return;
        if (event.kind === 'paste-incomplete') { note = 'Paste incomplete; waiting for end or reconnect ELS'; render(); return; }
        if (event.kind === 'paste-discarded') { note = 'Paste discarded; please retry'; render(); return; }
        if (movePicker) {
          if (event.kind === 'input') {
            const pending = movePicker;
            const result = pending.picker.feed(event.bytes);
            if (result.kind === 'cancel') movePicker = undefined;
            if (result.kind === 'select') {
              const tab = pending.tab; movePicker = undefined;
              void deps.request({ op: 'move-tab', tab, ws: result.id }).then(async answer => {
                note = answer.exitCode === 0 ? 'Tab moved' : answer.message.includes('OP authority required') ? 'Cannot move tab: OP coordinator authority required' : answer.message;
                await refresh();
              }, () => { note = 'Move failed; check the tab before retrying'; render(); });
            }
            render();
          }
          return;
        }
        if (voice.isOpen()) { if (event.kind === 'input') void voice.feed(event.bytes); return; }
        if (newTab.isOpen()) {                                     // keys (and clicks) belong to the prompt: nothing reaches the pane
          if (newTab.isSaving() && event.kind === 'action' && event.action === 'detach') { finish(0, ''); return; }
          if (event.kind === 'input') newTab.feed(event.bytes);
          else if (event.kind === 'mouse') { if (event.report.release) pressConsumed = false; else pressConsumed = (event.report.button & 0x40) === 0; }
          return;
        }
        // ELS-QUIT-CLICK (대표 11-26): the release of the ✕ click that raised this confirm (or any mouse report) must not count
        // as «any other key» — it cancelled the prompt in the same instant, so clicking ✕ Quit with something running did nothing.
        if (confirm && event.kind === 'mouse') { if (event.report.release) pressConsumed = false; else pressConsumed = (event.report.button & 0x40) === 0; return; }
        if (confirm) {
          const pending = confirm;
          confirm = undefined;
          if (event.kind === 'input' && event.bytes[0] === 'y') void settle(pending);
          else { note = '취소'; render(); }
          return;
        }
        if (dropdown && event.kind === 'input') { dropdownKey(event.bytes); return; }
        if (layerMoving && event.kind === 'input') { layerMoveKeys(event.bytes); return; }   // ELS-POPUP-MOVE: ctrl+b r mode
        let input = event;                                              // ELS-ZAXIS S2: the focus stack's top layer first
        if (event.kind === 'input') {
          const rest = overlayKey(event.bytes);
          if (rest !== undefined) { if (!rest) return; input = { ...event, bytes: rest }; }
        }
        if (event.kind === 'mouse') handleMouse(event.report);
        else if (event.kind === 'input') {
          if (current()?.remote) { note = `⇄${current()!.remote} pane 은 읽기 전용 — 입력은 els do ${current()!.pane} <글>`; render(); } else attached?.input(input.kind === 'input' ? input.bytes : event.bytes);
        }
        else if (event.kind === 'action') { if (!termAction(event.action)) act(event.action, event.n); }
        else { note = `ctrl+b ${event.key}: no such key`; render(); }   // every key is a row of key-bindings.ts (the hint after it says ? shortcuts)
      }, !newTab.isOpen() && !movePicker && !dropdown && !confirm && !voice.isOpen() && !overlayFocused());
      wasSavingAtInput = newTab.isSaving();
  };

  // Terminal reads can split ESC from the rest of a key or SGR mouse report.
  // Delay a bare Escape briefly only while the modal owns input; completed
  // sequences go through the ordinary router, including mouse ownership.
  const frameModalInput = (text: string): void => {
    let remaining = text;
    if (!newTab.isOpen() && !movePicker && (escapePending || discardEscapeSuffix)) {
      if (escapeTimer) clearTimeout(escapeTimer);
      escapeTimer = undefined;
      escapePending = '';
      discardEscapeSuffix = false;
    }
    while (remaining) {
      if (discardEscapeSuffix) {
        // A fresh Escape lets the user abandon an incomplete sequence.
        if (remaining[0] === '\u001b') { discardEscapeSuffix = false; continue; }
        const end = remaining.search(/[@-~]/);
        if (end < 0) return;
        remaining = remaining.slice(end + 1);
        discardEscapeSuffix = false;
        continue;
      }
      if (!escapePending) {
        const at = remaining.indexOf('\u001b');
        if (at < 0) { routeInput(remaining); return; }
        if (at > 0) { routeInput(remaining.slice(0, at)); remaining = remaining.slice(at); }
        if (!newTab.isOpen() && !movePicker) { routeInput(remaining); return; }
        escapePending = '\u001b';
        remaining = remaining.slice(1);
      }
      if (escapeTimer) { clearTimeout(escapeTimer); escapeTimer = undefined; }
      if (escapePending === '\u001b' && remaining && remaining[0] !== '[' && remaining[0] !== 'O') {
        escapePending = ''; routeInput('\u001b');
        // The entire terminal read belonged to the modal at cancellation.
        if (!newTab.isOpen() && !movePicker) return;
        remaining = remaining.slice(1);
        continue;
      }
      while (remaining && escapePending.length < 128) {
        const char = remaining[0]!; remaining = remaining.slice(1); escapePending += char;
        if (escapePending.length >= 3 && /[@-~]/.test(char)) {
          const sequence = escapePending; escapePending = ''; routeInput(sequence); break;
        }
      }
      if (escapePending.length >= 128) { escapePending = ''; discardEscapeSuffix = true; }
      if (escapePending) {
        const captured = escapePending;
        escapeTimer = setTimeout(() => {
          escapeTimer = undefined;
          if (escapePending !== captured) return;
          escapePending = '';
          if (captured === '\u001b' && (newTab.isOpen() || movePicker) && !finished) routeInput(captured);
          else if (captured !== '\u001b' && (newTab.isOpen() || movePicker) && !finished) discardEscapeSuffix = true;
        // Legacy terminals cannot distinguish a lone Esc from an arbitrarily delayed sequence.
        // Give ordinary transport/scheduling jitter 40ms; longer gaps can still be misclassified.
        }, captured === '\u001b' ? 40 : 250);
        return;
      }
    }
  };

  return {
    done,
    async start(pane) {
      try {
        const myWorkspaces = (): string[] => [...new Set(rows.flatMap((row) => [row.workspace, row.wsId]))];
        let stageBaseline = false;
        timer = deps.setInterval(() => {
          void refreshRemote();
          if (deps.stageWatch && !finished && stageBaseline) {
            let run: ReturnType<NonNullable<AttachAppDeps['stageWatch']>>;
            try { run = deps.stageWatch(myWorkspaces()); } catch { run = undefined; }
            if (run && run.key !== stageWatchKey && rows.some((row) => row.workspace === run!.ws || row.wsId === run!.ws)) {
              stageWatchKey = run.key;
              stageCfg = { readFeed: run.readFeed };
              stageFeed = undefined; stageSpot = undefined; tileFirstSeen.clear();
              tileWs = run.ws; tileLevel = 'space'; tilePage = 0; tileFocus = 0;
              if (tileMode) { tileScreens.clear(); renderTile(); } else enterTile();
            }
          }
          refresh().then(async (listed) => {
            if (listed && !finished && !selected && !selectedEmpty && rows.length === 0 && !automaticCreateAttempted) {
              automaticCreateAttempted = true;
              await create(undefined, undefined, true);
            }
          }).catch((error: unknown) => finish(1, `els: ${error instanceof Error ? error.message : String(error)}`));
        }, deps.pollMs);
        // ELS-ZAXIS S2: the overlay stack arrives by push; a stack is applied only when its rev differs (replays are no-ops).
        // The last applied SERVER rev is kept apart from the local copy: optimistic local edits (Esc, key updates) bump the
        // local rev too, and must never make a newer server push look like a replay.
        overlayWatch = deps.overlays?.watch((stack) => { if (finished || stack.rev === overlayServerRev) return; overlayServerRev = stack.rev; if (stack.focus.at(-1) !== overlay.focus.at(-1)) baseFocus = false; overlay = stack; render(); });   // A2: a newly focused layer takes the keys back
        await refresh(false, pane);
        // A run already active when this window opened is not «new»: remember it once the workspaces are listed.
        if (deps.stageWatch) { try { stageWatchKey = deps.stageWatch(myWorkspaces())?.key; } catch { /* no runs dir */ } }
        stageBaseline = true;
        void refreshRemote();                                      // the other hosts join the list when they answer
        if (finished) return;
        if (pane) select(pane);
        if (deps.tile) { enterTile(); return; }
        if (pane) { /* attached above */ }
        else if (rows.length === 0 && !selectedEmpty && !automaticCreateAttempted) {
          automaticCreateAttempted = true;
          await create(undefined, undefined, true);             // an empty server opens with one shell, like herdr's first workspace
        }
      } catch (error) { finish(1, `els: ${error instanceof Error ? error.message : String(error)}`); }
    },
    key(text) {
      if (finished) return;
      if (tileMode) { tileKey(text); return; }
      frameModalInput(text);
    },
    resized() { const size = paneSize(); attached?.resize(size.cols, size.rows); pushRemoteSize(); render(); },
  };
}
