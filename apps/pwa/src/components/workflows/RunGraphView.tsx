'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Background, Controls, Handle, Position, ReactFlow, type NodeProps, type NodeTypes } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useNexusClient } from '@/nexus/hooks/use-nexus-context';
import { NexusApiError, type GraphKindEntry } from '@/nexus/client';
import { runGraphToFlow, type RunGraphNodeData } from '@/lib/run-graph-flow';
import {
  CORE_GRAPH_KINDS,
  addRunGraphEdge,
  addRunGraphNode,
  readRunGraphYaml,
  removeRunGraphEdge,
  removeRunGraphNode,
  setRunGraphNodeKind,
  setRunGraphNodeRecipe,
  writeRunGraphYaml,
} from '@/lib/run-graph-yaml-edit';

const KIND_COLORS: Record<string, string> = {
  agent: '#3b82f6', gate: '#f59e0b', git: '#10b981', judge: '#a855f7',
  observe: '#06b6d4', hitl: '#f43f5e', subgraph: '#8b5cf6',
};

function RunNode({ data }: NodeProps) {
  const node = data as RunGraphNodeData;
  return (
    <div className="min-w-[190px] rounded-lg border border-border bg-surface px-3 py-2 shadow-sm"
      style={{ borderLeft: `4px solid ${KIND_COLORS[node.kind] ?? '#64748b'}`, height: node.height }}>
      {node.inputHandles.map((id, index) => (
        <Handle key={id} id={id} type="target" position={Position.Left} className="!pointer-events-none"
          style={{ top: `${((index + 1) / (node.inputHandles.length + 1)) * 100}%` }} />
      ))}
      <div className="flex items-center gap-1 text-[10px] text-text-tertiary">
        <span>{node.kind}</span>
        {node.entry && <span className="rounded bg-success/15 px-1 text-success">entry</span>}
        {node.terminal && <span className="rounded bg-accent/15 px-1 text-accent">terminal</span>}
      </div>
      <div className="font-mono text-xs font-semibold text-text-primary">{node.label}</div>
      <div className="max-w-[170px] truncate text-[10px] text-text-tertiary" title={node.recipe}>
        {node.recipe} · max {node.maxVisits}
      </div>
      {node.outcomes.length > 0 && (
        <div className="max-w-[170px] truncate text-[10px] text-text-tertiary" title={node.outcomes.join(' · ')}>
          {node.outcomes.join(' · ')}
        </div>
      )}
      {node.outputHandles.map((id, index) => (
        <Handle key={id} id={id} type="source" position={Position.Right} className="!pointer-events-none"
          style={{ top: `${((index + 1) / (node.outputHandles.length + 1)) * 100}%` }} />
      ))}
    </div>
  );
}

const NODE_TYPES: NodeTypes = { run: RunNode };
const EDGE_OPTIONS = { labelStyle: { fill: 'var(--text-primary, #334155)', fontSize: 12 }, labelBgStyle: { fill: 'var(--surface, #fff)' } };

function errorText(error: unknown): string {
  if (error instanceof NexusApiError) {
    const body = error.body as { errors?: Array<{ message?: string }>; reason?: string } | null;
    const parser = body?.errors?.map((issue) => issue.message).filter(Boolean).join(' · ');
    return parser || body?.reason || `저장 검증 실패 (${error.status})`;
  }
  return error instanceof Error ? error.message : '저장에 실패했습니다.';
}

