/**
 * DECSET 2026 (synchronized output) region registry.
 *
 * Two owners wrap their writes in `CSI ? 2026 h` … `CSI ? 2026 l`: the
 * display coordinator (`flush()`) and the dashboard draw seam
 * (`src/dashboard/synchronized-frame-output.ts`). They nest — the
 * coordinator opens a region and its `onRender` hook runs `drawNow()`,
 * which wants the same wrap for the frame + prompt repaint. A second pair
 * emitted inside the outer one is not harmless: the inner ESU flushes the
 * terminal early, so everything the coordinator writes afterwards (modal
 * overlay, cursor) lands in a separate presentation — exactly the flicker
 * the wrap exists to prevent.
 *
 * The registry makes the wrap re-entrant: whoever opens first owns the
 * byte pair; nested openers contribute no bytes and never close the outer
 * region. Every opener must close its handle (idempotent) so the depth
 * stays balanced even when a draw throws.
 */

export const SYNCHRONIZED_OUTPUT_BEGIN = '\x1b[?2026h';
export const SYNCHRONIZED_OUTPUT_END = '\x1b[?2026l';

export interface SynchronizedOutputRegion {
  /** true when this region owns the emitted BSU/ESU pair. */
  readonly outermost: boolean;
  /** Idempotent — closes this region exactly once. */
  close(): void;
}

let openDepth = 0;

/** True while any owner holds a synchronized-output region open. */
export function isSynchronizedOutputRegionOpen(): boolean {
  return openDepth > 0;
}

/**
 * `ELANOUS_SYNC_OUTPUT=off|0|false` escape hatch for terminals that
 * mishandle DEC 2026. Anything else (including unset) keeps the wrap on.
 */
export function synchronizedOutputDisabledByEnv(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const value = (env.ELANOUS_SYNC_OUTPUT ?? 'on').toLowerCase();
  return value === 'off' || value === '0' || value === 'false';
}

export function openSynchronizedOutputRegion(): SynchronizedOutputRegion {
  const outermost = openDepth === 0;
  openDepth += 1;
  let closed = false;
  return {
    outermost,
    close(): void {
      if (closed) return;
      closed = true;
      if (openDepth > 0) openDepth -= 1;
    },
  };
}
