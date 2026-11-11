'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { CredentialSlotWire } from '@/nexus/client';

type Inventory = { credentials: CredentialSlotWire[] };
type ImportCandidate = { id: string; name: string; source: string; lastFour: string };
type ViewState = { state: 'loading' | 'error' } | { state: 'ready'; rows: CredentialSlotWire[] };

export function CredentialVaultView({ load, startOpenRouter, listOpenRouterImports, importOpenRouterCandidate }: {
  load: () => Promise<Inventory>;
  startOpenRouter?: () => Promise<string>;
  listOpenRouterImports?: () => Promise<{ candidates: ImportCandidate[] }>;
  importOpenRouterCandidate?: (id: string) => Promise<unknown>;
}): React.ReactNode {
  const [view, setView] = useState<ViewState>({ state: 'loading' });
  const [oauthState, setOauthState] = useState<'idle' | 'starting' | 'error'>('idle');
  const [oauthResult, setOauthResult] = useState<'connected' | 'failed' | null>(null);
  const [importResult, setImportResult] = useState<'saved' | null>(null);
  const [candidates, setCandidates] = useState<ImportCandidate[]>([]);
  const [candidateError, setCandidateError] = useState(false);
  const latestRequest = useRef(0);
  const refresh = useCallback(async () => {
    const requestId = ++latestRequest.current;
    setView({ state: 'loading' });
    try {
      const result = await load();
      if (requestId === latestRequest.current) setView({ state: 'ready', rows: result.credentials });
    } catch {
      if (requestId === latestRequest.current) setView({ state: 'error' });
    }
  }, [load]);
  const refreshCandidates = useCallback(async () => {
    if (!listOpenRouterImports) return;
    setCandidateError(false);
    try { setCandidates((await listOpenRouterImports()).candidates); }
    catch { setCandidateError(true); }
  }, [listOpenRouterImports]);
  useEffect(() => { void refresh(); return () => { latestRequest.current += 1; }; }, [refresh]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    const result = url.searchParams.get('openrouter');
    if (result === 'connected' || result === 'failed') setOauthResult(result);
    if (result) {
      url.searchParams.delete('openrouter');
      window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    }
  }, []);
  useEffect(() => { void refreshCandidates(); }, [refreshCandidates]);
  const openRouterRow = view.state === 'ready' ? view.rows.find(row => row.id === 'cred:openrouter.api_key') : undefined;

  return <main className="mx-auto max-w-3xl space-y-6 px-4 py-8" data-testid="credential-vault">
    <header className="flex items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold">자격</h1>
        <p className="mt-1 text-sm text-muted-foreground">넥서스 금고의 공통 자격 슬롯 상태</p>
      </div>
      <button type="button" onClick={() => void refresh()} className="rounded-lg border px-3 py-2 text-sm">새로고침</button>
    </header>
    {view.state === 'loading' && <p role="status">자격 상태를 확인하고 있습니다.</p>}
    {view.state === 'error' && <p role="alert">자격 상태를 읽지 못했습니다. 연결과 소유자 권한을 확인해 주세요.</p>}
    {oauthResult === 'connected' && openRouterRow?.present && <p role="status">OpenRouter 연결을 마쳤고 Nexus 슬롯에서 키가 확인됩니다.</p>}
    {oauthResult === 'connected' && view.state === 'ready' && !openRouterRow?.present && <p role="alert">OpenRouter 연결 응답은 받았지만 Nexus 슬롯에서 키를 확인하지 못했습니다. 상태를 새로고침해 주세요.</p>}
    {oauthResult === 'connected' && view.state === 'error' && <p role="alert">OpenRouter 연결 응답은 받았지만 Nexus 슬롯 상태를 읽지 못했습니다.</p>}
    {oauthResult === 'failed' && <p role="alert">OpenRouter 연결을 완료하지 못했습니다. 다시 시도해 주세요.</p>}
    {importResult === 'saved' && <p role="status">감지한 OpenRouter 키를 Nexus가 검증해 저장했습니다.</p>}
    {view.state === 'ready' && <ul className="divide-y rounded-xl border" aria-label="자격 슬롯 목록">
      {view.rows.map((row) => <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div><div className="font-medium">{row.label}</div><div className="text-xs text-muted-foreground">{row.id}</div></div>
        <div className="text-right text-sm"><div>{row.present ? '있음' : '없음'}</div>
          {row.healthLabel && <div className="text-xs text-muted-foreground">상태: {row.healthLabel}</div>}
          <div className="text-xs text-muted-foreground">마지막 확인: {row.lastCheckedAt ? new Date(row.lastCheckedAt).toLocaleString('ko-KR') : '확인 기록 없음'}</div>
          {row.id === 'cred:openrouter.api_key' && startOpenRouter && <button type="button" className="mt-2 inline-block rounded-lg border px-3 py-1"
            disabled={oauthState === 'starting'} onClick={() => {
              setOauthState('starting');
              void startOpenRouter().then(url => { window.location.assign(url); }).catch(() => setOauthState('error'));
            }}>{oauthState === 'starting' ? 'OpenRouter로 이동합니다…' : 'OpenRouter 계정 연결'}</button>}
          {row.registerable && row.registrationPath && <Link className="mt-2 ml-2 inline-block rounded-lg border px-3 py-1" href={`${row.registrationPath}?slot=${encodeURIComponent(row.id)}`}>QR·키 등록</Link>}
        </div>
      </li>)}
    </ul>}
    {candidates.map(candidate => <section key={candidate.id} className="rounded-xl border p-4" aria-label="감지한 OpenRouter 키">
      <p>{candidate.name} · {candidate.source} · 끝자리 {candidate.lastFour}</p>
      <p>이 키를 Nexus 자격 금고에 가져올까요? 값 전체는 표시되지 않습니다.</p>
      <button type="button" className="mr-2 rounded-lg border px-3 py-1" onClick={() => {
        if (!importOpenRouterCandidate) return;
        void importOpenRouterCandidate(candidate.id).then(() => { setCandidates(rows => rows.filter(row => row.id !== candidate.id)); setImportResult('saved'); void refresh(); })
          .catch(() => setCandidateError(true));
      }}>가져오기</button>
      <button type="button" className="rounded-lg border px-3 py-1" onClick={() => setCandidates(rows => rows.filter(row => row.id !== candidate.id))}>아니요</button>
    </section>)}
    {candidateError && <div role="alert"><p>OpenRouter 키 후보를 처리하지 못했습니다. 후보를 새로 불러와 다시 시도해 주세요.</p>
      {listOpenRouterImports && <button type="button" className="rounded-lg border px-3 py-1" onClick={() => void refreshCandidates()}>후보 다시 불러오기</button>}
    </div>}
    {oauthState === 'error' && <p role="alert">OpenRouter 연결을 시작하지 못했습니다. 다시 시도해 주세요.</p>}
  </main>;
}
