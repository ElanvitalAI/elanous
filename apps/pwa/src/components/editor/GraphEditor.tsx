'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { Background, Controls, Handle, Position, ReactFlow, type Connection, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { stringify as stringifyYaml } from 'yaml';
import { useOptionalNexusClient } from '@/nexus/hooks/use-nexus-context';
import { NexusApiError, type GraphKindEntry, type NexusClient } from '@/nexus/client';
import { graphEditorHref, graphEditorNodeGroups, resolveGraphEditorMode, type GraphEditorMode, type GraphEditorNodeGroup } from './graph-editor-mode';
import { WorkflowsPanel } from '@/components/workflows/WorkflowsPanel';
import { RunGraphView } from '@/components/workflows/RunGraphView';
import { GraphCanvasEditor, type GraphCanvasContext } from './GraphCanvasEditor';
import { grantCanvasGraphAccess, shareableCanvasGraphId, type GraphAccessClient } from './graph-canvas-save';
import { GraphRunControl } from './GraphRunControl';
import type { NodeRunStatus } from '@/components/workflows/run-status-helpers';
import { GraphWizardChat, GraphWizardEntry } from './GraphWizardChat';
import type { WizardClient } from './graph-wizard';
import { useWizardCanvas } from './use-wizard-canvas';
import { addNode, emptyGraph, fromYaml, setTerminal, toYaml, validateGraph, type CanvasGraph } from './graph-canvas-model';
import { addNode as addWorkflowNode } from '@/components/workflows/workflow-graph-mutations';
import type { WorkflowDefinitionLike, NodeVariant } from '@/components/workflows/workflow-graph-layout';

function PaletteContents({ groups, onAdd }: { groups: GraphEditorNodeGroup[]; onAdd?: (entry: GraphKindEntry) => void }) {
  return <>
    <strong>노드 팔레트</strong>
    <div className="flex flex-wrap gap-4">
      {groups.map((group) => (
        <section key={group.graph} aria-label={group.label} className="min-w-0 flex-1">
          <h2 className="font-semibold">{group.label}</h2>
          <div className="flex flex-wrap items-center gap-2">
            {group.kinds.map((entry) => (
              onAdd ? <button key={`${entry.graph}:${entry.kind}`} type="button" title={entry.description} data-graph={entry.graph}
                aria-label={`${group.label} ${entry.kind} 추가`} onClick={() => onAdd(entry)}
                className="rounded border border-border px-2 py-0.5">{entry.kind} {entry.plugin && <small>{entry.plugin}</small>}</button>
                : <span key={`${entry.graph}:${entry.kind}`} title={entry.description} data-graph={entry.graph}
                  className="rounded border border-border px-2 py-0.5">{entry.kind} {entry.plugin && <small>{entry.plugin}</small>}</span>
            ))}
          </div>
          {group.fallback && <p role="status" className="mt-1 text-warning">어휘 목록을 불러오지 못해 코어 팔레트를 표시합니다.</p>}
        </section>
      ))}
    </div>
  </>;
}

export function GraphEditorPalette({ groups, onAdd }: { groups: GraphEditorNodeGroup[]; onAdd?: (entry: GraphKindEntry) => void }) {
  const count = groups.reduce((total, group) => total + group.kinds.length, 0);
  return <>
    <details className="border-b border-border px-3 py-2 text-xs min-[640px]:hidden" aria-label="노드 팔레트">
      <summary className="cursor-pointer">노드 더하기 ({count})</summary>
      <div className="mt-2"><PaletteContents groups={groups} onAdd={onAdd} /></div>
    </details>
    <div className="hidden border-b border-border px-3 py-2 text-xs min-[640px]:block" aria-label="노드 팔레트">
      <PaletteContents groups={groups} onAdd={onAdd} />
    </div>
  </>;
}

type SharedNode = { id: string; graph: GraphEditorMode; kind: string; x: number; y: number; workflow?: string };

