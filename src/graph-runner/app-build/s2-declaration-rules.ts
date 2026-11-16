import { createHash } from 'node:crypto';
import { stringify } from 'yaml';
import rules from '../../../plugins/elanous-app-build/graph/s2-declaration-rules.json' with { type: 'json' };
import { registerGraphCapabilityContract, registerGraphCapabilityProviderDeclaration,
  type GraphCapabilityRegistry } from '../capabilities.js';
import type { InProcessHandlerContext, InProcessHandlerResult } from '../in-process-registry.js';
import { lowerGraphV2 } from '../../graph-v2/lower.js';

function freezePolicy(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freezePolicy(child);
  Object.freeze(value);
}
freezePolicy(rules);
export const S2_DECLARATION_RULES = rules;
export const S2_GRAPH_IDENTITY = rules.identity;
export type S2ReasonCode = keyof typeof rules.failureRoutes;
export type S2CatalogId = keyof typeof rules.catalog;
type Node = { id: S2CatalogId; catalogId: S2CatalogId; maxVisits: number };
type Edge = { from: string; on: 'outcome'; map: Record<string, string> };
export interface S2Declaration {
  schemaVersion: number; catalogSnapshotDigest: string; entryNodeId: string;
  terminalNodeIds: string[]; nodes: Node[]; edges: Edge[];
  budget: { maxCorrections: number; maxTotalVisits: number; deadlineMs: number };
}
/** These options come from the authenticated host, never graph/model input. */
export interface S2DeclarationScope {
  graphId: string; verifiedOwnerId: string; registry: GraphCapabilityRegistry;
  hasVerifiedPdf: boolean; documentConsentVerified: boolean; requiresVisitorWrite: boolean;
  remainingVisits: number; remainingDeadlineMs: number;
}
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const keysAre = (value: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(value).sort().join() === [...keys].sort().join();
const catalog = rules.catalog as Record<string, { requires: string; with: Record<string, string>; maxVisits: number }>;
const provided = (registry: GraphCapabilityRegistry, id: string): boolean => Object.hasOwn(registry.contracts, id)
  && registry.providers.some(provider => (provider.provides as readonly string[]).includes(id));
const correctionOutcomes = [...new Set(Object.values(rules.failureRoutes).map(route => route.outcome))];
const correctableNodes = new Set(Object.values(rules.failureRoutes).flatMap(route => route.nodes));

function assertJson(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object') throw new Error('NON_JSON_DECLARATION');
  if (seen.has(value)) throw new Error('NON_JSON_DECLARATION');
  seen.add(value);
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    throw new Error('NON_JSON_DECLARATION');
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (['__proto__', 'prototype', 'constructor'].includes(key) || !('value' in descriptor)) throw new Error('POISON_DECLARATION');
    assertJson(descriptor.value, seen);
  }
  seen.delete(value);
}

export function s2CatalogSnapshotDigest(registry: GraphCapabilityRegistry): string {
  return digest({ rules, contracts: Object.keys(registry.contracts).sort(), providers: registry.providers.map(provider => ({ id: provider.id, provides: [...provider.provides].sort() })).sort((a, b) => a.id.localeCompare(b.id)) });
}
export function s2RequiredCatalogIds(scope: Pick<S2DeclarationScope, 'hasVerifiedPdf' | 'requiresVisitorWrite'>): S2CatalogId[] {
  return Object.keys(catalog).filter(id => (scope.hasVerifiedPdf || !['document-parse', 'information-extract'].includes(id))
    && (scope.requiresVisitorWrite || !['visitor-policy', 'retire-current-visitor-policy'].includes(id))) as S2CatalogId[];
}

