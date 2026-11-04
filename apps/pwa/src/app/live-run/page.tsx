'use client';

// HARNESS-RUN-LIVE-GRAPH — /live-run follows the newest run; ?run=<runId> pins an explicit run.
import { Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { LiveRunAutoFollowPanel } from '@/components/live-run/LiveRunAutoFollowPanel';
import { LiveRunPanel } from '@/components/live-run/LiveRunPanel';

export default function LiveRunPage() {
  return <Suspense fallback={<p className="p-4 text-sm">런 장면을 불러오는 중…</p>}><LiveRunRoute /></Suspense>;
}

function LiveRunRoute() {
  const params = useSearchParams();
  const router = useRouter();
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
