import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import * as harnessApi from '../../../src/nexus/api/harness-api.js';
import { NexusEventBus } from '../../../src/nexus/api/event-bus.js';
import { createNexusState } from '../../../src/nexus/state/state.js';
import { TabRegistry } from '../../../src/nexus/state/tab-registry.js';

type HarnessHandlerName = Extract<keyof typeof harnessApi, `handleHarness${string}`>;
type HarnessRoute = {
  readonly handler: HarnessHandlerName;
  readonly path: string;
  readonly method: 'GET' | 'POST';
  readonly body?: Record<string, string>;
};

const routeDetails = {
  handleHarnessAskPost: { path: '/v1/harness/ask', method: 'POST', body: { text: 'target: src/x.ts' } },
  handleHarnessAskStatusGet: { path: '/v1/harness/ask-status?acceptanceId=accept-1', method: 'GET' },
  handleHarnessRunEventsGet: { path: '/v1/harness/run-events?runId=run-1', method: 'GET' },
  handleHarnessRunScreenGet: { path: '/v1/harness/run-screen?runId=run-1', method: 'GET' },
  handleHarnessRunsGet: { path: '/v1/harness/runs', method: 'GET' },
  handleHarnessStopPost: { path: '/v1/harness/stop', method: 'POST', body: { spaceId: 'space-1' } },
} as const satisfies Record<HarnessHandlerName, Omit<HarnessRoute, 'handler'>>;

const routes = Object.keys(harnessApi)
  .filter((name): name is HarnessHandlerName => name.startsWith('handleHarness'))
  .map((handler) => ({ handler, ...routeDetails[handler] }));

const calls = Object.fromEntries(routes.map(({ handler }) => [handler, 0])) as Record<HarnessHandlerName, number>;
const handlerSpies: Array<{ mockRestore(): void }> = [];
let askHandler: typeof harnessApi.handleHarnessAskPost;
const runEventsHandler = harnessApi.handleHarnessRunEventsGet;
let startNexusHttpServer: typeof import('../../../src/nexus/api/http-server.js').startNexusHttpServer;

beforeAll(async () => {
  askHandler = async () => {
    calls.handleHarnessAskPost += 1;
    return Response.json({ handler: 'handleHarnessAskPost' }, { status: 202 });
  };
  for (const { handler } of routes) {
    if (handler === 'handleHarnessAskPost') {
      handlerSpies.push(spyOn(harnessApi, handler).mockImplementation((req, metaApi, deps) => askHandler(req, metaApi, deps)));
      continue;
    }
    handlerSpies.push(spyOn(harnessApi, handler).mockImplementation((req, metaApi) => {
      calls[handler] += 1;
      if (handler === 'handleHarnessRunEventsGet') {
        return runEventsHandler(req, metaApi, { logStore: { queryByDataKeys: () => [] } as never });
      }
      return Response.json({ handler });
    }));
  }
  ({ startNexusHttpServer } = await import('../../../src/nexus/api/http-server.js'));
});

afterAll(() => {
  for (const handlerSpy of handlerSpies) handlerSpy.mockRestore();
});

afterEach(() => {
  for (const handler of Object.keys(calls) as HarnessHandlerName[]) calls[handler] = 0;
});

function fixture() {
  const bus = new NexusEventBus();
  const state = createNexusState({ nexusVersion: 'test', phase: 'harness-http-routes' });
  state.bus = bus;
  return { state, registry: new TabRegistry(state), eventBus: bus };
}

async function uniquePort(): Promise<number> {
  return 47000 + Math.floor(Math.random() * 1000);
}

function request(route: HarnessRoute, authorized = false): RequestInit {
  return {
    method: route.method,
    headers: {
      ...(authorized ? { authorization: 'Bearer test-token' } : {}),
      ...(route.body ? { 'content-type': 'application/json' } : {}),
    },
    ...(route.body ? { body: JSON.stringify(route.body) } : {}),
  };
}

function expectedCalls(count: number): Record<HarnessHandlerName, number> {
  return Object.fromEntries(routes.map(({ handler }) => [handler, count])) as Record<HarnessHandlerName, number>;
}

