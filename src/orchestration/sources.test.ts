// DEMO-SOURCES-VIA-SECRET — data desks with mocked providers: source records ride from the desk through the worker
// and the reduce into the «출처» section; a missing key / failed call is «source unavailable» and yields no claim.
import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { headlessBackend } from './backends.js';
import { runOrchestration, sourceRule, withSources, type WorkerBackend, type WorkerOutcome } from './runner.js';
import { marketDesk, newsDesk, renderDesk, sourcesSection, withoutSources, xDesk, youtubeDesk, type DeskResult, type SourceDeps } from './sources.js';
import { DEFAULT_LIMITS, validateSpec } from './spec.js';
import { presetFor } from './templates.js';

const AT = new Date('2026-11-26T03:00:00.000Z');
const FAKE = 'fake-key-0000';
type Route = (url: string, init?: RequestInit) => { status: number; body: unknown } | undefined;
function deps(keys: Record<string, string>, route: Route, extra: Partial<SourceDeps> = {}): SourceDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls, now: () => AT,
    key: async (ids, env) => { for (const id of [...ids, ...env]) if (keys[id]) return keys[id]; return undefined; },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      const r = route(url, init);
      if (!r) return new Response('nope', { status: 404 });
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
    ...extra,
  };
}

describe('news desk', () => {
  test('Firecrawl items carry provider, URL and fetched-at', async () => {
    const d = deps({ 'cred:firecrawl.api_key': FAKE }, (u) => u.includes('firecrawl') ? { status: 200, body: { data: [{ url: 'https://news.example/a', title: 'KOSPI rallies', description: 'chips lead' }] } } : undefined);
    const r = await newsDesk('kospi', d);
    expect(r.status).toBe('ok');
    expect(r.via).toBe('via Firecrawl search');
    expect(r.items[0]!.source).toEqual({ provider: 'Firecrawl search', url: 'https://news.example/a', fetchedAt: '2026-11-26T03:00:00.000Z', title: 'KOSPI rallies' });
  });
  test('Firecrawl HTTP 500 falls back to Brave news', async () => {
    const d = deps({ 'cred:firecrawl.api_key': FAKE, 'cred:brave.api_key': FAKE }, (u) => u.includes('firecrawl') ? { status: 500, body: {} }
      : u.includes('brave') ? { status: 200, body: { results: [{ url: 'https://brave.example/b', title: 'Won weakens', description: 'FX' }] } } : undefined);
    const r = await newsDesk('kospi', d);
    expect(r.via).toBe('via Brave news search');
    expect(r.items.map((i) => i.source.url)).toEqual(['https://brave.example/b']);
  });
  test('no key at all → unavailable, no provider called', async () => {
    const d = deps({}, () => undefined);
    const r = await newsDesk('kospi', d);
    expect(r.status).toBe('unavailable');
    expect(r.items).toHaveLength(0);
    expect(r.reason).toContain('Firecrawl key not set');
    expect(d.calls).toHaveLength(0);
    expect(renderDesk(r)).toContain('source unavailable');
  });
});

describe('X desk', () => {
  test('no Apify token in secrets → Grok search, labelled «via Grok search», items cite X URLs', async () => {
    let usedKey: string | undefined;
    const d = deps({ XAI_API_KEY: FAKE, APIFY_TOKEN_ENV_ONLY: FAKE }, () => undefined, {
      grok: async (_q, k) => { usedKey = k; return { ok: true, status: 200, text: 'Traders expect a chip-led open.', citations: [{ url: 'https://x.com/a/status/1' }, { url: 'https://web.example/z' }], xSearchSources: ['https://x.com/a/status/1'] }; },
    });
    const r = await xDesk('kospi', d);
    expect(r.via).toBe('via Grok search');
    expect(usedKey).toBe(FAKE);
    expect(r.items.every((i) => i.source.url.startsWith('https://'))).toBe(true);
    expect(r.items[0]!.source.url).toBe('https://x.com/a/status/1');
    expect(d.calls.some((u) => u.includes('apify'))).toBe(false);
  });
  test('Apify token in secrets → tweet scraper items with tweet URLs', async () => {
    const d = deps({ 'cred:apify.token': FAKE }, (u) => u.includes('apify') ? { status: 200, body: [{ url: 'https://x.com/b/status/2', text: 'foreigners buying', author: { userName: 'b' } }] } : undefined);
    const r = await xDesk('kospi', d);
    expect(r.via).toBe('via Apify tweet scraper');
    expect(r.items[0]!.source.url).toBe('https://x.com/b/status/2');
  });
  test('Grok failure → unavailable', async () => {
    const d = deps({}, () => undefined, { grok: async () => ({ ok: false, status: 0, text: '', citations: [], error: 'missing-api-key' }) });
    const r = await xDesk('kospi', d);
    expect(r.status).toBe('unavailable');
    expect(r.reason).toContain('xAI key not set');
  });
});

