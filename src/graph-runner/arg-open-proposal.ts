import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { GraphTemplateSpec } from '../self-implement/graph-yaml.js';
import { isRecord } from '../primitives/guards.js';

export type ArgOpenChange =
  | { readonly kind: 'vocabulary'; readonly term: string }
  | { readonly kind: 'edge'; readonly from: string; readonly to: string; readonly condition: string }
  | { readonly kind: 'node'; readonly node: Readonly<Record<string, unknown>> }
  | { readonly kind: 'condition'; readonly expression: string }
  | { readonly kind: 'external-action'; readonly action: string };

export interface ArgOpenProposal {
  readonly apiVersion: 'elanous.dev/arg-proposal/v1';
  readonly verb: string;
  readonly rationale: string;
  readonly changes: readonly ArgOpenChange[];
  readonly rollbackWhen: readonly string[];
}

export interface ArgOpenDecision {
  readonly disposition: 'auto-apply' | 'input_required' | 'rejected';
  readonly risk: 'low' | 'high';
  readonly reason: string;
  readonly impact: readonly string[];
  readonly proposal?: ArgOpenProposal;
}

export interface ArgOpenContext {
  readonly graph: GraphTemplateSpec;
  readonly observation: Readonly<Record<string, unknown>>;
  readonly memory: readonly unknown[];
  readonly knowledgePacks: readonly unknown[];
  readonly cardPath: string;
}

/** The LLM output is untrusted. The union permits novel verbs while keeping
 * every proposed effect in a small, typed vocabulary for policy review. */
export function parseArgOpenProposal(value: unknown): ArgOpenProposal | null {
  if (!isRecord(value) || value.apiVersion !== 'elanous.dev/arg-proposal/v1' ||
      typeof value.verb !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/.test(value.verb) ||
      typeof value.rationale !== 'string' || !value.rationale.trim() ||
      !Array.isArray(value.changes) || value.changes.length === 0 ||
      !Array.isArray(value.rollbackWhen) || !value.rollbackWhen.every(item => typeof item === 'string' && item.trim()) ||
      Object.keys(value).some(key => !['apiVersion', 'verb', 'rationale', 'changes', 'rollbackWhen'].includes(key))) return null;
  const changes: ArgOpenChange[] = [];
  for (const change of value.changes) {
    if (!isRecord(change)) return null;
    if (change.kind === 'vocabulary' && Object.keys(change).length === 2 && typeof change.term === 'string')
      changes.push({ kind: 'vocabulary', term: change.term });
    else if (change.kind === 'edge' && Object.keys(change).length === 4 &&
      typeof change.from === 'string' && typeof change.to === 'string' && typeof change.condition === 'string')
      changes.push({ kind: 'edge', from: change.from, to: change.to, condition: change.condition });
    else if (change.kind === 'node' && Object.keys(change).length === 2 && isRecord(change.node))
      changes.push({ kind: 'node', node: change.node });
    else if (change.kind === 'condition' && Object.keys(change).length === 2 && typeof change.expression === 'string')
      changes.push({ kind: 'condition', expression: change.expression });
    else if (change.kind === 'external-action' && Object.keys(change).length === 2 && typeof change.action === 'string')
      changes.push({ kind: 'external-action', action: change.action });
    else return null;
  }
  return { apiVersion: 'elanous.dev/arg-proposal/v1', verb: value.verb, rationale: value.rationale,
    changes, rollbackWhen: value.rollbackWhen as string[] };
}

export async function proposeOpenArg(context: ArgOpenContext, callLLM: (prompt: string) => Promise<string>): Promise<ArgOpenProposal | null> {
  const prompt = [
    'You are a graph supervisor. Propose one bounded change for an unseen situation.',
    'Return only JSON with apiVersion elanous.dev/arg-proposal/v1, verb, rationale, changes, rollbackWhen.',
    'Changes may use vocabulary {term}, edge {from,to,condition}, node {node}, condition {expression}, or external-action {action}.',
    'Never include a shell command, secret value, or arbitrary executable payload.',
    `Observation: ${JSON.stringify(context.observation)}`,
    `Graph: ${JSON.stringify(context.graph)}`,
    `Knowledge packs: ${JSON.stringify(context.knowledgePacks)}`,
    `Template memory: ${JSON.stringify(context.memory)}`,
  ].join('\n');
  let raw: unknown;
  try { raw = JSON.parse((await callLLM(prompt)).trim()); }
  catch { return null; }
  return parseArgOpenProposal(raw);
}

/** Dry-run policy: only a new namespaced vocabulary term is auto-applicable.
 * A novel node, edge, condition, or external action must receive MRTR approval. */
