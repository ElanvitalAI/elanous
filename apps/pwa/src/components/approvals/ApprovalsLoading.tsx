'use client';

// Approvals load reads GitHub (cold ~5s): show that the machine is alive — spinner, a ticking clock, the step it waits on.
import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';

export const SLOW_AFTER_MS = 8_000;

/** Status text for the loading panel — pure so the wording and the slow hint are testable. */
export function loadingStatus(elapsedMs: number, view: 'open' | 'merged', target: number | null): { title: string; clock: string; hint: string | null } {
  const title = view === 'merged'
    ? 'GitHub 에서 승인해 머지된 PR 을 읽고 있습니다'
    : target ? `GitHub 에서 승인 대기 PR 과 #${target} 카드를 읽고 있습니다` : 'GitHub 에서 승인 대기 PR 을 읽고 있습니다';
  const clock = `${(Math.max(0, elapsedMs) / 1000).toFixed(1)}초`;
  const hint = elapsedMs >= SLOW_AFTER_MS ? '평소(2~5초)보다 오래 걸립니다 — GitHub 응답을 기다리는 중이며 멈추지 않았습니다.' : null;
  return { title, clock, hint };
}

export function ApprovalsLoading({ view, target }: { view: 'open' | 'merged'; target: number | null }) {
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(startedAt);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, []);
  const status = loadingStatus(now - startedAt, view, target);
  return <section role="status" aria-live="polite" aria-busy="true" className="space-y-3" data-approvals-loading>
    <div className="flex items-center gap-3 rounded-xl border border-blue-500/40 bg-blue-500/5 p-4">
      <Loader2 className="h-6 w-6 shrink-0 text-blue-500 motion-safe:animate-spin" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{status.title}</p>
        {status.hint && <p className="mt-1 text-sm text-amber-600 dark:text-amber-400">{status.hint}</p>}
      </div>
      <span className="font-mono text-lg tabular-nums text-blue-600 dark:text-blue-300" aria-label="경과 시간">{status.clock}</span>
    </div>
    <div className="h-1 overflow-hidden rounded-full bg-muted" aria-hidden>
      <div className="h-full w-1/3 rounded-full bg-blue-500 motion-safe:animate-[approvals-slide_1.2s_ease-in-out_infinite]" />
    </div>
    <style>{'@keyframes approvals-slide{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}'}</style>
    {[0, 1].map((i) => <div key={i} className="space-y-3 rounded-xl border border-border bg-card p-5 motion-safe:animate-pulse" aria-hidden>
      <div className="h-4 w-2/3 rounded bg-muted" />
      <div className="h-3 w-full rounded bg-muted" />
      <div className="h-3 w-5/6 rounded bg-muted" />
    </div>)}
  </section>;
}
