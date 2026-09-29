'use client';

// Trace 시간 축(RFC v6 §4 «시간 축 브러시 — 구간을 긁으면 창이 그 구간으로 · 그래프·표·로그가 같이 바뀜»).
// L1 = 런마다 첫 신호 → 마지막 신호 막대 ⊕ d3-brush(긁으면 렌즈에 `시간` 칸이 쌓인다) · L2 = 단계 간트.
// ⛔ d3 는 마운트 뒤에만 붙인다.

import { useEffect, useRef } from 'react';
import { brushX } from 'd3-brush';
import { select } from 'd3-selection';
import { LIVE_STAGE_LABEL, type LiveStage } from '@/lib/live-signals';
import type { TraceRun } from '@/lib/trace-model';

const STATUS_FILL: Record<TraceRun['status'], string> = { running: '#818cf8', landed: '#4ade80', blocked: '#fb7185', quiet: '#64748b' };
const TONE_FILL = { ok: '#4ade80', bad: '#fb7185', info: '#818cf8' } as const;

function axisTicks(lo: number, hi: number, n = 6): number[] {
  if (hi <= lo) return [lo];
  const step = (hi - lo) / n;
  return Array.from({ length: n + 1 }, (_, i) => lo + i * step);
}
const hm = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });

/** L1 — 런 막대 ⊕ 브러시. */
export function RunTimeline({ runs, lo, hi, range, onBrush }: { runs: TraceRun[]; lo: number; hi: number; range?: { from: number; to: number }; onBrush: (r: { from: number; to: number } | null) => void }) {
  const ref = useRef<SVGSVGElement | null>(null);
  const W = 1000; const ROW = 7; const top = 4; // 눈금 글자는 HTML 로 옮겼다 — 위 여백만
  const shown = runs.slice(0, 40);
  const H = top + shown.length * ROW + 6;
  const x = (t: number) => ((t - lo) / Math.max(1, hi - lo)) * W;
  const cb = useRef(onBrush);
  cb.current = onBrush;
  useEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    const g = select(svg).select<SVGGElement>('g[data-brush]');
    const b = brushX<unknown>().extent([[0, 0], [W, H]]).on('end', (e) => {
      if (!e.sourceEvent) return; // 코드로 옮긴 것은 무시
      if (!e.selection) { cb.current(null); return; }
      const [a, z] = e.selection as [number, number];
      cb.current({ from: lo + (a / W) * (hi - lo), to: lo + (z / W) * (hi - lo) });
    });
    g.call(b as never);
    if (range) g.call(b.move as never, [x(range.from), x(range.to)]);
    return () => { g.on('.brush', null); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lo, hi, H, range?.from, range?.to]);
  return (
    <div className="relative">
    {/* 눈금 글자는 SVG «밖»(HTML)에 둔다 — 이 SVG 는 preserveAspectRatio=none 으로 늘어나 SVG 글자가 4px 로 짓눌렸다(09-28 실측). */}
    <div className="pointer-events-none relative h-4 font-mono text-[11px] text-slate-500" aria-hidden data-trace-timeline-ticks>
      {axisTicks(lo, hi).map((t, i, all) => (
        <span key={t} className="absolute top-0" style={{ left: `${(x(t) / W) * 100}%`, transform: i === all.length - 1 ? 'translateX(-100%)' : i === 0 ? undefined : 'translateX(-50%)' }}>{hm(t)}</span>
      ))}
    </div>
    <svg ref={ref} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-32 w-full rounded-md bg-slate-950/60" data-trace-timeline aria-label="런 시간 축 — 끌어서 구간 고르기">
      {axisTicks(lo, hi).map((t) => (
        <line key={t} x1={x(t)} x2={x(t)} y1={0} y2={H} stroke="#1e293b" strokeDasharray="2 3" />
      ))}
      {shown.map((r, i) => {
        const a = x(Date.parse(r.firstTs)); const z = Math.max(a + 2, x(Date.parse(r.lastTs)));
        return <rect key={r.runId} x={a} y={top + i * ROW} width={z - a} height={ROW - 2} rx={1.5} fill={STATUS_FILL[r.status]} opacity={0.85} data-trace-timeline-run={r.runId} />;
      })}
      <g data-brush />
    </svg>
    </div>
  );
}

/** L2 — 단계 간트(단계마다 처음 → 마지막 신호). */
export function StageGantt({ bars }: { bars: Array<{ stage: LiveStage; start: number; end: number; tone: 'ok' | 'bad' | 'info' }> }) {
  if (bars.length === 0) return <p className="text-xs text-muted-foreground">이 런의 단계 신호가 없다.</p>;
  const lo = Math.min(...bars.map((b) => b.start));
  const hi = Math.max(...bars.map((b) => b.end), lo + 60_000);
  const W = 1000; const ROW = 16;
  const x = (t: number) => 90 + ((t - lo) / (hi - lo)) * (W - 100);
  return (
    <svg viewBox={`0 0 ${W} ${bars.length * ROW + 16}`} className="w-full rounded-md bg-slate-950/60" data-trace-gantt aria-label="단계 간트">
      {bars.map((b, i) => (
        <g key={b.stage}>
          <text x={4} y={14 + i * ROW} fill="#cbd5e1" fontSize={11}>{LIVE_STAGE_LABEL[b.stage]}</text>
          <rect x={x(b.start)} y={4 + i * ROW} width={Math.max(3, x(b.end) - x(b.start))} height={ROW - 5} rx={2} fill={TONE_FILL[b.tone]} opacity={0.85} />
          <text x={Math.max(x(b.end), x(b.start) + 3) + 4} y={14 + i * ROW} fill="#64748b" fontSize={9} fontFamily="monospace">{Math.round((b.end - b.start) / 60_000)}분</text>
        </g>
      ))}
      <text x={90} y={bars.length * ROW + 13} fill="#64748b" fontSize={9} fontFamily="monospace">{hm(lo)}</text>
      <text x={W - 4} y={bars.length * ROW + 13} fill="#64748b" fontSize={9} fontFamily="monospace" textAnchor="end">{hm(hi)}</text>
    </svg>
  );
}
