'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useDaemon } from '@/components/providers/DaemonProvider';

type Scrap = {
  id: string;
  kind: string;
  status: string;
  raw: { url?: string; text?: string };
};

function isScrap(value: unknown): value is Scrap {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== 'string' || typeof item.kind !== 'string'
    || typeof item.status !== 'string' || !item.raw || typeof item.raw !== 'object') return false;
  const raw = item.raw as Record<string, unknown>;
  return (raw.url === undefined || typeof raw.url === 'string')
    && (raw.text === undefined || typeof raw.text === 'string');
}

function scrapLabel(scrap: Scrap): string {
  return scrap.raw.text?.trim().split('\n')[0] || scrap.raw.url || '저장한 스크랩';
}

function articleUrl(scrap: Scrap): string | null {
  if (!scrap.raw.url) return null;
  try {
    const url = new URL(scrap.raw.url);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch { return null; }
}

export default function ScrapsPage() {
  const { config, sessionId } = useDaemon();
  const [scraps, setScraps] = useState<Scrap[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [message, setMessage] = useState('저장한 스크랩을 불러오는 중…');
  const [refresh, setRefresh] = useState(0);
  const [selectedId, setSelectedId] = useState('');
  const reload = useCallback(() => setRefresh((value) => value + 1), []);

  useEffect(() => {
    if (!sessionId) {
      setScraps([]);
      setSelectedId('');
      setState('error');
      setMessage('회원 로그인이 필요합니다.');
      return;
    }
    setSelectedId(typeof window === 'undefined' ? '' : new URLSearchParams(window.location.search).get('selected') ?? '');
    if (!config.baseUrl) {
      setScraps([]);
      setState('error');
      setMessage('연결된 서버가 없습니다. 설정에서 서버를 연결해 주세요.');
      return;
    }
    let active = true;
    setState('loading');
    void (async () => {
      try {
        const response = await fetch(new URL('/v1/scraps', config.baseUrl), { credentials: 'include' });
        if (!response.ok) throw new Error(response.status === 401 ? '회원 로그인이 필요합니다.' : `스크랩을 불러오지 못했습니다 (${response.status}).`);
        const body: unknown = await response.json();
        if (!body || typeof body !== 'object' || !Array.isArray((body as { scraps?: unknown }).scraps)) {
          throw new Error('스크랩 응답이 올바르지 않습니다.');
        }
        if (!active) return;
        setScraps((body as { scraps: unknown[] }).scraps.filter(isScrap));
        setState('ready');
      } catch (error) {
        if (!active) return;
        setMessage(error instanceof Error ? error.message : '스크랩을 불러오지 못했습니다.');
        setState('error');
      }
    })();
    return () => { active = false; };
  }, [config.baseUrl, refresh, sessionId]);

  useEffect(() => {
    if (!selectedId || typeof document === 'undefined') return;
    const selected = [...document.querySelectorAll<HTMLElement>('[data-scrap-id]')]
      .find((item) => item.dataset.scrapId === selectedId);
    selected?.scrollIntoView({ block: 'nearest' });
  }, [scraps, selectedId]);

  return <main className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-5 py-10">
    <div className="flex items-center justify-between gap-3">
      <h1 className="text-2xl font-semibold">저장한 스크랩</h1>
      <button type="button" onClick={reload} className="rounded-md border px-3 py-2">새로고침</button>
    </div>
    {state === 'loading' && <p role="status">저장한 스크랩을 불러오는 중…</p>}
    {state === 'error' && <p role="alert">{message}</p>}
    {state === 'ready' && scraps.length === 0 && <p role="status">저장한 스크랩이 없습니다. 기사에서 공유를 눌러 Elanous로 보내세요.</p>}
    {state === 'ready' && scraps.length > 0 && <ul className="flex flex-col gap-3">
      {scraps.map((scrap) => {
        const url = articleUrl(scrap);
        const selected = scrap.id === selectedId;
        return <li key={scrap.id} data-scrap-id={scrap.id} data-selected={selected} aria-current={selected ? 'true' : undefined}
          className={`rounded-lg border p-4 ${selected ? 'border-primary bg-primary/10' : ''}`}>
          {selected && <p className="mb-2 text-sm font-semibold text-primary">선택한 스크랩</p>}
          <p className="font-medium break-words">{scrapLabel(scrap)}</p>
          {url && <a href={url} target="_blank" rel="noopener noreferrer" className="mt-2 block break-all text-sm underline">출처: {new URL(url).hostname}</a>}
          <p className="mt-2 text-sm text-muted-foreground">{scrap.status === 'absorbed' ? '흡수됨' : scrap.status === 'failed' ? '흡수 실패' : '처리 중'}</p>
        </li>;
      })}
    </ul>}
    <Link href="/chat" className="text-sm underline">채팅으로</Link>
  </main>;
}
