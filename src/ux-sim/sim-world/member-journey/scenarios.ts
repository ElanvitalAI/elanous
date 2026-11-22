import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createFakeMemberOidcWorld, FAKE_MEMBER_OIDC_REDIRECT_URI } from '../../fake-member-oidc-world.js';
import { createRelayWebChatLedger, createWebChatHandoffLedger, membersApiWebChatServingGate,
  restoreWebChatHandlePins, routeBareWebChatHostRequest, routeRequest } from '../../../nexus/api/http-server.js';
import { DaemonSessionHistory } from '../../../boot/daemon-runtime.js';
import { createDevProxyRuntimeRef } from '../../../nexus/api/admin-dev-proxy.js';
import { setUserConfigOverlay } from '../../../user-config.js';
import { DaemonClient } from '../../../../apps/pwa/src/lib/daemon-client.js';
import { runChatTurnStreaming } from '../../../../apps/pwa/src/lib/chat-runtime.js';
import type { SimWorldDeviceDef, SimWorldScenario } from '../types.js';

const API = 'https://members.example.test';
const SITE = 'https://app.example.test';
const HANDLE = 'user';
const FIRST_REPLY = '안녕하세요. 첫 웹채팅 답입니다.';
const HMAC_KEY = 'fake-member-journey-hmac-key-at-least-32-bytes';
const SESSION_ID = 'a1a1a1a1-1111-4111-8111-111111111111';
type World = ReturnType<typeof createFakeMemberOidcWorld>;

function hostLedger() {
  const host = {};
  const pins = createRelayWebChatLedger(host);
  pins.setPinQueryChannel(async (handle, memberId) => pins.pinOwners.get(handle) === memberId);
  return { host, pins, handoffs: createWebChatHandoffLedger(host) };
}

async function makeMember(serving: boolean) {
  let current = hostLedger();
  let servingGateCalls = 0;
  const world = createFakeMemberOidcWorld({
    now: () => Date.parse('2026-11-14T01:00:00.000Z'),
    reservedJoosungGoogleEmailSha256: createHash('sha256').update('member-1@example.test').digest('hex'),
    pinPublicHandle: (handle, memberId) => {
      if (serving) current.pins.recordPin(handle, memberId, Promise.resolve());
    },
    webChatServing: input => {
      servingGateCalls += 1;
      return membersApiWebChatServingGate(current.host, current.host)(input);
    },
    webChatHandoff: {
      issue: ({ handle, memberId }) => {
        const token = current.handoffs.issue(memberId, handle);
        return token ? `https://${handle}.elanous.app/app/chat/handoff?handoff-token=${encodeURIComponent(token)}` : undefined;
      },
      revokeDerivedForMember: memberId => current.handoffs.revokeDerivedForMember(memberId),
    },
  });
  try {
    world.memberStore.provisionEventCode({ code: 'KAIST-2026', maxUses: 1 });
    const start = await world.membersApi.handle(new Request(`${API}/v1/members`, {
      method: 'POST', headers: { origin: SITE, 'content-type': 'application/json' },
      body: JSON.stringify({ eventCode: 'KAIST-2026', consents: { privacy: 'privacy-v1', terms: 'terms-v1' } }),
    }));
    if (start?.status !== 201) throw new Error(`signup status ${start?.status}`);
    const { authorizationUrl } = await start.json() as { authorizationUrl: string };
    const stateCookie = start.headers.get('set-cookie')!.split(';', 1)[0]!;
    const auth = world.googleWorld.authorize(authorizationUrl);
    const callback = await world.membersApi.handle(new Request(
      `${FAKE_MEMBER_OIDC_REDIRECT_URI}?code=${auth.code}&state=${auth.state}`,
      { headers: { cookie: stateCookie } },
    ));
    if (callback?.status !== 303) throw new Error(`callback status ${callback?.status}`);
    const memberCookie = callback.headers.getSetCookie().find(value => value.startsWith('__Host-elanous_member_session='))!.split(';', 1)[0]!;
    const profile = await world.membersApi.handle(new Request(`${API}/v1/members`, { headers: { cookie: memberCookie } }));
    const memberId = ((await profile!.json()) as { member: { id: string } }).member.id;
    const claim = await world.membersApi.handle(new Request(`${API}/v1/members/handle`, {
      method: 'PUT', headers: { origin: SITE, cookie: memberCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ handle: HANDLE }),
    }));
    if (claim?.status !== 200 || world.memberStore.handleForMember(memberId) !== HANDLE)
      throw new Error(`handle claim status ${claim?.status}`);
    world.memberStore.createMemberKey(memberId, 'fake-device');
    await Promise.resolve();
    return {
      world, memberId, memberCookie,
      current: () => current,
      servingChecks: () => servingGateCalls,
      restart: () => {
        current.pins.onConnectionClosed();
        current = hostLedger();
        // The fake world owns this in-memory member store across the injected Nexus restart.
        // The restore helper normally owns and closes its store handle, so pass a borrowed view.
        restoreWebChatHandlePins(current.pins, async () => undefined,
          { handleClaims: () => world.memberStore.handleClaims(), close: () => {} });
      },
      home: async () => (await world.membersApi.handle(new Request(`${API}/v1/members/home`, { headers: { cookie: memberCookie } })))!.text(),
      handoff: async () => world.membersApi.handle(new Request(`${API}/v1/members/webchat-handoff`, { headers: { cookie: memberCookie } })),
    };
  } catch (error) {
    world.close();
    throw error;
  }
}

