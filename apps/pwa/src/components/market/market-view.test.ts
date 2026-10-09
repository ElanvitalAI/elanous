import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { createNexusClient } from '../../nexus/client';
import { NexusProvider } from '../../nexus/hooks/use-nexus-context';
import { MarketPanel } from './MarketPanel';
import type { MarketIndexResponse } from '../../nexus/client';
import { formatMarketPrice, marketCards, marketSignatureBadge, wizardDraftFromForm, wizardFormFromPlugin, wizardFormFromRequest, type WizardForm } from './market-view';

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

test('대화로 초안을 만들고 폼으로 다듬어 안전한 생성 입력을 만든다', () => {
  const empty: WizardForm = { name: 'weather-report', description: '', instructions: '', connectorId: '', credentialNames: '' };
  const form = wizardFormFromRequest('  날씨를 조사해 줘  ', empty);
  const edited = { ...form, instructions: '내일의 기온을 요약', connectorId: 'weather', credentialNames: 'WEATHER_API_KEY' };
  const generated = wizardDraftFromForm(edited);
  expect(generated).toEqual({ name: 'weather-report', draft: {
    description: '날씨를 조사해 줘', connectors: [{ id: 'weather', credentials: [{ name: 'WEATHER_API_KEY' }] }],
    skill: { description: '날씨를 조사해 줘', instructions: '내일의 기온을 요약' },
  } });
  expect(wizardFormFromPlugin({ name: generated.name, draft: generated.draft })).toEqual(edited);
  expect(() => wizardDraftFromForm({ ...edited, credentialNames: 'KEY=secret' })).toThrow('항목 이름만');
  expect(() => wizardFormFromRequest('   ', edited)).toThrow('설명');
  expect(wizardFormFromRequest('내일 기온도 넣어 줘', form)).toMatchObject({
    description: '날씨를 조사해 줘', instructions: '날씨를 조사해 줘\n내일 기온도 넣어 줘',
  });
  const existing = { name: 'weather-report', draft: { description: '기존 설명',
    connectors: [{ id: 'first', credentials: [{ name: 'ONE' }] }, { id: 'second', credentials: [{ name: 'TWO' }] }],
    skill: { description: '기존 스킬 설명', instructions: '기존 지시문', requires: ['openai'] },
  } };
  expect(wizardDraftFromForm(wizardFormFromPlugin(existing))).toEqual(existing);
});

test('MarketPanel wizard tab reaches server create, list and regeneration without changing installed plugins', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  let saved: { name: string; description: string; draft: { description: string; skill: { description: string; instructions: string } } } | null = null;
  const client = createNexusClient({ baseUrl: 'https://test.example', fetchImpl: (async (input, init) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as { name: string; draft: typeof saved; regenerate?: boolean } : undefined;
    requests.push({ method, path, ...(body ? { body } : {}) });
    if (path === '/v1/plugins/index') return Response.json({ markets: [] });
    if (path === '/v1/plugins') return Response.json([]);
    if (path === '/v1/plugins/wizard' && method === 'GET') return Response.json({ plugins: saved ? [saved] : [] });
    if (path === '/v1/plugins/wizard' && method === 'POST' && body) {
      saved = { name: body.name, description: (body.draft as { description: string }).description, draft: body.draft as typeof saved & { description: string; skill: { description: string; instructions: string } } };
      return Response.json({ name: body.name, saved: true });
    }
    throw new Error(`unexpected request ${method} ${path}`);
  }) as typeof fetch });
  let view!: ReturnType<typeof create>;
  await act(async () => { view = create(createElement(NexusProvider, { client, children: createElement(MarketPanel) })); });
  const buttons = () => view.root.findAllByType('button');
  const button = (label: string) => buttons().find(item => item.children.includes(label))!;
  await act(async () => { button('플러그인 만들기').props.onClick(); });
  const input = (label: string) => view.root.findAllByType('label').find(item => item.children.includes(label))!.findByType('input');
  await act(async () => {
    input('이름 (영문 소문자·숫자·하이픈)').props.onChange({ target: { value: 'weather-research' } });
    view.root.findAllByType('textarea')[0]!.props.onChange({ target: { value: '날씨 요약' } });
  });
  await act(async () => { button('대화에 추가').props.onClick(); });
  await act(async () => { await button('초안 만들기').props.onClick(); });
  expect(requests.filter(call => call.path === '/v1/plugins/wizard').map(call => call.method)).toEqual(['GET', 'POST', 'GET']);
  expect(requests.find(call => call.method === 'POST')?.body).toMatchObject({ name: 'weather-research', draft: { description: '날씨 요약' } });
  expect(buttons().some(item => item.children.includes('다듬고 다시 만들기'))).toBe(true);
  await act(async () => { button('다듬고 다시 만들기').props.onClick(); });
  await act(async () => { input('설명').props.onChange({ target: { value: '내일 날씨 요약' } }); });
  await act(async () => { await button('다시 만들기').props.onClick(); });
  expect(requests.filter(call => call.method === 'POST').at(-1)?.body).toMatchObject({ regenerate: true, draft: { description: '내일 날씨 요약' } });
  expect(view.root.findAllByType('span').some(item => item.children.join('').includes('내일 날씨 요약'))).toBe(true);
  expect(requests.some(call => call.path === '/v1/plugins/install' || call.method === 'DELETE')).toBe(false);
  await act(async () => { view.unmount(); });
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

test('유료 가격 및 실패 배지는 실패 종류를 숨기지 않는다', () => {
  expect(formatMarketPrice({ model: 'subscription', amount: 5, currency: 'USD', period: 'month' })).toBe('5 USD / month');
  expect(marketSignatureBadge('unknown-key')).toContain('알 수 없는');
  expect(marketSignatureBadge('malformed')).toContain('잘못된');
  expect(marketSignatureBadge('stale')).toContain('유효하지 않은');
});
