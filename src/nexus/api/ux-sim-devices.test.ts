import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestStateRoot, setTestStateRoot } from '../paths.js';
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
    context,
    request: (path = '/v1/ux-sim/devices', method = 'GET', authorized = true) => routeRequest(new Request('http://localhost' + path, {
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

async function postRequest(harness: ReturnType<typeof setupRequest>, body: Record<string, unknown>) {
  return routeRequest(new Request('http://localhost/v1/ux-sim/devices', {
    method: 'POST',
    headers: { authorization: 'Bearer owner-secret', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }), harness.context, { requestIP: () => ({ address: '203.0.113.1' }) } as never, null, createDevProxyRuntimeRef());
}

test('GET /v1/ux-sim/devices is owner-gated, read-only, and returns the complete catalog', async () => {
  expect((await request('/v1/ux-sim/devices', 'GET', false))?.status).toBe(401);
  const harness = setupRequest();
  const before = { tabs: structuredClone(harness.state.tabs), events: structuredClone(harness.state.events) };
  const response = await harness.request();
  expect(response?.status).toBe(200);
  expect(await response!.json()).toEqual({
    catalogVersion: catalog.version,
    deviceCatalogVersion: catalog.deviceCatalogVersion,
    devices: catalog.devices,
    scenarios: catalog.scenarios,
    runEvidence: catalog.runEvidence,
    candidateAudit: catalog.candidateAudit,
    discovery: catalog.discovery,
  });
  expect({ tabs: harness.state.tabs, events: harness.state.events }).toEqual(before);
  expect(harness.publishEvents).toEqual([]);
  expect((await request('/v1/ux-sim/devices', 'POST'))?.status).toBe(403);
  expect((await request('/v1/ux-sim/devices', 'PUT'))?.status).toBe(405);
  expect((await request('/v1/devices'))?.status).toBe(503);
});

test('test-universe POST requests and GET missing list are owner-gated and isolated', async () => {
  const previousRoot = getTestStateRoot();
  const root = mkdtempSync(join(tmpdir(), 'ux-sim-device-api-'));
  setTestStateRoot(root);
  try {
    const harness = setupRequest();
    const created = await postRequest(harness, { cellId: 'SIM-DEVICE-REQUEST-NEXUS', boundary: 'API request flow', nearestDeviceId: 'scenario-runner' });
    expect(created?.status).toBe(201);
    const listed = await harness.request('/v1/ux-sim/devices?missing');
    expect(listed?.status).toBe(200);
    expect(await listed!.json()).toMatchObject({ missing: [{ cellId: 'SIM-DEVICE-REQUEST-NEXUS' }], resolved: [] });

    const invalid = await postRequest(harness, { cellId: '../bad', boundary: 'invalid', nearestDeviceId: 'scenario-runner' });
    expect(invalid?.status).toBe(400);

    const unauthorized = await routeRequest(new Request('http://localhost/v1/ux-sim/devices', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cellId: 'SIM-DEVICE-REQUEST-NEXUS', boundary: 'unauthorized', nearestDeviceId: 'scenario-runner' }),
    }), harness.context, { requestIP: () => ({ address: '203.0.113.1' }) } as never, null, createDevProxyRuntimeRef());
    expect(unauthorized?.status).toBe(401);

    rmSync(join(root, 'mock-device-requests', 'requests'), { recursive: true, force: true });
    writeFileSync(join(root, 'mock-device-requests', 'requests'), 'not-a-directory');
    const unavailable = await postRequest(harness, { cellId: 'SIM-DEVICE-REQUEST-NEXUS', boundary: 'storage fails', nearestDeviceId: 'scenario-runner' });
    expect(unavailable?.status).toBe(500);
    expect(await unavailable!.json()).toMatchObject({ error: 'mock-device-request-storage-failed' });
  } finally {
    setTestStateRoot(previousRoot ?? null);
    rmSync(root, { recursive: true, force: true });
  }
});
