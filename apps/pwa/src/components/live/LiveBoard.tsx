'use client';

// Live 탭 판 — 진짜 신호만 그린다(props 만 · 시험이 몰 수 있다).
// 기획 §0b(v3 요소표) · §0c(v4 두 모드): `practical`(기본 · 표·막대 · 애니메이션 없음) / `max`(화려함 MAX).

import { clockTime, DECISION_KINDS, foldForRole, isRawErrorText, LIVE_STAGES, LIVE_STAGE_LABEL, type DecisionKind, type LiveBoardData, type LiveRun } from '@/lib/live-signals';
import type { PwaRole } from '@/lib/pwa-role';
import { cn } from '@/lib/utils';

export type LiveMode = 'practical' | 'max';

const KIND_STYLE: Record<DecisionKind, string> = {
  PLAN: 'text-sky-600 dark:text-sky-400',
  ROUTE: 'text-violet-600 dark:text-violet-400',
  VERIFY: 'text-amber-600 dark:text-amber-400',
  HEAL: 'text-emerald-600 dark:text-emerald-400',
  ESCALATE: 'text-rose-600 dark:text-rose-400',
  SHIP: 'text-green-700 dark:text-green-400 font-semibold',
};

export interface LiveBoardProps {
  board: LiveBoardData;
  lines: string[];
  mode: LiveMode;
  onSelectRun?: (runId: string) => void;
  selectedRunId?: string | null;
  /** 없으면 오너 — 기존 시험·디버깅 화면은 바이트까지 같다. */
  role?: PwaRole;
}

