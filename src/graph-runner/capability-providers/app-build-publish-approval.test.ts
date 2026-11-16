import { expect, test } from 'bun:test';
import { createAppBuildPublishApprovalProvider, createSourceBuildWithApprovalRegistry } from './app-build-publish-approval.js';

const url = 'https://api.elanous.ai/v1/members/deployment-approvals/8f195ad4-a4e2-4b31-a7bc-155602760279';
const trustedWindow = (context: { signal?: AbortSignal }) =>
  ({ signal: context.signal!, deadlineAtMs: Date.now() + 60_000 });
const context = (action: 'start' | 'poll', changes: Record<string, unknown> = {}) => ({
  graphId: 'app-build', runId: 'run-a', nodeId: 'approval', input: {}, outputs: {},
  graphInput: { context: { memberId: 'member-a' } }, verifiedOwnerId: 'member-a',
  nodeInput: { action, appSlug: 'demo-app', requireOwner: 'member-a' },
  signal: new AbortController().signal, ...changes,
});

test('ordinary app-build manifest factory includes the approval contract and refuses without a trusted host', async () => {
  const registry = createSourceBuildWithApprovalRegistry();
  const approval = registry.providers.filter(provider => provider.provides.includes('app-build.publish-approval@1'));
  expect(approval).toHaveLength(1);
  expect(await approval[0]!.invoke(context('start'))).toMatchObject({ ok: false, outcome: 'failed' });
});

test('one approval node waits for an approved poll and keeps the URL out of graph output', async () => {
  const shown: string[] = [];
  const actions: string[] = [];
  const provider = createAppBuildPublishApprovalProvider({
    trustedWindow,
    transport: async action => {
      actions.push(action);
      return action === 'approval-start' ? { status: 'approval-pending', approvalUrl: url,
        pendingExpiresAt: new Date(Date.now() + 60_000).toISOString() } : { status: 'approval-approved' };
    },
    presentApprovalUrl: async (owner, value) => { shown.push(owner + ' ' + value); },
    pollIntervalMsForTesting: 10,
  });
  const start = await provider(context('start'));
  expect(start).toEqual({ ok: true, outcome: 'done', result: { status: 'approved' } });
  expect(JSON.stringify(start)).not.toContain('8f195ad4');
  expect(shown).toEqual(['member-a ' + url]);
  expect(await provider(context('poll'))).toEqual({ ok: true, outcome: 'done', result: { status: 'approved' } });
  expect(await provider(context('poll', { graphInput: undefined,
    input: { context: { memberId: 'member-a' } } }))).toEqual({ ok: true, outcome: 'done',
    result: { status: 'approved' } });
  expect(actions).toEqual(['approval-start', 'approval-poll', 'approval-poll', 'approval-poll']);
});

test('parent abort stops a pending poll without taking the graph done edge', async () => {
  const controller = new AbortController();
  let polls = 0;
  const pendingExpiresAt = new Date(Date.now() + 60_000).toISOString();
  const provider = createAppBuildPublishApprovalProvider({
    trustedWindow,
    transport: async action => { if (action === 'approval-poll') polls++;
      return { status: 'approval-pending', approvalUrl: url, pendingExpiresAt }; },
    presentApprovalUrl: async () => {},
    pollIntervalMsForTesting: 10,
  });
  setTimeout(() => controller.abort(), 25);
  expect(await provider(context('start', { signal: controller.signal }))).toMatchObject({ ok: false,
    outcome: 'failed' });
  expect(polls).toBeTruthy();
});

test('a changed pending URL is refused before graph publication', async () => {
  let calls = 0;
  const pendingExpiresAt = new Date(Date.now() + 60_000).toISOString();
  const provider = createAppBuildPublishApprovalProvider({
    trustedWindow,
    transport: async () => ({ status: 'approval-pending',
      approvalUrl: calls++ ? url.replace('8f195ad4', '9f195ad4') : url,
      pendingExpiresAt }),
    presentApprovalUrl: async () => {}, pollIntervalMsForTesting: 10,
  });
  expect(await provider(context('start'))).toMatchObject({ ok: false, outcome: 'failed' });
});

test('parent abort bounds a stalled foreground presenter', async () => {
  const controller = new AbortController();
  const provider = createAppBuildPublishApprovalProvider({
    trustedWindow,
    transport: async () => ({ status: 'approval-pending', approvalUrl: url,
      pendingExpiresAt: new Date(Date.now() + 60_000).toISOString() }),
    presentApprovalUrl: async () => new Promise<void>(() => {}),
    pollIntervalMsForTesting: 10,
  });
  setTimeout(() => controller.abort(), 20);
  expect(await provider(context('start', { signal: controller.signal }))).toMatchObject({ ok: false,
    outcome: 'failed' });
});

test('model approval ID and missing owner presenter cannot advance approval', async () => {
  let calls = 0;
  const provider = createAppBuildPublishApprovalProvider({ trustedWindow, transport: async () => {
    calls++; return { status: 'approval-pending', approvalUrl: url,
      pendingExpiresAt: new Date(Date.now() + 60_000).toISOString() };
  } });
  expect(await provider(context('start', { nodeInput: { action: 'start', appSlug: 'demo-app',
    requireOwner: 'member-a', approvalId: 'model-chosen' } }))).toMatchObject({ ok: false });
  expect(calls).toBe(0);
  expect(await provider(context('start'))).toMatchObject({ ok: false });
  expect(await provider(context('poll', { verifiedOwnerId: 'foreign' }))).toMatchObject({ ok: false });
  expect(await provider(context('start', { signal: undefined }))).toMatchObject({ ok: false });
  expect(calls).toBe(1);
});

test('a missing or foreign trusted window refuses before transport', async () => {
  let calls = 0;
  const options = { transport: async () => { calls++; return { status: 'approval-approved' }; },
    presentApprovalUrl: async () => {} };
  expect(await createAppBuildPublishApprovalProvider(options)(context('poll'))).toMatchObject({ ok: false });
  expect(await createAppBuildPublishApprovalProvider({ ...options,
    trustedWindow: () => ({ signal: new AbortController().signal,
      deadlineAtMs: Date.now() + 60_000 }) })(context('poll'))).toMatchObject({ ok: false });
  expect(await createAppBuildPublishApprovalProvider({ ...options,
    trustedWindow: current => ({ signal: current.signal!,
      deadlineAtMs: Date.now() - 1 }) })(context('poll'))).toMatchObject({ ok: false });
  expect(calls).toBe(0);
});
