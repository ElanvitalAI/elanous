import { topoSort } from '../workflow-runtime/schema.js';
import type { DagNode, WorkflowDefinition } from '../workflow-runtime/types.js';
import type { GraphEdgeSpec, GraphNodeSpec, GraphTemplateSpec } from '../self-implement/graph-yaml.js';
import { WORKFLOW_CORE_KINDS } from '../graph-kinds/registry.js';

/** In-memory graph projection. The compatibility executor dispatches these
 * workflow recipes; graph-runner cannot execute all workflow node variants yet. */
export interface WorkflowGraph {
  readonly template: GraphTemplateSpec;
  readonly recipes: Readonly<Record<string, DagNode>>;
}

export type WorkflowGraphResult =
  | { readonly ok: true; readonly graph: WorkflowGraph }
  | { readonly ok: false; readonly reason: string };

/** Project a validated workflow without changing its YAML or executing any work.
 * Reject constructs whose graph projection would silently change DAG semantics. */
export function workflowToGraph(workflow: WorkflowDefinition): WorkflowGraphResult {
  if ((workflow.concurrency ?? 1) !== 1) return { ok: false, reason: 'concurrency > 1' };
  if (!workflow.nodes.length) return { ok: false, reason: 'empty workflow' };
  if (workflow.nodes.some(node => node.on_error)) {
    return { ok: false, reason: 'error routing' };
  }
  let order: string[];
  try { order = topoSort(workflow.nodes); }
  catch (error) { return { ok: false, reason: String(error) }; }
  if (order.length !== workflow.nodes.length || new Set(order).size !== order.length) {
    return { ok: false, reason: 'invalid topology' };
  }
  const byId = new Map(workflow.nodes.map(node => [node.id, node] as const));
  const recipes: Record<string, DagNode> = Object.create(null);
  const nodes: GraphNodeSpec[] = [];
  for (const id of order) {
    const node = byId.get(id)!;
    const kind = typeof node.kind === 'string' ? node.kind
      : WORKFLOW_CORE_KINDS.find(key => key !== 'subworkflow' && key in node);
    if (!kind) {
      return { ok: false, reason: `unknown node variant: ${id}` };
    }
    recipes[id] = node;
    nodes.push({ nodeId: id, kind, recipe: `workflow:${id}`, maxVisits: 1 });
  }
  // A single cursor visits each node exactly once in the same stable topological
  // order as the serial workflow executor. Preserve original dependencies and
  // conditions in recipes; do not mistake a when expression for a graph outcome.
  const edges: GraphEdgeSpec[] = order.slice(1).map((id, index) => ({ from: order[index]!, to: id }));
  const template: GraphTemplateSpec = {
    graphId: workflow.name, version: 1, entryNode: order[0]!, terminalNodes: [order.at(-1)!],
    nodes, edges,
  };
  return { ok: true, graph: { template, recipes } };
}

/** The workflow compatibility cursor follows the projected graph edges, not
 * the source DAG. The WF event adapter remains the owner of node dispatch. */
export function walkWorkflowGraph(graph: WorkflowGraph): string[] {
  const order: string[] = [];
  const visited = new Set<string>();
  let current: string | undefined = graph.template.entryNode;
  while (current !== undefined) {
    const spec = graph.template.nodes.find(node => node.nodeId === current);
    if (visited.has(current) || !spec || spec.recipe !== `workflow:${current}` || spec.maxVisits !== 1
      || !Object.hasOwn(graph.recipes, current)) throw new Error(`invalid workflow graph cursor: ${current}`);
    const recipe = graph.recipes[current]!;
    const kind = typeof recipe.kind === 'string' ? recipe.kind
      : WORKFLOW_CORE_KINDS.find(key => key !== 'subworkflow' && key in recipe);
    if (recipe.id !== current || kind !== spec.kind) throw new Error(`invalid workflow graph recipe: ${current}`);
    visited.add(current);
    order.push(current);
    const outgoing: GraphEdgeSpec[] = graph.template.edges.filter(edge => edge.from === current);
    if (outgoing.length > 1 || outgoing.some(edge => edge.to === undefined)) throw new Error(`invalid workflow graph edge: ${current}`);
    current = outgoing[0]?.to;
  }
  if (order.length !== graph.template.nodes.length || !graph.template.terminalNodes.includes(order.at(-1)!)) {
    throw new Error('incomplete workflow graph path');
  }
  return order;
}
