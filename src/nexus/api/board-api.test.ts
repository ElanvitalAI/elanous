import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchGraphContract } from '../../graph-runner/capabilities.js';
import { boardCardNexusEvent, handleBoardRoute, recoverBoardApprovals, type BoardCardEvent, type BoardEventStore } from './board-api.js';
import { createJsonlMemberEventStore, createNexusCapabilityRegistry } from './member-event-store.js';
import { createBoardApprovalDispatch } from '../../../plugins/absorb/handlers/board-approval.js';

const events: BoardCardEvent[] = [
  { type: 'board.card', cardId: 'card-a', memberId: 'member-a', state: 'suggested', title: 'KAIST 앱', summary: '요청 정리', at: '2026-11-09T01:00:00.000Z' },
  { type: 'board.card', cardId: 'card-a', memberId: 'member-a', state: 'approved', title: 'KAIST 앱', summary: '승인', at: '2026-11-09T01:01:00.000Z' },
  { type: 'board.card', cardId: 'card-a', memberId: 'member-a', state: 'building', title: 'KAIST 앱', summary: '격리 복사', runId: 'run-42c1abcd', at: '2026-11-09T01:02:00.000Z' },
  { type: 'board.card', cardId: 'card-a', memberId: 'member-a', state: 'testing', title: 'KAIST 앱', summary: '원격 시험', result: { publicUrl: 'https://demo--owner.elanous.app/', simulationReceipt: 'sim-pass' }, at: '2026-11-09T01:03:00.000Z' },
  { type: 'board.card', cardId: 'card-a', memberId: 'member-a', state: 'released', title: 'KAIST 앱', summary: '배포 완료', runId: 'run-42c1abcd', result: { publicUrl: 'https://demo--owner.elanous.app/', resultUrl: 'https://demo--owner.elanous.app/' }, at: '2026-11-09T01:04:00.000Z' },
  { type: 'board.card', cardId: 'card-b', memberId: 'member-b', state: 'suggested', title: '다른 회원 카드', at: '2026-11-09T01:05:00.000Z' },
];

function storeFixture(seed: readonly BoardCardEvent[] = events) {
  const log = [...seed];
  const store: BoardEventStore = {
    query: async ({ memberId, type }) => log.filter(item => item.memberId === memberId && item.type === type),
    scan: async ({ type }) => log.filter(item => item.type === type),
    append: async value => { log.push(value as BoardCardEvent); },
  };
  return { store, log };
}

