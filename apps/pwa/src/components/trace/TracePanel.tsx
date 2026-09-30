'use client';

// «Trace» 탭 — 따라가는 작업대(RFC v6 §1 ①). Live(v5 무대)와 «데이터 층만» 공유한다 — 같은 연합 조회(`@active`) · 같은 원장.
// T2(🅕): 해상도 L0 플릿 → L1 런 → L2 런 한 개 · 렌즈 = 필터의 누적(빵부스러기로 하나씩 뺀다) · 칩마다 개수(facet) ·
// d3 그래프(클릭 선택 · 더블클릭 한 층 내려가기 · 휠 줌 · 끌어 고정) · URL 상태(링크 하나로 같은 화면) · 키보드(`/` 검색 · `Esc` 위로 · `[` `]` 층).
// L3 판단·L4 증거 패널·시간 브러시는 T3 — 🅣 `GET /v1/trace` 가 서면 원천만 바꾼다.

import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Crosshair } from 'lucide-react';
import { useNexusClient, useOptionalNexusClient } from '@/nexus/hooks/use-nexus-context';
import { useQuery } from '@tanstack/react-query';
import { useLiveSignals } from '@/nexus/hooks/use-live-signals';
import type { LogRow } from '@/nexus/client';
import { clockTime, LIVE_STAGE_LABEL, type DecisionLine } from '@/lib/live-signals';
import {
  buildTraceModel, crumbs, decisionEvidence, lensRows, drillDown, drillUp, facets, lensFromSearch, lensRuns, lensToSearch, repeatedFindings, runDecisions, serverDecisionChain, mergeServerRuns, runGantt, runSignals, traceGraph,
  TRACE_LEVELS, type TraceLens, type TraceRunStatus,
} from '@/lib/trace-model';
import { TraceGraph } from './TraceGraph';
import { RunTimeline, StageGantt } from './TraceTimeline';
import { ResearchFan } from './ResearchFan';
import { ResearchStage } from './ResearchStage';
import { LiveMaxStage } from '@/components/live/LiveMaxStage';
import { buildLiveBoard } from '@/lib/live-signals';
import { researchSessions } from '@/lib/research-fan';
import { accountNames, maskRowsForPublic, maskValueForPublic } from '@/lib/live-public';

/** 공개 캡처면 가릴 계정 이름(창 줄에서 모은 것) · 아니면 null. 서버에서 오는 판단 사슬·원문을 같은 별칭으로 가린다. */
const PublicMask = createContext<readonly string[] | null>(null);
import { RunDrawer } from '@/components/live/RunDrawer';
import { cn } from '@/lib/utils';

const NO_ROWS: LogRow[] = [];
const WINDOWS = [60, 360, 1440] as const;
const LEVEL_LABEL = { L0: 'L0 플릿', L1: 'L1 런', L2: 'L2 런 한 개', L3: 'L3 판단' } as const;
const STATUS_LABEL: Record<TraceRunStatus, string> = { running: '도는', landed: '착지', blocked: '막힘', quiet: '끊김·결과 모름' };
const KIND_TEXT: Record<string, string> = { PLAN: 'text-sky-400', ROUTE: 'text-violet-400', VERIFY: 'text-amber-400', HEAL: 'text-emerald-400', ESCALATE: 'text-rose-400', SHIP: 'text-green-400' };

export function TracePanel() {
  const client = useOptionalNexusClient();
  if (!client) {
    return (
      <div className="mx-auto max-w-2xl space-y-2 p-6">
        <h1 className="text-xl font-semibold tracking-tight">Trace</h1>
        <p className="text-sm text-muted-foreground">Connect to a NEXUS daemon to trace runs.</p>
      </div>
    );
  }
  return <TracePanelInner />;
}

