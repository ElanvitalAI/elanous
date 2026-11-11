import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runGraph } from '../../../src/graph-runner/runner.js';
import { createCrawlGraphRegistry } from '../../../src/crawl-capabilities/graph-registry.js';
import type { CrawlProvider } from '../../../src/crawl-capabilities/contracts.js';
import { runCapability, type EngineCtx, type EngineDescriptor } from '../../../skills/omni-crawl/src/registry.js';

const graph = resolve(import.meta.dir, 'kaist-key-feature.yaml');
const responses = [
  { kind: 'web', url: 'https://example.org/lecture', title: '강의 웹', text: '웹 강의 핵심 문장' },
  { kind: 'x', url: 'https://x.com/kaist/status/123', title: '강의 X', text: 'X 게시글 핵심 문장' },
  { kind: 'youtube', url: 'https://www.youtube.com/watch?v=abc123', title: '강의 영상', text: '영상 설명 핵심 문장' },
] as const;
const skillContext: EngineCtx = { limit: 1, depth: 'basic', minFavs: 0, maxItems: 1, lang: 'ko' };

function output(state: Awaited<ReturnType<typeof runGraph>>, nodeId: string): any {
  const raw = state.nodes.find(node => node.nodeId === nodeId)?.output;
  return JSON.parse(String(raw));
}

test('KAIST share → scrap → crawl contract → absorb → briefing completes for web, X and YouTube URLs', async () => {
  for (const item of responses) {
    const root = mkdtempSync(join(tmpdir(), 'kaist-key-flow-'));
    const calls: string[] = [];
    const freeSkill: EngineDescriptor = {
      id: 'fixed-skill-free', capability: 'scrape', provides: ['scrape.url@1'], tier: 'free', latency: 1, keyEnv: [],
      available: () => true,
      run: async (url) => {
        calls.push(`skill-free:${url}`);
        return { engine: 'fixed-skill-free', query: url, totalItems: 1,
          items: [{ engine: 'fixed-skill-free', query: url, url, text: item.text, metadata: { title: item.title } }] };
      },
    };
    const byokSkill: EngineDescriptor = {
      ...freeSkill, id: 'fixed-skill-byok', tier: 'byok', latency: 0, keyEnv: ['FIXED_SIM_KEY'],
      run: async (url) => { calls.push(`skill-byok:${url}`); throw new Error('free provider should win'); },
    };
    const scrape: CrawlProvider = {
      id: 'omni-fixed-scrape', provides: ['scrape.url@1'], tier: 'free', latency: 1, keyEnv: [],
      available: () => true,
      run: async (url) => (await runCapability({ contract: 'scrape.url@1' }, url, skillContext,
        [byokSkill, freeSkill], { FIXED_SIM_KEY: 'fixture' })).result,
    };
    const extract: CrawlProvider = {
      id: 'fixed-reader', provides: ['extract.structured@1'], tier: 'free', latency: 1, keyEnv: [],
      available: () => true,
      run: async (url, _context, contract) => {
        calls.push(`${contract}:${url}`);
        return { engine: 'fixed-reader', query: url, totalItems: 1,
          items: [{ engine: 'fixed-reader', query: url, url, text: item.text, metadata: { title: item.title } }] };
      },
    };
    try {
      const state = await runGraph(graph, {
        input: { memberId: 'kaist-demo', sourceKind: item.kind, url: item.url }, quiet: true,
        deps: { root, capabilityProviders: createCrawlGraphRegistry([scrape, extract]),
          inProcessHandlers: {
            share: ({ input }) => {
              const shared = input as { memberId: string; sourceKind: string; url: string };
              return { ok: true, outcome: 'ok', result: { ...shared, shared: true } };
            },
            scrap: ({ outputs }) => {
              const shared = (outputs.share as { result: { memberId: string; sourceKind: string; url: string } }).result;
              return { ok: true, outcome: 'ok', result: { ...shared, scrapId: 'fixed-scrap-1' } };
            },
            absorb: ({ outputs }) => {
              const extracted = (outputs.extract as { result: { url: string; title: string; content: string; provider: string } }).result;
              const scraped = (outputs['crawl-scrape'] as { result: { items: Array<{ text: string }> } }).result;
              if (scraped.items[0]?.text !== extracted.content) return { ok: false, outcome: 'fail', error: 'scrape/extract mismatch' };
              return { ok: true, outcome: 'ok', result: { ...extracted, scrapId: 'fixed-scrap-1', crawledText: scraped.items[0].text } };
            },
            brief: ({ outputs }) => {
              const absorbed = (outputs.absorb as { result: { url: string; title: string; content: string; provider: string; scrapId: string; crawledText: string } }).result;
              return { ok: true, outcome: 'ok', result: {
                title: absorbed.title, summary: absorbed.content, sourceUrl: absorbed.url,
                sourceProvider: absorbed.provider, scrapId: absorbed.scrapId, sourceExcerpt: absorbed.crawledText,
              } };
            },
          } },
      });
      expect(state.status).toBe('done');
      expect(state.path).toEqual(['share', 'scrap', 'crawl-scrape', 'extract', 'absorb', 'brief', 'done']);
      expect(calls).toEqual([`skill-free:${item.url}`, `extract.structured@1:${item.url}`]);
      expect(output(state, 'scrap').result).toMatchObject({ url: item.url, scrapId: 'fixed-scrap-1' });
      expect(output(state, 'crawl-scrape')).toMatchObject({ evidence: { provider: 'omni-fixed-scrape', source: item.url },
        result: { items: [{ url: item.url, text: item.text }] } });
      expect(output(state, 'extract')).toMatchObject({ evidence: { provider: 'fixed-reader', source: item.url },
        result: { url: item.url, title: item.title, content: item.text, provider: 'fixed-reader' } });
      expect(output(state, 'brief').result).toEqual({
        title: item.title, summary: item.text, sourceUrl: item.url,
        sourceProvider: 'fixed-reader', scrapId: 'fixed-scrap-1', sourceExcerpt: item.text,
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
}, 30_000);

test('empty crawl result fails closed before absorption and briefing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kaist-key-flow-empty-'));
  const crawl: CrawlProvider = {
    id: 'fixed-empty', provides: ['extract.structured@1'], tier: 'free', latency: 1, keyEnv: [],
    available: () => true, run: async () => null,
  };
  const scrape: CrawlProvider = {
    id: 'fixed-scrape', provides: ['scrape.url@1'], tier: 'free', latency: 1, keyEnv: [], available: () => true,
    run: async (url) => ({ engine: 'fixed-scrape', query: url, totalItems: 1,
      items: [{ engine: 'fixed-scrape', query: url, url, text: 'fixed page' }] }),
  };
  try {
    const state = await runGraph(graph, { input: { memberId: 'kaist-demo', sourceKind: 'web', url: responses[0].url }, quiet: true,
      deps: { root, capabilityProviders: createCrawlGraphRegistry([scrape, crawl]), inProcessHandlers: {
        share: ({ input }) => ({ ok: true, outcome: 'ok', result: input }),
        scrap: ({ outputs }) => ({ ok: true, outcome: 'ok', result: (outputs.share as { result: unknown }).result }),
        absorb: () => { throw new Error('absorb must not run'); },
        brief: () => { throw new Error('brief must not run'); },
      } } });
    expect(state.status).toBe('failed');
    expect(state.path).toEqual(['share', 'scrap', 'crawl-scrape', 'extract', 'failed']);
    expect(output(state, 'extract')).toMatchObject({ error: 'contract-exhausted', evidence: { contractId: 'extract.structured@1' } });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);
