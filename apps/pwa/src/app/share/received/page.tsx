'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { takeSharedPayload, acknowledgeSharedPayloadFiles, markSharedPayloadProgress, readSharedPayloadProgress, withSharedPayloadLock, ShareLockUnavailableError } from '@/lib/share-target-store';
import { saveSharedScraps, ScrapsUnavailableError } from '@/lib/share-scraps';

type State = { phase: 'loading' | 'saving' | 'saved' | 'failed'; message: string; saved: string[]; failed: string[] };

export default function ShareReceivedPage() {
  const { config, sessionId } = useDaemon();
  const [state, setState] = useState<State>({ phase: 'loading', message: '공유 내용을 읽는 중…', saved: [], failed: [] });
  const [shareId, setShareId] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const mounted = useRef(false);
  const inFlight = useRef<string | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const retrySave = useCallback(() => setRetry((value) => value + 1), []);

  useEffect(() => {
    // sessionId is filled in the same mount effect as the SSR-safe config.
    if (!sessionId) return;
    const id = new URLSearchParams(window.location.search).get('shared');
    setShareId(id);
    if (id && !config.baseUrl) {
      window.location.replace(`/app/chat?shared=${encodeURIComponent(id)}`);
      return;
    }
    if (!id || inFlight.current === id) {
      if (!id) setState({ phase: 'failed', message: '공유 내용을 찾지 못했습니다. 다시 공유해 주세요.', saved: [], failed: [] });
      return;
    }
    inFlight.current = id;
    void (async () => {
      try {
        await withSharedPayloadLock(id, async () => {
        const payload = await takeSharedPayload(id, { drain: false });
        if (!payload) throw new Error('공유 내용을 찾지 못했습니다. 다시 공유해 주세요.');
        if (payload.missingFiles?.length) throw new Error(`공유 파일을 읽지 못했습니다: ${payload.missingFiles.join(', ')}. 다시 공유해 주세요.`);
        if (mounted.current) setState({ phase: 'saving', message: '스크랩에 저장하는 중…', saved: [], failed: [] });
        const completed = new Set(await readSharedPayloadProgress(id));
        const result = await saveSharedScraps(payload, {
          baseUrl: config.baseUrl,
          daemonToken: config.token,
          completedKeys: completed,
          onSaved: async (key) => {
            await markSharedPayloadProgress(id, key);
            completed.add(key);
          },
        });
        if (result.failed.length === 0) {
          await acknowledgeSharedPayloadFiles(id, payload.fileKeys);
          const url = new URL(window.location.href);
          url.searchParams.delete('shared');
          window.history.replaceState(window.history.state, '', url);
        }
        if (mounted.current) setState({
          phase: result.failed.length ? 'failed' : 'saved',
          message: result.failed.length ? '일부 스크랩을 저장하지 못했습니다. 다시 시도할 수 있습니다.' : '스크랩에 저장했습니다.',
          saved: result.saved, failed: result.failed,
        });
        });
      } catch (error) {
        if (error instanceof ScrapsUnavailableError || error instanceof ShareLockUnavailableError) {
          // The ABSORB route may land after this PWA build. Preserve the
          // existing chat share handoff until its server route is ready.
          window.location.replace(`/app/chat?shared=${encodeURIComponent(id)}`);
          return;
        }
        if (mounted.current) setState({ phase: 'failed', message: error instanceof Error ? error.message : String(error), saved: [], failed: [] });
      } finally { inFlight.current = null; }
    })();
  }, [config.baseUrl, config.token, retry, sessionId]);

  return <main className="mx-auto flex w-full max-w-lg flex-col gap-4 px-5 py-12">
    <h1 className="text-2xl font-semibold">공유 스크랩</h1>
    <p role="status">{state.message}</p>
    {state.saved.length > 0 && <p className="text-sm text-muted-foreground">저장됨: {state.saved.join(', ')}</p>}
    {state.failed.length > 0 && <ul className="list-disc pl-5 text-sm text-destructive">{state.failed.map((item) => <li key={item}>{item}</li>)}</ul>}
    <div className="flex gap-3">
      {state.phase === 'failed' && <button type="button" onClick={retrySave} className="rounded-md bg-primary px-4 py-2 text-primary-foreground">다시 시도</button>}
      {(state.phase === 'failed' || state.phase === 'saved') && <Link href={state.phase === 'failed' && shareId ? `/chat?shared=${encodeURIComponent(shareId)}` : '/chat'} className="rounded-md border px-4 py-2">채팅으로</Link>}
    </div>
  </main>;
}
