import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createJsonlMemberEventStore } from '../nexus/api/member-event-store.js';
import { createAbsorbShareSummaryRequestApi, createShareSummaryRequestApi, resolveVerifiedShareSummaryOwner, shareSummaryNexusEvent, type SummaryScrap } from '../nexus/api/share-summary-requests.js';
import { handleScraps } from '../nexus/api/scraps.js';
import { startNexusHttpServer } from '../nexus/api/http-server.js';
import { NexusEventBus } from '../nexus/api/event-bus.js';
import { createMembersApi } from '../nexus/members/members-api.js';
import { createMemberStore } from '../nexus/members/member-store.js';
import { createNexusState } from '../nexus/state/state.js';
import { TabRegistry } from '../nexus/state/tab-registry.js';
import { listAbsorbScraps } from '../intake-plane/items.js';

const base = 'http://nexus.test/v1/scraps/summary-requests';

describe('iOS share summary request contract simulation', () => {
  test('real member API verifies app Bearer without an app slug and a member cookie', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ios-share-summary-owner-'));
    const store = createMemberStore({ path: join(root, 'members.sqlite') });
    try {
      const member = store.register({ sub: 'ios-summary-owner', email: 'ios-summary@example.test', emailVerified: true, name: 'Owner' }, { consents: { privacy: 'v1', terms: 'v1' } });
      const appSessionToken = 'aps_verified-ios-summary-owner';
      const api = createMembersApi({
        store,
        google: { redirectUri: 'https://example.test/v1/members/oauth/google/callback',
          // Source: 내부 문서 `user-ops-space` — this OAuth stub never issues a session.
          start: async () => ({ authorizationUrl: 'https://accounts.example.test', state: 'unused', cookieValue: 'unused', maxAgeSeconds: 0 }),
          complete: async () => { throw new Error('unused'); } },
        successRedirectUri: 'https://example.test/signup/complete',
        resolveVerifiedMemberOwner: credential => credential === appSessionToken
          ? { memberId: member.id, userSlug: 'owner', plan: 'free', entitlements: {} } : null,
      });
      const bearer = new Request(base, { headers: { authorization: `Bearer ${appSessionToken}` } });
      expect(await resolveVerifiedShareSummaryOwner(bearer, api)).toEqual({ memberId: member.id });
      const session = store.createSession(member.id);
      const cookie = new Request(base, { headers: { cookie: `__Host-elanous_member_session=${encodeURIComponent(session.token)}` } });
      expect(await resolveVerifiedShareSummaryOwner(cookie, api)).toEqual({ memberId: member.id });
      expect(await resolveVerifiedShareSummaryOwner(new Request(base), api)).toBeNull();
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test('Nexus route accepts a verified iOS bearer session and denies a forged body owner', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ios-share-summary-route-'));
    const memberStore = createMemberStore({ path: join(root, 'members.sqlite') });
    try {
      const member = memberStore.register({ sub: 'ios-route-owner', email: 'ios-route@example.test', emailVerified: true, name: 'Owner' }, { consents: { privacy: 'v1', terms: 'v1' } });
      const memberId = member.id;
      const appSessionToken = 'aps_ios-session';
      const membersApi = createMembersApi({
        store: memberStore,
        google: { redirectUri: 'https://example.test/v1/members/oauth/google/callback',
          // Source: 내부 문서 `user-ops-space` — this OAuth stub never issues a session.
          start: async () => ({ authorizationUrl: 'https://accounts.example.test', state: 'unused', cookieValue: 'unused', maxAgeSeconds: 0 }),
          complete: async () => { throw new Error('unused'); } },
        successRedirectUri: 'https://example.test/signup/complete',
        resolveVerifiedMemberOwner: credential => credential === appSessionToken
          ? { memberId, userSlug: 'owner', plan: 'free', entitlements: {} } : null,
      });
      const saved = await handleScraps(new Request('http://nexus.test/v1/scraps', {
        method: 'POST', headers: { 'idempotency-key': 'ios-share-route-0001', 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'text', source: 'android-share', raw: { text: 'Lecture summary' } }),
      }), { instanceRoot: root, resolveOwner: async () => ({ memberId }), extractors: {} });
      const scrapId = (await saved.json() as { id: string }).id;
      const events = createJsonlMemberEventStore(join(root, 'member-events'));
      const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
      const eventBus = new NexusEventBus();
      state.bus = eventBus;
      let extractionStarted!: () => void;
      let finishExtraction!: (value: { title: string; body: string }) => void;
      const started = new Promise<void>(resolve => { extractionStarted = resolve; });
      const extraction = new Promise<{ title: string; body: string }>(resolve => { finishExtraction = resolve; });
      let failureStarted!: () => void;
      let failExtraction!: (reason: Error) => void;
      const failedStart = new Promise<void>(resolve => { failureStarted = resolve; });
      const failedExtraction = new Promise<{ title: string; body: string }>((_, reject) => { failExtraction = reject; });
      const server = startNexusHttpServer({ state, registry: new TabRegistry(state), eventBus, membersApi,
        scraps: { instanceRoot: root, extractors: { digestWeb: async url => {
          if (url.endsWith('/failed')) { failureStarted(); return failedExtraction; }
          extractionStarted(); return extraction;
        } } }, boardEventStore: events,
        shareSummaryGenerator: async scrap => `새 모델 요약: ${scrap.extractedBody ?? scrap.card?.title}`,
        metaApi: { bearerToken: 'operator-token', noAuth: false },
        startPort: 46_000 + Math.floor(Math.random() * 1_000),
      });
      try {
      const headers = { authorization: `Bearer ${appSessionToken}`,
        'idempotency-key': 'ios-route-summary-0001', 'content-type': 'application/json' };
      const deniedStream = await fetch(`${server.url}/v1/events?topics=scrap.summary.result`);
      expect(deniedStream.status).toBe(401);
      const stream = await fetch(`${server.url}/v1/events?topics=scrap.summary.result`, { headers: { authorization: headers.authorization } });
      expect(stream.status).toBe(200);
      const reader = stream.body!.getReader();
      await reader.read(); // initial SSE comment
      const result = await fetch(`${server.url}/v1/scraps/summary-requests`, {
        method: 'POST', headers, body: JSON.stringify({ scrapId, memberId: 'attacker' }),
      });
      expect(result.status).toBe(201);
      const resultBody = await result.json() as { requestId: string; status: string; summary: string; summarySource: string };
      expect(resultBody.status).toBe('ready');
      expect(resultBody.summary).toBe('새 모델 요약: Lecture summary');
      expect(resultBody.summarySource).toBe('generated');
      const recovered = await fetch(`${server.url}/v1/scraps/summary-requests/${resultBody.requestId}`, { headers: { authorization: headers.authorization } });
      expect(recovered.status).toBe(200);
      expect((await recovered.json()).summary).toBe(resultBody.summary);
      const frame = new TextDecoder().decode((await reader.read()).value);
      expect(frame).toContain('scrap.summary.result');
      await reader.cancel();
      const persisted = (await events.query({ memberId, type: 'scrap.summary.result' }))[0]!;
      expect(shareSummaryNexusEvent(persisted)?.memberId).toBe(memberId);
      expect(shareSummaryNexusEvent(persisted)?.detail).toEqual({ requestId: persisted.requestId, scrapId,
        status: 'ready', summarySource: 'generated' });
      const denied = await fetch(`${server.url}/v1/scraps/summary-requests`, { method: 'POST',
        headers: { 'idempotency-key': 'ios-route-summary-0002', 'content-type': 'application/json' },
        body: JSON.stringify({ scrapId, memberId }),
      });
      expect(denied.status).toBe(401);
      const pendingStream = await fetch(`${server.url}/v1/events?topics=scrap.summary.result`, { headers: { authorization: headers.authorization } });
      const pendingReader = pendingStream.body!.getReader();
      await pendingReader.read();
      const saving = fetch(`${server.url}/v1/scraps`, {
        method: 'POST', headers: { ...headers, 'idempotency-key': 'ios-pending-scrap-0001' },
        body: JSON.stringify({ kind: 'web', source: 'android-share', raw: { url: 'https://example.test/pending' } }),
      });
      await started;
      const pendingScrapId = listAbsorbScraps(root, memberId).find(row => row.absorb?.raw.url === 'https://example.test/pending')!.id;
      const pendingRequest = await fetch(`${server.url}/v1/scraps/summary-requests`, {
        method: 'POST', headers: { ...headers, 'idempotency-key': 'ios-pending-summary-0001' },
        body: JSON.stringify({ scrapId: pendingScrapId }),
      });
      expect(pendingRequest.status).toBe(202);
      const pendingId = (await pendingRequest.json() as { requestId: string }).requestId;
      finishExtraction({ title: 'Pending lecture', body: 'First point.' });
      expect((await saving).status).toBe(201);
      const pendingFrame = new TextDecoder().decode((await pendingReader.read()).value);
      expect(pendingFrame).toContain('scrap.summary.result');
      expect(pendingFrame).toContain(pendingId);
      expect((await events.query({ memberId, type: 'scrap.summary.result' })).some(row => row.requestId === pendingId)).toBe(true);
      await pendingReader.cancel();
      const failedStream = await fetch(`${server.url}/v1/events?topics=scrap.summary.result`, { headers: { authorization: headers.authorization } });
      const failedReader = failedStream.body!.getReader();
      await failedReader.read();
      const failing = fetch(`${server.url}/v1/scraps`, {
        method: 'POST', headers: { ...headers, 'idempotency-key': 'ios-failed-scrap-0001' },
        body: JSON.stringify({ kind: 'web', source: 'android-share', raw: { url: 'https://example.test/failed' } }),
      });
      await failedStart;
      const failedScrapId = listAbsorbScraps(root, memberId).find(row => row.absorb?.raw.url === 'https://example.test/failed')!.id;
      const failedRequest = await fetch(`${server.url}/v1/scraps/summary-requests`, {
        method: 'POST', headers: { ...headers, 'idempotency-key': 'ios-failed-summary-0001' },
        body: JSON.stringify({ scrapId: failedScrapId }),
      });
      expect(failedRequest.status).toBe(202);
      const failedId = (await failedRequest.json() as { requestId: string }).requestId;
      failExtraction(new Error('digest-failed'));
      expect((await failing).status).toBe(502);
      const failedFrame = new TextDecoder().decode((await failedReader.read()).value);
      expect(failedFrame).toContain(failedId);
      expect(failedFrame).toContain('failed');
      await failedReader.cancel();
      } finally { server.stop(); }
    } finally { memberStore.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test('server extraction-pending boundary is separate from the extension save-response chain', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ios-summary-extraction-boundary-'));
    try {
      const events = createJsonlMemberEventStore(join(root, 'member-events'));
      let generated = 0;
      // Server contract only: this fixture already knows an extracting scrap ID.
      // It does not represent the extension, which must wait for its save response.
      const api = createShareSummaryRequestApi({ ownerForRequest: () => 'member-a', events,
        getScrap: () => ({ id: 'extracting-scrap', status: 'extracting' }),
        generateSummary: async () => { generated++; return 'Unexpected summary'; } });
      const pending = await api(new Request(base, { method: 'POST', headers: {
        'idempotency-key': 'ios-extraction-boundary-0001', 'content-type': 'application/json',
      }, body: JSON.stringify({ scrapId: 'extracting-scrap' }) }));
      expect(pending?.status).toBe(202);
      const body = await pending!.json() as { requestId: string; status: string };
      expect(body).toMatchObject({ status: 'pending' });
      expect(body.requestId).toStartWith('sum_');
      expect(generated).toBe(0);
      expect(await events.query({ memberId: 'member-a', type: 'scrap.summary.requested' })).toHaveLength(1);
      expect(await events.query({ memberId: 'member-a', type: 'scrap.summary.result' })).toHaveLength(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('installed share extension chain keeps save request and result notice on one requestId', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ios-extension-chain-'));
    const memberStore = createMemberStore({ path: join(root, 'members.sqlite') });
    try {
      const member = memberStore.register({ sub: 'ios-extension-chain', email: 'chain@example.test', emailVerified: true, name: 'Owner' }, { consents: { privacy: 'v1', terms: 'v1' } });
      const memberId = member.id;
      const appSessionToken = 'aps_ios-extension-chain';
      const membersApi = createMembersApi({
        store: memberStore,
        google: { redirectUri: 'https://example.test/v1/members/oauth/google/callback',
          // Source: 내부 문서 `user-ops-space` — this OAuth stub never issues a session.
          start: async () => ({ authorizationUrl: 'https://accounts.example.test', state: 'unused', cookieValue: 'unused', maxAgeSeconds: 0 }),
          complete: async () => { throw new Error('unused'); } },
        successRedirectUri: 'https://example.test/signup/complete',
        resolveVerifiedMemberOwner: credential => credential === appSessionToken
          ? { memberId, userSlug: 'owner', plan: 'free', entitlements: {} } : null,
      });
      let extractionStarted!: () => void;
      let finishExtraction!: (value: { title: string; body: string }) => void;
      const started = new Promise<void>(resolve => { extractionStarted = resolve; });
      const extraction = new Promise<{ title: string; body: string }>(resolve => { finishExtraction = resolve; });
      let generated = 0;
      const events = createJsonlMemberEventStore(join(root, 'member-events'));
      const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
      const eventBus = new NexusEventBus();
      state.bus = eventBus;
      const server = startNexusHttpServer({ state, registry: new TabRegistry(state), eventBus, membersApi,
        scraps: { instanceRoot: root, extractors: { digestWeb: async () => {
          extractionStarted(); return extraction;
        } } }, boardEventStore: events,
        shareSummaryGenerator: async scrap => { generated++; return `새 모델 요약: ${scrap.extractedBody ?? scrap.card?.title}`; },
        metaApi: { bearerToken: 'operator-token', noAuth: false },
        startPort: 46_000 + Math.floor(Math.random() * 1_000),
      });
      const authorization = `Bearer ${appSessionToken}`;
      try {
        const stream = await fetch(`${server.url}/v1/events?topics=scrap.summary.result`, { headers: { authorization } });
        expect(stream.status).toBe(200);
        const reader = stream.body!.getReader();
        await reader.read(); // initial SSE comment
        // Extension save leg: ShareScrapClient posts kind=web with ShareAPIContract.shareSource.
        const saving = fetch(`${server.url}/v1/scraps`, {
          method: 'POST', headers: { authorization, 'idempotency-key': 'ios-share-chain-0001', 'content-type': 'application/json' },
          body: JSON.stringify({ kind: 'web', source: 'android-share', raw: { url: 'https://example.test/chain' } }),
        });
        await started;
        // The extension cannot request a summary until save returns its scrap ID.
        expect(await events.query({ memberId, type: 'scrap.summary.requested' })).toHaveLength(0);
        finishExtraction({ title: 'Chain lecture', body: 'One point.' });
        const saved = await saving;
        expect(saved.status).toBe(201);
        const savedBody = await saved.json() as { id: string };
        const scrapId = savedBody.id;
        expect(scrapId).toBeString();
        expect(scrapId).not.toBe('');
        const storedExtensionState = JSON.stringify({ scrapId });
        // ShareSummaryRequestClient.idempotencyKey derives from the scrapID alone, so a
        // restarted extension re-derives the same key and replays the same requestId.
        const extensionKey = `iossum_${createHash('sha256').update(scrapId).digest('hex')}`;
        const expectedRequestId = `sum_${createHash('sha256').update(JSON.stringify([memberId, extensionKey])).digest('hex').slice(0, 32)}`;
        const post = (savedScrapId: string) => fetch(`${server.url}/v1/scraps/summary-requests`, {
          method: 'POST', headers: { authorization, 'idempotency-key': `iossum_${createHash('sha256').update(savedScrapId).digest('hex')}`, 'content-type': 'application/json' },
          body: JSON.stringify({ scrapId: savedScrapId }),
        });
        const created = await post(scrapId);
        expect(created.status).toBe(201);
        const createdBody = await created.json() as { requestId: string; status: string };
        expect(createdBody).toMatchObject({ requestId: expectedRequestId, status: 'ready' });
        // Simulate a fresh extension instance with only its persisted save response ID.
        const restartedState = JSON.parse(storedExtensionState) as { scrapId: string };
        const restartReplay = await post(restartedState.scrapId);
        expect(restartReplay.status).toBe(200);
        expect(await restartReplay.json()).toMatchObject({ requestId: expectedRequestId, status: 'ready' });
        // requestAndPoll leg: at most four status polls before showing the receipt.
        let receipt: { requestId: string; status: string; scrapId?: string; summary?: string; summarySource?: string }
          = { requestId: expectedRequestId, status: 'pending' };
        for (let polls = 0; polls < 4 && receipt.status === 'pending'; polls++) {
          const polled = await fetch(`${server.url}/v1/scraps/summary-requests/${receipt.requestId}`, { headers: { authorization } });
          expect(polled.status).toBe(200);
          receipt = await polled.json() as typeof receipt;
        }
        expect(receipt).toMatchObject({ requestId: expectedRequestId, scrapId, status: 'ready',
          summary: '새 모델 요약: One point.', summarySource: 'generated' });
        const frame = new TextDecoder().decode((await reader.read()).value);
        expect(frame).toContain('scrap.summary.result');
        expect(frame).toContain(expectedRequestId);
        expect(frame).toContain(scrapId);
        await reader.cancel();
        const requested = await events.query({ memberId, type: 'scrap.summary.requested' });
        expect(requested).toHaveLength(1);
        const durable = await events.query({ memberId, type: 'scrap.summary.result' });
        expect(durable).toHaveLength(1);
        expect(durable[0]).toMatchObject({ requestId: expectedRequestId, scrapId, status: 'ready' });
        // A restart after the result replays the receipt without generating again.
        const afterReady = await post((JSON.parse(storedExtensionState) as { scrapId: string }).scrapId);
        expect(afterReady.status).toBe(200);
        expect(await afterReady.json()).toMatchObject({ requestId: expectedRequestId, status: 'ready' });
        expect(generated).toBe(1);
        expect(await events.query({ memberId, type: 'scrap.summary.requested' })).toHaveLength(1);
      } finally { server.stop(); }
    } finally { memberStore.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test('actual saved article scrap becomes a member-scoped summary result', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ios-share-summary-absorb-'));
    try {
      const saved = await handleScraps(new Request('http://nexus.test/v1/scraps', {
        method: 'POST', headers: { 'idempotency-key': 'ios-shared-article-0001', 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'web', source: 'android-share', raw: { url: 'https://example.test/lecture' } }),
      }), {
        instanceRoot: root, resolveOwner: async () => ({ memberId: 'member-a' }),
        extractors: { digestWeb: async () => ({ title: 'Lecture', body: 'One point. Two point.' }) },
        now: () => new Date('2026-11-12T00:00:00.000Z'),
      });
      expect(saved.status).toBe(201);
      const scrapId = (await saved.json() as { id: string }).id;
      const events = createJsonlMemberEventStore(join(root, 'member-events'));
      const generatedInputs: string[] = [];
      const api = createAbsorbShareSummaryRequestApi({
        instanceRoot: root, events,
        ownerForRequest: request => request.headers.get('x-verified-member'),
        generateSummary: async scrap => {
          generatedInputs.push(scrap.extractedBody ?? '');
          return '모델이 새로 생성한 강의 요약';
        },
      });
      const request = (member: string) => new Request(base, {
        method: 'POST', headers: { 'x-verified-member': member, 'idempotency-key': 'ios-summary-request-0001', 'content-type': 'application/json' },
        body: JSON.stringify({ scrapId }),
      });
      expect((await api(request('member-b')))?.status).toBe(404);
      const result = (await api(request('member-a')))!;
      expect(result.status).toBe(201);
      const body = await result.json() as { status: string; summary: string; summarySource: string; requestId: string };
      expect(body.status).toBe('ready');
      expect(body.summary).toBe('모델이 새로 생성한 강의 요약');
      expect(body.summarySource).toBe('generated');
      expect(generatedInputs).toEqual(['One point. Two point.']);
      expect((await events.query({ memberId: 'member-a', type: 'scrap.summary.result' }))).toMatchObject([
        { requestId: body.requestId, scrapId, status: 'ready', summarySource: 'generated' },
      ]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('model failure keeps the stored card visible and marks its provenance on POST and replay', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ios-share-summary-fallback-'));
    try {
      const events = createJsonlMemberEventStore(join(root, 'member-events'));
      let calls = 0;
      const api = createShareSummaryRequestApi({
        ownerForRequest: () => 'member-a', events,
        getScrap: () => ({ id: 'scrap-1', status: 'absorbed', card: { title: 'Stored title', points: ['Stored point'] } }),
        generateSummary: async () => { calls++; throw new Error('private provider detail'); },
      });
      const post = () => new Request(base, { method: 'POST', headers: {
        'idempotency-key': 'ios-summary-fallback-0001', 'content-type': 'application/json',
      }, body: JSON.stringify({ scrapId: 'scrap-1' }) });
      const created = await api(post());
      expect(created?.status).toBe(201);
      const body = await created!.json() as { requestId: string; summary: string; summarySource: string };
      expect(body).toMatchObject({ summary: 'Stored title\nStored point', summarySource: 'stored-card' });
      const replay = await api(post());
      expect((await replay!.json()).summarySource).toBe('stored-card');
      const poll = await api(new Request(`${base}/${body.requestId}`));
      expect((await poll!.json()).summarySource).toBe('stored-card');
      expect(calls).toBe(1);
      expect(JSON.stringify(await events.query({ memberId: 'member-a', type: 'scrap.summary.result' }))).not.toContain('private provider detail');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('member hourly generation cap survives restart and concurrent keys while replay stays free', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ios-summary-hourly-cap-'));
    try {
      let clock = new Date('2026-11-13T00:00:00.000Z');
      let generated = 0;
      const options = {
        ownerForRequest: (request: Request) => request.headers.get('x-verified-member'),
        getScrap: () => ({ id: 'scrap-1', status: 'absorbed' as const,
          card: { title: 'Article', points: ['Fact'] } }),
        generateSummary: async () => { generated++; return 'New summary'; },
        now: () => clock,
      };
      const eventsRoot = join(root, 'events');
      const api = createShareSummaryRequestApi({ ...options, events: createJsonlMemberEventStore(eventsRoot) });
      const post = (member: string, index: number) => new Request(base, { method: 'POST',
        headers: { 'x-verified-member': member, 'idempotency-key': `ios-hourly-${index.toString().padStart(4, '0')}`,
          'content-type': 'application/json' }, body: JSON.stringify({ scrapId: 'scrap-1' }) });
      const first = await Promise.all(Array.from({ length: 31 }, (_, index) => api(post('member-a', index))));
      expect(first.filter(row => row?.status === 201)).toHaveLength(30);
      expect(first.filter(row => row?.status === 429)).toHaveLength(1);
      expect(generated).toBe(30);
      expect(await (await api(post('member-a', 0)))?.json()).toMatchObject({ summarySource: 'generated' });
      expect((await api(post('member-b', 31)))?.status).toBe(201);
      const reopened = createShareSummaryRequestApi({ ...options, events: createJsonlMemberEventStore(eventsRoot) });
      expect((await reopened(post('member-a', 32)))?.status).toBe(429);
      expect((await reopened(post('member-a', 32)))?.json()).resolves.toMatchObject({ error: 'summary-rate-limit' });
      clock = new Date('2026-11-13T01:00:01.000Z');
      expect((await reopened(post('member-a', 32)))?.status).toBe(201);
      expect((await createJsonlMemberEventStore(eventsRoot).query({ memberId: 'member-a', type: 'scrap.summary.requested' }))).toHaveLength(31);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('two API processes replay one key through the final hourly slot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ios-summary-process-race-'));
    try {
      const events = createJsonlMemberEventStore(root);
      for (let index = 0; index < 29; index++) await events.append({ type: 'scrap.summary.requested',
        memberId: 'member-a', requestId: `sum_prefill_${index}`, scrapId: 'scrap-1', at: '2026-11-13T00:00:00.000Z' });
      const storePath = new URL('../nexus/api/member-event-store.ts', import.meta.url).href;
      const apiPath = new URL('../nexus/api/share-summary-requests.ts', import.meta.url).href;
      const childSource = `import { createJsonlMemberEventStore } from ${JSON.stringify(storePath)};
        import { createShareSummaryRequestApi } from ${JSON.stringify(apiPath)};
        let generated = 0;
        const api = createShareSummaryRequestApi({ ownerForRequest: () => 'member-a',
          events: createJsonlMemberEventStore(process.argv[1]),
          getScrap: () => ({ id: 'scrap-1', status: 'absorbed', card: { title: 'Article', points: [] } }),
          generateSummary: async () => { generated++; await new Promise(resolve => setTimeout(resolve, 100)); return 'Generated'; },
          now: () => new Date('2026-11-13T00:00:00.000Z') });
        const result = await api(new Request('http://nexus.test/v1/scraps/summary-requests', {
          method: 'POST', headers: { 'idempotency-key': 'ios-process-same-key', 'content-type': 'application/json' },
          body: JSON.stringify({ scrapId: 'scrap-1' }) }));
        process.stdout.write(String(result.status) + ':' + generated);`;
      const runChild = () => new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', childSource, root], { stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '', errors = '';
        child.stdout.on('data', chunk => { output += String(chunk); });
        child.stderr.on('data', chunk => { errors += String(chunk); });
        child.once('error', reject);
        child.once('exit', code => code === 0 ? resolve(output) : reject(new Error(`API child failed: ${code} ${errors}`)));
      });
      const outcomes = await Promise.all([runChild(), runChild()]);
      expect(outcomes.filter(value => value === '201:1')).toHaveLength(1);
      expect(outcomes.every(value => ['200:0', '201:1', '202:0'].includes(value))).toBe(true);
      expect(await events.query({ memberId: 'member-a', type: 'scrap.summary.requested' })).toHaveLength(30);
      expect(await events.query({ memberId: 'member-a', type: 'scrap.summary.result' })).toHaveLength(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a long generation renews its claim before the lease expires', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ios-summary-long-generation-'));
    try {
      let clock = new Date('2026-11-13T00:00:00.000Z');
      let started!: () => void;
      let finish!: (value: string) => void;
      const generating = new Promise<string>(resolve => { finish = resolve; });
      const began = new Promise<void>(resolve => { started = resolve; });
      const events = createJsonlMemberEventStore(root);
      const api = createShareSummaryRequestApi({ ownerForRequest: () => 'member-a', events,
        getScrap: () => ({ id: 'scrap-1', status: 'absorbed', card: { title: 'Article', points: [] } }),
        generateSummary: async () => { started(); return generating; },
        now: () => clock, generationHeartbeatMs: 5 });
      const posting = api(new Request(base, { method: 'POST', headers: {
        'idempotency-key': 'ios-long-generation', 'content-type': 'application/json',
      }, body: JSON.stringify({ scrapId: 'scrap-1' }) }));
      await began;
      clock = new Date('2026-11-13T00:04:00.000Z');
      await new Promise(resolve => setTimeout(resolve, 30));
      clock = new Date('2026-11-13T00:06:00.000Z');
      const claim = (await events.query({ memberId: 'member-a', type: 'scrap.summary.claimed' }))[0]!;
      expect((await events.claimPendingEvent!({ type: 'scrap.summary.claimed', memberId: 'member-a',
        requestId: claim.requestId, claimId: 'other-worker', at: clock.toISOString() },
      { resultType: 'scrap.summary.result', key: 'requestId', now: () => clock, leaseMs: 5 * 60_000 }))).toBe('busy');
      finish('Long generated result');
      expect((await (await posting)!.json()).summary).toBe('Long generated result');
      expect(await events.query({ memberId: 'member-a', type: 'scrap.summary.result' })).toHaveLength(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('pending reservation resumes after restart and a crashed generation claim expires', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ios-summary-pending-recovery-'));
    try {
      const events = createJsonlMemberEventStore(root);
      let clock = new Date('2026-11-13T00:00:00.000Z');
      let absorbed = false;
      let generated = 0;
      const makeApi = () => createShareSummaryRequestApi({ ownerForRequest: () => 'member-a',
        events: createJsonlMemberEventStore(root),
        getScrap: () => ({ id: 'scrap-1', status: absorbed ? 'absorbed' : 'extracting',
          card: { title: 'Article', points: [] } }),
        generateSummary: async () => { generated++; return 'Recovered summary'; }, now: () => clock });
      const api = makeApi();
      const post = (key: string) => new Request(base, { method: 'POST',
        headers: { 'idempotency-key': key, 'content-type': 'application/json' },
        body: JSON.stringify({ scrapId: 'scrap-1' }) });
      const pending = await api(post('ios-recover-no-claim'));
      expect(pending?.status).toBe(202);
      absorbed = true;
      const restarted = makeApi();
      const recovered = await restarted(post('ios-recover-no-claim'));
      expect(recovered?.status).toBe(200);
      expect((await recovered?.json()).summary).toBe('Recovered summary');
      absorbed = false;
      const secondPending = await api(post('ios-recover-with-claim'));
      expect(secondPending?.status).toBe(202);
      const requestId = (await secondPending?.json()).requestId as string;
      await events.append({ type: 'scrap.summary.claimed', memberId: 'member-a',
        requestId, at: clock.toISOString() });
      absorbed = true;
      expect(requestId).toStartWith('sum_');
      expect((await restarted(post('ios-recover-with-claim')))?.status).toBe(200);
      expect(generated).toBe(1);
      clock = new Date(clock.getTime() + 6 * 60_000);
      const retried = await makeApi()(post('ios-recover-with-claim'));
      expect(retried?.status).toBe(200);
      expect((await retried?.json()).summary).toBe('Recovered summary');
      expect(generated).toBe(2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a durable result saved before provenance existed replays as stored-card', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ios-share-summary-legacy-'));
    try {
      const events = createJsonlMemberEventStore(join(root, 'member-events'));
      const api = createShareSummaryRequestApi({ ownerForRequest: () => 'member-a', events,
        getScrap: () => ({ id: 'scrap-legacy', status: 'extracting' }) });
      const post = () => new Request(base, { method: 'POST', headers: {
        'idempotency-key': 'ios-summary-legacy-0001', 'content-type': 'application/json',
      }, body: JSON.stringify({ scrapId: 'scrap-legacy' }) });
      const pending = (await api(post()))!;
      expect(pending.status).toBe(202);
      const { requestId } = await pending.json() as { requestId: string };
      const legacy = { type: 'scrap.summary.result', memberId: 'member-a', requestId,
        scrapId: 'scrap-legacy', status: 'ready', summary: 'Old card text', at: '2026-11-12T00:00:00.000Z' };
      await events.append(legacy);
      const replay = (await api(post()))!;
      expect((await replay.json()).summarySource).toBe('stored-card');
      const poll = (await api(new Request(`${base}/${requestId}`)))!;
      expect((await poll.json()).summarySource).toBe('stored-card');
      expect(shareSummaryNexusEvent((await events.query({ memberId: 'member-a', type: 'scrap.summary.result' }))[0]!)?.detail)
        .toMatchObject({ requestId, status: 'ready', summarySource: 'stored-card' });
      expect((await events.query({ memberId: 'member-a', type: 'scrap.summary.result' }))).toHaveLength(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('saved scrap request, pending poll, completed result notification, and replay', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ios-share-summary-'));
    try {
      const events = createJsonlMemberEventStore(join(root, 'member-events'));
      const notifications: unknown[] = [];
      events.subscribe(event => { if (event.type === 'scrap.summary.result') notifications.push(event); });
      let scrap: SummaryScrap | null = { id: 'scrap-1', status: 'extracting' };
      const api = createShareSummaryRequestApi({
        ownerForRequest: request => request.headers.get('x-verified-member'),
        getScrap: (memberId, id) => memberId === 'member-a' && id === scrap?.id ? scrap : null,
        events, now: () => new Date('2026-11-12T00:00:00.000Z'),
      });
      const post = (member: string, id: string, key = 'share-summary-0001') => new Request(base, {
        method: 'POST', headers: { 'x-verified-member': member, 'idempotency-key': key, 'content-type': 'application/json' },
        body: JSON.stringify({ scrapId: id, memberId: 'forged-member' }),
      });
      const [created, concurrentReplay] = await Promise.all([
        api(post('member-a', 'scrap-1')), api(post('member-a', 'scrap-1')),
      ]);
      expect([created?.status, concurrentReplay?.status].sort()).toEqual([200, 202]);
      expect((await events.query({ memberId: 'member-a', type: 'scrap.summary.requested' }))).toHaveLength(1);
      const createdResponse = created?.status === 202 ? created : concurrentReplay!;
      const pending = await createdResponse.json() as { requestId: string; status: string; summary?: string };
      expect(pending.status).toBe('pending');
      expect(pending.summary).toBeUndefined();
      expect(notifications).toHaveLength(0);
      expect((await api(post('member-b', 'scrap-1')))?.status).toBe(404);
      expect((await api(new Request(`${base}/${pending.requestId}`, { headers: { 'x-verified-member': 'member-b' } })))?.status).toBe(404);
      expect((await api(post('member-a', 'scrap-other', 'share-summary-other-1')))?.status).toBe(404);

      scrap = { id: 'scrap-1', status: 'absorbed', card: { title: 'Lecture', points: ['First point', 'Second point'] } };
      const completed = (await api(new Request(`${base}/${pending.requestId}`, { headers: { 'x-verified-member': 'member-a' } })))!;
      expect(completed.status).toBe(200);
      expect(await completed.json()).toMatchObject({ requestId: pending.requestId, status: 'ready', summary: 'Lecture\nFirst point\nSecond point' });
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toMatchObject({ type: 'scrap.summary.result', memberId: 'member-a', scrapId: 'scrap-1', status: 'ready' });
      const replay = (await api(post('member-a', 'scrap-1')))!;
      expect(replay.status).toBe(200);
      expect((await replay.json()).requestId).toBe(pending.requestId);
      expect(notifications).toHaveLength(1);
      scrap = null;
      const replayAfterDelete = (await api(post('member-a', 'scrap-1')))!;
      expect(replayAfterDelete.status).toBe(200);
      expect(await replayAfterDelete.json()).toMatchObject({ requestId: pending.requestId, status: 'ready' });
      expect((await api(post('member-a', 'scrap-other', 'share-summary-0001')))?.status).toBe(409);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('rejects malformed requests and reports a failed extraction', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ios-share-summary-failure-'));
    try {
      const events = createJsonlMemberEventStore(join(root, 'member-events'));
      const api = createShareSummaryRequestApi({
        ownerForRequest: request => request.headers.get('x-verified-member'),
        getScrap: () => ({ id: 'failed-scrap', status: 'failed', failure: { reason: 'transcription-unavailable' } }),
        events,
      });
      const headers = { 'x-verified-member': 'member-a', 'idempotency-key': 'summary-failure-01', 'content-type': 'application/json' };
      expect((await api(new Request(base, { method: 'POST', headers: { ...headers, 'idempotency-key': 'short' }, body: '{"scrapId":"failed-scrap"}' })))?.status).toBe(400);
      expect((await api(new Request(base, { method: 'POST', headers, body: '{' })))?.status).toBe(400);
      expect((await api(new Request(base, { method: 'POST', headers, body: '{"scrapId":"../bad"}' })))?.status).toBe(400);
      expect((await api(new Request(base, { method: 'POST', body: '{"scrapId":"failed-scrap"}' })))?.status).toBe(401);
      const failed = (await api(new Request(base, { method: 'POST', headers, body: '{"scrapId":"failed-scrap"}' })))!;
      expect(failed.status).toBe(201);
      expect(await failed.json()).toMatchObject({ status: 'failed', error: 'transcription-unavailable' });
      expect((await events.query({ memberId: 'member-a', type: 'scrap.summary.result' }))).toHaveLength(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});


test('summary completed after lease expiry is discarded before any takeover, then a new claim recovers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ios-summary-expired-completion-'));
  try {
    const events = createJsonlMemberEventStore(root);
    let clock = new Date('2026-11-13T00:00:00.000Z'), generated = 0;
    const api = createShareSummaryRequestApi({ ownerForRequest: () => 'member-a', events,
      getScrap: () => ({ id: 'scrap-1', status: 'absorbed', card: { title: 'Article', points: [] } }),
      generateSummary: async () => { generated++; if (generated === 1) clock = new Date('2026-11-13T00:05:00.001Z');
        return generated === 1 ? 'Expired output' : 'Fresh output'; }, now: () => clock });
    const post = () => new Request(base, { method: 'POST', headers: {
      'idempotency-key': 'ios-expired-completion', 'content-type': 'application/json',
    }, body: JSON.stringify({ scrapId: 'scrap-1' }) });
    expect((await api(post()))!.status).toBe(202);
    expect(await events.query({ memberId: 'member-a', type: 'scrap.summary.result' })).toHaveLength(0);
    expect(await events.query({ memberId: 'member-a', type: 'scrap.summary.claimed' })).toHaveLength(1);
    expect((await (await api(post()))!.json()).summary).toBe('Fresh output');
    const results = await events.query({ memberId: 'member-a', type: 'scrap.summary.result' });
    expect(results).toHaveLength(1); expect(results[0]!.summary).toBe('Fresh output');
    expect(await events.query({ memberId: 'member-a', type: 'scrap.summary.requested' })).toHaveLength(1);
    expect(generated).toBe(2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
