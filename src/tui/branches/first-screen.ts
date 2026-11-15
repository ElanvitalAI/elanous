import { firstScreenCellWidth, firstScreenGuidanceLines } from '../../tui-client/first-screen-guidance.js';

export interface NextFirstScreenInput {
  readonly width: number;
  readonly availableRows: number;
  readonly hasMessages: boolean;
  readonly hasActivity: boolean;
  readonly hasNotices: boolean;
  readonly hasDraft: boolean;
  readonly busy: boolean;
}

/** Keep concise actionable guidance in the empty next TUI without recording it in chat history. */
export function nextFirstScreenLines(input: NextFirstScreenInput): string[] {
  if (input.hasMessages || input.hasActivity || input.hasNotices || input.hasDraft || input.busy) return [];
  if (input.availableRows <= 0) return [];
  // /run-skill is classic-only; select actions before width truncation.
  const fullGuidance = firstScreenGuidanceLines('en', Number.MAX_SAFE_INTEGER, { includeSkills: false });
  const compact = input.availableRows < fullGuidance.length || fullGuidance.some((line) => firstScreenCellWidth(line) > input.width);
  const guidance = compact
    ? firstScreenGuidanceLines('en', input.width, { includeSkills: false, compact: true })
    : fullGuidance;
  return guidance.slice(0, input.availableRows);
}
