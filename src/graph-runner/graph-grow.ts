import { createHash } from 'node:crypto';
import { DecisionLedger, type DecisionEntry } from '../decisions/decision-ledger.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
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
export interface GrowthCommand { command: string; dry_run_command?: string; timeout_ms?: number }
export interface GrowthRecipeClassification { effect: GrowthRecipeEffect; command?: GrowthCommand; approval?: string }

export interface GraphGrowth {
  node: GraphNodeSpec;
  edges: readonly GraphEdgeSpec[];
  reason: string;
  undo: { removeNode: string; removeOutcome: { from: string; outcome: string }; removeEdge?: GraphEdgeSpec };
}

export interface GrowthDecisionDeps {
  ledger?: Pick<DecisionLedger, 'raiseOnce'>;
  root?: string;
  now?: () => Date;
}

function proposalGrowth(input: Parameters<GrowthProposer>[0], proposal: GrowthProposal): GraphGrowth {
  const edges: GraphEdgeSpec[] = [
    { from: input.nodeId, on: 'outcome', map: { [input.outcome]: proposal.node.nodeId } },
    { from: proposal.node.nodeId, to: proposal.returnTo as string },
  ];
  return { node: proposal.node, edges, reason: proposal.reason,
    undo: { removeNode: proposal.node.nodeId, removeOutcome: { from: input.nodeId, outcome: input.outcome }, removeEdge: edges[1]! } };
}

/** The card's own ref commits to the entire growth and resolved recipe, independently of the parked run state. */
export function growthApprovalRef(identity: { graphId: string; runId: string; from: string; outcome: string },
  growth: GraphGrowth, command?: GrowthCommand, approval?: string): string {
  const hash = createHash('sha256').update(JSON.stringify({ identity, growth, command, approval })).digest('hex');
  return `graph-growth:${hash}`;
}

export function growthDecisionRef(input: Parameters<GrowthProposer>[0], proposal: GrowthProposal, command?: GrowthCommand, approval?: string): string {
  return growthApprovalRef({ graphId: input.graph.graphId, runId: input.runId, from: input.nodeId, outcome: input.outcome },
    proposalGrowth(input, proposal), command, approval);
}

export function growthDecision(input: Parameters<GrowthProposer>[0], proposal: GrowthProposal, deps: GrowthDecisionDeps = {}, command?: GrowthCommand, approval?: string): DecisionEntry {
  const ledger = deps.ledger ?? new DecisionLedger({ stateDir: deps.root ?? effectiveInstanceRoot() });
  const ref = growthDecisionRef(input, proposal, command, approval);
  const summary = `${proposal.node.nodeId} (${proposal.node.kind}, ${proposal.node.recipe}) → ${proposal.returnTo}`;
  const commandDigest = command ? createHash('sha256').update(JSON.stringify(command)).digest('hex') : undefined;
  return ledger.raiseOnce({ title: `${input.graph.graphId} / ${input.nodeId} / ${input.outcome} growth approval`, category: 'scope',
    scqa: { s: `Graph ${input.graph.graphId}, node ${input.nodeId}, outcome ${input.outcome} has no mapped growth edge.`,
      c: `Proposed node: ${summary}; command SHA-256: ${commandDigest ?? 'unresolved'}; reason: ${proposal.reason}`.slice(0, 240) },
    options: [{ key: 'a', label: '승인', consequence: `Apply proposed node ${proposal.node.nodeId} and continue the run` },
      { key: 'b', label: '거절', consequence: 'Keep the original fallback route' }],
    recommendation: { skipped: true, reason: 'Side-effect recipe requires a human decision' },
    ...(command || approval ? { pendingQuestion: [approval ? `Approval recipe: ${approval}` : undefined,
      command ? `Proposed command (${commandDigest}):\n${command.command}` : undefined].filter(Boolean).join('\n') } : {}),
    raisedBy: { agent: 'graph-runner' }, refs: [ref], dueAt: new Date((deps.now?.() ?? new Date()).getTime() + 8 * 60 * 60 * 1000).toISOString() }, ref);
}

export async function proposeGrowth(input: Parameters<GrowthProposer>[0],
  proposer: GrowthProposer = createLLMGrowthProposer(), classifyRecipe?: (node: GraphNodeSpec) => GrowthRecipeEffect | GrowthRecipeClassification,
  decisionDeps: GrowthDecisionDeps = {}): Promise<{ ok: true; graph: GraphTemplateSpec; growth: GraphGrowth } | { ok: false; reason: string; park?: boolean; growth?: GraphGrowth; decisionId?: string; decisionRef?: string; command?: GrowthCommand; approval?: string }> {
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
    let command: GrowthCommand | undefined;
    let approval: string | undefined;
    try {
      const classification = classifyRecipe?.(proposal.node) ?? 'unknown';
      effect = typeof classification === 'string' ? classification : classification.effect;
      command = typeof classification === 'string' ? undefined : classification.command;
      approval = typeof classification === 'string' ? undefined : classification.approval;
    } catch { effect = 'unknown'; }
    if (effect !== 'read-only' || approval) {
      const decision = growthDecision(input, proposal, decisionDeps, command, approval);
      return { ok: false, park: true, reason: '사람 확인 필요: external or unclassified side-effect recipe',
        decisionId: decision.id, decisionRef: growthDecisionRef(input, proposal, command, approval), command, approval,
        growth: proposalGrowth(input, proposal) };
    }
  }
  return { ok: true, graph: result.template, growth: proposalGrowth(input, proposal) };
}
