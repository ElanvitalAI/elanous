import type { GraphTemplate } from './graph-templates.js';
import type { GraphTemplateSpec } from './graph-yaml.js';
import type { RunLedgerEntry } from './run-ledger.js';

type RuntimeOverlayGraph = Pick<GraphTemplate, 'nodes' | 'edges'> | Pick<GraphTemplateSpec, 'nodes' | 'edges'>;

const DEFAULT_OUTCOME = '$default';
const ABSENT_ROUTE = '$absent';

export interface RuntimeOverlayRunStepsInput {
  readonly runId: string;
  readonly timestamp: string;
  readonly before: RuntimeOverlayGraph;
  readonly after: RuntimeOverlayGraph;
  readonly overlayIds: readonly string[];
  readonly round: number;
}

interface GraphRoute {
  readonly from: string;
  readonly outcome: string;
  readonly to: string;
}

function routesOf(graph: RuntimeOverlayGraph): Map<string, GraphRoute> {
  const routes = new Map<string, GraphRoute>();
  if (!Array.isArray(graph.edges)) {
    const compiledEdges = graph.edges as Readonly<Record<string, readonly string[]>>;
    for (const [from, destinations] of Object.entries(compiledEdges)) {
      for (const [index, to] of destinations.entries()) {
        routes.set(`${from}\u0000${index}`, { from, outcome: String(index), to: String(to) });
      }
    }
    return routes;
  }
  for (const edge of graph.edges) {
    if (edge.to !== undefined) {
      routes.set(`${edge.from}\u0000${DEFAULT_OUTCOME}`, { from: edge.from, outcome: DEFAULT_OUTCOME, to: edge.to });
      continue;
    }
    for (const [outcome, to] of Object.entries(edge.map ?? {})) {
      routes.set(`${edge.from}\u0000${outcome}`, { from: edge.from, outcome, to: String(to) });
    }
  }
  return routes;
}

function reason(input: RuntimeOverlayRunStepsInput): string {
  return `runtime overlay ${input.overlayIds.join(', ')} applied at round ${input.round}`;
}

/** Convert an already accepted runtime overlay into the existing structural ledger vocabulary. */
export function runtimeOverlayRunSteps(input: RuntimeOverlayRunStepsInput): RunLedgerEntry[] {
  if (input.overlayIds.length === 0) return [];
  const detail = reason(input);
  const beforeNodes = new Set(input.before.nodes.map((node) => node.nodeId));
  const entries: RunLedgerEntry[] = input.after.nodes
    .filter((node) => !beforeNodes.has(node.nodeId))
    .map((node) => ({
      timestamp: input.timestamp,
      runId: input.runId,
      event: 'node-added',
      data: {
        node: node.nodeId,
        kind: node.kind,
        decider: 'runtime-overlay',
        reason: detail,
        trigger: { overlayIds: input.overlayIds, round: input.round },
      },
    }));

  const beforeRoutes = routesOf(input.before);
  const afterRoutes = routesOf(input.after);
  const changedRoutes = [...afterRoutes.entries()]
    .filter(([key, route]) => beforeRoutes.get(key)?.to !== route.to)
    .sort(([left], [right]) => left.localeCompare(right));
  for (const [key, route] of changedRoutes) {
    entries.push({
      timestamp: input.timestamp,
      runId: input.runId,
      event: 'edge-rerouted',
      data: {
        from: route.from,
        outcome: route.outcome,
        to: route.to,
        was: beforeRoutes.get(key)?.to ?? ABSENT_ROUTE,
        decider: 'runtime-overlay',
        reason: detail,
      },
    });
  }
  return entries;
}

export { ABSENT_ROUTE, DEFAULT_OUTCOME };
