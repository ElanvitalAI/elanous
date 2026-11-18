import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simCli } from '../ux-sim/in-process-cli.js';
import { runGraph } from './runner.js';
import { emptyGraphCapabilityRegistry, registerGraphCapabilityContract,
  registerGraphCapabilityProviderDeclaration } from './capabilities.js';
import { registerAppBuildPublishApprovalProvider } from './capability-providers/app-build-publish-approval.js';
import { withCliAppBuildApprovalProvider } from './app-build/cli-publish-approval-provider.js';

test('app-build CLI resume refuses replacement input and current-graph bypass before an approval call', async () => {
  const root = mkdtempSync(join(tmpdir(), 'app-build-approval-cli-'));
  try {
    const graph = join(root, 'app-build.yaml');
    writeFileSync(graph, 'graph: { id: app-build }\n');
    const run = (...args: string[]) => simCli(['graph', 'run', graph, '--resume', 'run-a', ...args], {
      allowPaths: [['graph', 'run']], stateRoot: join(root, 'state'), cwd: root,
    });
    const changed = await run('--input', '{"appSlug":"foreign"}');
    expect(changed.exitCode).not.toBe(0);
    expect(changed.stderr).toContain('app-build resume uses only the saved input and graph snapshot');
    const current = await run('--use-current-graph');
    expect(current.exitCode).not.toBe(0);
    expect(current.stderr).toContain('app-build resume uses only the saved input and graph snapshot');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a late formal approval reaches publish; an expired approval wait never calls publish', async () => {
  const root = mkdtempSync(join(tmpdir(), 'app-build-approval-flow-'));
  try {
    const graph = join(root, 'app-build.yaml');
    writeFileSync(join(root, 'recipes.yaml'), '{}\n');
    writeFileSync(graph, 'apiVersion: elanous.dev/graph/v2\n' +
      'graph: { id: app-build, version: 1.0.0, layer: flow, purpose: approval-flow-proof }\n' +
      'entry: publish-approval\n' +
      'nodes:\n' +
      '  - { id: publish-approval, type: capability, requires: app-build.publish-approval@1, with: { action: start, appSlug: $input.appSlug, requireOwner: $context.memberId } }\n' +
      '  - { id: publish, type: capability, requires: source-build.publish@1 }\n' +
      'edges:\n' +
      '  - { from: publish-approval, on: outcome, map: { done: publish, failed: failed } }\n' +
      '  - { from: publish, on: outcome, map: { done: done, failed: failed } }\n' +
      'terminal: [done, failed]\n');
    let publishes = 0;
    let registry = registerAppBuildPublishApprovalProvider(emptyGraphCapabilityRegistry());
    registry = registerGraphCapabilityContract(registry, { id: 'source-build.publish@1',
      input: { type: 'object' }, output: { type: 'object' } });
    registry = registerGraphCapabilityProviderDeclaration(registry, { id: 'fake-publish',
      provides: ['source-build.publish@1'], tier: 'free', invoke: async () => {
        publishes++;
        await new Promise(done => setTimeout(done, 80));
        return { ok: true, outcome: 'done', result: { status: 'published' } };
      } });
    const input = { appSlug: 'owner-slot', context: { memberId: 'owner-a' } };
    const approvalUrl = 'https://api.elanous.ai/v1/members/deployment-approvals/8f195ad4-a4e2-4b31-a7bc-155602760279';
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const parent = new AbortController().signal;
    let polls = 0;
    const approvedRegistry = withCliAppBuildApprovalProvider(registry, { ownerId: 'owner-a',
      runId: 'late-approved', appSlug: 'owner-slot', signal: parent, pollIntervalMsForTesting: 10,
      presentUrl: () => {}, transport: async action => action === 'approval-start' || ++polls < 7
        ? { status: 'approval-pending', approvalUrl, pendingExpiresAt: expiresAt }
        : { status: 'approval-approved' } });
    const completed = await runGraph(graph, { runId: 'late-approved', input, verifiedOwnerId: 'owner-a',
      signal: parent, quiet: true, deps: { root: join(root, 'state'), capabilityProviders: approvedRegistry } });
    expect(completed.status).toBe('done');
    expect(completed.path).toContain('publish');
    expect(publishes).toBe(1);
    expect(parent.aborted).toBe(false);

    const short = new AbortController().signal;
    const expiredRegistry = withCliAppBuildApprovalProvider(registry, { ownerId: 'owner-a',
      runId: 'wait-expired', appSlug: 'owner-slot', signal: short,
      now: () => Date.now() - 4 * 60_000 + 35, pollIntervalMsForTesting: 10,
      presentUrl: () => {}, transport: async () => ({ status: 'approval-pending', approvalUrl,
        pendingExpiresAt: expiresAt }) });
    const expired = await runGraph(graph, { runId: 'wait-expired', input, verifiedOwnerId: 'owner-a',
      signal: short, quiet: true, deps: { root: join(root, 'state'), capabilityProviders: expiredRegistry } });
    expect(expired.status).toBe('failed');
    expect(expired.path).not.toContain('publish');
    expect(publishes).toBe(1);
    expect(short.aborted).toBe(false);

    const canceled = new AbortController();
    const canceledRegistry = withCliAppBuildApprovalProvider(registry, { ownerId: 'owner-a',
      runId: 'parent-canceled', appSlug: 'owner-slot', signal: canceled.signal,
      pollIntervalMsForTesting: 10,
      presentUrl: () => { canceled.abort(); },
      transport: async () => ({ status: 'approval-pending', approvalUrl,
        pendingExpiresAt: expiresAt }) });
    const stopped = await runGraph(graph, { runId: 'parent-canceled', input, verifiedOwnerId: 'owner-a',
      signal: canceled.signal, quiet: true,
      deps: { root: join(root, 'state'), capabilityProviders: canceledRegistry } });
    expect(canceled.signal.aborted).toBe(true);
    expect(stopped.status).toBe('failed');
    expect(stopped.path).not.toContain('publish');
    expect(publishes).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
