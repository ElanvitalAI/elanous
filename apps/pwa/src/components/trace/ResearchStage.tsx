'use client';

// 조사 장면 «전체 무대»(🅢 12:0x · 대표 «일부러 화려하게» = 무대 크기) — Trace «발표» 에서만 뜬다(v5 Live 는 동결).
// 질문 노드 가운데 · 엔진 갈래가 화면 끝까지 · 출처 카드 수십 장이 비처럼 떨어져 쌓임(도메인·제목) · 합침은 번쩍이며 사라짐 ·
// firecrawl 스크랩 진행 막대 · 두뇌가 고른(인용) 카드만 빛나며 아래 판단 카드 «왜» 로 날아가 붙음 · 위 계기(ENGINES·SOURCES·SCRAPED·CREDITS·시간).
// full ↔ free 두 판 나란히(`pair`). ⛔ 보이는 수는 전부 `research.*`·`harness.decision` 진짜 줄이다. `prefers-reduced-motion` 이면 정지.

import type { ResearchSession, ResearchSource } from '@/lib/research-fan';
import { engineColor } from './ResearchFan';

const CSS = `
@keyframes rs-rain { from { transform: translateY(-110vh) rotate(-4deg); opacity: 0 } 70% { opacity: 1 } to { transform: none; opacity: 1 } }
@keyframes rs-merge { 0% { box-shadow: 0 0 0 0 #fde68a } 40% { box-shadow: 0 0 28px 6px #fde68a; transform: scale(1.08) } 100% { transform: scale(0); opacity: 0 } }
@keyframes rs-cite { 0%,100% { box-shadow: 0 0 10px var(--c) } 50% { box-shadow: 0 0 30px 4px var(--c) } }
@keyframes rs-fly { from { transform: translateY(-46vh) scale(.6); opacity: 0 } to { transform: none; opacity: 1 } }
@keyframes rs-grow { from { stroke-dashoffset: 1600 } to { stroke-dashoffset: 0 } }
@keyframes rs-core { 0%,100% { r: 34 } 50% { r: 44 } }
@media (prefers-reduced-motion: reduce) { [data-research-stage] * { animation: none !important } }
`;

function Gauge({ label, value, sub, color = '#e0e7ff' }: { label: string; value: string; sub?: React.ReactNode; color?: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-indigo-400/15 bg-slate-950/70 px-3 py-2">
      <div className="font-mono text-[11px] lg:text-[10px] tracking-[.14em] text-slate-400">{label}</div>
      <div className="font-mono text-3xl font-semibold tabular-nums" style={{ color, textShadow: `0 0 18px ${color}66` }}>{value}</div>
      {sub}
    </div>
  );
}

