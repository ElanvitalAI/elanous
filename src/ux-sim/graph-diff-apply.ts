import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { GraphEdgeSpec, GraphNodeSpec, GraphTemplateSpec } from '../self-implement/graph-yaml.js';

export type AdaptiveGraphOperation =
  | { readonly op: 'add'; readonly node: GraphNodeSpec; readonly edges: readonly GraphEdgeSpec[] }
  | { readonly op: 'remove'; readonly nodeId: string }
  | { readonly op: 'replace'; readonly node: GraphNodeSpec; readonly edges?: readonly GraphEdgeSpec[] };

export interface GraphDiffPlaybackChange {
  readonly op: AdaptiveGraphOperation['op'];
  readonly nodeId: string;
  readonly from?: string;
  readonly to?: string;
  readonly why: string;
}

export interface AdaptiveGraphOperationsResult {
  readonly graph: GraphTemplateSpec;
  readonly invalidatedNodeIds: readonly string[];
  readonly playbackDiff: readonly GraphDiffPlaybackChange[];
}

export type AdaptiveGraphCandidateValidator = (graph: GraphTemplateSpec) => void;

function destinations(edge: GraphEdgeSpec): string[] {
  return [
    ...(edge.to ? [edge.to] : []),
    ...Object.values(edge.map ?? {}),
    ...Object.values(edge.branches ?? {}).flat(),
    ...(edge.fallback ?? []).map((entry) => entry.node),
  ];
}

function downstream(graph: GraphTemplateSpec, seeds: ReadonlySet<string>): Set<string> {
  const affected = new Set(seeds);
  const queue = [...seeds];
  while (queue.length) {
    const current = queue.shift()!;
    for (const edge of graph.edges) {
      if (edge.from !== current) continue;
      for (const target of destinations(edge)) {
        if (!affected.has(target)) {
          affected.add(target);
          queue.push(target);
        }
      }
    }
  }
  return affected;
}

function invalidationSeedsFor(graph: GraphTemplateSpec, operation: AdaptiveGraphOperation): Set<string> {
  const nodeId = operation.op === 'remove' ? operation.nodeId : operation.node.nodeId;
  const seeds = new Set([nodeId]);
  if (operation.op === 'remove') {
    for (const edge of graph.edges) if (destinations(edge).includes(nodeId)) seeds.add(edge.from);
  } else {
    for (const edge of operation.op === 'add' ? operation.edges : operation.edges ?? []) seeds.add(edge.from);
  }
  return seeds;
}

function applyOperation(graph: GraphTemplateSpec, operation: AdaptiveGraphOperation): GraphTemplateSpec {
  if (operation.op === 'add') {
    if (graph.nodes.some((node) => node.nodeId === operation.node.nodeId)) throw new Error(`adaptive graph node already exists: ${operation.node.nodeId}`);
    return { ...graph, nodes: [...graph.nodes, structuredClone(operation.node)], edges: [...graph.edges, ...structuredClone(operation.edges)] };
  }
  const nodeId = operation.op === 'remove' ? operation.nodeId : operation.node.nodeId;
  const index = graph.nodes.findIndex((node) => node.nodeId === nodeId);
  if (index < 0) throw new Error(`adaptive graph node missing: ${nodeId}`);
  if (operation.op === 'remove') {
    const edges = graph.edges.flatMap((edge) => {
      if (edge.from === nodeId) return [];
      const to = edge.to === nodeId ? undefined : edge.to;
      const map = edge.map === undefined ? undefined : Object.fromEntries(Object.entries(edge.map).filter(([, target]) => target !== nodeId));
      const branches = edge.branches === undefined ? undefined : Object.fromEntries(Object.entries(edge.branches)
        .map(([key, targets]) => [key, targets.filter((target) => target !== nodeId)])
        .filter(([, targets]) => (targets as string[]).length > 0));
      const fallback = edge.fallback?.filter((entry) => entry.node !== nodeId);
      const hasPrimaryRoute = to !== undefined || Object.keys(map ?? {}).length > 0 || Object.keys(branches ?? {}).length > 0;
      if (!hasPrimaryRoute && (!fallback || fallback.length === 0)) return [];
      const { fallback: _fallback, map: _map, branches: _branches, to: _to, ...edgeWithoutRoutes } = edge;
      return [{ ...edgeWithoutRoutes,
        ...(to === undefined ? {} : { to }),
        ...(map === undefined || Object.keys(map).length === 0 ? {} : { map }),
        ...(branches === undefined || Object.keys(branches).length === 0 ? {} : { branches }),
        ...(fallback === undefined || fallback.length === 0 ? {} : { fallback }),
      }];
    });
    return { ...graph, nodes: graph.nodes.filter((node) => node.nodeId !== nodeId), edges,
      // Keep entry/terminal declarations in the private candidate. A later add
      // in the same atomic event can restore that ID; final validation rejects
      // the candidate if the declaration still points at a missing node.
    };
  }
  const nodes = [...graph.nodes];
  nodes[index] = structuredClone(operation.node);
  const edges = operation.edges === undefined ? graph.edges
    : [...graph.edges.filter((edge) => edge.from !== operation.node.nodeId), ...structuredClone(operation.edges)];
  return { ...graph, nodes, edges };
}

