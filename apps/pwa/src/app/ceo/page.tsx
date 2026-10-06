'use client';

import { useEffect, useState } from 'react';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { loopRows, LOOP_SCHEDULES_PATH, LOOPS_PATH, type LoopSchedule } from '@/components/loops/loop-status';
import { listOpenDecisions } from '@/lib/decisions-api';
import { getSeats, type OpsSeats } from '@/lib/ops-api';
import type { DaemonClient } from '@/lib/daemon-client';

type Risk = { id: string; kind: string; title: string; at: string };
type SchedulesResult = { summary: Record<string, number>; risks: Risk[] };
type DecisionsResult = { count: number; risks: Risk[] };
type RunsResult = { merged: number | null; risks: Risk[] | null };
type Snapshot = {
  release: { green: number; yellow: number } | null;
  loops: Record<string, number> | null;
  decisions: number | null;
  merged: number | null;
  risks: Risk[] | null;
};

const empty: Snapshot = { release: null, loops: null, decisions: null, merged: null, risks: null };
const validTime = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function isSchedule(value: unknown): value is LoopSchedule {
  if (value === null || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === 'string' && typeof row.name === 'string'
    && typeof row.source === 'string' && (row.category === null || typeof row.category === 'string')
    && (row.domain === null || typeof row.domain === 'string')
    && (row.runVia === null || typeof row.runVia === 'string')
    && ['live', 'firing', 'stale', 'off'].includes(row.state as string)
    && (row.cron === null || typeof row.cron === 'string')
    && (row.intervalMs === null || (typeof row.intervalMs === 'number' && Number.isFinite(row.intervalMs)))
    && Array.isArray(row.next) && row.next.every((next: unknown) => typeof next === 'string')
    && (row.lastRun === null || (typeof row.lastRun === 'object' && row.lastRun !== null
      && typeof (row.lastRun as Record<string, unknown>).at === 'string'
      && ((row.lastRun as Record<string, unknown>).status === null || typeof (row.lastRun as Record<string, unknown>).status === 'string')
      && ((row.lastRun as Record<string, unknown>).exit === null || typeof (row.lastRun as Record<string, unknown>).exit === 'number')));
}

async function readSchedules(client: DaemonClient): Promise<SchedulesResult | null> {
  try {
    const response = await client.fetchResponse(LOOP_SCHEDULES_PATH);
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (body === null || typeof body !== 'object' || !('schedules' in body)) return null;
    const schedules = body.schedules;
    if (!Array.isArray(schedules) || !schedules.every(isSchedule)) return null;
    const rows = loopRows(schedules, Date.now());
    const summary: Record<string, number> = {};
    for (const row of rows) summary[row.verdict] = (summary[row.verdict] ?? 0) + 1;
    const risks = rows.flatMap((row, index) => row.verdict === '실패' && validTime(row.lastRun)
      ? [{ id: `loop:${row.id}`, kind: '실패 루프', title: row.name, at: schedules[index]!.lastRun!.at }] : []);
    return { summary, risks };
  } catch { return null; }
}

async function readLoopFailures(client: DaemonClient): Promise<Risk[] | null> {
  try {
    const response = await client.fetchResponse(LOOPS_PATH);
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (!object(body) || !object(body.loops) || !Array.isArray(body.loops.loops)) return null;
    const loops: unknown[] = body.loops.loops;
    if (!loops.every((value) => object(value) && typeof value.name === 'string'
      && typeof value.label === 'string' && (value.last === null || (object(value.last)
        && validTime(value.last.at) && typeof value.last.status === 'string')))) return null;
    return loops.flatMap((value) => {
      const row = value as { name: string; label: string; last: { at: string; status: string } | null };
      if (!row.last || !['error', 'failed', 'failure', 'abandoned'].includes(row.last.status.toLowerCase())) return [];
      return [{ id: `loop:${row.name}`, kind: '실패 루프', title: row.label, at: row.last.at }];
    });
  } catch { return null; }
}

async function readRuns(client: DaemonClient, now: Date): Promise<RunsResult> {
  try {
    const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(now);
    const today = Date.parse(`${date}T00:00:00+09:00`);
    const [todayResult, riskResult] = await Promise.allSettled([
      client.fetchResponse(`/v1/harness/runs?finishedSince=${today}`).then(async (response) => response.ok ? await response.json() as unknown : null),
      client.fetchResponse(`/v1/harness/runs?finishedSince=${today - 7 * 24 * 60 * 60 * 1000}`).then(async (response) => response.ok ? await response.json() as unknown : null),
    ]);
    const body: unknown = todayResult.status === 'fulfilled' ? todayResult.value : null;
    const landed = object(body) ? body.landed : null;
    const merged = object(body) && (body.landedTruncated === undefined || body.landedTruncated === false) && body.landedError == null
      && Array.isArray(landed) && landed.every((row: unknown) => object(row) && typeof row.number === 'number' && validTime(row.mergedAt))
      ? new Set(landed.filter((row) => Date.parse(row.mergedAt) >= today).map((row) => row.number)).size : null;
    if (riskResult.status !== 'fulfilled') return { merged, risks: null };
    const riskBody: unknown = riskResult.value;
    if (!object(riskBody)) return { merged, risks: null };
    const finished = riskBody.finished;
    const entries = riskBody.entries;
    const risks = riskBody.completeness !== 'complete' || !Array.isArray(finished) || !Array.isArray(entries)
      || !object(riskBody.finishedObservation) || !Number.isInteger(riskBody.finishedObservation.skippedFiles)
      || (riskBody.finishedObservation.skippedFiles as number) !== 0
      ? null : finished.every((row: unknown) => object(row) && typeof row.runId === 'string' && typeof row.status === 'string' && validTime(row.endedAt))
        && entries.every((row: unknown) => object(row) && typeof row.runId === 'string' && typeof row.status === 'string')
        ? [
          ...finished.filter((row) => row.status === 'human-stop' || row.status === 'failed' || row.status === 'parked'
            || (row.status === 'cancelled' && row.stage === 'soft-stopped'))
            .map((row) => ({ id: `run:${row.runId}`, kind: '멈춘 하니스 런', title: typeof row.objective === 'string' && row.objective ? row.objective : row.runId, at: row.endedAt })),
          ...entries.filter((row) => row.status === 'ended-unclosed' && validTime(row.lastActivityTimestamp)
            && !finished.some((done) => done.runId === row.runId))
            .map((row) => ({ id: `run:${row.runId}`, kind: '멈춘 하니스 런', title: typeof row.objective === 'string' && row.objective ? row.objective : row.runId, at: row.lastActivityTimestamp as string })),
        ] : null;
    return { merged, risks };
  } catch { return { merged: null, risks: null }; }
}

async function readDecisions(client: DaemonClient, now: number): Promise<DecisionsResult | null> {
  try {
    const rows = await listOpenDecisions(client);
    if (!Array.isArray(rows) || !rows.every((row) => object(row) && typeof row.id === 'string')) return null;
    return { count: rows.length, risks: rows.flatMap((row) => validTime(row.dueAt) && Date.parse(row.dueAt) < now
      ? [{ id: `decision:${row.id}`, kind: '기한 지난 결정', title: typeof row.title === 'string' ? row.title : row.id, at: row.dueAt }] : []) };
  } catch { return null; }
}

function releaseFromSeats(board: OpsSeats): Snapshot['release'] {
  if (board.seats.length !== 4 || board.seats.some((seat) => seat.checklist === null)) return null;
  return {
    green: board.seats.reduce((sum, seat) => sum + seat.checklist!.green, 0),
    yellow: board.seats.reduce((sum, seat) => sum + seat.checklist!.yellow, 0),
  };
}

async function readSnapshot(client: DaemonClient): Promise<Snapshot> {
  const now = Date.now();
  const [seats, loops, loopFailures, decisions, runs] = await Promise.all([
    getSeats(client),
    readSchedules(client),
    readLoopFailures(client),
    readDecisions(client, now),
    readRuns(client, new Date(now)),
  ]);
  return {
    release: seats.kind === 'ready' ? releaseFromSeats(seats.data) : null,
    loops: loops?.summary ?? null,
    decisions: decisions?.count ?? null,
    merged: runs.merged,
    risks: loops && loopFailures && decisions && runs.risks ? [...new Map(
      [...loops.risks, ...loopFailures, ...decisions.risks, ...runs.risks]
        .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
        .map((risk) => [risk.id, risk] as const),
    ).values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.id.localeCompare(b.id)).slice(0, 5) : null,
  };
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return <section aria-label={title} className="min-w-0 rounded-xl border border-border bg-card p-3 sm:p-4">
    <h2 className="text-xs font-medium text-muted-foreground sm:text-sm">{title}</h2>
    <div className="mt-2 text-lg font-semibold leading-snug tabular-nums sm:text-xl">{children}</div>
  </section>;
}

export default function CeoPage() {
  const { client } = useDaemon();
  const [snapshot, setSnapshot] = useState<Snapshot>(empty);
  useEffect(() => {
    let active = true;
    setSnapshot(empty);
    void readSnapshot(client).then((result) => { if (active) setSnapshot(result); });
    return () => { active = false; };
  }, [client]);

  return <main className="mx-auto w-full min-w-0 max-w-3xl px-3 py-4 text-foreground sm:px-6">
    <header className="mb-4"><p className="text-xs text-muted-foreground">운영 · 오늘</p><h1 className="text-xl font-semibold">대표 조망판</h1></header>
    <div className="grid grid-cols-2 gap-2 sm:gap-4" aria-label="대표 조망 카드">
      <Card title="릴리스 판 진행">{snapshot.release
        ? <><span className="text-emerald-600">green {snapshot.release.green}</span><span className="block text-amber-600">노랑 {snapshot.release.yellow}</span></>
        : '못 읽음'}</Card>
      <Card title="루프 판정">{snapshot.loops === null ? '못 읽음' : Object.keys(snapshot.loops).length === 0
        ? '등록 0' : <div className="flex flex-wrap gap-1 text-xs font-medium">{Object.entries(snapshot.loops).map(([verdict, count]) =>
          <span key={verdict} className="rounded-full bg-muted px-2 py-1">{verdict} {count}</span>)}</div>}</Card>
      <Card title="결정 대기 카드">{snapshot.decisions ?? '못 읽음'}</Card>
      <Card title="오늘 병합 PR">{snapshot.merged ?? '못 읽음'}</Card>
    </div>
    <div className="mt-2 grid min-w-0 grid-cols-2 gap-2 sm:mt-4 sm:gap-4" aria-label="위험과 그리드 카드">
      <section aria-label="위험·막힘 톱 5" className="min-w-0 rounded-xl border border-border bg-card p-2 sm:p-4">
        <h2 className="text-xs font-medium text-muted-foreground sm:text-sm">위험·막힘 톱 5</h2>
        {snapshot.risks === null ? <p className="mt-2 text-sm">못 읽음</p> : snapshot.risks.length === 0
          ? <p className="mt-2 text-sm">해당 없음</p>
          : <ol className="mt-2 space-y-1 text-xs">{snapshot.risks.map((risk) => <li key={risk.id} className="min-w-0 border-b border-border pb-1 last:border-0">
            <span className="block text-muted-foreground">{risk.kind} · <time dateTime={risk.at}>{risk.at.slice(0, 16).replace('T', ' ')}</time></span>
            <span className="block truncate" title={risk.title}>{risk.title}</span>
          </li>)}</ol>}
      </section>
      <section aria-label="그리드" className="min-w-0 rounded-xl border border-border bg-card p-2 sm:p-4">
        <h2 className="text-xs font-medium text-muted-foreground sm:text-sm">그리드</h2>
        {/* No daemon API serves machine heartbeats or slot use yet — say so instead of a read failure. */}
        <p className="mt-2 text-sm">준비 중</p>
      </section>
    </div>
  </main>;
}
