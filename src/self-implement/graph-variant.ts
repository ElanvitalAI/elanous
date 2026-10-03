import { createHash } from 'node:crypto';
import { applyGraphOverlays, type GraphOverlaySpec, type OverlayPatchOp, type OverlayRejection } from './graph-overlay-yaml.js';
import { edgeMapOf, graphVersionHash, type GraphEdgeSpec, type GraphNodeSpec, type GraphTemplateSpec } from './graph-yaml.js';
import { inspectPipelineGraph } from './pipeline-shape.js';
import { hasNodeKind } from '../graph-kinds/registry.js';

/** A proposed change to one existing outcome of a conditional route. Unconditional and fallback edges are protected. */
export interface GraphVariantRoute {
  readonly from: string;
  readonly outcome: string;
  readonly to: string;
}

export interface GraphVariantGrowth {
  readonly node: GraphNodeSpec;
  readonly from: string;
  readonly outcome: string;
  readonly returnTo?: string;
}

export interface GraphVariantPlan {
  readonly maxVisits?: Readonly<Record<string, number>>;
  readonly routes?: readonly GraphVariantRoute[];
  readonly growth?: GraphVariantGrowth;
}

export type GraphVariantRejection =
  | { readonly kind: 'invalid-goal' }
  | { readonly kind: 'unknown-node'; readonly node: string }
  | { readonly kind: 'invalid-budget'; readonly node: string; readonly value: number }
  | { readonly kind: 'protected-edge'; readonly from: string; readonly outcome: string }
  | { readonly kind: 'unknown-outcome'; readonly from: string; readonly outcome: string }
  | { readonly kind: 'duplicate-route'; readonly from: string; readonly outcome: string }
  | { readonly kind: 'ambiguous-outcome'; readonly from: string; readonly outcome: string }
  | { readonly kind: 'unreachable-terminal'; readonly node: string }
  | { readonly kind: 'invalid-graph'; readonly defects: ReturnType<typeof inspectPipelineGraph> }
  | { readonly kind: 'overlay-rejected'; readonly rejections: readonly OverlayRejection[] }
  | { readonly kind: 'invalid-growth'; readonly reason: string };

export type GraphVariantResult =
  | { readonly ok: true; readonly overlay: GraphOverlaySpec; readonly template: GraphTemplateSpec; readonly patches: readonly OverlayPatchOp[] }
  | { readonly ok: false; readonly rejections: readonly GraphVariantRejection[] };

