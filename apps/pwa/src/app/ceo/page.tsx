'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { loopRows, LOOP_SCHEDULES_PATH, LOOPS_PATH, type LoopSchedule } from '@/components/loops/loop-status';
import { LOOPS_INTERACT_HREF } from '@/components/loops/loops-view';
import { listOpenDecisions } from '@/lib/decisions-api';
import { getSeats, type OpsSeats } from '@/lib/ops-api';
import type { DaemonClient } from '@/lib/daemon-client';
import type { GridData } from '../../../../../src/nexus/api/grid';

type Risk = { id: string; kind: string; title: string; at: string };
type SchedulesResult = { summary: Record<string, number>; risks: Risk[] };
type DecisionsResult = { count: number; risks: Risk[] };
type Snapshot = {
  release: { green: number; yellow: number } | null | undefined;
  loops: Record<string, number> | null | undefined;
  decisions: number | null | undefined;
  merged: number | null | undefined;
  risks: Risk[] | null | undefined;
  grid: GridData | null | undefined;
};

const empty: Snapshot = { release: undefined, loops: undefined, decisions: undefined, merged: undefined, risks: undefined, grid: undefined };
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

function todayStart(now: Date): number {
  const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(now);
  return Date.parse(`${date}T00:00:00+09:00`);
}

async function readMergedRuns(client: DaemonClient, today: number): Promise<number | null> {
  try {
    const response = await client.fetchResponse(`/v1/harness/runs?finishedSince=${today}`);
    const body: unknown = response.ok ? await response.json() : null;
    const landed = object(body) ? body.landed : null;
    return object(body) && (body.landedTruncated === undefined || body.landedTruncated === false) && body.landedError == null
      && Array.isArray(landed) && landed.every((row: unknown) => object(row) && typeof row.number === 'number' && validTime(row.mergedAt))
      ? new Set(landed.filter((row) => Date.parse(row.mergedAt) >= today).map((row) => row.number)).size : null;
  } catch { return null; }
}

async function readRunRisks(client: DaemonClient, today: number): Promise<Risk[] | null> {
  try {
    const response = await client.fetchResponse(`/v1/harness/runs?finishedSince=${today - 7 * 24 * 60 * 60 * 1000}`);
    const riskBody: unknown = response.ok ? await response.json() : null;
    if (!object(riskBody)) return null;
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
    return risks;
  } catch { return null; }
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

async function readGrid(client: DaemonClient): Promise<GridData | null> {
  try {
    const response = await client.fetchResponse('/v1/grid');
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (!object(body) || !object(body.hq) || !Array.isArray(body.members)
      || (body.poolReason !== null && typeof body.poolReason !== 'string')) return null;
    const hq = body.hq;
    if ((hq.record !== null && (!object(hq.record) || typeof hq.record.holder !== 'string'))
      || (hq.ageSeconds !== null && (typeof hq.ageSeconds !== 'number' || !Number.isFinite(hq.ageSeconds)))
      || (hq.expired !== null && typeof hq.expired !== 'boolean')
      || (hq.reason !== null && typeof hq.reason !== 'string')
      || !body.members.every((row: unknown) => object(row) && typeof row.context === 'string'
        && typeof row.capacity === 'number' && Number.isFinite(row.capacity)
        && (row.occupied === null || (typeof row.occupied === 'number' && Number.isFinite(row.occupied))))) return null;
    return body as unknown as GridData;
  } catch { return null; }
}

function readWithDeadline<T>(request: Promise<T>, onTimeout: T): Promise<T> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(onTimeout), 15_000);
    void request.then(
      (result) => { clearTimeout(timeout); resolve(result); },
      () => { clearTimeout(timeout); resolve(onTimeout); },
    );
  });
}