describe('harness HTTP routes', () => {
  test('derive every harness handler route from harness-api exports', () => {
    expect(Object.keys(routeDetails).sort()).toEqual(
      Object.keys(harnessApi).filter((name) => name.startsWith('handleHarness')).sort(),
    );
  });

  test('return 401 before meta API wiring without reaching handlers', async () => {
    const server = startNexusHttpServer({ ...fixture(), startPort: await uniquePort() });
    try {
      for (const route of routes) {
        const response = await fetch(`${server.url}${route.path}`, request(route));
        expect(response.status).toBe(401);
        await expect(response.json()).resolves.toEqual({ error: 'unauthorized' });
      }
      expect(calls).toEqual(expectedCalls(0));
    } finally {
      server.stop();
    }
  });

  test('return 401 before reaching handlers when authentication fails', async () => {
    const server = startNexusHttpServer({ ...fixture(), startPort: await uniquePort(), metaApi: { bearerToken: 'test-token', noAuth: false } });
    try {
      for (const route of routes) {
        const response = await fetch(`${server.url}${route.path}`, request(route));
        expect(response.status).toBe(401);
        await expect(response.json()).resolves.toEqual({ error: 'unauthorized' });
      }
      expect(calls).toEqual(expectedCalls(0));
    } finally {
      server.stop();
    }
  });

  test('authenticated unknown harness route reaches the behind-gate 404', async () => {
    const server = startNexusHttpServer({ ...fixture(), startPort: await uniquePort(), metaApi: { bearerToken: 'test-token', noAuth: false } });
    try {
      const response = await fetch(`${server.url}/v1/harness/not-a-route`, {
        headers: { authorization: 'Bearer test-token' },
      });
      expect(response.status).toBe(404);
      expect(calls).toEqual(expectedCalls(0));
    } finally {
      server.stop();
    }
  });

  test('dispatch authenticated requests to every exported handler through the HTTP server', async () => {
    const server = startNexusHttpServer({ ...fixture(), startPort: await uniquePort(), metaApi: { bearerToken: 'test-token', noAuth: false } });
    try {
      for (const route of routes) {
        const response = await fetch(`${server.url}${route.path}`, request(route, true));
        expect(response.ok).toBe(true);
        if (route.handler === 'handleHarnessRunEventsGet') {
          await expect(response.json()).resolves.toEqual([]);
        } else {
          await expect(response.json()).resolves.toEqual({ handler: route.handler });
        }
      }
      expect(calls).toEqual(expectedCalls(1));
    } finally {
      server.stop();
    }
  });

  test('preserves run-events handler responses and GET-only routing', async () => {
    const server = startNexusHttpServer({ ...fixture(), startPort: await uniquePort(), metaApi: { bearerToken: 'test-token', noAuth: false } });
    try {
      const missingRunId = await fetch(`${server.url}/v1/harness/run-events`, { headers: { authorization: 'Bearer test-token' } });
      expect(missingRunId.status).toBe(400);
      await expect(missingRunId.json()).resolves.toMatchObject({ error: expect.any(String) });

      const postResponse = await fetch(`${server.url}/v1/harness/run-events?runId=run-1`, {
        method: 'POST',
        headers: { authorization: 'Bearer test-token' },
      });
      expect(postResponse.status).toBe(405);
    } finally {
      server.stop();
    }
  });

  test('wires ask feedback through the server event bus as media.feedback', async () => {
    const { state, registry, eventBus } = fixture();
    const received: unknown[] = [];
    eventBus.subscribe((event) => received.push(event), ['media.']);
    askHandler = async (_request, _metaApi, deps) => {
      deps?.createFeedbackEmitter?.('accept-1')({
        envelopeVersion: 1,
        kind: 'tool.progress',
        blockId: 'accept-1:harness-ask',
        phase: 'end',
        sessionId: 'accept-1',
        emittedAt: 1,
        seq: 1,
        asciiFallback: ['done'],
        payload: { stream: 'generic', lines: ['done'] },
      });
      return Response.json({ handler: 'handleHarnessAskPost' }, { status: 202 });
    };
    const server = startNexusHttpServer({ state, registry, eventBus, startPort: await uniquePort(), metaApi: { bearerToken: 'test-token', noAuth: false } });
    try {
      const response = await fetch(`${server.url}/v1/harness/ask`, {
        method: 'POST',
        headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'target: src/x.ts' }),
      });
      expect(response.status).toBe(202);
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ kind: 'media.feedback', detail: { sessionId: 'accept-1' } });
    } finally {
      server.stop();
    }
  });
});
