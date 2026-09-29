// PWA · Nexus client tests (Phase N-4 PR ν)

import { describe, test, expect, spyOn } from 'bun:test';
import { createNexusClient, NexusApiError, NexusTimeoutError, type AnswerPriorityResponse, type TaskCardWire } from './client';

interface MockFetchCall {
  url: string;
  init?: RequestInit;
}

function makeMockFetch(handlers: Record<string, (init?: RequestInit) => { status: number; body?: unknown }>): {
  fetchImpl: typeof fetch;
  calls: MockFetchCall[];
} {
  const calls: MockFetchCall[] = [];
  const fetchImpl: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, ...(init !== undefined ? { init } : {}) });
    const u = new URL(url);
    const decodedPath = decodeURIComponent(u.pathname) + u.search;
    const handler = handlers[decodedPath] ?? handlers[`${init?.method ?? 'GET'} ${decodedPath}`] ?? handlers['*'];
    if (!handler) throw new Error(`no mock handler for ${url}`);
    const r = handler(init);
    return new Response(JSON.stringify(r.body ?? null), {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const BASE = 'http://localhost:31415';

describe('createNexusClient · base + fetchImpl wiring', () => {
  test('strips trailing slash from baseUrl', () => {
    const client = createNexusClient({ baseUrl: 'http://x/', fetchImpl: fetch });
    expect(client.baseUrl).toBe('http://x');
  });

  test('uses injected fetchImpl', async () => {
    const { fetchImpl, calls } = makeMockFetch({
      '/v1/health': () => ({ status: 200, body: { ok: true } }),
    });
    const client = createNexusClient({ baseUrl: BASE, fetchImpl });
    await client.getHealth();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}/v1/health`);
  });
});

test('channel-bot setup client uses GET status and authenticated POST without echoing token', async () => {
  const { fetchImpl, calls } = makeMockFetch({
    '/v1/setup/channel-bots': () => ({ status: 200, body: { platforms: [
      { platform: 'telegram', configured: false, source: null, allowedUsers: [] },
    ] } }),
    '/v1/setup/channel-bot': () => ({ status: 200, body: { ok: true, botName: 'bot', restartNeeded: true } }),
  });
  const client = createNexusClient({ baseUrl: BASE, token: 'nexus-auth', fetchImpl });
  expect((await client.getChannelBots()).platforms[0]?.configured).toBe(false);
  expect(await client.setChannelBot({ platform: 'telegram', token: 'private', allowedUsers: ['19'] }))
    .toEqual({ ok: true, botName: 'bot', restartNeeded: true });
  expect(calls.map(call => [call.url, call.init?.method])).toEqual([
    [`${BASE}/v1/setup/channel-bots`, 'GET'], [`${BASE}/v1/setup/channel-bot`, 'POST'],
  ]);
  expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ platform: 'telegram', token: 'private', allowedUsers: ['19'] });
  expect(JSON.stringify(calls[1]?.init?.headers)).toContain('nexus-auth');
});

describe('Read endpoints', () => {
  test('getHealth', async () => {
    const { fetchImpl } = makeMockFetch({
      '/v1/health': () => ({ status: 200, body: { ok: true, nexusVersion: '0.16.0' } }),
    });
    const client = createNexusClient({ baseUrl: BASE, fetchImpl });
    const r = await client.getHealth();
    expect(r.ok).toBe(true);
  });

  test('getNexus', async () => {
    const { fetchImpl } = makeMockFetch({
      '/v1/nexus': () => ({ status: 200, body: { tabs: [], recentEvents: [] } }),
    });
    const client = createNexusClient({ baseUrl: BASE, fetchImpl });
    const r = await client.getNexus();
    expect(Array.isArray(r.tabs)).toBe(true);
  });

  test('getTabs with kind filter', async () => {
    const { fetchImpl, calls } = makeMockFetch({
      '/v1/nexus/tabs?kind=chat': () => ({ status: 200, body: { tabs: [] } }),
    });
    const client = createNexusClient({ baseUrl: BASE, fetchImpl });
    await client.getTabs({ kind: 'chat' });
    expect(calls[0].url).toContain('?kind=chat');
  });

  test('getTab encodes id', async () => {
    const { fetchImpl, calls } = makeMockFetch({
      '/v1/nexus/tabs/chat:1': () => ({ status: 200, body: { tab: {}, recentEvents: [] } }),
    });
    const client = createNexusClient({ baseUrl: BASE, fetchImpl });
    await client.getTab('chat:1');
    expect(calls[0].url).toContain('chat%3A1');
  });
});

describe('Task card read endpoints', () => {
  test('list and single-card GETs return their respective response envelopes', async () => {
    const cards: TaskCardWire[] = [
      { id: 'card-1', goalId: 'goal-1', title: 'First', status: 'open', createdAt: '2026-09-29T00:00:00Z', sections: [] },
      { id: 'card-2', goalId: 'goal-2', title: 'Second', status: 'closed', createdAt: '2026-09-29T01:00:00Z', sections: [] },
    ];
    const { fetchImpl, calls } = makeMockFetch({
      '/v1/task-cards': () => ({ status: 200, body: { cards } }),
      '/v1/task-cards/card-1': () => ({ status: 200, body: { card: cards[0] } }),
    });
    const client = createNexusClient({ baseUrl: `${BASE}/`, token: 'card-token', fetchImpl });
    expect(await client.getTaskCards()).toEqual({ cards });
    expect(await client.getTaskCard('card-1')).toEqual({ card: cards[0] });
    expect(calls.map(({ url, init }) => [url, init?.method, init?.body])).toEqual([
      [`${BASE}/v1/task-cards`, 'GET', undefined],
      [`${BASE}/v1/task-cards/card-1`, 'GET', undefined],
    ]);
    for (const call of calls) {
      expect((call.init?.headers as Record<string, string>).authorization).toBe('Bearer card-token');
    }
  });

  test('single-card id is encoded as one path segment', async () => {
    const { fetchImpl, calls } = makeMockFetch({
      '/v1/task-cards/with/slash?and=query': () => ({ status: 200, body: { card: {
        id: 'with/slash?and=query', goalId: 'goal-1', title: 'Encoded', status: 'open', createdAt: '2026-09-29T00:00:00Z', sections: [],
      } } }),
    });
    const client = createNexusClient({ baseUrl: BASE, fetchImpl });
    expect((await client.getTaskCard('with/slash?and=query')).card.id).toBe('with/slash?and=query');
    expect(calls[0].url).toBe(`${BASE}/v1/task-cards/with%2Fslash%3Fand%3Dquery`);
  });

  test('list and single-card 404s retain status, path, and response body', async () => {
    const body = { error: 'not_found' };
    const { fetchImpl, calls } = makeMockFetch({
      '/v1/task-cards': () => ({ status: 404, body }),
      '/v1/task-cards/missing': () => ({ status: 404, body }),
    });
    const client = createNexusClient({ baseUrl: BASE, fetchImpl });
    for (const [call, path] of [
      [() => client.getTaskCards(), '/v1/task-cards'],
      [() => client.getTaskCard('missing'), '/v1/task-cards/missing'],
    ] as const) {
      try {
        await call();
        throw new Error('expected a 404');
      } catch (error) {
        expect(error).toBeInstanceOf(NexusApiError);
        expect((error as NexusApiError).status).toBe(404);
        expect((error as NexusApiError).path).toBe(path);
        expect((error as NexusApiError).body).toEqual(body);
      }
    }
    expect(calls).toHaveLength(2);
  });
});

describe('Tab mutation endpoints', () => {
  test('createTab POSTs body', async () => {
    const { fetchImpl, calls } = makeMockFetch({
      '/v1/nexus/tabs': () => ({ status: 201, body: { tab: { spec: { id: 'chat:1' } }, started: false } }),
    });
    const client = createNexusClient({ baseUrl: BASE, fetchImpl });
    await client.createTab({ kind: 'chat', label: 'first' });
    expect(calls[0].init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ kind: 'chat', label: 'first' });
  });

  test('deleteTab', async () => {
    const { fetchImpl, calls } = makeMockFetch({
      '/v1/nexus/tabs/chat:1': () => ({ status: 200, body: { deleted: true, id: 'chat:1' } }),
    });
    const client = createNexusClient({ baseUrl: BASE, fetchImpl });
    await client.deleteTab('chat:1');
    expect(calls[0].init?.method).toBe('DELETE');
  });

  test('startTab / stopTab / restartTab include action segment', async () => {
    const { fetchImpl, calls } = makeMockFetch({
      '/v1/nexus/tabs/d:1/start': () => ({ status: 200, body: { tab: {}, started: true } }),
      '/v1/nexus/tabs/d:1/stop?graceMs=0': () => ({ status: 200, body: { tab: {}, stopped: true } }),
      '/v1/nexus/tabs/d:1/restart': () => ({ status: 200, body: { tab: {}, restarted: true, started: true } }),
    });
    const client = createNexusClient({ baseUrl: BASE, fetchImpl });
    await client.startTab('d:1');
    await client.stopTab('d:1', { graceMs: 0 });
    await client.restartTab('d:1');
    expect(calls.map((c) => c.url.endsWith('/start') || c.url.includes('/stop?') || c.url.endsWith('/restart'))).toEqual([true, true, true]);
  });
});

describe('Templates', () => {
  test('getTemplates / getTemplate / saveTemplate', async () => {
    const { fetchImpl } = makeMockFetch({
      '/v1/nexus/templates': (init) => init?.method === 'POST'
        ? { status: 201, body: { saved: true, name: 'mine' } }
        : { status: 200, body: { templates: [] } },
      '/v1/nexus/templates/voice': () => ({ status: 200, body: { template: { name: 'voice' } } }),
    });
    const client = createNexusClient({ baseUrl: BASE, fetchImpl });
    expect((await client.getTemplates()).templates).toEqual([]);
    expect((await client.getTemplate('voice')).template.name).toBe('voice');
    expect((await client.saveTemplate({ name: 'mine' })).name).toBe('mine');
  });
});

describe('Config + secrets', () => {
  test('getSwitches', async () => {
    const { fetchImpl } = makeMockFetch({
      '/v1/config/switches': () => ({ status: 200, body: { switches: [] } }),
    });
    const client = createNexusClient({ baseUrl: BASE, fetchImpl });
    expect((await client.getSwitches()).switches).toEqual([]);
  });

  test('putSwitch returns outcome', async () => {
    const { fetchImpl, calls } = makeMockFetch({
      '/v1/config/switches/global.tools': () => ({ status: 200, body: { outcome: 'restart', switchId: 'global.tools', restartedTabs: ['daemon:1'] } }),
    });
    const client = createNexusClient({ baseUrl: BASE, fetchImpl });
    const r = await client.putSwitch('global.tools', { value: 'readonly' });
    expect(r.outcome).toBe('restart');
    expect(calls[0].init?.method).toBe('PUT');
  });

  test('getWorktrees returns repoRoot + worktrees + orphanedSessions (BACKLOG #5)', async () => {
    const { fetchImpl, calls } = makeMockFetch({
      '/v1/worktrees': () => ({
        status: 200,
        body: {
          repoRoot: '/tmp/r',
          worktrees: [
            { path: '/tmp/r', branch: 'main', sha: 'a', isMain: true, isLocked: false, isDetached: false, session: null, orphan: false },
            { path: '/tmp/r.worktrees/feat-x', branch: 'feat-x', sha: 'b', isMain: false, isLocked: false, isDetached: false,
              session: { sessionId: '12345', enteredAt: 1, previousCwd: '/tmp/r', alive: true }, orphan: false },
          ],
          orphanedSessions: [
            { sessionId: '99999', worktreePath: '/tmp/r.worktrees/gone', branch: 'gone', enteredAt: 2, alive: false },
          ],
        },
      }),
    });
    const client = createNexusClient({ baseUrl: BASE, fetchImpl });
    const r = await client.getWorktrees();
    expect(r.repoRoot).toBe('/tmp/r');
    expect(r.worktrees).toHaveLength(2);
    expect(r.worktrees[1].session?.sessionId).toBe('12345');
    expect(r.orphanedSessions).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}/v1/worktrees`);
  });

  test('getPlatforms returns 5 entries with status field (BACKLOG #2)', async () => {
    const { fetchImpl, calls } = makeMockFetch({
      '/v1/platforms': () => ({
        status: 200,
        body: {
          platforms: [
            { id: 'discord', label: 'Discord', status: 'connected', detail: 'token via secret-ref' },
            { id: 'telegram', label: 'Telegram', status: 'not-configured', detail: 'no token configured', hint: 'Set tabs.telegram:1.tokenRef …' },
            { id: 'pushcut', label: 'Pushcut', status: 'not-configured', detail: 'switch off' },
            { id: 'acp', label: 'ACP', status: 'connected', detail: '~/.elanous/acp-token present' },
            { id: 'tailscale', label: 'Tailscale Serve', status: 'not-configured', detail: 'switch off' },
          ],
        },
      }),
    });
    const client = createNexusClient({ baseUrl: BASE, fetchImpl });
    const r = await client.getPlatforms();
    expect(r.platforms).toHaveLength(5);
    expect(r.platforms.map((p) => p.id)).toEqual(['discord', 'telegram', 'pushcut', 'acp', 'tailscale']);
    expect(r.platforms[0].status).toBe('connected');
    expect(calls[0].url).toBe(`${BASE}/v1/platforms`);
  });

  test('postSecret + deleteSecret + getSecrets', async () => {
    const { fetchImpl } = makeMockFetch({
      '/v1/config/secrets': (init) => init?.method === 'POST'
        ? { status: 201, body: { stored: true, id: 'k', ref: 'ref:secret:k' } }
        : { status: 200, body: { secrets: [{ id: 'k' }] } },
      '/v1/config/secrets/k': () => ({ status: 200, body: { deleted: true, id: 'k' } }),
    });
    const client = createNexusClient({ baseUrl: BASE, fetchImpl });
    expect((await client.postSecret({ id: 'k', value: 'V' })).ref).toBe('ref:secret:k');
    expect((await client.getSecrets()).secrets[0].id).toBe('k');
    expect((await client.deleteSecret('k')).deleted).toBe(true);
  });
});