/** The run-graph library canvas: a new empty graph, or a «mine» graph opened for editing.
 *  `wizardPrompt` — GRAPH-WIZARD: the line typed on the «말로 만들기» entry, sent as the chat's first turn. */
type CanvasSession = { key: number; graph?: CanvasGraph; saved: boolean; wizardPrompt?: string };

/** A client without the wizard (a stub) answers like an older daemon. */
function wizardClientOf(client: NexusClient): WizardClient {
  const ask = client.graphWizard;
  return ask ? { graphWizard: (body, opts) => ask(body, opts) } : { graphWizard: async () => { throw new NexusApiError(404, '/v1/graphs/wizard', null); } };
}

/** `?mode=harness&wizard=<prompt>` — the entry hands its prompt to the run-graph canvas. */
export function graphWizardHref(prompt: string): string {
  return `${graphEditorHref('harness')}&wizard=${encodeURIComponent(prompt)}`;
}
type SharedEdge = { from: string; to: string };

function NodeCard({ data }: NodeProps) {
  const node = data as SharedNode;
  return <div className="rounded border border-border bg-background px-3 py-2 text-xs" data-graph={node.graph}>
    <Handle type="target" position={Position.Left} />
    <span>{node.graph === 'workflow' ? '작업 노드' : '실행 단계 노드'} · {node.kind}</span>
    <div className="font-mono">{node.id}</div>
    <Handle type="source" position={Position.Right} />
  </div>;
}
const NODE_TYPES = { shared: NodeCard };

/** Project each wire vocabulary from the same visible canvas; neither format is sent to the other's endpoint. */
function wireGraph(graph: GraphEditorMode, name: string, nodes: SharedNode[], edges: SharedEdge[]): string {
  const owned = nodes.filter((node) => node.graph === graph);
  if (graph === 'workflow') {
    let definition: WorkflowDefinitionLike = { name, nodes: [] };
    for (const node of owned) {
      if (node.kind.includes(':')) {
        definition = { ...definition, nodes: [...definition.nodes, { id: node.id, kind: node.kind, inputs: {} }] };
      } else if (node.kind === 'subworkflow') {
        definition = { ...definition, nodes: [...definition.nodes, { id: node.id, kind: 'subworkflow', workflow: node.workflow!, inputs: {} }] };
      } else {
        definition = addWorkflowNode(definition, node.kind as NodeVariant, { id: node.id });
      }
    }
    definition = { ...definition, nodes: definition.nodes.map((node) => ({
      ...node, ...((edges.filter((edge) => edge.to === node.id && owned.some((source) => source.id === edge.from)).length)
        ? { depends_on: edges.filter((edge) => edge.to === node.id && owned.some((source) => source.id === edge.from)).map((edge) => edge.from) } : {}),
    })) };
    return stringifyYaml(definition);
  }
  let result = emptyGraph(name);
  for (const node of owned) result = addNode(result, { kind: node.kind, id: node.id, x: node.x, y: node.y }).graph;
  result = { ...result, edges: edges.filter((edge) => owned.some((node) => node.id === edge.from) && owned.some((node) => node.id === edge.to))
    .map((edge) => ({ ...edge, outcome: '' })) };
  if (result.nodes.length) result = setTerminal(result, result.nodes[result.nodes.length - 1]!.id, true);
  return toYaml(result);
}

