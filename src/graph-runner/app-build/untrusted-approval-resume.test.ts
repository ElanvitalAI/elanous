import { expect, test } from 'bun:test';
import { Command } from 'commander';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideGraphApproval, readGraphRun, runGraph, type GraphRunState } from '../runner.js';
import { dispatchGraphContract, emptyGraphCapabilityRegistry, registerGraphCapabilityContract,
  registerGraphCapabilityProviderDeclaration, type GraphCapabilityRegistry } from '../capabilities.js';
import { registerAppBuildPublishApprovalProvider } from '../capability-providers/app-build-publish-approval.js';
import { withCliAppBuildApprovalProvider } from './cli-publish-approval-provider.js';
import { genericResumeApprovalRefusal, savedAppBuildApprovalResumeInput } from './cli-publish-approval-resume.js';
import { registerGraphCommands } from '../graph-cli.js';

const APPROVAL_URL = 'https://api.elanous.ai/v1/members/deployment-approvals/8f195ad4-a4e2-4b31-a7bc-155602760279';
const input = { appSlug: 'owner-slot', context: { memberId: 'owner-a' } };
const nodeInput = { action: 'start', appSlug: 'owner-slot', requireOwner: 'owner-a' };

function registryWithPublish(onPublish: () => void = () => {}): GraphCapabilityRegistry {
  let registry = registerAppBuildPublishApprovalProvider(emptyGraphCapabilityRegistry(), {
    transport: async () => { throw new Error('untrusted path must not reach the bridge'); } });
  registry = registerGraphCapabilityContract(registry, { id: 'source-build.publish@1',
    input: { type: 'object' }, output: { type: 'object' } });
  return registerGraphCapabilityProviderDeclaration(registry, { id: 'fake-publish',
    provides: ['source-build.publish@1'], tier: 'free', invoke: async () => {
      onPublish();
      return { ok: true, outcome: 'done', result: { status: 'published' } };
    } });
}

test('generic registry at the approval node fails with the typed resume instruction, not contract-exhausted', async () => {
  const result = await dispatchGraphContract('app-build.publish-approval@1', { graphId: 'app-build', runId: 'run-a',
    nodeId: 'publish-approval', input: nodeInput, outputs: {}, graphInput: input, nodeInput,
    verifiedOwnerId: 'owner-a', signal: new AbortController().signal }, registryWithPublish());
  expect(result.ok).toBe(false);
  expect(result.error).toStartWith('APP_BUILD_APPROVAL_UNTRUSTED_RESUME: 신뢰 경로로 재개 필요: eln graph run');
  expect(result.error).toContain('--resume run-a --from publish-approval');
  expect(result.error).not.toBe('contract-exhausted');
  // An undeclared code from another provider is still masked.
  let other = registerGraphCapabilityContract(emptyGraphCapabilityRegistry(), { id: 'source-build.publish@1',
    input: { type: 'object' }, output: { type: 'object' } });
  other = registerGraphCapabilityProviderDeclaration(other, { id: 'plain', provides: ['source-build.publish@1'],
    tier: 'free', invoke: async () => ({ ok: false, outcome: 'failed', error: 'APP_BUILD_APPROVAL_UNTRUSTED_RESUME' }) });
  expect((await dispatchGraphContract('source-build.publish@1', { graphId: 'g', runId: 'r', nodeId: 'n',
    input: {}, outputs: {} }, other)).error).toBe('contract-exhausted');
  expect(() => registerGraphCapabilityProviderDeclaration(emptyGraphCapabilityRegistry(), { id: 'bad',
    provides: ['source-build.publish@1'], tier: 'free', preserveFailureCodes: ['lower-case'],
    invoke: async () => ({ ok: true, outcome: 'done' }) })).toThrow();
});

