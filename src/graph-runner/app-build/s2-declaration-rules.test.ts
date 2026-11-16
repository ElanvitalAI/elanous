import { createHash } from 'node:crypto';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import type { GraphCapabilityRegistry, GraphContractId, GraphCapabilityProvider } from '../capabilities.js';
import { runGraph } from '../runner.js';
import { createGraphEventBus } from '../graph-events.js';
import { S2_DECLARATION_RULES as policy, lowerS2Declaration, s2CatalogSnapshotDigest,
  s2RequiredCatalogIds, selectS2Correction, validateS2Declaration, validateS2RetirementReceipt, registerS2RetirementProvider, guardS2RetirementProviders,
  type S2CommittedCorrection,
  type S2Declaration, type S2DeclarationScope, type S2CorrectionScope, type S2ObservedFailure } from './s2-declaration-rules.js';

const DEADLINE_MS = 60_000;
const INPUT_HASH = 'a'.repeat(64);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function registry(invoke: GraphCapabilityProvider = () => ({ ok: true, outcome: 'done', result: {} })): GraphCapabilityRegistry {
  const ids = [...new Set([...Object.values(policy.catalog).map(node => node.requires), ...policy.nativeDocumentContracts])] as GraphContractId[];
  return { contracts: Object.fromEntries(ids.map(id => [id, { id, input: {}, output: {} }])),
    providers: [{ id: 's2-test-provider', provides: ids, tier: 'free', invoke }] };
}
function scope(extra: Partial<S2DeclarationScope> = {}): S2DeclarationScope {
  return { graphId: 's2-test', verifiedOwnerId: 'fixture-owner', registry: registry(), hasVerifiedPdf: true,
    documentConsentVerified: true, requiresVisitorWrite: true,
    remainingVisits: policy.limits.maxTotalVisits, remainingDeadlineMs: DEADLINE_MS, ...extra };
}
/** Synthetic supervisor proposal; production consumes a proposed manifest instead of this fixture. */
function proposal(s: S2DeclarationScope): S2Declaration {
  const ids = s2RequiredCatalogIds(s);
  const normal = policy.normalOrder.filter(id => ids.includes(id as typeof ids[number]));
  const outcomes = [...new Set(Object.values(policy.failureRoutes).map(route => route.outcome))];
  const failures = new Set(Object.values(policy.failureRoutes).flatMap(route => route.nodes));
  return { schemaVersion: policy.schemaVersion, catalogSnapshotDigest: s2CatalogSnapshotDigest(s.registry),
    entryNodeId: 'source-reserve', terminalNodeIds: ['done', 'failed'],
    nodes: ids.map(id => ({ id, catalogId: id, maxVisits: policy.catalog[id].maxVisits })),
    budget: { maxCorrections: policy.limits.maxCorrections, maxTotalVisits: policy.limits.maxTotalVisits, deadlineMs: DEADLINE_MS },
    edges: ids.map(id => {
      const map: Record<string, string> = id === 'supervisor-correct'
        ? { ...Object.fromEntries(outcomes.map(role => [role, role === 'visitor-policy' && !s.requiresVisitorWrite ? 'failed' : 'retire-current-' + role])), failed: 'failed' }
        : id.startsWith('retire-current-')
          ? { done: Object.values(policy.failureRoutes).find(route => 'retire-current-' + route.outcome === id)!.target, failed: 'failed' }
          : id === 'visitor-policy' ? { done: 'file-plan', failed: 'failed' }
            : { done: normal[normal.indexOf(id) + 1] ?? 'done', failed: failures.has(id) ? 'supervisor-correct' : 'failed' };
      return { from: id, on: 'outcome', map };
    }) };
}
function observed(reasonCode = 'SEED_NOT_STARTED', nodeId = 'site-scenario-local'): S2ObservedFailure {
  return { graphId: 's2-test', runId: 'same-run', nodeId, reasonCode, eventId: 'observed-failure', sequence: 1, inputSha256: INPUT_HASH, outputSha256: 'b'.repeat(64) };
}
function correctionScope(failure: S2ObservedFailure, extra: Partial<S2CorrectionScope> = {}): S2CorrectionScope {
  return { graphId: failure.graphId, runId: failure.runId, verifiedOwnerId: 'fixture-owner', inputSha256: INPUT_HASH,
    observedFailures: [failure], consumedEventIds: [], correctionsUsed: 0, maxCorrections: policy.limits.maxCorrections,
    visitsUsed: 0, maxTotalVisits: policy.limits.maxTotalVisits, nowMs: 0, deadlineAtMs: DEADLINE_MS, requiresVisitorWrite: true, ...extra };
}

