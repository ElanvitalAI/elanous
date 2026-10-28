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
  /** Ordinal-free, explicitly supplied strength on [0, 1]; never inferred from votes. */
  evidenceStrength?: number;
  /** Optional T3 record-only confidence; never changes the live edge decision. */
  confidence?: number;
  counterEvidenceRefs?: readonly string[];
  outsideViewRefs?: readonly string[];
  proposal?: ResearchEdgeProposal;
}

export interface ResolvedResearchEdgeDecision extends ResearchEdgeDecision {
  provider: string;
}

/** T3 evidence is retained beside the current live decision, never applied to it. */
export interface ResearchEdgeDecisionEnvelope extends ResolvedResearchEdgeDecision {
  recommendation?: ResolvedResearchEdgeDecision;
  votes: readonly ResolvedResearchEdgeDecision[];
  dissent: readonly ResolvedResearchEdgeDecision[];
  counterEvidenceRefs: readonly string[];
  outsideViewRefs: readonly string[];
  agreesWithLive?: boolean;
  mode: 'record-only';
}

export type ResearchEdgeDecisionProvider = (
  assessment: BloomEdgeAssessment,
) => ResearchEdgeDecision | Promise<ResearchEdgeDecision>;

export interface ResearchEdgeDecisionRegistry {
  register(provider: ResearchEdgeDecisionProvider, name?: string, options?: { priority?: number }): () => void;
  decide(assessment: BloomEdgeAssessment): Promise<ResearchEdgeDecisionEnvelope>;
}

const noOpDecision: ResearchEdgeDecision = {
  action: 'stop',
  reason: 'no edge decision provider registered',
  evidence: [],
};

/** One registry belongs to one run. With no provider, the graph takes one round and stops. */
export function createResearchEdgeDecisionRegistry(): ResearchEdgeDecisionRegistry {
  const providers = new Map<symbol, { name: string; decide: ResearchEdgeDecisionProvider; priority?: number }>();
  return {
    register(provider, name = 'registered', options = {}) {
      if (options.priority !== undefined && !Number.isFinite(options.priority)) {
        throw new TypeError('research edge provider priority must be finite when supplied');
      }
      const key = Symbol('research-edge-decision-provider');
      providers.set(key, { name, decide: provider, ...(options.priority === undefined ? {} : { priority: options.priority }) });
      return () => { providers.delete(key); };
    },
    async decide(assessment) {
      const entries = [...providers.values()];
      if (!entries.length) return envelope({ ...noOpDecision, provider: 'default-noop' }, []);
      const results = await Promise.all(entries.map(async (entry) => {
        try {
          const decision = await entry.decide(assessment);
          return isResearchEdgeDecision(decision)
            ? { entry, decision }
            : { entry, error: 'returned an invalid decision' };
        } catch (error) {
          return { entry, error: `failed: ${String(error)}` };
        }
      }));
      const valid = results.filter((result): result is { entry: typeof entries[number]; decision: ResearchEdgeDecision } => 'decision' in result);
      const failures = results.filter((result): result is { entry: typeof entries[number]; error: string } => 'error' in result);
      if (!valid.length) return envelope({ action: 'stop', reason: `all edge decision providers failed: ${failures.map(({ entry, error }) => `${entry.name} ${error}`).join('; ')}`, evidence: [], provider: 'composition' }, []);
      if (valid.length === 1 && !failures.length) {
        const [{ entry, decision }] = valid;
        const live = { ...decision, evidence: [...decision.evidence], provider: entry.name };
        return envelope(live, votes(valid));
      }

      // Agreement composes evidence. Disagreement is resolved by declared evidence strength,
      // then explicit provider priority; an unresolved tie fails closed instead of voting.
      const actions = new Set(valid.map(({ decision }) => decision.action));
      const proposalKeys = new Set(valid.filter(({ decision }) => decision.action === 'add')
        .map(({ decision }) => JSON.stringify(decision.proposal)));
      const conflict = actions.size > 1 || proposalKeys.size > 1;
      let candidates = valid;
      if (conflict) {
        const ranked = valid.map((result) => ({ ...result,
          strength: result.decision.evidenceStrength ?? -1,
        })).sort((a, b) => b.strength - a.strength);
        const top = ranked[0]!;
        const tiedStrength = ranked.filter((item) => item.strength === top.strength);
        if (tiedStrength.length > 1 && tiedStrength.some((item) => item.entry.priority === undefined)) return envelope({
          action: 'stop', reason: `unresolved edge decision conflict: ${tiedStrength.map(({ entry }) => entry.name).join(', ')} (priority unspecified)`,
          evidence: [...new Set(valid.flatMap(({ decision }) => decision.evidence))], provider: 'composition',
        }, votes(valid));
        tiedStrength.sort((a, b) => (b.entry.priority ?? 0) - (a.entry.priority ?? 0));
        const winner = tiedStrength[0]!;
        const tied = tiedStrength.filter((item) => item.entry.priority === winner.entry.priority);
        if (tied.length > 1) return envelope({
          action: 'stop', reason: `unresolved edge decision conflict: ${tied.map(({ entry }) => entry.name).join(', ')}`,
          evidence: [...new Set(valid.flatMap(({ decision }) => decision.evidence))], provider: 'composition',
        }, votes(valid));
        candidates = [winner];
      }
      const winner = candidates[0]!;
      const evidence = [...new Set(valid.flatMap(({ decision }) => decision.evidence))];
      const contributors = valid.map(({ entry }) => entry.name).join(', ');
      const notes = failures.map(({ entry, error }) => `${entry.name} ${error}`);
      const reason = conflict
        ? `conflict resolved by ${winner.entry.name} (strength=${winner.decision.evidenceStrength ?? 'unspecified'}, priority=${winner.entry.priority ?? 'unspecified'}); ${winner.decision.reason}`
        : `composed ${contributors}: ${winner.decision.reason}`;
      const evidenceNote = evidence.length ? `; evidence=${evidence.join(' | ')}` : '';
      const live = { ...winner.decision, reason: [...notes, `${reason}${evidenceNote}`].join('; '), evidence, provider: conflict ? winner.entry.name : `composition[${contributors}]` };
      return envelope(live, votes(valid));
    },
  };
}

