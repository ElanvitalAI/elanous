import { expect, test } from 'bun:test';
import { createMemberConnectEntry } from './member-connect-entry-api.js';

const origin = 'https://api.elanous.ai';
const state = 's'.repeat(43);
const challenge = 'c'.repeat(43);
const pollSecret = 'p'.repeat(43);
const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('approved browser member alone creates a PKCE-bound code; foreign member, CSRF and poll theft refuse', async () => {
  let at = Date.parse('2026-11-14T00:00:00.000Z');
  const created: Array<Record<string, unknown>> = [];
  const api = createMemberConnectEntry({ origin, now: () => at,
    memberForRequest: request => request.headers.get('x-member'),
    store: {
      ensureNativeAppSlotForMember: memberId => ({ memberId, appId: `app-${memberId}` }) as never,
      createAppAuthCode: input => { created.push(input); },
    },
  });
  const start = await api.handle(post(`${origin}/v1/members/connect/start`, { state, codeChallenge: challenge, pollSecret }));
  expect(start?.status).toBe(201);
  const { approvalUrl, id, userCode } = await start!.json() as { approvalUrl: string; id: string; userCode: string };
  expect(approvalUrl).toBe(`${origin}/v1/members/connect/approve?id=${id}`);
  expect(approvalUrl).not.toContain(pollSecret);
  expect(userCode).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  expect(approvalUrl).not.toContain(userCode);
  const pollUrl = `${origin}/v1/members/connect/poll?id=${id}`;
  expect((await api.handle(post(pollUrl, { pollSecret: 'x'.repeat(43) })))?.status).toBe(404);
  expect((await api.handle(post(pollUrl, { pollSecret })))?.status).toBe(202);
  expect((await api.handle(new Request(approvalUrl)))?.status).toBe(401);
  const page = await api.handle(new Request(approvalUrl, { headers: { 'x-member': 'member-a' } }));
  expect(page?.status).toBe(200);
  const html = await page!.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
  expect(csrf).toBeTruthy();
  expect(html).not.toContain(pollSecret);
  expect(html).not.toContain(userCode);
  expect((await api.handle(new Request(approvalUrl, { headers: { 'x-member': 'member-b' } })))?.status).toBe(403);
  const approve = (member: string, csrfValue: string, requestOrigin = origin) =>
    new Request(approvalUrl, { method: 'POST', headers: { 'x-member': member, origin: requestOrigin,
      'content-type': 'application/x-www-form-urlencoded' }, body: `csrf=${csrfValue}&userCode=${userCode}` });
  expect((await api.handle(approve('member-b', csrf!)))?.status).toBe(403);
  expect((await api.handle(approve('member-a', csrf!, 'https://evil.example')))?.status).toBe(403);
  expect((await api.handle(approve('member-a', 'wrong')))?.status).toBe(403);
  expect((await api.handle(new Request(approvalUrl, { method: 'POST', headers: { 'x-member': 'member-a', origin },
    body: `csrf=${csrf}&userCode=AAAA-BBBB` })))?.status).toBe(403);
  const approved = await api.handle(approve('member-a', csrf!));
  expect(approved?.status).toBe(200);
  expect((await approved!.text())).not.toContain('app-member-a');
  expect(created).toHaveLength(1);
  expect(created[0]).toMatchObject({ memberId: 'member-a', appId: 'app-member-a', state, codeChallenge: challenge });
  const polled = await api.handle(post(pollUrl, { pollSecret }));
  expect(polled?.status).toBe(200);
  const payload = await polled!.json() as { code: string; state: string };
  expect(payload.state).toBe(state);
  expect(payload.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect((await api.handle(post(pollUrl, { pollSecret })))?.status).toBe(404);
  at += 1;
});

test('expired or unavailable issuer refuses without a code', async () => {
  let at = Date.parse('2026-11-14T00:00:00.000Z');
  let issued = 0;
  const api = createMemberConnectEntry({ origin, now: () => at, memberForRequest: () => 'member-a',
    store: { ensureNativeAppSlotForMember: () => ({ appId: 'app-a' }) as never,
      createAppAuthCode: () => { issued++; } } });
  const start = await api.handle(post(`${origin}/v1/members/connect/start`, { state, codeChallenge: challenge, pollSecret }));
  const { approvalUrl } = await start!.json() as { approvalUrl: string };
  at += 120_000;
  expect((await api.handle(new Request(approvalUrl)))?.status).toBe(404);
  expect(issued).toBe(0);
  const disabled = createMemberConnectEntry({ origin, enabled: false, memberForRequest: () => null,
    store: { ensureNativeAppSlotForMember: () => null } });
  expect((await disabled.handle(post(`${origin}/v1/members/connect/start`, { state, codeChallenge: challenge, pollSecret })))?.status).toBe(503);
});

test('start refuses an oversized stream before buffering it', async () => {
  let cancelled = false;
  const api = createMemberConnectEntry({ origin, memberForRequest: () => null,
    store: { ensureNativeAppSlotForMember: () => null, createAppAuthCode: () => {} } });
  const request = new Request(`${origin}/v1/members/connect/start`, { method: 'POST',
    body: new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(4097)); },
      cancel() { cancelled = true; },
    }),
  });
  expect((await api.handle(request))?.status).toBe(400);
  expect(cancelled).toBe(true);
});

