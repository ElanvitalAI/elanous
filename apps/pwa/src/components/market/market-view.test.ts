import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { createNexusClient } from '../../nexus/client';
import { NexusProvider } from '../../nexus/hooks/use-nexus-context';
import { DaemonContext } from '../providers/DaemonProvider';
import { DaemonClient } from '../../lib/daemon-client';
import { MarketPanel } from './MarketPanel';
import type { MarketIndexResponse } from '../../nexus/client';
import { formatMarketPrice, marketCards, marketSignatureBadge, wizardDraftFromForm, wizardConversationFromResponse, wizardFormFromPlugin, wizardFormFromRequest, type WizardForm } from './market-view';

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

test('LLM conversation updates only description and instructions; invalid output cannot overwrite the form', () => {
  const form: WizardForm = { name: 'weather-research', description: 'old', instructions: 'old instructions', connectorId: 'weather', credentialNames: 'API_KEY' };
  expect(wizardConversationFromResponse('```json\n{"name":"evil","description":"new","instructions":"new steps","reply":"What next?","credentialNames":"KEY=secret"}\n```', form))
    .toEqual({ form: { ...form, description: 'new', instructions: 'new steps' }, reply: 'What next?' });
  expect(() => wizardConversationFromResponse('No JSON', form)).toThrow('폼이 없습니다');
  expect(() => wizardConversationFromResponse('ignore me {"description":"bad","instructions":"bad"}', form)).toThrow('폼이 없습니다');
  expect(() => wizardConversationFromResponse('{"description":"new"}', form)).toThrow('설명과 지시문');
  expect(() => wizardConversationFromResponse('{"description":"new","instructions":"steps"}', form)).toThrow('답변');
  expect(form.description).toBe('old');
});

test('MarketPanel sends wizard conversation through daemon LLM and keeps user-edited identity', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const promptBodies: unknown[] = [];
  const config = { baseUrl: 'https://test.example/nexus/', token: 'owner-token', provider: '' };
  const wizardPosts: unknown[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    expect(new URL(String(input)).pathname).toBe('/nexus/v1/prompt');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer owner-token');
    promptBodies.push(JSON.parse(String(init?.body)));
    return Response.json({ sessionId: 'wizard', text: promptBodies.length === 1
      ? '{"description":"LLM summary","instructions":"LLM steps","reply":"Which fields should I refine next?"}'
      : '{"description":"LLM refined","instructions":"LLM steps two","reply":"Ready to save."}', stopReason: 'end_turn' });
  }) as typeof fetch;
  const nexus = createNexusClient({ baseUrl: config.baseUrl, fetchImpl: (async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === '/nexus/v1/plugins/index') return Response.json({ markets: [] });
    if (path === '/nexus/v1/plugins') return Response.json([]);
    if (path === '/nexus/v1/plugins/wizard' && init?.method === 'POST') {
      wizardPosts.push(JSON.parse(String(init.body)));
      return Response.json({ name: 'kept-name', saved: true });
    }
    if (path === '/nexus/v1/plugins/wizard') return Response.json({ plugins: [] });
    throw new Error(`unexpected ${path}`);
  }) as typeof fetch });
  let view!: ReturnType<typeof create>;
  try {
    await act(async () => { view = create(createElement(DaemonContext.Provider, { value: { client: new DaemonClient(config), config, sessionId: '', setConfig: () => {}, setSessionId: () => {} }, children: createElement(NexusProvider, { client: nexus, children: createElement(MarketPanel) }) })); });
    const button = (text: string) => view.root.findAllByType('button').find(item => item.children.includes(text))!;
    await act(async () => { await button('플러그인 만들기').props.onClick(); });
    await act(async () => {
      view.root.findAllByType('label').find(item => item.children.includes('이름 (영문 소문자·숫자·하이픈)'))!.findByType('input').props.onChange({ target: { value: 'kept-name' } });
      view.root.findAllByType('textarea')[0]!.props.onChange({ target: { value: '사용자 요청' } });
    });
    await act(async () => { await button('대화에 추가').props.onClick(); });
    expect(promptBodies).toHaveLength(1);
    expect(promptBodies[0]).toMatchObject({ tools: 'none', userText: expect.stringContaining('사용자 요청') });
    expect(view.root.findAllByType('label').find(item => item.children.includes('설명'))!.findByType('input').props.value).toBe('LLM summary');
    expect(view.root.findByProps({ 'aria-label': '마법사 대화' }).findAllByType('li').at(-1)!.children.join('')).toContain('Which fields should I refine next?');
    expect(view.root.findAllByType('label').find(item => item.children.includes('이름 (영문 소문자·숫자·하이픈)'))!.findByType('input').props.value).toBe('kept-name');
    await act(async () => { view.root.findAllByType('textarea')[0]!.props.onChange({ target: { value: '다듬어 줘' } }); });
    await act(async () => { await button('대화에 추가').props.onClick(); });
    expect(promptBodies).toHaveLength(2);
    const secondPrompt = promptBodies[1] as { tools: string; userText: string };
    expect(secondPrompt.tools).toBe('none');
    expect(secondPrompt.userText).toContain('사용자: 사용자 요청');
    expect(secondPrompt.userText).toContain('마법사: Which fields should I refine next?');
    expect(view.root.findByProps({ 'aria-label': '마법사 대화' }).findAllByType('li').at(-1)!.children.join('')).toContain('Ready to save.');
    await act(async () => { await button('초안 만들기').props.onClick(); });
    expect(wizardPosts).toEqual([{ name: 'kept-name', draft: { description: 'LLM refined', skill: { description: 'LLM refined', instructions: 'LLM steps two' } } }]);
    await act(async () => { view.unmount(); });
  } finally {
    globalThis.fetch = originalFetch;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  }
});