function SharedGraphCanvas({ groups, client }: { groups: GraphEditorNodeGroup[]; client: NexusClient }) {
  const [nodes, setNodes] = useState<SharedNode[]>([]);
  const [edges, setEdges] = useState<SharedEdge[]>([]);
  const [names, setNames] = useState<Record<GraphEditorMode, string>>({ workflow: '', harness: '' });
  const [saved, setSaved] = useState<Record<GraphEditorMode, string>>({ workflow: '', harness: '' });
  const [messages, setMessages] = useState<Record<GraphEditorMode, string>>({ workflow: '', harness: '' });
  const [busy, setBusy] = useState(false);
  function add(entry: GraphKindEntry) {
    setNodes((current) => {
      const prefix = `${entry.graph}-${entry.kind.split(':').pop()!.replace(/[^a-zA-Z0-9-]/g, '-')}`;
      let index = 1;
      while (current.some((node) => node.id === `${prefix}-${index}`)) index++;
      return [...current, { graph: entry.graph, kind: entry.kind, id: `${prefix}-${index}`,
        x: 40 + (current.length % 5) * 210, y: 40 + Math.floor(current.length / 5) * 130 }];
    });
  }
  async function check(graph: GraphEditorMode, save: boolean) {
    const name = names[graph].trim();
    if (!name || !nodes.some((node) => node.graph === graph)) { setMessages((current) => ({ ...current, [graph]: '그래프 이름과 노드가 필요합니다.' })); return; }
    if (graph === 'workflow' && nodes.some((node) => node.graph === graph && node.kind === 'subworkflow' && !node.workflow?.trim())) {
      setMessages((current) => ({ ...current, [graph]: 'subworkflow 참조 워크플로를 입력하세요.' }));
      return;
    }
    const yaml = wireGraph(graph, name, nodes, edges);
    if (graph === 'harness') {
      const local: CanvasGraph = fromYaml(yaml);
      const result = validateGraph(local, groups.find((group) => group.graph === graph)!.kinds.map((entry) => entry.kind));
      if (!result.ok) { setMessages((current) => ({ ...current, [graph]: result.issues.map((issue) => issue.message).join(', ') })); return; }
    }
    setBusy(true);
    try {
      const result = await client.validateGraph(graph, yaml);
      if (!result.ok) {
        setMessages((current) => ({ ...current, [graph]: result.errors.map((error) => error.message).join(', ') }));
        return;
      }
      if (save) {
        if (graph === 'workflow') await client.saveWorkflow(name, { yaml, scope: 'project' });
        else if (saved.harness === name) await client.putRunGraphYaml(name, yaml);
        else await client.createRunGraph(name, yaml);
        setSaved((current) => ({ ...current, [graph]: name }));
      }
      setMessages((current) => ({ ...current, [graph]: save ? '저장했습니다.' : '검증 통과' }));
    } catch (error) {
      setMessages((current) => ({ ...current, [graph]: error instanceof Error ? error.message : String(error) }));
    } finally {
      setBusy(false);
    }
  }
  const flowNodes = nodes.map((node) => ({ id: node.id, type: 'shared', position: { x: node.x, y: node.y }, data: node }));
  const flowEdges = edges.map((edge) => ({ id: `${edge.from}:${edge.to}`, source: edge.from, target: edge.to }));
  return <div className="flex min-h-0 flex-1 flex-col">
    <GraphEditorPalette groups={groups} onAdd={add} />
    {nodes.filter((node) => node.graph === 'workflow' && node.kind === 'subworkflow').map((node) => (
      <label key={node.id} className="px-3 py-1 text-xs">{node.id} 참조 워크플로
        <input aria-label={`${node.id} 참조 워크플로`} value={node.workflow ?? ''}
          onChange={(event) => setNodes((current) => current.map((item) => item.id === node.id ? { ...item, workflow: event.target.value } : item))}
          className="ml-2 rounded border border-border bg-background px-2 py-1" />
      </label>
    ))}
    <div className="flex flex-wrap gap-4 border-b border-border px-3 py-2 text-xs">
      {groups.map((group) => <section key={group.graph} aria-label={`${group.label} 검증과 저장`}>
        <label>{group.label} 이름 <input aria-label={`${group.label} 이름`} value={names[group.graph]}
          onChange={(event) => setNames((current) => ({ ...current, [group.graph]: event.target.value }))}
          className="rounded border border-border bg-background px-2 py-1" /></label>
        <button type="button" disabled={busy} onClick={() => { void check(group.graph, false); }}>검증</button>
        <button type="button" disabled={busy} onClick={() => { void check(group.graph, true); }}>저장</button>
        {messages[group.graph] && <span role="status">{messages[group.graph]}</span>}
      </section>)}
    </div>
    <div className="min-h-[300px] flex-1" aria-label="그래프 캔버스">
      <ReactFlow nodes={flowNodes} edges={flowEdges} nodeTypes={NODE_TYPES} fitView
        onNodesChange={(changes) => {
          const removed = new Set(changes.filter((change) => change.type === 'remove').map((change) => change.id));
          setNodes((current) => current.filter((node) => !removed.has(node.id)).map((node) => {
            const moved = changes.find((change) => change.type === 'position' && change.id === node.id);
            return moved?.type === 'position' && moved.position ? { ...node, ...moved.position } : node;
          }));
          if (removed.size) setEdges((current) => current.filter((edge) => !removed.has(edge.from) && !removed.has(edge.to)));
        }}
        onEdgesChange={(changes) => {
          const removed = new Set(changes.filter((change) => change.type === 'remove').map((change) => change.id));
          if (removed.size) setEdges((current) => current.filter((edge) => !removed.has(`${edge.from}:${edge.to}`)));
        }}
        onConnect={(connection: Connection) => {
          const source = nodes.find((node) => node.id === connection.source);
          const target = nodes.find((node) => node.id === connection.target);
          if (source && target && source.id !== target.id && source.graph === target.graph)
            setEdges((current) => current.some((edge) => edge.from === source.id && edge.to === target.id) ? current : [...current, { from: source.id, to: target.id }]);
        }}>
        <Background /><Controls />
      </ReactFlow>
    </div>
  </div>;
}

