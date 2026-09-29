import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';

import {
  buildOmniSearchTool,
  dispatchOmniSearch,
  omniSearchAvailable,
} from '../src/skills/tools/omni-search.js';
import {
  _resetWebSearchProvidersForTests,
  addWebSearchProvider,
  getAvailableWebSearchProviders,
} from '../src/web-search/index.js';
import type { WebSearchProvider, WebSearchHit } from '../src/web-search/provider.js';

function fakeProvider(id: string, hits: WebSearchHit[], opts: { available?: boolean; throwError?: string } = {}): WebSearchProvider {
  return {
    id,
    displayName: id,
    available: () => opts.available ?? true,
    async search() {
      if (opts.throwError) throw new Error(opts.throwError);
      return { hits, providerName: id, durationMs: 0 };
    },
  };
}

beforeEach(() => {
  _resetWebSearchProvidersForTests(false);
});

afterEach(() => {
  _resetWebSearchProvidersForTests();
});

describe('buildOmniSearchTool', () => {
  test('schema declares query required + merge enum', () => {
    const spec = buildOmniSearchTool();
    expect(spec.name).toBe('OmniSearch');
    expect(spec.parameters.required).toEqual(['query']);
    const props = spec.parameters.properties as Record<string, { enum?: string[] }>;
    expect(props.merge.enum).toEqual(['interleave', 'by-engine']);
  });
});

describe('omniSearchAvailable', () => {
  test('false when 0 or 1 providers available', () => {
    expect(omniSearchAvailable()).toBe(false);
    addWebSearchProvider(fakeProvider('one', []));
    expect(omniSearchAvailable()).toBe(false);
  });

  test('true when ≥ 2 providers available', () => {
    addWebSearchProvider(fakeProvider('one', []));
    addWebSearchProvider(fakeProvider('two', []));
    expect(omniSearchAvailable()).toBe(true);
  });
});

describe('dispatchOmniSearch — empty providers', () => {
  test('returns helpful message + zero hits', async () => {
    const r = await dispatchOmniSearch({ query: 'x' });
    expect(r.metadata.totalHits).toBe(0);
    expect(r.output).toContain('no available providers');
  });
});

describe('dispatchOmniSearch — happy path', () => {
  beforeEach(() => {
    addWebSearchProvider(fakeProvider('alpha', [
      { url: 'https://a.com/1', title: 'A1', snippet: 'aaa' },
      { url: 'https://a.com/2', title: 'A2', snippet: 'bbb' },
    ]));
    addWebSearchProvider(fakeProvider('beta', [
      { url: 'https://b.com/1', title: 'B1', snippet: 'ccc' },
    ]));
  });

  test('runs all providers and merges interleave by default', async () => {
    const r = await dispatchOmniSearch({ query: 'whatever' });
    expect(r.metadata.totalHits).toBe(3);
    expect(r.metadata.merge).toBe('interleave');
    expect(r.metadata.perEngine.alpha.hits).toBe(2);
    expect(r.metadata.perEngine.beta.hits).toBe(1);
    // Output contains hits from both providers.
    expect(r.output).toContain('A1');
    expect(r.output).toContain('B1');
  });

  test('merge="by-engine" groups under headings', async () => {
    const r = await dispatchOmniSearch({ query: 'q', merge: 'by-engine' });
    expect(r.output).toContain('## alpha');
    expect(r.output).toContain('## beta');
  });

  test('engines filter restricts to named providers', async () => {
    const r = await dispatchOmniSearch({ query: 'q', engines: ['alpha'] });
    expect(r.metadata.perEngine.alpha).toBeDefined();
    expect(r.metadata.perEngine.beta).toBeUndefined();
  });
});