test('real failed run: generic resume refused, trusted CLI predicate accepts saved state, approval starts and publishes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'app-build-ab-resume-'));
  try {
    const graph = join(root, 'app-build.yaml');
    writeFileSync(join(root, 'recipes.yaml'), '{}\n');
    writeFileSync(graph, 'apiVersion: elanous.dev/graph/v2\n' +
      'graph: { id: app-build, version: 1.0.0, layer: flow, purpose: untrusted-resume-proof }\n' +
      'entry: materialize\n' +
      'nodes:\n' +
      '  - { id: materialize, type: capability, requires: source-build.materialize@1 }\n' +
      '  - id: review-publish\n' +
      '    type: hitl\n' +
      '    with: { approval: "publish?" }\n' +
      '    hitl:\n' +
      '      options:\n' +
      '        - { key: y, exit: approved, default: false }\n' +
      '        - { key: N, exit: declined, default: true }\n' +
      '  - { id: publish-approval, type: capability, requires: app-build.publish-approval@1, with: { action: start, appSlug: $input.appSlug, requireOwner: $context.memberId } }\n' +
      '  - { id: publish, type: capability, requires: source-build.publish@1 }\n' +
      'edges:\n' +
      '  - { from: materialize, on: outcome, map: { done: review-publish, failed: failed } }\n' +
      '  - { from: review-publish, on: outcome, map: { approved: publish-approval, declined: failed } }\n' +
      '  - { from: publish-approval, on: outcome, map: { done: publish, failed: failed } }\n' +
      '  - { from: publish, on: outcome, map: { done: done, failed: failed } }\n' +
      'terminal: [done, failed]\n');
    let publishes = 0;
    let registry = registerGraphCapabilityContract(registryWithPublish(() => { publishes++; }), {
      id: 'source-build.materialize@1', input: { type: 'object' }, output: { type: 'object' } });
    registry = registerGraphCapabilityProviderDeclaration(registry, { id: 'fake-materialize',
      provides: ['source-build.materialize@1'], tier: 'free',
      invoke: async () => ({ ok: true, outcome: 'done', result: { materialized: true } }) });
    const stateRoot = join(root, 'state');
    const runId = 'ab-untrusted';
    const awaiting = await runGraph(graph, { runId, input, verifiedOwnerId: 'owner-a', quiet: true,
      deps: { root: stateRoot, capabilityProviders: registry } });
    expect(awaiting.status).toBe('awaiting-approval');
    decideGraphApproval('app-build', runId, 'approved', 'owner-a', stateRoot, { nodeId: 'review-publish', visit: 1 });
    // The generic registry (no owner window) reaches approval after the review was approved.
    const failed = await runGraph(graph, { resumeRunId: runId, verifiedOwnerId: 'owner-a', quiet: true,
      deps: { root: stateRoot, capabilityProviders: registry } });
    expect(failed.status).toBe('failed');
    const approval = failed.nodes.find(node => node.nodeId === 'publish-approval')!;
    expect(approval.error).toStartWith('APP_BUILD_APPROVAL_UNTRUSTED_RESUME:');
    expect(publishes).toBe(0);

    // The generic CLI resume refuses loudly and leaves the failed run untouched.
    const err: string[] = [];
    const previousError = console.error;
    console.error = (...parts) => { err.push(parts.join(' ')); };
    try {
      const program = new Command().exitOverride();
      registerGraphCommands(program, { root: stateRoot, processStartMs: () => null });
      await program.parseAsync(['node', 'elanous', 'graph', 'runs', 'resume', runId]);
      expect(process.exitCode).toBe(1);
    } finally { console.error = previousError; process.exitCode = 0; }
    expect(err.join('\n')).toContain('APP_BUILD_APPROVAL_UNTRUSTED_RESUME');
    expect(err.join('\n')).toContain(`--resume ${runId} --from publish-approval`);
    expect(publishes).toBe(0);

    // The trusted CLI predicate reads the persisted run, decision claim and snapshot.
    const saved = readGraphRun('app-build', runId, stateRoot);
    expect(saved.status).toBe('failed');
    const restart = savedAppBuildApprovalResumeInput(saved, graph);
    expect(restart).toEqual({ input: saved.input as Record<string, unknown>, executionId: approval.executionId! });

    const actions: string[] = [];
    const signal = new AbortController().signal;
    const trusted = withCliAppBuildApprovalProvider(registry, { ownerId: 'owner-a', runId,
      appSlug: 'owner-slot', signal, pollIntervalMsForTesting: 10, presentUrl: () => {},
      transport: async action => {
        actions.push(action);
        return action === 'approval-start'
          ? { status: 'approval-pending', approvalUrl: APPROVAL_URL, pendingExpiresAt: new Date(Date.now() + 60_000).toISOString() }
          : { status: 'approval-approved' };
      } });
    const resumed = await runGraph(graph, { resumeRunId: runId, fromVisitId: restart.executionId,
      verifiedOwnerId: 'owner-a', signal, quiet: true, deps: { root: stateRoot, capabilityProviders: trusted } });
    expect(actions[0]).toBe('approval-start');
    expect(resumed.status).toBe('done');
    expect(publishes).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('generic resume is refused only when it restarts at the approval node', () => {
  const read = () => snapshot;
  const approved = failedState({ ok: true, exit: 0, error: undefined }, {
    path: ['source-reserve', 'materialize', 'review-publish', 'publish-approval', 'publish', 'failed'] });
  approved.nodes.splice(4, 0, { nodeId: 'publish', executionId: 'v5', ok: false, exit: 1, executed: true, error: 'x' });
  // Restart at publish after an approved approval visit stays on the generic path.
  expect(genericResumeApprovalRefusal(approved, 'publish', read)).toBeUndefined();
  // A run that failed before approval (materialize) keeps the generic `--from materialize` resume.
  const atMaterialize = failedState({ ok: true, exit: 0, error: undefined }, {
    path: ['source-reserve', 'materialize', 'failed'] });
  atMaterialize.nodes = [atMaterialize.nodes[0]!, { ...atMaterialize.nodes[1]!, ok: false, error: 'contract-exhausted' },
    atMaterialize.nodes[4]!];
  expect(genericResumeApprovalRefusal(atMaterialize, 'materialize', read)).toBeUndefined();
  expect(genericResumeApprovalRefusal(atMaterialize, undefined, read)).toBeUndefined();
  expect(genericResumeApprovalRefusal(approved, 'materialize', read)).toBeUndefined();
  // A run that failed at publish-approval is refused with the trusted-command hint.
  const atApproval = failedState({ error: 'APP_BUILD_APPROVAL_UNTRUSTED_RESUME: x' });
  expect(genericResumeApprovalRefusal(atApproval, 'publish-approval', read)).toContain(
    'APP_BUILD_APPROVAL_UNTRUSTED_RESUME: 신뢰 경로로 재개 필요: eln graph run');
  expect(genericResumeApprovalRefusal(atApproval, 'publish-approval', read)).toContain('--resume run-a --from publish-approval');
  expect(genericResumeApprovalRefusal(failedState({ error: 'x' }, { graphSnapshot: undefined }), 'publish-approval', read)).toBeUndefined();
});

test('a different owner never reaches the approval bridge', async () => {
  let calls = 0;
  const trusted = withCliAppBuildApprovalProvider(registryWithPublish(), { ownerId: 'owner-b', runId: 'run-a',
    appSlug: 'owner-slot', signal: new AbortController().signal, presentUrl: () => {},
    transport: async () => { calls++; return { status: 'approval-approved' }; } });
  const provider = trusted.providers.find(item => item.provides.includes('app-build.publish-approval@1'))!;
  const result = await provider.invoke({ graphId: 'app-build', runId: 'run-a', nodeId: 'publish-approval',
    input: nodeInput, outputs: {}, graphInput: input, nodeInput, verifiedOwnerId: 'owner-b',
    signal: new AbortController().signal });
  expect(result.ok).toBe(false);
  expect(calls).toBe(0);
});

const graphFile = '/tmp/elanous/plugins/elanous-app-build/graph/app-build.yaml';
const statePath = '/tmp/elanous/graph-runs/app-build/run-a.json';
const snapshot = 'graph: { id: app-build }\nnodes:\n  - { id: publish-approval, type: capability, requires: app-build.publish-approval@1 }\n';
const decidedAt = '2026-11-17T07:15:55.239Z';
const inputSha256 = createHash('sha256').update(JSON.stringify(input)).digest('hex');
const legacyOutput = (reason: string, contractId = 'app-build.publish-approval@1', provider = 'app-build-owner-publish-approval') =>
  JSON.stringify({ evidence: { contractId, attempts: [{ provider, reason }] }, outcome: 'failed', error: 'contract-exhausted' });
const failedState = (approval: Partial<GraphRunState['nodes'][number]>, changes: Partial<GraphRunState> = {}): GraphRunState => ({
  graphId: 'app-build', runId: 'run-a', graphPath: graphFile, status: 'failed', statePath, input,
  path: ['source-reserve', 'materialize', 'review-publish', 'publish-approval', 'failed'],
  graphSnapshot: { graphSha: createHash('sha256').update(snapshot).digest('hex'), recipesSha: 'b'.repeat(64) },
  nodes: [
    { nodeId: 'source-reserve', executionId: 'v0', ok: true, exit: 0, executed: true },
    { nodeId: 'materialize', executionId: 'v1', ok: true, exit: 0, executed: true },
    { nodeId: 'review-publish', executionId: 'v2', ok: true, exit: null, executed: false, decidedAt },
    { nodeId: 'publish-approval', executionId: 'v3', ok: false, exit: 1, executed: true, ...approval },
    { nodeId: 'failed', executionId: 'v4', ok: true, exit: null, executed: false },
  ],
  executed: 3, dryRun: false, ...changes,
} as GraphRunState);
const reader = (claim: Record<string, unknown> = { nodeId: 'review-publish', decision: 'approved', inputSha256, decidedAt }) =>
  (path: string) => {
    if (path === `${statePath}.graph/graph.yaml`) return snapshot;
    if (path === `${statePath}.3.decision.json`) return JSON.stringify(claim);
    throw new Error(`unexpected read ${path}`);
  };

test('trusted resume restarts an approval visit that failed untrusted or with the pre-fix masked refusal', () => {
  const untrusted = failedState({ error: 'APP_BUILD_APPROVAL_UNTRUSTED_RESUME: 신뢰 경로로 재개 필요' });
  expect(savedAppBuildApprovalResumeInput(untrusted, graphFile, Date.now(), reader()))
    .toEqual({ input, executionId: 'v3' });
  for (const reason of ['verified owner approval required', 'owner approval unavailable or refused']) {
    const legacy = failedState({ error: 'contract-exhausted', output: legacyOutput(reason) });
    expect(savedAppBuildApprovalResumeInput(legacy, graphFile, Date.now(), reader()).executionId).toBe('v3');
  }
});

test('ordinary contract-exhausted failures, missing review approval and owner drift stay refused', () => {
  const check = (state: GraphRunState, read = reader()) => () => savedAppBuildApprovalResumeInput(state, graphFile, Date.now(), read);
  // Plain contract-exhausted with no approval-provider evidence.
  expect(check(failedState({ error: 'contract-exhausted' }))).toThrow();
  expect(check(failedState({ error: 'contract-exhausted', output: legacyOutput('provider-error') }))).toThrow();
  expect(check(failedState({ error: 'contract-exhausted', output: legacyOutput('verified owner approval required', 'source-build.publish@1') }))).toThrow();
  expect(check(failedState({ error: 'contract-exhausted', output: legacyOutput('verified owner approval required', undefined, 'other') }))).toThrow();
  // contract-exhausted at another node (files) is never an approval restart.
  const elsewhere = failedState({ error: 'contract-exhausted', output: legacyOutput('verified owner approval required') },
    { path: ['source-reserve', 'materialize', 'review-publish', 'files', 'failed'] });
  elsewhere.nodes[3] = { ...elsewhere.nodes[3]!, nodeId: 'files' };
  expect(check(elsewhere)).toThrow();
  const untrusted = { error: 'APP_BUILD_APPROVAL_UNTRUSTED_RESUME: x' };
  // Review decision missing, rejected, or bound to a different owner input.
  expect(check(failedState(untrusted), reader({ nodeId: 'review-publish', decision: 'rejected', inputSha256, decidedAt }))).toThrow();
  expect(check(failedState(untrusted), reader({ nodeId: 'review-publish', decision: 'approved',
    inputSha256: createHash('sha256').update(JSON.stringify({ ...input, context: { memberId: 'owner-b' } })).digest('hex'), decidedAt }))).toThrow();
  expect(check(failedState(untrusted), path => { if (path.endsWith('graph.yaml')) return snapshot; throw new Error('missing'); })).toThrow();
  expect(check(failedState(untrusted, { input: { appSlug: 'owner-slot', context: { memberId: 'owner-b' } } }))).toThrow();
  expect(check(failedState(untrusted, { input: { appSlug: 'owner-slot' } }))).toThrow();
  // Materialize must have succeeded before the review.
  const noMaterialize = failedState(untrusted);
  noMaterialize.nodes[1] = { ...noMaterialize.nodes[1]!, ok: false };
  expect(check(noMaterialize)).toThrow();
  // Snapshot drift and a still-pending run are refused.
  expect(check(failedState(untrusted), path => path.endsWith('graph.yaml') ? snapshot + '\n'
    : JSON.stringify({ nodeId: 'review-publish', decision: 'approved', inputSha256, decidedAt }))).toThrow();
  expect(check(failedState(untrusted, { status: 'awaiting-approval' }))).toThrow();
});