export function GraphShareControl({ context, client }: { context: GraphCanvasContext | null; client: GraphAccessClient }) {
  const [notice, setNotice] = useState<string | null>(null);
  const [recipient, setRecipient] = useState('');
  const [permission, setPermission] = useState<'view' | 'edit'>('view');
  const [busy, setBusy] = useState(false);
  const graphId = context ? shareableCanvasGraphId(context) : null;
  useEffect(() => { setNotice(null); setRecipient(''); }, [graphId]);
  async function grant() {
    if (!graphId || !recipient.trim() || busy) return;
    const grantedPermission = permission;
    setBusy(true);
    setNotice(null);
    try {
      await grantCanvasGraphAccess(client, graphId, recipient.trim(), grantedPermission);
      setNotice(`${grantedPermission === 'edit' ? '편집' : '보기'} 권한을 부여하고 서버에서 확인했습니다.`);
    } catch (error) {
      setNotice(`권한 설정 실패: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }
  return <div className="ml-auto flex flex-wrap items-center gap-2">
    <label>공유용 그래프 토큰 <input aria-label="공유용 그래프 토큰" autoComplete="off" value={recipient} onChange={(event) => { setRecipient(event.target.value); setNotice(null); }} className="rounded border border-border px-2 py-1" /></label>
    <button type="button" onClick={() => { setRecipient(`eg_${Array.from(crypto.getRandomValues(new Uint8Array(24)), (byte) => byte.toString(16).padStart(2, '0')).join('')}`); setNotice(null); }}
      className="rounded border border-border px-2 py-1">새 토큰 만들기</button>
    <span>권한 설정 뒤 이 토큰과 그래프 ID를 상대에게 전달하세요. 상대는 Nexus 연결 토큰으로 이 값을 사용해 해당 그래프 API에 접근합니다. 목록·실행은 공유되지 않습니다.</span>
    <label>권한 <select aria-label="공유 권한" value={permission} onChange={(event) => { setPermission(event.target.value as 'view' | 'edit'); setNotice(null); }}>
      <option value="view">보기</option><option value="edit">편집</option>
    </select></label>
    {permission === 'edit' && <span role="note" className="font-semibold text-red-700 dark:text-red-400">상대가 바꾼 그래프를 실행하면 상대 명령이 이 기계에서 돈다 — 실행 전 승인 필요</span>}
    <button type="button" onClick={() => { void grant(); }} disabled={!graphId || !recipient.trim() || busy}
      title={graphId ? '그래프 접근 권한을 설정합니다' : '저장 안 된 변경은 공유할 수 없습니다. 먼저 저장하세요'}
      className="rounded border border-border px-2 py-1 disabled:opacity-50">권한 설정</button>
    {notice && <span role="status">{notice}</span>}
  </div>;
}

export function GraphEditor() {
  const client = useOptionalNexusClient();
  return client ? <ConnectedGraphEditor client={client} /> :
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-border px-4 py-2"><h1 className="text-sm font-semibold">편집기</h1></header>
      <p className="p-4 text-sm text-text-tertiary">Daemon 연결이 설정되지 않았습니다. Settings 에서 Base URL 을 입력하세요.</p>
    </div>;
}

function ConnectedGraphEditor({ client }: { client: NexusClient }) {
  const params = useSearchParams();
  const requestedMode = resolveGraphEditorMode(params?.get('mode') ?? null);
  const [mode, setMode] = useState<GraphEditorMode>(requestedMode);
  // A legacy deep link (`/workflows` → `?mode=workflow`) still opens that library; plain `/editor` opens the shared canvas.
  const [showLibrary, setShowLibrary] = useState(() => params?.get('mode') != null);
  useEffect(() => { setMode(requestedMode); }, [requestedMode]);
  const selectMode = useCallback((graph: GraphEditorMode) => {
    setMode(graph);
    if (typeof window !== 'undefined') window.history.replaceState(null, '', graphEditorHref(graph));
  }, []);
  const queries = useQueryClient();
  const [canvas, setCanvas] = useState<CanvasSession | null>(null);
  const [shareContext, setShareContext] = useState<GraphCanvasContext | null>(null);
  const [runStatus, setRunStatus] = useState<Record<string, NodeRunStatus> | undefined>(undefined);
  const [selectedPack, setSelectedPack] = useState('');
  const packs = useQuery({ queryKey: ['graph-wizard-packs'], queryFn: () => client.getGraphWizardPacks!(),
    enabled: mode === 'harness' && Boolean(client.getGraphWizardPacks), retry: false });
  const wizard = useWizardCanvas();
  const [wizardDriven, setWizardDriven] = useState(false);
  const openCanvas = useCallback((session: Omit<CanvasSession, 'key'>) => {
    wizard.reset();
    setWizardDriven(Boolean(session.wizardPrompt));
    setShareContext(null);
    setCanvas({ key: Date.now(), ...session });
  }, [wizard.reset]);
  const wizardParam = params?.get('wizard') ?? null;
  const handledWizardParam = useRef<string | null>(null);
  useEffect(() => {
    if (mode !== 'harness' || !wizardParam || handledWizardParam.current === wizardParam) return;
    handledWizardParam.current = wizardParam;
    setShowLibrary(true);
    openCanvas({ saved: false, wizardPrompt: wizardParam });
  }, [mode, wizardParam, openCanvas]);
  const onRunStatus = useCallback((status: Record<string, NodeRunStatus> | undefined) => setRunStatus(status), []);
  const workflowKinds = useQuery({ queryKey: ['graph-kinds', 'workflow'], queryFn: () => client.getGraphKinds('workflow'), retry: false });
  const harnessKinds = useQuery({ queryKey: ['graph-kinds', 'harness'], queryFn: () => client.getGraphKinds('harness'), retry: false });
  const groups = useMemo(() => graphEditorNodeGroups([...(workflowKinds.data?.kinds ?? []), ...(harnessKinds.data?.kinds ?? [])]), [workflowKinds.data, harnessKinds.data]);
  const palette = groups.find((group) => group.graph === mode)!.kinds;
  const fallback = groups.find((group) => group.graph === mode)!.fallback;
  const openLibrary = (graph: GraphEditorMode) => {
    if (graph !== mode) { setCanvas(null); setShareContext(null); setRunStatus(undefined); selectMode(graph); }
    setShowLibrary(true);
  };
  const onCanvasChange = useCallback((context: GraphCanvasContext) => {
    wizard.onChange(context);
    setShareContext(context);
  }, [wizard.onChange]);
  return <div className="flex h-full min-h-0 flex-col">
    <header className="flex items-center gap-3 border-b border-border px-4 py-2">
      <h1 className="text-sm font-semibold">편집기</h1>
      <button type="button" aria-pressed={!showLibrary} onClick={() => { setShowLibrary(false); if (typeof window !== 'undefined') window.history?.replaceState(null, '', '/app/editor/'); }}>통합 캔버스</button>
      <button type="button" aria-pressed={showLibrary && mode === 'workflow'} onClick={() => openLibrary('workflow')}>워크플로 목록</button>
      <button type="button" aria-pressed={showLibrary && mode === 'harness'} onClick={() => openLibrary('harness')}>실행 그래프 목록</button>
    </header>
    <div className={showLibrary ? 'hidden' : 'flex min-h-0 flex-1 flex-col'}><SharedGraphCanvas groups={groups} client={client} /></div>
    {showLibrary && <div className="flex min-h-0 flex-1 flex-col">
      {!(mode === 'harness' && canvas) && <GraphWizardEntry onStart={(prompt) => {
        selectMode('harness');
        openCanvas({ saved: false, wizardPrompt: prompt });
      }} />}
      {mode === 'workflow' ? <WorkflowsPanel palette={palette} /> : canvas ? <>
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5 text-xs">
          <button type="button" onClick={() => { setCanvas(null); setShareContext(null); setRunStatus(undefined); }}>← 그래프 목록</button>
          <GraphShareControl key={canvas.key} context={shareContext} client={client} />
          {fallback && <span role="status">어휘 목록을 불러오지 못해 코어 팔레트를 씁니다.</span>}
        </div>
        <div className="border-b border-border px-3 py-2 text-xs">
          <label htmlFor="knowledge-pack">지식(RAG) 노드 · 설치된 팩</label>
          <select id="knowledge-pack" value={selectedPack} onChange={(event) => setSelectedPack(event.target.value)}
            className="ml-2 rounded border border-border bg-background px-2 py-1">
            <option value="">팩 사용 안 함</option>
            {(packs.data?.packs ?? []).map((pack) => <option key={pack.id} value={pack.id}>{pack.title} ({pack.id})</option>)}
          </select>
          {packs.isError && <span role="status">설치된 팩을 불러오지 못했습니다.</span>}
        </div>
        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col max-lg:overflow-y-auto">
            <GraphCanvasEditor key={canvas.key} palette={palette} client={client} wizardMode={wizardDriven}
              {...(canvas.graph ? { initialGraph: canvas.graph, initialSaved: canvas.saved } : {})}
              {...(runStatus ? { nodeStatus: runStatus } : {})}
              {...(wizard.replace ? { replace: wizard.replace } : {})}
              {...(wizard.highlight ? { highlight: wizard.highlight } : {})} nodeLabels={wizard.labels}
              {...(wizard.steps ? { wizardSteps: wizard.steps } : {})} onChange={onCanvasChange}
              installedPacks={packs.data?.packs} onKnowledgePackChange={setSelectedPack}
              renderActions={(context) => <GraphRunControl context={context} client={client} onStatus={onRunStatus} />}
              onSaved={() => { void queries.invalidateQueries({ queryKey: ['run-graphs'] }); }} />
          </div>
          <GraphWizardChat key={canvas.key} client={wizardClientOf(client)} current={wizard.current} laid={wizard.laid} {...(selectedPack ? { packId: selectedPack } : {})}
            onApply={(graph, added, autoLayout, labels, steps) => { setWizardDriven(true); wizard.apply(graph, added, autoLayout, labels, steps); }} onRestore={wizard.restore}
            {...(canvas.wizardPrompt ? { initialPrompt: canvas.wizardPrompt } : {})} />
        </div>
      </> : <RunGraphView palette={palette}
        onNewGraph={() => openCanvas({ saved: false })}
        onOpenInCanvas={(_id, yaml) => openCanvas({ graph: fromYaml(yaml), saved: true })} />}
    </div>}
  </div>;
}
