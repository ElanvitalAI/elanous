'use client';

// DEMO-GRAPH-LIVE-SHOWCASE — RunGraphView의 명시적 쇼케이스 면.
// 장면 엔진을 새로 만들지 않는다: 런 목록=liveRunPicks(실제 런), 장면·노드 탄생·상태 발광·간선 흐름=LiveRunGraph
// (sceneAt/outcomeState/takenEdges/activeEdge), 선언 밖 노드 강조=mergeWalked, 배선=runGraphToFlow.
// 첫 조각은 현재 사건 장면까지만 다룬다. 리포트·재생·접기는 후속 조각이다.

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNexusClient } from '@/nexus/hooks/use-nexus-context';
import { LiveRunGraph } from '@/components/live-run/LiveRunGraph';
import { liveRunPicks, runStatusLabel } from '@/lib/live-run-view';

/** Explicit showcase surface of RunGraphView — real run picker and live event scene. */
export function RunGraphShowcase({ onExit }: { onExit?: () => void } = {}) {
  const client = useNexusClient();
  const runs = useQuery({
    queryKey: ['showcase-runs'],
    queryFn: () => client.getHarnessRunsSince(7 * 24 * 3600_000),
  });
  const picks = useMemo(() => runs.data ? liveRunPicks(runs.data.entries, runs.data.finished ?? []) : [], [runs.data]);
  const [runId, setRunId] = useState<string | null>(null);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <h2 className="text-xs font-semibold">쇼케이스 — 실제 런 장면</h2>
        {onExit && (
          <button type="button" data-testid="showcase-return" onClick={onExit}
            className="rounded border border-border px-2 py-1 text-xs">편집으로 복귀</button>
        )}
      </div>
      <div role="group" aria-label="쇼케이스 런 목록" className="flex flex-wrap gap-2 px-3 text-xs">
        {runs.isLoading && <p className="text-text-tertiary">런 목록을 읽는 중…</p>}
        {runs.isError && <p role="alert" className="text-error">런 목록을 읽지 못했습니다.</p>}
        {picks.map((pick) => (
          <button key={pick.runId} type="button" data-testid={`showcase-run-${pick.runId}`} onClick={() => setRunId(pick.runId)}
            className={`rounded border px-2 py-1 text-left ${runId === pick.runId ? 'border-primary text-primary' : 'border-border text-text-secondary'}`}>
            <span className="block font-mono">{pick.runId}</span>
            <span className="block text-[10px] text-text-tertiary">{pick.live ? '● 도는 중' : runStatusLabel('completed')} · {pick.label}</span>
          </button>
        ))}
      </div>
      {runId ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <LiveRunGraph runId={runId} sceneOnly />
        </div>
      ) : (
        <p className="px-3 text-xs text-text-tertiary">런을 골라 장면을 보세요 — 노드 탄생·상태 발광·간선 흐름은 원장 사건으로만 움직입니다.</p>
      )}
    </div>
  );
}
