// Interactive terminal modal.
//
// Wraps a PreviewTerminal inside a coordinator-owned ModalSurface so
// a live PTY can run inside a centered overlay while the dashboard
// stays mounted underneath. The modal:
//
//   • owns its own PreviewTerminal (long-lived; see P8 session
//     registry for cross-attach/detach reuse)
//   • paints by calling preview.render(true) then positioning each
//     rendered row with moveTo(bounds.row + i, bounds.col)
//   • claims the host-OS caret via cursor() = preview.cursorPosition()
//     mapped into absolute bounds coords (inside border)
//   • accepts keys via onKey — dashboard routes with top priority
//     in P6 by intercepting before chat's readKey
//
// Default bounds: 85% of termCols × termRows. Minimum 40×8.

import { PreviewTerminal, type PreviewTerminalOpts, type SpawnFn } from './preview/terminal.js';
import { keyEventToTerminalBytes } from './display/execution-surface.js';
import chalk from 'chalk';
import { ansi, C, ctp, visibleWidth, stripAnsi } from './tui.js';
import type { ModalSurface, ModalBounds } from './display/modal-stack.js';
import type { CursorState } from './display/cursor-state.js';
import type { DisplayCoordinator } from './display/coordinator.js';
import type { DisplayEventBus } from './display/events.js';
import {
  isModalChromeMouseEventType,
  isPrimaryButtonClickMouseEventType,
  type Action,
  type DisplayMouseEvent,
  type KeyEvent,
  type SurfaceId,
  type SurfaceOwner,
} from './display/types.js';
import { debug } from './debug/log.js';
import {
  dispatchChromeControlAction,
  type ChromeControlResult,
} from './ui/modal-adapter.js';

export interface InteractiveTerminalModalSpec {
  id?: SurfaceId;
  /** Title painted in the modal's top border. */
  title: string;
  /** Working directory for the spawned shell. */
  cwd: string;
  /** Command to run. If provided, typed into the shell on start
   *  (followed by Enter). If omitted, the modal is an interactive
   *  shell the user/agent drives themselves. */
  command?: string;
  shell?: string;
  /** Positional args for the spawned process. Matrix remote
   *  transports set this to e.g. `['ssh', 'host', '--', 'bash']`
   *  so PreviewTerminal runs `tailscale ssh host -- bash` instead
   *  of a plain local shell. Empty default keeps the legacy behaviour. */
  shellArgs?: readonly string[];
  env?: Record<string, string>;
  /** Ghostty-compatible terminfo name. Defaults via PreviewTerminal
   *  to xterm-256color. */
  termName?: string;
  /** Register this popup in the shared PTY inventory. */
  useRegistry?: boolean;
  registryKind?: string;
  registryNickname?: string;
  registryOrigin?: { originRoot: string; controller?: string };
  registryPurpose?: string;
  registrySeat?: string;
  /** Override bounds. Default: 85% of termCols/termRows, centered. */
  bounds?: ModalBounds;
  /** MT1 — named size preset (mutually exclusive with `bounds`; when
   *  both are set, `bounds` wins for backward compatibility). */
  sizePreset?: ModalSizePreset;
  /** Called when the PTY exits (0 = normal). */
  /** ⛔ `code: null` = exited, code unlearnable — never render it as 0. */
  onExit?: (code: number | null) => void;
  /** Called after dispose() finishes. */
  onClose?: () => void;
  /** P13 — forwarded to PreviewTerminal. Fires on OSC 9/99/777. */
  onOscNotify?: (ev: { code: 9 | 99 | 777; title: string; body: string; raw: string }) => void;
  /** Owner tag for surface registry — defaults to 'dashboard'. */
  owner?: SurfaceOwner;
  /** User clicked a title-bar control button.
   *   - `'copy'`     → host snapshots PTY + writes plaintext to macOS
   *                    clipboard (path D in MANUAL §1.6 follow-up)
   *   - `'minimize'` → host calls sessionRegistry.detach (PTY lives)
   *   - `'close'`    → host calls sessionRegistry.kill (PTY dies)
   *  The modal surfaces the click; the host translates to the right
   *  registry op. Per user requests: "최소화, 종료 버튼 있는 아름다운
   *  타이틀 보더 포함." + "쉽게 결과물을 복사하는 방법이 필요한데" → 2번. */
  onTitleAction?: (action: 'copy' | 'minimize' | 'close') => ChromeControlResult;
}

export interface InteractiveTerminalModalHandle {
  readonly id: SurfaceId;
  readonly surface: ModalSurface;
  readonly preview: PreviewTerminal;
  /** Current bounds. Mutates via setBounds / enterFullscreen / exitFullscreen. */
  readonly bounds: ModalBounds;
  write(bytes: string): void;
  resize(cols: number, rows: number): void;
  /** Replace bounds. The modal paints at the new region on next
   *  frame + the underlying PreviewTerminal is resized to match
   *  interior dimensions. Used by enter/exit fullscreen + by
   *  window-resize handlers. */
  setBounds(bounds: ModalBounds, termCols: number, termRows: number): void;
  /** Enlarge modal to fill the entire terminal (no margin). */
  enterFullscreen(termCols: number, termRows: number): void;
  /** Shrink modal back to the default 85% centered bounds. */
  exitFullscreen(termCols: number, termRows: number): void;
  /** True when bounds cover (1,1,termCols,termRows). */
  isFullscreen(termCols: number, termRows: number): boolean;
  /** Dispose the modal. By default also stops the PreviewTerminal
   *  — pass keepPreview:true to leave the PTY alive (session detach
   *  semantics in P8 — the preview gets re-attached later). */
  dispose(opts?: { keepPreview?: boolean }): void;
  isAlive(): boolean;
  snapshot(): string;
}

