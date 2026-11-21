/** Counts from completed tool results already delivered to the web chat. No lookup is made here. */
export interface SourceUsage {
  firecrawl: number;
  grok: number;
  market: number;
}

export function readSourceUsage(value: unknown): SourceUsage | null {
  const usage = record(value);
  if (!usage) return null;
  for (const key of ['firecrawl', 'grok', 'market'] as const) {
    if (!Number.isSafeInteger(usage[key]) || (usage[key] as number) < 0) return null;
  }
  return { firecrawl: usage.firecrawl as number, grok: usage.grok as number, market: usage.market as number };
}

export function mergeSourceUsage(a: SourceUsage, b: SourceUsage): SourceUsage {
  return { firecrawl: a.firecrawl + b.firecrawl, grok: a.grok + b.grok, market: a.market + b.market };
}

const MARKET_TOOLS = new Set(['finance_quote', 'finance_kr_flow', 'MarketQuote', 'KrFlowSnapshot']);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function addSourceUsage(current: SourceUsage, name: string, ok: boolean, rawOutput: unknown): SourceUsage {
  if (!ok) return current;
  const result = record(rawOutput);
  if (!result || result.error || result.isError) return current;
  const metadata = record(result.metadata);
  const perEngine = record(metadata?.perEngine);
  let firecrawl = current.firecrawl;
  let grok = current.grok;
  if (name === 'OmniSearch' && perEngine) {
    for (const [engine, raw] of Object.entries(perEngine)) {
      const info = record(raw);
      const hits = info?.hits;
      if (!Number.isSafeInteger(hits) || (hits as number) < 0 || info?.error) continue;
      if (engine.toLowerCase() === 'firecrawl') firecrawl += hits as number;
      if (/^grok(?:$|[-_.])/.test(engine.toLowerCase())) grok += hits as number;
    }
  }
  if (name === 'WebSearch' && Number.isSafeInteger(result.numHits) && (result.numHits as number) > 0) {
    const provider = typeof result.providerName === 'string' ? result.providerName.toLowerCase() : '';
    if (provider === 'firecrawl') firecrawl += result.numHits as number;
    if (/^grok(?:$|[-_.])/.test(provider)) grok += result.numHits as number;
  }
  let market = current.market;
  if (MARKET_TOOLS.has(name)) {
    const quote = name === 'finance_quote' || name === 'MarketQuote';
    const source = name === 'finance_quote' ? result.source : metadata?.provider;
    const validQuote = source !== 'none' && typeof source === 'string'
      && (name === 'finance_quote' ? typeof result.price === 'number' : typeof metadata?.price === 'number');
    const validFlow = name === 'finance_kr_flow' ? typeof result.report === 'string' && result.report.length > 0
      : typeof result.output === 'string' && result.output.length > 0 && metadata?.exitCode === 0;
    if (quote ? validQuote : validFlow) market += 1;
  }
  return { firecrawl, grok, market };
}

export function hasSourceUsage(usage: SourceUsage): boolean {
  return usage.firecrawl + usage.grok + usage.market > 0;
}
