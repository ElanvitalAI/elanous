// ── In-log thinking indicator ──
//
// Animated "✢ Thinking…" line that lives INSIDE chatLines (the log
// buffer) instead of at a fixed terminal row. Replaces the older
// startSpinner(row, col, text) pattern which wrote to an absolute
// row and collided with the pinned 3-row status bar reserved at
// termRows-2/-1/0.
//
// Pattern inspired by Claude Code's inline thread display:
//
//     * Reusing…  (2m 4s · ↓ 1.7k tokens · thought for 26s)
//
// The caller owns chatLines[] and a `draw` function. We push one
// line and mutate it in-place every ~120ms on a timer. stop() removes
// the line (or replaces it with a final "done" marker).
//
// When the caller truncates chatLines (e.g. dashboard's streaming
// replace-in-place path), the thinking line re-appends itself at the
// new end on the next tick so it stays visible until explicitly
// stopped.

import { C } from './tui.js';
import { FIGURES, applyColor } from './render.js';

const GLYPHS = ['✢', '✳', '✶', '✻', '✽', '·'];
// 200 ms = 5 Hz. Previously 120 ms (~8 Hz), but each tick triggers a
// full dashboard redraw via onFrame → draw() and during a sub-agent
// batch every redraw also re-scans every task's message history and
// re-writes ~60 rows of ANSI to the terminal. At 5 Hz the spinner is
// still visually smooth (humans can't distinguish 5/8 Hz twinkles in
// peripheral vision) and the background cost drops ~40%.
const INTERVAL_MS = 200;

export interface ThinkingMetrics {
  /** ms timestamp when the turn started; elapsed derived from it. */
  startedAt?: number;
  /** Input tokens sent to the provider for this turn. */
  inputTokens?: number;
  /** Output tokens produced so far (during stream). */
  outputTokens?: number;
  /** Seconds the model claims to have "thought" (reasoning trace time,
   *  when the provider exposes it). */
  thoughtSec?: number;
  /** Compact TRUE-execution badge — the engine/model that actually ran
   *  this turn (self `🧠 terra(high)` vs delegate `🤖 acp-codex`), so the
   *  completion line surfaces the real backend instead of the config
   *  original (self-cognition §1 — kills the "config=opus but codex ran"
   *  illusion). Pre-rendered by the caller (route-decision aware); the
   *  thinking line stays dumb and just paints it as the last detail. */
  engine?: string;
  /** Live-only instruction shown after every other detail. */
  hint?: string;
}

/** Terminal state for the thinking line. The line STAYS in chatLines
 *  after stop() — colored to show the outcome — so the log grows top-
 *  to-bottom: older completed/interrupted items scroll up, the
 *  currently-active one stays at the bottom (animated). Matches the
 *  Claude-Code reference behavior the user asked to mirror. */
export type ThinkingStatus = 'completed' | 'interrupted' | 'failed';

export interface ThinkingHandle {
  /** Change the verb ("Thinking" → "Streaming" → "Compacting"). */
  update(msg: string): void;
  /** Change the verb to a frame-derived message. The factory is
   *  called on every animation paint, so callers can embed a scanner
   *  or other low-cost status animation without starting a second
   *  timer. Calling update() clears this factory. */
  updateAnimated(factory: (frame: number) => string): void;
  /** Patch the inline metrics parenthetical. */
  updateMetrics(m: Partial<ThinkingMetrics>): void;
  /** Force a re-render immediately, obeying the sticky policy. Hosts
   *  call this after mutating chatLines (e.g. pushing streamed content)
   *  so the indicator relocates to the tail without waiting for the
   *  next animation tick. No-op when stopped. */
  reflow(): void;
  /** Stop the animation and FREEZE the line in place with a status-
   *  colored marker. Default status is 'completed' (green ✓). On
   *  'interrupted' the line keeps red ✗. 'failed' → red ✗ with
   *  optional errorText appended. The line is never spliced from
   *  chatLines — the log keeps the history visible as new turns
   *  accumulate below. */
  stop(opts?: {
    status?: ThinkingStatus;
    finalText?: string;
    errorText?: string;
  }): void;
}

export interface StartThinkingOpts {
  chatLines: string[];
  /** Called whenever the line is mutated so the host can redraw. */
  onFrame: () => void;
  message?: string;
  metrics?: ThinkingMetrics;
  /** Animation interval in ms. Default 120. Tests pass 0 for none. */
  intervalMs?: number;
  /** When 'tail', the indicator re-anchors itself to the LAST row of
   *  chatLines on every tick — so pushing streamed content after it
   *  makes it "fall through" to the new bottom instead of getting
   *  buried mid-log. Matches Claude Code's "cursor follows output"
   *  pattern. Default 'anchor' (fixed at the index where the line
   *  was first pushed).
   *  NOTE: 'tail' has ordering subtleties when the host also
   *  truncates chatLines (e.g. renderStreaming resetting to
   *  assistantStart). For that flow prefer `startPinnedThinking`
   *  which keeps the indicator OUT of chatLines entirely. */
  sticky?: 'anchor' | 'tail';
}