export interface InteractiveTerminalModalDeps {
  coordinator: DisplayCoordinator;
  termCols: number;
  termRows: number;
  eventBus?: DisplayEventBus;
  /** Terminal factory — defaults to `new PreviewTerminal`. Tests
   *  override to inject a fake PTY. Ignored when `existingPreview`
   *  is supplied. */
  terminalFactory?: (opts: PreviewTerminalOpts, spawn?: SpawnFn) => PreviewTerminal;
  spawn?: SpawnFn;
  /** Attach the modal over a pre-existing PreviewTerminal instead
   *  of spawning a fresh one. Used by the session registry (P8) to
   *  re-attach a backgrounded session. When set:
   *    • preview.start() is NOT called (already running)
   *    • spec.command is ignored (already typed)
   *    • dispose() defaults to keepPreview:true so the caller
   *      retains ownership. */
  existingPreview?: PreviewTerminal;
}

let nextModalId = 1;

export const INTERACTIVE_MIN_COLS = 40;
export const INTERACTIVE_MIN_ROWS = 8;
export const INTERACTIVE_DEFAULT_SIZE_RATIO = 0.85;

export function createInteractiveTerminalModal(
  spec: InteractiveTerminalModalSpec,
  deps: InteractiveTerminalModalDeps,
): InteractiveTerminalModalHandle {
  const id = spec.id ?? `term-modal:${nextModalId++}`;
  // Caller-provided bounds also get clamped — a misconfigured bounds
  // (e.g. legacy config with width=120 for a 40-col pane) would paint
  // off-screen and look like the modal never opened.
  const rawBounds = spec.bounds
    ?? (spec.sizePreset ? presetBounds(spec.sizePreset, deps.termCols, deps.termRows) : computeDefaultBounds(deps.termCols, deps.termRows));
  let bounds: ModalBounds = clampBoundsToTerm(rawBounds, deps.termCols, deps.termRows);
  const owner = spec.owner ?? 'dashboard';
  if (debug.enabled) {
    debug.log('window.createInteractiveTerminalModal', id, {
      id,
      title: spec.title,
      cwd: spec.cwd,
      command: spec.command,
      shell: spec.shell,
      rawBounds: { ...rawBounds },
      bounds: { ...bounds },
      termCols: deps.termCols,
      termRows: deps.termRows,
      attachedToExisting: deps.existingPreview !== undefined,
      clamped: rawBounds.width !== bounds.width || rawBounds.height !== bounds.height
            || rawBounds.row !== bounds.row || rawBounds.col !== bounds.col,
    });
  }

  // Interior dimensions — 1 cell reserved each side for the border.
  const innerCols = Math.max(INTERACTIVE_MIN_COLS - 2, bounds.width - 2);
  const innerRows = Math.max(INTERACTIVE_MIN_ROWS - 2, bounds.height - 2);

  const attachedToExisting = deps.existingPreview !== undefined;
  const factory = deps.terminalFactory ?? ((o, s) => new PreviewTerminal(o, s));
  // Async-launch placeholder state. Cold shell startup (zsh + p10k +
  // /claude keychain unlock + claude bootstrap) routinely takes 1-2s
  // before the PTY emits its first frame. Without an explicit
  // placeholder the modal box appears empty for that whole window —
  // user-perceived "popup is slow". Per user feedback:
  //   "popup 터미널 모드, claude, codex 등 1초 이상 delay 가 걸리는데
  //    빠르게 'Start Terminal (claude or codex)' 등 안내 팝업을 띄우고
  //    바로 실제 런치 되자마자 dispose 하고 전환하는 것 검토.
  //    async 모드로 부드럽게 런칭되었으면 좋겠음."
  //
  // pendingStart=true while we haven't seen the first onUpdate from
  // the PreviewTerminal. paint() routes to a centered spinner +
  // "Starting <title>…" placeholder during this window. First
  // onUpdate flips it false and the real PTY grid takes over on the
  // next render. Re-attach paths skip the placeholder (PTY already
  // has output).
  let pendingStart = !attachedToExisting;
  let spinnerFrame = 0;
  let spinnerTimer: ReturnType<typeof setInterval> | null = null;

  const stopSpinner = (): void => {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
  };

  const preview = deps.existingPreview ?? factory({
    cols: innerCols,
    rows: innerRows,
    cwd: spec.cwd,
    shell: spec.shell,
    shellArgs: spec.shellArgs,
    env: spec.env,
    termName: spec.termName,
    useRegistry: spec.useRegistry,
    registryKind: spec.registryKind,
    registryNickname: spec.registryNickname,
    registryOrigin: spec.registryOrigin,
    registryPurpose: spec.registryPurpose,
    registrySeat: spec.registrySeat,
    onUpdate: () => {
      // First output → leave the placeholder state. Stops the
      // spinner timer + flushes a render so the real PTY frame
      // appears immediately.
      if (pendingStart) {
        pendingStart = false;
        stopSpinner();
      }
      deps.eventBus?.emit({ type: 'execution:update', id, status: 'output' });
      deps.coordinator.publish({ type: 'requestRender', region: id });
    },
    onExit: (code) => {
      // Defensive: if the PTY exited before emitting any output
      // (e.g. command not found), drop the placeholder so the
      // dispose path doesn't repaint the spinner.
      if (pendingStart) {
        pendingStart = false;
        stopSpinner();
      }
      deps.eventBus?.emit({ type: 'execution:update', id, status: 'exited', payload: { code } });
      try { spec.onExit?.(code); } catch { /* swallow */ }
      deps.coordinator.publish({ type: 'requestRender', region: id });
    },
    onOscNotify: spec.onOscNotify,
  }, deps.spawn);

  // When re-attaching to an existing preview, the target size may
  // have drifted (user resized terminal while the session was in
  // the background). Reconcile now so the first paint looks right.
  if (attachedToExisting) {
    try { preview.resize(innerCols, innerRows); } catch { /* ignore */ }
  }

  // Drive the spinner animation only while pendingStart is true.
  // 80ms cadence matches elanous's existing spinner conventions
  // (status bar, thinking line). Timer is unref'd so it never
  // pins the event loop on its own.
  if (pendingStart) {
    spinnerTimer = setInterval(() => {
      spinnerFrame = (spinnerFrame + 1) % STARTING_SPINNER_FRAMES.length;
      deps.coordinator.publish({ type: 'requestRender', region: id });
    }, 80);
    if (typeof (spinnerTimer as { unref?: () => void }).unref === 'function') {
      (spinnerTimer as unknown as { unref: () => void }).unref();
    }
  }

  let alive = true;

  const paint = (): string => {
    if (!alive) return '';
    try {
      const currentInnerCols = Math.max(INTERACTIVE_MIN_COLS - 2, bounds.width - 2);
      const currentInnerRows = Math.max(INTERACTIVE_MIN_ROWS - 2, bounds.height - 2);
      if (pendingStart) {
        // Highlighted frame while async-launching: peach border +
        // peach title so the popup reads as "active / starting" and
        // doesn't blend into the dashboard chrome behind it. Reverts
        // to the normal muted-border / accent-title styling on first
        // PTY output.
        const grid = buildStartingGrid({
          rows: currentInnerRows,
          cols: currentInnerCols,
          title: spec.title,
          spinner: STARTING_SPINNER_FRAMES[spinnerFrame] ?? '⠋',
        });
        return paintModal({
          bounds,
          title: spec.title,
          grid,
          borderColor: chalk.hex(ctp.peach),
          titleColor: chalk.bold.hex(ctp.peach),
        });
      }
      return paintModal({
        bounds,
        title: spec.title,
        grid: preview.render(true),
        showTitleControls: spec.onTitleAction !== undefined,
      });
    } catch {
      return '';
    }
  };

  const cursor = (): CursorState | null => {
    const p = preview.cursorPosition();
    if (!p) return null;
    // bounds is 1-indexed; interior starts at row+1, col+1.
    return {
      row: bounds.row + 1 + p.row,
      col: bounds.col + 1 + p.col,
      visible: true,
    };
  };

  const onKey = (ev: KeyEvent): Action => {
    if (!alive) return { type: 'none' };
    // Dashboard intercepts ESC / Ctrl-G / prefix sequences BEFORE
    // forwarding here (P6). Anything that reaches onKey is meant
    // for the PTY.
    const bytes = keyEventToTerminalBytes(ev);
    if (!bytes) return { type: 'none' };
    preview.write(bytes);
    return { type: 'refresh' };
  };

  const onMouse = (ev: DisplayMouseEvent): Action => {
    if (!isModalChromeMouseEventType(ev.type)) {
      return { type: 'none' };
    }
    if (!isInteractiveTerminalTitleRailHit(bounds, ev.row, ev.col)) return { type: 'none' };
    // BrowserPreview-style title controls — when the host wired
    // `onTitleAction`, only `click` events on the [−] / [✕] cells
    // dispatch (drag/release/double don't, to keep the title-rail
    // drag gesture working for window moves later). The modal still
    // attaches `hitTarget` so widget-level routing sees the title
    // rail consistently.
    if (isPrimaryButtonClickMouseEventType(ev.type) && spec.onTitleAction && !pendingStart) {
      const hits = computeTitleControls(bounds);
      for (const hit of hits) {
        if (ev.col >= hit.startCol && ev.col <= hit.endCol) {
          if (debug.enabled) {
            debug.log('window.modal.titleControl.click', hit.action, {
              id, action: hit.action, col: ev.col, row: ev.row,
            });
          }
          runTitleAction(hit.action);
          ev.hitTarget = { kind: 'modal-title', modalId: id };
          return { type: 'refresh' };
        }
      }
    }
    ev.hitTarget = { kind: 'modal-title', modalId: id };
    return { type: 'refresh' };
  };

  const surface: ModalSurface = {
    id,
    owner,
    kind: 'modal',
    // IDX-F1 — tier label for single-source lookup via
    // coordinator.topOfTier('terminal'). Preserves the existing
    // terminalModalRouter.current() behavior while the migration
    // lands; F2 removes the router singleton.
    tier: 'terminal',
    focus: 'owns',
    priority: 500,
    // The popup terminal owns the foreground while open: the user is
    // interacting with the PTY inside, not the dashboard chrome behind
    // it. Without this flag `shouldSuppressDashboardBottomArea()`
    // returns false, so chat-main-input's `paintChrome()` keeps firing
    // every frame and writes `\x1b[2K + divider text` across rows that
    // overlap the modal interior — erasing modal cells and leaking the
    // dashboard's input chrome / status pill inside the modal box.
    // pane-multi already sets this for the same reason.
    backgroundInteractionPolicy: 'block',
    // Mutable getter so setBounds changes propagate without having
    // to re-register the surface with the coordinator.
    get bounds() { return bounds; },
    render: () => [],
    paint,
    cursor,
    onKey,
    onMouse,
    dispose: () => {
      if (!alive) return;
      alive = false;
      // Surface-level dispose is triggered by coordinator.closeSurface.
      // Respect the attach-over-existing contract: leave the preview
      // alone in that case so the session can rewrap it later.
      if (!attachedToExisting) {
        try { preview.stop(); } catch { /* ignore */ }
      }
      try { spec.onClose?.(); } catch { /* ignore */ }
    },
  };

  // Spawn the PTY, push modal, give focus. Order matters: preview.start()
  // must happen BEFORE pushModal so the first paint has a valid grid.
  if (!attachedToExisting) {
    preview.start();
    if (spec.command) {
      // Type the command as if from keyboard — works in any shell
      // without requiring us to pass it via argv.
      preview.write(
        spec.command.endsWith('\r') || spec.command.endsWith('\n')
          ? spec.command
          : spec.command + '\r',
      );
    }
  }

  const { dispose: popFn } = deps.coordinator.pushModal(surface);
  deps.eventBus?.emit({
    type: 'execution:update',
    id,
    status: 'running',
    payload: { title: spec.title, cwd: spec.cwd, command: spec.command, placement: 'modal' },
  });

  const dispose = (opts: { keepPreview?: boolean } = {}): void => {
    if (!alive) return;
    alive = false;
    // Stop the placeholder spinner if it's still running (modal
    // disposed before PTY produced any output — e.g. user closed
    // the popup mid-launch).
    stopSpinner();
    // Default behavior: stop the preview — unless the caller owns
    // it (attachedToExisting) or explicitly asks to keep it around
    // (session detach). Either case leaves the PTY alive for a
    // subsequent re-attach.
    const keep = opts.keepPreview ?? attachedToExisting;
    if (!keep) {
      try { preview.stop(); } catch { /* ignore */ }
    }
    try { popFn(); } catch { /* already disposed */ }
    try { spec.onClose?.(); } catch { /* ignore */ }
  };

  const handle: InteractiveTerminalModalHandle = {
    id,
    surface,
    preview,
    get bounds() { return bounds; },
    write: (bytes) => { if (alive) preview.write(bytes); },
    resize: (cols, rows) => {
      // Re-derive interior then forward.
      const ic = Math.max(INTERACTIVE_MIN_COLS - 2, cols - 2);
      const ir = Math.max(INTERACTIVE_MIN_ROWS - 2, rows - 2);
      preview.resize(ic, ir);
    },
    setBounds: (b, _termCols, _termRows) => {
      bounds = b;
      try {
        preview.resize(
          Math.max(INTERACTIVE_MIN_COLS - 2, b.width - 2),
          Math.max(INTERACTIVE_MIN_ROWS - 2, b.height - 2),
        );
      } catch { /* ignore */ }
      deps.coordinator.publish({ type: 'requestRender', region: id, force: true });
    },
    enterFullscreen: (termCols, termRows) => {
      handle.setBounds({ row: 1, col: 1, width: termCols, height: termRows }, termCols, termRows);
    },
    exitFullscreen: (termCols, termRows) => {
      handle.setBounds(computeDefaultBounds(termCols, termRows), termCols, termRows);
    },
    isFullscreen: (termCols, termRows) =>
      bounds.row === 1 && bounds.col === 1 && bounds.width === termCols && bounds.height === termRows,
    dispose,
    isAlive: () => alive && preview.isAlive,
    snapshot: () => {
      try { return preview.render(false); } catch { return ''; }
    },
  };
  return handle;

  function runTitleAction(action: 'copy' | 'minimize' | 'close'): void {
    if (!spec.onTitleAction) return;
    if (action === 'copy') {
      try { spec.onTitleAction('copy'); } catch { /* ignore */ }
      return;
    }
    if (action === 'minimize') {
      dispatchChromeControlAction(
        'minimize',
        {
          minimizeButton: true,
          minimizeDisposition: 'keep-open',
          onMinimize: () => spec.onTitleAction?.('minimize'),
        },
        () => dispose({ keepPreview: true }),
      );
      return;
    }
    dispatchChromeControlAction(
      'close',
      {
        closeButton: true,
        closeDisposition: 'keep-open',
        onClose: () => spec.onTitleAction?.('close'),
      },
      () => dispose(),
    );
  }
}

