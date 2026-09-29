import type { MarketIndexResponse, MarketPluginWire } from '../../nexus/client';

type Market = MarketIndexResponse['markets'][number];
export interface MarketCard {
  market: Market;
  plugin: MarketPluginWire;
  price: string;
  badge: string;
}

export function formatMarketPrice(pricing: MarketPluginWire['pricing']): string {
  if (pricing.model === 'free') return '무료';
  const amount = pricing.amount === undefined ? '가격 미정' : `${pricing.amount.toLocaleString('ko-KR')} ${pricing.currency ?? ''}`.trim();
  return pricing.model === 'subscription' && pricing.period ? `${amount} / ${pricing.period}` : amount;
}

export function marketSignatureBadge(signature: Market['signature']): string {
  switch (signature) {
    case 'ok': return '✅ 서명 확인';
    case 'missing': return '⚠️ 서명 없음';
    case 'unknown-key': return '⚠️ 알 수 없는 서명 키';
    case 'malformed': return '⚠️ 잘못된 서명';
    case 'stale': return '⚠️ 유효하지 않은 서명';
  }
}

export function marketCards(response: MarketIndexResponse): MarketCard[] {
  return response.markets.flatMap(market => market.plugins.map(plugin => ({
    market, plugin, price: formatMarketPrice(plugin.pricing), badge: marketSignatureBadge(market.signature),
  }))).sort((a, b) => (a.market.signature === 'ok' ? 0 : 1) - (b.market.signature === 'ok' ? 0 : 1) ||
    a.plugin.name.localeCompare(b.plugin.name) || a.market.name.localeCompare(b.market.name));
}
