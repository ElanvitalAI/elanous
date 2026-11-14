'use client';

import { useCallback, useEffect, useState } from 'react';
import { NEWSLETTER_REVISION, type NewsletterChoice } from '@/lib/member-signup-intent';

const PATH = '/v1/members/newsletter-preference';

function recordedChoice(value: unknown): NewsletterChoice | null {
  if (!value || typeof value !== 'object') return null;
  const preference = 'preference' in value ? value.preference : value;
  if (!preference || typeof preference !== 'object' || !('revision' in preference) || preference.revision !== NEWSLETTER_REVISION) return null;
  if (!('choice' in preference)) return null;
  return preference.choice === 'opted_in' || preference.choice === 'declined' ? preference.choice : null;
}

export function NewsletterPreferencePanel({ baseUrl }: { baseUrl?: string }) {
  const [savedChoice, setSavedChoice] = useState<NewsletterChoice | null>(null);
  const [choice, setChoice] = useState<NewsletterChoice | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'saving' | 'error'>('loading');
  const [error, setError] = useState('');
  const endpoint = baseUrl ? new URL(PATH, baseUrl).toString() : PATH;

  const recheck = useCallback(async () => {
    setStatus('loading'); setError('');
    try {
      const response = await fetch(endpoint, { credentials: 'include', cache: 'no-store' });
      if (!response.ok) throw new Error('뉴스레터 수신 상태를 확인하지 못했습니다. 다시 확인해 주세요.');
      const current = recordedChoice(await response.json());
      setSavedChoice(current); setChoice(current); setStatus('ready');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '뉴스레터 수신 상태를 확인하지 못했습니다.');
      setStatus('error');
    }
  }, [endpoint]);

  useEffect(() => { void recheck(); }, [recheck]);

  async function save() {
    if (status !== 'ready' || !choice || choice === savedChoice) return;
    setStatus('saving'); setError('');
    try {
      const response = await fetch(endpoint, { method: 'PUT', credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ choice, revision: NEWSLETTER_REVISION }) });
      if (!response.ok) throw new Error('뉴스레터 수신 선택을 저장하지 못했습니다. 다시 시도해 주세요.');
      await recheck();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '뉴스레터 수신 선택을 저장하지 못했습니다.');
      setStatus('ready');
    }
  }

  return <section aria-label="뉴스레터 수신 상태" className="space-y-3 rounded-lg border border-border p-4">
    <h2 className="font-semibold">뉴스레터 수신 상태 확인</h2>
    {status === 'loading' ? <p>수신 상태 확인 중…</p> : <>
      {status !== 'error' && <p className="text-sm" role="status">{savedChoice === 'opted_in' ? '현재 수신 동의 상태입니다.'
        : savedChoice === 'declined' ? '현재 수신 거부 상태입니다.' : '기록된 수신 선택이 없습니다.'}</p>}
      <fieldset disabled={status === 'saving' || status === 'error'} className="space-y-2">
        <legend className="text-sm font-medium">수신 선택</legend>
        <label className="flex items-center gap-2 text-sm"><input type="radio" name="newsletterPreference" value="opted_in"
          checked={choice === 'opted_in'} onChange={() => setChoice('opted_in')} />받겠습니다</label>
        <label className="flex items-center gap-2 text-sm"><input type="radio" name="newsletterPreference" value="declined"
          checked={choice === 'declined'} onChange={() => setChoice('declined')} />받지 않겠습니다</label>
      </fieldset>
      <div className="flex gap-2">
        <button type="button" disabled={status !== 'ready' || !choice || choice === savedChoice} onClick={() => void save()}
          className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50">{status === 'saving' ? '저장 중…' : '선택 저장'}</button>
        <button type="button" disabled={status === 'saving'} onClick={() => void recheck()}
          className="rounded-md border px-3 py-2 text-sm">다시 확인</button>
      </div>
    </>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>;
}
