import type { LLMToolSpec } from '../../llm/tool-spec.js';
// AXON P5 — AnnounceCompletion LLM tool.
//
// The explicit "I'm done" signal. When the LLM calls this, the
// termination detector's factor 7 flips to satisfied and the
// AnnouncementStore captures summary + outcome + nextSteps so the
// caller (loop-prompt renderer, session-end banner, TOX feedback-
// loop) has structured data to close the loop on.
//
// This tool is stateless aside from the store side-effect — it does
// not itself stop any running process. The enclosing runner is
// expected to check `announcementStore.hasAnnounced()` or route
// through `evaluateTermination()` and exit on `shouldTerminate`.


import {
  announcementStore,
  type AnnouncementRecord,
  type CompletionOutcome,
} from '../../axon/announcement-store.js';

export interface AnnounceCompletionArgs {
  summary: string;
  outcome: CompletionOutcome;
  nextSteps?: string[];
  goalSlug?: string;
}

export interface AnnounceCompletionResult {
  ok: boolean;
  announcedAt: number;
  record: AnnouncementRecord;
}

const ALLOWED_OUTCOMES: readonly CompletionOutcome[] = ['success', 'partial', 'failed'];

export function buildAnnounceCompletionTool(): LLMToolSpec {
  return {
    name: 'AnnounceCompletion',
    description:
      "Signal explicit end-of-turn. Use when the goal is met, partially met, or you are unable to proceed. " +
      "Prefer this to an ambient stopReason because the termination detector weighs it higher than structural signals. " +
      "outcome must be 'success' | 'partial' | 'failed'. nextSteps is optional and captured verbatim.",
    parameters: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'Short (1-3 sentences) human-readable synopsis of what was done.',
        },
        outcome: {
          type: 'string',
          enum: [...ALLOWED_OUTCOMES],
          description: "success = goal met; partial = goal advanced but not complete; failed = unable to proceed.",
        },
        nextSteps: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional follow-up items for the next session / the user. Leave empty when nothing is outstanding.',
        },
        goalSlug: {
          type: 'string',
          description: 'Optional scope — the auto-research / TOX goal slug this announcement closes out.',
        },
      },
      required: ['summary', 'outcome'],
    },
  };
}

export async function dispatchAnnounceCompletion(
  args: AnnounceCompletionArgs,
): Promise<AnnounceCompletionResult> {
  if (typeof args.summary !== 'string' || args.summary.length === 0) {
    throw new Error('AnnounceCompletion: summary is required');
  }
  if (typeof args.outcome !== 'string' || !ALLOWED_OUTCOMES.includes(args.outcome as CompletionOutcome)) {
    throw new Error(
      `AnnounceCompletion: outcome must be one of ${ALLOWED_OUTCOMES.join(', ')}`,
    );
  }
  const nextSteps = Array.isArray(args.nextSteps)
    ? args.nextSteps.filter((s): s is string => typeof s === 'string' && s.length > 0)
    : undefined;

  const record = announcementStore.record({
    summary: args.summary,
    outcome: args.outcome as CompletionOutcome,
    ...(nextSteps !== undefined ? { nextSteps } : {}),
    ...(args.goalSlug !== undefined ? { goalSlug: args.goalSlug } : {}),
  });

  return {
    ok: true,
    announcedAt: record.announcedAt,
    record,
  };
}
