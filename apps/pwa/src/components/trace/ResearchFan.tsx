'use client';

// 조사 장면 — 엔진 부채꼴 · 출처 비 · 인용 후보(드라이브 RFC §1c · 대표 «일부러 화려하게»).
// Trace 는 기본이 «집중»이지만 이 칸만은 예외다: 조사는 여러 엔진이 «동시에» 도는 것이 보여야 한다.
// 부채꼴 = 질문 한 점에서 엔진마다 한 가지 · 길이 = 건수(도착 전엔 점선이 자란다) · 빨강 = 오류 · 오른쪽 = 출처 비 ⊕ 인용 후보.
// ⛔ 보이는 수는 전부 진짜 `research.*` 줄이다 — 이벤트가 없으면 칸을 그리지 않는다.

import type { ResearchSession } from '@/lib/research-fan';

const ENGINE_COLOR: Record<string, string> = {
  grok: '#f0abfc', firecrawl: '#fb923c', tavily: '#38bdf8', ddg: '#a7f3d0', jina: '#fde68a', 'fc-dev': '#fdba74', capture: '#c4b5fd',
};
export const engineColor = (id: string): string => ENGINE_COLOR[id] ?? ENGINE_COLOR[id.split('-')[0] ?? ''] ?? '#a5b4fc';

export function ResearchFan({ session }: { session: ResearchSession }) {
  const W = 460; const H = 200; const cx = 50; const cy = H / 2;
  const n = Math.max(1, session.engines.length);
  const top = Math.max(1, ...session.engines.map((e) => e.hits));
  const shareTotal = Object.values(session.share).reduce((a, b) => a + b, 0);
  return (
    <div className="rounded-lg border border-fuchsia-400/30 bg-slate-950/80 p-2 text-slate-100" data-trace-research={session.key} style={{ boxShadow: '0 0 24px #f0abfc22' }}>
      <style>{`@keyframes rf-grow { from { stroke-dashoffset: 400 } to { stroke-dashoffset: 0 } } @keyframes rf-pulse { 0%,100% { opacity: .5 } 50% { opacity: 1 } } @media (prefers-reduced-motion: reduce) { [data-trace-research] * { animation: none !important } }`}</style>
      <div className="mb-1 flex items-center gap-2 font-mono text-[11px] lg:text-[10.5px] tracking-wider text-slate-400">
        <span>▸ RESEARCH · 엔진 {session.engines.length}</span>
        <span className="ml-auto">{new Date(session.ts).toLocaleTimeString(undefined, { hour12: false })}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" aria-label="엔진 부채꼴">
        <defs>
          <radialGradient id="rf-core"><stop offset="0%" stopColor="#f5d0fe" /><stop offset="100%" stopColor="#f5d0fe00" /></radialGradient>
        </defs>
        <circle cx={cx} cy={cy} r={26} fill="url(#rf-core)" />
        <circle cx={cx} cy={cy} r={6} fill="#fdf4ff" />
        {session.engines.map((e, i) => {
          // 부채꼴이 칸 안에 들게 — 각도 ±0.55rad · 길이 70~260 · 라벨 자리(오른쪽 130px)를 남긴다.
          const a = n === 1 ? 0 : (-0.55 + (1.1 * i) / (n - 1));
          const len = Math.min(e.done ? 70 + (e.hits / top) * 190 : 90, (H / 2 - 14) / Math.max(0.2, Math.abs(Math.sin(a))), W - cx - 140);
          const x2 = cx + Math.cos(a) * len; const y2 = cy + Math.sin(a) * len;
          const c = e.error ? '#fb7185' : engineColor(e.id);
          return (
            <g key={e.id} data-trace-research-engine={e.id}>
              <line x1={cx} y1={cy} x2={x2} y2={y2} stroke={c} strokeWidth={e.done ? 2.5 : 1.5} strokeDasharray={e.done ? '400' : '4 4'}
                style={{ animation: e.done ? 'rf-grow .8s ease-out both' : 'rf-pulse 1.2s ease-in-out infinite', filter: `drop-shadow(0 0 5px ${c})` }} />
              <circle cx={x2} cy={y2} r={e.done ? 4 + Math.min(8, e.hits) : 3} fill={c} style={{ filter: `drop-shadow(0 0 8px ${c})` }} />
              <text x={x2 + 8} y={y2 + 3} fill={c} fontSize={13} fontFamily="ui-monospace, monospace">
                {e.id} {e.error ? '오류' : e.done ? `${e.hits}건` : '…'}{e.ms !== null ? ` · ${(e.ms / 1000).toFixed(1)}s` : ''}
              </text>
            </g>
          );
        })}
      </svg>
      <p className="line-clamp-2 px-1 text-[11px] text-slate-200" title={session.question}>«{session.question}»</p>
      {shareTotal > 0 && (
        <div className="mt-1 flex h-2 overflow-hidden rounded-full" aria-label="출처 비" data-trace-research-share>
          {Object.entries(session.share).map(([id, k]) => <span key={id} style={{ width: `${(k / shareTotal) * 100}%`, background: engineColor(id) }} title={`${id} ${k}`} />)}
        </div>
      )}
      {session.sources.length > 0 && (
        <ul className="mt-1 flex flex-wrap gap-1 font-mono text-[11px] lg:text-[10px]" aria-label="인용 후보">
          {session.sources.slice(0, 8).map((s, i) => (
            <li key={`${s.url}-${i}`} className="rounded px-1.5 py-0.5" style={{ color: engineColor(s.engine), background: `${engineColor(s.engine)}1a`, textDecoration: s.merged ? 'line-through' : undefined }} title={`${s.url}${s.merged ? ' (중복 합침)' : ''}`}>
              {s.host}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