function SourceCard({ s, i, delayBase, cited }: { s: ResearchSource; i: number; delayBase: number; cited: boolean }) {
  const c = engineColor(s.engine);
  const delay = `${delayBase + i * 0.12}s`;
  return (
    <div
      className="w-44 rounded-md border bg-slate-950/90 px-2 py-1 text-[11px] lg:text-[10px] leading-tight"
      style={{
        borderColor: `${c}88`, ['--c' as string]: c,
        animation: s.merged ? `rs-rain .9s ease-out ${delay} both, rs-merge 1s ease-in ${delayBase + i * 0.12 + 1.4}s forwards` : cited ? `rs-rain .9s ease-out ${delay} both, rs-cite 1.6s ease-in-out ${delayBase + i * 0.12 + 1}s infinite` : `rs-rain .9s ease-out ${delay} both`,
      }}
      title={s.url}
      data-research-card={s.merged ? 'merged' : cited ? 'cited' : 'source'}
    >
      <div className="flex items-center gap-1">
        {/* 도메인 배지 — 바깥 파비콘 서비스를 부르지 않는다(CSP · 보는 도메인이 새지 않게). */}
        <span className="flex h-3 w-3 shrink-0 items-center justify-center rounded-sm text-[11px] lg:text-[8px] font-bold text-slate-950" style={{ background: c }} aria-hidden>{s.host.charAt(0).toUpperCase()}</span>
        <span className="truncate font-mono" style={{ color: c }}>{s.host}</span>
        {s.scraped && <span className="ml-auto rounded bg-orange-400/20 px-1 text-[11px] lg:text-[9px] text-orange-200">SCRAPED</span>}
      </div>
      <div className="mt-0.5 line-clamp-2 text-slate-200">{s.title ?? s.url.replace(/^https?:\/\//, '')}</div>
    </div>
  );
}

/** 한 판 — 질문 · 갈래 · 카드 비 · 계기 · 판단 카드. */
export function ResearchStagePanel({ session, label }: { session: ResearchSession; label?: string }) {
  const W = 1000; const H = 600; const cx = W / 2; const cy = H / 2;
  const n = Math.max(1, session.engines.length);
  const kept = session.sources.filter((s) => !s.merged);
  const cited = kept.filter((s) => s.cited).slice(0, 5);
  const fcSources = session.sources.filter((s) => s.engine.startsWith('firecrawl') || s.engine === 'fc-dev');
  const scraped = session.sources.filter((s) => s.scraped).length;
  const credits = session.engines.reduce((a, e) => a + (e.credits ?? 0), 0);
  const hasCredits = session.engines.some((e) => typeof e.credits === 'number');
  const ms = Math.max(0, ...session.engines.map((e) => e.ms ?? 0));
  // 엔진 칸 — 왼쪽·오른쪽 30% 두 열에 나눠 세로 칸을 하나씩 준다(🅢 12:5x: 카드 더미가 가운데 질문을 덮고
  // 왼쪽 두 열이 서로 겹쳐 쌓였다). 가운데 40% 는 질문 자리로 비운다 · 갈래는 칸의 안쪽 끝에 닿는다.
  const COL = 0.3;
  const leftCount = Math.ceil(n / 2);
  const slot = (i: number) => {
    const side: 'left' | 'right' = i < leftCount ? 'left' : 'right';
    const j = side === 'left' ? i : i - leftCount;
    const m = side === 'left' ? leftCount : n - leftCount;
    return { side, top: j / m, height: 1 / m, x: side === 'left' ? W * COL : W * (1 - COL), y: H * ((j + 0.5) / m) };
  };
  const end = (i: number) => slot(i);
  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-indigo-400/20 bg-[radial-gradient(ellipse_at_center,rgba(124,58,237,.22),rgba(2,6,23,.98)_68%)] p-3" data-research-stage-panel={session.key}>
      <div className="grid grid-cols-5 gap-2">
        <Gauge label="ENGINES" value={String(session.engines.length)} sub={<div className="mt-1 flex gap-1">{session.engines.map((e) => <span key={e.id} className="h-1.5 flex-1 rounded-full" style={{ background: e.error ? '#fb7185' : engineColor(e.id), opacity: e.done ? 1 : 0.35 }} />)}</div>} />
        <Gauge label="SOURCES" value={String(kept.length)} color="#f5d0fe" sub={<div className="font-mono text-[11px] lg:text-[10px] text-slate-500">합침 {session.sources.length - kept.length}</div>} />
        <Gauge label="SCRAPED" value={`${scraped}`} color="#fdba74" sub={<div className="mt-1 h-1.5 rounded-full bg-slate-800"><div className="h-1.5 rounded-full bg-orange-400" style={{ width: `${fcSources.length ? Math.min(100, (scraped / fcSources.length) * 100) : 0}%`, boxShadow: '0 0 8px #fb923c' }} /></div>} />
        <Gauge label="CREDITS" value={hasCredits ? String(credits) : '—'} color="#fde68a" />
        <Gauge label="TIME" value={ms ? `${(ms / 1000).toFixed(1)}s` : '—'} color="#a7f3d0" sub={label ? <div className="font-mono text-[11px] lg:text-[10px] text-slate-400">{label}</div> : null} />
      </div>
      <div className="relative min-h-0 flex-1">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
          <defs><radialGradient id="rs-q"><stop offset="0%" stopColor="#fdf4ff" /><stop offset="100%" stopColor="#f0abfc00" /></radialGradient></defs>
          {session.engines.map((e, i) => {
            const p = end(i); const c = e.error ? '#fb7185' : engineColor(e.id);
            return <line key={e.id} x1={cx} y1={cy} x2={p.x} y2={p.y} stroke={c} strokeWidth={e.done ? 3 : 1.5} strokeDasharray={e.done ? '1600' : '6 6'} style={{ animation: e.done ? 'rs-grow 1.1s ease-out both' : undefined, filter: `drop-shadow(0 0 8px ${c})` }} />;
          })}
          <circle cx={cx} cy={cy} r={38} fill="url(#rs-q)" style={{ animation: 'rs-core 2.4s ease-in-out infinite' }} />
          <circle cx={cx} cy={cy} r={9} fill="#fff" />
        </svg>
        <div className="pointer-events-none absolute left-1/2 top-1/2 w-[34%] -translate-x-1/2 translate-y-6 text-center text-sm text-slate-100" style={{ textShadow: '0 0 12px #000' }}>«{session.question}»</div>
        {session.engines.map((e, i) => {
          const p = slot(i);
          const mine = session.sources.filter((s) => s.engine === e.id).slice(0, 12);
          const alignRight = p.side === 'right';
          return (
            <div key={e.id} className="absolute overflow-hidden p-1" data-research-engine-slot={e.id}
              style={{ top: `${p.top * 100}%`, height: `${p.height * 100}%`, width: `${COL * 100}%`, ...(alignRight ? { right: 0 } : { left: 0 }) }}>
              <div className={`mb-1 font-mono text-xs ${alignRight ? 'text-right' : ''}`} style={{ color: e.error ? '#fb7185' : engineColor(e.id), textShadow: `0 0 10px ${engineColor(e.id)}` }}>
                {e.id} {e.error ? `오류 · ${e.error}` : e.done ? `${e.hits}건` : '…'}{e.ms != null ? ` · ${(e.ms / 1000).toFixed(1)}s` : ''}
              </div>
              <div className={`flex flex-wrap gap-1 ${alignRight ? 'justify-end' : ''}`}>
                {mine.map((s, k) => <SourceCard key={`${s.url}-${k}`} s={s} i={k} delayBase={0.3 + i * 0.25} cited={!s.merged && !!s.cited} />)}
              </div>
            </div>
          );
        })}
      </div>
      {/* 판단 카드 — 인용 카드가 날아와 붙는 자리 */}
      <div className="mx-auto mt-2 w-[min(760px,92%)] rounded-xl border border-violet-300/40 bg-slate-950/90 p-3" style={{ boxShadow: '0 0 30px #a78bfa44' }} data-research-why>
        <div className="font-mono text-[11px] lg:text-[10px] tracking-widest text-violet-300">▸ 판단 · 왜</div>
        <div className="mt-1 text-sm text-slate-100">{session.why ?? <span className="text-slate-500">이 조사 뒤 판단이 아직 없다</span>}</div>
        {cited.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {cited.map((s, k) => (
              <span key={s.url} className="rounded border px-1.5 py-0.5 font-mono text-[11px] lg:text-[10px]" style={{ color: engineColor(s.engine), borderColor: `${engineColor(s.engine)}88`, animation: `rs-fly .8s cubic-bezier(.2,1.4,.4,1) ${2.2 + k * 0.25}s both`, boxShadow: `0 0 12px ${engineColor(s.engine)}66` }} data-research-cited>
                {s.title ?? s.host}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** 전체 무대 — 한 판, 또는 full ↔ free 나란히. */
export function ResearchStage({ sessions, pair, onClose, onPair }: { sessions: ResearchSession[]; pair: boolean; onClose: () => void; onPair: (on: boolean) => void }) {
  const first = sessions[0];
  const full = sessions.find((s) => s.tier === 'full');
  const free = sessions.find((s) => s.tier === 'free');
  const canPair = !!full && !!free;
  return (
    <div className="fixed inset-0 z-50 flex flex-col gap-2 bg-[#020617] p-3 text-slate-100" data-research-stage>
      <style>{CSS}</style>
      <header className="flex items-center gap-3">
        <span className="text-xl tracking-tight" style={{ fontFamily: 'Georgia, "Times New Roman", serif' }}>Elanous</span>
        <span className="font-mono text-[11px] tracking-[.18em] text-fuchsia-200/80">RESEARCH · 조사</span>
        <button type="button" disabled={!canPair} onClick={() => onPair(!pair)} className="rounded-full border border-fuchsia-300/40 px-3 py-1 font-mono text-[11px] lg:text-[10px] text-fuchsia-100 disabled:opacity-30" title={canPair ? 'full ↔ free 두 판 나란히' : 'full·free 두 조사가 모두 있을 때'} data-research-pair>
          {pair ? '한 판' : 'full ↔ free'}
        </button>
        <button type="button" onClick={onClose} className="ml-auto rounded-full border border-slate-600 px-3 py-1 text-xs text-slate-300 hover:bg-slate-800">닫기(Esc)</button>
      </header>
      {!first ? <p className="m-auto text-sm text-slate-400">이 창에 조사가 없다 — `elanous research` 가 돌면 여기에 뜬다.</p>
        : pair && canPair ? (
          <div className="grid min-h-0 flex-1 grid-cols-2 gap-2">
            <ResearchStagePanel session={full!} label="FULL · 유료 엔진" />
            <ResearchStagePanel session={free!} label="FREE · 무료 폴백" />
          </div>
        ) : <div className="min-h-0 flex-1"><ResearchStagePanel session={first} label={first.tier ? first.tier.toUpperCase() : undefined} /></div>}
    </div>
  );
}
