'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';

type Claim = { slot: string; label: string; setupUrl: string; bearer: string; expiresAt: number };
type ViewState = 'claiming' | 'waiting' | 'ready' | 'saving' | 'saved' | 'invalid' | 'error';

/** Phone-side claim: the route removes the fragment before the Nexus client is needed. */
export function CredentialClaimView({ token, claimLink, register, clientAvailable = true }: {
  token: string;
  claimLink: (token: string) => Promise<Claim>;
  register: (slot: string, bearer: string, value: string) => Promise<{ saved: true; slot: string; verification: 'verified' }>;
  clientAvailable?: boolean;
}): React.ReactNode {
  const [claim, setClaim] = useState<Claim | null>(null);
  const [value, setValue] = useState('');
  const [state, setState] = useState<ViewState>('claiming');
  const claimRequest = useRef<{ token: string; promise: Promise<Claim> } | null>(null);
  const savingRef = useRef(false);

  useEffect(() => {
    if (savingRef.current) return;
    if (!clientAvailable) { setState('waiting'); return; }
    if (!token) { setState('invalid'); return; }
    let active = true;
    let pending = claimRequest.current;
    if (!pending || pending.token !== token) {
      pending = { token, promise: claimLink(token) };
      claimRequest.current = pending;
    }
    const request = pending.promise;
    void request.then((result) => {
      if (!active || savingRef.current) return;
      if (result.expiresAt <= Date.now()) { claimRequest.current = null; setState('invalid'); return; }
      setClaim(result);
      setState('ready');
    }).catch(() => { if (claimRequest.current?.token === token) claimRequest.current = null; if (active) setState('invalid'); });
    return () => { active = false; };
  }, [token, claimLink, clientAvailable]);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!clientAvailable || !claim || state !== 'ready' || !value.trim()) return;
    const submitted = value;
    const activeClaim = claim;
    setValue('');
    savingRef.current = true;
    setState('saving');
    try {
      const result = await register(activeClaim.slot, activeClaim.bearer, submitted);
      if (result.saved !== true || result.slot !== activeClaim.slot || result.verification !== 'verified') throw new Error('invalid receipt');
      claimRequest.current = null;
      setClaim(null);
      setState('saved');
    } catch {
      claimRequest.current = null;
      setClaim(null);
      setValue('');
      setState('error');
    }
  };

  return <main className="mx-auto max-w-xl space-y-6 px-4 py-8" data-testid="credential-claim">
    <header className="space-y-2"><Link href="/credentials" className="text-sm underline">자격 목록</Link>
      <h1 className="text-2xl font-semibold">휴대폰에서 자격 등록</h1>
      <p className="text-sm text-muted-foreground">값은 이 기기에서 한 번만 전송하며 저장 뒤에는 표시하지 않습니다.</p>
    </header>
    {state === 'claiming' && <p role="status">일회용 등록 링크를 확인하고 있습니다.</p>}
    {state === 'waiting' && <p role="status">넥서스 연결을 기다리고 있습니다.</p>}
    {state === 'invalid' && <p role="alert">링크가 만료됐거나 이미 사용됐습니다. 소유자 화면에서 새 QR을 만들어 주세요.</p>}
    {state === 'error' && <p role="alert">저장하지 못했습니다. 새 QR을 요청한 뒤 다시 시도해 주세요.</p>}
    {claim && state !== 'saved' && <section className="space-y-3 rounded-xl border p-4" aria-label="등록할 자격">
      <div className="font-medium">{claim.label}</div><div className="text-xs text-muted-foreground">{claim.slot}</div>
      <a className="underline" href={claim.setupUrl} target="_blank" rel="noreferrer">서비스에서 자격 값 확인</a>
      <form onSubmit={(event) => void save(event)} className="space-y-3">
        <label htmlFor="credential-claim-value" className="block text-sm font-medium">자격 값</label>
        <input id="credential-claim-value" name="credential-value" type="password" autoComplete="new-password"
          className="w-full rounded-lg border px-3 py-2" value={value} onChange={(event) => setValue(event.target.value)}
          disabled={state === 'saving'} required />
        <button type="submit" disabled={!clientAvailable || state !== 'ready' || !value.trim()} className="rounded-lg border px-4 py-2">
          {state === 'saving' ? '저장 중…' : '이 기기에 저장'}
        </button>
      </form>
    </section>}
    {state === 'saved' && <p role="status">저장했습니다. 자격 값은 이 화면에 남지 않습니다.</p>}
  </main>;
}