/** Same metrics/status/finalText semantics as startThinking, but the
 *  rendered line is written to an external string ref instead of being
 *  pushed into chatLines. The log-pane renderer reads the ref and
 *  paints it as a footer row pinned below the tail-following log
 *  body — which is what Claude Code does: the status line is its own
 *  zone, not mixed into the transcript. */
export interface StartPinnedThinkingOpts {
  /** Mutable ref: `null` means no line rendered; otherwise the current
   *  frame string. The owner clears it back to `null` after stop() if
   *  the history shouldn't keep the final marker. */
  target: { current: string | null };
  onFrame: () => void;
  message?: string;
  metrics?: ThinkingMetrics;
  intervalMs?: number;
}

/** Format seconds as "Xs" / "Xm Ys" / "Xh Ym". Matches status-bar
 *  elapsedSegment for visual consistency between surfaces. */
export function fmtTime(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function renderLine(
  glyph: string,
  message: string,
  metrics: ThinkingMetrics,
): string {
  const now = Date.now();
  const elapsed = metrics.startedAt ? Math.round((now - metrics.startedAt) / 1000) : 0;
  const detail: string[] = [];
  if (elapsed > 0) detail.push(fmtTime(elapsed));
  if (metrics.outputTokens != null && metrics.outputTokens > 0) {
    const k = metrics.outputTokens / 1000;
    detail.push(`↓ ${k >= 1 ? k.toFixed(1) + 'k' : metrics.outputTokens} tokens`);
  }
  if (metrics.thoughtSec != null && metrics.thoughtSec > 0) {
    detail.push(`thought for ${fmtTime(metrics.thoughtSec)}`);
  }
  if (metrics.engine) detail.push(metrics.engine);
  if (metrics.hint) detail.push(metrics.hint);
  const tail = detail.length ? '  ' + C.muted('(' + detail.join(' · ') + ')') : '';
  return `${applyColor(glyph, 'claude')} ${C.muted(message + '…')}${tail}`;
}

function stoppedMessage(message: string, status: ThinkingStatus): string {
  const taskName = message.replace(/^(?:Streaming|Thinking)(?=\b|…)(?:\s*…)?\s*/, '').trim();
  const task = taskName ? `${taskName} ` : '';
  if (status === 'completed') return `${task}완료`;
  if (status === 'interrupted') return `${task}중단됨`;
  return `${task}실패`;
}

export function startThinking(opts: StartThinkingOpts): ThinkingHandle {
  let message = opts.message ?? 'Thinking';
  let messageFactory: ((frame: number) => string) | null = null;
  let metrics: ThinkingMetrics = { startedAt: Date.now(), ...opts.metrics };
  let frame = 0;
  let lineIndex = opts.chatLines.length;
  let stopped = false;
  opts.chatLines.push(renderLine(GLYPHS[0], message, metrics));

  const sticky = opts.sticky ?? 'anchor';
  const tick = (): void => {
    if (stopped) return;
    const currentMessage = messageFactory ? messageFactory(frame) : message;
    const rendered = renderLine(GLYPHS[frame % GLYPHS.length], currentMessage, metrics);
    if (sticky === 'tail') {
      // Always re-land at the current tail. Remove the old entry if it
      // still exists in the array, then push fresh — this way streaming
      // content pushed BEFORE this tick lands above us, and we stay
      // pinned at chatLines[length-1]. Simple overwrite at lineIndex
      // would place us mid-log, which was the prior bug.
      if (lineIndex >= 0 && lineIndex < opts.chatLines.length) {
        opts.chatLines.splice(lineIndex, 1);
      }
      lineIndex = opts.chatLines.length;
      opts.chatLines.push(rendered);
    } else {
      // 'anchor': keep the original index, only re-append if the host
      // truncated past us (streaming flow).
      if (lineIndex >= opts.chatLines.length) {
        lineIndex = opts.chatLines.length;
        opts.chatLines.push(rendered);
      } else {
        opts.chatLines[lineIndex] = rendered;
      }
    }
    frame++;
    opts.onFrame();
  };

  const interval = opts.intervalMs ?? INTERVAL_MS;
  const timer = interval > 0 ? setInterval(tick, interval) : null;
  // Initial render already happened via push(); first tick will
  // re-render on the next interval.

  return {
    update: (m) => { message = m; messageFactory = null; },
    updateAnimated: (fn) => { messageFactory = fn; },
    updateMetrics: (m) => { metrics = { ...metrics, ...m }; },
    reflow: () => { if (!stopped) tick(); },
    stop: (stopOpts) => {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);

      const status = stopOpts?.status ?? 'completed';
      const elapsed = metrics.startedAt
        ? fmtTime((Date.now() - metrics.startedAt) / 1000) : '';
      const detail: string[] = [];
      if (elapsed) detail.push(elapsed);
      if (metrics.outputTokens && metrics.outputTokens > 0) {
        const k = metrics.outputTokens / 1000;
        detail.push(`↓ ${k >= 1 ? k.toFixed(1) + 'k' : metrics.outputTokens} tokens`);
      }
      if (metrics.engine) detail.push(metrics.engine);
      const tail = detail.length ? '  ' + C.muted('(' + detail.join(' · ') + ')') : '';
      let finalText: string;
      if (stopOpts?.finalText !== undefined) {
        finalText = stopOpts.finalText;
      } else {
        const currentMessage = messageFactory ? messageFactory(frame) : message;
        const label = stoppedMessage(currentMessage, status);
        if (status === 'completed') {
          finalText = `${applyColor(FIGURES.TICK, 'success')} ${C.success(label)}${tail}`;
        } else if (status === 'interrupted') {
          finalText = `${applyColor(FIGURES.CROSS, 'error')} ${C.warning(label)}${tail}`;
        } else {
          const err = stopOpts?.errorText ? ` — ${stopOpts.errorText}` : '';
          finalText = `${applyColor(FIGURES.CROSS, 'error')} ${C.error(label + err)}${tail}`;
        }
      }

      // Freeze at tail if sticky='tail' — the indicator was tracking
      // the bottom; its stop marker should land at the current bottom
      // too (same splice+push pattern as tick). For 'anchor', leave at
      // the original index so the log keeps a stable record of when
      // this turn happened.
      if (sticky === 'tail') {
        if (lineIndex >= 0 && lineIndex < opts.chatLines.length) {
          opts.chatLines.splice(lineIndex, 1);
        }
        lineIndex = opts.chatLines.length;
        opts.chatLines.push(finalText);
      } else {
        const atIndex = lineIndex < opts.chatLines.length;
        if (atIndex) opts.chatLines[lineIndex] = finalText;
        else opts.chatLines.push(finalText);
      }
      opts.onFrame();
    },
  };
}

