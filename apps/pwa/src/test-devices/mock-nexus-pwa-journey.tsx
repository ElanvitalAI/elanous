/** N04: an isolated Nexus HTTP server, the real PWA client, and a rendered React frame. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { ReactElement } from 'react';
import { createNexusClient, type NexusClient } from '../nexus/client';
import { getElanousConfigDirOverride, setElanousConfigDir, resetElanousConfigDir } from '../../../../src/elanous-config-dir';
import { startNexusHttpServer } from '../../../../src/nexus/api/http-server';
import { NexusEventBus } from '../../../../src/nexus/api/event-bus';
import { createNexusState } from '../../../../src/nexus/state/state';
import { TabRegistry } from '../../../../src/nexus/state/tab-registry';

export interface MockNexusPwaRequest {
  runId: string;
  sourceSha: string;
  method: string;
  path: string;
  status: number;
}

export interface MockNexusPwaFrame {
  runId: string;
  sourceSha: string;
  tree: ReturnType<ReactTestRenderer['toJSON']>;
}

export function createMockNexusPwaJourney(input: {
  runId: string;
  sourceSha: string;
  callLLM: (prompt: string) => Promise<string>;
}) {
  if (!input.runId.trim() || !/^[a-f0-9]{40}$/i.test(input.sourceSha)) throw new Error('N04 requires runId and 40-hex sourceSha');
  const stateDir = mkdtempSync(join(tmpdir(), 'mock-nexus-pwa-'));
  const previousConfigDir = getElanousConfigDirOverride();
  const restoreConfigDir = () => previousConfigDir === undefined ? resetElanousConfigDir() : setElanousConfigDir(previousConfigDir);
  let server: ReturnType<typeof startNexusHttpServer>;
  try {
    setElanousConfigDir(stateDir);
    const state = createNexusState({ nexusVersion: 'mock-n04', phase: 'test' });
    const eventBus = new NexusEventBus();
    state.bus = eventBus;
    server = startNexusHttpServer({ state, eventBus, registry: new TabRegistry(state),
      startPort: 44000 + Math.floor(Math.random() * 1000), portRange: 20, hostname: '127.0.0.1',
      metaApi: { bearerToken: `mock-owner-${input.runId}`, noAuth: false },
      graphWizard: { callLLM: input.callLLM, graphsDir: join(import.meta.dir, '../../../../graphs'), existingIds: () => new Set() },
    });
  } catch (error) {
    restoreConfigDir();
    rmSync(stateDir, { recursive: true, force: true });
    throw error;
  }
  const token = `mock-owner-${input.runId}`;
  const requests: MockNexusPwaRequest[] = [];
  const trackedFetch: typeof fetch = Object.assign(async (resource: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof resource === 'string' ? resource : resource instanceof URL ? resource.href : resource.url;
    const response = await fetch(resource, init);
    requests.push({ runId: input.runId, sourceSha: input.sourceSha, method: init?.method ?? (resource instanceof Request ? resource.method : 'GET'), path: new URL(url).pathname,
      status: response.status });
    return response;
  }, { preconnect: fetch.preconnect });
  const client = createNexusClient({ baseUrl: server.url, token, fetchImpl: trackedFetch });
  let renderer: ReactTestRenderer | undefined;
  return {
    url: server.url,
    requests,
    async mount(render: (client: NexusClient) => ReactElement) {
      await act(async () => { renderer = create(render(client)); });
      return renderer!;
    },
    frame(): MockNexusPwaFrame {
      if (!renderer) throw new Error('N04 frame requested before mount');
      return { runId: input.runId, sourceSha: input.sourceSha, tree: renderer.toJSON() };
    },
    async close() {
      try {
        if (renderer) await act(async () => { renderer!.unmount(); });
      } finally {
        try { server.stop(); }
        finally {
          restoreConfigDir();
          rmSync(stateDir, { recursive: true, force: true });
        }
      }
    },
  };
}
