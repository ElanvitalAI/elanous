import { registerGraphCapabilityContract, registerGraphCapabilityProviderDeclaration,
  type GraphCapabilityRegistry, type GraphContractId } from '../capabilities.js';
import { consumeAppBuildSupervisorFailure } from '../app-build/supervisor-consumer.js';
import { S2_GRAPH_IDENTITY } from '../app-build/s2-declaration-rules.js';

export const APP_BUILD_SUPERVISOR_CONTRACT: GraphContractId = 'app-build.supervisor-correct@1';

/** Opt in only the S2 manifest route; this provider cannot choose arbitrary edges. */
export function registerAppBuildSupervisorProvider(base: GraphCapabilityRegistry): GraphCapabilityRegistry {
  const withContract = registerGraphCapabilityContract(base, {
    id: APP_BUILD_SUPERVISOR_CONTRACT,
    input: { type: 'object' }, output: { type: 'object' },
  });
  return registerGraphCapabilityProviderDeclaration(withContract, {
    id: 'app-build-supervisor-correct', provides: [APP_BUILD_SUPERVISOR_CONTRACT], tier: 'free',
    invoke: async context => {
      if (context.graphId !== S2_GRAPH_IDENTITY.graphId || context.nodeId !== S2_GRAPH_IDENTITY.supervisorNodeId
        || context.requires !== APP_BUILD_SUPERVISOR_CONTRACT)
        return { ok: false, outcome: 'failed', error: 'SUPERVISOR_CONTRACT_MISMATCH' };
      const decision = consumeAppBuildSupervisorFailure(context);
      if (decision.decision === 'failed')
        return { ok: false, outcome: 'failed', error: decision.reasonCode, result: decision };
      if (!decision.graphCorrection || decision.outcome !== decision.graphCorrection.correctionRole)
        return { ok: false, outcome: 'failed', error: 'SUPERVISOR_ROLE_MISMATCH' };
      return { ok: true, outcome: decision.outcome, result: decision };
    },
  });
}