function assertValidGraph(graph: GraphTemplateSpec): void {
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

function adjacentNodes(graph: GraphTemplateSpec, nodeId: string): { from?: string; to?: string } {
  const from = graph.edges.find((edge) => destinations(edge).includes(nodeId))?.from;
  const outgoing = graph.edges.find((edge) => edge.from === nodeId);
  const to = outgoing ? destinations(outgoing)[0] : undefined;
  return { ...(from ? { from } : {}), ...(to ? { to } : {}) };
}

/** Apply an event to a private candidate, then validate and publish it as one atomic result. */
export function applyAdaptiveGraphOperations(
  graph: GraphTemplateSpec,
  operations: readonly AdaptiveGraphOperation[],
  validateCandidate: AdaptiveGraphCandidateValidator,
  why = 'adaptive graph diff',
): AdaptiveGraphOperationsResult {
  if (operations.length === 0) throw new Error('adaptive graph diff must contain an operation');
  // Neither the source manifest nor caller-owned operation values may be
  // mutated by an operation or by the final validator.
  let candidate = structuredClone(graph);
  const seeds = new Set<string>();
  const playbackDiff: GraphDiffPlaybackChange[] = [];
  for (const operation of operations) {
    const before = candidate;
    for (const seed of invalidationSeedsFor(before, operation)) seeds.add(seed);
    candidate = applyOperation(candidate, operation);
    const nodeId = operation.op === 'remove' ? operation.nodeId : operation.node.nodeId;
    const adjacent = adjacentNodes(operation.op === 'remove' ? before : candidate, nodeId);
    playbackDiff.push({ op: operation.op, nodeId, ...adjacent, why });
  }
  assertValidGraph(candidate);
  // Validators are callbacks outside this module's control. Give them a
  // disposable snapshot so mutation cannot alter the value we publish, and
  // reject mutation rather than silently publishing an unvalidated candidate.
  const validationSnapshot = structuredClone(candidate);
  validateCandidate(validationSnapshot);
  if (!isDeepStrictEqual(candidate, validationSnapshot)) {
    throw new Error('adaptive graph candidate validator must not mutate its input');
  }
  const invalidated = new Set([...downstream(graph, seeds), ...downstream(candidate, seeds)]);
  return { graph: candidate, invalidatedNodeIds: [...invalidated].sort(), playbackDiff };
}

export interface PublishedGraphRevision {
  readonly revision: number;
  readonly yaml: string;
}

/** Resolve a run's recorded graph SHA only against exact, published YAML bytes. */
export function revisionForGraphSnapshot(revisions: readonly PublishedGraphRevision[], graphSha: string): number {
  const revisionIds = new Set(revisions.map((entry) => entry.revision));
  if (revisionIds.size !== revisions.length) throw new Error('published graph revisions contain duplicate revision numbers');
  const matches = revisions.filter((entry) => createHash('sha256').update(entry.yaml).digest('hex') === graphSha);
  if (matches.length !== 1) throw new Error('run graph snapshot does not match a published revision');
  return matches[0]!.revision;
}
