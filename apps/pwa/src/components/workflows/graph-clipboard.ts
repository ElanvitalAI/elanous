import { classifyNodeVariant, workflowToLayout, type WorkflowDefinitionLike } from './workflow-graph-layout';
import { nextFreeNodeId } from './workflow-graph-mutations';

export interface GraphClipboard {
  nodes: WorkflowDefinitionLike['nodes'];
  layout: Record<string, { x: number; y: number }>;
}

/** Snapshot selected nodes, keeping dependencies only when both endpoints are selected. */
export function copyNodes(
  def: WorkflowDefinitionLike,
  selectedIds: readonly string[],
): GraphClipboard | null {
  const selected = new Set(selectedIds);
  const nodes = (def.nodes ?? []).filter((node) => selected.has(node.id));
  if (nodes.length === 0) return null;

  const copiedIds = new Set(nodes.map((node) => node.id));
  const positions = new Map(workflowToLayout(def).nodes.map((node) => [node.id, node.position]));
  const layout: GraphClipboard['layout'] = {};
  for (const node of nodes) {
    const position = positions.get(node.id);
    if (position) layout[node.id] = { ...position };
  }

  return {
    nodes: nodes.map((node) => {
      const copy = structuredClone(node);
      if (Array.isArray(copy.depends_on)) {
        const internal = copy.depends_on.filter((id) => copiedIds.has(id));
        if (internal.length > 0) copy.depends_on = internal;
        else delete copy.depends_on;
      }
      return copy;
    }),
    layout,
  };
}

/** Append independent copies with fresh ids and positions shifted 40px on each axis. */
export function pasteNodes(
  def: WorkflowDefinitionLike,
  clipboard: GraphClipboard,
): WorkflowDefinitionLike {
  if (clipboard.nodes.length === 0) return def;

  const originals = def.nodes ?? [];
  const pasted: WorkflowDefinitionLike['nodes'] = [];
  const ids = new Map<string, string>();
  for (const node of clipboard.nodes) {
    const id = nextFreeNodeId({ ...def, nodes: [...originals, ...pasted] }, classifyNodeVariant(node));
    ids.set(node.id, id);
    pasted.push({ ...structuredClone(node), id });
  }

  const meta = def._meta && typeof def._meta === 'object'
    ? { ...(def._meta as Record<string, unknown>) }
    : {};
  const layout = meta.layout && typeof meta.layout === 'object'
    ? { ...(meta.layout as Record<string, { x: number; y: number }>) }
    : {};
  for (let i = 0; i < pasted.length; i += 1) {
    const node = pasted[i]!;
    const deps = node.depends_on?.map((id) => ids.get(id)).filter((id): id is string => id !== undefined);
    if (deps?.length) node.depends_on = deps;
    else delete node.depends_on;

    const position = clipboard.layout[clipboard.nodes[i]!.id];
    if (position) layout[node.id] = { x: position.x + 40, y: position.y + 40 };
  }
  if (Object.keys(layout).length > 0) meta.layout = layout;

  return {
    ...def,
    nodes: [...originals, ...pasted],
    ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
  };
}