test('a delayed wizard reply cannot switch the draft or contaminate another regeneration', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const config = { baseUrl: 'https://test.example', token: 'owner-token', provider: '' };
  const originalFetch = globalThis.fetch;
  let resolvePrompt!: (response: Response) => void;
  const prompt = new Promise<Response>(resolve => { resolvePrompt = resolve; });
  const posts: Array<{ name: string; regenerate?: boolean; draft: { description: string; skill: { instructions: string } } }> = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => prompt) as typeof fetch;
  const drafts = [
    { name: 'draft-a', description: 'A description', draft: { description: 'A description', skill: { description: 'A description', instructions: 'A instructions' } } },
    { name: 'draft-b', description: 'B description', draft: { description: 'B description', skill: { description: 'B description', instructions: 'B instructions' } } },
  ];
  const nexus = createNexusClient({ baseUrl: config.baseUrl, fetchImpl: (async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === '/v1/plugins/index') return Response.json({ markets: [] });
    if (path === '/v1/plugins') return Response.json([]);
    if (path === '/v1/plugins/wizard' && init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)));
      return Response.json({ name: 'draft-b', saved: true });
    }
    if (path === '/v1/plugins/wizard') return Response.json({ plugins: drafts });
    throw new Error(`unexpected ${path}`);
  }) as typeof fetch });
  let view: ReturnType<typeof create> | undefined;
  try {
    await act(async () => { view = create(createElement(DaemonContext.Provider, { value: { client: new DaemonClient(config), config, sessionId: '', setConfig: () => {}, setSessionId: () => {} }, children: createElement(NexusProvider, { client: nexus, children: createElement(MarketPanel) }) })); });
    const root = view!.root;
    const button = (text: string) => root.findAllByType('button').find(item => item.children.includes(text))!;
    const draftButton = (name: string) => root.findByProps({ 'aria-label': '만든 플러그인' }).findAllByType('li')
      .find(item => item.findByType('span').children.join('').includes(name))!.findByType('button');
    const input = (label: string) => root.findAllByType('label').find(item => item.children.includes(label))!.findByType('input');
    await act(async () => { await button('플러그인 만들기').props.onClick(); });
    await act(async () => { draftButton('draft-a').props.onClick(); root.findAllByType('textarea')[0]!.props.onChange({ target: { value: 'refine A' } }); });
    await act(async () => { button('대화에 추가').props.onClick(); });
    expect(draftButton('draft-b').props.disabled).toBe(true);
    await act(async () => { draftButton('draft-b').props.onClick(); });
    expect(input('이름 (영문 소문자·숫자·하이픈)').props.value).toBe('draft-a');
    const request = () => root.findAllByType('textarea')[0]!;
    const instructions = () => root.findAllByType('textarea')[1]!;
    expect(request().props.disabled).toBe(true);
    expect(input('설명').props.disabled).toBe(true);
    expect(instructions().props.disabled).toBe(true);
    expect(input('이름 (영문 소문자·숫자·하이픈)').props.disabled).toBe(true);
    expect(input('연결 이름 (선택)').props.disabled).toBe(true);
    expect(input('자격 정보 항목 이름 (쉼표 구분, 값은 입력하지 마세요)').props.disabled).toBe(true);
    await act(async () => {
      request().props.onChange({ target: { value: 'later request' } });
      input('설명').props.onChange({ target: { value: 'later description' } });
      instructions().props.onChange({ target: { value: 'later instructions' } });
      input('이름 (영문 소문자·숫자·하이픈)').props.onChange({ target: { value: 'other-draft' } });
      input('연결 이름 (선택)').props.onChange({ target: { value: 'other-connector' } });
      input('자격 정보 항목 이름 (쉼표 구분, 값은 입력하지 마세요)').props.onChange({ target: { value: 'OTHER_KEY' } });
    });
    expect(request().props.value).toBe('refine A');
    expect(input('설명').props.value).toBe('A description');
    expect(instructions().props.value).toBe('A instructions');
    expect(input('이름 (영문 소문자·숫자·하이픈)').props.value).toBe('draft-a');
    expect(input('연결 이름 (선택)').props.value).toBe('');
    expect(input('자격 정보 항목 이름 (쉼표 구분, 값은 입력하지 마세요)').props.value).toBe('');
    await act(async () => { resolvePrompt(Response.json({ text: '{"description":"A from LLM","instructions":"A from LLM","reply":"A ready"}' })); });
    expect(request().props.value).toBe('');
    expect(input('설명').props.value).toBe('A from LLM');
    expect(instructions().props.value).toBe('A from LLM');
    expect(request().props.disabled).toBe(false);
    expect(input('설명').props.disabled).toBe(false);
    expect(instructions().props.disabled).toBe(false);
    expect(draftButton('draft-b').props.disabled).toBe(false);
    await act(async () => { draftButton('draft-b').props.onClick(); });
    expect(input('설명').props.value).toBe('B description');
    expect(root.findAllByType('textarea')[1]!.props.value).toBe('B instructions');
    await act(async () => { await button('다시 만들기').props.onClick(); });
    expect(posts).toHaveLength(1);
    expect(posts[0]?.name).toBe('draft-b');
    expect(posts[0]?.regenerate).toBe(true);
    expect(posts[0]?.draft.description).toBe('B description');
    expect(posts[0]?.draft.skill.instructions).toBe('B instructions');
  } finally {
    if (view) await act(async () => { view!.unmount(); });
    globalThis.fetch = originalFetch;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  }
});

