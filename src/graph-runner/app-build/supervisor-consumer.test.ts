import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideGraphApproval, readGraphRun, runGraph } from '../runner.js';
import { emptyGraphCapabilityRegistry, registerGraphCapabilityContract,
  registerGraphCapabilityProviderDeclaration } from '../capabilities.js';
import { registerAppBuildSupervisorProvider } from '../capability-providers/app-build-supervisor.js';
import type { GraphCapabilityRegistry } from '../capabilities.js';
import { s2CatalogSnapshotDigest } from './s2-declaration-rules.js';
import { withS2SupervisorProvider } from '../plugin-graph-providers.js';
import { consumeAppBuildSupervisorFailure, SUPERVISOR_CORRECTION_LIMIT,
  SUPERVISOR_TOTAL_VISIT_LIMIT } from './supervisor-consumer.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function graphFixture() {
  const root = mkdtempSync(join(tmpdir(), 's2-supervisor-'));
  roots.push(root);
  const graph = join(root, 'app-build-s2.yaml');
  writeFileSync(graph, [
    'apiVersion: elanous.dev/graph/v2',
    'graph: { id: app-build-s2, version: 1.0.0, layer: flow, purpose: correction-test }',
    'entry: file-plan',
    'nodes:',
    '  - { id: file-plan, type: capability, requires: fake.step@1, with: { stage: file-plan }, max_visits: 3 }',
    '  - { id: files, type: capability, requires: fake.step@1, with: { stage: files }, max_visits: 3 }',
    '  - { id: verify-repair, type: capability, requires: fake.step@1, with: { stage: verify }, max_visits: 3 }',
    '  - { id: supervisor-correct, type: capability, requires: app-build.supervisor-correct@1, with: { stage: supervisor }, max_visits: 3 }',
    '  - { id: materialize, type: capability, requires: fake.step@1, with: { stage: materialize } }',
    '  - { id: publish, type: capability, requires: fake.step@1, with: { stage: publish } }',
    'edges:',
    '  - { from: file-plan, on: outcome, map: { done: files, failed: failed } }',
    '  - { from: files, on: outcome, map: { done: verify-repair, failed: supervisor-correct } }',
    '  - { from: verify-repair, on: outcome, map: { done: materialize, failed: supervisor-correct } }',
    '  - { from: supervisor-correct, on: outcome, map: { file-plan: file-plan, seed: file-plan, test-contract: file-plan, visitor-policy: file-plan, failed: failed } }',
    '  - { from: materialize, on: outcome, map: { done: publish, failed: failed } }',
    '  - { from: publish, on: outcome, map: { done: done, failed: failed } }',
    'terminal: [done, failed]',
    '',
  ].join('\n'));
  writeFileSync(join(root, 'recipes.yaml'), '{}\n');
  return { root, graph };
}

function registry(failureCount: number, calls: string[]): GraphCapabilityRegistry {
  let base = registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), {
    id: 'fake.step@1', input: { type: 'object' }, output: { type: 'object' },
  });
  base = registerGraphCapabilityProviderDeclaration(base, {
    id: 'fake-s2-steps', provides: ['fake.step@1'], tier: 'free',
    invoke: async context => {
      calls.push(context.nodeId);
      if (context.nodeId === 'files' && calls.filter(item => item === 'files').length <= failureCount)
        return { ok: false, outcome: 'failed', error: 'FILE_OUTPUT_INVALID' };
      return { ok: true, outcome: 'done', result: { stage: context.nodeId } };
    },
  });
  return registerAppBuildSupervisorProvider(base);
}
const correctionBudget = (providers: GraphCapabilityRegistry) => ({ maxCorrections: SUPERVISOR_CORRECTION_LIMIT,
  maxTotalVisits: SUPERVISOR_TOTAL_VISIT_LIMIT,
  deadlineAtMs: Date.now() + 60_000, catalogSnapshotDigest: s2CatalogSnapshotDigest(providers) });

