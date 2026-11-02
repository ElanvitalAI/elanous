import { expect, test } from 'bun:test';
import { loadMockScenarioCatalog } from '../../ux-sim/mock-scenario-catalog.js';
import { createNexusState } from '../state/state.js';
import { TabRegistry } from '../state/tab-registry.js';
import { NexusEventBus } from './event-bus.js';
import { createDevProxyRuntimeRef } from './admin-dev-proxy.js';
import { routeRequest } from './http-server.js';

const catalog = loadMockScenarioCatalog();

function setupRequest() {
  const bus = new NexusEventBus();
  const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
  state.bus = bus;
  const publishEvents: string[] = [];
  bus.subscribe((event) => publishEvents.push(event.kind));
  const context = {
    state,
    registry: new TabRegistry(state),
    eventBus: bus,
    metaApi: { bearerToken: 'owner-secret', noAuth: false },
  };
  return {
    state,
    publishEvents,
    request: (path = '/v1/ux-sim/devices', method = 'GET', authorized = true) => routeRequest(new Request(`http://localhost${path}`, {
      method,
      headers: authorized
        ? { authorization: 'Bearer owner-secret', 'sec-fetch-site': 'cross-site' }
        : { 'sec-fetch-site': 'cross-site' },
    }), context, { requestIP: () => ({ address: '203.0.113.1' }) } as never, null, createDevProxyRuntimeRef()),
  };
}

function request(path = '/v1/ux-sim/devices', method = 'GET', authorized = true) {
  return setupRequest().request(path, method, authorized);
}

test('GET /v1/ux-sim/devices is owner-gated, read-only, and returns the complete catalog', async () => {
  expect((await request('/v1/ux-sim/devices', 'GET', false))?.status).toBe(401);
  const harness = setupRequest();
  const before = { tabs: structuredClone(harness.state.tabs), events: structuredClone(harness.state.events) };
  const response = await harness.request();
  expect(response?.status).toBe(200);
  expect(await response!.json()).toEqual({
    catalogVersion: catalog.version,
    devices: catalog.devices,
    scenarios: catalog.scenarios,
    runEvidence: catalog.runEvidence,
    candidateAudit: catalog.candidateAudit,
    discovery: catalog.discovery,
  });
  expect({ tabs: harness.state.tabs, events: harness.state.events }).toEqual(before);
  expect(harness.publishEvents).toEqual([]);
  expect((await request('/v1/ux-sim/devices', 'POST'))?.status).toBe(405);
  expect((await request('/v1/devices'))?.status).toBe(503);
});
