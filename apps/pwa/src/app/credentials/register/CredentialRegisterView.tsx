'use client';

import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import Link from 'next/link';
import type { CredentialSlotWire } from '@/nexus/client';

type Inventory = { credentials: CredentialSlotWire[] };
type RegistrationLink = { slot: string; url: string; expiresAt: number };
type ViewState = 'loading' | 'ready' | 'creating' | 'linked' | 'invalid' | 'error';
const createQrSvg = (url: string): Promise<string> => QRCode.toString(url, { type: 'svg', margin: 2, width: 240 });
const registrationToken = (url: string): string => new URLSearchParams(new URL(url).hash.slice(1)).get('t') ?? '';

/** Owner-side screen: the one-time URL stays in memory and is shared to the phone by QR. */
export function CredentialRegisterView({ slotId, load, createLink, revokeLink, clientAvailable = true, encodeQr = createQrSvg }: {
  slotId: string;
  load: () => Promise<Inventory>;
  createLink: (slot: string) => Promise<RegistrationLink>;
  revokeLink: (token: string) => Promise<{ revoked: true }>;
  clientAvailable?: boolean;
  encodeQr?: (url: string) => Promise<string>;
}): React.ReactNode {
  const [slot, setSlot] = useState<CredentialSlotWire | null>(null);
  const [state, setState] = useState<ViewState>('loading');
  const [link, setLink] = useState<RegistrationLink | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [qrError, setQrError] = useState(false);
  const [revokeError, setRevokeError] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const operationRef = useRef(false);

  useEffect(() => {
    if (!clientAvailable) return;
    let active = true;
    void load().then((inventory) => {
      if (!active) return;
      const selected = inventory.credentials.find((row) => row.id === slotId && row.registerable);
      setSlot(selected ?? null);
      setState((current) => selected ? (current === 'linked' || current === 'creating' ? current : 'ready') : 'invalid');
    }).catch(() => { if (active) setState('error'); });
    return () => { active = false; };
  }, [clientAvailable, load, slotId]);

  useEffect(() => {
    let active = true;
    setQr(null);
    setQrError(false);
    if (link) void encodeQr(link.url)
      .then((svg) => { if (active) setQr(`data:image/svg+xml,${encodeURIComponent(svg)}`); })
      .catch(() => { if (active) { setQr(null); setQrError(true); } });
    return () => { active = false; };
  }, [encodeQr, link]);

  const mint = async () => {
    if (!slot || operationRef.current) return;
    operationRef.current = true;
    const previousLink = link;
    let previousRevoked = false;
    setState('creating');
    setRevokeError(false);
    try {
      if (previousLink) {
        const oldToken = registrationToken(previousLink.url);
        if (!oldToken) throw new Error('invalid link');
        await revokeLink(oldToken);
        previousRevoked = true;
        setLink(null);
      }
      const created = await createLink(slot.id);
      if (created.slot !== slot.id || !Number.isFinite(created.expiresAt)) throw new Error('invalid link');
      setLink(created);
      setState('linked');
    } catch {
      if (previousLink && !previousRevoked) { setRevokeError(true); setState('linked'); }
      else setState('error');
    } finally { operationRef.current = false; }
  };

  const revoke = async () => {
    if (!link || operationRef.current || !clientAvailable) return;
    operationRef.current = true;
    const token = registrationToken(link.url);
    if (!token) { setRevokeError(true); operationRef.current = false; return; }
    setRevoking(true);
    setRevokeError(false);
    try {
      await revokeLink(token);
      setLink(null);
      setQr(null);
      setState('ready');
    } catch { setRevokeError(true); }
    finally { operationRef.current = false; setRevoking(false); }
  };

  return <main className="mx-auto max-w-xl space-y-6 px-4 py-8" data-testid="credential-register">
    <header className="space-y-2">
      <Link href="/credentials" className="text-sm underline">자격 목록</Link>
      <h1 className="text-2xl font-semibold">휴대폰으로 자격 등록</h1>
      <p className="text-sm text-muted-foreground">휴대폰에서 QR을 열어 자격 값을 입력하세요. 링크는 한 번만 쓸 수 있고 잠시 뒤 만료됩니다.</p>
      {!clientAvailable && <p role="status">넥서스 연결을 기다리고 있습니다.</p>}
    </header>
    {state === 'loading' && <p role="status">등록할 슬롯을 확인하고 있습니다.</p>}
    {state === 'invalid' && <p role="alert">등록할 수 없는 슬롯입니다.</p>}
    {state === 'error' && <p role="alert">등록 링크를 만들지 못했습니다. 연결과 소유자 권한을 확인해 주세요.</p>}
    {slot && <section className="rounded-xl border p-4" aria-label="등록 대상 슬롯">
      <div className="font-medium">{slot.label}</div><div className="text-xs text-muted-foreground">{slot.id}</div>
    </section>}
    {slot && state !== 'linked' && <button type="button" onClick={() => void mint()} disabled={!clientAvailable || state === 'creating'}
      className="rounded-lg border px-4 py-2">{state === 'creating' ? 'QR 준비 중…' : '휴대폰 등록 QR 만들기'}</button>}
    {link && <section className="space-y-3 rounded-xl border p-4" aria-label="휴대폰 등록 QR">
      {qrError ? <p role="alert">QR을 만들지 못했습니다. 다시 시도해 주세요.</p>
        : qr ? <img src={qr} width={240} height={240} alt="휴대폰 자격 등록 QR 코드" className="mx-auto" />
          : <p role="status">QR을 만들고 있습니다.</p>}
      <p>휴대폰 카메라로 스캔해 등록을 이어가세요.</p>
      <p className="text-sm">만료 시각: {new Date(link.expiresAt).toLocaleTimeString('ko-KR')}</p>
      {revokeError && <p role="alert">링크를 폐기하지 못했습니다. 연결과 소유자 권한을 확인해 주세요.</p>}
      <button type="button" onClick={() => void revoke()} disabled={!clientAvailable || revoking} className="rounded-lg border px-3 py-1">
        {revoking ? '폐기 중…' : '현재 QR 폐기'}
      </button>
      <button type="button" onClick={() => void mint()} disabled={!clientAvailable || revoking} className="rounded-lg border px-3 py-1">{qrError ? 'QR 다시 만들기' : '새 QR 만들기'}</button>
    </section>}
  </main>;
}