/** Pinned variant — writes to an external ref, never touches chatLines.
 *  Use for the chat indicator that should sit BELOW the log's tail
 *  (and below streamed content) as a fixed footer row. Matches Claude
 *  Code's "status line is its own zone" layout. */
export function startPinnedThinking(opts: StartPinnedThinkingOpts): ThinkingHandle {
  let message = opts.message ?? 'Thinking';
  let messageFactory: ((frame: number) => string) | null = null;
  let metrics: ThinkingMetrics = { startedAt: Date.now(), ...opts.metrics };
  let frame = 0;
  let stopped = false;

  const paint = () => {
    const currentMessage = messageFactory ? messageFactory(frame) : message;
    opts.target.current = renderLine(
      GLYPHS[frame % GLYPHS.length], currentMessage, metrics,
    );
  };
  paint();

  const tick = (): void => {
    if (stopped) return;
    frame++;
    paint();
    opts.onFrame();
  };

  const interval = opts.intervalMs ?? INTERVAL_MS;
  const timer = interval > 0 ? setInterval(tick, interval) : null;

  return {
    update: (m) => { message = m; messageFactory = null; paint(); opts.onFrame(); },
    updateAnimated: (fn) => { messageFactory = fn; paint(); opts.onFrame(); },
    updateMetrics: (m) => { metrics = { ...metrics, ...m }; paint(); opts.onFrame(); },
    reflow: () => { if (!stopped) paint(); opts.onFrame(); },
    stop: (stopOpts) => {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);

      const status = stopOpts?.status ?? 'completed';
      const elapsed = metrics.startedAt
        ? fmtTime((Date.now() - metrics.startedAt) / 1000) : '';
      const detail: string[] = [];
      if (elapsed) detail.push(elapsed);
      if (metrics.outputTokens && metrics.outputTokens > 0) {
        const k = metrics.outputTokens / 1000;
        detail.push(`↓ ${k >= 1 ? k.toFixed(1) + 'k' : metrics.outputTokens} tokens`);
      }
      if (metrics.engine) detail.push(metrics.engine);
      const tail = detail.length ? '  ' + C.muted('(' + detail.join(' · ') + ')') : '';
      let finalText: string;
      if (stopOpts?.finalText !== undefined) {
        finalText = stopOpts.finalText;
      } else {
        const currentMessage = messageFactory ? messageFactory(frame) : message;
        const label = stoppedMessage(currentMessage, status);
        if (status === 'completed') {
          finalText = `${applyColor(FIGURES.TICK, 'success')} ${C.success(label)}${tail}`;
        } else if (status === 'interrupted') {
          finalText = `${applyColor(FIGURES.CROSS, 'error')} ${C.warning(label)}${tail}`;
        } else {
          const err = stopOpts?.errorText ? ` — ${stopOpts.errorText}` : '';
          finalText = `${applyColor(FIGURES.CROSS, 'error')} ${C.error(label + err)}${tail}`;
        }
      }
      opts.target.current = finalText;
      opts.onFrame();
    },
  };
}
