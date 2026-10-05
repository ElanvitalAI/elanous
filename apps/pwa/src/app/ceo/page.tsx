'use client';

import { useEffect, useState } from 'react';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { loopRows, LOOP_SCHEDULES_PATH, type LoopSchedule } from '@/components/loops/loop-status';
import { listOpenDecisions } from '@/lib/decisions-api';
import { getSeats, type OpsSeats } from '@/lib/ops-api';
import type { DaemonClient } from '@/lib/daemon-client';

type Snapshot = {
  release: { green: number; yellow: number } | null;
  loops: Record<string, number> | null;
  decisions: number | null;
  merged: number | null;
};

const empty: Snapshot = { release: null, loops: null, decisions: null, merged: null };

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

async function readSchedules(client: DaemonClient): Promise<Snapshot['loops']> {
  try {
    const response = await client.fetchResponse(LOOP_SCHEDULES_PATH);
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (body === null || typeof body !== 'object' || !('schedules' in body)) return null;
    const schedules = body.schedules;
    if (!Array.isArray(schedules) || !schedules.every(isSchedule)) return null;
    const summary: Record<string, number> = {};
    for (const row of loopRows(schedules, Date.now())) summary[row.verdict] = (summary[row.verdict] ?? 0) + 1;
    return summary;
  } catch { return null; }
}

async function readMerged(client: DaemonClient, now: Date): Promise<number | null> {
  try {
    const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(now);
    const since = Date.parse(`${date}T00:00:00+09:00`);
    const response = await client.fetchResponse(`/v1/harness/runs?finishedSince=${since}`);
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (body === null || typeof body !== 'object' || !('landed' in body)) return null;
    if ('landedTruncated' in body && body.landedTruncated !== false) return null;
    if ('landedError' in body && body.landedError != null) return null;
    const landed = body.landed;
    if (!Array.isArray(landed) || !landed.every((row) => row && typeof row.number === 'number'
      && typeof row.mergedAt === 'string' && Number.isFinite(Date.parse(row.mergedAt)))) return null;
    return new Set(landed.filter((row) => Date.parse(row.mergedAt) >= since).map((row) => row.number)).size;
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
  const [seats, loops, decisions, merged] = await Promise.all([
    getSeats(client),
    readSchedules(client),
    listOpenDecisions(client).then((rows) => Array.isArray(rows) ? rows.length : null).catch(() => null),
    readMerged(client, new Date(Date.now())),
  ]);
  return {
    release: seats.kind === 'ready' ? releaseFromSeats(seats.data) : null,
    loops,
    decisions,
    merged,
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
  </main>;
}
