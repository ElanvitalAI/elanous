import type { LLMToolSpec } from '../../llm/tool-spec.js';
// Native tool: market_quote (MarketQuote)
//
// 단일 심볼 시세 조회. ★ C-②b(2026-07-22) — 종전 자체 EODHD/FDS HTTP 재구현("skill-essence
// extraction")을 버리고 domains `marketQuote()` 단일 SSOT 에 위임한다. 그 결과 이 tool 도 세션/NXT/
// 토스/휴일 라벨·최적소스 자동선택(bun 빠른 omni)을 얻고, finance_quote 와 **같은 심볼 같은 값·세션
// 라벨**을 낸다(시세 드리프트 종식). skill 표면(tool 이름 MarketQuote·skill runner 노출)은 유지.
// raw 데이터는 marketQuote 가 omni-market skill/토스로 라우팅(skill=엔진 SSOT 정합).
//
// Symbols: pass-through. marketQuote 의 classify 가 "AAPL.US"/"005930.KS"/".INDX"/".FOREX" 를 판별.



export interface MarketQuoteArgs {
  symbol: string;
  fields?: Array<'price' | 'change' | 'volume' | 'all'>;
}

export interface MarketQuoteResult {
  output: string;
  metadata: {
    symbol: string;
    // C-②b — marketQuote() 위임 후 실제 출처(toss/yahoo 포함). 종전 eodhd/fds 만에서 확장.
    provider: 'eodhd' | 'fds' | 'toss' | 'yahoo' | 'none';
    price?: number;
    change?: number;
    changePct?: number;
    volume?: number;
    asOf?: string;
  };
  isError?: true;
}

export function buildMarketQuoteTool(): LLMToolSpec {
  return {
    name: 'MarketQuote',
    description:
      'Fetch a single price quote for a symbol. EODHD preferred, FinancialDatasets.ai fallback. ' +
      'Symbol format depends on provider: EODHD uses suffixed form ("AAPL.US", "005930.KS"); ' +
      'FDS uses bare ticker ("AAPL"). For multi-symbol / historical / fundamentals, use the ' +
      'full omni-market skill.',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Symbol per provider format (EODHD: AAPL.US / 005930.KS; FDS: AAPL).' },
        fields: {
          type: 'array',
          items: { type: 'string', enum: ['price', 'change', 'volume', 'all'] },
          description: 'Subset to return. Default ["all"].',
        },
      },
      required: ['symbol'],
      additionalProperties: false,
    },
  };
}

export async function dispatchMarketQuote(rawArgs: Record<string, unknown>): Promise<MarketQuoteResult> {
  const args = validate(rawArgs);
  const fields = args.fields && args.fields.length > 0 ? new Set(args.fields) : new Set(['all']);
  const wantPrice = fields.has('all') || fields.has('price');
  const wantChange = fields.has('all') || fields.has('change');
  const wantVolume = fields.has('all') || fields.has('volume');

  // ★ C-②b(2026-07-22) — 자체 EODHD/FDS HTTP 재구현을 버리고 domains marketQuote() 단일 SSOT 위임.
  //   세션/NXT/토스/휴일 라벨·최적소스 자동선택(bun 빠른 omni)을 그대로 얻고 시세 드리프트 종식
  //   (finance_quote 와 동일 진실원·같은 심볼 같은 값/세션 라벨). skill 표면(tool 이름 MarketQuote)은
  //   유지. omni-market skill 이 raw 데이터 SSOT(marketQuote 가 경유)라 계약 정합. 종전 fetchEodhd/
  //   fetchFds 는 이 위임으로 대체(재구현 제거).
  const { marketQuote, formatMarketQuote } = await import('../../domains/market-quote.js');
  const q = marketQuote(args.symbol.trim());
  if (q.price == null) {
    return {
      output: `market_quote: '${args.symbol}' 조회 실패${q.note ? ` (${q.note})` : ''}`,
      metadata: { symbol: q.symbol, provider: q.source },
      isError: true,
    };
  }
  const change = q.prevClose != null ? Number((q.price - q.prevClose).toFixed(4)) : undefined;
  return {
    output: formatMarketQuote(q),
    metadata: {
      symbol: q.symbol,
      provider: q.source,
      ...(wantPrice ? { price: q.price } : {}),
      ...(wantChange && change !== undefined ? { change } : {}),
      ...(wantChange && q.changePct != null ? { changePct: q.changePct } : {}),
      ...(wantVolume && q.volume != null ? { volume: q.volume } : {}),
    },
  };
}

/** Probe-compatible. */
export function marketQuoteAvailable(): boolean {
  return !!(process.env.EODHD_API_KEY || process.env.FDS_API_KEY);
}

function validate(raw: Record<string, unknown>): MarketQuoteArgs {
  const symbol = raw.symbol;
  if (typeof symbol !== 'string' || symbol.trim().length === 0) {
    throw new Error(`'symbol' is required`);
  }
  const fields = raw.fields;
  const validFields = new Set(['price', 'change', 'volume', 'all']);
  if (fields !== undefined) {
    if (!Array.isArray(fields) || !fields.every(f => typeof f === 'string' && validFields.has(f))) {
      throw new Error(`'fields' must be an array of price|change|volume|all`);
    }
  }
  return { symbol, fields: fields as MarketQuoteArgs['fields'] };
}
