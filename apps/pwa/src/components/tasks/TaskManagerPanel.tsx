'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { Button } from '@/components/ui/button';
import { TaskApi, type TaskBoardCard, type TaskDetail } from '@/lib/task-api';
import { debugLog } from '@/lib/debug';
import { toast } from 'sonner';
// W9d-FU Z13-a / Z13-c · TaskCard chip mounts. Substrate: #2438 + #2440 + #2447 + #2448.
import { NextFluentChip } from '@/components/fluent-chain/NextFluentChip';
import { createFluentChainApi } from '@/lib/fluent-chain-api';

/** next-fluent 칩 1-클릭 액션 실행 → dispatch + board refresh. 카드 계층에 context 로 주입(threading 회피). */
const ChipActionContext = createContext<((refId: string, action: string) => Promise<void>) | null>(null);
import { IdleNudgeBadge } from '@/components/idle-nudge/IdleNudgeBadge';
import { FabricStageHeader } from '@/components/shell/FabricStageHeader';

const IDLE_NUDGE_STATUSES = new Set<TaskBoardCard['status']>([
  'ready', 'running', 'review', 'blocked',
]);
const DONE_STATUSES = new Set<TaskBoardCard['status']>(['done', 'failed']);

const COLUMN_DEFS = [
  { id: 'backlog', label: 'Backlog', statuses: ['backlog', 'blocked'] },
  { id: 'scheduled', label: 'Scheduled', statuses: ['scheduled'] },
  { id: 'ready', label: 'Ready', statuses: ['ready'] },
  { id: 'running', label: 'Running', statuses: ['running'] },
  { id: 'review', label: 'Review', statuses: ['review'] },
  { id: 'closed', label: 'Closed', statuses: ['done', 'failed', 'cancelled', 'superseded'] },
] as const;

const PRIORITY_TONE: Record<string, string> = {
  urgent: 'bg-red-500/15 text-red-300 ring-red-500/30',
  high: 'bg-amber-500/15 text-amber-200 ring-amber-500/30',
  medium: 'bg-sky-500/15 text-sky-200 ring-sky-500/30',
  low: 'bg-muted text-muted-foreground ring-border',
};

/** 아크 상태 색 — 순차 배리어·통합검증 가시화(2026-07-14). */
const ARC_STATUS_TONE: Record<string, string> = {
  pending: 'bg-slate-500/15 text-slate-300 ring-slate-500/30',
  active: 'bg-sky-500/15 text-sky-200 ring-sky-500/30',
  verifying: 'bg-amber-500/15 text-amber-200 ring-amber-500/30',
  done: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
  failed: 'bg-red-500/15 text-red-300 ring-red-500/30',
};