test('MarketPanel uses the daemon LLM without a token when the daemon accepts same-origin requests', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const config = { baseUrl: 'https://test.example', token: '', provider: '' };
  const originalFetch = globalThis.fetch;
  const requests: Array<{ path: string; authorization?: string }> = [];
  globalThis.fetch = (async (input, init) => {
    const headers = init?.headers as Record<string, string>;
    requests.push({ path: new URL(String(input)).pathname, ...(headers.authorization ? { authorization: headers.authorization } : {}) });
    return Response.json({ text: '{"description":"Same-origin result","instructions":"Review it","reply":"What else?"}' });
  }) as typeof fetch;
  const nexus = createNexusClient({ baseUrl: config.baseUrl, fetchImpl: (async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === '/v1/plugins/index') return Response.json({ markets: [] });
    if (path === '/v1/plugins') return Response.json([]);
    if (path === '/v1/plugins/wizard') return Response.json({ plugins: [] });
    throw new Error(`unexpected ${path}`);
  }) as typeof fetch });
  let view: ReturnType<typeof create> | undefined;
  try {
    await act(async () => { view = create(createElement(DaemonContext.Provider, { value: { client: new DaemonClient(config), config, sessionId: '', setConfig: () => {}, setSessionId: () => {} }, children: createElement(NexusProvider, { client: nexus, children: createElement(MarketPanel) }) })); });
    const root = view!.root;
    const button = (text: string) => root.findAllByType('button').find(item => item.children.includes(text))!;
    await act(async () => { await button('플러그인 만들기').props.onClick(); });
    await act(async () => { root.findAllByType('textarea')[0]!.props.onChange({ target: { value: '같은 출처 요청' } }); });
    await act(async () => { await button('대화에 추가').props.onClick(); });
    expect(requests).toEqual([{ path: '/v1/prompt' }]);
    expect(root.findAllByType('label').find(item => item.children.includes('설명'))!.findByType('input').props.value).toBe('Same-origin result');
  } finally {
    const mounted = view;
    if (mounted) await act(async () => { mounted.unmount(); });
    globalThis.fetch = originalFetch;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  }
});