function isResearchEdgeDecision(value: unknown): value is ResearchEdgeDecision {
  if (!isRecord(value) || !['add', 'prune', 'deepen', 'stop'].includes(String(value.action))
    || typeof value.reason !== 'string' || !value.reason.trim()
    || !Array.isArray(value.evidence) || !value.evidence.every((item) => typeof item === 'string')
    || (value.evidenceStrength !== undefined && (typeof value.evidenceStrength !== 'number'
      || !Number.isFinite(value.evidenceStrength) || value.evidenceStrength < 0 || value.evidenceStrength > 1))) {
    return false;
  }
  if (value.action === 'add') return isResearchEdgeProposal(value.proposal);
  return value.proposal === undefined;
}

function votes(valid: readonly { entry: { name: string }; decision: ResearchEdgeDecision }[]): ResolvedResearchEdgeDecision[] {
  return valid.map(({ entry, decision }) => {
    const confidence = typeof decision.confidence === 'number' && Number.isFinite(decision.confidence)
      && decision.confidence >= 0 && decision.confidence <= 1 ? decision.confidence : undefined;
    const counterEvidenceRefs = Array.isArray(decision.counterEvidenceRefs)
      ? decision.counterEvidenceRefs.filter((item): item is string => typeof item === 'string') : [];
    const outsideViewRefs = Array.isArray(decision.outsideViewRefs)
      ? decision.outsideViewRefs.filter((item): item is string => typeof item === 'string') : [];
    return {
      ...decision,
      ...(confidence === undefined ? { confidence: undefined } : { confidence }),
      counterEvidenceRefs,
      outsideViewRefs,
      evidence: [...decision.evidence],
      provider: entry.name,
    };
  });
}

function envelope(live: ResolvedResearchEdgeDecision, recordedVotes: readonly ResolvedResearchEdgeDecision[]): ResearchEdgeDecisionEnvelope {
  const scored = recordedVotes.filter((vote) => vote.confidence !== undefined);
  const strongest = scored.length ? Math.max(...scored.map((vote) => vote.confidence!)) : undefined;
  const leaders = strongest === undefined ? [] : scored.filter((vote) => vote.confidence === strongest);
  const leaderActions = new Set(leaders.map(({ action }) => action));
  const leaderPayloads = new Set(leaders.map(({ action, proposal }) => JSON.stringify({ action, proposal })));
  const recommendation = !leaders.length ? undefined
    : leaderActions.size > 1 || leaderPayloads.size > 1
      ? { action: 'stop' as const, reason: 'conflicting strongest evidence', evidence: [...new Set(leaders.flatMap(({ evidence }) => evidence))], confidence: strongest, provider: 'evidence-composer' }
      : leaders[0];
  const sameLive = (vote: ResolvedResearchEdgeDecision) => vote.action === live.action && JSON.stringify(vote.proposal) === JSON.stringify(live.proposal);
  return {
    ...live,
    votes: [...recordedVotes],
    dissent: recommendation ? recordedVotes.filter((vote) => vote.action !== recommendation.action || JSON.stringify(vote.proposal) !== JSON.stringify(recommendation.proposal)) : [],
    counterEvidenceRefs: [...new Set(recordedVotes.flatMap((vote) => vote.counterEvidenceRefs ?? []))],
    outsideViewRefs: [...new Set(recordedVotes.flatMap((vote) => vote.outsideViewRefs ?? []))],
    ...(recommendation ? { recommendation, agreesWithLive: sameLive(recommendation) } : {}),
    mode: 'record-only',
  };
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
