'use client';

import type { OpsResult, ReleaseNode, ReleaseRun } from '@/lib/ops-api';
import { GateShardsPanel, shardTally } from './GateShards';

/** 노드 하나의 자리 — 색과 «글자»를 같이 낸다(색만으로 가르지 않는다). */
export type NodeState = 'done' | 'failed' | 'current' | 'pending';

export const NODE_STATE: Record<NodeState, { mark: string; word: string; chip: string; dot: string }> = {
  done: { mark: '✓', word: '끝남', chip: 'border-emerald-600/50 bg-emerald-600/10', dot: 'bg-emerald-600 text-white' },
  failed: { mark: '✗', word: '실패', chip: 'border-red-600/60 bg-red-600/10', dot: 'bg-red-600 text-white' },
  current: { mark: '●', word: '지금', chip: 'border-primary bg-primary/10 ring-2 ring-primary/30', dot: 'bg-primary text-primary-foreground' },
  pending: { mark: '○', word: '남음', chip: 'border-border border-dashed bg-muted/30', dot: 'bg-muted text-muted-foreground' },
};

export function currentNodeId(run: ReleaseRun): string | undefined {
  const current = run.path.find((id) => run.nodes.find((node) => node.nodeId === id)?.ok === null);
  return current ?? run.path.at(-1);
}

/** 원장 상태값 실측: done · failed · running — 끝난 런엔 «지금»이 없다. */
const FINISHED = /^(done|completed|success|succeeded|failed|error|cancelled|aborted)$/i;

export function nodeState(run: ReleaseRun, nodeId: string): NodeState {
  const node = run.nodes.find((entry) => entry.nodeId === nodeId);
  if (node?.ok === true) return 'done';
  if (node?.ok === false) return 'failed';
  const current = run.path.find((id) => run.nodes.find((entry) => entry.nodeId === id)?.ok !== true);
  return current === nodeId && !FINISHED.test(run.status) ? 'current' : 'pending';
}

/** summary 문자열에서 «샤드 n/m» 만 읽는다 — 못 읽으면 null(생략). */
export function shardProgress(summary: string): { done: number; total: number } | null {
  const match = /(?:샤드|shards?)\D{0,8}?(\d+)\s*\/\s*(\d+)/i.exec(summary) ?? /(\d+)\s*\/\s*(\d+)\s*(?:샤드|shards?)/i.exec(summary);
  if (!match) return null;
  const done = Number(match[1]);
  const total = Number(match[2]);
  return total > 0 && done <= total ? { done, total } : null;
}

const validTime = (value: string | null | undefined): value is string => !!value && Number.isFinite(Date.parse(value));
const clock = (iso: string) => new Date(iso).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** 노드 시각(GRAPH-NODE-TIMES 가 넣을 옵션 필드) — 없으면 «시각 미기록». */
export function nodeTime(node: ReleaseNode | undefined, now: number): string {
  if (!validTime(node?.startedAt)) return '시각 미기록';
  const end = validTime(node.endedAt) ? Date.parse(node.endedAt) : now;
  const minutes = Math.max(0, Math.round((end - Date.parse(node.startedAt)) / 60_000));
  return `${clock(node.startedAt)}${validTime(node.endedAt) ? `–${clock(node.endedAt)}` : ' 시작'} · ${minutes}분`;
}

