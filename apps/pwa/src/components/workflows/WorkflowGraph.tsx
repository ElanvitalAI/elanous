// Archon-port T2B (2026-05-08) — DAG visual view + Phase 2 edit mode.
//
// Phase 1 (#1965): read-only graph render with custom variant cards.
// Phase 2 (this PR): when `editable` is true, the user can:
//   - drag from one node to another to add a depends_on edge
//   - select a node and press Backspace / Delete to remove it
//   - click + Node in the floating palette to insert a new variant
// Mutations route through pure helpers (`workflow-graph-mutations.ts`)
// → serialise to YAML → bubble up via `onChangeYaml`. WorkflowsPanel
// stays the source of truth for the YAML draft, so the validation
// badge / save flow are untouched by edit mode.

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  addEdge as rfAddEdge,
  useReactFlow,
  useStore as useReactFlowStore,
  type Connection,
  type ConnectionLineComponentProps,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
  type NodeTypes,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './node-status.css';
import {
  workflowToLayout,
  type NodeVariant,
  type WorkflowDefinitionLike,
} from './workflow-graph-layout';
import {
  addEdge as defAddEdge,
  addNode as defAddNode,
  clearLayout as defClearLayout,
  definitionToYaml,
  deleteNode as defDeleteNode,
  nextFreeNodeId,
  duplicateNode as defDuplicateNode,
  removeEdge as defRemoveEdge,
  safeParseWorkflowYaml,
  setNodePosition,
} from './workflow-graph-mutations';
import { useKeyboardShortcuts, type ShortcutBinding } from './useKeyboardShortcuts';
import { useGraphHistory } from './use-graph-history';
import { copyNodes, pasteNodes, type GraphClipboard } from './graph-clipboard';
import {
  getDeliveryIcon,
  STATUS_TONE,
  type NodeStatusEntry,
} from './run-status-helpers';
import { nodeStatusClass } from './node-status-class';
import { DRAG_MIME, addNodeAt, decodeDrag, encodeDrag } from './graph-drop';
import { addNote, loadNotes, removeNote, saveNotes, updateNote, type GraphNote } from './graph-notes';
import type { ValidationIssue } from './validation-helpers';
import type { GraphKindEntry } from '@/nexus/client';

// Lazy parse: yaml has its own bundle cost so we only import on first
// use. Returns the parsed definition or null on failure.
async function safeParseYaml(yaml: string): Promise<WorkflowDefinitionLike | null> {
  try {
    const { parse } = await import('yaml');
    const parsed = parse(yaml) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const def = parsed as WorkflowDefinitionLike;
    if (!Array.isArray(def.nodes)) return null;
    return def;
  } catch {
    return null;
  }
}

interface WorkflowGraphProps {
  /** Server vocabulary, shared with the editor header. */
  palette?: GraphKindEntry[];
  /** Raw YAML text. Re-parsed on change. */
  yaml: string;
  /** Optional pre-parsed definition. When set, takes precedence over
   *  `yaml` (cheap path used by the WorkflowsPanel which already gets
   *  a parsed definition from /v1/workflows/:name). */
  definition?: WorkflowDefinitionLike | null;
  /** Phase 2: enable in-graph editing. When true, palette + drag-to-
   *  connect + delete are wired and `onChangeYaml` is called whenever
   *  the user makes a structural change. */
  editable?: boolean;
  /** Round-trip callback. Receives the new YAML after every mutation;
   *  consumer should set its draft state to this string. */
  onChangeYaml?: (yaml: string) => void;
  /** ROADMAP Tier 1 W2 (2026-05-11) — node click handler. Parent
   *  routes the id into `WorkflowNodeEditor` for inline editing. Set
   *  to undefined in read-only views to suppress the visual hover. */
  onNodeClick?: (nodeId: string) => void;
  /** ROADMAP Tier 2 W4 (2026-05-11) — last-run per-node status overlay.
   *  Parent derives via `extractNodeStatuses(runDetail.events)` and
   *  passes the resulting `nodeId → status` map. Undefined or missing
   *  entries render no dot (cleanly degrades when no run exists yet). */
  nodeStatuses?: Record<string, NodeStatusEntry>;
  /** ROADMAP Tier 2 W5 (2026-05-11) — inline per-node validation. Map
   *  of nodeId → ValidationIssue[]. Cards with entries render a ⚠
   *  badge in the header. Empty / missing entries render nothing. */
  nodeIssues?: Record<string, ValidationIssue[]>;
  /** ROADMAP Tier 2 W5 (2026-05-11) — set of nodeIds participating in
   *  a DAG cycle. Edges where both endpoints are in the set render
   *  dashed red so the user sees exactly which `depends_on` link
   *  creates the loop. */
  cycleNodeIds?: ReadonlySet<string>;
  /** ROADMAP Tier 2 W5 (2026-05-11) — when set, the graph fits view
   *  on this nodeId. Used by the panel's issue-list click handler to
   *  jump to the first invalid node. Pair with `focusNonce` to force a
   *  re-fire when the user clicks the same nodeId twice in a row. */
  focusNodeId?: string | null;
  /** Bumped by the parent to force a fitView re-fire even when the
   *  target nodeId is unchanged. */
  focusNonce?: number;
  /** Tier E3.2 (2026-05-11) — invoked when the user presses
   *  Ctrl/Cmd+Enter inside the graph editor. Parent wires this to its
   *  Run handler so power users don't need to mouse over the Run
   *  button. Optional — undefined disables the binding. */
  onRun?: () => void;
}

