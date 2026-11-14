// OCR registry + provider abstraction — verifies the scoring
// contract (output > strength > language > cost), hard filters,
// and pick() availability gating. Concrete UpstageProvider's
// run() shape is covered separately in ocr-upstage.test.ts.

import { describe, expect, test } from 'bun:test';

import {
  OcrProvider,
  OcrRegistry,
  SCORE_WEIGHT_OUTPUT,
  SCORE_WEIGHT_STRENGTH,
  SCORE_WEIGHT_LANGUAGE,
  COST_PENALTY_PER_USD,
  UpstageProvider,
  type OcrCapabilities,
  type OcrInput,
  type OcrResult,
} from '../src/ocr/index.js';

class StubProvider extends OcrProvider {
  constructor(
    public readonly name: string,
    public readonly capabilities: OcrCapabilities,
    private readonly available = true,
  ) { super(); }
  isAvailable(): boolean | Promise<boolean> { return this.available; }
  async run(_input: OcrInput): Promise<OcrResult> {
    return {
      ok: true, provider: this.name,
      text: '', markdown: '', html: '', raw: {},
    };
  }
}

const baseCaps = (over: Partial<OcrCapabilities>): OcrCapabilities => ({
  languages: ['en'],
  outputs: ['text'],
  inputs: ['image/*'],
  strengths: [],
  costPerPageUsd: 0.01,
  ...over,
});

describe('OcrProvider.matchScore · capability scoring', () => {
  test('output match adds SCORE_WEIGHT_OUTPUT per overlap', () => {
    const p = new StubProvider('p', baseCaps({ outputs: ['text', 'markdown'] }));
    const score = p.matchScore({ outputs: ['markdown'] })!;
    expect(score).toBeCloseTo(SCORE_WEIGHT_OUTPUT - baseCaps({}).costPerPageUsd * COST_PENALTY_PER_USD, 5);
  });

  test('output ratio: format > strength > language', () => {
    const caps = baseCaps({
      outputs: ['markdown'],
      strengths: ['korean'],
      languages: ['ko'],
    });
    const p = new StubProvider('p', caps);
    const onlyOutput = p.matchScore({ outputs: ['markdown'] })!;
    const onlyStrength = p.matchScore({ strengths: ['korean'] })!;
    const onlyLanguage = p.matchScore({ languages: ['ko'] })!;
    expect(onlyOutput).toBeGreaterThan(onlyStrength);
    expect(onlyStrength).toBeGreaterThan(onlyLanguage);
  });

  test('languages: "*" wildcard matches any caller hint', () => {
    const p = new StubProvider('p', baseCaps({ languages: ['*'] }));
    const score = p.matchScore({ languages: ['ko', 'en', 'zh'] })!;
    expect(score).toBeCloseTo(SCORE_WEIGHT_LANGUAGE * 3 - 0.01 * COST_PENALTY_PER_USD, 5);
  });

  test('hard filter: maxCostPerPageUsd excludes pricey provider', () => {
    const cheap = new StubProvider('cheap', baseCaps({ costPerPageUsd: 0.001 }));
    const pricey = new StubProvider('pricey', baseCaps({ costPerPageUsd: 0.05 }));
    expect(cheap.matchScore({ maxCostPerPageUsd: 0.01 })).not.toBeNull();
    expect(pricey.matchScore({ maxCostPerPageUsd: 0.01 })).toBeNull();
  });

  test('hard filter: requireAsync excludes sync-only provider', () => {
    const sync = new StubProvider('sync', baseCaps({ async: false }));
    const both = new StubProvider('both', baseCaps({ async: true }));
    expect(sync.matchScore({ requireAsync: true })).toBeNull();
    expect(both.matchScore({ requireAsync: true })).not.toBeNull();
  });

  test('cost penalty makes the cheaper provider win on ties', () => {
    const a = new StubProvider('a', baseCaps({ outputs: ['markdown'], costPerPageUsd: 0.001 }));
    const b = new StubProvider('b', baseCaps({ outputs: ['markdown'], costPerPageUsd: 0.05 }));
    const aScore = a.matchScore({ outputs: ['markdown'] })!;
    const bScore = b.matchScore({ outputs: ['markdown'] })!;
    expect(aScore).toBeGreaterThan(bScore);
  });

  test('empty requirements still applies cost penalty', () => {
    const free = new StubProvider('free', baseCaps({ costPerPageUsd: 0 }));
    const paid = new StubProvider('paid', baseCaps({ costPerPageUsd: 0.05 }));
    expect(free.matchScore({})!).toBeGreaterThan(paid.matchScore({})!);
  });
});