function fmtRelative(ts: number): string {
  const diff = Date.now() - ts;
  const sec = Math.max(0, Math.floor(diff / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

// ── 미션별 그룹핑(2026-07-14) — 미션을 Task Manager 에서 조직화 단위로 ─────────────
const ORDER: Record<string, number> = { running: 0, review: 1, ready: 2, blocked: 3, backlog: 4, done: 5, failed: 5, cancelled: 6, superseded: 6, scheduled: 3 };

interface MissionGroupData {
  key: string; // goalSlug or '__standalone__'
  missionTitle: string;
  tasks: TaskBoardCard[];
  total: number;
  doneCount: number;
  runningCount: number;
  failedCount: number;
  // 아크 롤업: arcName → { total, done, status }
  arcs: Array<{ name: string; total: number; done: number; status: string; index: number }>;
  isStandalone: boolean;
}

function groupByMission(tasks: readonly TaskBoardCard[]): MissionGroupData[] {
  const byMission = new Map<string, TaskBoardCard[]>();
  for (const t of tasks) {
    const key = t.missionTitle ? (t.goalSlug ?? t.missionTitle) : '__standalone__';
    (byMission.get(key) ?? byMission.set(key, []).get(key)!).push(t);
  }
  const groups: MissionGroupData[] = [];
  for (const [key, ts] of Array.from(byMission.entries())) {
    const isStandalone = key === '__standalone__';
    const arcMap = new Map<string, { name: string; total: number; done: number; status: string; index: number }>();
    for (const t of ts) {
      if (t.arcName) {
        const a = arcMap.get(t.arcName) ?? { name: t.arcName, total: 0, done: 0, status: t.arcStatus ?? 'pending', index: t.arcIndex ?? 0 };
        a.total += 1;
        if (t.status === 'done') a.done += 1;
        if (t.arcStatus) a.status = t.arcStatus;
        arcMap.set(t.arcName, a);
      }
    }
    const sorted = [...ts].sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) || b.createdAt - a.createdAt);
    groups.push({
      key,
      missionTitle: isStandalone ? '독립 태스크 (미션 외)' : (ts[0]?.missionTitle ?? key),
      tasks: sorted,
      total: ts.length,
      doneCount: ts.filter((t) => t.status === 'done').length,
      runningCount: ts.filter((t) => t.status === 'running').length,
      failedCount: ts.filter((t) => t.status === 'failed').length,
      arcs: Array.from(arcMap.values()).sort((a, b) => a.index - b.index),
      isStandalone,
    });
  }
  // 활성(running/미완) 미션 먼저, 독립은 맨 뒤.
  return groups.sort((a, b) => {
    if (a.isStandalone !== b.isStandalone) return a.isStandalone ? 1 : -1;
    const aActive = a.runningCount > 0 || a.doneCount < a.total;
    const bActive = b.runningCount > 0 || b.doneCount < b.total;
    if (aActive !== bActive) return aActive ? -1 : 1;
    return b.total - a.total;
  });
}

function MissionGroup({ group, selectedId, onSelect }: { group: MissionGroupData; selectedId: string | null; onSelect: (id: string) => void }) {
  const pct = group.total > 0 ? Math.round((group.doneCount / group.total) * 100) : 0;
  return (
    <section className="rounded-2xl border border-border bg-muted/20 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {!group.isStandalone && <span className="text-xs">🎯</span>}
        <h2 className="text-sm font-semibold" title={group.missionTitle}>{group.missionTitle}</h2>
        <span className="rounded-full bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
          {group.doneCount}/{group.total} · {pct}%
        </span>
        {group.runningCount > 0 && (
          <span className="animate-pulse rounded-full bg-sky-500/15 px-2 py-0.5 text-[10px] text-sky-200 ring-1 ring-sky-500/30">
            ● {group.runningCount} 빌드중
          </span>
        )}
        {group.failedCount > 0 && (
          <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] text-red-300 ring-1 ring-red-500/30">
            ✗ {group.failedCount} 실패
          </span>
        )}
      </div>
      {/* 아크 진행 롤업 — 순차 배리어·통합검증 상태 */}
      {group.arcs.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {group.arcs.map((arc, i) => (
            <span key={arc.name} className="flex items-center gap-1 text-[10px]">
              {i > 0 && <span className="text-muted-foreground">→</span>}
              <span className={`rounded-full px-2 py-0.5 ring-1 ${ARC_STATUS_TONE[arc.status] ?? ARC_STATUS_TONE.pending}`}>
                ⬡ {arc.name} {arc.done}/{arc.total}
              </span>
            </span>
          ))}
        </div>
      )}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {group.tasks.map((task) => (
          <TaskCard key={task.id} task={task} selected={task.id === selectedId} onClick={() => onSelect(task.id)} />
        ))}
      </div>
    </section>
  );
}

