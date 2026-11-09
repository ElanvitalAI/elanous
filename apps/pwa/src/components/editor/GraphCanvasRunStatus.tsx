'use client';

import { useMemo } from 'react';
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps, type NodeTypes } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { layeredPositions } from '@/lib/graph-edge-route';

export type GraphRunNodeState = 'pending' | 'running' | 'done' | 'failed';
export interface GraphRunGraph {
  nodes: Array<{ nodeId: string; kind: string; needs: string[] }>;
}
export interface GraphRunNodeStatus {
  nodeId: string; kind?: string; state: GraphRunNodeState; time: string; summary?: string;
}

interface RunCardData extends Record<string, unknown> {
  nodeId: string; kind: string; state: GraphRunNodeState; time: string; summary?: string;
  onSelect?: (nodeId: string) => void;
}

const STATE: Record<GraphRunNodeState, { label: string; mark: string; classes: string }> = {
  pending: { label: '대기', mark: '○', classes: 'border-border border-dashed bg-muted/30 text-muted-foreground' },
  running: { label: '실행 중', mark: '●', classes: 'border-primary bg-primary/10 text-primary ring-2 ring-primary/30' },
  done: { label: '완료', mark: '✓', classes: 'border-emerald-600/50 bg-emerald-600/10 text-emerald-700 dark:text-emerald-300' },
  failed: { label: '실패', mark: '✗', classes: 'border-red-600/60 bg-red-600/10 text-red-700 dark:text-red-300' },
};

function RunStatusNode({ data }: NodeProps) {
  const node = data as RunCardData;
  const state = STATE[node.state];
  return <div className="relative w-[210px]">
    <Handle type="target" position={Position.Left} isConnectable={false} aria-hidden className="!h-2 !w-2 !border-border !bg-muted-foreground" />
    <button type="button" data-testid={`release-graph-node-${node.nodeId}`} data-run-status={node.state}
      onClick={() => node.onSelect?.(node.nodeId)} disabled={!node.onSelect}
      className={`w-full rounded-lg border p-2.5 text-left shadow-sm disabled:cursor-default ${state.classes}`}>
      <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
        <span>{node.kind}</span><span className="ml-auto font-semibold">{state.mark} {state.label}</span>
      </span>
      <span className="mt-1 block truncate font-mono text-xs font-semibold text-foreground" title={node.nodeId}>{node.nodeId}</span>
      <span className="mt-1 block text-[10px] text-muted-foreground">{node.time}</span>
      {node.summary && <span className="mt-1 block truncate text-[10px] text-muted-foreground" title={node.summary}>{node.summary}</span>}
    </button>
    <Handle type="source" position={Position.Right} isConnectable={false} aria-hidden className="!h-2 !w-2 !border-border !bg-muted-foreground" />
  </div>;
}

const NODE_TYPES: NodeTypes = { runStatus: RunStatusNode };
const CARD = { width: 210, height: 82 } as const;

/** Read-only, run-source-agnostic graph canvas. Release and future app deploy runs pass the same graph/status shape. */
export function GraphCanvasRunStatus({ graph, statuses, onNode }: {
  graph: GraphRunGraph;
  statuses: GraphRunNodeStatus[];
  onNode?: (nodeId: string) => void;
}): React.ReactNode {
  const flow = useMemo(() => {
    const unique = new Map<string, GraphRunGraph['nodes'][number]>();
    for (const node of graph.nodes) if (node.nodeId && !unique.has(node.nodeId)) unique.set(node.nodeId, node);
    const defs = [...unique.values()];
    const known = new Set(defs.map((node) => node.nodeId));
    const dependencyEdges = defs.flatMap((node) => node.needs.filter((need) => known.has(need) && need !== node.nodeId)
      .map((need) => ({ from: need, to: node.nodeId, outcome: '' })));
    const positions = layeredPositions(defs.map((node) => ({ id: node.nodeId, ...CARD })), dependencyEdges,
      { entry: defs[0]?.nodeId, flow: 'horizontal' });
    const byId = new Map(statuses.map((status) => [status.nodeId, status]));
    const nodes: Node<RunCardData>[] = defs.map((def) => {
      const status = byId.get(def.nodeId);
      return { id: def.nodeId, type: 'runStatus', position: positions.get(def.nodeId) ?? { x: 0, y: 0 },
        data: { nodeId: def.nodeId, kind: status?.kind ?? def.kind, state: status?.state ?? 'pending',
          time: status?.time ?? '시각 미기록', ...(status?.summary ? { summary: status.summary } : {}), onSelect: onNode } };
    });
    const edges: Edge[] = dependencyEdges.map((edge, index) => ({ id: `needs-${index}-${edge.from}-${edge.to}`,
      source: edge.from, target: edge.to, label: 'needs', type: 'smoothstep',
      markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: 'var(--muted-foreground)', strokeWidth: 1.5 },
      labelStyle: { fill: 'var(--muted-foreground)', fontSize: 10 }, labelBgStyle: { fill: 'var(--background)' } }));
    return { nodes, edges };
  }, [graph, statuses, onNode]);

  return <section aria-label="릴리스 의존성 그래프" className="h-[62vh] min-h-[420px] max-h-[760px] min-w-0 overflow-hidden rounded-lg border bg-background">
    {flow.nodes.length === 0 ? <p className="p-4 text-sm text-muted-foreground">그래프 노드가 없습니다.</p> :
      <ReactFlow nodes={flow.nodes} edges={flow.edges} nodeTypes={NODE_TYPES} fitView fitViewOptions={{ padding: 0.12, minZoom: 0.3, maxZoom: 1.1 }}
        nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} edgesReconnectable={false}
        nodesFocusable={false} edgesFocusable={false} minZoom={0.2} maxZoom={1.4} className="!bg-background">
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>}
  </section>;
}