/** A constrained manifest, not an execution engine. Model-provided commands/URLs/authority are rejected. */
export function validateS2Declaration(value: unknown, scope: S2DeclarationScope):
  { ok: true; declaration: S2Declaration } | { ok: false; code: string } {
  try {
    assertJson(value);
    if (Buffer.byteLength(JSON.stringify(value)) > rules.limits.maxDeclarationBytes) throw new Error('DECLARATION_BUDGET');
    if (!scope.verifiedOwnerId || !positive(scope.remainingVisits) || !positive(scope.remainingDeadlineMs)) throw new Error('TRUSTED_SCOPE_REQUIRED');
    if (scope.hasVerifiedPdf && !scope.documentConsentVerified) throw new Error('DOCUMENT_CONSENT_REQUIRED');
    if (!record(value) || !keysAre(value, ['schemaVersion', 'catalogSnapshotDigest', 'entryNodeId', 'terminalNodeIds', 'nodes', 'edges', 'budget'])
      || value.schemaVersion !== rules.schemaVersion || value.catalogSnapshotDigest !== s2CatalogSnapshotDigest(scope.registry)
      || value.entryNodeId !== 'source-reserve' || !Array.isArray(value.terminalNodeIds)
      || [...value.terminalNodeIds].sort().join() !== 'done,failed') throw new Error('DECLARATION_BINDING_INVALID');
    const budget = value.budget;
    if (!record(budget) || !keysAre(budget, ['maxCorrections', 'maxTotalVisits', 'deadlineMs'])
      || !positive(budget.maxCorrections) || budget.maxCorrections > rules.limits.maxCorrections
      || !positive(budget.maxTotalVisits) || budget.maxTotalVisits > Math.min(rules.limits.maxTotalVisits, scope.remainingVisits)
      || !positive(budget.deadlineMs) || budget.deadlineMs > scope.remainingDeadlineMs) throw new Error('DECLARATION_BUDGET');
    const required = s2RequiredCatalogIds(scope);
    if (!Array.isArray(value.nodes) || value.nodes.length !== required.length) throw new Error('REQUIRED_NODES_MISSING');
    const ids = new Set<string>();
    let visitBound = 0;
    for (const raw of value.nodes) {
      if (!record(raw) || !keysAre(raw, ['id', 'catalogId', 'maxVisits']) || typeof raw.id !== 'string'
        || raw.id !== raw.catalogId || !required.includes(raw.id as S2CatalogId) || ids.has(raw.id)
        || !positive(raw.maxVisits) || raw.maxVisits > catalog[raw.id]!.maxVisits) throw new Error('CATALOG_NODE_INVALID');
      const contract = catalog[raw.id]!.requires;
      if (!provided(scope.registry, contract)) throw new Error('CAPABILITY_UNPROVIDED');
      ids.add(raw.id); visitBound += raw.maxVisits;
    }
    if (visitBound > budget.maxTotalVisits) throw new Error('DECLARATION_BUDGET');
    if (scope.hasVerifiedPdf && rules.nativeDocumentContracts.some(id => !provided(scope.registry, id)))
      throw new Error('DOCUMENT_CAPABILITY_UNPROVIDED');
    const normal = rules.normalOrder.filter(id => ids.has(id));
    if (!Array.isArray(value.edges) || value.edges.length !== ids.size) throw new Error('DECLARATION_EDGES_INVALID');
    const sources = new Set<string>();
    for (const raw of value.edges) {
      if (!record(raw) || !keysAre(raw, ['from', 'on', 'map']) || typeof raw.from !== 'string'
        || !ids.has(raw.from) || sources.has(raw.from) || raw.on !== 'outcome' || !record(raw.map)) throw new Error('DECLARATION_EDGES_INVALID');
      sources.add(raw.from);
      let expected: Record<string, string>;
      if (raw.from === 'supervisor-correct') {
        expected = Object.fromEntries(correctionOutcomes.map(outcome => [outcome,
          outcome === 'visitor-policy' && !scope.requiresVisitorWrite ? 'failed' : 'retire-current-' + outcome]));
        expected.failed = 'failed';
      } else if (raw.from.startsWith('retire-current-')) {
        const role = catalog[raw.from]!.with.correctionRole;
        const route = Object.values(rules.failureRoutes).find(candidate => candidate.outcome === role);
        if (!route) throw new Error('UNSAFE_CORRECTION_EDGE');
        expected = { done: route.target, failed: 'failed' };
      } else if (raw.from === 'visitor-policy') expected = { done: 'file-plan', failed: 'failed' };
      else {
        const index = normal.indexOf(raw.from);
        expected = { done: normal[index + 1] ?? 'done', failed: correctableNodes.has(raw.from) ? 'supervisor-correct' : 'failed' };
      }
      const edgeMap = raw.map;
      if (!keysAre(edgeMap, Object.keys(expected)) || Object.entries(expected).some(([key, target]) => edgeMap[key] !== target))
        throw new Error('UNSAFE_CORRECTION_EDGE');
    }
    return { ok: true, declaration: value as unknown as S2Declaration };
  } catch (error) { return { ok: false, code: error instanceof Error ? error.message : 'DECLARATION_INVALID' }; }
}

