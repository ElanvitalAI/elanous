import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeMemberOidcWorld, FAKE_MEMBER_OIDC_REDIRECT_URI } from './fake-member-oidc-world.js';
import { createRelayWebChatLedger, createWebChatHandoffLedger, membersApiWebChatServingGate, routeBareWebChatHostRequest, routeRequest } from '../nexus/api/http-server.js';
import { DaemonSessionHistory } from '../boot/daemon-runtime.js';
import { createDevProxyRuntimeRef } from '../nexus/api/admin-dev-proxy.js';

const API = 'https://members.example.test';
const SITE = 'https://app.example.test';

test('fake signup and reserved handle reach the product webchat handoff only after a verified pin', async () => {
  const previousKey = process.env.ELANOUS_WEBCHAT_HANDOFF_HMAC_KEY;
  const previousSessionRoot = process.env.ELANOUS_SESSION_ROOT;
  const previousFakeLlm = process.env.ELANOUS_TEST_FAKE_LLM;
  const previousFakeResponse = process.env.ELANOUS_TEST_FAKE_LLM_RESPONSE;
  const root = mkdtempSync(join(tmpdir(), 'fake-member-webchat-'));
  process.env.ELANOUS_WEBCHAT_HANDOFF_HMAC_KEY = 'fake-member-webchat-signing-key-at-least-32-bytes';
  process.env.ELANOUS_SESSION_ROOT = root;
  process.env.ELANOUS_TEST_FAKE_LLM = '1';
  process.env.ELANOUS_TEST_FAKE_LLM_RESPONSE = '안녕하세요. 첫 웹채팅 답입니다.';
  const host = {};
  const pins = createRelayWebChatLedger(host);
  pins.setPinQueryChannel(async (handle, memberId) => pins.pinOwners.get(handle) === memberId);
  const handoffs = createWebChatHandoffLedger(host);
  const world = createFakeMemberOidcWorld({
    now: () => Date.parse('2026-11-14T01:00:00.000Z'),
    reservedJoosungGoogleEmailSha256: createHash('sha256').update('member-1@example.test').digest('hex'),
    pinPublicHandle: (handle, memberId) => pins.recordPin(handle, memberId, Promise.resolve()),
    webChatServing: membersApiWebChatServingGate(host, host),
    webChatHandoff: {
      issue: ({ handle, memberId }) => {
        const token = handoffs.issue(memberId, handle);
        return token ? `https://${handle}.elanous.app/app/chat/handoff?handoff-token=${encodeURIComponent(token)}` : undefined;
      },
      revokeDerivedForMember: handoffs.revokeDerivedForMember,
    },
  });
  try {
    world.memberStore.provisionEventCode({ code: 'KAIST-2026', maxUses: 1 });
    const start = await world.membersApi.handle(new Request(`${API}/v1/members`, {
      method: 'POST', headers: { origin: SITE, 'content-type': 'application/json' },
      body: JSON.stringify({ eventCode: 'KAIST-2026', consents: { privacy: 'privacy-v1', terms: 'terms-v1' } }),
    }));
    if (start?.status !== 201) throw new Error(`signup ${start?.status}: ${await start?.text()}`);
    const { authorizationUrl } = await start!.json() as { authorizationUrl: string };
    const stateCookie = start!.headers.get('set-cookie')!.split(';', 1)[0]!;
    const auth = world.googleWorld.authorize(authorizationUrl);
    const callback = await world.membersApi.handle(new Request(
      `${FAKE_MEMBER_OIDC_REDIRECT_URI}?code=${auth.code}&state=${auth.state}`,
      { headers: { cookie: stateCookie } },
    ));
    expect(callback?.status).toBe(303);
    const memberCookie = callback!.headers.getSetCookie().find(value => value.startsWith('__Host-elanous_member_session='))!.split(';', 1)[0]!;
    const profile = await world.membersApi.handle(new Request(`${API}/v1/members`, { headers: { cookie: memberCookie } }));
    const memberId = ((await profile!.json()) as { member: { id: string } }).member.id;
    const claim = await world.membersApi.handle(new Request(`${API}/v1/members/handle`, {
      method: 'PUT', headers: { origin: SITE, cookie: memberCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ handle: 'user' }),
    }));
    expect(claim?.status).toBe(200);
    world.memberStore.createMemberKey(memberId, 'fake-device');
    await Promise.resolve();
    expect(pins.pinOwners.get('user')).toBe(memberId);
    expect(world.memberStore.appSlotForMember(memberId)).not.toBeNull();
    const home = await world.membersApi.handle(new Request(`${API}/v1/members/home`, { headers: { cookie: memberCookie } }));
    const html = await home!.text();
    expect(html).toContain('data-member-webchat-entry href="https://members.example.test/v1/members/webchat-handoff"');
    const handoff = await world.membersApi.handle(new Request(`${API}/v1/members/webchat-handoff`, { headers: { cookie: memberCookie } }));
    expect(handoff?.status).toBe(303);
    const location = handoff!.headers.get('location')!;
    expect(location).toMatch(/^https:\/\/user\.elanous\.app\/app\/chat\/handoff\?handoff-token=wch_/);
    const bareOpts = { pinnedHandles: pins.handles, pinOwners: pins.pinOwners, webChatHandoff: handoffs };
    const exchange = await routeBareWebChatHostRequest(new Request(location), bareOpts);
    expect(exchange?.status).toBe(303);
    const derivedCookie = exchange!.headers.getSetCookie().find(cookie => cookie.startsWith('__Secure-elanous_webchat_session='))!.split(';', 1)[0]!;
    expect(derivedCookie).toMatch(/^__Secure-elanous_webchat_session=wcs_/);
    const prompt = await routeBareWebChatHostRequest(new Request('https://user.elanous.app/v1/prompt/stream', {
      method: 'POST', headers: { cookie: derivedCookie, origin: 'https://user.elanous.app', 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'a1a1a1a1-1111-4111-8111-111111111111', userText: '안녕' }),
    }), { ...bareOpts, forwardApi: async request =>
      (await routeRequest(request, { metaApi: { history: new DaemonSessionHistory({ diskDir: root }), bearerToken: 'fake-daemon-owner', toolCwd: process.cwd() } } as never,
        {} as never, null, createDevProxyRuntimeRef())) ?? new Response(null, { status: 404 }) });
    expect(prompt?.status).toBe(200);
    expect(await prompt!.text()).toContain('안녕하세요. 첫 웹채팅 답입니다.');
  } finally {
    world.close();
    rmSync(root, { recursive: true, force: true });
    if (previousKey === undefined) delete process.env.ELANOUS_WEBCHAT_HANDOFF_HMAC_KEY;
    else process.env.ELANOUS_WEBCHAT_HANDOFF_HMAC_KEY = previousKey;
    if (previousSessionRoot === undefined) delete process.env.ELANOUS_SESSION_ROOT;
    else process.env.ELANOUS_SESSION_ROOT = previousSessionRoot;
    if (previousFakeLlm === undefined) delete process.env.ELANOUS_TEST_FAKE_LLM;
    else process.env.ELANOUS_TEST_FAKE_LLM = previousFakeLlm;
    if (previousFakeResponse === undefined) delete process.env.ELANOUS_TEST_FAKE_LLM_RESPONSE;
    else process.env.ELANOUS_TEST_FAKE_LLM_RESPONSE = previousFakeResponse;
  }
});
