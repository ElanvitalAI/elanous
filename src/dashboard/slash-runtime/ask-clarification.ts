import type { SurfaceUx } from '../../agent/surface-ux/types.js';
import type { AskUserQuestionRequest } from '../../ask-user-question/types.js';
import { DASHBOARD_CLARIFICATION_REQUEST } from '../../esc-abort-gate.js';
import type { GoalDocumentClarification } from '../../self-implement/goal-author-clarification.js';
import { getUserConfig, resolveTuiUnattended } from '../../user-config.js';

export const DASHBOARD_CLARIFICATION_TIMEOUT_MS = 60_000;

/**
 * Converts the line-oriented self-dev clarification seam into the existing
 * structured SurfaceUx question contract. A missing, cancelled, or failed
 * surface answer becomes an empty line, which preserves clarification's
 * existing "unanswered → deferred" behavior without exposing answer text to
 * the observation payload emitted by SurfaceUx.
 */
export async function readDashboardAskClarification(
  clarification: GoalDocumentClarification,
  surfaceUx: Pick<SurfaceUx, 'question'> | undefined,
  notify?: (line: string) => void,
  unattended = resolveTuiUnattended(getUserConfig()),
): Promise<string> {
  if (!surfaceUx) return '';
  const request: AskUserQuestionRequest = {
    questions: [{
      id: clarification.questionId,
      header: 'Clarify goal',
      question: clarification.question,
      options: clarification.options.map((option) => ({
        label: option.label,
        description: option.description,
      })),
      includeOther: clarification.includeOther,
    }],
  };
  Object.defineProperty(request, DASHBOARD_CLARIFICATION_REQUEST, { value: true });
  try {
    const pending = surfaceUx.question(request, unattended
      ? { timeoutMs: DASHBOARD_CLARIFICATION_TIMEOUT_MS }
      : undefined);
    const id = clarification.questionId;
    notify?.('하니스가 묻는다 — 창에서 고르거나 Esc 로 답 없이 진행');
    const result = await pending;
    if (!result || result.cancelled) return '';
    const answer = result.answers[id];
    const selectedLabel = Array.isArray(answer) ? answer[0] : answer;
    const optionIndex = clarification.options.findIndex((option) => option.label === selectedLabel);
    if (optionIndex >= 0) return String(optionIndex);
    const other = clarification.includeOther ? result.otherText?.[id]?.trim() : '';
    return other || '';
  } catch {
    return '';
  }
}

