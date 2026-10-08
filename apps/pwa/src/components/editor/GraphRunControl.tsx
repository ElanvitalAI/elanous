'use client';

import { useEffect, useRef, useState } from 'react';
import type { NodeRunStatus } from '@/components/workflows/run-status-helpers';
import { getGraphRun, graphRunLine, graphRunNodeStatuses, RUN_FINISHED, startGraphRun, type GraphRun, type GraphRunClient } from '@/lib/graph-run-api';
import type { GraphCanvasContext } from './GraphCanvasEditor';

const POLL_MS = 1_000;
/** 연속으로 못 읽으면 멈추고 말한다(데몬 재시작 등). */
const MAX_MISSES = 5;
/** 데모 레시피는 노드당 수 초 — 이보다 길면 원장이 «running» 으로 남은 것으로 보고 폴링을 접는다. */
const MAX_POLL_MS = 3 * 60_000;

/** 실행 전에 막는 이유 — 저장된 그래프만, 검증을 통과한 것만 돌린다(서버가 도는 것은 저장된 판이다). */
export function runBlockedReason(context: Pick<GraphCanvasContext, 'graphId' | 'valid' | 'saved'>): string | null {
  if (!context.graphId) return '그래프 id 가 없습니다';
  if (!context.valid) return '검증을 통과해야 실행할 수 있습니다';
  if (!context.saved) return '저장한 뒤 실행할 수 있습니다 — 서버는 저장된 판을 돌립니다';
  return null;
}

export function nodeStatusOf(run: GraphRun): Record<string, NodeRunStatus> {
  return Object.fromEntries(Object.entries(graphRunNodeStatuses(run)).map(([id, entry]) => [id, entry.status]));
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'running'; runId: string; run: GraphRun | null; misses: number; since: number; tick: number }
  | { kind: 'refused'; lines: string[] };

/** CGE-RUN — 캔버스 도구줄의 «데모 실행». 런을 시작하고 1초마다 원장을 읽어 노드 색을 넘긴다. */
export function GraphRunControl({ context, client, onStatus }: {
  context: GraphCanvasContext;
  client: GraphRunClient;
  onStatus: (status: Record<string, NodeRunStatus> | undefined) => void;
}): React.ReactNode {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const graphRef = useRef(context.graphId);
  const blocked = runBlockedReason(context);

  // 다른 그래프로 바뀌면 지난 런의 색을 지운다.
  useEffect(() => {
    if (graphRef.current === context.graphId) return;
    graphRef.current = context.graphId;
    setPhase({ kind: 'idle' });
    onStatus(undefined);
  }, [context.graphId, onStatus]);

  const runId = phase.kind === 'running' ? phase.runId : null;
  const finished = phase.kind === 'running' && phase.run !== null && RUN_FINISHED.has(phase.run.status);
  useEffect(() => {
    if (!runId || finished) return;
    let stop = false;
    const current = phase.kind === 'running' ? phase : null;
    const timer = setTimeout(async () => {
      const run = await getGraphRun(client, context.graphId, runId);
      if (stop || !current) return;
      if (!run) {
        const misses = current.misses + 1;
        // 못 읽어도 다음 틱을 건다 — 한 번의 순단으로 화면이 «도는 중»에 굳지 않게.
        setPhase(misses >= MAX_MISSES
          ? { kind: 'refused', lines: [`런 상태를 ${misses}번 연속 읽지 못했습니다 — 데몬을 확인한 뒤 다시 실행하세요`] }
          : { ...current, misses, tick: current.tick + 1 });
        return;
      }
      if (Date.now() - current.since > MAX_POLL_MS && !RUN_FINISHED.has(run.status)) {
        setPhase({ kind: 'refused', lines: [`데모 실행이 ${Math.round(MAX_POLL_MS / 60_000)}분 넘게 끝나지 않습니다 — 원장이 «도는 중»으로 남았을 수 있습니다(데몬 재시작 등)`] });
        onStatus(nodeStatusOf(run));
        return;
      }
      setPhase({ ...current, run, misses: 0, tick: current.tick + 1 });
      onStatus(nodeStatusOf(run));
    }, POLL_MS);
    return () => { stop = true; clearTimeout(timer); };
  }, [runId, finished, phase, client, context.graphId, onStatus]);

  const start = async () => {
    setPhase({ kind: 'starting' });
    onStatus(undefined);
    const result = await startGraphRun(client, context.graphId);
    if (result.kind === 'started') setPhase({ kind: 'running', runId: result.runId, run: null, misses: 0, since: Date.now(), tick: 0 });
    else if (result.kind === 'not-runnable') setPhase({ kind: 'refused', lines: result.issues });
    else if (result.kind === 'forbidden') setPhase({ kind: 'refused', lines: ['운영자만 실행할 수 있습니다'] });
    else setPhase({ kind: 'refused', lines: [`실행을 시작하지 못했습니다${result.message ? ` — ${result.message}` : ''}${result.status ? ` (${result.status})` : ''}`] });
  };

  const busy = phase.kind === 'starting' || (phase.kind === 'running' && !finished);
  const run = phase.kind === 'running' ? phase.run : null;
  const tone = run?.status === 'done' ? 'text-emerald-700 dark:text-emerald-400'
    : run && RUN_FINISHED.has(run.status) ? 'text-red-700 dark:text-red-400' : 'text-sky-700 dark:text-sky-400';
  return <span className="flex min-w-0 flex-wrap items-center gap-2">
    <button type="button" onClick={() => { void start(); }} disabled={busy || blocked !== null} title={blocked ?? '저장된 그래프를 데모 레시피로 실행합니다'}
      className="rounded border border-sky-600/60 bg-sky-600/10 px-2.5 py-1 text-xs font-semibold text-sky-800 disabled:cursor-not-allowed disabled:opacity-50 dark:text-sky-300">
      ▶ 데모 실행
    </button>
    {blocked && phase.kind === 'idle' && <span className="text-xs text-muted-foreground">{blocked}</span>}
    {phase.kind === 'starting' && <span role="status" className="text-xs text-sky-700 dark:text-sky-400">데모 실행 · 시작하는 중</span>}
    {phase.kind === 'running' && <span role="status" aria-live="polite" className={`text-xs font-semibold ${tone}`}>
      {run ? graphRunLine(run) : '데모 실행 · 시작하는 중'}
    </span>}
    {phase.kind === 'refused' && <span role="alert" className="text-xs font-semibold text-red-700 dark:text-red-400">{phase.lines.join(' · ')}</span>}
  </span>;
}
