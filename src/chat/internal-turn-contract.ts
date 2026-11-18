import type { InternalTurnOrigin } from './internal-turn-origin.js';
import type { MessageSource } from '../session/index.js';

/** Shared contract for callers of the classic internal-turn gate. */
export type InternalTurnRejectReason =
  | 'NotIdle'
  | 'HumanTyping'
  | 'Superseded'
  | 'Disabled'
  | 'Cap';

export interface StartTurnIfIdleOptions {
  origin: InternalTurnOrigin;
  reason?: string;
  expectedPrevTurnId?: string;
  capReached?: boolean;
  /**
   * MSG-SOURCE-HIERARCHY: the agent seat this turn delivers for (a structured field — never read from the text).
   * Only `kind: 'agent'` is carried; absent = the harness itself (system · `origin`).
   */
  from?: MessageSource;
}

export type StartTurnIfIdleResult =
  | { opened: true; turnId: string }
  | { opened: false; reason: InternalTurnRejectReason; detail?: string;
      /** ELN-SEAT-TURN-PACING: when a paced rejection may be retried (epoch ms). Absent = wait for a new event (mail, child, person). */
      retryAt?: number };