type MemberFixture = Awaited<ReturnType<typeof makeMember>>;
async function exchange(member: MemberFixture, location: string) {
  const active = member.current();
  return routeBareWebChatHostRequest(new Request(location), {
    pinnedHandles: active.pins.handles, pinOwners: active.pins.pinOwners, webChatHandoff: active.handoffs,
  });
}

async function prompt(member: MemberFixture, cookie: string, universeRoot: string, userText: string) {
  const active = member.current();
  return routeBareWebChatHostRequest(new Request(`https://${HANDLE}.elanous.app/v1/prompt/stream`, {
    method: 'POST', headers: { cookie, origin: `https://${HANDLE}.elanous.app`, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: SESSION_ID, userText }),
  }), {
    pinnedHandles: active.pins.handles, pinOwners: active.pins.pinOwners, webChatHandoff: active.handoffs,
    forwardApi: async request => (await routeRequest(request,
      { metaApi: { history: new DaemonSessionHistory({ diskDir: join(universeRoot, 'sessions') }),
        bearerToken: 'fake-daemon-owner', toolCwd: process.cwd() } } as never,
      {} as never, null, createDevProxyRuntimeRef())) ?? new Response(null, { status: 404 }),
  });
}

export const simWorldDevices: readonly SimWorldDeviceDef<{ makeMember: typeof makeMember }>[] = [{
  id: 'MEMBER-JOURNEY-FAKE-OIDC-WEBCHAT',
  title: 'isolated fake Google and LLM edges with real member, pin and bare webchat handlers',
  create: () => ({ makeMember }),
}];