/** 빌드 라이브 로그 뷰어(2026-07-14) — running 페이즈의 SE 빌드 로그를 2초 폴링으로 tail. */
function BuildLogViewer({ api, buildId }: { api: TaskApi; buildId: string }) {
  const [snap, setSnap] = useState<import('@/lib/task-api').BuildSnapshotWire | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const tick = async (): Promise<void> => {
      try {
        const s = await api.buildSnapshot(buildId, 120);
        if (cancelled) return;
        setSnap(s); setErr(null);
        // running 이면 계속 폴링(2s), 종결되면 1회 더 보고 중단.
        if (s.build.status === 'running') timer = window.setTimeout(() => void tick(), 2000);
      } catch (e) { if (!cancelled) setErr(e instanceof Error ? e.message : String(e)); }
    };
    void tick();
    return () => { cancelled = true; if (timer) window.clearTimeout(timer); };
  }, [api, buildId]);
  useEffect(() => { if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight; }, [snap]);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 text-[11px]">
        <span className="font-medium">빌드 로그</span>
        <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">{buildId}</span>
        {snap && (
          <span className={`rounded-full px-2 py-0.5 ring-1 ${snap.build.status === 'running' ? 'bg-sky-500/15 text-sky-200 ring-sky-500/30' : 'bg-muted text-muted-foreground ring-border'}`}>
            {snap.build.status === 'running' ? '● 라이브' : snap.build.status}
          </span>
        )}
        {snap?.diffStat && <span className="text-muted-foreground">+{snap.diffStat.insertions}/-{snap.diffStat.deletions} · {snap.diffStat.files}파일</span>}
      </div>
      {err && <div className="text-[11px] text-red-300">로그 조회 실패: {err}</div>}
      <div ref={boxRef} className="max-h-64 overflow-auto rounded-lg border border-border bg-background/60 p-2 font-mono text-[10px] leading-relaxed text-muted-foreground">
        {snap?.logTail?.length ? snap.logTail.map((l, i) => <div key={i} className="whitespace-pre-wrap break-all">{l}</div>) : <div className="opacity-60">로그 대기 중…</div>}
      </div>
    </div>
  );
}

function TaskCard({
  task,
  selected,
  onClick,
}: {
  task: TaskBoardCard;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'w-full rounded-xl border p-3 text-left transition-colors',
        selected
          ? 'border-primary bg-primary/10 ring-1 ring-primary/40'
          : 'border-border bg-card hover:bg-accent/40',
      ].join(' ')}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          {/* 미션 뱃지(2026-07-14) — 이 태스크를 빌드한 미션. 미션=태스크 통합 가시성. */}
          {task.missionTitle && (
            <div className="mb-1 flex items-center gap-1 truncate text-[10px] text-indigo-300" title={task.missionTitle}>
              <span className="shrink-0">🎯 미션</span>
              <span className="truncate opacity-80">{task.missionTitle}</span>
            </div>
          )}
          <div className="text-sm font-medium leading-5">{task.title}</div>
          <div className="mt-1 text-[11px] text-muted-foreground">{task.id}</div>
        </div>
        <div className="flex items-center gap-1.5">
          {task.dryRun && (
            <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] text-emerald-300">
              dry run
            </span>
          )}
          <span className={`rounded-full px-2 py-0.5 text-[10px] ring-1 ${PRIORITY_TONE[task.priority] ?? PRIORITY_TONE.low}`}>
            {task.priority}
          </span>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
        <span className="rounded-full bg-muted px-2 py-0.5">{task.surfaceKind}</span>
        {/* 빌드중 뱃지(2026-07-14) — running 페이즈의 실 SE 빌드(지금 도는 것). */}
        {task.status === 'running' && task.build && (
          <span
            className="flex items-center gap-1 rounded-full bg-sky-500/15 px-2 py-0.5 text-sky-200 ring-1 ring-sky-500/30"
            title={`빌드 ${task.build.buildId} · ${task.build.backend}${task.build.maxTurns ? ` · ${task.build.maxTurns}턴` : ''}`}
          >
            <span className="animate-pulse">●</span> 빌드중 {task.build.backend.replace(/^elanous-self:/, '')} 시도{task.build.attemptSeq}
          </span>
        )}
        {/* 아크 뱃지(2026-07-14) — 멀티아크 미션의 이 페이즈가 속한 아크·진행·통합검증 상태. */}
        {task.arcName && (
          <span
            className={`rounded-full px-2 py-0.5 ring-1 ${ARC_STATUS_TONE[task.arcStatus ?? 'pending'] ?? ARC_STATUS_TONE.pending}`}
            title={`아크: ${task.arcName}${task.arcStatus ? ` · ${task.arcStatus}` : ''}`}
          >
            ⬡ {task.arcName}
            {task.phaseIndexInArc && task.arcTotalPhases ? ` · ${task.phaseIndexInArc}/${task.arcTotalPhases}` : ''}
          </span>
        )}
        {task.featureName && <span className="rounded-full bg-muted px-2 py-0.5">{task.featureName}</span>}
        {task.scheduleText && <span className="rounded-full bg-muted px-2 py-0.5">{task.scheduleText}</span>}
        {task.showroomSessionId && (
          <a
            href={`/showroom?session=${encodeURIComponent(task.showroomSessionId)}`}
            onClick={(e) => e.stopPropagation()}
            className="rounded-full bg-sky-500/15 px-2 py-0.5 text-sky-200 ring-1 ring-sky-500/30 hover:bg-sky-500/25"
            title={`Open showroom session ${task.showroomSessionId}`}
          >
            ↗ showroom
          </a>
        )}
      </div>
      <div className="mt-3 flex items-center justify-between text-[11px] text-muted-foreground">
        <span>attempt {task.attempt}/{task.maxRetries}</span>
        <span>{fmtRelative(task.updatedAt)}</span>
      </div>
      <TaskStatusChips task={task} />
    </button>
  );
}