describe('dispatchOmniSearch — onEngine', () => {
  test('reports start and completion for selected engines without changing tool output', async () => {
    const clock = spyOn(Date, 'now').mockReturnValue(100);
    try {
      const searched: string[] = [];
      const events: Array<{ engine: string; phase: string; hits?: number; durationMs?: number; error?: string }> = [];
      addWebSearchProvider({
        ...fakeProvider('first', [{ url: 'https://a.test', title: 'A', snippet: 'a' }]),
        async search(q) {
          searched.push(`first:${q.query}:${q.limit}`);
          return { hits: [{ url: 'https://a.test', title: 'A', snippet: 'a' }], providerName: 'first', durationMs: 0 };
        },
      });
      addWebSearchProvider({
        ...fakeProvider('second', []),
        async search(q) {
          searched.push(`second:${q.query}:${q.limit}`);
          throw new Error('offline failure');
        },
      });
      const args = { query: 'offline', engines: ['first', 'second'], limit: 3, merge: 'by-engine' as const };
      const without = await dispatchOmniSearch(args);
      expect(searched).toEqual(['first:offline:3', 'second:offline:3']);
      searched.length = 0;
      const withCallback = await dispatchOmniSearch(args, { onEngine: event => events.push(event) });
      expect(searched).toEqual(['first:offline:3', 'second:offline:3']);
      expect(withCallback).toEqual(without);
      expect(events).toEqual([
        { engine: 'first', phase: 'start' },
        { engine: 'second', phase: 'start' },
        { engine: 'first', phase: 'complete', hits: 1, durationMs: 0 },
        { engine: 'second', phase: 'complete', hits: 0, durationMs: 0, error: 'offline failure' },
      ]);
    } finally {
      clock.mockRestore();
    }
  });

  test('observer exceptions do not turn successful searches into failures', async () => {
    addWebSearchProvider(fakeProvider('local', [{ url: 'https://a.test', title: 'A', snippet: 'a' }]));
    const args = { query: 'offline', engines: ['local'] };
    const baseline = await dispatchOmniSearch(args);
    const phases: string[] = [];
    const result = await dispatchOmniSearch(args, { onEngine: event => {
      phases.push(event.phase);
      throw new Error('observer failed');
    } });
    expect(phases).toEqual(['start', 'complete']);
    expect(result.output.replace(/in \d+ms/g, 'in <ms>')).toBe(baseline.output.replace(/in \d+ms/g, 'in <ms>'));
    expect(result.metadata.totalHits).toBe(baseline.metadata.totalHits);
    expect(result.metadata.perEngine.local.error).toBeUndefined();
  });

  test('async observer rejections at start and completion leave the result unchanged', async () => {
    const clock = spyOn(Date, 'now').mockReturnValue(100);
    try {
      addWebSearchProvider(fakeProvider('local', [{ url: 'https://a.test', title: 'A', snippet: 'a' }]));
      const args = { query: 'offline', engines: ['local'] };
      const baseline = await dispatchOmniSearch(args);
      const phases: string[] = [];
      const result = await dispatchOmniSearch(args, { onEngine: async event => {
        phases.push(event.phase);
        await Promise.resolve();
        throw new Error('async observer failed');
      } });
      expect(phases).toEqual(['start', 'complete']);
      expect(result).toEqual(baseline);
      // Let both rejected observer promises settle before the test ends.
      await new Promise(resolve => setTimeout(resolve, 0));
    } finally {
      clock.mockRestore();
    }
  });

  test('no providers produce no engine events and retain the helpful output', async () => {
    const events: unknown[] = [];
    const args = { query: 'offline', engines: ['not-registered'] };
    const without = await dispatchOmniSearch(args);
    expect(await dispatchOmniSearch(args, { onEngine: event => events.push(event) })).toEqual(without);
    expect(events).toEqual([]);
    expect(without.output).toContain('no available providers');
  });
});

describe('dispatchOmniSearch — source observer', () => {
  test('emits provider-tagged hits without changing the original output or swallowing provider results', async () => {
    addWebSearchProvider(fakeProvider('first', [{ url: 'https://a.test', title: 'A', snippet: 'a' }]));
    const clock = spyOn(Date, 'now').mockReturnValue(100);
    try {
      const args = { query: 'q' };
      const baseline = await dispatchOmniSearch(args);
      const hits: string[] = [];
      const actual = await dispatchOmniSearch(args, { onSource: hit => {
        hits.push(`${hit.engine}:${hit.url}`);
        throw new Error('observer failed');
      } });
      expect(hits).toEqual(['first:https://a.test']);
      expect(actual).toEqual(baseline);
      expect(actual.metadata.perEngine.first.error).toBeUndefined();
    } finally {
      clock.mockRestore();
    }
  });
});

describe('dispatchOmniSearch — provider error tolerance', () => {
  test('one failing provider does not break the call', async () => {
    addWebSearchProvider(fakeProvider('good', [
      { url: 'https://x.com', title: 'X', snippet: 's' },
    ]));
    addWebSearchProvider(fakeProvider('bad', [], { throwError: 'simulated 500' }));
    const r = await dispatchOmniSearch({ query: 'q' });
    expect(r.metadata.totalHits).toBe(1);
    expect(r.metadata.perEngine.bad.error).toContain('simulated 500');
    expect(r.metadata.perEngine.good.hits).toBe(1);
  });
});

describe('dispatchOmniSearch — validation', () => {
  test('missing query rejected', async () => {
    await expect(dispatchOmniSearch({})).rejects.toThrow(/query/);
  });

  test('non-array engines rejected', async () => {
    await expect(dispatchOmniSearch({ query: 'q', engines: 'grok' })).rejects.toThrow(/engines/);
  });

  test('invalid merge rejected', async () => {
    await expect(dispatchOmniSearch({ query: 'q', merge: 'random' })).rejects.toThrow(/merge/);
  });
});

describe('catalog registration', () => {
  test('omni_search has hintKeys + cleanerFitThanShell', async () => {
    const { nativeToolCatalog } = await import('../src/native-tool-catalog.js');
    const entry = nativeToolCatalog.find(t => t.id === 'omni_search');
    expect(entry).toBeDefined();
    expect(entry!.hintKeys).toContain('intentResearch');
    expect(entry!.cleanerFitThanShell).toBe(true);
  });
});