test('actual S2 graph dispatches a failed stage to supervisor and revisits the declared plan in the same run', async () => {
  const { root, graph } = graphFixture();
  const calls: string[] = [];
  const providers = registry(1, calls);
  const state = await runGraph(graph, { input: { ask: 'build' }, verifiedOwnerId: 'owner-1',
    s2CorrectionBudget: correctionBudget(providers), quiet: true, deps: { root, capabilityProviders: providers } });
  expect(state.status).toBe('done');
  expect(state.path.filter(node => node === 'file-plan')).toHaveLength(2);
  expect(state.path.filter(node => node === 'files')).toHaveLength(2);
  expect(calls.filter(node => node === 'materialize')).toHaveLength(1);
  expect(calls.filter(node => node === 'publish')).toHaveLength(1);
  const correction = state.nodes.find(node => node.nodeId === 'supervisor-correct');
  const output = JSON.parse(typeof correction?.output === 'string' ? correction.output : '{}') as { result?: { graphCorrection?: { eventId: string;
    correctionRole: string; remainingCorrections: number; graphId: string; runId: string;
    outputSha256: string; sha256: string; before: string } } };
  expect(output.result?.graphCorrection?.correctionRole).toBe('file-plan');
  expect(output.result?.graphCorrection?.remainingCorrections).toBe(1);
  expect(output.result?.graphCorrection?.runId).toBe(state.runId);
  expect(output.result?.graphCorrection?.before).toBe('retire-current-file-plan');
  expect(output.result?.graphCorrection?.sha256).toMatch(/^[a-f0-9]{64}$/u);
  const failedOutput = state.nodes.find(node => node.nodeId === 'files' && !node.ok)?.output;
  const failedObject = typeof failedOutput === 'string' ? JSON.parse(failedOutput) : failedOutput;
  expect(output.result?.graphCorrection?.outputSha256)
    .toBe(createHash('sha256').update(JSON.stringify(failedObject)).digest('hex'));
});

test('third correction ends failed before materialize or publish', async () => {
  const { root, graph } = graphFixture();
  const calls: string[] = [];
  const providers = registry(3, calls);
  const state = await runGraph(graph, { input: { ask: 'build' }, verifiedOwnerId: 'owner-1',
    s2CorrectionBudget: correctionBudget(providers), quiet: true, deps: { root, capabilityProviders: providers } });
  expect(state.status).toBe('failed');
  expect(state.path.filter(node => node === 'file-plan')).toHaveLength(3);
  expect(state.path.filter(node => node === 'supervisor-correct')).toHaveLength(3);
  expect(state.nodes.at(-2)?.nodeId).toBe('supervisor-correct');
  expect(state.nodes.at(-2)?.output).toContain('CORRECTION_BUDGET_EXHAUSTED');
  expect(calls).not.toContain('materialize');
  expect(calls).not.toContain('publish');
  await expect(runGraph(graph, { resumeRunId: state.runId, resumeGraphId: state.graphId,
    fromNodeId: 'files', verifiedOwnerId: 'owner-1', quiet: true,
    deps: { root, capabilityProviders: providers } }))
    .rejects.toThrow('cannot preserve a failed predecessor when resuming');
  expect(calls).not.toContain('materialize');
  expect(calls).not.toContain('publish');
});

