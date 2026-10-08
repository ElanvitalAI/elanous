'use client';

// HARNESS-RUN-LIVE-GRAPH — 하니스 런 하나가 도는 장면(/live-run/?run=<runId>).
import { Suspense } from 'react';
import { LiveRunPanel } from '@/components/live-run/LiveRunPanel';

export default function LiveRunPage() {
  return <Suspense fallback={<p className="p-4 text-sm">런 장면을 불러오는 중…</p>}><LiveRunPanel /></Suspense>;
}