/** W9d-FU Z13-a + Z13-c · status-aware chip mount. Renders nothing
 *  when the daemon endpoint is unwired (chips internally handle the
 *  503 / `disabled` outcome by hiding themselves). Click events are
 *  stopped so the chip interaction doesn't bubble into the TaskCard
 *  selection. */
function TaskStatusChips({ task }: { task: TaskBoardCard }) {
  const isDone = DONE_STATUSES.has(task.status);
  const isIdle = IDLE_NUDGE_STATUSES.has(task.status);
  const onChipAction = useContext(ChipActionContext);
  if (!isDone && !isIdle) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2" onClick={(e) => e.stopPropagation()}>
      {isDone && (
        <NextFluentChip
          trigger={{
            refId: task.id,
            refKind: 'task',
            finishedSurface: surfaceToHookKind(task.surfaceKind),
            outcome: task.status === 'done' ? 'ok' : 'failed',
            completedAt: task.updatedAt,
            ...(task.featureName ? { tags: [task.featureName] } : {}),
          }}
          {...(onChipAction ? { onChoose: (kind: string) => { void onChipAction(task.id, kind); } } : {})}
        />
      )}
      {isIdle && (
        <IdleNudgeBadge
          request={{
            taskId: task.id,
            status: task.status as 'ready' | 'running' | 'review' | 'blocked',
            enteredStatusAt: task.updatedAt,
            observedAt: Date.now(),
            taskTitle: task.title,
          }}
        />
      )}
    </div>
  );
}

/** TaskBoardCard.surfaceKind is free-form on the wire; pass through
 *  when it's one of the canonical TaskSurfaceKind values, null otherwise.
 *  The hook treats `null` as "let the lane decide". */
function surfaceToHookKind(surface: string): null | (
  'terminal-pane' | 'vw-slot' | 'subagent' | 'skill' | 'chat-prompt'
  | 'cron' | 'llm-direct' | 'acx-session' | 'showroom'
) {
  switch (surface) {
    case 'terminal-pane':
    case 'vw-slot':
    case 'subagent':
    case 'skill':
    case 'chat-prompt':
    case 'cron':
    case 'llm-direct':
    case 'acx-session':
    case 'showroom':
      return surface;
    default:
      return null;
  }
}

function DetailBlock({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-sm">{value}</div>
    </div>
  );
}