test('missing, expired and mismatched trusted policy fail before a correction effect', async () => {
  const { root, graph } = graphFixture();
  const calls: string[] = [];
  const providers = registry(1, calls);
  const missing = await runGraph(graph, { input: { ask: 'build' }, verifiedOwnerId: 'owner-1', quiet: true,
    deps: { root, capabilityProviders: providers } });
  expect(missing.status).toBe('failed');
  expect(missing.nodes.find(node => node.nodeId === 'supervisor-correct')?.output).toContain('TRUSTED_BUDGET_MISSING');
  expect(calls).not.toContain('materialize');
  expect(calls).not.toContain('publish');
  const next = graphFixture();
  const noCalls: string[] = [];
  const isolated = registry(1, noCalls);
  await expect(runGraph(next.graph, { input: { ask: 'build' }, verifiedOwnerId: 'owner-1', quiet: true,
    s2CorrectionBudget: { ...correctionBudget(isolated), deadlineAtMs: Date.now() - 1 },
    deps: { root: next.root, capabilityProviders: isolated } })).rejects.toThrow('S2_CORRECTION_BUDGET_UNTRUSTED');
  await expect(runGraph(next.graph, { input: { ask: 'build' }, verifiedOwnerId: 'owner-1', quiet: true,
    s2CorrectionBudget: { ...correctionBudget(isolated), catalogSnapshotDigest: '0'.repeat(64) },
    deps: { root: next.root, capabilityProviders: isolated } })).rejects.toThrow('S2_CORRECTION_BUDGET_UNTRUSTED');
  expect(noCalls).toHaveLength(0);
});

test('persisted S2 owner and deadline cannot disappear or reset on resume', async () => {
  const { root, graph } = graphFixture();
  const calls: string[] = [];
  const providers = registry(1, calls);
  const state = await runGraph(graph, { input: { ask: 'build' }, verifiedOwnerId: 'owner-1', quiet: true,
    s2CorrectionBudget: correctionBudget(providers), deps: { root, capabilityProviders: providers } });
  expect(state.status).toBe('done');
  const original = readFileSync(state.statePath, 'utf8');
  const ledger = JSON.parse(original) as Record<string, unknown>;
  delete ledger.s2CorrectionOwnerId;
  writeFileSync(state.statePath, JSON.stringify(ledger));
  expect(() => readGraphRun(state.graphId, state.runId, root)).toThrow('S2_CORRECTION_OWNER_MISSING');
  writeFileSync(state.statePath, original);
  const expired = JSON.parse(original) as { s2CorrectionBudget: { deadlineAtMs: number } };
  expired.s2CorrectionBudget.deadlineAtMs = Date.now() - 1;
  writeFileSync(state.statePath, JSON.stringify(expired));
  await expect(runGraph(graph, { resumeRunId: state.runId, resumeGraphId: state.graphId,
    verifiedOwnerId: 'owner-1', quiet: true, deps: { root, capabilityProviders: providers } }))
    .rejects.toThrow('S2_CORRECTION_BUDGET_UNTRUSTED');
  writeFileSync(state.statePath, original);
  const missing = JSON.parse(original) as Record<string, unknown>;
  delete missing.s2CorrectionBudget;
  writeFileSync(state.statePath, JSON.stringify(missing));
  await expect(runGraph(graph, { resumeRunId: state.runId, resumeGraphId: state.graphId,
    verifiedOwnerId: 'owner-1', quiet: true, deps: { root, capabilityProviders: providers } }))
    .rejects.toThrow('S2_CORRECTION_BUDGET_MISSING');
});

