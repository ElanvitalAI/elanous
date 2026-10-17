'use client';

// /live — 기본은 LivePanel(라이브 보드)을 그대로 그린다(보존 계약: 다른 화면·명령의 기본 동작은 그대로).
// `?run=<runId>` 를 붙이면 같은 경로에서 LiveRunGraph 로 그 런 하나를 확대해 보여 준다(390px 시연 경로).
import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { LivePanel } from '@/components/live/LivePanel';
import { LiveRunGraph } from '@/components/live-run/LiveRunGraph';

function LiveRoute() {
  const runId = useSearchParams().get('run');
  if (runId) return <LiveRunGraph runId={runId} />;
  return <LivePanel />;
}

export default function LivePage() {
  return (
    <Suspense fallback={<p className="p-4 text-sm text-text-tertiary">라이브를 여는 중…</p>}>
      <LiveRoute />
    </Suspense>
  );
}
