import type { InternalTurnOrigin } from './internal-turn-origin.js';

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
}

export type StartTurnIfIdleResult =
  | { opened: true; turnId: string }
  | { opened: false; reason: InternalTurnRejectReason; detail?: string };