describe('YouTube and market desks', () => {
  test('no Supadata key → unavailable', async () => {
    expect((await youtubeDesk('q', deps({}, () => undefined))).status).toBe('unavailable');
  });
  test('Supadata search + transcript → item per video URL', async () => {
    const d = deps({ SUPADATA_API_KEY: FAKE }, (u) => u.includes('/youtube/search') ? { status: 200, body: { results: [{ id: 'abcDEF12345', title: 'Market talk', channel: { name: 'Chan' } }] } }
      : u.includes('/transcript') ? { status: 200, body: { content: 'tomorrow the index…' } } : undefined);
    const r = await youtubeDesk('q', d);
    expect(r.items[0]!.source.url).toBe('https://www.youtube.com/watch?v=abcDEF12345');
  });
  test('EODHD quotes recorded without the token; missing KIS/KRX keys are named as unavailable parts', async () => {
    const d = deps({ 'cred:eodhd.api_key': FAKE }, (u) => u.includes('eodhd.com') ? { status: 200, body: { close: 2650.5, change_p: 1.2, timestamp: 1764100000 } } : undefined);
    const r = await marketDesk(d);
    expect(r.status).toBe('ok');
    expect(r.items).toHaveLength(5);
    expect(JSON.stringify(r)).not.toContain(FAKE);
    expect(r.items[0]!.source.url).toBe('https://eodhd.com/api/real-time/KS11.INDX');
    expect(r.unavailableParts?.map((p) => p.provider)).toEqual(['KIS', 'KRX']);
  });
  test('every market source failing → unavailable, error text has no key', async () => {
    const d = deps({ 'cred:eodhd.api_key': FAKE, 'cred:krx.api_key': FAKE }, () => ({ status: 401, body: {} }));
    const r = await marketDesk(d);
    expect(r.status).toBe('unavailable');
    expect(r.reason).toContain('HTTP 401');
    expect(JSON.stringify(r)).not.toContain(FAKE);
  });
});

const okDesk: DeskResult = { desk: 'news', status: 'ok', via: 'via Firecrawl search', items: [{ text: 'a', source: { provider: 'Firecrawl search', url: 'https://news.example/a', fetchedAt: AT.toISOString() } }] };
const deadDesk: DeskResult = { desk: 'x', status: 'unavailable', via: 'via Grok search', items: [], reason: 'xAI key not set' };

