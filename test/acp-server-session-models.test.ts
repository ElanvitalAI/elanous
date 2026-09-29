import { afterEach, describe, expect, test } from 'bun:test';
import {
  ClientSideConnection,
  ndJsonStream,
} from '@agentclientprotocol/sdk';

import {
  deriveAcpSessionModelState,
  runAcpServer,
} from '../src/acp/server.js';
import {
  LLM_TIER_MAP_BY_PROVIDER,
  TIER_PROVIDERS,
  type LlmTierProvider,
  type LlmTierSpec,
} from '../src/model-tier/llm-tier-map.js';
import type { ModelTier } from '../src/model-tier/types.js';
import { createInProcessAcpBridge } from '../src/tui-client/acp-transport-local.js';
import type { AcpTransportServer } from '../src/acp/transport/index.js';
import { debug } from '../src/debug/log.js';
import {
  _resetSessionTierOverridesForTesting,
  getSessionTierOverride,
} from '../src/model-tier/session-override.js';

/** ACP 1.x: the session model list is the `model` select in `configOptions`. */
function modelValues(session: { configOptions?: Array<{ id: string; type?: string; options?: unknown }> | null }): string[] {
  const option = session.configOptions?.find((entry) => entry.id === 'model');
  const options = (option?.options ?? []) as Array<{ value?: string }>;
  return options.map((entry) => entry.value!).filter(Boolean);
}

function expectedModelIds(providers: readonly LlmTierProvider[]): string[] {
  return providers.flatMap((provider) => Object.entries(LLM_TIER_MAP_BY_PROVIDER[provider])
    .map(([tier, spec]) => `${provider}:${tier}:${spec.model}`));
}

describe('deriveAcpSessionModelState()', () => {
  test('derives a non-empty ACP model catalog from every provider tier', () => {
    const state = deriveAcpSessionModelState();

    expect(state.availableModels.map((model) => model.modelId).sort())
      .toEqual(expectedModelIds(TIER_PROVIDERS).sort());
    expect(state.availableModels).not.toHaveLength(0);
    expect(state.availableModels.some((model) => model.modelId === state.currentModelId)).toBe(true);
  });

  test('uses injected tier metadata and omits only tiers absent from an otherwise identical provider list', () => {
    const injectedGrokTier = {
      model: 'test-injected-grok-model',
      label: 'Injected Grok label',
      rationale: 'Injected Grok rationale',
      status: 'wip' as const,
      reasoningLevel: 'high' as const,
    };
    const catalog = {
      ...LLM_TIER_MAP_BY_PROVIDER,
      grok: {
        best: injectedGrokTier,
      },
    };
    const state = deriveAcpSessionModelState(TIER_PROVIDERS, catalog);
    const injectedModel = state.availableModels.find((model) => model.modelId === 'grok:best:test-injected-grok-model');

    expect(injectedModel).toEqual({
      modelId: 'grok:best:test-injected-grok-model',
      name: 'Injected Grok label',
      description: 'Injected Grok rationale · wip · high',
    });
    expect(state.availableModels.some((model) => model.modelId.startsWith('grok:') && model.modelId !== injectedModel?.modelId)).toBe(false);
    expect(state.availableModels.some((model) => model.modelId === state.currentModelId)).toBe(true);
  });
});

