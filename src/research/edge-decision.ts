import type { GraphNodeSpec } from '../self-implement/graph-yaml.js';

/** Opaque Bloom 4/5 output. The hook owns the decision boundary, not analysis policy. */
export interface BloomEdgeAssessment {
  gaps: readonly unknown[];
  contradictions: readonly unknown[];
  verdicts: readonly unknown[];
}

export type ResearchEdgeAction = 'add' | 'prune' | 'deepen' | 'stop';

export interface ResearchEdgeProposal {
  node: GraphNodeSpec;
  returnTo?: string;
  reason: string;
}

export interface ResearchEdgeDecision {
  action: ResearchEdgeAction;
  reason: string;
  evidence: readonly string[];
  proposal?: ResearchEdgeProposal;
}

export interface ResolvedResearchEdgeDecision extends ResearchEdgeDecision {
  provider: string;
}

export type ResearchEdgeDecisionProvider = (
  assessment: BloomEdgeAssessment,
) => ResearchEdgeDecision | Promise<ResearchEdgeDecision>;

export interface ResearchEdgeDecisionRegistry {
  register(provider: ResearchEdgeDecisionProvider, name?: string): () => void;
  decide(assessment: BloomEdgeAssessment): Promise<ResolvedResearchEdgeDecision>;
}

const noOpDecision: ResearchEdgeDecision = {
  action: 'stop',
  reason: 'no edge decision provider registered',
  evidence: [],
};

/** One registry belongs to one run. With no provider, the graph takes one round and stops. */
export function createResearchEdgeDecisionRegistry(): ResearchEdgeDecisionRegistry {
  const providers = new Map<symbol, { name: string; decide: ResearchEdgeDecisionProvider }>();
  return {
    register(provider, name = 'registered') {
      const key = Symbol('research-edge-decision-provider');
      providers.set(key, { name, decide: provider });
      return () => { providers.delete(key); };
    },
    async decide(assessment) {
      const provider = [...providers.values()].at(-1);
      if (!provider) return { ...noOpDecision, provider: 'default-noop' };
      try {
        const decision = await provider.decide(assessment);
        if (!isResearchEdgeDecision(decision)) {
          return { action: 'stop', reason: 'edge decision provider returned an invalid decision', evidence: [], provider: provider.name };
        }
        return { ...decision, evidence: [...decision.evidence], provider: provider.name };
      } catch (error) {
        return { action: 'stop', reason: `edge decision provider failed: ${String(error)}`, evidence: [], provider: provider.name };
      }
    },
  };
}

function isResearchEdgeDecision(value: unknown): value is ResearchEdgeDecision {
  if (!isRecord(value) || !['add', 'prune', 'deepen', 'stop'].includes(String(value.action))
    || typeof value.reason !== 'string' || !value.reason.trim()
    || !Array.isArray(value.evidence) || !value.evidence.every((item) => typeof item === 'string')) {
    return false;
  }
  if (value.action === 'add') return isResearchEdgeProposal(value.proposal);
  return value.proposal === undefined;
}

function isResearchEdgeProposal(value: unknown): value is ResearchEdgeProposal {
  return isRecord(value) && isRecord(value.node) && typeof value.node.nodeId === 'string'
    && typeof value.node.kind === 'string' && typeof value.node.recipe === 'string'
    && typeof value.reason === 'string' && value.reason.trim().length > 0
    && (value.returnTo === undefined || typeof value.returnTo === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
