'use client';

// HARNESS-RUN-LIVE-GRAPH — /live-run follows the newest run; ?run=<runId> pins an explicit run.
import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { LiveRunAutoFollowPanel } from '@/components/live-run/LiveRunAutoFollowPanel';
import { LiveRunPanel } from '@/components/live-run/LiveRunPanel';
import { claimSetupLink, readSetupLinkToken } from '@/lib/setup-link';
import { loadDaemonConfig, saveDaemonConfig } from '@/lib/daemon-config';

export default function LiveRunPage() {
  return <Suspense fallback={<p className="p-4 text-sm">런 장면을 불러오는 중…</p>}><LiveRunRoute /></Suspense>;
}

function LiveRunRoute() {
  const params = useSearchParams();
  const router = useRouter();
  const [linkState, setLinkState] = useState<'checking' | 'ready' | 'failed'>('checking');
  const claimAttempt = useRef<ReturnType<typeof claimSetupLink> | null>(null);
  const claimState = useRef<'pending' | 'processing' | 'handled'>('pending');
  const claimActive = useRef(false);
  useEffect(() => {
    claimActive.current = true;
    if (claimState.current !== 'pending') return () => { claimActive.current = false; };
    if (typeof window === 'undefined') {
      setLinkState('ready');
      return () => { claimActive.current = false; };
    }
    if (!claimAttempt.current) {
      const token = readSetupLinkToken(window.location?.hash ?? '');
      if (!token) {
        claimState.current = 'handled';
        setLinkState('ready');
        return () => { claimActive.current = false; };
      }
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
      claimAttempt.current = claimSetupLink(window.location.origin, token);
    }
    void claimAttempt.current.then((claim) => {
      if (!claimActive.current || claimState.current !== 'pending') return;
      claimState.current = 'processing';
      if (claim.status !== 'claimed') {
        claimState.current = 'handled';
        setLinkState('failed');
        return;
      }
      const baseUrl = window.location.origin;
      saveDaemonConfig({ baseUrl, token: claim.bearer });
      localStorage.setItem('elanous.daemon.setupScopeExpiresAt', String(claim.expiresAt));
      claimState.current = 'handled';
      setLinkState('ready');
      window.location.replace(window.location.pathname + window.location.search);
    }).catch(() => {
      if (claimActive.current && claimState.current !== 'handled') {
        claimState.current = 'handled';
        setLinkState('failed');
      }
    });
    return () => { claimActive.current = false; };
  }, []);
  if (linkState === 'checking') return <p role="status" className="p-4 text-sm">기기 연결을 확인하는 중…</p>;
  if (linkState === 'failed') return <p role="alert" className="p-4 text-sm">연결 링크가 만료됐거나 이미 사용됐습니다. 새 링크를 요청해 주세요.</p>;
  const runId = params.get('run')?.trim() || null;
  if (!runId) return <LiveRunAutoFollowPanel />;
  const stageMode = params.get('stage') === '1';
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!stageMode && <div className="flex shrink-0 justify-end px-4 pt-2"><button type="button" aria-label="최신 런 자동 따라가기" onClick={() => router.replace('/live-run/')} className="rounded border border-border bg-surface px-2 py-1 text-xs text-text-secondary hover:bg-surface-elevated">
        최신 런 자동 따라가기
      </button></div>}
      <LiveRunPanel />
    </div>
  );
}
