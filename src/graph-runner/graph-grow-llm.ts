import { PROVIDERS, streamLLM } from '../llm.js';
import { getUserConfig, resolveRoleLlm, type UserConfig } from '../user-config.js';
import type { GrowthProposal, GrowthProposer } from './graph-grow.js';

type GrowthLLM = (prompt: string) => Promise<string>;
const OUTPUT_TAIL_LENGTH = 2000;

export function graphGrowthLlmOptions(config: UserConfig): { model?: string; provider?: string } {
  const role = config.roleLlm?.['graph-grow'];
  if (!role || (!role.provider && !role.model && !role.tier)) return {};
  const selected = resolveRoleLlm('graph-grow', { config });
  return { model: selected.model, provider: selected.provider };
}

async function defaultGrowthLLM(prompt: string): Promise<string> {
  const selected = graphGrowthLlmOptions(getUserConfig());
  return streamLLM([{ role: 'user', content: prompt }], () => {}, {
    ...(selected.model ? { model: selected.model, provider: PROVIDERS[selected.provider!] } : {}),
    reasoningEffort: 'low',
  });
}

/** Model output is untrusted: structural and side-effect validation belongs to proposeGrowth. */
export function createLLMGrowthProposer(callLLM: GrowthLLM = defaultGrowthLLM): GrowthProposer {
  return async (input: Parameters<GrowthProposer>[0]) => {
    const serializedOutput = typeof input.output === 'string' ? input.output : input.output === undefined ? '' : JSON.stringify(input.output);
    const prompt = [
      'Propose exactly one new contracted graph node to handle the unseen outcome and one return edge to an existing node.',
      'Reply with only JSON: {"node":{"nodeId":"...","kind":"agent","recipe":"none","maxVisits":1,"contract":{"inputs":[],"tools":"read-only","outputs":[]}},"returnTo":"existing-node-id","reason":"..."}.',
      'Use only an existing recipe type (none, an existing cmd:/approval: recipe ID, or a catalog role); never invent commands. The missing-outcome edge and the return edge are built from node and returnTo after validation.',
      'Do not alter existing nodes or edges. The proposal will be validated independently; do not assume a recipe is safe.',
      `Graph snapshot: ${JSON.stringify(input.graph)}`,
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
