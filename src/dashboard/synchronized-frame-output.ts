/**
 * TUI-FLICKER-DRAW-INTEGRATION — one synchronized-output owner per dashboard frame.
 *
 * A dashboard frame is not a single write: the transient-overlay cleanup, the
 * base frame, the coordinator modal overlay, the prompt repaint and the
 * post-frame overlay stamp are flushed one after another. Under tmux each of
 * those flushes is presented on its own, so a tick that rewrites the frame is
 * visible as a flicker. Wrapping the whole compose in DEC synchronized output
 * (`CSI ? 2026 h` … `CSI ? 2026 l`) lets the terminal present the composite
 * frame atomically.
 *
 * The owner is deliberately tiny and synchronous: callers open it, draw, and
 * close it in a `finally` so a throw inside the draw still emits the ESU and
 * the *next* frame is not swallowed by a dangling synchronized-output region.
 *
 * The wrap nests with the display coordinator, which opens the same region
 * around its own flush and whose `onRender` hook is what calls `drawNow()`.
 * `src/display/synchronized-output-region.ts` keeps that single-owner: an
 * inner open contributes no bytes, so the coordinator's overlay + cursor stamp
 * stays inside the one presentation instead of being pushed out by an early
 * inner ESU.
 */

import {
  SYNCHRONIZED_OUTPUT_BEGIN,
  SYNCHRONIZED_OUTPUT_END,
  openSynchronizedOutputRegion,
  synchronizedOutputDisabledByEnv,
} from '../display/synchronized-output-region.js';

export { SYNCHRONIZED_OUTPUT_BEGIN, SYNCHRONIZED_OUTPUT_END };

export interface SynchronizedFrameOutputDeps {
  /** Sink for the control sequences — production passes `process.stdout.write`. */
  write: (chunk: string) => void;
  /**
   * Whether the sink may receive DEC 2026. Defaults to `true`. Production
   * passes `process.stdout.isTTY` so piped/captured output stays
   * byte-identical to what it was before this seam existed.
   */
  supported?: boolean;
  /** Environment escape hatch (`ELANOUS_SYNC_OUTPUT=off`). Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

export interface SynchronizedFrameOutput {
  /** Closes the region. Idempotent — a second call writes nothing. */
  close: () => void;
}

export function beginSynchronizedFrameOutput(
  deps: SynchronizedFrameOutputDeps,
): SynchronizedFrameOutput {
  const region = openSynchronizedOutputRegion();
  const enabled =
    region.outermost && deps.supported !== false && !synchronizedOutputDisabledByEnv(deps.env);
  let closed = false;
  if (enabled) {
    try {
      deps.write(SYNCHRONIZED_OUTPUT_BEGIN);
    } catch (err) {
      region.close();
      throw err;
    }
  }
  return {
    close: () => {
      if (closed) return;
      closed = true;
      if (enabled) deps.write(SYNCHRONIZED_OUTPUT_END);
      region.close();
    },
  };
}