export function LiveBoard({ board, lines, mode, onSelectRun, selectedRunId, role = 'owner' }: LiveBoardProps) {
  const max = mode === 'max';
  const owner = role === 'owner';
  const g = board.gauges;
  const { snapshot } = board;
  const foldedErrors = owner ? 0 : board.stream.filter((s) => s.why != null && isRawErrorText(s.why)).length;
  return (
    <div className={cn('space-y-4', max && 'live-max')} data-live-mode={mode}>
      {/* ③ 계기판 */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Gauge label="LIVE" hint="도는 런" value={String(g.live)} tone={g.live > 0 ? 'live' : 'idle'} max={max} />
        <Gauge label="DECISIONS/MIN" hint={`판단 ${g.decisions}건`} value={String(g.decisionsPerMin)} max={max} />
        <Gauge label="SHIPPED" hint="병합·PR" value={String(g.shipped)} tone="ok" max={max} />
        <Gauge label="SELF-HEAL" hint={g.selfHealRuns ? `수리 런 ${g.selfHealRuns}` : '수리 런 없음'} value={g.selfHealRate === null ? '—' : `${g.selfHealRate}%`} max={max} />
        <Gauge label="BURN" hint="토큰/분" value={compact(g.burnTokensPerMin)} max={max} />
        <Gauge label="BLOCKED" hint="막힌 런" value={String(snapshot.counters.blocked)} tone={snapshot.counters.blocked ? 'bad' : 'idle'} max={max} />
      </div>

      {/* ① 런 페이즈 막대 ⊕ 라운드 */}
      <section className="space-y-2" aria-label="런">
        <h2 className="text-sm font-medium">런 <span className="text-xs text-muted-foreground">최근 {snapshot.windowMinutes}분 · {snapshot.runs.length}</span></h2>
        {snapshot.runs.length === 0 ? (
          <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground" data-live-empty>
            지금 이 창에 런 신호가 없습니다 — 텔레그램이나 Intake 로 한 줄 보내면 여기에 런이 뜹니다.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {snapshot.runs.slice(0, 12).map((run) => (
              <RunBar key={run.runId} run={run} round={board.rounds[run.runId]} max={max} selected={run.runId === selectedRunId} onSelect={onSelectRun} owner={owner} />
            ))}
          </ul>
        )}
      </section>

      <div className="grid gap-4 lg:grid-cols-5">
        {/* ④ 판단 스트림 */}
        <section className="space-y-2 lg:col-span-3" aria-label="판단 스트림">
          <h2 className="flex flex-wrap items-center gap-2 text-sm font-medium">
            판단 스트림
            {DECISION_KINDS.map((k) => <span key={k} className={cn('text-[11px] lg:text-[10px] font-mono', KIND_STYLE[k])}>{k}</span>)}
          </h2>
          {board.stream.length === 0 ? (
            <p className="text-xs text-muted-foreground">이 창에 판단 신호가 없습니다.</p>
          ) : (
            <ul className="max-h-80 space-y-1 overflow-auto rounded-md border p-2 font-mono text-[11px]" data-live-stream>
              {board.stream.slice(0, 40).map((s, i) => (
                <li key={`${s.ts}-${i}`} className={cn('leading-relaxed', max && i === 0 && 'live-line-in', max && s.kind === 'SHIP' && 'live-ship')}>
                  <span className="text-muted-foreground"><span title={s.ts}>{clockTime(s.ts)}</span> </span>
                  <span className={KIND_STYLE[s.kind]}>[{s.kind}]</span> {owner ? s.what : foldForRole(s.what.replace(/run-[0-9a-f]{8}-[^\s]*/gi, ''), role)}
                  {s.why && <span className="text-muted-foreground"> · 왜: {foldForRole(s.why, role)}</span>}
                  {s.purpose && <span className="text-muted-foreground"> · 목적: {s.purpose}</span>}
                  {s.target && <span className="text-muted-foreground"> → {s.target}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ⑥ 모델 성적표 ⊕ ⑤ 수렴(라운드) */}
        <section className="space-y-2 lg:col-span-2" aria-label="성적표">
          <h2 className="text-sm font-medium">모델 성적표</h2>
          {board.scorecard.length === 0 ? <p className="text-xs text-muted-foreground">이 창에 모델 요청이 없습니다.</p> : (
            <table className="w-full text-[11px]">
              <thead><tr className="text-muted-foreground"><th className="text-left font-normal">모델</th><th className="text-right font-normal">요청</th><th className="text-right font-normal">토큰</th><th className="text-right font-normal">과금</th></tr></thead>
              <tbody>
                {board.scorecard.slice(0, 8).map((m) => (
                  <tr key={m.model}><td className="truncate">{m.model}</td><td className="text-right tabular-nums">{m.requests}</td><td className="text-right tabular-nums">{compact(m.tokens)}</td><td className="text-right text-muted-foreground">{m.billing ?? '—'}</td></tr>
                ))}
              </tbody>
            </table>
          )}
          <h2 className="pt-2 text-sm font-medium">리뷰 판정</h2>
          <Bars items={snapshot.reviewVerdicts} max={max} />
        </section>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {owner ? (
        <section className="space-y-2" aria-label="흐르는 로그">
          <h2 className="text-sm font-medium">흐르는 로그</h2>
          <pre className="max-h-60 overflow-auto rounded-md border bg-muted/30 p-2 text-[11px] leading-relaxed" data-live-log>
            {lines.slice(0, 60).join('\n') || '—'}
          </pre>
        </section>
        ) : foldedErrors > 0 ? (
          <p className="text-xs text-muted-foreground" data-live-folded-errors>오류 {foldedErrors}건 접힘</p>
        ) : null}
        {/* 빈 칸 표 — 판단에 «왜·목적·보낸 곳»이 없는 자리(🅢·🅣 가 계측을 심는다) */}
        <section className="space-y-2" aria-label="빈 칸 표">
          <h2 className="text-sm font-medium">빈 칸 표 <span className="text-xs text-muted-foreground">판단 로그에 없는 칸</span></h2>
          {board.missing.length === 0 ? <p className="text-xs text-muted-foreground">빈 칸 없음.</p> : (
            <table className="w-full text-[11px]" data-live-missing>
              <tbody>
                {board.missing.slice(0, 10).map((m) => (
                  <tr key={m.key}><td className="font-mono">{m.key}</td><td className="text-right tabular-nums">{m.count}</td><td className="pl-2 text-muted-foreground">{m.lacks.join(' · ')}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}

function compact(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n);
}

function Gauge({ label, hint, value, tone = 'idle', max }: { label: string; hint: string; value: string; tone?: 'idle' | 'live' | 'ok' | 'bad'; max: boolean }) {
  return (
    <div className={cn('rounded-lg border p-3', tone === 'live' && 'border-primary/50', tone === 'bad' && 'border-error/50', tone === 'ok' && 'border-green-600/40', max && 'live-gauge', max && tone === 'live' && 'live-glow')}>
      <div className="font-mono text-[11px] lg:text-[10px] tracking-wider text-muted-foreground">{label}</div>
      <div className={cn('text-2xl font-semibold tabular-nums', max && 'live-count')} data-live-gauge={label}>{value}</div>
      <div className="text-[11px] lg:text-[10px] text-muted-foreground">{hint}</div>
    </div>
  );
}

function RunBar({ run, round, max, selected, onSelect, owner }: { run: LiveRun; round?: number; max: boolean; selected: boolean; onSelect?: (runId: string) => void; owner: boolean }) {
  return (
    <li>
      <button
        type="button"
        data-live-run={run.runId}
        onClick={() => onSelect?.(run.runId)}
        className={cn('flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left text-xs hover:bg-muted/40', selected && 'ring-1 ring-primary')}
      >
        <span className="w-24 shrink-0 truncate font-mono text-[11px] text-muted-foreground">{owner ? run.runId.replace(/^run-/, '').slice(0, 8) : '런'}</span>
        <span className="flex flex-1 gap-1" aria-label="단계">
          {LIVE_STAGES.map((stage) => {
            const tone = run.stages[stage];
            const current = run.current === stage;
            return (
              <span
                key={stage}
                title={`${LIVE_STAGE_LABEL[stage]} · ${tone ?? '신호 없음'}`}
                data-stage={stage}
                data-tone={tone ?? 'none'}
                className={cn(
                  'h-2 flex-1 rounded-full bg-muted',
                  tone === 'info' && 'bg-primary/60',
                  tone === 'ok' && 'bg-green-600',
                  tone === 'bad' && 'bg-error',
                  max && current && tone !== 'bad' && 'live-pulse',
                  max && current && tone === 'bad' && 'live-pulse-bad',
                )}
              />
            );
          })}
        </span>
        <span className="w-14 shrink-0 text-right font-mono text-[11px] lg:text-[10px] text-muted-foreground">{round ? `R ${round}/3` : ''}</span>
        <span className="w-24 shrink-0 text-right text-[11px]">
          {run.blocked ? <span className="text-error">막힘</span> : run.stages.land === 'ok' ? <span className="text-green-700">착지{run.pr ? ` #${run.pr}` : ''}</span> : run.current ? LIVE_STAGE_LABEL[run.current] : ''}
        </span>
      </button>
    </li>
  );
}

function Bars({ items, max }: { items: Array<{ name: string; count: number }>; max: boolean }) {
  const top = Math.max(1, ...items.map((i) => i.count));
  if (items.length === 0) return <div className="text-[11px] text-muted-foreground">—</div>;
  return (
    <ul className="space-y-1">
      {items.slice(0, 6).map((item) => (
        <li key={item.name} className="flex items-center gap-2 text-[11px]">
          <span className="w-24 shrink-0 truncate">{item.name}</span>
          <span className="h-1.5 flex-1 rounded-full bg-muted">
            <span className={cn('block h-1.5 rounded-full bg-primary/70', max && 'transition-[width] duration-700')} style={{ width: `${(item.count / top) * 100}%` }} />
          </span>
          <span className="w-8 text-right tabular-nums">{item.count}</span>
        </li>
      ))}
    </ul>
  );
}
