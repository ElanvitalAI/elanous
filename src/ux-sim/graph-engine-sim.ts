import { nextNode, withGrowth } from '../graph-runner/runner.js';
import type { GraphGrowth } from '../graph-runner/graph-grow.js';
import type { GraphEdgeSpec, GraphTemplateSpec } from '../self-implement/graph-yaml.js';

/** Synthetic component result supplied to the simulator; no node executor or external effect is run. */
export interface GraphEngineSimExit {
  readonly nodeId: string;
  readonly outcome: 'success' | 'failure' | 'missing' | 'stuck' | 'budget-exceeded' | (string & {});
}

export interface GraphEngineSimObservation {
  readonly from: string;
  readonly outcome: string;
  readonly to?: string;
  readonly growthApplied: boolean;
  readonly sourceGraphUnchanged: boolean;
}

/**
 * GRAPH-ENGINE-SIM: inject only a component's exit label and run the production graph-growth and
 * edge-selector functions. This is a selector device, not a simulated executor or live graph run.
 */
export function simGraphEngineSelection(input: {
  graph: GraphTemplateSpec;
  exit: GraphEngineSimExit;
  growth?: GraphGrowth;
}): GraphEngineSimObservation {
  const sourceEdges = input.graph.edges;
  const graph = input.growth ? withGrowth(input.graph, [input.growth]) : input.graph;
  const isSuccess = input.exit.outcome === 'success';
  const to = nextNode(graph.edges, input.exit.nodeId, isSuccess ? 'ok' : 'fail', input.exit.outcome);
  return {
    from: input.exit.nodeId,
    outcome: input.exit.outcome,
    ...(to === undefined ? {} : { to }),
    growthApplied: graph !== input.graph,
    sourceGraphUnchanged: input.graph.edges === sourceEdges,
  };
}

/** Small receipt useful to command-line and test consumers. */
export function renderGraphEngineSim(observation: GraphEngineSimObservation): string {
  return `${observation.from} --${observation.outcome}--> ${observation.to ?? '(no edge)'} · growth=${observation.growthApplied ? 'applied' : 'none'} · source-unchanged=${observation.sourceGraphUnchanged}`;
}

/** Keep the production selector's accepted edge shape visible to device authors. */
export type GraphEngineSimEdges = readonly GraphEdgeSpec[];
