'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useOptionalNexusClient } from '@/nexus/hooks/use-nexus-context';
import { CredentialRegisterView } from './CredentialRegisterView';

export default function CredentialRegisterPage(): React.ReactNode {
  const client = useOptionalNexusClient();
  const [slotId, setSlotId] = useState<string | null>(null);
  useEffect(() => { setSlotId(new URLSearchParams(window.location.search).get('slot') ?? ''); }, []);
  const hasClient = useRef(false);
  if (client) hasClient.current = true;
  const load = useCallback(() => client ? client.getCredentialSlots() : Promise.reject(new Error('Nexus unavailable')), [client]);
  const createLink = useCallback((slot: string) => client ? client.createCredentialRegistrationLink(slot) : Promise.reject(new Error('Nexus unavailable')), [client]);
  const revokeLink = useCallback((token: string) => client ? client.revokeCredentialRegistrationLink(token) : Promise.reject(new Error('Nexus unavailable')), [client]);
  if (!hasClient.current || slotId === null) return <main className="p-8" role="status">넥서스 연결을 기다리고 있습니다.</main>;
  return <CredentialRegisterView slotId={slotId} load={load} createLink={createLink} revokeLink={revokeLink} clientAvailable={client !== null} />;
}
