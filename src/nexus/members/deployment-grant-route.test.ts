import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeploymentGrantRoute } from './deployment-grant-route.js';
import { openDeploymentGrantStore } from './deployment-grant-store.js';
import { openDeploymentApprovalStore } from './deployment-approval-store.js';
import { createMemberStore } from './member-store.js';
import { createMembersApi } from './members-api.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const endpoint = 'https://api.elanous.ai/v1/members/deployment-grants';
const issueInput = { appSlug: 'a'.repeat(24), runId: '11111111-1111-4111-8111-111111111111',
  deploymentId: 'dyn-11111111-1111-4111-8111-111111111111',
  sourceHead: 'b'.repeat(40), artifactDigest: 'c'.repeat(64), relayKeyId: '22222222-2222-4222-8222-222222222222',
  expiresAt: '2026-11-16T02:00:00Z' };

function fixture(now: () => number = () => Date.parse('2026-11-16T00:00:00Z')) {
  const dir = mkdtempSync(join(tmpdir(), 'deployment-grant-route-'));
  dirs.push(dir);
  const path = join(dir, 'grants.sqlite');
  const store = openDeploymentGrantStore(path, now);
  const approvals = openDeploymentApprovalStore(path, now);
  let memberActive = true;
  let keyActive = true;
  function newApproval(overrides: { appSlug?: string; runId?: string } = {}) {
    const binding = { memberId: 'member-a', appSlug: overrides.appSlug ?? issueInput.appSlug,
      runId: overrides.runId ?? issueInput.runId,
      deploymentId: issueInput.deploymentId, sourceHead: issueInput.sourceHead,
      artifactDigest: issueInput.artifactDigest, relayKeyId: issueInput.relayKeyId };
    const proposed = approvals.propose(binding, issueInput.expiresAt)!;
    const prepared = approvals.prepareConfirmation(proposed.approvalId, 'member-a')!;
    expect(approvals.approve(proposed.approvalId, 'member-a', prepared.nonce)).not.toBeNull();
    return proposed.approvalId;
  }
  const input = { ...issueInput, approvalId: newApproval() };
  const route = createDeploymentGrantRoute({ store,
    resolveOwner: async (appSlug, token) => appSlug === issueInput.appSlug && token === 'aps_owner_credential'
      ? { memberId: 'member-a' } : null,
    activeBinding: async binding => memberActive && keyActive && binding.relayKeyId === issueInput.relayKeyId });
  function issue(body: unknown = input, token = 'aps_owner_credential') {
    return route.handle(new Request(endpoint, { method: 'POST', headers: {
      authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  }
  return { store, approvals, route, input, issue, newApproval,
    setMemberActive(value: boolean) { memberActive = value; },
    setKeyActive(value: boolean) { keyActive = value; } };
}

test('issue, duplicate, introspect and owner revoke enforce one-time secret and exact binding', async () => {
  const f = fixture();
  const issued = (await f.issue())!;
  expect(issued.status).toBe(201);
  expect(issued.headers.get('cache-control')).toBe('no-store');
  const first = await issued.json();
  expect(first).toMatchObject({ memberId: 'member-a', appSlug: issueInput.appSlug, runId: issueInput.runId,
    deploymentId: issueInput.deploymentId,
    sourceHead: issueInput.sourceHead, artifactDigest: issueInput.artifactDigest,
    relayKeyId: issueInput.relayKeyId, expiresAt: '2026-11-16T02:00:00.000Z', grantVersion: 1,
    approvalId: f.input.approvalId });
  const retry = (await f.issue())!;
  expect(retry.status).toBe(409);
  expect(await retry.json()).toEqual({ error: 'credential-already-issued', grantId: first.grantId, grantVersion: 1 });
  const inspect = () => f.route.handle(new Request(endpoint + '/introspect', {
    method: 'POST', headers: { authorization: 'Bearer ' + first.credential } }));
  const introspected = (await inspect())!;
  expect(introspected.status).toBe(200);
  expect(await introspected.json()).toEqual({ grantId: first.grantId, approvalId: f.input.approvalId, memberId: 'member-a',
    appSlug: issueInput.appSlug, runId: issueInput.runId, deploymentId: issueInput.deploymentId,
    sourceHead: issueInput.sourceHead, artifactDigest: issueInput.artifactDigest,
    relayKeyId: issueInput.relayKeyId, expiresAt: first.expiresAt, grantVersion: 1 });
  f.setKeyActive(false);
  expect((await inspect())!.status).toBe(401);
  f.setKeyActive(true);
  f.setMemberActive(false);
  expect((await inspect())!.status).toBe(401);
  f.setMemberActive(true);
  const revokeUrl = endpoint + '/' + first.grantId;
  const foreign = await f.route.handle(new Request(revokeUrl, { method: 'DELETE', headers: { authorization: 'Bearer aps_foreign' } }));
  expect(foreign?.status).toBe(404);
  const revoke = () => f.route.handle(new Request(revokeUrl, { method: 'DELETE', headers: { authorization: 'Bearer aps_owner_credential' } }));
  expect((await revoke())!.status).toBe(200);
  expect((await revoke())!.status).toBe(200);
  expect((await inspect())!.status).toBe(401);
  expect((await f.issue())!.status).toBe(403);
  expect((await f.issue({ ...f.input, approvalId: f.newApproval() }))!.status).toBe(201);
  f.approvals.close(); f.store.close();
});

for (const transition of ['revoke', 'expire'] as const) {
  test(`introspection refuses a grant that ${transition}s while active binding is pending`, async () => {
    let nowMs = Date.parse('2026-11-16T00:00:00Z');
    const f = fixture(() => nowMs);
    const issued = (await (await f.issue())!.json()) as { grantId: string; credential: string };
    let entered!: () => void;
    let resume!: () => void;
    const checkEntered = new Promise<void>(resolve => { entered = resolve; });
    const pendingCheck = new Promise<void>(resolve => { resume = resolve; });
    const introspection = createDeploymentGrantRoute({ store: f.store,
      resolveOwner: async () => ({ memberId: 'member-a' }),
      activeBinding: async () => { entered(); await pendingCheck; return true; },
    });
    const result = introspection.handle(new Request(endpoint + '/introspect', {
      method: 'POST', headers: { authorization: 'Bearer ' + issued.credential } }));
    await checkEntered;
    if (transition === 'revoke') {
      expect(f.store.revoke(issued.grantId, 'member-a', issueInput.appSlug)).toBe(true);
    } else {
      nowMs = Date.parse('2026-11-16T02:00:00Z');
    }
    resume();
    expect((await result)?.status).toBe(401);
    f.approvals.close(); f.store.close();
  });
}

test('missing authority, foreign session, invalid body and unavailable live check fail closed', async () => {
  const f = fixture();
  expect((await createDeploymentGrantRoute({ store: f.store }).handle(new Request(endpoint, { method: 'POST' })))?.status).toBe(503);
  expect((await f.issue(f.input, 'aps_foreign'))!.status).toBe(401);
  expect((await f.issue({ ...f.input, memberId: 'caller-selected-owner' }))!.status).toBe(400);
  expect((await f.issue({ ...f.input, sourceHead: 'invalid' }))!.status).toBe(400);
  expect((await f.issue({ ...f.input, approvalId: '00000000-0000-4000-8000-000000000000' }))!.status).toBe(403);
  f.approvals.close(); f.store.close();
});

test('grant issue cancels an oversized streamed body and enforces owner lookup deadline before issuing', async () => {
  const f = fixture();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(5_000)); },
    cancel() { cancelled = true; },
  });
  const tooLarge = await f.route.handle(new Request(endpoint, { method: 'POST', headers: {
    authorization: 'Bearer aps_owner_credential', 'content-type': 'application/json' },
  body: stream as BodyInit }));
  expect(tooLarge?.status).toBe(413);
  expect(cancelled).toBe(true);

  let time = Date.now();
  const nowSpy = spyOn(Date, 'now').mockImplementation(() => time);
  try {
    const route = createDeploymentGrantRoute({ store: f.store,
      resolveOwner: async () => { time += 5_000; return { memberId: 'member-a' }; },
      activeBinding: async () => true });
    const response = await route.handle(new Request(endpoint, { method: 'POST', headers: {
      authorization: 'Bearer aps_owner_credential', 'content-type': 'application/json' },
    body: JSON.stringify(f.input) }));
    expect(response?.status).toBe(504);
    expect(f.approvals.lookup(f.input.approvalId)?.consumedGrantId).toBeNull();
  } finally { nowSpy.mockRestore(); f.approvals.close(); f.store.close(); }
});

