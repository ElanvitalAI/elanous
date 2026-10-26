// Shared key routing for interactive terminal modals in dashboard and TUI.
//
// Holds singleton state for "which interactive terminal modal is
// currently foregrounded" + the key-intercept policy:
//
//   • while a modal is present, ESC / Ctrl-G dispose it
//   • all other keys forward to modal.surface.onKey(ev) so the PTY
//     receives them without the chat readKey loop trying to
//     interpret them
//
// Kept separate from either renderer so both can use the same routing policy.
//
// P10 will extend this with Ctrl-B prefix handling (d=detach,
// s=switch, etc.) once a session registry exists to act on.

import type { InteractiveTerminalModalHandle } from '../interactive-terminal-modal.js';
import type { KeyEvent } from '../display/types.js';
import { debug } from '../debug/log.js';

export type KeyRouteResult = 'consumed' | 'passthrough' | 'closed';

export interface TerminalModalRouter {
  current(): InteractiveTerminalModalHandle | null;
  /** Install a modal handle. Optional closePolicy controls what
   *  ESC/Ctrl-G does: 'kill' disposes the modal + PTY (default);
   *  'detach' calls handle.dispose({keepPreview:true}) so the PTY
   *  survives for re-attach (session registry flow). An explicit
   *  onClose hook wins over closePolicy — that's how dashboard
   *  wires the owning session registry's detach action on Esc. */
  set(
    handle: InteractiveTerminalModalHandle | null,
    opts?: { closePolicy?: 'kill' | 'detach'; onClose?: () => void },
  ): void;
  close(): void;
  handleKey(ev: KeyEvent): KeyRouteResult;
}

// `exit` typed cleanly + Enter closes the popup. claude / codex don't
// recognize plain `exit` (their command is /exit or /quit), so a user
// typing `exit\n` would otherwise be stuck — the popup stays open
// because the child never exits, and the typed text just becomes chat
// input. elanous intercepts the exact sequence at the router so:
//   • plain shell: same end result (we close before shell evaluates)
//   • claude / codex: popup closes as the user expected
// Sequence is reset on any non-letter key (other than backspace, which
// rewinds), Ctrl/Alt modifiers, or any character outside `e/x/i/t` —
// so genuine words containing "exit" (e.g. typing "exit this loop"
// into a claude prompt without Enter) DON'T trigger the close. The
// trigger is specifically `e`, `x`, `i`, `t`, Enter with nothing else.
const EXIT_CHARS = ['e', 'x', 'i', 't'] as const;

export function createTerminalModalRouter(): TerminalModalRouter {
  let handle: InteractiveTerminalModalHandle | null = null;
  let closePolicy: 'kill' | 'detach' = 'kill';
  let onClose: (() => void) | null = null;
  let exitProgress = 0; // how many of EXIT_CHARS have been typed in order

  const close = (): void => {
    if (!handle) return;
    const h = handle;
    const cb = onClose;
    if (debug.enabled) debug.log('window.terminalModalRouter.close', h.id, { id: h.id, closePolicy, hasOnClose: !!cb });
    handle = null;
    onClose = null;
    exitProgress = 0;
    try {
      if (cb) cb();
      else if (closePolicy === 'detach') h.dispose({ keepPreview: true });
      else h.dispose();
    } catch { /* already disposed */ }
    closePolicy = 'kill';
  };

  return {
    current: () => handle,
    set: (h, opts) => {
      if (handle && h && handle.id !== h.id) close();
      handle = h;
      closePolicy = opts?.closePolicy ?? 'kill';
      onClose = opts?.onClose ?? null;
      exitProgress = 0;
      if (debug.enabled) {
        debug.log('window.terminalModalRouter.set', h?.id ?? '(null)', {
          id: h?.id ?? null,
          closePolicy,
          hasOnClose: !!onClose,
        });
      }
    },
    close,
    handleKey: (ev) => {
      if (!handle) return 'passthrough';
      const name = (ev.name ?? '').toLowerCase();
      // ESC must NOT close the modal — claude / codex inside the popup
      // use ESC to cancel an in-progress chat / tool turn. Closing the
      // wrapper window on ESC made the only-way-to-cancel kill the
      // whole popup. iTerm / ghostty don't close their own windows on
      // ESC either; the wrapper should match. Modal close is reserved
      // for: Ctrl+G (close + focus log), Ctrl+Shift+T (toggle off),
      // typed `exit\n`, and the child's own `exit`. ESC just forwards.
      if (ev.ctrl && (name === 'g' || name === 'ㅎ')) {
        if (debug.enabled) debug.log('window.terminalModalRouter.handleKey.close', 'ctrl-g', { id: handle.id });
        close();
        return 'closed';
      }

      // Track typed `exit` followed by Enter so the user's natural
      // mental model ("type exit to quit") works inside agent popups
      // (claude / codex) where the child app doesn't recognize a bare
      // `exit` command. See EXIT_CHARS comment above for false-positive
      // avoidance.
      const noMods = !ev.ctrl && !ev.alt;
      if (noMods && name === 'enter' && exitProgress === EXIT_CHARS.length) {
        if (debug.enabled) {
          debug.log('window.terminalModalRouter.handleKey.close', 'typed-exit', {
            id: handle.id,
          });
        }
        close();
        return 'closed';
      }
      if (noMods && name === 'backspace') {
        if (exitProgress > 0) exitProgress--;
      } else if (noMods && name.length === 1 && exitProgress < EXIT_CHARS.length && name === EXIT_CHARS[exitProgress]) {
        exitProgress++;
      } else if (noMods && name === 'enter') {
        // Enter without a complete `exit` prefix — reset and forward.
        exitProgress = 0;
      } else if (name.length === 1 || name === 'space' || ev.ctrl || ev.alt) {
        // Any other printable key OR a modifier keystroke breaks the
        // streak. Multi-char named keys (arrow / fn / etc.) leave the
        // streak alone — the child may consume them without affecting
        // the user's typed prompt buffer.
        exitProgress = 0;
      }

      if (debug.enabled) {
        debug.log('window.terminalModalRouter.handleKey.forward', name || '(empty)', {
          id: handle.id,
          name,
          ctrl: ev.ctrl ?? false,
          shift: ev.shift ?? false,
          alt: ev.alt ?? false,
          exitProgress,
        });
      }
      try {
        handle.surface.onKey?.(ev);
      } catch { /* surface disposed mid-event; treat as no-op */ }
      return 'consumed';
    },
  };
}

/** Singleton used by renderers; the factory remains available for isolated tests. */
export const terminalModalRouter = createTerminalModalRouter();