function readSnapshot(client: DaemonClient, update: (patch: Partial<Snapshot>) => void): void {
  const now = Date.now();
  const today = todayStart(new Date(now));
  const seats = readWithDeadline(getSeats(client), { kind: 'error' as const, status: 0 });
  const loops = readWithDeadline(readSchedules(client), null);
  const loopFailures = readWithDeadline(readLoopFailures(client), null);
  const decisions = readWithDeadline(readDecisions(client, now), null);
  const merged = readWithDeadline(readMergedRuns(client, today), null);
  const runRisks = readWithDeadline(readRunRisks(client, today), null);
  const grid = readWithDeadline(readGrid(client), null);

  void seats.then((value) => update({ release: value.kind === 'ready' ? releaseFromSeats(value.data) : null }));
  void loops.then((value) => update({ loops: value?.summary ?? null }));
  void decisions.then((value) => update({ decisions: value?.count ?? null }));
  void merged.then((value) => update({ merged: value }));
  void grid.then((value) => update({ grid: value }));
  void Promise.all([loops, loopFailures, decisions, runRisks]).then(([schedule, failures, decision, runs]) => {
    const risks = schedule && failures && decision && runs ? [...new Map(
      [...schedule.risks, ...failures, ...decision.risks, ...runs]
        .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
        .map((risk) => [risk.id, risk] as const),
    ).values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.id.localeCompare(b.id)).slice(0, 5) : null;
    update({ risks });
  });
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
    readSnapshot(client, (patch) => { if (active) setSnapshot((current) => ({ ...current, ...patch })); });
    return () => { active = false; };
  }, [client]);

  return <main className="mx-auto w-full min-w-0 max-w-3xl px-3 py-4 text-foreground sm:px-6">
    <header className="mb-4"><p className="text-xs text-muted-foreground">운영 · 오늘</p><h1 className="text-xl font-semibold">대표 조망판</h1></header>
    <div className="grid grid-cols-2 gap-2 sm:gap-4" aria-label="대표 조망 카드">
      <Card title="릴리스 판 진행">{snapshot.release === undefined ? '불러오는 중…' : snapshot.release
        ? <><span className="text-emerald-600">green {snapshot.release.green}</span><span className="block text-amber-600">노랑 {snapshot.release.yellow}</span></>
        : '못 읽음'}
        <Link href="/ops/release" className="mt-1 block rounded text-xs font-medium text-primary underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" aria-label="발행 현황 보기 — 운영 › 릴리스">발행 현황 보기 →</Link></Card>
      <Card title="루프 판정">{snapshot.loops === undefined ? '불러오는 중…' : snapshot.loops === null ? '못 읽음' : Object.keys(snapshot.loops).length === 0
        ? '등록 0' : <div className="flex flex-wrap gap-1 text-xs font-medium">{Object.entries(snapshot.loops).map(([verdict, count]) =>
          <span key={verdict} className="rounded-full bg-muted px-2 py-1">{verdict} {count}</span>)}</div>}
        <Link href={LOOPS_INTERACT_HREF} className="mt-1 block rounded text-xs font-medium text-primary underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" aria-label="루프 상호작용 보기 — 운영 › 루프 상호작용">루프 상호작용 보기 →</Link></Card>
      <Card title="결정 대기 카드"><Link href="/decisions" className="rounded underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" aria-label="결정 대기 카드 보기">{snapshot.decisions === undefined ? '불러오는 중…' : snapshot.decisions ?? '못 읽음'}</Link></Card>
      <Card title="오늘 병합 PR">{snapshot.merged === undefined ? '불러오는 중…' : snapshot.merged ?? '못 읽음'}</Card>
    </div>
    <div className="mt-2 grid min-w-0 grid-cols-2 gap-2 sm:mt-4 sm:gap-4" aria-label="위험과 그리드 카드">
      <section aria-label="위험·막힘 톱 5" className="min-w-0 rounded-xl border border-border bg-card p-2 sm:p-4">
        <h2 className="text-xs font-medium text-muted-foreground sm:text-sm">위험·막힘 톱 5</h2>
        {snapshot.risks === undefined ? <p className="mt-2 text-sm">불러오는 중…</p> : snapshot.risks === null ? <p className="mt-2 text-sm">못 읽음</p> : snapshot.risks.length === 0
          ? <p className="mt-2 text-sm">해당 없음</p>
          : <ol className="mt-2 space-y-1 text-xs">{snapshot.risks.map((risk) => <li key={risk.id} className="min-w-0 border-b border-border pb-1 last:border-0">
            <span className="block text-muted-foreground">{risk.kind} · <time dateTime={risk.at}>{risk.at.slice(0, 16).replace('T', ' ')}</time></span>
            <span className="block truncate" title={risk.title}>{risk.title}</span>
          </li>)}</ol>}
      </section>
      <section aria-label="그리드" className="min-w-0 rounded-xl border border-border bg-card p-2 sm:p-4">
        <h2 className="text-xs font-medium text-muted-foreground sm:text-sm">그리드</h2>
        {snapshot.grid === undefined ? <p className="mt-2 text-sm">불러오는 중…</p> : snapshot.grid === null ? <p className="mt-2 text-sm">못 읽음</p> : <div className="mt-2 space-y-2 text-xs">
          <p className="min-w-0 break-words">본부 · {snapshot.grid.hq.reason ? '본부 못 읽음'
            : snapshot.grid.hq.record ? <><span title={snapshot.grid.hq.record.holder}>{snapshot.grid.hq.record.holder}</span>
              {snapshot.grid.hq.ageSeconds !== null && <> · {Math.floor(snapshot.grid.hq.ageSeconds / 60)}분 전</>}
              {snapshot.grid.hq.expired && <span className="ml-1 font-semibold text-red-600">만료</span>}</>
              : '임대 없음'}</p>
          {snapshot.grid.poolReason && <p className="break-words text-amber-700" title={snapshot.grid.poolReason}>풀 못 읽음 · {snapshot.grid.poolReason.slice(0, 40)}</p>}
          <ul className="space-y-1">{snapshot.grid.members.map((member) => <li key={member.context} className="min-w-0">
            <div className="flex min-w-0 items-center justify-between gap-1">
              <span className="min-w-0 truncate" title={member.context}>{member.context}</span>
              <span className="shrink-0 tabular-nums">{member.occupied === null ? '측정 불가' : `${member.occupied}/${member.capacity}`}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="meter" aria-label={`${member.context} 칸 사용`}
              aria-valuemin={0} aria-valuemax={Math.max(member.capacity, member.occupied ?? 0, 1)}
              {...(member.occupied === null ? {} : { 'aria-valuenow': member.occupied })}>
              {member.occupied !== null && <div className="h-full rounded-full bg-emerald-600"
                style={{ width: `${member.capacity > 0 ? Math.min(100, Math.max(0, member.occupied / member.capacity * 100)) : 0}%` }} />}
            </div>
          </li>)}</ul>
          <p className="font-medium tabular-nums">칸 사용 {snapshot.grid.poolReason || snapshot.grid.members.some((member) => member.occupied === null)
            ? '측정 불가' : snapshot.grid.members.reduce((sum, member) => sum + member.occupied!, 0)}/{snapshot.grid.members.reduce((sum, member) => sum + member.capacity, 0)}</p>
        </div>}
      </section>
    </div>
  </main>;
}
