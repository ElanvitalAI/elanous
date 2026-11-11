import { createOutboundGuardSim, type OutboundGuardDecision, type OutboundGuardObservation, type OutboundGuardProvenance } from '../ux-sim/outbound-guard-sim.js';
import { emitReleaseStageTransition, type ReleaseStageMailInput } from './stage-mail.js';

/** Replays a release transition through the real stage-mail gate with a fake mailbox sink. */
export function runGuardedReleaseStageWorld(
  provenance: OutboundGuardProvenance | undefined,
  input: ReleaseStageMailInput,
  emit: (mail: ReleaseStageMailInput) => void,
): { decision: OutboundGuardDecision; delivered: boolean; observations: OutboundGuardObservation[] } {
  const guard = createOutboundGuardSim();
  let delivered = false;
  const decision = guard.attempt(provenance, { kind: 'release-stage-mail', id: `${input.runId}:${input.nodeId}:${input.state}` }, () => {
    delivered = emitReleaseStageTransition('release-loop', false, input, emit);
  });
  return { decision, delivered, observations: guard.observations() };
}
