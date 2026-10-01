'use client';

// Live 탭 — «AI 가 판단하고 기획하는 것이 눈앞에서 흐른다»(기획 v2). 보이는 수는 전부 진짜 신호다.
// 기획: 내부 문서 `PLAN-live-signals-tab-teaser-and-web-2026-09-28` · 🅕 v1(새 서버 API 없음).

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, Sparkles } from 'lucide-react';
import { useNexusClient, useOptionalNexusClient } from '@/nexus/hooks/use-nexus-context';
import { useLiveSignals } from '@/nexus/hooks/use-live-signals';
import { buildLiveBoard, logLine } from '@/lib/live-signals';
import { selfHealedPrs } from '@/lib/live-v5';
import { maskRowsForPublic } from '@/lib/live-public';
import type { LogRow } from '@/nexus/client';
import { usePwaRole } from '@/lib/pwa-role';
import { LiveBoard, type LiveMode } from './LiveBoard';
import { LiveMaxStage } from './LiveMaxStage';
import { RunDrawer } from './RunDrawer';

const MODE_KEY = 'elanous.live.mode';
const MAX_AUTO_OFF_MS = 30 * 60_000;
const WINDOWS = [15, 60, 360, 1440] as const;
/** 연합 원천(서버가 «최근 24시간에 쓰인 우주»를 고른다) — MAX 기본(🅢 09-28 10:1x: 워크트리 발사 = 시험 우주 · 자식 = Pod). */
const FEDERATED = '@active';

export function LivePanel() {
  const client = useOptionalNexusClient();
  if (!client) {
    return (
      <div className="mx-auto max-w-2xl space-y-2 p-6">
        <h1 className="text-xl font-semibold tracking-tight">Live</h1>
        <p className="text-sm text-muted-foreground">Connect to a NEXUS daemon to watch runs live.</p>
      </div>
    );
  }
  return <LivePanelInner />;
}