export const simWorldScenarios: readonly SimWorldScenario[] = [{
  id: 'HANDLE-WEBCHAT-FIRST-TURN',
  title: 'signup to reserved fake handle, serving pin, HMAC handoff and first model reply with four faults',
  devices: ['MEMBER-JOURNEY-FAKE-OIDC-WEBCHAT'],
  async run(ctx) {
    const { makeMember: make } = ctx.device<{ makeMember: typeof makeMember }>('MEMBER-JOURNEY-FAKE-OIDC-WEBCHAT');
    const saved = new Map(['ELANOUS_WEBCHAT_HANDOFF_HMAC_KEY', 'ELANOUS_TEST_FAKE_LLM', 'ELANOUS_LLM_MODE',
      'ELANOUS_TEST_FAKE_LLM_DELAY_MS',
      'ELANOUS_TEST_FAKE_LLM_RESPONSE', 'ELANOUS_SESSION_ROOT'].map(key => [key, process.env[key]]));
    process.env.ELANOUS_WEBCHAT_HANDOFF_HMAC_KEY = HMAC_KEY;
    process.env.ELANOUS_TEST_FAKE_LLM = '1';
    process.env.ELANOUS_LLM_MODE = 'fake';
    process.env.ELANOUS_TEST_FAKE_LLM_RESPONSE = FIRST_REPLY;
    process.env.ELANOUS_SESSION_ROOT = join(ctx.universeRoot, 'sessions');
    let member: MemberFixture | undefined;
    let noServing: MemberFixture | undefined;
    const fail = (diff: string) => ({ ok: false as const, reason: 'member webchat journey mismatch', diff });
    try {
      member = await make(true);
      const home = await member.home();
      if (!home.includes('data-member-webchat-entry href="https://members.example.test/v1/members/webchat-handoff"'))
        return fail('serving member home lacks the webchat entry');
      const handoff = await member.handoff();
      const location = handoff?.headers.get('location') ?? '';
      if (handoff?.status !== 303 || !/^https:\/\/user\.elanous\.app\/app\/chat\/handoff\?handoff-token=wch_/.test(location))
        return fail(`member handoff status ${handoff?.status}`);
      const bare = await exchange(member, location);
      const cookie = bare?.headers.getSetCookie().find(value => value.startsWith('__Secure-elanous_webchat_session='))?.split(';', 1)[0] ?? '';
      if (bare?.status !== 303 || !cookie.startsWith('__Secure-elanous_webchat_session=wcs_'))
        return fail(`bare HMAC exchange status ${bare?.status}`);
      const first = await prompt(member, cookie, ctx.universeRoot, '안녕');
      const firstText = await first?.text() ?? '';
      if (first?.status !== 200 || !firstText.includes(FIRST_REPLY)) return fail(`first prompt status ${first?.status} or reply missing: ${firstText.replace(/\s+/g, ' ').slice(-600)}`);
      ctx.recorder.event('member-journey:first-turn', { signup: 201, handle: HANDLE, homeEntry: true, handoff: 303,
        bareExchange: 303, derivedCookie: cookie.startsWith('__Secure-elanous_webchat_session=wcs_'), prompt: 200, fakeAnswer: true });

      const beforeRestart = await member.handoff();
      const pendingLocation = beforeRestart?.headers.get('location') ?? '';
      member.restart();
      await Bun.sleep(0);
      const resumedHome = await member.home();
      const child = Bun.spawn([process.execPath, join(import.meta.dir, 'restart-child.ts')], {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test', ELANOUS_SIM_UNIVERSE: '1',
          ELANOUS_WEBCHAT_HANDOFF_HMAC_KEY: HMAC_KEY, MEMBER_JOURNEY_HANDOFF_URL: pendingLocation,
          MEMBER_JOURNEY_MEMBER_ID: member.memberId },
        stdout: 'pipe', stderr: 'pipe',
      });
      const [childExit, childOut, childErr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      let restarted: { status?: number; derivedCookie?: boolean } = {};
      try { restarted = JSON.parse(childOut) as typeof restarted; } catch { /* explicit failure below */ }
      if (!resumedHome.includes('data-member-webchat-entry') || childExit !== 0
        || restarted.status !== 303 || restarted.derivedCookie !== true)
        return fail(`restart handoff not resumed: child ${childExit}, status ${restarted.status}, stderr ${childErr.slice(0, 120)}`);
      ctx.recorder.event('member-journey:restart', { homeEntry: true, separateProcessHmacExchange: 303 });

      const afterRestart = await member.handoff();
      const resumed = await exchange(member, afterRestart?.headers.get('location') ?? '');
      const resumedCookie = resumed?.headers.getSetCookie().find(value => value.startsWith('__Secure-elanous_webchat_session='))?.split(';', 1)[0] ?? '';
      process.env.ELANOUS_TEST_FAKE_LLM_DELAY_MS = '500';
      const previousOverlay = setUserConfigOverlay(config => ({ ...config, llm: { ...config.llm, streamIdleTimeoutMs: 20 } }));
      const originalFetch = globalThis.fetch;
      let clientError = '';
      let visibleFailure = '';
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (!url.startsWith(`https://${HANDLE}.elanous.app/v1/prompt/stream`)) return originalFetch(input, init);
        const headers = new Headers(init?.headers);
        headers.set('cookie', resumedCookie);
        headers.set('origin', `https://${HANDLE}.elanous.app`);
        const request = new Request(url, { ...init, headers });
        return await routeBareWebChatHostRequest(request, {
          pinnedHandles: member!.current().pins.handles, pinOwners: member!.current().pins.pinOwners,
          webChatHandoff: member!.current().handoffs,
          forwardApi: async apiRequest => (await routeRequest(apiRequest,
            { metaApi: { history: new DaemonSessionHistory({ diskDir: join(ctx.universeRoot, 'sessions') }),
              bearerToken: 'fake-daemon-owner', toolCwd: process.cwd() } } as never,
            {} as never, null, createDevProxyRuntimeRef())) ?? new Response(null, { status: 404 }),
        }) ?? new Response(null, { status: 404 });
      }) as typeof fetch;
      try {
        await runChatTurnStreaming('무응답 공급자 주입', {
          client: new DaemonClient({ baseUrl: `https://${HANDLE}.elanous.app`, token: '', provider: '' }),
          sessionId: SESSION_ID, provider: '', setSessionId: () => {},
        }, { onError: info => { clientError = String(info.error ?? ''); } });
      } catch (error) {
        visibleFailure = error instanceof Error ? error.message : String(error);
      } finally {
        globalThis.fetch = originalFetch;
        setUserConfigOverlay(previousOverlay);
        delete process.env.ELANOUS_TEST_FAKE_LLM_DELAY_MS;
      }
      if (clientError !== 'turn_failed' || !visibleFailure.includes('turn_failed'))
        return fail(`unresponsive fake LLM not delivered to PWA error path: ${clientError}/${visibleFailure.slice(0, 120)}`);
      ctx.recorder.event('member-journey:provider-unresponsive', { clientError, visibleFailure: true, infiniteWait: false });

      const simultaneous = await member.handoff();
      const sameLocation = simultaneous?.headers.get('location') ?? '';
      const beforeConcurrentSessions = member.current().handoffs.stats().derivedSessions;
      const raced = await Promise.all([exchange(member, sameLocation), exchange(member, sameLocation)]);
      const statuses = raced.map(response => response?.status).sort();
      const sessions = raced.flatMap(response => response?.headers.getSetCookie() ?? [])
        .filter(value => value.startsWith('__Secure-elanous_webchat_session=') && value.includes('wcs_'));
      const sessionTokens = new Set(sessions.map(value => /__Secure-elanous_webchat_session=(wcs_[^;]+)/.exec(value)?.[1]));
      const addedSessions = member.current().handoffs.stats().derivedSessions - beforeConcurrentSessions;
      const rejected = await raced.find(response => response?.status === 401)?.json() as { error?: string } | undefined;
      if (JSON.stringify(statuses) !== JSON.stringify([303, 401]) || sessions.length !== 4
        || sessionTokens.size !== 1 || addedSessions !== 1 || rejected?.error !== 'webchat-handoff-unknown')
        return fail(`concurrent same-token exchange statuses ${JSON.stringify(statuses)}, cookies ${sessions.length}, new sessions ${addedSessions}`);
      ctx.recorder.event('member-journey:concurrent-handoff', { statuses, sameHandoffToken: true,
        successfulExchangeCount: 1, newDerivedSessions: 1 });

      const independent = await Promise.all([member.handoff(), member.handoff()]);
      const independentLocations = independent.map(response => response?.headers.get('location') ?? '');
      if (independent.some(response => response?.status !== 303) || independentLocations[0] === independentLocations[1])
        return fail('independent handoff tokens were not both issued distinctly');
      const independentExchanges = await Promise.all(independentLocations.map(location => exchange(member!, location)));
      const independentCookies = independentExchanges.map(response => response?.headers.getSetCookie()
        .find(value => value.startsWith('__Secure-elanous_webchat_session='))?.split(';', 1)[0] ?? '');
      const independentTokens = independentCookies.map(value => /__Secure-elanous_webchat_session=(wcs_[^;]+)/.exec(value)?.[1]);
      if (independentExchanges.some(response => response?.status !== 303)
        || independentTokens.some(token => !token) || independentTokens[0] === independentTokens[1])
        return fail('independent handoffs did not retain distinct derived bearers');
      const independentPrompts: Array<Response | null | undefined> = [];
      const independentAnswers: Array<string | undefined> = [];
      for (const value of independentCookies) {
        const response = await prompt(member, value, ctx.universeRoot, '독립 기기');
        independentPrompts.push(response);
        independentAnswers.push(await response?.text());
      }
      if (independentPrompts.some(response => response?.status !== 200)
        || independentAnswers.some(answer => !answer?.includes(FIRST_REPLY)))
        return fail(`independent derived bearer could not reach the product prompt route: statuses ${independentPrompts.map(response => response?.status)}, tails ${independentAnswers.map(answer => answer?.replace(/\s+/g, ' ').slice(-160))}`);
      ctx.recorder.event('member-journey:independent-handoffs', { handoffs: 2, distinctBearers: true, usablePrompts: 2 });

      noServing = await make(false);
      const soon = await noServing.home();
      const absent = await routeBareWebChatHostRequest(new Request(`https://${HANDLE}.elanous.app/app/chat/`), {
        pinnedHandles: noServing.current().pins.handles, pinOwners: noServing.current().pins.pinOwners,
        webChatHandoff: noServing.current().handoffs,
      });
      if (noServing.servingChecks() < 1 || !soon.includes('data-member-webchat-soon')
        || soon.includes('data-member-webchat-entry') || absent?.status !== 404)
        return fail(`serving absent did not keep soon state through the product gate: checks ${noServing.servingChecks()}, bare ${absent?.status}`);
      ctx.recorder.event('member-journey:no-serving', { gateCalls: noServing.servingChecks(), soon: true, entry: false, bareStatus: 404 });
      return { ok: true };
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    } finally {
      noServing?.world.close();
      member?.world.close();
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  },
}];
