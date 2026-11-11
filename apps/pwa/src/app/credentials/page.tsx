'use client';

import { useCallback } from 'react';
import { useOptionalNexusClient } from '@/nexus/hooks/use-nexus-context';
import { CredentialVaultView } from './CredentialVaultView';

export default function CredentialsPage(): React.ReactNode {
  const client = useOptionalNexusClient();
  const load = useCallback(() => client!.getCredentialSlots(), [client]);
  if (!client) return <main className="p-8" role="status">넥서스 연결을 기다리고 있습니다.</main>;
  return <CredentialVaultView load={load}
    startOpenRouter={async () => (await client.startOpenRouterOAuth()).authorizationUrl}
    listOpenRouterImports={() => client.listOpenRouterImportCandidates()}
    importOpenRouterCandidate={id => client.importOpenRouterCandidate(id)} />;
}
