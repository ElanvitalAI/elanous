'use client';

import { useEffect, useState } from 'react';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { getSeats, type OpsSeats } from '@/lib/ops-api';
import { createNexusClient, type HarnessRunsResponse } from '@/nexus/client';
import { loopAgentsView, type LoopAgentsView } from './loop-agents-view';

const EMPTY = loopAgentsView(null, null);

export function LoopAgentsViewContent({ view, runsUnreadable, refreshedAt }: {
  view: LoopAgentsView; runsUnreadable: boolean; refreshedAt: string | null;
}) {
  return <section aria-label="루프 에이전트 활동" className="min-w-0 space-y-6 p-4 text-lg min-[1440px]:text-[22px]">
    <div className="grid grid-cols-2 gap-3 min-[1440px]:grid-cols-4">
      {view.seats.map((row) => <article key={row.seat} aria-label={`${row.seat} 자리`} className="min-w-0 space-y-3 rounded-2xl border border-border bg-card p-3 min-[1440px]:p-6">
        <h2 className="font-bold">{row.seat}</h2>
        <p className="break-words" aria-label="지금 하는 일">{row.now}</p>
        <dl className="space-y-1 text-base min-[1440px]:text-[22px]">
          <div className="flex flex-wrap justify-between gap-x-2"><dt>오늘 착지</dt><dd>{row.landedToday}</dd></div>
          <div className="flex flex-wrap justify-between gap-x-2"><dt>막힘</dt><dd>{row.blocked}</dd></div>
          <div className="flex flex-wrap justify-between gap-x-2"><dt>대표 결정 대기</dt><dd>{row.decisionsWaiting}</dd></div>
        </dl>
      </article>)}
    </div>
    <section aria-label="지금 도는 런" className="min-w-0 rounded-2xl border border-border bg-card p-4">
      <h2 className="font-semibold">지금 도는 런</h2>
      {runsUnreadable ? <p className="text-muted-foreground">못 읽음</p> : view.runs.length === 0
        ? <p className="text-muted-foreground">지금 도는 런이 없습니다</p>
        : <ul className="mt-3 flex flex-wrap gap-3">{view.runs.map((run, index) => <li key={`${run.id6}-${index}`} className="min-w-0 break-words rounded-lg border border-border px-3 py-2">
          런 {run.id6} · {run.stage} · 경과 {run.elapsedSec === '못 읽음' ? run.elapsedSec : `${run.elapsedSec}초`}
        </li>)}</ul>}
    </section>
    <p className="text-sm text-muted-foreground">마지막 갱신 <time dateTime={refreshedAt ?? undefined}>{refreshedAt ? new Date(refreshedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '못 읽음'}</time></p>
  </section>;
}

export function LoopAgentsScene() {
  const { client, config } = useDaemon();
  const [snapshot, setSnapshot] = useState<{ source: string; seats: OpsSeats | null; runs: HarnessRunsResponse | null; runsUnreadable: boolean; refreshedAt: string | null } | null>(null);
  const source = `${config.baseUrl}\u0000${config.token}`;
  const current = snapshot?.source === source ? snapshot : null;

  useEffect(() => {
    let active = true;
    let busy = false;
    const nexus = createNexusClient({ baseUrl: config.baseUrl, token: config.token });
    setSnapshot({ source, seats: null, runs: null, runsUnreadable: true, refreshedAt: null });
    const refresh = async () => {
      if (!active || busy || document.hidden) return;
      busy = true;
      const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date());
      const [seatResult, runResult] = await Promise.allSettled([getSeats(client, date), nexus.getHarnessRuns()]);
      busy = false;
      if (!active) return;
      const seats = seatResult.status === 'fulfilled' && seatResult.value.kind === 'ready' ? seatResult.value.data : null;
      const runs = runResult.status === 'fulfilled' && Array.isArray(runResult.value?.entries) ? runResult.value : null;
      setSnapshot({ source, seats, runs, runsUnreadable: runs === null, refreshedAt: seats || runs ? new Date().toISOString() : null });
    };
    void refresh();
    const interval = window.setInterval(() => { void refresh(); }, 10_000);
    const visible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', visible);
    return () => { active = false; window.clearInterval(interval); document.removeEventListener('visibilitychange', visible); };
  }, [client, config.baseUrl, config.token, source]);

  return <LoopAgentsViewContent view={current ? loopAgentsView(current.seats, current.runs) : EMPTY}
    runsUnreadable={current?.runsUnreadable ?? true} refreshedAt={current?.refreshedAt ?? null} />;
}
