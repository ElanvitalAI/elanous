// NEXUS · /v1/personas REST handlers (§6.4 · 2026-05-09).
//
// Covers `src/nexus/api/personas.ts` + global PersonaRegistry lazy
// init via `setGlobalPersonaRegistryDir` test seam.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  _resetGlobalPersonaRegistryForTest,
  awaitGlobalPersonaLoad,
  getGlobalPersonaRegistry,
  reloadGlobalPersonaRegistry,
  setGlobalPersonaRegistryDir,
} from '../src/persona/global-registry.js';
import { routeRequest, type NexusHttpServerOpts } from '../src/nexus/api/http-server.js';
import { createDevProxyRuntimeRef } from '../src/nexus/api/admin-dev-proxy.js';
import {
  dispatchPersonaRoute,
  handlePersonaCreate,
  handlePersonaGet,
  handlePersonaPatch,
  handlePersonaPresets,
  handlePersonasEvents,
  handlePersonasList,
} from '../src/nexus/api/personas.js';

let dir: string;
const originalPersonasDir = process.env.ELANOUS_PERSONAS_DIR;

function writePersona(name: string, body: string): void {
  writeFileSync(join(dir, `${name}.yaml`), body, 'utf8');
}

beforeEach(() => {
  _resetGlobalPersonaRegistryForTest();
  dir = mkdtempSync(join(tmpdir(), 'persona-rest-test-'));
  setGlobalPersonaRegistryDir(dir);
  process.env.ELANOUS_PERSONAS_DIR = dir;
});

afterEach(() => {
  _resetGlobalPersonaRegistryForTest();
  if (originalPersonasDir === undefined) delete process.env.ELANOUS_PERSONAS_DIR;
  else process.env.ELANOUS_PERSONAS_DIR = originalPersonasDir;
  rmSync(dir, { recursive: true, force: true });
});

describe('§6.4 · GET /v1/personas (list)', () => {
  test('empty dir → empty array · count 0', async () => {
    const req = new Request('http://localhost/v1/personas');
    const res = await handlePersonasList(req);
    expect(res.status).toBe(200);
    const body = await res.json() as { personas: unknown[]; count: number };
    expect(body.count).toBe(0);
    expect(body.personas).toEqual([]);
  });

  test('fixture persona is the only persona returned through the dispatcher', async () => {
    writePersona('fixture-only', `personaId: fixture-only\ndisplayName: Fixture only\n`);

    const res = await dispatchPersonaRoute(
      new Request('http://localhost/v1/personas'),
      '/v1/personas',
    );

    expect(res?.status).toBe(200);
    const body = await res!.json() as { personas: Array<{ personaId: string }>; count: number };
    expect(body.count).toBe(1);
    expect(body.personas.map((persona) => persona.personaId)).toEqual(['fixture-only']);
  });

  test('explicit reload isolates dispatch from repository personas', async () => {
    writePersona('fixture-only', `
personaId: fixture-only
displayName: Fixture only
`);
    await awaitGlobalPersonaLoad();

    const isolatedReloadDir = mkdtempSync(join(tmpdir(), 'persona-rest-reload-'));
    try {
      writeFileSync(join(isolatedReloadDir, 'reload-only.yaml'), `
personaId: reload-only
displayName: Reload only
`, 'utf8');
      await reloadGlobalPersonaRegistry(isolatedReloadDir);

      const res = await dispatchPersonaRoute(
        new Request('http://localhost/v1/personas'),
        '/v1/personas',
      );
      expect(res!.status).toBe(200);
      const body = await res!.json() as {
        personas: Array<{ personaId: string; displayName: string }>;
        count: number;
      };
      expect(body.count).toBe(1);
      expect(body.personas).toEqual([{ personaId: 'reload-only', displayName: 'Reload only' }]);
    } finally {
      rmSync(isolatedReloadDir, { recursive: true, force: true });
    }
  });

  test('two personas → sorted by displayName · wire shape', async () => {
    writePersona('alpha', `
personaId: alpha
displayName: Z-Last
systemPrompt: |
  You are Z-Last.
brand: claude
`);
    writePersona('beta', `
personaId: beta
displayName: A-First
systemPrompt: |
  You are A-First.
brand: codex
brandColor: '#dc2626'
`);
    await awaitGlobalPersonaLoad();
    const res = await handlePersonasList(new Request('http://localhost/v1/personas'));
    expect(res.status).toBe(200);
    const body = await res.json() as {
      personas: Array<{ personaId: string; displayName: string; brand?: string; brandColor?: string }>;
      count: number;
    };
    expect(body.count).toBe(2);
    expect(body.personas[0]?.displayName).toBe('A-First');
    expect(body.personas[0]?.personaId).toBe('beta');
    expect(body.personas[0]?.brand).toBe('codex');
    expect(body.personas[0]?.brandColor).toBe('#dc2626');
    expect(body.personas[1]?.displayName).toBe('Z-Last');
  });

  test('checkAuth fail → 401', async () => {
    const res = await handlePersonasList(
      new Request('http://localhost/v1/personas'),
      { checkAuth: () => false },
    );
    expect(res.status).toBe(401);
  });
});

