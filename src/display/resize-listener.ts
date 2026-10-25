// Terminal resize listener — fills the implementation gap for the
// "readKey / mouse / resize" coordinator entry triplet documented in
// CAPABILITIES-display.md §1.3. Before this module no handler was
// attached to `process.stdout.on('resize')`, so a bare terminal
// resize produced a stale paint (old input prompt row + ghost tab
// bar) until the next keystroke triggered a redraw.
//
// Strategy: debounce resize bursts for one frame (16ms), then paint the
// dashboard, prompt, and overlays synchronously inside one atomic output
// block. Transient paint errors do not kill the listener.
//
// (3) TUI-PICKER-RESIZE-SHRINK (#76 · 2026-10-17) — then ask the
// coordinator for one FORCED frame. Steps (1)+(2) bypass the
// coordinator flush, so the prompt chrome repaint in (2) writes the
// input divider straight over the bottom row of an open overlay (the
// slash picker's `╰` sits on the divider row) and nothing re-emits the
// overlay afterwards — the picker lost its bottom border until it was
// closed and reopened. A coordinator frame runs onRender → afterRender
// (chrome) → flushOverlay (modals on top), so the overlay lands last.
// `force` matters: the overlay byte-equality cache would otherwise
// skip a re-emit whose bytes match the last coordinator frame
// (e.g. 80 → 120 → 80 with no coordinator flush in between).
//
// Non-goals (stay out of IDX-1 territory):
//   - Do NOT touch coordinator.flushOverlay cache state directly.
//   - Do NOT reach into chat.ts textInput loop internals.

import { debug } from '../debug/log.js';

const RESIZE_DEBOUNCE_MS = 16;

export interface ResizeListenerDeps {
  draw: (opts?: { force?: boolean }) => void;
  promptCtl: { repaint: () => void };
  /** Request one forced coordinator frame so modal overlays are
   *  re-emitted on top of the chrome the prompt repaint just wrote.
   *  Optional: hosts without a coordinator keep the legacy two-step. */
  requestOverlayFrame?: () => void;
  /** Run the whole resize repaint batch inside the host's atomic output
   *  block. Nested coordinator frames must share this outer block. */
  withSynchronizedOutput?: (paint: () => void) => void;
}

/** Registers the resize listener and returns a dispose fn that
 *  detaches it. Safe to call multiple times — each call attaches a
 *  fresh listener; the caller is responsible for disposing previous
 *  installations. */
export function installResizeListener(deps: ResizeListenerDeps): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const repaint = (): void => {
    timer = undefined;
    if (disposed) return;
    const paint = (): void => {
      try { deps.draw({ force: true }); } catch { /* swallow — paint errors shouldn't break resize */ }
      try { deps.promptCtl.repaint(); } catch { /* swallow */ }
      let overlayFrame: 'requested' | 'absent' | 'failed' = 'absent';
      if (deps.requestOverlayFrame) {
        try {
          deps.requestOverlayFrame();
          overlayFrame = 'requested';
        } catch {
          overlayFrame = 'failed';
        }
      }
      debug.log('display.resize', 'repaint', {
        cols: process.stdout.columns ?? null,
        rows: process.stdout.rows ?? null,
        overlayFrame,
      });
    };
    try {
      if (deps.withSynchronizedOutput) deps.withSynchronizedOutput(paint);
      else paint();
    } catch { /* resize painting must not detach the listener */ }
  };
  const handler = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(repaint, RESIZE_DEBOUNCE_MS);
  };
  process.stdout.on('resize', handler);
  return (): void => {
    disposed = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    process.stdout.removeListener('resize', handler);
  };
}
