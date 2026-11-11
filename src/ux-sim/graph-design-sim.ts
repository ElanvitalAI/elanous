import { createHash } from 'node:crypto';
import { stringify } from 'yaml';
import type { GraphRunState } from '../graph-runner/runner.js';
import { simGraphEngineSelection } from './graph-engine-sim.js';
import { parseGraphTemplateYaml, type GraphEdgeSpec, type GraphTemplateSpec } from '../self-implement/graph-yaml.js';
import {
  applyAdaptiveGraphOperations,
  revisionForGraphSnapshot,
  type AdaptiveGraphOperation,
  type GraphDiffPlaybackChange,
} from './graph-diff-apply.js';

export interface AdaptiveGraphDiff {
  readonly revision: number;
  readonly eventId: string;
  readonly reason: string;
  readonly operations: readonly AdaptiveGraphOperation[];
}

export interface AdaptiveGraphOutput {
  readonly nodeId: string;
  readonly revision: number;
  readonly runId: string;
  readonly status: 'current' | 'superseded';
  readonly value?: unknown;
  readonly supersededBy?: number;
}

export interface AdaptiveGraphDesignState {
  readonly graphId: string;
  readonly runId: string;
  readonly revision: number;
  readonly graph: GraphTemplateSpec;
  readonly appliedEvents: Readonly<Record<string, string>>;
  readonly outputs: readonly AdaptiveGraphOutput[];
  readonly revisionGraphs: readonly RevisionGraph[];
}

export interface AdaptiveGraphDiffResult {
  readonly state: AdaptiveGraphDesignState;
  readonly replayed: boolean;
  readonly invalidatedNodeIds: readonly string[];
  readonly supersededOutputCount: number;
  readonly publishedYaml: string;
}

export type GraphDesignPlaybackDiff = GraphDiffPlaybackChange;

export interface GraphDesignPlaybackNode {
  readonly nodeId: string;
  readonly kind: string;
  readonly status: 'pending' | 'current' | 'superseded';
  readonly output?: unknown;
}

export interface GraphDesignPlaybackFrame {
  readonly revision: number;
  readonly nodes: readonly GraphDesignPlaybackNode[];
  readonly diff: readonly GraphDesignPlaybackDiff[];
  readonly conclusion?: string;
  readonly bloomQuestions?: readonly string[];
}

export interface GraphDesignPlaybackEnvelope {
  readonly runId: string;
  readonly frames: readonly GraphDesignPlaybackFrame[];
}

interface RevisionGraph {
  readonly revision: number;
  readonly graph: GraphTemplateSpec;
  readonly yaml: string;
  readonly diff: readonly GraphDesignPlaybackDiff[];
  readonly invalidatedNodeIds: readonly string[];
}

export interface GraphDesignPlaybackContext {
  readonly conclusions?: Readonly<Record<number, string>>;
  readonly bloomQuestions?: Readonly<Record<number, readonly string[]>>;
}

function graphYamlDocument(graph: GraphTemplateSpec): Record<string, unknown> {
  return {
    graph_id: graph.graphId,
    version: graph.version,
    entry_node: graph.entryNode,
    terminal_nodes: [...graph.terminalNodes],
    nodes: graph.nodes.map((node) => ({
      node_id: node.nodeId,
      kind: node.kind,
      recipe: node.recipe,
      max_visits: node.maxVisits,
      ...(node.needs === undefined ? {} : { needs: node.needs }),
      ...(node.resourceLocks === undefined ? {} : { resource_locks: node.resourceLocks }),
      ...(node.journeyStage === undefined ? {} : { journey_stage: node.journeyStage }),
      ...(node.progress === undefined ? {} : { progress: node.progress }),
      ...(node.phases === undefined ? {} : { phases: node.phases }),
      ...(node.terminalStages === undefined ? {} : { terminal_stages: node.terminalStages }),
      ...(node.fanOut === undefined ? {} : { fan_out: node.fanOut }),
      ...(node.contract === undefined ? {} : { contract: node.contract }),
      ...(node.input === undefined ? {} : { input: node.input }),
      ...(node.emits === undefined ? {} : { emits: node.emits }),
      ...(node.subscribes === undefined ? {} : { subscribes: node.subscribes }),
      ...(node.call === undefined ? {} : { call: node.call }),
      ...(node.callEntry === undefined ? {} : { call_entry: node.callEntry }),
      ...(node.budget === undefined ? {} : { budget: { inner_steps: node.budget.innerSteps } }),
      ...(node.allowance === undefined ? {} : { allowance: { inner_steps: node.allowance.innerSteps } }),
      ...(node.skipWhen === undefined ? {} : { skip_when: node.skipWhen }),
    })),
    edges: graph.edges.map((edge) => ({
      from: edge.from,
      ...(edge.to === undefined ? {} : { to: edge.to }),
      ...(edge.on === undefined ? {} : { on: edge.on }),
      ...(edge.map === undefined ? {} : { map: edge.map }),
      ...(edge.branches === undefined ? {} : { branches: edge.branches }),
      ...(edge.join === undefined ? {} : { join: edge.join }),
      ...(edge.warningBranches === undefined ? {} : { warning_branches: edge.warningBranches }),
      ...(edge.fallback === undefined ? {} : { fallback: edge.fallback }),
      ...(edge.observed === undefined ? {} : { observed: edge.observed }),
      ...(edge.when === undefined ? {} : { when: edge.when }),
    })),
    ...(graph.maxParallelNodes === undefined ? {} : { max_parallel_nodes: graph.maxParallelNodes }),
    ...(graph.journeyStages === undefined ? {} : { journey_stages: graph.journeyStages }),
    ...(graph.docsOnlyGateSkip === undefined ? {} : { docs_only_gate_skip: graph.docsOnlyGateSkip }),
    ...(graph.allowance === undefined ? {} : { allowance: { inner_steps: graph.allowance.innerSteps } }),
    ...(graph.unit === undefined ? {} : { unit: graph.unit }),
    ...(graph.state === undefined ? {} : { state: graph.state }),
    ...(graph.loop === undefined ? {} : { loop: graph.loop }),
  };
}