describe('OcrRegistry.pick · availability gating + ranking', () => {
  test('awaits Promise true/false and skips a rejecting provider before choosing fallback', async () => {
    class AsyncProvider extends StubProvider {
      constructor(name: string, private readonly availability: () => Promise<boolean>) {
        super(name, baseCaps({ outputs: ['markdown'] }));
      }
      override isAvailable(): Promise<boolean> { return this.availability(); }
    }
    const reg = new OcrRegistry();
    reg.register(new AsyncProvider('async-true', async () => true));
    reg.register(new AsyncProvider('async-false', async () => false));
    reg.register(new AsyncProvider('async-reject', async () => { throw new Error('synthetic backend detail'); }));
    reg.register(new StubProvider('fallback', baseCaps({ outputs: ['markdown'] })));
    const picked = await reg.pick({ outputs: ['markdown'] });
    expect(picked?.provider.name).toBe('async-true');
    expect(picked?.ranking.map(row => row.provider.name)).toEqual(['async-true', 'fallback']);

    const rejectedFirst = new OcrRegistry();
    rejectedFirst.register(new AsyncProvider('async-reject', async () => { throw new Error('synthetic backend detail'); }));
    rejectedFirst.register(new StubProvider('fallback', baseCaps({ outputs: ['markdown'] })));
    expect((await rejectedFirst.pick({ outputs: ['markdown'] }))?.provider.name).toBe('fallback');
  });

  test('empty registry returns null', async () => {
    const reg = new OcrRegistry();
    expect(await reg.pick()).toBeNull();
  });

  test('skips unavailable providers', async () => {
    const reg = new OcrRegistry();
    reg.register(new StubProvider('a', baseCaps({}), false)); // unavailable
    reg.register(new StubProvider('b', baseCaps({}), true));
    const picked = await reg.pick();
    expect(picked).not.toBeNull();
    expect(picked!.provider.name).toBe('b');
  });

  test('returns highest-scoring available provider', async () => {
    const reg = new OcrRegistry();
    reg.register(new StubProvider('weak', baseCaps({ outputs: ['text'] })));
    reg.register(new StubProvider('strong', baseCaps({ outputs: ['markdown', 'html'] })));
    const picked = await reg.pick({ outputs: ['markdown'] });
    expect(picked!.provider.name).toBe('strong');
    // ranking covers all available providers, sorted desc.
    expect(picked!.ranking.length).toBe(2);
    expect(picked!.ranking[0]!.provider.name).toBe('strong');
    expect(picked!.ranking[1]!.provider.name).toBe('weak');
  });

  test('ties broken by registration order (insertion order)', async () => {
    const reg = new OcrRegistry();
    const caps = baseCaps({ outputs: ['markdown'] });
    reg.register(new StubProvider('first', caps));
    reg.register(new StubProvider('second', caps));
    const picked = await reg.pick({ outputs: ['markdown'] });
    expect(picked!.provider.name).toBe('first');
  });

  test('hard-filtered providers excluded from ranking', async () => {
    const reg = new OcrRegistry();
    reg.register(new StubProvider('cheap', baseCaps({ costPerPageUsd: 0.001 })));
    reg.register(new StubProvider('pricey', baseCaps({ costPerPageUsd: 0.05 })));
    const picked = await reg.pick({ maxCostPerPageUsd: 0.01 });
    expect(picked!.provider.name).toBe('cheap');
    expect(picked!.ranking.length).toBe(1); // pricey filtered out
  });

  test('register() is idempotent — same name overwrites', async () => {
    const reg = new OcrRegistry();
    reg.register(new StubProvider('p', baseCaps({ outputs: ['text'] })));
    reg.register(new StubProvider('p', baseCaps({ outputs: ['markdown'] }))); // overwrite
    expect(reg.list().length).toBe(1);
    expect(reg.get('p')!.capabilities.outputs).toEqual(['markdown']);
  });

  test('unregister returns true when removed', () => {
    const reg = new OcrRegistry();
    reg.register(new StubProvider('p', baseCaps({})));
    expect(reg.unregister('p')).toBe(true);
    expect(reg.unregister('p')).toBe(false);
  });
});

