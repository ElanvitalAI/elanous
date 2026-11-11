'use client';

import dagre from '@dagrejs/dagre';

/** The JSON v1 projection owned by plugins/graph-instance-view, as defined by R-SURFACE. */
export interface GraphInstanceView {
  schemaVersion: 1;
  instance: { source: 'harness' | 'graph' | 'release' | 'resource'; runId: string; graphId?: string; title: string; observedAt: string; state: 'running' | 'waiting' | 'done' | 'failed' | 'unknown' };
  nodes: Array<{ id: string; label: string; model?: string; role?: string; state: 'queued' | 'running' | 'waiting' | 'done' | 'failed' | 'unknown' | 'on' | 'off' | 'stopped';
    resource?: { hostKind: 'local' | 'cloud'; cpuCores?: number; loadavg?: [number, number, number]; memory?: { usedBytes: number; totalBytes: number };
      tasks: Array<{ kind: 'seat' | 'pod' | 'train' | 'gate' | 'rehearsal' | 'review'; label: string }> };
    progress?: { done: number; total: number } }>;
  edges: Array<{ id: string; from: string; to: string; kind: 'flow' | 'branch' | 'join'; state: 'planned' | 'taken' | 'unknown' }>;
  progress: { completed: number; total: number | null; activeNodeIds: string[]; label?: string };
  logs: Array<{ seq: number; at?: string; nodeId?: string; level: 'info' | 'warn' | 'error'; text: string }>;
  statusLine: string;
  readState: 'ok' | 'partial' | 'unavailable';
}

// Source: 내부 문서 `graph-instance-rich-sidetab` JSON v1; these are display dimensions only.
const NODE_WIDTH = 184;
const NODE_HEIGHT = 92;
const EDGE_MARGIN = 22;

const STATE_TEXT: Record<GraphInstanceView['nodes'][number]['state'], string> = {
  queued: '대기열', running: '진행 중', waiting: '승인 대기', done: '완료', failed: '실패', unknown: '기록 없음',
  on: '켜짐', off: '꺼짐', stopped: '정지',
};

const RESOURCE_DOT: Record<'on' | 'off' | 'stopped', string> = {
  on: 'bg-green-500', off: 'bg-gray-400', stopped: 'bg-red-500',
};

function ResourceNode({ node }: { node: GraphInstanceView['nodes'][number] }) {
  const resource = node.resource;
  const state = node.state === 'on' || node.state === 'off' || node.state === 'stopped' ? node.state : null;
  const load = resource?.loadavg?.[0];
  const memory = resource?.memory;
  return <article data-node-id={node.id} data-node-state={node.state} className="space-y-2 rounded-lg border border-border bg-background p-3">
    <div className="flex items-center gap-2">
      <span aria-hidden="true" className={`h-2.5 w-2.5 rounded-full ${state ? RESOURCE_DOT[state] : 'bg-gray-400'}`} />
      <h3 className="font-semibold">{node.label}</h3>
      <span className="ml-auto text-xs text-text-secondary">{state ? STATE_TEXT[state] : STATE_TEXT[node.state]}</span>
    </div>
    <p className="text-xs text-text-tertiary">{resource?.hostKind === 'cloud' ? '클라우드 VM' : '로컬 컴퓨터'}</p>
    <div className="space-y-1 text-xs">
      {state === 'on' && load !== undefined && resource?.cpuCores ? <label className="block">부하 1분 {load.toFixed(2)} / {resource.cpuCores}코어
        <progress aria-label={`${node.label} 부하`} value={load} max={resource.cpuCores} className="block w-full" />
      </label> : <p>부하 기록 없음</p>}
      {state === 'on' && memory && memory.totalBytes > 0 ? <label className="block">메모리 {Math.round(memory.usedBytes / memory.totalBytes * 100)}%
        <progress aria-label={`${node.label} 메모리`} value={memory.usedBytes} max={memory.totalBytes} className="block w-full" />
      </label> : <p>메모리 기록 없음</p>}
    </div>
    {resource?.tasks.length ? <ul aria-label={`${node.label} 작업`} className="space-y-1 text-xs">
      {resource.tasks.map((task, index) => <li key={`${task.kind}:${task.label}:${index}`}>{task.kind} · {task.label}</li>)}
    </ul> : <p className="text-xs text-text-tertiary">작업 기록 없음</p>}
  </article>;
}

function graphLayout(view: GraphInstanceView) {
  const graph = new dagre.graphlib.Graph({ multigraph: true });
  graph.setGraph({ rankdir: 'LR', marginx: EDGE_MARGIN, marginy: EDGE_MARGIN, nodesep: 36, ranksep: 76 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const node of view.nodes) graph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const edge of view.edges) {
    if (graph.hasNode(edge.from) && graph.hasNode(edge.to)) graph.setEdge(edge.from, edge.to, {}, edge.id);
  }
  dagre.layout(graph);
  return graph;
}

