'use client';

// ── Missions 서브탭 (AL4 · U1d 통합 · 2026-07-09) ─────────────────────────
//
// 대표 지시: 오토파일럿이 만든 잡을 계보로 추적·모니터. U1d(Mission Fabric)에서
// **단일 표면**으로 격상 — 데이터를 /v1/autopilot/missions(apm-only) → **/v1/missions**
// (fabric 전체)로 재배선. 사람 intake 미션 + 자율 미션을 한 목록으로. 자율 미션은
// 실행모델 뱃지·파생 계보(/v1/autopilot/trace?id=apm_…), 사람 미션은 Task 진행 표시.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import {
  AutopilotApi, EXECUTION_MODEL_META, missionSchedulesHref,
  type MissionSummary, type MissionTrace, type DerivedStatus, type DerivedJob, type TriageResult,
} from '@/lib/autopilot-api';
import { missionStaleness } from '@/lib/mission-staleness';

const STATUS_META: Record<DerivedStatus, { icon: string; tone: string; label: string }> = {
  ok: { icon: '✅', tone: 'text-emerald-300', label: '정상' },
  done: { icon: '✅', tone: 'text-emerald-300', label: '완료' },
  stale: { icon: '⏰', tone: 'text-amber-300', label: '밀림' },
  error: { icon: '❌', tone: 'text-rose-400', label: '실패' },
  active: { icon: '🔵', tone: 'text-sky-300', label: '실행중' },
  pending: { icon: '⏳', tone: 'text-muted-foreground', label: '대기' },
};
const KIND_LABEL: Record<DerivedJob['kind'], string> = { cron: '크론', task: '태스크', action: '자율행동' };

/** 사람 intake 미션의 Task 진행(파생 rollup 대신 taskStatusCounts 표시). */
function TaskProgressChips({ counts, total }: { counts?: Record<string, number>; total?: number }) {
  const entries = Object.entries(counts ?? {}).filter(([, n]) => n > 0);
  if (!total || total === 0) return <span className="text-xs text-muted-foreground">태스크 0</span>;
  const done = (counts?.done ?? 0);
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-xs text-muted-foreground">태스크 {done}/{total}</span>
      {entries.map(([s, n]) => (
        <span key={s} className="text-[11px] text-muted-foreground">{s}:{n}</span>
      ))}
    </span>
  );
}

function RollupChips({ r }: { r: MissionSummary['derived'] }) {
  if (!r || r.total === 0) return <span className="text-xs text-muted-foreground">파생 0</span>;
  const chip = (n: number, s: DerivedStatus) =>
    n > 0 ? <span key={s} className={['text-xs', STATUS_META[s].tone].join(' ')}>{STATUS_META[s].icon}{n}</span> : null;
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-xs text-muted-foreground">파생 {r.total}</span>
      {chip(r.ok, 'ok')}{chip(r.stale, 'stale')}{chip(r.error, 'error')}{chip(r.active, 'active')}{chip(r.pending, 'pending')}
    </span>
  );
}