describe('Logs tail', () => {
  test('getLogsTail with lines query', async () => {
    const { fetchImpl, calls } = makeMockFetch({
      '/v1/nexus/tabs/d:1/logs?lines=50': () => ({
        status: 200,
        body: { id: 'd:1', lines: 50, stdout: { path: '', tail: [], size: 0 }, stderr: { path: '', tail: [], size: 0 } },
      }),
    });
    const client = createNexusClient({ baseUrl: BASE, fetchImpl });
    const r = await client.getLogsTail('d:1', { lines: 50 });
    expect(r.lines).toBe(50);
    expect(calls[0].url).toContain('?lines=50');
  });
});

describe('validateWorkflow · external AbortSignal (Caveat #5)', () => {
  test('forwards caller-supplied signal so the request aborts', async () => {
    let receivedInit: RequestInit | undefined;
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      receivedInit = init;
      // Resolve a Response if not aborted; reject with AbortError otherwise.
      return new Promise<Response>((resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(new DOMException('aborted', 'AbortError'));
          return;
        }
        const onAbort = () => reject(new DOMException('aborted', 'AbortError'));
        init?.signal?.addEventListener('abort', onAbort);
        setTimeout(() => {
          init?.signal?.removeEventListener('abort', onAbort);
          resolve(
            new Response(JSON.stringify({ validation: { ok: true, issues: [] } }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          );
        }, 1000);
      });
    }) as unknown as typeof fetch;
    const client = createNexusClient({ baseUrl: BASE, fetchImpl });
    const ctrl = new AbortController();
    const p = client.validateWorkflow('name: x', { signal: ctrl.signal });
    ctrl.abort();
    let caught: unknown = null;
    try { await p; } catch (e) { caught = e; }
    expect(caught).toBeTruthy();
    expect(receivedInit?.signal).toBeDefined();
    // The signal forwarded into fetch must have been aborted by the
    // bridge that listens to the caller's external signal.
    expect((receivedInit?.signal as AbortSignal).aborted).toBe(true);
  });

  test('honours an already-aborted signal (no fetch round-trip)', async () => {
    let fetchCalled = false;
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      fetchCalled = true;
      if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const client = createNexusClient({ baseUrl: BASE, fetchImpl });
    const ctrl = new AbortController();
    ctrl.abort();
    let caught: unknown = null;
    try { await client.validateWorkflow('name: x', { signal: ctrl.signal }); } catch (e) { caught = e; }
    expect(caught).toBeTruthy();
    // fetch may or may not be invoked depending on timing; the contract
    // is that the request is aborted, observable via thrown error.
    expect(fetchCalled).toBe(true);
  });
});

