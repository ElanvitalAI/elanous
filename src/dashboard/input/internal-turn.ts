/** Classic dashboard compatibility entry for the shared TUI internal-turn gate. */
export {
  DEFAULT_HUMAN_QUIET_MS,
  isInternalTurnEnabledByEnv,
  createInternalTurnGate,
  resolveInternalTurnSubmitIntent,
  formatInternalTurnBanner,
  consumeInternalTurnYield,
} from '../../tui/input/internal-turn.js';
export type {
  InternalTurnOrigin,
  InternalTurnRejectReason,
  StartTurnIfIdleOptions,
  StartTurnIfIdleResult,
  InternalTurnRequest,
  InternalTurnGateDeps,
  InternalTurnGate,
  InternalTurnConsumeResult,
} from '../../tui/input/internal-turn.js';
