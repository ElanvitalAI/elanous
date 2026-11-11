'use client';

import { useContext, useEffect, useState } from 'react';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import { memberSignupBody, memberSignupIntentFromSearch, type MemberSignupLinkIntent } from '@/lib/member-signup-intent';

const KCB_EVENT_CODE = 'KCB1114';
const KCB_START_KEY = 'kcb-qr-journey-started-at';

export default function MemberSignupPage() {
  const daemon = useContext(DaemonContext);
  const [intent, setIntent] = useState<MemberSignupLinkIntent | null>(null);
  const [consented, setConsented] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    try {
      const next = memberSignupIntentFromSearch(window.location.search);
      setIntent(next);
      if (next.eventCode === KCB_EVENT_CODE && typeof sessionStorage !== 'undefined') {
        const prior = Number(sessionStorage.getItem(KCB_START_KEY));
        const now = Date.now();
        if (!Number.isFinite(prior) || prior <= 0 || prior > now) sessionStorage.setItem(KCB_START_KEY, String(now));
      }
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : '가입 링크가 올바르지 않습니다.'); }
  }, []);
  async function start() {
    if (!intent || !consented || busy) return;
    setBusy(true); setError('');
    try {
      const endpoint = daemon?.config.baseUrl ? new URL('/v1/members', daemon.config.baseUrl).toString() : '/v1/members';
      const response = await fetch(endpoint, { method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(memberSignupBody(intent)) });
      if (!response.ok) throw new Error(response.status === 400 ? '초대 또는 행사 코드를 확인해 주세요.'
        : response.status === 429 ? '접속이 많습니다. 잠시 뒤 다시 시도해 주세요.' : '가입을 시작하지 못했습니다. 다시 시도해 주세요.');
      const body = await response.json() as { authorizationUrl?: unknown };
      if (typeof body.authorizationUrl !== 'string' || new URL(body.authorizationUrl).protocol !== 'https:')
        throw new Error('로그인 주소가 올바르지 않습니다. 다시 시도해 주세요.');
      window.location.assign(body.authorizationUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '가입을 시작하지 못했습니다. 다시 시도해 주세요.');
      setBusy(false);
    }
  }
  return <main className="mx-auto flex w-full max-w-lg flex-col gap-5 px-5 py-12">
    {intent?.eventCode === KCB_EVENT_CODE && <p className="text-sm text-muted-foreground">KCB 행사 체험</p>}
    <h1 className="text-3xl font-semibold">{intent?.eventCode === KCB_EVENT_CODE ? 'QR로 시작해 바로 해 보기' : 'Elanous 회원 가입'}</h1>
    <p>Google 계정으로 가입합니다. 초대 링크로 오셨다면 추천 관계가 가입 시 기록됩니다.</p>
    {intent?.referralCode && <p className="rounded border border-border bg-card p-3 text-sm">초대 코드가 적용됩니다.</p>}
    {intent?.eventCode === KCB_EVENT_CODE ? <label className="flex flex-col gap-2 text-sm">행사 코드
      <input value={intent.eventCode} readOnly className="rounded-md border bg-muted px-3 py-2" aria-label="행사 코드" />
    </label> : intent?.eventCode && <p className="rounded border border-border bg-card p-3 text-sm">행사 코드 {intent.eventCode}가 적용됩니다.</p>}
    <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={consented} onChange={event => setConsented(event.target.checked)} />
      <span>개인정보 처리와 이용약관에 동의합니다.</span></label>
    <button type="button" disabled={!consented || !intent || busy} onClick={() => void start()}
      className="rounded-md bg-primary px-4 py-3 text-primary-foreground disabled:opacity-50">
      {busy ? 'Google 로그인으로 이동 중…' : 'Google로 가입하고 시작'}
    </button>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </main>;
}
