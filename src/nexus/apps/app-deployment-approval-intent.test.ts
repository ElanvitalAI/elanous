import { expect, test } from 'bun:test';
import { createAppDeploymentApprovalProvider, type DeploymentApprovalIntentBinding } from './app-deployment-approval-intent.js';

const now = Date.parse('2026-11-16T00:00:00Z');
const binding: DeploymentApprovalIntentBinding = {
  memberId: 'member-1', appSlug: 'app-one', runId: 'run-1',
  deploymentId: 'dyn-6e0ae494-891b-410a-a067-2bfc9127f778',
  sourceHead: 'a'.repeat(40), artifactDigest: 'b'.repeat(64),
  relayKeyId: '6e0ae494-891b-410a-a067-2bfc9127f778',
  expiresAt: new Date(now + 60 * 60_000).toISOString(),
};
const approvalId = 'bd7133d2-ea11-4b2d-a14c-b96795f43210';
const pending = { approvalId,
  approvalUrl: 'https://api.elanous.ai/v1/members/deployment-approvals/' + approvalId,
  pendingExpiresAt: new Date(now + 5 * 60_000).toISOString() };
const session = { nexusUrl: 'https://api.elanous.ai', appSlug: 'app-one', sessionToken: 'aps_synthetic' };
const json = (status: number, value: object) => Response.json(value, { status });

test('native start and poll pin the server ID and full exact binding without approving', async () => {
  const calls: Array<{ url: string; request: RequestInit }> = [];
  const fetcher = async (url: string | URL | Request, request?: RequestInit) => {
    calls.push({ url: String(url), request: request! });
    if (calls.length === 1) return json(201, pending);
    if (calls.length === 2) return json(202, { status: 'pending', pendingExpiresAt: pending.pendingExpiresAt });
    return json(200, { approvalId, ...binding });
  };
  const provider = createAppDeploymentApprovalProvider({ getSession: () => session,
    fetcher: fetcher as typeof fetch, now: () => now });
  expect(await provider.start(binding)).toEqual(pending);
  expect(await provider.poll(binding, pending)).toEqual({ status: 'pending' });
  expect(await provider.poll(binding, pending)).toEqual({ status: 'approved', expiresAt: binding.expiresAt });
  expect(calls.map(call => call.url)).toEqual([
    'https://api.elanous.ai/v1/members/deployment-approvals/intents',
    'https://api.elanous.ai/v1/members/deployment-approvals/intents/' + approvalId + '/poll',
    'https://api.elanous.ai/v1/members/deployment-approvals/intents/' + approvalId + '/poll',
  ]);
  expect(JSON.parse(calls[0]!.request.body as string)).toEqual({ appSlug: binding.appSlug,
    runId: binding.runId, deploymentId: binding.deploymentId, sourceHead: binding.sourceHead,
    artifactDigest: binding.artifactDigest, relayKeyId: binding.relayKeyId, expiresAt: binding.expiresAt });
  expect(calls.every(call => call.request.method === 'POST'
    && (call.request.headers as Record<string, string>).authorization === 'Bearer aps_synthetic')).toBe(true);
});

test('foreign, expired and malformed server approval replies refuse before grant issue', async () => {
  for (const reply of [
    { approvalId, ...binding, memberId: 'foreign' },
    { approvalId, ...binding, deploymentId: 'dyn-4794bb25-2443-4618-a2fd-84d95cdb1cde' },
    { approvalId, ...binding, relayKeyId: '4794bb25-2443-4618-a2fd-84d95cdb1cde' },
    { approvalId, ...binding, expiresAt: new Date(now - 1).toISOString() },
  ]) {
    const provider = createAppDeploymentApprovalProvider({ getSession: () => session,
      fetcher: (async () => json(200, reply)) as unknown as typeof fetch, now: () => now });
    expect(provider.poll(binding, pending)).rejects.toThrow('DEPLOYMENT_APPROVAL_REFUSED');
  }
  const wrongUrl = { ...pending, approvalUrl: 'https://attacker.example/approve' };
  const provider = createAppDeploymentApprovalProvider({ getSession: () => session,
    fetcher: (async () => json(202, { status: 'pending' })) as unknown as typeof fetch, now: () => now });
  expect(provider.poll(binding, wrongUrl)).rejects.toThrow('DEPLOYMENT_APPROVAL_REFUSED');
  const noNativeSession = createAppDeploymentApprovalProvider({ getSession: () => ({ ...session,
    nexusUrl: 'http://127.0.0.1:3000' }), fetcher: (async () => json(201, pending)) as unknown as typeof fetch,
    now: () => now });
  expect(noNativeSession.start(binding)).rejects.toThrow('DEPLOYMENT_APPROVAL_REFUSED');
});

test('parent cancellation bounds a stalled approval response body', async () => {
  const controller = new AbortController();
  const provider = createAppDeploymentApprovalProvider({ getSession: () => session,
    fetcher: (async () => new Response(new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => {}),
    }), { status: 201 })) as unknown as typeof fetch, now: () => now });
  const timer = setTimeout(() => controller.abort(), 20);
  try { await expect(provider.start(binding, controller.signal)).rejects.toThrow(); }
  finally { clearTimeout(timer); }
});
