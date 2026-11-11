/** Classic dashboard compatibility entry for the shared TUI goal-continue policy. */
export {
  classifyReplyTail,
  replyTailFromLines,
  GOAL_CONTINUE_ENV,
  DEFAULT_GOAL_CONTINUE_CAP,
  goalContinueFingerprint,
  replyLinesOfThisTurn,
  formatGoalContinuePrompt,
  isGoalContinueEnabledByEnv,
  createGoalContinue,
} from '../../tui/input/goal-continue.js';
export type {
  GoalContinueVerdict,
  GoalContinueDeps,
  GoalContinueTurnEnd,
  GoalContinueController,
} from '../../tui/input/goal-continue.js';
