import { afterEach, describe, expect, it } from 'bun:test';
import { DaemonClient } from './daemon-client';
import { handleModelCommand, parseModelCommand } from './chat-model-commands';

const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const writes: { path: string; body: unknown }[] = [];
const storage = new Map<string, string>();
let activeProvider = 'anthropic';
const config = { baseUrl: 'http://localhost:31415', token: 'test' };
const ctx = { client: new DaemonClient({ ...config, provider: 'anthropic' }), daemon: config, provider: 'anthropic' };

function setup(): void {
  writes.length = 0;
  storage.clear();
  activeProvider = 'anthropic';
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorage });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (init?.method === 'PUT' || init?.method === 'POST') writes.push({ path, body: JSON.parse(String(init.body)) });
    if (path === '/v1/setup/llm-provider' && init?.method === 'POST') {
      activeProvider = (JSON.parse(String(init.body)) as { provider: string }).provider;
    }
    const body = path === '/v1/setup/llm-providers'
      ? { activeProvider, providers: [
        { provider: 'anthropic', label: 'Anthropic', flow: 'auto', hasSavedKey: false },
        { provider: 'grok', label: 'Grok', flow: 'apiKey', hasSavedKey: true },
        { provider: 'openai', label: 'OpenAI', flow: 'apiKey', hasSavedKey: false },
        { provider: 'gemini', label: 'Gemini', flow: 'auto', hasSavedKey: false },
      ] }
      : path === '/v1/config/model-tier' ? { modelTier: { llm: 'balanced' } } : { active: { provider: activeProvider } };
    return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => body } as Response;
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else delete (globalThis as { window?: Window }).window;
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else delete (globalThis as { localStorage?: Storage }).localStorage;
});

describe('PWA model commands', () => {
  it('lists current tier and actual model on /model with valid choices', async () => {
    setup();
    expect(await handleModelCommand(parseModelCommand('model', []), ctx)).toContain('balanced · claude-haiku-4-5');
    expect(await handleModelCommand(parseModelCommand('model', []), ctx)).toContain('쓸 수 있는 값: budget');
    expect(writes).toHaveLength(0);
    expect(await handleModelCommand(parseModelCommand('model', []), { ...ctx, provider: 'grok' })).toContain('claude-haiku-4-5');
  });

  it('never reports an unverified default as the current model or reasoning level', async () => {
    setup();
    const withoutDaemon = { client: ctx.client, provider: ctx.provider };
    for (const name of ['model', 'reasoning'] as const) {
      const result = await handleModelCommand(parseModelCommand(name, []), withoutDaemon);
      expect(result).toContain('확인할 수 없음');
      expect(result).not.toContain('현재 모델: balanced');
      expect(result).not.toContain('현재 추론 단계: off');
    }
    expect(writes).toHaveLength(0);
  });

  it('does not treat a successful daemon response without a tier as a current tier', async () => {
    setup();
    const fetchBefore = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname === '/v1/config/model-tier') {
        return { ok: true, json: async () => ({ modelTier: {} }) } as Response;
      }
      return fetchBefore(input, init);
    }) as typeof fetch;
    expect(await handleModelCommand(parseModelCommand('model', []), ctx)).toContain('현재 모델: 확인할 수 없음');
    expect(await handleModelCommand(parseModelCommand('reasoning', []), ctx)).toContain('현재 추론 단계: 확인할 수 없음');
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      throw new TypeError('offline');
    }) as typeof fetch;
    expect(await handleModelCommand(parseModelCommand('model', []), ctx)).toContain('현재 모델: 확인할 수 없음');
    expect(await handleModelCommand(parseModelCommand('reasoning', []), ctx)).toContain('현재 추론 단계: 확인할 수 없음');
    expect(writes).toHaveLength(0);
  });

  it('saves /model best once with the daemon tier sync helper and reports the model', async () => {
    setup();
    expect(await handleModelCommand(parseModelCommand('model', ['best']), ctx)).toBe('모델: claude-opus-4-7(으)로 바꿨습니다');
    expect(writes).toEqual([{ path: '/v1/config/model-tier', body: { modelTier: { llm: 'best' } } }]);
  });

  it('maps the TUI sol alias to its tier; unknown names and extra arguments never write', async () => {
    setup();
    expect(parseModelCommand('model', ['sol'])).toEqual({ kind: 'model', tier: 'best' });
    expect(parseModelCommand('model', ['terra'])).toEqual({ kind: 'model', tier: 'better' });
    expect(await handleModelCommand(parseModelCommand('model', ['sol']), ctx)).toContain('claude-opus-4-7');
    writes.length = 0;
    for (const args of [['nonesuch'], ['best', 'extra'], ['__proto__']]) {
      expect(await handleModelCommand(parseModelCommand('model', args), ctx)).toContain('쓸 수 있는 값:');
    }
    expect(writes).toHaveLength(0);
  });

  it('cycles the same filtered order as the chip; never posts an unknown provider', async () => {
    setup();
    expect(await handleModelCommand(parseModelCommand('provider', []), ctx)).toContain('현재 프로바이더: anthropic');
    expect(await handleModelCommand(parseModelCommand('provider', ['next']), ctx)).toContain('grok');
    expect(await handleModelCommand(parseModelCommand('provider', []), ctx)).toContain('현재 프로바이더: grok');
    expect(await handleModelCommand(parseModelCommand('provider', ['next']), ctx)).toContain('gemini');
    expect(writes).toEqual([
      { path: '/v1/setup/llm-provider', body: { provider: 'grok' } },
      { path: '/v1/setup/llm-provider', body: { provider: 'gemini' } },
    ]);
    writes.length = 0;
    for (const args of [['use', 'openai'], ['use', 'unknown'], ['use'], ['next', 'extra']]) {
      expect(await handleModelCommand(parseModelCommand('provider', args), ctx)).toContain('쓸 수 있는 값:');
    }
    expect(writes).toHaveLength(0);
    expect(await handleModelCommand(parseModelCommand('provider', ['use', 'unknown']), ctx)).toContain('anthropic · grok · gemini');
    expect(await handleModelCommand(parseModelCommand('provider', ['use', 'grok']), ctx)).toContain('grok');
    expect(writes).toHaveLength(1);
  });

  it('shows the tier reasoning default and guides high to settings without inventing an API', async () => {
    setup();
    expect(await handleModelCommand(parseModelCommand('reasoning', []), ctx)).toContain('현재 추론 단계: 확인할 수 없음 · 모델 티어 기본값: off');
    expect(await handleModelCommand(parseModelCommand('reasoning', ['high']), ctx)).toBe('추론 강도는 설정 화면에서 바꾸세요');
    expect(await handleModelCommand(parseModelCommand('reasoning', ['xhigh']), ctx)).toContain('쓸 수 있는 값: low · medium · high');
    expect(writes).toHaveLength(0);
  });
});
