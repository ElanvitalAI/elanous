// APP-BUILD-CAPABILITY-RESOLUTION — seeded scenarios (seeds 1–5) for «번역 서비스 만들어줘»:
//   (i) eln provider usable → LLM translation from the provider, no card;
//   (ii) no key anywhere → mock + numbered card (recommendation 1 = LLM via OpenRouter);
//   (iii) provider not injectable but eln secret OPENROUTER_API_KEY → that secret, by name.
import { describe, expect, test } from 'bun:test';
import { detectCapabilityNeeds, renderChoiceCard, resolveCapabilities, resolveCapability, type CapabilityProbe } from './capability-resolution.js';

const ASKS = [
  '나는 번역 서비스를 만들고 싶어. 백엔드, 프론트 구성하고 만들어줘',
  '번역 서비스 만들어줘',
  '한영 번역 웹앱 만들어줘',
  'build me a translation web app',
  '문서를 번역하고 요약해 주는 서비스 만들어줘',
];
const PROVIDERS = [
  { name: 'openrouter', model: 'z-ai/glm-5.3', baseUrl: 'https://openrouter.ai/api/v1' },
  { name: 'glm', model: 'glm-5.3', baseUrl: 'https://api.z.ai/api/coding/paas/v4' },
  { name: 'openai', model: 'gpt-6-sol', baseUrl: 'https://api.openai.com/v1' },
  { name: 'gemini', model: 'gemini-3.1-pro-preview', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  { name: 'openrouter', model: 'moonshotai/kimi-k3', baseUrl: 'https://openrouter.ai/api/v1' },
];
const empty = (): CapabilityProbe => ({ llmSecrets: [], secretNames: [], local: { tools: [] } });

for (const seed of [1, 2, 3, 4, 5]) {
  const ask = ASKS[seed - 1]!;
  const provider = PROVIDERS[seed - 1]!;
  describe(`seed ${seed} · ${ask}`, () => {
    test('the line needs translation', () => {
      expect(detectCapabilityNeeds(ask)).toContain('translation');
    });
    test('(i) the running eln provider serves translation as LLM translation, no card', () => {
      const [translation] = resolveCapabilities(['translation'], { ...empty(), provider: { ...provider, hasKey: true, injectable: true } });
      expect(translation).toMatchObject({ status: 'resolved', source: 'eln-provider', engine: 'llm', keyEnv: 'ELN_LLM_API_KEY',
        key: { kind: 'provider', provider: provider.name }, env: { ELN_LLM_BASE_URL: provider.baseUrl, ELN_LLM_MODEL: provider.model } });
      expect(translation!.card).toBeUndefined();
    });
    test('(ii) no key at all → mock now + numbered card, LLM recommended', () => {
      const probe = seed % 2 ? empty() : { ...empty(), provider: { name: 'openai-codex', model: 'gpt-6', hasKey: false, injectable: false, subscription: true } };
      const translation = resolveCapability('translation', probe);
      expect(translation).toMatchObject({ status: 'needs-choice', source: 'mock', env: { ELN_MOCK_TRANSLATION: '1' } });
      expect(translation.card!.recommended).toBe(1);
      expect(translation.card!.options.map(option => option.id)).toEqual(['llm-openrouter', 'llm-local', 'libretranslate', 'mock']);
      const text = renderChoiceCard(translation.card!);
      expect(text).toContain('1) LLM 번역 사용 (OpenRouter 키 연결) · 추천');
      expect(text).toContain('3) LibreTranslate 주소·키 입력');
      if (!(seed % 2)) expect(text).toContain('openai-codex');
    });
    test('(iii) eln secret OPENROUTER_API_KEY is used by name when the provider cannot be injected', () => {
      const translation = resolveCapability('translation', { ...empty(),
        provider: { name: 'openai-codex', model: 'gpt-6', hasKey: true, injectable: false },
        llmSecrets: [{ name: 'OPENROUTER_API_KEY', baseUrl: 'https://openrouter.ai/api/v1', model: 'z-ai/glm-5.3' }],
        secretNames: ['OPENROUTER_API_KEY'] });
      expect(translation).toMatchObject({ status: 'resolved', source: 'eln-secret', engine: 'llm',
        key: { kind: 'secret', name: 'OPENROUTER_API_KEY' }, env: { ELN_LLM_BASE_URL: 'https://openrouter.ai/api/v1' } });
      expect(translation.summary).toContain('OPENROUTER_API_KEY');
    });
  });
}

test('a declared capability list wins over the line cues', () => {
  expect(detectCapabilityNeeds('번역 서비스 만들어줘', ['summarization', 'bogus'])).toEqual(['summarization']);
  expect(detectCapabilityNeeds('메모 앱 만들어줘')).toEqual([]);
});

test('a provider without a key falls through to a local LLM before any card', () => {
  const resolved = resolveCapability('summarization', { ...empty(),
    provider: { name: 'openrouter', model: 'x', baseUrl: 'https://openrouter.ai/api/v1', hasKey: false, injectable: true },
    local: { llmUrl: 'http://localhost:11434/v1', tools: [] } });
  expect(resolved).toMatchObject({ status: 'resolved', source: 'local', key: { kind: 'none' }, env: { ELN_LLM_MODEL: 'llama3' } });
});

test('non-LLM capabilities use a service secret, then a free/local option, then a card', () => {
  expect(resolveCapability('search', { ...empty(), secretNames: ['TAVILY_API_KEY'] }))
    .toMatchObject({ source: 'eln-secret', keyEnv: 'TAVILY_API_KEY', key: { kind: 'secret', name: 'TAVILY_API_KEY' } });
  expect(resolveCapability('search', empty())).toMatchObject({ status: 'resolved', source: 'free', engine: 'free-api' });
  expect(resolveCapability('tts', { ...empty(), local: { tools: ['say'] } })).toMatchObject({ status: 'resolved', engine: 'local-tool' });
  const tts = resolveCapability('tts', empty());
  expect(tts.status).toBe('needs-choice');
  expect(tts.card!.options[0]).toMatchObject({ n: 1, action: 'eln secret set ELEVENLABS_API_KEY', recommended: true });
});

test('a keyless local provider is called for real: no provider key reference, no run-time mock', () => {
  const resolved = resolveCapability('translation', { ...empty(),
    provider: { name: 'local', model: 'llama3', baseUrl: 'http://localhost:11434/v1', hasKey: true, injectable: true, keyless: true } });
  expect(resolved).toMatchObject({ status: 'resolved', source: 'eln-provider', key: { kind: 'none' },
    env: { ELN_LLM_BASE_URL: 'http://localhost:11434/v1', ELN_LLM_MODEL: 'llama3' } });
  expect(resolved.keyEnv).toBeUndefined();
});

test('the card says why: subscription vs not callable by the OpenAI-compatible adapter', () => {
  const anthropic = resolveCapability('translation', { ...empty(), provider: { name: 'anthropic', model: 'claude', hasKey: true, injectable: false } });
  expect(anthropic.card!.question).toContain('앱의 OpenAI 호환 어댑터로 부를 수 없습니다');
  const codex = resolveCapability('translation', { ...empty(), provider: { name: 'openai-codex', model: 'gpt-6', hasKey: false, injectable: false, subscription: true } });
  expect(codex.card!.question).toContain('구독 인증이라');
});