test('actual cleanup provider is bound to the persisted role and rechecks the ledger after its effect', async () => {
  for (const mode of ['valid', 'wrong-role', 'ledger-swapped'] as const) {
    const wrongRole = mode === 'wrong-role';
    const { root, graph } = graphFixture();
    let source = readFileSync(graph, 'utf8');
    source = source.replace('edges:\n', [
      '  - { id: retire-current-file-plan, type: capability, requires: app-build.retire-current@1, with: { correctionRole: file-plan } }',
      '  - { id: retire-current-seed, type: capability, requires: app-build.retire-current@1, with: { correctionRole: seed } }',
      'edges:',
    ].join('\n') + '\n');
    source = source.replace('file-plan: file-plan, seed: file-plan, test-contract: file-plan, visitor-policy: file-plan, failed: failed',
      'file-plan: ' + (wrongRole ? 'retire-current-seed' : 'retire-current-file-plan')
      + ', seed: retire-current-seed, test-contract: retire-current-file-plan, visitor-policy: retire-current-file-plan, failed: failed');
    source = source.replace('terminal: [done, failed]', [
      '  - { from: retire-current-file-plan, on: outcome, map: { done: file-plan, failed: failed } }',
      '  - { from: retire-current-seed, on: outcome, map: { done: file-plan, failed: failed } }',
      'terminal: [done, failed]',
    ].join('\n'));
    writeFileSync(graph, source);
    const calls: string[] = [];
    let cleanupEffects = 0;
    let base = registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), {
      id: 'fake.step@1', input: { type: 'object' }, output: { type: 'object' },
    });
    base = registerGraphCapabilityProviderDeclaration(base, {
      id: 'fake-s2-steps', provides: ['fake.step@1'], tier: 'free',
      invoke: async context => {
        calls.push(context.nodeId);
        return context.nodeId === 'files' && calls.filter(node => node === 'files').length === 1
          ? { ok: false, outcome: 'failed', error: 'FILE_OUTPUT_INVALID' }
          : { ok: true, outcome: 'done', result: { stage: context.nodeId } };
      },
    });
    base = registerGraphCapabilityContract(base, { id: 'app-build.retire-current@1',
      input: { type: 'object' }, output: { type: 'object' } });
    base = registerGraphCapabilityProviderDeclaration(base, {
      id: 'fake-retirement-effect', provides: ['app-build.retire-current@1'], tier: 'free',
      invoke: async context => {
        cleanupEffects++;
        if (mode === 'ledger-swapped') {
          const path = join(root, 'graph-runs', 'app-build-s2', context.runId + '.json');
          const saved = JSON.parse(readFileSync(path, 'utf8')) as { nodes: { output?: string }[] };
          const supervisor = saved.nodes.at(-1)!;
          const output = JSON.parse(supervisor.output!) as { result: { graphCorrection: { sha256: string } } };
          output.result.graphCorrection.sha256 = '0'.repeat(64);
          supervisor.output = JSON.stringify(output);
          writeFileSync(path, JSON.stringify(saved));
        }
        return { ok: true, outcome: 'done', result: { kind: 'retired' } };
      },
    });
    const providers = withS2SupervisorProvider('elanous-app-build', 'graph/app-build-s2.yaml',
      wrongRole ? registerAppBuildSupervisorProvider(base) : base);
    const state = await runGraph(graph, { input: { ask: 'build' }, verifiedOwnerId: 'owner-1', quiet: true,
      s2CorrectionBudget: correctionBudget(providers), deps: { root, capabilityProviders: providers } });
    expect(state.status).toBe(mode === 'valid' ? 'done' : 'failed');
    expect(cleanupEffects).toBe(wrongRole ? 0 : 1);
    expect(state.path.filter(node => node === 'file-plan')).toHaveLength(mode === 'valid' ? 2 : 1);
    if (mode !== 'valid') expect(state.nodes.find(node => node.nodeId === (wrongRole
      ? 'retire-current-seed' : 'retire-current-file-plan'))?.output)
      .toContain('S2_RETIREMENT_RECEIPT_MISMATCH');
  }
});

test('receipt persistence failure stops before the correction edge dispatches', async () => {
  const { root, graph } = graphFixture();
  const calls: string[] = [];
  const base = registry(1, calls);
  let runId = '';
  const providers = { ...base, providers: base.providers.map(provider => provider.id !== 'app-build-supervisor-correct'
    ? provider : { ...provider, invoke: async (context: Parameters<typeof provider.invoke>[0]) => {
      const result = await provider.invoke(context);
      runId = context.runId;
      chmodSync(join(root, 'graph-runs', 'app-build-s2'), 0o500);
      return result;
    } }) };
  try {
    await expect(runGraph(graph, { input: { ask: 'build' }, verifiedOwnerId: 'owner-1', quiet: true,
      s2CorrectionBudget: correctionBudget(providers),
      deps: { root, capabilityProviders: providers } })).rejects.toThrow();
  } finally { chmodSync(join(root, 'graph-runs', 'app-build-s2'), 0o700); }
  expect(calls.filter(node => node === 'file-plan')).toHaveLength(1);
  expect(calls.filter(node => node === 'files')).toHaveLength(1);
  expect(calls).not.toContain('materialize');
  expect(calls).not.toContain('publish');
  const saved = JSON.parse(readFileSync(join(root, 'graph-runs', 'app-build-s2', runId + '.json'), 'utf8')) as {
    nodes: Array<{ nodeId: string }> };
  expect(saved.nodes.some(node => node.nodeId === 'supervisor-correct')).toBe(false);
});