/** Serialize a manifest revision as the YAML artifact consumed by runGraph. */
export function serializeAdaptiveGraphYaml(graph: GraphTemplateSpec): string {
  return stringify(graphYamlDocument(graph));
}

function parseAndValidateYaml(source: string): GraphTemplateSpec {
  const parsed = parseGraphTemplateYaml(source, 'adaptive-graph.yaml');
  if (!parsed.template || parsed.errors.length > 0) {
    throw new Error(`adaptive graph YAML validation failed: ${parsed.errors.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`);
  }
  validateGraph(parsed.template);
  return parsed.template;
}

function fingerprint(diff: AdaptiveGraphDiff): string {
  return createHash('sha256').update(JSON.stringify(diff)).digest('hex');
}

function destinations(edge: GraphEdgeSpec): string[] {
  return [
    ...(edge.to ? [edge.to] : []),
    ...Object.values(edge.map ?? {}),
    ...Object.values(edge.branches ?? {}).flat(),
    ...(edge.fallback ?? []).map((entry) => entry.node),
  ];
}

function validateGraph(graph: GraphTemplateSpec): void {
  const ids = graph.nodes.map((node) => node.nodeId);
  const known = new Set(ids);
  if (known.size !== ids.length) throw new Error('adaptive graph contains duplicate node ids');
  if (!known.has(graph.entryNode)) throw new Error(`adaptive graph entry node missing: ${graph.entryNode}`);
  for (const terminal of graph.terminalNodes) if (!known.has(terminal)) throw new Error(`adaptive graph terminal missing: ${terminal}`);
  for (const edge of graph.edges) {
    if (!known.has(edge.from)) throw new Error(`adaptive graph edge source missing: ${edge.from}`);
    for (const target of destinations(edge)) if (!known.has(target)) throw new Error(`adaptive graph edge target missing: ${target}`);
  }
}

export function createAdaptiveGraphDesignState(graphYaml: string, runId: string): AdaptiveGraphDesignState {
  if (!runId.trim()) throw new Error('adaptive graph runId is required');
  const graph = parseAndValidateYaml(graphYaml);
  return { graphId: graph.graphId, runId, revision: graph.version, graph, appliedEvents: {}, outputs: [],
    revisionGraphs: [{ revision: graph.version, graph, yaml: graphYaml, diff: [], invalidatedNodeIds: [] }] };
}

