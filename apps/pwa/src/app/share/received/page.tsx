'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { takeSharedPayload, acknowledgeSharedPayloadFiles, markSharedPayloadProgress, readSharedPayloadProgress, readSharedPayloadReceipt, withSharedPayloadLock, ShareLockUnavailableError } from '@/lib/share-target-store';
import { saveSharedScraps, ScrapsUnavailableError, type SavedScrapReceipt } from '@/lib/share-scraps';

type State = { phase: 'loading' | 'saving' | 'saved' | 'failed'; message: string; saved: string[]; failed: string[] };

async function verifiedSavedArticle(baseUrl: string, id: string): Promise<SavedScrapReceipt | null> {
  const response = await fetch(new URL('/v1/scraps', baseUrl), { credentials: 'include' });
  if (!response.ok) return null;
  const value: unknown = await response.json();
  if (!value || typeof value !== 'object' || !Array.isArray((value as { scraps?: unknown }).scraps)) return null;
  const scrap = (value as { scraps: unknown[] }).scraps.find((item) => item && typeof item === 'object'
    && (item as { id?: unknown }).id === id) as SavedScrapReceipt | undefined;
  return scrap?.raw && typeof scrap.raw === 'object' && typeof scrap.raw.url === 'string'
    && /^https?:\/\//.test(scrap.raw.url) ? scrap : null;
}