test('concurrent approval bodies issue only one auth code', async () => {
  let issued = 0;
  const api = createMemberConnectEntry({ origin, memberForRequest: () => 'member-a',
    store: { ensureNativeAppSlotForMember: () => ({ appId: 'app-a' }) as never,
      createAppAuthCode: () => { issued++; } } });
  const start = await api.handle(post(`${origin}/v1/members/connect/start`, { state, codeChallenge: challenge, pollSecret }));
  const { approvalUrl, userCode } = await start!.json() as { approvalUrl: string; userCode: string };
  const page = await api.handle(new Request(approvalUrl));
  const csrf = /name="csrf" value="([^"]+)"/.exec(await page!.text())![1];
  const delayed = () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const request = new Request(approvalUrl, { method: 'POST', headers: { origin },
      body: new ReadableStream<Uint8Array>({ start(value) { controller = value; } }) });
    return { request, release() { controller.enqueue(new TextEncoder().encode(`csrf=${csrf}&userCode=${userCode}`)); controller.close(); } };
  };
  const first = delayed();
  const second = delayed();
  const firstResult = api.handle(first.request);
  const secondResult = api.handle(second.request);
  first.release();
  second.release();
  const statuses = [(await firstResult)?.status, (await secondResult)?.status].sort();
  expect(statuses).toEqual([200, 403]);
  expect(issued).toBe(1);
});

test('approval body crossing expiry and expiry during slot lookup issue no code', async () => {
  let at = Date.parse('2026-11-14T00:00:00.000Z');
  let issued = 0;
  let expireDuringSlot = false;
  const api = createMemberConnectEntry({ origin, now: () => at, memberForRequest: () => 'member-a',
    store: { ensureNativeAppSlotForMember: () => {
      if (expireDuringSlot) at += 120_000;
      return { appId: 'app-a' } as never;
    }, createAppAuthCode: () => { issued++; } } });
  const makeApproval = async () => {
    const start = await api.handle(post(`${origin}/v1/members/connect/start`, { state, codeChallenge: challenge, pollSecret }));
    const { approvalUrl, userCode } = await start!.json() as { approvalUrl: string; userCode: string };
    const page = await api.handle(new Request(approvalUrl));
    const csrf = /name="csrf" value="([^"]+)"/.exec(await page!.text())![1];
    return { approvalUrl, csrf, userCode };
  };
  const first = await makeApproval();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const request = new Request(first.approvalUrl, { method: 'POST', headers: { origin },
    body: new ReadableStream<Uint8Array>({ start(value) { controller = value; } }) });
  const result = api.handle(request);
  at += 120_000;
  controller.enqueue(new TextEncoder().encode(`csrf=${first.csrf}&userCode=${first.userCode}`));
  controller.close();
  expect((await result)?.status).toBe(403);
  expect(issued).toBe(0);

  const second = await makeApproval();
  expireDuringSlot = true;
  const approve = new Request(second.approvalUrl, { method: 'POST', headers: { origin }, body: `csrf=${second.csrf}&userCode=${second.userCode}` });
  expect((await api.handle(approve))?.status).toBe(403);
  expect(issued).toBe(0);
});