// ─── Bounds + paint helpers ─────────────────────────────────────

/** MT1 — named size variants for modal terminals. Useful for
 *  verifying widget/TUI layouts at canonical terminal sizes without
 *  resizing the host window. Actual values come from classic VT
 *  conventions (80x24), modern-dev (132x40), ultrawide (200x60), and
 *  fullscreen. The string is mapped by presetBounds(); unknown values
 *  fall back to the default centered 85% layout. */
export type ModalSizePreset = '80x24' | '132x40' | '200x60' | 'full' | 'default';

export const MODAL_SIZE_PRESETS: readonly ModalSizePreset[] = Object.freeze([
  'default', '80x24', '132x40', '200x60', 'full',
]);

/** Compute bounds for a named preset. 'full' takes the whole
 *  viewport; 'default' returns the standard centered 85% layout via
 *  computeDefaultBounds(). Fixed sizes center themselves and clamp to
 *  the available terminal so an 80x24 request on a 40-col host falls
 *  back to the fullscreen fallback rather than painting off-screen. */
export function presetBounds(
  preset: ModalSizePreset,
  termCols: number,
  termRows: number,
): ModalBounds {
  if (preset === 'default') return computeDefaultBounds(termCols, termRows);
  if (preset === 'full') {
    return { row: 1, col: 1, width: termCols, height: termRows };
  }
  const fixed: Record<Exclude<ModalSizePreset, 'default' | 'full'>, { w: number; h: number }> = {
    '80x24':  { w: 80,  h: 24 },
    '132x40': { w: 132, h: 40 },
    '200x60': { w: 200, h: 60 },
  };
  const spec = fixed[preset];
  // If the requested size doesn't fit, fall through to the sane default
  // rather than cropping to a malformed modal.
  if (termCols < spec.w + 2 || termRows < spec.h + 2) {
    return computeDefaultBounds(termCols, termRows);
  }
  const row = Math.max(1, Math.floor((termRows - spec.h) / 2) + 1);
  const col = Math.max(1, Math.floor((termCols - spec.w) / 2) + 1);
  return { row, col, width: spec.w, height: spec.h };
}

