'use client';

import { useEffect, useState } from 'react';
import { useDaemon } from '@/components/providers/DaemonProvider';
import type { DaemonClient } from '@/lib/daemon-client';
import {
  EMPTY_RUNS,
  reduceRuns,
  subscribeInsideEvents,
  subscribeWizardSteps,
  type InsideEvent,
  type InsideNode,
  type RunsState,
  type WizardStepEvent,
} from '@/lib/inside-events';
import { toPublicText } from './public-text';

const IDLE_MS = 60_000;

const NODE_TONE: Record<InsideNode['phase'], string> = {
  start: 'border-sky-400 bg-sky-500/15 text-sky-200',
  ok: 'border-green-500 bg-green-500/15 text-green-300',
  fail: 'border-red-500 bg-red-500/15 text-red-300',
};

interface LastSettlement {
  receivedAt: number;
  nodeId: string;
  phase: 'ok' | 'fail';
  ts: string;
}

/** Pure visual slice; the container below alone owns the clock and stream. */
export function LiveTraceView({
  state,
  now,
  receivedAt,
  lastSettlement,
  lastActivityTs = null,
  activityStatus = 'loading',
  wizardSteps = [],
}: {
  state: RunsState;
  now: number;
  receivedAt: number;
  lastSettlement?: LastSettlement | null;
  lastActivityTs?: string | null;
  activityStatus?: 'loading' | 'ready' | 'unavailable';
  wizardSteps?: WizardStepEvent[];
}) {
  const run = state.currentRunId ? state.runs[state.currentRunId] : null;
  const idle = !run || now - receivedAt > IDLE_MS;
  const running = run?.order.some((id) => run.nodes[id].phase === 'start');
  const waitingForNext = lastSettlement && !running && now - lastSettlement.receivedAt < 15_000;
  const settled = lastSettlement && !running && now - lastSettlement.receivedAt >= 15_000;
  const elapsed = run ? Math.max(0, Math.floor((now - Date.parse(run.startedAt)) / 1000)) : 0;
  const duration = run && lastSettlement ? Math.max(0, Math.floor((Date.parse(lastSettlement.ts) - Date.parse(run.startedAt)) / 1000)) : 0;
  const status = settled ? lastSettlement.phase === 'fail' ? `실패 · ${lastSettlement.nodeId}` : `완료 · ${duration}초` : null;

  return (
    <section aria-label="라이브 트레이스" className="min-w-0 space-y-6 p-6 text-lg leading-relaxed">
      {wizardSteps.length > 0 && <ol aria-label="플러그인 마법사 흐름">
        {wizardSteps.map(event => <li key={`${event.wizardId}:${event.step}`}>
          마법사 {event.step} · {toPublicText(event.text)}
        </li>)}
      </ol>}
      {idle ? (
        <div className="space-y-4 text-muted-foreground">
          <p>지금 도는 런이 없습니다</p>
          <p role="status">마지막 활동: {lastActivityTs && Number.isFinite(Date.parse(lastActivityTs))
            ? <time dateTime={lastActivityTs}>{new Date(lastActivityTs).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} KST</time>
            : activityStatus === 'loading' ? '확인 중' : activityStatus === 'unavailable' ? '못 읽음' : '기록 없음'}</p>
          <button type="button" className="rounded-lg border border-border px-5 py-3 text-lg" disabled>녹화 보기</button>
        </div>
      ) : (
        <>
          <header className="flex flex-wrap items-center gap-x-5 gap-y-2 break-all text-lg">
            <h2 className="font-semibold">{run.graphId}</h2>
            <span>런 {run.runId.slice(0, 6)}</span>
            <span>경과 {elapsed}초</span>
            {status && <span role="status">{status}</span>}
          </header>
          <div role="list" aria-label="노드 흐름" className="flex flex-wrap gap-3">
            {waitingForNext && <span className="rounded-lg border border-border bg-muted px-3 py-1 text-sm text-muted-foreground">다음 단계 준비 중</span>}
            {run.order.map((id) => {
              const node = run.nodes[id];
              return (
                <div role="listitem" key={id} className={`min-w-0 max-w-full break-all rounded-lg border px-5 py-3 ${NODE_TONE[node.phase]}`}>
                  <span className={node.phase === 'start' ? 'animate-pulse' : ''}>
                    {node.nodeId} · {node.phase === 'start' ? '진행 중' : node.phase === 'ok' ? 'ok' : 'fail'}
                  </span>
                  {node.retries > 0 && <span className="ml-3" aria-label={`다시 ${node.retries}회`}>↻{node.retries}</span>}
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

interface TraceSnapshot {
  client: Pick<DaemonClient, 'logsStreamUrl' | 'listLogs'>;
  baseUrl: string;
  token: string;
  state: RunsState;
  receivedAt: number;
  lastSettlement: LastSettlement | null;
  lastActivityTs: string | null;
  activityStatus: 'loading' | 'ready' | 'unavailable';
}

export function LiveTraceScene() {
  const { client, config } = useDaemon();
  const [snapshot, setSnapshot] = useState<TraceSnapshot>(() => ({
    client, baseUrl: config.baseUrl, token: config.token, state: EMPTY_RUNS, receivedAt: 0, lastSettlement: null,
    lastActivityTs: null, activityStatus: 'loading',
  }));
  const [now, setNow] = useState(0);
  const [wizardSteps, setWizardSteps] = useState<WizardStepEvent[]>([]);
  const currentTarget = snapshot.client === client && snapshot.baseUrl === config.baseUrl && snapshot.token === config.token;

  useEffect(() => {
    let active = true;
    setSnapshot({ client, baseUrl: config.baseUrl, token: config.token, state: EMPTY_RUNS, receivedAt: 0, lastSettlement: null,
      lastActivityTs: null, activityStatus: 'loading' });
    setWizardSteps([]);
    void client.listLogs({ category: 'graph.run', event: 'node', limit: '1' }).then(response => {
      if (!active) return;
      setSnapshot(previous => {
        if (previous.client !== client || previous.baseUrl !== config.baseUrl || previous.token !== config.token) return previous;
        const ts = response.logs?.[0]?.ts;
        const validTs = typeof ts === 'string' && Number.isFinite(Date.parse(ts)) ? ts : null;
        const lastActivityTs = validTs && (!previous.lastActivityTs || Date.parse(validTs) > Date.parse(previous.lastActivityTs))
          ? validTs : previous.lastActivityTs;
        return { ...previous, lastActivityTs, activityStatus: response.ok && Array.isArray(response.logs) ? 'ready' : 'unavailable' };
      });
    }).catch(() => {
      if (active) setSnapshot(previous => previous.client === client && previous.baseUrl === config.baseUrl && previous.token === config.token
        ? { ...previous, activityStatus: 'unavailable' } : previous);
    });
    const unsubscribeWizard = subscribeWizardSteps(client, event => {
      if (active) setWizardSteps(previous => event.step === 'request' ? [event] :
        [...previous.filter(item => item.wizardId === event.wizardId), event].slice(-6));
    });
    const unsubscribe = subscribeInsideEvents(client, (event: InsideEvent) => {
      if (!active) return;
      const receivedAt = Date.now();
      setSnapshot((previous) => {
        if (!active) return previous;
        const sameTarget = previous.client === client && previous.baseUrl === config.baseUrl && previous.token === config.token;
        const previousState = sameTarget ? previous.state : EMPTY_RUNS;
        const duplicate = previousState.currentRunId === event.runId && event.phase !== 'start'
          && previousState.runs[event.runId]?.nodes[event.nodeId]?.phase === event.phase;
        const olderRun = previousState.currentRunId !== event.runId && !!previousState.runs[event.runId];
        const lastSettlement = olderRun ? previous.lastSettlement
          : event.phase === 'start' || previousState.currentRunId !== event.runId ? null
          : duplicate ? previous.lastSettlement
          : { receivedAt, nodeId: event.nodeId, phase: event.phase, ts: event.ts };
        const lastActivityTs = !sameTarget || !previous.lastActivityTs || Date.parse(event.ts) > Date.parse(previous.lastActivityTs)
          ? event.ts : previous.lastActivityTs;
        return {
          client, baseUrl: config.baseUrl, token: config.token, receivedAt, lastSettlement,
          lastActivityTs, activityStatus: sameTarget ? previous.activityStatus : 'loading',
          state: reduceRuns(previousState, event),
        };
      });
      setNow(receivedAt);
    });
    const interval = setInterval(() => setNow(Date.now()), 1_000);
    return () => { active = false; unsubscribe(); unsubscribeWizard(); clearInterval(interval); };
  }, [client, config.baseUrl, config.token]);

  return (
    <LiveTraceView
      state={currentTarget ? snapshot.state : EMPTY_RUNS}
      now={now}
      receivedAt={snapshot.receivedAt}
      lastSettlement={currentTarget ? snapshot.lastSettlement : null}
      lastActivityTs={currentTarget ? snapshot.lastActivityTs : null}
      activityStatus={currentTarget ? snapshot.activityStatus : 'loading'}
      wizardSteps={currentTarget ? wizardSteps : []}
    />
  );
}