test('public start is limited per trusted caller and recovers after expiry', async () => {
  let at = Date.parse('2026-11-14T00:00:00.000Z');
  const api = createMemberConnectEntry({ origin, now: () => at, memberForRequest: () => null,
    store: { ensureNativeAppSlotForMember: () => null, createAppAuthCode: () => {} } });
  const start = (caller: string) => api.handle(post(`${origin}/v1/members/connect/start`,
    { state, codeChallenge: challenge, pollSecret }), caller);
  for (let index = 0; index < 3; index++) expect((await start('ipv4:203.0.113.1'))?.status).toBe(201);
  const callerBusy = await start('ipv4:203.0.113.1');
  expect(callerBusy?.status).toBe(429);
  expect(callerBusy?.headers.get('retry-after')).toBe('120');
  expect((await start('ipv4:203.0.113.2'))?.status).toBe(201);
  expect((await start('unknown'))?.status).toBe(201);
  expect((await start('unknown'))?.status).toBe(429);
  at += 120_000;
  expect((await start('ipv4:203.0.113.1'))?.status).toBe(201);
});

test('start attempt window runs before body read, bounds caller map and recovers', async () => {
  let at = Date.parse('2026-11-14T00:00:00.000Z');
  const api = createMemberConnectEntry({ origin, now: () => at, memberForRequest: () => null,
    store: { ensureNativeAppSlotForMember: () => null, createAppAuthCode: () => {} } });
  const invalid = (caller: string) => api.handle(post(`${origin}/v1/members/connect/start`, {}), caller);
  for (let index = 0; index < 8; index++) expect((await invalid('caller-a'))?.status).toBe(400);
  const blocked = new Request(`${origin}/v1/members/connect/start`, { method: 'POST',
    body: new ReadableStream<Uint8Array>({ start() {} }) });
  const denied = await api.handle(blocked, 'caller-a');
  expect(denied?.status).toBe(429);
  expect(denied?.headers.get('retry-after')).toBe('120');
  expect(blocked.bodyUsed).toBe(false);
  for (let index = 0; index < 1023; index++) expect((await invalid(`caller-${index}`))?.status).toBe(400);
  expect((await invalid('caller-overflow'))?.status).toBe(429);
  at += 120_000;
  expect((await invalid('caller-overflow'))?.status).toBe(400);
});

test('failed poll secrets are bounded and a consumed code is delivered only once', async () => {
  const api = createMemberConnectEntry({ origin, memberForRequest: () => 'member-a',
    store: { ensureNativeAppSlotForMember: () => ({ appId: 'app-a' }) as never,
      createAppAuthCode: () => {} } });
  const create = async () => {
    const started = await api.handle(post(`${origin}/v1/members/connect/start`, { state, codeChallenge: challenge, pollSecret }));
    return await started!.json() as { id: string; approvalUrl: string; userCode: string };
  };
  const first = await create();
  const firstPoll = `${origin}/v1/members/connect/poll?id=${first.id}`;
  for (let index = 0; index < 7; index++) {
    expect((await api.handle(post(firstPoll, { pollSecret: 'x'.repeat(43) })))?.status).toBe(404);
  }
  expect((await api.handle(post(firstPoll, { pollSecret })))?.status).toBe(202);
  expect((await api.handle(post(firstPoll, { pollSecret: 'x'.repeat(43) })))?.status).toBe(404);
  expect((await api.handle(post(firstPoll, { pollSecret })))?.status).toBe(404);

  const second = await create();
  const page = await api.handle(new Request(second.approvalUrl));
  const csrf = /name="csrf" value="([^"]+)"/.exec(await page!.text())![1];
  const approved = await api.handle(new Request(second.approvalUrl, { method: 'POST', headers: { origin },
    body: `csrf=${csrf}&userCode=${second.userCode}` }));
  expect(approved?.status).toBe(200);
  const pollUrl = `${origin}/v1/members/connect/poll?id=${second.id}`;
  const delayed = () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const request = new Request(pollUrl, { method: 'POST',
      body: new ReadableStream<Uint8Array>({ start(value) { controller = value; } }) });
    return { request, release() { controller.enqueue(new TextEncoder().encode(JSON.stringify({ pollSecret }))); controller.close(); } };
  };
  const a = delayed();
  const b = delayed();
  const aResult = api.handle(a.request);
  const bResult = api.handle(b.request);
  a.release(); b.release();
  expect([(await aResult)?.status, (await bResult)?.status].sort()).toEqual([200, 404]);
});