/** Render the plugin projection unchanged: one node per ID, every declared edge, ledger-ordered logs. */
export function GraphInstanceRichView({ view }: { view: GraphInstanceView }) {
  const resource = view.instance.source === 'resource';
  const graph = resource ? null : graphLayout(view);
  const width = Math.max(graph?.graph().width ?? 0, NODE_WIDTH + EDGE_MARGIN * 2);
  const height = Math.max(graph?.graph().height ?? 0, NODE_HEIGHT + EDGE_MARGIN * 2);
  const progress = view.progress.total === null ? `${view.progress.completed}/?` : `${view.progress.completed}/${view.progress.total}`;
  return <section aria-label="그래프 인스턴스" className="space-y-4 rounded-xl border border-border bg-surface p-4">
    <header className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">{view.instance.title}</h2>
        <span className="rounded border border-border px-2 py-0.5 text-xs">{view.instance.source}</span>
        <span className="text-xs text-text-secondary">{view.instance.state}</span>
      </div>
      <p className="break-all font-mono text-xs text-text-tertiary">{view.instance.graphId ? `${view.instance.graphId} · ` : ''}{view.instance.runId}</p>
      {view.readState !== 'ok' && <p role="status" className="text-sm text-warning">원장 읽기 {view.readState === 'partial' ? '일부만 가능' : '불가'} · 현재 상태를 확인해 주세요.</p>}
    </header>
    {resource ? <div aria-label="자원 현황" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {view.nodes.map(node => <ResourceNode key={node.id} node={node} />)}
    </div> : <div className="overflow-x-auto rounded-lg border border-border bg-background p-2" aria-label="그래프 노드와 간선">
      <svg role="img" aria-label={`${view.nodes.length}개 노드와 ${view.edges.length}개 간선`} viewBox={`0 0 ${width} ${height}`} width={width} height={height} className="max-w-none">
        <defs><marker id="instance-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8" fill="none" stroke="currentColor" /></marker></defs>
        {view.edges.map(edge => {
          const points = graph?.edge({ v: edge.from, w: edge.to, name: edge.id })?.points as Array<{ x: number; y: number }> | undefined;
          if (!points?.length) return null;
          const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x} ${point.y}`).join(' ');
          return <path key={edge.id} data-edge-id={edge.id} data-edge-state={edge.state} data-edge-kind={edge.kind} d={path} fill="none"
            stroke="currentColor" strokeWidth={edge.state === 'taken' ? 2.5 : 1.5} opacity={edge.state === 'taken' ? 1 : 0.45}
            strokeDasharray={edge.state === 'planned' ? '5 4' : undefined} markerEnd="url(#instance-arrow)" />;
        })}
        {view.nodes.map(node => {
          const position = graph?.node(node.id) as { x: number; y: number } | undefined;
          if (!position) return null;
          const x = position.x - NODE_WIDTH / 2;
          const y = position.y - NODE_HEIGHT / 2;
          return <g key={node.id} data-node-id={node.id} data-node-state={node.state} transform={`translate(${x} ${y})`}>
            <rect width={NODE_WIDTH} height={NODE_HEIGHT} rx="8" fill="var(--background, white)" stroke="currentColor" strokeWidth={node.state === 'running' ? 2.5 : 1} />
            <text x="10" y="22" className="fill-current text-xs font-semibold">{node.label}</text>
            <text x="10" y="43" className="fill-current text-[11px]">{[node.role, node.model].filter(Boolean).join(' · ') || '역할·모델 기록 없음'}</text>
            <text x="10" y="64" className="fill-current text-[11px]">{STATE_TEXT[node.state]}{node.progress ? ` · ${node.progress.done}/${node.progress.total}` : ''}</text>
          </g>;
        })}
      </svg>
    </div>}
    <div aria-label="진행" className="text-sm">{view.progress.label ?? '진행'} {progress}{view.progress.activeNodeIds.length ? ` · ${view.progress.activeNodeIds.join(', ')}` : ''}</div>
    <ol aria-label="세션 로그" className="max-h-40 space-y-1 overflow-y-auto text-xs">
      {view.logs.map(log => <li key={log.seq} data-log-seq={log.seq} data-log-level={log.level} className="break-words">
        <span className="font-mono text-text-tertiary">#{log.seq}{log.at ? ` · ${log.at}` : ''}</span> {log.nodeId ? `${log.nodeId} · ` : ''}{log.text}
      </li>)}
    </ol>
    <p role="status" className="border-t border-border pt-2 text-sm">{view.statusLine}</p>
  </section>;
}
