import { createAbsorbDesignRegistry } from '../absorb-design-provider.js';
import { createDocumentParseRegistry } from './document-parse.js';
import { createMemberStoreRegistry, registerMemberStoreProviders } from './member-store.js';
import { registerAbsorbExtractProvider } from './absorb-extract.js';
import { registerAbsorbBriefNotifyProvider } from './absorb-notify.js';
import type { NotifyCapabilitySend } from './notify.js';
import { registerGraphCapabilityContract, registerGraphCapabilityProviderDeclaration,
  STORE_EVENTS_CONTRACT } from '../capabilities.js';
import { createJsonlMemberEventStore, storeEventsProvider, type MemberEventStore } from '../../nexus/api/member-event-store.js';
import { nexusRootDir } from '../../nexus/paths.js';
import { join } from 'node:path';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Production manifest factories preserve existing guards and add only member-scoped storage. */
export function createAbsorbIngestMemberRegistry() {
  return registerMemberStoreProviders(createDocumentParseRegistry());
}
export function createAbsorbBriefMemberRegistry(send?: NotifyCapabilitySend) {
  return registerAbsorbBriefNotifyProvider(
    registerAbsorbExtractProvider(registerMemberStoreProviders(createAbsorbDesignRegistry())), send);
}
export function createAbsorbReadMemberRegistry() {
  return createMemberStoreRegistry();
}

/** Reuse the Nexus board journal while binding every event to the authenticated graph member. */
export function createAbsorbBuildMemberRegistry(store: MemberEventStore =
  createJsonlMemberEventStore(join(nexusRootDir(), 'member-events'))) {
  const eventProvider = storeEventsProvider(store);
  return registerGraphCapabilityProviderDeclaration(
    registerGraphCapabilityContract(createMemberStoreRegistry(), STORE_EVENTS_CONTRACT), {
      ...eventProvider,
      id: 'absorb-owned-board-events',
      invoke: context => {
        const owner = context.verifiedOwnerId;
        const graphOwner = record(record(context.graphInput ?? context.input).context).memberId;
        const request = record(context.nodeInput ?? context.input);
        if (!owner || graphOwner !== owner || request.memberId !== owner
          || request.operation === 'append' && record(request.event).memberId !== owner)
          return { ok: false, outcome: 'failed', error: 'verified member board event required' };
        return eventProvider.invoke(context);
      },
    });
}
