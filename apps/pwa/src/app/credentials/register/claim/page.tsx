'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useOptionalNexusClient } from '@/nexus/hooks/use-nexus-context';
import { CredentialClaimView } from './CredentialClaimView';

export default function CredentialClaimPage(): React.ReactNode {
  const client = useOptionalNexusClient();
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const tokenCaptured = useRef(false);
  const claimRequest = useRef<{ token: string; promise: ReturnType<NonNullable<typeof client>['claimCredentialRegistrationLink']> } | null>(null);
  useEffect(() => {
    if (tokenCaptured.current) return;
    tokenCaptured.current = true;
    const fragmentToken = new URLSearchParams(window.location.hash.slice(1)).get('t');
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    setToken(fragmentToken || null);
  }, []);
  const claimLink = useCallback((requestToken: string) => {
    if (!client) return Promise.reject(new Error('넥서스 연결을 기다리고 있습니다.'));
    if (claimRequest.current?.token === requestToken) return claimRequest.current.promise;
    const promise = client.claimCredentialRegistrationLink(requestToken);
    claimRequest.current = { token: requestToken, promise };
    void promise.catch(() => { if (claimRequest.current?.promise === promise) claimRequest.current = null; });
    return promise;
  }, [client]);
  const register = useCallback(async (slot: string, bearer: string, value: string) => {
    if (!client) throw new Error('넥서스 연결을 기다리고 있습니다.');
    try { return await client.submitCredentialRegistration(slot, bearer, value); }
    finally { claimRequest.current = null; }
  }, [client]);
  if (token === undefined) return <main className="p-8" role="status">일회용 등록 링크를 확인하고 있습니다.</main>;
  if (!token) return <main className="p-8" role="alert">링크가 없습니다. 소유자 화면에서 새 QR을 만들어 주세요.</main>;
  return <CredentialClaimView token={token} claimLink={claimLink} register={register} clientAvailable={client !== null} />;
}
