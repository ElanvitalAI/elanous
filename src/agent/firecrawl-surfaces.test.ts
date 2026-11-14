import { readFirecrawlKey } from './firecrawl-plugin.js';
import { resolve } from 'node:path';
import { createPluginRouteAdapter } from '../plugins/core/route-adapter.js';
import { createDashboardPluginRouteAdapter } from '../dashboard/plugin-route-adapter.js';
import { afterEach, expect, spyOn, test } from 'bun:test';
import { buildSharedAppTools } from './shared-app-tools.js';
import { buildContinuationAgentTools } from '../dispatch/continuation-turn-runner.js';
import { registerDashboardCoreHostTools } from '../dashboard/index.js';
import { buildSessionRuntimeToolSpecs } from '../session-runtime/index.js';
import type { LLMToolDef } from '../plugins/core/types.js';
import * as secrets from '../nexus/config/secrets/index.js';

afterEach(() => { secretsSpy?.mockRestore(); fetchSpy?.mockRestore(); server?.stop(true); });
let secretsSpy: ReturnType<typeof spyOn> | undefined;
let fetchSpy: ReturnType<typeof spyOn> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;

test('TUI catalog+host, PWA shared tools and Telegram continuation dispatch the same fake HTTP scrape', async () => {
  const requests: string[] = [];
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async req => {
    expect(req.headers.get('authorization')).toBe('Bearer synthetic-surface-key');
    expect((await req.json()).url).toBe('https://example.com/');
    requests.push(new URL(req.url).pathname);
    return Response.json({ success: true, data: { markdown: 'fake website content' } });
  } });
  secretsSpy = spyOn(secrets, 'getSecretAsync').mockImplementation(async id => {
    expect(id).toBe('cred:firecrawl.api_key');
    return 'synthetic-surface-key';
  });
  const realFetch = globalThis.fetch;
  const transport = Object.assign((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    expect(url.origin).toBe('https://api.firecrawl.dev');
    return realFetch(new URL(url.pathname, server!.url), init);
  }, { preconnect: realFetch.preconnect });
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(transport);
  const hosts: LLMToolDef[] = [];
  const tui = registerDashboardCoreHostTools({ registerHostTool: tool => { hosts.push(tool); } });
  const catalog = buildSessionRuntimeToolSpecs({ userText: 'https://example.com 이 사이트 크롤링해줘', hostTools: hosts });
  expect(catalog.map(x => x.name)).toContain('firecrawl');
  const pwa = buildSharedAppTools();
  const telegram = buildContinuationAgentTools();
  expect(pwa.specs.map(x => x.name)).toContain('firecrawl');
  expect(telegram.specs.map(x => x.name)).toContain('firecrawl');
  for (const dispatch of [tui, pwa.dispatch, telegram.dispatch]) {
    expect(await dispatch('firecrawl', { url: 'https://example.com', mode: 'scrape' }))
      .toMatchObject({ status: 'completed', pages: [{ markdown: 'fake website content' }] });
  }
  for (const build of [createPluginRouteAdapter, createDashboardPluginRouteAdapter]) {
    const routes = build({ pluginRoot: resolve(import.meta.dir, '../../plugins'), dispatchCore: tui });
    expect(await routes.dispatch('firecrawl', { url: 'https://example.com', mode: 'scrape' }))
      .toMatchObject({ ok: true, result: { status: 'completed' } });
  }
  expect(requests).toEqual(['/v2/scrape', '/v2/scrape', '/v2/scrape', '/v2/scrape', '/v2/scrape']);
});

test('legacy secret precedes env and env remains a read-only final fallback', async () => {
  const priorEnv = process.env.FIRECRAWL_API_KEY;
  process.env.FIRECRAWL_API_KEY = 'synthetic-env-compatibility';
  try {
    secretsSpy = spyOn(secrets, 'getSecretAsync').mockImplementation(async id => id === 'FIRECRAWL_API_KEY' ? 'synthetic-old-slot' : undefined);
    expect(await readFirecrawlKey()).toBe('synthetic-old-slot');
    secretsSpy.mockRestore();
    secretsSpy = spyOn(secrets, 'getSecretAsync').mockImplementation(async () => undefined);
    expect(await readFirecrawlKey()).toBe('synthetic-env-compatibility');
    secretsSpy.mockRestore();
    secretsSpy = spyOn(secrets, 'getSecretAsync').mockImplementation(async () => { throw new Error('backend-unavailable'); });
    await expect(readFirecrawlKey()).rejects.toThrow('backend-unavailable');
  } finally {
    if (priorEnv === undefined) delete process.env.FIRECRAWL_API_KEY; else process.env.FIRECRAWL_API_KEY = priorEnv;
  }
});
