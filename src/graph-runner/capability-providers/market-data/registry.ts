import type { GraphCapabilityContract, GraphCapabilityRegistry } from '../../capabilities.js';
import { emptyGraphCapabilityRegistry, registerGraphCapabilityContract, registerGraphCapabilityProviderDeclaration } from '../../capabilities.js';
import type { GraphCapabilityProviderDeclaration } from '../../capabilities.js';
import { createFreeMarketDeclarations } from './free-declarations.js';
import { createFinnhubDeclarations } from './finnhub.js';
import { createKisDeclarations } from './kis.js';
import { createEodhdDeclarations } from './eodhd.js';
import { createTossDeclarations } from './toss.js';
import { createTwelveDataDeclarations, createFdsDeclarations, createYahooDeclarations } from './omni-sources.js';
import { createPykrxDeclarations } from './kr-daily-sources.js';
import { createKrxDeclarations } from './krx.js';

const pointInput = { type: 'object', required: ['market', 'symbol'], properties: {
  market: { type: 'string', enum: ['US', 'KR', 'GLOBAL'] }, symbol: { type: 'string' }, quote: { type: 'string' },
} } as const;
const pointOutput = { type: 'object', required: ['source', 'capability', 'symbol', 'value', 'asOf', 'latency'], properties: {
  source: { type: 'string' }, capability: { type: 'string' }, symbol: { type: 'string' },
  value: { type: 'number' }, asOf: { type: 'string' }, latency: { type: 'string' },
} } as const;

export const marketDataContracts = [
  { id: 'market.quote@1', input: { type: 'object', required: ['market', 'symbol'], properties: {
    market: { type: 'string', enum: ['US', 'KR'] }, symbol: { type: 'string' },
  } }, output: { type: 'object', required: ['source', 'market', 'symbol', 'price', 'currency', 'asOf'], properties: {
    source: { type: 'string' }, market: { type: 'string' }, symbol: { type: 'string' },
    price: { type: 'number' }, currency: { type: 'string' }, asOf: { type: 'string' },
  } }, guarantees: { sourceAttribution: true } },
  { id: 'market.ohlcv@1', input: { type: 'object', required: ['market', 'symbol', 'from', 'to'], properties: {
    market: { type: 'string', enum: ['US', 'KR'] }, symbol: { type: 'string' },
    from: { type: 'string' }, to: { type: 'string' },
  } }, output: { type: 'object', required: ['source', 'market', 'symbol', 'bars'], properties: {
    source: { type: 'string' }, market: { type: 'string' }, symbol: { type: 'string' },
    bars: { type: 'array', items: { type: 'object', required: ['date', 'open', 'high', 'low', 'close', 'volume'] } },
  } }, guarantees: { sourceAttribution: true } },
  { id: 'market.kr-flow@1', input: { type: 'object', required: ['market', 'symbol'], properties: {
    market: { type: 'string', enum: ['KR'] }, symbol: { type: 'string' },
  } }, output: { type: 'object', required: ['source', 'market', 'symbol', 'asOf', 'foreignNetVolume', 'institutionNetVolume'], properties: {
    source: { type: 'string' }, market: { type: 'string' }, symbol: { type: 'string' },
    asOf: { type: 'string' }, foreignNetVolume: { type: 'number' }, institutionNetVolume: { type: 'number' },
  } }, guarantees: { sourceAttribution: true } },
  ...(['kr.flow.foreign@1', 'kr.flow.investor@1', 'kr.flow.investor-time@1', 'kr.flow.estimate@1',
    'kr.flow.market@1', 'kr.flow.investor-detail@1', 'kr.flow.intraday@1', 'kr.short-sale@1'] as const).map((id) => ({ id,
    input: { type: 'object', required: ['market'], properties: { market: { type: 'string', enum: ['KR'] }, symbol: { type: 'string' } } },
    output: { type: 'object', required: ['source'] }, guarantees: { sourceAttribution: true } })),
  { id: 'market.intraday@1', input: { type: 'object', required: ['market', 'symbol', 'from', 'to'], properties: {
    market: { type: 'string', enum: ['US'] }, symbol: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' },
  } }, output: { type: 'object', required: ['source', 'market', 'symbol', 'bars'] }, guarantees: { sourceAttribution: true } },
  { id: 'market.fundamentals@1', input: { type: 'object', required: ['market', 'symbol'], properties: {
    market: { type: 'string', enum: ['US'] }, symbol: { type: 'string' },
  } }, output: { type: 'object', required: ['source', 'market', 'symbol', 'facts'] }, guarantees: { sourceAttribution: true } },
  { id: 'market.index@1', input: { type: 'object', required: ['market'], properties: {
    market: { type: 'string' }, symbol: { type: 'string' }, command: { type: 'string' }, date: { type: 'string' },
  } }, output: { type: 'object', required: ['source'] }, guarantees: { sourceAttribution: true } },
  ...(['kr.market.daily@1', 'kr.etp.daily@1', 'market.instrument@1',
    'kr.derivatives.options@1', 'kr.bond.daily@1'] as const).map((id) => ({ id,
    input: { type: 'object', required: ['market', 'command', 'date'], properties: {
      market: { type: 'string', enum: ['KR'] }, command: { type: 'string' }, date: { type: 'string' },
    } }, output: { type: 'object', required: ['source', 'market', 'command', 'date', 'rows'] },
    guarantees: { sourceAttribution: true } })),
  { id: 'kr.derivatives.futures@1', input: { type: 'object', required: ['market'], properties: {
    market: { type: 'string' }, symbol: { type: 'string' }, command: { type: 'string' }, date: { type: 'string' },
  } }, output: { type: 'object', required: ['source'] }, guarantees: { sourceAttribution: true } },
  { id: 'market.rates@1', input: pointInput, output: pointOutput, guarantees: { sourceAttribution: true } },
  { id: 'market.macro@1', input: pointInput, output: pointOutput, guarantees: { sourceAttribution: true } },
  { id: 'market.fx@1', input: pointInput, output: pointOutput, guarantees: { sourceAttribution: true } },
  { id: 'market.crypto@1', input: pointInput, output: pointOutput, guarantees: { sourceAttribution: true } },
] as const satisfies readonly GraphCapabilityContract[];

/** The graph runner owns provider selection; this only supplies declarations. */
export function marketDataRegistry(providers: readonly GraphCapabilityProviderDeclaration[]): GraphCapabilityRegistry {
  let registry = emptyGraphCapabilityRegistry();
  for (const contract of marketDataContracts) registry = registerGraphCapabilityContract(registry, contract);
  for (const provider of providers) registry = registerGraphCapabilityProviderDeclaration(registry, provider);
  return registry;
}

/** Default graph registration; constructing this object does not make a network request. */
export function createDefaultMarketDataRegistry(): GraphCapabilityRegistry {
  return marketDataRegistry([
    ...createFreeMarketDeclarations(), ...createTossDeclarations(), ...createFinnhubDeclarations(),
    ...createKisDeclarations(), ...createEodhdDeclarations(),
    ...createTwelveDataDeclarations(), ...createFdsDeclarations(), ...createYahooDeclarations(),
    ...createKrxDeclarations(), ...createPykrxDeclarations(),
  ]);
}
