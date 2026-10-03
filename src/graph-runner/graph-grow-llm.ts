import { streamLLM } from '../llm.js';
import type { GrowthProposal, GrowthProposer } from './graph-grow.js';

type GrowthLLM = (prompt: string) => Promise<string>;
const OUTPUT_TAIL_LENGTH = 4000;

/** Model output is untrusted: structural and side-effect validation belongs to proposeGrowth. */
export function createLLMGrowthProposer(callLLM: GrowthLLM = (prompt) =>
  streamLLM([{ role: 'user', content: prompt }], () => {}, { reasoningEffort: 'low' })): GrowthProposer {
  return async (input: Parameters<GrowthProposer>[0]) => {
    const serializedOutput = typeof input.output === 'string' ? input.output : input.output === undefined ? '' : JSON.stringify(input.output);
    const graphSummary = {
      graphId: input.graph.graphId,
      nodes: input.graph.nodes.map(({ nodeId, kind, recipe }) => ({ nodeId, kind, recipe })),
      edges: input.graph.edges.map(({ from, to, on, map, fallback }) => ({ from, ...(to === undefined ? {} : { to }),
        ...(on === undefined ? {} : { on }), ...(map === undefined ? {} : { map }), ...(fallback === undefined ? {} : { fallback }) })),
    };
    const prompt = [
      'Propose exactly one new contracted graph node to handle the unseen outcome, then return to an existing node.',
      'Reply with only JSON: {"node":{"nodeId":"...","kind":"...","recipe":"none","maxVisits":1,"contract":{"inputs":[],"tools":"read-only","outputs":[]}},"returnTo":"existing-node-id","reason":"..."}.',
      'Do not alter existing nodes or edges. The proposal will be validated independently; do not assume a recipe is safe.',
      `Graph summary: ${JSON.stringify(graphSummary)}`,
      `Blocked node ID: ${JSON.stringify(input.nodeId)}`,
      `Unseen outcome: ${JSON.stringify(input.outcome)}`,
      `Blocked node output tail: ${JSON.stringify(serializedOutput.slice(-OUTPUT_TAIL_LENGTH))}`,
    ].join('\n');
    const response = await callLLM(prompt);
    let parsed: unknown;
    try { parsed = JSON.parse(response.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
    catch { return undefined; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const proposal = parsed as Record<string, unknown>;
    if (!proposal.node || typeof proposal.node !== 'object' || Array.isArray(proposal.node) ||
      typeof proposal.reason !== 'string' || !proposal.reason.trim() || typeof proposal.returnTo !== 'string') return undefined;
    return { node: proposal.node, reason: proposal.reason, returnTo: proposal.returnTo } as GrowthProposal;
  };
}
