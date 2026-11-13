import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { MemberProposalCard } from '../components/chat/MemberProposalCard';
import { createMemberMiniBoardApi, type MemberMiniBoardApi } from './member-mini-board-api';
import { handleBoardRoute, type BoardCardEvent, type BoardEventStore } from '../../../../src/nexus/api/board-api';
import { createBoardApprovalDispatch } from '../../../../plugins/absorb/handlers/board-approval';
import { runAbsorbGraphSimulation } from '../../../../src/ux-sim/absorb-v2-runGraph-sim';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test('scene 3 PWA reopens the verified member approval and run receipt after remount', async () => {
  const api: MemberMiniBoardApi = {
    getVerifiedOwner: async () => ({ memberId: 'member-a', appSlug: 'ticket-app' }),
    getBoard: async () => ({ cards: [
      { id: 'proposal-a', memberId: 'member-a', title: '티켓팅 서비스', state: 'developing',
        acceptanceId: 'run-scene3-a', runId: 'run-scene3-a' },
      { id: 'proposal-b', memberId: 'member-b', title: '다른 회원 앱', state: 'deployed',
        acceptanceId: 'run-scene3-b', runId: 'run-scene3-b' },
    ] }),
    getBriefings: async () => [],
    subscribe: () => () => {},
  };
  let tree: ReturnType<typeof create> | undefined;
  try {
    for (let mount = 0; mount < 2; mount++) {
      await act(async () => { tree = create(createElement(MemberProposalCard, { api })); await Bun.sleep(0); });
      const screen = JSON.stringify(tree!.toJSON());
      expect(screen).toContain('티켓팅 서비스');
      expect(screen).toContain('run-scene3-a');
      expect(screen).toContain('개발 중');
      expect(screen).not.toContain('다른 회원 앱');
      expect(screen).not.toContain('run-scene3-b');
      await act(async () => tree!.unmount());
      tree = undefined;
    }
  } finally {
    if (tree) await act(async () => tree!.unmount());
  }
});

test('scene 3 PWA same API owner switch drops the prior member acceptance before and after remount', async () => {
  let ownerId = 'member-a';
  let notify: (() => void) | undefined;
  const api: MemberMiniBoardApi = {
    getVerifiedOwner: async () => ({ memberId: ownerId, appSlug: 'ticket-app' }),
    getBoard: async () => ({ cards: ownerId === 'member-a' ? [
      { id: 'proposal-a', memberId: 'member-a', title: '회원 A 전용 앱', state: 'developing',
        acceptanceId: 'accept-member-a', runId: 'run-member-a' },
    ] : [
      { id: 'proposal-b', memberId: 'member-b', title: '회원 B 전용 앱', state: 'testing',
        acceptanceId: 'accept-member-b', runId: 'run-member-b' },
    ] }),
    getBriefings: async () => [],
    subscribe: (_memberId, onChange) => { notify = onChange; return () => { notify = undefined; }; },
  };
  let tree: ReturnType<typeof create> | undefined;
  try {
    await act(async () => { tree = create(createElement(MemberProposalCard, { api })); await Bun.sleep(0); });
    expect(JSON.stringify(tree!.toJSON())).toContain('회원 A 전용 앱');
    expect(JSON.stringify(tree!.toJSON())).toContain('accept-member-a');
    ownerId = 'member-b';
    await act(async () => { notify?.(); await Bun.sleep(0); });
    const switched = JSON.stringify(tree!.toJSON());
    expect(switched).toContain('회원 B 전용 앱');
    expect(switched).toContain('accept-member-b');
    expect(switched).toContain('run-member-b');
    expect(switched).not.toContain('회원 A 전용 앱');
    expect(switched).not.toContain('accept-member-a');
    expect(switched).not.toContain('run-member-a');
    await act(async () => tree!.unmount());
    tree = undefined;
    await act(async () => { tree = create(createElement(MemberProposalCard, { api })); await Bun.sleep(0); });
    const remounted = JSON.stringify(tree!.toJSON());
    expect(remounted).toContain('회원 B 전용 앱');
    expect(remounted).toContain('accept-member-b');
    expect(remounted).toContain('run-member-b');
    expect(remounted).not.toContain('회원 A 전용 앱');
    expect(remounted).not.toContain('accept-member-a');
    expect(remounted).not.toContain('run-member-a');
  } finally {
    if (tree) await act(async () => tree!.unmount());
  }
});