test.each([true, false])('lowers the registered catalog with verified PDF=%s and explicit approval barrier', hasVerifiedPdf => {
  const s = scope({ hasVerifiedPdf });
  const checked = lowerS2Declaration(proposal(s), s);
  expect(checked.ok).toBe(true);
  if (!checked.ok) throw new Error(checked.code);
  expect(checked.graph.nodes.some(node => node.id === 'document-parse')).toBe(hasVerifiedPdf);
  expect(checked.graph.edges.find(edge => edge.from === 'materialize')?.map.done).toBe('publish-approval');
  expect(checked.graph.edges.find(edge => edge.from === 'publish-approval')?.map.done).toBe('publish');
  expect(checked.requiredRuntimeBudget.maxCorrections).toBe(policy.limits.maxCorrections);
});

test('rejects unknown authority fields, poisoned keys, skipped approval and cleanup edges', () => {
  const s = scope();
  const unknown = { ...proposal(s), command: 'anything' };
  expect(validateS2Declaration(unknown, s).ok).toBe(false);
  expect(validateS2Declaration(JSON.parse(JSON.stringify(proposal(s)).replace('"schemaVersion":1', '"schemaVersion":1,"__proto__":{}')), s).ok).toBe(false);
  for (const [from, outcome, target] of [['materialize', 'done', 'publish'], ['supervisor-correct', 'seed', 'file-plan'], ['retire-current-seed', 'done', 'architecture']]) {
    const p = proposal(s);
    p.edges.find(edge => edge.from === from)!.map[outcome!] = target!;
    expect(validateS2Declaration(p, s)).toMatchObject({ ok: false, code: 'UNSAFE_CORRECTION_EDGE' });
  }
});

test('does not execute model-supplied serialization hooks or mutable policy overrides', () => {
  const s = scope();
  let called = false;
  const malicious = { ...proposal(s), toJSON: () => { called = true; return proposal(s); } };
  expect(validateS2Declaration(malicious, s)).toMatchObject({ ok: false, code: 'NON_JSON_DECLARATION' });
  expect(called).toBe(false);
  expect(Object.isFrozen(policy.failureRoutes.SEED_NOT_STARTED.nodes)).toBe(true);
  expect(Object.isFrozen(policy.limits)).toBe(true);
});

test('requires real provider declarations, native document capabilities, consent and current snapshot', () => {
  const s = scope();
  expect(validateS2Declaration(proposal(s), { ...s, documentConsentVerified: false }).ok).toBe(false);
  const noProviders = scope({ registry: { ...s.registry, providers: [] } });
  expect(validateS2Declaration(proposal(noProviders), noProviders)).toMatchObject({ ok: false, code: 'CAPABILITY_UNPROVIDED' });
  const missingNative = registry();
  const contracts = { ...missingNative.contracts };
  delete contracts['document.information-extract@1'];
  const nativeScope = scope({ registry: { ...missingNative, contracts } });
  expect(validateS2Declaration(proposal(nativeScope), nativeScope)).toMatchObject({ ok: false, code: 'DOCUMENT_CAPABILITY_UNPROVIDED' });
  expect(validateS2Declaration(proposal(s), noProviders).ok).toBe(false);
  const reduced = { ...s, remainingVisits: policy.limits.maxCorrections };
  expect(validateS2Declaration(proposal(s), reduced).ok).toBe(false);
});

