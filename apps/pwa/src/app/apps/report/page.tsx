'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { publicReportHost, submitPublicAppReport, type PublicReportCategory } from '@/lib/public-app-report';

const CATEGORIES: Array<{ value: PublicReportCategory; label: string }> = [
  { value: 'abuse', label: '유해한 내용' },
  { value: 'phishing', label: '사칭 또는 피싱' },
  { value: 'spam', label: '스팸' },
];

export default function AppReportPage() {
  const [host, setHost] = useState('');
  const [category, setCategory] = useState<PublicReportCategory>('abuse');
  const [state, setState] = useState<'ready' | 'sending' | 'received' | 'error'>('ready');

  useEffect(() => {
    const suggested = new URLSearchParams(window.location.search).get('host');
    if (suggested) setHost(publicReportHost(suggested) ?? '');
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (state === 'sending') return;
    setState('sending');
    try { setState(await submitPublicAppReport(host, category) ? 'received' : 'error'); }
    catch { setState('error'); }
  };

  return <main className="mx-auto flex w-full max-w-lg flex-col gap-5 px-5 py-12">
    <h1 className="text-2xl font-semibold">공개 앱 신고</h1>
    <p className="text-sm text-muted-foreground">신고가 접수되면 해당 앱의 공개 접속이 일시 중지됩니다. 계정 정보나 토큰을 입력하지 마세요.</p>
    <form onSubmit={submit} className="space-y-5">
      <label className="block space-y-2 text-sm font-medium">앱 주소의 호스트 이름
        <input value={host} onChange={event => setHost(event.target.value)} required autoComplete="off"
          placeholder="notes--alice.elanous.app" className="w-full rounded-md border border-border bg-background px-3 py-2" />
      </label>
      <label className="block space-y-2 text-sm font-medium">신고 유형
        <select value={category} onChange={event => setCategory(event.target.value as PublicReportCategory)}
          className="w-full rounded-md border border-border bg-background px-3 py-2">
          {CATEGORIES.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
      </label>
      <button type="submit" disabled={state === 'sending' || state === 'received'}
        className="rounded-md bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50">신고하기</button>
    </form>
    {state === 'received' && <p role="status">신고를 접수했습니다.</p>}
    {state === 'error' && <p role="alert">신고를 접수하지 못했습니다. 앱 주소를 확인한 뒤 다시 시도해 주세요.</p>}
  </main>;
}