export default function ShareReceivedPage() {
  const { config, sessionId } = useDaemon();
  const [state, setState] = useState<State>({ phase: 'loading', message: '공유 내용을 읽는 중…', saved: [], failed: [] });
  const [shareId, setShareId] = useState<string | null>(null);
  const [article, setArticle] = useState<SavedScrapReceipt | null>(null);
  const [retry, setRetry] = useState(0);
  const mounted = useRef(false);
  const inFlight = useRef<string | null>(null);
  const inFlightScope = useRef('');
  const currentScope = useRef('');
  const pendingScope = useRef('');
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const retrySave = useCallback(() => setRetry((value) => value + 1), []);

  useEffect(() => {
    let active = true;
    const scope = sessionId ? `${sessionId}\u0000${config.baseUrl}\u0000${config.token}` : '';
    currentScope.current = scope;
    // sessionId is filled in the same mount effect as the SSR-safe config.
    if (!sessionId) {
      setArticle(null);
      setState({ phase: 'failed', message: '회원 로그인이 필요합니다.', saved: [], failed: [] });
      return () => { active = false; };
    }
    const query = new URLSearchParams(window.location.search);
    const id = query.get('shared');
    const savedId = query.get('saved');
    setShareId(id);
    if (!id && savedId && config.baseUrl) {
      setArticle(null);
      void verifiedSavedArticle(config.baseUrl, savedId).then((receipt) => {
        if (!mounted.current || !active) return;
        setArticle(receipt);
        setState(receipt
          ? { phase: 'saved', message: '스크랩에 저장했습니다.', saved: ['링크'], failed: [] }
          : { phase: 'failed', message: '회원 스크랩을 찾지 못했습니다.', saved: [], failed: [] });
      }).catch(() => { if (mounted.current && active) setState({ phase: 'failed', message: '회원 스크랩을 불러오지 못했습니다.', saved: [], failed: [] }); });
      return () => { active = false; };
    }
    if (id && !config.baseUrl) {
      window.location.replace(`/app/chat?shared=${encodeURIComponent(id)}`);
      return () => { active = false; };
    }
    if (!id || inFlight.current) {
      if (!id) setState({ phase: 'failed', message: '공유 내용을 찾지 못했습니다. 다시 공유해 주세요.', saved: [], failed: [] });
      else if (inFlight.current !== id || inFlightScope.current !== scope) pendingScope.current = scope;
      return () => { active = false; };
    }
    inFlight.current = id;
    inFlightScope.current = scope;
    void (async () => {
      try {
        await withSharedPayloadLock(id, async () => {
        const payload = await takeSharedPayload(id, { drain: false });
        if (!payload) throw new Error('공유 내용을 찾지 못했습니다. 다시 공유해 주세요.');
        if (payload.missingFiles?.length) throw new Error(`공유 파일을 읽지 못했습니다: ${payload.missingFiles.join(', ')}. 다시 공유해 주세요.`);
        if (mounted.current && currentScope.current === scope) setState({ phase: 'saving', message: '스크랩에 저장하는 중…', saved: [], failed: [] });
        const completed = new Set(await readSharedPayloadProgress(id));
        const priorReceipt = completed.has('url') ? await readSharedPayloadReceipt(id, 'url') : null;
        // Legacy progress stored only a marker. Replaying the same idempotency key
        // recovers the server's persisted ID without creating another scrap.
        if (completed.has('url') && !priorReceipt) completed.delete('url');
        let articleReceipt = priorReceipt ? await verifiedSavedArticle(config.baseUrl, priorReceipt.id) : null;
        if (priorReceipt && !articleReceipt) throw new Error('현재 회원의 저장된 스크랩을 찾지 못했습니다.');
        const result = await saveSharedScraps(payload, {
          baseUrl: config.baseUrl,
          daemonToken: config.token,
          completedKeys: completed,
          onSaved: async (key, receipt) => {
            await markSharedPayloadProgress(id, key, receipt);
            completed.add(key);
            if (key === 'url') articleReceipt = receipt;
          },
        });
        if (mounted.current && currentScope.current === scope) setArticle(articleReceipt);
        if (result.failed.length === 0 && currentScope.current === scope) {
          await acknowledgeSharedPayloadFiles(id, payload.fileKeys);
          const url = new URL(window.location.href);
          url.searchParams.delete('shared');
          if (articleReceipt) url.searchParams.set('saved', articleReceipt.id);
          window.history.replaceState(window.history.state, '', url);
        }
        if (mounted.current && currentScope.current === scope) setState({
          phase: result.failed.length ? 'failed' : 'saved',
          message: result.failed.length ? '일부 스크랩을 저장하지 못했습니다. 다시 시도할 수 있습니다.' : '스크랩에 저장했습니다.',
          saved: result.saved, failed: result.failed,
        });
        });
      } catch (error) {
        if (error instanceof ScrapsUnavailableError || error instanceof ShareLockUnavailableError) {
          // The ABSORB route may land after this PWA build. Preserve the
          // existing chat share handoff until its server route is ready.
          if (mounted.current && currentScope.current === scope) window.location.replace(`/app/chat?shared=${encodeURIComponent(id)}`);
          return;
        }
        if (mounted.current && currentScope.current === scope) setState({ phase: 'failed', message: error instanceof Error ? error.message : String(error), saved: [], failed: [] });
      } finally {
        inFlight.current = null;
        inFlightScope.current = '';
        const resumeScope = pendingScope.current;
        pendingScope.current = '';
        if (resumeScope && resumeScope === currentScope.current && mounted.current) setRetry((value) => value + 1);
      }
    })();
    return () => { active = false; };
  }, [config.baseUrl, config.token, retry, sessionId]);

  return <main className="mx-auto flex w-full max-w-lg flex-col gap-4 px-5 py-12">
    <h1 className="text-2xl font-semibold">공유 스크랩</h1>
    <p role="status">{state.message}</p>
    {state.saved.length > 0 && <p className="text-sm text-muted-foreground">저장됨: {state.saved.join(', ')}</p>}
    {state.phase === 'saved' && article?.raw.url && <section aria-label="저장한 기사" data-scrap-id={article.id} className="rounded-lg border p-4">
      <p className="font-medium break-words">{article.raw.text?.trim().split('\n')[0] || article.raw.url}</p>
      <a href={article.raw.url} target="_blank" rel="noopener noreferrer" className="mt-2 block break-all text-sm underline">출처: {new URL(article.raw.url).hostname}</a>
    </section>}
    {state.failed.length > 0 && <ul className="list-disc pl-5 text-sm text-destructive">{state.failed.map((item) => <li key={item}>{item}</li>)}</ul>}
    <div className="flex gap-3">
      {state.phase === 'failed' && <button type="button" onClick={retrySave} className="rounded-md bg-primary px-4 py-2 text-primary-foreground">다시 시도</button>}
      {state.phase === 'saved' && <Link href={article ? `/scraps?selected=${encodeURIComponent(article.id)}` : '/scraps'} className="rounded-md bg-primary px-4 py-2 text-primary-foreground">저장한 스크랩 보기</Link>}
      {(state.phase === 'failed' || state.phase === 'saved') && <Link href={state.phase === 'failed' && shareId ? `/chat?shared=${encodeURIComponent(shareId)}` : '/chat'} className="rounded-md border px-4 py-2">채팅으로</Link>}
    </div>
  </main>;
}
