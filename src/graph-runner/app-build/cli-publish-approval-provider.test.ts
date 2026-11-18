import { expect, test } from 'bun:test';
import { ApprovalPresentationUnavailableError, withCliAppBuildApprovalProvider } from './cli-publish-approval-provider.js';
import { createSourceBuildWithApprovalRegistry } from '../capability-providers/app-build-publish-approval.js';

const approvalUrl = 'https://api.elanous.ai/v1/members/deployment-approvals/8f195ad4-a4e2-4b31-a7bc-155602760279';

test('CLI window privately presents the formal URL and continues only after approved poll', async () => {
  const signal = new AbortController().signal;
  const shown: string[] = [];
  const registry = withCliAppBuildApprovalProvider(createSourceBuildWithApprovalRegistry(), {
    ownerId: 'owner-a', runId: 'run-a', appSlug: 'owner-slot', signal, pollIntervalMsForTesting: 10,
    presentUrl: (url) => { shown.push(url); },
    transport: async action => action === 'approval-start'
      ? { status: 'approval-pending', approvalUrl,
        pendingExpiresAt: new Date(Date.now() + 60_000).toISOString() }
      : { status: 'approval-approved' },
  });
  const provider = registry.providers.find(item => item.provides.includes('app-build.publish-approval@1'))!;
  const result = await provider.invoke({ graphId: 'app-build', runId: 'run-a', nodeId: 'publish-approval',
    input: {}, outputs: {}, graphInput: { context: { memberId: 'owner-a' } },
    nodeInput: { action: 'start', appSlug: 'owner-slot', requireOwner: 'owner-a' },
    verifiedOwnerId: 'owner-a', signal });
  expect(result).toEqual({ ok: true, outcome: 'done', result: { status: 'approved' } });
  expect(shown).toEqual([approvalUrl]);
  expect(JSON.stringify(result)).not.toContain(approvalUrl);
});

test('owner mismatch cannot invoke formal approval transport', async () => {
  const signal = new AbortController().signal;
  let called = 0;
  const registry = withCliAppBuildApprovalProvider(createSourceBuildWithApprovalRegistry(), {
    ownerId: 'owner-a', runId: 'run-a', appSlug: 'owner-slot', signal, presentUrl: () => {},
    transport: async () => { called++; return { status: 'approval-approved' }; },
  });
  const provider = registry.providers.find(item => item.provides.includes('app-build.publish-approval@1'))!;
  const result = await provider.invoke({ graphId: 'app-build', runId: 'run-a', nodeId: 'publish-approval',
    input: {}, outputs: {}, graphInput: { context: { memberId: 'owner-a' } },
    nodeInput: { action: 'start', appSlug: 'owner-slot', requireOwner: 'owner-a' },
    verifiedOwnerId: 'foreign-owner', signal });
  expect(result).toMatchObject({ ok: false, outcome: 'failed' });
  expect(called).toBe(0);
});

test('expired parent window and an aborted dispatcher signal never start server approval', async () => {
  const controller = new AbortController();
  let called = 0;
  const registry = withCliAppBuildApprovalProvider(createSourceBuildWithApprovalRegistry(), {
    ownerId: 'owner-a', runId: 'run-a', appSlug: 'owner-slot', signal: controller.signal, presentUrl: () => {},
    transport: async () => { called++; return { status: 'approval-approved' }; },
  });
  const provider = registry.providers.find(item => item.provides.includes('app-build.publish-approval@1'))!;
  const base = { graphId: 'app-build', runId: 'run-a', nodeId: 'publish-approval',
    input: {}, outputs: {}, graphInput: { context: { memberId: 'owner-a' } },
    nodeInput: { action: 'start', appSlug: 'owner-slot', requireOwner: 'owner-a' },
    verifiedOwnerId: 'owner-a' };
  const stoppedChild = new AbortController(); stoppedChild.abort();
  expect(await provider.invoke({ ...base, signal: stoppedChild.signal }))
    .toMatchObject({ ok: false, outcome: 'failed' });
  controller.abort();
  expect(await provider.invoke({ ...base, signal: controller.signal }))
    .toMatchObject({ ok: false, outcome: 'failed' });
  expect(called).toBe(0);
});