for (const [reason, route] of Object.entries(policy.failureRoutes)) {
  test(`selects fixed correction for ${reason} only from its observed source`, () => {
    const failure = observed(reason, route.nodes[0]!);
    const selected = selectS2Correction(failure, correctionScope(failure));
    expect(selected).toMatchObject({ ok: true, outcome: route.outcome, receipt: { targetNodeId: route.target, before: 'retire-current-' + route.outcome, correctionNumber: 1 } });
    if (selected.ok) {
      expect(selected.receipt.outputSha256).toBe(failure.outputSha256);
      expect(selected.receipt.remainingCorrections).toBe(policy.limits.maxCorrections - selected.receipt.correctionNumber);
      expect(selected.receipt.deadlineAtMs).toBe(DEADLINE_MS);
    }
    const wrong = { ...failure, nodeId: 'publish-approval' };
    expect(selectS2Correction(wrong, correctionScope(wrong)).ok).toBe(false);
  });
}

test('binds the persisted correction receipt role and target to its exact cleanup node', () => {
  const failure = observed();
  const selected = selectS2Correction(failure, correctionScope(failure));
  if (!selected.ok) throw new Error(selected.code);
  const retirement = { graphId: failure.graphId, runId: failure.runId, inputSha256: failure.inputSha256,
    outputSha256: failure.outputSha256, cleanupNodeId: 'retire-current-seed', persistedReceiptSha256: selected.receipt.sha256 };
  expect(validateS2RetirementReceipt(selected.receipt, retirement)).toBe(true);
  expect(validateS2RetirementReceipt(selected.receipt, { ...retirement, cleanupNodeId: 'retire-current-test-contract' })).toBe(false);
  for (const change of [{ correctionRole: 'test-contract', targetNodeId: 'architecture' },
    { before: 'retire-current-test-contract' }, { runId: 'other-run' }, { outputSha256: 'c'.repeat(64) }]) {
    const forged = { ...selected.receipt, ...change };
    const { sha256: _old, ...unsigned } = forged;
    forged.sha256 = createHash('sha256').update(JSON.stringify(unsigned)).digest('hex');
    expect(validateS2RetirementReceipt(forged, retirement)).toBe(false);
  }
});

test('rejects replay, cross-run/input, unknown/security reasons, exhausted counters and elapsed deadline', () => {
  const failure = observed();
  for (const extra of [ { consumedEventIds: [failure.eventId] }, { runId: 'other-run' }, { verifiedOwnerId: '' },
    { inputSha256: 'b'.repeat(64) }, { observedFailures: [] }, { correctionsUsed: policy.limits.maxCorrections },
    { visitsUsed: policy.limits.maxTotalVisits }, { nowMs: DEADLINE_MS } ]) {
    expect(selectS2Correction(failure, correctionScope(failure, extra)).ok).toBe(false);
  }
  for (const reason of ['OWNER_DENIED', 'APPROVAL_REQUIRED', 'TOKEN_EXPIRED', '__proto__', 'UNRECOGNIZED']) {
    const unknown = observed(reason);
    expect(selectS2Correction(unknown, correctionScope(unknown))).toMatchObject({ ok: false, outcome: 'failed' });
  }
});

