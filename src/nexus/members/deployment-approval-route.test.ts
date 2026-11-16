import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeploymentApprovalRoute } from './deployment-approval-route.js';
import { openDeploymentApprovalStore } from './deployment-approval-store.js';
import { createMembersApi } from './members-api.js';
import { createMemberStore } from './member-store.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const origin = 'https://api.elanous.ai';
const base = origin + '/v1/members/deployment-approvals';
const input = { appSlug: 'demo-app', runId: 'run-1',
  deploymentId: 'dyn-11111111-1111-4111-8111-111111111111', sourceHead: 'a'.repeat(40),
  artifactDigest: 'b'.repeat(64), relayKeyId: '22222222-2222-4222-8222-222222222222', expiresAt: '2026-11-16T02:00:00Z' };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'deployment-approval-route-'));
  dirs.push(dir);
  let clock = Date.parse('2026-11-16T00:00:00Z');
  let keyActive = true;
  const store = openDeploymentApprovalStore(join(dir, 'server.sqlite'), () => clock);
  const options = { store, officialOrigin: origin,
    resolveOwner: async (slug: string, token: string) => slug === 'demo-app' && token === 'aps_owner_credential'
      ? { memberId: 'owner-a' } : null,
    resolveBrowserOwner: async (request: Request, slug: string) => slug === 'demo-app'
      && request.headers.get('cookie') === 'member_session=verified-owner'
      ? { memberId: 'owner-a' } : null,
    activeBinding: async (binding: { relayKeyId: string }) => keyActive && binding.relayKeyId === input.relayKeyId };
  const route = createDeploymentApprovalRoute(options);
  const native = (url: string, body?: unknown) => route.handle(new Request(url, { method: 'POST',
    headers: { authorization: 'Bearer aps_owner_credential', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) }));
  return { store, route, options, native, advance(ms: number) { clock += ms; },
    revokeKey() { keyActive = false; } };
}

test('real intent, browser confirmation and native poll route consume one browser nonce', async () => {
  const f = fixture();
  const proposed = (await f.native(base + '/intents', input))!;
  expect(proposed.status).toBe(201);
  const { approvalId, approvalUrl, pendingExpiresAt } = await proposed.json();
  expect(approvalUrl).toBe(base + '/' + approvalId);
  expect(pendingExpiresAt).toBe('2026-11-16T00:05:00.000Z');
  const pollUrl = base + '/intents/' + approvalId + '/poll';
  expect((await f.native(pollUrl))?.status).toBe(202);
  expect((await f.route.handle(new Request(approvalUrl, { headers: { cookie: 'member_session=foreign' } })))?.status).toBe(404);
  const page = (await f.route.handle(new Request(approvalUrl, { headers: { cookie: 'member_session=verified-owner' } })))!;
  expect(page.status).toBe(200);
  expect(page.headers.get('referrer-policy')).toBe('same-origin');
  const nonce = /name="nonce" value="([A-Za-z0-9_-]{43})"/.exec(await page.text())?.[1];
  expect(nonce).toBeTruthy();
  const approvalPost = (requestOrigin: string) => f.route.handle(new Request(approvalUrl + '/approve', {
    method: 'POST', headers: { cookie: 'member_session=verified-owner', origin: requestOrigin,
      'content-type': 'application/x-www-form-urlencoded' }, body: 'nonce=' + nonce }));
  expect((await approvalPost('https://evil.example'))?.status).toBe(403);
  expect((await f.native(pollUrl))?.status).toBe(202);
  expect((await approvalPost(origin))?.status).toBe(200);
  const approved = (await f.native(pollUrl))!;
  expect(approved.status).toBe(200);
  expect(await approved.json()).toMatchObject({ approvalId, memberId: 'owner-a', ...input,
    expiresAt: '2026-11-16T02:00:00.000Z' });
  expect((await approvalPost(origin))?.status).toBe(410);
  f.store.close();
});

test('pending approval expires at five minutes and cannot be approved after the boundary', async () => {
  const f = fixture();
  const { approvalUrl, approvalId } = await (await f.native(base + '/intents', input))!.json();
  const page = (await f.route.handle(new Request(approvalUrl, { headers: { cookie: 'member_session=verified-owner' } })))!;
  const nonce = /name="nonce" value="([A-Za-z0-9_-]{43})"/.exec(await page.text())?.[1];
  f.advance(5 * 60_000);
  expect((await f.native(base + '/intents/' + approvalId + '/poll'))?.status).toBe(410);
  expect((await f.route.handle(new Request(approvalUrl + '/approve', { method: 'POST', headers: {
    cookie: 'member_session=verified-owner', origin, 'content-type': 'application/x-www-form-urlencoded' },
  body: 'nonce=' + nonce })))?.status).toBe(410);
  f.store.close();
});

test('native poll expires at the requested expiry even before the pending five-minute limit', async () => {
  const f = fixture();
  const short = { ...input, expiresAt: '2026-11-16T00:02:00.000Z' };
  const proposed = await f.native(base + '/intents', short);
  expect(proposed?.status).toBe(201);
  const { approvalId } = await proposed!.json();
  const poll = () => f.native(base + '/intents/' + approvalId + '/poll');
  f.advance(2 * 60_000 - 1);
  expect((await poll())?.status).toBe(202);
  f.advance(1);
  expect((await poll())?.status).toBe(410);
  f.store.close();
});

test('poll denies an approval after its relay key is revoked', async () => {
  const f = fixture();
  const { approvalId } = await (await f.native(base + '/intents', input))!.json();
  f.revokeKey();
  expect((await f.native(base + '/intents/' + approvalId + '/poll'))?.status).toBe(403);
  f.store.close();
});

test('intent body cap rejects oversized requests before creating approval state', async () => {
  const f = fixture();
  const oversized = await f.native(base + '/intents', { ...input, extra: 'x'.repeat(5000) });
  expect(oversized?.status).toBe(413);
  f.store.close();
});

test('members API dispatches approval routes and leaves absent authority unavailable', async () => {
  const f = fixture();
  const members = createMemberStore({ path: ':memory:' });
  const baseOptions = { store: members,
    google: { redirectUri: origin + '/v1/members/oauth/google/callback' } as never,
    successRedirectUri: 'https://app.elanous.ai/member' };
  try {
    const unavailable = createMembersApi(baseOptions);
    expect((await unavailable.handle(new Request(base + '/intents', { method: 'POST' })))?.status).toBe(503);
    const api = createMembersApi({ ...baseOptions, deploymentApprovals: f.options });
    const issued = await api.handle(new Request(base + '/intents', { method: 'POST', headers: {
      authorization: 'Bearer aps_owner_credential', 'content-type': 'application/json' },
    body: JSON.stringify(input) }));
    expect(issued?.status).toBe(201);
    const body = await issued!.json();
    expect((await api.handle(new Request(base + '/intents/' + body.approvalId + '/poll', {
      method: 'POST', headers: { authorization: 'Bearer aps_owner_credential' } })))?.status).toBe(202);
  } finally { members.close(); f.store.close(); }
});