describe('reduce keeps the source records', () => {
  test('출처 lists fetched URLs and names the desk with no source', () => {
    const outcomes: WorkerOutcome[] = [
      { jobId: 'r1-a', workerId: 'news', kind: 'eln', ok: true, text: 'news says a', durationMs: 1, costUsd: 0, source: okDesk },
      { jobId: 'r1-b', workerId: 'x-pulse', kind: 'eln', ok: false, text: 'source unavailable', durationMs: 1, costUsd: 0, error: 'source unavailable', source: deadDesk },
    ];
    const out = withSources('브리핑 본문', outcomes);
    expect(out).toMatch(/## 출처\n1\. Firecrawl search · https:\/\/news\.example\/a · 2026-11-26T03:00:00\.000Z/u);
    expect(out).toContain('### 출처 없음\n- x-pulse (via Grok search): 출처 확보 실패 — xAI key not set · 이 데스크의 내용은 싣지 않음');
    expect(sourceRule(outcomes, '내일 시장 브리핑')).toContain('Write the whole result in Korean');
    expect(sourceRule(outcomes, 'market brief')).not.toContain('Korean');
    expect(sourceRule(outcomes)).toContain('x-pulse');
    expect(withSources('plain', [{ jobId: 'j', workerId: 'w', kind: 'eln', ok: true, text: 't', durationMs: 1, costUsd: 0 }])).toBe('plain');
    expect(sourcesSection([])).toBe('');
    expect(withoutSources(out)).toBe('브리핑 본문');
    expect(withoutSources('no list')).toBe('no list');
  });
  test('a run carries desk records into the final result; the dead desk\'s text never reaches the reduce', async () => {
    const seen: string[] = [];
    const backend: WorkerBackend = {
      name: 'sim', available: async () => true, closeAll: async () => undefined,
      run: async (job) => job.worker.id === 'news'
        ? { jobId: job.id, workerId: 'news', kind: 'eln', ok: true, text: `${'chips lead the open. '.repeat(20)}`, durationMs: 1, costUsd: 0.01, source: okDesk }
        : { jobId: job.id, workerId: job.worker.id, kind: 'eln', ok: false, text: 'FABRICATED-IF-USED', durationMs: 1, costUsd: 0.01, error: 'source unavailable', source: deadDesk },
    };
    const spec = validateSpec({ goal: '내일 시장 브리핑', pattern: 'map-reduce', tasks: ['news', 'x'], workers: [{ id: 'news', kind: 'eln', role: 'n', fetch: 'true' }, { id: 'x-pulse', kind: 'eln', role: 'x', fetch: 'true' }], reduce: { method: 'llm-summary', success: 'min-length:100' }, limits: { maxRounds: 1 } }).spec!;
    const rep = await runOrchestration(spec, { backend, llm: async (p) => { seen.push(p); return `요약: 반도체 주도 (https://news.example/a). ${'x'.repeat(120)}`; } });
    expect(rep.status).toBe('met');
    expect(rep.result).toContain('## 출처');
    expect(rep.result).toContain('https://news.example/a');
    expect(rep.result).toContain('x-pulse (via Grok search): 출처 확보 실패');
    expect(seen.join('\n')).not.toContain('FABRICATED-IF-USED');
    expect(seen.join('\n')).toContain('Source rule: Write the whole result in Korean');
  });
});

describe('worker script', () => {
  const stubCli = (dir: string): string => { const p = join(dir, 'eln-stub.sh'); writeFileSync(p, '#!/bin/bash\necho "answer from data"\n'); chmodSync(p, 0o755); return p; };
  test('a desk that reports unavailable ends the worker before any model call: «source unavailable», rc 3', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-src-'));
    const b = headlessBackend({ dir, timeoutSec: DEFAULT_LIMITS.timeoutSec, env: { ...process.env, ORCH_ELN: stubCli(dir) } });
    const fetch = `printf '%s' '${JSON.stringify(deadDesk)}' > "$ORCH_SOURCES_FILE"; echo "X · source unavailable"; exit 3`;
    const o = await b.run({ id: 'r1-x', title: 'ORCH·x', round: 1, prompt: 'p', worker: { id: 'x-pulse', kind: 'eln', role: 'x', fetch } }, new AbortController().signal);
    expect(o.ok).toBe(false);
    expect(o.error).toBe('source unavailable');
    expect(o.text).toBe('source unavailable');
    expect(o.source?.status).toBe('unavailable');
  });
  test('a desk with items: the outcome carries its source records', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-src-'));
    const b = headlessBackend({ dir, timeoutSec: DEFAULT_LIMITS.timeoutSec, env: { ...process.env, ORCH_ELN: stubCli(dir) } });
    const fetch = `printf '%s' '${JSON.stringify(okDesk)}' > "$ORCH_SOURCES_FILE"; echo "[1] a"`;
    const o = await b.run({ id: 'r1-n', title: 'ORCH·news', round: 1, prompt: 'p', worker: { id: 'news', kind: 'eln', role: 'n', fetch } }, new AbortController().signal);
    expect(o.ok).toBe(true);
    expect(o.source?.items[0]?.source.url).toBe('https://news.example/a');
  });
  test('the market-brief preset uses the secret-backed desks', () => {
    const fetches = presetFor('내일 아침 시장 브리핑 만들어서 음성으로 들려줘')!.build('g').workers.map((w) => w.fetch);
    expect(fetches).toEqual(['eln orchestrate source news "내일 코스피 전망 증시 뉴스"', 'eln orchestrate source x "코스피 반도체 외국인 수급 전망"',
      'eln orchestrate source youtube "증시 전망 내일 코스피"', 'eln orchestrate source market']);
  });
});
