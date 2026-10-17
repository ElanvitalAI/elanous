// Terminal resize listener — fills the implementation gap for the
// "readKey / mouse / resize" coordinator entry triplet documented in
// CAPABILITIES-display.md §1.3. Before this module no handler was
// attached to `process.stdout.on('resize')`, so a bare terminal
// resize produced a stale paint (old input prompt row + ghost tab
// bar) until the next keystroke triggered a redraw.
//
// Strategy: on every stdout resize event, (1) push a forced dashboard
// redraw and (2) invoke the prompt's repaint hook so input-mode
// overlays catch up too. Both calls are wrapped in try/catch so a
// transient paint error doesn't kill the listener.
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

export interface ResizeListenerDeps {
  draw: (opts?: { force?: boolean }) => void;
  promptCtl: { repaint: () => void };
  /** Request one forced coordinator frame so modal overlays are
   *  re-emitted on top of the chrome the prompt repaint just wrote.
   *  Optional: hosts without a coordinator keep the legacy two-step. */
  requestOverlayFrame?: () => void;
}

/** Registers the resize listener and returns a dispose fn that
 *  detaches it. Safe to call multiple times — each call attaches a
 *  fresh listener; the caller is responsible for disposing previous
 *  installations. */
export function installResizeListener(deps: ResizeListenerDeps): () => void {
  const handler = (): void => {
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
  process.stdout.on('resize', handler);
  return (): void => {
    process.stdout.removeListener('resize', handler);
  };
}