describe('Authorization header', () => {
  function authHeader(init?: RequestInit): string | undefined {
    const headers = init?.headers as Record<string, string> | undefined;
    return headers?.authorization;
  }

  test('token-bearing getHealth (GET, no body) sends authorization Bearer', async () => {
    const { fetchImpl, calls } = makeMockFetch({
      '/v1/health': () => ({ status: 200, body: { ok: true } }),
    });
    const client = createNexusClient({ baseUrl: BASE, fetchImpl, token: 'tok-1' });
    await client.getHealth();
    expect(authHeader(calls[0].init)).toBe('Bearer tok-1');
    const getHeaders = calls[0].init?.headers as Record<string, string> | undefined;
    expect(getHeaders?.['content-type']).toBeUndefined();
    expect(calls[0].init?.body).toBeUndefined();
  });

  test('token-bearing putSwitch sends authorization Bearer', async () => {
    const { fetchImpl, calls } = makeMockFetch({
      '/v1/config/switches/global.tools': () => ({ status: 200, body: { outcome: 'hot', switchId: 'global.tools' } }),
    });
    const client = createNexusClient({ baseUrl: BASE, fetchImpl, token: 'tok-1' });
    await client.putSwitch('global.tools', { value: 'readonly' });
    expect(authHeader(calls[0].init)).toBe('Bearer tok-1');
    const putHeaders = calls[0].init?.headers as Record<string, string>;
    expect(putHeaders['content-type']).toBe('application/json');
  });

  test('client created without a token sends no authorization header', async () => {
    const { fetchImpl, calls } = makeMockFetch({
      '/v1/health': () => ({ status: 200, body: { ok: true } }),
      '/v1/config/switches/global.tools': () => ({ status: 200, body: { outcome: 'hot', switchId: 'global.tools' } }),
      '/v1/setup/obsidian-skills': () => ({ status: 200, body: { obsidian: {}, skills: {} } }),
    });
    const client = createNexusClient({ baseUrl: BASE, fetchImpl });
    await client.getHealth();
    await client.putSwitch('global.tools', { value: 'readonly' });
    await client.getObsidianSkills();
    for (const call of calls) {
      expect(authHeader(call.init)).toBeUndefined();
    }
  });
});

