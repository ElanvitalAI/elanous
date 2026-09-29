import { expect, test } from 'bun:test';
import type { MarketIndexResponse } from '../../nexus/client';
import { formatMarketPrice, marketCards, marketSignatureBadge } from './market-view';

const plugin = (name: string) => ({ name, version: '1.0.0', capabilities: [], connectors: [], pricing: { model: 'free' as const }, sha256: 'a'.repeat(64) });

test('서명 ok 카드 먼저, 각 그룹 이름순; 무료 및 서명 배지는 데몬 결과를 따른다', () => {
  const index: MarketIndexResponse = { markets: [
    { name: 'unsigned', signature: 'missing', plugins: [plugin('alpha')] },
    { name: 'verified', signature: 'ok', plugins: [plugin('zeta'), plugin('beta')] },
  ] };
  const cards = marketCards(index);
  expect(cards.map(card => card.plugin.name)).toEqual(['beta', 'zeta', 'alpha']);
  expect(cards[0]?.price).toBe('무료');
  expect(cards.map(card => card.badge)).toEqual(['✅ 서명 확인', '✅ 서명 확인', '⚠️ 서명 없음']);
  expect(index.markets[0]?.plugins[0]?.name).toBe('alpha');
});

test('유료 가격 및 실패 배지는 실패 종류를 숨기지 않는다', () => {
  expect(formatMarketPrice({ model: 'subscription', amount: 5, currency: 'USD', period: 'month' })).toBe('5 USD / month');
  expect(marketSignatureBadge('unknown-key')).toContain('알 수 없는');
  expect(marketSignatureBadge('malformed')).toContain('잘못된');
  expect(marketSignatureBadge('stale')).toContain('유효하지 않은');
});