export function computeDefaultBounds(termCols: number, termRows: number): ModalBounds {
  // On narrow tablets / small SSH panes the terminal may be smaller
  // than INTERACTIVE_MIN_COLS. Before the clamp below the function
  // returned width=40 on a 30-col screen, which then painted off the
  // right edge and wrapped — the user saw screen corruption instead
  // of a modal. Fall back to fullscreen when min wouldn't fit.
  const canFitMinCols = termCols >= INTERACTIVE_MIN_COLS + 2;
  const canFitMinRows = termRows >= INTERACTIVE_MIN_ROWS + 2;
  if (!canFitMinCols || !canFitMinRows) {
    // Fullscreen fallback — the modal takes the whole viewport. Still
    // leaves row 1 / col 1 available so a 1-cell margin isn't
    // required by the border paint path.
    const w = Math.max(4, Math.min(termCols, 200));
    const h = Math.max(3, Math.min(termRows, 200));
    return { row: 1, col: 1, width: w, height: h };
  }
  const width = Math.max(
    INTERACTIVE_MIN_COLS,
    Math.min(termCols - 2, Math.floor(termCols * INTERACTIVE_DEFAULT_SIZE_RATIO)),
  );
  const height = Math.max(
    INTERACTIVE_MIN_ROWS,
    Math.min(termRows - 2, Math.floor(termRows * INTERACTIVE_DEFAULT_SIZE_RATIO)),
  );
  const row = Math.max(1, Math.floor((termRows - height) / 2) + 1);
  const col = Math.max(1, Math.floor((termCols - width) / 2) + 1);
  return { row, col, width, height };
}

