'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { FabricStageHeader } from '@/components/shell/FabricStageHeader';
import Link from 'next/link';

/**
 * Scheduler 표면 (2026-07-08 부활 · registry 기반).
 *
 * 2026-05-11 에 "스케줄은 workflow trigger 로 통합" 이라며 은퇴시켰으나, 실제
 * 예약(투자 크론 등)은 workflow YAML 이 아니라 `schedule_registry` 에 산다 →
 * workflow 화면에선 안 보이는 공백이 생겼다. 그래서 "모든 예약의 단일 인지
 * 지점" 인 schedule-registry(crontab·데몬 내부·workflow trigger 미러를 전부
 * 흡수)를 그대로 뷰로 되살린다. READ-ONLY(P1). adopt/release/CRUD 는 P2.
 */

export interface ScheduleJob {
  id: string;
  name: string;
  cron: string | null;
  intervalMs: number | null;
  category: string;
  domain: string | null;
  source: string;
  enabled: boolean;
  runVia: string;
  lastRun: string | null;
  // P1 실행 관측성(RFC-scheduler-execution-observability) — 백엔드가 이미 반환·프론트 렌더 보강.
  lastStatus?: string | null;
  lastExit?: number | null;
  lastDurationMs?: number | null;
  lastVia?: string | null;
  lastError?: string | null;
  stale?: boolean;
  command: string;
  note: string | null;
  /** «켜짐»의 근거(🅣 S1 `GET /v1/schedules`) — 레지스트리 enabled 가 아니라 실제 발화 경로(crontab·launchd·trigger)로 잰 상태. */
  state?: ScheduleState;
  /** 다음 발화 시각(ISO · 최대 5). */
  next?: string[];
  /** stale · no-history · duplicate · pilot-path. */
  flags?: string[];
}

export type ScheduleState = 'live' | 'firing' | 'stale' | 'off';

/** `GET /v1/schedules` 카드(🅣 #21472 · 레지스트리 메타는 🅕 09-28 추가). */
export interface ScheduleCard {
  id: string;
  name: string;
  source: string;
  cron: string | null;
  intervalMs: number | null;
  command: string | null;
  runVia?: string | null;
  category?: string | null;
  domain?: string | null;
  note?: string | null;
  state: ScheduleState;
  registryEnabled: boolean;
  next: string[];
  lastRun: { at: string; status: string | null; exit: number | null; durationMs: number | null; via: string | null } | null;
  flags: string[];
  pid?: number | null;
  lastExit?: number | null;
}

/** 새 카드 → 화면 행. 켜짐 = 실제 발화 근거가 있다(state ≠ off). */
export function cardToJob(card: ScheduleCard): ScheduleJob {
  return {
    id: card.id,
    name: card.name,
    cron: card.cron,
    intervalMs: card.intervalMs,
    category: card.category ?? card.source,
    domain: card.domain ?? null,
    source: card.source,
    enabled: card.state !== 'off',
    runVia: card.runVia ?? card.source,
    lastRun: card.lastRun?.at ?? null,
    lastStatus: card.lastRun?.status ?? null,
    lastExit: card.lastRun?.exit ?? card.lastExit ?? null,
    lastDurationMs: card.lastRun?.durationMs ?? null,
    lastVia: card.lastRun?.via ?? null,
    stale: card.state === 'stale',
    command: card.command ?? '',
    note: card.note ?? null,
    state: card.state,
    next: card.next,
    flags: card.flags,
  };
}

export function cardsToPayload(cards: ScheduleCard[], generatedAt = new Date().toISOString()): SchedulesPayload {
  const jobs = cards.map(cardToJob);
  const byCategory: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  const byState: Record<string, number> = {};
  for (const j of jobs) {
    byCategory[j.category] = (byCategory[j.category] ?? 0) + 1;
    bySource[j.source] = (bySource[j.source] ?? 0) + 1;
    if (j.state) byState[j.state] = (byState[j.state] ?? 0) + 1;
  }
  return { total: jobs.length, adopted: jobs.filter((j) => j.runVia === 'elanous').length, byCategory, bySource, byState, jobs, generatedAt };
}

export interface SchedulesPayload {
  total: number;
  adopted: number;
  byCategory: Record<string, number>;
  bySource: Record<string, number>;
  /** 새 API 에서만 — 상태별 수. */
  byState?: Record<string, number>;
  jobs: ScheduleJob[];
  generatedAt: string;
}

