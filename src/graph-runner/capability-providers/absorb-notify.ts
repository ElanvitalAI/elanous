import {
  registerGraphCapabilityContract,
  registerGraphCapabilityProviderDeclaration,
  type GraphCapabilityRegistry,
} from '../capabilities.js';
import {
  createNotifyCapabilityProvider,
  NOTIFY_CHANNEL_CONTRACT,
  type NotifyCapabilitySend,
} from './notify.js';

function row(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Bind the shared outbound transport to the verified member's persisted briefing. */
export function registerAbsorbBriefNotifyProvider(
  registry: GraphCapabilityRegistry,
  send?: NotifyCapabilitySend,
): GraphCapabilityRegistry {
  const notify = createNotifyCapabilityProvider(send);
  return registerGraphCapabilityProviderDeclaration(
    registerGraphCapabilityContract(registry, NOTIFY_CHANNEL_CONTRACT),
    {
      id: 'absorb-member-brief-notify', provides: [NOTIFY_CHANNEL_CONTRACT.id], tier: 'byok',
      invoke: context => {
        const owner = context.verifiedOwnerId;
        const graphOwner = row(row(context.graphInput ?? context.input).context).memberId;
        const briefingId = row(row(row(context.outputs.brief).evidence).briefing).id;
        const message = row(context.nodeInput);
        if (!owner || graphOwner !== owner || typeof briefingId !== 'string' || !briefingId
          || message.refId !== briefingId)
          return { ok: false, outcome: 'failed', error: 'verified member briefing required' };
        return notify(context);
      },
    },
  );
}