export function ReleaseFlow({ run, openedNodeId, onNode, now = Date.now() }: {
  run: ReleaseRun;
  openedNodeId: string | null;
  onNode: (nodeId: string) => void;
  now?: number;
}): React.ReactNode {
  const states = run.path.map((id) => nodeState(run, id));
  const tally = (['done', 'failed', 'current', 'pending'] as const).map((state) => [state, states.filter((value) => value === state).length] as const);
  return <div className="min-w-0 space-y-3">
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted" role="img"
      aria-label={`노드 ${run.path.length}개 중 ${tally.map(([state, n]) => `${NODE_STATE[state].word} ${n}`).join(' · ')}`}>
      {states.map((state, index) => <span key={index} className={`h-full flex-1 border-r border-background last:border-0 ${NODE_STATE[state].dot}`} />)}
    </div>
    <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {tally.map(([state, n]) => <span key={state}>{NODE_STATE[state].mark} {NODE_STATE[state].word} {n}</span>)}
    </p>
    <ol aria-label="노드 흐름" className="flex min-w-0 flex-col gap-0 md:flex-row md:flex-wrap md:items-stretch md:gap-y-3">
      {run.path.map((id, index) => {
        const node = run.nodes.find((entry) => entry.nodeId === id);
        const state = states[index]!;
        const look = NODE_STATE[state];
        const gate = id === 'gate' && state === 'current' ? run.gateShards : undefined;
        const shard = !gate && node ? shardProgress(node.summary) : null;
        const open = openedNodeId === id;
        return <li key={`${id}-${index}`} data-node-state={state} className="flex min-w-0 flex-col md:flex-row md:items-center">
          <button type="button" aria-expanded={open} aria-controls="release-node-detail" aria-current={state === 'current' ? 'step' : undefined}
            onClick={() => onNode(id)}
            className={`flex w-full min-w-0 items-start gap-2 rounded-lg border p-2.5 text-left transition-colors hover:bg-muted md:w-52 ${look.chip} ${open ? 'outline outline-2 outline-offset-2 outline-primary' : ''}`}>
            <span aria-hidden className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${look.dot}`}>{look.mark}</span>
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-baseline gap-1.5">
                <span className="text-[11px] tabular-nums text-muted-foreground">{index + 1}</span>
                <span className="min-w-0 truncate font-medium" title={id}>{id}</span>
              </span>
              <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs">
                <span className="font-semibold">{look.word}</span>
                <span className="text-muted-foreground">{nodeTime(node, now)}</span>
              </span>
              {gate && <span className="mt-1 block text-xs tabular-nums">{shardTally(gate)}</span>}
              {shard && <span className="mt-1 block text-xs" aria-label={`샤드 ${shard.done}/${shard.total}`}>
                <span className="tabular-nums">{`샤드 ${shard.done}/${shard.total}`}</span>
                <span aria-hidden className="mt-0.5 block h-1 overflow-hidden rounded-full bg-muted">
                  <span className="block h-full bg-current" style={{ width: `${Math.round(shard.done / shard.total * 100)}%` }} />
                </span>
              </span>}
            </span>
          </button>
          {index < run.path.length - 1 && <span aria-hidden className="mx-auto h-3 w-px bg-border md:mx-1 md:h-px md:w-3" />}
        </li>;
      })}
    </ol>
  </div>;
}

export function ReleaseNodeDetail({ run, nodeId, log, now = Date.now() }: {
  run: ReleaseRun;
  nodeId: string;
  log: OpsResult<{ log: string }> | null;
  now?: number;
}): React.ReactNode {
  const node = run.nodes.find((entry) => entry.nodeId === nodeId);
  const state = nodeState(run, nodeId);
  const look = NODE_STATE[state];
  const [first = '', ...rest] = (node?.summary ?? '').split(/\r?\n/);
  const logLines = log?.kind === 'ready' ? log.data.log.split(/\r?\n/) : [];
  const failedLine = state === 'failed' ? logLines.findIndex((line) => /fail|error|✗|❌|실패/i.test(line)) : -1;
  return <section id="release-node-detail" aria-label="노드 상세" className="min-w-0 space-y-3 rounded-xl border bg-card p-3 sm:p-4">
    <header className="flex min-w-0 flex-wrap items-center gap-2">
      <span aria-hidden className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${look.dot}`}>{look.mark}</span>
      <h3 className="min-w-0 break-all font-semibold">{nodeId}</h3>
      <span className="rounded-full border px-2 py-0.5 text-xs font-semibold">{look.word}</span>
      <span className="text-xs text-muted-foreground">{nodeTime(node, now)}</span>
    </header>
    <div className="min-w-0 space-y-1">
      <h4 className="text-xs font-medium text-muted-foreground">요약</h4>
      {node?.summary
        ? <div className="min-w-0 break-words text-sm">
            <p className={state === 'failed' ? 'font-semibold text-red-700 dark:text-red-400' : ''} {...(state === 'failed' ? { role: 'alert' } : {})}>{first}</p>
            {rest.length > 0 && <p className="whitespace-pre-wrap text-muted-foreground">{rest.join('\n')}</p>}
          </div>
        : <p className="text-sm text-muted-foreground">요약 없음</p>}
    </div>
    {nodeId === 'gate' && state === 'current' && run.gateShards && <GateShardsPanel gate={run.gateShards} />}
    <div className="min-w-0 space-y-1">
      <h4 className="text-xs font-medium text-muted-foreground">로그 꼬리</h4>
      {log?.kind === 'ready'
        ? <pre className="max-h-80 max-w-full overflow-auto whitespace-pre rounded-md bg-muted/50 p-2 font-mono text-xs" aria-label="노드 로그">{logLines.map((line, index) =>
            <span key={index} className={index === failedLine ? 'block bg-red-600/15 font-semibold text-red-700 dark:text-red-300' : 'block'}>{line || ' '}</span>)}</pre>
        : <p role="status" className="text-sm">{log?.kind === 'error' ? `로그를 불러오지 못했습니다 (${log.status})` : '로그를 불러오는 중…'}</p>}
    </div>
  </section>;
}