export type ScheduleLoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; data: SchedulesPayload }
  | { kind: 'error'; reason: string };

function errorReason(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  return 'Unknown error';
}

/** 새 읽기 API(`/v1/schedules`)가 정본 — 판올림 전 데몬(그 경로가 없다)에서만 옛 대시보드 경로로 한 번 더. 모양으로 가른다. */
export const SCHEDULES_PATH = '/v1/schedules?includeOff=1';
export const LEGACY_SCHEDULES_PATH = '/v1/dashboard/schedules';

function toPayload(res: unknown): SchedulesPayload | null {
  const body = res as { schedules?: unknown } | null;
  if (!body || typeof body !== 'object') return null;
  if (Array.isArray(body.schedules)) return cardsToPayload(body.schedules as ScheduleCard[]);
  const legacy = body.schedules as SchedulesPayload | undefined;
  return legacy && Array.isArray(legacy.jobs) ? legacy : null;
}

export async function fetchScheduleLoad(
  fetchJson: (path: string) => Promise<unknown>,
): Promise<ScheduleLoadState> {
  let reason = 'Unknown error';
  for (const path of [SCHEDULES_PATH, LEGACY_SCHEDULES_PATH]) {
    try {
      const data = toPayload(await fetchJson(path));
      if (data) return { kind: 'ready', data };
      reason = `unexpected response from ${path}`;
    } catch (err) {
      reason = errorReason(err);
    }
  }
  return { kind: 'error', reason };
}

const STATE_BADGE: Record<ScheduleState, { label: string; tone: string; tip: string }> = {
  live: { label: '켜짐', tone: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30', tip: '실제 발화 경로(crontab·launchd·trigger)에 올라 있다' },
  firing: { label: '발화 중', tone: 'bg-sky-500/15 text-sky-200 ring-sky-500/30', tip: '발화 경로에 올라 있고 최근 실행 기록이 있다' },
  stale: { label: '유실 의심', tone: 'bg-amber-500/15 text-amber-300 ring-amber-500/30', tip: '예정 시각이 지났는데 실행 기록이 없다' },
  off: { label: '꺼짐', tone: 'bg-muted text-muted-foreground ring-border', tip: '어느 발화 경로에도 없다(레지스트리에만 있다)' },
};

/** `?ids=a,b` — Missions 의 «이 미션을 부르는 스케줄» 링크가 넘기는 정확한 id 목록(부분 일치 아님). */
export function parseIdsFilter(search: string): string[] | null {
  const raw = new URLSearchParams(search).get('ids');
  if (!raw) return null;
  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return ids.length ? ids : null;
}

function fmtNext(iso: string | undefined): string | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return null;
  const min = Math.round((ts - Date.now()) / 60000);
  if (min < 1) return 'next <1m';
  if (min < 60) return `next ${min}m`;
  const hr = Math.floor(min / 60);
  return hr < 24 ? `next ${hr}h` : `next ${Math.floor(hr / 24)}d`;
}

export function isCurrentScheduleRequest<T>(
  request: number,
  client: T,
  latestRequest: number,
  activeClient: T | null,
): boolean {
  return request === latestRequest && activeClient === client;
}

export function reportScheduleLoadFailure(reason: string, notify: (message: string) => void): void {
  notify(`scheduler load failed: ${reason}`);
}

const RUN_VIA_TONE: Record<string, string> = {
  elanous: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
  daemon: 'bg-sky-500/15 text-sky-200 ring-sky-500/30',
  crontab: 'bg-muted text-muted-foreground ring-border',
};

const DOMAIN_LABEL: Record<string, string> = {
  finance: 'Finance',
  elanous: 'elanous (core)',
  general: 'General',
};

function domainKey(d: string | null): string {
  return d && d.trim() ? d : 'general';
}