describe('UpstageProvider · capability declaration + isAvailable', () => {
  test('declares Korean / tables / handwriting strengths', () => {
    const p = new UpstageProvider();
    expect(p.capabilities.strengths).toContain('korean');
    expect(p.capabilities.strengths).toContain('tables');
    expect(p.capabilities.strengths).toContain('handwriting');
  });

  test('declares markdown + layout outputs (document-parse default)', () => {
    const p = new UpstageProvider();
    expect(p.capabilities.outputs).toContain('markdown');
    expect(p.capabilities.outputs).toContain('html');
    expect(p.capabilities.outputs).toContain('layout');
  });

  test('isAvailable returns false when key resolver returns null', () => {
    const p = new UpstageProvider({ resolveApiKey: () => null });
    expect(p.isAvailable()).toBe(false);
  });

  test('isAvailable returns true when key resolver returns a string', () => {
    const p = new UpstageProvider({ resolveApiKey: () => 'fake-key' });
    expect(p.isAvailable()).toBe(true);
  });

  test('run rejects unsupported mime with stage=unsupported', async () => {
    const p = new UpstageProvider({ resolveApiKey: () => 'k' });
    const res = await p.run({
      file: new Uint8Array([0]),
      filename: 'audio.wav',
      mimeType: 'audio/wav',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.stage).toBe('unsupported');
  });

  test('run wraps low-level runUpstageOcr · provider field set', async () => {
    type FetchLike = (input: unknown, init?: unknown) => Promise<Response>;
    const fakeFetch = ((async () => new Response(
      JSON.stringify({ content: { markdown: '# x', html: '<h1>x</h1>', text: 'x' } }),
      { status: 200 },
    )) as FetchLike) as unknown as typeof fetch;
    const p = new UpstageProvider({ resolveApiKey: () => 'k' });
    const res = await p.run({
      file: new Uint8Array([0]),
      filename: 'memo.jpg',
      mimeType: 'image/jpeg',
      fetchImpl: fakeFetch,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.provider).toBe('upstage');
      expect(res.markdown).toBe('# x');
      expect(res.html).toBe('<h1>x</h1>');
    }
  });

  test('preferredOutput=text picks the cheaper ocr model', async () => {
    type FetchLike = (input: unknown, init?: unknown) => Promise<Response>;
    const seen: { model: string | null } = { model: null };
    const fakeFetch = ((async (_url: unknown, init: unknown) => {
      const body = (init as RequestInit).body;
      if (body instanceof FormData) {
        const v = body.get('model');
        seen.model = typeof v === 'string' ? v : null;
      }
      return new Response(JSON.stringify({ text: 'raw' }), { status: 200 });
    }) as FetchLike) as unknown as typeof fetch;
    const p = new UpstageProvider({ resolveApiKey: () => 'k' });
    await p.run({
      file: new Uint8Array([0]),
      filename: 'card.png',
      mimeType: 'image/png',
      preferredOutput: 'text',
      fetchImpl: fakeFetch,
    });
    expect(seen.model).toBe('ocr');
  });
});