const VARIANT_COLOR: Record<NodeVariant, string> = {
  prompt: '#8b5cf6',     // violet
  bash: '#22c55e',       // green
  skill: '#f59e0b',      // amber
  cft: '#06b6d4',        // cyan
  approval: '#ef4444',   // red
  if: '#ec4899',         // pink — N1.1 control flow
  switch: '#d946ef',     // fuchsia — N1.2 N-way branch
  iteration: '#a855f7',  // purple — N1.3 sequential loop
  classify: '#0ea5e9',   // sky — N2.1 LLM classification
  extract: '#14b8a6',    // teal — N2.2 LLM extraction
  set: '#84cc16',        // lime — N3.1 variable assigner
  filter: '#10b981',     // emerald — N3.2 array filter
  template: '#f97316',   // orange — N3.3 template transform
  http: '#3b82f6',       // blue — N4.3 HTTP request
  scheduleTrigger: '#6366f1', // indigo — N4.1 schedule entry
  webhookTrigger: '#a78bfa', // violet — N4.2 webhook entry
  discordTrigger: '#5865f2', // discord blurple — N4.4 discord entry
  telegramTrigger: '#0088cc', // telegram blue — N4.5 telegram entry
  manualTrigger: '#64748b',  // slate — B6 explicit entry
  chatTrigger: '#9333ea',    // purple — B7 chat-driven entry
  unknown: '#9ca3af',    // gray
};

/** W3c — the minimap only earns its space once the graph is big enough to get lost in. */
export const MINIMAP_MIN_NODES = 10;
export function showMiniMap(nodeCount: number): boolean {
  return nodeCount >= MINIMAP_MIN_NODES;
}

export function showEmptyCanvas(workflowNodeCount: number, noteCount: number): boolean {
  return workflowNodeCount === 0 && noteCount === 0;
}

/** W3c — the palette entry carried by a drag, or null when it is not ours / not offered by this palette. */
export function droppedEntry(
  event: { dataTransfer: { types: ArrayLike<string> | Iterable<string>; getData: (format: string) => string } },
  palette: GraphKindEntry[] | undefined,
): GraphKindEntry | null {
  if (!Array.from(event.dataTransfer.types as Iterable<string>).includes(DRAG_MIME)) return null;
  const entry = decodeDrag(event.dataTransfer.getData(DRAG_MIME));
  if (!entry) return null;
  const offered = palette
    ? palette.some((item) => item.kind === entry.kind && item.core === entry.core)
    : entry.core;
  return offered ? entry : null;
}