/** Clamp a bounds to fit within (termCols × termRows). Shrinks width/
 *  height and nudges row/col so the modal never paints off-screen.
 *  When the terminal is big enough for the paint minimum (4x3), the
 *  row/col are pulled back so the modal stays fully on-screen. When
 *  the terminal is smaller than the minimum, the bounds are returned
 *  as-is for the paint path to bail on — paintModal already guards
 *  with `if (width < 4 || height < 3) return ''`.
 *  Exported for unit tests + callers that accept user-supplied bounds. */
export function clampBoundsToTerm(bounds: ModalBounds, termCols: number, termRows: number): ModalBounds {
  // Paint minimum = 4 wide × 3 tall (border + 1 content row). When the
  // terminal can host it, we guarantee col/row are pulled back so the
  // min fits without overflowing.
  const MIN_W = 4;
  const MIN_H = 3;
  const colCap = termCols >= MIN_W ? termCols - MIN_W + 1 : 1;
  const rowCap = termRows >= MIN_H ? termRows - MIN_H + 1 : 1;
  const col = Math.max(1, Math.min(bounds.col, colCap));
  const row = Math.max(1, Math.min(bounds.row, rowCap));
  const width = Math.max(MIN_W, Math.min(bounds.width, Math.max(MIN_W, termCols - col + 1)));
  const height = Math.max(MIN_H, Math.min(bounds.height, Math.max(MIN_H, termRows - row + 1)));
  return { row, col, width, height };
}

