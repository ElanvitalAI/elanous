'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { getSeats, type OpsSeats } from '@/lib/ops-api';
import { createNexusClient, NexusApiError, type HarnessRunsResponse } from '@/nexus/client';
import { loopAgentsView, type LoopAgentsView } from './loop-agents-view';
import { loadLoopRows, type LoopRow } from '@/components/loops/loop-status';
import { LoopActivityMap } from './LoopActivityMap';
import { subscribeLoopEdgeRefresh } from './loop-live-refresh';
import { activityEdges, applyLoopOwners, isValidRef, journeyParam, journeyResponseEdges, newlySeenEdges, ACTIVITY_WINDOW_MS, RUNS_NODE, TASK_AGENT_NODE, type ActivityEdge, type LoopOwner, type NodeDetailSource } from './loop-activity-map';

/** `?journey=<id>`(또는 0·1 아닌 `?demo=<id>`) 면 그 여정만 `?ref=<id>&mode=live` 로 — 60분 창·limit 에 앞 단계가 잘리지 않게. */
export function loopEdgesPath(receivedAt: number, demo: string | null): string {
  return isValidRef(demo) ? `/v1/loops/edges?ref=${encodeURIComponent(demo)}&mode=live&limit=500`
    : `/v1/loops/edges?since=${encodeURIComponent(new Date(receivedAt - ACTIVITY_WINDOW_MS).toISOString())}&limit=200`;
}

/** near 줌 노드 안쪽 — 현황 탭이 이미 읽은 자리·런 데이터를 지도 노드 id 로 옮긴다(새 조회 0). */
export function mapNodeDetails(view: LoopAgentsView, runsUnreadable: boolean): Record<string, NodeDetailSource> {
  const ids: Record<string, string> = { COO: 'OP', CMO: 'MK', CTO: 'TC', CXO: 'UX' };
  const running = runsUnreadable ? '못 읽음' as const : view.runs.length;
  const details: Record<string, NodeDetailSource> = { [TASK_AGENT_NODE]: { running }, [RUNS_NODE]: { running } };
  for (const seat of view.seats) details[ids[seat.seat]!] = { now: seat.now, waiting: seat.decisionsWaiting };
  return details;
}

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

/** `initialMode="map"` — `/loops?view=interact` 처럼 지도부터 여는 진입(여정 주소가 아니어도). */
export function LoopAgentsScene({ initialMode = 'activity' }: { initialMode?: 'activity' | 'map' } = {}) {
  const { client, config } = useDaemon();
  const [snapshot, setSnapshot] = useState<{ source: string; seats: OpsSeats | null; runs: HarnessRunsResponse | null; runsUnreadable: boolean; refreshedAt: string | null } | null>(null);
  const demo = journeyParam(useSearchParams());
  // 데모 주소로 들어오면 지도부터 연다.
  const [mode, setMode] = useState<'activity' | 'map'>(demo !== null ? 'map' : initialMode);
  const [map, setMap] = useState<{ source: string; rows: LoopRow[]; edges: ActivityEdge[]; seenAt: Record<string, number>; state: 'ready' | 'error' | 'unauthorized' } | null>(null);
  const [now, setNow] = useState(0);
  const source = `${config.baseUrl}\u0000${config.token}`;
  const mapSource = `${source}\u0000${mode}\u0000${demo ?? ''}`;
  const current = snapshot?.source === source ? snapshot : null;
  const subSeatIds = current?.seats?.seats.flatMap(seat => seat.subSeats?.map(sub => sub.id) ?? []) ?? [];

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

  useEffect(() => {
    if (mode !== 'map') return;
    let active = true;
    let busy = false;
    let again = false;
    setMap(null);
    setNow(Date.now());
    const refresh = async () => {
      if (!active || document.hidden) return;
      // 읽는 중에 온 신호는 버리지 않고 한 번 더 읽는다 — 마지막 사건이 다음 신호까지 숨지 않게.
      if (busy) { again = true; return; }
      busy = true;
      again = false;
      const receivedAt = Date.now();
      try {
        const [rows, owners, response] = await Promise.all([
          loadLoopRows(path => client.fetchJson<unknown>(path), receivedAt),
          client.fetchJson<{ owners: LoopOwner[] | null }>('/v1/schedules?includeOff=1&includeOwners=1'),
          client.fetchJson<unknown>(loopEdgesPath(receivedAt, demo)),
        ]);
        const loopOwners = owners.owners;
        if (!Array.isArray(loopOwners)) throw new Error('루프 주인 조회 실패');
        const edges = demo === null ? activityEdges(response, receivedAt) : journeyResponseEdges(response, receivedAt);
        if (active) setMap(previous => ({ source: mapSource, rows: applyLoopOwners(rows, loopOwners, receivedAt), edges,
          seenAt: newlySeenEdges(previous?.source === mapSource ? previous.seenAt : null, edges, receivedAt), state: 'ready' }));
      } catch (error) {
        if (active) {
          const unauthorized = error instanceof NexusApiError && (error.status === 401 || error.status === 403);
          setMap(previous => ({ source: mapSource,
            rows: unauthorized ? [] : previous?.source === mapSource ? previous.rows : [],
            edges: unauthorized ? [] : previous?.source === mapSource ? previous.edges : [],
            seenAt: unauthorized ? {} : previous?.source === mapSource ? previous.seenAt : {},
            state: unauthorized ? 'unauthorized' : 'error' }));
        }
      } finally {
        busy = false;
        if (again && active) void refresh();
      }
    };
    void refresh();
    // 실시간 = 기존 로그 SSE 를 «다시 읽기 신호»로만(디바운스) · 끊기면 5초 폴링.
    const unsubscribe = subscribeLoopEdgeRefresh(client, () => { void refresh(); });
    const clock = window.setInterval(() => { if (!document.hidden) setNow(Date.now()); }, 250);
    const visible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', visible);
    return () => { active = false; unsubscribe(); window.clearInterval(clock); document.removeEventListener('visibilitychange', visible); };
  }, [client, mode, mapSource, demo]);

  const currentMap = map?.source === mapSource ? map : null;
  return <div className="min-w-0">
    <div role="group" aria-label="루프 에이전트 보기" className="flex gap-2 px-4 pt-4">
      <button type="button" aria-pressed={mode === 'activity'} onClick={() => setMode('activity')} className="min-h-11 rounded-lg border border-slate-500 px-4 py-2 aria-pressed:bg-sky-800">현황</button>
      <button type="button" aria-pressed={mode === 'map'} onClick={() => setMode('map')} className="min-h-11 rounded-lg border border-slate-500 px-4 py-2 aria-pressed:bg-sky-800">지도</button>
    </div>
    {mode === 'activity' ? <LoopAgentsViewContent view={current ? loopAgentsView(current.seats, current.runs) : EMPTY}
      runsUnreadable={current?.runsUnreadable ?? true} refreshedAt={current?.refreshedAt ?? null} />
      : <div className="min-w-0 p-4"><LoopActivityMap rows={currentMap?.rows ?? []} edges={currentMap?.edges ?? []} seatIds={['OP', 'MK', 'TC', 'UX', ...subSeatIds]}
          details={current ? mapNodeDetails(loopAgentsView(current.seats, current.runs), current.runsUnreadable) : undefined}
          seenAt={currentMap?.seenAt ?? {}} now={now} state={currentMap?.state ?? 'loading'} /></div>}
  </div>;
}
