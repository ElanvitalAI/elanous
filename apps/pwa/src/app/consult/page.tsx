'use client';

import { useState, type FormEvent } from 'react';
import { useDaemon } from '@/components/providers/DaemonProvider';
import type { ConsultRequest } from '@/lib/daemon-client';

/** 상담·문의 메일 주소(사이트·앱·PWA 같은 주소). */
const CONSULT_EMAIL = 'user@elanvital.ai';

const fieldNames: Record<string, string> = {
  name: '이름',
  org: '회사명',
  kind: '회사/개인',
  interest: '관심 분야',
  contact: '연락처',
  consent: '동의',
};

export default function ConsultPage() {
  const { client } = useDaemon();
  const [name, setName] = useState('');
  const [org, setOrg] = useState('');
  const [kind, setKind] = useState<ConsultRequest['kind']>('personal');
  const [interest, setInterest] = useState<ConsultRequest['interest']>('A');
  const [contact, setContact] = useState('');
  const [consent, setConsent] = useState(false);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!consent || sending) return;
    const request: ConsultRequest = {
      name: name.trim(),
      ...(kind === 'company' ? { org: org.trim() } : {}),
      kind,
      interest,
      contact: contact.trim(),
      consent: true,
    };
    const missing = !request.name ? 'name' : kind === 'company' && !request.org ? 'org' : !request.contact ? 'contact' : null;
    if (missing) {
      setError(true);
      setMessage(`${fieldNames[missing]} 항목을 입력해 주세요.`);
      return;
    }
    setSending(true);
    setMessage('');
    try {
      const result = await client.submitConsultRequest(request);
      if ('receiptId' in result) {
        setError(false);
        setMessage(`접수했습니다 · ${result.receiptId} — 곧 연락드리겠습니다`);
      } else {
        setError(true);
        setMessage(`${fieldNames[result.field] ?? '필수'} 항목을 확인해 주세요.`);
      }
    } catch {
      setError(true);
      setMessage('접수하지 못했습니다. 연결 상태를 확인하고 다시 보내 주세요.');
    } finally {
      setSending(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-xl px-5 py-10 sm:py-16">
      <header className="mb-8">
        <p className="mb-2 text-sm font-medium text-primary">AX · 상담 문의</p>
        <h1 className="text-2xl font-semibold tracking-tight">어떤 도움이 필요하신가요?</h1>
        <p className="mt-3 text-sm text-muted-foreground">도입 상담이나 교육 과정에 대해 남겨 주세요. 확인 후 연락드리겠습니다.</p>
        <p className="mt-2 text-sm text-muted-foreground">메일로 바로 문의: <a className="underline" href={`mailto:${CONSULT_EMAIL}`}>{CONSULT_EMAIL}</a></p>
      </header>
      <form onSubmit={submit} noValidate className="space-y-6 rounded-xl border border-border bg-card p-5 sm:p-8">
        <div className="space-y-2">
          <label htmlFor="consult-name" className="block text-sm font-medium">이름</label>
          <input id="consult-name" name="name" required autoComplete="name" value={name} onChange={e => setName(e.target.value)} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
        </div>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">회사/개인</legend>
          <div className="flex gap-5 text-sm">
            <label className="flex items-center gap-2"><input type="radio" name="kind" value="company" checked={kind === 'company'} onChange={() => setKind('company')} />회사</label>
            <label className="flex items-center gap-2"><input type="radio" name="kind" value="personal" checked={kind === 'personal'} onChange={() => setKind('personal')} />개인</label>
          </div>
        </fieldset>
        {kind === 'company' && (
          <div className="space-y-2">
            <label htmlFor="consult-org" className="block text-sm font-medium">회사명</label>
            <input id="consult-org" name="org" required autoComplete="organization" value={org} onChange={e => setOrg(e.target.value)} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
          </div>
        )}
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">관심 분야</legend>
          <div className="flex flex-col gap-2 text-sm">
            <label className="flex items-center gap-2"><input type="radio" name="interest" value="A" checked={interest === 'A'} onChange={() => setInterest('A')} />A · AX 도입 상담</label>
            <label className="flex items-center gap-2"><input type="radio" name="interest" value="B" checked={interest === 'B'} onChange={() => setInterest('B')} />B · 과정·교육 문의</label>
          </div>
        </fieldset>
        <div className="space-y-2">
          <label htmlFor="consult-contact" className="block text-sm font-medium">연락처 (메일 또는 전화)</label>
          <input id="consult-contact" name="contact" required value={contact} onChange={e => setContact(e.target.value)} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
        </div>
        <label className="flex items-start gap-3 text-sm leading-6">
          <input type="checkbox" name="consent" checked={consent} onChange={e => setConsent(e.target.checked)} className="mt-1" />
          <span>입력한 정보는 상담 연락을 위해 서버로 전송하며, 상담 연락에만 사용합니다</span>
        </label>
        {message && <p role={error ? 'alert' : 'status'} className={error ? 'text-sm text-destructive' : 'text-sm text-primary'}>{message}</p>}
        <button type="submit" disabled={!consent || sending} className="w-full rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50">
          {sending ? '보내는 중…' : '보내기'}
        </button>
      </form>
    </main>
  );
}