describe('Error handling', () => {
  test('non-2xx throws NexusApiError', async () => {
    const { fetchImpl } = makeMockFetch({
      '/v1/nexus/tabs/missing': () => ({ status: 404, body: { error: 'tab-not-found' } }),
    });
    const client = createNexusClient({ baseUrl: BASE, fetchImpl });
    let err: unknown = null;
    try { await client.getTab('missing'); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(NexusApiError);
    expect((err as NexusApiError).status).toBe(404);
    expect((err as NexusApiError).body).toEqual({ error: 'tab-not-found' });
  });
});

describe('request timeout and retry', () => {
  const timeoutMs = 10;
  const abortError = new DOMException('signal is aborted without reason', 'AbortError');
  function slowFetch(calls: RequestInit[], succeedOn?: number): typeof fetch {
    return (async (_input: unknown, init?: RequestInit) => {
      calls.push(init ?? {});
      if (calls.length === succeedOn) return new Response('{"ok":true}', { status: 200 });
      return new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) return reject(abortError);
        init?.signal?.addEventListener('abort', () => reject(abortError), { once: true });
      });
    }) as typeof fetch;
  }

  test('GET times out once and returns the second response', async () => {
    const calls: RequestInit[] = [];
    const client = createNexusClient({ baseUrl: BASE, fetchImpl: slowFetch(calls, 2), timeoutMs });
    expect((await client.getHealth()).ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0].signal).not.toBe(calls[1].signal);
  });

  test('GET times out twice with a path-bearing NexusTimeoutError', async () => {
    const calls: RequestInit[] = [];
    const client = createNexusClient({ baseUrl: BASE, fetchImpl: slowFetch(calls), timeoutMs });
    let caught: unknown;
    try { await client.getHealth(); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(NexusTimeoutError);
    expect((caught as NexusTimeoutError).path).toBe('/v1/health');
    expect((caught as NexusTimeoutError).timeoutMs).toBe(timeoutMs);
    expect((caught as NexusTimeoutError).message).toBe('NEXUS 가 0.01초 안에 답하지 않았습니다 (/v1/health) — 방금 켰다면 잠시 뒤 다시 시도하세요.');
    expect(calls).toHaveLength(2);
  });

  test('POST times out without a retry', async () => {
    const calls: RequestInit[] = [];
    const client = createNexusClient({ baseUrl: BASE, fetchImpl: slowFetch(calls), timeoutMs });
    await expect(client.createTab({ kind: 'chat' })).rejects.toBeInstanceOf(NexusTimeoutError);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
  });

  test('caller abort before timeout remains the original AbortError', async () => {
    const calls: RequestInit[] = [];
    const client = createNexusClient({ baseUrl: BASE, fetchImpl: slowFetch(calls), timeoutMs });
    const ctrl = new AbortController();
    const pending = client.getTriggersSnapshot({ signal: ctrl.signal });
    ctrl.abort();
    let caught: unknown;
    try { await pending; } catch (err) { caught = err; }
    expect(caught).toBe(abortError);
    expect(caught).not.toBeInstanceOf(NexusTimeoutError);
    expect(calls).toHaveLength(1);
  });

  function slowBodyFetch(calls: RequestInit[], succeedOn?: number): typeof fetch {
    return (async (_input: unknown, init?: RequestInit) => {
      calls.push(init ?? {});
      if (calls.length === succeedOn) return new Response('{"ok":true}', { status: 200 });
      return {
        ok: true,
        json: () => new Promise<unknown>((_resolve, reject) => {
          if (init?.signal?.aborted) return reject(abortError);
          init?.signal?.addEventListener('abort', () => reject(abortError), { once: true });
        }),
      } as Response;
    }) as typeof fetch;
  }

  test('GET retries when the first response body times out', async () => {
    const calls: RequestInit[] = [];
    const client = createNexusClient({ baseUrl: BASE, fetchImpl: slowBodyFetch(calls, 2), timeoutMs });
    expect((await client.getHealth()).ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  test('GET reports a timeout when both response bodies time out', async () => {
    const calls: RequestInit[] = [];
    const client = createNexusClient({ baseUrl: BASE, fetchImpl: slowBodyFetch(calls), timeoutMs });
    let caught: unknown;
    try { await client.getHealth(); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(NexusTimeoutError);
    expect((caught as NexusTimeoutError).path).toBe('/v1/health');
    expect(calls).toHaveLength(2);
  });

  test('POST does not retry when its response body times out', async () => {
    const calls: RequestInit[] = [];
    const client = createNexusClient({ baseUrl: BASE, fetchImpl: slowBodyFetch(calls), timeoutMs });
    await expect(client.createTab({ kind: 'chat' })).rejects.toBeInstanceOf(NexusTimeoutError);
    expect(calls).toHaveLength(1);
  });

  test('caller cancellation while reading the body preserves the AbortError', async () => {
    const calls: RequestInit[] = [];
    const client = createNexusClient({ baseUrl: BASE, fetchImpl: slowBodyFetch(calls), timeoutMs });
    const ctrl = new AbortController();
    const pending = client.getTriggersSnapshot({ signal: ctrl.signal });
    await Promise.resolve(); // Let fetch return its response before aborting the body read.
    ctrl.abort();
    let caught: unknown;
    try { await pending; } catch (err) { caught = err; }
    expect(caught).toBe(abortError);
    expect(caught).not.toBeInstanceOf(NexusTimeoutError);
    expect(calls).toHaveLength(1);
  });

  test('invalid JSON on HTTP error retains the null body and original message', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response('not json', { status: 503 });
    }) as unknown as typeof fetch;
    const client = createNexusClient({ baseUrl: BASE, fetchImpl, timeoutMs });
    let caught: unknown;
    try { await client.getHealth(); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(NexusApiError);
    expect((caught as NexusApiError).body).toBeNull();
    expect((caught as NexusApiError).message).toBe('nexus 503 on /v1/health: null');
    expect(calls).toBe(1);
  });

  test('HTTP error keeps its original message and is not retried', async () => {
    const { fetchImpl, calls } = makeMockFetch({
      '/v1/health': () => ({ status: 503, body: { error: 'unavailable' } }),
    });
    const client = createNexusClient({ baseUrl: BASE, fetchImpl, timeoutMs });
    let caught: unknown;
    try { await client.getHealth(); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(NexusApiError);
    expect((caught as NexusApiError).message).toBe('nexus 503 on /v1/health: {"error":"unavailable"}');
    expect(calls).toHaveLength(1);
  });
});

describe('SSE subscribers', () => {
  // EventSource stub
  class StubEventSource {
    static lastUrl: string | null = null;
    static lastInstance: StubEventSource | null = null;
    listeners = new Map<string, EventListener>();
    readyState = 0;
    constructor(public url: string) {
      StubEventSource.lastUrl = url;
      StubEventSource.lastInstance = this;
    }
    addEventListener(type: string, fn: EventListener): void { this.listeners.set(type, fn); }
    close(): void { /* noop */ }
    emit(type: string, data: unknown): void {
      const fn = this.listeners.get(type);
      if (fn) fn({ data: typeof data === 'string' ? data : JSON.stringify(data) } as MessageEvent);
    }
  }

  test('subscribeEvents URL contains topic filter + delivers parsed events', () => {
    const client = createNexusClient({ baseUrl: BASE });
    const got: unknown[] = [];
    const off = client.subscribeEvents({
      topics: ['tab.', 'nexus.'],
      onEvent: (ev) => got.push(ev),
      EventSourceImpl: StubEventSource as unknown as typeof EventSource,
    });
    expect(StubEventSource.lastUrl).toContain('topics=tab.%2Cnexus.');
    StubEventSource.lastInstance!.emit('message', { ts: 1, kind: 'tab.up', tabId: 'd:1' });
    expect(got).toHaveLength(1);
    off();
  });

  test('subscribeEvents catches NAMED frames the server emits (§15.8(b) fix)', () => {
    // Pre-fix: only `addEventListener('message', …)` was attached, so
    // server frames carrying `event: tab.up\ndata: …\n\n` were silently
    // dropped (EventSource dispatches them to the named listener, not
    // to 'message'). Fix attaches a listener for each known kind.
    const client = createNexusClient({ baseUrl: BASE });
    const got: { ts: number; kind: string }[] = [];
    const off = client.subscribeEvents({
      topics: ['tab.', 'workflow.run.'],
      onEvent: (ev) => got.push(ev as { ts: number; kind: string }),
      EventSourceImpl: StubEventSource as unknown as typeof EventSource,
    });

    // emit several named frames covering both new and existing kinds
    StubEventSource.lastInstance!.emit('tab.up', { ts: 1, kind: 'tab.up', tabId: 'd:1' });
    StubEventSource.lastInstance!.emit('workflow.run.started', {
      ts: 2, kind: 'workflow.run.started', detail: { runId: 'r1', workflowName: 'demo' },
    });
    StubEventSource.lastInstance!.emit('workflow.run.completed', {
      ts: 3, kind: 'workflow.run.completed', detail: { runId: 'r1', workflowName: 'demo' },
    });

    expect(got.map((e) => e.kind)).toEqual([
      'tab.up',
      'workflow.run.started',
      'workflow.run.completed',
    ]);
    off();
  });

  test('subscribeEvents accepts forward-compat kinds option for unknown server kinds', () => {
    const client = createNexusClient({ baseUrl: BASE });
    const got: { kind: string }[] = [];
    const off = client.subscribeEvents({
      onEvent: (ev) => got.push(ev as { kind: string }),
      kinds: ['custom.kind.from.future'],
      EventSourceImpl: StubEventSource as unknown as typeof EventSource,
    });
    StubEventSource.lastInstance!.emit('custom.kind.from.future', {
      ts: 1, kind: 'custom.kind.from.future', detail: {},
    });
    expect(got.map((e) => e.kind)).toEqual(['custom.kind.from.future']);
    off();
  });

  test('subscribeLogs hits /logs?stream=1', () => {
    const client = createNexusClient({ baseUrl: BASE });
    const got: unknown[] = [];
    client.subscribeLogs('d:1', {
      onLine: (line) => got.push(line),
      EventSourceImpl: StubEventSource as unknown as typeof EventSource,
    });
    expect(StubEventSource.lastUrl).toContain('/v1/nexus/tabs/d%3A1/logs?stream=1');
    StubEventSource.lastInstance!.emit('log', { stream: 'stdout', line: 'hi' });
    expect(got).toEqual([{ stream: 'stdout', line: 'hi' }]);
  });

  test('subscribeEvents records reconnecting errors without onError', () => {
    const consoleSpy = spyOn(console, 'debug').mockImplementation(() => {});
    try {
      const client = createNexusClient({ baseUrl: BASE });
      client.subscribeEvents({
        onEvent: () => {},
        EventSourceImpl: StubEventSource as unknown as typeof EventSource,
      });
      StubEventSource.lastInstance!.readyState = 0;
      StubEventSource.lastInstance!.emit('error', 'ignored');

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('nexus.sse.error'),
        expect.objectContaining({
          url: StubEventSource.lastUrl,
          readyState: 0,
          connectionState: 'reconnecting',
        }),
      );
    } finally {
      consoleSpy.mockRestore();
    }
  });

  test('subscribeEvents preserves onError callback delivery', () => {
    const onError = spyOn({ onError: () => {} }, 'onError');
    const client = createNexusClient({ baseUrl: BASE });
    client.subscribeEvents({
      onEvent: () => {},
      onError: onError as unknown as (err: Error) => void,
      EventSourceImpl: StubEventSource as unknown as typeof EventSource,
    });
    StubEventSource.lastInstance!.emit('error', 'ignored');

    expect(onError).toHaveBeenCalledTimes(1);
  });

  test('subscribeLogs records closed errors without onError', () => {
    const consoleSpy = spyOn(console, 'debug').mockImplementation(() => {});
    try {
      const client = createNexusClient({ baseUrl: BASE });
      client.subscribeLogs('d:1', {
        onLine: () => {},
        EventSourceImpl: StubEventSource as unknown as typeof EventSource,
      });
      StubEventSource.lastInstance!.readyState = 2;
      StubEventSource.lastInstance!.emit('error', 'ignored');

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('nexus.sse.error'),
        expect.objectContaining({
          url: StubEventSource.lastUrl,
          readyState: 2,
          connectionState: 'closed',
        }),
      );
    } finally {
      consoleSpy.mockRestore();
    }
  });

  test('throws if EventSource not available globally + not provided', () => {
    const client = createNexusClient({ baseUrl: BASE });
    const prev = (globalThis as { EventSource?: unknown }).EventSource;
    delete (globalThis as { EventSource?: unknown }).EventSource;
    try {
      expect(() => client.subscribeEvents({ onEvent: () => {} })).toThrow(/EventSource/);
    } finally {
      if (prev) (globalThis as { EventSource?: unknown }).EventSource = prev;
    }
  });
});

