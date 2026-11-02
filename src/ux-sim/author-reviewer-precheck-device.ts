import type { LLMMessage, streamLLM as StreamLLM } from '../llm.js';
import { executeGoalAuthorReviewerPrecheck, runGoalAuthorReviewerPrecheck } from '../self-implement/goal-author.js';
import { getUserConfig } from '../user-config.js';
import { debug } from '../debug/log.js';

export type AuthorReviewerPrecheckVariant = 'applied' | 'rejected-unprovable';
export interface AuthorReviewerPrecheckDeviceResult {
  status: 'skipped' | 'completed' | 'rejected-soft' | 'failed-soft';
  originalDocument: string;
  revisedDocument: string;
  appliedFixes: string[];
  unappliedItems: string[];
}

const ORIGINAL_ASK = 'The result has a measurable criterion and an observable source.';
const UNSUPPORTED_FIX = 'Add an unsupported requirement absent from the original ask.';

export function reviewerPrecheckFixtureDocument(): string {
  return [
    'Reviewable goal',
    '- GoalId: 1234567890abcdef',
    '- RootIntent: preserve measurable authoring',
    '- GoalType: implement',
    '', '## PROBLEM', '- The current goal needs clearer acceptance.',
    '', '## WHAT TO BUILD', '- Make the goal measurable.',
    'Original ask (verbatim, unmodified):', '```text', '대상 경로: src/self-implement/goal-author.ts', ORIGINAL_ASK, '```',
    '', '## ACCEPTANCE CRITERIA', '- The result has a measurable criterion.',
    '', '## REQUIRED EVIDENCE', '- [requested] focused test output',
    '', '## TRACED PATHS', '- src/self-implement/goal-author.ts — author entrypoint',
    '', '## SCOPE BOUNDARY', '- 대상 경로: src/self-implement/goal-author.ts',
    '', '## 답하지 못하는 것', '- No unresolved questions.',
    '', '## 불변식', '- The original ask remains verbatim.',
    '', '## 판정 신호', '- Condition: the authoring result is reviewed', '- Observation: revised acceptance is present', '- Expected result: the criterion is measurable.',
  ].join('\n');
}

function fakeLlmResponse(document: string, variant: AuthorReviewerPrecheckVariant): string {
  const sentence = variant === 'applied' ? ORIGINAL_ASK : UNSUPPORTED_FIX;
  const originalText = '- The result has a measurable criterion.';
  const revisedText = `${originalText}\n- ${sentence}`;
  return JSON.stringify({
    suggestions: [],
    fixes: [sentence],
    fixEvidence: [{ fix: sentence, originalText, revisedText }],
    remainingNeedsHuman: [],
    revisedDocument: document.replace(originalText, revisedText),
  });
}

/** Uses the real reviewer parser/validator and its real event writer, with the only model boundary faked. */
export async function runAuthorReviewerPrecheckDevice(
  runId: string,
  variant: AuthorReviewerPrecheckVariant,
): Promise<AuthorReviewerPrecheckDeviceResult> {
  const document = reviewerPrecheckFixtureDocument();
  const config = getUserConfig();
  const stream: typeof StreamLLM = async (messages: LLMMessage[], _onChunk, options = {}) => {
    if (messages.length !== 1 || !String(messages[0]?.content).includes(document)) {
      throw new Error('fake reviewer received an unexpected request');
    }
    options.onResolvedProvider?.('openai-codex', 'gpt-6.1-terra');
    return fakeLlmResponse(document, variant);
  };
  const result = await executeGoalAuthorReviewerPrecheck(
    true,
    document,
    runId,
    (candidate) => runGoalAuthorReviewerPrecheck(candidate, { config, stream }),
    (event, data) => debug.log('author.reviewer-precheck', event, { ...data, runId }),
  );
  return {
    status: result.status,
    originalDocument: document,
    revisedDocument: result.result?.revisedDocument ?? document,
    appliedFixes: result.result?.appliedFixes ?? [],
    unappliedItems: result.result?.unappliedItems ?? [],
  };
}
