'use client';

// /live-run without ?run= follows the newest run while preserving explicit-run replay in LiveRunPanel.
import { useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useNexusClient, useOptionalNexusClient } from '@/nexus/hooks/use-nexus-context';
import { latestLiveRunId, liveRunPicks } from '@/lib/live-run-view';
import { kstClock } from '@/lib/live-run-scene';
import { LiveRunGraph } from './LiveRunGraph';

const DAY_MS = 24 * 3600_000;
const AUTO_FOLLOW_VALUE = '__auto_follow_latest__';

export function LiveRunAutoFollowPanel() {
  const client = useOptionalNexusClient();
  if (!client) {
    return (
      <div className="mx-auto max-w-2xl space-y-2 p-6">
        <h1 className="text-xl font-semibold tracking-tight">런 장면</h1>
        <p className="text-sm text-text-secondary">데몬에 연결되면 최근 하니스 런을 자동으로 따라갑니다.</p>
      </div>
    );
  }
  return <LiveRunAutoFollowPanelInner />;
}

function LiveRunAutoFollowPanelInner() {
  const client = useNexusClient();
  const router = useRouter();
  const params = useSearchParams();
  const since = useMemo(() => Date.now() - DAY_MS, []);
  const runs = useQuery({
    queryKey: ['harness-runs-since', since],
    queryFn: () => client.getHarnessRunsSince(since, { includeLanded: false }),
    refetchInterval: 30_000,
  });
  const picks = useMemo(() => runs.data ? liveRunPicks(runs.data.entries ?? [], runs.data.finished ?? []) : [], [runs.data]);
  const runId = latestLiveRunId(picks);
  const pick = (id: string) => router.replace(`/live-run/?run=${encodeURIComponent(id)}`);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="text-base font-semibold text-text-primary">런 장면</h1>
        <span className="text-xs text-text-tertiary">최신 세션 런을 자동으로 따라갑니다 (라이브 · 리플레이)</span>
        <label className="flex w-full min-w-0 items-center gap-1 text-xs text-text-secondary sm:ml-auto sm:w-auto sm:min-w-[320px]">
          <span className="shrink-0">런</span>
          <select aria-label="런 고르기" value={AUTO_FOLLOW_VALUE}
            onChange={(event) => { if (event.target.value && event.target.value !== AUTO_FOLLOW_VALUE) pick(event.target.value); }}
            className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-xs text-text-primary">
            <option value={AUTO_FOLLOW_VALUE}>{runs.isLoading ? '불러오는 중…' : '최신 런 자동 따라가기'}</option>
            {picks.some((item) => item.live) && <optgroup label="도는 중">
              {picks.filter((item) => item.live).map((item) => <option key={item.runId} value={item.runId}>● {item.label}</option>)}
            </optgroup>}
            {picks.some((item) => !item.live) && <optgroup label="끝난 런 (최근 24시간)">
              {picks.filter((item) => !item.live).map((item) => <option key={item.runId} value={item.runId}>{item.at ? `${kstClock(item.at).slice(0, 5)} · ` : ''}{item.label}</option>)}
            </optgroup>}
          </select>
        </label>
      </header>
      {runs.isError && <p role="status" className="text-xs text-warning">런 목록을 읽지 못했습니다.</p>}
      {runId ? <LiveRunGraph key={runId} runId={runId} initialFolded={params.get('units') === 'folded'} /> : (
        <p role="status" className="rounded-lg border border-border bg-surface p-4 text-sm text-text-secondary">
          {runs.isLoading ? '최근 런 목록을 불러오는 중입니다.' : '최근 24시간 런이 없습니다.'}
        </p>
      )}
    </div>
  );
}
