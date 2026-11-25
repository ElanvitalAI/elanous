// els app view (ELS-ATTACH-VIEW stage 3): the herdr-shaped screen. Left: workspaces and their panes with status marks;
// middle: the selected pane live (colours, cursor); bottom: one status line. The terminal, the socket and the clock come in
// as `deps`, so the same logic runs under a real terminal and under tests. The app is a client: closing it (ctrl+b q)
// leaves the server and every pane as they were.

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
import { composeView, emptyCoordinatorSpaces, emptyRemoteCoordinators, FIRST_RUN_HINT, NARROW_BELOW_COLS, parsePaneRows, parseRemoteRows, SIDEBAR_HELP, sidebarWidthFor, UNREACHABLE_MARK, type PaneRow } from './attach-view.js';
import { buildTabDropdown, layoutSpaceList, isActiveSeat, buildTabRow, dropdownTargets, withCommands, type DropdownTarget } from './space-tabs-view.js';
import { interpretMouse, wheelBytes, type MouseLayout, type MouseReport } from './attach-mouse.js';
import type { WheelRoute } from '../pty-shell/registry.js';
import { withNewDefaults } from './cli-args.js';
import type { ElsResult } from './core.js';
import type { ElsRequest } from './server.js';

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
  readonly remote?: { readonly list: () => Promise<ElsResult>; readonly read: (address: string) => Promise<ElsResult>;
    /** REMOTE-PANE-SIZE: set the remote pane's PTY to this viewer's pane area (the remote SIGWINCH). */
    readonly resize?: (address: string, cols: number, rows: number) => Promise<ElsResult> };
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
  const remember = (): void => {
    if (selected && !remoteRows.some((row) => row.pane === selected)) lastLocal = selected;
    try { deps.memory.save({ sidebar: sidebarOpen, ...(lastLocal ? { lastPane: lastLocal } : {}), ...(groupFolds.size > 0 ? { groupFolds: Object.fromEntries(groupFolds) } : {}), ...(activeOnly ? { activeOnly } : {}) }); } catch { /* the view works without its memory */ }
  };
  const everyRow = (): PaneRow[] => [...rows, ...remoteRows];
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
  const handleMouse = (report: MouseReport): void => {
    if (report.release) {
      const swallow = pressConsumed;
      pressConsumed = false;
      if (!swallow && attached) attached.input(report.bytes);
      return;
    }
    const wheel = (report.button & 0x40) !== 0;
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
  const render = (frameOnly = false): void => {
    if (finished) return;
    const { cols, rows: height } = deps.size();
    if (frameOnly && chrome && chrome.cols === cols && chrome.height === height && !newTab.isOpen() && !movePicker) {
      const kept = chrome;
      deps.write(composeView({ cols, rows: height, sidebar: kept.sidebar, frame, status: statusText(), buttons: buttonsLayout(cols).text,
        ...(kept.tabs.line !== undefined ? { tabRow: kept.tabs.line } : {}), ...(kept.overlay ? { overlay: kept.overlay } : {}) }));
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
    const list = width ? layoutSpaceList(shown, selected, width, height - 1, deps.env.HOME, ceoSideUnavailable ? -1 : ceoPendingRed, [...emptyCoordinatorSpaces(lsAnswer, rows), ...remoteEmpty], selectedEmpty, agentsGrouped ? 'grouped' : 'status', actingSeat, listTop, groupFolds, activeOnly, spacesTop) : undefined;
    listMarks = { heads: list?.groupHeads ?? [], ...(list?.foldAll ? { foldAll: list.foldAll } : {}), ...(list?.activeBox ? { active: list.activeBox } : {}) };
    listScroll = list?.scroll;
    spacesScroll = list?.spacesScroll;
    tabScroll = tabs.prev || tabs.next ? { first: tabs.first ?? 0, count: tabs.count ?? 0, more: !!tabs.next } : undefined;
    emptyHits = list?.emptySpaces ?? [];
    mouseLayout = { cols, rows: height, sidebarWidth: width, sidebar: list?.spaces ?? [], ...(list?.newBox ? { sidebarNew: list.newBox } : {}), tabs: tabs.tabs, ...(tabs.plus ? { plus: tabs.plus } : {}),
      ...(list?.scroll ? { sidebarScroll: list.scroll } : {}), ...(list?.spacesScroll ? { spacesScroll: list.spacesScroll } : {}), ...(list?.agentsTop !== undefined ? { agentsTop: list.agentsTop } : {}), ...(tabs.prev ? { tabPrev: tabs.prev } : {}), ...(tabs.next ? { tabNext: tabs.next } : {}) };
    chrome = { cols, height, width, tabs, ...(overlay ? { overlay } : {}), sidebar: list ? list.lines : null };
    const screen = composeView({ cols, rows: height, sidebar: list ? list.lines : null, frame, status: statusText(), buttons: buttonsLayout(cols).text,
      ...(tabs.line !== undefined ? { tabRow: tabs.line } : {}), ...(overlay ? { overlay } : {}),
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

  const act = (action: KeyAction, n?: number): void => {
    note = '';
    if (dropdown && action !== 'toggle-sidebar') dropdown = false;
    const row = current();
    if (selectedEmpty && action === 'next-workspace') { nextWorkspace(); return; }
    if (selectedEmpty && ['next', 'previous'].includes(action)) { select(everyRow()[0]?.pane); return; }
    if (selectedEmpty && !['detach', 'toggle-sidebar', 'help', 'new', 'new-chat', 'new-workspace', 'close-workspace', 'toggle-agents-order', 'expand-all', 'collapse-all', 'toggle-active'].includes(action)) { note = '빈 작업공간에는 pane이 없습니다'; render(); return; }
    switch (action) {
      case 'detach': finish(0, ''); return;
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
      case 'help': note = SIDEBAR_HELP; render(); return;
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
        if (confirm) {
          const pending = confirm;
          confirm = undefined;
          if (event.kind === 'input' && event.bytes[0] === 'y') void settle(pending);
          else { note = '취소'; render(); }
          return;
        }
        if (dropdown && event.kind === 'input') { dropdownKey(event.bytes); return; }
        if (event.kind === 'mouse') handleMouse(event.report);
        else if (event.kind === 'input') {
          if (current()?.remote) { note = `⇄${current()!.remote} pane 은 읽기 전용 — 입력은 els do ${current()!.pane} <글>`; render(); } else attached?.input(event.bytes);
        }
        else if (event.kind === 'action') act(event.action, event.n);
        else if (event.key === ':') voice.open();                  // ELS-VOICE-CONTROL-POPUP: say it to els
        else if (event.key === 'Q') quitSpace();                  // ELS-EXIT-BG-BUTTONS: ✕ 종료 by key (ctrl+b q = ⏏ 백그라운드)
        else { note = `ctrl+b ${event.key} 는 아직 없음`; render(); }
      }, !newTab.isOpen() && !movePicker && !dropdown && !confirm && !voice.isOpen());
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
        timer = deps.setInterval(() => {
          void refreshRemote();
          refresh().then(async (listed) => {
            if (listed && !finished && !selected && !selectedEmpty && rows.length === 0 && !automaticCreateAttempted) {
              automaticCreateAttempted = true;
              await create(undefined, undefined, true);
            }
          }).catch((error: unknown) => finish(1, `els: ${error instanceof Error ? error.message : String(error)}`));
        }, deps.pollMs);
        await refresh(false, pane);
        void refreshRemote();                                      // the other hosts join the list when they answer
        if (finished) return;
        if (pane) select(pane);
        else if (rows.length === 0 && !selectedEmpty && !automaticCreateAttempted) {
          automaticCreateAttempted = true;
          await create(undefined, undefined, true);             // an empty server opens with one shell, like herdr's first workspace
        }
      } catch (error) { finish(1, `els: ${error instanceof Error ? error.message : String(error)}`); }
    },
    key(text) {
      if (finished) return;
      frameModalInput(text);
    },
    resized() { const size = paneSize(); attached?.resize(size.cols, size.rows); pushRemoteSize(); render(); },
  };
}