function request(path: string, method = 'GET', body?: unknown) {
  return new Request(`https://nexus.test${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe('member board Nexus routes · fake cap:store world', () => {
  test('journal SSE mapping withholds app URLs until the released state', () => {
    const event = { ...events[3]!, result: { publicUrl: 'https://demo--owner.elanous.app/', resultUrl: 'https://demo--owner.elanous.app/', simulationReceipt: 'sim-pass' } };
    const testing = boardCardNexusEvent(event)!;
    expect(testing.detail?.result).toEqual({ simulationReceipt: 'sim-pass' });
    const released = boardCardNexusEvent({ ...event, state: 'released' })!;
    expect(released.detail?.result).toEqual(event.result);
  });

  test('GET folds the five event states through the shared projection and returns only the verified member cards', async () => {
    const { store } = storeFixture();
    const response = await handleBoardRoute(request('/v1/board'), '/v1/board', {
      store, resolveOwner: async () => ({ memberId: 'member-a' }), now: () => Date.parse('2026-11-09T01:06:00Z'),
    });
    expect(response).toBeDefined();
    expect(response!.status).toBe(200);
    expect(await response!.json()).toEqual({ cards: [{
      id: 'card-a', memberId: 'member-a', title: 'KAIST 앱', state: 'deployed',
      summary: '배포 완료', runId: 'run-42c1abcd',
      resultUrl: 'https://demo--owner.elanous.app/', publicUrl: 'https://demo--owner.elanous.app/',
      updatedAt: '2026-11-09T01:04:00.000Z',
    }] });
  });

  test('hides public URLs until release even when app.publish has already returned one', async () => {
    const { store } = storeFixture(events.slice(0, 4));
    const response = await handleBoardRoute(request('/v1/board'), '/v1/board', {
      store, resolveOwner: async () => ({ memberId: 'member-a' }),
    });
    expect(response).toBeDefined();
    expect((await response!.json() as { cards: Array<Record<string, unknown>> }).cards[0]).not.toHaveProperty('publicUrl');
    const denied = await handleBoardRoute(request('/v1/board'), '/v1/board', { store, resolveOwner: async () => null });
    expect(denied).toBeDefined();
    expect(denied!.status).toBe(401);
  });

  test('latest card state follows journal order even when producer timestamps regress', async () => {
    const history: BoardCardEvent[] = [
      { ...events[0]!, state: 'suggested', at: '2026-11-09T02:00:00.000Z' },
      { ...events[0]!, state: 'approved', at: '2026-11-09T02:01:00.000Z' },
      { ...events[0]!, state: 'building', summary: 'graph started', at: '2026-11-09T01:59:00.000Z' },
    ];
    const { store } = storeFixture(history);
    const response = await handleBoardRoute(request('/v1/board'), '/v1/board', {
      store, resolveOwner: async () => ({ memberId: 'member-a' }),
    });
    expect((await response!.json() as { cards: Array<{ state: string; summary: string }> }).cards[0]).toMatchObject({
      state: 'developing', summary: 'graph started',
    });
  });

  test('approve records only explicit member input and publishes the graph-facing decision event', async () => {
    const { store, log } = storeFixture([events[0]!, events[5]!]);
    const published: unknown[] = [];
    const deps = { store, resolveOwner: async () => ({ memberId: 'member-a' }), publish: (event: unknown) => { published.push(event); }, now: () => Date.parse('2026-11-09T02:00:00Z') };
    const approved = await handleBoardRoute(request('/v1/board/card-a/approve', 'POST', { decision: 'approved' }), '/v1/board/card-a/approve', deps);
    expect(approved).toBeDefined();
    expect(approved!.status).toBe(200);
    expect(log.at(-1)).toEqual({ ...events[0], state: 'approved', at: '2026-11-09T02:00:00.000Z' });
    expect(log.at(-1)?.memberId).toBe('member-a');
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ kind: 'board.card', memberId: 'member-a', detail: { cardId: 'card-a', state: 'approved' } });
    const foreign = await handleBoardRoute(request('/v1/board/card-b/approve', 'POST', { decision: 'approved' }), '/v1/board/card-b/approve', deps);
    expect(foreign).toBeDefined();
    expect(foreign!.status).toBe(404);
  });

  test('only one concurrent approval can advance a suggested card in one Nexus process', async () => {
    const { store, log } = storeFixture([events[0]!]);
    const dispatched: string[] = [];
    const deps = { store, resolveOwner: async () => ({ memberId: 'member-a', appSlug: 'kaist-app' }),
      dispatchApproved: async (card: BoardCardEvent) => { dispatched.push(card.cardId); return { acceptanceId: 'accept-once', start: async () => undefined };  } };
    const results = await Promise.all([1, 2].map(() => handleBoardRoute(
      request('/v1/board/card-a/approve', 'POST', { decision: 'approved' }), '/v1/board/card-a/approve', deps,
    )));
    expect(results.map(result => result?.status).sort()).toEqual([202, 409]);
    expect(log.filter(event => event.state === 'approved')).toHaveLength(1);
    expect(dispatched).toEqual(['card-a']);
  });

  test('JSONL store restart replays an accepted graph with the same run id', async () => {
    const root = mkdtempSync(join(tmpdir(), 'board-restart-'));
    try {
      const first = createJsonlMemberEventStore(root);
      const accepted: BoardCardEvent = { ...events[1]!, acceptanceId: 'run-durable', appSlug: 'kaist-app' };
      await first.append(events[0]!);
      await first.append(accepted);
      const restarted = createJsonlMemberEventStore(root);
      const launched: string[] = [];
      await recoverBoardApprovals(restarted, async (_card, _owner, existingRunId) => ({
        acceptanceId: existingRunId!, start: async () => { launched.push(existingRunId!); },
      }));
      expect(launched).toEqual(['run-durable']);
      expect(await restarted.query({ memberId: 'member-a', type: 'board.card' })).toEqual([events[0], accepted]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('restart replay uses persisted acceptance id and verified app slug', async () => {
    const accepted: BoardCardEvent = { ...events[1]!, acceptanceId: 'run-replay', appSlug: 'kaist-app' };
    const { store, log } = storeFixture([events[0]!, accepted]);
    const launches: string[] = [];
    await recoverBoardApprovals(store, async (card, owner, existingRunId) => {
      expect(card).toMatchObject({ cardId: 'card-a', acceptanceId: 'run-replay' });
      expect(owner).toEqual({ memberId: 'member-a', appSlug: 'kaist-app' });
      expect(existingRunId).toBe('run-replay');
      return { acceptanceId: existingRunId!, start: async () => {
        launches.push(existingRunId!);
        await store.append({ ...accepted, state: 'building', runId: existingRunId!, at: '2026-11-09T01:02:00.000Z' });
      } };
    });
    expect(launches).toEqual(['run-replay']);
    expect(log.map(event => event.state)).toEqual(['suggested', 'approved', 'building']);
    await store.append({ ...accepted, state: 'released', at: '2026-11-09T01:03:00.000Z' });
    await recoverBoardApprovals(store, async () => { throw new Error('terminal run must not replay'); });
  });

  test('durable acceptance precedes graph progress and prevents duplicate start', async () => {
    const { store, log } = storeFixture([events[0]!]);
    let starts = 0;
    const deps = { store, resolveOwner: async () => ({ memberId: 'member-a', appSlug: 'kaist-app' }),
      dispatchApproved: async () => ({ acceptanceId: 'run-once', start: async () => {
        starts += 1;
        await store.append({ ...events[0]!, state: 'building', runId: 'run-once', at: '2026-11-09T02:00:01.000Z' });
      } }), now: () => Date.parse('2026-11-09T02:00:00.000Z') };
    const first = await handleBoardRoute(request('/v1/board/card-a/approve', 'POST', { decision: 'approved' }), '/v1/board/card-a/approve', deps);
    expect(first?.status).toBe(202);
    const again = await handleBoardRoute(request('/v1/board/card-a/approve', 'POST', { decision: 'approved' }), '/v1/board/card-a/approve', deps);
    expect(again?.status).toBe(409);
    for (let attempt = 0; attempt < 10 && log.length < 3; attempt += 1) await Bun.sleep(0);
    expect(starts).toBe(1);
    expect(log.map(event => event.state)).toEqual(['suggested', 'approved', 'building']);
    expect(log[1]?.acceptanceId).toBe('run-once');
  });

  test('async graph start rejection records failed with the accepted run id', async () => {
    const { store, log } = storeFixture([events[0]!]);
    const response = await handleBoardRoute(request('/v1/board/card-a/approve', 'POST', { decision: 'approved' }), '/v1/board/card-a/approve', {
      store, resolveOwner: async () => ({ memberId: 'member-a', appSlug: 'kaist-app' }),
      dispatchApproved: async () => ({ acceptanceId: 'run-failed', start: async () => { throw new Error('private graph error'); } }),
    });
    expect(response?.status).toBe(202);
    for (let attempt = 0; attempt < 10 && log.length < 3; attempt += 1) await Bun.sleep(0);
    expect(log.map(event => event.state)).toEqual(['suggested', 'approved', 'failed']);
    expect(log.at(-1)?.acceptanceId).toBe('run-failed');
    expect(JSON.stringify(log)).not.toContain('private graph error');
  });

  test('failed harness acceptance records a retryable failed card in the same journal', async () => {
    const { store, log } = storeFixture([events[0]!]);
    const response = await handleBoardRoute(request('/v1/board/card-a/approve', 'POST', { decision: 'approved' }), '/v1/board/card-a/approve', {
      store, resolveOwner: async () => ({ memberId: 'member-a', appSlug: 'kaist-app' }),
      dispatchApproved: async () => { throw new Error('private harness error'); },
    });
    expect(response?.status).toBe(503);
    expect(await response!.json()).toMatchObject({ error: 'harness-dispatch-failed' });
    expect(log.map(event => event.state)).toEqual(['suggested', 'failed']);
    expect(JSON.stringify(log)).not.toContain('private harness error');
    const retry = await handleBoardRoute(request('/v1/board/card-a/approve', 'POST', { decision: 'approved' }), '/v1/board/card-a/approve', {
      store, resolveOwner: async () => ({ memberId: 'member-a', appSlug: 'kaist-app' }),
      dispatchApproved: async () => ({ acceptanceId: 'accept-retry', start: async () => undefined }),
    });
    expect(retry?.status).toBe(202);
    expect(log.at(-1)).toMatchObject({ state: 'approved', acceptanceId: 'accept-retry' });
    const duplicate = await handleBoardRoute(request('/v1/board/card-a/approve', 'POST', { decision: 'approved' }), '/v1/board/card-a/approve', {
      store, resolveOwner: async () => ({ memberId: 'member-a', appSlug: 'kaist-app' }),
      dispatchApproved: async () => { throw new Error('must not dispatch twice'); },
    });
    expect(duplicate?.status).toBe(409);
  });

  test('transient failed-event append is retried before reporting dispatch failure', async () => {
    const { store, log } = storeFixture([events[0]!]);
    const append = store.append;
    let failedWrites = 0;
    store.append = async event => {
      if ((event as BoardCardEvent).state === 'failed' && failedWrites++ === 0) throw new Error('temporary store fault');
      await append(event);
    };
    const response = await handleBoardRoute(request('/v1/board/card-a/approve', 'POST', { decision: 'approved' }), '/v1/board/card-a/approve', {
      store, resolveOwner: async () => ({ memberId: 'member-a', appSlug: 'kaist-app' }),
      dispatchApproved: async () => { throw new Error('private launch fault'); },
    });
    expect(response?.status).toBe(503);
    expect(failedWrites).toBe(2);
    expect(log.at(-1)?.state).toBe('failed');
  });

  test('graph route fails closed when runtime capability providers are absent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'board-graph-provider-'));
    mkdirSync(join(root, 'kaist-app'));
    try {
      const dispatch = createBoardApprovalDispatch({ appsRoot: root });
      await expect(dispatch(events[1]!, { memberId: 'member-a', appSlug: 'kaist-app' }))
        .rejects.toThrow('absorb graph capability providers are unavailable');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('plugin dispatch does not produce progress; graph journal events project attachments', async () => {
    const root = mkdtempSync(join(tmpdir(), 'board-graph-owned-'));
    mkdirSync(join(root, 'kaist-app'));
    try {
      const { store, log } = storeFixture([events[1]!]);
      const dispatch = createBoardApprovalDispatch({ appsRoot: root,
        createRunId: () => 'accept-graph-owned',
        runGraph: async () => ({ status: 'done' }) as never,
      });
      await dispatch(events[1]!, { memberId: 'member-a', appSlug: 'kaist-app' });
      expect(log.map(event => event.state)).toEqual(['approved']);
      const attachment = { kind: 'diagram' as const, title: '구성도', url: 'https://example.test/diagram.svg', mime: 'image/svg+xml', sha256: 'a'.repeat(64), producedBy: 'absorb-build' };
      await store.append({ ...events[1]!, state: 'testing', attachments: [attachment], at: '2026-11-09T01:06:00.000Z' });
      const response = await handleBoardRoute(request('/v1/board'), '/v1/board', { store, resolveOwner: async () => ({ memberId: 'member-a' }) });
      expect((await response!.json() as { cards: Array<{ attachments: unknown[] }> }).cards[0]?.attachments).toEqual([attachment]);
      expect(boardCardNexusEvent(log.at(-1))?.detail?.attachments).toEqual([attachment]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a card cannot be approved again after its history already contains approval', async () => {
    const history: BoardCardEvent[] = [
      { ...events[0]!, state: 'suggested' },
      { ...events[0]!, state: 'approved', at: '2026-11-09T01:01:00.000Z' },
      { ...events[0]!, state: 'suggested', at: '2026-11-09T01:02:00.000Z' },
    ];
    const { store, log } = storeFixture(history);
    const response = await handleBoardRoute(request('/v1/board/card-a/approve', 'POST', { decision: 'approved' }), '/v1/board/card-a/approve', {
      store, resolveOwner: async () => ({ memberId: 'member-a' }),
    });
    expect(response?.status).toBe(409);
    expect(log).toHaveLength(3);
  });

  test('approval uses journal order when a later graph state has an earlier timestamp', async () => {
    const history: BoardCardEvent[] = [
      { ...events[0]!, state: 'suggested', at: '2026-11-09T02:00:00.000Z' },
      { ...events[0]!, state: 'building', at: '2026-11-09T01:59:00.000Z' },
    ];
    const { store, log } = storeFixture(history);
    const response = await handleBoardRoute(request('/v1/board/card-a/approve', 'POST', { decision: 'approved' }), '/v1/board/card-a/approve', {
      store, resolveOwner: async () => ({ memberId: 'member-a' }),
    });
    expect(response?.status).toBe(409);
    expect(log).toHaveLength(2);
  });

  test('board routes and store.events@1 share the same injected JSONL journal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nexus-board-store-wire-'));
    try {
      const store = createJsonlMemberEventStore(root);
      const registry = createNexusCapabilityRegistry(store);
      const observed: unknown[] = [];
      store.subscribe(event => observed.push(event));
      await store.append(events[0]!);
      const deps = { store, resolveOwner: async () => ({ memberId: 'member-a' }), now: () => Date.parse('2026-11-09T02:00:00Z') };
      const listed = await handleBoardRoute(request('/v1/board'), '/v1/board', deps);
      expect(listed?.status).toBe(200);
      expect((await listed!.json() as { cards: Array<{ id: string; state: string }> }).cards).toMatchObject([{ id: 'card-a', state: 'proposed' }]);

      const approved = await handleBoardRoute(request('/v1/board/card-a/approve', 'POST', { decision: 'approved' }), '/v1/board/card-a/approve', deps);
      expect(approved?.status).toBe(200);
      const queried = await dispatchGraphContract('store.events@1', {
        graphId: 'board-route-sim', runId: 'board-route-sim', nodeId: 'store',
        input: { operation: 'query', memberId: 'member-a', type: 'board.card' }, outputs: {},
      }, registry);
      expect(queried).toMatchObject({ ok: true, result: { events: [
        { cardId: 'card-a', state: 'suggested' }, { cardId: 'card-a', state: 'approved' },
      ] } });
      const progress = await dispatchGraphContract('store.events@1', {
        graphId: 'absorb-build', runId: 'build-run-1', nodeId: 'board-testing',
        input: { operation: 'append', memberId: 'member-a', event: { ...events[0], state: 'testing', runId: 'build-run-1', at: '2026-11-09T02:01:00.000Z' } }, outputs: {},
      }, registry);
      expect(progress).toMatchObject({ ok: true, outcome: 'ok', result: { appended: true } });
      expect(observed.at(-1)).toMatchObject({ cardId: 'card-a', state: 'testing', memberId: 'member-a', runId: 'build-run-1' });
      const progressedBoard = await handleBoardRoute(request('/v1/board'), '/v1/board', deps);
      expect((await progressedBoard!.json() as { cards: Array<{ id: string; state: string; runId: string }> }).cards)
        .toMatchObject([{ id: 'card-a', state: 'testing', runId: 'build-run-1' }]);
      expect(observed.map(event => (event as { state?: string }).state)).toEqual(['suggested', 'approved', 'testing']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('rejects absent or negative human confirmation and malformed event values', async () => {
    const { store, log } = storeFixture([events[0]!]);
    const deps = { store, resolveOwner: async () => ({ memberId: 'member-a' }) };
    const rejected = await handleBoardRoute(request('/v1/board/card-a/approve', 'POST', { decision: 'rejected' }), '/v1/board/card-a/approve', deps);
    expect(rejected).toBeDefined();
    expect(rejected!.status).toBe(400);
    expect(log).toHaveLength(1);
    const unauthorized = await handleBoardRoute(request('/v1/board/card-a/approve', 'POST', { decision: 'approved' }), '/v1/board/card-a/approve', { ...deps, resolveOwner: async () => null });
    expect(unauthorized).toBeDefined();
    expect(unauthorized!.status).toBe(401);
    const malformed = await handleBoardRoute(request('/v1/board'), '/v1/board', { ...deps, store: {
      query: async () => [{ ...events[0], memberId: 7 }], append: async () => {},
    } });
    expect(malformed).toBeDefined();
    expect(malformed!.status).toBe(200);
  });

  test('cookie approval rejects cross-origin and non-JSON requests', async () => {
    const { store, log } = storeFixture([events[0]!]);
    const deps = { store, resolveOwner: async () => ({ memberId: 'member-a' }) };
    const crossOrigin = await handleBoardRoute(new Request('https://nexus.test/v1/board/card-a/approve', {
      method: 'POST', headers: { cookie: 'member-session=valid', origin: 'https://evil.test', 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approved' }),
    }), '/v1/board/card-a/approve', deps);
    expect(crossOrigin?.status).toBe(403);
    const textPlain = await handleBoardRoute(new Request('https://nexus.test/v1/board/card-a/approve', {
      method: 'POST', headers: { cookie: 'member-session=valid', origin: 'https://nexus.test', 'content-type': 'text/plain' },
      body: JSON.stringify({ decision: 'approved' }),
    }), '/v1/board/card-a/approve', deps);
    expect(textPlain?.status).toBe(415);
    expect(log).toHaveLength(1);
  });

  test('approval authenticates before reading a body and enforces the streaming byte limit', async () => {
    const { store, log } = storeFixture([events[0]!]);
    let consumed = false;
    const unauthorizedRequest = new Request('https://nexus.test/v1/board/card-a/approve', {
      method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '5000' },
      body: new ReadableStream<Uint8Array>({ pull(controller) { consumed = true; controller.enqueue(new Uint8Array(5_000)); controller.close(); } }, { highWaterMark: 0 }),
    });
    const unauthorized = await handleBoardRoute(unauthorizedRequest, '/v1/board/card-a/approve', {
      store, resolveOwner: async () => null,
    });
    expect(unauthorized?.status).toBe(401);
    expect(consumed).toBe(false);

    const oversized = await handleBoardRoute(request('/v1/board/card-a/approve', 'POST', { decision: 'approved', extra: 'x'.repeat(5_000) }), '/v1/board/card-a/approve', {
      store, resolveOwner: async () => ({ memberId: 'member-a' }),
    });
    expect(oversized?.status).toBe(413);
    expect(log).toHaveLength(1);
  });
});