test('publisher app slug and non-UUID run grammar are accepted without caller-selected owner', async () => {
  const f = fixture();
  const route = createDeploymentGrantRoute({ store: f.store,
    resolveOwner: async (appSlug, token) => appSlug === 'demo-app' && token === 'aps_owner_credential'
      ? { memberId: 'member-a' } : null,
    activeBinding: async () => true });
  const result = await route.handle(new Request(endpoint, { method: 'POST', headers: {
    authorization: 'Bearer aps_owner_credential', 'content-type': 'application/json' },
  body: JSON.stringify({ ...f.input, appSlug: 'demo-app', runId: 'run-1',
    approvalId: f.newApproval({ appSlug: 'demo-app', runId: 'run-1' }) }) }));
  expect(result?.status).toBe(201);
  f.approvals.close(); f.store.close();
});

test('members API dispatches grant endpoints to the injected authority and fails closed without one', async () => {
  const f = fixture();
  const members = createMemberStore({ path: ':memory:' });
  const base = { store: members,
    google: { redirectUri: 'https://api.elanous.ai/v1/members/oauth/google/callback' } as never,
    successRedirectUri: 'https://app.elanous.ai/member' };
  try {
    const unavailable = createMembersApi(base);
    expect((await unavailable.handle(new Request(endpoint, { method: 'POST' })))?.status).toBe(503);
    const api = createMembersApi({ ...base, deploymentGrants: { store: f.store,
      resolveOwner: async (_slug, token) => token === 'aps_owner_credential' ? { memberId: 'member-a' } : null,
      activeBinding: async () => true } });
    const issued = await api.handle(new Request(endpoint, { method: 'POST', headers: {
      authorization: 'Bearer aps_owner_credential', 'content-type': 'application/json' },
    body: JSON.stringify(f.input) }));
    expect(issued?.status).toBe(201);
    const body = await issued!.json();
    expect(body.memberId).toBe('member-a');
    expect((await api.handle(new Request(endpoint + '/introspect', { method: 'POST', headers: {
      authorization: 'Bearer ' + body.credential } })))?.status).toBe(200);
    expect((await api.handle(new Request(endpoint + '/' + body.grantId, { method: 'DELETE', headers: {
      authorization: 'Bearer aps_owner_credential' } })))?.status).toBe(200);
  } finally { members.close(); f.approvals.close(); f.store.close(); }
});