// Spinner frames + placeholder grid builder for the async-launch
// "Starting <title>…" overlay. Re-rendered every 80ms while the PTY
// is cold; replaced by the real terminal grid on first onUpdate.
const STARTING_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

type Painter = (s: string) => string;

function centerLine(cols: number, content: string): string {
  const vw = visibleWidth(stripAnsi(content));
  if (vw >= cols) return content; // overflow: caller is responsible for clipping
  const padL = Math.max(0, Math.floor((cols - vw) / 2));
  const padR = Math.max(0, cols - vw - padL);
  return ' '.repeat(padL) + content + ' '.repeat(padR);
}

function buildStartingGrid(input: {
  rows: number;
  cols: number;
  /** title is unused in the body — the modal frame already paints
   *  it in the top border, so duplicating it inside would be noise.
   *  Kept on the type for caller compatibility. */
  title: string;
  spinner: string;
}): string {
  const { rows, cols, spinner } = input;

  // Banner — "═══ Information ═══" peach header inside the inner box.
  const bannerLabel = ' Information ';

  // Headline — peach spinner + bold "STARTING".
  const headline =
    chalk.bold.hex(ctp.peach)(`${spinner}  `)
    + chalk.bold.hex(ctp.text)('STARTING');

  // Hint — softer subtext line.
  const hint = chalk.hex(ctp.subtext0)('cold start may take a moment…');

  // Inner border — a heavy double-stroked rectangle that wraps the
  // content block. Reinforces "this is an announcement, not the
  // running terminal" per user feedback ("사각형 보더도 더 보강").
  // Width derived from the widest content line plus padding; falls
  // back to a sensible default when interior cols are tight.
  const wantedInnerWidth = Math.max(
    visibleWidth(bannerLabel) + 6,
    visibleWidth(stripAnsi(headline)) + 4,
    visibleWidth(stripAnsi(hint)) + 4,
  );
  const maxInnerWidth = Math.max(8, cols - 4); // 2 cells margin each side
  const innerWidth = Math.min(wantedInnerWidth, maxInnerWidth);
  const innerCols = innerWidth - 2; // text width inside the inner box
  const innerSideMargin = Math.max(0, Math.floor((cols - innerWidth) / 2));
  const sidePad = ' '.repeat(innerSideMargin);

  const sideBars = Math.max(2, Math.floor((innerCols - visibleWidth(bannerLabel)) / 2));
  const banner =
    chalk.hex(ctp.peach)('═'.repeat(sideBars))
    + chalk.bold.hex(ctp.peach)(bannerLabel)
    + chalk.hex(ctp.peach)('═'.repeat(Math.max(0, innerCols - sideBars - visibleWidth(bannerLabel))));

  const innerBlankRow = ' '.repeat(innerCols);
  const top    = chalk.hex(ctp.peach)('┏' + '━'.repeat(innerCols) + '┓');
  const bot    = chalk.hex(ctp.peach)('┗' + '━'.repeat(innerCols) + '┛');
  const sideL  = chalk.hex(ctp.peach)('┃');
  const sideR  = chalk.hex(ctp.peach)('┃');
  const wrap   = (content: string): string =>
    sideL + centerLine(innerCols, content) + sideR;

  // Inner-box rows (top, blank, banner, blank, headline, blank, hint, blank, bot)
  const innerRows: string[] = [
    top,
    sideL + innerBlankRow + sideR,
    sideL + centerLine(innerCols, banner) + sideR,
    sideL + innerBlankRow + sideR,
    wrap(headline),
    sideL + innerBlankRow + sideR,
    wrap(hint),
    sideL + innerBlankRow + sideR,
    bot,
  ];

  const blank = ' '.repeat(cols);
  const lines: string[] = [];

  // Vertically center the inner box.
  const topPad = Math.max(0, Math.floor((rows - innerRows.length) / 2));
  for (let i = 0; i < topPad; i++) lines.push(blank);
  for (const row of innerRows) {
    if (lines.length >= rows) break;
    // Pad the row so total visible width === cols (left margin +
    // inner box + right margin).
    const rightPad = Math.max(0, cols - innerSideMargin - innerWidth);
    lines.push(sidePad + row + ' '.repeat(rightPad));
  }
  while (lines.length < rows) lines.push(blank);

  return lines.join('\n');
}

/** Title-bar control button hit description. Returned from
 *  computeTitleControlHit so onMouse can dispatch the right action
 *  without re-laying out the title rail. */
