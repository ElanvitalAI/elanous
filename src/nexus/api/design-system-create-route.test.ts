import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defaultDesignSystemsDir } from '../../design/design-systems.js';
import * as extractDesignRun from '../../webclone/extract-design-run.js';
import type { ExtractDesignResult } from '../../webclone/extract-design-run.js';
import { createDevProxyRuntimeRef } from './admin-dev-proxy.js';
import { NexusEventBus } from './event-bus.js';
import { startNexusHttpServer } from './http-server.js';
import { isPublicRoute } from './public-routes.js';
import { DESIGN_SYSTEM_PATH } from './rest-route-paths.js';
import { createNexusState } from '../state/state.js';
import { TabRegistry } from '../state/tab-registry.js';
import {
  handleDesignSystemCreate,
  resetDesignSystemCreateGate,
} from './design-system-create-route.js';

const roots: string[] = [];

afterEach(() => {
  resetDesignSystemCreateGate();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const tokens = JSON.stringify({
  customProperties: { '--bg': '#ffffff', '--fg': '#111111' },
});

function fakeExtract(outRoot: string): ExtractDesignResult {
  return {
    slug: 'linear-app',
    outDir: join(outRoot, 'linear-app'),
    viewport: { w: 1280, h: 800 },
    tokenCount: 2,
    paletteCount: 2,
    roleCount: 0,
    missingRoles: [],
    assets: [],
    assetNote: null,
    honoursReducedMotion: null,
    browserForcedReducedMotion: false,
  };
}

function libraryDeps(extractCalls: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'design-system-route-'));
  roots.push(root);
  return {
    libraryDirectory: () => join(root, 'library'),
    systemsDirectory: defaultDesignSystemsDir,
    extractRoot: () => join(root, 'extracts'),
    readFile: () => tokens,
    runExtractDesign: async (options: { url: string; outRoot: string }) => {
      extractCalls.push(options.url);
      return fakeExtract(options.outRoot);
    },
  };
}

function post(body: unknown): Request {
  return new Request('http://nexus.test/v1/design-system', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /v1/design-system', () => {
  test('without owner auth the response is 401 and the extractor is not called', async () => {
    expect(DESIGN_SYSTEM_PATH).toBe('/v1/design-system');
    expect(isPublicRoute('POST', DESIGN_SYSTEM_PATH, { setupMode: false })).toBe(false);
    const extract = spyOn(extractDesignRun, 'runExtractDesign').mockImplementation(async () => {
      throw new Error('extractor must not run');
    });
    const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
    const eventBus = new NexusEventBus();
    state.bus = eventBus;
    const server = startNexusHttpServer({
      state,
      eventBus,
      registry: new TabRegistry(state),
      metaApi: { bearerToken: 'design-system-owner', noAuth: false },
      startPort: 58000 + Math.floor(Math.random() * 400),
    });
    try {
      const response = await fetch(`${server.url}${DESIGN_SYSTEM_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
        body: JSON.stringify({ kind: 'url', url: 'https://stumptowncoffee.com' }),
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'unauthorized' });
      expect(extract).not.toHaveBeenCalled();
      const { routeRequest } = await import('./http-server.js');
      const direct = await routeRequest(new Request('http://127.0.0.1/v1/design-system', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          host: '127.0.0.1',
          origin: 'http://127.0.0.1',
          'sec-fetch-site': 'same-origin',
        },
        body: JSON.stringify({ kind: 'url', url: 'https://stumptowncoffee.com' }),
      }), {
        state,
        eventBus,
        registry: new TabRegistry(state),
        metaApi: { bearerToken: 'design-system-owner', noAuth: false },
      }, { upgrade: () => false, requestIP: () => ({ address: '127.0.0.1' }) } as never, null, createDevProxyRuntimeRef());
      expect(direct?.status).toBe(401);
      expect(await direct?.json()).toEqual({ error: 'unauthorized' });
      expect(extract).not.toHaveBeenCalled();
      const owner = await routeRequest(new Request('http://127.0.0.1/v1/design-system', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          host: '127.0.0.1',
          origin: 'http://127.0.0.1',
          'sec-fetch-site': 'same-origin',
          authorization: 'Bearer design-system-owner',
        },
        body: '{not-json',
      }), {
        state,
        eventBus,
        registry: new TabRegistry(state),
        metaApi: { bearerToken: 'design-system-owner', noAuth: false },
      }, { upgrade: () => false, requestIP: () => ({ address: '127.0.0.1' }) } as never, null, createDevProxyRuntimeRef());
      expect(owner?.status).toBe(400);
      expect(extract).not.toHaveBeenCalled();
    } finally {
      server.stop();
      extract.mockRestore();
    }
  });

  test('bad url is 400 and the extractor is not called', async () => {
    const calls: string[] = [];
    const res = await handleDesignSystemCreate(post({ kind: 'url', url: 'ftp://nope.example' }), libraryDeps(calls));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, reason: 'bad-url' });
    expect(calls).toEqual([]);
  });

  test('id-taken is 409', async () => {
    const deps = libraryDeps();
    const first = await handleDesignSystemCreate(post({ kind: 'url', url: 'https://linear.app', id: 'mine' }), deps);
    expect(first.status).toBe(201);
    const again = await handleDesignSystemCreate(post({ kind: 'url', url: 'https://linear.app', id: 'mine' }), deps);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ ok: false, reason: 'id-taken' });
  });

  test('extract failure is 502', async () => {
    const deps = libraryDeps();
    const res = await handleDesignSystemCreate(post({ kind: 'url', url: 'https://linear.app' }), {
      ...deps,
      runExtractDesign: async () => { throw new Error('chrome missing'); },
    });
    expect(res.status).toBe(502);
    const body = await res.json() as { ok: false; reason: string; detail?: string };
    expect(body.reason).toBe('extract-failed');
    expect(body.detail).toContain('chrome missing');
  });

  test('success is 201 with id, tokens, and unread', async () => {
    const res = await handleDesignSystemCreate(post({ kind: 'url', url: 'https://linear.app' }), libraryDeps());
    expect(res.status).toBe(201);
    const body = await res.json() as { ok: true; id: string; tokens: unknown[]; unread: number; warnings: string[]; dir: string };
    expect(body.ok).toBe(true);
    expect(body.id).toBe('linear');
    expect(body.tokens.length).toBeGreaterThan(0);
    expect(typeof body.unread).toBe('number');
    expect(Array.isArray(body.warnings)).toBe(true);
    expect(body.dir.endsWith('/linear')).toBe(true);
  });

  test('a second request while one is in flight is 429 and does not start another extract', async () => {
    const calls: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const deps = {
      ...libraryDeps(),
      runExtractDesign: async (options: { url: string; outRoot: string }) => {
        calls.push(options.url);
        await gate;
        return fakeExtract(options.outRoot);
      },
    };
    const first = handleDesignSystemCreate(post({ kind: 'url', url: 'https://linear.app' }), deps);
    await Promise.resolve();
    const second = await handleDesignSystemCreate(post({ kind: 'url', url: 'https://other.example' }), deps);
    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({ ok: false, reason: 'busy' });
    expect(calls).toEqual(['https://linear.app']);
    release();
    expect((await first).status).toBe(201);
    expect(calls).toEqual(['https://linear.app']);
  });
});