function fmtRelative(iso: string | null): string {
  if (!iso) return 'never';
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function whenLabel(job: ScheduleJob): string {
  if (job.cron) return job.cron;
  if (job.intervalMs) return `every ${Math.round(job.intervalMs / 1000)}s`;
  return '—';
}

/** command 를 읽기 쉬운 한 줄 설명으로 자동 요약(하단 레이블용).
 *  긴 "cd ... && /path/bun scripts/dig-runner.ts >> /tmp/x" 에서 실행 스크립트만
 *  뽑아 "scripts/dig-runner.ts". 스크립트가 없으면 인터프리터/리다이렉트 제거한
 *  핵심 명령. note(수동 설명)가 있으면 그걸 우선하고 이 함수는 fallback. */
function describeCommand(cmd: string): string {
  if (!cmd) return '—';
  const noRedirect = cmd.split(/\s*>>?\s*/)[0]!.trim();
  const file = noRedirect.match(/(\S+\.(?:ts|py|sh|js|mjs))\b/);
  if (file) {
    const path = file[1]!;
    const si = path.indexOf('/scripts/');
    if (si >= 0) return path.slice(si + 1); // scripts/<name>.ts
    const slash = path.lastIndexOf('/');
    return slash >= 0 ? path.slice(slash + 1) : path; // basename
  }
  // 스크립트 없으면 cd/&& 프리앰블 제거 후 첫 실행 명령.
  return noRedirect.replace(/^cd\s+\S+\s*&&\s*/, '').trim().slice(0, 60) || '—';
}

function ActionBtn({
  label,
  onClick,
  disabled,
  danger,
}: {
  label: string;
  onClick: () => void;
  disabled: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={[
        'rounded-md px-1.5 py-0.5 text-[10px] ring-1 transition-colors disabled:opacity-40',
        danger
          ? 'text-red-300 ring-red-500/30 hover:bg-red-500/15'
          : 'text-muted-foreground ring-border hover:bg-accent/40 hover:text-foreground',
      ].join(' ')}
    >
      {label}
    </button>
  );
}

function JobRow({
  job,
  onAction,
  acting,
}: {
  job: ScheduleJob;
  onAction: (action: string, job: ScheduleJob, note?: string) => void;
  acting: boolean;
}) {
  // daemon(데몬 내부 스케줄)·launchd·trigger 미러는 crontab/registry 조작 대상이 아님 — 액션 숨김.
  const isDaemon = job.runVia === 'daemon' || job.id.includes(':');
  const badge = job.state ? STATE_BADGE[job.state] : null;
  const next = fmtNext(job.next?.[0]);
  // 하단 레이블: 수동 설명(note)이 있으면 우선, 없으면 command 자동 요약.
  const label = job.note || describeCommand(job.command);
  // 호버 툴팁: 설명(있으면) + 항상 풀 command.
  const tip = job.note ? `${job.note}\n\n${job.command}` : job.command;
  return (
    <div
      className={[
        'flex flex-col gap-1 rounded-xl border border-border bg-card p-3 sm:flex-row sm:items-center sm:justify-between',
        job.enabled ? '' : 'opacity-50',
      ].join(' ')}
      title={tip}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{job.name}</span>
          {badge ? (
            <span className={`shrink-0 whitespace-nowrap rounded-full px-1.5 py-0.5 text-[10px] ring-1 ${badge.tone}`} title={badge.tip} data-schedule-state={job.state}>{badge.label}</span>
          ) : !job.enabled && (
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">disabled</span>
          )}
          {job.flags?.includes('duplicate') && (
            <span className="rounded-full bg-red-500/15 px-1.5 py-0.5 text-[10px] text-red-300 ring-1 ring-red-500/30" title="같은 명령이 두 번 발화한다">duplicate</span>
          )}
        </div>
        <div
          className={`mt-0.5 truncate text-[11px] ${job.note ? 'text-muted-foreground' : 'font-mono text-muted-foreground/70'}`}
        >
          {label}
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 text-[11px]">
        <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-muted-foreground">{whenLabel(job)}</span>
        {next && job.enabled && (
          <span className="text-muted-foreground" title={job.next?.join('\n')}>{next}</span>
        )}
        <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">{job.category}</span>
        <span className={`rounded-full px-2 py-0.5 ring-1 ${RUN_VIA_TONE[job.runVia] ?? RUN_VIA_TONE.crontab}`}>
          {job.runVia}
        </span>
        {/* P1 실행 상태(RFC) — 마지막 실행 성공/실패·소요·경로. 백엔드 lastStatus 렌더. */}
        {job.lastStatus && (
          <span
            className={`rounded-full px-2 py-0.5 ring-1 ${
              job.lastStatus === 'ok'
                ? 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30'
                : 'bg-red-500/15 text-red-300 ring-red-500/30'
            }`}
            title={job.lastError ?? (job.lastStatus === 'ok' ? '마지막 실행 성공' : `exit ${job.lastExit ?? '?'}`)}
          >
            {job.lastStatus === 'ok' ? '✓' : '✗'}
            {job.lastDurationMs != null ? ` ${Math.round(job.lastDurationMs)}ms` : ''}
            {job.lastVia && job.lastVia !== 'crontab' ? ` ${job.lastVia}` : ''}
          </span>
        )}
        {job.stale && !badge && (
          <span
            className="rounded-full bg-amber-500/15 px-2 py-0.5 text-amber-300 ring-1 ring-amber-500/30"
            title="예정 시각이 지났는데 미실행(유실 의심)"
          >
            stale
          </span>
        )}
        <span className="text-muted-foreground" title={job.lastRun ?? 'never run'}>
          {fmtRelative(job.lastRun)}
        </span>
        {!isDaemon && (
          <span className="ml-1 flex items-center gap-1">
            {job.runVia === 'crontab' && (
              <ActionBtn label="adopt" onClick={() => onAction('adopt', job)} disabled={acting} />
            )}
            {job.runVia === 'elanous' && (
              <ActionBtn label="release" onClick={() => onAction('release', job)} disabled={acting} />
            )}
            <ActionBtn
              label={job.enabled ? 'disable' : 'enable'}
              onClick={() => onAction(job.enabled ? 'disable' : 'enable', job)}
              disabled={acting}
            />
            <ActionBtn label="✕" onClick={() => onAction('delete', job)} disabled={acting} danger />
          </span>
        )}
      </div>
    </div>
  );
}

export function ScheduleLoadContent({
  load,
  groups,
  onRefresh,
  onAction,
  busy,
  acting,
}: {
  load: ScheduleLoadState;
  groups: Array<{ domain: string; jobs: ScheduleJob[] }>;
  onRefresh: () => void;
  onAction: (action: string, job: ScheduleJob, note?: string) => void;
  busy: boolean;
  acting: boolean;
}) {
  if (load.kind === 'loading') return <div className="text-sm text-muted-foreground">Loading schedules…</div>;
  if (load.kind === 'error') {
    return (
      <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-10 text-center text-sm text-destructive">
        <p>Failed to load schedules</p>
        <p className="mt-1 text-muted-foreground">{load.reason}</p>
        <Button className="mt-3" size="sm" variant="outline" onClick={onRefresh} disabled={busy}>
          Retry
        </Button>
      </div>
    );
  }
  const data = load.data;
  if (data.jobs.length === 0) {
    return <div className="rounded-xl border border-dashed border-border px-3 py-10 text-center text-sm text-muted-foreground">no schedules</div>;
  }
  return (
    <div className="space-y-6">
      {groups.map((group) => (
        <section key={group.domain} className="space-y-2">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold">{DOMAIN_LABEL[group.domain] ?? group.domain}</h2>
            <span className="rounded-full bg-background px-2 py-0.5 text-[11px] text-muted-foreground">{group.jobs.length}</span>
          </div>
          <div className="space-y-2">
            {group.jobs.map((job) => <JobRow key={job.id} job={job} onAction={onAction} acting={acting} />)}
          </div>
        </section>
      ))}
    </div>
  );
}

export function SchedulerPanel() {
  const { client } = useDaemon();
  const [load, setLoad] = useState<ScheduleLoadState>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [acting, setActing] = useState(false);
  const requestId = useRef(0);
  const inFlightClient = useRef<typeof client | null>(null);
  const data = load.kind === 'ready' ? load.data : null;
  // ⛔ 렌더 중에 location 을 읽지 않는다(정적 export 하이드레이션 · #418) — 마운트 뒤에.
  const [idsFilter, setIdsFilter] = useState<string[] | null>(null);
  useEffect(() => { setIdsFilter(parseIdsFilter(window.location.search)); }, []);

  const refresh = useCallback(async (): Promise<void> => {
    if (inFlightClient.current === client) return;
    inFlightClient.current = client;
    const currentRequest = ++requestId.current;
    setBusy(true);
    setLoad({ kind: 'loading' });
    try {
      const nextLoad = await fetchScheduleLoad((path) => client.fetchJson<unknown>(path));
      if (isCurrentScheduleRequest(currentRequest, client, requestId.current, inFlightClient.current)) {
        setLoad(nextLoad);
        if (nextLoad.kind === 'error') reportScheduleLoadFailure(nextLoad.reason, toast.error);
      }
    } finally {
      if (isCurrentScheduleRequest(currentRequest, client, requestId.current, inFlightClient.current)) {
        inFlightClient.current = null;
        setBusy(false);
      }
    }
  }, [client]);

  const doAction = useCallback(
    async (action: string, job: ScheduleJob, note?: string): Promise<void> => {
      if (action === 'delete' && !window.confirm(`삭제: ${job.name}?\n(자동 백업되어 복구 가능)`)) return;
      setActing(true);
      try {
        const res = await client.fetchJson<{ error?: string }>('/v1/schedules/action', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action, id: job.id, ...(note !== undefined ? { note } : {}) }),
        });
        if (res && typeof res === 'object' && 'error' in res && res.error) {
          toast.error(`${action} 실패: ${res.error}`);
        } else {
          toast.success(action === 'note' ? `설명 저장: ${job.name}` : `${action}: ${job.name}`);
          await refresh();
        }
      } catch (err) {
        toast.error(`${action} 실패: ${err instanceof Error ? err.message : err}`);
      } finally {
        setActing(false);
      }
    },
    [client, refresh],
  );

  useEffect(() => {
    void refresh();
    const handle = window.setInterval(() => void refresh(), 30000);
    return () => window.clearInterval(handle);
  }, [refresh]);

  const groups = useMemo(() => {
    if (!data) return [];
    const byDomain = new Map<string, ScheduleJob[]>();
    for (const job of data.jobs) {
      if (idsFilter && !idsFilter.includes(job.id)) continue;
      const key = domainKey(job.domain);
      const list = byDomain.get(key) ?? [];
      list.push(job);
      byDomain.set(key, list);
    }
    // finance -> elanous -> general -> 기타 순, 각 그룹 내 last_run 최신 우선.
    const order = ['finance', 'elanous', 'general'];
    return [...byDomain.entries()]
      .sort((a, b) => {
        const ia = order.indexOf(a[0]);
        const ib = order.indexOf(b[0]);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      })
      .map(([domain, jobs]) => ({
        domain,
        jobs: jobs.sort((x, y) => (Date.parse(y.lastRun ?? '0') || 0) - (Date.parse(x.lastRun ?? '0') || 0)),
      }));
  }, [data, idsFilter]);

  return (
    <div className="mx-auto max-w-[1200px] space-y-4 p-4">
      <FabricStageHeader active="scheduler" />
      <header className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Schedules</h1>
          <p className="text-sm text-muted-foreground">
            예약된 모든 잡 한 곳 (crontab · launchd · 데몬 내부 · workflow trigger). «켜짐» = 실제 발화 경로에 올라 있다.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/loops" className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-accent">루프 현황 →</Link>
          {data && (
            <>
              <div className="rounded-lg border border-border bg-card px-3 py-2 text-xs">
                <div className="text-muted-foreground">total</div>
                <div className="text-sm font-semibold">{data.total}</div>
              </div>
              {data.byState ? (
                (['live', 'firing', 'stale', 'off'] as const).map((st) => (
                  <div key={st} className="rounded-lg border border-border bg-card px-3 py-2 text-xs" data-schedule-count={st}>
                    <div className="text-muted-foreground">{STATE_BADGE[st].label}</div>
                    <div className={`text-sm font-semibold ${st === 'stale' && data.byState?.[st] ? 'text-amber-300' : ''}`}>{data.byState?.[st] ?? 0}</div>
                  </div>
                ))
              ) : (
                <div className="rounded-lg border border-border bg-card px-3 py-2 text-xs">
                  <div className="text-muted-foreground">adopted (elanous)</div>
                  <div className="text-sm font-semibold">{data.adopted}</div>
                </div>
              )}
            </>
          )}
          <Button size="sm" variant="outline" onClick={() => void refresh()} disabled={busy}>
            Refresh
          </Button>
        </div>
      </header>

      {idsFilter && (
        <div className="flex items-center gap-2 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2 text-xs" data-schedule-ids-filter>
          <span>미션이 부르는 스케줄만 · {idsFilter.length}</span>
          {data && groups.reduce((n, g) => n + g.jobs.length, 0) < idsFilter.length && (
            <span className="text-amber-300">— {idsFilter.length - groups.reduce((n, g) => n + g.jobs.length, 0)}개는 지금 목록에 없다(지워졌거나 다른 우주)</span>
          )}
          <button type="button" className="ml-auto underline" onClick={() => { setIdsFilter(null); window.history.replaceState(null, '', window.location.pathname); }}>모두 보기</button>
        </div>
      )}
      <ScheduleLoadContent
        load={load}
        groups={groups}
        onRefresh={() => void refresh()}
        onAction={doAction}
        busy={busy}
        acting={acting}
      />
    </div>
  );
}