export function WorkflowGraph({
  palette,
  yaml,
  definition,
  editable,
  onChangeYaml,
  onNodeClick,
  nodeStatuses,
  nodeIssues,
  cycleNodeIds,
  focusNodeId,
  focusNonce,
  onRun,
}: WorkflowGraphProps) {
  const [parsed, setParsed] = useState<WorkflowDefinitionLike | null>(definition ?? null);
  const [parseError, setParseError] = useState(false);
  // A ref, not state: storing the instance in state re-rendered on every init and looped (W3c harvest).
  const flowRef = useRef<ReactFlowInstance | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [storedNotes, setStoredNotes] = useState<{ name: string | null; items: GraphNote[] }>(() => ({
    name: definition?.name ?? null,
    items: definition?.name ? loadNotes(definition.name) : [],
  }));
  const currentNotes = useRef(storedNotes);
  const workflowName = parsed?.name ?? null;
  const notes = storedNotes.name === workflowName ? storedNotes.items : [];

  useEffect(() => {
    if (!workflowName) return;
    if (currentNotes.current.name === workflowName) return;
    const loaded = { name: workflowName, items: loadNotes(workflowName) };
    currentNotes.current = loaded;
    setStoredNotes(loaded);
  }, [workflowName]);

  const changeNotes = useCallback((change: (current: GraphNote[]) => GraphNote[]) => {
    if (!editable || !workflowName) return;
    const next = change(currentNotes.current.name === workflowName ? currentNotes.current.items : loadNotes(workflowName));
    currentNotes.current = { name: workflowName, items: next };
    saveNotes(workflowName, next);
    setStoredNotes(currentNotes.current);
  }, [editable, workflowName]);
  const onAddNote = useCallback(() => {
    if (!editable || !workflowName) return;
    const bounds = canvasRef.current?.getBoundingClientRect();
    const flow = flowRef.current;
    const center = bounds
      ? { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 }
      : { x: 100, y: 60 };
    const position = flow?.screenToFlowPosition(center)
      ?? (bounds ? { x: bounds.width / 2, y: bounds.height / 2 } : center);
    changeNotes((current) => addNote(current, { x: position.x - 100, y: position.y - 60 }));
  }, [changeNotes, editable, workflowName]);
  // Tier E3.3 (2026-05-11) — set of currently-selected node ids,
  // sourced from ReactFlow's `onSelectionChange`. Drives the
  // multi-select pan-into-view fitView trigger + the Cmd+D duplicate /
  // F2 rename shortcuts (which target the first selected node).
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const { record, undo, redo, canUndo, canRedo } = useGraphHistory();
  const clipboard = useRef<GraphClipboard | null>(null);

  useEffect(() => {
    if (definition) {
      setParsed(definition);
      setParseError(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      const r = await safeParseYaml(yaml);
      if (cancelled) return;
      setParsed(r);
      setParseError(r === null);
    })();
    return () => { cancelled = true; };
  }, [yaml, definition]);

  // Mutation helper: take the *current* YAML (so we never lose a
  // concurrent textarea edit), parse it, apply `mut`, serialise, and
  // hand back to the consumer. Falls back to the in-state `parsed`
  // when reparse fails.
  //
  // Optimistic update (2026-05-08 dogfood follow-up): also set
  // `parsed` synchronously so the ReactFlow re-layout fires on the
  // same tick as the click. Without this, every palette/connect/
  // delete bounces through onChangeYaml → parent re-render → async
  // `await import('yaml')` reparse → eventual setParsed, which
  // produced a visible 600–800ms delay before the new node appeared.
  // The follow-up reparse from `useEffect` still runs (and resolves
  // to the same value) — it just no longer gates the user-visible
  // update.
  const mutate = useCallback(
    (mut: (def: WorkflowDefinitionLike) => WorkflowDefinitionLike) => {
      if (!onChangeYaml) return;
      const currentDef = safeParseWorkflowYaml(yaml) ?? parsed;
      if (!currentDef) return;
      const next = mut(currentDef);
      try {
        const nextYaml = definitionToYaml(next);
        if (nextYaml === yaml) return;
        record(yaml);
        setParsed(next);
        onChangeYaml(nextYaml);
      } catch {
        // serialization failed — silently keep current YAML so the
        // user doesn't lose their edits
      }
    },
    [onChangeYaml, parsed, record, yaml],
  );

  const restoreYaml = useCallback((previous: string | null) => {
    if (previous === null || !onChangeYaml) return;
    setParsed(safeParseWorkflowYaml(previous));
    onChangeYaml(previous);
  }, [onChangeYaml]);
  const onUndo = useCallback(() => {
    if (onChangeYaml) restoreYaml(undo(yaml));
  }, [onChangeYaml, restoreYaml, undo, yaml]);
  const onRedo = useCallback(() => {
    if (onChangeYaml) restoreYaml(redo(yaml));
  }, [onChangeYaml, restoreYaml, redo, yaml]);
  const onCopy = useCallback(() => {
    const currentDef = safeParseWorkflowYaml(yaml) ?? parsed;
    if (!currentDef) return;
    const copied = copyNodes(currentDef, selectedIds);
    if (copied) clipboard.current = copied;
  }, [yaml, parsed, selectedIds]);
  const onPaste = useCallback(() => {
    if (!clipboard.current || !onChangeYaml) return;
    mutate((def) => pasteNodes(def, clipboard.current!));
  }, [mutate, onChangeYaml]);

  const layout = useMemo(() => {
    if (!parsed) return null;
    try {
      return workflowToLayout(parsed);
    } catch {
      return null;
    }
  }, [parsed]);

  const nodes: Node[] = useMemo(() => {
    const workflowNodes: Node[] = (layout?.nodes ?? []).map((n) => {
      const inCycle = cycleNodeIds?.has(n.id) ?? false;
      const issues = nodeIssues?.[n.id];
      const statusEntry = nodeStatuses?.[n.id];
      // Ergonomic-port Tier E2.2 (2026-05-11) — wrap the node with a
      // status class so CSS keyframes (pulse / flash) + reduced-motion
      // fallback live in `node-status.css` instead of inline style.
      const statusClass = nodeStatusClass(statusEntry?.status);
      return {
        id: n.id,
        type: 'workflow', // Tier E4.2 — custom node type with zoom-aware rendering.
        position: n.position,
        data: { raw: n, statusEntry, issues, inCycle },
        className: statusClass,
        style: {
          background: 'var(--surface, #0f1117)',
          color: 'var(--text-primary, #e5e7eb)',
          border: inCycle
            ? '2px dashed #ef4444'
            : `1.5px solid ${VARIANT_COLOR[n.variant]}`,
          borderRadius: 8,
          padding: 0,
          width: n.width,
          fontSize: 11,
          textAlign: 'left' as const,
        },
      } satisfies Node;
    });
    return [...workflowNodes, ...notes.map((note) => ({
      id: `annotation:${note.id}`,
      type: 'note',
      position: { x: note.x, y: note.y },
      data: {
        text: note.text,
        editable: editable === true,
        onTextChange: (text: string) => changeNotes((current) => updateNote(current, note.id, { text })),
        onRemove: () => changeNotes((current) => removeNote(current, note.id)),
      },
      draggable: editable === true,
      selectable: false,
      style: { padding: 0, border: 0, background: 'transparent', width: 200 },
    } satisfies Node))];
  }, [layout, nodeStatuses, nodeIssues, cycleNodeIds, notes, editable, changeNotes]);

  // Tier E4.2 (2026-05-11) — register the custom node type once.
  const nodeTypes: NodeTypes = useMemo(() => ({ workflow: WorkflowNodeView, note: NoteNodeView }), []);

  const edges: Edge[] = useMemo(() => {
    if (!layout) return [];
    return layout.edges.map((e) => {
      // W5 — an edge belongs to a cycle iff both endpoints do.
      const inCycle =
        cycleNodeIds?.has(e.source) === true && cycleNodeIds.has(e.target);
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        animated: false,
        style: inCycle
          ? { stroke: '#ef4444', strokeWidth: 2, strokeDasharray: '6 4' }
          : { stroke: 'var(--text-tertiary, #6b7280)', strokeWidth: 1.5 },
      };
    });
  }, [layout, cycleNodeIds]);

  // Edit-mode handlers. Each maps a ReactFlow event onto a pure
  // mutation in `workflow-graph-mutations.ts`.
  //
  // IMPORTANT: these `useCallback`s MUST live above the early-return
  // branches below. React's Rules of Hooks forbid conditional hook
  // calls — when `parsed` flipped from null → populated on a second
  // render the hook count diverged and React threw error #310 ("rendered
  // more hooks than during the previous render"), which collapsed the
  // entire WorkflowsPanel tree. Confirmed via Dia CDP dogfood
  // (2026-05-08): clicking the Graph toggle on quick-summary unmounted
  // the panel; hoisting the callbacks fixes it.
  const onConnect = useCallback(
    (c: Connection) => {
      if (!editable || !c.source || !c.target) return;
      mutate((def) => defAddEdge(def, c.source!, c.target!));
    },
    [editable, mutate],
  );
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      if (!editable) return;
      const noteIds = new Map(notes.map((note) => [`annotation:${note.id}`, note.id]));
      const removed = changes.filter((ch) => ch.type === 'remove');
      const removedNotes = removed.map((ch) => noteIds.get(ch.id)).filter((id): id is string => id !== undefined);
      if (removedNotes.length > 0) {
        changeNotes((current) => removedNotes.reduce((items, id) => removeNote(items, id), current));
      }
      const removedWorkflow = removed.filter((ch) => !ch.id.startsWith('annotation:'));
      if (removedWorkflow.length > 0) {
        mutate((def) => removedWorkflow.reduce((d, ch) => defDeleteNode(d, ch.id), def));
      }
      // ROADMAP W3 — persist drag-stopped positions to `_meta.layout`.
      // ReactFlow emits `position` changes continuously while dragging
      // with `dragging: true`, then one final change with `dragging:
      // false`. We only commit on the final tick so the YAML doesn't
      // churn every frame.
      const settled = changes.filter(
        (ch): ch is NodeChange & { id: string; position: { x: number; y: number }; dragging?: boolean } =>
          ch.type === 'position'
          && (ch as { dragging?: boolean }).dragging === false
          && (ch as { position?: unknown }).position !== undefined,
      );
      const notePositions = settled.filter((ch) => noteIds.has(ch.id));
      if (notePositions.length > 0) {
        changeNotes((current) => notePositions.reduce((items, ch) =>
          updateNote(items, noteIds.get(ch.id)!, { x: ch.position.x, y: ch.position.y }), current));
      }
      const workflowPositions = settled.filter((ch) => !ch.id.startsWith('annotation:'));
      if (workflowPositions.length > 0) {
        mutate((def) => workflowPositions.reduce((d, ch) => setNodePosition(d, ch.id, ch.position), def));
      }
    },
    [editable, mutate, notes, changeNotes],
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      if (!editable) return;
      const removed = changes.filter((ch) => ch.type === 'remove');
      if (removed.length === 0) return;
      // ReactFlow edge ids in our world are `source->target` (set in
      // workflow-graph-layout.ts). Parse back to source / target.
      mutate((def) =>
        removed.reduce((d, ch) => {
          const id = (ch as { id: string }).id;
          const [source, target] = id.split('->');
          if (!source || !target) return d;
          return defRemoveEdge(d, source, target);
        }, def),
      );
    },
    [editable, mutate],
  );

  // Tier E4.3 (2026-05-11) — NodeCreator panel toggle. `N` opens it
  // (search + variant chips); ESC dismisses. Click a chip → addNode +
  // close. Replaces the previous N=add-bash binding (the bare Add
  // bash is still in the floating palette).
  const [nodeCreatorOpen, setNodeCreatorOpen] = useState(false);

  // ⛔📏 2026-08-21: 이 `useCallback` 은 아래(조기 반환 셋 뒤)에 있었다. 위 주석이 「반드시 조기 반환
  // 위에 두라」고 이미 적어 두었는데도 새 훅 하나가 그 아래로 들어갔고, 파싱 실패·미파싱·노드 0 인
  // 렌더에서 훅 수가 줄어 React 가 이 트리를 죽인다. 2026-05-08 에 같은 파일에서 났던 그 결함이다.
  // ⇒ 이제 그 재발을 «세는» 자가 있다: `bun run scripts/hook-order-sweep.ts --list`.
  const onCreateNode = useCallback(
    (variant: NodeVariant) => {
      mutate((def) => defAddNode(def, variant));
      setNodeCreatorOpen(false);
    },
    [mutate],
  );
  const onAddPaletteNode = useCallback((entry: GraphKindEntry) => {
    mutate((def) => entry.core
      ? defAddNode(def, entry.kind as NodeVariant)
      : { ...def, nodes: [...def.nodes, { id: nextFreeNodeId(def, 'unknown'), kind: entry.kind, inputs: {} }] });
  }, [mutate]);

  // Tier E3.2 (2026-05-11) — keyboard shortcuts. Skipped entirely
  // when not editable so a read-only viewer doesn't accidentally
  // catch a power-user chord.
  const shortcuts: ShortcutBinding[] = useMemo(() => {
    if (!editable) return [];
    const bindings: ShortcutBinding[] = [];
    bindings.push(
      { key: 'z', metaOrCtrl: true, shift: false, handler: onUndo },
      { key: 'z', metaOrCtrl: true, shift: true, handler: onRedo },
      { key: 'c', metaOrCtrl: true, handler: onCopy },
      { key: 'v', metaOrCtrl: true, handler: onPaste },
    );
    // N — open the NodeCreator panel (Tier E4.3).
    bindings.push({
      key: 'n',
      handler: () => setNodeCreatorOpen((open) => !open),
    });
    // Shift+Alt+T — Tidy-up (Tier E4.1) — clear `_meta.layout` so the
    // dagre LR auto-layout re-runs.
    bindings.push({
      key: 't',
      shift: true,
      alt: true,
      handler: () => mutate((def) => defClearLayout(def)),
    });
    // Escape — dismiss the NodeCreator if it's open.
    bindings.push({
      key: 'Escape',
      handler: () => setNodeCreatorOpen(false),
      preventDefault: false,
    });
    // Cmd/Ctrl+D — duplicate the first selected node.
    bindings.push({
      key: 'd',
      metaOrCtrl: true,
      handler: () => {
        const target = selectedIds[0];
        if (!target) return;
        mutate((def) => defDuplicateNode(def, target));
      },
    });
    // F2 — open the inline editor for the first selected node. Same
    // entry point as a node click; preventDefault so browsers that
    // map F2 to "rename" in their own surface don't fight us.
    bindings.push({
      key: 'F2',
      handler: () => {
        const target = selectedIds[0];
        if (!target || !onNodeClick) return;
        onNodeClick(target);
      },
    });
    // Cmd/Ctrl+Enter — bubble the run intent to the parent.
    if (onRun) {
      bindings.push({
        key: 'Enter',
        metaOrCtrl: true,
        handler: () => onRun(),
      });
    }
    return bindings;
  }, [editable, mutate, onCopy, onNodeClick, onPaste, onRedo, onRun, onUndo, selectedIds]);
  useKeyboardShortcuts(shortcuts, { enabled: editable === true });

  if (parseError) {
    return (
      <div className="flex h-full items-center justify-center text-[11px] text-text-tertiary">
        YAML parse failed — switch to YAML view to fix.
      </div>
    );
  }
  if (!parsed) {
    return (
      <div className="flex h-full items-center justify-center text-[11px] text-text-tertiary">
        Parsing…
      </div>
    );
  }
  if (showEmptyCanvas(layout?.nodes.length ?? 0, notes.length)) {
    // Only an entirely empty canvas skips React Flow; notes on a node-free workflow need the canvas to edit them.
    // The empty panel itself takes a palette drop and places the first node at the origin.
    return (
      <div
        ref={canvasRef}
        className="relative flex h-full items-center justify-center text-[11px] text-text-tertiary"
        onDragOver={(event) => {
          if (editable && Array.from(event.dataTransfer.types).includes(DRAG_MIME)) {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
          }
        }}
        onDrop={(event) => {
          if (!editable) return;
          const entry = droppedEntry(event, palette);
          if (!entry) return;
          event.preventDefault();
          mutate((def) => addNodeAt(def, entry, { x: 0, y: 0 }).def);
        }}
      >
        {editable && <NodePalette palette={palette} editable={editable === true} onAdd={onAddPaletteNode} />}
        {editable && <GraphHistoryControls canUndo={canUndo} canRedo={canRedo} onUndo={onUndo} onRedo={onRedo} />}
        {editable && <AddNoteButton onAdd={onAddNote} />}
        {editable
          ? 'No nodes yet — pick a variant from the palette.'
          : 'No nodes yet — switch to YAML view to add one.'}
      </div>
    );
  }
  return (
    <div ref={canvasRef} className="relative h-full w-full">
      {editable && <NodePalette palette={palette} editable={editable === true} onAdd={onAddPaletteNode} />}
      {editable && <GraphHistoryControls canUndo={canUndo} canRedo={canRedo} onUndo={onUndo} onRedo={onRedo} />}
      {editable && (
        <>
          <AddNoteButton onAdd={onAddNote} />
          <TidyUpButton onTidy={() => mutate((def) => defClearLayout(def))} />
        </>
      )}
      {editable && nodeCreatorOpen && (
        <NodeCreatorPanel
          onPick={onCreateNode}
          onClose={() => setNodeCreatorOpen(false)}
        />
      )}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        nodesDraggable={editable ?? false}
        nodesConnectable={editable ?? false}
        elementsSelectable={editable ?? false}
        deleteKeyCode={editable ? ['Backspace', 'Delete'] : null}
        onConnect={editable ? onConnect : undefined}
        onNodesChange={editable ? onNodesChange : undefined}
        onEdgesChange={editable ? onEdgesChange : undefined}
        onInit={(instance) => { flowRef.current = instance; }}
        onDragOver={(event) => {
          if (editable && Array.from(event.dataTransfer.types).includes(DRAG_MIME)) {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
          }
        }}
        onDrop={(event) => {
          const flow = flowRef.current;
          if (!editable || !flow) return;
          const entry = droppedEntry(event, palette);
          if (!entry) return;
          event.preventDefault();
          const position = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
          mutate((def) => addNodeAt(def, entry, position).def);
        }}
        onNodeClick={onNodeClick ? (_evt, node) => { if (node.type !== 'note') onNodeClick(node.id); } : undefined}
        // Tier E3.3 (2026-05-11) — track selection so power-user
        // shortcuts (Cmd+D / F2) target the right node and the
        // SelectionPanController can pan multiple nodes into view.
        onSelectionChange={({ nodes: sel }) => setSelectedIds(sel.filter((n) => n.type !== 'note').map((n) => n.id))}
        proOptions={{ hideAttribution: true }}
        // Ergonomic-port Tier E2.1 (2026-05-11) — custom connection
        // line that fades in over ~300ms. Keeps a stray click from
        // painting a wire for a single frame before the user commits.
        connectionLineComponent={editable ? PendingConnectionLine : undefined}
        fitView
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        <Controls showInteractive={false} />
        {showMiniMap(nodes.length) && <MiniMap position="bottom-right" pannable zoomable bgColor="#16171c" maskColor="rgba(12, 12, 14, 0.6)" nodeColor="#7188a5" />}
        {focusNodeId !== undefined && (
          <FocusController focusNodeId={focusNodeId ?? null} focusNonce={focusNonce ?? 0} />
        )}
        <SelectionPanController selectedIds={selectedIds} />
      </ReactFlow>
    </div>
  );
}