function MaterializeForm({ api, m, onDone }: { api: AutopilotApi; m: MissionSummary; onDone: () => void }) {
  const isScheduler = m.model === 'scheduler';
  const isTask = m.model === 'task';
  const [command, setCommand] = useState('');
  const [cron, setCron] = useState('');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState<null | 'materialize' | 'arm'>(null);
  const [msg, setMsg] = useState<string | null>(null);

  if (!isScheduler && !isTask) {
    return <p className="text-xs text-muted-foreground">이 실행모델({m.model})은 지속 잡을 만들지 않아 구체화 대상이 아닙니다.</p>;
  }
  const run = async (action: 'materialize' | 'arm') => {
    setBusy(action); setMsg(null);
    const spec = isScheduler ? { command: command.trim(), ...(cron.trim() ? { cron: cron.trim() } : {}) } : { ...(prompt.trim() ? { prompt: prompt.trim() } : {}) };
    try {
      const r = await api.missionAction(m.id, action, spec);
      if (r.error) setMsg(`오류: ${r.error}`);
      else { setMsg(action === 'arm' ? '승인·arming ON 시 자동 실행' : `구체화 완료(${r.engine ?? ''})`); onDone(); }
    } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };
  return (
    <div className="mt-3 space-y-2 rounded-md border border-border bg-background/50 p-2.5">
      {isScheduler && (
        <>
          <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="실행할 명령 (예: scripts/foo.ts) — 필수"
            className="w-full rounded border border-border bg-background px-2 py-1 text-xs" />
          <input value={cron} onChange={(e) => setCron(e.target.value)} placeholder="cron (선택 · 비우면 골에서 추론)"
            className="w-full rounded border border-border bg-background px-2 py-1 font-mono text-xs" />
        </>
      )}
      {isTask && (
        <input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="태스크 내용 (선택 · 비우면 골 사용)"
          className="w-full rounded border border-border bg-background px-2 py-1 text-xs" />
      )}
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={!!busy || (isScheduler && !command.trim())} onClick={() => void run('materialize')}>
          {busy === 'materialize' ? '…' : '지금 구체화'}
        </Button>
        <Button size="sm" variant="outline" disabled={!!busy || (isScheduler && !command.trim())} onClick={() => void run('arm')}>
          {busy === 'arm' ? '…' : '승인(arm)'}
        </Button>
        {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
      </div>
    </div>
  );
}

function MissionCard({ api, m }: { api: AutopilotApi; m: MissionSummary }) {
  const isHuman = m.isAutopilot === false;   // 사람 intake 미션(autopilot 메타 없음)
  const [open, setOpen] = useState(false);
  const [trace, setTrace] = useState<MissionTrace | null>(null);
  const [busy, setBusy] = useState(false);
  const meta = m.model ? EXECUTION_MODEL_META[m.model] : null;
  const staleness = missionStaleness(m.updatedAt, Date.now(), { status: m.status });

  const loadTrace = useCallback(async () => {
    setBusy(true);
    try { setTrace(await api.trace(m.id)); } catch { /* fail-soft */ } finally { setBusy(false); }
  }, [api, m.id]);

  const [cancelling, setCancelling] = useState(false);
  const [approving, setApproving] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  // 승인 대기 = autopilot 미션이 proposed(자동 분해됨·실행 전).
  const awaitingApproval = !isHuman && m.status === 'proposed';

  const toggle = useCallback(async () => {
    const next = !open;
    setOpen(next);
    // 사람 미션은 autopilot 계보(trace)가 없다 → Task 카운트만 표시(호출 생략).
    if (next && !trace && !isHuman) await loadTrace();
  }, [open, trace, loadTrace, isHuman]);

  const cancel = useCallback(async () => {
    setCancelling(true); setActionMsg(null);
    try { await api.missionAction(m.id, 'cancel'); await loadTrace(); } catch { /* fail-soft */ } finally { setCancelling(false); }
  }, [api, m.id, loadTrace]);

  const approve = useCallback(async () => {
    setApproving(true); setActionMsg(null);
    try {
      const r = await api.missionAction(m.id, 'approve');
      if (r.error) setActionMsg(`오류: ${r.error}`);
      else setActionMsg(`✅ 승인 — 태스크 ${r.activated ?? 0}건 실행 시작(ready). 미션 running.`);
      await loadTrace();
    } catch (e) { setActionMsg(e instanceof Error ? e.message : String(e)); }
    finally { setApproving(false); }
  }, [api, m.id, loadTrace]);

  return (
    <div className="rounded-lg border border-border bg-card/50">
      <div className="flex items-start">
        <button type="button" onClick={() => void toggle()} className="flex min-w-0 flex-1 items-start gap-3 p-3 text-left">
        <span className="mt-0.5 text-muted-foreground">{open ? '▾' : '▸'}</span>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            {isHuman
              ? <span className="rounded bg-slate-500/15 px-2 py-0.5 text-xs font-medium text-slate-300 ring-1 ring-slate-500/30">사람 · intake</span>
              : meta && <span className={['rounded px-2 py-0.5 text-xs font-medium ring-1', meta.tone].join(' ')}>{meta.label}</span>}
            {!isHuman && m.kind === 'continuous' && <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[11px] text-sky-300 ring-1 ring-sky-500/30">상시</span>}
            {!isHuman && m.kind === 'finite' && <span className="rounded bg-violet-500/15 px-1.5 py-0.5 text-[11px] text-violet-300 ring-1 ring-violet-500/30">유한</span>}
            <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground ring-1 ring-border">{m.source}</span>
            {awaitingApproval
              ? <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium text-amber-300 ring-1 ring-amber-500/40">승인 대기</span>
              : !staleness?.stale && <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground ring-1 ring-border">{m.status}</span>}
            {m.reviewDue && <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-300 ring-1 ring-amber-500/30">⚠ 30일+ 리뷰</span>}
            {isHuman ? <TaskProgressChips counts={m.taskCounts} total={m.taskCount} /> : <RollupChips r={m.derived} />}
            {staleness?.stale && <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium text-amber-300 ring-1 ring-amber-500/30">{staleness.days}일 멈춤 · 마지막 갱신 {staleness.lastUpdated}</span>}
          </div>
          <p className="truncate text-sm text-foreground/90">{m.goal}</p>
          <p className="font-mono text-[10px] text-muted-foreground">{m.id}</p>
        </div>
        </button>
        {staleness?.stale && !isHuman && (
          <Button size="sm" variant="outline" disabled={cancelling} onClick={() => void cancel()}
            className="mr-3 mt-3 shrink-0 border-amber-500/40 text-amber-300 hover:text-amber-200">
            {cancelling ? '종료 중…' : '닫기 제안'}
          </Button>
        )}
      </div>
      {open && isHuman && (
        <div className="border-t border-border px-4 py-3 space-y-2">
          <p className="text-xs text-muted-foreground">
            사람이 Intake 로 만든 미션입니다. 실행은 Task 보드에서 진행됩니다.
          </p>
          <TaskProgressChips counts={m.taskCounts} total={m.taskCount} />
          <Link href="/tasks" className="inline-block text-xs text-primary hover:underline">② 작업 보드에서 보기 →</Link>
        </div>
      )}
      {open && !isHuman && (
        <div className="border-t border-border px-4 py-3">
          {awaitingApproval && (
            <div className="mb-3 space-y-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
              <p className="text-sm font-medium text-amber-200">자동 분해 완료 · 승인 대기</p>
              <p className="text-xs text-muted-foreground">
                골을 태스크로 자동 구체화했습니다(아직 <b>실행 안 함</b>). 승인하면 실행이 시작됩니다.
                {m.model === 'scheduler' && ' 반복 스케줄은 승인 후 배선됩니다.'}
              </p>
              <div className="flex items-center gap-2">
                <Button size="sm" disabled={approving || cancelling} onClick={() => void approve()}>
                  {approving ? '승인 중…' : '✅ 승인(실행 시작)'}
                </Button>
                <Button size="sm" variant="ghost" disabled={approving || cancelling} onClick={() => void cancel()}
                  className="text-rose-400 hover:text-rose-300">
                  {cancelling ? '거절 중…' : '거절'}
                </Button>
                {actionMsg && <span className="text-xs text-muted-foreground">{actionMsg}</span>}
              </div>
            </div>
          )}
          {busy && <p className="text-xs text-muted-foreground">계보 조회 중…</p>}
          {trace && trace.derived.length === 0 && (
            <p className="text-xs text-muted-foreground">{trace.note}</p>
          )}
          {trace && missionSchedulesHref(trace.derived) && (
            <Link href={missionSchedulesHref(trace.derived) as never} className="mb-2 inline-block text-xs text-primary hover:underline" data-mission-schedules>
              이 미션을 부르는 스케줄 {trace.derived.filter((d) => d.kind === 'cron' && d.id).length} →
            </Link>
          )}
          {trace && trace.derived.length > 0 && (
            <ul className="space-y-1.5">
              {trace.derived.map((d, i) => {
                const s = STATUS_META[d.status];
                return (
                  <li key={i} className="flex items-start gap-2 text-sm">
                    <span className={s.tone}>{s.icon}</span>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground ring-1 ring-border">{KIND_LABEL[d.kind]}</span>
                    <span className="min-w-0 flex-1">
                      <span className="text-foreground/90">{d.name}</span>
                      {d.detail && <span className="ml-2 text-xs text-muted-foreground">{d.detail}</span>}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {trace && m.status !== 'done' && m.status !== 'proposed' && (
            <div className="mt-2 flex items-center gap-2">
              <Button size="sm" variant="ghost" disabled={cancelling} onClick={() => void cancel()}
                className="text-rose-400 hover:text-rose-300">
                {cancelling ? '종료 중…' : '미션 종료(파생 잡 release)'}
              </Button>
              {m.kind === 'continuous' && <span className="text-[11px] text-muted-foreground">상시 미션 — 종료 전까지 계속 실행</span>}
            </div>
          )}
          {trace && !awaitingApproval && <MaterializeForm api={api} m={m} onDone={() => void loadTrace()} />}
        </div>
      )}
    </div>
  );
}

/** 인라인 골 컴포저(F2 · 겹침 해소) — 구 최상위 "Triage" 탭을 흡수. "골 던지면
 *  자율 미션화" 를 자기가 만드는 미션 목록 바로 위에 co-locate. intake(리뷰 우선
 *  포착)와 구분되는 "즉시 자율 미션" 경로. */
function QuickGoalComposer({ api, onCommitted }: { api: AutopilotApi; onCommitted: () => void }) {
  const [goal, setGoal] = useState('');
  const [result, setResult] = useState<TriageResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = useCallback(async () => {
    const g = goal.trim();
    if (!g) return;
    setBusy(true); setErr(null);
    try { setResult((await api.triagePreview(g)).triage); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }, [api, goal]);

  const commit = useCallback(async () => {
    const g = goal.trim();
    if (!g) return;
    setCommitting(true); setErr(null);
    try {
      const r = await api.commitMission(g, 'intake');
      if (r.missionId) { setGoal(''); setResult(null); onCommitted(); }
      else setErr('미션 생성 실패');
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setCommitting(false); }
  }, [api, goal, onCommitted]);

  const meta = result ? EXECUTION_MODEL_META[result.executionModel] : null;
  return (
    <div className="space-y-2 rounded-lg border border-border bg-card/40 p-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">골 던지기 <span className="text-xs font-normal text-muted-foreground">— 소망을 말하면 미션이 됩니다</span></span>
        <span className="text-[11px] text-muted-foreground">텔레그램에선 &ldquo;미션:&rdquo; 마커로</span>
      </div>
      <textarea
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void run(); }}
        placeholder="예: 삼성전자 급락하면 매매 검토 / 이 주제 끝까지 파봐 / 매일 아침 반도체 뉴스 정리"
        className="min-h-[60px] w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => void run()} disabled={busy || !goal.trim()} size="sm" variant="outline">
          {busy ? '분류 중…' : 'Triage (⌘↵)'}
        </Button>
        <Button onClick={() => void commit()} disabled={committing || !goal.trim()} size="sm">
          {committing ? '커밋 중…' : '미션 커밋 →'}
        </Button>
        {result && meta && (
          <span className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className={['rounded px-2 py-0.5 ring-1', meta.tone].join(' ')}>{meta.label}</span>
            <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground ring-1 ring-border">{result.tier === 'heavy' ? '무거움' : '가벼움'}</span>
            <span className="text-muted-foreground">{result.rationale}</span>
          </span>
        )}
        {err && <span className="text-xs text-rose-400">{err}</span>}
      </div>
    </div>
  );
}

export function AutopilotMissions({ api }: { api: AutopilotApi }) {
  const [missions, setMissions] = useState<MissionSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.missionsUnified();
      // 최신순(createdAt DESC) — 사람·자율 혼합 목록 정렬.
      const sorted = [...r.missions].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      setMissions(sorted);
    }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  const autopilotCount = missions?.filter((m) => m.isAutopilot).length ?? 0;
  const humanCount = (missions?.length ?? 0) - autopilotCount;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          모든 미션(사람 intake + 자율)의 계보·실행 상태.
          {missions && <span className="ml-1 text-[11px]">자율 {autopilotCount} · 사람 {humanCount}</span>}
        </p>
        <Button onClick={() => void load()} disabled={busy} size="sm" variant="outline">{busy ? '…' : '새로고침'}</Button>
      </div>
      <QuickGoalComposer api={api} onCommitted={() => void load()} />
      {err && <p className="text-xs text-rose-400">{err}</p>}
      {missions && missions.length === 0 && (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          아직 미션이 없습니다. 위 &ldquo;골 던지기&rdquo;로 자율 미션을 만들거나, Intake 에서 메모를 포착하세요.
        </p>
      )}
      {missions && missions.length > 0 && (
        <div className="space-y-2">
          {missions.map((m) => <MissionCard key={m.id} api={api} m={m} />)}
        </div>
      )}
    </div>
  );
}
