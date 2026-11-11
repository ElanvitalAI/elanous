import { createOutboundGuardSim, type OutboundGuardDecision, type OutboundGuardObservation, type OutboundGuardProvenance } from '../ux-sim/outbound-guard-sim.js';
import { runMsgMirrorTick, type MsgMirrorTickOptions, type MsgMirrorTickResult } from './msg-mirror-runner.js';

/** Runs the real mirror decision path with an injected transport, after the I2 guard. */
export async function runGuardedMsgMirrorWorld(
  provenance: OutboundGuardProvenance | undefined,
  options: MsgMirrorTickOptions,
): Promise<{ decision: OutboundGuardDecision; result?: MsgMirrorTickResult; observations: OutboundGuardObservation[] }> {
  const guard = createOutboundGuardSim();
  const decision = guard.attempt(provenance, { kind: 'msg-mirror-github', id: 'mirror-tick' }, () => {});
  if (!decision.allowed) return { decision, observations: guard.observations() };
  const result = await runMsgMirrorTick(options);
  return { decision, result, observations: guard.observations() };
}