function TracePanelInner() {
  const [lens, setLens] = useState<TraceLens>({ level: 'L1', windowMin: 1440 });
  const [selected, setSelected] = useState<string | null>(null);
  const [store, setStore] = useState('@active');
  // «발표» — 녹화용 전체 무대 둘(🅢): `stage` = v5 무대 문법(LiveMaxStage 공유 · 렌즈에 남은 런만) · `research` = 조사 장면.
  // 주소 `?present=stage|research` 로도. v5 교체 조건 ①(«발표» 1920 이 v5 옆에서 밀도 같거나 높음)을 재는 판이다.
  const [present, setPresent] = useState<'stage' | 'research' | null>(null);
  const [pair, setPair] = useState(false);
  useEffect(() => { const p = new URLSearchParams(window.location.search).get('present'); if (p === 'stage' || p === 'research') setPresent(p); }, []);
  const searchRef = useRef<HTMLInputElement | null>(null);
  // URL ↔ 렌즈 — 마운트 뒤에 읽고(정적 export · #418), 바뀔 때마다 주소에 쓴다(링크 공유).
  const hydrated = useRef(false);
  useEffect(() => { setLens(lensFromSearch(window.location.search)); hydrated.current = true; }, []);
  useEffect(() => {
    if (!hydrated.current) return;
    // 렌즈가 주소를 다시 쓸 때 `capture`·`present` 는 지키지 않으면 새로고침에서 가림이 풀린다(녹화 중 새로고침).
    const keep = new URLSearchParams(window.location.search);
    const next = new URLSearchParams(lensToSearch(lens).replace(/^\?/, ''));
    for (const k of ['capture', 'present']) { const v = keep.get(k); if (v) next.set(k, v); }
    const q = next.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${q ? `?${q}` : ''}`);
  }, [lens]);

  const { logs, runs } = useLiveSignals({ store, windowMinutes: lens.windowMin });
  // «공개 캡처»(`?capture=public` · 🅢 09-28) — Live 와 같은 가림을 Trace 에도. 녹화(T2·T3) 전에 켠다.
  //   창 줄은 그리기 «전»에 가리고, 서버에서 오는 판단 사슬·L4 원문은 같은 계정 별칭으로 가린다(PublicMask 컨텍스트).
  const [publicCapture, setPublicCapture] = useState(false);
  useEffect(() => { if (new URLSearchParams(window.location.search).get('capture') === 'public') setPublicCapture(true); }, []);
  const rawRows = logs.data?.logs ?? NO_ROWS;
  const publicNames = useMemo(() => (publicCapture ? accountNames(rawRows) : null), [publicCapture, rawRows]);
  const rows = useMemo(() => (publicCapture ? maskRowsForPublic(rawRows) : rawRows), [publicCapture, rawRows]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { setNow(Date.now()); }, [logs.dataUpdatedAt]);
  // L1 런 목록 — 🅣 `/v1/trace?level=L1`(#21624 런 집계 · 행 상한과 무관)로 창 조회가 놓친 런을 채운다(실측: 창 8 ↔ 서버 70).
  const traceClient = useOptionalNexusClient();
  const serverRuns = useQuery({
    queryKey: ['trace', 'L1', store, lens.windowMin],
    queryFn: () => traceClient!.getTrace({ level: 'L1', from: Date.now() - lens.windowMin * 60_000, ...(store ? { store } : {}) }),
    enabled: Boolean(traceClient),
    refetchInterval: 60_000,
    retry: false,
  });
  const model = useMemo(() => mergeServerRuns(
    buildTraceModel(rows, runs.data?.entries ?? [], { now, windowMinutes: lens.windowMin }),
    serverRuns.data?.ok ? serverRuns.data : undefined, runs.data?.entries ?? [], now,
  ), [rows, runs.data, now, lens.windowMin, serverRuns.data]);
  const graph = useMemo(() => traceGraph(model, lens), [model, lens]);
  const list = useMemo(() => lensRuns(model, lens).sort((a, b) => (a.lastTs < b.lastTs ? 1 : -1)), [model, lens]);
  const counts = useMemo(() => facets(model, lens), [model, lens]);
  const repeated = useMemo(() => repeatedFindings(model).slice(0, 6), [model]);
  const run = lens.runId ? model.runs.find((r) => r.runId === lens.runId) ?? null : null;
  // 조사 장면 — 렌즈에 런이 있으면 그 런의 조사만.
  const allResearch = useMemo(() => researchSessions(rows).filter((s) => !lens.runId || s.runId === lens.runId), [rows, lens.runId]);
  const research = allResearch.slice(0, 2);
  const presentRef = useRef(false);
  presentRef.current = present !== null;

  // 키보드 — `/` 검색 · `Esc` 한 층 위 · `[` `]` 층.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) { if (e.key === 'Escape') t.blur(); return; }
      if (e.key === '/') { e.preventDefault(); searchRef.current?.focus(); }
      else if (e.key === 'Escape' && presentRef.current) { setPresent(null); }
      else if (e.key === 'Escape') { setSelected(null); setLens((l) => drillUp(l)); }
      else if (e.key === '[') setLens((l) => (l.level === 'L3' || l.level === 'L2' ? drillUp(l) : l.level === 'L1' ? { ...l, level: 'L0' } : l));
      // L3 — 판단 사슬 앞뒤(RFC §4 «←→ 판단 사슬 이동»).
      else if (e.key === 'ArrowLeft') setLens((l) => (l.level === 'L3' && (l.decision ?? 0) > 0 ? { ...l, decision: (l.decision ?? 0) - 1 } : l));
      else if (e.key === 'ArrowRight') setLens((l) => (l.level === 'L3' ? { ...l, decision: (l.decision ?? 0) + 1 } : l));
      else if (e.key === ']') setLens((l) => (l.level === 'L0' ? { ...l, level: 'L1' } : l));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const removeCrumb = (key: 'universe' | 'runId' | 'status' | 'q' | 'time' | 'finding') => setLens((l) => {
    const next = { ...l };
    if (key === 'time') { delete next.from; delete next.to; return next; }
    delete next[key];
    if (key === 'runId' && next.level === 'L2') next.level = 'L1';
    return next;
  });

  return (
    <PublicMask.Provider value={publicNames}>
    <div className="mx-auto max-w-none space-y-3 p-3 text-slate-100 sm:p-4" data-trace-panel>
      {present === 'research' && <ResearchStage sessions={allResearch} pair={pair} onPair={setPair} onClose={() => setPresent(null)} />}
      {present === 'stage' && (
        <div className="fixed inset-0 z-50 overflow-auto bg-[#020617] p-2" data-trace-present-stage>
          <div className="mb-1 flex items-center gap-2 px-1 font-mono text-[11px] text-slate-400">
            <span>TRACE · 발표</span>
            <span className="truncate text-indigo-200">{crumbs(lens).map((c) => c.label).join(' › ') || '전체'}</span>
            <button type="button" onClick={() => setPresent(null)} className="ml-auto rounded-full border border-slate-600 px-3 py-0.5 text-slate-300 hover:bg-slate-800">닫기(Esc)</button>
          </div>
          <PresentStage model={model} lens={lens} ledger={runs.data?.entries ?? []} now={now} store={store} publicCapture={publicCapture} />
        </div>
      )}
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="mr-2 flex items-center gap-2 text-xl font-semibold tracking-tight text-foreground"><Crosshair className="h-5 w-5" aria-hidden /> Trace</h1>
        <nav className="flex gap-1" aria-label="해상도">
          {TRACE_LEVELS.map((lv) => (
            <button key={lv} type="button" onClick={() => setLens((l) => ({ ...l, level: lv }))} disabled={(lv === 'L2' && !lens.runId) || (lv === 'L3' && lens.decision === undefined)}
              aria-pressed={lens.level === lv} className={cn('rounded-md border px-2 py-1 font-mono text-xs disabled:opacity-40', lens.level === lv ? 'border-primary bg-primary/15 text-foreground' : 'text-muted-foreground hover:bg-muted')}
              data-trace-level={lv}>{LEVEL_LABEL[lv]}</button>
          ))}
        </nav>
        <input ref={searchRef} value={lens.q ?? ''} onChange={(e) => setLens((l) => ({ ...l, q: e.target.value || undefined }))} placeholder="/ 검색 — runId · PR · 우주"
          className="w-56 rounded-md border bg-background px-2 py-1 text-xs text-foreground" aria-label="검색" />
        <select aria-label="시간 창" value={lens.windowMin} onChange={(e) => setLens((l) => ({ ...l, windowMin: Number(e.target.value) }))} className="rounded-md border bg-background px-2 py-1 text-xs text-foreground">
          {WINDOWS.map((w) => <option key={w} value={w}>{w < 60 ? `${w}분` : `${w / 60}시간`}</option>)}
        </select>
        <select aria-label="신호 출처" value={store} onChange={(e) => setStore(e.target.value)} className="rounded-md border bg-background px-2 py-1 text-xs text-foreground">
          <option value="@active">전체(연합)</option>
          <option value="">이 인스턴스</option>
        </select>
        <button type="button" onClick={() => setPresent('stage')}
          className="ml-auto rounded-md border border-indigo-400/50 px-2 py-1 text-xs text-indigo-200 hover:bg-indigo-500/10" data-elanous-action="trace-present-stage"
          title="렌즈에 남은 런을 v5 무대 문법으로(녹화용 · Esc 로 닫기)">
          ✦ 발표 · 무대
        </button>
        <button type="button" onClick={() => setPresent('research')} disabled={research.length === 0}
          className="rounded-md border border-fuchsia-400/50 px-2 py-1 text-xs text-fuchsia-200 hover:bg-fuchsia-500/10 disabled:opacity-40" data-elanous-action="trace-present"
          title={research.length ? '조사 장면을 전체 무대로(녹화용)' : '이 렌즈에 조사가 없다'}>
          ✦ 발표 · 조사
        </button>
        <Link href="/live" className="rounded-md border px-2 py-1 text-xs text-muted-foreground hover:bg-muted">무대로(Live) →</Link>
      </header>

      {/* 렌즈 빵부스러기 — 칸마다 ✕ 로 하나씩 뺀다 */}
      <div className="flex flex-wrap items-center gap-1 font-mono text-[11px]" aria-label="렌즈" data-trace-crumbs>
        <span className="text-muted-foreground">렌즈 ›</span>
        {crumbs(lens).length === 0 && <span className="text-muted-foreground">전체</span>}
        {crumbs(lens).map((c) => (
          <button key={c.key} type="button" onClick={() => removeCrumb(c.key)} className="rounded-full border border-indigo-400/40 bg-indigo-500/10 px-2 py-0.5 text-indigo-200 hover:bg-indigo-500/20" data-trace-crumb={c.key}>
            {c.label} ✕
          </button>
        ))}
        <span className="ml-2 text-muted-foreground">신호 {rows.length} · 런 {model.runs.length} · 우주 {model.universes.length}{logs.stores.length > 0 ? ` · 저장소 ${logs.stores.length}${logs.registeredStores ? `/${logs.registeredStores}` : ''}${logs.failedStores.length ? ` (${logs.failedStores.length} 못 읽음)` : ''}` : ''}{logs.truncated ? ' · ⚠ 조회 상한에 닿음' : ''}</span>
      </div>

      {/* 필터 칩 — 누르면 렌즈에 쌓인다 · 개수 = 그 칩을 누르면 남는 런 */}
      <div className="flex flex-wrap gap-1 text-[11px]" data-trace-chips>
        {(Object.keys(STATUS_LABEL) as TraceRunStatus[]).map((s) => (
          <button key={s} type="button" onClick={() => setLens((l) => ({ ...l, status: l.status === s ? undefined : s }))} aria-pressed={lens.status === s}
            className={cn('rounded-full border px-2 py-0.5', lens.status === s ? 'border-primary bg-primary/15 text-foreground' : 'text-muted-foreground hover:bg-muted')} data-trace-chip={`status:${s}`}>
            {STATUS_LABEL[s]} <span className="tabular-nums">{counts.status[s]}</span>
          </button>
        ))}
        <span className="mx-1 text-muted-foreground">·</span>
        {Object.entries(counts.universe).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([u, n]) => (
          <button key={u} type="button" onClick={() => setLens((l) => ({ ...l, universe: l.universe === u ? undefined : u }))} aria-pressed={lens.universe === u}
            className={cn('rounded-full border px-2 py-0.5 font-mono', lens.universe === u ? 'border-cyan-400 bg-cyan-500/15 text-foreground' : 'text-muted-foreground hover:bg-muted')} data-trace-chip={`universe:${u}`}>
            {u} <span className="tabular-nums">{n}</span>
          </button>
        ))}
      </div>

      {/* «같은 지적»(RFC §7 · T4) — 둘 이상의 런에서 나온 리뷰 지적. 누르면 그 지적이 나온 런만. */}
      {repeated.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 text-[11px]" data-trace-findings>
          <span className="text-muted-foreground">같은 지적 ›</span>
          {repeated.map((f) => (
            <button key={f.sig} type="button" onClick={() => setLens((l) => ({ ...l, finding: l.finding === f.sig ? undefined : f.sig }))} aria-pressed={lens.finding === f.sig}
              className={cn('max-w-[28rem] truncate rounded-full border px-2 py-0.5', lens.finding === f.sig ? 'border-amber-400 bg-amber-500/15 text-foreground' : 'text-muted-foreground hover:bg-muted')} title={f.sig} data-trace-finding>
              {f.sig} <span className="tabular-nums">· 런 {f.runs}</span>
            </button>
          ))}
        </div>
      )}

      <div className="grid gap-3 xl:grid-cols-12">
        <section className="xl:col-span-8" aria-label="그래프">
          <TraceGraph
            nodes={graph.nodes}
            edges={graph.edges}
            selected={lens.level === 'L3' && lens.decision !== undefined ? `d:${lens.decision}` : selected}
            onSelect={setSelected}
            onDrill={(node) => { setSelected(null); setLens((l) => drillDown(l, node)); }}
          />
          <div className="mt-2">
            {lens.level === 'L0' || lens.level === 'L1' ? (
              <RunTimeline
                runs={lensRuns(model, { ...lens, from: undefined, to: undefined }).sort((a, b) => (a.firstTs < b.firstTs ? -1 : 1))}
                lo={now - lens.windowMin * 60_000}
                hi={now}
                range={lens.from !== undefined && lens.to !== undefined ? { from: lens.from, to: lens.to } : undefined}
                onBrush={(r) => setLens((l) => (r ? { ...l, from: r.from, to: r.to } : (() => { const n = { ...l }; delete n.from; delete n.to; return n; })()))}
              />
            ) : run ? (
              <StageGantt bars={runGantt(model, run.runId)} />
            ) : null}
          </div>
          <p className="mt-1 text-[11px] lg:text-[10px] text-muted-foreground">시간 축을 끌면 그 구간만 · 클릭 = 선택(이웃만 밝게) · 더블클릭 = 한 층 내려가기 · 끌기 = 고정(두 번 누르면 해제) · 휠 = 줌 · <kbd>/</kbd> 검색 · <kbd>Esc</kbd> 위로</p>
        </section>

        <aside className="space-y-2 xl:col-span-4" aria-label="옆 패널">
          {research.map((s) => <ResearchFan key={s.key} session={s} />)}
          {lens.level === 'L3' && run ? (
            <DecisionDetail runId={run.runId} universe={run.universe} store={store} index={lens.decision ?? 0} model={model} onIndex={(i) => setLens((l) => ({ ...l, decision: i }))} />
          ) : lens.level !== 'L2' ? (
            <div className="rounded-lg border bg-card/60">
              <h2 className="border-b px-3 py-1.5 font-mono text-[11px] tracking-wider text-muted-foreground">▸ RUNS · {list.length}</h2>
              <ul className="max-h-[520px] divide-y overflow-auto text-xs" data-trace-runs>
                {list.slice(0, 120).map((r) => (
                  <li key={r.runId}>
                    <button type="button" onClick={() => setSelected(`r:${r.runId}`)} onDoubleClick={() => setLens((l) => drillDown(l, { id: `r:${r.runId}`, kind: 'run' }))}
                      className={cn('flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-muted/40', selected === `r:${r.runId}` && 'bg-primary/10')} data-trace-run={r.runId}>
                      <span className={cn('h-2 w-2 shrink-0 rounded-full', r.status === 'blocked' ? 'bg-rose-400' : r.status === 'landed' ? 'bg-green-400' : 'bg-indigo-400')} />
                      <span className="w-20 shrink-0 truncate font-mono">{r.runId.replace(/^run-/, '').slice(0, 8)}</span>
                      <span className="w-14 shrink-0 text-muted-foreground">{r.current ? LIVE_STAGE_LABEL[r.current] : '—'}</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px] lg:text-[10px] text-muted-foreground">{r.universe}</span>
                      {r.pr && <span className="font-mono text-[11px] lg:text-[10px]">#{r.pr}</span>}
                      <span className="w-12 shrink-0 text-right font-mono text-[11px] lg:text-[10px] text-muted-foreground">{clockTime(r.lastTs)}</span>
                    </button>
                  </li>
                ))}
                {list.length === 0 && <li className="px-3 py-6 text-center text-muted-foreground">이 렌즈에 런이 없다 — 빵부스러기에서 칸을 빼 본다.</li>}
              </ul>
            </div>
          ) : run ? (
            <RunDetail runId={run.runId} store={store} model={model} onPick={(i) => setLens((l) => ({ ...l, level: 'L3', decision: i }))} />
          ) : (
            <p className="rounded-lg border p-3 text-xs text-muted-foreground">이 창에 런 {lens.runId} 가 없다 — 창을 넓히거나 출처를 «전체»로.</p>
          )}
        </aside>
      </div>

      {(lens.level === 'L2' || lens.level === 'L3') && run && (
        <RunDrawer runId={run.runId} run={{ runId: run.runId, stages: run.stages, current: run.current, lastTs: run.lastTs, events: run.events, blocked: run.status === 'blocked', pr: run.pr, ledgerStatus: null }} lines={runSignals(model, run.runId).map((s) => `${clockTime(s.ts)} ${s.category} ${s.event}`)} onClose={() => setLens((l) => drillUp(l))} />
      )}
    </div>
    </PublicMask.Provider>
  );
}

/** 판단 사슬의 원천 — 🅣 `GET /v1/trace?level=L3&runId=` 가 1순위(서버가 여러 우주를 모아 PR·커밋·원문 열쇠까지 붙인다).
 *  서버가 못 주거나(옛 데몬 · 토큰 · 오류) 0건이면 이 창의 조회로 되돌아간다 — 어느 쪽인지를 화면에 적는다. */
type ChainLine = DecisionLine & { logId?: string; pr?: string | null; commit?: string | null };
function useRunChain(runId: string, store: string, model: ReturnType<typeof buildTraceModel>): { chain: ChainLine[]; source: 'server' | 'local'; note: string } {
  const client = useNexusClient();
  const server = useQuery({
    queryKey: ['trace', 'L3', runId, store],
    // 판단 줄만 좁혀 받는다 — 안 좁히면 한 런의 activity·llm 줄이 상한(1000)을 채워 판단이 밀려난다(실측: 1000줄 중 판단 19).
    queryFn: () => client.getTrace({ level: 'L3', runId, limit: 1000, q: 'harness.decision', ...(store ? { store } : {}) }),
    refetchInterval: 30_000,
    retry: false,
  });
  const publicNames = useContext(PublicMask);
  return useMemo(() => {
    const serverChain = server.data?.ok ? serverDecisionChain(publicNames ? maskValueForPublic(server.data.events, publicNames) : server.data.events, runId) : [];
    if (serverChain.length > 0) return { chain: serverChain, source: 'server' as const, note: `서버 /v1/trace${server.data?.truncated ? ' · 상한에 걸림' : ''}` };
    const why = server.isLoading ? '서버 조회 중' : server.error ? `서버 조회 실패: ${String((server.error as Error).message ?? server.error).slice(0, 60)}` : '서버 0건';
    return { chain: runDecisions(model, runId), source: 'local' as const, note: `이 창 조회 · ${why}` };
  }, [server.data, server.isLoading, server.error, model, runId, publicNames]);
}

/** L2 옆 패널 — 단계 줄 ⊕ 판단 사슬(옛것 → 최신 · 가로 흐름). */
function RunDetail({ runId, store, model, onPick }: { runId: string; store: string; model: ReturnType<typeof buildTraceModel>; onPick: (index: number) => void }) {
  const run = model.runs.find((r) => r.runId === runId)!;
  const { chain, source, note } = useRunChain(runId, store, model);
  return (
    <div className="space-y-2 rounded-lg border bg-card/60 p-3 text-xs" data-trace-run-detail={runId}>
      <div className="font-mono text-[11px] text-muted-foreground">{runId} · {run.universe}{run.parentRunId ? ` · 부모 ${run.parentRunId.replace(/^run-/, '').slice(0, 8)}` : ''}</div>
      <div className="flex gap-1" aria-label="단계">
        {(['author', 'decompose', 'build', 'gate', 'review', 'land'] as const).map((s) => {
          const tone = run.stages[s];
          return (
            <span key={s} className={cn('flex-1 rounded px-1 py-1 text-center text-[11px] lg:text-[10px]', !tone && 'bg-muted text-muted-foreground', tone === 'info' && 'bg-indigo-500/30', tone === 'ok' && 'bg-green-600/40', tone === 'bad' && 'bg-rose-500/40', run.current === s && 'ring-1 ring-violet-300')}>
              {LIVE_STAGE_LABEL[s]}
            </span>
          );
        })}
      </div>
      <h3 className="pt-1 font-mono text-[11px] tracking-wider text-muted-foreground">▸ 판단 사슬 · {chain.length} <span className={cn('ml-1 rounded px-1', source === 'server' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-muted')} data-trace-chain-source={source}>원천: {note}</span></h3>
      {chain.length === 0 ? <p className="text-muted-foreground">이 런의 판단 신호가 없다(계측 없음 — MAX «이 런만» 을 켜면 채워진다).</p> : (
        <ol className="flex gap-1 overflow-x-auto pb-1" data-trace-chain>
          {chain.map((d, i) => (
            <li key={`${d.ts}-${i}`} className="w-44 shrink-0 cursor-pointer rounded-md border bg-background/60 p-2 hover:border-primary" onClick={() => onPick(i)} data-trace-chain-card={i}>
              <div className="flex justify-between font-mono text-[11px] lg:text-[10px]"><span className={KIND_TEXT[d.kind]}>{d.kind}</span><span className="text-muted-foreground">{clockTime(d.ts)}</span></div>
              <div className="mt-1 line-clamp-2 text-[11px]">{d.what}</div>
              <div className="mt-1 line-clamp-2 text-[11px] lg:text-[10px] text-muted-foreground">왜: {d.why ?? d.purpose ?? <span className="rounded bg-muted px-1">계측 없음</span>}</div>
              {d.target && <div className="mt-0.5 truncate text-[11px] lg:text-[10px] text-muted-foreground">→ {d.target}</div>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** L3 판단 ⊕ L4 증거(RFC §2) — 카드(무엇·왜·목적·어디로·PATHS) · 앞뒤 사슬(←→) · 원 로그 줄 · 앞뒤 1분 신호 · 다시 찾는 명령 · PR. */
function DecisionDetail({ runId, universe, store, index, model, onIndex }: { runId: string; universe: string; store: string; index: number; model: ReturnType<typeof buildTraceModel>; onIndex: (i: number) => void }) {
  const { chain, source } = useRunChain(runId, store, model);
  const client = useNexusClient();
  const i = Math.min(Math.max(0, index), Math.max(0, chain.length - 1));
  const d = chain[i];
  const [copied, setCopied] = useState(false);
  // 키보드 `→` 가 사슬 끝을 넘으면 URL 의 번호를 끝으로 되돌린다(화면은 이미 끝을 보이고 있다).
  useEffect(() => { if (chain.length && index !== i) onIndex(i); }, [index, i, chain.length, onIndex]);
  // L4 원문 — 서버 사슬이면 그 줄의 열쇠(`log:<우주>:<id>`)로 원문을 받는다(비밀 가림 · 조회 상한과 무관).
  const evidenceRef = (d as ChainLine | undefined)?.logId;
  const evidence = useQuery({
    queryKey: ['trace', 'evidence', evidenceRef],
    queryFn: () => client.getTraceEvidence(evidenceRef!),
    enabled: Boolean(evidenceRef),
    retry: false,
    staleTime: Infinity,
  });
  const publicNames = useContext(PublicMask);
  const shownEvidence = evidence.data?.evidence && publicNames ? maskValueForPublic(evidence.data.evidence, publicNames) : evidence.data?.evidence;
  if (!d) return <p className="rounded-lg border p-3 text-xs text-muted-foreground">이 런에 판단이 없다.</p>;
  const ev = decisionEvidence(model, d, universe);
  const pr = (d as ChainLine).pr ?? ev.pr;
  return (
    <div className="space-y-2 rounded-lg border bg-card/60 p-3 text-xs" data-trace-decision={i}>
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => onIndex(i - 1)} disabled={i === 0} className="rounded border px-1.5 disabled:opacity-30" aria-label="앞 판단">←</button>
        <span className="font-mono text-[11px] text-muted-foreground">판단 {i + 1}/{chain.length}</span>
        <button type="button" onClick={() => onIndex(i + 1)} disabled={i >= chain.length - 1} className="rounded border px-1.5 disabled:opacity-30" aria-label="다음 판단">→</button>
        <span className={cn('ml-auto font-mono', KIND_TEXT[d.kind])}>{d.kind}</span>
        <span className="font-mono text-muted-foreground">{clockTime(d.ts)}</span>
      </div>
      <dl className="grid grid-cols-[5rem_1fr] gap-x-2 gap-y-1">
        <dt className="text-muted-foreground">무엇</dt><dd>{d.what}</dd>
        <dt className="text-muted-foreground">왜</dt><dd>{d.why ?? <span className="rounded bg-muted px-1">계측 없음</span>}</dd>
        <dt className="text-muted-foreground">목적</dt><dd>{d.purpose ?? <span className="rounded bg-muted px-1">계측 없음</span>}</dd>
        <dt className="text-muted-foreground">어디로</dt><dd>{d.target ?? '—'}</dd>
        {d.paths ? (<><dt className="text-muted-foreground">PATHS</dt><dd className="font-mono">{d.paths}</dd></>) : null}
      </dl>
      <details open className="rounded-md border bg-background/40 p-2" data-trace-evidence>
        <summary className="cursor-pointer font-mono text-[11px] tracking-wider text-muted-foreground">▸ L4 증거</summary>
        <div className="mt-2 space-y-2">
          <div>
            <div className="text-[11px] lg:text-[10px] text-muted-foreground" data-trace-evidence-origin={evidence.data?.evidence ? 'server' : 'local'}>원 로그 줄 · {evidence.data?.evidence ? '서버 원문(비밀 가림)' : source === 'server' && evidence.error ? `서버 원문 실패 — 이 창 조회` : '이 창 조회'}</div>
            <pre className="max-h-40 overflow-auto rounded bg-muted/40 p-2 text-[11px] lg:text-[10px] leading-relaxed" data-trace-evidence-source>
              {shownEvidence
                ? JSON.stringify({ ref: evidence.data!.ref, ts: shownEvidence.ts, instance: shownEvidence.instance, category: shownEvidence.category, event: shownEvidence.event, data: shownEvidence.data }, null, 2)
                : ev.source ? JSON.stringify({ ts: ev.source.ts, instance: ev.source.instance, category: ev.source.category, event: ev.source.event, data: ev.source.data }, null, 2)
                  : evidenceRef && evidence.isLoading ? '원문을 받는 중…' : '이 창의 조회에 원 줄이 없다(조회 상한 또는 다른 우주).'}
            </pre>
          </div>
          <div>
            <div className="text-[11px] lg:text-[10px] text-muted-foreground">앞뒤 1분 · 같은 런 · {ev.around.length}</div>
            <pre className="max-h-32 overflow-auto rounded bg-muted/40 p-2 text-[11px] lg:text-[10px] leading-relaxed">{ev.around.map((r) => `${clockTime(r.ts)} ${r.category} ${r.event}`).join('\n') || '—'}</pre>
          </div>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-muted/40 px-2 py-1 text-[11px] lg:text-[10px]" title={ev.command} data-trace-evidence-command>{ev.command}</code>
            <button type="button" className="rounded border px-2 py-1 text-[11px] lg:text-[10px] hover:bg-muted" onClick={() => { void navigator.clipboard?.writeText(ev.command).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }); }}>{copied ? '복사됨' : '명령 복사'}</button>
          </div>
          {(d as ChainLine).commit && <code className="rounded bg-muted/40 px-2 py-1 text-[11px] lg:text-[10px]" data-trace-evidence-commit>커밋 {(d as ChainLine).commit!.slice(0, 10)}</code>}
          {pr && <Link href={`/approvals?pr=${pr}` as never} className="inline-block rounded border px-2 py-1 text-[11px] lg:text-[10px] hover:bg-muted">PR #{pr} 승인 카드 →</Link>}
        </div>
      </details>
    </div>
  );
}

/** v5 무대 문법(LiveMaxStage 공유) — 렌즈에 남은 런의 줄만 먹인다. 두 탭이 같은 무대 부품을 쓰니 교체가 싸다(🅢 11:0x). */
function PresentStage({ model, lens, ledger, now, store, publicCapture = false }: { model: ReturnType<typeof buildTraceModel>; lens: TraceLens; ledger: Parameters<typeof buildLiveBoard>[1]; now: number; store: string; publicCapture?: boolean }) {
  const rows = useMemo(() => lensRows(model, lens), [model, lens]);
  // 렌즈가 «전체»면 SHIPPED 는 Live 와 같은 자(GitHub 병합 수)로 — v5 교체 조건 ③ «같은 창·우주에서 수 일치».
  // 좁혔으면 그 런들의 병합(로그의 SHIP)만 센다 — GitHub 수는 렌즈를 모른다.
  const whole = rows === model.rows;
  const client = useNexusClient();
  const shipped = useQuery({ queryKey: ['trace', 'shipped', lens.windowMin], queryFn: () => client.getLiveShipped(`${lens.windowMin}m`), refetchInterval: 60_000, enabled: whole });
  const board = useMemo(() => {
    const b = buildLiveBoard(rows, ledger, { now, windowMinutes: lens.windowMin });
    const merged = whole ? shipped.data?.merged : null;
    return typeof merged === 'number' ? { ...b, gauges: { ...b.gauges, shipped: merged } } : b;
  }, [rows, ledger, now, lens.windowMin, whole, shipped.data]);
  return <LiveMaxStage board={board} rows={rows} publicCapture={publicCapture} windowMinutes={lens.windowMin} sourceLabel={store === '@active' ? 'federated' : store || 'this instance'} shippedSource={whole && typeof shipped.data?.merged === 'number' ? 'github' : 'log'} />;
}
