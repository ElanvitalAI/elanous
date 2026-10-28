// AskUserQuestion barrel — Phase WF1.

export {
  parseQuestionRequest,
  MAX_QUESTIONS, MAX_OPTIONS_PER_QUESTION, MIN_OPTIONS_PER_QUESTION, MAX_HEADER_LENGTH,
  type Question,
  type QuestionOption,
  type AskUserQuestionRequest,
  type AskUserQuestionResult,
  type AskUserQuestionError,
} from './types.js';

export {
  createAskUserQuestionModal,
  type AskUserQuestionModalSpec,
  type AskUserQuestionModalHandle,
} from './modal.js';

export {
  createInlineAskUserQuestionResolver,
  resolveUnattendedInlineChoiceTimeoutMs,
  UNATTENDED_INLINE_CHOICE_TIMEOUT_MS,
} from './inline-resolver.js';

export {
  buildAskUserQuestionTool, createFileAskUserQuestionResolver, dispatchAskUserQuestion,
  ASK_USER_QUESTION_OBSERVABILITY_CATEGORY,
  setAskUserQuestionDeps, getAskUserQuestionDeps,
  setAskUserQuestionResolver, getAskUserQuestionResolver,
  type AskUserQuestionDeps, type AskUserQuestionDispatchResult,
  type AskUserQuestionDispatchContext,
  type AskUserQuestionResolver,
} from './tool.js';

export {
  subscribeQuestionResult,
  publishQuestionResult,
  _clearQuestionResultListenersForTesting,
} from './events.js';

export {
  getExecutionAskSystemPrompt,
  buildExecutionAskSystemMessages,
} from './system-prompt.js';

export {
  classifyDestructive,
  isGuardianDisabled,
  setGuardianDisabled,
  type GuardianFinding,
  type GuardianSeverity,
} from './guardian.js';