/** The caller must bind these limits to its existing same-run persistence/signal; no resume budget reset. */
export function lowerS2Declaration(value: unknown, scope: S2DeclarationScope) {
  const checked = validateS2Declaration(value, scope);
  if (!checked.ok) return checked;
  const declaration = checked.declaration;
  const graph = {
    apiVersion: 'elanous.dev/graph/v2', graph: { id: scope.graphId, version: '1.0.0', layer: 'flow', purpose: 'Verified app build with bounded self-correction' },
    entry: declaration.entryNodeId,
    nodes: declaration.nodes.map(node => ({ id: node.id, type: 'capability', requires: catalog[node.catalogId]!.requires,
      with: catalog[node.catalogId]!.with, max_visits: node.maxVisits })),
    edges: declaration.edges, terminal: declaration.terminalNodeIds, observe: { categories: ['graph.run', 'graph.unit'] },
  };
  const lowered = lowerGraphV2(stringify(graph));
  if (!lowered.template || lowered.errors.length) return { ok: false as const, code: 'GRAPH_LOWERING_FAILED' };
  return { ok: true as const, graph, template: lowered.template, requiredRuntimeBudget: declaration.budget,
    catalogSnapshotDigest: declaration.catalogSnapshotDigest };
}

export interface S2ObservedFailure {
  graphId: string; runId: string; nodeId: string; eventId: string; sequence: number;
  reasonCode: string; inputSha256: string; outputSha256: string;
}
/** Populated only by the trusted same-run observer/ledger adapter. */
export interface S2CorrectionScope {
  graphId: string; runId: string; verifiedOwnerId: string; inputSha256: string;
  observedFailures: readonly S2ObservedFailure[]; consumedEventIds: readonly string[];
  correctionsUsed: number; maxCorrections: number; visitsUsed: number; maxTotalVisits: number;
  nowMs: number; deadlineAtMs: number; requiresVisitorWrite: boolean;
}
export function selectS2Correction(failure: S2ObservedFailure, scope: S2CorrectionScope) {
  const deny = (code: string) => ({ ok: false as const, outcome: 'failed' as const, code });
  if (!scope.verifiedOwnerId || failure.graphId !== scope.graphId || failure.runId !== scope.runId
    || failure.inputSha256 !== scope.inputSha256 || !/^[a-f0-9]{64}$/u.test(scope.inputSha256)
    || !/^[a-f0-9]{64}$/u.test(failure.outputSha256) || !failure.eventId || !positive(failure.sequence)
    || !scope.observedFailures.some(event => Object.keys(failure).every(key => event[key as keyof S2ObservedFailure] === failure[key as keyof S2ObservedFailure])))
    return deny('UNVERIFIED_FAILURE');
  if (scope.consumedEventIds.includes(failure.eventId)) return deny('CORRECTION_REPLAY');
  if (!Number.isSafeInteger(scope.correctionsUsed) || scope.correctionsUsed < 0 || !positive(scope.maxCorrections)
    || scope.maxCorrections > rules.limits.maxCorrections || scope.correctionsUsed >= scope.maxCorrections
    || !Number.isSafeInteger(scope.visitsUsed) || scope.visitsUsed < 0 || !positive(scope.maxTotalVisits)
    || scope.maxTotalVisits > rules.limits.maxTotalVisits || scope.visitsUsed >= scope.maxTotalVisits
    || !Number.isSafeInteger(scope.nowMs) || !Number.isSafeInteger(scope.deadlineAtMs) || scope.nowMs >= scope.deadlineAtMs)
    return deny('CORRECTION_BUDGET_EXHAUSTED');
  if (!Object.hasOwn(rules.failureRoutes, failure.reasonCode)) return deny('UNCORRECTABLE_FAILURE');
  const route = rules.failureRoutes[failure.reasonCode as S2ReasonCode];
  if (!(route.nodes as readonly string[]).includes(failure.nodeId)
    || route.outcome === 'visitor-policy' && !scope.requiresVisitorWrite) return deny('UNCORRECTABLE_FAILURE');
  const receipt = { schemaVersion: rules.schemaVersion, graphId: scope.graphId, runId: scope.runId,
    eventId: failure.eventId, sequence: failure.sequence, failedNodeId: failure.nodeId, reasonCode: failure.reasonCode,
    inputSha256: scope.inputSha256, outputSha256: failure.outputSha256, correctionNumber: scope.correctionsUsed + 1,
    remainingCorrections: scope.maxCorrections - (scope.correctionsUsed + 1),
    remainingVisits: scope.maxTotalVisits - scope.visitsUsed, deadlineAtMs: scope.deadlineAtMs,
    remainingDeadlineMs: scope.deadlineAtMs - scope.nowMs,
    correctionRole: route.outcome, targetNodeId: route.target, before: 'retire-current-' + route.outcome };
  return { ok: true as const, outcome: route.outcome, receipt: { ...receipt, sha256: digest(receipt) } };
}