export function TaskManagerPanel() {
  const { client } = useDaemon();
  const api = useMemo(() => new TaskApi(client), [client]);
  // 미션별 아크 상세(③·2026-07-14) — 미션 그룹 펼침에서 배리어·통합검증 표시.
  const [tasks, setTasks] = useState<TaskBoardCard[]>([]);
  const [summary, setSummary] = useState<{ total: number; open: number; terminal: number; linkedScheduler: number } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{
    task: TaskDetail;
    executions: Array<{ id: string; status: string; startedAt: number; durationMs?: number; output?: string }>;
    events: Array<{ kind: string; timestamp: number }>;
    linkedSchedulerJob?: {
      taskId: string;
      title: string;
      taskMeta?: { dryRun?: boolean; dryRunOutcome?: 'done' | 'failed' };
    } | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [detailBusy, setDetailBusy] = useState(false);
  // 뷰 모드(2026-07-14) — 칸반(status 컬럼) vs 미션별 그룹(미션→아크→페이즈). 대표: 미션을
  // Task Manager 에서도 보이게. 미션 페이즈가 대부분이라 미션 그룹이 실질 조직화 단위.
  const [viewMode, setViewMode] = useState<'kanban' | 'mission'>('mission');

  const refresh = useCallback(async (): Promise<void> => {
    debugLog('webterm.tasks.list.refresh', {});
    setBusy(true);
    try {
      const res = await api.list();
      setTasks(res.tasks);
      setSummary(res.summary);
      // 사용자가 카드를 직접 클릭하기 전엔 자동 선택하지 않는다. 기존 선택이
      // 여전히 유효하면 유지, 사라진 태스크면 해제(자동 첫선택 금지).
      setSelectedId((cur) => (cur && res.tasks.some((t) => t.id === cur) ? cur : null));
    } catch (err) {
      toast.error(`task board failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setBusy(false);
    }
  }, [api]);

  // next-fluent 칩 1-클릭 → 페이즈 액션 dispatch + board refresh(2026-07-15). toast 로 결과 피드백.
  const onChipAction = useCallback(async (refId: string, action: string): Promise<void> => {
    try {
      const r = await createFluentChainApi({ baseUrl: window.location.origin }).dispatch(refId, action);
      if (r.ok) toast.success(`${action} 실행됨`);
      else toast.error(`${action} 실패: ${r.error ?? ''}`);
    } catch (err) {
      toast.error(`${action} 실패: ${err instanceof Error ? err.message : err}`);
    }
    await refresh();
  }, [refresh]);

  useEffect(() => {
    void refresh();
    const handle = window.setInterval(() => void refresh(), 15000);
    return () => window.clearInterval(handle);
  }, [refresh]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailBusy(true);
    void (async () => {
      try {
        const res = await api.detail(selectedId);
        if (cancelled) return;
        setDetail({
          task: res.task,
          executions: res.executions.map((exec) => ({
            id: exec.id,
            status: exec.status,
            startedAt: exec.startedAt,
            durationMs: exec.durationMs,
            output: exec.output,
          })),
          events: res.events,
          linkedSchedulerJob: res.linkedSchedulerJob ?? null,
        });
      } catch (err) {
        if (!cancelled) toast.error(`task detail failed: ${err instanceof Error ? err.message : err}`);
      } finally {
        if (!cancelled) setDetailBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, selectedId]);

  const columns = useMemo(
    () =>
      COLUMN_DEFS.map((column) => ({
        ...column,
        tasks: tasks.filter((task) => column.statuses.some((status) => status === task.status)),
      })),
    [tasks],
  );

  // 미션별 그룹(2026-07-14) — 미션(goalSlug) → 그 페이즈들. 미션이 빌드한 것을 미션 단위로 조직화.
  //   각 그룹: 미션 제목·페이즈 상태 롤업·아크 진행. 미션 없는(독립) 태스크는 마지막 그룹.
  const missionGroups = useMemo(() => groupByMission(tasks), [tasks]);

  return (
    <ChipActionContext.Provider value={onChipAction}>
    <div className="mx-auto max-w-[1600px] space-y-4 p-4">
      <FabricStageHeader active="tasks" />
      <header className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Task Manager</h1>
          <p className="text-sm text-muted-foreground">
            TOX board snapshot for backlog, running work, and closed items.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {summary && (
            <>
              <div className="rounded-lg border border-border bg-card px-3 py-2 text-xs">
                <div className="text-muted-foreground">open</div>
                <div className="text-sm font-semibold">{summary.open}</div>
              </div>
              <div className="rounded-lg border border-border bg-card px-3 py-2 text-xs">
                <div className="text-muted-foreground">closed</div>
                <div className="text-sm font-semibold">{summary.terminal}</div>
              </div>
              <div className="rounded-lg border border-border bg-card px-3 py-2 text-xs">
                <div className="text-muted-foreground">linked schedules</div>
                <div className="text-sm font-semibold">{summary.linkedScheduler}</div>
              </div>
            </>
          )}
          {/* 뷰 토글(2026-07-14) — 미션별 그룹 vs 칸반(status). */}
          <div className="flex rounded-lg border border-border bg-card p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setViewMode('mission')}
              className={`rounded-md px-2.5 py-1 ${viewMode === 'mission' ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:text-foreground'}`}
            >
              🎯 미션별
            </button>
            <button
              type="button"
              onClick={() => setViewMode('kanban')}
              className={`rounded-md px-2.5 py-1 ${viewMode === 'kanban' ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:text-foreground'}`}
            >
              칸반
            </button>
          </div>
          <Button size="sm" variant="outline" onClick={() => void refresh()} disabled={busy}>
            Refresh
          </Button>
        </div>
      </header>

      <div className="flex flex-col gap-4 xl:flex-row xl:items-start">
        <section className="min-w-0 flex-1 space-y-3">
          {viewMode === 'mission' ? (
            /* 미션별 그룹 뷰(2026-07-14) — 미션→아크→페이즈. 미션을 Task Manager 에서 조직화. */
            <div className="space-y-3">
              {missionGroups.length > 0 ? (
                missionGroups.map((group) => (
                  <MissionGroup key={group.key} group={group} selectedId={selectedId} onSelect={setSelectedId} />
                ))
              ) : (
                <div className="rounded-xl border border-dashed border-border px-3 py-12 text-center text-sm text-muted-foreground">
                  미션/태스크 없음
                </div>
              )}
            </div>
          ) : (
          <div className="pb-2">
            {/* 반응형: 고정폭(스크롤) 대신 유동폭 + wrap — 화면이 좁아져도 모든
                컬럼이 잘리지 않고 다 보이게(넓으면 6열 균등·좁으면 여러 줄). */}
            <div className="flex flex-wrap gap-3">
              {columns.map((column) => (
                <div key={column.id} className="min-w-[170px] flex-1 rounded-2xl border border-border bg-muted/30 p-3">
                  <div className="mb-3 flex items-center justify-between">
                    <h2 className="text-sm font-semibold">{column.label}</h2>
                    <span className="rounded-full bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
                      {column.tasks.length}
                    </span>
                  </div>
                  <div className="space-y-2">
                    {column.tasks.length > 0 ? column.tasks.map((task) => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        selected={task.id === selectedId}
                        onClick={() => setSelectedId(task.id)}
                      />
                    )) : (
                      <div className="rounded-xl border border-dashed border-border px-3 py-8 text-center text-xs text-muted-foreground">
                        no tasks
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
          )}
        </section>

        {selectedId && (
        <aside className="w-full shrink-0 space-y-3 rounded-2xl border border-border bg-card p-4 xl:w-[360px]">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold">Detail</h2>
            <div className="flex items-center gap-2">
              {detail?.task && (
                <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                  {detail.task.status}
                </span>
              )}
              <button
                type="button"
                onClick={() => setSelectedId(null)}
                className="rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent/40 hover:text-foreground"
                aria-label="Close detail"
              >
                ✕
              </button>
            </div>
          </div>
          {detailBusy || !detail ? (
            <div className="text-sm text-muted-foreground">Loading task detail…</div>
          ) : (
            <div className="space-y-4">
              {/* 빌드 라이브 로그(2026-07-14) — 선택 태스크가 running 이고 SE 빌드가 있으면. */}
              {(() => {
                const sel = tasks.find((t) => t.id === selectedId);
                return sel?.status === 'running' && sel.build
                  ? <BuildLogViewer api={api} buildId={sel.build.buildId} />
                  : null;
              })()}
              <div>
                <div className="text-lg font-semibold leading-6">{detail.task.title}</div>
                <div className="mt-1 text-xs text-muted-foreground">{detail.task.id}</div>
                {detail.task.description && (
                  <p className="mt-3 whitespace-pre-wrap text-sm text-muted-foreground">{detail.task.description}</p>
                )}
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <DetailBlock label="Surface" value={detail.task.surface.kind} />
                <DetailBlock label="Priority" value={detail.task.priority} />
                <DetailBlock label="Goal" value={detail.task.goalSlug ?? '—'} />
                <DetailBlock label="Feature" value={detail.task.featureName ?? '—'} />
                <DetailBlock label="Depends On" value={detail.task.dependsOn.length > 0 ? detail.task.dependsOn.join(', ') : '—'} />
                <DetailBlock label="Schedule" value={detail.task.schedulerJobId ?? '—'} />
              </div>

              {detail.linkedSchedulerJob && (
                <div className="rounded-xl border border-border bg-muted/40 px-3 py-2 text-sm">
                  linked schedule: {detail.linkedSchedulerJob.title}
                  <span className="ml-2 text-xs text-muted-foreground">{detail.linkedSchedulerJob.taskId}</span>
                  {detail.linkedSchedulerJob.taskMeta?.dryRun && (
                    <span className="ml-2 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] text-emerald-300">
                      dry run{detail.linkedSchedulerJob.taskMeta.dryRunOutcome ? ` · ${detail.linkedSchedulerJob.taskMeta.dryRunOutcome}` : ''}
                    </span>
                  )}
                </div>
              )}

              <div className="space-y-2">
                <div className="text-sm font-semibold">Acceptance</div>
                {detail.task.acceptance?.criteria?.length ? (
                  <ul className="space-y-1 text-sm text-muted-foreground">
                    {detail.task.acceptance.criteria.map((criterion) => (
                      <li key={criterion} className="rounded-lg bg-muted/50 px-3 py-2">{criterion}</li>
                    ))}
                  </ul>
                ) : (
                  <div className="text-sm text-muted-foreground">No acceptance criteria.</div>
                )}
              </div>

              <div className="space-y-2">
                <div className="text-sm font-semibold">Recent Executions</div>
                {detail.executions.length > 0 ? (
                  <div className="space-y-2">
                    {detail.executions.map((exec) => (
                      <div key={exec.id} className="rounded-xl border border-border bg-background p-3">
                        <div className="flex items-center justify-between text-sm">
                          <span className="font-medium">{exec.status}</span>
                          <span className="text-xs text-muted-foreground">{fmtRelative(exec.startedAt)}</span>
                        </div>
                        {exec.durationMs !== undefined && (
                          <div className="mt-1 text-xs text-muted-foreground">duration {Math.round(exec.durationMs / 1000)}s</div>
                        )}
                        {exec.output && (
                          <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-2 text-xs text-muted-foreground">
                            {exec.output.slice(0, 600)}
                          </pre>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-sm text-muted-foreground">No executions recorded yet.</div>
                )}
              </div>

              <div className="space-y-2">
                <div className="text-sm font-semibold">Recent Events</div>
                {detail.events.length > 0 ? (
                  <div className="space-y-1">
                    {detail.events.slice(-8).reverse().map((event, index) => (
                      <div key={`${event.kind}-${event.timestamp}-${index}`} className="flex items-center justify-between rounded-lg bg-muted/50 px-3 py-2 text-xs">
                        <span>{event.kind}</span>
                        <span className="text-muted-foreground">{fmtRelative(event.timestamp)}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-sm text-muted-foreground">No events recorded yet.</div>
                )}
              </div>
            </div>
          )}
        </aside>
        )}
      </div>
    </div>
    </ChipActionContext.Provider>
  );
}
