// Shared Grok Agent-Tools search parser (src/grok/agent-search.ts).
// parseResponsesOutput is the flattener all three Grok search call-sites
// depend on, so it's guarded here in isolation (pure, no network).

import { describe, test, expect } from 'bun:test';
import { debug } from '../src/debug/log.js';
import { grokAgentSearch, parseResponsesOutput } from '../src/grok/agent-search';

describe('grokAgentSearch · injected transport ledger', () => {
  test('records one safe attempt while retaining the injected transport and response', async () => {
    const before = debug.events(500).filter(e => e.category === 'llm.call' && e.event === 'attempt').length;
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const result = await grokAgentSearch('find docs', {
      apiKey: 'grok-secret', model: 'grok-search-test', baseUrl: 'https://proxy.example/v1',
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Found it' }] }] });
      },
    });
    expect(result).toMatchObject({ ok: true, status: 200, text: 'Found it' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://proxy.example/v1/responses');
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe('Bearer grok-secret');
    expect(JSON.parse(calls[0]?.init?.body as string).model).toBe('grok-search-test');
    const rows = debug.events(500).filter(e => e.category === 'llm.call' && e.event === 'attempt').slice(before);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data).toMatchObject({ provider: 'grok', model: 'grok-search-test', host: 'proxy.example', requestedBy: 'grok.agent-search' });
    expect(JSON.stringify(rows[0])).not.toContain('grok-secret');
    expect(JSON.stringify(rows[0])).not.toContain('/responses');
  });
});

describe('parseResponsesOutput', () => {
  test('flattens message text + annotations + search_call sources, deduped', () => {
    const r = parseResponsesOutput({
      output: [
        { type: 'reasoning', summary: [] },
        { type: 'web_search_call', action: { sources: [
          { type: 'url', url: 'https://a.com', title: 'A' },
          { type: 'url', url: 'https://b.com' },
        ] } },
        { type: 'message', content: [{
          type: 'output_text',
          text: 'Answer body.',
          annotations: [
            { type: 'url_citation', url: 'https://a.com', title: '1' }, // dup url, numeric title
            { type: 'url_citation', url: 'https://c.com', title: 'C site' },
          ],
        }] },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.text).toBe('Answer body.');
    // a.com from annotation first (numeric title dropped → no title), then
    // c.com (real title), then b.com from the search_call. a.com deduped.
    expect(r.citations.map(c => c.url)).toEqual(['https://a.com', 'https://c.com', 'https://b.com']);
    expect(r.citations.find(c => c.url === 'https://a.com')?.title).toBeUndefined(); // "1" dropped
    expect(r.citations.find(c => c.url === 'https://c.com')?.title).toBe('C site');
    expect(r.citations.find(c => c.url === 'https://a.com')).toBeDefined();
  });

  test('x_search_call sources are included too', () => {
    const r = parseResponsesOutput({
      output: [
        { type: 'x_search_call', action: { sources: [{ type: 'url', url: 'https://x.com/post/1' }] } },
        { type: 'message', content: [{ type: 'output_text', text: 'X says hi', annotations: [] }] },
      ],
    });
    expect(r.text).toBe('X says hi');
    expect(r.citations.map(c => c.url)).toEqual(['https://x.com/post/1']);
  });

  test('empty / malformed output is fail-soft (empty text, no citations)', () => {
    expect(parseResponsesOutput({ output: [] })).toMatchObject({ ok: true, text: '', citations: [] });
    expect(parseResponsesOutput(null)).toMatchObject({ ok: true, text: '', citations: [] });
    expect(parseResponsesOutput({})).toMatchObject({ ok: true, text: '', citations: [] });
  });
});