test('scene 3 fake graph suggestion keeps one approval run through POST and PWA projection; N and stale OK stay closed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'demo1114-s3-pwa-'));
  const appId = 'lecture-scrap-demo';
  const memberId = 'member-demo';
  const runId = 'accept-scene3-0315';
  const events: BoardCardEvent[] = [];
  const store: BoardEventStore = {
    query: async ({ memberId: owner }) => events.filter(event => event.memberId === owner),
    append: async event => { events.push(event); },
  };
  let tree: ReturnType<typeof create> | undefined;
  try {
    mkdirSync(join(root, appId));
    const sourceWorld = parseYaml(readFileSync(join(import.meta.dir, '../../../../plugins/absorb/sims/absorb-demo-world.yaml'), 'utf8')) as {
      fixtures: { suggestions: unknown[] };
    };
    sourceWorld.fixtures.suggestions = [];
    const worldPath = join(root, 'scene3-world.json');
    writeFileSync(worldPath, JSON.stringify(sourceWorld));
    let suggestionId = '';
    const proposal = await runAbsorbGraphSimulation({ briefOnly: true, briefRunId: runId, worldPath, memberId, onSuggestion: async ({ suggestions }) => {
      const suggestion = suggestions.find(row => row.owner === memberId && typeof row.id === 'string');
      if (!suggestion) throw new Error('production brief graph did not save the member suggestion');
      suggestionId = String(suggestion.id);
      events.push({ type: 'board.card', cardId: suggestionId, memberId, runId, state: 'suggested',
        title: String(suggestion.ask), summary: String(suggestion.change), at: '2026-11-09T01:01:00.000Z' });
    } });
    expect(proposal).toMatchObject({ status: 'done' });
    expect(proposal.runId).toBe(runId);
    expect(suggestionId).toStartWith('suggestion-2026-11-09-');
    sourceWorld.fixtures.suggestions = [
      (proposal.suggestions as Array<Record<string, unknown>>).find(row => row.id === suggestionId)!,
    ];
    writeFileSync(worldPath, JSON.stringify(sourceWorld));

    let graphReceipt: Record<string, unknown> | undefined;
    let graphStarts = 0;
    const dispatchApproved = createBoardApprovalDispatch({
      appsRoot: root, createRunId: () => runId,
      runGraph: async (file, options) => {
        if (!options) throw new Error('approval graph options missing');
        expect(file).toContain('absorb-build.yaml');
        expect(options.runId).toBe(runId);
        expect(options.input).toMatchObject({ suggestionId, context: { memberId, runId } });
        graphStarts++;
        graphReceipt = await runAbsorbGraphSimulation({ confirmation: 'y', buildOnly: true, worldPath, memberId,
          routeSuggestionId: suggestionId, approvalRunId: options.runId });
        return { status: 'done' } as never;
      },
    });
    const posts: Array<{ path: string; decision: string; status: number }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/v1/members') return Response.json({ member: { id: memberId }, appSlot: { appSlug: appId } });
      if (url.pathname === '/v1/members/owner') return Response.json({ memberId });
      const request = new Request(url, { ...init, headers: {
        ...Object.fromEntries(new Headers(init?.headers).entries()), cookie: 'member-session=fake', origin: url.origin,
      } });
      const response = await handleBoardRoute(request, url.pathname, {
        store, resolveOwner: async () => ({ memberId, appSlug: appId }), dispatchApproved,
        now: () => Date.parse('2026-11-09T01:02:00.000Z'),
      }) ?? new Response(null, { status: 404 });
      if (init?.method === 'POST') posts.push({ path: url.pathname, decision: String(JSON.parse(String(init.body)).decision), status: response.status });
      return response;
    }) as typeof fetch;
    const api = createMemberMiniBoardApi('https://nexus.example.test', fetchImpl, () => ({ addEventListener() {}, close() {} }));

    const deny = await fetchImpl(`https://nexus.example.test/v1/board/${suggestionId}/approve`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'rejected' }),
    });
    expect(deny.status).toBe(400);
    expect(events.map(event => event.state)).toEqual(['suggested']);
    expect(graphStarts).toBe(0);

    await act(async () => { tree = create(createElement(MemberProposalCard, { api })); await Bun.sleep(0); });
    expect(JSON.stringify(tree!.toJSON())).toContain(String(events[0]!.title));
    await act(async () => { tree!.root.findByType('button').props.onClick(); await Bun.sleep(0); });
    expect(posts.filter(post => post.decision === 'approved')).toEqual([{
      path: `/v1/board/${suggestionId}/approve`, decision: 'approved', status: 202,
    }]);
    expect(graphStarts).toBe(1);
    expect(graphReceipt).toMatchObject({ status: 'done', selectedSuggestion: { id: suggestionId } });
    const board = await api.getBoard() as { cards: Array<{ id: string; state: string; acceptanceId?: string; runId?: string }> };
    expect(board.cards).toMatchObject([{ id: suggestionId, acceptanceId: runId, runId }]);
    expect(events.filter(event => event.state === 'approved').map(event => event.acceptanceId)).toEqual([runId]);
    expect(JSON.stringify(tree!.toJSON())).toContain(runId);
    await act(async () => tree!.unmount());
    tree = undefined;
    await act(async () => { tree = create(createElement(MemberProposalCard, { api })); await Bun.sleep(0); });
    expect(JSON.stringify(tree!.toJSON())).toContain(runId);

    const stale = await fetchImpl(`https://nexus.example.test/v1/board/${suggestionId}/approve`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'approved' }),
    });
    expect(stale.status).toBe(409);
    expect(graphStarts).toBe(1);
    expect(events.filter(event => event.acceptanceId === runId)).toHaveLength(1);
    console.log(JSON.stringify({ device: 'absorb-demo-world + board-api + MemberProposalCard',
      proposalGraphRunId: proposal.runId, suggestionId, approvalRunId: runId,
      boardAcceptanceId: board.cards[0]?.acceptanceId, pwaRemountHasRunId: JSON.stringify(tree!.toJSON()).includes(runId),
      posts, graphStarts, graphStatus: graphReceipt?.status, eventStates: events.map(event => event.state) }));
  } finally {
    if (tree) await act(async () => tree!.unmount());
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
