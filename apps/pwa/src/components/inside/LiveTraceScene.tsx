'use client';

import { useEffect, useState } from 'react';
import { useDaemon } from '@/components/providers/DaemonProvider';
import type { DaemonClient } from '@/lib/daemon-client';
import { EMPTY_RUNS, reduceRuns, subscribeInsideEvents, type InsideNode, type RunsState } from '@/lib/inside-events';

const IDLE_MS = 60_000;

const NODE_TONE: Record<InsideNode['phase'], string> = {
  start: 'border-sky-400 bg-sky-500/15 text-sky-200',
  ok: 'border-green-500 bg-green-500/15 text-green-300',
  fail: 'border-red-500 bg-red-500/15 text-red-300',
};

/** Pure visual slice; the container below alone owns the clock and stream. */
export function LiveTraceView({ state, now, receivedAt }: { state: RunsState; now: number; receivedAt: number }) {
  const run = state.currentRunId ? state.runs[state.currentRunId] : null;
  const idle = !run || now - receivedAt > IDLE_MS;

  return (
    <section aria-label="라이브 트레이스" className="min-w-0 space-y-6 p-6 text-lg leading-relaxed">
      {idle ? (
        <div className="space-y-4 text-muted-foreground">
          <p>지금 도는 런이 없습니다</p>
          <button type="button" className="rounded-lg border border-border px-5 py-3 text-lg" disabled>녹화 보기</button>
        </div>
      ) : (
        <>
          <header className="flex flex-wrap items-center gap-x-5 gap-y-2 break-all text-lg">
            <h2 className="font-semibold">{run.graphId}</h2>
            <span>런 {run.runId.slice(0, 6)}</span>
            <span>경과 {Math.max(0, Math.floor((now - Date.parse(run.startedAt)) / 1000))}초</span>
          </header>
          <div role="list" aria-label="노드 흐름" className="flex flex-wrap gap-3">
            {run.order.every((id) => run.nodes[id].phase !== 'start') && <span className="rounded-lg border border-border bg-muted px-5 py-3 text-muted-foreground">대기</span>}
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
  client: Pick<DaemonClient, 'logsStreamUrl'>;
  baseUrl: string;
  token: string;
  state: RunsState;
  receivedAt: number;
}

export function LiveTraceScene() {
  const { client, config } = useDaemon();
  const [snapshot, setSnapshot] = useState<TraceSnapshot>(() => ({
    client, baseUrl: config.baseUrl, token: config.token, state: EMPTY_RUNS, receivedAt: 0,
  }));
  const [now, setNow] = useState(0);
  const currentTarget = snapshot.client === client && snapshot.baseUrl === config.baseUrl && snapshot.token === config.token;

  useEffect(() => {
    let active = true;
    setSnapshot({ client, baseUrl: config.baseUrl, token: config.token, state: EMPTY_RUNS, receivedAt: 0 });
    const unsubscribe = subscribeInsideEvents(client, (event) => {
      if (!active) return;
      const receivedAt = Date.now();
      setSnapshot((previous) => active ? ({
        client, baseUrl: config.baseUrl, token: config.token, receivedAt,
        state: reduceRuns(previous.client === client && previous.baseUrl === config.baseUrl && previous.token === config.token
          ? previous.state : EMPTY_RUNS, event),
      }) : previous);
      setNow(receivedAt);
    });
    const interval = setInterval(() => setNow(Date.now()), 1_000);
    return () => { active = false; unsubscribe(); clearInterval(interval); };
  }, [client, config.baseUrl, config.token]);

  return <LiveTraceView state={currentTarget ? snapshot.state : EMPTY_RUNS} now={now} receivedAt={snapshot.receivedAt} />;
}
