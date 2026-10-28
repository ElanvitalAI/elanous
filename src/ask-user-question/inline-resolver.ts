import { InlineChoiceBroker } from '../tui/inline-choice.js';
import { resolveTuiUnattended, type UserConfig } from '../user-config.js';
import type { AskUserQuestionRequest, AskUserQuestionResult } from './types.js';

export const UNATTENDED_INLINE_CHOICE_TIMEOUT_MS = 60_000;

export function resolveUnattendedInlineChoiceTimeoutMs(
  config?: UserConfig,
  env?: NodeJS.ProcessEnv,
): number | undefined {
  return resolveTuiUnattended(config, env) ? UNATTENDED_INLINE_CHOICE_TIMEOUT_MS : undefined;
}

/** Collect an AskUserQuestion request through the shared, non-modal chat-input broker. */
export function createInlineAskUserQuestionResolver(
  broker: InlineChoiceBroker,
  options: { timeoutMs?: () => number | undefined; createId?: () => string } = {},
): (request: AskUserQuestionRequest) => Promise<AskUserQuestionResult> {
  const createId = options.createId ?? (() => `auq-inline:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 7)}`);
  const timeoutMs = options.timeoutMs ?? (() => resolveUnattendedInlineChoiceTimeoutMs());
  return async (request) => {
    const answers: AskUserQuestionResult['answers'] = {};
    const otherText: NonNullable<AskUserQuestionResult['otherText']> = {};
    for (const question of request.questions) {
      const result = await broker.ask({
        id: `${createId()}:${question.id}`,
        question: `${question.header}: ${question.question}`,
        options: question.options.map((option) => ({
          value: option.label,
          label: option.label,
          description: option.description,
        })),
        multiSelect: question.multiSelect,
        includeOther: question.includeOther,
        timeoutMs: timeoutMs(),
      });
      if ('cancelled' in result) return { answers, cancelled: true };
      if (result.otherText !== undefined) {
        answers[question.id] = 'Other';
        otherText[question.id] = result.otherText;
      } else if (question.multiSelect) {
        answers[question.id] = [...result.selected];
      } else {
        answers[question.id] = result.selected[0] ?? '';
      }
    }
    return Object.keys(otherText).length > 0 ? { answers, otherText } : { answers };
  };
}
