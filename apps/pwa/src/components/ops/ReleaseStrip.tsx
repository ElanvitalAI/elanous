'use client';

import type { OpsResult, ReleaseRun } from '@/lib/ops-api';

// The release graph ledger writes 'done' | 'failed' | 'running' (10-06 tally: done 13 · failed 36 · running 9); keep the generic words too.
const FINISHED = new Set(['done', 'completed', 'success', 'succeeded', 'failed', 'error', 'cancelled', 'aborted']);
const BLOCKED = /fail|error|block|stall|cancel|abort/i;
const DAY = 24 * 60 * 60 * 1000;

export function latestReleaseRun(result: OpsResult<ReleaseRun[]> | null, now: number): ReleaseRun | null {
  if (result?.kind !== 'ready') return null;
  const latest = result.data.reduce<ReleaseRun | null>((best, run) =>
    !best || Date.parse(run.startedAt) > Date.parse(best.startedAt) ? run : best, null);
  if (!latest || (FINISHED.has(latest.status.toLowerCase()) && now - Date.parse(latest.startedAt) > DAY)) return null;
  return latest;
}

export function ReleaseStrip({ result, onSelect, selectedRun, now = Date.now() }: {
  result: OpsResult<ReleaseRun[]> | null;
  onSelect: (run: ReleaseRun) => void;
  selectedRun?: ReleaseRun | null;
  now?: number;
}): React.ReactNode {
  const run = selectedRun === undefined ? latestReleaseRun(result, now) : selectedRun;
  if (!run) return null;
  const index = Math.max(0, run.path.findIndex((id) => run.nodes.find((node) => node.nodeId === id)?.ok !== true));
  const currentIndex = run.path.length > 0 && run.path.every((id) => run.nodes.find((node) => node.nodeId === id)?.ok === true)
    ? run.path.length - 1 : index;
  const id = run.path[currentIndex];
  const current = run.nodes.find((node) => node.nodeId === id);
  const doneWithFailedNode = run.status.toLowerCase() === 'done' && current?.ok === false;
  const blocked = !doneWithFailedNode && (current?.ok === false || BLOCKED.test(run.status));
  const summary = blocked ? current?.summary.split(/\r?\n/, 1)[0]?.trim() : null;
  const elapsed = Math.max(0, Math.floor((now - Date.parse(run.startedAt)) / 60_000));
  return <section aria-label="발행 진행" className="min-w-0 rounded-2xl border bg-card p-3 text-foreground">
    <button type="button" onClick={() => onSelect(run)} className="flex w-full min-w-0 items-center gap-2 text-left text-sm hover:text-primary">
      <span className="shrink-0 whitespace-nowrap font-semibold">발행 {run.version ?? '판 미상'}</span>
      <span className="shrink-0 whitespace-nowrap">· {id ?? '노드 미상'} ({run.path.length ? currentIndex + 1 : 0}/{run.path.length})</span>
      <span className="shrink-0 whitespace-nowrap">· 경과 {Number.isFinite(elapsed) ? elapsed : 0}분</span>
      <span className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap" aria-label="발행 노드 순서">
        {run.path.map((nodeId, position) => {
          const node = run.nodes.find((entry) => entry.nodeId === nodeId);
          return <span key={`${nodeId}-${position}`} aria-current={position === currentIndex ? 'step' : undefined}
            className={`mr-1 inline-block rounded-full border px-2 py-0.5 ${position === currentIndex ? 'border-primary bg-primary/10 font-semibold' : position > currentIndex ? 'opacity-50' : ''}`}>
            {position < currentIndex ? node?.ok === true ? '✓ ' : node?.ok === false ? '✗ ' : '' : ''}{nodeId}
          </span>;
        })}
      </span>
    </button>
    <p className="mt-1 text-xs text-muted-foreground">상태: {run.status}</p>
    {doneWithFailedNode && <p role="status" className="truncate text-sm text-amber-700 dark:text-amber-400">경고: 노드 실패 보고 · 런은 끝남</p>}
    {summary && <p role="alert" className="truncate text-sm text-red-600 dark:text-red-400">막힘: {summary}</p>}
  </section>;
}
