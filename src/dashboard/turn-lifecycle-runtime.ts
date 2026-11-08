import type { LLMToolSpec } from '../llm/tool-spec.js';

import type { SearchPlannerState } from '../session-runtime/index.js';
import type { SessionTurnProfile } from '../session-runtime/index.js';

export interface DashboardAcpTurnRef {
  abortCtrl: AbortController | null;
  userText: string | null;
  turnProfile: SessionTurnProfile | null;
  searchPlannerState: SearchPlannerState | null;
  optionalSpecs: readonly LLMToolSpec[];
}

export function createDashboardAcpTurnRef(): DashboardAcpTurnRef {
  return {
    abortCtrl: null,
    userText: null,
    turnProfile: null,
    searchPlannerState: null,
    optionalSpecs: [],
  };
}

export function armDashboardAcpTurnRef(
  ref: DashboardAcpTurnRef,
  deps: {
    abortCtrl: AbortController;
    userText: string;
    turnProfile: SessionTurnProfile;
    searchPlannerState: SearchPlannerState;
    optionalSpecs: readonly LLMToolSpec[];
  },
): void {
  ref.abortCtrl = deps.abortCtrl;
  ref.userText = deps.userText;
  ref.turnProfile = deps.turnProfile;
  ref.searchPlannerState = deps.searchPlannerState;
  ref.optionalSpecs = deps.optionalSpecs;
}

export function resetDashboardAcpTurnRef(
  ref: DashboardAcpTurnRef,
): void {
  ref.abortCtrl = null;
  ref.userText = null;
  ref.turnProfile = null;
  ref.searchPlannerState = null;
  ref.optionalSpecs = [];
}

export function finalizeDashboardStreamLifecycle(
  cleanupEsc: () => void,
  aborted: boolean,
  finalStatus: 'completed' | 'interrupted' | 'failed',
): 'completed' | 'interrupted' | 'failed' {
  cleanupEsc();
  return aborted ? 'interrupted' : finalStatus;
}