describe('§6.4 · GET /v1/personas/:personaId', () => {
  test('known id → 200 + persona body', async () => {
    writePersona('skeptic', `
personaId: skeptic
displayName: Skeptic
description: Challenges every assumption
systemPrompt: |
  Always question.
brand: claude
`);
    await awaitGlobalPersonaLoad();
    const res = await handlePersonaGet(
      new Request('http://localhost/v1/personas/skeptic'),
      'skeptic',
    );
    expect(res.status).toBe(200);
    const body = await res.json() as {
      persona: {
        personaId: string;
        displayName: string;
        description?: string;
        systemPrompt?: string;
      };
    };
    expect(body.persona.personaId).toBe('skeptic');
    expect(body.persona.displayName).toBe('Skeptic');
    expect(body.persona.description).toBe('Challenges every assumption');
    expect(body.persona.systemPrompt).toContain('Always question.');
  });

  test('unknown id → 404', async () => {
    const res = await handlePersonaGet(
      new Request('http://localhost/v1/personas/missing'),
      'missing',
    );
    expect(res.status).toBe(404);
  });
});

describe('§6.4 · dispatchPersonaRoute', () => {
  test('GET /v1/personas → list', async () => {
    const res = await dispatchPersonaRoute(
      new Request('http://localhost/v1/personas'),
      '/v1/personas',
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
  });

  test('GET /v1/personas/:id → get', async () => {
    writePersona('alpha', `
personaId: alpha
displayName: Alpha
systemPrompt: hi
`);
    await awaitGlobalPersonaLoad();
    const res = await dispatchPersonaRoute(
      new Request('http://localhost/v1/personas/alpha'),
      '/v1/personas/alpha',
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
  });

  test('POST /v1/personas → 400 when the request has no preset and name', async () => {
    const res = await dispatchPersonaRoute(
      new Request('http://localhost/v1/personas', { method: 'POST', body: '{}' }),
      '/v1/personas',
    );
    expect(res?.status).toBe(400);
  });

  test('non-personas pathname → null (caller chains)', async () => {
    const res = await dispatchPersonaRoute(
      new Request('http://localhost/v1/other'),
      '/v1/other',
    );
    expect(res).toBeNull();
  });

  test('URL-encoded id', async () => {
    writePersona('with-dashes', `
personaId: with-dashes
displayName: With Dashes
`);
    await awaitGlobalPersonaLoad();
    const res = await dispatchPersonaRoute(
      new Request('http://localhost/v1/personas/with-dashes'),
      '/v1/personas/with-dashes',
    );
    expect(res!.status).toBe(200);
    const body = await res!.json() as { persona: { personaId: string } };
    expect(body.persona.personaId).toBe('with-dashes');
  });

  test('R6 Task 3 — /v1/personas/events routes to SSE handler (not /:id 404)', async () => {
    await awaitGlobalPersonaLoad();
    const res = await dispatchPersonaRoute(
      new Request('http://localhost/v1/personas/events'),
      '/v1/personas/events',
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.headers.get('content-type')).toContain('text/event-stream');
    // Drain so the underlying ReadableStream cancellation runs
    // immediately and the test doesn't leak a long-lived stream.
    res!.body?.cancel();
  });

  test('R6 Task 3 — /v1/personas/events POST → 405', async () => {
    await awaitGlobalPersonaLoad();
    const res = await dispatchPersonaRoute(
      new Request('http://localhost/v1/personas/events', { method: 'POST' }),
      '/v1/personas/events',
    );
    expect(res!.status).toBe(405);
  });
});

describe('§6.4 · R6 Task 3 — SSE handler', () => {
  test('hello frame is sent immediately with current count', async () => {
    writePersona('alpha', `
personaId: alpha
displayName: Alpha
`);
    await awaitGlobalPersonaLoad();
    const res = handlePersonasEvents(new Request('http://localhost/v1/personas/events'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toContain('no-cache');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const { value } = await reader.read();
    const text = decoder.decode(value);
    expect(text).toContain('event: hello');
    expect(text).toContain('"count":1');
    void reader.cancel();
  });

  test('upsert event is forwarded after a registry reload', async () => {
    await awaitGlobalPersonaLoad();
    const res = handlePersonasEvents(new Request('http://localhost/v1/personas/events'));
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // Drain hello frame.
    await reader.read();

    // Trigger an emit on the registry (synthetic upsert from outside
    // — same event shape the fs.watch path would produce).
    const registry = getGlobalPersonaRegistry();
    writePersona('gamma', `
personaId: gamma
displayName: Gamma
`);
    await registry.reloadFile(join(dir, 'gamma.yaml'));

    // The upsert event should land in the next read.
    const { value } = await reader.read();
    const text = decoder.decode(value);
    expect(text).toContain('event: upsert');
    expect(text).toContain('"personaId":"gamma"');
    void reader.cancel();
  });

  test('checkAuth=false → 401 without opening a stream', () => {
    const res = handlePersonasEvents(
      new Request('http://localhost/v1/personas/events'),
      { checkAuth: () => false },
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});

describe('preset catalog and persona creation', () => {
  test('GET serves the shipped catalog and rejects unauthenticated requests', async () => {
    const req = new Request('http://localhost/v1/persona-presets');
    expect(handlePersonaPresets(req, { checkAuth: () => false }).status).toBe(401);
    const res = await dispatchPersonaRoute(req, '/v1/persona-presets');
    expect(res?.status).toBe(200);
    const body = await res!.json() as { presets: Array<{ personaId: string; displayName: string }> };
    expect(body.presets.length).toBeGreaterThan(0);
    expect(body.presets[0]?.personaId).toBeTruthy();
    expect(body.presets[0]?.displayName).toBeTruthy();
  });

  test('HTTP routing requires owner auth and reaches GET catalog, POST create and PATCH edit', async () => {
    const opts = { metaApi: { bearerToken: 'owner-secret' } } as unknown as NexusHttpServerOpts;
    const server = { requestIP: () => ({ address: '203.0.113.10' }) };
    const route = (method: string, path: string, body?: object, authorized = true) => routeRequest(
      new Request(`http://localhost${path}`, {
        method,
        headers: authorized ? { authorization: 'Bearer owner-secret' } : {},
        ...(body ? { body: JSON.stringify(body) } : {}),
      }), opts, server as unknown as Parameters<typeof routeRequest>[2], null, createDevProxyRuntimeRef(),
    );
    expect((await route('GET', '/v1/persona-presets', undefined, false))?.status).toBe(401);
    expect((await route('POST', '/v1/personas', { preset: 'x', name: 'N' }, false))?.status).toBe(401);
    expect((await route('PATCH', '/v1/personas/alpha', { description: 'x' }, false))?.status).toBe(401);
    const catalog = await route('GET', '/v1/persona-presets');
    expect(catalog?.status).toBe(200);
    const { presets } = await catalog!.json() as { presets: Array<{ personaId: string }> };
    const created = await route('POST', '/v1/personas', { preset: presets[0]!.personaId, name: 'API Friend' });
    expect(created?.status).toBe(201);
    const patched = await route('PATCH', '/v1/personas/api-friend', { displayName: 'API Renamed', systemPrompt: 'one\ntwo' });
    expect(patched?.status).toBe(200);
    expect((await patched!.json() as { persona: { systemPrompt: string } }).persona.systemPrompt).toBe('one\ntwo');
  });

  test('POST clones a preset, reloads the registry, rejects duplicate names and missing presets', async () => {
    const presetRes = handlePersonaPresets(new Request('http://localhost/v1/persona-presets'));
    const { presets } = await presetRes.json() as { presets: Array<{ personaId: string }> };
    const preset = presets[0]!.personaId;
    const request = () => new Request('http://localhost/v1/personas', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ preset, name: 'Custom Friend' }),
    });
    expect((await handlePersonaCreate(request(), { checkAuth: () => false })).status).toBe(401);
    const res = await dispatchPersonaRoute(request(), '/v1/personas');
    expect(res?.status).toBe(201);
    const body = await res!.json() as { persona: { personaId: string; displayName: string } };
    expect(body.persona.personaId).toBe('custom-friend');
    expect(body.persona.displayName).toContain('Custom Friend');
    expect(getGlobalPersonaRegistry().get(body.persona.personaId)?.displayName).toBe(body.persona.displayName);
    expect(readFileSync(join(dir, 'custom-friend.yaml'), 'utf8')).toContain('personaId: custom-friend');
    expect((await handlePersonaCreate(request())).status).toBe(409);
    const missing = new Request('http://localhost/v1/personas', {
      method: 'POST', body: JSON.stringify({ preset: 'does-not-exist', name: 'Somebody' }),
    });
    expect((await handlePersonaCreate(missing)).status).toBe(404);
  });
});

describe('§Phase 3 · PATCH /v1/personas/:id (description edit)', () => {
  test('updates description + reloads registry', async () => {
    writePersona('alpha', `personaId: alpha
displayName: Alpha
description: old desc
`);
    await awaitGlobalPersonaLoad();

    const req = new Request('http://localhost/v1/personas/alpha', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'new description text' }),
    });
    const res = await handlePersonaPatch(req, 'alpha');
    expect(res.status).toBe(200);
    const body = await res.json() as { persona: { personaId: string; description?: string } };
    expect(body.persona.personaId).toBe('alpha');
    expect(body.persona.description).toBe('new description text');
  });

  test('edits displayName, description and multiline systemPrompt without losing identity', async () => {
    writePersona('alpha', 'personaId: alpha\ndisplayName: Alpha\ndescription: Before\nsystemPrompt: Before\n');
    const prompt = 'First line\nSecond line';
    const req = new Request('http://localhost/v1/personas/alpha', {
      method: 'PATCH', body: JSON.stringify({ displayName: 'Renamed', description: 'After', systemPrompt: prompt }),
    });
    const res = await dispatchPersonaRoute(req, '/v1/personas/alpha');
    expect(res?.status).toBe(200);
    const { persona } = await res!.json() as { persona: { personaId: string; displayName: string; description: string; systemPrompt: string } };
    expect(persona).toMatchObject({ personaId: 'alpha', displayName: 'Renamed', description: 'After', systemPrompt: prompt });
    expect(readFileSync(join(dir, 'alpha.yaml'), 'utf8')).toContain('Second line');
    expect((await handlePersonaPatch(new Request('http://localhost/v1/personas/alpha', {
      method: 'PATCH', body: JSON.stringify({ personaId: 'other', displayName: 'Unsafe' }),
    }), 'alpha')).status).toBe(400);
    expect(getGlobalPersonaRegistry().get('alpha')?.displayName).toBe('Renamed');
  });

  test('description-only edit preserves YAML comments and unrelated keys', async () => {
    writePersona('alpha', '# Keep me\npersonaId: alpha\ndisplayName: Alpha\ndescription: before\ncustomKey: custom value\n');
    const res = await handlePersonaPatch(new Request('http://localhost/v1/personas/alpha', {
      method: 'PATCH', body: JSON.stringify({ description: 'after' }),
    }), 'alpha');
    expect(res.status).toBe(200);
    const yaml = readFileSync(join(dir, 'alpha.yaml'), 'utf8');
    expect(yaml).toContain('# Keep me');
    expect(yaml).toContain('customKey: custom value');
    expect(yaml).toContain('description: "after"');
  });

  test('404 on unknown personaId', async () => {
    await awaitGlobalPersonaLoad();
    const req = new Request('http://localhost/v1/personas/ghost', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'whatever' }),
    });
    const res = await handlePersonaPatch(req, 'ghost');
    expect(res.status).toBe(404);
  });

  test('400 on missing description field', async () => {
    writePersona('beta', `personaId: beta\ndisplayName: Beta\n`);
    await awaitGlobalPersonaLoad();
    const req = new Request('http://localhost/v1/personas/beta', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const res = await handlePersonaPatch(req, 'beta');
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('description-required');
  });

  test('400 on malformed JSON', async () => {
    await awaitGlobalPersonaLoad();
    const req = new Request('http://localhost/v1/personas/x', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    const res = await handlePersonaPatch(req, 'x');
    expect(res.status).toBe(400);
  });

  test('401 when checkAuth fails (auth wrapper passthrough)', async () => {
    const req = new Request('http://localhost/v1/personas/x', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'x' }),
    });
    const res = await handlePersonaPatch(req, 'x', { checkAuth: () => false });
    expect(res.status).toBe(401);
  });

  test('dispatchPersonaRoute routes PATCH to handlePersonaPatch', async () => {
    writePersona('gamma', `personaId: gamma\ndisplayName: Gamma\n`);
    await awaitGlobalPersonaLoad();
    const req = new Request('http://localhost/v1/personas/gamma', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'routed.' }),
    });
    const res = await dispatchPersonaRoute(req, '/v1/personas/gamma');
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
  });
});