function AddNoteButton({ onAdd }: { onAdd: () => void }) {
  return (
    <button type="button" onClick={onAdd} title="메모 추가"
      className="absolute right-20 top-3 z-10 rounded-md border border-amber-500 bg-amber-100 px-2 py-1 text-[10px] text-amber-950 shadow-md hover:bg-amber-200">
      메모 추가
    </button>
  );
}

type NoteNodeData = {
  text: string;
  editable: boolean;
  onTextChange: (text: string) => void;
  onRemove: () => void;
};

function NoteNodeView({ data }: NodeProps) {
  const note = data as NoteNodeData;
  return (
    <div className="rounded-md border border-amber-400 bg-amber-100 p-2 text-amber-950 shadow-md">
      <div className="flex items-center justify-between pb-1 text-[10px] font-semibold">
        <span>메모</span>
        {note.editable && <button type="button" onClick={note.onRemove} title="메모 지우기" aria-label="메모 지우기" className="nodrag text-amber-900">×</button>}
      </div>
      {note.editable ? (
        <textarea aria-label="메모 내용" value={note.text} onChange={(event) => note.onTextChange(event.target.value)}
          className="nodrag nowheel block min-h-20 w-full resize-y rounded bg-amber-50 p-1 text-xs text-amber-950 outline-amber-600" />
      ) : <div className="min-h-20 whitespace-pre-wrap break-words text-xs">{note.text}</div>}
    </div>
  );
}

