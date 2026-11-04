'use client';

// HARNESS-RUN-LIVE-GRAPH — 런 고르개(도는 런 ⊕ 최근 24시간 끝난 런) ⊕ 고른 런 하나의 장면.
import { useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useNexusClient, useOptionalNexusClient } from '@/nexus/hooks/use-nexus-context';
import { liveRunPicks } from '@/lib/live-run-view';
import { kstClock } from '@/lib/live-run-scene';
import { LiveRunGraph } from './LiveRunGraph';

const DAY_MS = 24 * 3600_000;

export function LiveRunPanel() {
  // 데몬에 붙지 않은 화면(정적 export 의 사전 렌더 포함)에서는 안내만 낸다.
  const client = useOptionalNexusClient();
  if (!client) {
    return (
      <div className="mx-auto max-w-2xl space-y-2 p-6">
        <h1 className="text-xl font-semibold tracking-tight">런 장면</h1>
        <p className="text-sm text-text-secondary">데몬에 연결되면 하니스 런 하나가 도는 장면을 그립니다.</p>
      </div>
    );
  }
  return <LiveRunPanelInner />;
}

function LiveRunPanelInner() {
  const client = useNexusClient();
  const router = useRouter();
  const params = useSearchParams();
  const runId = params.get('run')?.trim() || null;
  const [pickerOpen, setPickerOpen] = useState(false);
  const stageMode = params.get('stage') === '1' && Boolean(runId);
  const since = useMemo(() => Date.now() - DAY_MS, []);
  const runs = useQuery({
    queryKey: ['harness-runs-since', since],
    queryFn: () => client.getHarnessRunsSince(since, { includeLanded: false }),
    // A pinned demo URL already names the run to render; skip the broad run ledger scan for that view.
    enabled: !runId || pickerOpen,
    refetchInterval: 30_000,
  });
  const picks = useMemo(() => runs.data ? liveRunPicks(runs.data.entries ?? [], runs.data.finished ?? []) : [], [runs.data]);
  const pick = (id: string) => router.replace(`/live-run/?run=${encodeURIComponent(id)}`);
  const enterStage = () => {
    if (!runId) return;
    const fullscreen = document.documentElement.requestFullscreen;
    if (fullscreen) void fullscreen.call(document.documentElement).catch(() => undefined);
    router.replace(`/live-run/?run=${encodeURIComponent(runId)}&stage=1`, { scroll: false });
  };
  const leaveStage = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    router.replace(`/live-run/?run=${encodeURIComponent(runId ?? '')}`, { scroll: false });
  };

  return (
    <div className={stageMode ? 'fixed inset-0 z-[100] flex min-h-0 flex-col overflow-hidden bg-[#070b18] p-3 text-white sm:p-5' : 'flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4'}>
      <header className={`flex flex-wrap items-center gap-2 ${stageMode ? 'mb-2 border-b border-white/10 pb-2' : ''}`}>
        <h1 className={`font-semibold ${stageMode ? 'text-lg tracking-[0.18em] text-cyan-100 sm:text-xl' : 'text-base text-text-primary'}`}>{stageMode ? 'ELANOUS · LIVE GRAPH' : '런 장면'}</h1>
        <span className={`text-xs ${stageMode ? 'text-white/55' : 'text-text-tertiary'}`}>{stageMode ? 'DEMO1104 · GRAPH SHOWSTOPPER' : '하니스 런 하나가 실제로 밟은 노드·간선 (라이브 · 리플레이)'}</span>
        {!stageMode && <label className="flex w-full min-w-0 items-center gap-1 text-xs text-text-secondary sm:ml-auto sm:w-auto sm:min-w-[320px]">
          <span className="shrink-0">런</span>
          <select aria-label="런 고르기" value={runId ?? ''} onChange={(event) => { if (event.target.value) pick(event.target.value); }}
            onFocus={() => setPickerOpen(true)} onBlur={() => setPickerOpen(false)}
            className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-xs text-text-primary">
            <option value="">{runId ? '현재 런 · 목록 열기' : runs.isLoading ? '불러오는 중…' : picks.length ? '런을 고르세요' : '최근 24시간 런 없음'}</option>
            {runId && !picks.some((item) => item.runId === runId) && <option value={runId}>{runId}</option>}
            {picks.some((item) => item.live) && <optgroup label="도는 중">
              {picks.filter((item) => item.live).map((item) => <option key={item.runId} value={item.runId}>● {item.label}</option>)}
            </optgroup>}
            {picks.some((item) => !item.live) && <optgroup label="끝난 런 (최근 24시간)">
              {picks.filter((item) => !item.live).map((item) => <option key={item.runId} value={item.runId}>{item.at ? `${kstClock(item.at).slice(0, 5)} · ` : ''}{item.label}</option>)}
            </optgroup>}
          </select>
        </label>}
        {runId && <button type="button" onClick={stageMode ? leaveStage : enterStage} className={`rounded-lg border px-3 py-1.5 text-xs font-semibold ${stageMode ? 'border-white/20 bg-white/10 text-white hover:bg-white/20' : 'ml-auto border-border text-text-primary hover:bg-surface-elevated'}`}>
          {stageMode ? '무대 모드 종료' : '⛶ 무대 모드'}
        </button>}
      </header>
      {runs.isError && <p role="status" className="text-xs text-warning">런 목록을 읽지 못했습니다 — 주소에 ?run=&lt;runId&gt; 를 주면 그 런은 그대로 그립니다.</p>}
      {runId ? <LiveRunGraph key={runId} runId={runId} initialFolded={params.get('units') === 'folded'} stageMode={stageMode} /> : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {picks.slice(0, 12).map((item) => (
            <li key={item.runId}>
              <button type="button" onClick={() => pick(item.runId)} className="w-full rounded-lg border border-border bg-surface p-3 text-left hover:bg-surface-elevated">
                <span className={`text-xs font-semibold ${item.live ? 'text-amber-500' : 'text-text-tertiary'}`}>{item.live ? '● 도는 중' : `끝남 ${item.at ? kstClock(item.at) : ''}`}</span>
                <span className="mt-1 block truncate text-sm text-text-primary">{item.label}</span>
                <span className="block font-mono text-[11px] text-text-tertiary">{item.runId}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
