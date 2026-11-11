import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routeRequest, type NexusHttpServerOpts } from '../nexus/api/http-server.js';
import { createMembersApi } from '../nexus/members/members-api.js';
import { createMemberStore } from '../nexus/members/member-store.js';
import { createJsonlMemberEventStore } from '../nexus/api/member-event-store.js';
import { createDevProxyRuntimeRef } from '../nexus/api/admin-dev-proxy.js';
import { loadNexusAppHost } from '../nexus/apps/app-host.js';
import { testFakeLlmProvider } from './fake-llm.js';
import { createBoardApprovalDispatch } from '../../plugins/absorb/handlers/board-approval.js';
import { runAbsorbGraphSimulation } from './absorb-v2-runGraph-sim.js';
import type { BoardCardEvent } from '../nexus/api/board-api.js';

const TEST_DAY = '2026-11-09';
const TEST_NOW = '2026-11-14T01:00:00.000Z';

describe('KAIST absorb path · fake member session and fixed-response provider', () => {
  test('scrap → brief/suggestion → human OK → harness dispatch → projected mini board', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kaist-absorb-e2e-'));
    const memberStore = createMemberStore({ path: join(root, 'members.sqlite'), now: () => Date.parse(TEST_NOW) });
    // Source: #36288's fake member E2E provisions exactly one registration for its single test owner.
    memberStore.provisionEventCode({ code: 'KAIST-TEST', maxUses: 1 });
    const member = memberStore.register({ sub: 'fake-kaist-owner', email: 'kaist-owner@example.test', emailVerified: true, name: 'KAIST Test Owner' }, { consents: { privacy: 'v1', terms: 'v1' }, eventCode: 'KAIST-TEST' }, TEST_NOW);
    const appSlot = memberStore.createAppSlotForMember(member.id, TEST_NOW);
    expect(['created', 'already-exists']).toContain(appSlot.outcome);
    if (appSlot.outcome !== 'created' && appSlot.outcome !== 'already-exists') throw new Error('fake member app slot was not created');
    const appDir = join(root, 'apps', appSlot.slot.appSlug);
    mkdirSync(join(appDir, 'out'), { recursive: true });
    writeFileSync(join(appDir, 'app.yaml'), `apiVersion: elanous.app/v0\nslug: ${appSlot.slot.appSlug}\ntitle: KAIST test\nfrontend:\n  kind: static-export\n  out: out\nroles:\n  owner: { via: nexus-session }\n`);
    writeFileSync(join(appDir, 'out', 'index.html'), '<main>KAIST simulation</main>');
    const appHost = loadNexusAppHost(join(root, 'apps'), undefined, {
      dir: join(root, 'app-auth'), databaseDirectory: join(root, 'app-databases'),
      key: 'kaist-absorb-e2e-test-key-with-at-least-256-bits', now: () => Date.parse(TEST_NOW),
    }).appHost;
    const fakeSession = appHost.issueOwnerSession(appSlot.slot.appSlug, member.id);
    const membersApi = createMembersApi({
      store: memberStore,
      google: {
        redirectUri: 'https://example.test/v1/members/oauth/google/callback',
        // Source: #36288's fake Google provider is never invoked; this value is not issued to a browser.
        start: async () => ({ authorizationUrl: 'https://example.test/oauth', state: 'unused', cookieValue: 'unused', maxAgeSeconds: 0 }),
        complete: async () => { throw new Error('unused'); },
      },
      successRedirectUri: 'https://example.test/signup/complete',
      now: () => Date.parse(TEST_NOW),
      resolveVerifiedOwner: (appSlug, credential, members) => appHost.resolveVerifiedOwner(appSlug, credential, members, 'kaist-test-owner'),
      resolveVerifiedMemberOwner: (credential, members) => appHost.resolveVerifiedMemberOwner(credential, members, 'kaist-test-owner'),
    });
    const boardEventStore = createJsonlMemberEventStore(join(root, 'events'));
    let suggested!: BoardCardEvent;
    let graphRun: Promise<unknown> | undefined;
    const previousFakeEnabled = process.env.ELANOUS_TEST_FAKE_LLM;
    const previousFakeResponse = process.env.ELANOUS_TEST_FAKE_LLM_RESPONSE;
    process.env.ELANOUS_TEST_FAKE_LLM = '1';
    process.env.ELANOUS_TEST_FAKE_LLM_RESPONSE = '강의 노트 공유 입력을 추가하자는 제안';
    const opts = {
      metaApi: { noAuth: true },
      appHost,
      membersApi,
      boardEventStore,
      boardApprovalDispatch: createBoardApprovalDispatch({
        appsRoot: join(root, 'apps'),
        createRunId: () => 'accept-kaist-test-1',
        runGraph: async (file, options) => {
          expect(file).toContain('absorb-build.yaml');
          expect(options.input).toMatchObject({ suggestionId: 'kaist-card-1', context: { memberId: member.id, target: realpathSync(appDir) } });
          graphRun = runAbsorbGraphSimulation({ confirmation: 'y', approvalRunId: options.runId, onAcceptedBuild: async state => {
            expect(state.status).toBe('done');
            expect(state.path).toEqual(expect.arrayContaining(['build', 'simulate', 'publish']));
            const runId = state.runId;
            const attachment = { kind: 'diagram' as const, title: '강의 노트 흐름도', url: 'https://example.test/diagram.svg', mime: 'image/svg+xml', sha256: 'c'.repeat(64), producedBy: 'absorb-build' };
            await boardEventStore.append({ ...suggested, state: 'building', runId, at: '2026-11-09T01:05:00.000Z' });
            await boardEventStore.append({ ...suggested, state: 'testing', runId, summary: '그래프 시험 진행', at: '2026-11-09T01:06:00.000Z' });
            await boardEventStore.append({ ...suggested, state: 'released', runId, summary: '가짜 그래프 발행 완료', attachments: [attachment],
              result: { publicUrl: 'https://lecture-scrap-demo.app.sim.invalid/' }, at: '2026-11-09T01:07:00.000Z' });
          } });
          await graphRun;
          return { status: 'done' } as never;
        },
      }),
      scraps: {
        instanceRoot: root,
        extractors: {},
        now: () => new Date('2026-11-09T01:00:00.000Z'),
      },
    } as unknown as NexusHttpServerOpts;
    const nexusState = { nexusVersion: 'test' } as never;
    const graphEvents: unknown[] = [];
    const unsubscribe = boardEventStore.subscribe(event => {
      graphEvents.push(event);
    });
    const call = (path: string, method = 'GET', body?: unknown, sessionToken = fakeSession.sessionToken) => routeRequest(new Request(`http://nexus.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${sessionToken}`,
        origin: 'http://nexus.test',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(path === '/v1/scraps' && method === 'POST' ? { 'idempotency-key': 'kaist-e2e-scrap-001' } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), opts, nexusState, null, createDevProxyRuntimeRef());

    try {
      const scrapResponse = await call('/v1/scraps', 'POST', {
        kind: 'text', source: 'tui', raw: { text: 'KAIST 강의 자료를 강의 노트 앱에서 이어서 읽고 싶다.' },
      });
      expect(scrapResponse?.status).toBe(201);
      const scrap = await scrapResponse!.json() as { id: string; memberId: string; status: string; card: { title: string } };
      expect(scrap).toMatchObject({ memberId: member.id, status: 'absorbed' });

      const llmReply = Array.fromAsync(testFakeLlmProvider.chat([{ role: 'user', content: `브리핑과 제안 생성: ${scrap.card.title}` }]));
      expect(await llmReply).toEqual(['강의 노트 공유 입력을 추가하자는 제안']);
      const at = '2026-11-09T01:01:00.000Z';
      suggested = { type: 'board.card', cardId: 'kaist-card-1', memberId: member.id, state: 'suggested', title: '강의 노트 앱 공유 입력', summary: '강의 자료 스크랩을 앱에서 이어 읽기', at };
      await boardEventStore.append(suggested);

      const briefing = { id: 'brief-kaist-1', memberId: member.id, day: TEST_DAY, title: 'KAIST 강의 노트', scrapIds: [scrap.id], suggestionId: 'kaist-card-1' };
      expect(briefing.scrapIds).toContain(scrap.id);
      const beforeApproval = await call('/v1/board');
      expect(beforeApproval?.status).toBe(200);
      const preApprovalBoard = await beforeApproval!.json() as { cards: Array<{ id: string; state: string }> };
      expect(preApprovalBoard.cards).toMatchObject([{ id: 'kaist-card-1', state: 'proposed' }]);

      const approvedResponse = await call('/v1/board/kaist-card-1/approve', 'POST', { decision: 'approved' });
      expect(approvedResponse?.status).toBe(202);
      expect(await approvedResponse!.json()).toMatchObject({ card: { state: 'approved' }, dispatch: { acceptanceId: 'accept-kaist-test-1' } });
      expect(graphRun).toBeDefined();
      await graphRun;
      const runId = 'accept-kaist-test-1';
      const attachment = { kind: 'diagram' as const, title: '강의 노트 흐름도', url: 'https://example.test/diagram.svg', mime: 'image/svg+xml', sha256: 'c'.repeat(64), producedBy: 'absorb-build' };

      const boardResponse = await call('/v1/board');
      expect(boardResponse?.status).toBe(200);
      const board = await boardResponse!.json() as { cards: Array<{ id: string; memberId: string; title: string; state: 'deployed'; summary: string; runId: string; publicUrl?: string }> };
      expect(board.cards).toMatchObject([{
        id: 'kaist-card-1', memberId: member.id, title: '강의 노트 앱 공유 입력', state: 'deployed',
        summary: '가짜 그래프 발행 완료', runId,
      }]);
      expect(board.cards[0]?.publicUrl).toBe('https://lecture-scrap-demo.app.sim.invalid/');
      expect((board.cards[0] as { attachments?: unknown[] })?.attachments).toEqual([attachment]);
      expect(graphEvents).toHaveLength(5);
      expect(graphEvents.map(event => (event as { state: string }).state)).toEqual(['suggested', 'approved', 'building', 'testing', 'released']);
      expect((await call('/v1/board', 'GET')).status).toBe(200);
      const invalidSession = await call('/v1/scraps', 'POST', {
        kind: 'text', source: 'tui', raw: { text: 'invalid session must not write' },
      }, 'aps_invalid_test_session');
      expect(invalidSession?.status).toBe(401);
    } finally {
      unsubscribe();
      appHost.close();
      if (previousFakeEnabled === undefined) delete process.env.ELANOUS_TEST_FAKE_LLM;
      else process.env.ELANOUS_TEST_FAKE_LLM = previousFakeEnabled;
      if (previousFakeResponse === undefined) delete process.env.ELANOUS_TEST_FAKE_LLM_RESPONSE;
      else process.env.ELANOUS_TEST_FAKE_LLM_RESPONSE = previousFakeResponse;
      memberStore.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