export interface S2RetirementScope {
  graphId: string; runId: string; inputSha256: string; outputSha256: string;
  cleanupNodeId: string; persistedReceiptSha256: string;
}
/** Bind cleanup to the trusted persisted receipt, never a provider-selected remediation role. */
export function validateS2RetirementReceipt(value: unknown, scope: S2RetirementScope): boolean {
  try {
    assertJson(value);
    if (!record(value) || !/^[a-f0-9]{64}$/u.test(scope.persistedReceiptSha256)
      || value.sha256 !== scope.persistedReceiptSha256 || value.schemaVersion !== rules.schemaVersion
      || value.graphId !== scope.graphId || value.runId !== scope.runId
      || value.inputSha256 !== scope.inputSha256 || value.outputSha256 !== scope.outputSha256
      || value.before !== scope.cleanupNodeId || typeof value.reasonCode !== 'string'
      || !Object.hasOwn(rules.failureRoutes, value.reasonCode)) return false;
    const { sha256: _sha256, ...unsigned } = value;
    if (digest(unsigned) !== scope.persistedReceiptSha256) return false;
    const route = rules.failureRoutes[value.reasonCode as S2ReasonCode];
    return value.correctionRole === route.outcome && value.targetNodeId === route.target
      && scope.cleanupNodeId === 'retire-current-' + route.outcome;
  } catch { return false; }
}

