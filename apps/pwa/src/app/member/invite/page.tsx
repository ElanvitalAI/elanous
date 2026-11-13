'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { useOptionalNexusClient } from '@/nexus/hooks/use-nexus-context';
import { createMemberInviteApi, memberExampleKitMailto } from '@/lib/member-invite-api';

export default function MemberInvitePage() {
  const nexus = useOptionalNexusClient();
  const api = useMemo(() => nexus ? createMemberInviteApi(nexus.baseUrl) : null, [nexus]);
  const [link, setLink] = useState<string | null>(null);
  const [handle, setHandle] = useState<string | null>(null);
  const [canClaimHandle, setCanClaimHandle] = useState(false);
  const [requestedId, setRequestedId] = useState('');
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
      if (active && generation === requestGeneration.current) {
        setLink(value.link); setHandle(value.handle); setCanClaimHandle(value.canClaimHandle);
        setReferralCount(value.referralCount);
      }
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
  async function claim() {
    if (!api || !canClaimHandle) return;
    const generation = ++requestGeneration.current;
    setBusy(true); setError(null); setCopied(false);
    try {
      const next = await api.claim(requestedId);
      if (generation === requestGeneration.current) {
        setLink(next.link); setHandle(next.handle); setCanClaimHandle(false); setRequestedId('');
      }
    } catch (cause) {
      if (generation === requestGeneration.current) setError(cause instanceof Error ? cause.message : '회원 ID를 설정하지 못했습니다.');
    } finally { if (generation === requestGeneration.current) setBusy(false); }
  }
  async function copy() {
    if (!link) return;
    try { await navigator.clipboard.writeText(link); setCopied(true); }
    catch { setError('클립보드에 복사하지 못했습니다. 링크를 직접 선택해 주세요.'); }
  }
  return <main className="mx-auto max-w-xl space-y-5 px-5 py-8">
    <h1 className="text-2xl font-semibold">내 초대 링크</h1>
    <p className="text-sm text-muted-foreground">회원 ID는 공개됩니다. 이 링크로 가입한 회원의 추천 관계가 기록됩니다. 회원 비밀 키는 링크에 포함되지 않습니다.</p>
    {referralCount !== null && <p role="status" className="text-sm">내 링크로 가입한 회원 {referralCount}명</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!api && <p role="status">Nexus 연결 후 초대 링크를 확인할 수 있습니다.</p>}
    {handle && <p className="text-sm">내 회원 ID: <strong>{handle}</strong></p>}
    {canClaimHandle && <form className="space-y-2 rounded-xl border border-border bg-card p-4" onSubmit={event => { event.preventDefault(); void claim(); }}>
      <label htmlFor="member-public-id" className="block text-sm font-medium">읽기 쉬운 회원 ID 정하기 (1회)</label>
      <input id="member-public-id" value={requestedId} onChange={event => setRequestedId(event.currentTarget.value)}
        minLength={3} maxLength={30} pattern="[a-z][a-z0-9_]{2,29}" autoComplete="off"
        className="w-full rounded border border-border bg-background p-2 text-sm" />
      <p className="text-xs text-muted-foreground">영문 소문자로 시작하고 숫자·밑줄을 사용할 수 있습니다. 설정 뒤에는 변경할 수 없습니다.</p>
      <button type="submit" disabled={busy || !/^[a-z][a-z0-9_]{2,29}$/.test(requestedId)
        || ['em_', 'emk_', 'emt_'].some(prefix => requestedId.startsWith(prefix))}
        className="rounded bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50">회원 ID 설정</button>
    </form>}
    {link ? <section className="space-y-4 rounded-xl border border-border bg-card p-5">
      <label className="block text-sm font-medium" htmlFor="member-invite-link">초대 링크</label>
      <input id="member-invite-link" readOnly value={link} onFocus={event => event.currentTarget.select()} className="w-full rounded border border-border bg-background p-2 text-sm" />
      {qr && <img src={qr} alt="내 초대 링크 QR 코드" width={280} height={280} />}
      <div className="flex flex-wrap gap-2"><button type="button" onClick={copy} className="rounded bg-primary px-3 py-2 text-primary-foreground">복사</button>
        <a href={memberExampleKitMailto(link)} className="rounded border border-border px-3 py-2">예제 키트 메일 초안</a></div>
      {copied && <p role="status" className="text-sm">초대 링크를 복사했습니다.</p>}
    </section> : api && !error && !canClaimHandle && <p role="status">회원 ID 링크를 불러오는 중입니다.</p>}
  </main>;
}
