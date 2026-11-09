'use client';

import { useMemo } from 'react';
import type { GateShard, ReleaseRun } from '@/lib/ops-api';
import type { ReleaseGateProgressEvent } from '@/lib/inside-events';
import { currentNodeId, nodeTime } from './ReleaseFlow';
import { GraphCanvasRunStatus, type GraphRunNodeStatus } from '@/components/editor/GraphCanvasRunStatus';

function shardRows(run: ReleaseRun, events: ReleaseGateProgressEvent[]): GateShard[] {
  const byId = new Map((run.gateShards?.shards ?? []).map((shard) => [shard.id, { ...shard }]));
  for (const event of events) {
    if (event.phase !== 'shard-decision' || !event.shard || !event.decision) continue;
    const prior = byId.get(event.shard) ?? { id: event.shard, state: 'pending' as const };
    byId.set(event.shard, { ...prior, reuseDecision: event.decision, ...(event.reason ? { reuseReason: event.reason } : {}) });
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

function GateReuseSummary({ run, events }: { run: ReleaseRun; events: ReleaseGateProgressEvent[] }): React.ReactNode {
  const shards = useMemo(() => shardRows(run, events), [run.gateShards?.shards, events]);
  const latestPlan = [...events].reverse().find((event) => event.phase === 'shard-plan');
  const reuseCount = shards.filter((shard) => shard.reuseDecision === 'reuse').length;
  const rerunCount = shards.filter((shard) => shard.reuseDecision === 'rerun').length;
  const total = latestPlan?.shardTotal ?? run.gateShards?.summary.total ?? shards.length;
  const reasons = new Map<string, number>();
  for (const shard of shards) if (shard.reuseReason) reasons.set(shard.reuseReason, (reasons.get(shard.reuseReason) ?? 0) + 1);
  if (latestPlan?.rerunReasons) for (const [reason, count] of Object.entries(latestPlan.rerunReasons)) reasons.set(reason, count);
  const radiusInvalidated = latestPlan?.radiusInvalidatedCount ?? reasons.get('radius-invalidated') ?? 0;
  if (!total && !shards.length && events.length === 0 && !run.gateShards) return null;
  return <section aria-label="게이트 조각 재사용 판정" className="space-y-3 rounded-xl border bg-card p-4">
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
      <h3 className="font-semibold">게이트 조각</h3>
      <p className="text-sm tabular-nums">재사용 {reuseCount} · 재실행 {rerunCount}{total ? ` · 전체 ${total}` : ''}</p>
    </div>
    {total > 0 && radiusInvalidated === total && <p role="status" aria-label={`전체 ${total}개 조각이 radius-invalidated`}
      className="rounded-lg border-2 border-amber-500 bg-amber-500/10 p-3 text-base font-bold text-amber-900 dark:text-amber-200">
      전체 {total}조각 재실행 · 모두 radius-invalidated
    </p>}
    {radiusInvalidated > 0 && radiusInvalidated !== total && <p className="text-sm font-semibold">radius-invalidated {radiusInvalidated}{total ? ` / ${total}` : ''}</p>}
    {reasons.size > 0 && <ul aria-label="재사용·재실행 사유" className="flex flex-wrap gap-2 text-xs">
      {[...reasons].sort(([a], [b]) => a.localeCompare(b)).map(([reason, count]) => <li key={reason} className="rounded-full border px-2 py-1">
        {reason} · {count}
      </li>)}
    </ul>}
    {shards.length > 0 && <details open>
      <summary className="cursor-pointer text-sm font-medium">조각별 판정 {shards.length}</summary>
      <ul aria-label="조각별 판정" className="mt-2 grid max-h-80 gap-2 overflow-auto sm:grid-cols-2 lg:grid-cols-3">
        {shards.map((shard) => <li key={shard.id} data-shard-decision={shard.reuseDecision ?? 'pending'}
          data-shard-state={shard.state} className="min-w-0 rounded-md border p-2 text-xs">
          <span className="font-mono font-semibold">{shard.id}</span>
          <span className="ml-2 font-semibold">{shard.reuseDecision === 'reuse' ? '재사용 · ' : shard.reuseDecision === 'rerun' ? '재실행 · ' : ''}{shard.state}</span>
          <span className="mt-1 block break-words text-muted-foreground">{shard.reuseReason ?? shard.waitReason ?? '사유 미기록'}</span>
        </li>)}
      </ul>
    </details>}
  </section>;
}

/** Release adapter. The canvas itself accepts a source-neutral graph/status contract for future app deployment runs. */
export function ReleaseGraphRunView({ run, events = [], onNode }: {
  run: ReleaseRun;
  events?: ReleaseGateProgressEvent[];
  onNode?: (nodeId: string) => void;
}): React.ReactNode {
  const activeNode = currentNodeId(run);
  const statuses = useMemo<GraphRunNodeStatus[]>(() => {
    const recorded = new Map(run.nodes.map((node) => [node.nodeId, node]));
    const finished = /^(done|completed|success|succeeded|failed|error|cancelled|aborted)$/i.test(run.status);
    return (run.graph?.nodes ?? []).map((definition) => {
      const node = recorded.get(definition.nodeId);
      const state = node?.ok === true ? 'done' : node?.ok === false ? 'failed'
        : !finished && node?.ok === null && (node.startedAt || activeNode === definition.nodeId) ? 'running' : 'pending';
      return { nodeId: definition.nodeId, kind: definition.kind, state,
        time: nodeTime(node, Date.now()), ...(node?.summary ? { summary: node.summary.split(/\r?\n/, 1)[0] } : {}) };
    });
  }, [run.graph, run.nodes, run.status, activeNode]);
  const parallelCount = statuses.filter((node) => node.state === 'running').length;
  const graph = run.graph;
  if (!graph) return <p role="status" className="rounded-lg border p-3 text-sm text-muted-foreground">이 런에는 그래프 정의가 연결되지 않았습니다.</p>;
  const clickable = new Set(run.nodes.map((node) => node.nodeId));
  return <div className="space-y-4" data-run-id={run.runId}>
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
      <span className="font-semibold">병렬 동시 노드 {parallelCount}</span>
      <span className="text-muted-foreground">노드 {graph.nodes.length} · needs 간선 {graph.nodes.reduce((sum, node) => sum + node.needs.length, 0)}</span>
    </div>
    <GraphCanvasRunStatus graph={graph} statuses={statuses} onNode={onNode ? (nodeId) => { if (clickable.has(nodeId)) onNode(nodeId); } : undefined} />
    <GateReuseSummary run={run} events={events} />
  </div>;
}
