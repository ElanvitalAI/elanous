'use client';

import type { GateShard, GateShards, GateShardState } from '@/lib/ops-api';

/** 조각 상태 — 색과 «글자»를 같이 낸다(색만으로 가르지 않는다). 순서 = 사람이 먼저 봐야 할 것부터. */
export const SHARD_LOOK: Record<GateShardState, { word: string; mark: string; cell: string }> = {
  failed: { word: '실패', mark: '✗', cell: 'border-red-600/60 bg-red-600/15 text-red-800 dark:text-red-300' },
  timeout: { word: '잘림', mark: '✂', cell: 'border-orange-600/60 bg-orange-500/15 text-orange-800 dark:text-orange-300' },
  retry: { word: '재시도', mark: '↻', cell: 'border-amber-600/60 bg-amber-500/15 text-amber-800 dark:text-amber-300' },
  pending: { word: '대기', mark: '○', cell: 'border-dashed border-border bg-muted/40 text-muted-foreground' },
  running: { word: '돌기', mark: '●', cell: 'border-primary bg-primary/10 text-foreground' },
  done: { word: '통과', mark: '✓', cell: 'border-emerald-600/50 bg-emerald-600/10 text-emerald-800 dark:text-emerald-300' },
};
const ORDER = Object.keys(SHARD_LOOK) as GateShardState[];

export function etaText(etaMin: number | null, opts: { overrunMin?: number; open?: number } = {}): string {
  // 계획을 넘겨 도는 조각이 있으면 추정은 «하한»일 뿐 — 0분이라고 말하지 않는다(canary 10-07: 계획 0.1분 · 실제 22분).
  if ((opts.overrunMin ?? 0) >= 1) return `계획보다 ${opts.overrunMin}분 넘게 도는 중 — 남은 시간 추정 불가`;
  if (etaMin === null) return '남은 시간 추정 불가(계획 분 없음)';
  if (etaMin === 0) return opts.open ? '곧 끝남(계획상)' : '남은 조각 없음';
  return etaMin >= 60 ? `남은 약 ${Math.floor(etaMin / 60)}시간 ${etaMin % 60}분` : `남은 약 ${etaMin}분`;
}

/** 노드 칩 안의 한 줄 — «조각 24 · 돌기 5 · 대기 8 · 잘림 2 · 통과 9». */
export function shardTally(gate: GateShards): string {
  const counts = gate.summary.counts;
  return [`조각 ${gate.summary.total}`, ...ORDER.filter((s) => counts[s] > 0).map((s) => `${SHARD_LOOK[s].word} ${counts[s]}`)].join(' · ');
}

function shardTitle(shard: GateShard): string {
  const bits = [`${shard.id} · ${SHARD_LOOK[shard.state].word}`];
  if (shard.waitReason) bits.push(`대기 이유: ${shard.waitReason}`);
  if (shard.rc !== undefined) bits.push(`rc ${shard.rc}`);
  if (shard.installSec !== undefined) bits.push(`설치 ${shard.installSec}초`);
  if (shard.plannedMin !== undefined) bits.push(`계획 ${shard.plannedMin}분`);
  return bits.join(' · ');
}

/** 게이트 노드 상세 — 조각 상태 표 · 대기 이유 · 남은 시간 추정. kubectl 없이 «왜 안 끝나나»를 읽게. */
export function GateShardsPanel({ gate }: { gate: GateShards }): React.ReactNode {
  const { summary } = gate;
  const shards = [...gate.shards].sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || a.id.localeCompare(b.id, 'en', { numeric: true }));
  return <div className="min-w-0 space-y-2" aria-label="게이트 조각">
    <h4 className="text-xs font-medium text-muted-foreground">게이트 조각</h4>
    <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
      <span className="font-semibold tabular-nums">{shardTally(gate)}</span>
      <span className="text-muted-foreground">{etaText(summary.etaMin, { overrunMin: summary.overrunMin, open: summary.counts.running + summary.counts.pending + summary.counts.retry })}</span>
      {summary.staleMin !== null && summary.staleMin >= 15
        && <span role="alert" className="font-semibold text-amber-700 dark:text-amber-400">⚠️ {summary.staleMin}분째 갱신 없음</span>}
    </p>
    {summary.waitReasons.length > 0 && <ul aria-label="대기 이유" className="space-y-0.5 text-xs">
      {summary.waitReasons.map((row) => <li key={row.reason}><span className="font-medium">대기 {row.count}</span> — {row.reason}</li>)}
    </ul>}
    <ol aria-label="조각 상태 표" className="grid grid-cols-4 gap-1 sm:grid-cols-6 lg:grid-cols-8">
      {shards.map((shard) => {
        const look = SHARD_LOOK[shard.state];
        return <li key={shard.id} data-shard-state={shard.state} title={shardTitle(shard)} aria-label={shardTitle(shard)}
          className={`min-w-0 rounded border px-1.5 py-1 text-[11px] leading-tight ${look.cell}`}>
          <span className="block truncate font-mono">{shard.id}</span>
          <span className="block font-semibold">{look.mark} {look.word}</span>
        </li>;
      })}
    </ol>
  </div>;
}