test('an approved resume keeps the same-run correction cap after the collector restarts', async () => {
  const { root, graph } = graphFixture();
  let source = readFileSync(graph, 'utf8');
  source = source.replace('edges:\n', [
    '  - { id: publish-approval, type: hitl, hitl: { options: [{ key: y, exit: approved }, { key: N, exit: rejected, default: true }] }, max_visits: 3 }',
    '  - { id: site-scenario-public, type: capability, requires: fake.step@1, with: { stage: public }, max_visits: 3 }',
    '  - { id: retire-current, type: capability, requires: fake.step@1, with: { stage: retire }, max_visits: 3 }',
    'edges:',
  ].join('\n') + '\n');
  source = source.replace('file-plan: file-plan, seed: file-plan, test-contract: file-plan, visitor-policy: file-plan, failed: failed',
    'file-plan: retire-current, seed: retire-current, test-contract: retire-current, visitor-policy: retire-current, failed: failed');
  source = source.replace('from: materialize, on: outcome, map: { done: publish, failed: failed }',
    'from: materialize, on: outcome, map: { done: publish-approval, failed: failed }');
  source = source.replace('with: { stage: materialize } }', 'with: { stage: materialize }, max_visits: 3 }')
    .replace('with: { stage: publish } }', 'with: { stage: publish }, max_visits: 3 }');
  source = source.replace('from: publish, on: outcome, map: { done: done, failed: failed }', [
    'from: publish, on: outcome, map: { done: site-scenario-public, failed: failed } }',
    '  - { from: publish-approval, on: outcome, map: { approved: publish, rejected: failed } }',
    '  - { from: site-scenario-public, on: outcome, map: { done: done, failed: supervisor-correct } }',
    '  - { from: retire-current, on: outcome, map: { file-plan: file-plan, seed: file-plan, test-contract: file-plan, visitor-policy: file-plan, failed: failed }',
  ].join('\n'));
  writeFileSync(graph, source);
  const calls: string[] = [];
  let published = false;
  let publicChecks = 0;
  let retired = 0;
  let base = registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), {
    id: 'fake.step@1', input: { type: 'object' }, output: { type: 'object' },
  });
  base = registerGraphCapabilityProviderDeclaration(base, {
    id: 'fake-s2-steps', provides: ['fake.step@1'], tier: 'free',
    invoke: async context => {
      calls.push(context.nodeId);
      if (context.nodeId === 'files' && calls.filter(node => node === 'files').length === 1)
        return { ok: false, outcome: 'failed', error: 'FILE_OUTPUT_INVALID' };
      if (context.nodeId === 'site-scenario-public') {
        publicChecks++;
        return { ok: false, outcome: 'failed', error: 'API_CONTRACT_MISMATCH' };
      }
      if (context.nodeId === 'publish') published = true;
      if (context.nodeId === 'retire-current') {
        const supervisor = context.outputs['supervisor-correct'] as { result?: { graphCorrection?: { correctionRole?: string } } };
        if (!supervisor?.result?.graphCorrection?.correctionRole)
          return { ok: false, outcome: 'failed', error: 'CORRECTION_RECEIPT_MISSING' };
        if (published) { retired++; published = false; }
        return { ok: true, outcome: supervisor.result.graphCorrection.correctionRole,
          result: { retired } };
      }
      return { ok: true, outcome: 'done', result: { stage: context.nodeId } };
    },
  });
  const providers = registerAppBuildSupervisorProvider(base);
  const policy = correctionBudget(providers);
  let state = await runGraph(graph, { input: { ask: 'build' }, verifiedOwnerId: 'owner-1', quiet: true,
    s2CorrectionBudget: policy,
    deps: { root, capabilityProviders: providers } });
  expect(state.status).toBe('awaiting-approval');
  expect(state.nodes.filter(node => node.nodeId === 'supervisor-correct')).toHaveLength(1);
  await expect(runGraph(graph, { resumeRunId: state.runId, resumeGraphId: state.graphId,
    verifiedOwnerId: 'other-owner', quiet: true, deps: { root, capabilityProviders: providers } }))
    .rejects.toThrow('S2_CORRECTION_BUDGET_UNTRUSTED');
  await expect(runGraph(graph, { resumeRunId: state.runId, resumeGraphId: state.graphId,
    verifiedOwnerId: 'owner-1', quiet: true,
    s2CorrectionBudget: { ...policy, deadlineAtMs: policy.deadlineAtMs + 1_000 },
    deps: { root, capabilityProviders: providers } }))
    .rejects.toThrow('S2_CORRECTION_BUDGET_CANNOT_EXPAND');
  decideGraphApproval(state.graphId, state.runId, 'approved', 'owner-1', root);
  state = await runGraph(graph, { resumeRunId: state.runId, resumeGraphId: state.graphId,
    verifiedOwnerId: 'owner-1', quiet: true,
    s2CorrectionBudget: { ...policy, deadlineAtMs: policy.deadlineAtMs - 1_000 },
    deps: { root, capabilityProviders: providers } });
  expect(state.status).toBe('awaiting-approval');
  expect(state.s2CorrectionBudget?.deadlineAtMs).toBe(policy.deadlineAtMs - 1_000);
  expect(state.nodes.filter(node => node.nodeId === 'supervisor-correct')).toHaveLength(2);
  const secondCorrection = state.nodes.filter(node => node.nodeId === 'supervisor-correct')[1];
  expect(secondCorrection?.output).toContain('"remainingCorrections":0');
  expect(retired).toBe(1);
  decideGraphApproval(state.graphId, state.runId, 'approved', 'owner-1', root);
  state = await runGraph(graph, { resumeRunId: state.runId, resumeGraphId: state.graphId,
    verifiedOwnerId: 'owner-1', quiet: true, deps: { root, capabilityProviders: providers } });
  expect(state.status).toBe('failed');
  expect(state.nodes.at(-2)?.output).toContain('CORRECTION_BUDGET_EXHAUSTED');
  expect(publicChecks).toBe(2);
  expect(state.nodes.filter(node => node.nodeId === 'publish-approval' && node.ok)).toHaveLength(2);
  expect(calls.filter(node => node === 'publish')).toHaveLength(2);
  expect(retired).toBe(1);
});


