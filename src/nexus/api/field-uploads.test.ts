import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../../elanous-config-dir.js';
import { createNexusState } from '../state/state.js';
import { TabRegistry } from '../state/tab-registry.js';
import { createDevProxyRuntimeRef } from './admin-dev-proxy.js';
import { NexusEventBus } from './event-bus.js';
import { handleFieldUploads } from './field-uploads.js';
import { routeRequest } from './http-server.js';

const roots: string[] = [];
afterEach(() => {
  resetElanousConfigDir();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
function root(): string {
  const r = mkdtempSync(join(tmpdir(), 'field-uploads-'));
  roots.push(r);
  return r;
}
const NOW = () => new Date('2026-10-15T10:00:00.000Z');
const URL_BASE = 'http://localhost/v1/field/uploads';

function multipart(files: Array<{ name: string; type: string; size: number }>, capturedAt?: string[] | string): FormData {
  const form = new FormData();
  for (const f of files) form.append('file', new File([new Uint8Array(f.size).fill(1)], f.name, { type: f.type }));
  if (Array.isArray(capturedAt)) for (const c of capturedAt) form.append('capturedAt', c);
  else if (capturedAt !== undefined) form.append('capturedAt', capturedAt);
  return form;
}

describe('handleFieldUploads (direct)', () => {
  test('multipart: saves every file part, uses per-file capturedAt, returns count and refreshes .ready', async () => {
    const rootDir = root();
    const res = await handleFieldUploads(new Request(`${URL_BASE}?event=marketers-night-2026-10&device=iphone`, {
      method: 'POST',
      body: multipart([{ name: 'IMG_1.jpg', type: 'image/jpeg', size: 3 }, { name: 'clip.mov', type: 'video/quicktime', size: 5 }],
        ['2026-10-15T19:30:12+09:00', '']),
    }), { authorize: () => true, rootDir: () => rootDir, now: NOW });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true, event: 'marketers-night-2026-10', count: 2,
      saved: [
        { name: '20261015T103012Z-iphone-IMG_1.jpg', bytes: 3 },
        { name: '20261015T100000Z-iphone-clip.mov', bytes: 5 },
      ],
    });
    expect(readFileSync(join(rootDir, 'field', 'marketers-night-2026-10', '.ready'), 'utf8')).toBe('2\n');
  });

  test('multipart: capturedAt may be one JSON array', async () => {
    const rootDir = root();
    const res = await handleFieldUploads(new Request(`${URL_BASE}?event=ev&device=d`, {
      method: 'POST',
      body: multipart([{ name: 'a.png', type: 'image/png', size: 1 }, { name: 'b.png', type: 'image/png', size: 2 }],
        JSON.stringify([null, '2026-10-15T11:00:00Z'])),
    }), { authorize: () => true, rootDir: () => rootDir, now: NOW });
    const body = await res.json() as { saved: Array<{ name: string }> };
    expect(body.saved.map((s) => s.name)).toEqual(['20261015T100000Z-d-a.png', '20261015T110000Z-d-b.png']);
  });

  test('JSON body: { files: [{ name, mimeType, dataBase64, capturedAt? }] }', async () => {
    const rootDir = root();
    const res = await handleFieldUploads(new Request(`${URL_BASE}?event=ev&device=pixel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ files: [{ name: 'p.webp', mimeType: 'image/webp', dataBase64: Buffer.from('hello').toString('base64'), capturedAt: '2026-10-15T09:00:00Z' }] }),
    }), { authorize: () => true, rootDir: () => rootDir, now: NOW });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, event: 'ev', count: 1, saved: [{ name: '20261015T090000Z-pixel-p.webp', bytes: 5 }] });
    expect(readFileSync(join(rootDir, 'field', 'ev', '20261015T090000Z-pixel-p.webp'), 'utf8')).toBe('hello');

    const list = await handleFieldUploads(new Request(`${URL_BASE}?event=ev`), { authorize: () => true, rootDir: () => rootDir });
    expect(await list.json()).toEqual({ event: 'ev', count: 1, files: [{ name: '20261015T090000Z-pixel-p.webp', bytes: 5 }] });
    const empty = await handleFieldUploads(new Request(`${URL_BASE}?event=nothing-yet`), { authorize: () => true, rootDir: () => rootDir });
    expect(await empty.json()).toEqual({ event: 'nothing-yet', count: 0, files: [] });
  });

  test('bad slug → 400 · bad type → 415 · unauthorized → 401 · oversize content-length → 413', async () => {
    const rootDir = root();
    const deps = { authorize: () => true, rootDir: () => rootDir };
    const post = (qs: string, init: RequestInit = {}) => handleFieldUploads(new Request(`${URL_BASE}?${qs}`, { method: 'POST', ...init }), deps);
    const good = () => multipart([{ name: 'a.jpg', type: 'image/jpeg', size: 1 }]);
    expect((await post('event=Bad%20Event&device=d', { body: good() })).status).toBe(400);
    expect((await post('event=ev&device=../x', { body: good() })).status).toBe(400);
    expect((await post('event=ev', { body: good() })).status).toBe(400);
    expect((await handleFieldUploads(new Request(`${URL_BASE}?event=..`), deps)).status).toBe(400);
    const gif = await post('event=ev&device=d', { body: multipart([{ name: 'a.gif', type: 'image/gif', size: 1 }]) });
    expect(gif.status).toBe(415);
    expect(await gif.json()).toMatchObject({ ok: false, error: 'unsupported-media-type' });
    expect((await post('event=ev&device=d', { headers: { 'content-type': 'text/plain' }, body: 'x' })).status).toBe(415);
    expect((await post('event=ev&device=d', { body: multipart([]) })).status).toBe(400);
    expect((await post('event=ev&device=d', {
      headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': String(600 * 1024 * 1024) }, body: 'x',
    })).status).toBe(413);
    const denied = await handleFieldUploads(new Request(`${URL_BASE}?event=ev&device=d`, { method: 'POST', body: good() }),
      { authorize: () => false, rootDir: () => rootDir });
    expect(denied.status).toBe(401);
    expect((await handleFieldUploads(new Request(`${URL_BASE}?event=ev`), deps)).status).toBe(200);
  });
});

describe('routeRequest wiring', () => {
  function call(path: string, init: RequestInit, bearer: boolean) {
    const bus = new NexusEventBus();
    const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
    state.bus = bus;
    const headers = new Headers(init.headers);
    headers.set('sec-fetch-site', 'cross-site');
    if (bearer) headers.set('authorization', 'Bearer owner-secret');
    return routeRequest(new Request(`http://localhost${path}`, { ...init, headers }),
      { state, registry: new TabRegistry(state), eventBus: bus, metaApi: { bearerToken: 'owner-secret', noAuth: false } },
      { requestIP: () => ({ address: '203.0.113.1' }) } as never, null, createDevProxyRuntimeRef());
  }

  test('owner bearer required for GET and POST; saves under the daemon config dir', async () => {
    const rootDir = root();
    setElanousConfigDir(rootDir);
    const body = () => multipart([{ name: 'a.jpg', type: 'image/jpeg', size: 2 }]);
    expect((await call('/v1/field/uploads?event=ev&device=d', { method: 'POST', body: body() }, false))?.status).toBe(401);
    expect((await call('/v1/field/uploads?event=ev', { method: 'GET' }, false))?.status).toBe(401);
    const ok = await call('/v1/field/uploads?event=ev&device=d', { method: 'POST', body: body() }, true);
    expect(ok?.status).toBe(200);
    expect(((await ok!.json()) as { count: number }).count).toBe(1);
    expect(readFileSync(join(rootDir, 'field', 'ev', '.ready'), 'utf8')).toBe('1\n');
    const list = await call('/v1/field/uploads?event=ev', { method: 'GET' }, true);
    expect(((await list!.json()) as { count: number }).count).toBe(1);
  });
});