test('same-run pending resume polls the pinned approval and never starts another grant', async () => {
  const signal = new AbortController().signal;
  const actions: string[] = [];
  const expiry = new Date(Date.now() + 60_000).toISOString();
  const registry = withCliAppBuildApprovalProvider(createSourceBuildWithApprovalRegistry(), {
    ownerId: 'owner-a', runId: 'run-a', appSlug: 'owner-slot', signal, resumePendingExpiresAt: expiry,
    pollIntervalMsForTesting: 10, presentUrl: () => {},
    transport: async action => {
      actions.push(action);
      return actions.length === 1
        ? { status: 'approval-pending', approvalUrl, pendingExpiresAt: expiry }
        : { status: 'approval-approved' };
    },
  });
  const provider = registry.providers.find(item => item.provides.includes('app-build.publish-approval@1'))!;
  const result = await provider.invoke({ graphId: 'app-build', runId: 'run-a', nodeId: 'publish-approval',
    input: {}, outputs: {}, graphInput: { context: { memberId: 'owner-a' } },
    nodeInput: { action: 'start', appSlug: 'owner-slot', requireOwner: 'owner-a' },
    verifiedOwnerId: 'owner-a', signal });
  expect(result).toMatchObject({ ok: true, outcome: 'done' });
  expect(actions).toEqual(['approval-poll', 'approval-poll']);
});

test('only typed technical terminal failure after valid pending yields a retry marker', async () => {
  const signal = new AbortController().signal;
  const expiry = new Date(Date.now() + 60_000).toISOString();
  const base = { graphId: 'app-build', runId: 'run-a', nodeId: 'publish-approval', input: {}, outputs: {},
    graphInput: { context: { memberId: 'owner-a' } },
    nodeInput: { action: 'start', appSlug: 'owner-slot', requireOwner: 'owner-a' },
    verifiedOwnerId: 'owner-a', signal };
  const registry = withCliAppBuildApprovalProvider(createSourceBuildWithApprovalRegistry(), {
    ownerId: 'owner-a', runId: 'run-a', appSlug: 'owner-slot', signal,
    transport: async () => ({ status: 'approval-pending', approvalUrl, pendingExpiresAt: expiry }),
    presentUrl: () => { throw new ApprovalPresentationUnavailableError('TTY write failed'); },
  });
  const provider = registry.providers.find(item => item.provides.includes('app-build.publish-approval@1'))!;
  const result = await provider.invoke(base);
  expect(result).toMatchObject({ ok: false, outcome: 'failed',
    error: `APP_BUILD_APPROVAL_PRESENTATION_RETRYABLE:${expiry}` });
  expect(JSON.stringify(result)).not.toContain(approvalUrl);
  const refused = withCliAppBuildApprovalProvider(createSourceBuildWithApprovalRegistry(), {
    ownerId: 'owner-a', runId: 'run-a', appSlug: 'owner-slot', signal,
    transport: async () => ({ status: 'approval-pending', approvalUrl, pendingExpiresAt: expiry }),
    presentUrl: () => { throw new Error('user declined'); },
  }).providers.find(item => item.provides.includes('app-build.publish-approval@1'))!;
  expect((await refused.invoke(base)).error).not.toContain('RETRYABLE');
});

test('late approved poll leaves the parent run live for publish while approval wait has its own deadline', async () => {
  const signal = new AbortController().signal;
  const expiry = new Date(Date.now() + 60_000).toISOString();
  let polls = 0;
  const registry = withCliAppBuildApprovalProvider(createSourceBuildWithApprovalRegistry(), {
    ownerId: 'owner-a', runId: 'run-a', appSlug: 'owner-slot', signal,
    pollIntervalMsForTesting: 10, presentUrl: () => {},
    transport: async action => action === 'approval-start' || ++polls < 7
      ? { status: 'approval-pending', approvalUrl, pendingExpiresAt: expiry }
      : { status: 'approval-approved' },
  });
  const provider = registry.providers.find(item => item.provides.includes('app-build.publish-approval@1'))!;
  const context = { graphId: 'app-build', runId: 'run-a', nodeId: 'publish-approval',
    input: {}, outputs: {}, graphInput: { context: { memberId: 'owner-a' } },
    nodeInput: { action: 'start', appSlug: 'owner-slot', requireOwner: 'owner-a' },
    verifiedOwnerId: 'owner-a', signal };
  expect(await provider.invoke(context)).toMatchObject({ ok: true, outcome: 'done' });
  expect(polls).toBe(7);
  await new Promise(done => setTimeout(done, 80));
  expect(signal.aborted).toBe(false);
  const publish = async () => { if (signal.aborted) throw new Error('parent run canceled'); return 'published'; };
  expect(await publish()).toBe('published');

  const shortWindow = withCliAppBuildApprovalProvider(createSourceBuildWithApprovalRegistry(), {
    ownerId: 'owner-a', runId: 'run-a', appSlug: 'owner-slot', signal,
    now: () => Date.now() - 4 * 60_000 + 35, pollIntervalMsForTesting: 10,
    presentUrl: () => {}, transport: async () => ({ status: 'approval-pending', approvalUrl,
      pendingExpiresAt: expiry }),
  }).providers.find(item => item.provides.includes('app-build.publish-approval@1'))!;
  expect(await shortWindow.invoke(context)).toMatchObject({ ok: false, outcome: 'failed' });
  expect(signal.aborted).toBe(false);
});
