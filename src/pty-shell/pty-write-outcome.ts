import type { PtyControlTarget } from './registry.js';
import type { PtyWriteActor } from './pty-write-arbiter.js';

type PtyWriteOutcome = 'success' | 'denied' | 'write-failed';
export type PtyWriteOutcomeDetail =
  | { readonly status: 'success' }
  | { readonly status: 'denied' }
  | { readonly status: 'write-failed'; readonly reason?: 'tui-busy-text-without-enter' | 'tui-external-input-queue-full' };
type PtyResizeOutcome = 'success' | 'denied' | 'resize-failed';

const EXTERNAL_INPUT_REJECTION_REASONS = new Set([
  'tui-busy-text-without-enter',
  'tui-external-input-queue-full',
]);

/** Detailed write result for command paths that must surface known TUI refusal reasons. */
export function writePtyWithOutcomeDetail(handle: PtyControlTarget, chars: string, actor: PtyWriteActor = 'human'): PtyWriteOutcomeDetail {
  if (!handle.canWrite(actor)) return { status: 'denied' };
  try {
    handle.write(chars, actor);
    return { status: 'success' };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return EXTERNAL_INPUT_REJECTION_REASONS.has(message)
      ? { status: 'write-failed', reason: message as 'tui-busy-text-without-enter' | 'tui-external-input-queue-full' }
      : { status: 'write-failed' };
  }
}

/** Preflights the public write contract while retaining its arbiter enforcement for other callers. */
export function writePtyWithOutcome(handle: PtyControlTarget, chars: string, actor: PtyWriteActor = 'human'): PtyWriteOutcome {
  const result = writePtyWithOutcomeDetail(handle, chars, actor);
  return result.status;
}

/** Gates control-channel resize requests with the same access matrix as input. */
export function resizePtyWithOutcome(handle: PtyControlTarget, cols: number, rows: number, actor: PtyWriteActor = 'human'): PtyResizeOutcome {
  if (!handle.canWrite(actor)) return 'denied';
  try {
    handle.resize(cols, rows);
    return 'success';
  } catch {
    return 'resize-failed';
  }
}
