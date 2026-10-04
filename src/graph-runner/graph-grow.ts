import { createGraphVariant } from '../self-implement/graph-variant.js';
import type { GraphEdgeSpec, GraphNodeSpec, GraphTemplateSpec } from '../self-implement/graph-yaml.js';
import { createLLMGrowthProposer } from './graph-grow-llm.js';

export interface GrowthProposal {
  node: GraphNodeSpec;
  returnTo?: string;
  reason: string;
}

export type GrowthProposer = (input: { graph: GraphTemplateSpec; nodeId: string; outcome: string; runId: string; output?: unknown }) => GrowthProposal | undefined | Promise<GrowthProposal | undefined>;
export type GrowthRecipeEffect = 'read-only' | 'external-effect' | 'unknown';

export interface GraphGrowth {
  node: GraphNodeSpec;
  edges: readonly GraphEdgeSpec[];
  reason: string;
  undo: { removeNode: string; removeOutcome: { from: string; outcome: string }; removeEdge?: GraphEdgeSpec };
}

export async function proposeGrowth(input: Parameters<GrowthProposer>[0],
  proposer: GrowthProposer = createLLMGrowthProposer(), classifyRecipe?: (node: GraphNodeSpec) => GrowthRecipeEffect): Promise<{ ok: true; graph: GraphTemplateSpec; growth: GraphGrowth } | { ok: false; reason: string; park?: boolean }> {
  let proposal: GrowthProposal | undefined;
  try { proposal = await proposer(input); }
  catch (error) { return { ok: false, reason: `proposer failed: ${String(error)}` }; }
  if (!proposal) return { ok: false, reason: 'no proposal' };
  if (!proposal.node || typeof proposal.reason !== 'string' || !proposal.reason.trim()) return { ok: false, reason: 'proposal requires a node and reason' };
  let result: ReturnType<typeof createGraphVariant>;
  try {
    result = createGraphVariant({ template: input.graph, goal: `g_${input.runId.replace(/[^a-z0-9_-]/gi, '_')}`,
      plan: { growth: { node: proposal.node, from: input.nodeId, outcome: input.outcome, returnTo: proposal.returnTo } } });
  } catch (error) { return { ok: false, reason: `growth rejected: ${String(error)}` }; }
  if (!result.ok) return { ok: false, reason: `growth rejected: ${JSON.stringify(result.rejections)}` };
  // Neither a recipe id nor its declared tools certify arbitrary executable code.
  // Only a trusted classification of the resolved recipe may authorize execution.
  let effect: GrowthRecipeEffect = 'unknown';
  if (proposal.node.recipe !== 'none') {
    try { effect = classifyRecipe?.(proposal.node) ?? 'unknown'; }
    catch { effect = 'unknown'; }
    if (effect !== 'read-only') {
      return { ok: false, park: true, reason: '사람 확인 필요: external or unclassified side-effect recipe' };
    }
  }
  const edges: GraphEdgeSpec[] = [
    { from: input.nodeId, on: 'outcome', map: { [input.outcome]: proposal.node.nodeId } },
    { from: proposal.node.nodeId, to: proposal.returnTo as string },
  ];
  return { ok: true, graph: result.template, growth: { node: proposal.node, edges, reason: proposal.reason,
    undo: { removeNode: proposal.node.nodeId, removeOutcome: { from: input.nodeId, outcome: input.outcome }, removeEdge: edges[1]! } } };
}
