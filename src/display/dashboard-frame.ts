import { render, type RenderOptions } from '../tui.js';
import { paintCursor, type CursorState } from './cursor-state.js';
import type { CursorDecision } from './cursor-owner.js';
import { resolveEssentialFrameCursorDecision, type EssentialFrameCursorDecision } from './essential-frame-cursor.js';

type DashboardFrameRenderer = (lines: string[], options: RenderOptions) => void;

/** One frame write for the classic surface; the rendering contract is shared with simulations. */
export interface DashboardFrameInput {
  overlay: string;
  preserveBounds?: { row: number; col: number; width: number; height: number };
  force: boolean;
  cursorOwner: CursorDecision['owner'];
  claimedCursor: CursorState | null;
  coordinatorCursor?: CursorState | null;
  promptCaret: CursorState | null;
  suppressPromptArea: boolean;
  onEssentialFrameCursorDecision?: (observation: EssentialFrameCursorObservation) => void;
  onFrameWriteComplete?: (error?: Error | null) => void;
}

export interface EssentialFrameCursorObservation {
  caret: CursorState | null;
  cursorOwner: CursorDecision['owner'];
  reason: EssentialFrameCursorDecision['reason'];
  source: EssentialFrameCursorDecision['source'];
  suppressPromptArea: boolean;
}

export interface DashboardEssentialCursorObserverDeps {
  isDebugEnabled: () => boolean;
  log: (category: string, event: string, data: EssentialFrameCursorObservation) => void;
}

export function createDashboardEssentialCursorObserver(deps: DashboardEssentialCursorObserverDeps): (
  observation: EssentialFrameCursorObservation,
) => void {
  let lastKey = '';
  return (observation) => {
    if (!deps.isDebugEnabled()) return;
    const key = JSON.stringify(observation);
    if (key === lastKey) return;
    lastKey = key;
    try { deps.log('cursor.final-decision', 'resolved', observation); }
    catch { /* cursor observation must not affect frame rendering */ }
  };
}

export function renderDashboardFrame(
  lines: string[],
  input: DashboardFrameInput,
  renderFrame: DashboardFrameRenderer = render,
): void {
  const cursorDecisionExists = input.cursorOwner !== 'none';
  const essentialDecision = resolveEssentialFrameCursorDecision({
    claimedCursor: cursorDecisionExists ? input.claimedCursor : null,
    promptCaret: input.promptCaret,
    suppressPromptArea: input.suppressPromptArea,
  });
  renderFrame(lines, {
    overlay: input.overlay,
    preserveBounds: input.preserveBounds,
    force: input.force,
    cursor: paintCursor(essentialDecision.cursor ?? input.coordinatorCursor ?? null),
    onWriteComplete: input.onFrameWriteComplete,
  });
  input.onEssentialFrameCursorDecision?.({
    caret: essentialDecision.cursor,
    cursorOwner: input.cursorOwner,
    reason: essentialDecision.reason,
    source: essentialDecision.source,
    suppressPromptArea: input.suppressPromptArea,
  });
}