test('MarketPanel keeps the form and the request when the LLM response is invalid', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const config = { baseUrl: 'https://test.example', token: 'owner-token', provider: '' };
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => {
    attempts += 1;
    return attempts === 1 ? Response.json({ text: 'invalid response' }) : Response.json({ error: 'unauthorized' }, { status: 401 });
  }) as typeof fetch;
  const nexus = createNexusClient({ baseUrl: config.baseUrl, fetchImpl: (async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === '/v1/plugins/index') return Response.json({ markets: [] });
    if (path === '/v1/plugins') return Response.json([]);
    if (path === '/v1/plugins/wizard') return Response.json({ plugins: [] });
    throw new Error(`unexpected ${path}`);
  }) as typeof fetch });
  let view: ReturnType<typeof create> | undefined;
  try {
    await act(async () => { view = create(createElement(DaemonContext.Provider, { value: { client: new DaemonClient(config), config, sessionId: '', setConfig: () => {}, setSessionId: () => {} }, children: createElement(NexusProvider, { client: nexus, children: createElement(MarketPanel) }) })); });
    const root = view!.root;
    const button = (text: string) => root.findAllByType('button').find(item => item.children.includes(text))!;
    await act(async () => { await button('플러그인 만들기').props.onClick(); });
    await act(async () => { root.findAllByType('textarea')[0]!.props.onChange({ target: { value: '날씨 요청' } }); });
    await act(async () => { await button('대화에 추가').props.onClick(); });
    expect(root.findAllByType('textarea')[0]!.props.value).toBe('날씨 요청');
    expect(root.findAllByType('label').find(item => item.children.includes('설명'))!.findByType('input').props.value).toBe('');
    expect(root.findByProps({ role: 'alert' }).children.join('')).toContain('폼이 없습니다');
    expect(root.findByProps({ 'aria-label': '마법사 대화' }).findAllByType('li')).toHaveLength(0);
    await act(async () => { await button('대화에 추가').props.onClick(); });
    expect(attempts).toBe(2);
    expect(root.findByProps({ role: 'alert' }).children.join('')).toContain('401');
    expect(root.findAllByType('textarea')[0]!.props.value).toBe('날씨 요청');
    expect(root.findByProps({ 'aria-label': '마법사 대화' }).findAllByType('li')).toHaveLength(0);
  } finally {
    const mounted = view;
    if (mounted) await act(async () => { mounted.unmount(); });
    globalThis.fetch = originalFetch;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  }
});