test.each([{ failuresNeeded: 1, expectedStatus: 'done', corrections: 1, maliciousCleanup: false, maliciousSupervisor: false },
  { failuresNeeded: 2, expectedStatus: 'done', corrections: 2, maliciousCleanup: false, maliciousSupervisor: false },
  { failuresNeeded: 3, expectedStatus: 'failed', corrections: 2, maliciousCleanup: false, maliciousSupervisor: false },
  { failuresNeeded: 1, expectedStatus: 'failed', corrections: 1, maliciousCleanup: true, maliciousSupervisor: false },
  { failuresNeeded: 1, expectedStatus: 'failed', corrections: 1, maliciousCleanup: false, maliciousSupervisor: true }])('existing runner bounds same-run correction: %j', async ({ failuresNeeded, expectedStatus, corrections, maliciousCleanup, maliciousSupervisor }) => {
  const seen: string[] = [];
  const failures: S2ObservedFailure[] = [];
  let correctionsUsed = 0;
  let committed: S2CommittedCorrection | undefined;
  let retirementEffects = 0;
  let scenarioVisits = 0;
  const bus = createGraphEventBus();
  bus.subscribe(event => {
    if (event.type === 'node-end' && event.source.nodeId === 'site-scenario-local' && event.data?.ok === false)
      failures.push({ graphId: event.graphId, runId: event.runId, nodeId: event.source.nodeId, eventId: event.eventId,
        sequence: event.sequence, reasonCode: 'SEED_NOT_STARTED', inputSha256: INPUT_HASH, outputSha256: '' });
  });
  const s = scope({ hasVerifiedPdf: false, requiresVisitorWrite: false, registry: registry(context => {
    seen.push(context.nodeId);
    if (context.nodeId.startsWith('retire-current-')) {
      retirementEffects++;
      expect(seen.at(-2)).toBe('receipt-committed');
      return { ok: true, outcome: maliciousCleanup ? 'test-contract' : 'done', result: { cleanup: 'synthetic' } };
    }
    if (context.nodeId === 'site-scenario-local') {
      scenarioVisits++;
      if (scenarioVisits <= failuresNeeded) return { ok: false, outcome: 'failed', error: 'SEED_NOT_STARTED' };
    }
    if (context.nodeId === 'supervisor-correct') {
      const failure = failures.at(-1);
      if (!failure) return { ok: false, outcome: 'failed', error: 'missing actual failed event' };
      failure.outputSha256 = createHash('sha256').update(JSON.stringify(context.outputs[failure.nodeId])).digest('hex');
      const selected = selectS2Correction(failure, correctionScope(failure, { correctionsUsed, visitsUsed: seen.length }));
      if (!selected.ok) return { ok: false, outcome: 'failed', error: selected.code };
      correctionsUsed = selected.receipt.correctionNumber;
      committed = { ownerId: context.verifiedOwnerId!, receipt: selected.receipt, sha256: selected.receipt.sha256,
        inputSha256: failure.inputSha256, outputSha256: failure.outputSha256 };
      seen.push('receipt-committed');
      return { ok: true, outcome: maliciousSupervisor ? 'test-contract' : selected.outcome, result: selected.receipt };
    }
    return { ok: true, outcome: 'done', result: {} };
  }) });
  // The production S2 host applies this same wrapper to its registered cleanup providers.
  s.registry = guardS2RetirementProviders(s.registry, () => committed);
  const lowered = lowerS2Declaration(proposal(s), s);
  if (!lowered.ok) throw new Error(lowered.code);
  const root = mkdtempSync(join(tmpdir(), 's2-declaration-')); roots.push(root);
  const graphPath = join(root, 's2.yaml');
  writeFileSync(graphPath, stringify(lowered.graph));
  const state = await runGraph(graphPath, { graphSource: stringify(lowered.graph), input: { ask: 'synthetic application' },
    verifiedOwnerId: s.verifiedOwnerId, runId: 'same-run', eventBus: bus, routeGraphEvents: false, quiet: true,
    deps: { root, capabilityProviders: s.registry } });
  if (state.status !== expectedStatus) throw new Error(JSON.stringify({ status: state.status, path: state.path, nodes: state.nodes.map(node => ({ nodeId: node.nodeId, output: node.output })), seen }));
  expect(state.status).toBe(expectedStatus);
  expect(state.runId).toBe('same-run');
  expect(seen.filter(id => id === 'file-plan')).toHaveLength(maliciousCleanup || maliciousSupervisor ? corrections : corrections + 1);
  expect(correctionsUsed).toBe(corrections);
  if (!maliciousSupervisor) expect(seen.indexOf('receipt-committed')).toBeLessThan(seen.indexOf('retire-current-seed'));
  else expect(retirementEffects).toBe(0);
  if (!maliciousCleanup && !maliciousSupervisor) expect(seen.indexOf('retire-current-seed')).toBeLessThan(seen.lastIndexOf('file-plan'));
  else expect(seen.filter(id => id === 'architecture')).toHaveLength(1);
});
