/** The emergency lane stays disabled until run-bound eligibility evidence is implemented. */

export interface EmergencyPublishSwitchDecision {
  action: 'stay-normal';
  eligible: false;
  promoted: false;
  normalRunId: string;
  hotfixCommit: null;
  reasons: ['emergency-publish-disabled-by-default'];
  evidence: { normalGateOutcome: string };
}

/** Graph wiring is present, but caller-provided run inputs cannot enable the emergency lane. */
export function decideEmergencyPublishSwitch(normalRunId: string, normalGateOutcome: string): EmergencyPublishSwitchDecision {
  return {
    action: 'stay-normal',
    eligible: false,
    promoted: false,
    normalRunId,
    hotfixCommit: null,
    reasons: ['emergency-publish-disabled-by-default'],
    evidence: { normalGateOutcome },
  };
}