describe('runAcpServer() newSession models', () => {
  let shutdown: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await shutdown?.();
    shutdown = undefined;
    _resetSessionTierOverridesForTesting();
  });

  test('records client identity and protocol version for initialize requests with and without clientInfo', async () => {
    const firstBridge = createInProcessAcpBridge();
    const secondBridge = createInProcessAcpBridge();
    const controller = new AbortController();
    const server = runAcpServer({
      transportFactory: async (onConnection) => {
        void onConnection({
          readable: firstBridge.a.readable,
          writable: firstBridge.a.writable,
          peerId: 'initialize-client-info-present',
          close: async () => { await firstBridge.a.writable.close(); },
        });
        void onConnection({
          readable: secondBridge.a.readable,
          writable: secondBridge.a.writable,
          peerId: 'initialize-client-info-absent',
          close: async () => { await secondBridge.a.writable.close(); },
        });
        return { close: async () => {
          await firstBridge.a.writable.close();
          await secondBridge.a.writable.close();
        } } as AcpTransportServer;
      },
      shutdownSignal: controller.signal,
    });
    shutdown = async () => {
      controller.abort();
      await firstBridge.b.writable.close();
      await secondBridge.b.writable.close();
      await server;
    };

    const createClient = (bridge: ReturnType<typeof createInProcessAcpBridge>) => new ClientSideConnection(() => ({
      async sessionUpdate() {},
      async requestPermission() { return { outcome: { outcome: 'cancelled' as const } }; },
    }), ndJsonStream(bridge.b.writable, bridge.b.readable));
    const presentClient = createClient(firstBridge);
    const absentClient = createClient(secondBridge);
    await Promise.all([
      presentClient.initialize({
        protocolVersion: 1,
        clientInfo: { name: 'session-model-test-client', version: '1.2.3' },
        clientCapabilities: {},
      }),
      absentClient.initialize({ protocolVersion: 2, clientCapabilities: {} }),
    ]);

    const initializeEvents = debug.events(10_000).filter((event) => event.category === 'acp.session'
      && event.event === 'initialize');
    expect(initializeEvents.some((event) => {
      const data = event.data as { protocolVersion?: number; clientName?: string; clientVersion?: string };
      return data.protocolVersion === 1
        && data.clientName === 'session-model-test-client'
        && data.clientVersion === '1.2.3';
    })).toBe(true);
    expect(initializeEvents.some((event) => {
      const data = event.data as { protocolVersion?: number; clientName?: string; clientVersion?: string };
      return data.protocolVersion === 2
        && data.clientName === 'absent'
        && data.clientVersion === 'absent';
    })).toBe(true);
  });

  test('advertises the derived catalog and a current id contained in it', async () => {
    const bridge = createInProcessAcpBridge();
    const controller = new AbortController();
    const server = runAcpServer({
      transportFactory: async (onConnection) => {
        void onConnection({
          readable: bridge.a.readable,
          writable: bridge.a.writable,
          peerId: 'session-models-test',
          close: async () => { await bridge.a.writable.close(); },
        });
        return { close: async () => { await bridge.a.writable.close(); } } as AcpTransportServer;
      },
      shutdownSignal: controller.signal,
    });
    shutdown = async () => {
      controller.abort();
      await bridge.b.writable.close();
      await server;
    };

    const client = new ClientSideConnection(() => ({
      async sessionUpdate() {},
      async requestPermission() { return { outcome: { outcome: 'cancelled' as const } }; },
    }), ndJsonStream(bridge.b.writable, bridge.b.readable));
    await client.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const response = await client.newSession({ cwd: '/tmp', mcpServers: [] });

    const values = modelValues(response);
    expect([...values].sort()).toEqual(expectedModelIds(TIER_PROVIDERS).sort());
    expect(values).not.toHaveLength(0);
    const option = response.configOptions?.find((entry) => entry.id === 'model') as { category?: string; currentValue?: string } | undefined;
    expect(option?.category).toBe('model');
    expect(values).toContain(option?.currentValue ?? '<none>');
  });

  test('stores only advertised selections per session with rationale and lifecycle observation', async () => {
    const bridge = createInProcessAcpBridge();
    const controller = new AbortController();
    const server = runAcpServer({
      transportFactory: async (onConnection) => {
        void onConnection({
          readable: bridge.a.readable,
          writable: bridge.a.writable,
          peerId: 'session-model-selection-test',
          close: async () => { await bridge.a.writable.close(); },
        });
        return { close: async () => { await bridge.a.writable.close(); } } as AcpTransportServer;
      },
      shutdownSignal: controller.signal,
    });
    shutdown = async () => {
      controller.abort();
      await bridge.b.writable.close();
      await server;
    };

    const client = new ClientSideConnection(() => ({
      async sessionUpdate() {},
      async requestPermission() { return { outcome: { outcome: 'cancelled' as const } }; },
    }), ndJsonStream(bridge.b.writable, bridge.b.readable));
    await client.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const first = await client.newSession({ cwd: '/tmp', mcpServers: [] });
    const second = await client.newSession({ cwd: '/tmp', mcpServers: [] });
    const selectedModelId = modelValues(first).at(-1)!;
    const [, expectedTier] = selectedModelId.split(':', 3);

    await client.setSessionConfigOption({ sessionId: first.sessionId, configId: 'model', value: selectedModelId });

    const override = getSessionTierOverride(first.sessionId);
    expect(override).toMatchObject({ llm: expectedTier });
    expect(override?.rationale.length).toBeGreaterThan(0);
    expect(getSessionTierOverride(second.sessionId)).toBeUndefined();
    expect(debug.events(10_000).some((event) => event.category === 'acp.session'
      && event.event === 'model-selected'
      && (event.data as { sessionId?: string; modelId?: string }).sessionId === first.sessionId
      && (event.data as { sessionId?: string; modelId?: string }).modelId === selectedModelId)).toBe(true);

    await expect(client.setSessionConfigOption({
      sessionId: second.sessionId,
      configId: 'model',
      value: 'unadvertised:best:model',
    })).rejects.toMatchObject({
      code: -32602,
      message: 'Invalid params: unadvertised session model',
    });
    expect(getSessionTierOverride(second.sessionId)).toBeUndefined();
  });

  test('validates selections against the session model snapshot after the catalog changes', async () => {
    const bridge = createInProcessAcpBridge();
    const controller = new AbortController();
    const server = runAcpServer({
      transportFactory: async (onConnection) => {
        void onConnection({
          readable: bridge.a.readable,
          writable: bridge.a.writable,
          peerId: 'session-model-snapshot-test',
          close: async () => { await bridge.a.writable.close(); },
        });
        return { close: async () => { await bridge.a.writable.close(); } } as AcpTransportServer;
      },
      shutdownSignal: controller.signal,
    });
    shutdown = async () => {
      controller.abort();
      await bridge.b.writable.close();
      await server;
    };

    const client = new ClientSideConnection(() => ({
      async sessionUpdate() {},
      async requestPermission() { return { outcome: { outcome: 'cancelled' as const } }; },
    }), ndJsonStream(bridge.b.writable, bridge.b.readable));
    await client.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const session = await client.newSession({ cwd: '/tmp', mcpServers: [] });
    const catalog = LLM_TIER_MAP_BY_PROVIDER as Record<LlmTierProvider, Partial<Record<ModelTier, LlmTierSpec>>>;
    const original = catalog.grok.best!;
    const advertisedModelId = `grok:best:${original.model}`;
    const changedModelId = 'grok:best:catalog-changed-after-advertisement';

    delete catalog.grok.best;
    catalog.grok.best = { ...original, model: 'catalog-changed-after-advertisement' };
    try {
      await client.setSessionConfigOption({ sessionId: session.sessionId, configId: 'model', value: advertisedModelId });
      expect(getSessionTierOverride(session.sessionId)).toMatchObject({ llm: 'best' });

      await expect(client.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: 'model',
        value: changedModelId,
      })).rejects.toMatchObject({
        code: -32602,
        message: 'Invalid params: unadvertised session model',
      });
    } finally {
      catalog.grok.best = original;
    }
  });

  test('rejects selections for a session not advertised to the connection without storing an override', async () => {
    const firstBridge = createInProcessAcpBridge();
    const secondBridge = createInProcessAcpBridge();
    const controller = new AbortController();
    const server = runAcpServer({
      transportFactory: async (onConnection) => {
        void onConnection({
          readable: firstBridge.a.readable,
          writable: firstBridge.a.writable,
          peerId: 'session-model-owner-first',
          close: async () => { await firstBridge.a.writable.close(); },
        });
        void onConnection({
          readable: secondBridge.a.readable,
          writable: secondBridge.a.writable,
          peerId: 'session-model-owner-second',
          close: async () => { await secondBridge.a.writable.close(); },
        });
        return { close: async () => {
          await firstBridge.a.writable.close();
          await secondBridge.a.writable.close();
        } } as AcpTransportServer;
      },
      shutdownSignal: controller.signal,
    });
    shutdown = async () => {
      controller.abort();
      await firstBridge.b.writable.close();
      await secondBridge.b.writable.close();
      await server;
    };

    const createClient = (bridge: ReturnType<typeof createInProcessAcpBridge>) => new ClientSideConnection(() => ({
      async sessionUpdate() {},
      async requestPermission() { return { outcome: { outcome: 'cancelled' as const } }; },
    }), ndJsonStream(bridge.b.writable, bridge.b.readable));
    const firstClient = createClient(firstBridge);
    const secondClient = createClient(secondBridge);
    await Promise.all([
      firstClient.initialize({ protocolVersion: 1, clientCapabilities: {} }),
      secondClient.initialize({ protocolVersion: 1, clientCapabilities: {} }),
    ]);
    const first = await firstClient.newSession({ cwd: '/tmp', mcpServers: [] });
    const selectedModelId = modelValues(first).at(-1)!;

    await expect(secondClient.setSessionConfigOption({
      sessionId: first.sessionId,
      configId: 'model',
      value: selectedModelId,
    })).rejects.toMatchObject({
      code: -32602,
      message: 'Invalid params: unknown or unadvertised session',
    });
    expect(getSessionTierOverride(first.sessionId)).toBeUndefined();
  });
});
