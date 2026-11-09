import { createHash } from 'node:crypto';
import { PROVIDERS, streamLLM } from '../llm.js';
import { getUserConfig, resolveRoleLlm } from '../user-config.js';
import type { GraphSubscriptionDispatch, GraphSubscriptionHandler } from '../graph-runner/graph-subscriptions.js';

export interface IncidentPolicyProposal {
  readonly vocabularyLine: string;
  readonly repairSummary: string;
  readonly rationale: string;
}

export type IncidentPolicyProposer = (dispatch: GraphSubscriptionDispatch) => Promise<IncidentPolicyProposal | undefined>;
export type IncidentPolicyCallLLM = (prompt: string) => Promise<string>;

function parseProposal(raw: string): IncidentPolicyProposal | undefined {
  let value: unknown;
  try { value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
  catch { return undefined; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const proposal = value as Record<string, unknown>;
  if (typeof proposal.vocabularyLine !== 'string' || typeof proposal.repairSummary !== 'string' || typeof proposal.rationale !== 'string') return undefined;
  const vocabularyLine = proposal.vocabularyLine.trim();
  const repairSummary = proposal.repairSummary.trim();
  const rationale = proposal.rationale.trim();
  if (!/^release\.incident\.[a-z0-9][a-z0-9.-]{0,100}$/.test(vocabularyLine) || !repairSummary || repairSummary.length > 240 ||
      !rationale || rationale.length > 240) return undefined;
  return { vocabularyLine, repairSummary, rationale };
}

async function defaultIncidentPolicyCallLLM(prompt: string): Promise<string> {
  const role = getUserConfig().roleLlm?.['graph-grow'];
  const selected = role && (role.provider || role.model || role.tier) ? resolveRoleLlm('graph-grow') : undefined;
  return streamLLM([{ role: 'user', content: prompt }], () => {}, {
    ...(selected ? { model: selected.model, provider: PROVIDERS[selected.provider] } : {}),
    reasoningEffort: 'low',
  });
}

export function createLLMIncidentPolicyProposer(callLLM: IncidentPolicyCallLLM = defaultIncidentPolicyCallLLM): IncidentPolicyProposer {
  return async (dispatch) => {
  const description = typeof dispatch.event.data?.description === 'string' ? dispatch.event.data.description : '';
  const prompt = [
    'Propose a release incident policy for this new incident. Return only JSON with vocabularyLine, repairSummary, rationale.',
    'vocabularyLine must exactly equal the incoming event type. repairSummary and rationale must be concise, factual, and actionable.',
    `Event type: ${dispatch.event.type}`,
    `Incident data: ${JSON.stringify(dispatch.event.data ?? {})}`,
    `Description: ${description}`,
  ].join('\n');
    return parseProposal(await callLLM(prompt));
  };
}

/** Converts an untrusted incident proposal into runner-owned, validated graph mutations. */
export function createIncidentPolicyHandler(propose: IncidentPolicyProposer = createLLMIncidentPolicyProposer()): GraphSubscriptionHandler {
  return async (dispatch) => {
    if (!dispatch.event.type.startsWith('release.incident.')) return;
    const proposal = await propose(dispatch);
    if (!proposal) throw new Error(`incident policy proposal is invalid for ${dispatch.event.type}`);
    if (proposal.vocabularyLine !== dispatch.event.type) throw new Error('incident policy vocabulary must match the incoming event type');
    if (!dispatch.appendGraph || !dispatch.proposeEdge) throw new Error('incident policy graph mutation ports are unavailable');

    const nodeId = `gate-repair-${createHash('sha256').update(`${dispatch.event.runId}\0${dispatch.event.eventId}`).digest('hex').slice(0, 12)}`;
    dispatch.eventVocabulary.registerType(proposal.vocabularyLine);
    const appended = await dispatch.appendGraph({
      nodes: [{ nodeId, kind: 'agent', recipe: 'cmd:gate-repair', maxVisits: 1 }],
      edges: [{ from: nodeId, on: 'outcome', map: { ok: 'done', fail: 'failed', error: 'failed' } }],
      entryNodeId: nodeId,
      returnTo: 'done',
      failureTo: 'failed',
      reason: `${proposal.repairSummary}: ${proposal.rationale}`,
    });
    if (appended.disposition === 'rejected') throw new Error(`incident repair append rejected: ${appended.reason}`);
    const edge = await dispatch.proposeEdge({ from: dispatch.event.source.nodeId ?? 'gate', to: dispatch.nodeId,
      triggerEvent: proposal.vocabularyLine, rationale: proposal.rationale, mode: 'live' });
    if (edge.disposition !== 'added') throw new Error(`incident edge proposal ${edge.disposition}: ${edge.reason}`);
  };
}