export function validateOpenArgProposal(proposal: ArgOpenProposal | null, context: ArgOpenContext): ArgOpenDecision {
  if (!proposal) return { disposition: 'rejected', risk: 'high', reason: 'proposal schema invalid', impact: [] };
  const card = parseYaml(readFileSync(context.cardPath, 'utf8')) as Record<string, unknown>;
  const policy = isRecord(card?.policy) && isRecord(card.policy.openProposal) ? card.policy.openProposal : undefined;
  const namespace = policy?.vocabularyNamespace;
  if (typeof namespace !== 'string' || !/^[a-z][a-z0-9.-]*$/.test(namespace))
    return { disposition: 'rejected', risk: 'high', reason: 'open-proposal policy missing', impact: [] };
  const nodeIds = new Set(context.graph.nodes.map(node => node.nodeId));
  const impact: string[] = [];
  for (const change of proposal.changes) {
    if (change.kind === 'vocabulary') {
      if (!new RegExp(`^${namespace.replaceAll('.', '\\.')}(?:\\.[a-z][a-z0-9-]*)+$`).test(change.term))
        return { disposition: 'rejected', risk: 'high', reason: 'vocabulary outside declared namespace', impact: [] };
      impact.push(`vocabulary:${change.term}`);
    } else if (change.kind === 'edge') {
      if (!nodeIds.has(change.from) || !nodeIds.has(change.to) || !change.condition.trim())
        return { disposition: 'rejected', risk: 'high', reason: 'edge dry-run failed', impact: [] };
      impact.push(`edge:${change.from}->${change.to}`);
    } else if (change.kind === 'node') {
      const id = change.node.node_id;
      const kind = change.node.kind;
      const recipe = change.node.recipe;
      if (typeof id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(id) || nodeIds.has(id) ||
          typeof kind !== 'string' || !['agent', 'gate', 'judge', 'prompt', 'hitl', 'subgraph'].includes(kind) ||
          typeof recipe !== 'string' || !recipe.trim())
        return { disposition: 'rejected', risk: 'high', reason: 'node dry-run failed', impact: [] };
      nodeIds.add(id);
      impact.push(`node:${id}`);
    } else if (change.kind === 'condition') {
      if (!change.expression.trim() || change.expression.length > 256)
        return { disposition: 'rejected', risk: 'high', reason: 'condition lint failed', impact: [] };
      impact.push(`condition:${change.expression}`);
    } else {
      if (!change.action.trim() || change.action.length > 256)
        return { disposition: 'rejected', risk: 'high', reason: 'external action lint failed', impact: [] };
      impact.push(`external-action:${change.action}`);
    }
  }
  const lowRisk = proposal.changes.length === 1 && proposal.changes.every(change => change.kind === 'vocabulary') &&
    Array.isArray(policy?.lowRiskKinds) && policy.lowRiskKinds.includes('vocabulary') &&
    proposal.rollbackWhen.includes('verification fails');
  const highRiskKinds = Array.isArray(policy?.highRiskKinds)
    ? policy.highRiskKinds.filter((kind): kind is string => typeof kind === 'string') : [];
  const lowRiskKinds = Array.isArray(policy?.lowRiskKinds)
    ? policy.lowRiskKinds.filter((kind): kind is string => typeof kind === 'string') : [];
  const hasHighRiskChange = proposal.changes.some(change => highRiskKinds.includes(change.kind));
  if (!lowRisk && (!hasHighRiskChange ||
      proposal.changes.some(change => !highRiskKinds.includes(change.kind) &&
        !lowRiskKinds.includes(change.kind))))
    return { disposition: 'rejected', risk: 'high', reason: 'effect kind absent from open-proposal policy', impact };
  return { disposition: lowRisk ? 'auto-apply' : 'input_required', risk: lowRisk ? 'low' : 'high',
    reason: lowRisk ? 'namespaced vocabulary dry-run passed' : 'effect needs MRTR approval', impact, proposal };
}

export interface ArgMemoryEntry { readonly targetRunId: string; readonly term: string; readonly observation: string;
  readonly verifiedUses: number; readonly status: 'candidate' }

export function argCandidateDirectory(root: string, targetRunId: string): string {
  if (!targetRunId.trim()) throw new Error('ARG candidate memory requires targetRunId');
  return join(root, 'graph-supervisors/instance-memory',
    `run-${createHash('sha256').update(targetRunId).digest('hex')}`, 'candidates');
}

/** Quarantine verified observations in instance memory. Template promotion and
 * retrieval require a separate declared, verified MRTR-approved workflow. */
export function recordOpenArgMemory(root: string, cardPath: string, targetRunId: string,
  term: string, observation: string, verified: boolean): ArgMemoryEntry {
  const card = parseYaml(readFileSync(cardPath, 'utf8')) as Record<string, unknown>;
  const policy = isRecord(card?.policy) && isRecord(card.policy.openProposal) ? card.policy.openProposal : undefined;
  if (policy?.candidateStore !== 'instance' || policy.injectCandidateMemory !== false ||
      policy.autoPromote !== false || !Array.isArray(policy.templatePromotion) ||
      JSON.stringify(policy.templatePromotion) !== JSON.stringify(['declaration', 'verification', 'mrtr-approval']))
    throw new Error('ARG instance candidate memory policy invalid');
  const directory = argCandidateDirectory(root, targetRunId);
  mkdirSync(directory, { recursive: true });
  const entry: ArgMemoryEntry = { targetRunId, term, observation, verifiedUses: verified ? 1 : 0, status: 'candidate' };
  // A unique create-only file keeps every observation when ticks write at once.
  writeFileSync(join(directory, `${randomUUID()}.json`), JSON.stringify(entry) + '\n', { flag: 'wx' });
  appendFileSync(join(root, 'graph-supervisors/actions.jsonl'), JSON.stringify({ verb: 'memory-candidate',
    targetRunId, term, evidence: observation, verifiedUses: entry.verifiedUses, status: entry.status }) + '\n');
  return entry;
}
