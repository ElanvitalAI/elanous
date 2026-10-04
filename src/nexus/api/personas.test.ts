import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _resetGlobalPersonaRegistryForTest,
  setGlobalPersonaRegistryDir,
} from '../../persona/global-registry.js';
import { loadPresets } from '../../persona/presets.js';
import { dispatchPersonaRoute } from './personas.js';
import { createDevProxyRuntimeRef } from './admin-dev-proxy.js';
import { routeRequest, type NexusHttpServerOpts } from './http-server.js';
import { isPublicRoute } from './public-routes.js';

const originalDir = process.env.ELANOUS_PERSONAS_DIR;
let dir: string;

beforeEach(() => {
  _resetGlobalPersonaRegistryForTest();
  dir = mkdtempSync(join(tmpdir(), 'nexus-personas-'));
  process.env.ELANOUS_PERSONAS_DIR = dir;
  setGlobalPersonaRegistryDir(dir);
});

afterEach(() => {
  _resetGlobalPersonaRegistryForTest();
  if (originalDir === undefined) delete process.env.ELANOUS_PERSONAS_DIR;
  else process.env.ELANOUS_PERSONAS_DIR = originalDir;
  rmSync(dir, { recursive: true, force: true });
});

const request = (path: string, method = 'GET', data?: unknown) => new Request(`http://localhost${path}`, {
  method,
  ...(data !== undefined ? { body: JSON.stringify(data), headers: { 'content-type': 'application/json' } } : {}),
});
const dispatch = (path: string, method = 'GET', data?: unknown) =>
  dispatchPersonaRoute(request(path, method, data), path);
const ownerToken = 'persona-owner-test-token';
const http = (path: string, method = 'GET', data?: unknown, token?: string) => routeRequest(
  new Request(`http://nexus.test${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(data !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
  }),
  { metaApi: { bearerToken: ownerToken, noAuth: false } } as NexusHttpServerOpts,
  {} as never, null, createDevProxyRuntimeRef(),
);

describe('persona REST routes', () => {
  test('HTTP GET presets and POST/PATCH personas are owner-only and registered in their method blocks', async () => {
    for (const [path, method, body] of [
      ['/v1/persona-presets', 'GET', undefined],
      ['/v1/personas', 'POST', { preset: 'mira', name: 'Owner Test' }],
      ['/v1/personas/owner-test', 'PATCH', { description: 'owner edit' }],
    ] as const) {
      expect(isPublicRoute(method, path, { setupMode: false })).toBe(false);
      expect((await http(path, method, body))?.status).toBe(401);
      expect((await http(path, method, body, 'wrong-token'))?.status).toBe(401);
    }
    const catalog = await http('/v1/persona-presets', 'GET', undefined, ownerToken);
    expect(catalog?.status).toBe(200);
    expect((await catalog!.json()).presets).toEqual(loadPresets());
    const created = await http('/v1/personas', 'POST', { preset: 'mira', name: 'Owner Test' }, ownerToken);
    expect(created?.status).toBe(201);
    expect((await created!.json()).persona.personaId).toBe('owner-test');
    const patched = await http('/v1/personas/owner-test', 'PATCH', { description: 'owner edit' }, ownerToken);
    expect(patched?.status).toBe(200);
    expect((await patched!.json()).persona.description).toBe('owner edit');
  });
  test('GET preset catalog returns the shipped presets in index order; unauthorized calls do not read it', async () => {
    const path = '/v1/persona-presets';
    const denied = await dispatchPersonaRoute(request(path), path, { checkAuth: () => false });
    expect(denied?.status).toBe(401);
    const response = await dispatch(path);
    expect(response?.status).toBe(200);
    expect((await response!.json()).presets).toEqual(loadPresets());
  });

  test('POST clones a preset, PATCH edits fields and retains provenance; unauthorized writes leave state untouched', async () => {
    const denied = await dispatchPersonaRoute(request('/v1/personas', 'POST', { preset: 'mira', name: 'Nexus Test' }),
      '/v1/personas', { checkAuth: () => false });
    expect(denied?.status).toBe(401);
    expect((await dispatch('/v1/personas', 'POST', { preset: 'absent', name: 'Nexus Test' }))?.status).toBe(404);
    const created = await dispatch('/v1/personas', 'POST', { preset: 'mira', name: 'Nexus Test' });
    expect(created?.status).toBe(201);
    const { persona } = await created!.json();
    expect(persona.personaId).toBe('nexus-test');
    const path = `/v1/personas/${persona.personaId}`;
    const forbidden = await dispatchPersonaRoute(request(path, 'PATCH', { displayName: 'No' }), path, { checkAuth: () => false });
    expect(forbidden?.status).toBe(401);
    const changed = await dispatch(path, 'PATCH', { displayName: 'Edited', description: 'New description', systemPrompt: 'New\nPrompt' });
    expect(changed?.status).toBe(200);
    expect((await changed!.json()).persona).toMatchObject({
      personaId: persona.personaId, displayName: 'Edited', description: 'New description', systemPrompt: 'New\nPrompt',
    });
    const saved = readFileSync(join(dir, `${persona.personaId}.yaml`), 'utf8');
    expect(saved).toContain('preset:');
    expect(saved).toContain('New description');
    expect((await dispatch(path))?.status).toBe(200);
  });

  test('GET keeps decoded IDs with dots or non-ASCII as lookups; PATCH still validates write IDs', async () => {
    for (const id of ['name.with.dot', '한글']) {
      const path = `/v1/personas/${encodeURIComponent(id)}`;
      const read = await dispatch(path);
      expect(read?.status).toBe(404);
      expect((await read!.json()).error).toBe(`persona ${id} not found`);
      const write = await dispatch(path, 'PATCH', { description: 'Unsafe' });
      expect(write?.status).toBe(400);
      expect((await write!.json()).error).toBe('invalid-persona-id');
    }
  });
});