/** Read only from the authenticated runner's committed correction ledger, never node/model input. */
export interface S2CommittedCorrection {
  ownerId: string; receipt: unknown; sha256: string; inputSha256: string; outputSha256: string;
}
export type S2RetirementProof = {
  kind: 'no-deployment'; graphId: string; runId: string; ownerId: string;
} | {
  kind: 'retired'; graphId: string; runId: string; ownerId: string;
  deploymentId: string; stopped: true; durableRetirement: true;
};
export interface S2RetirementProviderOptions {
  readCommittedCorrection: (context: InProcessHandlerContext) => S2CommittedCorrection | undefined | Promise<S2CommittedCorrection | undefined>;
  retire: (context: InProcessHandlerContext, correction: S2CommittedCorrection) => Promise<S2RetirementProof>;
}
type ReadCommittedCorrection = S2RetirementProviderOptions['readCommittedCorrection'];
async function invokeBoundRetirement(context: InProcessHandlerContext, read: ReadCommittedCorrection,
  effect: (pinned: S2CommittedCorrection) => Promise<InProcessHandlerResult>): Promise<InProcessHandlerResult> {
  const refused = (): InProcessHandlerResult => ({ ok: false, outcome: 'failed', error: 'S2_RETIREMENT_RECEIPT_MISMATCH' });
  try {
    const check = (saved: S2CommittedCorrection | undefined): saved is S2CommittedCorrection => !!saved
      && !!context.verifiedOwnerId && saved.ownerId === context.verifiedOwnerId
      && context.requires === 'app-build.retire-current@1' && !context.signal?.aborted
      && validateS2RetirementReceipt(saved.receipt, { graphId: context.graphId, runId: context.runId,
        inputSha256: saved.inputSha256, outputSha256: saved.outputSha256,
        cleanupNodeId: context.nodeId, persistedReceiptSha256: saved.sha256 });
    const saved = await read(context);
    if (!check(saved)) return refused();
    const pinned = JSON.parse(JSON.stringify(saved)) as S2CommittedCorrection;
    freezePolicy(pinned);
    const result = await effect(pinned);
    const current = await read(context);
    if (!check(current) || current.sha256 !== pinned.sha256 || !result.ok || result.outcome !== 'done' || !record(result.result))
      return refused();
    const receipt = pinned.receipt as Record<string, unknown>;
    if (Object.hasOwn(result.result, 'targetNodeId') && result.result.targetNodeId !== receipt.targetNodeId
      || Object.hasOwn(result.result, 'correctionRole') && result.result.correctionRole !== receipt.correctionRole) return refused();
    return { ...result, result: { ...result.result, receiptSha256: pinned.sha256,
      correctionRole: receipt.correctionRole, targetNodeId: receipt.targetNodeId } };
  } catch { return refused(); }
}

/** Production registry boundary: called by the S2 host registry around the existing cleanup effect. */
export function guardS2RetirementProviders(base: GraphCapabilityRegistry, read: ReadCommittedCorrection): GraphCapabilityRegistry {
  return { ...base, providers: base.providers.map(provider =>
    !(provider.provides as readonly string[]).includes('app-build.retire-current@1') ? provider : {
      ...provider, invoke: context => context.requires !== 'app-build.retire-current@1' ? provider.invoke(context)
        : invokeBoundRetirement(context, read, async () => await provider.invoke(context)),
    }) };
}

/** Actual capability handler: verifies the selected node BEFORE any cleanup effect or target dispatch. */
export function registerS2RetirementProvider(base: GraphCapabilityRegistry, options: S2RetirementProviderOptions): GraphCapabilityRegistry {
  const withContract = registerGraphCapabilityContract(base, { id: 'app-build.retire-current@1', input: {}, output: { type: 'object' } });
  return registerGraphCapabilityProviderDeclaration(withContract, { id: 's2-bound-retirement',
    provides: ['app-build.retire-current@1'], tier: 'free', invoke: context =>
      invokeBoundRetirement(context, options.readCommittedCorrection, async pinned => {
        const proof = await options.retire(context, pinned);
        if (!record(proof) || proof.graphId !== context.graphId || proof.runId !== context.runId || proof.ownerId !== context.verifiedOwnerId)
          throw new Error('S2_RETIREMENT_PROOF_INVALID');
        const safeProof = proof.kind === 'no-deployment'
          ? keysAre(proof, ['kind', 'graphId', 'runId', 'ownerId'])
          : proof.kind === 'retired' && keysAre(proof, ['kind', 'graphId', 'runId', 'ownerId', 'deploymentId', 'stopped', 'durableRetirement'])
            && typeof proof.deploymentId === 'string' && !!proof.deploymentId && proof.stopped === true && proof.durableRetirement === true;
        if (!safeProof) throw new Error('S2_RETIREMENT_PROOF_INVALID');
        return { ok: true, outcome: 'done', result: { kind: 's2-retirement' } };
      }),
  });
}