const directBudget = { correctionCount: 0, maxCorrections: SUPERVISOR_CORRECTION_LIMIT,
  totalVisits: 2, maxTotalVisits: SUPERVISOR_TOTAL_VISIT_LIMIT,
  remainingSteps: 20, nodeVisits: { 'file-plan': 1, architecture: 1, 'visitor-policy': 0 },
  priorFailedEventIds: [] as string[], inputSha256: 'a'.repeat(64),
  catalogSnapshotDigest: 'b'.repeat(64), requiresVisitorWrite: true,
  nowMs: 1_000, deadlineAtMs: 60_000 };

function decisionFor(nodeId: 'files' | 'verify-repair' | 'site-scenario-local', reason: string,
  change: Record<string, unknown> = {}) {
  const graphId = 'app-build-s2'; const runId = 's2-test-run';
  const eventId = graphId + ':' + runId + ':2';
  const observation = { graphId, runId, lastSequence: 2, truncated: false,
    sequenceGapObserved: true, outOfOrderIgnored: false,
    events: [{ version: 1 as const, eventId, sequence: 2, graphId, runId, nodeId,
      attempt: 1, at: '2026-11-16T00:00:00.000Z', dryRun: false, kind: 'failed' as const }] };
  const input = { graphId, runId, verifiedOwnerId: 'owner-1', graphObservation: observation,
    graphCorrection: directBudget,
    outputs: { [nodeId]: { outcome: 'failed', error: 'contract-exhausted',
      evidence: { attempts: [{ provider: 'fake-real-stage', reason }] } } } };
  return consumeAppBuildSupervisorFailure({ ...input, ...change });
}

