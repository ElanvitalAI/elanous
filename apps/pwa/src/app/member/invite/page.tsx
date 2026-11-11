'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { useOptionalNexusClient } from '@/nexus/hooks/use-nexus-context';
import { createMemberInviteApi, memberExampleKitMailto } from '@/lib/member-invite-api';

export default function MemberInvitePage() {
  const nexus = useOptionalNexusClient();
  const api = useMemo(() => nexus ? createMemberInviteApi(nexus.baseUrl) : null, [nexus]);
  const [link, setLink] = useState<string | null>(null);
  const [referralCount, setReferralCount] = useState<number | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const requestGeneration = useRef(0);
  useEffect(() => {
    if (!api) return;
    let active = true;
    const generation = ++requestGeneration.current;
    api.read().then(value => {
      if (active && generation === requestGeneration.current) { setLink(value.link); setReferralCount(value.referralCount); }
    }).catch(cause => { if (active && generation === requestGeneration.current) setError(String(cause)); });
    return () => { active = false; requestGeneration.current++; };
  }, [api]);
  useEffect(() => {
    let active = true;
    const generation = requestGeneration.current;
    if (!link) { setQr(null); return; }
    QRCode.toDataURL(link, { margin: 2, width: 280 }).then(value => { if (active && generation === requestGeneration.current) setQr(value); })
      .catch(() => { if (active && generation === requestGeneration.current) setQr(null); });
    return () => { active = false; };
  }, [link]);
  async function mutate(action: 'rotate' | 'revoke') {
    if (!api) return;
    const generation = ++requestGeneration.current;
    setBusy(true); setError(null); setCopied(false); setLink(null); setQr(null);
    try {
      const next = action === 'rotate' ? await api.rotate() : (await api.revoke(), null);
      if (generation === requestGeneration.current) setLink(next);
    } catch (cause) {
      if (generation === requestGeneration.current) {
        try {
          const current = await api.read();
          if (generation === requestGeneration.current) { setLink(current.link); setReferralCount(current.referralCount); }
        } catch { /* Keep the previous QR hidden until the current server state is known. */ }
        setError(String(cause));
      }
    } finally { if (generation === requestGeneration.current) setBusy(false); }
  }
  async function copy() {
    if (!link) return;
    try { await navigator.clipboard.writeText(link); setCopied(true); }
    catch { setError('클립보드에 복사하지 못했습니다. 링크를 직접 선택해 주세요.'); }
  }
  return <main className="mx-auto max-w-xl space-y-5 px-5 py-8">
    <h1 className="text-2xl font-semibold">내 초대 링크</h1>
    <p className="text-sm text-muted-foreground">링크로 가입한 회원의 추천 관계가 기록됩니다. 이전 링크가 노출되었다면 재발급하거나 폐기할 수 있습니다.</p>
    {referralCount !== null && <p role="status" className="text-sm">내 링크로 가입한 회원 {referralCount}명</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!api && <p role="status">Nexus 연결 후 초대 링크를 확인할 수 있습니다.</p>}
    {link ? <section className="space-y-4 rounded-xl border border-border bg-card p-5">
      <label className="block text-sm font-medium" htmlFor="member-invite-link">초대 링크</label>
      <input id="member-invite-link" readOnly value={link} onFocus={event => event.currentTarget.select()} className="w-full rounded border border-border bg-background p-2 text-sm" />
      {qr && <img src={qr} alt="내 초대 링크 QR 코드" width={280} height={280} />}
      <div className="flex flex-wrap gap-2"><button type="button" onClick={copy} className="rounded bg-primary px-3 py-2 text-primary-foreground">복사</button>
        <a href={memberExampleKitMailto(link)} className="rounded border border-border px-3 py-2">예제 키트 메일 초안</a>
        <button type="button" disabled={busy} onClick={() => mutate('rotate')} className="rounded border border-border px-3 py-2">재발급</button>
        <button type="button" disabled={busy} onClick={() => mutate('revoke')} className="rounded border border-border px-3 py-2">폐기</button></div>
      {copied && <p role="status" className="text-sm">초대 링크를 복사했습니다.</p>}
    </section> : api && !error && <div className="space-y-3"><p role="status">활성 초대 링크가 없습니다.</p>
      <button type="button" disabled={busy} onClick={() => mutate('rotate')} className="rounded bg-primary px-3 py-2 text-primary-foreground">새 초대 링크 발급</button></div>}
  </main>;
}
