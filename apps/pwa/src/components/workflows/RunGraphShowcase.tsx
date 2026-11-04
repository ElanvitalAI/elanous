'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNexusClient } from '@/nexus/hooks/use-nexus-context';
import { LiveRunGraph } from '@/components/live-run/LiveRunGraph';
import { liveRunPicks } from '@/lib/live-run-view';
import { runGraphAdaptiveEvidence } from '@/lib/run-graph-flow';
import { kstClock } from '@/lib/live-run-scene';
import type { HarnessRunTraversal } from '@/nexus/client';

const PANELS = ['리서치', '업무 비서(리니어·흡수·브라우저)', '만드는 엘라누스(마법사·손·영상)'] as const;

function RunPanel({ index, title, runId, picks, selectionVersion, onSelect }: {
  index: number;
  title: string;
  runId: string | null;
  picks: ReturnType<typeof liveRunPicks>;
  selectionVersion: number;
  onSelect: (runId: string | null) => void;
}) {
  const client = useNexusClient();
  const traversal = useQuery({
    queryKey: ['harness-run-traversal', runId],
    queryFn: () => client.getHarnessRunTraversal(runId!),
    enabled: runId !== null,
    refetchInterval: (query) => (query.state.data as HarnessRunTraversal | undefined)?.status === 'running' ? 4000 : false,
  });
  const evidence = useMemo(() => runGraphAdaptiveEvidence(traversal.data?.graphEvents), [traversal.data?.graphEvents]);
  const [nodeSelection, setNodeSelection] = useState<{ version: number; nodeId: string | null }>({ version: -1, nodeId: null });
  const selectedNode = nodeSelection.version === selectionVersion ? nodeSelection.nodeId : null;
  const [reportState, setReportState] = useState<{ version: number; open: boolean }>({ version: -1, open: false });
  const [focusResetVersion, setFocusResetVersion] = useState(0);
  const reportOpen = reportState.version === selectionVersion && reportState.open;
  const selectedSteps = traversal.data?.steps.filter((step) => step.node === selectedNode) ?? [];
  const selectedEvents = traversal.data?.graphEvents?.filter((event) =>
    (event.type === 'node-added' && event.node === selectedNode)
    || (event.type === 'unit-expanded' && event.node === selectedNode)
    || (event.type === 'unit-collapsed' && event.node === selectedNode)
    || (event.type === 'edge-rerouted' && (event.from === selectedNode || event.to === selectedNode)),
  ) ?? [];
  const run = traversal.data;
  const journeyEdges = run?.journeyEdges ?? [];
  const elapsed = run?.startedAt && run.endedAt
    ? Math.max(0, Date.parse(run.endedAt) - Date.parse(run.startedAt))
    : null;

  return (
    <section aria-label={`${title} 그래프 패널`} data-testid={`showcase-panel-${index}`} className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-surface">
      <header className="flex items-center gap-2 border-b border-border p-2">
        <h3 className="shrink-0 text-xs font-semibold">{index + 1}. {title}</h3>
        <select aria-label={`${title} 실제 런 선택`} data-testid={`showcase-run-select-${index}`} value={runId ?? ''}
          onChange={(event) => onSelect(event.target.value || null)} className="min-w-0 flex-1 rounded border border-border bg-surface px-2 py-1 text-[10px]">
          <option value="">실제 런 선택</option>
          {picks.map((pick) => (
            <option key={pick.runId} value={pick.runId}>{pick.live ? '도는 중' : '완료'} · {pick.label} · {pick.runId}</option>
          ))}
        </select>
      </header>
      {runId ? (
        <>
          <div role="group" aria-label={`${title} 적응형 그래프 사건`} aria-live="polite" className="grid grid-cols-3 gap-1 p-2 text-[10px]">
            <section data-testid={`arg-added-panel-${index}`} className={`min-w-0 rounded border border-border p-1 ${evidence.addedNodes.length > 0 ? 'animate-pulse ring-2 ring-primary/50 motion-reduce:animate-none' : ''}`}>
              <h4 className="font-semibold">노드 추가</h4>
              <p className="font-mono text-base" data-testid={`arg-added-count-${index}`}>{evidence.addedNodes.length}</p>
              {evidence.addedNodes.map((event) => <p key={`${event.seq}:${event.node}`} className="truncate text-text-secondary" title={event.reason}>{event.node} · {event.kind}</p>)}
            </section>
            <section data-testid={`arg-depth-panel-${index}`} className={`min-w-0 rounded border border-border p-1 ${evidence.depthChanges.some((event) => event.type === 'unit-expanded') ? 'animate-pulse ring-2 ring-amber-500/50 motion-reduce:animate-none' : ''}`}>
              <h4 className="font-semibold">깊이 상승</h4>
              <p className="font-mono text-base" data-testid={`arg-depth-count-${index}`}>{evidence.depthChanges.filter((event) => event.type === 'unit-expanded').length}</p>
              {evidence.depthChanges.filter((event) => event.type === 'unit-expanded').map((event) => <p key={`${event.seq}:${event.node}`} className="truncate text-text-secondary">{event.node} · 해상도 {event.resolution}</p>)}
            </section>
            <section data-testid={`arg-repair-panel-${index}`} className={`min-w-0 rounded border border-border p-1 ${evidence.repairs.length > 0 ? 'animate-pulse ring-2 ring-error/50 motion-reduce:animate-none' : ''}`}>
              <h4 className="font-semibold">경로 수리</h4>
              <p className="font-mono text-base" data-testid={`arg-repair-count-${index}`}>{evidence.repairs.length}</p>
              {evidence.repairs.map((event) => <p key={`${event.seq}:${event.from}:${event.to}`} className="truncate text-text-secondary" title={event.reason}>{event.from} → {event.to}</p>)}
            </section>
          </div>
          {evidence.orderedEvents.length > 0 && (
            <ol aria-label={`${title} 적응 장면 순서`} data-testid={`arg-event-stream-${index}`} className="mx-2 mb-2 flex flex-wrap gap-1 text-[10px]">
              {evidence.orderedEvents.map((event) => {
                const label = event.type === 'node-added'
                  ? `${event.kind === 'hand' ? '손' : '노드 추가'} · ${event.node}`
                  : event.type === 'unit-expanded'
                    ? `깊이 상승 · ${event.node} · ${event.resolution}`
                    : event.type === 'edge-rerouted'
                      ? `경로 수리 · ${event.from} → ${event.to}`
                      : `깊이 조정 · ${event.node} · ${event.resolution}`;
                return <li key={`${event.seq}:${event.type}`} data-event-seq={event.seq} className="rounded-full border border-primary/40 bg-primary/10 px-2 py-1 font-medium text-text-primary">{label}</li>;
              })}
            </ol>
          )}
          {journeyEdges.length > 0 && (
            <section aria-label={`${title} 선택 경로 근거`} data-testid={`arg-route-outcome-${index}`} className="mx-2 mb-2 rounded border border-primary/40 bg-primary/5 p-2 text-[10px]">
              <h4 className="font-semibold">run ledger 선택 경로 · selector={journeyEdges.every((edge) => edge.source === 'graph') ? 'graph' : 'mixed'}</h4>
              <ol className="mt-1 space-y-0.5">
                {journeyEdges.map((edge, edgeIndex) => <li key={`${edge.seq ?? edgeIndex}:${edge.from}:${edge.taken}`}>
                  {edge.from} · {edge.label} → {edge.taken}
                  {edge.injected ? ` · injected: mock-outcome(${edge.mockOutcome ?? 'unknown'})` : ''}
                </li>)}
              </ol>
            </section>
          )}
          <section aria-label={`${title} 손 노드 카드`} data-testid={`arg-hand-card-${index}`} className="mx-2 mb-2 rounded border border-border p-2 text-[10px]">
            <h4 className="font-semibold">손 노드 · 누가 무엇을</h4>
            {evidence.handNodes.length > 0
              ? evidence.handNodes.map((event) => <p key={`${event.seq}:${event.node}`} className="truncate text-text-secondary" title={event.what ?? event.reason}>{event.who ?? event.decider} → {event.what ?? event.node}{event.missionId ? ` · ${event.missionId}` : ''}</p>)
              : <p className="text-text-tertiary">이 런 원장에 기록된 손 노드 없음</p>}
          </section>
          {selectedNode && (
            <section aria-label={`${title} 노드 근거 미리보기`} data-testid={`node-evidence-${index}`} className="mx-2 mb-2 rounded border border-primary/40 bg-primary/5 p-2 text-[10px]">
              <header className="flex items-center gap-2">
                <h4 className="font-semibold">근거 · <span className="font-mono">{selectedNode}</span></h4>
                <button type="button" className="ml-auto rounded border border-border px-1.5" onClick={() => {
                  setNodeSelection({ version: selectionVersion, nodeId: null });
                  setFocusResetVersion((version) => version + 1);
                }}>닫기</button>
              </header>
              {selectedSteps.length > 0 ? <ol className="mt-1 space-y-1">
                {selectedSteps.map((step, stepIndex) => <li key={`${step.at}:${stepIndex}`}>
                  방문 {step.visit} · {step.outcome ?? '도는 중'} · <time dateTime={step.at} title={step.at}>{kstClock(step.at)}</time>{step.detail ? ` · ${step.detail}` : ''}
                </li>)}
              </ol> : <p className="mt-1 text-text-tertiary">이 노드의 traversal step 기록 없음</p>}
              {selectedEvents.length > 0 ? <ul className="mt-1 space-y-1">
                {selectedEvents.map((event) => <li key={`${event.seq}:${event.type}`}>graph event #{event.seq} · {event.type} · <time dateTime={event.ts} title={event.ts}>{kstClock(event.ts)}</time>{'reason' in event ? ` · ${event.reason}` : ''}</li>)}
              </ul> : <p className="mt-1 text-text-tertiary">연결된 graph event 기록 없음</p>}
            </section>
          )}
          <section className="mx-2 mb-2 rounded border border-border">
            <button type="button" aria-expanded={reportOpen} aria-controls={`showcase-report-${index}`} data-testid={`showcase-report-toggle-${index}`}
              onClick={() => setReportState({ version: selectionVersion, open: !reportOpen })} className="flex w-full items-center justify-between p-2 text-left text-[10px] font-semibold">
              결과 리포트 {reportOpen ? '접기' : '펼치기'} <span aria-hidden="true">{reportOpen ? '−' : '+'}</span>
            </button>
            {reportOpen && <div id={`showcase-report-${index}`} data-testid={`showcase-report-${index}`} className="space-y-1 border-t border-border p-2 text-[10px]">
              <p>{run?.title ?? run?.graphId ?? '이름 없는 런'} · 상태 {run?.status ?? '기록 없음'}{run?.stage ? ` · 단계 ${run.stage}` : ''}</p>
              <p>시작 {run?.startedAt ?? '기록 없음'} · 종료 {run?.endedAt ?? '진행 중/기록 없음'}{elapsed !== null ? ` · 경과 ${Math.round(elapsed / 1000)}초` : ''}</p>
              <p>원장 단계 {run?.steps.length ?? 0} · ledger events {run?.ledgerEvents ?? 0}{run?.prNumber !== null && run?.prNumber !== undefined ? ` · PR #${run.prNumber}` : ''}{run?.substrate ? ` · ${run.substrate}` : ''}</p>
              {run?.steps.length ? <ol className="list-inside list-decimal space-y-0.5">
                {run.steps.map((step, stepIndex) => <li key={`${step.at}:${stepIndex}`}>{step.node} · {step.outcome ?? '도는 중'}{step.detail ? ` · ${step.detail}` : ''}</li>)}
              </ol> : <p className="text-text-tertiary">원장에 기록된 단계 없음</p>}
            </div>}
          </section>
          <div className="min-h-[300px] flex-1">
            <LiveRunGraph runId={runId} clearFocusVersion={focusResetVersion} onNodeSelect={(nodeId) => setNodeSelection({ version: selectionVersion, nodeId })} />
          </div>
        </>
      ) : (
        <p className="p-3 text-xs text-text-tertiary">원장에 기록된 실제 런을 선택하세요.</p>
      )}
    </section>
  );
}

/** Three real-run panels; counts and hand cards are projections of each run's graph event stream. */
export function RunGraphShowcase({ onExit }: { onExit?: () => void } = {}) {
  const client = useNexusClient();
  const runs = useQuery({
    queryKey: ['showcase-runs'],
    queryFn: () => client.getHarnessRunsSince(7 * 24 * 3600_000),
  });
  const picks = useMemo(() => runs.data ? liveRunPicks(runs.data.entries, runs.data.finished ?? []) : [], [runs.data]);
  const [runSelections, setRunSelections] = useState<Array<{ runId: string | null; version: number }>>([
    { runId: null, version: 0 }, { runId: null, version: 0 }, { runId: null, version: 0 },
  ]);
  const runIds = runSelections.map((selection) => selection.runId);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <h2 className="text-xs font-semibold">쇼케이스 — 실제 런 세 장면</h2>
        {onExit && <button type="button" data-testid="showcase-return" onClick={onExit} className="rounded border border-border px-2 py-1 text-xs">편집으로 복귀</button>}
        {runs.isLoading && <p className="text-text-tertiary">런 목록을 읽는 중…</p>}
        {runs.isError && <p role="alert" className="text-error">런 목록을 읽지 못했습니다.</p>}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 overflow-auto px-2 pb-2 md:grid-cols-2 xl:grid-cols-3">
        {PANELS.map((title, index) => (
          <RunPanel key={title} index={index} title={title} runId={runIds[index] ?? null} selectionVersion={runSelections[index]!.version}
            picks={picks.filter((pick) => !runIds.some((selected, slot) => slot !== index && selected === pick.runId))}
            onSelect={(next) => setRunSelections((current) => current.map((selection, slot) => slot === index ? { runId: next, version: selection.version + 1 } : selection))} />
        ))}
      </div>
    </div>
  );
}