test('six allowlisted actual failure codes select only their declared correction roles', () => {
  expect(decisionFor('files', 'FILE_OUTPUT_INVALID').outcome).toBe('file-plan');
  expect(decisionFor('verify-repair', 'BUILD_TESTS_EXHAUSTED').outcome).toBe('test-contract');
  expect(decisionFor('site-scenario-local', 'API_CONTRACT_MISMATCH').outcome).toBe('file-plan');
  expect(decisionFor('site-scenario-local', 'SEED_NOT_STARTED').outcome).toBe('seed');
  expect(decisionFor('site-scenario-local', 'DB_PATH_MISMATCH').outcome).toBe('seed');
  expect(decisionFor('site-scenario-local', 'VISITOR_WRITE_UNAUTHORIZED').outcome).toBe('visitor-policy');
});

test('owner, run identity, replay, cap and security failures refuse correction', () => {
  expect(decisionFor('files', 'FILE_OUTPUT_INVALID', { verifiedOwnerId: undefined }).decision).toBe('failed');
  expect(decisionFor('files', 'FILE_OUTPUT_INVALID', { runId: 'other-run' }).decision).toBe('failed');
  expect(decisionFor('files', 'FILE_OUTPUT_INVALID', { graphCorrection: {
    ...directBudget, priorFailedEventIds: ['app-build-s2:s2-test-run:2'] } }).reasonCode).toBe('CORRECTION_REPLAY');
  expect(decisionFor('files', 'FILE_OUTPUT_INVALID', { graphCorrection: {
    ...directBudget, correctionCount: 2 } }).reasonCode).toBe('CORRECTION_BUDGET_EXHAUSTED');
  expect(decisionFor('site-scenario-local', 'VISITOR_WRITE_UNAUTHORIZED', { graphCorrection: {
    ...directBudget, requiresVisitorWrite: false } }).reasonCode).toBe('UNCORRECTABLE_FAILURE');
  expect(decisionFor('site-scenario-local', 'SELF_APPROVAL_DENIED').decision).toBe('failed');
  expect(decisionFor('files', 'BUILD_TESTS_EXHAUSTED').decision).toBe('failed');
  expect(decisionFor('files', 'FILE_OUTPUT_INVALID', { outputs: { files: { outcome: 'failed',
    error: 'contract-exhausted', evidence: { attempts: [
      { provider: 'one', reason: 'FILE_OUTPUT_INVALID' },
      { provider: 'two', reason: 'OWNER_DENIED' },
    ] } } } }).decision).toBe('failed');
  const stale = decisionFor('files', 'FILE_OUTPUT_INVALID', { graphObservation: {
    graphId: 'app-build-s2', runId: 's2-test-run', lastSequence: 3, truncated: false,
    sequenceGapObserved: true, outOfOrderIgnored: false,
    events: [
      { version: 1, eventId: 'app-build-s2:s2-test-run:2', sequence: 2, graphId: 'app-build-s2',
        runId: 's2-test-run', nodeId: 'files', attempt: 1, at: '2026-11-16T00:00:00.000Z', dryRun: false, kind: 'failed' },
      { version: 1, eventId: 'app-build-s2:s2-test-run:3', sequence: 3, graphId: 'app-build-s2',
        runId: 's2-test-run', nodeId: 'publish', attempt: 1, at: '2026-11-16T00:00:01.000Z', dryRun: false, kind: 'completed' },
    ],
  } });
  expect(stale.reasonCode).toBe('NO_MATCHING_FAILURE');
});