test('MarketPanel does not retry a saved draft as a new create when inventory refresh fails', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const posts: Array<{ name: string; draft: unknown; regenerate?: boolean }> = [];
  let lists = 0;
  const client = createNexusClient({ baseUrl: 'https://test.example', fetchImpl: (async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === '/v1/plugins/index') return Response.json({ markets: [] });
    if (path === '/v1/plugins') return Response.json([]);
    if (path === '/v1/plugins/wizard' && init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)) as { name: string; draft: unknown; regenerate?: boolean });
      return Response.json({ name: 'weather-research', saved: true });
    }
    if (path === '/v1/plugins/wizard') {
      lists++;
      if (lists > 1) return Response.json({ error: 'unavailable' }, { status: 503 });
      return Response.json({ plugins: [] });
    }
    throw new Error(`unexpected ${path}`);
  }) as typeof fetch });
  let view: ReturnType<typeof create> | undefined;
  try {
    await act(async () => { view = create(createElement(NexusProvider, { client, children: createElement(MarketPanel) })); });
    const root = view!.root;
    const button = (label: string) => root.findAllByType('button').find(item => item.children.includes(label))!;
    const input = (label: string) => root.findAllByType('label').find(item => item.children.includes(label))!.findByType('input');
    await act(async () => { await button('플러그인 만들기').props.onClick(); });
    await act(async () => {
      input('이름 (영문 소문자·숫자·하이픈)').props.onChange({ target: { value: 'weather-research' } });
      input('설명').props.onChange({ target: { value: 'Weather research' } });
    });
    await act(async () => { await button('초안 만들기').props.onClick(); });
    expect(posts).toEqual([{ name: 'weather-research', draft: { description: 'Weather research', skill: { description: 'Weather research', instructions: 'Weather research' } } }]);
    expect(lists).toBe(2);
    expect(root.findByProps({ role: 'alert' }).children.join('')).toContain('초안은 저장했지만');
    expect(button('다시 만들기')).toBeDefined();
    expect(root.findByProps({ 'aria-label': '마법사 대화' }).findAllByType('li').at(-1)!.children.join('')).toContain('저장했습니다');
    await act(async () => { await button('다시 만들기').props.onClick(); });
    expect(posts.at(-1)).toMatchObject({ name: 'weather-research', regenerate: true });
  } finally {
    if (view) await act(async () => { view!.unmount(); });
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  }
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
  const wizard = view.root.findByProps({ 'aria-label': '플러그인 마법사' });
  expect(wizard.props.className).toContain('min-w-0');
  expect(wizard.findAllByType('div').some(item => item.props.className?.includes('md:grid-cols-2'))).toBe(true);
  expect(view.root.findByProps({ 'aria-label': '마법사 대화 입력' }).props.className).toContain('min-w-0');
  expect(view.root.findByProps({ 'aria-label': '마법사 초안 편집' }).props.className).toContain('min-w-0');
  expect(view.root.findByProps({ 'aria-label': '마법사 대화' }).props.className).toContain('break-words');
  expect(view.root.findByProps({ 'aria-label': '만든 플러그인' }).props.className).toContain('min-w-0');
  const input = (label: string) => view.root.findAllByType('label').find(item => item.children.includes(label))!.findByType('input');
  await act(async () => {
    input('이름 (영문 소문자·숫자·하이픈)').props.onChange({ target: { value: 'weather-research' } });
    view.root.findAllByType('textarea')[0]!.props.onChange({ target: { value: '날씨 요약' } });
  });
  await act(async () => { button('대화에 추가').props.onClick(); });
  expect(view.root.findByProps({ 'aria-label': '마법사 대화' }).findAllByType('li').at(-1)!.children.join('')).toContain('LLM 대화는 데몬 연결 후');
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
  await act(async () => {
    view.root.findAllByType('textarea')[0]!.props.onChange({ target: { value: '쓰던 요청' } });
    button('새 초안').props.onClick();
  });
  expect(view.root.findAllByType('textarea')[0]!.props.value).toBe('');
  expect(input('설명').props.value).toBe('');
  await act(async () => { view.unmount(); });
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

test('유료 가격 및 실패 배지는 실패 종류를 숨기지 않는다', () => {
  expect(formatMarketPrice({ model: 'subscription', amount: 5, currency: 'USD', period: 'month' })).toBe('5 USD / month');
  expect(marketSignatureBadge('unknown-key')).toContain('알 수 없는');
  expect(marketSignatureBadge('malformed')).toContain('잘못된');
  expect(marketSignatureBadge('stale')).toContain('유효하지 않은');
});