/** Apply one complete design event to an in-memory manifest. Invalid diffs do not change the source state. */
export function applyAdaptiveGraphDiff(state: AdaptiveGraphDesignState, diff: AdaptiveGraphDiff): AdaptiveGraphDiffResult {
  const eventKey = `${state.graphId}:${state.runId}:${diff.revision}:${diff.eventId}`;
  const digest = fingerprint(diff);
  const prior = state.appliedEvents[eventKey];
  if (prior !== undefined) {
    if (prior !== digest) throw new Error(`adaptive graph idempotency key reused with different diff: ${diff.eventId}`);
    return { state, replayed: true, invalidatedNodeIds: [], supersededOutputCount: 0,
      publishedYaml: getAdaptiveGraphPublishedYaml(state, diff.revision) };
  }
  if (!diff.eventId.trim() || !diff.reason.trim()) throw new Error('adaptive graph diff requires eventId and reason');
  if (diff.revision !== state.revision + 1) throw new Error(`adaptive graph revision must be ${state.revision + 1}`);
  if (diff.operations.length === 0) throw new Error('adaptive graph diff must contain an operation');

  const applied = applyAdaptiveGraphOperations(state.graph, diff.operations, (candidate) => {
    parseAndValidateYaml(serializeAdaptiveGraphYaml({ ...candidate, version: diff.revision }));
  }, diff.reason);
  const candidateYaml = serializeAdaptiveGraphYaml({ ...applied.graph, version: diff.revision });
  const graph = parseAndValidateYaml(candidateYaml);
  const invalidatedNodeIds = applied.invalidatedNodeIds;
  const invalidated = new Set(invalidatedNodeIds);
  let supersededOutputCount = 0;
  const outputs = state.outputs.map((output) => {
    if (output.status !== 'current' || !invalidated.has(output.nodeId) || output.revision >= diff.revision) return output;
    supersededOutputCount++;
    return { ...output, status: 'superseded' as const, supersededBy: diff.revision };
  });
  return {
    state: { ...state, revision: diff.revision, graph, outputs,
      appliedEvents: { ...state.appliedEvents, [eventKey]: digest },
      revisionGraphs: [...state.revisionGraphs, { revision: diff.revision, graph, yaml: candidateYaml, diff: applied.playbackDiff,
        invalidatedNodeIds: [...invalidatedNodeIds] }] },
    replayed: false,
    invalidatedNodeIds: [...invalidatedNodeIds].sort(),
    supersededOutputCount,
    publishedYaml: candidateYaml,
  };
}

/** Read only YAML that passed parser validation and was published into the in-memory revision ledger. */
export function getAdaptiveGraphPublishedYaml(state: AdaptiveGraphDesignState, revision = state.revision): string {
  const frame = state.revisionGraphs.find((item) => item.revision === revision);
  if (!frame) throw new Error(`adaptive graph revision not published: ${revision}`);
  return frame.yaml;
}

/** Attach actual runGraph receipts to the design canvas so later diffs can supersede stale evidence. */
export function recordAdaptiveGraphRun(state: AdaptiveGraphDesignState, run: GraphRunState): AdaptiveGraphDesignState {
  if (run.graphId !== state.graphId) throw new Error(`adaptive graph run identity mismatch: ${run.graphId}`);
  const graphSha = run.graphSnapshot?.graphSha;
  if (!graphSha) throw new Error('cannot record run without a graph snapshot');
  const revision = revisionForGraphSnapshot(state.revisionGraphs, graphSha);
  const outputs = run.nodes.filter((node) => node.executed && node.output !== undefined).map((node) => {
    const invalidatingRevision = state.revisionGraphs.find((frame) => frame.revision > revision && frame.invalidatedNodeIds.includes(node.nodeId))?.revision;
    return { nodeId: node.nodeId, revision, runId: run.runId,
      status: invalidatingRevision === undefined ? 'current' as const : 'superseded' as const,
      ...(invalidatingRevision === undefined ? {} : { supersededBy: invalidatingRevision }), value: node.output };
  });
  return { ...state, outputs: [...state.outputs, ...outputs] };
}

/** Render the simulator's recorded graph history in the frame envelope consumed by PWA playback. */
export function buildGraphDesignPlaybackEnvelope(state: AdaptiveGraphDesignState, context: GraphDesignPlaybackContext = {}): GraphDesignPlaybackEnvelope {
  return {
    runId: state.runId,
    frames: state.revisionGraphs.map(({ revision, graph, diff }) => ({
      revision,
      nodes: graph.nodes.map((node) => {
        const output = [...state.outputs].reverse().find((item) => item.revision === revision && item.nodeId === node.nodeId);
        return { nodeId: node.nodeId, kind: node.kind, status: output?.status ?? 'pending',
          ...(output?.value === undefined ? {} : { output: output.value }) };
      }),
      diff,
      ...(context.conclusions?.[revision] === undefined ? {} : { conclusion: context.conclusions[revision] }),
      ...(context.bloomQuestions?.[revision] === undefined ? {} : { bloomQuestions: context.bloomQuestions[revision] }),
    })),
  };
}

/** Reuse the graph-engine selector on the currently declared graph; the runner remains the only executor. */
export function previewAdaptiveGraphRoute(state: AdaptiveGraphDesignState, nodeId: string, outcome: string): string | undefined {
  return simGraphEngineSelection({ graph: state.graph, exit: { nodeId, outcome } }).to;
}