interface TitleControlHit {
  action: 'copy' | 'minimize' | 'close';
  startCol: number;
  endCol: number;
}

const TITLE_PREFIX_GLYPH = '⏵';
const TITLE_CONTROL_COPY = '⎘';      // U+2398 NEXT PAGE — common "copy" glyph
const TITLE_CONTROL_MINIMIZE = '─';
const TITLE_CONTROL_CLOSE = '✕';

// Title controls reserved-width math (single source of truth so
// paint, hit-test, and the "controls-fit" gate all agree).
const TITLE_CONTROL_BUTTON_WIDTH = 5;   // `[ X ]`
const TITLE_CONTROL_GAP_WIDTH = 1;      // ' '
const TITLE_CONTROL_LEADING_PAD = 1;    // ' ' before the first button
const TITLE_CONTROLS_TOTAL_WIDTH =
  TITLE_CONTROL_LEADING_PAD
  + TITLE_CONTROL_BUTTON_WIDTH * 3
  + TITLE_CONTROL_GAP_WIDTH * 2;        // = 18 (` [ ⎘ ] [ ─ ] [ ✕ ]`)

/** Compute the column ranges for the [⎘] [─] [✕] controls in the
 *  title rail. Returns one entry per control; the modal's onMouse
 *  uses these to decide which action to dispatch on click. The
 *  layout matches the paint exactly so paint and hit-test never
 *  drift. */
function computeTitleControls(bounds: ModalBounds): TitleControlHit[] {
  if (bounds.width < TITLE_CONTROLS_TOTAL_WIDTH + 4) return []; // need title room too
  // Heavy-bar layout (no trailing border cells on the top row):
  //   …█████ [ ⎘ ] [ ─ ] [ ✕ ]   ← `]` of close sits at col+width-1
  // Each `[ X ]` button is 5 visible columns; gap between them is
  // 1 column.
  const lastCol = bounds.col + bounds.width - 1;
  const closeEnd = lastCol;            // `]` of close
  const closeStart = lastCol - 4;      // `[` of close
  const minEnd = lastCol - 6;          // `]` of minimize
  const minStart = lastCol - 10;       // `[` of minimize
  const copyEnd = lastCol - 12;        // `]` of copy
  const copyStart = lastCol - 16;      // `[` of copy
  return [
    { action: 'copy',     startCol: copyStart,  endCol: copyEnd  },
    { action: 'minimize', startCol: minStart,   endCol: minEnd   },
    { action: 'close',    startCol: closeStart, endCol: closeEnd },
  ];
}

