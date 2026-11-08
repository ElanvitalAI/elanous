// RFC #2161 Phase 6 — discovery sources + runner + endpoint tests.

import { describe, expect, test, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { anthropicSource } from '../src/registry/discovery/sources/anthropic.js';
import { openaiSource } from '../src/registry/discovery/sources/openai.js';
import { geminiSource } from '../src/registry/discovery/sources/gemini.js';
import { grokSource } from '../src/registry/discovery/sources/grok.js';
import { lmStudioSource, ollamaSource } from '../src/registry/discovery/sources/local-hosts.js';
import { setHostsOverride } from '../src/nexus/api/llm-hosts.js';
import { __resetS3AvailabilityCache } from '../src/storage/s3.js';
import {
  historyKeyFilename,
  pushDiscoverySnapshotToS3,
  type DiscoveryS3Transport,
} from '../src/registry/discovery/s3-push.js';
import {
  runDiscovery,
  readDiscoveryCache,
  BUILTIN_SOURCES,
} from '../src/registry/discovery/runner.js';
import {
  DEFAULT_DISCOVERY_OVERALL_TIMEOUT_MS,
  handleDiscoveryGet,
  handleDiscoveryRun,
} from '../src/nexus/api/registry-discovery.js';
import { debug } from '../src/debug/log.js';
import { currentEventLoopActivity } from '../src/debug/event-loop-watchdog.js';
import type { DiscoverySource } from '../src/registry/discovery/types.js';
import { createFakeFetchDevice, type FakeFetchDevice } from '../src/ux-sim/fake-fetch.js';

let tmpHome: string;
let fakeFetch: FakeFetchDevice | undefined;
const KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'XAI_API_KEY', 'FIRECRAWL_API_KEY'];

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'discovery-'));
  process.env.ELANOUS_TEST_HOME = tmpHome;
  // Block any accidental real S3 upload during these tests — A7's push
  // helper gates on isS3Available() which would otherwise probe the
  // user's aws CLI. Stub-based tests opt back in via custom transport.
  process.env.ELANOUS_S3_DISABLED = '1';
  __resetS3AvailabilityCache();
  for (const k of KEYS) delete process.env[k];
});

afterEach(() => {
  fakeFetch?.restore();
  fakeFetch = undefined;
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.ELANOUS_TEST_HOME;
  delete process.env.ELANOUS_S3_DISABLED;
  __resetS3AvailabilityCache();
  for (const k of KEYS) delete process.env[k];
  delete process.env.ELANOUS_LLM_HOSTS;
  setHostsOverride(null);
});

function mockResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('anthropicSource', () => {
  test('missing API key → ok=false + missing-api-key error', async () => {
    const r = await anthropicSource.run();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('missing-api-key');
    expect(r.models).toEqual([]);
  });

  test('happy path → normalised DiscoveredModel[]', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const r = await anthropicSource.run({
      fetchImpl: ((async () =>
        mockResponse({
          data: [
            { id: 'claude-opus-4-7', type: 'model', display_name: 'Claude Opus 4.7', created_at: '2026-04-16T00:00:00Z' },
            { id: 'claude-haiku-4-5', type: 'model', display_name: 'Claude Haiku 4.5' },
          ],
        })) as unknown) as typeof fetch,
      now: () => Date.parse('2026-05-11T00:00:00Z'),
    });
    expect(r.ok).toBe(true);
    expect(r.models.length).toBe(2);
    const opus = r.models.find((m) => m.id === 'claude-opus-4-7');
    expect(opus?.partial.displayName).toBe('Claude Opus 4.7');
    expect(opus?.partial.releaseDate).toBe('2026-04-16');
    expect(opus?.discoveryMeta.source).toBe('auto-anthropic-api');
    expect(opus?.discoveryMeta.confidence).toBe('high');
    expect(opus?.discoveryMeta.lastSeen).toBe('2026-05-11T00:00:00.000Z');
  });

  test('401 from upstream → upstream-auth-401', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-bad';
    const r = await anthropicSource.run({
      fetchImpl: ((async () => new Response('bad', { status: 401 })) as unknown) as typeof fetch,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('upstream-auth-401');
  });

  test('500 from upstream → upstream-http-500', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant';
    const r = await anthropicSource.run({
      fetchImpl: ((async () => new Response('whoops', { status: 500 })) as unknown) as typeof fetch,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('upstream-http-500');
  });

  test('network error → upstream-network', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant';
    const r = await anthropicSource.run({
      fetchImpl: ((async () => { throw new Error('econnrefused'); }) as unknown) as typeof fetch,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('econnrefused');
  });
});

describe('openaiSource', () => {
  test('missing API key → ok=false', async () => {
    const r = await openaiSource.run();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('missing-api-key');
  });

  test('happy path → normalised DiscoveredModel[]', async () => {
    process.env.OPENAI_API_KEY = 'sk-openai';
    const r = await openaiSource.run({
      fetchImpl: ((async () =>
        mockResponse({
          data: [
            { id: 'gpt-5.5', object: 'model', owned_by: 'openai', created: 1755432000 },
            { id: 'gpt-5.5-mini', object: 'model', owned_by: 'openai' },
          ],
        })) as unknown) as typeof fetch,
      now: () => Date.parse('2026-05-11T00:00:00Z'),
    });
    expect(r.ok).toBe(true);
    expect(r.models.length).toBe(2);
    expect(r.models[0]?.discoveryMeta.source).toBe('auto-openai-api');
    expect(r.models[0]?.partial.releaseDate).toBeTypeOf('string');
  });
});

describe('geminiSource', () => {
  test('missing API key → ok=false', async () => {
    const r = await geminiSource.run();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('missing-api-key');
  });

  test('happy path → strips models/ prefix + maps token limits', async () => {
    process.env.GEMINI_API_KEY = 'goog-key';
    const r = await geminiSource.run({
      fetchImpl: ((async () =>
        new Response(
          JSON.stringify({
            models: [
              {
                name: 'models/gemini-3.1-pro-preview',
                displayName: 'Gemini 3.1 Pro Preview',
                inputTokenLimit: 1_048_576,
                outputTokenLimit: 65_536,
                supportedGenerationMethods: ['generateContent'],
              },
              { name: 'models/gemini-2.0-flash', displayName: 'Gemini 2.0 Flash' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )) as unknown) as typeof fetch,
      now: () => Date.parse('2026-05-11T00:00:00Z'),
    });
    expect(r.ok).toBe(true);
    expect(r.models.length).toBe(2);
    const pro = r.models.find((m) => m.id === 'gemini-3.1-pro-preview');
    expect(pro?.partial.contextSize).toBe(1_048_576);
    expect(pro?.partial.outputMaxTokens).toBe(65_536);
    expect(pro?.discoveryMeta.source).toBe('auto-gemini-api');
  });

  test('401 → upstream-auth-401', async () => {
    process.env.GEMINI_API_KEY = 'bad';
    const r = await geminiSource.run({
      fetchImpl: ((async () => new Response('x', { status: 401 })) as unknown) as typeof fetch,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('upstream-auth-401');
  });
});

describe('grokSource', () => {
  test('missing API key → ok=false', async () => {
    const r = await grokSource.run();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('missing-api-key');
  });

  test('happy path → bearer auth + OpenAI-compat payload', async () => {
    process.env.XAI_API_KEY = 'xai-test';
    let captured: { auth?: string } = {};
    const r = await grokSource.run({
      fetchImpl: ((async (_url: unknown, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        captured.auth = headers['authorization'];
        return new Response(
          JSON.stringify({
            data: [
              { id: 'grok-4.3', object: 'model', owned_by: 'xai', created: 1761868800 },
              { id: 'grok-4-1-fast', object: 'model', owned_by: 'xai' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as unknown) as typeof fetch,
    });
    expect(captured.auth).toBe('Bearer xai-test');
    expect(r.ok).toBe(true);
    expect(r.models.map((m) => m.id).sort()).toEqual(['grok-4-1-fast', 'grok-4.3']);
    expect(r.models[0]?.discoveryMeta.source).toBe('auto-grok-api');
  });

  test('403 → upstream-auth-403', async () => {
    process.env.XAI_API_KEY = 'bad';
    const r = await grokSource.run({
      fetchImpl: ((async () => new Response('', { status: 403 })) as unknown) as typeof fetch,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('upstream-auth-403');
  });
});

describe('lmStudioSource (local-hosts)', () => {
  test('no configured hosts → ok=true with empty models', async () => {
    setHostsOverride([]);
    const r = await lmStudioSource.run();
    expect(r.ok).toBe(true);
    expect(r.models).toEqual([]);
  });

  test('configured lm-studio host → fan-out via fetchAllHosts', async () => {
    setHostsOverride([
      { name: 'macmini', kind: 'lm-studio', endpoint: 'http://lm.test:1234' },
    ]);
    // local-hosts source delegates to `fetchAllHosts` which uses the
    // global fetch · override that for this test (the source doesn't
    // expose a fetchImpl seam to keep its signature minimal).
    fakeFetch = createFakeFetchDevice([{
      url: 'http://lm.test:1234/v1/models', method: 'GET', response: (request) => {
        if (request.url === 'http://lm.test:1234/v1/models') return new Response(
          JSON.stringify({
            data: [
              { id: 'gemma-4-26b-a4b-it', object: 'model', owned_by: 'lmstudio-community' },
              { id: 'qwen3-72b-instruct', object: 'model', owned_by: 'qwen' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
        return new Response('', { status: 404 });
      },
    }]);
    const r = await lmStudioSource.run();
    expect(r.ok).toBe(true);
    expect(r.models.map((m) => m.id).sort()).toEqual(['gemma-4-26b-a4b-it', 'qwen3-72b-instruct']);
    expect(r.models[0]?.provider).toBe('local');
    expect(r.models[0]?.discoveryMeta.source).toBe('auto-local-host');
    expect(fakeFetch.calls().map(({ method, url }) => `${method} ${url}`)).toEqual(['GET http://lm.test:1234/v1/models']);
  });

  test('skips ollama hosts (filter mismatch)', async () => {
    setHostsOverride([
      { name: 'ollama', kind: 'ollama', endpoint: 'http://ollama.test:11434' },
    ]);
    const r = await lmStudioSource.run();
    // No matching hosts → empty result, no fetch
    expect(r.ok).toBe(true);
    expect(r.models).toEqual([]);
  });
});

describe('ollamaSource (local-hosts)', () => {
  test('configured ollama host → fan-out via /api/tags', async () => {
    setHostsOverride([
      { name: 'workstation', kind: 'ollama', endpoint: 'http://ollama.test:11434' },
    ]);
    fakeFetch = createFakeFetchDevice([{
      url: 'http://ollama.test:11434/api/tags', method: 'GET', response: (request) => {
        if (request.url === 'http://ollama.test:11434/api/tags') return new Response(
          JSON.stringify({
            models: [
              { name: 'llama-3', model: 'llama-3' },
              { name: 'phi-4', model: 'phi-4' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
        return new Response('', { status: 404 });
      },
    }]);
    const r = await ollamaSource.run();
    expect(r.ok).toBe(true);
    expect(r.models.map((m) => m.id).sort()).toEqual(['llama-3', 'phi-4']);
    expect(r.models[0]?.provider).toBe('local');
    expect(r.models[0]?.discoveryMeta.confidence).toBe('medium');
    expect(r.models[0]?.discoveryMeta.source).toBe('auto-local-host');
    expect(fakeFetch.calls().map(({ method, url }) => `${method} ${url}`)).toEqual(['GET http://ollama.test:11434/api/tags']);
  });
});

describe('runDiscovery', () => {
  test('all builtin sources run in parallel', () => {
    expect(BUILTIN_SOURCES.length).toBeGreaterThan(0);
    expect(BUILTIN_SOURCES.map((s) => s.id).sort()).toEqual([
      'anthropic',
      'firecrawl-crawl',
      'gemini',
      'grok',
      'grok-crawl',
      'lmstudio',
      'ollama',
      'openai',
      'openrouter',
    ]);
  });

  test('per-source failures are isolated · snapshot still serialises', async () => {
    const goodSource: DiscoverySource = {
      id: 'anthropic',
      run: async () => ({
        source: 'anthropic',
        ok: true,
        models: [{
          id: 'claude-opus-4-7',
          provider: 'anthropic',
          partial: { id: 'claude-opus-4-7', provider: 'anthropic' },
          discoveryMeta: {
            source: 'auto-anthropic-api',
            lastSeen: '2026-05-11T00:00:00.000Z',
            autoFilled: true,
            confidence: 'high',
          },
        }],
        durationMs: 5,
      }),
    };
    const failingSource: DiscoverySource = {
      id: 'openai',
      run: async () => ({
        source: 'openai',
        ok: false,
        models: [],
        durationMs: 2,
        error: 'upstream-timeout',
      }),
    };
    const { snapshot, results } = await runDiscovery({
      sources: [goodSource, failingSource],
      cachePath: join(tmpHome, 'snap.json'),
    });
    expect(snapshot.sources.length).toBe(2);
    expect(snapshot.sources.find((s) => s.id === 'anthropic')?.ok).toBe(true);
    expect(snapshot.sources.find((s) => s.id === 'openai')?.error).toBe('upstream-timeout');
    expect(snapshot.models.length).toBe(1); // only good source contributes
    expect(results.length).toBe(2);
  });

  test('merges successful sources and keeps duplicate provider+id models in source order', async () => {
    const shared = {
      id: 'claude-opus-4-7',
      provider: 'anthropic',
      partial: { id: 'claude-opus-4-7', provider: 'anthropic' },
      discoveryMeta: {
        source: 'auto-anthropic-api' as const,
        lastSeen: '2026-05-11T00:00:00.000Z',
        autoFilled: true,
        confidence: 'high' as const,
      },
    };
    const first: DiscoverySource = {
      id: 'anthropic',
      run: async () => ({ source: 'anthropic', ok: true, models: [shared], durationMs: 1 }),
    };
    const second: DiscoverySource = {
      id: 'openai',
      run: async () => ({
        source: 'openai',
        ok: true,
        models: [{
          ...shared,
          discoveryMeta: { ...shared.discoveryMeta, source: 'auto-openai-api' },
        }],
        durationMs: 2,
      }),
    };
    const { snapshot } = await runDiscovery({
      sources: [first, second],
      skipCacheWrite: true,
      s3Push: false,
    });
    expect(snapshot.sources.length).toBe(2);
    expect(snapshot.models.length).toBe(2);
    expect(snapshot.models[0]?.discoveryMeta.source).toBe('auto-anthropic-api');
    expect(snapshot.models[1]?.discoveryMeta.source).toBe('auto-openai-api');
  });

  test('writes snapshot to cachePath', async () => {
    const cachePath = join(tmpHome, 'manual.json');
    const stub: DiscoverySource = {
      id: 'anthropic',
      run: async () => ({ source: 'anthropic', ok: true, models: [], durationMs: 0 }),
    };
    await runDiscovery({ sources: [stub], cachePath });
    const persisted = JSON.parse(readFileSync(cachePath, 'utf-8')) as { version: number };
    expect(persisted.version).toBe(1);
  });

  test('readDiscoveryCache returns null when no cache exists', () => {
    const cached = readDiscoveryCache({ cachePath: join(tmpHome, 'never-existed.json') });
    expect(cached).toBe(null);
  });

  test('readDiscoveryCache survives corrupted JSON', () => {
    const path = join(tmpHome, 'broken.json');
    require('node:fs').writeFileSync(path, '{not valid', 'utf-8');
    expect(readDiscoveryCache({ cachePath: path })).toBe(null);
  });
});

describe('S3 push (FU A7) · pushDiscoverySnapshotToS3', () => {
  const snapshot = {
    version: 1,
    generatedAt: '2026-05-11T13:42:09.000Z',
    sources: [],
    models: [],
  };

  test('skips push when transport.available()=false (reason=disabled)', () => {
    const transport: DiscoveryS3Transport = {
      available: () => false,
      upload: () => { throw new Error('should not be called'); },
    };
    const r = pushDiscoverySnapshotToS3(snapshot, { transport });
    expect(r.pushed).toBe(false);
    expect(r.reason).toBe('disabled');
    expect(r.keys).toEqual([]);
  });

  test('happy path uploads both latest + history keys', () => {
    const calls: { local: string; key: string }[] = [];
    const transport: DiscoveryS3Transport = {
      available: () => true,
      upload: (local, key) => { calls.push({ local, key }); },
    };
    const r = pushDiscoverySnapshotToS3(snapshot, {
      transport,
      now: () => new Date('2026-05-11T13:42:09Z'),
    });
    expect(r.pushed).toBe(true);
    expect(r.keys.length).toBe(2);
    // history key has the ISO timestamp; latest key is constant.
    expect(r.keys.some((k) => k.endsWith('/latest.json'))).toBe(true);
    expect(r.keys.some((k) => k.includes('discovery-history'))).toBe(true);
    expect(r.keys.some((k) => k.includes('2026-05-11T13-42-09'))).toBe(true);
    // Each upload pointed at the same temp file (both keys use the
    // same snapshot bytes — no need to re-serialise).
    expect(calls.length).toBe(2);
    expect(calls[0]?.local).toBe(calls[1]?.local);
  });

  test('historyOnly:true skips the latest.json overwrite', () => {
    const calls: { key: string }[] = [];
    const transport: DiscoveryS3Transport = {
      available: () => true,
      upload: (_local, key) => { calls.push({ key }); },
    };
    const r = pushDiscoverySnapshotToS3(snapshot, {
      transport,
      historyOnly: true,
    });
    expect(r.pushed).toBe(true);
    expect(r.keys.length).toBe(1);
    expect(r.keys[0]).toContain('discovery-history');
    expect(calls.some((c) => c.key.endsWith('/latest.json'))).toBe(false);
  });

  test('transport throw → reason=transport-error with message', () => {
    const transport: DiscoveryS3Transport = {
      available: () => true,
      upload: () => { throw new Error('s3 ConnectionTimeout'); },
    };
    const r = pushDiscoverySnapshotToS3(snapshot, { transport });
    expect(r.pushed).toBe(false);
    expect(r.reason).toBe('transport-error');
    expect(r.error).toContain('s3 ConnectionTimeout');
  });

  test('historyKeyFilename strips ms+Z, replaces colons', () => {
    const f = historyKeyFilename(new Date('2026-05-11T13:42:09.123Z'));
    expect(f).toBe('2026-05-11T13-42-09.json');
  });
});

describe('runDiscovery + S3 push wiring (FU A7)', () => {
  test('default opts.s3Push=undefined fires push (disabled in test → reason)', async () => {
    const stub: DiscoverySource = {
      id: 'anthropic',
      run: async () => ({ source: 'anthropic', ok: true, models: [], durationMs: 0 }),
    };
    const out = await runDiscovery({ sources: [stub], cachePath: join(tmpHome, 's.json') });
    // S3 disabled by the global beforeEach (ELANOUS_S3_DISABLED=1) so
    // the push helper short-circuits at `available()`.
    expect(out.s3Push?.pushed).toBe(false);
    expect(out.s3Push?.reason).toBe('disabled');
  });

  test('opts.s3Push=false skips push entirely (no s3Push field)', async () => {
    const stub: DiscoverySource = {
      id: 'anthropic',
      run: async () => ({ source: 'anthropic', ok: true, models: [], durationMs: 0 }),
    };
    const out = await runDiscovery({
      sources: [stub],
      cachePath: join(tmpHome, 's.json'),
      s3Push: false,
    });
    expect(out.s3Push).toBeUndefined();
  });

  test('opts.s3Push transport override → push fires + keys returned', async () => {
    const uploaded: string[] = [];
    const stub: DiscoverySource = {
      id: 'anthropic',
      run: async () => ({ source: 'anthropic', ok: true, models: [], durationMs: 0 }),
    };
    const out = await runDiscovery({
      sources: [stub],
      cachePath: join(tmpHome, 's.json'),
      s3Push: {
        transport: {
          available: () => true,
          upload: (_local, key) => { uploaded.push(key); },
        },
        now: () => new Date('2026-05-11T13:42:09Z'),
      },
    });
    expect(out.s3Push?.pushed).toBe(true);
    expect(uploaded.length).toBe(2);
  });
});

describe('external abort propagates through the overall cap', () => {
  // ⛔ 「상한이 걸린다」와 「밖에서 끊으면 곧바로 끝난다」는 «다른 축»이다.
  //    후자가 없으면 요청이 취소돼도 서버는 상한을 «다» 기다린다.
  test('an ALREADY-aborted request never STARTS a source (and blocks nothing)', async () => {
    // ⛔ 「빨리 돌아온다」로는 부족하다 — 소스가 await «전»에 동기로 일하면 race 가
    //    돌 기회를 못 얻는다(이 저장소에 실제로 그런 소스가 있었다 · #14925).
    //    그래서 ***호출 «횟수»***로 「시작조차 안 했다」를 문다. ⊕ 그 소스는 불리면
    //    동기로 «막아» 버려서, 시작했다면 시간으로도 드러난다.
    let invoked = 0;
    const ac = new AbortController();
    ac.abort();
    const hostile: DiscoverySource = {
      id: 'firecrawl-crawl',
      run: async () => {
        invoked += 1;
        const until = Date.now() + 800;
        while (Date.now() < until) { /* 동기 블로킹 — 이벤트 루프를 막는다 */ }
        return { source: 'firecrawl-crawl', ok: true, models: [], durationMs: 800 };
      },
    };
    const started = Date.now();
    const res = await handleDiscoveryRun({
      timeoutMs: 5_000,
      discovery: { sources: [hostile], signal: ac.signal, skipCacheWrite: true, s3Push: false },
    });
    const elapsed = Date.now() - started;
    expect(res.status).toBe(200);
    // ⭐ 핵심 단정 — 소스를 «부르지도» 않았다.
    expect(invoked).toBe(0);
    expect(elapsed).toBeLessThan(300);
    const body = (await res.json()) as {
      aborted?: boolean; timedOut?: boolean; unsettledSourceIds?: string[];
    };
    // ⛔ 「부르는 쪽이 갔다」를 「우리가 상한에 걸렸다」로 말하면 거짓이다.
    expect(body.aborted).toBe(true);
    expect(body.timedOut).toBe(false);
    // 시작 못 한 소스도 «이름»으로 남는다.
    expect(body.unsettledSourceIds).toEqual(['firecrawl-crawl']);
  });

  test('an external abort DURING the run returns without waiting the cap', async () => {
    const ac = new AbortController();
    // ⛔ 이 소스는 signal 을 «무시»한다. 협조하는 소스로 재면 abortPromise 를 빼도
    //    통과해서 «아무것도 안 무는» 시험이 된다(리뷰 3차 지적).
    const uncooperative: DiscoverySource = {
      id: 'firecrawl-crawl',
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        return { source: 'firecrawl-crawl', ok: true, models: [], durationMs: 3_000 };
      },
    };
    const started = Date.now();
    setTimeout(() => ac.abort(), 60);
    const res = await handleDiscoveryRun({
      timeoutMs: 5_000,
      discovery: { sources: [uncooperative], signal: ac.signal, skipCacheWrite: true, s3Push: false },
    });
    const elapsed = Date.now() - started;
    expect(res.status).toBe(200);
    expect(elapsed).toBeGreaterThanOrEqual(50);
    // 상한 5s 를 기다리지 «않는다» — 밖에서 끊은 것이 전파됐다.
    expect(elapsed).toBeLessThan(1_500);
    const body = (await res.json()) as { aborted?: boolean; timedOut?: boolean };
    // 이 경로에서도 두 종료 이유가 «갈려» 나가야 한다.
    expect(body.aborted).toBe(true);
    expect(body.timedOut).toBe(false);
  });
});

describe('the timeout response tells the EFFECTIVE cap and the observation says it too', () => {
  // 🩸 이 자리엔 「생략해도 적용된 상한을 사실로 낸다」는 이름의 시험이 있었는데,
  //    본문은 «성공» 응답에서 필드가 없다는 것만 봤다 — 이름이 확인 안 하는 걸 약속했다
  //    (리뷰가 Goodhart 라 불렀고 맞다). ⇒ 계약을 «두 조각»으로 나눠 각각 직접 문다.
  //    ⛔ 「생략 ⇒ 15초 타임아웃 응답」을 «통째로» 밟는 시험은 두지 않는다 —
  //       그 판의 기본 상한이 15초라 스위트가 «15초를 기다리게» 된다.
  // 🩸 이 자리엔 «두 번» Goodhart 시험이 있었다.
  //    ① 이름이 「생략해도 실린다」인데 «성공» 응답의 필드 부재만 봤다.
  //    ② 고친 판도 `timeoutMs: 40` 만 써서 ***원값과 실효값이 «같아»*** — 핸들러가
  //       실효값 대신 «원입력»을 싣는 변이를 원리상 못 잡았다.
  //    ⇒ 원값 ≠ 실효값인 입력(0·NaN·Infinity·생략)으로 재야 하는데, 그것들은 전부
  //      DEFAULT(15초)로 해석되므로 «타임아웃 경로»로 재면 스위트가 15초를 기다린다.
  //    🔑 길이 있다 — ***「이미 취소」 단락 경로***가 같은 실효 상한을 «즉시» 낸다.
  //      그래서 아래는 «빠르고» 그 변이를 «실제로» 잡는다.
  for (const [label, raw] of [
    ['omitted', undefined],
    ['zero', 0],
    ['negative', -1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ] as Array<[string, number | undefined]>) {
    test(`an invalid/omitted cap (${label}) surfaces the DEFAULT, never the raw input`, async () => {
      const ac = new AbortController();
      ac.abort();
      const res = await handleDiscoveryRun({
        ...(raw === undefined ? {} : { timeoutMs: raw }),
        discovery: {
          sources: [{ id: 'anthropic', run: async () => ({ source: 'anthropic', ok: true, models: [], durationMs: 0 }) }],
          signal: ac.signal, skipCacheWrite: true, s3Push: false,
        },
      });
      const body = (await res.json()) as { timeoutMs?: number };
      expect(body.timeoutMs).toBe(DEFAULT_DISCOVERY_OVERALL_TIMEOUT_MS);
      // ⭐ 원값을 실었다면 여기서 갈린다.
      if (raw !== undefined) expect(body.timeoutMs).not.toBe(raw);
    });
  }

  test('a VALID cap passes through unchanged on the timeout path', async () => {
    const slow: DiscoverySource = {
      id: 'firecrawl-crawl',
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 400));
        return { source: 'firecrawl-crawl', ok: true, models: [], durationMs: 400 };
      },
    };
    const res = await handleDiscoveryRun({
      timeoutMs: 40,
      discovery: { sources: [slow], skipCacheWrite: true, s3Push: false },
    });
    const body = (await res.json()) as { timedOut?: boolean; timeoutMs?: number };
    expect(body.timedOut).toBe(true);
    expect(body.timeoutMs).toBe(40);
  });

  test('a run that finishes carries NO cap field — it is a timeout-path fact only', async () => {
    const fast: DiscoverySource = {
      id: 'anthropic',
      run: async () => ({ source: 'anthropic', ok: true, models: [], durationMs: 1 }),
    };
    const res = await handleDiscoveryRun({
      discovery: { sources: [fast], skipCacheWrite: true, s3Push: false },
    });
    const body = (await res.json()) as { ok: boolean; timeoutMs?: number };
    expect(body.ok).toBe(true);
    expect(body.timeoutMs).toBeUndefined();
  });

  // ⛔ 위 시험은 «라우트» 경로다. 계약은 runner 머리말에 적혀 있고 cron 등 라우트
  //    «밖» 호출자도 그것을 믿으므로, 러너 계층에서 직접 문다.
  test('runDiscovery itself keeps the partial when ONE source throws (cron path too)', async () => {
    const boom: DiscoverySource = {
      id: 'grok-crawl',
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        throw new Error('kaboom');
      },
    };
    const good: DiscoverySource = {
      id: 'anthropic',
      run: async () => ({
        source: 'anthropic',
        ok: true,
        models: [{
          id: 'claude-opus-4-7',
          provider: 'anthropic',
          partial: { id: 'claude-opus-4-7', provider: 'anthropic' },
          discoveryMeta: {
            source: 'auto-anthropic-api',
            lastSeen: '2026-05-11T00:00:00.000Z',
            autoFilled: true,
            confidence: 'high',
          },
        }],
        durationMs: 1,
      }),
    };
    // ⛔ 던지면 «여기서» reject 하던 것이 이 판의 결함이었다.
    const { snapshot, results } = await runDiscovery({
      sources: [boom, good],
      skipCacheWrite: true,
      s3Push: false,
    });
    expect(results.length).toBe(2);
    const failed = results.find((r) => r.source === 'grok-crawl');
    expect(failed?.ok).toBe(false);
    expect(failed?.error).toContain('kaboom');
    // ⭐ 실패에도 «진짜» 소요 시간이 실린다 — 0 을 박으면 「빨리 실패」와
    //    「오래 끌다 터짐」이 같아 보인다.
    expect(failed?.durationMs).toBeGreaterThanOrEqual(50);
    // ⭐ 그리고 성공한 소스의 부분 결과가 «살아남는다».
    expect(snapshot.models.map((m) => m.id)).toContain('claude-opus-4-7');
    expect(snapshot.sources.find((x) => x.id === 'anthropic')?.ok).toBe(true);
  });

  test('a THROWING source settles as a failure — it is not called «unsettled»', async () => {
    // ⛔ 던진 소스는 «끝난» 것이다(실패로). 그것을 unsettledSourceIds 에 넣으면
    //    「기다리다 잘렸다」는 거짓말이 된다. ⊕ 던지게 두면 Promise.all 이
    //    런 «전체»를 죽여 부분 결과가 통째로 사라진다.
    const boom: DiscoverySource = {
      id: 'grok-crawl',
      run: async () => { throw new Error('kaboom'); },
    };
    const slow: DiscoverySource = {
      id: 'firecrawl-crawl',
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 400));
        return { source: 'firecrawl-crawl', ok: true, models: [], durationMs: 400 };
      },
    };
    const res = await handleDiscoveryRun({
      timeoutMs: 40,
      discovery: { sources: [boom, slow], skipCacheWrite: true, s3Push: false },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean; timedOut?: boolean;
      sources: Array<{ id: string; ok: boolean; error?: string }>;
      unsettledSourceIds?: string[];
    };
    expect(body.timedOut).toBe(true);
    // ⭐ 던진 소스는 «부분 결과에 실패로» 들어간다.
    const thrown = body.sources.find((x) => x.id === 'grok-crawl');
    expect(thrown?.ok).toBe(false);
    expect(thrown?.error).toContain('kaboom');
    // ⭐ 그리고 «미정산» 이라 불리지 않는다 — 못 끝난 것은 느린 쪽뿐이다.
    expect(body.unsettledSourceIds).toEqual(['firecrawl-crawl']);
  });

  test('the aborted short-circuit is OBSERVED — startedSources: 0 reaches debug.log', async () => {
    // ⛔ invoked===0 만으론 «관측 계약»을 못 지킨다 — 로그가 사라져도 통과한다.
    const events: Array<{ category: string; event: string; data?: Record<string, unknown> }> = [];
    const spy = spyOn(debug, 'log').mockImplementation((category, event, data) => {
      events.push({ category, event, data: data as Record<string, unknown> | undefined });
    });
    try {
      const ac = new AbortController();
      ac.abort();
      await handleDiscoveryRun({
        discovery: {
          sources: [{ id: 'firecrawl-crawl', run: async () => ({ source: 'firecrawl-crawl', ok: true, models: [], durationMs: 0 }) }],
          signal: ac.signal, skipCacheWrite: true, s3Push: false,
        },
      });
      const done = events.find((e) => e.category === 'registry.discovery' && e.event === 'done');
      expect(done).toBeDefined();
      expect(done?.data?.startedSources).toBe(0);
      expect(done?.data?.aborted).toBe(true);
      expect(done?.data?.timedOut).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('handleDiscoveryGet (GET /v1/registry/discovery)', () => {
  test('returns cached: null when no snapshot exists', async () => {
    const res = handleDiscoveryGet({ cachePath: join(tmpHome, 'never-existed.json') });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cached: unknown };
    expect(body.cached).toBe(null);
  });

  test('returns the persisted snapshot when present', async () => {
    // Write a snapshot via runDiscovery first.
    const stub: DiscoverySource = {
      id: 'anthropic',
      run: async () => ({
        source: 'anthropic',
        ok: true,
        models: [{
          id: 'claude-opus-4-7',
          provider: 'anthropic',
          partial: { id: 'claude-opus-4-7', provider: 'anthropic' },
          discoveryMeta: {
            source: 'auto-anthropic-api',
            lastSeen: '2026-05-11T00:00:00.000Z',
            autoFilled: true,
            confidence: 'high',
          },
        }],
        durationMs: 1,
      }),
    };
    const cachePath = join(tmpHome, 'snap.json');
    await runDiscovery({
      sources: [stub],
      cachePath,
    });
    const res = handleDiscoveryGet({ cachePath });
    const body = (await res.json()) as {
      cached: { version: number; models: Array<{ id: string }> };
    };
    expect(body.cached?.models?.[0]?.id).toBe('claude-opus-4-7');
  });
});

describe('handleDiscoveryRun (POST /v1/registry/discovery)', () => {
  test('runs discovery and echoes the snapshot', async () => {
    // This is an HTTP-handler contract test, not a live provider test.
    // Inject every builtin id so a developer's ~/.elanous credentials cannot
    // cause Firecrawl/Grok subprocesses or network calls during `bun test`.
    const sources: DiscoverySource[] = BUILTIN_SOURCES.map((source) => ({
      id: source.id,
      run: async () => ({
        source: source.id,
        ok: false,
        models: [],
        durationMs: 0,
        error: 'not-run-in-handler-test',
      }),
    }));
    const res = await handleDiscoveryRun({
      discovery: { sources, skipCacheWrite: true, s3Push: false },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; sources: Array<{ id: string; ok: boolean }> };
    expect(body.ok).toBe(true);
    expect(body.sources.length).toBe(BUILTIN_SOURCES.length);
  });

  test('emits start then done with durationMs, and marks event-loop activity', async () => {
    const logs: Array<{ category: string; event: string; data?: unknown }> = [];
    const spy = spyOn(debug, 'log').mockImplementation((category, event, data) => {
      logs.push({ category, event, data });
    });
    try {
      const sources: DiscoverySource[] = BUILTIN_SOURCES.map((source) => ({
        id: source.id,
        run: async () => ({
          source: source.id,
          ok: false,
          models: [],
          durationMs: 0,
          error: 'not-run-in-handler-test',
        }),
      }));
      const res = await handleDiscoveryRun({
        discovery: { sources, skipCacheWrite: true, s3Push: false },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; sources: Array<{ id: string }> };
      expect(body.ok).toBe(true);
      expect(body.sources.length).toBe(BUILTIN_SOURCES.length);

      const discoveryLogs = logs.filter((l) => l.category === 'registry.discovery');
      expect(discoveryLogs.map((l) => l.event)).toEqual(['start', 'done']);
      const doneData = discoveryLogs[1]?.data as { durationMs?: number };
      expect(typeof doneData.durationMs).toBe('number');
      expect(doneData.durationMs).toBeGreaterThanOrEqual(0);
      expect(currentEventLoopActivity().label).toBe('registry:discovery');
    } finally {
      spy.mockRestore();
    }
  });

  test('overall timeout returns near the cap with partial results and timedOut', async () => {
    const timeoutMs = 40;
    const fast: DiscoverySource = {
      id: 'anthropic',
      run: async () => ({
        source: 'anthropic',
        ok: true,
        models: [{
          id: 'claude-opus-4-7',
          provider: 'anthropic',
          partial: { id: 'claude-opus-4-7', provider: 'anthropic' },
          discoveryMeta: {
            source: 'auto-anthropic-api',
            lastSeen: '2026-05-11T00:00:00.000Z',
            autoFilled: true,
            confidence: 'high',
          },
        }],
        durationMs: 1,
      }),
    };
    const slow: DiscoverySource = {
      id: 'firecrawl-crawl',
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 400));
        return { source: 'firecrawl-crawl', ok: true, models: [], durationMs: 400 };
      },
    };
    const started = Date.now();
    const res = await handleDiscoveryRun({
      timeoutMs,
      discovery: { sources: [fast, slow], skipCacheWrite: true, s3Push: false },
    });
    const elapsed = Date.now() - started;
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      timedOut?: boolean;
      timeoutMs?: number;
      sources: Array<{ id: string; ok: boolean }>;
      models: Array<{ id: string }>;
      unsettledSourceIds?: string[];
      aborted?: boolean;
    };
    expect(body.ok).toBe(false);
    expect(body.timedOut).toBe(true);
    expect(body.timeoutMs).toBe(timeoutMs);
    expect(body.sources.some((s) => s.id === 'anthropic' && s.ok)).toBe(true);
    expect(body.models.map((m) => m.id)).toContain('claude-opus-4-7');
    expect(elapsed).toBeGreaterThanOrEqual(timeoutMs - 5);
    expect(elapsed).toBeLessThan(250);
    // ⛔ 잘린 소스가 목록에서 «조용히 사라지면» 「그 소스가 0건을 냈다」와
    //    「그 소스를 기다리다 잘랐다」가 «같아 보인다». 이름을 대야 한다.
    expect(body.unsettledSourceIds).toEqual(['firecrawl-crawl']);
    expect(body.sources.some((s) => s.id === 'firecrawl-crawl')).toBe(false);
    // ⊕ 「우리가 잘랐다」와 「부르는 쪽이 갔다」는 다른 값이다.
    expect(body.aborted).toBe(false);
  });

  test('overall timeout partial snapshot keeps duplicate models from settled sources', async () => {
    const timeoutMs = 40;
    const shared = {
      id: 'claude-opus-4-7',
      provider: 'anthropic',
      partial: { id: 'claude-opus-4-7', provider: 'anthropic' },
      discoveryMeta: {
        source: 'auto-anthropic-api' as const,
        lastSeen: '2026-05-11T00:00:00.000Z',
        autoFilled: true,
        confidence: 'high' as const,
      },
    };
    const first: DiscoverySource = {
      id: 'anthropic',
      run: async () => ({ source: 'anthropic', ok: true, models: [shared], durationMs: 1 }),
    };
    const second: DiscoverySource = {
      id: 'openai',
      run: async () => ({
        source: 'openai',
        ok: true,
        models: [{
          ...shared,
          discoveryMeta: { ...shared.discoveryMeta, source: 'auto-openai-api' },
        }],
        durationMs: 1,
      }),
    };
    const slow: DiscoverySource = {
      id: 'firecrawl-crawl',
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 400));
        return { source: 'firecrawl-crawl', ok: true, models: [], durationMs: 400 };
      },
    };
    const started = Date.now();
    const res = await handleDiscoveryRun({
      timeoutMs,
      discovery: { sources: [first, second, slow], skipCacheWrite: true, s3Push: false },
    });
    const elapsed = Date.now() - started;
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      timedOut?: boolean;
      timeoutMs?: number;
      models: Array<{ id: string; provider: string; discoveryMeta?: { source?: string } }>;
    };
    expect(body.ok).toBe(false);
    expect(body.timedOut).toBe(true);
    expect(body.timeoutMs).toBe(timeoutMs);
    expect(body.models.filter((m) => m.id === 'claude-opus-4-7' && m.provider === 'anthropic')).toHaveLength(2);
    expect(body.models[0]?.discoveryMeta?.source).toBe('auto-anthropic-api');
    expect(body.models[1]?.discoveryMeta?.source).toBe('auto-openai-api');
    expect(elapsed).toBeGreaterThanOrEqual(timeoutMs - 5);
    expect(elapsed).toBeLessThan(250);
  });

  test('in-time discovery keeps the success body and has no timeout indicator', async () => {
    const sources: DiscoverySource[] = BUILTIN_SOURCES.map((source) => ({
      id: source.id,
      run: async () => ({
        source: source.id,
        ok: false,
        models: [],
        durationMs: 0,
        error: 'not-run-in-handler-test',
      }),
    }));
    const res = await handleDiscoveryRun({
      timeoutMs: 1_000,
      discovery: { sources, skipCacheWrite: true, s3Push: false },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      timedOut?: boolean;
      timeoutMs?: number;
      sources: Array<{ id: string; ok: boolean }>;
      version?: number;
      generatedAt?: string;
      models?: unknown[];
    };
    expect(body.ok).toBe(true);
    expect(body.timedOut).toBeUndefined();
    expect(body.timeoutMs).toBeUndefined();
    expect(body.sources.length).toBe(BUILTIN_SOURCES.length);
    expect(typeof body.generatedAt).toBe('string');
    expect(body.version).toBe(1);
    expect(Array.isArray(body.models)).toBe(true);
  });

  test('omitted timeoutMs uses DEFAULT_DISCOVERY_OVERALL_TIMEOUT_MS and still succeeds in time', async () => {
    expect(DEFAULT_DISCOVERY_OVERALL_TIMEOUT_MS).toBe(15_000);
    const stub: DiscoverySource = {
      id: 'anthropic',
      run: async () => ({ source: 'anthropic', ok: true, models: [], durationMs: 0 }),
    };
    const res = await handleDiscoveryRun({
      discovery: { sources: [stub], skipCacheWrite: true, s3Push: false },
    });
    const body = (await res.json()) as { ok: boolean; timedOut?: boolean };
    expect(body.ok).toBe(true);
    expect(body.timedOut).toBeUndefined();
  });

  test('overall timeout aborts the run and does not persist cache or S3 after a late source settles', async () => {
    const timeoutMs = 40;
    const cachePath = join(tmpHome, 'timeout-no-persist.json');
    const uploaded: string[] = [];
    let slowSettled = false;
    let receivedSignal: AbortSignal | undefined;
    const fast: DiscoverySource = {
      id: 'anthropic',
      run: async () => ({
        source: 'anthropic',
        ok: true,
        models: [{
          id: 'claude-opus-4-7',
          provider: 'anthropic',
          partial: { id: 'claude-opus-4-7', provider: 'anthropic' },
          discoveryMeta: {
            source: 'auto-anthropic-api',
            lastSeen: '2026-05-11T00:00:00.000Z',
            autoFilled: true,
            confidence: 'high',
          },
        }],
        durationMs: 1,
      }),
    };
    const slow: DiscoverySource = {
      id: 'firecrawl-crawl',
      run: async (sourceOpts) => {
        receivedSignal = sourceOpts?.signal;
        await new Promise((resolve) => setTimeout(resolve, 120));
        slowSettled = true;
        return { source: 'firecrawl-crawl', ok: true, models: [], durationMs: 120 };
      },
    };
    const started = Date.now();
    const res = await handleDiscoveryRun({
      timeoutMs,
      discovery: {
        sources: [fast, slow],
        cachePath,
        s3Push: {
          transport: {
            available: () => true,
            upload: (_local, key) => { uploaded.push(key); },
          },
        },
      },
    });
    const elapsed = Date.now() - started;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; timedOut?: boolean };
    expect(body.ok).toBe(false);
    expect(body.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(250);
    expect(receivedSignal?.aborted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(slowSettled).toBe(true);
    expect(readDiscoveryCache({ cachePath })).toBe(null);
    expect(uploaded).toEqual([]);
  });

  // 🩸 이 시험은 원래 «소스가 던지면 런 전체가 죽는다」를 전제로 `sources: [throwing]`
  //    를 썼다. 그 전제를 이 판이 «의도적으로» 바꿨다 — 던진 소스는 이제 실패 결과로
  //    정규화되고 부분 결과에 실린다(runner.ts 머리말의 "Per-source failures don't fail
  //    the run" 계약대로). ⇒ 그래도 `failed` 관측 자체는 살아 있어야 하므로,
  //    ***소스가 «아닌» 이유***(캐시 쓰기)로 던지게 바꿔 그 경로를 계속 문다.
  test('emits failed with durationMs when the run throws for a NON-source reason', async () => {
    const logs: Array<{ category: string; event: string; data?: unknown }> = [];
    const spy = spyOn(debug, 'log').mockImplementation((category, event, data) => {
      logs.push({ category, event, data });
    });
    try {
      const sources: DiscoverySource[] = [{
        id: 'anthropic',
        run: async () => ({ source: 'anthropic', ok: true, models: [], durationMs: 1 }),
      }];
      await expect(handleDiscoveryRun({
        // 시계가 던지게 한다 — 소스 «밖»이면서 런 «안»(buildDiscoverySnapshot)이다.
        // (캐시 쓰기는 best-effort 라 안 던진다 — 실측으로 확인했다.)
        discovery: {
          sources,
          now: (() => { throw new Error('clock-boom'); }) as unknown as () => number,
          skipCacheWrite: true,
          s3Push: false,
        },
      })).rejects.toThrow('clock-boom');

      const discoveryLogs = logs.filter((l) => l.category === 'registry.discovery');
      expect(discoveryLogs.map((l) => l.event)).toEqual(['start', 'failed']);
      const failedData = discoveryLogs[1]?.data as { durationMs?: number; error?: string };
      expect(typeof failedData.durationMs).toBe('number');
      expect(failedData.durationMs).toBeGreaterThanOrEqual(0);
      expect(failedData.error).toContain('clock-boom');
    } finally {
      spy.mockRestore();
    }
  });
});