function LivePanelInner() {
  const role = usePwaRole();
  // ⛔ 기기 설정은 마운트 뒤에 읽는다(정적 export 하이드레이션 · #418). MAX 는 저장하지 않는다 — 늘 «알고» 켠다(v4).
  const [mode, setMode] = useState<LiveMode>('practical');
  const [maxUntil, setMaxUntil] = useState<number | null>(null);
  const [maxScope, setMaxScope] = useState<'all' | 'run'>('all');
  const [confirming, setConfirming] = useState(false);
  useEffect(() => { try { window.localStorage.removeItem(MODE_KEY); } catch { /* 옛 값 정리 */ } }, []);
  useEffect(() => {
    if (!maxUntil) return;
    const t = setTimeout(() => { setMode('practical'); setMaxUntil(null); }, Math.max(0, maxUntil - Date.now()));
    return () => clearTimeout(t);
  }, [maxUntil]);
  // MAX = 하니스 상세 계측 스위치(🅢 #21452 `POST /v1/live/detail`) — 서버가 들고 모든 기기가 같은 상태를 본다.
  const client = useNexusClient();
  const [switchError, setSwitchError] = useState<string | null>(null);
  const applyState = (st: { on: boolean; scope?: string | null; until?: string | null }) => {
    if (st.on) {
      setMode('max');
      setMaxScope(st.scope && st.scope !== 'all' ? 'run' : 'all');
      setMaxUntil(st.until ? Date.parse(st.until) : Date.now() + MAX_AUTO_OFF_MS);
    } else { setMode('practical'); setMaxUntil(null); }
  };
  useEffect(() => {
    let alive = true;
    client.getLiveDetail().then((st) => { if (alive) applyState(st); }).catch(() => { /* 옛 데몬 — 스위치 없음 */ });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);
  const turnOnMax = (scope: 'all' | 'run') => {
    setConfirming(false); setSwitchError(null);
    const target = scope === 'run' && selectedRunId ? selectedRunId : 'all';
    client.setLiveDetail({ scope: target, ttlMin: MAX_AUTO_OFF_MS / 60_000, by: 'pwa-live' })
      .then(applyState)
      .catch((e) => setSwitchError(e instanceof Error ? e.message : String(e)));
  };
  const turnOffMax = () => {
    setSwitchError(null);
    client.setLiveDetail({ scope: 'all', ttlMin: 0, by: 'pwa-live' }).then(applyState).catch((e) => setSwitchError(e instanceof Error ? e.message : String(e)));
    setMode('practical'); setMaxUntil(null);
  };
  const [windowMinutes, setWindowMinutes] = useState<number>(60);
  const [store, setStore] = useState<string>('');
  // MAX 로 «들어갈 때» 한 번 — 연합 ⊕ 24시간(판단 수가 적어 무대가 조용하던 것 · 🅢 ⑤). 그 뒤 사람이 바꾼 값은 존중한다.
  const enteredMax = useRef(false);
  useEffect(() => {
    if (mode === 'max' && !enteredMax.current) { enteredMax.current = true; setStore(FEDERATED); setWindowMinutes(1440); }
    if (mode !== 'max') enteredMax.current = false;
  }, [mode]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const { logs, runs, instances } = useLiveSignals({ store: store || undefined, windowMinutes });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { setNow(Date.now()); }, [logs.dataUpdatedAt]);

  // «공개 캡처»(🅢 09-28 10:3x) — 녹화·스크린샷 전에 켠다. `?capture=public` 로도(🅣 녹화용). 주소는 마운트 뒤에 읽는다(#418).
  const [publicCapture, setPublicCapture] = useState(false);
  useEffect(() => { if (new URLSearchParams(window.location.search).get('capture') === 'public') setPublicCapture(true); }, []);
  const rawRows = logs.data?.logs ?? NO_LOG_ROWS;
  const rows = useMemo(() => (publicCapture ? maskRowsForPublic(rawRows) : rawRows), [rawRows, publicCapture]);
  // SHIPPED = GitHub 병합 PR 수(🅢 ①) — 로그의 SHIP 판단만 세면 우주가 갈려 0 이 나왔다.
  const shipped = useQuery({
    queryKey: ['live', 'shipped', windowMinutes],
    queryFn: () => client.getLiveShipped(`${windowMinutes}m`),
    refetchInterval: 60_000,
  });
  const board = useMemo(() => {
    const b = buildLiveBoard(rows, runs.data?.entries ?? [], { now, windowMinutes });
    const merged = shipped.data?.merged;
    if (typeof merged !== 'number') return b;
    const healed = selfHealedPrs(rows).length;
    return { ...b, gauges: { ...b.gauges, shipped: merged, selfHealRuns: healed, selfHealRate: merged > 0 ? Math.round((healed / merged) * 100) : null } };
  }, [rows, runs.data, now, windowMinutes, shipped.data]);
  // 비용 배지(v4) — 이 화면이 실제로 받는 신호량(추정 아님). 하니스 쪽 상세 계측 스위치는 아직 없다.
  const eventsPerMin = windowMinutes > 0 ? Math.round((rows.length / windowMinutes) * 10) / 10 : 0;
  const payloadKb = Math.round(JSON.stringify(rows).length / 1024);
  const lines = useMemo(
    () => rows
      .filter((row) => !selectedRunId || (row.data as { runId?: unknown } | null | undefined)?.runId === selectedRunId)
      .map((row) => logLine(row)),
    [rows, selectedRunId],
  );
  const sources = (instances.data?.instances ?? []).filter((i) => i.dbExists !== false && !i.current);

  return (
    <div className={`mx-auto ${mode === 'max' ? 'max-w-none space-y-2 p-2' : 'max-w-6xl space-y-4 p-4 sm:p-6'}`}>
      <style>{LIVE_SHOW_CSS}</style>
      <header className={`flex flex-wrap items-center gap-3 ${mode === 'max' ? 'justify-end' : 'justify-between'}`}>
        <div className={mode === 'max' ? 'hidden' : ''}>
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <Activity className="h-5 w-5" aria-hidden /> Live
          </h1>
          <p className="text-sm text-muted-foreground">하니스 런이 판단하고 기획하는 신호 — 보이는 수는 전부 진짜다.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <select aria-label="시간 창" value={windowMinutes} onChange={(e) => setWindowMinutes(Number(e.target.value))} className="rounded-md border bg-background px-2 py-1">
            {WINDOWS.map((w) => <option key={w} value={w}>{w < 60 ? `${w}분` : `${w / 60}시간`}</option>)}
          </select>
          <select aria-label="신호 출처" value={store} onChange={(e) => setStore(e.target.value)} className="max-w-48 rounded-md border bg-background px-2 py-1">
            <option value="">이 인스턴스</option>
            <option value={FEDERATED}>전체(연합 · 최근 24시간에 쓰인 우주)</option>
            {sources.map((i) => <option key={i.name} value={i.name}>{i.name}</option>)}
          </select>
          <button
            type="button"
            data-elanous-action="live-public-capture"
            aria-pressed={publicCapture}
            onClick={() => setPublicCapture((v) => !v)}
            title="녹화·스크린샷용 — 계정 이름 → account-N · 크레딧·USD 숨김 · 홈 경로 가림"
            className={`rounded-md border px-2 py-1 ${publicCapture ? 'border-emerald-500 text-emerald-600 dark:text-emerald-300' : 'hover:bg-muted'}`}
          >
            {publicCapture ? '● 공개 캡처 켜짐' : '공개 캡처'}
          </button>
          {mode === 'max' ? (
            <button type="button" data-elanous-action="live-max-off" onClick={turnOffMax} className="inline-flex items-center gap-1 rounded-md border border-primary px-2 py-1 text-primary hover:bg-muted">
              <Sparkles className="h-3.5 w-3.5" aria-hidden /> 화려함 MAX 켜짐 · 끄기
            </button>
          ) : (
            <button type="button" data-elanous-action="live-max-on" onClick={() => setConfirming(true)} className="inline-flex items-center gap-1 rounded-md border px-2 py-1 hover:bg-muted">
              <Sparkles className="h-3.5 w-3.5" aria-hidden /> 화려함 MAX
            </button>
          )}
        </div>
      </header>

      {confirming && (
        <div role="dialog" aria-label="화려함 MAX 켜기" className="space-y-2 rounded-md border border-primary/50 bg-primary/5 p-3 text-sm" data-live-max-confirm>
          <p className="font-medium">화려함 MAX 를 켤까요?</p>
          <p className="text-xs text-muted-foreground">
            마케팅(시연·녹화)과 상세 런 디버깅용입니다. 켜면 하니스가 판단마다 «왜·목적·보낸 곳»을 추가로 기록합니다(부하가 듭니다) — 30분 뒤 자동으로 꺼지고, 다른 기기에서도 같은 상태로 보입니다.
            지금 이 화면이 받는 신호: 분당 {eventsPerMin}건 · 응답 약 {payloadKb}KB.
          </p>
          <div className="flex flex-wrap gap-2 text-xs">
            <button type="button" data-elanous-action="live-max-all" onClick={() => turnOnMax('all')} className="rounded-md border px-2 py-1 hover:bg-muted">전체로 켜기</button>
            <button type="button" data-elanous-action="live-max-run" disabled={!selectedRunId} onClick={() => turnOnMax('run')} className="rounded-md border px-2 py-1 hover:bg-muted disabled:opacity-50">{selectedRunId ? '이 런만 켜기' : '이 런만 켜기(먼저 런을 고르세요)'}</button>
            <button type="button" onClick={() => setConfirming(false)} className="rounded-md px-2 py-1 text-muted-foreground hover:bg-muted">취소</button>
          </div>
        </div>
      )}
      {switchError && <p className="rounded-md bg-error/10 p-2 text-xs text-error">MAX 스위치를 못 바꿨다: {switchError}</p>}
      {mode === 'max' && (
        <p className="rounded-md border border-primary/40 px-3 py-1 text-[11px] lg:text-[10px] text-muted-foreground" data-live-cost-badge>
          화려함 MAX · 범위 {maxScope === 'run' && selectedRunId ? `런 ${selectedRunId.replace(/^run-/, '').slice(0, 8)}` : '전체'} · 받는 신호 분당 {eventsPerMin}건 · 응답 약 {payloadKb}KB
          {maxUntil ? ` · ${Math.max(0, Math.round((maxUntil - now) / 60_000))}분 뒤 자동 꺼짐` : ''} · 하니스 판단 이벤트 {board.emitted}건
        </p>
      )}
      {logs.error ? (
        <p className="rounded-md bg-error/10 p-3 text-sm text-error">신호를 못 읽었다: {logs.error instanceof Error ? logs.error.message : String(logs.error)}</p>
      ) : null}
      {selectedRunId && (
        <RunDrawer runId={selectedRunId} run={board.snapshot.runs.find((r) => r.runId === selectedRunId) ?? null} lines={lines} onClose={() => setSelectedRunId(null)} />
      )}
      {mode === 'max' ? (
        <LiveMaxStage board={board} rows={rows} windowMinutes={windowMinutes} sourceLabel={store === FEDERATED ? 'federated' : store || 'this instance'} shippedSource={typeof shipped.data?.merged === 'number' ? 'github' : 'log'} publicCapture={publicCapture} role={role} onSelectRun={(id) => setSelectedRunId((cur) => (cur === id ? null : id))} />
      ) : (
        <LiveBoard board={board} lines={lines} mode={mode} role={role} selectedRunId={selectedRunId} onSelectRun={(id) => setSelectedRunId((cur) => (cur === id ? null : id))} />
      )}
      <p className={`text-[11px] text-muted-foreground ${mode === 'max' ? 'hidden' : ''}`}>
        갱신 5초 · 출처 <code>/v1/logs</code> · <code>/v1/harness/runs</code> · 비밀처럼 보이는 조각은 가린다.
      </p>
    </div>
  );
}

/** 빈 조회도 같은 배열 — 렌더마다 새 `[]` 면 아래 메모가 매번 깨진다. */
const NO_LOG_ROWS: LogRow[] = [];

// 화려함 MAX 전용 연출 — `prefers-reduced-motion` 이면 움직임을 끈다.
const LIVE_SHOW_CSS = `
@keyframes live-pulse { 0%,100% { opacity: 1; box-shadow: 0 0 0 0 rgba(99,102,241,0) } 50% { opacity: .55; box-shadow: 0 0 10px 2px rgba(99,102,241,.55) } }
@keyframes live-pulse-bad { 0%,100% { opacity: 1 } 50% { opacity: .4; box-shadow: 0 0 10px 2px rgba(239,68,68,.6) } }
@keyframes live-glow { 0%,100% { box-shadow: 0 0 0 0 rgba(99,102,241,0) } 50% { box-shadow: 0 0 18px 2px rgba(99,102,241,.35) } }
@keyframes live-line-in { from { transform: translateY(-6px); opacity: 0 } to { transform: none; opacity: 1 } }
@keyframes live-ship { 0% { background: rgba(34,197,94,.35) } 100% { background: transparent } }
.live-max .live-pulse { animation: live-pulse 1.4s ease-in-out infinite }
.live-max .live-pulse-bad { animation: live-pulse-bad 1s ease-in-out infinite }
.live-max .live-glow { animation: live-glow 2.4s ease-in-out infinite }
.live-max .live-line-in { animation: live-line-in .45s ease-out }
.live-max .live-ship { animation: live-ship 2.4s ease-out; font-size: 12px }
.live-max .live-gauge { background: radial-gradient(120% 120% at 0% 0%, rgba(99,102,241,.10), transparent 60%) }
.live-max .live-count { text-shadow: 0 0 12px rgba(99,102,241,.45) }
.live-stage { background: radial-gradient(120% 90% at 50% 0%, rgba(79,70,229,.25), rgba(2,6,23,.98) 60%), #020617; box-shadow: inset 0 0 0 1px rgba(99,102,241,.25) }
.live-stage .live-line-in { animation: live-line-in .45s ease-out }
@keyframes live-v5-marquee { from { transform: translateX(0) } to { transform: translateX(-50%) } }
@keyframes live-v5-blink { 0%,100% { opacity: 1 } 50% { opacity: .45 } }
@keyframes live-v5-hot { 0%,100% { box-shadow: 0 0 14px #a78bfa55, inset 0 0 14px #a78bfa22 } 50% { box-shadow: 0 0 26px #a78bfa99, inset 0 0 22px #a78bfa44 } }
.live-v5-marquee { animation: live-v5-marquee linear infinite }
.live-v5-blink { animation: live-v5-blink 1.6s ease-in-out infinite }
.live-v5-hot { animation: live-v5-hot 1.8s ease-in-out infinite }
@media (prefers-reduced-motion: reduce) { .live-max *, .live-v5 * { animation: none !important; transition: none !important } }
`;