function paintModal(input: {
  bounds: ModalBounds;
  title: string;
  grid: string;
  /** Optional border color (default: C.muted). Highlighted variants
   *  pass C.peach so the modal reads as "active / starting / status"
   *  while it's transient. */
  borderColor?: Painter;
  /** Optional title color (default: C.accent). */
  titleColor?: Painter;
  /** When true, paint [−] and [✕] controls on the right of the title
   *  rail. The `onTitleAction` spec field is invoked from onMouse on
   *  click. Disabled when the title bar is too narrow to fit the
   *  controls (innerWidth < 12). */
  showTitleControls?: boolean;
}): string {
  const { row, col, width, height } = input.bounds;
  if (width < 4 || height < 3) return '';

  const innerWidth = width - 2;
  const innerHeight = height - 2;
  const borderColor = input.borderColor ?? C.muted;
  const titleColor = input.titleColor ?? C.accent;

  const out: string[] = [];

  // ── Title rail ────────────────────────────────────────────────
  // BrowserPreview-style: rounded corners, title with a leading
  // ⏵ play-glyph (so the user can tell at a glance which popup is
  // running), and right-aligned [−] [✕] controls.
  //
  //   ╭─ ⏵ claude-code [monad-agent] ───────── [ ─ ] [ ✕ ] ─╮
  //
  // When the rail is too narrow for controls, fall back to the
  // legacy centered-title layout (no controls).
  const wantControls = input.showTitleControls === true && innerWidth >= 22;

  if (wantControls) {
    // Heavy block-bar top row — only the upper edge is "thick" per
    // user request: "어퍼 영역만 Thick 하게 표현. ㅁㅁㅁㅁㅁㅁㅁ 타이틀
    // ㅁㅁㅁㅁㅁㅁㅁ 보더를 띡하게 표현하고 타이틀은 센터 정렬." Title
    // is dead-centered against the modal width; minimize / close
    // controls anchor to the right edge and visually sit on top of
    // the right block bar. Sides + bottom remain thin (`│` + `╰─╯`).
    //
    //   ████████████ ⏵ claude-code ████████████ [ ─ ] [ ✕ ]
    //   │                                                  │
    //   │ <terminal grid>                                   │
    //   ╰──────────────────────────────────────────────────╯
    const HEAVY_BLOCK = '█';
    const totalWidth = width;

    const titleRaw = ` ${TITLE_PREFIX_GLYPH} ${input.title} `;
    const controlsVW = TITLE_CONTROLS_TOTAL_WIDTH; // = 18 (` [ ⎘ ] [ ─ ] [ ✕ ]`)

    // Clip the title if necessary so leftFill/rightFill stay
    // non-negative. Reserve `controlsVW + 2` cells on the right
    // for the right block bar + controls, plus 4 cells minimum on
    // the left for the left block bar.
    const reservedNonTitle = controlsVW + 6;
    const maxTitleVW = Math.max(0, totalWidth - reservedNonTitle);
    const titleClipped = visibleWidth(titleRaw) > maxTitleVW
      ? ` ${TITLE_PREFIX_GLYPH} ${input.title.slice(0, Math.max(0, maxTitleVW - 5))}… `
      : titleRaw;
    const titleVW = visibleWidth(titleClipped);
    const titleStyled = chalk.bold(titleColor(stripAnsi(titleClipped)));

    // Layout math: [left-blocks][title][right-blocks][controls]
    // Left blocks: centered against full width (ignoring controls
    // anchor) so the title visually sits in the middle of the bar.
    const leftFill = Math.max(2, Math.floor((totalWidth - titleVW) / 2));
    const remainingAfterTitle = totalWidth - leftFill - titleVW;
    const rightBlocksBeforeControls = Math.max(0, remainingAfterTitle - controlsVW);

    // Controls — buttons painted with their own colors, brackets in
    // borderColor for visual consistency with the bar. Order on
    // screen (left → right): copy / minimize / close.
    const copyBtn =
      borderColor('[ ')
      + chalk.bold.hex(ctp.sky)(TITLE_CONTROL_COPY)
      + borderColor(' ]');
    const minBtn =
      borderColor('[ ')
      + chalk.hex(ctp.subtext0)(TITLE_CONTROL_MINIMIZE)
      + borderColor(' ]');
    const closeBtn =
      borderColor('[ ')
      + chalk.bold.hex(ctp.peach)(TITLE_CONTROL_CLOSE)
      + borderColor(' ]');

    out.push(
      ansi.moveTo(row, col) +
      borderColor(HEAVY_BLOCK.repeat(leftFill)) +
      titleStyled +
      borderColor(HEAVY_BLOCK.repeat(rightBlocksBeforeControls)) +
      ' ' + copyBtn + ' ' + minBtn + ' ' + closeBtn,
    );
  } else {
    // Legacy centered-title fallback (used when modal too narrow,
    // and during async-launch state where controls would distract
    // from the placeholder banner).
    const titleRaw = input.title.length > innerWidth - 6
      ? input.title.slice(0, innerWidth - 7) + '…'
      : input.title;
    const titleStyled = ` ${titleColor(titleRaw)} `;
    const titleVW = visibleWidth(stripAnsi(titleStyled));
    const leftPad = Math.max(1, Math.floor((innerWidth - titleVW) / 2));
    const rightPad = Math.max(1, innerWidth - titleVW - leftPad);
    out.push(
      ansi.moveTo(row, col) +
      borderColor('╭') +
      borderColor('─'.repeat(leftPad)) +
      titleStyled +
      borderColor('─'.repeat(rightPad)) +
      borderColor('╮'),
    );
  }

  // Content rows.
  const gridLines = input.grid.split('\n');
  // Diagnostic — track whether grid line count + per-row visible width
  // match expectations. A mismatch means cells inside the modal aren't
  // overwritten by the new frame, so dashboard / prior-frame text leaks
  // through. Logged once per paint when something's off (silent in the
  // happy path).
  if (debug.enabled && gridLines.length !== innerHeight) {
    debug.log('window.modal.paint.linecount', '', {
      innerHeight, gridLines: gridLines.length,
    });
  }
  for (let i = 0; i < innerHeight; i++) {
    const r = row + 1 + i;
    const raw = gridLines[i] ?? '';
    if (debug.enabled) {
      const visW = visibleWidth(stripAnsi(raw));
      if (visW !== innerWidth) {
        debug.log('window.modal.paint.row', String(i), {
          i, row: r, innerWidth, visW, rawLen: raw.length,
        });
      }
    }
    // ANSI lines from preview are already width-fitted to innerWidth
    // (we pass innerCols into the terminal). We just left + right
    // frame them with the border cells. Reset SGR at the right edge
    // so the border color doesn't leak.
    out.push(
      ansi.moveTo(r, col) +
      borderColor('│') +
      raw +
      '\x1b[0m' +
      ansi.moveTo(r, col + width - 1) +
      borderColor('│'),
    );
  }

  // Bottom border.
  out.push(
    ansi.moveTo(row + height - 1, col) +
    borderColor('╰') +
    borderColor('─'.repeat(innerWidth)) +
    borderColor('╯'),
  );

  return out.join('');
}

function isInteractiveTerminalTitleRailHit(
  bounds: ModalBounds,
  row: number,
  col: number,
): boolean {
  if (row !== bounds.row || bounds.width < 4) return false;
  // Heavy-bar layout has no border-cell corners on the top row —
  // the leftmost column is a `█` block and the rightmost is the
  // `]` of the close button. Both ends must be hittable so clicks
  // on the absolute right edge actually fire the close action.
  return col >= bounds.col && col <= bounds.col + bounds.width - 1;
}