/** Pure, deterministic variant authoring. Never mutates the supplied template and never writes an overlay. */
export function createGraphVariant(input: {
  readonly template: GraphTemplateSpec;
  readonly goal: string;
  readonly plan: GraphVariantPlan;
}): GraphVariantResult {
  const { template, goal, plan } = input;
  const known = new Set(template.nodes.map((node) => node.nodeId));
  const rejections: GraphVariantRejection[] = [];
  if (!/^g_[a-z0-9_-]+$/i.test(goal)) rejections.push({ kind: 'invalid-goal' });
  if (plan.growth) {
    const { node, from, outcome, returnTo } = plan.growth;
    if (!node || typeof node !== 'object') return { ok: false, rejections: [{ kind: 'invalid-growth', reason: 'growth requires one new contracted node' }] };
    const edgeIndex = template.edges.findIndex((edge) => edge.from === from);
    const edge = template.edges[edgeIndex];
    if (!known.has(from) || known.has(node.nodeId) || template.terminalNodes.includes(from) ||
        typeof node.nodeId !== 'string' || !node.nodeId || typeof node.recipe !== 'string' || !node.recipe ||
        typeof node.kind !== 'string' || !hasNodeKind('harness', node.kind) || !Number.isSafeInteger(node.maxVisits) || node.maxVisits < 1 ||
        typeof node.contract?.tools !== 'string' || !node.contract.tools.trim() || !Array.isArray(node.contract.inputs) ||
        !Array.isArray(node.contract.outputs) || typeof outcome !== 'string' || !outcome || !edge || edge.to !== undefined || edge.on !== 'outcome' ||
        !edge.map || Object.hasOwn(edge.map, outcome) ||
        template.edges.filter((candidate) => candidate.from === from).length !== 1 ||
        typeof returnTo !== 'string' || !known.has(returnTo) || plan.routes?.length || Object.keys(plan.maxVisits ?? {}).length) {
      rejections.push({ kind: 'invalid-growth', reason: 'growth requires one new contracted node, one missing conditional outcome and an existing return destination' });
    }
    if (rejections.length) return { ok: false, rejections };
    const addedEdge: GraphEdgeSpec = { from: node.nodeId, to: returnTo as string };
    const patches: OverlayPatchOp[] = [
      { op: 'add', path: '/nodes/-', value: node },
      { op: 'add', path: `/edges/${edgeIndex}/map/${outcome.replace(/~/g, '~0').replace(/\//g, '~1')}`, value: node.nodeId },
      { op: 'add', path: '/edges/-', value: addedEdge },
    ];
    const normalized = JSON.stringify({ graph: graphVersionHash(template), goal, patches });
    const overlay: GraphOverlaySpec = { overlayId: `variant-${createHash('sha256').update(normalized).digest('hex').slice(0, 16)}`,
      target: template.graphId, stage: 'runtime', appliesWhen: `goal_key == ${goal}`, patch: patches };
    // Existing YAML runner nodes predate contracts; only the newly proposed node must supply one.
    const validationTemplate: GraphTemplateSpec = { ...template, nodes: template.nodes.map((existing) => ({
      ...existing, contract: existing.contract?.tools ? existing.contract : { inputs: [], tools: 'existing', outputs: [] },
    })) };
    const applied = applyGraphOverlays(validationTemplate, [overlay]);
    if (!applied.ok) return { ok: false, rejections: [{ kind: 'overlay-rejected', rejections: applied.rejections }] };
    const projected: GraphTemplateSpec = { ...applied.template, nodes: [...template.nodes, node] };
    const edges = edgeMapOf(projected);
    const reached = new Set<string>();
    const pending = [projected.entryNode];
    while (pending.length) {
      const at = pending.pop()!;
      if (reached.has(at)) continue;
      reached.add(at);
      pending.push(...(edges[at] ?? []));
    }
    const unreachable = projected.terminalNodes.filter((terminal) => !reached.has(terminal) || (edges[terminal]?.length ?? 0) !== 0);
    if (unreachable.length) return { ok: false, rejections: unreachable.map((terminal) => ({ kind: 'unreachable-terminal', node: terminal })) };
    return { ok: true, overlay, template: projected, patches };
  }
  const patches: OverlayPatchOp[] = [];

  for (const [node, value] of Object.entries(plan.maxVisits ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (!known.has(node)) { rejections.push({ kind: 'unknown-node', node }); continue; }
    if (!Number.isSafeInteger(value) || value < 1) { rejections.push({ kind: 'invalid-budget', node, value }); continue; }
    const index = template.nodes.findIndex((candidate) => candidate.nodeId === node);
    if (template.nodes[index]!.maxVisits !== value) patches.push({ op: 'replace', path: `/nodes/${index}/maxVisits`, value });
  }

  const seen = new Set<string>();
  for (const route of [...(plan.routes ?? [])].sort((a, b) => {
    const left = JSON.stringify([a.from, a.outcome, a.to]);
    const right = JSON.stringify([b.from, b.outcome, b.to]);
    return left < right ? -1 : left > right ? 1 : 0;
  })) {
    if (!known.has(route.from)) { rejections.push({ kind: 'unknown-node', node: route.from }); continue; }
    if (!known.has(route.to)) { rejections.push({ kind: 'unknown-node', node: route.to }); continue; }
    const key = JSON.stringify([route.from, route.outcome]);
    if (seen.has(key)) { rejections.push({ kind: 'duplicate-route', from: route.from, outcome: route.outcome }); continue; }
    seen.add(key);
    const matches = template.edges.filter((edge) => edge.from === route.from && edge.map && Object.hasOwn(edge.map, route.outcome));
    // One patch addresses one edge, so an outcome declared on two conditional edges would validate a graph we do not return.
    if (matches.length > 1) { rejections.push({ kind: 'ambiguous-outcome', from: route.from, outcome: route.outcome }); continue; }
    const conditional = matches[0];
    if (!conditional) {
      const protectedEdge = template.edges.some((edge) => edge.from === route.from && (edge.to !== undefined || edge.fallback?.length));
      rejections.push(protectedEdge
        ? { kind: 'protected-edge', from: route.from, outcome: route.outcome }
        : { kind: 'unknown-outcome', from: route.from, outcome: route.outcome });
      continue;
    }
    const index = template.edges.indexOf(conditional);
    if (conditional.map![route.outcome] !== route.to) {
      // JSON Pointer escaping keeps even unusual, already-declared outcome labels addressable.
      const label = route.outcome.replace(/~/g, '~0').replace(/\//g, '~1');
      patches.push({ op: 'replace', path: `/edges/${index}/map/${label}`, value: route.to });
    }
  }
  if (rejections.length > 0) return { ok: false, rejections };

  const projected: GraphTemplateSpec = {
    ...template,
    nodes: template.nodes.map((node) => ({ ...node, maxVisits: plan.maxVisits?.[node.nodeId] ?? node.maxVisits })),
    edges: template.edges.map((edge) => edge.map === undefined ? edge : {
      ...edge,
      map: Object.fromEntries(Object.entries(edge.map).map(([outcome, to]) => [outcome,
        plan.routes?.find((route) => route.from === edge.from && route.outcome === outcome)?.to ?? to])),
    }),
  };
  const edges = edgeMapOf(projected);
  const defects = inspectPipelineGraph(edges, projected.entryNode);
  const reached = new Set<string>();
  const pending = [projected.entryNode];
  while (pending.length) {
    const node = pending.pop()!;
    if (reached.has(node)) continue;
    reached.add(node);
    for (const to of edges[node] ?? []) pending.push(to);
  }
  const unreachable = projected.terminalNodes.filter((node) => !reached.has(node) || (edges[node]?.length ?? 0) !== 0);
  if (unreachable.length > 0) return { ok: false, rejections: unreachable.map((node) => ({ kind: 'unreachable-terminal', node })) };
  if (defects.length > 0) return { ok: false, rejections: [{ kind: 'invalid-graph', defects }] };
  const normalized = JSON.stringify({ graph: graphVersionHash(template), goal, patches });
  const overlayId = `variant-${createHash('sha256').update(normalized).digest('hex').slice(0, 16)}`;
  const overlay: GraphOverlaySpec = { overlayId, target: template.graphId, stage: 'launch', appliesWhen: `goal_key == ${goal}`, patch: patches };
  // Existing runner YAML nodes may predate contracts; the plan only changes routes and visits.
  const validationTemplate: GraphTemplateSpec = { ...template, nodes: template.nodes.map((node) => ({
    ...node, contract: node.contract?.tools ? node.contract : { inputs: [], tools: 'existing', outputs: [] },
  })) };
  const applied = applyGraphOverlays(validationTemplate, [overlay]);
  if (!applied.ok) return { ok: false, rejections: [{ kind: 'overlay-rejected', rejections: applied.rejections }] };
  return { ok: true, overlay, template: projected, patches };
}