function GraphHistoryControls({
  canUndo, canRedo, onUndo, onRedo,
}: {
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}) {
  return (
    <div className="absolute right-3 top-12 z-10 flex gap-1">
      <button type="button" onClick={onUndo} disabled={!canUndo} title="Undo (Cmd/Ctrl+Z)"
        className="rounded border border-border bg-surface-elevated px-2 py-1 text-[10px] text-text-tertiary disabled:opacity-50">
        Undo
      </button>
      <button type="button" onClick={onRedo} disabled={!canRedo} title="Redo (Cmd/Ctrl+Shift+Z)"
        className="rounded border border-border bg-surface-elevated px-2 py-1 text-[10px] text-text-tertiary disabled:opacity-50">
        Redo
      </button>
    </div>
  );
}

/** Floating palette of variant buttons. Click → add a new node of
 *  that variant via the consumer's mutate callback. */
function NodePalette({ palette, editable, onAdd }: { palette?: GraphKindEntry[]; editable: boolean; onAdd: (entry: GraphKindEntry) => void }) {
  const variants: { v: NodeVariant; label: string }[] = [
    { v: 'prompt', label: '+ prompt' },
    { v: 'bash', label: '+ bash' },
    { v: 'skill', label: '+ skill' },
    { v: 'cft', label: '+ cft' },
    { v: 'approval', label: '+ approval' },
    { v: 'if', label: '+ if' },
    { v: 'switch', label: '+ switch' },
    { v: 'iteration', label: '+ loop' },
    { v: 'classify', label: '+ classify' },
    { v: 'extract', label: '+ extract' },
    { v: 'set', label: '+ set' },
    { v: 'filter', label: '+ filter' },
    { v: 'template', label: '+ template' },
    { v: 'http', label: '+ http' },
    { v: 'scheduleTrigger', label: '+ schedule' },
    { v: 'webhookTrigger', label: '+ webhook' },
  ];
  return (
    <div
      className="absolute left-3 top-3 z-10 flex flex-col gap-1 rounded-md border border-border bg-surface-elevated p-1 shadow-md"
    >
      {(palette ?? variants.map(({ v }) => ({ graph: 'workflow' as const, kind: v, core: true, plugin: null, description: '' })))
        .map((entry) => (
        <button
          key={entry.kind}
          type="button"
          draggable={editable}
          onDragStart={(event) => {
            if (!editable) { event.preventDefault(); return; }
            event.dataTransfer.setData(DRAG_MIME, encodeDrag(entry));
            event.dataTransfer.effectAllowed = 'copy';
          }}
          onClick={() => onAdd(entry)}
          className="rounded px-2 py-0.5 text-left text-[10px] text-text-tertiary transition-colors hover:bg-surface hover:text-text-primary"
          style={{ minWidth: 80 }}
        >
          {variants.find(({ v }) => v === entry.kind)?.label ?? `+ ${entry.kind}`}
          {entry.plugin && <span className="ml-1 rounded bg-accent/15 px-1 text-accent">{entry.plugin}</span>}
        </button>
      ))}
    </div>
  );
}