/** Core graphs offer clone-to-edit. Mine graphs edit the document tree and save through PUT. */
export function RunGraphView({ palette: sharedPalette }: { palette?: GraphKindEntry[] } = {}) {
  const client = useNexusClient();
  const queries = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [yaml, setYaml] = useState<string | null>(null);
  const [nodeId, setNodeId] = useState('note');
  const [kind, setKind] = useState<string>(CORE_GRAPH_KINDS[0]);
  const [recipe, setRecipe] = useState('read-only');
  const [edgeFrom, setEdgeFrom] = useState('');
  const [edgeOutcome, setEdgeOutcome] = useState('pass');
  const [edgeTo, setEdgeTo] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [ignoredKeys, setIgnoredKeys] = useState<string[]>([]);
  const [validationError, setValidationError] = useState<string | null>(null);
  const list = useQuery({ queryKey: ['run-graphs'], queryFn: () => client.getRunGraphs() });
  const kinds = useQuery({
    queryKey: ['graph-kinds', 'harness'],
    queryFn: () => client.getGraphKinds('harness'),
    enabled: !sharedPalette,
    retry: false,
  });
  const palette = sharedPalette ?? (kinds.data?.kinds.length ? kinds.data.kinds : null) ?? CORE_GRAPH_KINDS.map((entry) => ({
    graph: 'harness' as const, kind: entry, plugin: null, description: '', schema: {}, core: true,
  }));
  const selectedKind = palette.some((entry) => entry.kind === kind) ? kind : (palette[0]?.kind ?? kind);
  const selected = selectedId ?? list.data?.graphs[0]?.id ?? null;
  const summary = list.data?.graphs.find((graph) => graph.id === selected);
  const detail = useQuery({
    queryKey: ['run-graph', selected],
    queryFn: () => client.getRunGraph(selected!),
    enabled: selected !== null,
  });
  const editable = summary?.editable === true && summary.source === 'mine' && detail.data?.id === selected && detail.data.source === 'mine' && detail.data.editable === true;
  const raw = useQuery({
    queryKey: ['run-graph-yaml', editable ? selected : null],
    queryFn: () => client.getRunGraphYaml(selected!),
    enabled: editable && selected !== null,
  });
  const currentYaml = !editable ? null : draftId === selected ? yaml : raw.data?.id === selected && raw.data.source === 'mine' && raw.data.editable ? raw.data.yaml : null;
  const flow = useMemo(() => detail.data && detail.data.id === selected ? runGraphToFlow(detail.data) : null, [detail.data, selected]);
  const nodes = useMemo(() => flow?.nodes.map((node) => ({ ...node, type: 'run' })) ?? [], [flow]);

  function edit(next: (text: string) => string) {
    if (!editable || !selected || currentYaml === null || save.isPending) return;
    try {
      const updated = next(currentYaml);
      setDraftId(selected);
      setYaml(updated);
      setSaveError(null);
      setIgnoredKeys([]);
      setValidationError(null);
    } catch (error) {
      setSaveError(errorText(error));
    }
  }

  const clone = useMutation({
    mutationFn: () => client.cloneRunGraph(selected!, `${selected}-mine`),
    onSuccess: async (created) => {
      setDraftId(null);
      setYaml(null);
      setSaveError(null);
      setValidationError(null);
      setIgnoredKeys([]);
      await queries.invalidateQueries({ queryKey: ['run-graphs'] });
      setSelectedId(created.id);
    },
  });
  const save = useMutation({
    mutationFn: async ({ savingId, savingYaml }: { savingId: string; savingYaml: string }) => {
      const validation = await client.validateGraph('harness', savingYaml);
      setIgnoredKeys(validation.ignoredKeys);
      if (!validation.ok || validation.errors.length > 0) {
        setValidationError(validation.errors.map((issue) => issue.message).join(' · ') || '그래프 검증에 실패했습니다.');
        return;
      }
      setValidationError(null);
      return client.putRunGraphYaml(savingId, savingYaml);
    },
    onSuccess: async (saved) => {
      if (!saved) return;
      setSaveError(null);
      setDraftId(null);
      await queries.invalidateQueries({ queryKey: ['run-graph', saved.id] });
      await queries.invalidateQueries({ queryKey: ['run-graph-yaml', saved.id] });
    },
    onError: (error) => setSaveError(errorText(error)),
  });

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <aside className="w-56 shrink-0 overflow-y-auto border-r border-border" aria-label="실행 그래프 목록">
        <h2 className="px-3 py-3 text-xs font-semibold">실행 그래프</h2>
        {list.isLoading && <p className="px-3 text-xs text-text-tertiary">불러오는 중…</p>}
        {list.isError && <p role="alert" className="px-3 text-xs text-error">그래프 목록을 불러오지 못했습니다.</p>}
        {list.data?.graphs.length === 0 && <p className="px-3 text-xs text-text-tertiary">그래프가 없습니다.</p>}
        <ul>{list.data?.graphs.map((graph) => (
          <li key={graph.id}>
            <button type="button" onClick={() => {
              setSelectedId(graph.id);
              setSaveError(null);
              setValidationError(null);
              setIgnoredKeys([]);
            }}
              disabled={save.isPending || clone.isPending}
              aria-current={selected === graph.id ? 'true' : undefined}
              className={`w-full px-3 py-2 text-left text-xs hover:bg-surface-elevated ${selected === graph.id ? 'bg-accent/15 text-text-primary' : 'text-text-secondary'}`}>
              <span className="block font-mono">{graph.id}</span>
              <span className="text-[10px] text-text-tertiary">
                {graph.nodeCount} nodes · {graph.source === 'mine' ? '내 그래프' : 'core'} · {graph.editable ? '편집' : '읽기 전용'}
              </span>
            </button>
          </li>
        ))}</ul>
      </aside>
      <section className="relative flex min-w-0 flex-1 flex-col bg-surface" aria-label="실행 그래프 캔버스">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          {summary && !summary.editable && (
            <button type="button" onClick={() => clone.mutate()} disabled={clone.isPending}
              className="rounded border border-border px-2 py-1 text-xs">복제해서 고치기</button>
          )}
          {editable && (
            <>
              <label className="text-[10px] text-text-tertiary">kind
                <select aria-label="노드 kind" value={selectedKind} onChange={(event) => setKind(event.target.value)} className="ml-1 text-xs">
                  {palette.map((entry) => <option key={`${entry.plugin ?? 'core'}:${entry.kind}`} value={entry.kind}>{entry.kind}{entry.plugin ? ` · ${entry.plugin}` : ''}</option>)}
                </select>
              </label>
              <input aria-label="노드 id" value={nodeId} onChange={(event) => setNodeId(event.target.value)} className="w-24 rounded border border-border px-1 text-xs" />
              <input aria-label="recipe" value={recipe} onChange={(event) => setRecipe(event.target.value)} className="w-28 rounded border border-border px-1 text-xs" />
              <button type="button" className="rounded border border-border px-2 py-1 text-xs" onClick={() => edit((text) => {
                const doc = readRunGraphYaml(text);
                addRunGraphNode(doc, { nodeId, kind: selectedKind, recipe });
                return writeRunGraphYaml(doc);
              })}>노드 추가</button>
              <button type="button" className="rounded border border-border px-2 py-1 text-xs" onClick={() => edit((text) => {
                const doc = readRunGraphYaml(text);
                removeRunGraphNode(doc, nodeId);
                return writeRunGraphYaml(doc);
              })}>노드 삭제</button>
              <button type="button" className="rounded border border-border px-2 py-1 text-xs" onClick={() => edit((text) => {
                const doc = readRunGraphYaml(text);
                setRunGraphNodeKind(doc, nodeId, selectedKind);
                setRunGraphNodeRecipe(doc, nodeId, recipe);
                return writeRunGraphYaml(doc);
              })}>kind/recipe</button>
              <input aria-label="간선 from" value={edgeFrom} onChange={(event) => setEdgeFrom(event.target.value)} placeholder="from" className="w-20 rounded border border-border px-1 text-xs" />
              <input aria-label="간선 결과" value={edgeOutcome} onChange={(event) => setEdgeOutcome(event.target.value)} placeholder="결과" className="w-16 rounded border border-border px-1 text-xs" />
              <input aria-label="간선 to" value={edgeTo} onChange={(event) => setEdgeTo(event.target.value)} placeholder="to" className="w-20 rounded border border-border px-1 text-xs" />
              <button type="button" className="rounded border border-border px-2 py-1 text-xs" onClick={() => edit((text) => {
                const doc = readRunGraphYaml(text);
                addRunGraphEdge(doc, { from: edgeFrom, outcome: edgeOutcome, to: edgeTo });
                return writeRunGraphYaml(doc);
              })}>간선 추가</button>
              <button type="button" className="rounded border border-border px-2 py-1 text-xs" onClick={() => edit((text) => {
                const doc = readRunGraphYaml(text);
                removeRunGraphEdge(doc, edgeFrom, edgeOutcome);
                return writeRunGraphYaml(doc);
              })}>간선 삭제</button>
              <button type="button" onClick={() => {
                if (editable && selected && currentYaml !== null) save.mutate({ savingId: selected, savingYaml: currentYaml });
              }} disabled={currentYaml === null || save.isPending}
                className="rounded bg-accent px-2 py-1 text-xs text-white">저장</button>
            </>
          )}
        </div>
        {!sharedPalette && kinds.isError && <p role="status" className="px-3 py-1 text-xs text-warning">어휘 목록을 불러오지 못해 코어 팔레트를 표시합니다.</p>}
        {(validationError || saveError) && <p role="alert" className="px-3 py-1 text-xs text-error">{validationError || saveError}</p>}
        {ignoredKeys.length > 0 && <p role="status" className="px-3 py-1 text-xs text-warning">무시되는 키: {ignoredKeys.join(' · ')}</p>}
        {clone.isError && <p role="alert" className="px-3 py-1 text-xs text-error">{errorText(clone.error)}</p>}
        {detail.isError && <p role="alert" className="p-4 text-xs text-error">그래프를 불러오지 못했습니다.</p>}
        {detail.isLoading && <p className="p-4 text-xs text-text-tertiary">불러오는 중…</p>}
        {flow && (
          <ReactFlow key={selected ?? ''} nodes={nodes}
            edges={flow.edges} nodeTypes={NODE_TYPES} fitView
            nodesDraggable={false} nodesConnectable={false} elementsSelectable={editable}
            edgesReconnectable={false} deleteKeyCode={null} nodesFocusable={editable} edgesFocusable={false}
            defaultEdgeOptions={EDGE_OPTIONS}
            className="!bg-surface">
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
        )}
      </section>
    </div>
  );
}
