import { describe, expect, test } from 'bun:test';

import { NexusEventBus } from '../src/nexus/api/event-bus.js';
import { startNexusHttpServer } from '../src/nexus/api/http-server.js';
import { isPublicRoute } from '../src/nexus/api/public-routes.js';
import { DESIGN_DIRECTION_PATH } from '../src/nexus/api/rest-route-paths.js';
import { createNexusState } from '../src/nexus/state/state.js';
import { TabRegistry } from '../src/nexus/state/tab-registry.js';

const BEARER = 'design-direction-route-owner-token';

function start(metaApi?: { bearerToken: string; noAuth: false }) {
  const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
  const eventBus = new NexusEventBus();
  state.bus = eventBus;
  return startNexusHttpServer({
    state,
    eventBus,
    registry: new TabRegistry(state),
    ...(metaApi ? { metaApi } : {}),
    startPort: 57500 + Math.floor(Math.random() * 500),
  });
}

function post(url: string, body: string, authorization?: string) {
  return fetch(`${url}${DESIGN_DIRECTION_PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'sec-fetch-site': 'cross-site',
      ...(authorization ? { authorization } : {}),
    },
    body,
  });
}

describe('POST /v1/design-direction — HTTP route and owner authentication', () => {
  test('is not public; no owner credential denies the write before parsing its body', async () => {
    expect(DESIGN_DIRECTION_PATH).toBe('/v1/design-direction');
    expect(isPublicRoute('POST', DESIGN_DIRECTION_PATH, { setupMode: false })).toBe(false);
    const server = start({ bearerToken: BEARER, noAuth: false });
    try {
      const response = await post(server.url, '{not-json');
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'unauthorized' });
    } finally {
      server.stop();
    }
  });

  test('a wrong bearer is denied and a missing auth runtime fails closed', async () => {
    for (const metaApi of [{ bearerToken: BEARER, noAuth: false } as const, undefined]) {
      const server = start(metaApi);
      try {
        const response = await post(server.url, '{not-json', 'Bearer wrong-token');
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: 'unauthorized' });
      } finally {
        server.stop();
      }
    }
  });

  test('a valid owner bearer reaches the design-direction handler', async () => {
    const server = start({ bearerToken: BEARER, noAuth: false });
    try {
      const malformed = await post(server.url, '{not-json', `Bearer ${BEARER}`);
      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toEqual({ ok: false, reason: 'invalid-json' });
      const missingId = await post(server.url, '{}', `Bearer ${BEARER}`);
      expect(missingId.status).toBe(400);
      expect(await missingId.json()).toEqual({ ok: false, reason: 'id-required' });
    } finally {
      server.stop();
    }
  });

  test('GET design-check remains reachable; GET design-direction does not select', async () => {
    const server = start({ bearerToken: BEARER, noAuth: false });
    try {
      const headers = { authorization: `Bearer ${BEARER}`, 'sec-fetch-site': 'cross-site' };
      const check = await fetch(`${server.url}/v1/design-check`, { headers });
      expect(check.status).toBe(200);
      expect(await check.json()).toHaveProperty('ok');
      const selection = await fetch(`${server.url}${DESIGN_DIRECTION_PATH}`, { headers });
      expect(selection.status).toBe(404);
    } finally {
      server.stop();
    }
  });
});