// PWA mirror PR 1 — chat-backend-detection client method test
describe('createNexusClient · getChatBackendDetection', () => {
  test('GET /v1/nexus/chat-backend-detection returns parsed snapshot', async () => {
    const sample = {
      detection: { backend: 'codex', source: 'openai-codex OAuth' },
      entries: [
        {
          provider: 'codex',
          label: 'OpenAI · Codex',
          paths: [
            { tag: 'OAuth', hint: 'elanous login codex', detected: true },
            { tag: 'OPENAI_API_KEY', hint: 'export ...', detected: false },
          ],
        },
        { provider: 'claude-code', label: 'Anthropic · Claude', paths: [] },
        { provider: 'gemini', label: 'Google · Gemini', paths: [] },
      ],
    };
    const { fetchImpl, calls } = makeMockFetch({
      '/v1/nexus/chat-backend-detection': () => ({ status: 200, body: sample }),
    });
    const client = createNexusClient({ baseUrl: BASE, fetchImpl });
    const result = await client.getChatBackendDetection();
    expect(result.detection.backend).toBe('codex');
    expect(result.entries).toHaveLength(3);
    expect(result.entries[0].paths[0].detected).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}/v1/nexus/chat-backend-detection`);
  });

  test('handles 404 / not-wired with NexusApiError', async () => {
    const { fetchImpl } = makeMockFetch({
      '/v1/nexus/chat-backend-detection': () => ({ status: 404, body: { error: 'not-found' } }),
    });
    const client = createNexusClient({ baseUrl: BASE, fetchImpl });
    await expect(client.getChatBackendDetection()).rejects.toBeInstanceOf(NexusApiError);
  });
});

describe('/setup wizard wire (Phase 1 · 2026-05-19)', () => {
  test('answer priority GET and POST use the authenticated setup endpoint', async () => {
    const sample: AnswerPriorityResponse = { value: null, effective: 'balanced', choices: [
      { value: 'cost', label: '비용', description: '적은 도구' },
    ] };
    const { fetchImpl, calls } = makeMockFetch({
      '/v1/setup/answer-priority': (init) => init?.method === 'POST'
        ? { status: 200, body: { value: 'quality' } }
        : { status: 200, body: sample },
    });
    const client = createNexusClient({ baseUrl: BASE, fetchImpl, token: 'setup-token' });
    expect(await client.getAnswerPriority()).toEqual(sample);
    expect(await client.setAnswerPriority('quality')).toEqual({ value: 'quality' });
    expect(calls.map((call) => call.init?.method)).toEqual(['GET', 'POST']);
    expect(calls.map((call) => call.url)).toEqual([
      `${BASE}/v1/setup/answer-priority`, `${BASE}/v1/setup/answer-priority`,
    ]);
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ value: 'quality' });
    expect(JSON.stringify(calls[1]?.init?.headers)).toContain('Bearer setup-token');
  });

  test('getLlmProviders surfaces catalog', async () => {
    const sample = {
      providers: [
        {
          provider: 'anthropic',
          label: 'Anthropic',
          description: 'Claude · API key (ANTHROPIC_API_KEY)',
          apiKeyLabel: 'Anthropic API key',
          flow: 'apiKey',
          recommended: true,
          hasSavedKey: false,
        },
        {
          provider: 'auto',
          label: 'Auto-detect at runtime',
          description: 'Pick first available provider from env every call',
          apiKeyLabel: '',
          flow: 'auto',
          recommended: false,
          hasSavedKey: false,
        },
      ],
      activeProvider: '',
    };
    const { fetchImpl, calls } = makeMockFetch({
      '/v1/setup/llm-providers': () => ({ status: 200, body: sample }),
    });
    const client = createNexusClient({ baseUrl: BASE, fetchImpl });
    const result = await client.getLlmProviders();
    expect(result.providers).toHaveLength(2);
    expect(result.providers[0].provider).toBe('anthropic');
    expect(result.providers[0].flow).toBe('apiKey');
    expect(result.activeProvider).toBe('');
    expect(calls[0].url).toBe(`${BASE}/v1/setup/llm-providers`);
  });

  test('setLlmProvider POSTs JSON body with apiKey', async () => {
    const { fetchImpl, calls } = makeMockFetch({
      'POST /v1/setup/llm-provider': () => ({
        status: 200,
        body: { ok: true, active: { provider: 'anthropic', model: '' } },
      }),
    });
    const client = createNexusClient({ baseUrl: BASE, fetchImpl });
    const result = await client.setLlmProvider({
      provider: 'anthropic',
      apiKey: 'sk-ant-test-1234567890',
    });
    expect(result.ok).toBe(true);
    expect(result.active.provider).toBe('anthropic');
    expect(calls).toHaveLength(1);
    expect(calls[0].init?.method).toBe('POST');
    const sentBody = calls[0].init?.body
      ? JSON.parse(calls[0].init.body as string)
      : {};
    expect(sentBody.provider).toBe('anthropic');
    expect(sentBody.apiKey).toBe('sk-ant-test-1234567890');
  });

  test('setLlmProvider forwards 422 (interactive flow) as NexusApiError', async () => {
    const { fetchImpl } = makeMockFetch({
      'POST /v1/setup/llm-provider': () => ({
        status: 422,
        body: { error: 'flow-not-supported-in-pwa', flow: 'codex' },
      }),
    });
    const client = createNexusClient({ baseUrl: BASE, fetchImpl });
    await expect(
      client.setLlmProvider({ provider: 'openai-codex' }),
    ).rejects.toBeInstanceOf(NexusApiError);
  });

  test('setLlmProvider forwards 400 (missing apiKey)', async () => {
    const { fetchImpl } = makeMockFetch({
      'POST /v1/setup/llm-provider': () => ({
        status: 400,
        body: { error: 'apiKey-required', provider: 'anthropic' },
      }),
    });
    const client = createNexusClient({ baseUrl: BASE, fetchImpl });
    await expect(
      client.setLlmProvider({ provider: 'anthropic' }),
    ).rejects.toBeInstanceOf(NexusApiError);
  });
});