// Suppress the unused-import lint when ReactFlow's helper isn't
// referenced directly (kept handy for future reordering).
void rfAddEdge;

/** Tier E2.1 (2026-05-11) — custom connection-line renderer. ReactFlow
 *  draws this while the user is mid-drag from one handle. We wrap the
 *  default path with a `.workflow-edge-pending` class that fades the
 *  wire in over ~220ms (after an 80ms delay) so a stray click doesn't
 *  paint a connection for a single frame. */
function PendingConnectionLine({
  fromX,
  fromY,
  toX,
  toY,
}: ConnectionLineComponentProps) {
  return (
    <g className="workflow-edge-pending">
      <path
        d={`M ${fromX},${fromY} C ${fromX + 60},${fromY} ${toX - 60},${toY} ${toX},${toY}`}
        fill="none"
        stroke="var(--accent, #8b5cf6)"
        strokeWidth={1.8}
        strokeDasharray="4 3"
      />
      <circle cx={toX} cy={toY} r={4} fill="var(--accent, #8b5cf6)" />
    </g>
  );
}

/** W5 — invisible child of <ReactFlow> that imperatively focuses the
 *  viewport on a target node. Lives inside <ReactFlow> so it can use
 *  `useReactFlow()` (the hook needs the auto-injected provider). */
function FocusController({
  focusNodeId,
  focusNonce,
}: {
  focusNodeId: string | null;
  focusNonce: number;
}) {
  const flow = useReactFlow();
  useEffect(() => {
    if (!focusNodeId) return;
    // Defer one tick so the latest layout commits before fitView is
    // computed against the new positions.
    const t = setTimeout(() => {
      flow.fitView({ nodes: [{ id: focusNodeId }], duration: 300, padding: 0.3 });
    }, 0);
    return () => { clearTimeout(t); };
    // focusNonce is intentionally a dep — bumping it forces the
    // refocus even when focusNodeId hasn't changed (the consumer
    // clicked the same issue twice).
  }, [focusNodeId, focusNonce, flow]);
  return null;
}

/** Tier E3.3 (2026-05-11) — pan + zoom to fit the user's current
 *  multi-selection. Fires only when the selected count is > 1 so a
 *  bare single-node click (already comfortable) doesn't yank the
 *  viewport. Single-node fitView is reserved for the W5 issue-list
 *  jump (handled by FocusController above). */
