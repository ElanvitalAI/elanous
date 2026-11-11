import type { CursorState } from './cursor-state.js';

export type EssentialFrameCursorSource = 'claim' | 'suppressed' | 'prompt' | 'none';

export interface EssentialFrameCursorDecision {
  cursor: CursorState | null;
  source: EssentialFrameCursorSource;
  reason: 'visible-claim' | 'prompt-area-suppressed' | 'prompt-caret' | 'no-cursor';
}

export interface EssentialFrameCursorInput {
  claimedCursor: CursorState | null;
  promptCaret: CursorState | null;
  suppressPromptArea: boolean;
}

export function resolveEssentialFrameCursorDecision(input: EssentialFrameCursorInput): EssentialFrameCursorDecision {
  if (input.claimedCursor?.visible) return { cursor: input.claimedCursor, source: 'claim', reason: 'visible-claim' };
  if (input.suppressPromptArea) return { cursor: null, source: 'suppressed', reason: 'prompt-area-suppressed' };
  if (input.promptCaret) return { cursor: input.promptCaret, source: 'prompt', reason: 'prompt-caret' };
  return { cursor: null, source: 'none', reason: 'no-cursor' };
}

export function resolveEssentialFrameCursor(input: EssentialFrameCursorInput): CursorState | null {
  return resolveEssentialFrameCursorDecision(input).cursor;
}
