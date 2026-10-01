import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
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
function mp4(): Buffer {
  const rendered = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=32x32:r=1',
    '-frames:v', '1', '-c:v', 'mpeg4', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1'],
  { maxBuffer: 1024 * 1024 });
  if (rendered.status !== 0) throw new Error(`test video fixture failed: ${rendered.stderr.toString()}`);
  return rendered.stdout;
}

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

  test('multipart per-file captions, status/list and authenticated finished video download', async () => {
    const rootDir = root();
    const form = multipart([{ name: 'a.jpg', type: 'image/jpeg', size: 1 }, { name: 'b.jpg', type: 'image/jpeg', size: 1 }]);
    form.append('caption', '첫 장'); form.append('caption', '둘째 장');
    const video = mp4();
    const runner = async (dir: string) => {
      writeFileSync(join(dir, 'reel', 'reel-9x16.mp4'), video);
      return { ok: true, file: join(dir, 'reel', 'reel-9x16.mp4'), seconds: 42 };
    };
    const deps = { authorize: () => true, rootDir: () => rootDir, reel: { quietMs: 10, runner } };
    const post = await handleFieldUploads(new Request(`${URL_BASE}?event=ev&device=d`, { method: 'POST', body: form }), deps);
    const body = await post.json() as { saved: Array<{ name: string }> };
    const dir = join(rootDir, 'field', 'ev');
    expect(readFileSync(join(dir, 'captions.txt'), 'utf8')).toBe(`${body.saved[0]!.name} | 첫 장\n${body.saved[1]!.name} | 둘째 장\n`);
    const listed = await handleFieldUploads(new Request(`${URL_BASE}?event=ev`), deps);
    expect((await listed.json() as { reel: unknown }).reel).toEqual({ status: 'waiting', updatedAt: expect.any(String) });
    const waiting = await handleFieldUploads(new Request('http://localhost/v1/field/reel?event=ev'), deps);
    expect(await waiting.json()).toEqual({ event: 'ev', state: 'waiting', items: 2 });
    expect((await handleFieldUploads(new Request('http://localhost/v1/field/reel/file?event=ev'), deps)).status).toBe(404);
    for (let i = 0; i < 100; i++) {
      if (JSON.parse(readFileSync(join(dir, '.reel-status.json'), 'utf8')).state === 'done') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const status = await handleFieldUploads(new Request('http://localhost/v1/field/reel?event=ev'), deps);
    expect(await status.json()).toMatchObject({ event: 'ev', state: 'done', items: 2, seconds: 42, url: '/v1/field/reel/file?event=ev' });
    const listDone = await handleFieldUploads(new Request(`${URL_BASE}?event=ev`), deps);
    expect((await listDone.json() as { reel: unknown }).reel).toMatchObject({ status: 'done', url: '/v1/field/reel/file?event=ev', updatedAt: expect.any(String) });
    const file = await handleFieldUploads(new Request('http://localhost/v1/field/reel/file?event=ev'), deps);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('video/mp4');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array(video));
    expect((await handleFieldUploads(new Request('http://localhost/v1/field/reel?event=ev'), { ...deps, authorize: () => false })).status).toBe(401);
    expect((await handleFieldUploads(new Request('http://localhost/v1/field/reel/file?event=ev'), { ...deps, authorize: () => false })).status).toBe(401);
  });

  test('reel status distinguishes an uncreated event from waiting and exposes render failure reason', async () => {
    const rootDir = root();
    const deps = { authorize: () => true, rootDir: () => rootDir,
      reel: { quietMs: 10, runner: async () => ({ ok: false, seconds: 0, error: 'renderer unavailable' }) } };
    const reel = 'http://localhost/v1/field/reel?event=failed-event';
    const absent = await handleFieldUploads(new Request(reel), deps);
    expect(absent.status).toBe(404);
    expect(await absent.json()).toEqual({ error: 'not-found' });
    const post = await handleFieldUploads(new Request(`${URL_BASE}?event=failed-event&device=d`, {
      method: 'POST', body: multipart([{ name: 'a.jpg', type: 'image/jpeg', size: 1 }]),
    }), deps);
    expect(post.status).toBe(200);
    expect(await (await handleFieldUploads(new Request(reel), deps)).json())
      .toEqual({ event: 'failed-event', state: 'waiting', items: 1 });
    let failed: Response | undefined;
    for (let i = 0; i < 100; i++) {
      const response = await handleFieldUploads(new Request(reel), deps);
      if ((await response.clone().json() as { state: string }).state === 'failed') { failed = response; break; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(failed?.status).toBe(200);
    expect(await failed!.json()).toMatchObject({ event: 'failed-event', state: 'failed', items: 1, error: 'renderer unavailable' });
    expect((await handleFieldUploads(new Request('http://localhost/v1/field/reel/file?event=failed-event'), deps)).status).toBe(404);
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
    expect(await list.json()).toEqual({ event: 'ev', count: 1, files: [{ name: '20261015T090000Z-pixel-p.webp', bytes: 5 }],
      reel: { status: 'waiting', updatedAt: expect.any(String) } });
    const empty = await handleFieldUploads(new Request(`${URL_BASE}?event=nothing-yet`), { authorize: () => true, rootDir: () => rootDir });
    expect(await empty.json()).toEqual({ event: 'nothing-yet', count: 0, files: [] });
  });

  test('JSON per-item captions and one multipart caption only annotate the intended files', async () => {
    const rootDir = root();
    const deps = { authorize: () => true, rootDir: () => rootDir, now: NOW,
      reel: { quietMs: 20_000, runner: async () => ({ ok: false, seconds: 0, error: 'test runner' }) } };
    const file = (name: string, caption?: string) => ({ name, mimeType: 'image/jpeg', dataBase64: 'AQ==', ...(caption ? { caption } : {}) });
    const res = await handleFieldUploads(new Request(`${URL_BASE}?event=json-ev&device=d`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ files: [file('a.jpg', '첫 장'), file('b.jpg', '둘째 장')] }),
    }), deps);
    expect(res.status).toBe(200);
    const saved = (await res.json() as { saved: Array<{ name: string }> }).saved;
    expect(readFileSync(join(rootDir, 'field', 'json-ev', 'captions.txt'), 'utf8'))
      .toBe(`${saved[0]!.name} | 첫 장\n${saved[1]!.name} | 둘째 장\n`);
    const form = multipart([{ name: 'c.jpg', type: 'image/jpeg', size: 1 }, { name: 'd.jpg', type: 'image/jpeg', size: 1 }]);
    form.append('caption', '첫 파일만');
    const single = await handleFieldUploads(new Request(`${URL_BASE}?event=single-ev&device=d`, { method: 'POST', body: form }), deps);
    const names = (await single.json() as { saved: Array<{ name: string }> }).saved;
    expect(readFileSync(join(rootDir, 'field', 'single-ev', 'captions.txt'), 'utf8'))
      .toBe(`${names[0]!.name} | 첫 파일만\n`);
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
    expect((await call('/v1/field/reel?event=ev', { method: 'GET' }, false))?.status).toBe(401);
    expect((await call('/v1/field/reel/file?event=ev', { method: 'GET' }, false))?.status).toBe(401);
    expect((await call('/v1/field/reel/file?event=ev', { method: 'GET' }, true))?.status).toBe(404);
    const dir = join(rootDir, 'field', 'ev', 'reel');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'reel-9x16.mp4'), mp4());
    writeFileSync(join(rootDir, 'field', 'ev', '.reel-status.json'), JSON.stringify({ state: 'done', items: 1, updatedAt: '2026-10-01T00:00:00Z' }));
    expect((await call('/v1/field/reel/file?event=ev', { method: 'GET' }, true))?.headers.get('content-type')).toBe('video/mp4');
    // 디코딩 검사는 렌더 완료 때 한 번(field-reel.test.ts) — 요청 경로는 «있고 비어 있지 않다»만 본다(리뷰 R3: 요청마다 전체 ffprobe 금지).
    writeFileSync(join(dir, 'reel-9x16.mp4'), '');
    const invalid = await call('/v1/field/reel?event=ev', { method: 'GET' }, true);
    expect((await invalid!.json() as { url?: string }).url).toBeUndefined();
    expect((await call('/v1/field/reel/file?event=ev', { method: 'GET' }, true))?.status).toBe(404);
  });
});

describe('default event for the app (GET without event)', () => {
  test('returns the configured telegram.fieldDefaultEvent, else field-<local date>; still owner-only', async () => {
    const configured = await handleFieldUploads(new Request(URL_BASE), { authorize: () => true, now: NOW, configuredEvent: () => 'marketers-night-2026-10' });
    expect(configured.status).toBe(200);
    expect(await configured.json()).toEqual({ defaultEvent: 'marketers-night-2026-10' });
    const fallback = await handleFieldUploads(new Request(URL_BASE), { authorize: () => true, now: NOW, configuredEvent: () => undefined });
    expect(((await fallback.json()) as { defaultEvent: string }).defaultEvent).toMatch(/^field-\d{4}-\d{2}-\d{2}$/);
    const bad = await handleFieldUploads(new Request(URL_BASE), { authorize: () => true, now: NOW, configuredEvent: () => 'Bad Value' });
    expect(((await bad.json()) as { defaultEvent: string }).defaultEvent).toMatch(/^field-/);
    expect((await handleFieldUploads(new Request(URL_BASE), { authorize: () => false })).status).toBe(401);
  });
});