function SelectionPanController({ selectedIds }: { selectedIds: string[] }) {
  const flow = useReactFlow();
  const key = selectedIds.join(',');
  useEffect(() => {
    if (selectedIds.length <= 1) return;
    const t = setTimeout(() => {
      flow.fitView({
        nodes: selectedIds.map((id) => ({ id })),
        duration: 300,
        padding: 0.25,
      });
    }, 0);
    return () => { clearTimeout(t); };
    // `key` (the joined id list) is the meaningful dep — re-fires
    // whenever the selection set actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, flow]);
  return null;
}

/** Tier E4.1 (2026-05-11) — Tidy-up button. Top-right corner overlay
 *  on the canvas. Clearing `_meta.layout` lets the dagre LR
 *  auto-layout re-run on the next render. Pairs with the Shift+Alt+T
 *  keyboard shortcut wired in the parent. */
function TidyUpButton({ onTidy }: { onTidy: () => void }) {
  return (
    <button
      type="button"
      onClick={onTidy}
      title="Tidy-up auto-layout (Shift+Alt+T)"
      className="absolute right-3 top-3 z-10 rounded-md border border-border bg-surface-elevated px-2 py-1 text-[10px] text-text-tertiary shadow-md hover:bg-surface hover:text-text-primary"
    >
      ✨ Tidy
    </button>
  );
}

/** Tier E4.3 (2026-05-11) — NodeCreator side panel. Slide-in from the
 *  right with a search bar + variant chips. Click a chip to insert a
 *  node of that variant; ESC or click-outside dismisses. Triggered by
 *  `N` shortcut from the parent.
 *
 *  Search is a substring filter (no fuzzy / Fuse.js dep — the variant
 *  catalog is 5 entries long). When skill / cft selectors land in a
 *  later iteration the same surface accepts a list prop. */
function NodeCreatorPanel({
  onPick,
  onClose,
}: {
  onPick: (variant: NodeVariant) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const items: { v: NodeVariant; label: string; help: string }[] = [
    { v: 'prompt', label: 'prompt', help: 'Run an LLM prompt with the run context.' },
    { v: 'bash', label: 'bash', help: 'Run a shell snippet.' },
    { v: 'skill', label: 'skill', help: 'Invoke a registered skill (e.g. omni-digest).' },
    { v: 'cft', label: 'cft', help: 'Run a CFT (e.g. pdca, swot).' },
    { v: 'approval', label: 'approval', help: 'Pause for human approval.' },
    { v: 'if', label: 'if', help: 'Branch on a boolean condition (then / else).' },
    { v: 'switch', label: 'switch', help: 'N-way branch on an expression value.' },
    { v: 'iteration', label: 'iteration', help: 'Run a bash body for each element of an array.' },
    { v: 'classify', label: 'classify', help: 'LLM picks one class label from a list.' },
    { v: 'extract', label: 'extract', help: 'LLM fills a JSON schema from free text.' },
    { v: 'set', label: 'set', help: 'Build a record of derived values.' },
    { v: 'filter', label: 'filter', help: 'Keep array elements where a condition holds.' },
    { v: 'template', label: 'template', help: '{{var}} substitution into a string template.' },
    { v: 'http', label: 'http', help: 'HTTP request (GET/POST/...). Parsed JSON output.' },
    { v: 'scheduleTrigger', label: 'schedule', help: 'Cron / interval trigger (daemon-side dispatch v2).' },
    { v: 'webhookTrigger', label: 'webhook', help: 'HTTP entry point (daemon-side dispatch v2).' },
  ];
  const filtered = items.filter((it) =>
    it.label.includes(query.toLowerCase()) || it.help.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className="absolute right-0 top-0 z-20 flex h-full w-72 flex-col border-l border-border bg-surface-elevated shadow-xl">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-xs font-semibold">Add node</span>
        <button
          type="button"
          onClick={onClose}
          className="text-[11px] text-text-tertiary hover:text-text-primary"
          title="Close (Esc)"
        >
          ✕
        </button>
      </div>
      <div className="border-b border-border px-3 py-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search variants…"
          autoFocus
          className="w-full rounded-md border border-border bg-surface px-2 py-1 text-xs"
        />
      </div>
      <ul className="flex-1 overflow-y-auto px-2 py-2">
        {filtered.length === 0 && (
          <li className="px-2 py-1 text-[11px] text-text-tertiary">No matches.</li>
        )}
        {filtered.map((it) => (
          <li key={it.v}>
            <button
              type="button"
              onClick={() => onPick(it.v)}
              className="flex w-full flex-col items-start gap-0.5 rounded px-2 py-1.5 text-left text-[11px] hover:bg-surface"
            >
              <span
                className="inline-block rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-white"
                style={{ background: VARIANT_COLOR[it.v] }}
              >
                {it.label}
              </span>
              <span className="text-text-tertiary">{it.help}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Tier E4.2 (2026-05-11) — custom node component. Renders the node
 *  card body with explicit Left/Right handles, and switches to a
 *  compact variant when the canvas zoom drops below 0.7 (조감 모드).
 *
 *  Subscribes to ReactFlow's transform via `useStore` so React only
 *  re-renders when the zoom crosses the breakpoint, not on every
 *  zoom delta. */
const ZOOM_COMPACT_BREAKPOINT = 0.7;
type WorkflowNodeData = {
  raw: {
    id: string;
    variant: NodeVariant;
    badge: string;
    preview: string;
    hasWhen: boolean;
    triggerRule?: string;
    hasToolPolicy: boolean;
    approvalDelivery?: string;
    /** Node-catalog v2 (2026-05-11) — branch labels for if/switch
     *  multi-handle visualization. Other variants leave this undefined
     *  and render a single source handle on the right. */
    branches?: string[];
  };
  statusEntry?: NodeStatusEntry;
  issues?: ValidationIssue[];
  inCycle: boolean;
};

function WorkflowNodeView({ data }: NodeProps) {
  const { raw, statusEntry, issues } = data as WorkflowNodeData;
  const compact = useReactFlowStore(
    (s: { transform: [number, number, number] }) => s.transform[2] < ZOOM_COMPACT_BREAKPOINT,
  );
  const branches = raw.branches;
  return (
    <>
      <Handle type="target" position={Position.Left} />
      {compact ? (
        <CompactNodeCard raw={raw} statusEntry={statusEntry} />
      ) : (
        renderNodeCard(raw, statusEntry, issues)
      )}
      {/* Node-catalog v2 (2026-05-11) — multi-handle for if/switch.
       *  Each branch gets its own labeled handle on the right edge,
       *  positioned so they're visually distinct. Default (single
       *  source handle) for all other variants. */}
      {branches && branches.length > 0 ? (
        branches.map((branch, i) => {
          // Evenly distribute handles along the right edge.
          const topPct = ((i + 1) / (branches.length + 1)) * 100;
          return (
            <Handle
              key={branch}
              type="source"
              position={Position.Right}
              id={branch}
              style={{ top: `${topPct}%` }}
            >
              <span
                aria-hidden
                style={{
                  position: 'absolute',
                  right: 14,
                  top: -2,
                  fontSize: 8,
                  color: 'var(--text-tertiary, #6b7280)',
                  pointerEvents: 'none',
                  whiteSpace: 'nowrap',
                }}
              >
                {branch}
              </span>
            </Handle>
          );
        })
      ) : (
        <Handle type="source" position={Position.Right} />
      )}
    </>
  );
}

/** Tier E4.2 (2026-05-11) — compact card body for the 조감 모드 zoom.
 *  Strips the preview / metadata row; keeps the variant pill, id, and
 *  status dot so the user can still tell what the node is at a glance. */
function CompactNodeCard({
  raw,
  statusEntry,
}: {
  raw: WorkflowNodeData['raw'];
  statusEntry?: NodeStatusEntry;
}) {
  const tone = statusEntry ? STATUS_TONE[statusEntry.status] : null;
  return (
    <div style={{ padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 6 }}>
      <span
        style={{
          display: 'inline-block',
          padding: '0 5px',
          borderRadius: 3,
          fontSize: 9,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: 0.4,
          background: VARIANT_COLOR[raw.variant],
          color: 'white',
        }}
      >
        {raw.badge}
      </span>
      <span style={{ fontSize: 11, fontWeight: 500 }}>{raw.id}</span>
      {tone && (
        <span
          style={{
            display: 'inline-block',
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: tone.dot,
            marginLeft: 'auto',
          }}
        />
      )}
    </div>
  );
}

/** Render a small card body. Uses inline JSX so the variant pill +
 *  preview line stay legible even at the default ReactFlow zoom.
 *
 *  Tier 2 W4 (2026-05-11) — accepts an optional `statusEntry` to
 *  paint a per-node last-run dot beside the variant pill, and
 *  surfaces the approval node's `delivery` channel as an inline icon
 *  on the metadata row so users can see "this approval pings via
 *  pushcut" without opening the editor drawer. */
function renderNodeCard(
  n: {
    id: string;
    variant: NodeVariant;
    badge: string;
    preview: string;
    hasWhen: boolean;
    triggerRule?: string;
    hasToolPolicy: boolean;
    approvalDelivery?: string;
  },
  statusEntry?: NodeStatusEntry,
  issues?: ValidationIssue[],
): React.ReactNode {
  const tone = statusEntry ? STATUS_TONE[statusEntry.status] : null;
  const deliveryIcon = getDeliveryIcon(n.approvalDelivery);
  const statusTitle = statusEntry
    ? `Last run: ${tone?.label ?? statusEntry.status}`
      + (statusEntry.durationMs !== undefined ? ` · ${statusEntry.durationMs}ms` : '')
      + (statusEntry.error ? ` · ${statusEntry.error}` : '')
      + (statusEntry.reason ? ` · ${statusEntry.reason}` : '')
    : undefined;
  const issueCount = issues?.length ?? 0;
  const issueTitle = issueCount > 0
    ? `${issueCount} validation issue${issueCount === 1 ? '' : 's'}:\n`
      + issues!.map((i) => `· ${i.message}`).join('\n')
    : undefined;
  return (
    <div style={{ padding: '6px 8px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
        <span
          style={{
            display: 'inline-block',
            padding: '0 5px',
            borderRadius: 3,
            fontSize: 9,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: 0.4,
            background: VARIANT_COLOR[n.variant],
            color: 'white',
          }}
        >
          {n.badge}
        </span>
        <span style={{ fontWeight: 500, fontSize: 11 }}>{n.id}</span>
        {tone && (
          <span
            aria-label={statusTitle}
            title={statusTitle}
            style={{
              display: 'inline-block',
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: tone.dot,
              flexShrink: 0,
              boxShadow: statusEntry?.status === 'running'
                ? `0 0 0 2px ${tone.dot}33`
                : undefined,
            }}
          />
        )}
        {issueCount > 0 && (
          <span
            aria-label={issueTitle}
            title={issueTitle}
            style={{
              fontSize: 10,
              color: '#ef4444',
              fontWeight: 700,
              flexShrink: 0,
            }}
          >
            ⚠
          </span>
        )}
        {deliveryIcon && (
          <span
            aria-label={`delivery: ${n.approvalDelivery}`}
            title={`Delivery: ${n.approvalDelivery}`}
            style={{ fontSize: 10, marginLeft: 'auto', flexShrink: 0 }}
          >
            {deliveryIcon}
          </span>
        )}
      </div>
      {n.preview && (
        <div
          style={{
            fontSize: 10,
            opacity: 0.75,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {n.preview}
        </div>
      )}
      {(n.hasWhen || n.triggerRule || n.hasToolPolicy) && (
        <div style={{ display: 'flex', gap: 4, marginTop: 3, fontSize: 9, opacity: 0.7 }}>
          {n.hasWhen && <span>when</span>}
          {n.triggerRule && <span>{n.triggerRule}</span>}
          {n.hasToolPolicy && <span>tools</span>}
        </div>
      )}
    </div>
  );
}
