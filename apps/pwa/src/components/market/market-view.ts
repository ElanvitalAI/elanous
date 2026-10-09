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

export interface WizardForm {
  name: string;
  description: string;
  instructions: string;
  connectorId: string;
  credentialNames: string;
  requires?: string[];
  skillDescription?: string;
  otherConnectors?: Array<{ id: string; credentials?: Array<{ name: string }> }>;
}

export interface WizardMessage { role: 'user' | 'assistant'; text: string }

export function wizardFormFromRequest(request: string, previous: WizardForm): WizardForm {
  const description = request.trim();
  if (!description) throw new Error('플러그인 설명을 입력하세요.');
  return previous.description
    ? { ...previous, instructions: `${previous.instructions || previous.description}\n${description}` }
    : { ...previous, description, instructions: previous.instructions || description };
}

export function wizardDraftFromForm(form: WizardForm) {
  const name = form.name.trim();
  if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(name)) throw new Error('플러그인 이름은 영문 소문자·숫자·하이픈 2~32자로 입력하세요.');
  if (!form.description.trim()) throw new Error('플러그인 설명을 입력하세요.');
  const connectorId = form.connectorId.trim();
  const names = form.credentialNames.split(',').map(item => item.trim()).filter(Boolean);
  if (connectorId && !/^[a-z0-9][a-z0-9-]{1,31}$/.test(connectorId)) throw new Error('연결 이름이 올바르지 않습니다.');
  if (!connectorId && names.length) throw new Error('연결 이름을 먼저 입력하세요.');
  if (names.some(item => !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(item)) || new Set(names).size !== names.length) {
    throw new Error('자격 정보에는 중복 없는 항목 이름만 입력하세요.');
  }
  const connectors = form.otherConnectors ?? [];
  if (connectorId && connectors.some(connector => connector.id === connectorId)) throw new Error('연결 이름이 중복됩니다.');
  return { name, draft: { description: form.description.trim(),
    ...(connectorId || connectors.length ? { connectors: [
      ...(connectorId ? [{ id: connectorId, credentials: names.map(name => ({ name })) }] : []), ...connectors,
    ] } : {}),
    skill: { description: form.skillDescription ?? form.description.trim(), instructions: form.instructions.trim() || form.description.trim(),
      ...(form.requires ? { requires: form.requires } : {}) } } };
}

export function wizardFormFromPlugin(plugin: { name: string; draft: { description: string; connectors?: Array<{ id: string; credentials?: Array<{ name: string }> }>;
  skill?: { description: string; instructions: string; requires?: string[] } } }): WizardForm {
  return { name: plugin.name, description: plugin.draft.description, instructions: plugin.draft.skill?.instructions ?? '',
    connectorId: plugin.draft.connectors?.[0]?.id ?? '', credentialNames: plugin.draft.connectors?.[0]?.credentials?.map(item => item.name).join(', ') ?? '',
    ...(plugin.draft.skill?.requires?.length ? { requires: plugin.draft.skill.requires } : {}),
    ...(plugin.draft.skill?.description && plugin.draft.skill.description !== plugin.draft.description ? { skillDescription: plugin.draft.skill.description } : {}),
    ...(plugin.draft.connectors && plugin.draft.connectors.length > 1 ? { otherConnectors: plugin.draft.connectors.slice(1) } : {}) };
}

export function marketCards(response: MarketIndexResponse): MarketCard[] {
  return response.markets.flatMap(market => market.plugins.map(plugin => ({
    market, plugin, price: formatMarketPrice(plugin.pricing), badge: marketSignatureBadge(market.signature),
  }))).sort((a, b) => (a.market.signature === 'ok' ? 0 : 1) - (b.market.signature === 'ok' ? 0 : 1) ||
    a.plugin.name.localeCompare(b.plugin.name) || a.market.name.localeCompare(b.market.name));
}
