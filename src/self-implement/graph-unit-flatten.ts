import type { GraphEdgeSpec, GraphTemplateSpec } from './graph-yaml.js';

export interface StaticGraphUnit {
  readonly path: string;
  readonly template: GraphTemplateSpec;
}

export type StaticUnitResolver = (call: string, callerPath: string) => StaticGraphUnit;

/** Expand calls for static readers (PWA/anatomy) while the runner keeps executing child runs. */
export function flattenGraphUnits(
  graph: GraphTemplateSpec,
  graphPath: string,
  resolve: StaticUnitResolver,
  ancestors: readonly string[] = [],
): GraphTemplateSpec {
  if (ancestors.includes(graph.graphId)) throw new Error(`unit cycle: ${[...ancestors, graph.graphId].join(' -> ')}`);
  if (ancestors.length > 3) throw new Error('unit nesting exceeds depth 3');

  let nodes = [...graph.nodes];
  let edges = [...graph.edges];
  let entryNode = graph.entryNode;
  const terminals = [...graph.terminalNodes];

  for (const callNode of graph.nodes) {
    if (callNode.kind !== 'subgraph' || !callNode.call) continue;
    const unit = resolve(callNode.call, graphPath);
    const unitHeader = unit.template.unit;
    const selectedEntry = callNode.callEntry ?? unit.template.entryNode;
    if (!unitHeader || !(unitHeader.entries ?? [unit.template.entryNode]).includes(selectedEntry)) {
      throw new Error(`unit entry mismatch: ${callNode.nodeId} -> ${selectedEntry}`);
    }
    const nested = flattenGraphUnits({ ...unit.template, entryNode: selectedEntry }, unit.path, resolve, [...ancestors, graph.graphId]);
    // Earlier calls may already have rewritten this call's destinations.
    const outgoing = edges.find((edge) => edge.from === callNode.nodeId);
    if (!outgoing || outgoing.on !== 'outcome' || !outgoing.map ||
        Object.keys(outgoing.map).length !== unitHeader.exits.length ||
        unitHeader.exits.some((exit) => !Object.hasOwn(outgoing.map!, exit)) ||
        !callNode.contract ||
        callNode.contract.inputs.length !== unitHeader.inputs.length ||
        callNode.contract.inputs.some((key) => !unitHeader.inputs.includes(key)) ||
        callNode.contract.outputs.length !== unitHeader.outputs.length ||
        callNode.contract.outputs.some((key) => !unitHeader.outputs.includes(key))) {
      throw new Error(`unit contract mismatch: ${callNode.nodeId} -> ${callNode.call}`);
    }

    const prefix = (id: string) => `${callNode.nodeId}__${id}`;
    const childIds = new Map(nested.nodes.map((node) => [node.nodeId, prefix(node.nodeId)]));
    const parentIds = new Set(nodes.filter((node) => node.nodeId !== callNode.nodeId).map((node) => node.nodeId));
    for (const node of nested.nodes) {
      if (!unitHeader.exits.includes(node.nodeId) && parentIds.has(prefix(node.nodeId))) {
        throw new Error(`flattened unit node collision: ${prefix(node.nodeId)}`);
      }
    }
    const exitTargets = new Map(unitHeader.exits.map((exit) => [exit, outgoing.map![exit]!]));
    if (unitHeader.exits.includes(nested.entryNode) && exitTargets.get(nested.entryNode) === callNode.nodeId) {
      throw new Error(`unit entry exit cannot map back to its own call: ${callNode.nodeId} -> ${nested.entryNode}`);
    }
    const childEntry = unitHeader.exits.includes(nested.entryNode)
      ? exitTargets.get(nested.entryNode)!
      : childIds.get(nested.entryNode);
    if (!childEntry) throw new Error(`unit entry missing: ${callNode.nodeId} -> ${selectedEntry}`);
    const childTarget = (id: string): string => {
      if (unitHeader.exits.includes(id)) {
        const target = exitTargets.get(id)!;
        // A caller exit mapped back into its own call re-enters the flattened unit at its entry.
        return target === callNode.nodeId ? childEntry : target;
      }
      const mapped = childIds.get(id);
      if (!mapped) throw new Error(`unit edge target missing: ${unit.template.graphId}/${id}`);
      return mapped;
    };

    const rewriteTarget = (edge: GraphEdgeSpec, target: string): string => target === callNode.nodeId ? childEntry : target;
    const rewrittenParentEdges = edges
      .filter((edge) => edge.from !== callNode.nodeId)
      .map((edge) => ({
        ...edge,
        from: rewriteTarget(edge, edge.from),
        ...(edge.to ? { to: rewriteTarget(edge, edge.to) } : {}),
        ...(edge.map ? { map: Object.fromEntries(Object.entries(edge.map).map(([outcome, target]) => [outcome, rewriteTarget(edge, target)])) } : {}),
        ...(edge.fallback ? { fallback: edge.fallback.map((item) => ({ ...item, node: rewriteTarget(edge, item.node) })) } : {}),
      }));
    const childNodes = nested.nodes.filter((node) => !unitHeader.exits.includes(node.nodeId))
      .map((node) => ({ ...node, nodeId: childIds.get(node.nodeId)! }));
    const childEdges = nested.edges.filter((edge) => !unitHeader.exits.includes(edge.from)).map((edge) => ({
      ...edge,
      from: childIds.get(edge.from) ?? childTarget(edge.from),
      ...(edge.to ? { to: childTarget(edge.to) } : {}),
      ...(edge.map ? { map: Object.fromEntries(Object.entries(edge.map).map(([outcome, target]) => [outcome, childTarget(target)])) } : {}),
      ...(edge.fallback ? { fallback: edge.fallback.map((item) => ({ ...item, node: childTarget(item.node) })) } : {}),
    }));

    nodes = nodes.filter((node) => node.nodeId !== callNode.nodeId).concat(childNodes);
    edges = rewrittenParentEdges.concat(childEdges);
    if (entryNode === callNode.nodeId) entryNode = childEntry;
    // Unit exits are replaced by their caller's mapped destinations. `terminals`
    // belongs to the parent graph; removing by child exit name can erase a
    // same-named parent terminal that is still present in the flattened graph.
  }

  return { ...graph, entryNode, terminalNodes: terminals, nodes, edges, unit: undefined };
}
