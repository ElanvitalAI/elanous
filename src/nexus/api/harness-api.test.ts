import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GoalRunRecord } from '../../self-implement/goal-run-store.js';
import { readReportOrigin } from '../../self-implement/report-origin.js';
import { LogStore } from '../../mss/logging/log-store.js';
import {
  handleHarnessRunScreenGet,
  handleHarnessAskPost,
  handleHarnessAskStatusGet,
  rememberAcceptedAsk,
  observeHarnessCorrelation,
  queryHarnessAskLifecycle,
  handleHarnessRunEventsGet,
  handleHarnessRunsGet,
  handleHarnessStopPost,
  collectFinishedRuns,
  listLandedPrs,
  _resetLandedPrsCacheForTest,
} from './harness-api.js';

const request = (path: string, body?: unknown) => new Request(`http://nexus.test${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const goalRun = (
  runId: string,
  record: Pick<GoalRunRecord['record'], 'correlationId' | 'completedAt' | 'stage' | 'outcome' | 'ok'>,
): GoalRunRecord => ({
  id: 1,
  runId,
  goalId: 'goal-1',
  goalFile: '/tmp/GOAL.md',
  record: record as GoalRunRecord['record'],
});

describe('harness API handlers', () => {
  test('ask returns 202 before authoring settles, then invokes shared authoring and detached launch', async () => {
    const askCalls: unknown[] = [];
    const launchCalls: unknown[] = [];
    const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
    const feedback: unknown[] = [];
    let settleAsk: (result: unknown) => void = () => {};
    const askPending = new Promise<unknown>((resolve) => { settleAsk = resolve; });
    const response = await handleHarnessAskPost(request('/v1/harness/ask', { text: '대상 경로: src/x.ts', sessionId: 'chat-session-1' }), {}, {
      createAcceptanceId: () => 'accept-1',
      createFeedbackEmitter: (acceptanceId) => (env) => { feedback.push({ acceptanceId, env }); },
      log: (event, data) => logs.push({ event, data }),
      runAskLaunchFlow: async (input) => {
        askCalls.push(input);
        return await askPending as never;
      },
      launchDevGoalFileDetached: async (input) => { launchCalls.push(input); },
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true, acceptanceId: 'accept-1', entrance: 'daemon-harness-ask' });
    await Bun.sleep(0);
    expect(askCalls).toHaveLength(1);
    expect(askCalls[0]).toMatchObject({ askText: '대상 경로: src/x.ts', inputSource: 'say', entrance: { id: 'daemon-harness-ask' } });
    expect(launchCalls).toEqual([]);

    settleAsk({ kind: 'launch', goalFile: '/tmp/GOAL.md' });
    await Bun.sleep(0);
    expect(launchCalls).toEqual([{ goalFile: '/tmp/GOAL.md', correlation: 'accept-1' }]);
    expect(feedback).toHaveLength(1);
    expect(feedback[0]).toMatchObject({
      acceptanceId: 'accept-1',
      env: {
        kind: 'tool.progress',
        sessionId: 'chat-session-1',
        blockId: 'accept-1:harness-ask',
        phase: 'end',
        payload: { stream: 'generic', lines: ['Harness ask launched: /tmp/GOAL.md'] },
      },
    });
    expect(logs).toEqual([
      { event: 'ask-accepted', data: { acceptanceId: 'accept-1', textLength: 15 } },
      { event: 'ask-flow-settled', data: { acceptanceId: 'accept-1', kind: 'launch' } },
      { event: 'ask-launch-started', data: { acceptanceId: 'accept-1', goalFile: '/tmp/GOAL.md' } },
      { event: 'ask-launch-settled', data: { acceptanceId: 'accept-1', goalFile: '/tmp/GOAL.md' } },
    ]);

    const invalid = await handleHarnessAskPost(request('/v1/harness/ask', {}), {}, {});
    expect(invalid.status).toBe(400);
    expect((await invalid.json() as { error: string }).error).toContain('usage: POST /v1/harness/ask');

    const nullBody = await handleHarnessAskPost(request('/v1/harness/ask', null), {}, {});
    expect(nullBody.status).toBe(400);
    expect((await nullBody.json() as { error: string }).error).toContain('usage: POST /v1/harness/ask');
  });

  test('ask forwards a valid origin only in the detached launch environment; ignores unknown shapes', async () => {
    const origin = { channel: 'telegram' as const, chatId: -100123, botId: 'bot-1', threadId: 7 };
    const launches: Array<{ env?: Record<string, string> }> = [];
    const logs: string[] = [];
    for (const supplied of [origin, undefined, { channel: 'telegram', chatId: 'not-a-number' }]) {
      const body = supplied === undefined ? { text: 'ask' } : { text: 'ask', origin: supplied };
      const response = await handleHarnessAskPost(request('/v1/harness/ask', body), {}, {
        log: (event) => { logs.push(event); },
        runAskLaunchFlow: async () => ({ kind: 'launch', goalFile: '/tmp/GOAL.md' }) as never,
        launchDevGoalFileDetached: async (input) => { launches.push(input); },
      });
      expect(response.status).toBe(202);
      await Bun.sleep(0);
    }
    expect(readReportOrigin(launches[0]!.env ?? {})).toEqual(origin);
    expect(launches[1]).not.toHaveProperty('env');
    expect(launches[2]).not.toHaveProperty('env');
    expect(logs.filter((event) => event === 'ask-origin-ignored')).toHaveLength(1);
  });

  test('ask forwards a Discord origin (the shape discord-seat-work sends) instead of logging invalid-origin (EV12b)', async () => {
    const origin = { channel: 'discord' as const, channelId: '123456789012345678', discordThreadId: '987654321098765432' };
    const launches: Array<{ env?: Record<string, string> }> = [];
    const logs: string[] = [];
    const response = await handleHarnessAskPost(request('/v1/harness/ask', { text: 'ask', origin }), {}, {
      log: (event) => { logs.push(event); },
      runAskLaunchFlow: async () => ({ kind: 'launch', goalFile: '/tmp/GOAL.md' }) as never,
      launchDevGoalFileDetached: async (input) => { launches.push(input); },
    });
    expect(response.status).toBe(202);
    await Bun.sleep(0);
    expect(logs).not.toContain('ask-origin-ignored');
    expect(readReportOrigin(launches[0]!.env ?? {})).toEqual(origin);
  });

  test('ask emits an empty sessionId without changing the accepted response when omitted', async () => {
    const feedback: unknown[] = [];
    const response = await handleHarnessAskPost(request('/v1/harness/ask', { text: 'ask' }), {}, {
      createAcceptanceId: () => 'accept-omitted',
      createFeedbackEmitter: () => (env) => { feedback.push(env); },
      runAskLaunchFlow: async () => ({ kind: 'stopped' }) as never,
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true, acceptanceId: 'accept-omitted', entrance: 'daemon-harness-ask' });
    await Bun.sleep(0);
    expect(feedback).toHaveLength(1);
    expect(feedback[0]).toMatchObject({
      kind: 'tool.progress',
      sessionId: '',
      blockId: 'accept-omitted:harness-ask',
      phase: 'end',
    });
  });

  test('ask validates target before acceptance and forwards an allowed target only to detached launch', async () => {
    for (const [target, status] of [
      ['/etc', 'outside-home'],
      [`${process.cwd()}/missing-harness-target`, 'missing'],
    ]) {
      let askCalls = 0;
      let launchCalls = 0;
      const rejected = await handleHarnessAskPost(request('/v1/harness/ask', { text: 'ask', target }), {}, {
        runAskLaunchFlow: async () => { askCalls += 1; return { kind: 'launch', goalFile: '/tmp/GOAL.md' } as never; },
        launchDevGoalFileDetached: async () => { launchCalls += 1; },
      });
      expect(rejected.status).toBe(400);
      expect((await rejected.json() as { error: string }).error).toContain(status);
      await Bun.sleep(0);
      expect(askCalls).toBe(0);
      expect(launchCalls).toBe(0);
    }

    for (const target of [42, {}, null]) {
      let askCalls = 0;
      let launchCalls = 0;
      const invalid = await handleHarnessAskPost(request('/v1/harness/ask', { text: 'ask', target }), {}, {
        runAskLaunchFlow: async () => { askCalls += 1; return { kind: 'launch', goalFile: '/tmp/GOAL.md' } as never; },
        launchDevGoalFileDetached: async () => { launchCalls += 1; },
      });
      expect(invalid.status).toBe(400);
      expect((await invalid.json() as { error: string }).error).toContain('target must be a string');
      await Bun.sleep(0);
      expect(askCalls).toBe(0);
      expect(launchCalls).toBe(0);
    }

    // The allowed target is «inside home». process.cwd() is outside home when the suite runs
    // from a worktree under /tmp or /private/tmp (harness worktrees, CI) — use a directory
    // that is inside home wherever the suite runs.
    const allowed = mkdtempSync(join(homedir(), '.elanous-harness-target-'));
    try {
      const launchCalls: unknown[] = [];
      const response = await handleHarnessAskPost(request('/v1/harness/ask', { text: 'ask', target: allowed }), {}, {
        runAskLaunchFlow: async () => ({ kind: 'launch', goalFile: '/tmp/GOAL.md' }) as never,
        launchDevGoalFileDetached: async (input) => { launchCalls.push(input); },
      });
      expect(response.status).toBe(202);
      await Bun.sleep(0);
      expect(launchCalls).toEqual([{ goalFile: '/tmp/GOAL.md', correlation: expect.any(String), target: allowed }]);
    } finally { rmSync(allowed, { recursive: true, force: true }); }
  });

  test('ask logs background failures without changing accepted response', async () => {
    const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
    const response = await handleHarnessAskPost(request('/v1/harness/ask', { text: 'ask' }), {}, {
      log: (event, data) => logs.push({ event, data }),
      runAskLaunchFlow: async () => { throw new Error('author failed'); },
    });
    expect(response.status).toBe(202);
    await Bun.sleep(0);
    expect(logs.find(({ event }) => event === 'ask-launch-failed')).toMatchObject({ data: { message: 'author failed' } });
  });

  test('keeps successful and failed ask outcomes separate from synchronous and asynchronous feedback failures', async () => {
    for (const [outcome, emit] of [
      ['success', () => { throw new Error('sync feedback failed'); }],
      ['failure', () => Promise.reject(new Error('async feedback failed'))],
    ] as const) {
      const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
      const response = await handleHarnessAskPost(request('/v1/harness/ask', { text: 'ask' }), {}, {
        log: (event, data) => logs.push({ event, data }),
        createFeedbackEmitter: () => emit,
        runAskLaunchFlow: async () => {
          if (outcome === 'failure') throw new Error('author failed');
          return { kind: 'launch', goalFile: '/tmp/GOAL.md' } as never;
        },
        launchDevGoalFileDetached: async () => {},
      });

      expect(response.status).toBe(202);
      await Bun.sleep(0);
      expect(logs.filter(({ event }) => event === 'ask-feedback-failed')).toHaveLength(1);
      expect(logs.filter(({ event }) => event === 'ask-launch-failed')).toHaveLength(outcome === 'failure' ? 1 : 0);
      expect(logs.some(({ event }) => event === 'ask-launch-settled')).toBe(outcome === 'success');
    }
  });

  test('queries only valid lifecycle rows for one acceptanceId in chronological order', () => {
    const acceptanceId = 'accept-1';
    const store = {
      query: (query: unknown) => {
        expect(query).toEqual({
          exactCategories: ['harness-http'],
          events: ['ask-accepted', 'ask-flow-settled', 'ask-launch-started', 'ask-launch-settled', 'ask-launch-failed'],
          grep: acceptanceId,
          limit: 100,
        });
        return [
          { id: 3, ts: '3', ts_ms: 20, event: 'ask-launch-settled', data: JSON.stringify({ acceptanceId }) },
          { id: 2, ts: '2', ts_ms: 10, event: 'ask-flow-settled', data: JSON.stringify({ acceptanceId }) },
          { id: 1, ts: '1', ts_ms: 10, event: 'ask-accepted', data: JSON.stringify({ acceptanceId }) },
          { id: 4, ts: '4', ts_ms: 30, event: 'ask-launch-failed', data: JSON.stringify({ acceptanceId: 'another-acceptance' }) },
          { id: 5, ts: '5', ts_ms: 40, event: 'ask-accepted', data: '{invalid json' },
        ];
      },
    } as never;

    expect(queryHarnessAskLifecycle(store, acceptanceId).map(({ row }) => row.id)).toEqual([1, 2, 3]);
  });

  test('ask status returns accepted for an issued ID before its log is flushed while preserving unknown-ID 404', async () => {
    const acceptanceId = 'accept-unflushed';
    const accepted = await handleHarnessAskPost(request('/v1/harness/ask', { text: 'ask' }), {}, {
      createAcceptanceId: () => acceptanceId,
      runAskLaunchFlow: async () => ({ kind: 'stopped' }) as never,
    });
    expect(accepted.status).toBe(202);

    const status = handleHarnessAskStatusGet(new Request(`http://nexus.test/v1/harness/ask-status?acceptanceId=${acceptanceId}`), {}, {
      askStatusLogStore: { query: () => [] } as never,
    });
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ acceptanceId, phase: 'accepted', elapsedSeconds: expect.any(Number) });

    const missing = handleHarnessAskStatusGet(new Request('http://nexus.test/v1/harness/ask-status?acceptanceId=unknown-never-issued'), {}, {
      askStatusLogStore: { query: () => [] } as never,
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'harness ask not found', acceptanceId: 'unknown-never-issued' });
  });

  test('ask status evicts the oldest accepted ID at the bounded registry limit and prefers persisted lifecycle logs', async () => {
    const oldest = 'accept-bounded-oldest';
    rememberAcceptedAsk(oldest);
    let newest = oldest;
    for (let index = 0; index < 1_000; index += 1) {
      newest = `accept-bounded-${index}`;
      rememberAcceptedAsk(newest);
    }

    const evicted = handleHarnessAskStatusGet(new Request(`http://nexus.test/v1/harness/ask-status?acceptanceId=${oldest}`), {}, {
      askStatusLogStore: { query: () => [] } as never,
    });
    expect(evicted.status).toBe(404);

    const logged = handleHarnessAskStatusGet(new Request(`http://nexus.test/v1/harness/ask-status?acceptanceId=${newest}`), {}, {
      askStatusLogStore: { query: () => [{
        id: 1,
        ts: '2026-09-14T00:00:00.000Z',
        ts_ms: Date.now() - 1_000,
        event: 'ask-launch-settled',
        data: JSON.stringify({ acceptanceId: newest }),
      }] } as never,
    });
    expect(logged.status).toBe(200);
    expect(await logged.json()).toMatchObject({ acceptanceId: newest, phase: 'launch-settled' });
  });

  test('ask status advances from accepted to launch-started and joins goalFile from the start event', async () => {
    const acceptanceId = 'accept-1';
    const rows = [
      { id: 3, ts: '2026-09-11T00:00:03.000Z', ts_ms: Date.now() - 2_000, event: 'ask-launch-started', data: JSON.stringify({ acceptanceId, goalFile: '/expected/GOAL.md' }) },
      { id: 2, ts: '2026-09-11T00:00:02.000Z', ts_ms: Date.now() - 3_000, event: 'ask-flow-settled', data: JSON.stringify({ acceptanceId, kind: 'launch' }) },
      { id: 1, ts: '2026-09-11T00:00:01.000Z', ts_ms: Date.now() - 4_000, event: 'ask-accepted', data: JSON.stringify({ acceptanceId, textLength: 3 }) },
    ];
    const askStatusLogStore = {
      query: (query: unknown) => {
        const category = (query as { exactCategories: string[] }).exactCategories[0];
        expect(query).toMatchObject({ exactCategories: [category], grep: acceptanceId });
        return category === 'harness-http' ? rows : [];
      },
    } as never;
    const accepted = handleHarnessAskStatusGet(new Request(`http://nexus.test/v1/harness/ask-status?acceptanceId=${acceptanceId}`), {}, {
      askStatusLogStore: { query: () => [rows[2]] } as never,
    });
    expect(await accepted.json()).toMatchObject({ acceptanceId, phase: 'accepted', elapsedSeconds: expect.any(Number) });

    const noStartLogs = { queryByDataKeys: () => [] } as never;
    const runId = 'run-1';
    const started = handleHarnessAskStatusGet(new Request(`http://nexus.test/v1/harness/ask-status?acceptanceId=${acceptanceId}`), {}, {
      askStatusLogStore,
      askStatusRunLogStore: noStartLogs,
      queryGoalRunsByCorrelation: (id) => {
        expect(id).toBe(acceptanceId);
        return [goalRun(runId, { correlationId: id, stage: 'merged', outcome: 'completed', ok: true })];
      },
    });
    expect(await started.json()).toMatchObject({ acceptanceId, phase: 'launch-started', goalFile: '/expected/GOAL.md', runId, elapsedSeconds: expect.any(Number) });
    const runEvents = handleHarnessRunEventsGet(new Request(`http://nexus.test/v1/harness/run-events?runId=${runId}`), {}, {
      logStore: { queryByDataKeys: (query: unknown) => {
        expect(query).toEqual({ exactCategories: ['self-implement'], runIds: [runId] });
        return [{ id: 1, ts: '2026-09-11T00:00:03.000Z', ts_ms: 1, event: 'headless.spawn' }];
      } } as never,
    });
    expect(await runEvents.json()).toEqual([{ ts: '2026-09-11T00:00:03.000Z', event: 'headless.spawn', runId }]);

    const unproved = handleHarnessAskStatusGet(new Request(`http://nexus.test/v1/harness/ask-status?acceptanceId=${acceptanceId}`), {}, {
      askStatusLogStore,
      askStatusRunLogStore: noStartLogs,
      queryGoalRunsByCorrelation: () => [],
    });
    expect(await unproved.json()).not.toHaveProperty('runId');
    const ambiguous = handleHarnessAskStatusGet(new Request(`http://nexus.test/v1/harness/ask-status?acceptanceId=${acceptanceId}`), {}, {
      askStatusLogStore,
      askStatusRunLogStore: noStartLogs,
      queryGoalRunsByCorrelation: () => [
        goalRun('run-a', { correlationId: acceptanceId, stage: 'merged', outcome: 'completed', ok: true }),
        goalRun('run-b', { correlationId: acceptanceId, stage: 'merged', outcome: 'completed', ok: true }),
      ],
    });
    expect(await ambiguous.json()).not.toHaveProperty('runId');

    const missing = handleHarnessAskStatusGet(new Request('http://nexus.test/v1/harness/ask-status?acceptanceId=unknown'), {}, {
      askStatusLogStore: { query: () => [] } as never,
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'harness ask not found', acceptanceId: 'unknown' });

    const invalid = handleHarnessAskStatusGet(new Request('http://nexus.test/v1/harness/ask-status'), {}, {});
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: 'usage: GET /v1/harness/ask-status?acceptanceId=<acceptanceId>' });
  });

  test('ask status falls back to one exact self-implement start correlation without overriding goal-run evidence', async () => {
    const acceptanceId = 'accept-start';
    const lifecycle = { id: 1, ts: '2026-09-11T00:00:01.000Z', ts_ms: Date.now() - 1_000, event: 'ask-accepted', data: JSON.stringify({ acceptanceId }) };
    const start = (id: number, data: unknown) => ({ id, ts: `2026-09-11T00:00:0${id}.000Z`, ts_ms: id, event: 'start', data: JSON.stringify(data) });
    const status = (startRows: readonly ReturnType<typeof start>[], goalRuns: readonly GoalRunRecord[] | null = []) => {
      const queries: unknown[] = [];
      const response = handleHarnessAskStatusGet(new Request(`http://nexus.test/v1/harness/ask-status?acceptanceId=${acceptanceId}`), {}, {
        askStatusLogStore: { query: (query: unknown) => {
          queries.push(query);
          return [lifecycle];
        } } as never,
        askStatusRunLogStore: { queryByDataKeys: (query: unknown) => {
          queries.push(query);
          return startRows;
        } } as never,
        queryGoalRunsByCorrelation: () => goalRuns,
      });
      return { response, queries };
    };

    const exact = status([
      start(2, { correlationId: acceptanceId, runId: 'run-from-start' }),
      start(3, { correlationId: acceptanceId, runId: 'run-from-start' }),
      start(4, { correlationId: 'other-acceptance', runId: 'wrong-correlation' }),
      { id: 5, ts: '2026-09-11T00:00:05.000Z', ts_ms: 5, event: 'start', data: '{invalid json' },
    ]);
    expect(await exact.response.json()).toMatchObject({ acceptanceId, runId: 'run-from-start' });
    expect(exact.queries).toEqual([
      { exactCategories: ['harness-http'], events: ['ask-accepted', 'ask-flow-settled', 'ask-launch-started', 'ask-launch-settled', 'ask-launch-failed'], grep: acceptanceId, limit: 100 },
      { exactCategories: ['self-implement'], correlationIds: [acceptanceId] },
    ]);

    const authoritative = status([start(2, { correlationId: acceptanceId, runId: 'run-from-start' })], [goalRun('run-from-goal', { correlationId: acceptanceId, stage: 'merged', outcome: 'completed', ok: true })]);
    expect(await authoritative.response.json()).toMatchObject({ acceptanceId, runId: 'run-from-goal' });
    expect(authoritative.queries).toHaveLength(1);

    const multipleGoalRuns = status([start(2, { correlationId: acceptanceId, runId: 'run-from-start' })], [
      goalRun('run-from-goal-a', { correlationId: acceptanceId, stage: 'merged', outcome: 'completed', ok: true }),
      goalRun('run-from-goal-b', { correlationId: acceptanceId, stage: 'merged', outcome: 'completed', ok: true }),
    ]);
    expect(await multipleGoalRuns.response.json()).not.toHaveProperty('runId');
    expect(multipleGoalRuns.queries).toHaveLength(1);

    const ambiguous = status([
      start(2, { correlationId: acceptanceId, runId: 'run-a' }),
      start(3, { correlationId: acceptanceId, runId: 'run-b' }),
    ]);
    expect(await ambiguous.response.json()).not.toHaveProperty('runId');
    const repeated = status(Array.from({ length: 100 }, (_, index) => start(index + 2, { correlationId: acceptanceId, runId: 'run-at-limit' })));
    expect(await repeated.response.json()).toMatchObject({ runId: 'run-at-limit' });
  });

  test('ask status uses all exact-correlation start logs from the store', async () => {
    const acceptanceId = 'accept-start-log';
    const lifecycleStore = {
      query: () => [{
        id: 1,
        ts: '2026-09-14T00:00:00.000Z',
        ts_ms: Date.now(),
        event: 'ask-launch-settled',
        data: JSON.stringify({ acceptanceId }),
      }],
    } as never;
    const statusRequest = new Request(`http://nexus.test/v1/harness/ask-status?acceptanceId=${acceptanceId}`);
    const startStore = new LogStore(':memory:');
    try {
      startStore.insertBatch(Array.from({ length: 100 }, (_, id) => ({
        rec: {
          ts: new Date(1_000 + id).toISOString(),
          category: 'self-implement',
          event: 'start',
          data: { correlationId: acceptanceId, runId: 'run-log' },
        },
        surface: 'nexus',
      })));
      startStore.insertBatch([{ rec: {
        ts: new Date(2_000).toISOString(),
        category: 'self-implement',
        event: 'start',
        data: { correlationId: 'other-acceptance', runId: 'run-ignored' },
      }, surface: 'nexus' }]);

      const unique = handleHarnessAskStatusGet(statusRequest, {}, {
        askStatusLogStore: lifecycleStore,
        askStatusRunLogStore: startStore,
        queryGoalRunsByCorrelation: () => [],
      });
      expect(await unique.json()).toMatchObject({ runId: 'run-log' });

      startStore.insertBatch([{ rec: {
        ts: new Date(3_000).toISOString(),
        category: 'self-implement',
        event: 'start',
        data: { correlationId: acceptanceId, runId: 'run-other' },
      }, surface: 'nexus' }]);
      const ambiguous = handleHarnessAskStatusGet(statusRequest, {}, {
        askStatusLogStore: lifecycleStore,
        askStatusRunLogStore: startStore,
        queryGoalRunsByCorrelation: () => [],
      });
      expect(await ambiguous.json()).not.toHaveProperty('runId');

      const goalRunPreferred = handleHarnessAskStatusGet(statusRequest, {}, {
        askStatusLogStore: lifecycleStore,
        askStatusRunLogStore: startStore,
        queryGoalRunsByCorrelation: () => [goalRun('run-goal', { correlationId: acceptanceId, stage: 'merged', outcome: 'completed', ok: true })],
      });
      expect(await goalRunPreferred.json()).toMatchObject({ runId: 'run-goal' });
    } finally {
      startStore.close();
    }
  });

  test('correlation observer refuses shared or missing candidates rather than fixing an unproved run', async () => {
    const sharedCandidate = goalRun('run-shared', { stage: 'pr-opened', outcome: 'completed', ok: true });
    for (const acceptanceId of ['accept-a', 'accept-b']) {
      const observations = await Array.fromAsync(observeHarnessCorrelation(acceptanceId, {
        queryGoalRuns: () => [],
        queryRunEvents: () => { throw new Error('unproved ownership must not query events'); },
      }));
      expect(observations).toEqual([{ kind: 'ownership-unproven', acceptanceId, reason: 'no-matching-run', candidateCount: 0 }]);
    }
    const multiple = await Array.fromAsync(observeHarnessCorrelation('accept-many', {
      queryGoalRuns: () => [sharedCandidate, { ...sharedCandidate, runId: 'run-other' }],
      queryRunEvents: () => { throw new Error('ambiguous ownership must not query events'); },
    }));
    expect(multiple).toEqual([{ kind: 'ownership-unproven', acceptanceId: 'accept-many', reason: 'multiple-matching-runs', candidateCount: 2 }]);
  });

  test('correlation observer fixes one matching run, emits new ordered progress, and terminates once', async () => {
    const events = [
      { id: 1, ts: '2026-09-12T00:00:01.000Z', event: 'headless.spawn' },
      { id: 2, ts: '2026-09-12T00:00:02.000Z', event: 'implemented' },
    ];
    let recordReads = 0;
    let eventReads = 0;
    const observations = await Array.fromAsync(observeHarnessCorrelation('accept-one', {
      queryGoalRuns: (acceptanceId) => {
        expect(acceptanceId).toBe('accept-one');
        recordReads += 1;
        return [goalRun('run-one', {
          correlationId: acceptanceId,
          ...(recordReads > 2 ? { completedAt: '2026-09-12T00:00:03.000Z' } : {}),
          stage: 'merged', outcome: 'completed', ok: true,
        })];
      },
      queryRunEvents: (runId) => {
        expect(runId).toBe('run-one');
        eventReads += 1;
        return eventReads === 1 ? events : [...events, { id: 3, ts: '2026-09-12T00:00:03.000Z', event: 'gate.baseline' }];
      },
    }));
    expect(observations).toEqual([
      { kind: 'run-fixed', acceptanceId: 'accept-one', runId: 'run-one' },
      { kind: 'progress', acceptanceId: 'accept-one', runId: 'run-one', event: events[0].event, ts: events[0].ts },
      { kind: 'progress', acceptanceId: 'accept-one', runId: 'run-one', event: events[1].event, ts: events[1].ts },
      { kind: 'progress', acceptanceId: 'accept-one', runId: 'run-one', event: 'gate.baseline', ts: '2026-09-12T00:00:03.000Z' },
      { kind: 'terminal', acceptanceId: 'accept-one', runId: 'run-one', stage: 'merged', outcome: 'completed', ok: true },
    ]);
  });

  test('correlation observer stops at the finite polling limit when no terminal result arrives', async () => {
    let polls = 0;
    const observations = await Array.fromAsync(observeHarnessCorrelation('accept-pending', {
      queryGoalRuns: () => [goalRun('run-pending', { stage: 'aborted', outcome: 'abandoned', ok: false })],
      queryRunEvents: () => {
        polls += 1;
        return [];
      },
    }, 3));
    expect(polls).toBe(3);
    expect(observations).toEqual([
      { kind: 'run-fixed', acceptanceId: 'accept-pending', runId: 'run-pending' },
      { kind: 'poll-limit-reached', acceptanceId: 'accept-pending', runId: 'run-pending', maxPolls: 3 },
    ]);
  });

  test('runs preserves the shared structured observation', async () => {
    const shared = { entries: [], counts: { running: 0 }, total: 0 };
    const response = await handleHarnessRunsGet(new Request('http://nexus.test/v1/harness/runs'), {}, {
      queryRunningRuns: ((options: unknown) => {
        expect(options).toEqual({ includeTest: false });
        return shared;
      }) as never,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(shared);
  });

  test('runs with finishedSince adds terminated ledger summaries; without it the shape is unchanged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-finished-'));
    try {
      const line = (runId: string, timestamp: string, event: string, data: Record<string, unknown>) =>
        `${JSON.stringify({ timestamp, runId, event, data: { ...data, runId }, pieceTotal: 1 })}\n`;
      const since = Date.parse('2026-09-30T00:00:00.000Z');
      writeFileSync(join(dir, 'run-merged.jsonl'),
        line('run-merged', '2026-09-30T01:00:00.000Z', 'start', { feature: `  로그인 버튼이 안 눌린다 ${'x'.repeat(300)}` })
        + line('run-merged', '2026-09-30T01:20:00.000Z', 'pr-opened', { url: 'https://github.com/o/n/pull/42', number: 42 })
        + line('run-merged', '2026-09-30T01:21:00.000Z', 'merge-decision', { decision: 'auto', reason: 'ok' })
        + line('run-merged', '2026-09-30T01:25:00.000Z', 'merged', { number: 42, merged: true })
        + line('run-merged', '2026-09-30T01:26:00.000Z', 'run-status', { stage: 'merged', runStatus: 'completed' }));
      writeFileSync(join(dir, 'run-failed.jsonl'),
        line('run-failed', '2026-09-30T03:00:00.000Z', 'start', { feature: '검색 속도' })
        + line('run-failed', '2026-09-30T03:10:00.000Z', 'run-status', { stage: 'failed', runStatus: 'failed' }));
      writeFileSync(join(dir, 'run-live.jsonl'),
        line('run-live', '2026-09-30T04:00:00.000Z', 'start', { feature: '아직 도는 중' }));
      // 어제 끝났지만 파일이 오늘 만져진 런 — endedAt 이 창 밖이면 빠진다.
      writeFileSync(join(dir, 'run-yesterday.jsonl'),
        line('run-yesterday', '2026-09-29T10:00:00.000Z', 'run-status', { stage: 'failed', runStatus: 'failed' }));
      writeFileSync(join(dir, 'run-broken.jsonl'), '{not json}\n');
      writeFileSync(join(dir, 'notes.txt'), 'ignored');
      const shared = {
        entries: [
          { runId: 'run-live', status: 'running', ledgerDirectories: [dir] },
          { runId: 'run-unknown', status: 'running', ledgerDirectories: [] },
        ],
        counts: { running: 2 }, total: 2,
      };
      _resetLandedPrsCacheForTest();
      const deps = {
        queryRunningRuns: (() => shared) as never, ledgerDir: dir, log: () => {},
        landed: { repoSlug: async () => 'o/n', runGh: async () => ({ ok: true, exitCode: 0, stdout: '[]', stderr: '' }) },
      };

      const plain = handleHarnessRunsGet(new Request('http://nexus.test/v1/harness/runs'), {}, deps);
      expect(plain).toBeInstanceOf(Response);
      expect(await (plain as Response).json()).toEqual(shared);

      const response = await handleHarnessRunsGet(new Request(`http://nexus.test/v1/harness/runs?finishedSince=${since}`), {}, deps);
      expect(response.status).toBe(200);
      const body = await response.json() as { entries: unknown[]; finished: Array<Record<string, unknown>>; finishedObservation: Record<string, unknown>; landed: unknown[] };
      // 도는 항목에 원장 `start.feature` 가 붙는다 — 원장이 없으면 칸이 없다.
      expect(body.entries).toEqual([
        { runId: 'run-live', status: 'running', ledgerDirectories: [dir], objective: '아직 도는 중' },
        { runId: 'run-unknown', status: 'running', ledgerDirectories: [] },
      ]);
      expect(body.landed).toEqual([]);
      expect(body.finished.map((run) => run.runId)).toEqual(['run-failed', 'run-merged']);
      expect(body.finished[0]).toEqual({ runId: 'run-failed', status: 'failed', endedAt: '2026-09-30T03:10:00.000Z', stage: 'failed', objective: '검색 속도' });
      const merged = body.finished[1]!;
      expect(merged).toMatchObject({ status: 'completed', stage: 'merged', prUrl: 'https://github.com/o/n/pull/42', merged: true, mergeDecision: 'auto' });
      expect((merged.objective as string).startsWith('로그인 버튼이 안 눌린다')).toBe(true);
      expect((merged.objective as string).length).toBe(160);
      expect(body.finishedObservation).toMatchObject({ sinceMs: since, scannedFiles: 5, skippedFiles: 1, limit: 20 });

      const bad = await handleHarnessRunsGet(new Request('http://nexus.test/v1/harness/runs?finishedSince=soon'), {}, deps);
      expect(bad.status).toBe(400);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('landed lists PRs merged since the cutoff through the injected gh runner and caches 60s', async () => {
    _resetLandedPrsCacheForTest();
    const since = Date.parse('2026-09-29T15:00:00.000Z');
    const calls: string[][] = [];
    let now = Date.parse('2026-09-30T08:00:00.000Z');
    const landed = {
      repoSlug: async () => 'ElanvitalAI/elanous',
      now: () => now,
      runGh: async (args: string[]) => {
        calls.push(args);
        return {
          ok: true, exitCode: 0, stderr: '',
          stdout: JSON.stringify([
            { number: 22180, title: '오늘 착지 A', url: 'https://example.test/pull/22180', mergedAt: '2026-09-30T05:00:00Z' },
            { number: 22190, title: '오늘 착지 B', url: 'https://example.test/pull/22190', mergedAt: '2026-09-30T07:30:00Z' },
            { number: 22001, title: '어제', url: 'https://example.test/pull/22001', mergedAt: '2026-09-29T10:00:00Z' },
            { number: 'bad' },
          ]),
        };
      },
    };
    const deps = { queryRunningRuns: (() => ({ entries: [], counts: {}, total: 0 })) as never, ledgerDir: join(tmpdir(), 'missing-ledger-dir'), landed };
    const response = await handleHarnessRunsGet(new Request(`http://nexus.test/v1/harness/runs?finishedSince=${since}`), {}, deps);
    const body = await response.json() as { landed: Array<{ number: number }>; landedError?: string; finished: unknown[] };
    expect(body.landed.map((pr) => pr.number)).toEqual([22190, 22180]);
    expect(body.landedError).toBeUndefined();
    expect(body.finished).toEqual([]);
    expect(calls).toEqual([[
      'pr', 'list', '--repo', 'ElanvitalAI/elanous', '--state', 'merged', '--base', 'main',
      '--search', 'merged:>=2026-09-29T15:00:00Z', '--json', 'number,title,url,mergedAt', '--limit', '30',
    ]]);
    // 60초 안에는 gh 를 다시 부르지 않는다.
    now += 30_000;
    expect((await listLandedPrs(since, landed)).cached).toBe(true);
    now += 31_000;
    await listLandedPrs(since, landed);
    expect(calls).toHaveLength(2);
  });

  test('landed failures and timeouts become landedError, never a thrown error or a blocked response', async () => {
    _resetLandedPrsCacheForTest();
    const failed = await listLandedPrs(0, {
      repoSlug: async () => 'o/n',
      runGh: async () => ({ ok: false, exitCode: 4, stdout: '', stderr: 'HTTP 401: Bad credentials\nmore' }),
    });
    expect(failed).toEqual({ prs: [], error: 'gh failed rc=4: HTTP 401: Bad credentials' });
    expect(await listLandedPrs(0, { repoSlug: async () => null })).toEqual({ prs: [], error: 'no-repository' });
    expect((await listLandedPrs(0, { repoSlug: async () => 'o/n', runGh: async () => ({ ok: true, exitCode: 0, stdout: 'not json', stderr: '' }) })).prs).toEqual([]);
    const started = Date.now();
    const slow = await listLandedPrs(0, { repoSlug: async () => 'o/n', timeoutMs: 50, runGh: () => new Promise(() => {}) });
    expect(slow).toEqual({ prs: [], error: 'timeout 50ms' });
    expect(Date.now() - started).toBeLessThan(1_000);
    // 상한(30)만큼 오면 «더 있을 수 있다»를 표시한다.
    const full = Array.from({ length: 30 }, (_, i) => ({ number: i, title: `t${i}`, url: `https://example.test/pull/${i}`, mergedAt: '2026-09-30T05:00:00Z' }));
    const capped = await listLandedPrs(1, { repoSlug: async () => 'o/n', runGh: async () => ({ ok: true, exitCode: 0, stdout: JSON.stringify(full), stderr: '' }) });
    expect(capped.truncated).toBe(true);
    _resetLandedPrsCacheForTest();
    // 실패는 캐시하지 않는다 — 다음 요청이 다시 묻는다.
    let asked = 0;
    await listLandedPrs(0, { repoSlug: async () => 'o/n', runGh: async () => { asked += 1; return { ok: true, exitCode: 0, stdout: '[]', stderr: '' }; } });
    expect(asked).toBe(1);
  });

  test('finished runs are capped at 20 newest by endedAt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-finished-cap-'));
    try {
      for (let i = 0; i < 25; i += 1) {
        const runId = `run-${String(i).padStart(2, '0')}`;
        const ts = new Date(Date.parse('2026-09-30T00:00:00.000Z') + i * 60_000).toISOString();
        writeFileSync(join(dir, `${runId}.jsonl`), `${JSON.stringify({ timestamp: ts, runId, event: 'run-status', data: { runStatus: 'completed' } })}\n`);
      }
      const result = collectFinishedRuns(dir, 0);
      expect(result.runs).toHaveLength(20);
      expect(result.runs[0]!.runId).toBe('run-24');
      expect(result.runs.at(-1)!.runId).toBe('run-05');
      expect(collectFinishedRuns(join(dir, 'missing'), 0)).toEqual({ runs: [], scannedFiles: 0, skippedFiles: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('run events return only timestamp/id-ordered skeleton events for a run', async () => {
    const runId = 'run-1';
    const response = handleHarnessRunEventsGet(new Request(`http://nexus.test/v1/harness/run-events?runId=${runId}`), {}, {
      logStore: {
        queryByDataKeys: (query) => {
          expect(query).toEqual({ exactCategories: ['self-implement'], runIds: [runId] });
          return [
            { id: 6, ts: '2026-09-11T00:00:06.000Z', ts_ms: 6, event: 'poll.heartbeat' },
            { id: 4, ts: '2026-09-11T00:00:04.000Z', ts_ms: 4, event: 'headless.done' },
            { id: 7, ts: '2026-09-11T00:00:03.000Z', ts_ms: 3, event: 'run-terminal', data: JSON.stringify({ runStatus: 'failed', stage: 'failed', error: 'initial execute failure' }) },
            { id: 2, ts: '2026-09-11T00:00:02.000Z', ts_ms: 2, event: 'headless.progress' },
            { id: 3, ts: '2026-09-11T00:00:03.000Z', ts_ms: 3, event: 'implemented', data: JSON.stringify({ ok: true, round: 1 }) },
            { id: 8, ts: '2026-09-11T00:00:03.500Z', ts_ms: 3.5, event: 'implemented', data: JSON.stringify({ ok: false }) },
            { id: 9, ts: '2026-09-11T00:00:03.750Z', ts_ms: 3.75, event: 'implemented', data: JSON.stringify({ message: '구현 완료' }) },
            { id: 10, ts: '2026-09-11T00:00:03.875Z', ts_ms: 3.875, event: 'implemented', data: null },
            { id: 1, ts: '2026-09-11T00:00:01.000Z', ts_ms: 1, event: 'headless.spawn' },
            { id: 5, ts: '2026-09-11T00:00:05.000Z', ts_ms: 5, event: 'progress-delivery-outcome' },
          ] as never;
        },
      },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      { ts: '2026-09-11T00:00:01.000Z', event: 'headless.spawn', runId },
      { ts: '2026-09-11T00:00:03.000Z', event: 'implemented', runId, payload: { ok: true } },
      {
        ts: '2026-09-11T00:00:03.000Z',
        event: 'run-terminal',
        runId,
        payload: { runStatus: 'failed', stage: 'failed', error: 'initial execute failure' },
      },
      { ts: '2026-09-11T00:00:03.500Z', event: 'implemented', runId, payload: { ok: false } },
      { ts: '2026-09-11T00:00:03.875Z', event: 'implemented', runId },
      { ts: '2026-09-11T00:00:04.000Z', event: 'headless.done', runId },
    ]);

    const skeletonTerminal = handleHarnessRunEventsGet(new Request(`http://nexus.test/v1/harness/run-events?runId=${runId}`), {}, {
      logStore: {
        queryByDataKeys: () => [{ id: 8, ts: '2026-09-11T00:00:08.000Z', ts_ms: 8, event: 'run-terminal', data: null }] as never,
      },
    });
    expect(await skeletonTerminal.json()).toEqual([
      { ts: '2026-09-11T00:00:08.000Z', event: 'run-terminal', runId },
    ]);

    const noiseOnly = handleHarnessRunEventsGet(new Request(`http://nexus.test/v1/harness/run-events?runId=${runId}`), {}, {
      logStore: { queryByDataKeys: () => Array.from({ length: 6 }, (_, id) => ({ id, ts: String(id), ts_ms: id, event: 'headless.progress' })) as never },
    });
    expect(await noiseOnly.json()).toEqual([]);

    const beyondTwoHundred = handleHarnessRunEventsGet(new Request(`http://nexus.test/v1/harness/run-events?runId=${runId}`), {}, {
      logStore: {
        queryByDataKeys: () => Array.from({ length: 201 }, (_, index) => ({
          id: index + 1,
          ts: `2026-09-11T00:00:${String(index).padStart(2, '0')}.000Z`,
          ts_ms: index + 1,
          event: index === 200 ? 'headless.done' : 'implemented',
        })) as never,
      },
    });
    const allEvents = await beyondTwoHundred.json() as Array<{ ts: string; event: string; runId: string }>;
    expect(allEvents).toHaveLength(201);
    expect(allEvents[200]).toEqual({ ts: '2026-09-11T00:00:200.000Z', event: 'headless.done', runId });

    const invalid = handleHarnessRunEventsGet(new Request('http://nexus.test/v1/harness/run-events'), {}, {});
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: 'usage: GET /v1/harness/run-events?runId=<runId>' });
  });

  test('stop validates, lists candidates on missing screen, and enqueues a known screen', async () => {
    const screens = [{ spaceId: 'space-a', path: '/tmp/a.screen', mtimeMs: 1, bytes: 1 }];
    const missing = await handleHarnessStopPost(request('/v1/harness/stop', { spaceId: 'space-b' }), {}, {
      listHarnessScreens: () => screens,
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'harness screen not found', candidates: ['space-a'] });

    const stopped: string[] = [];
    const success = await handleHarnessStopPost(request('/v1/harness/stop', { spaceId: 'space-a' }), {}, {
      listHarnessScreens: () => screens,
      enqueueSoftStop: (spaceId) => { stopped.push(spaceId); },
    });
    expect(success.status).toBe(200);
    expect(await success.json()).toEqual({ stopped: 'space-a' });
    expect(stopped).toEqual(['space-a']);

    const invalid = await handleHarnessStopPost(request('/v1/harness/stop', {}), {}, {});
    expect(invalid.status).toBe(400);
    expect((await invalid.json() as { error: string }).error).toContain('usage: POST /v1/harness/stop');

    const nullBody = await handleHarnessStopPost(request('/v1/harness/stop', null), {}, {});
    expect(nullBody.status).toBe(400);
    expect((await nullBody.json() as { error: string }).error).toContain('usage: POST /v1/harness/stop');
  });

  test('run-screen: runId → screen key → redacted tail · reasons as values · stoppable only for a live screen', async () => {
    const screens = [{ spaceId: 'space-a', path: '/tmp/a.screen', mtimeMs: 1, bytes: 1 }];
    const secret = 'sk-or-v1-this-is-a-secret-value-with-long-random-chars';
    const res = handleHarnessRunScreenGet(new Request('http://nexus.test/v1/harness/run-screen?runId=run-1&lines=10'), {}, {
      queryRunScreenKey: () => ({ screenKey: 'space-a', logStoreStatus: 'read', lastEvent: null }),
      readHarnessScreenTail: (key, lines) => ({ text: `${key} ${lines} OPENROUTER_API_KEY=${secret}`, outcome: null, path: '/tmp/a.screen' }),
      listHarnessScreens: () => screens,
    });
    const body = await res.json() as { text: string; stoppable: boolean; screenKey: string };
    expect(res.status).toBe(200);
    expect(body.screenKey).toBe('space-a');
    expect(body.stoppable).toBe(true);
    expect(body.text).toContain('space-a 10');
    expect(body.text).not.toContain(secret);

    const noKey = await handleHarnessRunScreenGet(new Request('http://nexus.test/v1/harness/run-screen?runId=run-2'), {}, {
      queryRunScreenKey: () => ({ screenKey: null, logStoreStatus: 'read', lastEvent: { category: 'self-implement', event: 'x', timestamp: 't' } }),
    }).json() as { reason: string; stoppable: boolean };
    expect(noKey).toMatchObject({ reason: 'no-screen-key', stoppable: false });

    const gone = await handleHarnessRunScreenGet(new Request('http://nexus.test/v1/harness/run-screen?runId=run-3'), {}, {
      queryRunScreenKey: () => ({ screenKey: 'space-z', logStoreStatus: 'read', lastEvent: null }),
      readHarnessScreenTail: () => null,
      listHarnessScreens: () => screens,
    }).json() as { reason: string; stoppable: boolean };
    expect(gone).toMatchObject({ reason: 'screen-missing', stoppable: false });

    expect(handleHarnessRunScreenGet(new Request('http://nexus.test/v1/harness/run-screen?runId=../x'), {}, {}).status).toBe(400);
    expect(handleHarnessRunScreenGet(new Request('http://nexus.test/v1/harness/run-screen'), {}, {}).status).toBe(400);
  });
});
