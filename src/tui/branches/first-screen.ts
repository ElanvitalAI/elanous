import { firstScreenGuidanceLines } from '../../tui-client/first-screen-guidance.js';

export interface NextFirstScreenInput {
  readonly width: number;
  readonly availableRows: number;
  readonly hasMessages: boolean;
  readonly hasActivity: boolean;
  readonly hasNotices: boolean;
  readonly hasDraft: boolean;
  readonly busy: boolean;
}

/** Keep classic's actionable guidance in the empty next TUI without recording it in chat history. */
export function nextFirstScreenLines(input: NextFirstScreenInput): string[] {
  if (input.hasMessages || input.hasActivity || input.hasNotices || input.hasDraft || input.busy) return [];
  if (input.availableRows <= 0) return [];
  // /run-skill is classic-only; select actions before width truncation.
  const guidance = firstScreenGuidanceLines('ko', input.width, { includeSkills: false });
  return guidance.slice(0, input.availableRows);
}
